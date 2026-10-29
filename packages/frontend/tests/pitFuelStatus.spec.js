import { test, expect } from '@playwright/test'

test.use({ locale: 'en-US' })

async function mockSession(page) {
  const driver = { id: 'driver-1', name: 'Driver One', color: '#ef4444' }
  const state = {
    current: {
      id: 'pit-session',
      name: 'Pit race',
      type: 'race',
      status: 'active',
      virtualFuelRate: 5,
      track: { name: 'Pit circuit' },
      drivers: [
        { id: 'entry-1', driverId: driver.id, driver, controller: 0, totalLaps: 2, virtualFuelUnits: 7250 },
        { id: 'entry-2', driverId: 'driver-2', driver: { name: 'Driver Two' }, controller: 0, virtualFuelUnits: 0 },
      ],
      laps: [],
      penalties: [],
      pitStops: [
        {
          id: 'cu-1',
          sessionDriverId: 'entry-1',
          controller: 0,
          source: 'cu',
          enteredAt: '2026-10-29T12:00:00Z',
          durationMs: 2400,
        },
        {
          id: 'sim-1',
          sessionDriverId: 'entry-2',
          controller: 0,
          source: 'simulator',
          enteredAt: '2026-10-29T12:01:00Z',
          durationMs: 3200,
        },
      ],
      virtualFuelEvents: [
        {
          id: 1,
          sessionDriverId: 'entry-1',
          controller: 0,
          kind: 'lap',
          units: 2750,
          source: 'lap',
          createdAt: '2026-10-29T12:00:30Z',
        },
        {
          id: 2,
          sessionDriverId: 'entry-2',
          controller: 0,
          kind: 'refuel',
          units: 0,
          source: 'simulator',
          reference: 'pit:sim-1',
          createdAt: '2026-10-29T12:01:03Z',
        },
      ],
    },
    writes: [],
    failRead: false,
  }
  await page.routeWebSocket('**/socket.io/**', (socket) => socket.close())
  await page.route('**/socket.io/**', (route) => route.abort())
  await page.route('**/api/**', (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() !== 'GET') state.writes.push({ path: url.pathname, method: request.method() })
    let data = []
    if (url.pathname === '/api/sessions') data = [state.current]
    if (url.pathname === '/api/sessions/pit-session') {
      if (state.failRead) return route.fulfill({ status: 500, json: { success: false } })
      data = state.current
    }
    if (url.pathname === '/api/race-control/status') {
      return route.fulfill({ json: { success: true, enabled: true, keyRequired: false } })
    }
    if (url.pathname === '/api/race-control/vsc') data = { status: 'inactive', active: false }
    if (url.pathname === '/api/race-control/director/session-recovery')
      data = { sessions: [], boundSessionId: 'pit-session' }
    return route.fulfill({ json: { success: true, data } })
  })
  return state
}

test('driver pit status uses assignment IDs and never infers refuelling from CU stops', async ({ page }) => {
  const state = await mockSession(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/display/driver/driver-1')
  const panel = page.getByTestId('pit-fuel-status')
  await expect(panel.getByTestId('pit-stop-count')).toContainText('(1)')
  await expect(panel.getByTestId('pit-stop-cu-1')).toContainText('CU pit signal (observed)')
  await expect(panel.getByTestId('pit-stop-cu-1')).toContainText('~2.4 s')
  await expect(panel.getByTestId('pit-refuel-count')).toContainText('(0)')
  await expect(panel.getByTestId('pit-fuel-level-entry-1')).toContainText('Virtual fuel: 73 %')
  await expect(panel).not.toContainText('Driver Two')
  await expect(panel.getByTestId('pit-refuel-1')).toHaveCount(0)
  await expect(page.getByText('CU fuel level (hardware)')).toBeVisible()
  await expect(panel).toContainText('CU pit signals do not prove refuelling')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(state.writes).toEqual([])
})

for (const [view, path] of [
  ['director', '/display/control'],
  ['history', '/sessions/pit-session'],
]) {
  test(`${view} separates saved stops, refuel events and current virtual levels`, async ({ page }) => {
    const state = await mockSession(page)
    if (view === 'history') state.current.status = 'finished'
    await page.goto(path)
    const panel = page.getByTestId('pit-fuel-status')
    await expect(panel.getByTestId('pit-stop-count')).toContainText('(2)')
    await expect(panel.getByTestId('pit-refuel-count')).toContainText('(1)')
    await expect(panel.getByTestId('pit-stop-sim-1')).toContainText('Simulator')
    await expect(panel.getByTestId('pit-refuel-2')).toContainText('Driver Two')
    await expect(panel.getByTestId('pit-refuel-2')).toContainText('refilled to 100 % at this event')
    await expect(panel.getByTestId('pit-fuel-level-entry-2')).toContainText('Virtual fuel: 0 %')
    await expect(panel.getByTestId('pit-refuel-1')).toHaveCount(0)
    await expect(panel.getByTestId('pit-fuel-levels')).toContainText('5 % per race minute')
    expect(state.writes).toEqual([])
  })
}

test('driver refreshes after a completed pit event and preserves saved state on read failure', async ({ page }) => {
  const state = await mockSession(page)
  await page.goto('/display/driver/driver-1')
  await expect(page.getByTestId('pit-refuel-count')).toContainText('(0)')
  state.current.pitStops.push({ ...state.current.pitStops[1], id: 'sim-2', sessionDriverId: 'entry-1' })
  state.current.virtualFuelEvents.push({
    ...state.current.virtualFuelEvents[1],
    id: 3,
    sessionDriverId: 'entry-1',
    reference: 'pit:sim-2',
  })
  state.current.drivers[0].virtualFuelUnits = 10000
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('session:pit_stop')))
  await expect(page.getByTestId('pit-refuel-3')).toBeVisible()
  await expect(page.getByTestId('pit-stop-count')).toContainText('(2)')
  await expect(page.getByTestId('pit-fuel-level-entry-1')).toContainText('100 %')
  state.failRead = true
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('session:pit_stop')))
  await expect(page.getByRole('alert')).toContainText('Could not refresh session data')
  await expect(page.getByTestId('pit-refuel-3')).toBeVisible()
  state.failRead = false
  await page.reload()
  await expect(page.getByTestId('pit-refuel-3')).toBeVisible()
  expect(state.writes).toEqual([])
})

test('disabled consumption and no completed stops remain explicit', async ({ page }) => {
  const state = await mockSession(page)
  state.current.virtualFuelRate = null
  state.current.pitStops = []
  state.current.virtualFuelEvents = []
  await page.goto('/display/driver/driver-1')
  const panel = page.getByTestId('pit-fuel-status')
  await expect(panel).toContainText('Virtual consumption is disabled')
  await expect(panel).toContainText('No completed pit stop recorded')
  await expect(panel).toContainText('No virtual refuel recorded')
  await expect(panel.getByTestId('pit-fuel-level-entry-1')).toHaveCount(0)
})

test('history retains unassigned pit observations and reports missing fuel instead of assuming full', async ({
  page,
}) => {
  const state = await mockSession(page)
  state.current.status = 'finished'
  state.current.drivers[0].virtualFuelUnits = null
  state.current.pitStops[0].sessionDriverId = null
  state.current.pitStops[0].source = 'unknown'
  await page.goto('/sessions/pit-session')
  const panel = page.getByTestId('pit-fuel-status')
  await expect(panel.getByTestId('pit-stop-count')).toContainText('(2)')
  await expect(panel.getByTestId('pit-stop-cu-1')).toContainText('Controller 1')
  await expect(panel.getByTestId('pit-stop-cu-1')).toContainText('Source unknown')
  await expect(panel.getByTestId('pit-fuel-level-entry-1')).toContainText('Virtual fuel: unavailable')
})

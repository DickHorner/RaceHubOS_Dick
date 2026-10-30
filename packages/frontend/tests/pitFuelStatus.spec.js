import { test, expect } from '@playwright/test'

test.use({ locale: 'en-US' })

async function mockSession(page, { withLive = false } = {}) {
  const driver = { id: 'driver-1', name: 'Driver One', color: '#ef4444' }
  const state = {
    current: {
      id: 'pit-session',
      name: 'Pit race',
      type: 'race',
      status: 'active',
      startedAt: '2026-10-29T11:59:00Z',
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
    rejectPlan: false,
  }
  const sockets = []
  await page.routeWebSocket('**/socket.io/**', (socket) => {
    if (!withLive) return socket.close()
    const connection = { socket, ready: false }
    sockets.push(connection)
    socket.onMessage((message) => {
      if (message === '40') {
        socket.send('40{"sid":"fuel-test"}')
        connection.ready = true
      }
    })
    socket.send('0{"sid":"fuel-test","upgrades":[],"pingInterval":25000,"pingTimeout":20000}')
  })
  state.connected = () => sockets.filter((connection) => connection.ready).length
  state.sendLeaderboard = (rows) => {
    for (const connection of sockets.filter((socket) => socket.ready))
      connection.socket.send('42' + JSON.stringify(['session:leaderboard', rows]))
  }
  await page.route('**/socket.io/**', (route) => route.abort())
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() !== 'GET') state.writes.push({ path: url.pathname, method: request.method() })
    if (url.pathname === '/api/race-control/driver/start-fuel' && request.method() === 'POST') {
      const body = request.postDataJSON()
      state.writes[state.writes.length - 1].body = body
      if (state.rejectPlan) return route.fulfill({ status: 409, json: { success: false } })
      if (state.planGate) await state.planGate
      const assigned = state.current.drivers[0]
      assigned.initialFuelUnits = body.initialFuelUnits
      assigned.virtualFuelUnits = body.initialFuelUnits
      assigned.fuelPlanVersion = (assigned.fuelPlanVersion || 0) + 1
      return route.fulfill({ json: { success: true, data: assigned } })
    }
    if (url.pathname === '/api/race-control/driver/fuel' && request.method() === 'POST') {
      const body = request.postDataJSON()
      state.writes[state.writes.length - 1].body = body
      if (state.rejectPlan) return route.fulfill({ status: 409, json: { success: false } })
      if (state.planGate) await state.planGate
      const assigned = state.current.drivers[0]
      assigned.pendingFuelLaps = body.targetLaps ?? null
      assigned.pendingFuelUnits = body.targetUnits ?? (body.targetLaps == null ? null : body.targetLaps * 100)
      assigned.fuelPlanVersion = (assigned.fuelPlanVersion || 0) + 1
      return route.fulfill({ json: { success: true, data: assigned } })
    }
    let data = []
    if (url.pathname === '/api/race-control/driver/session') {
      if (state.accessGate) await state.accessGate
      if (state.rejectAccess) return route.fulfill({ status: 403, json: { success: false } })
      data = { sessionId: state.current.id, sessionDriverId: 'entry-1', driverId: 'driver-1' }
    }
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

test('personal fuel plan previews 25 laps, persists without approval and applies only after the pit update', async ({
  page,
}) => {
  const state = await mockSession(page)
  state.current.virtualFuelEvents = [1, 2, 3].map((id) => ({ id, sessionDriverId: 'entry-1', kind: 'lap', units: 100 }))
  state.current.drivers[0].virtualFuelUnits = 1700
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/display/driver/driver-1#chaos=personal-test-token')
  await expect(page.getByTestId('fuel-range')).toContainText('17 laps')
  await page.getByTestId('fuel-target-laps').fill('25')
  await expect(page.getByTestId('fuel-target-preview')).toContainText('25 %')
  await expect(page.getByTestId('fuel-full-range')).toContainText('100 laps')
  await expect(page.getByTestId('fuel-refill-preview')).toContainText('add 8 % of tank capacity')
  await expect(page.getByTestId('fuel-refill-preview')).toContainText('level of 25 %')
  await expect(page.getByTestId('fuel-refill-preview')).toContainText('afterwards: 25 laps')
  expect(state.writes).toEqual([])
  await page.getByTestId('fuel-plan-save').click()
  await expect(page.getByTestId('fuel-saved-plan')).toContainText('25 laps')
  await expect(page.getByTestId('pit-fuel-level-entry-1')).toContainText('17 %')
  expect(state.writes).toEqual([
    { path: '/api/race-control/driver/fuel', method: 'POST', body: { targetLaps: 25, expectedVersion: 0 } },
  ])
  await page.reload()
  await expect(page.getByTestId('fuel-target-laps')).toHaveValue('25')
  await expect(page.getByTestId('fuel-refill-preview')).toContainText('add 8 % of tank capacity')
  state.current.drivers[0] = {
    ...state.current.drivers[0],
    pendingFuelLaps: null,
    pendingFuelUnits: null,
    fuelPlanVersion: 2,
    virtualFuelUnits: 2500,
  }
  state.current.virtualFuelEvents.push({
    id: 4,
    sessionDriverId: 'entry-1',
    controller: 0,
    kind: 'refuel',
    source: 'simulator',
    targetUnits: 2500,
    createdAt: '2026-10-29T12:03:00Z',
  })
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('session:pit_stop')))
  await expect(page.getByTestId('fuel-saved-plan')).toContainText('No individual target')
  await expect(page.getByTestId('fuel-range')).toContainText('25 laps')
  await expect(page.getByTestId('fuel-refill-preview')).toContainText('add 0 % of tank capacity')
  await expect(page.getByTestId('pit-refuel-4')).toContainText('25 % at this event')
  expect(state.writes).toHaveLength(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('fuel planning shows prerequisites and rejects impossible previews without a write', async ({ page }) => {
  const state = await mockSession(page)
  await page.goto('/display/driver/driver-1')
  const panel = page.getByTestId('driver-fuel-strategy')
  await expect(panel).toContainText('Use your personal driver link')
  await expect(panel.getByTestId('fuel-target-laps')).toBeDisabled()
  await page.goto('/display/driver/driver-1#chaos=personal-test-token')
  await expect(panel.getByTestId('fuel-range')).toContainText('not yet calculable')
  await page.getByTestId('fuel-target-laps').fill('25')
  await expect(page.getByTestId('fuel-plan-save')).toBeDisabled()
  state.current.virtualFuelEvents = [1, 2, 3].map((id) => ({
    id,
    sessionDriverId: 'entry-1',
    kind: 'lap',
    units: 1000,
  }))
  await page.reload()
  for (const laps of ['25', '0', '1.5', '']) {
    await page.getByTestId('fuel-target-laps').fill(laps)
    await expect(page.getByTestId('fuel-plan-save')).toBeDisabled()
  }
  await page.getByTestId('fuel-target-laps').fill('10')
  await expect(page.getByTestId('fuel-target-preview')).toContainText('100 %')
  await expect(page.getByTestId('fuel-plan-save')).toBeEnabled()
  expect(state.writes).toEqual([])
})

test('a paused qualifying fuel plan can return to full-tank stops without a refuel', async ({ page }) => {
  const state = await mockSession(page)
  state.current.type = 'qualif'
  state.current.status = 'paused'
  state.current.drivers[0] = {
    ...state.current.drivers[0],
    pendingFuelLaps: 25,
    pendingFuelUnits: 2500,
    fuelPlanVersion: 3,
  }
  await page.goto('/display/driver/driver-1#chaos=personal-test-token')
  await page.getByTestId('fuel-plan-clear').click()
  await expect(page.getByTestId('fuel-saved-plan')).toContainText('fills the virtual tank completely')
  await expect(page.getByTestId('pit-fuel-level-entry-1')).toContainText('73 %')
  expect(state.writes[0].body).toEqual({ targetLaps: null, expectedVersion: 3 })
  expect(
    state.current.virtualFuelEvents.filter((event) => event.sessionDriverId === 'entry-1' && event.kind === 'refuel')
  ).toHaveLength(0)
})

test('stale fuel plans report failure and refresh the saved assignment', async ({ page }) => {
  const state = await mockSession(page)
  state.current.virtualFuelEvents = [1, 2, 3].map((id) => ({ id, sessionDriverId: 'entry-1', kind: 'lap', units: 100 }))
  await page.goto('/display/driver/driver-1#chaos=personal-test-token')
  await page.getByTestId('fuel-target-laps').fill('25')
  state.current.drivers[0] = {
    ...state.current.drivers[0],
    pendingFuelLaps: 40,
    pendingFuelUnits: 4000,
    fuelPlanVersion: 1,
  }
  state.rejectPlan = true
  await page.getByTestId('fuel-plan-save').click()
  await expect(page.getByTestId('fuel-plan-error')).toContainText('Could not save')
  await expect(page.getByTestId('fuel-saved-plan')).toContainText('40 laps')
  await expect(page.getByTestId('fuel-target-laps')).toHaveValue('25')
  await expect(page.getByTestId('pit-fuel-level-entry-1')).toContainText('73 %')
  expect(state.writes[0].body.expectedVersion).toBe(0)
})

test('fuel plan saving blocks duplicate input until the server reply', async ({ page }) => {
  const state = await mockSession(page)
  state.current.virtualFuelEvents = [1, 2, 3].map((id) => ({ id, sessionDriverId: 'entry-1', kind: 'lap', units: 100 }))
  let release
  state.planGate = new Promise((resolve) => {
    release = resolve
  })
  await page.goto('/display/driver/driver-1#chaos=personal-test-token')
  await page.getByTestId('fuel-target-laps').fill('25')
  await page.getByTestId('fuel-plan-save').click()
  await expect(page.getByTestId('fuel-plan-save')).toBeDisabled()
  await expect(page.getByTestId('fuel-target-laps')).toBeDisabled()
  await page.getByTestId('fuel-plan-save').evaluate((button) => button.click())
  expect(state.writes).toHaveLength(1)
  release()
  await expect(page.getByTestId('fuel-saved-plan')).toContainText('25 laps')
  await expect(page.getByTestId('fuel-plan-save')).toBeEnabled()
  expect(state.writes).toHaveLength(1)
})

test('accepted fuel plans with a failed reload are reported as unconfirmed', async ({ page }) => {
  const state = await mockSession(page)
  state.current.virtualFuelEvents = [1, 2, 3].map((id) => ({ id, sessionDriverId: 'entry-1', kind: 'lap', units: 100 }))
  await page.goto('/display/driver/driver-1#chaos=personal-test-token')
  await page.getByTestId('fuel-target-laps').fill('25')
  state.failRead = true
  await page.getByTestId('fuel-plan-save').click()
  await expect(page.getByTestId('fuel-plan-error')).toContainText('server accepted the plan')
  await expect(page.getByTestId('fuel-plan-error')).toContainText('Reload this page')
  expect(state.writes).toHaveLength(1)
  state.failRead = false
  await page.reload()
  await expect(page.getByTestId('fuel-saved-plan')).toContainText('25 laps')
  expect(state.writes).toHaveLength(1)
})

test('driver sees own remaining required stops while CU observations remain separate', async ({ page }) => {
  const state = await mockSession(page)
  state.current.requiredPitStops = 2
  await page.goto('/display/driver/driver-1')
  const progress = page.getByTestId('required-pits-driver-entry-1')
  await expect(progress).toContainText('0 / 2')
  await expect(progress).toContainText('remaining: 2')
  await expect(page.getByTestId('required-pits-driver-entry-2')).toHaveCount(0)
  await expect(page.getByTestId('pit-stop-cu-1')).toBeVisible()
  state.current.pitStops.push({
    id: 'verified-1',
    sessionId: 'pit-session',
    sessionDriverId: 'entry-1',
    source: 'simulator',
    enteredAt: '2026-10-29T12:03:00Z',
    exitedAt: '2026-10-29T12:03:02Z',
    durationMs: 2000,
  })
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('session:pit_stop')))
  await expect(progress).toContainText('1 / 2')
  await expect(progress).toContainText('remaining: 1')
  expect(state.writes).toEqual([])
})

for (const [view, path] of [
  ['director', '/display/control'],
  ['history', '/sessions/pit-session'],
]) {
  test(`${view} shows required-stop compliance per driver without changing the classification`, async ({ page }) => {
    const state = await mockSession(page)
    state.current.requiredPitStops = 1
    if (view === 'history') state.current.status = 'finished'
    state.current.pitStops[1] = {
      ...state.current.pitStops[1],
      sessionId: 'pit-session',
      exitedAt: '2026-10-29T12:01:03.200Z',
    }
    await page.goto(path)
    await expect(page.getByTestId('required-pits-driver-entry-1')).toContainText('not yet fulfilled')
    await expect(page.getByTestId('required-pits-driver-entry-2')).toContainText('requirement fulfilled')
    await expect(page.getByTestId('required-pits-status')).toContainText('does not automatically change classification')
    expect(state.writes).toEqual([])
  })
}

test('required stops wait for GO and exclude earlier pit cycles from the next attempt', async ({ page }) => {
  const state = await mockSession(page)
  state.current.requiredPitStops = 1
  state.current.startedAt = null
  state.current.pitStops[1] = {
    ...state.current.pitStops[1],
    sessionId: 'pit-session',
    exitedAt: '2026-10-29T12:01:03.200Z',
  }
  await page.goto('/display/control')
  const progress = page.getByTestId('required-pits-driver-entry-2')
  await expect(progress).toContainText('0 / 1')
  state.current.startedAt = '2026-10-29T12:02:00Z'
  await page.reload()
  await expect(progress).toContainText('0 / 1')
  state.current.pitStops.push({
    id: 'after-go',
    sessionId: 'pit-session',
    sessionDriverId: 'entry-2',
    source: 'simulator',
    enteredAt: '2026-10-29T12:03:00Z',
    exitedAt: '2026-10-29T12:03:01Z',
    durationMs: 1000,
  })
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('session:pit_stop')))
  await expect(progress).toContainText('1 / 1')
  await expect(progress).toContainText('requirement fulfilled')
  expect(state.writes).toEqual([])
})

for (const type of ['race', 'qualif']) {
  test(`${type}: personal draft link saves starting fuel and reloads its own prepared session`, async ({ page }) => {
    const state = await mockSession(page)
    state.current.type = type
    state.current.status = 'draft'
    state.current.startedAt = null
    state.current.virtualFuelEvents = []
    state.current.drivers[0].virtualFuelUnits = 10000
    // A prepared personal session must remain reachable while another race is active.
    let listReads = 0
    await page.route('**/api/sessions?*', (route) => {
      listReads++
      return route.fulfill({
        json: { success: true, data: [{ id: 'other-race', status: 'active', name: 'Other race' }] },
      })
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/display/driver/driver-1#chaos=personal-test-token')
    await expect(page.getByTestId('start-fuel-save')).toBeEnabled()
    await expect(page.getByTestId('fuel-range')).toContainText('not yet calculable')
    await page.getByTestId('start-fuel-percent').fill('25')
    await page.getByTestId('start-fuel-save').click()
    await expect(page.getByTestId('start-fuel-saved')).toContainText('25 %')
    await expect(page.getByTestId('start-fuel-save')).toBeEnabled()
    expect(state.writes).toEqual([
      {
        path: '/api/race-control/driver/start-fuel',
        method: 'POST',
        body: { initialFuelUnits: 2500, expectedVersion: 0 },
      },
    ])
    await page.reload()
    await expect(page.getByTestId('start-fuel-percent')).toHaveValue('25')
    await expect(page.getByTestId('pit-fuel-level-entry-1')).toContainText('25 %')
    await page.getByTestId('start-fuel-percent').fill('0')
    await page.getByTestId('start-fuel-save').click()
    await expect(page.getByTestId('start-fuel-saved')).toContainText('0 %')
    expect(state.writes[1].body).toEqual({ initialFuelUnits: 0, expectedVersion: 1 })
    expect(listReads).toBe(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}

test('starting fuel requires a verified personal draft link and rejects invalid percentages', async ({ page }) => {
  const state = await mockSession(page)
  state.current.status = 'draft'
  state.current.type = 'qualif'
  await page.goto('/display/driver/driver-1#chaos=personal-test-token')
  for (const value of ['-1', '101', '1.5', '']) {
    await page.getByTestId('start-fuel-percent').fill(value)
    await expect(page.getByTestId('start-fuel-save')).toBeDisabled()
  }
  await page.getByTestId('start-fuel-percent').fill('100')
  await expect(page.getByTestId('start-fuel-save')).toBeEnabled()
  state.current.status = 'active'
  await page.reload()
  await expect(page.getByTestId('start-fuel-percent')).toBeDisabled()
  await expect(page.getByTestId('start-fuel-save')).toBeDisabled()
  expect(state.writes).toEqual([])
})

test('stale or unconfirmed starting fuel remains explicit and recovers through reload', async ({ page }) => {
  const state = await mockSession(page)
  state.current.status = 'draft'
  await page.goto('/display/driver/driver-1#chaos=personal-test-token')
  await page.getByTestId('start-fuel-percent').fill('25')
  state.rejectPlan = true
  await page.getByTestId('start-fuel-save').click()
  await expect(page.getByTestId('fuel-plan-error')).toContainText('Could not save starting fuel')
  await expect(page.getByTestId('start-fuel-saved')).toContainText('100 %')
  state.rejectPlan = false
  state.failRead = true
  await page.getByTestId('start-fuel-save').click()
  await expect(page.getByTestId('fuel-plan-error')).toContainText('server accepted the plan')
  state.failRead = false
  await page.reload()
  await expect(page.getByTestId('start-fuel-saved')).toContainText('25 %')
})

test('a rejected or mismatched personal link never enables controls for a different driver', async ({ page }) => {
  const state = await mockSession(page)
  await page.goto('/display/driver/another-driver#chaos=personal-test-token')
  await expect(page.getByRole('alert')).toContainText('Could not refresh session data')
  await expect(page.getByTestId('driver-fuel-strategy')).toHaveCount(0)
  await page.goto('/display/driver/driver-1#chaos=personal-test-token')
  await expect(page.getByTestId('driver-fuel-strategy')).toBeVisible()
  state.rejectAccess = true
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('session:status_changed')))
  await expect(page.getByTestId('driver-fuel-strategy')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /chaos/i })).toHaveCount(0)
  expect(state.writes).toEqual([])
})

test('switching the driver URL immediately revokes controls while personal lookup is pending', async ({ page }) => {
  const state = await mockSession(page)
  await page.goto('/display/driver/driver-1#chaos=personal-test-token')
  await expect(page.getByRole('button', { name: /chaos/i })).toBeVisible()
  let release
  state.accessGate = new Promise((resolve) => {
    release = resolve
  })
  await page.evaluate(() => {
    history.pushState(null, '', '/display/driver/driver-2#chaos=personal-test-token')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  await expect(page.getByRole('button', { name: /chaos/i })).toHaveCount(0)
  await expect(page.getByTestId('start-fuel-save')).toBeDisabled()
  release()
  await expect(page.getByRole('alert')).toContainText('Could not refresh session data')
  expect(state.writes).toEqual([])
})

test('fuel preview keeps a higher current level and isolates the assigned driver consumption', async ({ page }) => {
  const state = await mockSession(page)
  state.current.virtualFuelEvents = [1, 2, 3].flatMap((id) => [
    { id, sessionDriverId: 'entry-1', kind: 'lap', units: 100 },
    { id: id + 3, sessionDriverId: 'entry-2', kind: 'lap', units: 9000 },
  ])
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/display/driver/driver-1#chaos=personal-test-token')
  await page.getByTestId('fuel-target-laps').fill('10')
  const preview = page.getByTestId('fuel-refill-preview')
  await expect(preview).toContainText('add 0 % of tank capacity')
  await expect(preview).toContainText('level of 72.5 %')
  await expect(preview).toContainText('afterwards: 72 laps')
  await expect(preview).toContainText('Further consumption before the pit stop')
  await expect(page.getByTestId('fuel-full-range')).toContainText('100 laps')
  expect(state.current.drivers[0].virtualFuelUnits).toBe(7250)
  expect(state.writes).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('empty qualifying tank previews capacity exactly and hides impossible input amounts', async ({ page }) => {
  const state = await mockSession(page)
  state.current.type = 'qualif'
  state.current.status = 'paused'
  state.current.drivers[0].virtualFuelUnits = 0
  state.current.virtualFuelEvents = [1, 2, 3].map((id) => ({
    id,
    sessionDriverId: 'entry-1',
    kind: 'lap',
    units: 1000,
  }))
  await page.goto('/display/driver/driver-1#chaos=personal-test-token')
  await expect(page.getByTestId('fuel-range')).toContainText('0 laps')
  await expect(page.getByTestId('fuel-full-range')).toContainText('10 laps')
  await page.getByTestId('fuel-target-laps').fill('10')
  await expect(page.getByTestId('fuel-refill-preview')).toContainText('add 100 % of tank capacity')
  await expect(page.getByTestId('fuel-refill-preview')).toContainText('level of 100 %')
  await expect(page.getByTestId('fuel-refill-preview')).toContainText('afterwards: 10 laps')
  await page.getByTestId('fuel-target-laps').fill('11')
  await expect(page.getByTestId('fuel-refill-preview')).toHaveCount(0)
  await expect(page.getByTestId('fuel-plan-save')).toBeDisabled()
  expect(state.writes).toEqual([])
})

test('fuel preview never invents a current level or calculates from missing or disabled consumption', async ({
  page,
}) => {
  const state = await mockSession(page)
  state.current.drivers[0].virtualFuelUnits = null
  state.current.virtualFuelEvents = [1, 2, 3].map((id) => ({
    id,
    sessionDriverId: 'entry-1',
    kind: 'lap',
    units: 100,
  }))
  await page.goto('/display/driver/driver-1#chaos=personal-test-token')
  await page.getByTestId('fuel-target-laps').fill('25')
  await expect(page.getByTestId('fuel-refill-preview')).toContainText('current virtual fuel level is unavailable')
  await expect(page.getByTestId('fuel-range')).toContainText('not yet calculable')
  await expect(page.getByTestId('fuel-full-range')).toContainText('100 laps')

  state.current.virtualFuelEvents.pop()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('session:pit_stop')))
  await expect(page.getByTestId('fuel-full-range')).toHaveCount(0)
  await expect(page.getByTestId('fuel-refill-preview')).toHaveCount(0)
  await expect(page.getByTestId('fuel-target-preview')).toContainText('not yet calculable')

  state.current.virtualFuelEvents.push({ id: 3, sessionDriverId: 'entry-1', kind: 'lap', units: 100 })
  state.current.virtualFuelRate = null
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('session:pit_stop')))
  await expect(page.getByTestId('fuel-saved-plan')).toContainText('disabled')
  await expect(page.getByTestId('fuel-full-range')).toHaveCount(0)
  await expect(page.getByTestId('fuel-refill-preview')).toHaveCount(0)
  expect(state.writes).toEqual([])
})

test('fuel preview follows current consumption without rewriting a previously saved target', async ({ page }) => {
  const state = await mockSession(page)
  state.current.drivers[0] = {
    ...state.current.drivers[0],
    virtualFuelUnits: 1700,
    pendingFuelLaps: 25,
    pendingFuelUnits: 2500,
  }
  state.current.virtualFuelEvents = [1, 2, 3].map((id) => ({
    id,
    sessionDriverId: 'entry-1',
    kind: 'lap',
    units: 100,
  }))
  await page.goto('/display/driver/driver-1#chaos=personal-test-token')
  await expect(page.getByTestId('fuel-refill-preview')).toContainText('add 8 % of tank capacity')
  state.current.virtualFuelEvents.push(
    ...[4, 5, 6].map((id) => ({
      id,
      sessionDriverId: 'entry-1',
      kind: 'lap',
      units: 200,
    }))
  )
  state.current.drivers[0].virtualFuelUnits = 1100
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('session:pit_stop')))
  await expect(page.getByTestId('fuel-refill-preview')).toContainText('add 39 % of tank capacity')
  await expect(page.getByTestId('fuel-refill-preview')).toContainText('level of 50 %')
  await expect(page.getByTestId('fuel-full-range')).toContainText('50 laps')
  await expect(page.getByTestId('fuel-saved-plan')).toContainText('target at least 25 %')
  await expect(page.getByTestId('fuel-target-laps')).toHaveValue('25')
  expect(state.current.drivers[0].pendingFuelUnits).toBe(2500)
  expect(state.writes).toEqual([])
})

for (const type of ['race', 'qualif']) {
  test(`${type} percent target saves without measured laps and survives reload`, async ({ page }) => {
    const state = await mockSession(page)
    state.current.type = type
    state.current.drivers[0].virtualFuelUnits = 1700
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/display/driver/driver-1#chaos=personal-test-token')
    await page.getByTestId('fuel-mode-percent').check()
    await page.getByTestId('fuel-target-percent').fill('25')
    await expect(page.getByTestId('fuel-target-preview')).toContainText('at least 25 %')
    await expect(page.getByTestId('fuel-refill-preview')).toContainText('add 8 %')
    await expect(page.getByTestId('fuel-refill-preview')).toContainText('not yet calculable')
    expect(state.writes).toEqual([])
    await page.getByTestId('fuel-plan-save').click()
    await expect(page.getByTestId('fuel-saved-plan')).toHaveText('Saved: target at least 25 % fuel level.')
    expect(state.writes[0].body).toEqual({ targetUnits: 2500, expectedVersion: 0 })
    await expect(page.getByTestId('pit-fuel-level-entry-1')).toContainText('17 %')
    await page.reload()
    await expect(page.getByTestId('fuel-target-percent')).toHaveValue('25')
    await expect(page.getByTestId('fuel-plan-clear')).toBeEnabled()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}

test('percent targets validate boundaries and replace or clear the same lap plan', async ({ page }) => {
  const state = await mockSession(page)
  state.current.virtualFuelEvents = [1, 2, 3].map((id) => ({ id, sessionDriverId: 'entry-1', kind: 'lap', units: 100 }))
  Object.assign(state.current.drivers[0], { pendingFuelLaps: 25, pendingFuelUnits: 2500, fuelPlanVersion: 1 })
  await page.goto('/display/driver/driver-1#chaos=personal-test-token')
  await page.getByTestId('fuel-mode-percent').check()
  for (const invalid of ['', '-1', '101', '12.5']) {
    await page.getByTestId('fuel-target-percent').fill(invalid)
    await expect(page.getByTestId('fuel-plan-save')).toBeDisabled()
  }
  expect(state.writes).toEqual([])
  await page.getByTestId('fuel-target-percent').fill('0')
  await expect(page.getByTestId('fuel-refill-preview')).toContainText('add 0 %')
  await expect(page.getByTestId('fuel-refill-preview')).toContainText('72.5 %')
  await page.getByTestId('fuel-plan-save').click()
  await expect(page.getByTestId('fuel-saved-plan')).toHaveText('Saved: target at least 0 % fuel level.')
  expect(state.writes[0].body).toEqual({ targetUnits: 0, expectedVersion: 1 })
  await page.getByTestId('fuel-plan-clear').click()
  await expect(page.getByTestId('fuel-saved-plan')).toContainText('No individual target')
  expect(state.writes[1].body).toEqual({ targetLaps: null, expectedVersion: 2 })
  await page.getByTestId('fuel-target-percent').fill('100')
  await page.getByTestId('fuel-plan-save').click()
  await expect(page.getByTestId('fuel-saved-plan')).toContainText('100 %')
  await page.getByTestId('fuel-mode-laps').check()
  await page.getByTestId('fuel-target-laps').fill('10')
  await page.getByTestId('fuel-plan-save').click()
  await expect(page.getByTestId('fuel-saved-plan')).toContainText('10 laps')
  expect(state.writes[3].body).toEqual({ targetLaps: 10, expectedVersion: 4 })
})

test('percent target shares pending, refresh failure and read-only locks', async ({ page }) => {
  const state = await mockSession(page)
  let release
  state.planGate = new Promise((resolve) => {
    release = resolve
  })
  await page.goto('/display/driver/driver-1#chaos=personal-test-token')
  await page.getByTestId('fuel-mode-percent').check()
  await page.getByTestId('fuel-target-percent').fill('30')
  await page.getByTestId('fuel-plan-save').click()
  await expect(page.getByTestId('fuel-target-percent')).toBeDisabled()
  await expect(page.getByTestId('fuel-mode-laps')).toBeDisabled()
  await page.getByTestId('fuel-plan-save').evaluate((button) => button.click())
  state.failRead = true
  release()
  await expect(page.getByTestId('fuel-plan-error')).toContainText('server accepted the plan')
  expect(state.writes).toHaveLength(1)
  state.failRead = false
  await page.goto('/display/driver/driver-1')
  await expect(page.getByTestId('fuel-target-percent')).toBeDisabled()
  await expect(page.getByTestId('fuel-mode-laps')).toBeDisabled()
  await expect(page.getByTestId('fuel-plan-clear')).toBeDisabled()
})

for (const type of ['race', 'qualif']) {
  test(`${type} shows own finish fuel demand and copies it without changing the saved plan`, async ({ page }) => {
    const state = await mockSession(page)
    Object.assign(state.current, { type, status: 'paused', maxLaps: 20 })
    Object.assign(state.current.drivers[0], {
      totalLaps: 10,
      virtualFuelUnits: 1700,
      pendingFuelLaps: 25,
      pendingFuelUnits: 2500,
    })
    state.current.drivers[1].totalLaps = 19
    state.current.virtualFuelEvents = [1, 2, 3].map((id) => ({
      id,
      sessionDriverId: 'entry-1',
      kind: 'lap',
      units: 100,
    }))
    state.current.virtualFuelEvents.push({ id: 4, sessionDriverId: 'entry-2', kind: 'lap', units: 9000 })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/display/driver/driver-1#chaos=personal-test-token')
    await expect(page.getByTestId('fuel-finish-laps')).toContainText('10 laps remaining')
    await expect(page.getByTestId('fuel-finish-demand')).toContainText('10 % fuel level')
    await expect(page.getByTestId('fuel-finish-balance')).toContainText('reserve')
    await expect(page.getByTestId('fuel-finish-balance')).toContainText('7 %')
    await page.getByTestId('fuel-mode-percent').check()
    await page.getByTestId('fuel-finish-use').click()
    await expect(page.getByTestId('fuel-target-laps')).toHaveValue('10')
    await expect(page.getByTestId('fuel-target-preview')).toContainText('10 %')
    await expect(page.getByTestId('fuel-saved-plan')).toContainText('25 laps')
    expect(state.writes).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}

test('live finish demand uses completed laps rather than penalty classification and preserves an existing plan', async ({
  page,
}) => {
  const state = await mockSession(page, { withLive: true })
  state.current.maxLaps = 20
  Object.assign(state.current.drivers[0], {
    totalLaps: 10,
    virtualFuelUnits: 1700,
    pendingFuelLaps: 25,
    pendingFuelUnits: 2500,
  })
  state.current.virtualFuelEvents = [1, 2, 3].map((id) => ({ id, sessionDriverId: 'entry-1', kind: 'lap', units: 100 }))
  await page.goto('/display/driver/driver-1#chaos=personal-test-token')
  await expect(page.getByTestId('fuel-finish-laps')).toContainText('10 laps remaining')
  await expect.poll(state.connected).toBe(2)
  const entry = {
    ...state.current.drivers[0],
    sessionId: state.current.id,
    totalLaps: 13,
    classifiedLaps: 10,
    penaltyLaps: 3,
    virtualFuelUnits: 700,
  }
  state.sendLeaderboard([entry])
  await expect(page.getByTestId('fuel-finish-laps')).toContainText('7 laps remaining')
  await expect(page.getByTestId('fuel-finish-demand')).toContainText('7 % fuel level')
  await expect(page.getByTestId('fuel-finish-balance')).toContainText('0 %')
  state.sendLeaderboard([{ ...entry, totalLaps: 14, virtualFuelUnits: 400 }])
  await expect(page.getByTestId('fuel-finish-laps')).toContainText('6 laps remaining')
  await expect(page.getByTestId('fuel-finish-balance')).toContainText('short by an estimated 2 %')
  await expect(page.getByTestId('fuel-saved-plan')).toContainText('25 laps')
  expect(state.writes).toEqual([])
  await page.getByTestId('fuel-finish-use').click()
  await expect(page.getByTestId('fuel-target-laps')).toHaveValue('6')
  expect(state.writes).toEqual([])
  await page.getByTestId('fuel-plan-save').click()
  await expect(page.getByTestId('fuel-saved-plan')).toContainText('6 laps')
  expect(state.writes[0].body).toEqual({ targetLaps: 6, expectedVersion: 0 })
})

test('finish demand keeps timed sessions, missing data, capacity and reached targets explicit', async ({ page }) => {
  const state = await mockSession(page)
  state.current.virtualFuelEvents = [1, 2, 3].map((id) => ({ id, sessionDriverId: 'entry-1', kind: 'lap', units: 100 }))
  await page.goto('/display/driver/driver-1#chaos=personal-test-token')
  for (const setup of [
    { maxLaps: null, totalLaps: 10, expected: 'cannot be calculated' },
    { maxLaps: 20, totalLaps: null, expected: 'cannot be calculated' },
    { maxLaps: 20, totalLaps: -1, expected: 'cannot be calculated' },
    { maxLaps: 20, totalLaps: 20, expected: 'has been reached' },
    { maxLaps: 20, totalLaps: 21, expected: 'has been reached' },
  ]) {
    state.current.maxLaps = setup.maxLaps
    state.current.maxDuration = 60000
    state.current.drivers[0].totalLaps = setup.totalLaps
    await page.reload()
    await expect(page.getByTestId('fuel-finish-laps')).toContainText(setup.expected)
    await expect(page.getByTestId('fuel-finish-demand')).toHaveCount(0)
    await expect(page.getByTestId('fuel-finish-use')).toBeDisabled()
  }
  state.current.maxLaps = 102
  state.current.drivers[0].totalLaps = 1
  await page.reload()
  await expect(page.getByTestId('fuel-finish-demand')).toContainText('one full tank cannot reach')
  await expect(page.getByTestId('fuel-finish-use')).toBeDisabled()
  state.current.maxLaps = 101
  await page.reload()
  await expect(page.getByTestId('fuel-finish-demand')).toContainText('100 % fuel level')
  await expect(page.getByTestId('fuel-finish-use')).toBeEnabled()
  state.current.virtualFuelEvents = []
  await page.reload()
  await expect(page.getByTestId('fuel-finish-demand')).toContainText('not yet calculable')
  await expect(page.getByTestId('fuel-finish-use')).toBeDisabled()
  state.current.virtualFuelEvents = [1, 2, 3].map((id) => ({ id, sessionDriverId: 'entry-1', kind: 'lap', units: 100 }))
  state.current.drivers[0].virtualFuelUnits = null
  await page.reload()
  await expect(page.getByTestId('fuel-finish-balance')).toContainText('current virtual fuel level is unavailable')
  expect(state.writes).toEqual([])
})

test('finish target input obeys access, DNF, finish and pending-save locks', async ({ page }) => {
  const state = await mockSession(page)
  state.current.maxLaps = 20
  state.current.virtualFuelEvents = [1, 2, 3].map((id) => ({ id, sessionDriverId: 'entry-1', kind: 'lap', units: 100 }))
  await page.goto('/display/driver/driver-1')
  await expect(page.getByTestId('fuel-finish-use')).toBeDisabled()
  state.current.drivers[0].isDNF = true
  await page.goto('/display/driver/driver-1#chaos=personal-test-token')
  await expect(page.getByTestId('fuel-finish-use')).toBeDisabled()
  state.current.drivers[0].isDNF = false
  state.current.status = 'finishing'
  await page.reload()
  await expect(page.getByTestId('fuel-finish-use')).toBeDisabled()
  state.current.status = 'active'
  await page.reload()
  await page.getByTestId('fuel-finish-use').click()
  let release
  state.planGate = new Promise((resolve) => {
    release = resolve
  })
  await page.getByTestId('fuel-plan-save').click()
  await expect(page.getByTestId('fuel-finish-use')).toBeDisabled()
  release()
  await expect(page.getByTestId('fuel-finish-use')).toBeEnabled()
  expect(state.writes).toHaveLength(1)
  state.current.virtualFuelRate = null
  await page.reload()
  await expect(page.getByTestId('fuel-finish-plan')).toHaveCount(0)
})

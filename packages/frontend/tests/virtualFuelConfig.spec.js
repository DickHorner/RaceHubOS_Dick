import { test, expect } from '@playwright/test'

test.use({ locale: 'en-US' })

async function openSession(page, mode = 'free', rate = null, type = mode === 'free' ? 'practice' : 'race') {
  const track = { id: 'fuel-track', name: 'Fuel circuit' }
  const driver = { id: 'fuel-driver', name: 'Fuel driver', color: '#ef4444' }
  const car = { id: 'fuel-car', brand: 'Carrera', model: 'Fuel car' }
  const state = {
    current: {
      id: 'fuel-session',
      name: 'Fuel session',
      type,
      status: 'draft',
      trackId: track.id,
      track,
      virtualFuelRate: rate,
      fuelMode: 'OFF',
      weatherSeed: null,
      damageLapThresholdMs: null,
      championshipId: mode === 'free' ? null : 'fuel-cup',
      drivers: [{ id: 'fuel-entry', controller: 0, driverId: driver.id, carId: car.id, driver, car, totalLaps: 0 }],
    },
    writes: [],
    reject: false,
    failReload: false,
  }
  // This fixture owns its device and session state; live broadcasts must not
  // replace it while the test exercises configuration persistence.
  await page.routeWebSocket('**/socket.io/**', (socket) => socket.close())
  await page.route('**/socket.io/**', (route) => route.abort())
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok' } }))
  await page.route('**/api/devices', (route) => route.fulfill({ json: { success: true, data: [] } }))
  await page.route('**/api/preferences/**', (route) => route.fulfill({ json: { success: true, data: null } }))
  await page.route('**/api/tracks', (route) => route.fulfill({ json: { success: true, data: [track] } }))
  await page.route('**/api/drivers', (route) => route.fulfill({ json: { success: true, data: [driver] } }))
  await page.route('**/api/cars', (route) => route.fulfill({ json: { success: true, data: [car] } }))
  await page.route('**/api/bluetooth/status', (route) =>
    route.fulfill({ json: { connected: true, deviceType: 'simulator' } })
  )
  await page.route('**/api/records/track/**', (route) =>
    route.fulfill({ json: { success: true, data: { practice: [], qualif: [], race: [] } } })
  )
  await page.route('**/api/sessions?*', (route) => route.fulfill({ json: { success: true, data: [state.current] } }))
  await page.route('**/api/sessions/fuel-session/leaderboard', (route) =>
    route.fulfill({ json: { success: true, data: [] } })
  )
  await page.route('**/api/sync/load-session/fuel-session', (route) => route.fulfill({ json: { success: true } }))
  await page.route('**/api/sessions/fuel-session', (route) => {
    if (route.request().method() === 'PUT') {
      const changes = route.request().postDataJSON()
      state.writes.push(changes)
      if (state.reject) return route.fulfill({ status: 409, json: { success: false, error: 'Session changed' } })
      state.current = { ...state.current, ...changes }
    } else if (state.failReload) {
      return route.fulfill({ status: 500, json: { success: false, error: 'Read failed' } })
    }
    return route.fulfill({ json: { success: true, data: state.current } })
  })
  await page.route('**/api/championships/fuel-cup', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          id: 'fuel-cup',
          name: 'Fuel cup',
          mode: 'manual',
          status: 'planned',
          track,
          participants: [],
        },
      },
    })
  )
  await page.route('**/api/championships/fuel-cup/standings?type=*', (route) =>
    route.fulfill({ json: { success: true, standings: [] } })
  )
  await page.route('**/api/championships/fuel-cup/team-standings', (route) =>
    route.fulfill({ json: { success: true, standings: [], legacyRaces: 0 } })
  )
  await page.addInitScript((type) => {
    localStorage.setItem('racehubos-free-track', 'fuel-track')
    localStorage.setItem('racehubos-free-type', type)
    localStorage.setItem('championship_fuel-cup_session', 'fuel-session')
  }, type)
  await page.goto(mode === 'free' ? '/race' : '/championships/fuel-cup')
  await expect(page.getByTestId('virtual-fuel-config')).toBeVisible()
  return state
}

for (const mode of ['free', 'championship']) {
  test(`${mode}: virtual consumption can be enabled, edited, reloaded and disabled`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const hardwareWrites = []
    page.on('request', (request) => {
      if (request.url().includes('/api/bluetooth/') && request.method() !== 'GET') hardwareWrites.push(request.url())
    })
    const state = await openSession(page, mode)
    const enabled = page.getByTestId('virtual-fuel-enabled')
    const rate = page.getByTestId('virtual-fuel-rate')
    await expect(enabled).not.toBeChecked()
    await expect(rate).toBeDisabled()
    await enabled.click()
    await expect(rate).toBeEnabled()
    await expect(rate).toHaveValue('1')
    await rate.fill('7')
    await rate.blur()
    await expect.poll(() => state.current.virtualFuelRate).toBe(7)
    await expect(enabled).toBeEnabled()
    await page.reload()
    await expect(rate).toHaveValue('7')
    await expect(enabled).toBeChecked()
    await enabled.click()
    await expect.poll(() => state.current.virtualFuelRate).toBeNull()
    await expect(enabled).not.toBeChecked()
    await expect(rate).toBeDisabled()
    expect(state.writes).toEqual([{ virtualFuelRate: 1 }, { virtualFuelRate: 7 }, { virtualFuelRate: null }])
    expect(state.current.fuelMode).toBe('OFF')
    expect(hardwareWrites).toEqual([])
  })
}

test('invalid fuel rates are rejected locally and a valid correction clears the error', async ({ page }) => {
  const state = await openSession(page, 'free', 8)
  const rate = page.getByTestId('virtual-fuel-rate')
  for (const value of ['0', '101', '1.5', '']) {
    await rate.fill(value)
    await rate.blur()
    await expect(page.getByTestId('virtual-fuel-error')).toContainText('whole number from 1 to 100')
    await expect(page.getByTestId('session-section').getByRole('button', { name: 'Start', exact: true })).toBeDisabled()
  }
  expect(state.writes).toEqual([])
  await rate.fill('8')
  await rate.blur()
  await expect(page.getByTestId('virtual-fuel-error')).toHaveCount(0)
  expect(state.writes).toEqual([])
  await rate.fill('100')
  await rate.blur()
  await expect.poll(() => state.current.virtualFuelRate).toBe(100)
})

test('failed fuel writes keep the saved selection and allow an explicit retry', async ({ page }) => {
  const state = await openSession(page)
  state.reject = true
  await page.getByTestId('virtual-fuel-enabled').click()
  await expect(page.getByTestId('virtual-fuel-error')).toContainText('could not be confirmed')
  await expect(page.getByTestId('virtual-fuel-enabled')).not.toBeChecked()
  await expect(page.getByTestId('virtual-fuel-enabled')).toBeEnabled()
  expect(state.current.virtualFuelRate).toBeNull()
  state.reject = false
  await page.getByTestId('virtual-fuel-enabled').click()
  await expect(page.getByTestId('virtual-fuel-enabled')).toBeChecked()
  await expect(page.getByTestId('virtual-fuel-error')).toHaveCount(0)
})

test('failed reload after saving fuel is visible rather than claiming the display is current', async ({ page }) => {
  const state = await openSession(page)
  state.failReload = true
  await page.getByTestId('virtual-fuel-enabled').click()
  await expect(page.getByTestId('virtual-fuel-error')).toContainText('could not be confirmed')
  await expect(page.getByTestId('virtual-fuel-enabled')).not.toBeChecked()
  expect(state.current.virtualFuelRate).toBe(1)
  state.failReload = false
  await page.getByTestId('virtual-fuel-reload').click()
  await expect(page.getByTestId('virtual-fuel-enabled')).toBeChecked()
  await expect(page.getByTestId('virtual-fuel-rate')).toHaveValue('1')
})

test('pending fuel writes lock consumption controls and race start until persistence completes', async ({ page }) => {
  const state = await openSession(page)
  let release
  const pending = new Promise((resolve) => {
    release = resolve
  })
  await page.route('**/api/sessions/fuel-session', async (route) => {
    if (route.request().method() === 'PUT') await pending
    await route.fallback()
  })
  await page.getByTestId('virtual-fuel-enabled').click()
  await expect(page.getByTestId('virtual-fuel-enabled')).toBeDisabled()
  await expect(page.getByTestId('virtual-fuel-rate')).toBeDisabled()
  await expect(page.getByTestId('session-section').getByRole('button', { name: 'Start', exact: true })).toBeDisabled()
  await expect(page.getByRole('status').filter({ hasText: 'Saving fuel consumption setting' })).toBeVisible()
  release()
  await expect(page.getByTestId('virtual-fuel-enabled')).toBeEnabled()
  await expect(page.getByTestId('virtual-fuel-enabled')).toBeChecked()
  await expect(page.getByTestId('session-section').getByRole('button', { name: 'Start', exact: true })).toBeEnabled()
  expect(state.writes).toEqual([{ virtualFuelRate: 1 }])
})

test('running, paused and finished sessions keep fuel settings discoverable but locked', async ({ page }) => {
  const state = await openSession(page, 'free', 5)
  for (const status of ['active', 'paused', 'finished']) {
    state.current = { ...state.current, status }
    await page.reload()
    await expect(page.getByTestId('virtual-fuel-config')).toBeVisible()
    await expect(page.getByTestId('virtual-fuel-enabled')).toBeChecked()
    await expect(page.getByTestId('virtual-fuel-enabled')).toBeDisabled()
    await expect(page.getByTestId('virtual-fuel-rate')).toHaveValue('5')
    await expect(page.getByTestId('virtual-fuel-rate')).toBeDisabled()
    await expect(page.getByText('Consumption can only be changed before the start.')).toBeVisible()
  }
  expect(state.writes).toEqual([])
})

for (const mode of ['free', 'championship']) {
  test(`${mode}: required pit stops persist, reload and can be disabled before start`, async ({ page }) => {
    const state = await openSession(page, mode)
    const count = page.getByTestId('required-pits-count')
    await expect(count).toHaveValue('0')
    await count.fill('2')
    await count.blur()
    await expect.poll(() => state.current.requiredPitStops).toBe(2)
    await page.reload()
    await expect(count).toHaveValue('2')
    await count.fill('0')
    await count.blur()
    await expect.poll(() => state.current.requiredPitStops).toBe(0)
    expect(state.writes).toEqual([{ requiredPitStops: 2 }, { requiredPitStops: 0 }])
  })
}

test('invalid required pit counts block start until corrected without a write', async ({ page }) => {
  const state = await openSession(page)
  const count = page.getByTestId('required-pits-count')
  const start = page.getByTestId('session-section').getByRole('button', { name: 'Start', exact: true })
  for (const value of ['-1', '101', '1.5', '']) {
    await count.fill(value)
    await count.blur()
    await expect(page.getByTestId('required-pits-error')).toBeVisible()
    await expect(start).toBeDisabled()
  }
  expect(state.writes).toEqual([])
  await count.fill('0')
  await count.blur()
  await expect(page.getByTestId('required-pits-error')).toHaveCount(0)
  await expect(start).toBeEnabled()
})

test('required pit save and reload failures stay visible and require recovery', async ({ page }) => {
  const state = await openSession(page)
  state.reject = true
  const count = page.getByTestId('required-pits-count')
  await count.fill('2')
  await count.blur()
  await expect(page.getByTestId('required-pits-error')).toContainText('could not be confirmed saved')
  expect(state.current.requiredPitStops).toBeUndefined()
  state.reject = false
  state.failReload = true
  await count.fill('3')
  await count.blur()
  await expect.poll(() => state.current.requiredPitStops).toBe(3)
  await expect(page.getByTestId('required-pits-error')).toBeVisible()
  state.failReload = false
  await page.getByTestId('required-pits-reload').click()
  await expect(count).toHaveValue('3')
  await expect(page.getByTestId('required-pits-error')).toHaveCount(0)
})

test('required pit rules stay visible and locked after session start', async ({ page }) => {
  const state = await openSession(page)
  state.current.requiredPitStops = 2
  state.current.status = 'active'
  await page.reload()
  await expect(page.getByTestId('required-pits-count')).toHaveValue('2')
  await expect(page.getByTestId('required-pits-count')).toBeDisabled()
  await expect(page.getByTestId('required-pits-config')).toContainText('locked after session start')
  expect(state.writes).toEqual([])
})

for (const [mode, type] of [
  ['free', 'race'],
  ['free', 'qualif'],
  ['championship', 'race'],
]) {
  test(`${mode} ${type}: weight scoring saves, reloads and disables with virtual fuel`, async ({ page }) => {
    const state = await openSession(page, mode, 6, type)
    const weight = page.getByTestId('fuel-weight-config')
    await expect(weight).toBeEnabled()
    await weight.fill('10')
    await weight.blur()
    await expect.poll(() => state.current.fuelWeightPercent).toBe(10)
    await page.reload()
    await expect(weight).toHaveValue('10')
    await page.getByTestId('virtual-fuel-enabled').click()
    await expect.poll(() => state.current.fuelWeightPercent).toBe(0)
    await expect(weight).toBeDisabled()
    expect(state.writes).toEqual([{ fuelWeightPercent: 10 }, { virtualFuelRate: null, fuelWeightPercent: 0 }])
    expect(state.current.fuelMode).toBe('OFF')
  })
}

test('weight validation and failed saves block start; active and finished sessions stay locked', async ({ page }) => {
  const state = await openSession(page, 'free', 6, 'qualif')
  const weight = page.getByTestId('fuel-weight-config')
  for (const value of ['-1', '31', '1.5', '']) {
    await weight.fill(value)
    await weight.blur()
    await expect(page.getByTestId('virtual-fuel-error')).toContainText('whole number from 0 to 30')
    await expect(page.getByTestId('session-section').getByRole('button', { name: 'Start', exact: true })).toBeDisabled()
  }
  expect(state.writes).toEqual([])
  state.reject = true
  await weight.fill('30')
  await weight.blur()
  await expect(page.getByTestId('virtual-fuel-error')).toContainText('could not be confirmed')
  expect(state.current.fuelWeightPercent).toBeUndefined()
  state.reject = false
  await weight.fill('30')
  await weight.blur()
  await expect.poll(() => state.current.fuelWeightPercent).toBe(30)
  for (const status of ['active', 'paused', 'finished']) {
    state.current.status = status
    await page.reload()
    await expect(weight).toHaveValue('30')
    await expect(weight).toBeDisabled()
  }
})

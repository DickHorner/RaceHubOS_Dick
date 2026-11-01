import { test, expect } from '@playwright/test'

test.use({ locale: 'en-US' })

async function setup(page, { enabled = true, audioState = 'running', failAudio = false, failStart = false } = {}) {
  const track = { id: 'trace-track', name: 'Trace circuit' }
  const driver = { id: 'trace-driver', name: 'Trace driver' }
  const car = { id: 'trace-car', brand: 'Carrera', model: 'Trace car' }
  let session = {
    id: 'trace-session',
    name: 'Trace session',
    type: 'race',
    status: 'draft',
    trackId: track.id,
    track,
    fuelMode: 'OFF',
    virtualFuelRate: null,
    requiredPitStops: 0,
    drivers: [{ id: 'trace-entry', controller: 0, driverId: driver.id, carId: car.id, driver, car, totalLaps: 0 }],
  }
  const rows = []
  const requests = []
  page.on('console', async (message) => {
    if (message.type() !== 'info') return
    const args = message.args()
    if (args.length === 2 && (await args[0].jsonValue()) === '[BrowserStartTrace]') rows.push(await args[1].jsonValue())
  })
  await page.addInitScript(
    ({ enabled, audioState, failAudio }) => {
      if (enabled) sessionStorage.setItem('racehubos-start-trace', '1')
      localStorage.setItem('racehubos-free-track', 'trace-track')
      localStorage.setItem('racehubos-free-type', 'race')
      window.__beeps = []
      window.AudioContext = class {
        state = audioState
        currentTime = 0.25
        destination = {}
        createOscillator() {
          if (failAudio) throw new Error('Test audio failure')
          const osc = {
            frequency: {},
            connect() {},
            start() {
              window.__beeps.push(osc.frequency.value)
            },
            stop() {},
          }
          return osc
        }
        createGain() {
          return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }
        }
      }
    },
    { enabled, audioState, failAudio }
  )
  const sockets = []
  await page.routeWebSocket('**/socket.io/**', (socket) => {
    const connection = { socket, ready: false }
    sockets.push(connection)
    socket.onMessage((message) => {
      if (message === '40') {
        socket.send('40{"sid":"trace-test"}')
        connection.ready = true
      }
    })
    socket.send('0{"sid":"trace-test","upgrades":[],"pingInterval":25000,"pingTimeout":20000}')
  })
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok' } }))
  await page.route('**/api/**', (route) => route.fulfill({ json: { success: true, data: [] } }))
  await page.route('**/api/preferences/**', (route) => route.fulfill({ json: { success: true, data: null } }))
  for (const [name, data] of Object.entries({ tracks: [track], drivers: [driver], cars: [car] })) {
    await page.route('**/api/' + name, (route) => route.fulfill({ json: { success: true, data } }))
  }
  await page.route('**/api/bluetooth/status', (route) =>
    route.fulfill({ json: { connected: true, deviceType: 'simulator', lastStatus: { start: 9 } } })
  )
  await page.route('**/api/sessions?*', (route) => route.fulfill({ json: { success: true, data: [session] } }))
  await page.route('**/api/sessions/trace-session', (route) =>
    route.fulfill({ json: { success: true, data: session } })
  )
  await page.route('**/api/sessions/trace-session/start', (route) => {
    requests.push('prepare')
    if (failStart) return route.fulfill({ status: 409, json: { success: false, error: 'Test conflict' } })
    session = { ...session, status: 'active' }
    return route.fulfill({ json: { success: true, data: session } })
  })
  await page.route('**/api/bluetooth/start-race', (route) => {
    requests.push('advance')
    return route.fulfill({ json: { success: true } })
  })
  await page.goto('/race')
  const start = page.getByTestId('session-section').getByRole('button', { name: 'Start', exact: true })
  await expect(start).toBeEnabled()
  await expect.poll(() => sockets.filter((c) => c.ready).length).toBe(2)
  await start.click()
  if (failStart) await expect(page.getByRole('alert')).toContainText('Test conflict')
  else await expect(page.getByTestId('virtual-fuel-enabled')).toBeDisabled()
  const send = (event, data) => {
    for (const c of sockets.filter((c) => c.ready)) c.socket.send('42' + JSON.stringify([event, data]))
  }
  return { rows, requests, send }
}

test('browser capture follows click, HTTP, received lights, effects and actual audio scheduling', async ({ page }) => {
  const { rows, requests, send } = await setup(page)
  await expect.poll(() => rows.some((row) => row.phase === 'http:response')).toBe(true)
  for (const start of [1, 2, 3, 4, 5, 7, 0]) {
    send('cu:status', { start })
    await expect.poll(() => rows.some((row) => row.phase === 'light:effect' && row.start === start)).toBe(true)
    send('cu:status', { start })
    if (start === 1) {
      await page.getByTestId('start-lights-advance').click()
      await expect.poll(() => rows.some((row) => row.phase === 'advance:http:response')).toBe(true)
    }
  }
  await expect.poll(() => rows.at(-1)?.phase).toBe('racing')
  expect(rows.filter((row) => row.phase === 'status:received').map((row) => row.start)).toEqual([1, 2, 3, 4, 5, 7, 0])
  expect(rows.filter((row) => row.phase === 'audio:scheduled').map((row) => row.frequency)).toEqual([
    600, 600, 600, 600, 600, 1200,
  ])
  expect(requests).toEqual(['prepare', 'advance'])
  for (const start of [1, 2, 3, 4, 5, 7, 0]) {
    const received = rows.findIndex((row) => row.phase === 'status:received' && row.start === start)
    const effect = rows.findIndex((row) => row.phase === 'light:effect' && row.start === start)
    expect(effect).toBeGreaterThan(received)
    expect(rows[effect + 1].phase).toBe(start === 0 ? 'racing' : 'audio:scheduled')
  }
  expect(rows.every((row, i) => !i || row.elapsedMs >= rows[i - 1].elapsedMs)).toBe(true)
  expect(rows.every((row) => row.sessionId === 'trace-session' && row.traceId === rows[0].traceId)).toBe(true)
  expect(JSON.stringify(rows)).not.toMatch(/secret|token|address|Test audio failure/)
})

test('capture is off by default while lights and beeps still execute', async ({ page }) => {
  const { rows, send, requests } = await setup(page, { enabled: false })
  send('cu:status', { start: 1 })
  await expect.poll(() => page.evaluate(() => window.__beeps)).toEqual([600])
  expect(rows).toEqual([])
  expect(requests).toEqual(['prepare'])
})

test('suspended audio is recorded as scheduled, without claiming audible playback', async ({ page }) => {
  const { rows, send } = await setup(page, { audioState: 'suspended' })
  send('cu:status', { start: 1 })
  await expect.poll(() => rows.find((row) => row.phase === 'audio:scheduled')?.contextState).toBe('suspended')
})

test('audio failure is visible without logging the exception or stopping the light sequence', async ({ page }) => {
  const { rows, send } = await setup(page, { failAudio: true })
  send('cu:status', { start: 1 })
  await expect.poll(() => rows.some((row) => row.phase === 'audio:failed')).toBe(true)
  expect(rows.some((row) => row.phase === 'audio:scheduled')).toBe(false)
  await expect(page.getByTestId('start-lights-advance')).toBeVisible()
  expect(JSON.stringify(rows)).not.toContain('Test audio failure')
})

test('rejected start ends capture without a false successful start', async ({ page }) => {
  const { rows, requests } = await setup(page, { failStart: true })
  await expect.poll(() => rows.at(-1)?.phase).toBe('failed')
  expect(rows.map((row) => row.phase)).toEqual(['click', 'http:response', 'failed'])
  expect(rows[1].status).toBe(409)
  expect(requests).toEqual(['prepare'])
})

test('CU disconnect ends capture and later statuses do not extend it', async ({ page }) => {
  const { rows, send } = await setup(page)
  send('cu:status', { start: 1 })
  await expect.poll(() => rows.some((row) => row.phase === 'audio:scheduled')).toBe(true)
  send('cu:disconnected', {})
  await expect.poll(() => rows.at(-1)?.phase).toBe('disconnected')
  const count = rows.length
  send('cu:status', { start: 2 })
  await expect.poll(() => page.evaluate(() => window.__beeps)).toEqual([600, 600])
  expect(rows).toHaveLength(count)
})

test('verified false start stays visible through 7 and 0, retries produce exactly one GO', async ({ page }) => {
  const { rows, send } = await setup(page)
  const sendStatus = async (start) => {
    const count = rows.filter((row) => row.phase === 'light:effect' && row.start === start).length
    send('cu:status', { start })
    await expect
      .poll(() => rows.filter((row) => row.phase === 'light:effect' && row.start === start).length)
      .toBeGreaterThan(count)
  }
  for (const start of [1, 2, 3, 4, 5, 6]) await sendStatus(start)
  for (const start of [7, 0, 2, 5, 7, 0]) {
    await sendStatus(start)
    await expect(page.getByText('FALSE START', { exact: true })).toBeVisible()
    await expect(page.getByText('GO!', { exact: true })).toHaveCount(0)
  }
  expect(await page.evaluate(() => window.__beeps)).toEqual([600, 600, 600, 600, 600, 300])
  expect(rows.some((row) => row.phase === 'racing')).toBe(false)
  for (const start of [1, 2, 3, 4, 5, 7, 0]) await sendStatus(start)
  await expect(page.getByText('FALSE START', { exact: true })).toHaveCount(0)
  await expect(page.getByText('GO!', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.__beeps)).toEqual([
    600, 600, 600, 600, 600, 300, 600, 600, 600, 600, 600, 1200,
  ])
  await expect(page.getByText('GO!', { exact: true })).toHaveCount(0, { timeout: 4000 })
})

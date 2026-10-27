import { test, expect } from '@playwright/test'

test.use({ locale: 'en-US' })

const track = { id: 'voice-track', name: 'Voice Circuit' }
const driverOne = { id: 'voice-driver-one', name: 'Driver One', color: '#ef4444' }
const driverTwo = { id: 'voice-driver-two', name: 'Driver Two', color: '#3b82f6' }
const car = { id: 'voice-car', brand: 'BMW', model: 'M4' }
const startedAt = '2026-10-27T10:00:00.000Z'
const race = {
  id: 'voice-race',
  name: 'Voice Race',
  type: 'race',
  status: 'active',
  trackId: track.id,
  track,
  startedAt,
  maxLaps: 12,
  drivers: [
    { id: 'voice-entry-one', controller: 0, driverId: driverOne.id, driver: driverOne, car, totalLaps: 3 },
    { id: 'voice-entry-two', controller: 1, driverId: driverTwo.id, driver: driverTwo, car, totalLaps: 2 },
  ],
}

function leaderboard(leader, laps, otherLaps = laps - 1) {
  const oneLeads = leader === 'one'
  return [
    {
      id: 'voice-entry-one',
      position: oneLeads ? 1 : 2,
      totalLaps: oneLeads ? laps : otherLaps,
      driver: driverOne,
    },
    {
      id: 'voice-entry-two',
      position: oneLeads ? 2 : 1,
      totalLaps: oneLeads ? otherLaps : laps,
      driver: driverTwo,
    },
  ]
}

async function preferences(page, events) {
  for (const [key, value] of Object.entries({
    'raceVoice:events': events,
    'bestLapVoice:enabled': false,
    'podiumVoice:enabled': false,
  })) {
    const response = await page.request.put('/api/preferences/' + key, { data: { value } })
    expect(response.ok()).toBe(true)
  }
}

async function racePage(page, current = race) {
  await page.route('**/api/tracks', (route) => route.fulfill({ json: { success: true, data: [track] } }))
  await page.route('**/api/drivers', (route) =>
    route.fulfill({ json: { success: true, data: [driverOne, driverTwo] } })
  )
  await page.route('**/api/cars', (route) => route.fulfill({ json: { success: true, data: [car] } }))
  await page.route('**/api/sessions?*', (route) => route.fulfill({ json: { success: true, data: [current] } }))
  await page.route('**/api/sessions/voice-race', (route) => route.fulfill({ json: { success: true, data: current } }))
  await page.route('**/api/sessions/voice-race/leaderboard', (route) =>
    route.fulfill({ json: { success: true, data: leaderboard('one', 3) } })
  )
  await page.route('**/api/sync/load-session/voice-race', (route) => route.fulfill({ json: { success: true } }))
  await page.route('**/api/records/track/**', (route) =>
    route.fulfill({ json: { success: true, data: { practice: [], qualif: [], race: [] } } })
  )
  await page.addInitScript(() => {
    localStorage.setItem('racehubos-free-track', 'voice-track')
    localStorage.setItem('racehubos-free-type', 'race')
  })
  await page.goto('/race')
  await expect(page.getByTestId('session-section')).toBeVisible()
}

async function audioSpy(page) {
  await page.addInitScript(() => {
    window.__spoken = []
    window.__audio = []
    window.__received = []
    window.addEventListener('session:status_changed', () => window.__received.push('status'))
    window.addEventListener('session:finished', () => window.__received.push('finish'))
    window.__holdSpeech = false
    let current = null
    const synthesis = {
      speaking: false,
      getVoices: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
      cancel() {
        this.speaking = false
      },
      speak(utterance) {
        window.__spoken.push(utterance.text)
        current = utterance
        if (window.__holdSpeech) {
          this.speaking = true
        } else {
          queueMicrotask(() => utterance.onend?.())
        }
      },
    }
    window.__releaseSpeech = () => {
      synthesis.speaking = false
      current?.onend?.()
    }
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synthesis })
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      configurable: true,
      value: class {
        constructor(text) {
          this.text = text
        }
      },
    })
    window.Audio = class {
      constructor(src) {
        this.src = src
        window.__audio.push(this)
      }
      play() {
        return Promise.resolve()
      }
      pause() {}
    }
  })
}

async function socketSpy(page) {
  const sockets = []
  await page.routeWebSocket('**/socket.io/**', (socket) => {
    const connection = { socket, ready: false }
    sockets.push(connection)
    socket.onClose(() => {
      connection.ready = false
    })
    socket.onMessage((message) => {
      if (message === '40') {
        socket.send('40{"sid":"voice-test"}')
        connection.ready = true
      }
    })
    socket.send('0{"sid":"voice-test","upgrades":[],"pingInterval":25000,"pingTimeout":20000}')
  })
  return sockets
}

function send(sockets, event, data) {
  const connected = sockets.filter((socket) => socket.ready)
  expect(connected.length).toBeGreaterThan(0)
  // Socket.IO broadcasts to both the session and device connections.
  for (const connection of connected) connection.socket.send('42' + JSON.stringify([event, data]))
}

async function spoken(page) {
  return page.evaluate(() => window.__spoken)
}

test('commentary is opt-in, saved and restored', async ({ page }) => {
  await preferences(page, null)
  await page.goto('/settings')
  const switches = page.getByRole('switch')
  await expect(switches).toHaveCount(3)
  for (const control of await switches.all()) {
    await expect(control).toHaveAttribute('aria-checked', 'false')
  }

  await page.getByRole('switch', { name: 'Announce lead changes' }).click()
  await expect
    .poll(async () => {
      const response = await page.request.get('/api/preferences/raceVoice:events')
      return (await response.json()).data
    })
    .toEqual({ start: false, leader: true, finish: false })

  await page.reload()
  await expect(page.getByRole('switch', { name: 'Announce lead changes' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('switch', { name: 'Announce race start' })).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByRole('switch', { name: 'Announce race finish' })).toHaveAttribute('aria-checked', 'false')
})

test('GO is spoken once; preparation, resume, duplicate and reload remain silent', async ({ page }) => {
  await preferences(page, { start: true, leader: false, finish: false })
  await audioSpy(page)
  const sockets = await socketSpy(page)
  await racePage(page)
  await expect.poll(() => sockets.some((socket) => socket.ready)).toBe(true)

  send(sockets, 'session:status_changed', { sessionId: race.id, status: 'active' })
  await expect.poll(() => page.evaluate(() => window.__received)).toEqual(['status'])
  send(sockets, 'session:started', { sessionId: race.id })
  send(sockets, 'session:race_resumed', { sessionId: race.id })
  expect(await spoken(page)).toEqual([])

  send(sockets, 'session:race_started', { sessionId: race.id, startedAt })
  await expect.poll(() => spoken(page)).toEqual(['The race has started'])
  send(sockets, 'session:race_started', { sessionId: race.id, startedAt })
  await expect.poll(() => spoken(page)).toEqual(['The race has started'])

  await page.reload()
  await expect.poll(() => sockets.filter((socket) => socket.ready).length).toBe(2)
  send(sockets, 'session:race_started', { sessionId: race.id, startedAt })
  await expect.poll(() => spoken(page)).toEqual([])
})

test('leader changes require identified leaders and strictly advancing completed laps', async ({ page }) => {
  await preferences(page, { start: false, leader: true, finish: false })
  await audioSpy(page)
  const sockets = await socketSpy(page)
  await racePage(page)
  await expect.poll(() => sockets.some((socket) => socket.ready)).toBe(true)

  send(sockets, 'session:leaderboard', leaderboard('one', 3))
  send(sockets, 'session:leaderboard', leaderboard('two', 4))
  await expect.poll(() => spoken(page)).toEqual(['Driver Two takes the lead'])

  send(sockets, 'session:leaderboard', leaderboard('two', 4))
  send(sockets, 'session:leaderboard', leaderboard('one', 3))
  send(sockets, 'session:leaderboard', [
    { ...leaderboard('one', 5)[0], position: 1 },
    { ...leaderboard('one', 5)[1], position: 1 },
  ])
  await expect.poll(() => spoken(page)).toEqual(['Driver Two takes the lead'])

  send(sockets, 'session:leaderboard', leaderboard('one', 5))
  await expect.poll(() => spoken(page)).toEqual(['Driver Two takes the lead', 'Driver One takes the lead'])
})

test('two race-control tabs speak each start and lead event only once', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-US' })
  try {
    const first = await context.newPage()
    const second = await context.newPage()
    await preferences(first, { start: true, leader: true, finish: false })
    await Promise.all([audioSpy(first), audioSpy(second)])
    const [one, two] = await Promise.all([socketSpy(first), socketSpy(second)])
    await Promise.all([racePage(first), racePage(second)])
    await expect.poll(() => one.some((socket) => socket.ready) && two.some((socket) => socket.ready)).toBe(true)

    for (const sockets of [one, two]) send(sockets, 'session:race_started', { sessionId: race.id, startedAt })
    await expect.poll(async () => (await spoken(first)).length + (await spoken(second)).length).toBe(1)
    for (const sockets of [one, two]) send(sockets, 'session:leaderboard', leaderboard('one', 3))
    for (const sockets of [one, two]) send(sockets, 'session:leaderboard', leaderboard('two', 4))
    await expect.poll(async () => (await spoken(first)).length + (await spoken(second)).length).toBe(2)
    const all = [...(await spoken(first)), ...(await spoken(second))]
    expect(all.sort()).toEqual(['Driver Two takes the lead', 'The race has started'].sort())
  } finally {
    await context.close()
  }
})

test('finish waits for the sound and repeated socket events do not replay audio', async ({ page }) => {
  await preferences(page, { start: false, leader: false, finish: true })
  await audioSpy(page)
  const sockets = await socketSpy(page)
  await racePage(page)
  await expect.poll(() => sockets.some((socket) => socket.ready)).toBe(true)

  const finish = { sessionId: race.id, sessionType: 'race', startedAt, leaderboard: [], reason: 'manual_stop' }
  send(sockets, 'session:finished', finish)
  await expect.poll(() => page.evaluate(() => window.__audio.length)).toBe(1)
  expect(await spoken(page)).toEqual([])
  await page.evaluate(() => window.__audio[0].onended?.())
  await expect.poll(() => spoken(page)).toEqual(['The race has finished'])
  send(sockets, 'session:finished', finish)
  await expect.poll(() => page.evaluate(() => window.__audio.length)).toBe(1)
  expect(await spoken(page)).toEqual(['The race has finished'])
})

test('busy browser speech does not cause overlapping announcements', async ({ page }) => {
  await preferences(page, { start: true, leader: true, finish: false })
  await audioSpy(page)
  const sockets = await socketSpy(page)
  await racePage(page)
  await expect.poll(() => sockets.some((socket) => socket.ready)).toBe(true)

  await page.evaluate(() => {
    window.__holdSpeech = true
  })
  send(sockets, 'session:race_started', { sessionId: race.id, startedAt })
  await expect.poll(() => spoken(page)).toEqual(['The race has started'])
  send(sockets, 'session:leaderboard', leaderboard('one', 3))
  send(sockets, 'session:leaderboard', leaderboard('two', 4))
  await expect.poll(() => spoken(page)).toEqual(['The race has started'])
  await page.evaluate(() => window.__releaseSpeech())
  expect(await spoken(page)).toEqual(['The race has started'])
})

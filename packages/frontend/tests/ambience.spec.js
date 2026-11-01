import { test, expect } from '@playwright/test'

test.use({ locale: 'en-US' })

async function openRace(page, mode = 'free') {
  const track = { id: 'ambient-track', name: 'Ambient circuit' }
  const current = {
    id: 'ambient-session',
    name: 'Ambient session',
    type: 'race',
    status: 'active',
    trackId: track.id,
    track,
    drivers: [],
    laps: [],
    penalties: [],
    virtualFuelRate: null,
    championshipId: mode === 'free' ? null : 'ambient-cup',
  }
  await page.addInitScript(() => {
    localStorage.setItem('racehubos-free-track', 'ambient-track')
    localStorage.setItem('racehubos-free-type', 'race')
    localStorage.setItem('championship_ambient-cup_session', 'ambient-session')
    window.__ambientContexts = []
    window.__ambientSpeaking = false
    window.__ambientReject = false
    window.__ambientHold = false
    Object.defineProperty(window.speechSynthesis, 'speaking', { get: () => window.__ambientSpeaking })
    const Native = window.AudioContext
    window.AudioContext = class extends Native {
      constructor(...args) {
        super(...args)
        this.__gains = []
        window.__ambientContexts.push(this)
      }
      createGain() {
        const gain = super.createGain()
        this.__gains.push(gain)
        return gain
      }
      resume() {
        if (window.__ambientReject) return Promise.reject(new DOMException('User gesture required', 'NotAllowedError'))
        if (window.__ambientHold)
          return new Promise((resolve) => {
            window.__ambientRelease = () => {
              super
                .resume()
                .then(resolve)
                .catch(() => resolve())
            }
          })
        return super.resume()
      }
    }
  })
  const sockets = []
  await page.routeWebSocket('**/socket.io/**', (socket) => {
    const connection = { socket, ready: false }
    sockets.push(connection)
    socket.onClose(() => {
      connection.ready = false
    })
    socket.onMessage((message) => {
      if (message === '40') {
        socket.send('40{"sid":"ambient-test"}')
        connection.ready = true
      }
    })
    socket.send('0{"sid":"ambient-test","upgrades":[],"pingInterval":25000,"pingTimeout":20000}')
  })
  await page.route('**/socket.io/**', (route) => route.abort())
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok' } }))
  await page.route('**/api/preferences/**', (route) => route.fulfill({ json: { success: true, data: null } }))
  await page.route('**/api/devices', (route) => route.fulfill({ json: { success: true, data: [] } }))
  await page.route('**/api/bluetooth/status', (route) => route.fulfill({ json: { connected: false } }))
  await page.route('**/api/tracks', (route) => route.fulfill({ json: { success: true, data: [track] } }))
  for (const entity of ['cars', 'drivers'])
    await page.route(`**/api/${entity}`, (route) => route.fulfill({ json: { success: true, data: [] } }))
  await page.route('**/api/records/track/**', (route) =>
    route.fulfill({ json: { success: true, data: { practice: [], qualif: [], race: [] } } })
  )
  await page.route('**/api/sessions?*', (route) => route.fulfill({ json: { success: true, data: [current] } }))
  await page.route('**/api/sessions/ambient-session', (route) =>
    route.fulfill({ json: { success: true, data: current } })
  )
  await page.route('**/api/sessions/ambient-session/leaderboard', (route) =>
    route.fulfill({ json: { success: true, data: [] } })
  )
  await page.route('**/api/sync/load-session/ambient-session', (route) => route.fulfill({ json: { success: true } }))
  await page.route('**/api/championships/ambient-cup', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: { id: 'ambient-cup', name: 'Ambient cup', mode: 'manual', status: 'planned', track, participants: [] },
      },
    })
  )
  await page.route('**/api/championships/ambient-cup/standings?*', (route) =>
    route.fulfill({ json: { success: true, standings: [] } })
  )
  await page.route('**/api/championships/ambient-cup/team-standings', (route) =>
    route.fulfill({ json: { success: true, standings: [], legacyRaces: 0 } })
  )
  await page.goto(mode === 'free' ? '/race' : '/championships/ambient-cup')
  await expect(page.getByTestId('race-ambience')).toBeVisible()
  return { current, sockets }
}

const gain = (page) => page.evaluate(() => window.__ambientContexts.at(-1).__gains[0].gain.value)
const closed = (page) => page.evaluate(() => window.__ambientContexts.every((context) => context.state === 'closed'))

for (const mode of ['free', 'championship']) {
  test(`${mode}: ambience starts only by gesture and releases audio when leaving the view`, async ({ page }) => {
    await openRace(page, mode)
    await expect.poll(() => page.evaluate(() => window.__ambientContexts.length)).toBe(0)
    await page.getByTestId('ambience-toggle').click()
    await expect(page.getByTestId('race-ambience').getByRole('status')).toHaveText('Playing')
    await expect.poll(() => page.evaluate(() => window.__ambientContexts.length)).toBe(1)
    await expect.poll(() => gain(page)).toBeCloseTo(0.2, 2)
    // Client-side navigation must unmount and release the context, not rely on a document reload.
    await page.getByRole('link', { name: 'Home', exact: true }).first().click()
    await expect(page.getByTestId('race-ambience')).toHaveCount(0)
    await expect.poll(() => closed(page)).toBe(true)
  })
}

test('real audio gain follows volume, mute, speech start and cancellation without changing speech', async ({
  page,
}) => {
  await openRace(page)
  await page.getByTestId('ambience-toggle').click()
  await page.getByTestId('ambience-volume').focus()
  await page.getByTestId('ambience-volume').press('End')
  await expect.poll(() => gain(page)).toBeCloseTo(1, 2)
  await page.evaluate(() => {
    window.__ambientSpeaking = true
  })
  await expect(page.getByTestId('race-ambience').getByRole('status')).toHaveText('Lowered for speech')
  await expect.poll(() => gain(page)).toBeCloseTo(0.2, 2)
  await page.getByTestId('ambience-mute').click()
  await expect.poll(() => gain(page)).toBeCloseTo(0, 2)
  await page.evaluate(() => {
    window.__ambientSpeaking = false
  })
  await expect(page.getByTestId('ambience-mute')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('ambience-mute').click()
  await expect.poll(() => gain(page)).toBeCloseTo(1, 2)
  await page.getByTestId('ambience-toggle').click()
  await expect.poll(() => closed(page)).toBe(true)
  await expect(page.getByTestId('race-ambience').getByRole('status')).toHaveText('Off')
})

test('browser audio refusal closes resources and allows an explicit retry', async ({ page }) => {
  await openRace(page)
  await page.evaluate(() => {
    window.__ambientReject = true
  })
  await page.getByTestId('ambience-toggle').click()
  await expect(page.getByTestId('race-ambience').getByRole('alert')).toBeVisible()
  await expect.poll(() => closed(page)).toBe(true)
  await page.evaluate(() => {
    window.__ambientReject = false
  })
  await page.getByTestId('ambience-toggle').click()
  await expect(page.getByTestId('race-ambience').getByRole('status')).toHaveText('Playing')
  await expect(page.getByTestId('race-ambience').getByRole('alert')).toHaveCount(0)
})

test('session completion stops playback and reload never auto-starts it', async ({ page }) => {
  const { current, sockets } = await openRace(page)
  await page.getByTestId('ambience-toggle').click()
  current.status = 'finished'
  await expect.poll(() => sockets.filter((socket) => socket.ready).length).toBeGreaterThan(0)
  for (const { socket, ready } of sockets)
    if (ready)
      socket.send('42' + JSON.stringify(['session:status_changed', { sessionId: current.id, status: 'finished' }]))
  await expect(page.getByTestId('race-ambience').getByRole('status')).toHaveText('Session ended – ambience off')
  await expect.poll(() => closed(page)).toBe(true)
  await expect(page.getByTestId('ambience-toggle')).toBeDisabled()
  await page.reload()
  await expect(page.getByTestId('ambience-toggle')).toBeDisabled()
  expect(await page.evaluate(() => window.__ambientContexts.length)).toBe(0)
})

test('leaving during a pending audio permission cannot start playback later', async ({ page }) => {
  await openRace(page)
  await page.evaluate(() => {
    window.__ambientHold = true
  })
  await page.getByTestId('ambience-toggle').click()
  await expect(page.getByTestId('race-ambience').getByRole('status')).toHaveText('Starting …')
  await page.getByRole('link', { name: 'Home', exact: true }).first().click()
  await page.evaluate(() => {
    window.__ambientRelease()
  })
  await expect.poll(() => closed(page)).toBe(true)
  await expect(page.getByTestId('race-ambience')).toHaveCount(0)
})

test('a stalled audio permission times out and releases resources', async ({ page }) => {
  await openRace(page)
  await page.evaluate(() => {
    window.__ambientHold = true
  })
  await page.getByTestId('ambience-toggle').click()
  await expect(page.getByTestId('race-ambience').getByRole('alert')).toBeVisible({ timeout: 10000 })
  await expect.poll(() => closed(page)).toBe(true)
  await expect(page.getByTestId('ambience-toggle')).toHaveText('Start ambience')
})

test('the original local synthesis produces a non-silent, bounded waveform', async ({ page }) => {
  await openRace(page)
  const result = await page.evaluate(async () => {
    const { createRaceAmbience } = await import('/src/lib/raceAmbience.js')
    const Native = window.AudioContext
    let context
    window.AudioContext = class extends OfflineAudioContext {
      constructor() {
        super(1, 48000, 48000)
        context = this
      }
      close() {
        return Promise.resolve()
      }
    }
    let audio
    try {
      audio = createRaceAmbience()
      audio.setVolume(1)
      const rendered = await context.startRendering()
      const samples = rendered.getChannelData(0)
      let peak = 0
      let energy = 0
      for (const sample of samples) {
        peak = Math.max(peak, Math.abs(sample))
        energy += sample * sample
      }
      return { peak, rms: Math.sqrt(energy / samples.length) }
    } finally {
      audio?.stop()
      window.AudioContext = Native
    }
  })
  expect(result.rms).toBeGreaterThan(0.001)
  expect(result.peak).toBeLessThan(1)
})

test('German ambience controls fit a narrow phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => localStorage.setItem('racehubos-lang', 'de'))
  await openRace(page)
  const panel = page.getByTestId('race-ambience')
  await expect(panel.getByRole('heading', { name: 'Lokales Rennambiente' })).toBeVisible()
  expect(await panel.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  expect(await page.evaluate(() => window.__ambientContexts.length)).toBe(0)
})

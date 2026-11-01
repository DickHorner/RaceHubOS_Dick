import { test, expect } from '@playwright/test'
import { AUTO_CUE_TYPES } from '../src/lib/soundboardAuto.js'

test.use({ locale: 'en-US' })

const credential = 'e2e-only-director-secret-for-isolated-playwright-server'

function wavFile() {
  const samples = 4000
  const data = Buffer.alloc(44 + samples * 2)
  data.write('RIFF', 0)
  data.writeUInt32LE(data.length - 8, 4)
  data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16)
  data.writeUInt16LE(1, 20)
  data.writeUInt16LE(1, 22)
  data.writeUInt32LE(8000, 24)
  data.writeUInt32LE(16000, 28)
  data.writeUInt16LE(2, 32)
  data.writeUInt16LE(16, 34)
  data.write('data', 36)
  data.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(1400 * Math.sin((2 * Math.PI * i * 440) / 8000)), 44 + i * 2)
  }
  return data
}

async function installAudioSpy(page) {
  await page.addInitScript(() => {
    window.__routingAudio = []
    const OriginalAudio = window.Audio
    window.Audio = function (src) {
      if (src?.includes('/api/upload/sounds/')) window.__routingAudio.push(src)
      return new OriginalAudio(src)
    }
  })
}

async function authorizeDirector(page) {
  await page.goto('/display/control')
  await page.getByLabel('Race director credential').fill(credential)
  await page.getByRole('button', { name: 'Unlock' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Director authorized' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Receive audio here' })).toBeVisible()
}

test('stored clips play locally or travel by HTTP to the sole enabled director receiver', async ({ page, browser }) => {
  const uploaded = []
  const directorContext = await browser.newContext({ locale: 'en-US' })
  const director = await directorContext.newPage()
  const receivedAudio = []
  director.on('response', (response) => {
    if (response.url().includes('/api/upload/sounds/')) receivedAudio.push(response)
  })
  try {
    for (let i = 0; i < 2; i++) {
      const result = await page.request.post('/api/upload/sounds', {
        multipart: { audio: { name: 'beep.wav', mimeType: 'audio/wav', buffer: wavFile() } },
      })
      expect(result.ok()).toBe(true)
      const body = await result.json()
      uploaded.push(body.data.url)
    }
    const presets = [
      { id: 'route-clip-1', label: 'Race clip', kind: 'clip', url: uploaded[0] },
      { id: 'route-clip-2', label: 'Local director clip', kind: 'clip', url: uploaded[1] },
    ]
    expect((await page.request.put('/api/preferences/soundboard:presets', { data: { value: presets } })).ok()).toBe(
      true
    )

    await installAudioSpy(page)
    await installAudioSpy(director)
    await page.goto('/race')
    await page.getByRole('button', { name: 'Soundboard' }).click()
    await expect(page.getByRole('button', { name: 'Race clip', exact: true })).toBeVisible()

    // R -> R: existing local output, without a registered director receiver.
    await page.getByRole('button', { name: 'Race clip', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.__routingAudio.length)).toBe(1)
    await expect((await page.request.get('/api/race-control/soundboard/status')).json()).resolves.toMatchObject({
      ready: false,
    })

    // A remote selection cannot silently fall back to the race PC.
    await page.getByRole('combobox', { name: /Playback on/ }).selectOption('director')
    await expect(page.getByText('Director unavailable')).toBeVisible()
    await page.evaluate(() => {
      window.__routingAudio = []
    })
    await page.getByRole('button', { name: 'Race clip', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('offline')
    expect(await page.evaluate(() => window.__routingAudio)).toEqual([])

    await authorizeDirector(director)
    await director.getByRole('button', { name: 'Receive audio here' }).click()
    await expect(director.getByText('Receiver connected (speakers not verified)')).toBeVisible()
    await expect(page.getByText('Director connected')).toBeVisible()

    // R -> D: director receives the audio bytes from the original server,
    // and the race PC never constructs a local Audio instance.
    await page.getByRole('button', { name: 'Race clip', exact: true }).click()
    await expect(page.getByText('Director playback started (speakers not verified).')).toBeVisible()
    await expect.poll(() => director.evaluate(() => window.__routingAudio.length)).toBe(1)
    expect(await page.evaluate(() => window.__routingAudio)).toEqual([])
    await expect.poll(() => receivedAudio.filter((response) => response.url().endsWith(uploaded[0])).length).toBe(1)
    const response = receivedAudio.find((item) => item.url().endsWith(uploaded[0]))
    expect(response.status()).toBeGreaterThanOrEqual(200)
    expect(response.status()).toBeLessThan(300)
    expect(response.headers()['content-type']).toContain('audio/')
    expect((await response.body()).length).toBeGreaterThan(44)

    // D -> D: different clip, same central media store, with no remote command.
    await director.getByRole('button', { name: 'Local director clip' }).click()
    await expect.poll(() => director.evaluate(() => window.__routingAudio.length)).toBe(2)
    await expect.poll(() => receivedAudio.filter((item) => item.url().endsWith(uploaded[1])).length).toBe(1)

    await page.getByRole('button', { name: 'Stop' }).click()
    await director.getByRole('button', { name: 'Disable receiving' }).click()
    await expect(page.getByText('Director unavailable')).toBeVisible()
  } finally {
    await directorContext.close()
    for (const url of uploaded) {
      await page.request.delete(url)
    }
    await page.request.put('/api/preferences/soundboard:presets', { data: { value: null } })
  }
})

test('director auto cues map verified best lap and finish to saved speech and HTTP clip', async ({ page, browser }) => {
  const directorContext = await browser.newContext({ locale: 'en-US' })
  const director = await directorContext.newPage()
  let uploadedUrl
  const readySockets = []
  const audioResponses = []
  let preferenceReads = 0
  try {
    const upload = await page.request.post('/api/upload/sounds', {
      multipart: { audio: { name: 'beep.wav', mimeType: 'audio/wav', buffer: wavFile() } },
    })
    expect(upload.ok()).toBe(true)
    uploadedUrl = (await upload.json()).data.url
    const presets = [
      { id: 'auto-voice', label: 'Auto lap voice', kind: 'speech', text: '{driver}: car {controller}, lap {lapTime}' },
      { id: 'auto-clip', label: 'Auto finish clip', kind: 'clip', url: uploadedUrl },
    ]
    expect((await page.request.put('/api/preferences/soundboard:presets', { data: { value: presets } })).ok()).toBe(
      true
    )
    await page.request.put('/api/preferences/soundboard:auto', { data: { value: { bestlap: '', finished: '' } } })
    await page.goto('/race')
    await page.getByRole('button', { name: 'Soundboard' }).click()
    await page.getByRole('combobox', { name: 'New best lap' }).selectOption('auto-voice')
    await expect
      .poll(async () => {
        const response = await page.request.get('/api/preferences/soundboard:auto')
        return (await response.json()).data?.bestlap
      })
      .toBe('auto-voice')
    await page.getByRole('combobox', { name: 'Session finished' }).selectOption('auto-clip')
    await expect
      .poll(async () => {
        const response = await page.request.get('/api/preferences/soundboard:auto')
        return (await response.json()).data
      })
      .toEqual({ bestlap: 'auto-voice', finished: 'auto-clip' })

    const additional = AUTO_CUE_TYPES.filter((type) => !['bestlap', 'finished'].includes(type))
    const labels = [
      'Start preparation complete',
      'Race start (GO)',
      'Session paused',
      'Race resumed (GO)',
      'Finishing phase started',
      'Rain begins (simulation)',
      'Track dry (simulation)',
      'VSC activated',
      'VSC ended',
      'Pit stop completed',
      'Tyre change confirmed',
      'Damage triggered (simulation)',
      'Damage repaired (simulation)',
      'Damage retirement (simulation)',
      'Virtual fuel: at most 20%',
      'Virtual tank empty',
      'Virtual tank refilled',
      'Penalty issued',
      'Penalty served',
      'Penalty revoked',
    ]
    const text = { id: 'auto-transition', label: 'Transition voice', kind: 'speech', text: 'Confirmed event' }
    await page.request.put('/api/preferences/soundboard:presets', { data: { value: [...presets, text] } })
    await page.reload()
    await page.getByRole('button', { name: 'Soundboard', exact: true }).click()
    for (const label of labels) {
      const select = page.getByRole('combobox', { name: label, exact: true })
      await expect(select).toHaveValue('')
      await expect(select).toBeEnabled()
      await select.selectOption('auto-transition')
      await expect(select).toBeEnabled()
    }
    const mappings = (await (await page.request.get('/api/preferences/soundboard:auto')).json()).data
    expect(mappings.bestlap).toBe('auto-voice')
    expect(mappings.finished).toBe('auto-clip')
    for (const type of additional) expect(mappings[type]).toBe('auto-transition')
    await page.reload()
    await page.getByRole('button', { name: 'Soundboard', exact: true }).click()
    for (const label of labels)
      await expect(page.getByRole('combobox', { name: label, exact: true })).toHaveValue('auto-transition')

    await director.addInitScript(() => {
      window.__autoSpoken = []
      window.__autoClip = []
      Object.defineProperty(window, 'speechSynthesis', {
        configurable: true,
        value: {
          speaking: false,
          getVoices: () => [],
          cancel() {},
          speak(utterance) {
            window.__autoSpoken.push(utterance.text)
            queueMicrotask(() => {
              utterance.onstart?.()
              utterance.onend?.()
            })
          },
        },
      })
      Object.defineProperty(window, 'SpeechSynthesisUtterance', {
        configurable: true,
        value: class {
          constructor(text) {
            this.text = text
          }
        },
      })
      const NativeAudio = window.Audio
      window.Audio = function (src) {
        if (src?.includes('/api/upload/sounds/')) window.__autoClip.push(src)
        return new NativeAudio(src)
      }
    })
    await director.routeWebSocket('**/socket.io/**', (socket) => {
      const item = { socket, ready: false }
      readySockets.push(item)
      socket.onMessage((message) => {
        if (message === '40') {
          socket.send('40{"sid":"auto-test-socket"}')
          item.ready = true
        }
      })
      socket.send('0{"sid":"auto-test-socket","upgrades":[],"pingInterval":25000,"pingTimeout":20000}')
    })
    await director.route('**/api/race-control/director/soundboard/receiver', (route) =>
      route.fulfill({ json: { success: true, ready: true } })
    )
    director.on('request', (request) => {
      if (
        request.method() === 'GET' &&
        /\/api\/preferences\/(soundboard:auto|soundboard:presets)$/.test(request.url())
      ) {
        preferenceReads += 1
      }
    })
    director.on('response', (response) => {
      if (response.url().includes('/api/upload/sounds/')) audioResponses.push(response)
    })
    await authorizeDirector(director)
    await director.getByRole('button', { name: 'Receive audio here' }).click()
    await expect(director.getByText('Receiver connected (speakers not verified)')).toBeVisible()
    await expect.poll(() => readySockets.some((socket) => socket.ready)).toBe(true)

    const send = (type, data) => {
      for (const connection of readySockets.filter((socket) => socket.ready)) {
        connection.socket.send('42' + JSON.stringify(['soundboard:auto', { type, data }]))
      }
    }
    const best = {
      sessionId: 'auto-race',
      sessionType: 'race',
      controller: 0,
      totalLaps: 3,
      lapTime: 8956,
      driverName: 'Alice',
      carBrand: 'BMW',
      carModel: 'M4',
    }
    send('bestlap', best)
    await expect.poll(() => director.evaluate(() => window.__autoSpoken.length)).toBe(1)
    expect((await director.evaluate(() => window.__autoSpoken))[0]).toContain('Alice: car 1, lap')

    const beforeDuplicate = preferenceReads
    send('bestlap', best)
    await expect.poll(() => preferenceReads).toBe(beforeDuplicate + 2)
    expect(await director.evaluate(() => window.__autoSpoken.length)).toBe(1)

    for (const [index, type] of additional.entries()) {
      const data = { sessionId: 'auto-race', sessionType: 'race', eventId: crypto.randomUUID() }
      send(type, data)
      await expect.poll(() => director.evaluate(() => window.__autoSpoken.length)).toBe(index + 2)
      expect((await director.evaluate(() => window.__autoSpoken)).at(-1)).toBe('Confirmed event')
      const before = preferenceReads
      send(type, data)
      await expect.poll(() => preferenceReads).toBe(before + 2)
      expect(await director.evaluate(() => window.__autoSpoken.length)).toBe(index + 2)
    }

    // Disabled mappings suppress an otherwise valid server event.
    await page.request.put('/api/preferences/soundboard:auto', { data: { value: { ...mappings, rain: '' } } })
    const beforeOff = preferenceReads
    send('rain', { sessionId: 'auto-race', sessionType: 'race', eventId: crypto.randomUUID() })
    await expect.poll(() => preferenceReads).toBe(beforeOff + 2)
    expect(await director.evaluate(() => window.__autoSpoken.length)).toBe(additional.length + 1)

    const beforeMissing = preferenceReads
    send('bestlap', { ...best, driverName: null, totalLaps: 4 })
    await expect.poll(() => preferenceReads).toBe(beforeMissing + 2)
    expect(await director.evaluate(() => window.__autoSpoken.length)).toBe(additional.length + 1)

    const finish = { sessionId: 'auto-race', sessionType: 'race', startedAt: '2026-10-28T12:00:00Z' }
    send('finished', finish)
    await expect.poll(() => director.evaluate(() => window.__autoClip.length)).toBe(1)
    await expect.poll(() => audioResponses.length).toBe(1)
    expect([200, 206]).toContain(audioResponses[0].status())
    expect(audioResponses[0].headers()['content-type']).toContain('audio/')
    expect((await audioResponses[0].body()).length).toBeGreaterThan(44)

    const beforeSecondFinish = preferenceReads
    send('finished', finish)
    await expect.poll(() => preferenceReads).toBe(beforeSecondFinish + 2)
    expect(await director.evaluate(() => window.__autoClip.length)).toBe(1)

    await director.getByRole('button', { name: 'Mute' }).click()
    send('bestlap', { ...best, totalLaps: 5 })
    send('rain', { sessionId: 'auto-race', sessionType: 'race', eventId: crypto.randomUUID() })
    expect(await director.evaluate(() => window.__autoSpoken.length)).toBe(additional.length + 1)
  } finally {
    await directorContext.close()
    if (uploadedUrl) await page.request.delete(uploadedUrl)
    await page.request.put('/api/preferences/soundboard:auto', { data: { value: null } })
    await page.request.put('/api/preferences/soundboard:presets', { data: { value: null } })
  }
})

test('operator pads play locally without editing or race controls', async ({ page }) => {
  const previous = await (await page.request.get('/api/preferences/soundboard:presets')).json()
  const url = '/api/upload/sounds/123e4567-e89b-12d3-a456-426614174000.mp3'
  const writes = []
  try {
    await page.request.put('/api/preferences/soundboard:presets', {
      data: { value: [{ id: 'operator-horn', label: 'Airhorn', kind: 'clip', url }] },
    })
    await page.addInitScript(() => {
      window.__operatorPlays = []
      window.__operatorPauses = 0
      window.Audio = class {
        constructor(src) {
          this.src = src
        }
        play() {
          window.__operatorPlays.push(this.src)
          return Promise.resolve()
        }
        pause() {
          window.__operatorPauses++
        }
      }
    })
    page.on('request', (request) => {
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) && request.url().includes('/api/')) {
        writes.push(request.url())
      }
    })
    await page.goto('/soundboard')
    const pad = page.getByRole('button', { name: 'Airhorn', exact: true })
    await expect(pad).toBeVisible()
    await expect(page.getByRole('link', { name: 'Back to race' })).toHaveAttribute('href', '/race')
    await expect(page.getByRole('combobox')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Edit: Airhorn' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Add announcement or sound' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Receive audio here' })).toHaveCount(0)

    await pad.click()
    await expect.poll(() => page.evaluate(() => window.__operatorPlays.length)).toBe(1)
    const playedUrl = await page.evaluate(() => window.__operatorPlays[0])
    expect(playedUrl.endsWith(url)).toBe(true)
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.__operatorPauses)).toBe(1)
    await page.getByRole('button', { name: 'Mute', exact: true }).click()
    await expect(pad).toBeDisabled()
    await page.getByRole('button', { name: 'Unmute', exact: true }).click()
    await expect(pad).toBeEnabled()
    expect(writes).toEqual([])
  } finally {
    await page.request.put('/api/preferences/soundboard:presets', { data: { value: previous.data ?? null } })
  }
})

test('operator soundboard handles empty presets', async ({ page }) => {
  const previous = await (await page.request.get('/api/preferences/soundboard:presets')).json()
  try {
    await page.request.put('/api/preferences/soundboard:presets', { data: { value: null } })
    await page.goto('/soundboard')
    await expect(page.getByText('No announcements or sounds saved yet.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Add announcement or sound' })).toHaveCount(0)
  } finally {
    await page.request.put('/api/preferences/soundboard:presets', { data: { value: previous.data ?? null } })
  }
})

test('missing sound assignments stay explicit until a replacement or Off is successfully saved', async ({ page }) => {
  const oldPresets = (await (await page.request.get('/api/preferences/soundboard:presets')).json()).data
  const oldMappings = (await (await page.request.get('/api/preferences/soundboard:auto')).json()).data
  const preset = { id: 'available-voice', label: 'Available voice', kind: 'speech', text: 'Ready' }
  const mappings = { bestlap: 'deleted-voice', finished: 'deleted-voice', fuellow: preset.id }
  const writes = []
  try {
    await page.request.put('/api/preferences/soundboard:presets', {
      data: {
        value: [preset, { id: 'deleted-voice', label: 'Invalid stored sound', kind: 'clip', url: '/not-a-sound' }],
      },
    })
    await page.request.put('/api/preferences/soundboard:auto', { data: { value: mappings } })
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().includes('/api/preferences/')) writes.push(request.url())
    })
    await page.goto('/soundboard-settings')
    const best = page.getByRole('combobox', { name: 'New best lap' })
    await expect(best).toHaveValue('deleted-voice')
    await expect(best.locator('option:checked')).toHaveText('Sound unavailable')
    await expect(best).toHaveAttribute('aria-invalid', 'true')
    await expect(best).toHaveAccessibleDescription(/assigned sound is missing or invalid/)
    await expect(page.getByRole('status').filter({ hasText: 'The assigned sound is missing or invalid' })).toHaveCount(
      2
    )
    await page.reload()
    await expect(best).toHaveValue('deleted-voice')
    expect(writes).toEqual([])

    await page.route('**/api/preferences/soundboard:auto', async (route) => {
      if (route.request().method() === 'PUT') await route.fulfill({ status: 500, json: { success: false } })
      else await route.continue()
    })
    await best.selectOption(preset.id)
    await expect(page.getByRole('alert')).toHaveText('Could not save soundboard.')
    await expect(best).toHaveValue('deleted-voice')
    expect((await (await page.request.get('/api/preferences/soundboard:auto')).json()).data).toEqual(mappings)
    await page.unroute('**/api/preferences/soundboard:auto')
    await best.selectOption(preset.id)
    await expect(best).not.toHaveAttribute('aria-invalid', 'true')
    await page.getByRole('combobox', { name: 'Session finished' }).selectOption('')
    await expect
      .poll(async () => (await (await page.request.get('/api/preferences/soundboard:auto')).json()).data)
      .toEqual({ ...mappings, bestlap: preset.id, finished: '' })
    await page.reload()
    await expect(page.getByRole('status').filter({ hasText: 'The assigned sound is missing or invalid' })).toHaveCount(
      0
    )
    await expect(page.getByRole('combobox', { name: 'Virtual fuel: at most 20%' })).toHaveValue(preset.id)
  } finally {
    await page.request.put('/api/preferences/soundboard:presets', { data: { value: oldPresets ?? null } })
    await page.request.put('/api/preferences/soundboard:auto', { data: { value: oldMappings ?? null } })
  }
})

test('deleting an assigned preset marks its trigger without clearing other stored assignments', async ({ page }) => {
  const oldPresets = (await (await page.request.get('/api/preferences/soundboard:presets')).json()).data
  const oldMappings = (await (await page.request.get('/api/preferences/soundboard:auto')).json()).data
  const presets = [
    { id: 'remove-me', label: 'Old voice', kind: 'speech', text: 'Old' },
    { id: 'keep-me', label: 'Keep voice', kind: 'speech', text: 'Keep' },
  ]
  const mappings = { bestlap: 'remove-me', finished: 'keep-me' }
  try {
    await page.request.put('/api/preferences/soundboard:presets', { data: { value: presets } })
    await page.request.put('/api/preferences/soundboard:auto', { data: { value: mappings } })
    await page.goto('/soundboard-settings')
    await page.getByRole('button', { name: 'Delete: Old voice' }).click()
    await expect(page.getByRole('button', { name: 'Old voice', exact: true })).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'New best lap' })).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByRole('combobox', { name: 'Session finished' })).toHaveValue('keep-me')
    expect((await (await page.request.get('/api/preferences/soundboard:auto')).json()).data).toEqual(mappings)
    await page.reload()
    await expect(page.getByRole('combobox', { name: 'New best lap' }).locator('option:checked')).toHaveText(
      'Sound unavailable'
    )
  } finally {
    await page.request.put('/api/preferences/soundboard:presets', { data: { value: oldPresets ?? null } })
    await page.request.put('/api/preferences/soundboard:auto', { data: { value: oldMappings ?? null } })
  }
})

for (const key of ['soundboard:auto', 'soundboard:presets']) {
  for (const failure of [
    { name: 'HTTP failure', status: 503, json: { success: false } },
    { name: 'application failure', status: 200, json: { success: false } },
    { name: 'invalid data shape', status: 200, json: { success: true, data: key === 'soundboard:auto' ? [] : {} } },
  ]) {
    test(`${key} ${failure.name} cannot enable editing of unloaded settings`, async ({ page }) => {
      const writes = []
      await page.route(`**/api/preferences/${key}`, (route) =>
        route.fulfill({ status: failure.status, json: failure.json })
      )
      page.on('request', (request) => {
        if (request.method() === 'PUT' && request.url().includes('/api/preferences/soundboard:'))
          writes.push(request.url())
      })
      await page.goto('/soundboard-settings')
      await expect(page.getByRole('alert')).toHaveText('Could not load soundboard.')
      await expect(page.getByRole('combobox', { name: 'New best lap' })).toBeDisabled()
      if (key === 'soundboard:presets')
        await expect(page.getByRole('button', { name: 'Add announcement or sound' })).toBeDisabled()
      expect(writes).toEqual([])
      await page.reload()
      await expect(page.getByRole('alert')).toHaveText('Could not load soundboard.')
      await expect(page.getByRole('combobox', { name: 'New best lap' })).toBeDisabled()
      expect(writes).toEqual([])
    })
  }
}

test('a new soundboard with null preferences remains editable', async ({ page }) => {
  for (const key of ['soundboard:auto', 'soundboard:presets']) {
    await page.route(`**/api/preferences/${key}`, (route) => route.fulfill({ json: { success: true, data: null } }))
  }
  await page.goto('/soundboard-settings')
  await expect(page.getByRole('combobox', { name: 'New best lap' })).toBeEnabled()
  await expect(page.getByRole('combobox', { name: 'New best lap' })).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Add announcement or sound' })).toBeEnabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

import { test, expect } from '@playwright/test'

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

    const beforeMissing = preferenceReads
    send('bestlap', { ...best, driverName: null, totalLaps: 4 })
    await expect.poll(() => preferenceReads).toBe(beforeMissing + 2)
    expect(await director.evaluate(() => window.__autoSpoken.length)).toBe(1)

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
    expect(await director.evaluate(() => window.__autoSpoken.length)).toBe(1)
  } finally {
    await directorContext.close()
    if (uploadedUrl) await page.request.delete(uploadedUrl)
    await page.request.put('/api/preferences/soundboard:auto', { data: { value: null } })
    await page.request.put('/api/preferences/soundboard:presets', { data: { value: null } })
  }
})

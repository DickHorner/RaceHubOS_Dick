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

import { readFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.routeWebSocket('**/socket.io/**', (socket) => socket.close())
  await page.route('**/socket.io/**', (route) => route.abort())
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok' } }))
  await page.route('**/api/preferences/**', (route) => route.fulfill({ json: { success: true, data: null } }))
  await page.route('**/api/devices', (route) => route.fulfill({ json: { success: true, data: [] } }))
  await page.route('**/api/bluetooth/status', (route) => route.fulfill({ json: { connected: false } }))
})

const race = {
  id: 'race-print',
  name: 'Coupe du circuit',
  type: 'race',
  status: 'finished',
  track: { name: 'Circuit E2E' },
  championship: { name: 'Saison 2026' },
  createdAt: '2026-10-26T18:00:00.000Z',
  startedAt: '2026-10-26T18:05:00.000Z',
  finishedAt: '2026-10-26T18:10:00.000Z',
  drivers: [
    {
      id: 'entry-a',
      controller: 0,
      totalLaps: 9,
      totalTime: 90000,
      bestLapTime: 9700,
      driver: { name: 'Pilote Alpha', email: 'private@example.com' },
      car: { brand: 'BMW', model: 'M4' },
    },
    {
      id: 'entry-b',
      controller: 1,
      totalLaps: 9,
      totalTime: 85000,
      bestLapTime: 9400,
      driver: { name: 'Pilote Beta' },
      car: { brand: 'Porsche', model: 'GT1' },
    },
  ],
  penalties: [{ sessionDriverId: 'entry-b', kind: 'time', status: 'active', amount: 20000 }],
}

test('printable race uses classified standings, displays provenance and never sends writes', async ({ page }) => {
  const writes = []
  page.on('request', (request) => {
    if (request.url().includes('/api/') && request.method() !== 'GET') writes.push(request.url())
  })
  await page.route('**/api/sessions/race-print', (route) => route.fulfill({ json: { success: true, data: race } }))

  await page.goto('/results/race-print')

  await expect(page.getByRole('heading', { name: 'Coupe du circuit' })).toBeVisible()
  await expect(page.getByText('Circuit E2E')).toBeVisible()
  await expect(page.getByText('Saison 2026')).toBeVisible()
  await expect(page.getByText('race-print')).toBeVisible()
  await expect(page.getByTestId('session-classification').locator('tbody tr').first()).toContainText('Pilote Alpha')
  await expect(page.getByTestId('session-classification').locator('tbody tr').nth(1)).toContainText('Pilote Beta')
  await expect(page.getByTestId('session-classification').locator('tbody tr').nth(1)).toContainText('1:45.000')
  await expect(page.getByText('private@example.com')).toHaveCount(0)
  await expect(page.locator('aside')).toHaveCount(0)
  expect(writes).toEqual([])

  await page.emulateMedia({ media: 'print' })
  await expect(page.getByTestId('session-classification')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Imprimer' })).toBeHidden()
  await page.emulateMedia({ media: 'screen' })

  await page.reload()
  await expect(page.getByTestId('session-classification').locator('tbody tr').first()).toContainText('Pilote Alpha')
  expect(writes).toEqual([])
})

test('qualifying sorts by measured best lap and omits race total time', async ({ page }) => {
  const qualif = {
    ...race,
    id: 'qualif-print',
    type: 'qualif',
    penalties: [],
    drivers: [
      { ...race.drivers[0], bestLapTime: 12500, totalLaps: 6 },
      { ...race.drivers[1], bestLapTime: 11000, totalLaps: 4 },
    ],
  }
  await page.route('**/api/sessions/qualif-print', (route) => route.fulfill({ json: { success: true, data: qualif } }))
  await page.goto('/results/qualif-print')

  await expect(page.getByTestId('session-classification').locator('tbody tr').first()).toContainText('Pilote Beta')
  await expect(page.getByTestId('session-classification').locator('tbody tr').nth(1)).toContainText('Pilote Alpha')
  await expect(page.getByTestId('session-classification').getByText('Temps classé')).toHaveCount(0)
})

test('unavailable or unfinished sessions do not expose a printable classification', async ({ page }) => {
  await page.route('**/api/sessions/draft-print', (route) =>
    route.fulfill({ json: { success: true, data: { ...race, status: 'draft', id: 'draft-print' } } })
  )
  await page.goto('/results/draft-print')
  await expect(page.getByRole('status')).toContainText('réservée aux courses et qualifications terminées')
  await expect(page.getByTestId('session-classification')).toHaveCount(0)

  await page.route('**/api/sessions/missing-print', (route) =>
    route.fulfill({ status: 404, json: { success: false, error: 'Session not found' } })
  )
  await page.goto('/results/missing-print')
  await expect(page.getByRole('alert')).toContainText('Session introuvable')
  await expect(page.getByTestId('session-classification')).toHaveCount(0)
})

test('localhost sharing asks for manual copying instead of promising a LAN-accessible URL', async ({ page }) => {
  await page.route('**/api/sessions/race-print', (route) => route.fulfill({ json: { success: true, data: race } }))
  await page.goto('/results/race-print')

  const dialog = page.waitForEvent('dialog').then(async (prompt) => {
    expect(prompt.type()).toBe('prompt')
    expect(prompt.defaultValue()).toContain('/results/race-print')
    expect(prompt.message()).toContain('réseau local')
    await prompt.dismiss()
  })
  await page.getByRole('button', { name: 'Copier le lien' }).click()
  await dialog
})

test('weighted qualifying prints virtual order with measured and simulated bests separately', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('racehubos-lang', 'en'))
  const data = {
    ...race,
    type: 'qualif',
    fuelWeightPercent: 10,
    drivers: race.drivers.map((d, i) => ({
      ...d,
      bestLapTime: i === 0 ? 10000 : 10500,
      simulatedBestLapTime: i === 0 ? 11000 : 10500,
    })),
  }
  await page.route('**/api/sessions/race-print', (route) => route.fulfill({ json: { success: true, data } }))
  await page.goto('/results/race-print')
  const rows = page.getByTestId('session-classification').locator('tbody tr')
  await expect(rows.first()).toContainText('Pilote Beta')
  await expect(rows.nth(1)).toContainText('10.000')
  await expect(rows.nth(1)).toContainText('11.000')
  await expect(page.getByRole('note').filter({ hasText: 'Fuel weight:' })).toContainText('10%')
  await expect(
    page.getByTestId('session-classification').getByRole('columnheader', { name: 'Best simulated lap' })
  ).toBeVisible()
})

test('HTML export defaults to redacted data and the standalone file matches the reviewed preview', async ({
  page,
  browser,
}, testInfo) => {
  await page.route('**/api/sessions/race-print', (route) => route.fulfill({ json: { success: true, data: race } }))
  const writes = []
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(request.url())
  })
  await page.goto('/results/race-print')
  const panel = page.getByTestId('public-result-export')
  const preview = page.getByTestId('public-result-preview')
  const downloadButton = panel.getByRole('button', { name: 'Télécharger le HTML' })
  await expect(downloadButton).toBeDisabled()
  await expect(preview).not.toContainText('Pilote Alpha')
  await expect(preview).toContainText('Pilote 1')
  const expectedRows = await preview.locator('tbody tr').allTextContents()
  await panel.getByRole('checkbox').nth(1).check()
  const pending = page.waitForEvent('download')
  await downloadButton.click()
  const download = await pending
  expect(download.suggestedFilename()).toBe('racehub-results.html')
  const path = testInfo.outputPath('redacted.html')
  await download.saveAs(path)
  const html = await readFile(path, 'utf8')
  for (const privateValue of [
    'Pilote Alpha',
    'Pilote Beta',
    'private@example.com',
    'race-print',
    'Circuit E2E',
    'Coupe du circuit',
    'Saison 2026',
    'BMW',
    'entry-a',
    '2026-10-26',
  ])
    expect(html).not.toContain(privateValue)
  const offline = await browser.newContext({ offline: true })
  const artifact = await offline.newPage()
  await artifact.goto('file://' + path)
  expect(await artifact.locator('tbody tr').allTextContents()).toEqual(expectedRows)
  expect(await artifact.locator('script,iframe,img,link,a,form').count()).toBe(0)
  await offline.close()
  expect(writes).toEqual([])
})

test('opting into names resets review and escapes injected markup in the downloaded HTML', async ({
  page,
  browser,
}, testInfo) => {
  const name = '<img src="https://example.invalid/leak" onerror="window.leaked=true"> & "Pilot"'
  const poisoned = { ...race, drivers: [{ ...race.drivers[0], driver: { name, email: 'secret@example.com' } }] }
  await page.route('**/api/sessions/race-print', (route) => route.fulfill({ json: { success: true, data: poisoned } }))
  await page.goto('/results/race-print')
  const panel = page.getByTestId('public-result-export')
  const checks = panel.getByRole('checkbox')
  await checks.nth(1).check()
  await checks.nth(0).check()
  await expect(checks.nth(1)).not.toBeChecked()
  await expect(panel.getByRole('button')).toBeDisabled()
  await expect(page.getByTestId('public-result-preview')).toContainText(name)
  await checks.nth(1).check()
  const pending = page.waitForEvent('download')
  await panel.getByRole('button').click()
  const path = testInfo.outputPath('named.html')
  await (await pending).saveAs(path)
  const html = await readFile(path, 'utf8')
  expect(html).not.toContain('secret@example.com')
  expect(html).toContain('&lt;img')
  const offline = await browser.newContext({ offline: true })
  const artifact = await offline.newPage()
  await artifact.goto('file://' + path)
  await expect(artifact.locator('tbody')).toContainText(name)
  expect(await artifact.locator('img,script').count()).toBe(0)
  expect(await artifact.evaluate(() => window.leaked)).toBeUndefined()
  await offline.close()
})

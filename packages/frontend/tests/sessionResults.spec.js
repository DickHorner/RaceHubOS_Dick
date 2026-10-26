import { test, expect } from '@playwright/test'

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
  await expect(page.getByRole('table').locator('tbody tr').first()).toContainText('Pilote Alpha')
  await expect(page.getByRole('table').locator('tbody tr').nth(1)).toContainText('Pilote Beta')
  await expect(page.getByRole('table').locator('tbody tr').nth(1)).toContainText('1:45.000')
  await expect(page.getByText('private@example.com')).toHaveCount(0)
  await expect(page.locator('aside')).toHaveCount(0)
  expect(writes).toEqual([])

  await page.emulateMedia({ media: 'print' })
  await expect(page.getByRole('table')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Imprimer' })).toBeHidden()
  await page.emulateMedia({ media: 'screen' })

  await page.reload()
  await expect(page.getByRole('table').locator('tbody tr').first()).toContainText('Pilote Alpha')
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
  await page.route('**/api/sessions/qualif-print', (route) =>
    route.fulfill({ json: { success: true, data: qualif } })
  )
  await page.goto('/results/qualif-print')

  await expect(page.getByRole('table').locator('tbody tr').first()).toContainText('Pilote Beta')
  await expect(page.getByRole('table').locator('tbody tr').nth(1)).toContainText('Pilote Alpha')
  await expect(page.getByRole('table').getByText('Temps classé')).toHaveCount(0)
})

test('unavailable or unfinished sessions do not expose a printable classification', async ({ page }) => {
  await page.route('**/api/sessions/draft-print', (route) =>
    route.fulfill({ json: { success: true, data: { ...race, status: 'draft', id: 'draft-print' } } })
  )
  await page.goto('/results/draft-print')
  await expect(page.getByRole('status')).toContainText('réservée aux courses et qualifications terminées')
  await expect(page.getByRole('table')).toHaveCount(0)

  await page.route('**/api/sessions/missing-print', (route) =>
    route.fulfill({ status: 404, json: { success: false, error: 'Session not found' } })
  )
  await page.goto('/results/missing-print')
  await expect(page.getByRole('alert')).toContainText('Session introuvable')
  await expect(page.getByRole('table')).toHaveCount(0)
})

test('localhost sharing asks for manual copying instead of promising a LAN-accessible URL', async ({ page }) => {
  await page.route('**/api/sessions/race-print', (route) => route.fulfill({ json: { success: true, data: race } }))
  await page.goto('/results/race-print')

  const dialog = page.waitForEvent('dialog')
  await page.getByRole('button', { name: 'Copier le lien' }).click()
  const prompt = await dialog
  expect(prompt.type()).toBe('prompt')
  expect(prompt.defaultValue()).toContain('/results/race-print')
  expect(prompt.message()).toContain('réseau local')
  await prompt.dismiss()
})

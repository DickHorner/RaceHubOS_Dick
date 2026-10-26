import { test, expect } from '@playwright/test'

const session = {
  id: 'spectator-e2e',
  name: 'Course E2E',
  type: 'race',
  status: 'paused',
  maxLaps: 20,
  track: { name: 'Circuit E2E' },
  drivers: [
    {
      id: 'sd-a',
      controller: 0,
      position: 1,
      totalLaps: 7,
      totalTime: 90000,
      bestLapTime: 12000,
      lastLapTime: 13000,
      driver: { name: 'Pilote Un', color: '#ff0000' },
      car: { brand: 'BMW', model: 'M4' },
    },
  ],
}

test('spectator page shows a read-only scoreboard with no race controls', async ({ page }) => {
  const writes = []
  page.on('request', (request) => {
    if (request.url().includes('/api/sessions') && request.method() !== 'GET') {
      writes.push(`${request.method()} ${request.url()}`)
    }
  })

  await page.route('**/api/sessions?*', (route) => {
    const status = new URL(route.request().url()).searchParams.get('status')
    const data = status === 'active,paused,finishing' ? [session] : []
    return route.fulfill({ json: { success: true, data } })
  })
  await page.route('**/api/sessions/spectator-e2e', (route) =>
    route.fulfill({ json: { success: true, data: session } })
  )

  await page.goto('/display/scoreboard')

  await expect(page.getByRole('heading', { name: 'Course E2E' })).toBeVisible()
  await expect(page.getByText('Un', { exact: true })).toBeVisible()
  await expect(page.getByText('7 / 20')).toBeVisible()
  await expect(page.getByRole('status')).toBeVisible()
  await expect(page.getByText('Affichage uniquement', { exact: false })).toBeVisible()
  await expect(page.locator('aside')).toHaveCount(0)
  expect(writes).toEqual([])
})

test('a refreshed spectator view shows the most recent finished race', async ({ page }) => {
  const finished = { ...session, status: 'finished', name: 'Dernière course', finishedAt: new Date().toISOString() }
  await page.route('**/api/sessions?*', (route) => {
    const status = new URL(route.request().url()).searchParams.get('status')
    return route.fulfill({ json: { success: true, data: status === 'finished' ? [finished] : [] } })
  })
  await page.route('**/api/sessions/spectator-e2e', (route) =>
    route.fulfill({ json: { success: true, data: finished } })
  )

  await page.goto('/display/scoreboard')
  await expect(page.getByRole('heading', { name: 'Dernière course' })).toBeVisible()
  await expect(page.getByText('Terminée')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Dernière course' })).toBeVisible()
})

import { test, expect } from '@playwright/test'

const track = { id: 'layout-track', name: 'Layout Circuit' }
const driver = { id: 'layout-driver', name: 'Pilote Layout', color: '#f00' }
const car = { id: 'layout-car', brand: 'BMW', model: 'M4' }
const session = {
  id: 'layout-session',
  name: 'Layout Race',
  trackId: track.id,
  track,
  type: 'practice',
  status: 'finished',
  createdAt: '2026-10-26T12:00:00.000Z',
  startedAt: '2026-10-26T12:01:00.000Z',
  finishedAt: '2026-10-26T12:05:00.000Z',
  drivers: [
    {
      id: 'sd-layout',
      controller: 0,
      driverId: driver.id,
      carId: car.id,
      driver,
      car,
      totalLaps: 3,
      bestLapTime: 9500,
      totalTime: 31_000,
    },
  ],
}

async function openRace(page, race = session) {
  await page.route('**/api/tracks', (route) => route.fulfill({ json: { success: true, data: [track] } }))
  await page.route('**/api/drivers', (route) => route.fulfill({ json: { success: true, data: [driver] } }))
  await page.route('**/api/cars', (route) => route.fulfill({ json: { success: true, data: [car] } }))
  await page.route('**/api/sessions?*', (route) => route.fulfill({ json: { success: true, data: [race] } }))
  await page.route('**/api/sessions/layout-session', (route) => route.fulfill({ json: { success: true, data: race } }))
  await page.route('**/api/sessions/layout-session/leaderboard', (route) =>
    route.fulfill({ json: { success: true, data: [] } })
  )
  await page.route('**/api/records/track/**', (route) =>
    route.fulfill({ json: { success: true, data: { practice: [], qualif: [], race: [] } } })
  )
  if (race.status === 'active') {
    await page.route('**/api/sync/load-session/layout-session', (route) => route.fulfill({ json: { success: true } }))
  }
  await page.goto('/race')
  await expect(page.getByTestId('session-section')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Disposition' })).toBeVisible()
}

async function setLayout(page, value) {
  await page.request.put('/api/preferences/freeSession:widgets', { data: { value } })
}

async function storedLayout(page) {
  const response = await page.request.get('/api/preferences/freeSession:widgets')
  return (await response.json()).data
}

async function visibleOrder(page) {
  return page
    .locator('[data-testid^="free-widget-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.testid.replace('free-widget-', '')))
}

test('a missing preference preserves the prior session and leaderboard/standings layout', async ({ page }) => {
  await setLayout(page, null)
  await openRace(page)

  await expect.poll(() => visibleOrder(page)).toEqual(['leaderboard', 'standings'])
  await expect(page.getByText('Classement Général', { exact: true })).toBeVisible()
  await expect(page.getByTestId('free-widget-leaderboard')).toBeVisible()
  await expect(page.getByTestId('session-section')).toBeVisible()
})

test('unknown IDs are ignored and visible widgets are reordered, hidden, saved and restored', async ({ page }) => {
  await setLayout(page, ['unknown', 'standings', 'leaderboard', 'standings'])
  await openRace(page)

  await expect.poll(() => visibleOrder(page)).toEqual(['standings', 'leaderboard'])
  await page.getByRole('button', { name: 'Disposition' }).click()
  const standings = page.getByRole('checkbox', { name: 'Classement général' })
  const leaderboard = page.getByRole('checkbox', { name: 'Classement en direct' })
  await expect(standings).toBeChecked()
  await expect(leaderboard).toBeChecked()

  await page.getByRole('button', { name: 'Monter Classement en direct' }).click()
  await expect.poll(() => visibleOrder(page)).toEqual(['leaderboard', 'standings'])
  await expect.poll(() => storedLayout(page)).toEqual(['leaderboard', 'standings'])

  await standings.click()
  await expect(page.getByTestId('free-widget-standings')).toHaveCount(0)
  await expect.poll(() => storedLayout(page)).toEqual(['leaderboard'])

  await page.reload()
  await expect(page.getByTestId('session-section')).toBeVisible()
  await expect.poll(() => visibleOrder(page)).toEqual(['leaderboard'])

  await page.getByRole('button', { name: 'Disposition' }).click()
  await page.getByRole('checkbox', { name: 'Classement général' }).click()
  await expect.poll(() => storedLayout(page)).toEqual(['leaderboard', 'standings'])
  await page.setViewportSize({ width: 390, height: 850 })
  const left = await page.getByTestId('free-widget-leaderboard').boundingBox()
  const right = await page.getByTestId('free-widget-standings').boundingBox()
  expect(Math.abs(left.x - right.x)).toBeLessThan(2)
  expect(right.y).toBeGreaterThan(left.y)
})

test('hiding every configurable widget keeps the race controls visible', async ({ page }) => {
  await setLayout(page, [])
  await openRace(page)

  await expect(page.getByTestId('session-section')).toBeVisible()
  await expect(page.locator('[data-testid^="free-widget-"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Disposition' }).click()
  await expect(page.getByRole('checkbox', { name: 'Classement en direct' })).not.toBeChecked()
  await page.getByRole('checkbox', { name: 'Classement en direct' }).click()
  await expect.poll(() => storedLayout(page)).toEqual(['leaderboard'])
})

test('a failed preference write leaves the previous layout intact', async ({ page }) => {
  await setLayout(page, ['leaderboard', 'standings'])
  await page.route('**/api/preferences/freeSession:widgets', (route) => {
    if (route.request().method() === 'PUT') {
      return route.fulfill({ status: 500, json: { success: false, error: 'failed' } })
    }
    return route.continue()
  })
  await openRace(page)

  await page.getByRole('button', { name: 'Disposition' }).click()
  await page.getByRole('checkbox', { name: 'Classement général' }).click()
  await expect(page.getByRole('alert')).toContainText('Disposition non enregistrée')
  await expect.poll(() => visibleOrder(page)).toEqual(['leaderboard', 'standings'])
  await expect.poll(() => storedLayout(page)).toEqual(['leaderboard', 'standings'])
})

test('active sessions automatically hide the standings without overwriting the saved layout', async ({ page }) => {
  await setLayout(page, ['leaderboard', 'standings'])
  await openRace(page, { ...session, status: 'active', finishedAt: null })
  await expect.poll(() => visibleOrder(page)).toEqual(['leaderboard'])
  await page.getByRole('button', { name: 'Disposition' }).click()
  await expect(page.getByRole('checkbox', { name: 'Classement général' })).toBeDisabled()
  await expect.poll(() => storedLayout(page)).toEqual(['leaderboard', 'standings'])
})

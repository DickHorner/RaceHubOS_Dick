import { test, expect } from '@playwright/test'

test.use({ locale: 'en-US' })

const participant = {
  id: 'entry-1', driverId: 'driver-1', controller: 0,
  position: 1, totalLaps: 3, bestLapTime: 12300, lastLapTime: 12400,
  driver: { id: 'driver-1', name: 'Driver One', number: 11, color: '#ef4444' },
  car: { brand: 'BMW', model: 'M4' },
}
const race = {
  id: 'race-1', name: 'Chaos Race', type: 'race', status: 'active',
  track: { name: 'Circuit E2E' }, drivers: [participant],
}

async function mockRace(page, session) {
  await page.route('**/api/sessions?*', (route) => route.fulfill({ json: { success: true, data: [session] } }))
  await page.route('**/api/sessions/race-1', (route) => route.fulfill({ json: { success: true, data: session } }))
}

test('personal display offers CHAOS only with a scoped token', async ({ page }) => {
  await mockRace(page, race)
  await page.goto('/display/driver/driver-1')
  await expect(page.getByRole('button', { name: /chaos/i })).toHaveCount(0)

  await page.goto('/display/driver/driver-1#chaos=temporary-driver-token')
  let auth = ''
  await page.route('**/api/race-control/chaos', (route) => {
    auth = route.request().headers().authorization
    return route.fulfill({ json: { success: true, paused: true, alreadyPaused: false } })
  })
  await expect(page.getByRole('button', { name: /chaos/i })).toBeVisible()
  // The mocked CU is not connected: the button must remain disabled rather than pretending to pause.
  await expect(page.getByRole('button', { name: /chaos/i })).toBeDisabled()
  expect(auth).toBe('')
})

test('director credential and individual driver links stay out of the URL', async ({ page }) => {
  await mockRace(page, race)
  await page.route('**/api/race-control/status', (route) => route.fulfill({ json: { success: true, enabled: true } }))
  await page.route('**/api/race-control/director/check', (route) =>
    route.fulfill({ json: { success: route.request().headers().authorization === 'Bearer test-secret' },
      status: route.request().headers().authorization === 'Bearer test-secret' ? 200 : 403 })
  )
  await page.route('**/api/race-control/driver-link', (route) =>
    route.fulfill({ json: { success: true, token: 'signed-driver-token', expiresAt: Date.now() + 10000 } })
  )

  await page.goto('/display/control')
  await page.getByLabel(/director credential/i).fill('test-secret')
  await page.getByRole('button', { name: /unlock/i }).click()
  await expect(page.getByRole('status').filter({ hasText: /authorized/i })).toBeVisible()
  await page.getByRole('button', { name: /Driver One/i }).click()
  await expect(page.locator('#issued-driver-link')).toHaveValue(/\/display\/driver\/driver-1#chaos=signed-driver-token$/)
  expect(page.url()).not.toContain('test-secret')
  expect(page.url()).not.toContain('signed-driver-token')
})
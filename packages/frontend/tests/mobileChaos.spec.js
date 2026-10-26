import { test, expect } from '@playwright/test'

test.use({ locale: 'en-US' })

const participant = {
  id: 'entry-1',
  driverId: 'driver-1',
  controller: 0,
  position: 1,
  totalLaps: 3,
  bestLapTime: 12300,
  lastLapTime: 12400,
  driver: { id: 'driver-1', name: 'Driver One', number: 11, color: '#ef4444' },
  car: { brand: 'BMW', model: 'M4' },
}
const race = {
  id: 'race-1',
  name: 'Chaos Race',
  type: 'race',
  status: 'active',
  track: { name: 'Circuit E2E' },
  drivers: [participant],
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
  // A token changes the visible capability; no write occurs before a deliberate click.
  expect(auth).toBe('')
})

test('director credential and individual driver links stay out of the URL', async ({ page }) => {
  await mockRace(page, race)
  await page.route('**/api/race-control/status', (route) => route.fulfill({ json: { success: true, enabled: true } }))
  await page.route('**/api/race-control/director/check', (route) =>
    route.fulfill({
      json: { success: route.request().headers().authorization === 'Bearer test-secret' },
      status: route.request().headers().authorization === 'Bearer test-secret' ? 200 : 403,
    })
  )
  await page.route('**/api/race-control/driver-link', (route) =>
    route.fulfill({ json: { success: true, token: 'signed-driver-token', expiresAt: Date.now() + 10000 } })
  )

  await page.goto('/display/control')
  await page.getByLabel(/director credential/i).fill('test-secret')
  await page.getByRole('button', { name: /unlock/i }).click()
  await expect(page.getByRole('status').filter({ hasText: /authorized/i })).toBeVisible()
  await page.getByRole('button', { name: /Driver One/i }).click()
  await expect(page.locator('#issued-driver-link')).toHaveValue(
    /\/display\/driver\/driver-1#chaos=signed-driver-token$/
  )
  expect(page.url()).not.toContain('test-secret')
  expect(page.url()).not.toContain('signed-driver-token')
})
test('first-run setup on race PC generates a key and unlocks director controls', async ({ page }) => {
  await mockRace(page, race)
  await page.route('**/api/race-control/status', (route) =>
    route.fulfill({ json: { success: true, enabled: false, setupAvailable: true } })
  )
  let setupCalls = 0
  await page.route('**/api/race-control/setup', (route) => {
    setupCalls++
    return route.fulfill({ json: { success: true, secret: 'a'.repeat(64) } })
  })
  await page.goto('/display/control')
  await expect(page.getByRole('button', { name: /set up race control/i })).toBeVisible()
  await page.getByRole('button', { name: /set up race control/i }).click()
  await expect(page.getByRole('status').filter({ hasText: /director authorized/i })).toBeVisible()
  await expect(page.getByLabel(/new race director credential/i)).toHaveValue('a'.repeat(64))
  expect(setupCalls).toBe(1)
  expect(page.url()).not.toContain('a'.repeat(64))
})

test('remote first-run screen explains setup location rather than displaying a broken form', async ({ page }) => {
  await mockRace(page, race)
  await page.route('**/api/race-control/status', (route) =>
    route.fulfill({ json: { success: true, enabled: false, setupAvailable: false } })
  )
  await page.goto('/display/control')
  await expect(page.getByText(/only available directly on the race PC/i)).toBeVisible()
  await expect(page.getByRole('button', { name: /set up race control/i })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /check setup status again/i })).toBeVisible()
})

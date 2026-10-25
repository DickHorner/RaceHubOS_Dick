import { test, expect } from '@playwright/test'

const participants = [
  {
    id: 'entry-a', driverId: 'driver-a', controller: 0,
    position: 1, totalLaps: 7, totalTime: 90000, bestLapTime: 12000, lastLapTime: 13000,
    driver: { id: 'driver-a', name: 'Driver Alpha', color: '#ef4444', number: 11 },
    car: { brand: 'BMW', model: 'M4' },
  },
  {
    id: 'entry-b', driverId: 'driver-b', controller: 1,
    position: 2, totalLaps: 6, totalTime: 88000, bestLapTime: 13500, lastLapTime: 14000,
    driver: { id: 'driver-b', name: 'Driver Beta', color: '#3b82f6', number: 22 },
    car: { brand: 'AMG', model: 'GT3' },
  },
]

const race = {
  id: 'race-a', name: 'Live Test Race', type: 'race', status: 'paused', maxLaps: 20,
  track: { name: 'Circuit E2E' }, drivers: participants,
}

async function mockSession(page, current) {
  const writes = []
  page.on('request', (request) => {
    if (request.url().includes('/api/') && request.method() !== 'GET') writes.push(request.url())
  })
  await page.route('**/api/sessions?*', (route) => {
    const status = new URL(route.request().url()).searchParams.get('status')
    const available = ['active,paused,finishing', 'finished'].includes(status) &&
      (status === 'finished') === (current.value.status === 'finished')
    return route.fulfill({ json: { success: true, data: available ? [current.value] : [] } })
  })
  await page.route('**/api/sessions/race-*', (route) =>
    route.fulfill({ json: { success: true, data: current.value } })
  )
  return writes
}

test('two phones show only their own assigned driver and never issue race commands', async ({ browser }) => {
  const one = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US' })
  const two = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US' })
  try {
    const pageA = await one.newPage()
    const pageB = await two.newPage()
    const state = { value: race }
    const writesA = await mockSession(pageA, state)
    const writesB = await mockSession(pageB, state)

    await Promise.all([
      pageA.goto('/display/driver/driver-a'),
      pageB.goto('/display/driver/driver-b'),
    ])

    await expect(pageA.getByText('Driver Alpha')).toBeVisible()
    await expect(pageA.getByText('Controller 1')).toBeVisible()
    await expect(pageA.getByText('Driver Beta')).toHaveCount(0)
    await expect(pageB.getByText('Driver Beta')).toBeVisible()
    await expect(pageB.getByText('Controller 2')).toBeVisible()
    await expect(pageB.getByText('Driver Alpha')).toHaveCount(0)
    await expect(pageA.getByText('Unavailable')).toBeVisible()
    await expect(pageA.locator('aside')).toHaveCount(0)
    await expect(pageB.locator('aside')).toHaveCount(0)
    expect(writesA).toEqual([])
    expect(writesB).toEqual([])
  } finally {
    await one.close()
    await two.close()
  }
})

test('driver reassignment and session changes cannot show another driver', async ({ page }) => {
  const state = { value: race }
  await mockSession(page, state)
  await page.goto('/display/driver/driver-a')
  await expect(page.getByText('Driver Alpha')).toBeVisible()
  await expect(page.getByText('Controller 1')).toBeVisible()

  state.value = {
    ...race,
    drivers: [
      { ...participants[0], controller: 1 },
      { ...participants[1], controller: 0 },
    ],
  }
  await page.evaluate(() => window.dispatchEvent(new Event('session:status_changed')))
  await expect(page.getByText('Controller 2')).toBeVisible()
  await expect(page.getByText('Driver Beta')).toHaveCount(0)

  state.value = {
    ...race,
    id: 'race-b', name: 'Another session',
    drivers: [{ ...participants[1], id: 'entry-new', controller: 0 }],
  }
  await page.evaluate(() => window.dispatchEvent(new Event('session:status_changed')))
  await expect(page.getByText('Another session')).toBeVisible()
  await expect(page.getByText('This driver is not assigned')).toBeVisible()
  await expect(page.getByText('Driver Beta')).toHaveCount(0)
})


test('duplicate assignment does not silently select the wrong controller', async ({ page }) => {
  const state = { value: { ...race, drivers: [participants[0], { ...participants[0], id: 'entry-duplicate', controller: 3 }] } }
  await mockSession(page, state)
  await page.goto('/display/driver/driver-a')
  await expect(page.getByRole('alert')).toContainText('multiple assignments')
  await expect(page.getByText('Controller 1')).toHaveCount(0)
})
import { test, expect } from '@playwright/test'

test.use({ locale: 'en-US' })

const secret = 'z'.repeat(64)
const participant = {
  id: 'entry-1',
  driverId: 'driver-1',
  controller: 0,
  totalLaps: 3,
  driver: { id: 'driver-1', name: 'Driver One' },
}
const race = {
  id: 'race-1',
  name: 'LAN Test Race',
  type: 'race',
  status: 'active',
  drivers: [participant],
}

async function setup(page, addresses) {
  await page.route('**/api/race-control/lan-addresses', (route) =>
    route.fulfill({ json: { success: true, data: addresses } })
  )
  await page.route('**/api/race-control/status', (route) => route.fulfill({ json: { success: true, enabled: true } }))
  await page.route('**/api/race-control/director/check', (route) => {
    const allowed = route.request().headers().authorization === `Bearer ${secret}`
    return route.fulfill({ status: allowed ? 200 : 403, json: { success: allowed } })
  })
  await page.route('**/api/race-control/vsc', (route) =>
    route.fulfill({ json: { success: true, data: { status: 'inactive', active: false } } })
  )
  await page.route('**/api/sessions?*', (route) => route.fulfill({ json: { success: true, data: [race] } }))
  await page.route('**/api/sessions/race-1', (route) => route.fulfill({ json: { success: true, data: race } }))
}

async function authorize(page) {
  await page.goto('/display/control')
  await page.getByLabel('Race director credential').fill(secret)
  await page.getByRole('button', { name: 'Unlock' }).click()
  await expect(page.getByText('Share race director')).toBeVisible()
}

test('director QR defaults to LAN-only and includes full credential only when opted in', async ({ page }) => {
  await setup(page, [{ name: 'Wi-Fi', address: '192.168.178.42' }])
  await authorize(page)
  const panel = page.getByTestId('lan-share-panel').first()
  const plain = 'http://192.168.178.42:5175/display/control'
  await expect(panel.getByLabel('LAN link')).toHaveValue(plain)
  await expect(panel.locator('svg')).toHaveCount(1)
  await expect(panel.locator('a')).toHaveAttribute('href', plain)
  await panel.getByLabel('Include director credential in QR code').check()
  const protectedLink = `${plain}#director=${secret}`
  await expect(panel.getByLabel('LAN link')).toHaveValue(protectedLink)
  await expect(panel.getByLabel('LAN link')).toHaveAttribute('type', 'password')
  await expect(panel.locator('a')).toHaveAttribute('href', protectedLink)
  await expect(panel.locator('a')).not.toContainText(secret)
  await expect(panel.getByText(/grants full race-director control/)).toBeVisible()
  expect(page.url()).not.toContain(secret)
  await panel.getByLabel('Include director credential in QR code').uncheck()
  await expect(panel.getByLabel('LAN link')).toHaveValue(plain)
})

test('scanned director credential is checked and removed from browser history before authorization', async ({
  page,
}) => {
  await setup(page, [{ name: 'Wi-Fi', address: '192.168.178.42' }])
  let validated = ''
  page.on('request', (request) => {
    if (request.url().includes('/api/race-control/director/check')) {
      validated = request.headers().authorization
      expect(request.url()).not.toContain(secret)
    }
  })
  await page.goto(`/display/control#director=${secret}`)
  await expect(page.getByText('Share race director')).toBeVisible()
  expect(validated).toBe(`Bearer ${secret}`)
  expect(page.url()).not.toContain(secret)
  expect(await page.evaluate(() => window.location.hash)).toBe('')
})

test('multiple LAN interfaces require selection; driver CHAOS fragment is preserved', async ({ page }) => {
  await setup(page, [
    { name: 'Ethernet', address: '10.0.0.8' },
    { name: 'Wi-Fi', address: '192.168.178.42' },
  ])
  await page.route('**/api/race-control/driver-link', (route) =>
    route.fulfill({ json: { success: true, token: 'signed-driver-token' } })
  )
  await authorize(page)
  const director = page.getByTestId('lan-share-panel').first()
  await expect(director.locator('svg')).toHaveCount(0)
  await director.getByLabel('Race PC LAN address').selectOption('192.168.178.42')
  await expect(director.getByLabel('LAN link')).toHaveValue('http://192.168.178.42:5175/display/control')

  await page.getByRole('button', { name: 'Driver One' }).click()
  const driver = page.getByTestId('lan-share-panel').last()
  await driver.getByLabel('Race PC LAN address').selectOption('10.0.0.8')
  await expect(driver.locator('a')).toHaveAttribute(
    'href',
    'http://10.0.0.8:5175/display/driver/driver-1#chaos=signed-driver-token'
  )
  await expect(driver.locator('svg')).toHaveCount(1)
  expect(page.url()).not.toContain('signed-driver-token')
})

test('without a private LAN address no localhost QR is fabricated', async ({ page }) => {
  await setup(page, [])
  await authorize(page)
  const panel = page.getByTestId('lan-share-panel').first()
  await expect(panel.getByRole('alert')).toContainText('No private IPv4 address')
  await expect(panel.locator('svg')).toHaveCount(0)
  await expect(panel.locator('a')).toHaveCount(0)
})

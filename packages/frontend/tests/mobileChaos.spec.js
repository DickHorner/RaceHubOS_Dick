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

test('first-run setup lets the race PC choose its own director credential', async ({ page }) => {
  await mockRace(page, race)
  await page.route('**/api/race-control/status', (route) =>
    route.fulfill({ json: { success: true, enabled: false, setupAvailable: true } })
  )
  const custom = 'Race_Director_Custom_Key_2026-ABC'
  let submitted
  await page.route('**/api/race-control/setup', (route) => {
    submitted = route.request().postDataJSON()
    return route.fulfill({ json: { success: true, secret: submitted.secret } })
  })
  await page.goto('/display/control')
  await page.getByLabel('Custom director credential (optional)').fill('too-short')
  await expect(page.getByRole('button', { name: /set up race control/i })).toBeDisabled()
  await page.getByLabel('Custom director credential (optional)').fill(custom)
  await page.getByRole('button', { name: /set up race control/i }).click()
  await expect(page.getByRole('status').filter({ hasText: /director authorized/i })).toBeVisible()
  expect(submitted).toEqual({ secret: custom })
  await expect(page.getByLabel(/new race director credential/i)).toHaveValue(custom)
  expect(page.url()).not.toContain(custom)
})

test('authorized director can change the key and refresh the optional QR link', async ({ page }) => {
  await mockRace(page, race)
  const original = 'Original_Director_Key_1234567890'
  const replacement = 'Replacement_Director_Key_1234567890'
  await page.route('**/api/race-control/status', (route) => route.fulfill({ json: { success: true, enabled: true } }))
  await page.route('**/api/race-control/director/check', (route) => {
    const allowed = route.request().headers().authorization === `Bearer ${original}`
    return route.fulfill({ status: allowed ? 200 : 403, json: { success: allowed } })
  })
  await page.route('**/api/race-control/lan-addresses', (route) =>
    route.fulfill({ json: { success: true, data: [{ name: 'Wi-Fi', address: '192.168.178.42' }] } })
  )
  let oldAuthorization
  let received
  await page.route('**/api/race-control/director/credential', (route) => {
    oldAuthorization = route.request().headers().authorization
    received = route.request().postDataJSON()
    return route.fulfill({ json: { success: true } })
  })
  await page.goto('/display/control')
  await page.getByLabel(/director credential/i).fill(original)
  await page.getByRole('button', { name: /unlock/i }).click()
  await expect(page.getByText('Share race director')).toBeVisible()
  await page.getByLabel('Set a new director credential').fill('short')
  await expect(page.getByRole('button', { name: 'Change credential' })).toBeDisabled()
  await page.getByLabel('Set a new director credential').fill(replacement)
  await page.getByRole('button', { name: 'Change credential' }).click()
  await expect(page.getByText('Director credential changed. The new key is active immediately.')).toBeVisible()
  expect(oldAuthorization).toBe(`Bearer ${original}`)
  expect(received).toEqual({ secret: replacement })
  const share = page.getByTestId('lan-share-panel')
  await share.getByLabel('Include director credential in QR code').check()
  await expect(share.getByLabel('LAN link')).toHaveValue(new RegExp(`#director=${replacement}$`))
  expect(page.url()).not.toContain(replacement)
})

test('director can disable the credential entirely and re-enable it from the open LAN screen', async ({ page }) => {
  await mockRace(page, race)
  const secret = 'Race_Director_Key_For_Local_Mode_2026'
  let keyRequired = true
  const updates = []

  await page.route('**/api/race-control/status', (route) =>
    route.fulfill({ json: { success: true, enabled: true, keyRequired } })
  )
  await page.route('**/api/race-control/director/check', (route) => {
    const valid = route.request().headers().authorization === `Bearer ${secret}`
    return route.fulfill({ status: valid ? 200 : 403, json: { success: valid } })
  })
  await page.route('**/api/race-control/director/key-required', (route) => {
    const body = route.request().postDataJSON()
    updates.push({ required: body.keyRequired, key: route.request().headers().authorization })
    keyRequired = body.keyRequired
    return route.fulfill({ json: { success: true, keyRequired } })
  })

  await page.goto('/display/control')
  await page.getByLabel(/director credential/i).fill(secret)
  await page.getByRole('button', { name: /unlock/i }).click()
  await expect(page.getByRole('status').filter({ hasText: /director authorized/i })).toBeVisible()
  await page.getByLabel('Require race director key').uncheck()
  await expect(page.getByText(/anyone on the network can control races/i)).toBeVisible()
  expect(updates[0]).toEqual({ required: false, key: `Bearer ${secret}` })

  await page.reload()
  await expect(page.getByRole('status').filter({ hasText: /director authorized/i })).toBeVisible()
  await expect(page.getByLabel('Require race director key')).not.toBeChecked()
  await expect(page.getByLabel('Race director credential', { exact: true })).toHaveCount(0)
  await page.getByLabel('Require race director key').check()
  expect(updates[1].required).toBe(true)
  await page.reload()
  await expect(page.getByLabel(/director credential/i)).toBeVisible()
})

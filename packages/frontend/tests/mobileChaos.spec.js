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
  await page.route('**/api/race-control/driver/session', (route) =>
    route.fulfill({
      json: { success: true, data: { sessionId: session.id, sessionDriverId: 'entry-1', driverId: 'driver-1' } },
    })
  )
  await page.route('**/api/sessions?*', (route) => route.fulfill({ json: { success: true, data: [session] } }))
  await page.route('**/api/sessions/race-1', (route) => route.fulfill({ json: { success: true, data: session } }))
}

test('session recovery protects the bound session and only resolves the confirmed orphan on mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockRace(page, race)
  await page.route('**/api/race-control/status', (route) =>
    route.fulfill({ json: { success: true, enabled: true, keyRequired: false } })
  )
  const orphan = { id: 'orphan-1', name: 'Old practice', type: 'practice', status: 'paused' }
  let rows = [race, orphan]
  await page.route('**/api/race-control/director/session-recovery', (route) =>
    route.fulfill({ json: { success: true, data: { boundSessionId: race.id, sessions: rows } } })
  )
  let submitted
  let calls = 0
  await page.route('**/api/race-control/director/session-recovery/orphan-1', (route) => {
    calls++
    submitted = route.request().postDataJSON()
    rows = [race]
    return route.fulfill({ json: { success: true, data: { sessionId: orphan.id, status: 'interrupted' } } })
  })
  await page.goto('/display/control#session-recovery')
  await expect(page.getByTestId('session-recovery-choice-race-1')).toBeDisabled()
  await expect(page.getByTestId('session-recovery-choice-orphan-1')).not.toBeChecked()
  await page.getByTestId('session-recovery-choice-orphan-1').check()
  await expect(page.getByTestId('session-recovery-submit')).toBeDisabled()
  expect(calls).toBe(0)
  await page.getByTestId('session-recovery-confirm').check()
  await page.getByTestId('session-recovery-submit').click()
  await expect(page.getByTestId('session-recovery-notice')).toContainText('Old practice')
  await expect(page.getByTestId('session-recovery-choice-orphan-1')).toHaveCount(0)
  await expect(page.getByTestId('session-recovery-choice-race-1')).toBeDisabled()
  expect(submitted).toEqual({ confirmed: true, expectedStatus: 'paused' })
  expect(calls).toBe(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('after restart session recovery requires a fresh confirmation for each selection', async ({ page }) => {
  await mockRace(page, race)
  await page.route('**/api/race-control/status', (route) =>
    route.fulfill({ json: { success: true, enabled: true, keyRequired: false } })
  )
  await page.route('**/api/race-control/director/session-recovery', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          boundSessionId: null,
          sessions: [race, { ...race, id: 'old-2', name: 'Other heat', status: 'paused' }],
        },
      },
    })
  )
  await page.goto('/display/control#session-recovery')
  const panel = page.getByTestId('session-recovery-panel')
  await expect(panel.getByText(/does not establish which session was actually running/i)).toBeVisible()
  await expect(panel.getByRole('radio', { checked: true })).toHaveCount(0)
  await page.getByTestId('session-recovery-choice-race-1').check()
  await page.getByTestId('session-recovery-confirm').check()
  await expect(page.getByTestId('session-recovery-submit')).toBeEnabled()
  await page.getByTestId('session-recovery-choice-old-2').check()
  await expect(page.getByTestId('session-recovery-confirm')).not.toBeChecked()
  await expect(page.getByTestId('session-recovery-submit')).toBeDisabled()
})

test('session recovery reports concurrent changes and refreshes the bound-session protection', async ({ page }) => {
  await mockRace(page, race)
  await page.route('**/api/race-control/status', (route) =>
    route.fulfill({ json: { success: true, enabled: true, keyRequired: false } })
  )
  let boundSessionId = null
  await page.route('**/api/race-control/director/session-recovery', (route) =>
    route.fulfill({ json: { success: true, data: { boundSessionId, sessions: [race] } } })
  )
  await page.route('**/api/race-control/director/session-recovery/race-1', (route) => {
    boundSessionId = race.id
    return route.fulfill({ status: 409, json: { success: false } })
  })
  await page.goto('/display/control#session-recovery')
  await page.getByTestId('session-recovery-choice-race-1').check()
  await page.getByTestId('session-recovery-confirm').check()
  await page.getByTestId('session-recovery-submit').click()
  await expect(page.getByTestId('session-recovery-error')).toContainText('Refresh the list')
  await expect(page.getByTestId('session-recovery-notice')).toHaveCount(0)
  await page.getByTestId('session-recovery-refresh').click()
  await expect(page.getByTestId('session-recovery-choice-race-1')).toBeDisabled()
  await expect(page.getByTestId('session-recovery-submit')).toHaveCount(0)
})

test('session detail distinguishes recovery from a normal race finish', async ({ page }) => {
  await mockRace(page, {
    ...race,
    status: 'interrupted',
    recoveredAt: '2026-10-29T15:00:00Z',
    recoveredFromStatus: 'active',
    laps: [],
    penalties: [],
    pitStops: [],
  })
  await page.goto('/sessions/race-1')
  await expect(page.getByTestId('session-recovery-audit')).toContainText('not a normal race finish')
  await expect(page.getByTestId('session-recovery-audit')).toContainText('Incomplete')
})

test('blocked race start links directly to session recovery', async ({ page }) => {
  // This UI fixture supplies its own device state; live CU broadcasts must not
  // overwrite it while the test exercises the HTTP conflict response.
  await page.routeWebSocket('**/socket.io/**', (socket) => socket.close())
  await page.route('**/socket.io/**', (route) => route.abort())
  await page.route('**/api/preferences/**', (route) => route.fulfill({ json: { success: true, data: null } }))
  await page.route('**/api/records/track/**', (route) =>
    route.fulfill({ json: { success: true, data: { practice: [], qualif: [], race: [] } } })
  )
  const track = { id: 'recovery-track', name: 'Recovery circuit' }
  const car = { ...participant.car, id: 'recovery-car' }
  const draft = {
    ...race,
    status: 'draft',
    trackId: track.id,
    track,
    drivers: [{ ...participant, carId: car.id, car }],
  }
  await mockRace(page, draft)
  await page.route('**/api/tracks', (route) => route.fulfill({ json: { success: true, data: [track] } }))
  await page.route('**/api/drivers', (route) => route.fulfill({ json: { success: true, data: [participant.driver] } }))
  await page.route('**/api/cars', (route) => route.fulfill({ json: { success: true, data: [car] } }))
  await page.route('**/api/bluetooth/status', (route) =>
    route.fulfill({ json: { connected: true, deviceType: 'simulator' } })
  )
  await page.route('**/api/sessions/race-1/leaderboard', (route) =>
    route.fulfill({ json: { success: true, data: [] } })
  )
  await page.route('**/api/sync/load-session/race-1', (route) => route.fulfill({ json: { success: true } }))
  await page.route('**/api/sessions/race-1/start', (route) =>
    route.fulfill({
      status: 409,
      json: {
        success: false,
        error: 'Another session is already running',
        runningSessions: [{ id: 'old-1', status: 'active' }],
      },
    })
  )
  await page.addInitScript(() => {
    localStorage.setItem('racehubos-free-track', 'recovery-track')
    localStorage.setItem('racehubos-free-type', 'race')
  })
  await page.goto('/race')
  await expect(page.getByTestId('session-section')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('session-section').getByRole('button', { name: 'Start', exact: true })).toBeEnabled()
  await page.getByTestId('session-section').getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByTestId('session-conflict-recovery-link')).toHaveAttribute(
    'href',
    '/display/control#session-recovery'
  )
})

test('development proxy preserves the LAN host for recovery checks', async ({ request }) => {
  const status = await request.get('/api/race-control/status', { headers: { Host: '192.168.0.10:5175' } })
  expect(status.ok()).toBe(true)
  expect(await status.json()).toMatchObject({ setupAvailable: false, recoveryAvailable: false })
  const recovery = await request.post('/api/race-control/recover', {
    headers: { Host: '192.168.0.10:5175', Origin: 'http://192.168.0.10:5175' },
    data: { confirmed: true },
  })
  expect(recovery.status()).toBe(403)
})

test('forgotten credential can be recovered locally after explicit confirmation', async ({ page }) => {
  await mockRace(page, race)
  await page.route('**/api/race-control/status', (route) =>
    route.fulfill({
      json: { success: true, enabled: true, keyRequired: true, recoveryAvailable: true },
    })
  )
  const replacement = 'Recovered_Director_Key_2026'.padEnd(40, 'A')
  let submitted
  let calls = 0
  await page.route('**/api/race-control/recover', (route) => {
    calls++
    submitted = route.request().postDataJSON()
    expect(route.request().headers().authorization).toBeUndefined()
    return route.fulfill({ json: { success: true, secret: replacement } })
  })
  await page.goto('/display/control')
  await page.getByTestId('director-recovery-open').click()
  await expect(page.getByTestId('director-recovery-submit')).toBeDisabled()
  await page.getByTestId('director-recovery-confirm').check()
  await page.getByLabel('Custom director credential (optional)').fill('short')
  await expect(page.getByTestId('director-recovery-submit')).toBeDisabled()
  expect(calls).toBe(0)
  await page.getByLabel('Custom director credential (optional)').fill(replacement)
  await page.getByTestId('director-recovery-submit').click()
  await expect(page.getByRole('status').filter({ hasText: /director authorized/i })).toBeVisible()
  await expect(page.getByLabel(/new race director credential/i)).toHaveValue(replacement)
  await expect(page.getByTestId('director-recovery-form')).toHaveCount(0)
  expect(submitted).toEqual({ confirmed: true, secret: replacement })
  expect(calls).toBe(1)
  expect(page.url()).not.toContain(replacement)
})

test('recovery remains discoverable remotely with an explanation and no executable action', async ({ page }) => {
  await mockRace(page, race)
  await page.route('**/api/race-control/status', (route) =>
    route.fulfill({
      json: { success: true, enabled: true, recoveryAvailable: false },
    })
  )
  await page.goto('/display/control')
  await expect(page.getByTestId('director-recovery-open')).toBeVisible()
  await expect(page.getByTestId('director-recovery-open')).toBeDisabled()
  await expect(page.getByText(/open this page via localhost directly on the race PC/i)).toBeVisible()
})

test('unusable file entry offers recovery and keeps failed recovery on screen', async ({ page }) => {
  await mockRace(page, race)
  await page.route('**/api/race-control/status', (route) =>
    route.fulfill({
      json: { success: true, enabled: false, setupAvailable: false, recoveryAvailable: true },
    })
  )
  await page.route('**/api/race-control/recover', (route) =>
    route.fulfill({
      status: 409,
      json: { success: false, code: 'recoveryConfigError' },
    })
  )
  await page.goto('/display/control')
  await expect(page.getByRole('button', { name: /set up race control/i })).toHaveCount(0)
  await page.getByTestId('director-recovery-open').click()
  await page.getByTestId('director-recovery-confirm').check()
  await page.getByTestId('director-recovery-submit').click()
  await expect(page.getByRole('alert')).toHaveText(/managed externally or contains conflicting entries/i)
  await expect(page.getByTestId('director-recovery-form')).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: /director authorized/i })).toHaveCount(0)
})

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
  await page.getByLabel('Require race director key').click()
  await expect(page.getByLabel('Require race director key')).not.toBeChecked()
  await expect(page.getByText(/anyone on the network can control races/i)).toBeVisible()
  expect(updates[0]).toEqual({ required: false, key: `Bearer ${secret}` })

  await page.reload()
  await expect(page.getByRole('status').filter({ hasText: /director authorized/i })).toBeVisible()
  await expect(page.getByLabel('Require race director key')).not.toBeChecked()
  await expect(page.getByLabel('Race director credential', { exact: true })).toHaveCount(0)
  await page.getByLabel('Require race director key').click()
  await expect(page.getByLabel('Race director credential', { exact: true })).toBeVisible()
  expect(updates[1].required).toBe(true)
  await page.reload()
  await expect(page.getByLabel('Race director credential', { exact: true })).toBeVisible()
})

async function penaltyServingFixture(page, authorized = true) {
  const penalty = {
    id: 'pending-penalty',
    sessionId: 'race-1',
    sessionDriverId: participant.id,
    controller: 0,
    kind: 'time',
    amount: 5000,
    reason: 'Unsafe overtake',
    status: 'active',
    issuedAt: '2026-10-31T10:00:00Z',
  }
  const current = {
    ...race,
    penalties: [penalty],
    pitStops: [
      {
        id: 'pit-after',
        sessionId: 'race-1',
        sessionDriverId: participant.id,
        controller: 0,
        source: 'simulator',
        durationMs: 6000,
        enteredAt: '2026-10-31T10:01:00Z',
        exitedAt: '2026-10-31T10:01:06Z',
      },
    ],
    laps: [],
  }
  await page.routeWebSocket('**/socket.io/**', (socket) => socket.close())
  await page.route('**/socket.io/**', (route) => route.abort())
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok' } }))
  await page.route('**/api/preferences/**', (route) => route.fulfill({ json: { success: true, data: null } }))
  await page.route('**/api/devices', (route) => route.fulfill({ json: { success: true, data: [] } }))
  await page.route('**/api/bluetooth/status', (route) => route.fulfill({ json: { connected: false } }))
  await page.route('**/api/race-control/status', (route) =>
    route.fulfill({ json: { success: true, enabled: true, keyRequired: true } })
  )
  await page.route('**/api/race-control/vsc', (route) =>
    route.fulfill({ json: { success: true, data: { status: 'inactive' } } })
  )
  await page.route('**/api/race-control/director/check', (route) => route.fulfill({ json: { success: true } }))
  await mockRace(page, current)
  const state = { current, writes: [], reject: false, gate: null }
  await page.route('**/api/race-control/director/penalties/pending-penalty/serve', async (route) => {
    const data = route.request().postDataJSON()
    state.writes.push({ data, auth: route.request().headers().authorization })
    if (state.gate) await state.gate
    if (state.reject)
      return route.fulfill({ status: 409, json: { success: false, error: 'Stop changed; refresh evidence' } })
    Object.assign(penalty, {
      status: 'served',
      servedAt: '2026-10-31T10:02:00Z',
      servedMethod: data.method,
      servedPitStopId: data.pitStopId,
      servedReason: data.reason,
    })
    return route.fulfill({ json: { success: true, data: penalty } })
  })
  await page.goto('/display/control' + (authorized ? '#director=director-penalty-serving-test-key-12345' : ''))
  return state
}

test('director verifies stationary time, serves once and retains the audit after reload and in history', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const state = await penaltyServingFixture(page)
  const form = page.getByTestId('serve-pending-penalty')
  const submit = form.getByRole('button', { name: 'Confirm served', exact: true })
  await expect(submit).toBeDisabled()
  await form.getByLabel('Reason / evidence').fill('Stationary time verified on video')
  await expect(submit).toBeDisabled()
  await form.getByRole('checkbox').check()
  let release
  state.gate = new Promise((resolve) => {
    release = resolve
  })
  await submit.click()
  await expect(submit).toBeDisabled()
  release()
  await expect(form).toHaveCount(0)
  expect(state.writes).toHaveLength(1)
  expect(state.writes[0]).toMatchObject({
    data: { method: 'pit', pitStopId: 'pit-after', confirmedStationary: true },
    auth: 'Bearer director-penalty-serving-test-key-12345',
  })
  await page.reload()
  await page.getByLabel('Race director credential', { exact: true }).fill('director-penalty-serving-test-key-12345')
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(page.getByTestId('penalty-audit-pending-penalty')).toContainText('Served')
  await expect(page.getByTestId('penalty-audit-pending-penalty')).toContainText('Stationary time verified on video')
  await page.goto('/sessions/race-1')
  await expect(page.getByTestId('penalty-served-pending-penalty')).toContainText('pit-after')
})

test('manual penalty override requires a reason and rejected evidence keeps the penalty pending', async ({ page }) => {
  const state = await penaltyServingFixture(page)
  const form = page.getByTestId('serve-pending-penalty')
  await form.getByLabel('Confirmation method').selectOption('manual')
  await expect(form.getByRole('button', { name: 'Confirm served', exact: true })).toBeDisabled()
  await form.getByLabel('Reason / evidence').fill('Verified despite disconnected timing')
  state.reject = true
  await form.getByRole('button', { name: 'Confirm served', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Stop changed' })).toBeVisible()
  await expect(form).toBeVisible()
  expect(state.current.penalties[0].status).toBe('active')
  state.reject = false
  await form.getByRole('button', { name: 'Confirm served', exact: true }).click()
  await expect(form).toHaveCount(0)
  expect(state.current.penalties[0]).toMatchObject({ servedMethod: 'manual', servedPitStopId: null })
})

test('spectator access cannot expose penalty-serving controls', async ({ page }) => {
  const state = await penaltyServingFixture(page, false)
  await expect(page.getByRole('button', { name: 'Unlock', exact: true })).toBeVisible()
  await expect(page.getByTestId('serve-pending-penalty')).toHaveCount(0)
  expect(state.writes).toEqual([])
})

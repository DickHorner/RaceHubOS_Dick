import { test, expect } from '@playwright/test'

test.use({ locale: 'de-DE' })

const areas = [
  { id: 'race', title: 'Rennzentrale', routes: ['/dashboard', '/race', '/championships', '/display/control'] },
  { id: 'garage', title: 'Garage & Fahrerlager', routes: ['/cars', '/drivers', '/teams', '/tracks'] },
  { id: 'show', title: 'Show & Sound', routes: ['/soundboard-settings', '/soundboard', '/display/scoreboard'] },
  { id: 'analysis', title: 'Datenlabor', routes: ['/history', '/stats', '/balancing'] },
]

test('landing page offers four illustrated area tiles with working destinations', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByText('RaceHub OG', { exact: true })).toBeVisible()
  await expect(page.getByTestId('area-tile-race')).toBeVisible()

  for (const area of areas) {
    const tile = page.getByTestId(`area-tile-${area.id}`)
    await expect(tile).toHaveAttribute('href', `/areas/${area.id}`)
    await expect(tile.locator('img')).toHaveAttribute('src', `/illustrations/${area.id}.svg`)
    await expect.poll(() => tile.locator('img').evaluate((img) => img.naturalWidth)).toBeGreaterThan(0)
  }

  await page.getByTestId('area-tile-garage').click()
  await expect(page).toHaveURL(/\/areas\/garage$/)
  await expect(page.getByRole('main').getByRole('heading', { name: 'Garage & Fahrerlager' })).toBeVisible()
  await expect(page.getByRole('main').getByRole('link', { name: 'Zur Startseite' })).toBeVisible()
  await expect(page.getByRole('main').locator('a[href="/cars"]')).toBeVisible()
})

test('sidebar has four primary areas with context-sensitive secondary links', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('racehubos-sidebar', 'true')
    localStorage.setItem('racehubos-admin', 'false')
  })
  await page.goto('/')

  const groups = page.locator('[data-sidebar="group"]')
  await expect(groups).toHaveCount(4)
  await expect(page.locator('[data-sidebar="menu-sub"]')).toHaveCount(0)

  for (const [index, area] of areas.entries()) {
    const group = groups.nth(index)
    await expect(group).toHaveAttribute('aria-label', area.title)
    await expect(group.locator('a[data-sidebar="menu-button"]')).toHaveAttribute('href', `/areas/${area.id}`)
  }

  await page.goto('/cars')
  await expect(page.locator('[data-sidebar="menu-sub"]')).toHaveCount(1)
  const garage = page.locator('[data-sidebar="group"]').nth(1)
  const routes = await garage
    .locator('a[data-sidebar="menu-sub-button"]')
    .evaluateAll((links) => links.map((link) => new URL(link.href).pathname))
  expect(routes).toEqual(areas[1].routes)
  await expect(garage.locator('a[href="/cars"]')).toHaveAttribute('data-active', 'true')
  await expect(page.getByRole('link', { name: 'Einstellungen' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Test', exact: true })).toHaveCount(0)

  await page.goto('/areas/race')
  await expect(page.locator('[data-sidebar="menu-sub"]')).toHaveCount(1)
  const race = page.locator('[data-sidebar="group"]').first()
  await expect(race.locator('a[href="/display/control"]')).toHaveAttribute('target', '_blank')
  await expect(page.locator('a[href="/dashboard"]')).toBeVisible()
})

test('soundboard and vehicle balancing appear in their intended areas', async ({ page }) => {
  await page.goto('/areas/show')
  const show = page.getByRole('main')
  const soundboard = show.locator('a[href="/soundboard"]')
  await expect(soundboard).toBeVisible()
  await expect(soundboard).toHaveAttribute('target', '_blank')
  await expect(show.locator('a[href="/display/scoreboard"]')).toBeVisible()
  const settings = show.getByRole('link', { name: 'Sounds verwalten' })
  await expect(settings).toHaveAttribute('href', '/soundboard-settings')
  await expect(settings).not.toHaveAttribute('target', '_blank')

  await page.goto('/areas/analysis')
  await expect(page.getByRole('main').locator('a[href="/balancing"]')).toBeVisible()

  await page.goto('/areas/garage')
  await expect(page.getByRole('main').locator('a[href="/balancing"]')).toHaveCount(0)
})

test('Show & Sound opens shared preset and trigger settings without race controls', async ({ page }) => {
  const presets = (await (await page.request.get('/api/preferences/soundboard:presets')).json()).data
  const mappings = (await (await page.request.get('/api/preferences/soundboard:auto')).json()).data
  try {
    await page.request.put('/api/preferences/soundboard:presets', { data: { value: [] } })
    await page.request.put('/api/preferences/soundboard:auto', { data: { value: {} } })
    await page.goto('/areas/show')
    await page.getByRole('main').getByRole('link', { name: 'Sounds verwalten' }).click()
    await expect(page).toHaveURL(/\/soundboard-settings$/)
    const main = page.getByRole('main')
    await expect(main.getByRole('heading', { name: 'Sounds verwalten', level: 2 })).toBeVisible()
    await expect(main.getByRole('group', { name: 'Automatische Rennsounds' }).getByRole('combobox')).toHaveCount(19)
    const show = page.locator('[data-sidebar="group"]').filter({ has: page.locator('a[href="/areas/show"]') })
    await expect(show.locator('a[href="/soundboard-settings"]')).toHaveAttribute('data-active', 'true')
    await expect(show.locator('a[href="/soundboard"]')).not.toHaveAttribute('data-active', 'true')
    await expect(main.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0)
    await main.getByRole('button', { name: 'Ansage oder Sound hinzufügen' }).click()
    await main.locator('form input[maxlength="60"]').fill('Tankhinweis Einrichtung')
    await main.locator('form textarea').fill('Virtuellen Tank prüfen')
    await main.getByRole('button', { name: 'Speichern', exact: true }).click()
    await expect(main.getByRole('button', { name: 'Tankhinweis Einrichtung', exact: true })).toBeVisible()
    const saved = (await (await page.request.get('/api/preferences/soundboard:presets')).json()).data
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ label: 'Tankhinweis Einrichtung', kind: 'speech', text: 'Virtuellen Tank prüfen' })
    await main.getByRole('combobox', { name: 'Virtueller Tank: höchstens 20 %' }).selectOption(saved[0].id)
    await expect
      .poll(async () => (await (await page.request.get('/api/preferences/soundboard:auto')).json()).data?.fuellow)
      .toBe(saved[0].id)
    await page.reload()
    await expect(main.getByRole('combobox', { name: 'Virtueller Tank: höchstens 20 %' })).toHaveValue(saved[0].id)

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(main.getByRole('button', { name: 'Ansage oder Sound hinzufügen' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    await page.goto('/race')
    await expect(page.getByRole('button', { name: 'Ansage oder Sound hinzufügen' })).not.toBeVisible()
    await page.getByRole('button', { name: 'Soundboard', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Virtueller Tank: höchstens 20 %' })).toHaveValue(saved[0].id)

    await page.goto('/soundboard')
    await expect(page.getByRole('button', { name: 'Tankhinweis Einrichtung', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Ansage oder Sound hinzufügen' })).toHaveCount(0)
    await expect(page.getByRole('combobox')).toHaveCount(0)
  } finally {
    await page.request.put('/api/preferences/soundboard:presets', { data: { value: presets ?? null } })
    await page.request.put('/api/preferences/soundboard:auto', { data: { value: mappings ?? null } })
  }
})

test('system tools remain global and old dashboard lives in the race center', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('racehubos-sidebar', 'true')
    localStorage.setItem('racehubos-admin', 'true')
  })
  await page.goto('/areas/analysis')

  await expect(page.locator('[data-sidebar="group"]')).toHaveCount(4)
  const footer = page.locator('[data-sidebar="footer"]')
  await expect(footer.getByRole('link', { name: 'Anzeigen' })).toBeVisible()
  await expect(footer.getByRole('link', { name: 'Test', exact: true })).toBeVisible()
  await expect(footer.getByRole('link', { name: 'Einstellungen' })).toBeVisible()

  await page.goto('/dashboard')
  await expect(page.locator('a[href="/areas/race"][data-sidebar="menu-button"]')).toHaveAttribute('data-active', 'true')

  await page.goto('/areas/not-a-real-area')
  await expect(page).toHaveURL(/\/$/)
})

test('new race features have flat Home shortcuts with visible prerequisites and direct destinations', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const shortcuts = page.getByTestId('feature-shortcuts')
  await expect(shortcuts.getByRole('link')).toHaveCount(10)
  await expect(page.getByTestId('feature-driverStrategy')).toHaveAttribute('href', '/display/control#driver-links')
  await expect(page.getByTestId('feature-driverStrategy')).toContainText('Rennleitercode')
  await expect(page.getByTestId('feature-fuelRules')).toContainText('vor dem Start')
  await expect(page.getByTestId('feature-directorAccess')).toContainText('localhost')
  await page.getByTestId('feature-startDiagnostics').click()
  await expect(page).toHaveURL(/\/settings#start-diagnostics$/)
  await expect(page.locator('#start-diagnostics')).toBeInViewport()
  await page.goto('/areas/show')
  await expect(page.getByTestId('feature-soundAutomation')).toBeVisible()
  await expect(page.getByTestId('feature-voice')).toBeVisible()
  await expect(page.getByTestId('feature-ambience')).toBeVisible()
})

test('locked director features remain visible and explain access without exposing write controls', async ({ page }) => {
  await page.route('**/api/race-control/status', (route) =>
    route.fulfill({ json: { success: true, enabled: true, keyRequired: true, recoveryAvailable: false } })
  )
  await page.goto('/display/control#driver-links')
  await expect(page.getByTestId('locked-director-features')).toBeVisible()
  await expect(page.locator('#driver-links')).toBeInViewport()
  await expect(page.getByTestId('locked-director-features')).toContainText('Rennleitercode')
  await expect(page.getByTestId('locked-director-features')).toContainText('Zeitstrafen')
  await expect(page.getByTestId('serve-pending-penalty')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Strafe vergeben', exact: true })).toHaveCount(0)
})

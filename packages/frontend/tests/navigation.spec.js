import { test, expect } from '@playwright/test'

test.use({ locale: 'de-DE' })

const areas = [
  { id: 'race', title: 'Rennzentrale', routes: ['/dashboard', '/race', '/championships', '/display/control'] },
  { id: 'garage', title: 'Garage & Fahrerlager', routes: ['/cars', '/drivers', '/teams', '/tracks', '/balancing'] },
  { id: 'show', title: 'Show & Sound', routes: ['/display/scoreboard'] },
  { id: 'analysis', title: 'Datenlabor', routes: ['/history', '/stats'] },
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
  const routes = await garage.locator('a[data-sidebar="menu-sub-button"]').evaluateAll((links) =>
    links.map((link) => new URL(link.href).pathname)
  )
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
  await expect(page.getByRole('main').getByText('RaceHub OG')).toHaveCount(0)
  await expect(page.locator('a[href="/areas/race"][data-sidebar="menu-button"]')).toHaveAttribute('data-active', 'true')

  await page.goto('/areas/not-a-real-area')
  await expect(page).toHaveURL(/\/$/)
})

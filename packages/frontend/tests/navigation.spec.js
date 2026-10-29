import { test, expect } from '@playwright/test'

test.use({ locale: 'de-DE' })

const areas = [
  { title: 'Rennzentrale', routes: ['/', '/race', '/championships', '/display/control'] },
  { title: 'Garage & Fahrerlager', routes: ['/cars', '/drivers', '/teams', '/tracks', '/balancing'] },
  { title: 'Show & Sound', routes: ['/display/scoreboard'] },
  { title: 'Datenlabor', routes: ['/history', '/stats'] },
]

test('navigation groups every main route into four areas and keeps settings global', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('racehubos-sidebar', 'true')
    localStorage.setItem('racehubos-admin', 'false')
  })
  await page.goto('/')

  const groups = page.locator('[data-sidebar="group"]')
  await expect(groups).toHaveCount(4)

  for (const [index, area] of areas.entries()) {
    const group = groups.nth(index)
    await expect(group).toHaveAttribute('aria-label', area.title)
    await expect(group.locator('[data-sidebar="group-label"]')).toHaveText(area.title)
    const routes = await group.locator('a[data-sidebar="menu-button"]').evaluateAll((links) =>
      links.map((link) => new URL(link.href).pathname)
    )
    expect(routes).toEqual(area.routes)
  }

  await expect(page.locator('a[href="/display/control"]')).toHaveAttribute('target', '_blank')
  await expect(page.locator('a[href="/display/scoreboard"]')).toHaveAttribute('target', '_blank')
  await expect(page.getByRole('link', { name: 'Einstellungen' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Test', exact: true })).toHaveCount(0)

  await page.goto('/cars')
  await expect(page.locator('a[data-sidebar="menu-button"][href="/cars"]')).toHaveAttribute('data-active', 'true')
})

test('admin-only developer links remain outside the four areas', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('racehubos-sidebar', 'true')
    localStorage.setItem('racehubos-admin', 'true')
  })
  await page.goto('/')

  await expect(page.locator('[data-sidebar="group"]')).toHaveCount(4)
  const footer = page.locator('[data-sidebar="footer"]')
  await expect(footer.getByRole('link', { name: 'Anzeigen' })).toBeVisible()
  await expect(footer.getByRole('link', { name: 'Test', exact: true })).toBeVisible()
  await expect(footer.getByRole('link', { name: 'Einstellungen' })).toBeVisible()
})

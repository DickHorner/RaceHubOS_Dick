import { test, expect } from '@playwright/test'

test('race commentary options are opt-in and survive a reload', async ({ page }) => {
  await page.request.put('/api/preferences/raceVoice:events', {
    data: { value: null },
  })
  await page.goto('/settings')
  const switches = page.getByRole('switch')
  await expect(switches).toHaveCount(3)
  for (const control of await switches.all()) {
    await expect(control).toHaveAttribute('aria-checked', 'false')
  }

  await switches.nth(1).click()
  await expect
    .poll(async () => {
      const response = await page.request.get('/api/preferences/raceVoice:events')
      return (await response.json()).data
    })
    .toEqual({ start: false, leader: true, finish: false })

  await page.reload()
  await expect(page.getByRole('switch').nth(1)).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('switch').nth(0)).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByRole('switch').nth(2)).toHaveAttribute('aria-checked', 'false')
})

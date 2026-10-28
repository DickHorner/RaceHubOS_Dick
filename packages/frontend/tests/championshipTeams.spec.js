import { test, expect } from '@playwright/test'

const championship = {
  id: 'team-cup',
  name: 'Coupe par équipes',
  status: 'active',
  mode: 'manual',
  track: { name: 'Circuit E2E' },
  participants: [],
}

test('team tab shows historical team points and warns about older unsnapshotted races', async ({ page }) => {
  await page.route('**/api/championships/team-cup', (route) =>
    route.fulfill({ json: { success: true, data: championship } })
  )
  await page.route('**/api/sessions?championshipId=team-cup', (route) =>
    route.fulfill({ json: { success: true, data: [] } })
  )
  await page.route('**/api/drivers', (route) => route.fulfill({ json: { success: true, data: [] } }))
  await page.route('**/api/cars', (route) => route.fulfill({ json: { success: true, data: [] } }))
  await page.route('**/api/tracks', (route) => route.fulfill({ json: { success: true, data: [] } }))
  await page.route('**/api/championships/team-cup/standings?type=*', (route) =>
    route.fulfill({ json: { success: true, standings: [] } })
  )
  await page.route('**/api/championships/team-cup/team-standings', (route) =>
    route.fulfill({
      json: {
        success: true,
        standings: [
          { position: 1, teamId: 'a', team: { name: 'Rouges', color: '#f00' }, totalPoints: 43 },
          { position: 2, teamId: 'b', team: { name: 'Bleus', color: '#00f' }, totalPoints: 25 },
        ],
        legacyRaces: 1,
      },
    })
  )

  await page.goto('/championships/team-cup')
  await page.getByRole('button', { name: 'Équipes' }).click()
  await expect(page.getByText('Rouges')).toBeVisible()
  await expect(page.getByText('Bleus')).toBeVisible()
  await expect(page.getByText('43 pts')).toBeVisible()
  await expect(page.getByRole('status')).toContainText('ancienne course')
  await page
    .getByRole('button', { name: /Course/ })
    .last()
    .click()
  await expect(page.getByText('Rouges')).toHaveCount(0)
})

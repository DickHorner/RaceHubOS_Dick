import { test, expect } from '@playwright/test'

const drivers = [
  {
    id: 'assignment-a',
    driverId: 'd-a',
    carId: 'car-a',
    controller: 0,
    totalLaps: 3,
    totalTime: 28_000,
    bestLapTime: 7000,
    lastLapTime: 7000,
    driver: { id: 'd-a', name: 'Alpha', color: '#ef4444' },
    car: { id: 'car-a', brand: 'BMW', model: 'M4' },
  },
  {
    id: 'assignment-b',
    driverId: 'd-b',
    carId: 'car-b',
    controller: 1,
    totalLaps: 3,
    totalTime: 30_000,
    bestLapTime: 8000,
    lastLapTime: 11_000,
    driver: { id: 'd-b', name: 'Beta', color: '#2563eb' },
    car: { id: 'car-b', brand: 'Porsche', model: 'GT1' },
  },
]

function lap(controller, number, second, time) {
  const participant = drivers[controller]
  return {
    id: `lap-${controller}-${number}`,
    controller,
    lapNumber: number,
    driverId: participant.driverId,
    carId: participant.carId,
    phase: 'race',
    lapTime: time,
    timestamp: new Date(Date.parse('2026-10-26T10:00:00Z') + second * 1000).toISOString(),
  }
}

const race = {
  id: 'lap-analysis',
  name: 'Lap Analytics',
  type: 'race',
  status: 'finished',
  track: { id: 't-a', name: 'Circuit E2E', bestLap: 7000 },
  drivers,
  penalties: [],
  laps: [
    lap(0, 1, 10, 10_000),
    lap(1, 1, 11, 11_000),
    lap(1, 2, 19, 8000),
    lap(0, 2, 21, 11_000),
    lap(0, 3, 28, 7000),
    lap(1, 3, 30, 11_000),
  ],
  createdAt: '2026-10-26T10:00:00.000Z',
  startedAt: '2026-10-26T10:00:00.000Z',
  finishedAt: '2026-10-26T10:02:00.000Z',
}

test('session detail charts measured laps, filters driver/car, and labels logged lead changes', async ({ page }) => {
  const writes = []
  page.on('request', (request) => {
    if (request.url().includes('/api/') && request.method() !== 'GET') writes.push(request.url())
  })
  await page.route('**/api/sessions/lap-analysis', (route) => route.fulfill({ json: { success: true, data: race } }))
  await page.goto('/sessions/lap-analysis')

  await expect(page.getByRole('heading', { name: 'Évolution des temps au tour' })).toBeVisible()
  await expect(page.getByRole('checkbox', { name: /Alpha.*BMW M4/ })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: /Beta.*Porsche GT1/ })).toBeChecked()
  await expect(page.getByText('Changement de leader observé', { exact: false })).toHaveCount(2)
  await expect(page.getByText('Record du circuit enregistré', { exact: false })).toBeVisible()

  await page.getByRole('checkbox', { name: /Alpha.*BMW M4/ }).uncheck()
  await page.getByRole('checkbox', { name: /Beta.*Porsche GT1/ }).uncheck()
  await expect(page.getByText('Aucune série sélectionnée.')).toBeVisible()
  expect(writes).toEqual([])
})

test('uncertain race timestamps show a warning instead of claimed lead changes', async ({ page }) => {
  const uncertain = {
    ...race,
    laps: [...race.laps.slice(0, 2), { ...race.laps[2], timestamp: race.laps[1].timestamp }, ...race.laps.slice(3)],
  }
  await page.route('**/api/sessions/lap-analysis', (route) =>
    route.fulfill({ json: { success: true, data: uncertain } })
  )
  await page.goto('/sessions/lap-analysis')

  await expect(page.getByRole('status')).toContainText('Impossible de reconstruire les changements de leader')
  await expect(page.getByText('Changement de leader observé', { exact: false })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Évolution des temps au tour' })).toBeVisible()
})

test('practice lap-time chart has no race-lead timeline', async ({ page }) => {
  const practice = {
    ...race,
    status: 'draft',
    type: 'practice',
    laps: race.laps.map((entry) => ({ ...entry, phase: 'practice' })),
  }
  await page.route('**/api/sessions/lap-analysis', (route) =>
    route.fulfill({ json: { success: true, data: practice } })
  )
  await page.goto('/sessions/lap-analysis')

  await expect(page.getByRole('heading', { name: 'Évolution des temps au tour' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Leaders aux passages enregistrés' })).toHaveCount(0)
})

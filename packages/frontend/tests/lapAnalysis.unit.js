import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeSessionLaps } from '../src/lib/lapAnalysis.js'

const drivers = [
  {
    controller: 0,
    driverId: 'd-a',
    carId: 'car-a',
    driver: { name: 'Alpha', color: '#f00' },
    car: { brand: 'BMW', model: 'M4' },
  },
  {
    controller: 1,
    driverId: 'd-b',
    carId: 'car-b',
    driver: { name: 'Beta', color: '#00f' },
    car: { brand: 'Porsche', model: 'GT1' },
  },
]

const base = Date.parse('2026-10-26T10:00:00.000Z')

function lap(controller, lapNumber, second, lapTime = 10_000) {
  return {
    id: `lap-${controller}-${lapNumber}`,
    controller,
    driverId: drivers[controller].driverId,
    carId: drivers[controller].carId,
    phase: 'race',
    lapNumber,
    lapTime,
    timestamp: new Date(base + second * 1000).toISOString(),
  }
}

function race(laps) {
  return { type: 'race', drivers, laps }
}

test('shuffled crossings produce only observed highest-lap leader changes', () => {
  const data = [
    lap(0, 3, 28, 7000),
    lap(1, 2, 19, 8000),
    lap(0, 1, 10, 10_000),
    lap(1, 1, 11, 11_000),
    lap(0, 2, 21, 11_000),
    lap(1, 3, 30, 11_000),
  ]
  const result = analyzeSessionLaps(race(data))

  assert.equal(result.incomplete, false)
  assert.deepEqual(
    result.leaders.map(({ controller, lapNumber, type }) => [controller, lapNumber, type]),
    [
      [0, 1, 'first'],
      [1, 2, 'change'],
      [0, 3, 'change'],
    ]
  )
  assert.deepEqual(
    result.chartData.map((row) => row.lap),
    [1, 2, 3]
  )
  assert.equal(result.chartData[1].c1, 8)
  assert.deepEqual(
    result.series.map((entry) => entry.bestLapNumber),
    [3, 2]
  )
})

test('equal timestamps, skipped laps and duplicate laps suppress inferred lead changes', () => {
  const baseLaps = [lap(0, 1, 10), lap(1, 1, 11), lap(0, 2, 20), lap(1, 2, 21)]

  const tied = analyzeSessionLaps(
    race([baseLaps[0], { ...baseLaps[1], timestamp: baseLaps[0].timestamp }, ...baseLaps.slice(2)])
  )
  assert.equal(tied.incomplete, true)
  assert.deepEqual(tied.leaders, [])

  const skipped = analyzeSessionLaps(race([lap(0, 1, 10), lap(1, 1, 11), lap(1, 3, 22)]))
  assert.equal(skipped.incomplete, true)
  assert.deepEqual(skipped.leaders, [])
  assert.deepEqual(
    skipped.chartData.map((row) => row.lap),
    [1, 3]
  )

  const duplicated = analyzeSessionLaps(race([...baseLaps, lap(0, 2, 22, 9999)]))
  assert.equal(duplicated.incomplete, true)
  assert.deepEqual(duplicated.leaders, [])
  assert.equal(duplicated.chartData.find((row) => row.lap === 2).c0, undefined)
})

test('deleted laps are excluded; wrong driver/car and bad timestamps are not attributed', () => {
  const deleted = { ...lap(0, 2, 20), deletedAt: new Date().toISOString() }
  const ordinary = analyzeSessionLaps(race([lap(0, 1, 10), deleted, lap(1, 1, 11)]))
  assert.equal(ordinary.incomplete, false)
  assert.equal(ordinary.chartData.length, 1)
  assert.equal(ordinary.chartData[0].c0, 10)

  const changed = analyzeSessionLaps(race([lap(0, 1, 10), { ...lap(1, 1, 11), carId: 'wrong' }]))
  assert.equal(changed.incomplete, true)
  assert.deepEqual(changed.leaders, [])
  assert.equal(changed.chartData[0].c1, undefined)

  const noTime = analyzeSessionLaps(race([{ ...lap(0, 1, 10), timestamp: 'invalid' }]))
  assert.equal(noTime.incomplete, true)
  assert.deepEqual(noTime.leaders, [])
  assert.equal(noTime.chartData[0].c0, 10)
})

test('large lap histories use bounded chart samples but retain all personal best laps', () => {
  const laps = []
  for (let number = 1; number <= 5000; number++) {
    laps.push(lap(0, number, number * 2, number === 4999 ? 6000 : 10_000))
    laps.push(lap(1, number, number * 2 + 1, number === 4877 ? 7000 : 11_000))
  }
  const result = analyzeSessionLaps(race(laps))
  const plotted = result.chartData.map((row) => row.lap)

  assert.equal(result.incomplete, false)
  assert.ok(result.chartData.length <= 650)
  assert.equal(plotted[0], 1)
  assert.equal(plotted.at(-1), 5000)
  assert.ok(plotted.includes(4999))
  assert.ok(plotted.includes(4877))
  assert.deepEqual(
    result.series.map((entry) => entry.bestLapNumber),
    [4999, 4877]
  )
  assert.deepEqual(
    result.leaders.map((event) => event.type),
    ['first']
  )
})

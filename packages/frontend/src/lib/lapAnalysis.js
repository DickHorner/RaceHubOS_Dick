const MAX_CHART_LAPS = 600

/**
 * Build measured lap series and observed lead crossings from persisted session laps.
 * A write-time timestamp is not proof of intermediate on-track positions.
 */
export function analyzeSessionLaps(session) {
  const participants = (session.drivers || []).filter(
    (entry) => !entry.deletedAt && Number.isInteger(entry.controller) && entry.driverId && entry.carId
  )
  const byController = new Map(participants.map((entry) => [entry.controller, entry]))
  const seen = new Map()
  const duplicates = new Set()
  let incomplete = false

  for (const lap of session.laps || []) {
    if (lap.deletedAt || (lap.phase && lap.phase !== session.type)) continue
    const assigned = byController.get(lap.controller)
    if (
      !assigned ||
      lap.driverId !== assigned.driverId ||
      lap.carId !== assigned.carId ||
      !Number.isInteger(lap.lapNumber) ||
      lap.lapNumber < 1 ||
      !Number.isFinite(lap.lapTime) ||
      lap.lapTime <= 0
    ) {
      incomplete = true
      continue
    }

    const key = `${lap.controller}:${lap.lapNumber}`
    if (seen.has(key)) {
      duplicates.add(key)
      incomplete = true
      continue
    }
    seen.set(key, { ...lap, crossingTime: new Date(lap.timestamp).getTime() })
  }

  const laps = [...seen.entries()].filter(([key]) => !duplicates.has(key)).map(([, lap]) => lap)
  const rows = new Map()
  const series = []

  for (const entry of participants) {
    const own = laps.filter((lap) => lap.controller === entry.controller).sort((a, b) => a.lapNumber - b.lapNumber)
    if (!own.length) continue

    const best = own.reduce((current, lap) => (lap.lapTime < current.lapTime ? lap : current))
    const key = `c${entry.controller}`
    series.push({
      key,
      controller: entry.controller,
      driverName: entry.driver?.name || `Ctrl ${entry.controller + 1}`,
      carName: [entry.car?.brand, entry.car?.model].filter(Boolean).join(' '),
      color: entry.driver?.color || '#3B82F6',
      bestLapNumber: best.lapNumber,
      bestLapTime: best.lapTime / 1000,
    })

    own.forEach((lap, index) => {
      if (lap.lapNumber !== index + 1 || !Number.isFinite(lap.crossingTime)) incomplete = true
      if (!rows.has(lap.lapNumber)) rows.set(lap.lapNumber, { lap: lap.lapNumber })
      rows.get(lap.lapNumber)[key] = lap.lapTime / 1000
    })
  }

  const lapNumbers = [...rows.keys()].sort((a, b) => a - b)
  const stride = Math.max(1, Math.ceil(lapNumbers.length / MAX_CHART_LAPS))
  const visibleLaps = new Set(lapNumbers.filter((_, index) => index % stride === 0))
  if (lapNumbers.length) visibleLaps.add(lapNumbers.at(-1))
  for (const item of series) visibleLaps.add(item.bestLapNumber)
  const chartData = [...visibleLaps].sort((a, b) => a - b).map((number) => rows.get(number))

  const crossings = [...laps].sort((a, b) => a.crossingTime - b.crossingTime)
  for (let i = 1; i < crossings.length; i++) {
    if (crossings[i].crossingTime === crossings[i - 1].crossingTime) incomplete = true
  }

  const leaders = []
  if (!incomplete && session.type === 'race') {
    let highestLap = 0
    let leader = null
    for (const lap of crossings) {
      if (lap.lapNumber <= highestLap) continue
      highestLap = lap.lapNumber
      if (lap.controller !== leader) {
        leaders.push({
          controller: lap.controller,
          lapNumber: lap.lapNumber,
          timestamp: lap.timestamp,
          type: leader === null ? 'first' : 'change',
        })
        leader = lap.controller
      }
    }
  }

  return { series, chartData, leaders, incomplete }
}

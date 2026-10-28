// Authoritative socket payloads only: never synthesize a race or a driver from UI state.
export function autoCueKey(type, data) {
  if (typeof data?.sessionId !== 'string' || !data.sessionId) return null

  if (type === 'bestlap') {
    if (!['race', 'qualif', 'practice'].includes(data.sessionType)) return null
    if (!Number.isInteger(data.controller) || data.controller < 0 || data.controller > 5) return null
    if (!Number.isInteger(data.totalLaps) || data.totalLaps < 1) return null
    if (!Number.isFinite(data.lapTime) || data.lapTime <= 0) return null
    return `bestlap:${data.sessionId}:${data.controller}:${data.totalLaps}:${data.lapTime}`
  }

  if (type === 'finished') {
    if (!['race', 'qualif', 'practice'].includes(data.sessionType) || !data.startedAt) return null
    return `finished:${data.sessionId}:${data.startedAt}`
  }

  return null
}

// Missing recorded fields suppress the speech cue rather than announcing a fictitious driver.
export function autoSpeechText(template, type, data, formatTime) {
  if (typeof template !== 'string' || template.length > 300) return null
  if (type !== 'bestlap') {
    return /\{(?:driver|car|controller|lapTime)\}/.test(template) ? null : template
  }
  const values = {
    driver: typeof data.driverName === 'string' ? data.driverName.trim() : '',
    car: [data.carBrand, data.carModel].filter((item) => typeof item === 'string' && item.trim()).join(' '),
    controller: Number.isInteger(data.controller) ? String(data.controller + 1) : '',
    lapTime: Number.isFinite(data.lapTime) && data.lapTime > 0 ? formatTime(data.lapTime) : '',
  }
  let missing = false
  const text = template.replace(/\{(driver|car|controller|lapTime)\}/g, (_, field) => {
    if (!values[field]) missing = true
    return values[field]
  })
  return missing ? null : text
}

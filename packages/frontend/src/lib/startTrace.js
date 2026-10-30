// One opt-in capture in the initiating tab; no buffers, timers or network writes.
let trace = null
let sequence = 0
const records = []

export function setStartTraceEnabled(enabled) {
  try {
    localStorage.setItem('racehubos-start-trace', enabled ? '1' : '0')
    if (!enabled) trace = null
    return true
  } catch {
    return false
  }
}

export function getStartTraceRecords() {
  return records.slice()
}

function isStartTraceEnabled() {
  try {
    const setting = localStorage.getItem('racehubos-start-trace')
    if (setting !== null) return setting === '1'
  } catch {}
  try {
    return sessionStorage.getItem('racehubos-start-trace') === '1'
  } catch {
    return false
  }
}

export function beginStartTrace(sessionId) {
  if (trace && performance.now() - trace.started <= 60_000) return
  trace = null
  if (!isStartTraceEnabled()) return
  trace = { id: ++sequence, sessionId, started: performance.now(), lastStart: null }
  traceStart('click', { startedAt: new Date().toISOString() })
}

export function traceStart(phase, details) {
  if (!trace) return
  const elapsed = performance.now() - trace.started
  if (elapsed > 60_000) {
    phase = 'expired'
    details = undefined
  }
  const record = {
    traceId: trace.id,
    sessionId: trace.sessionId,
    elapsedMs: Math.round(elapsed * 1000) / 1000,
    phase,
    ...details,
  }
  console.info('[BrowserStartTrace]', record)
  records.push(record)
  if (records.length > 1600) records.shift()
  if (['racing', 'failed', 'disconnected', 'expired'].includes(phase)) trace = null
}

export function traceStartStatus(start) {
  if (!trace) return
  if (trace.lastStart === start && performance.now() - trace.started <= 60_000) return
  trace.lastStart = start
  traceStart('status:received', { start })
}

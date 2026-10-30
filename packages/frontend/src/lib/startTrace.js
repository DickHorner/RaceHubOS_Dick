// One opt-in capture in the initiating tab; no buffers, timers or network writes.
let trace = null
let sequence = 0

export function beginStartTrace(sessionId) {
  if (trace && performance.now() - trace.started <= 60_000) return
  trace = null
  try {
    if (sessionStorage.getItem('racehubos-start-trace') !== '1') return
  } catch {
    return
  }
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
  console.info('[BrowserStartTrace]', {
    traceId: trace.id,
    sessionId: trace.sessionId,
    elapsedMs: Math.round(elapsed * 1000) / 1000,
    phase,
    ...details,
  })
  if (['racing', 'failed', 'disconnected', 'expired'].includes(phase)) trace = null
}

export function traceStartStatus(start) {
  if (!trace) return
  if (trace.lastStart === start && performance.now() - trace.started <= 60_000) return
  trace.lastStart = start
  traceStart('status:received', { start })
}

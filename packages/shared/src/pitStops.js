import { SessionStatus } from './sessionStatus.js';

export const REQUIRED_PIT_STOPS_MAX = 100;

export function validRequiredPitStops(count) {
  return Number.isInteger(count) && count >= 0 && count <= REQUIRED_PIT_STOPS_MAX;
}

// Only persisted, completed simulator cycles currently provide a verified stop.
// CU observations remain visible separately until their hardware semantics are verified.
export function requiredPitProgress(session, sessionDriverId) {
  const required = session.requiredPitStops ?? 0;
  const startedAt = session.startedAt ? new Date(session.startedAt).getTime() : NaN;
  if (session.status === SessionStatus.DRAFT || !Number.isFinite(startedAt)) {
    return { required, completed: 0, remaining: required };
  }
  const completed = new Set();
  for (const stop of session.pitStops || []) {
    if (
      !stop.id ||
      stop.sessionId !== session.id ||
      stop.sessionDriverId !== sessionDriverId ||
      stop.source !== 'simulator' ||
      !Number.isInteger(stop.durationMs) ||
      stop.durationMs <= 0 ||
      !stop.enteredAt ||
      !stop.exitedAt
    )
      continue;
    const entered = new Date(stop.enteredAt).getTime();
    const exited = new Date(stop.exitedAt).getTime();
    if (entered < startedAt) continue;
    if (Number.isFinite(entered) && Number.isFinite(exited) && exited - entered === stop.durationMs)
      completed.add(stop.id);
  }
  return { required, completed: completed.size, remaining: Math.max(0, required - completed.size) };
}

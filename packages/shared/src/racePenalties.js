/**
 * Derived race classification. Penalties never alter recorded laps or times.
 * A revoked penalty has no effect; the saved audit record remains visible.
 */
export const PenaltyKind = Object.freeze({ TIME: 'time', LAP: 'lap' });
export const PenaltyStatus = Object.freeze({ ACTIVE: 'active', REVOKED: 'revoked' });

export function withRacePenalties(driver, penalties = []) {
  let penaltyLaps = 0;
  let penaltyTimeMs = 0;

  for (const penalty of penalties) {
    if (penalty.status !== PenaltyStatus.ACTIVE || penalty.sessionDriverId !== driver.id) continue;
    if (penalty.kind === PenaltyKind.LAP) penaltyLaps += penalty.amount;
    if (penalty.kind === PenaltyKind.TIME) penaltyTimeMs += penalty.amount;
  }

  return {
    ...driver,
    penaltyLaps,
    penaltyTimeMs,
    classifiedLaps: Math.max(0, (driver.totalLaps || 0) - penaltyLaps),
    classifiedTime: (driver.totalTime || 0) + penaltyTimeMs,
    // Simulated tyre time (when enabled) is the same-lap tie-breaker; measured totalTime is unchanged.
    classifiedSimulatedTime: (driver.simulatedTotalTime ?? driver.totalTime ?? 0) + penaltyTimeMs,
  };
}

/** Finished drivers precede DNFs; ties are broken by controller for stable replay. */
export function compareRaceClassification(a, b) {
  if (Boolean(a.isDNF) !== Boolean(b.isDNF)) return a.isDNF ? 1 : -1;
  const lapsA = a.classifiedLaps ?? a.totalLaps ?? 0;
  const lapsB = b.classifiedLaps ?? b.totalLaps ?? 0;
  if (lapsA !== lapsB) return lapsB - lapsA;
  const timeA = a.classifiedSimulatedTime ?? a.classifiedTime ?? a.totalTime ?? 0;
  const timeB = b.classifiedSimulatedTime ?? b.classifiedTime ?? b.totalTime ?? 0;
  if (timeA !== timeB) return timeA - timeB;
  return (a.controller ?? 0) - (b.controller ?? 0);
}

export function rankRaceDrivers(drivers, penalties = []) {
  return drivers.map((driver) => withRacePenalties(driver, penalties)).sort(compareRaceClassification);
}

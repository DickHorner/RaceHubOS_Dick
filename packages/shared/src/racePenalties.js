/**
 * Derived race classification. Penalties never alter recorded laps or times.
 * A revoked penalty has no effect; the saved audit record remains visible.
 */
export function withRacePenalties(driver, penalties = []) {
  let penaltyLaps = 0;
  let penaltyTimeMs = 0;

  for (const penalty of penalties) {
    if (penalty.status !== 'active' || penalty.sessionDriverId !== driver.id) continue;
    if (penalty.kind === 'lap') penaltyLaps += penalty.amount;
    if (penalty.kind === 'time') penaltyTimeMs += penalty.amount;
  }

  return {
    ...driver,
    penaltyLaps,
    penaltyTimeMs,
    classifiedLaps: Math.max(0, (driver.totalLaps || 0) - penaltyLaps),
    classifiedTime: (driver.totalTime || 0) + penaltyTimeMs,
  };
}

/** Finished drivers precede DNFs; ties are broken by controller for stable replay. */
export function compareRaceClassification(a, b) {
  if (Boolean(a.isDNF) !== Boolean(b.isDNF)) return a.isDNF ? 1 : -1;
  const lapsA = a.classifiedLaps ?? a.totalLaps ?? 0;
  const lapsB = b.classifiedLaps ?? b.totalLaps ?? 0;
  if (lapsA !== lapsB) return lapsB - lapsA;
  const timeA = a.classifiedTime ?? a.totalTime ?? 0;
  const timeB = b.classifiedTime ?? b.totalTime ?? 0;
  if (timeA !== timeB) return timeA - timeB;
  return (a.controller ?? 0) - (b.controller ?? 0);
}

export function rankRaceDrivers(drivers, penalties = []) {
  return drivers.map((driver) => withRacePenalties(driver, penalties)).sort(compareRaceClassification);
}

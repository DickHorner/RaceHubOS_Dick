// Software-only virtual fuel. One percent equals 100 integer units.
export const VIRTUAL_FUEL_FULL = 10000;
export const VIRTUAL_FUEL_MAX_RATE = 100;

export function validVirtualFuelRate(rate) {
  return rate === null || (Number.isInteger(rate) && rate >= 1 && rate <= VIRTUAL_FUEL_MAX_RATE);
}

// %/minute -> basis points per completed lap; never read/write CU fuel values.
export function virtualFuelBurn(lapTimeMs, rate) {
  if (!Number.isFinite(lapTimeMs) || lapTimeMs <= 0 || !validVirtualFuelRate(rate) || rate === null) return 0;
  return Math.min(VIRTUAL_FUEL_FULL, Math.round(Math.round(lapTimeMs) * rate / 600));
}

export function virtualFuelAfter(units, event) {
  if (event.kind === 'refuel') return VIRTUAL_FUEL_FULL;
  if (event.kind === 'lap') return Math.max(0, units - event.units);
  return units;
}

export function replayVirtualFuel(events) {
  const levels = new Map();
  for (const event of events) {
    const previous = levels.get(event.sessionDriverId) ?? VIRTUAL_FUEL_FULL;
    levels.set(event.sessionDriverId, virtualFuelAfter(previous, event));
  }
  return levels;
}

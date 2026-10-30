// Software-only virtual fuel. One percent equals 100 integer units.
export const VIRTUAL_FUEL_FULL = 10000;
export const VIRTUAL_FUEL_MAX_RATE = 100;
export const VIRTUAL_FUEL_MAX_WEIGHT_PERCENT = 30;

export function validVirtualFuelRate(rate) {
  return rate === null || (Number.isInteger(rate) && rate >= 1 && rate <= VIRTUAL_FUEL_MAX_RATE);
}

// %/minute -> basis points per completed lap; never read/write CU fuel values.
export function virtualFuelBurn(lapTimeMs, rate) {
  if (!Number.isFinite(lapTimeMs) || lapTimeMs <= 0 || !validVirtualFuelRate(rate) || rate === null) return 0;
  return Math.min(VIRTUAL_FUEL_FULL, Math.round((Math.round(lapTimeMs) * rate) / 600));
}

export function virtualFuelAfter(units, event) {
  if (event.kind === 'refuel') return event.targetUnits ?? VIRTUAL_FUEL_FULL;
  if (event.kind === 'lap') return Math.max(0, units - event.units);
  return units;
}

export function replayVirtualFuel(events = [], drivers = []) {
  const levels = new Map(drivers.map((driver) => [driver.id, driver.initialFuelUnits ?? VIRTUAL_FUEL_FULL]));
  for (const event of events) {
    const previous = levels.get(event.sessionDriverId) ?? VIRTUAL_FUEL_FULL;
    levels.set(event.sessionDriverId, virtualFuelAfter(previous, event));
  }
  return levels;
}

// Events must be in persisted id order, as returned by the session endpoint.
// Key by recorded lap reference, never by controller or displayed lap order.
export function virtualFuelLapHistory(events = [], drivers = []) {
  const assignments = new Map(drivers.map((driver) => [driver.id, driver]));
  const levels = replayVirtualFuel([], drivers);
  const history = new Map();
  for (const event of events) {
    const driver = assignments.get(event.sessionDriverId);
    if (!driver) continue;
    const current = levels.get(driver.id);
    const beforeUnits = validVirtualFuelUnits(current) ? current : null;
    let afterUnits = null;
    switch (event.kind) {
      case 'lap':
        if (beforeUnits !== null && validVirtualFuelUnits(event.units))
          afterUnits = virtualFuelAfter(beforeUnits, event);
        if (typeof event.reference === 'string' && event.reference.startsWith('lap:')) {
          history.set(event.reference.slice(4), {
            sessionDriverId: driver.id,
            driverId: driver.driverId,
            carId: driver.carId,
            controller: event.controller,
            beforeUnits,
            afterUnits,
          });
        }
        break;
      case 'refuel':
        if (validVirtualFuelUnits(event.targetUnits ?? VIRTUAL_FUEL_FULL))
          afterUnits = virtualFuelAfter(beforeUnits, event);
        break;
    }
    levels.set(driver.id, afterUnits);
  }
  return history;
}

// Use the median of the last five recorded lap burns; at least three are needed.
// Pit refills are excluded. The estimate is in the same integer units as the event log.
export function virtualFuelPerLap(events = []) {
  const burns = events
    .filter(
      (event) =>
        event.kind === 'lap' && Number.isInteger(event.units) && event.units >= 0 && event.units <= VIRTUAL_FUEL_FULL
    )
    .slice(-5)
    .map((event) => event.units)
    .sort((a, b) => a - b);
  if (burns.length < 3) return null;
  const middle = Math.floor(burns.length / 2);
  const median = burns.length % 2 ? burns[middle] : (burns[middle - 1] + burns[middle]) / 2;
  return median > 0 ? Math.ceil(median) : null;
}

export function validVirtualFuelLaps(laps) {
  return Number.isInteger(laps) && laps >= 1 && laps <= VIRTUAL_FUEL_FULL;
}

export function virtualFuelTarget(laps, unitsPerLap) {
  if (!validVirtualFuelLaps(laps) || !Number.isInteger(unitsPerLap) || unitsPerLap <= 0) return null;
  const target = laps * unitsPerLap;
  return target <= VIRTUAL_FUEL_FULL ? target : null;
}

export function validVirtualFuelUnits(units) {
  return Number.isInteger(units) && units >= 0 && units <= VIRTUAL_FUEL_FULL;
}

export function validVirtualFuelWeightPercent(percent) {
  return Number.isInteger(percent) && percent >= 0 && percent <= VIRTUAL_FUEL_MAX_WEIGHT_PERCENT;
}

// Preview only: apply a linear fuel-weight factor to a measured or saved tyre-adjusted time.
export function virtualFuelWeightedLapTime(lapTime, units, percent) {
  if (!Number.isFinite(lapTime) || lapTime <= 0 || !validVirtualFuelWeightPercent(percent)) return null;
  if (percent === 0) return Math.round(lapTime);
  if (!validVirtualFuelUnits(units)) return null;
  return Math.round(lapTime * (1 + (percent * units) / (100 * VIRTUAL_FUEL_FULL)));
}

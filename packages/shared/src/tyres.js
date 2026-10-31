import { WeatherCondition } from './weather.js';

export const TyreType = Object.freeze({ DRY: 'dry', WET: 'wet' });

export function validTyreType(type) {
  return type === TyreType.DRY || type === TyreType.WET;
}

export function validTyreMismatchPercent(percent) {
  return Number.isInteger(percent) && percent >= 0 && percent <= 30;
}

export function tyreTimeFactor(tyreType, weather, mismatchPercent) {
  if (!weather || mismatchPercent === 0) return 1;
  const mismatch =
    (weather === WeatherCondition.RAIN && tyreType === TyreType.DRY) ||
    (weather === WeatherCondition.DRY && tyreType === TyreType.WET);
  return mismatch ? (100 + mismatchPercent) / 100 : 1;
}

/**
 * Virtual pace effect only. The recorded lap time and CU speed are unchanged.
 * Zero means the feature is disabled; a matching tyre carries no time penalty.
 */
export function tyreAdjustedLapTime(lapTime, tyreType, weather, mismatchPercent) {
  if (!Number.isFinite(lapTime) || lapTime <= 0) return null;
  const raw = Math.round(lapTime);
  if (!weather || mismatchPercent === 0) return raw;
  const mismatch =
    (weather === WeatherCondition.RAIN && tyreType === TyreType.DRY) ||
    (weather === WeatherCondition.DRY && tyreType === TyreType.WET);
  return mismatch ? Math.round((raw * (100 + mismatchPercent)) / 100) : raw;
}

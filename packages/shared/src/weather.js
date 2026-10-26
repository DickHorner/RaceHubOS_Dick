/** Software-only weather. The persisted seed and race clock are the source of truth. */
export const WeatherCondition = Object.freeze({ DRY: 'dry', RAIN: 'rain' });

export function validWeatherConfig({ weatherSeed, weatherInitial, weatherRainChance, weatherIntervalSeconds, weatherAdvanceDuringPause }) {
  return (
    (weatherSeed === null || (Number.isInteger(weatherSeed) && weatherSeed >= 0 && weatherSeed <= 2147483647)) &&
    Object.values(WeatherCondition).includes(weatherInitial) &&
    Number.isInteger(weatherRainChance) && weatherRainChance >= 0 && weatherRainChance <= 100 &&
    Number.isInteger(weatherIntervalSeconds) && weatherIntervalSeconds >= 10 && weatherIntervalSeconds <= 3600 &&
    typeof weatherAdvanceDuringPause === 'boolean'
  );
}

/** Each elapsed interval draws a reproducible rain sample; work is O(1), even after long races. */
export function weatherAtElapsed(config, elapsedMs) {
  if (config.weatherSeed == null) return null;
  const interval = config.weatherIntervalSeconds * 1000;
  const slot = Math.floor(Math.max(0, elapsedMs) / interval);
  if (slot === 0) return config.weatherInitial;

  let hash = (config.weatherSeed ^ Math.imul(slot, 0x9e3779b1)) >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d) >>> 0;
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b) >>> 0;
  hash ^= hash >>> 16;
  return (hash / 4294967296) * 100 < config.weatherRainChance
    ? WeatherCondition.RAIN
    : WeatherCondition.DRY;
}

/** Replay from persisted GO time; only subtract pauses when the race config requests it. */
export function weatherForSession(session, nowMs) {
  if (session.weatherSeed == null) return null;
  if (!session.startedAt) return session.weatherInitial;

  const end = session.finishedAt ? new Date(session.finishedAt).getTime() : nowMs;
  const startedAt = new Date(session.startedAt).getTime();
  let pausedMs = 0;
  if (!session.weatherAdvanceDuringPause) {
    const pauses = typeof session.pauses === 'string' ? JSON.parse(session.pauses) : session.pauses || [];
    for (const pause of pauses) {
      const from = Math.max(startedAt, pause.start);
      const to = Math.min(end, pause.end ?? end);
      if (to > from) pausedMs += to - from;
    }
  }
  return weatherAtElapsed(session, Math.max(0, end - startedAt - pausedMs));
}

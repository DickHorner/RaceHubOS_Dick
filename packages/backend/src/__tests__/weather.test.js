import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from './setup.js';
import { SessionService } from '../services/SessionService.js';
import sessionsRouter, { setSessionService } from '../routes/sessions.js';
import { WeatherCondition, validWeatherConfig, weatherAtElapsed, weatherForSession } from '@racehubos/shared';

const config = {
  weatherSeed: 17,
  weatherInitial: WeatherCondition.DRY,
  weatherRainChance: 100,
  weatherIntervalSeconds: 10,
  weatherAdvanceDuringPause: false,
};
const start = Date.parse('2026-10-26T10:00:00.000Z');

describe('deterministic race weather', () => {
  test('the first interval keeps initial conditions; every later 100% rain interval rains', () => {
    expect(weatherAtElapsed(config, 0)).toBe(WeatherCondition.DRY);
    expect(weatherAtElapsed(config, 9999)).toBe(WeatherCondition.DRY);
    expect(weatherAtElapsed(config, 10000)).toBe(WeatherCondition.RAIN);
    expect(weatherAtElapsed(config, 1000000)).toBe(WeatherCondition.RAIN);
  });

  test('0% chance always dries after the initial interval, independent of seed', () => {
    const rainyStart = { ...config, weatherInitial: WeatherCondition.RAIN, weatherRainChance: 0 };
    expect(weatherAtElapsed(rainyStart, 0)).toBe(WeatherCondition.RAIN);
    expect(weatherAtElapsed(rainyStart, 10000)).toBe(WeatherCondition.DRY);
    expect(weatherAtElapsed({ ...rainyStart, weatherSeed: 321 }, 10000)).toBe(WeatherCondition.DRY);
  });

  test('same seed, elapsed time and config always yield the same sequence', () => {
    const randomWeather = { ...config, weatherRainChance: 45 };
    const one = Array.from({ length: 120 }, (_, n) => weatherAtElapsed(randomWeather, n * 10000));
    const two = Array.from({ length: 120 }, (_, n) => weatherAtElapsed(randomWeather, n * 10000));
    expect(two).toEqual(one);
    expect(one).toContain(WeatherCondition.DRY);
    expect(one).toContain(WeatherCondition.RAIN);
  });

  test('disabled weather is null for old sessions and does not require a running clock', () => {
    expect(weatherForSession({ ...config, weatherSeed: null }, start + 500000)).toBeNull();
    expect(weatherForSession({ ...config, startedAt: null }, start + 500000)).toBe(WeatherCondition.DRY);
  });

  test('pause policy chooses independent weather time or frozen race time', () => {
    const openPause = { start: start + 4000, end: null };
    const frozen = { ...config, startedAt: new Date(start), pauses: [openPause] };
    expect(weatherForSession(frozen, start + 20000)).toBe(WeatherCondition.DRY);
    expect(weatherForSession({ ...frozen, weatherAdvanceDuringPause: true }, start + 20000)).toBe(
      WeatherCondition.RAIN
    );

    const finished = {
      ...frozen,
      pauses: JSON.stringify([{ start: start + 4000, end: start + 24000 }]),
      finishedAt: new Date(start + 28000),
    };
    expect(weatherForSession(finished, start + 999999)).toBe(WeatherCondition.DRY);
    expect(weatherForSession({ ...finished, weatherAdvanceDuringPause: true }, start + 999999)).toBe(
      WeatherCondition.RAIN
    );
  });

  test('weather validation rejects non-integral or out-of-range configuration', () => {
    expect(validWeatherConfig(config)).toBe(true);
    expect(validWeatherConfig({ ...config, weatherRainChance: -1 })).toBe(false);
    expect(validWeatherConfig({ ...config, weatherRainChance: 101 })).toBe(false);
    expect(validWeatherConfig({ ...config, weatherSeed: 0.1 })).toBe(false);
    expect(validWeatherConfig({ ...config, weatherIntervalSeconds: 9 })).toBe(false);
    expect(validWeatherConfig({ ...config, weatherAdvanceDuringPause: 'yes' })).toBe(false);
  });
});

describe('persisted session weather and heartbeat', () => {
  let service;

  async function makeTrack() {
    return prisma.track.create({ data: { name: 'Weather test track' } });
  }

  beforeEach(async () => {
    await prisma.trackRecord.deleteMany();
    await prisma.controllerConfig.deleteMany();
    await prisma.lap.deleteMany();
    await prisma.sessionDriver.deleteMany();
    await prisma.session.deleteMany();
    await prisma.track.deleteMany();
    service = new SessionService({ emit: jest.fn() });
  });

  afterEach(async () => {
    service.stopHeartbeat();
    jest.useRealTimers();
    await service.prisma.$disconnect();
  });

  test('creating a race stores weather and reload reconstructs the condition', async () => {
    const track = await makeTrack();
    const created = await service.createSession({ type: 'race', trackId: track.id, ...config });
    expect(created).toMatchObject(config);
    await prisma.session.update({
      where: { id: created.id },
      data: {
        status: 'active',
        startedAt: new Date(start),
        pauses: JSON.stringify([{ start: start + 4000, end: null }]),
      },
    });

    await service.loadSession(created.id);
    expect(service.sessionConfig.weatherAdvanceDuringPause).toBe(false);
    expect(service.getState().weatherCondition).toBe(WeatherCondition.DRY);

    const app = express();
    app.use(express.json());
    setSessionService(service);
    app.use('/api/sessions', sessionsRouter);
    const response = await request(app).get(`/api/sessions/${created.id}`).expect(200);
    expect(response.body.data).toMatchObject({ weatherSeed: 17, weatherCondition: WeatherCondition.DRY });
  });

  test('draft changes validate; weather configuration is immutable after start', async () => {
    const track = await makeTrack();
    const created = await service.createSession({ type: 'race', trackId: track.id });
    const app = express();
    app.use(express.json());
    setSessionService(service);
    app.use('/api/sessions', sessionsRouter);

    await request(app)
      .put(`/api/sessions/${created.id}`)
      .send({ weatherSeed: 9, weatherRainChance: 70, weatherAdvanceDuringPause: true })
      .expect(200);
    await request(app).put(`/api/sessions/${created.id}`).send({ weatherRainChance: 101 }).expect(400);
    await request(app).put(`/api/sessions/${created.id}`).send({ weatherAdvanceDuringPause: 'yes' }).expect(400);

    await prisma.session.update({ where: { id: created.id }, data: { status: 'active' } });
    await request(app).put(`/api/sessions/${created.id}`).send({ weatherRainChance: 50 }).expect(409);
    const unchanged = await prisma.session.findUnique({ where: { id: created.id } });
    expect(unchanged).toMatchObject({ weatherSeed: 9, weatherRainChance: 70, weatherAdvanceDuringPause: true });
  });

  test('races without weather remain dry and enabled non-race sessions are rejected', async () => {
    const track = await makeTrack();
    const oldRace = await service.createSession({ type: 'race', trackId: track.id });
    await service.loadSession(oldRace.id);
    expect(service.getState().weatherCondition).toBeNull();
    await expect(service.createSession({ type: 'practice', trackId: track.id, ...config })).rejects.toThrow(
      'only supported'
    );
  });

  test('heartbeat freezes rain when paused unless the configured weather clock continues', async () => {
    const track = await makeTrack();
    const created = await service.createSession({ type: 'race', trackId: track.id, ...config });
    await prisma.session.update({
      where: { id: created.id },
      data: { status: 'paused', startedAt: new Date(start), pauses: JSON.stringify([{ start, end: null }]) },
    });
    await service.loadSession(created.id);
    // Prisma uses real event-loop timers: fake only the race heartbeat after DB setup.
    jest.useFakeTimers({ now: start });
    service.startHeartbeat();

    await jest.advanceTimersByTimeAsync(11000);
    const heartbeats = service.io.emit.mock.calls.filter(([event]) => event === 'session:heartbeat');
    expect(heartbeats.at(-1)[1].weatherCondition).toBe(WeatherCondition.DRY);
    expect(service.io.emit.mock.calls.filter(([event]) => event === 'session:weather_changed')).toHaveLength(0);

    service.stopHeartbeat();
    service.sessionConfig.weatherAdvanceDuringPause = true;
    service.startHeartbeat();
    await jest.advanceTimersByTimeAsync(1000);
    const transitions = service.io.emit.mock.calls.filter(([event]) => event === 'session:weather_changed');
    expect(transitions).toHaveLength(1);
    expect(transitions[0][1]).toMatchObject({ sessionId: created.id, weatherCondition: WeatherCondition.RAIN });
  });

  test('weather reset reuses the same settings and restarts at the initial condition', async () => {
    const track = await makeTrack();
    const created = await service.createSession({ type: 'race', trackId: track.id, ...config });
    await prisma.session.update({
      where: { id: created.id },
      data: { status: 'active', startedAt: new Date(start) },
    });
    await service.loadSession(created.id);
    await service.resetSession(created.id);
    const reset = await prisma.session.findUnique({ where: { id: created.id } });
    expect(reset).toMatchObject({ status: 'draft', weatherSeed: 17, weatherInitial: WeatherCondition.DRY });
    expect(weatherForSession(reset, start + 500000)).toBe(WeatherCondition.DRY);
  });
});

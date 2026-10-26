import { jest } from '@jest/globals';
import { prisma } from './setup.js';
import { SessionService } from '../services/SessionService.js';
import {
  SessionStatus,
  SessionType,
  TyreType,
  WeatherCondition,
  validTyreMismatchPercent,
  tyreAdjustedLapTime,
} from '@racehubos/shared';

describe('virtual dry/wet timing', () => {
  test('dry tyres in rain incur the configured time penalty', () => {
    expect(tyreAdjustedLapTime(10000, TyreType.DRY, WeatherCondition.RAIN, 10)).toBe(11000);
    expect(tyreAdjustedLapTime(10000, TyreType.WET, WeatherCondition.RAIN, 10)).toBe(10000);
  });

  test('wet tyres on a dry track are penalized, dry tyres are not', () => {
    expect(tyreAdjustedLapTime(10000, TyreType.WET, WeatherCondition.DRY, 5)).toBe(10500);
    expect(tyreAdjustedLapTime(10000, TyreType.DRY, WeatherCondition.DRY, 5)).toBe(10000);
  });

  test('disabled weather or zero factor never changes the measured lap', () => {
    expect(tyreAdjustedLapTime(10000, TyreType.DRY, WeatherCondition.RAIN, 0)).toBe(10000);
    expect(tyreAdjustedLapTime(10000, TyreType.DRY, null, 10)).toBe(10000);
    expect(tyreAdjustedLapTime(0, TyreType.DRY, WeatherCondition.RAIN, 10)).toBeNull();
    expect(validTyreMismatchPercent(0)).toBe(true);
    expect(validTyreMismatchPercent(30)).toBe(true);
    expect(validTyreMismatchPercent(-1)).toBe(false);
    expect(validTyreMismatchPercent(31)).toBe(false);
    expect(validTyreMismatchPercent(2.5)).toBe(false);
  });
});

describe('session tyre requests and pit changes', () => {
  let service;

  async function fixture() {
    const track = await prisma.track.create({ data: { name: 'Tyre test track' } });
    const car = await prisma.car.create({ data: { brand: 'Carrera', model: 'Tyre test car' } });
    const driver = await prisma.driver.create({ data: { name: 'Tyre test pilot' } });
    const session = await prisma.session.create({
      data: {
        type: SessionType.RACE,
        status: SessionStatus.ACTIVE,
        trackId: track.id,
        startedAt: new Date(Date.now() - 5000),
        weatherSeed: 19,
        weatherInitial: WeatherCondition.RAIN,
        weatherRainChance: 100,
        weatherIntervalSeconds: 60,
        tyreMismatchPercent: 10,
      },
    });
    const assigned = await prisma.sessionDriver.create({
      data: { sessionId: session.id, driverId: driver.id, carId: car.id, controller: 0 },
    });
    await service.loadSession(session.id);
    return { track, car, driver, session, assigned };
  }

  async function pit(source = 'simulator') {
    const enteredAt = new Date(Date.now() - 3000);
    const exitedAt = new Date(Date.now() - 1000);
    return service.recordPitStop({ controller: 0, enteredAt, exitedAt, source });
  }

  async function lap(time = 10000) {
    return service.handleLap({ controller: 0, timestamp: 1000, lapTime: time, sector: 1 });
  }

  beforeEach(async () => {
    await prisma.tyreChange.deleteMany();
    await prisma.pitStop.deleteMany();
    await prisma.trackRecord.deleteMany();
    await prisma.controllerConfig.deleteMany();
    await prisma.lap.deleteMany();
    await prisma.sessionDriver.deleteMany();
    await prisma.session.deleteMany();
    await prisma.driver.deleteMany();
    await prisma.car.deleteMany();
    await prisma.track.deleteMany();
    service = new SessionService({ emit: jest.fn() });
  });

  afterEach(async () => {
    service.stopHeartbeat();
    await service.prisma.$disconnect();
  });

  test('simulated timing is persisted beside raw lapTime and survives reload', async () => {
    const { session, assigned } = await fixture();
    await lap();

    const saved = await prisma.lap.findFirst({ where: { sessionId: session.id } });
    expect(saved).toMatchObject({
      lapTime: 10000,
      simulatedLapTime: 11000,
      tyreAtLap: TyreType.DRY,
      weatherAtLap: WeatherCondition.RAIN,
    });
    const row = await prisma.sessionDriver.findUnique({ where: { id: assigned.id } });
    expect(row).toMatchObject({ totalTime: 10000, simulatedTotalTime: 11000, bestLapTime: 10000 });

    const replay = new SessionService({ emit: jest.fn() });
    try {
      await replay.loadSession(session.id);
      expect(replay.getLeaderboard()[0]).toMatchObject({
        tyreType: TyreType.DRY, simulatedTotalTime: 11000, totalTime: 10000,
      });
    } finally {
      replay.stopHeartbeat();
      await replay.prisma.$disconnect();
    }
  });

  test('a driver request does not change tyres until a confirmed simulator pit exit', async () => {
    const { session, assigned } = await fixture();
    await lap();
    const planned = await service.requestTyreChange(session.id, assigned.id, TyreType.WET);
    expect(planned).toMatchObject({ tyreType: TyreType.DRY, pendingTyreType: TyreType.WET });
    expect(await prisma.tyreChange.count()).toBe(0);

    await pit('simulator');
    expect(service.getLeaderboard()[0]).toMatchObject({ tyreType: TyreType.WET, pendingTyreType: null });
    const savedChanges = await prisma.tyreChange.findMany();
    expect(savedChanges).toHaveLength(1);
    expect(savedChanges[0]).toMatchObject({
      fromType: TyreType.DRY, toType: TyreType.WET, source: 'simulator',
      sessionDriverId: assigned.id,
    });
    expect(savedChanges[0].pitStopId).toBeTruthy();

    await pit('simulator');
    expect(await prisma.tyreChange.count()).toBe(1);
    await lap();
    const laps = await prisma.lap.findMany({ where: { sessionId: session.id }, orderBy: { timestamp: 'asc' } });
    expect(laps.map((row) => [row.lapTime, row.simulatedLapTime, row.tyreAtLap]))
      .toEqual([[10000, 11000, TyreType.DRY], [10000, 10000, TyreType.WET]]);
    expect((await prisma.sessionDriver.findUnique({ where: { id: assigned.id } })).simulatedTotalTime).toBe(21000);
  });

  test('unverified CU pit observations leave the request pending for manual confirmation', async () => {
    const { session, assigned } = await fixture();
    await service.requestTyreChange(session.id, assigned.id, TyreType.WET);
    await pit('cu');
    expect(await prisma.pitStop.count()).toBe(1);
    expect(await prisma.tyreChange.count()).toBe(0);
    expect(service.getLeaderboard()[0]).toMatchObject({ tyreType: TyreType.DRY, pendingTyreType: TyreType.WET });

    const change = await service.confirmTyreChange(session.id, assigned.id);
    expect(change).toMatchObject({ fromType: TyreType.DRY, toType: TyreType.WET, source: 'director' });
    expect(service.getLeaderboard()[0].tyreType).toBe(TyreType.WET);
    await expect(service.confirmTyreChange(session.id, assigned.id)).rejects.toMatchObject({ status: 409 });
    expect(await prisma.tyreChange.count()).toBe(1);
  });

  test('a failed transaction cannot report a tyre change or partial pit event', async () => {
    const { session, assigned } = await fixture();
    await service.requestTyreChange(session.id, assigned.id, TyreType.WET);
    const create = service.prisma.tyreChange.create;
    const spy = jest.spyOn(service.prisma.tyreChange, 'create').mockRejectedValueOnce(new Error('DB failure'));
    try {
      await expect(pit('simulator')).rejects.toThrow('DB failure');
      expect(await prisma.tyreChange.count()).toBe(0);
      expect(await prisma.pitStop.count()).toBe(0);
      expect(service.getLeaderboard()[0]).toMatchObject({ tyreType: TyreType.DRY, pendingTyreType: TyreType.WET });
    } finally {
      spy.mockRestore();
    }
    expect(create).toBeTruthy();
  });

  test('invalid, stale or inactive requests cannot change the selected tyres', async () => {
    const { session, assigned } = await fixture();
    await expect(service.requestTyreChange(session.id, assigned.id, 'slick')).rejects.toMatchObject({ status: 400 });
    await expect(service.requestTyreChange('other-session', assigned.id, TyreType.WET))
      .rejects.toMatchObject({ status: 409 });
    await expect(service.requestTyreChange(session.id, 'other-driver', TyreType.WET))
      .rejects.toMatchObject({ status: 409 });
    service.sessionStatus = SessionStatus.FINISHED;
    await expect(service.requestTyreChange(session.id, assigned.id, TyreType.WET))
      .rejects.toMatchObject({ status: 409 });
    expect(await prisma.tyreChange.count()).toBe(0);
    expect((await prisma.sessionDriver.findUnique({ where: { id: assigned.id } })).tyreType).toBe(TyreType.DRY);
  });

  test('queuing repeated pit requests applies a change only once', async () => {
    const { session, assigned } = await fixture();
    await service.requestTyreChange(session.id, assigned.id, TyreType.WET);
    await Promise.all([pit(), pit()]);
    expect(await prisma.tyreChange.count({ where: { sessionDriverId: assigned.id } })).toBe(1);
    expect((await prisma.sessionDriver.findUnique({ where: { id: assigned.id } })).pendingTyreType).toBeNull();
  });

  test('a reset removes simulated tyre history and restores the initial dry set', async () => {
    const { session, assigned } = await fixture();
    await service.requestTyreChange(session.id, assigned.id, TyreType.WET);
    await pit();
    await lap();
    await service.resetSession(session.id);
    expect(await prisma.tyreChange.count()).toBe(0);
    const row = await prisma.sessionDriver.findUnique({ where: { id: assigned.id } });
    expect(row).toMatchObject({
      tyreType: TyreType.DRY, pendingTyreType: null,
      simulatedTotalTime: null, simulatedBestLapTime: null,
    });
    const active = await prisma.lap.count({ where: { sessionId: session.id, deletedAt: null } });
    expect(active).toBe(0);
  });

  test('actual CU speed and brake functions are not called by tyre changes', async () => {
    const { session, assigned } = await fixture();
    const setSpeed = jest.fn();
    const setBrake = jest.fn();
    service.syncService = { getDevice: () => ({ setSpeed, setBrake }) };
    await service.requestTyreChange(session.id, assigned.id, TyreType.WET);
    await pit('cu');
    await service.confirmTyreChange(session.id, assigned.id);
    expect(setSpeed).not.toHaveBeenCalled();
    expect(setBrake).not.toHaveBeenCalled();
  });
});

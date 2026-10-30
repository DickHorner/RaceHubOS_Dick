import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from './setup.js';
import { SessionService } from '../services/SessionService.js';
import { SyncService } from '../services/SyncService.js';
import { CarreraSimulator } from '../services/simulator.js';
import sessionsRouter, { setSessionService } from '../routes/sessions.js';
import raceControl, { setRaceControlServices } from '../routes/raceControl.js';
import {
  VIRTUAL_FUEL_FULL,
  validVirtualFuelRate,
  virtualFuelBurn,
  replayVirtualFuel,
  virtualFuelLapHistory,
  virtualFuelPerLap,
  virtualFuelTarget,
  validVirtualFuelUnits,
  validVirtualFuelWeightPercent,
  virtualFuelWeightedLapTime,
  tyreAdjustedLapTime,
  TyreType,
  WeatherCondition,
} from '@racehubos/shared';

describe('virtual fuel arithmetic', () => {
  test('optional fuel weight scales linearly with the reconstructed tank and is identity when disabled', () => {
    expect(virtualFuelWeightedLapTime(10000, 10000, 10)).toBe(11000);
    expect(virtualFuelWeightedLapTime(10000, 5000, 10)).toBe(10500);
    expect(virtualFuelWeightedLapTime(10000, 0, 10)).toBe(10000);
    expect(virtualFuelWeightedLapTime(10000, null, 0)).toBe(10000);
    expect(virtualFuelWeightedLapTime(10000, 10000, 30)).toBe(13000);
    expect(virtualFuelWeightedLapTime(10000.49, 10000, 5)).toBe(10501);
  });

  test('fuel weight preview rejects invalid model inputs instead of producing an invented time', () => {
    for (const percent of [-1, 31, 1.5, '10', null, NaN, Infinity]) {
      expect(validVirtualFuelWeightPercent(percent)).toBe(false);
      expect(virtualFuelWeightedLapTime(10000, 5000, percent)).toBeNull();
    }
    for (const units of [null, undefined, -1, 10001, 1.5, '5000', NaN, Infinity])
      expect(virtualFuelWeightedLapTime(10000, units, 10)).toBeNull();
    for (const time of [null, undefined, 0, -1, '10000', NaN, Infinity])
      expect(virtualFuelWeightedLapTime(time, 5000, 10)).toBeNull();
    for (const percent of [0, 5, 30]) expect(validVirtualFuelWeightPercent(percent)).toBe(true);
  });

  test('weight composes multiplicatively with saved tyre timing rather than adding percentage points', () => {
    const raw = 10000;
    const wetRace = tyreAdjustedLapTime(raw, TyreType.DRY, WeatherCondition.RAIN, 10);
    expect(wetRace).toBe(11000);
    expect(virtualFuelWeightedLapTime(wetRace, 10000, 10)).toBe(12100);
    expect(virtualFuelWeightedLapTime(wetRace, 5000, 10)).toBe(11550);
    expect(virtualFuelWeightedLapTime(wetRace, 0, 10)).toBe(wetRace);
    expect(raw).toBe(10000);
  });

  test('a 10-second lap at 6% per minute burns 1% of the virtual tank', () => {
    expect(virtualFuelBurn(10000, 6)).toBe(100);
    expect(virtualFuelBurn(20000, 6)).toBe(200);
    expect(virtualFuelBurn(60000, 100)).toBe(VIRTUAL_FUEL_FULL);
    expect(virtualFuelBurn(120000, 100)).toBe(VIRTUAL_FUEL_FULL);
  });

  test('invalid laps and disabled mode never burn fuel', () => {
    expect(virtualFuelBurn(0, 6)).toBe(0);
    expect(virtualFuelBurn(-300, 6)).toBe(0);
    expect(virtualFuelBurn(Number.NaN, 6)).toBe(0);
    expect(virtualFuelBurn(Number.POSITIVE_INFINITY, 6)).toBe(0);
    expect(virtualFuelBurn(10000, null)).toBe(0);
    expect(validVirtualFuelRate(null)).toBe(true);
    expect(validVirtualFuelRate(0)).toBe(false);
    expect(validVirtualFuelRate(100.5)).toBe(false);
    expect(validVirtualFuelRate(101)).toBe(false);
  });

  test('range uses recent measured burns and resists isolated slow-lap outliers', () => {
    const events = [100, 110, 8000, 90, 100].map((units) => ({ kind: 'lap', units }));
    expect(virtualFuelPerLap(events)).toBe(100);
    expect(virtualFuelPerLap(events.slice(0, 2))).toBeNull();
    expect(virtualFuelPerLap([{ kind: 'refuel', units: 0 }, ...events])).toBe(100);
    expect(virtualFuelPerLap(Array.from({ length: 5 }, () => ({ kind: 'lap', units: 0 })))).toBeNull();
    expect(virtualFuelPerLap([...events, ...[200, 210, 220, 230, 240].map((units) => ({ kind: 'lap', units }))])).toBe(
      220
    );
    expect(virtualFuelTarget(25, 100)).toBe(2500);
    expect(virtualFuelTarget(100, 100)).toBe(VIRTUAL_FUEL_FULL);
    for (const laps of [101, 0, -1, 1.5, '25', Infinity]) expect(virtualFuelTarget(laps, 100)).toBeNull();
    expect(virtualFuelTarget(25, null)).toBeNull();
  });

  test('partial target refills replay while legacy refills remain full', () => {
    expect(
      replayVirtualFuel([
        { sessionDriverId: 'a', kind: 'refuel', units: 0, targetUnits: 2500 },
        { sessionDriverId: 'a', kind: 'lap', units: 100 },
      ]).get('a')
    ).toBe(2400);
    expect(replayVirtualFuel([{ sessionDriverId: 'a', kind: 'refuel', units: 0, targetUnits: null }]).get('a')).toBe(
      VIRTUAL_FUEL_FULL
    );
  });

  test('replay starts from each saved tank, including empty, while legacy drivers start full', () => {
    const drivers = [{ id: 'a', initialFuelUnits: 2500 }, { id: 'b', initialFuelUnits: 0 }, { id: 'c' }];
    const levels = replayVirtualFuel([{ sessionDriverId: 'a', kind: 'lap', units: 100 }], drivers);
    expect([...levels]).toEqual([
      ['a', 2400],
      ['b', 0],
      ['c', 10000],
    ]);
    expect(replayVirtualFuel([{ sessionDriverId: 'a', kind: 'refuel', units: 0 }], drivers).get('a')).toBe(10000);
    for (const units of [0, 2500, 10000]) expect(validVirtualFuelUnits(units)).toBe(true);
    for (const units of [null, -1, 10001, 1.5, '2500', Infinity]) expect(validVirtualFuelUnits(units)).toBe(false);
  });

  test('lap fuel history follows event order, isolates assignments sharing a controller and includes partial refills', () => {
    const drivers = [
      { id: 'a', driverId: 'driver-a', carId: 'car-a', initialFuelUnits: 2500 },
      { id: 'b', driverId: 'driver-b', carId: 'car-b', initialFuelUnits: 0 },
    ];
    const events = [
      { sessionDriverId: 'a', controller: 0, kind: 'lap', units: 100, reference: 'lap:a-1' },
      { sessionDriverId: 'b', controller: 0, kind: 'lap', units: 100, reference: 'lap:b-1' },
      { sessionDriverId: 'a', controller: 0, kind: 'refuel', targetUnits: 5000, reference: 'pit:one' },
      { sessionDriverId: 'a', controller: 0, kind: 'lap', units: 200, reference: 'lap:a-2' },
      { sessionDriverId: 'b', controller: 0, kind: 'refuel', targetUnits: 3000, reference: 'pit:two' },
      { sessionDriverId: 'b', controller: 0, kind: 'lap', units: 400, reference: 'lap:b-2' },
    ];
    const before = JSON.stringify({ drivers, events });
    const history = virtualFuelLapHistory(events, drivers);
    expect(history.get('a-1')).toEqual({
      sessionDriverId: 'a',
      driverId: 'driver-a',
      carId: 'car-a',
      controller: 0,
      beforeUnits: 2500,
      afterUnits: 2400,
    });
    expect(history.get('b-1')).toMatchObject({ beforeUnits: 0, afterUnits: 0 });
    expect(history.get('a-2')).toMatchObject({ beforeUnits: 5000, afterUnits: 4800 });
    expect(history.get('b-2')).toMatchObject({ beforeUnits: 3000, afterUnits: 2600 });
    const levels = replayVirtualFuel(events, drivers);
    expect(history.get('a-2').afterUnits).toBe(levels.get('a'));
    expect(history.get('b-2').afterUnits).toBe(levels.get('b'));
    expect(history.size).toBe(4);
    expect(JSON.stringify({ drivers, events })).toBe(before);
  });

  test('lap history keeps missing assignments and invalid fuel unknown, then recovers at a recorded refill', () => {
    const drivers = [{ id: 'a', driverId: 'd', carId: 'c', initialFuelUnits: 10001 }];
    const events = [
      { sessionDriverId: 'missing', kind: 'lap', units: 100, reference: 'lap:foreign' },
      { sessionDriverId: 'a', kind: 'lap', units: 100, reference: 'lap:unknown-start' },
      { sessionDriverId: 'a', kind: 'refuel', targetUnits: 2500 },
      { sessionDriverId: 'a', kind: 'lap', units: 3000, reference: 'lap:empty' },
      { sessionDriverId: 'a', kind: 'lap', units: -1, reference: 'lap:bad' },
      { sessionDriverId: 'a', kind: 'lap', units: 100, reference: 'lap:after-bad' },
      { sessionDriverId: 'a', kind: 'refuel', targetUnits: 10001 },
      { sessionDriverId: 'a', kind: 'lap', units: 100, reference: 'lap:bad-refill' },
      { sessionDriverId: 'a', kind: 'refuel', targetUnits: null },
      { sessionDriverId: 'a', kind: 'lap', units: 0, reference: 'lap:known' },
    ];
    const history = virtualFuelLapHistory(events, drivers);
    expect(history.has('foreign')).toBe(false);
    for (const id of ['unknown-start', 'after-bad', 'bad-refill'])
      expect(history.get(id)).toMatchObject({ beforeUnits: null, afterUnits: null });
    expect(history.get('empty')).toMatchObject({ beforeUnits: 2500, afterUnits: 0 });
    expect(history.get('bad')).toMatchObject({ beforeUnits: 0, afterUnits: null });
    expect(history.get('known')).toMatchObject({ beforeUnits: 10000, afterUnits: 10000 });
    expect(virtualFuelLapHistory().size).toBe(0);
    expect(virtualFuelLapHistory([{ sessionDriverId: 'a', kind: 'lap', units: 100 }], [{ id: 'a' }]).size).toBe(0);
  });

  test('legacy lap fuel history starts full and does not infer values for a missing lap reference', () => {
    const history = virtualFuelLapHistory(
      [
        { sessionDriverId: 'a', kind: 'lap', units: 150, reference: 'lap:first' },
        { sessionDriverId: 'a', kind: 'lap', units: 100, reference: 'lap:third' },
      ],
      [{ id: 'a', driverId: 'd', carId: 'c' }]
    );
    expect(history.get('first')).toMatchObject({ beforeUnits: 10000, afterUnits: 9850 });
    expect(history.has('second')).toBe(false);
    expect(history.get('third')).toMatchObject({ beforeUnits: 9850, afterUnits: 9750 });
  });

  test('ordered events replay exactly and a confirmed refill restores a full tank', () => {
    const events = [
      { sessionDriverId: 'a', kind: 'lap', units: 200 },
      { sessionDriverId: 'b', kind: 'lap', units: 300 },
      { sessionDriverId: 'a', kind: 'refuel', units: 0 },
      { sessionDriverId: 'a', kind: 'lap', units: 100 },
    ];
    const levels = replayVirtualFuel(events);
    expect(levels.get('a')).toBe(9900);
    expect(levels.get('b')).toBe(9700);
    expect(replayVirtualFuel(events).get('a')).toBe(9900);
  });
});

describe('virtual fuel event persistence', () => {
  const previousSecret = process.env.RACE_CONTROL_SECRET;
  let service;
  let io;
  let sync;

  async function fixture(virtualFuelRate = 6, status = 'active', fuelMode = 'OFF') {
    const track = await prisma.track.create({ data: { name: 'Virtual fuel track' } });
    const driver = await prisma.driver.create({ data: { name: 'Test pilot' } });
    const car = await prisma.car.create({ data: { brand: 'Carrera', model: 'Test car' } });
    const session = await prisma.session.create({
      data: { trackId: track.id, type: 'race', status, fuelMode, virtualFuelRate },
    });
    const assigned = await prisma.sessionDriver.create({
      data: { sessionId: session.id, driverId: driver.id, carId: car.id, controller: 0 },
    });
    return { track, driver, car, session, assigned };
  }

  const lap = (time, controller = 0, sector = 1) =>
    service.handleLap({ controller, timestamp: 1000, lapTime: time, sector });

  beforeEach(async () => {
    await prisma.virtualFuelEvent.deleteMany();
    await prisma.pitStop.deleteMany();
    await prisma.lap.deleteMany();
    await prisma.sessionDriver.deleteMany();
    await prisma.session.deleteMany();
    await prisma.driver.deleteMany();
    await prisma.car.deleteMany();
    await prisma.track.deleteMany();
    io = { emit: jest.fn() };
    service = new SessionService(io);
  });

  afterEach(async () => {
    if (previousSecret === undefined) delete process.env.RACE_CONTROL_SECRET;
    else process.env.RACE_CONTROL_SECRET = previousSecret;
    service.stopHeartbeat();
    sync?.close();
    sync = null;
    await service.prisma.$disconnect();
  });

  test('the stored session endpoint reconstructs lap fuel across a simulator refill without changing raw laps', async () => {
    const data = await fixture();
    await prisma.sessionDriver.update({ where: { id: data.assigned.id }, data: { initialFuelUnits: 2500 } });
    await service.loadSession(data.session.id);
    await lap(10000);
    await service.recordPitStop({
      controller: 0,
      enteredAt: new Date(Date.now() - 5000),
      exitedAt: new Date(),
      source: 'simulator',
    });
    await lap(20000);
    setSessionService(service);
    const app = express();
    app.use('/api/sessions', sessionsRouter);
    const response = await request(app).get(`/api/sessions/${data.session.id}`).expect(200);
    const saved = response.body.data;
    const history = virtualFuelLapHistory(saved.virtualFuelEvents, saved.drivers);
    expect(saved.laps.map((row) => row.lapTime)).toEqual([10000, 20000]);
    expect(history.get(saved.laps[0].id)).toMatchObject({ beforeUnits: 2500, afterUnits: 2400 });
    expect(history.get(saved.laps[1].id)).toMatchObject({ beforeUnits: 10000, afterUnits: 9800 });
    expect(virtualFuelWeightedLapTime(saved.laps[0].lapTime, history.get(saved.laps[0].id).beforeUnits, 10)).toBe(
      10250
    );
    expect(virtualFuelWeightedLapTime(saved.laps[1].lapTime, history.get(saved.laps[1].id).beforeUnits, 10)).toBe(
      22000
    );
    await service.loadSession(data.session.id);
    expect(history.get(saved.laps[1].id).afterUnits).toBe(service.getLeaderboard()[0].virtualFuelUnits);
  });

  test('valid laps persist fuel events and exact raw lap measurements', async () => {
    const data = await fixture();
    await service.loadSession(data.session.id);

    await lap(10000);
    expect(service.getLeaderboard()[0].virtualFuelUnits).toBe(9900);
    const events = await prisma.virtualFuelEvent.findMany({
      where: { sessionId: data.session.id },
      orderBy: { id: 'asc' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'lap',
      units: 100,
      source: 'lap',
      controller: 0,
      sessionDriverId: data.assigned.id,
    });
    expect(events[0].reference).toMatch(/^lap:/);
    const savedLap = await prisma.lap.findFirst({ where: { sessionId: data.session.id } });
    expect(savedLap.lapTime).toBe(10000);
    expect(savedLap.lapNumber).toBe(1);
    expect((await prisma.sessionDriver.findUnique({ where: { id: data.assigned.id } })).totalLaps).toBe(1);
  });

  test('reload replays lap and simulator pit events, with CU pit observations excluded', async () => {
    const data = await fixture(6, 'active', 'ON');
    await service.loadSession(data.session.id);
    await lap(20000);
    expect(service.getLeaderboard()[0].virtualFuelUnits).toBe(9800);

    const enteredAt = new Date('2026-10-26T08:00:00.000Z');
    await service.recordPitStop({
      controller: 0,
      enteredAt,
      exitedAt: new Date('2026-10-26T08:00:02.000Z'),
      source: 'cu',
    });
    expect(service.getLeaderboard()[0].virtualFuelUnits).toBe(9800);
    expect(await prisma.virtualFuelEvent.count()).toBe(1);

    await service.recordPitStop({
      controller: 0,
      enteredAt: new Date('2026-10-26T08:00:03.000Z'),
      exitedAt: new Date('2026-10-26T08:00:05.000Z'),
      source: 'simulator',
    });
    expect(service.getLeaderboard()[0].virtualFuelUnits).toBe(VIRTUAL_FUEL_FULL);
    await lap(10000);
    expect(service.getLeaderboard()[0].virtualFuelUnits).toBe(9900);

    const events = await prisma.virtualFuelEvent.findMany({
      where: { sessionId: data.session.id },
      orderBy: { id: 'asc' },
    });
    expect(events.map((row) => row.kind)).toEqual(['lap', 'refuel', 'lap']);
    expect(events.map((row) => row.source)).toEqual(['lap', 'simulator', 'lap']);
    expect(events[1].reference).toMatch(/^pit:/);
    expect(replayVirtualFuel(events).get(data.assigned.id)).toBe(9900);

    const reloaded = new SessionService({ emit: jest.fn() });
    try {
      await reloaded.loadSession(data.session.id);
      expect(reloaded.getLeaderboard()[0].virtualFuelUnits).toBe(9900);
    } finally {
      await reloaded.prisma.$disconnect();
    }

    const app = express();
    app.use(express.json());
    setSessionService(service);
    app.use('/api/sessions', sessionsRouter);
    const response = await request(app).get(`/api/sessions/${data.session.id}`).expect(200);
    expect(response.body.data).toMatchObject({ fuelMode: 'ON', virtualFuelRate: 6 });
    expect(response.body.data.drivers[0].virtualFuelUnits).toBe(9900);
    const standings = await request(app).get(`/api/sessions/${data.session.id}/leaderboard`).expect(200);
    expect(standings.body.data[0].virtualFuelUnits).toBe(9900);
  });

  test('paused, invalid and after-finish laps do not consume virtual fuel or create laps', async () => {
    const data = await fixture();
    await service.loadSession(data.session.id);
    service.sessionStatus = 'paused';
    await lap(10000);
    service.sessionStatus = 'active';
    await lap(0);
    await lap(Number.NaN);
    await lap(Number.POSITIVE_INFINITY);
    await lap(10000, 0, 2);
    expect(await prisma.virtualFuelEvent.count()).toBe(0);
    expect(await prisma.lap.count()).toBe(0);

    service.sessionConfig.maxLaps = 1;
    service.checkSessionComplete = jest.fn();
    await lap(10000);
    await lap(10000);
    expect(await prisma.virtualFuelEvent.count()).toBe(1);
    expect(service.getLeaderboard()[0]).toMatchObject({
      totalLaps: 1,
      virtualFuelUnits: 9900,
    });
    service.sessionStatus = 'finished';
    await lap(10000);
    expect(await prisma.virtualFuelEvent.count()).toBe(1);
  });

  test('virtual fuel is opt-in and does not touch the hardware fuel mode', async () => {
    const data = await fixture(null, 'active', 'ON');
    await service.loadSession(data.session.id);
    await lap(10000);
    await service.recordPitStop({
      controller: 0,
      enteredAt: new Date('2026-10-26T08:00:00.000Z'),
      exitedAt: new Date('2026-10-26T08:00:02.000Z'),
      source: 'simulator',
    });
    expect(await prisma.virtualFuelEvent.count()).toBe(0);
    expect(service.getLeaderboard()[0].virtualFuelUnits).toBeNull();
    expect((await prisma.session.findUnique({ where: { id: data.session.id } })).fuelMode).toBe('ON');
  });

  test('real simulator pit-status transitions trigger one persisted refuel', async () => {
    const data = await fixture();
    await service.loadSession(data.session.id);
    await lap(10000);

    sync = new SyncService({ emit: jest.fn() });
    sync.setSessionService(service);
    service.setSyncService(sync);
    const simulator = new CarreraSimulator({ emit: jest.fn() });
    simulator.init(6);
    simulator.cuMode |= 0x4;
    simulator.cuState = 0;
    const completed = new Promise((resolve) => {
      io.emit.mockImplementation((event, payload) => {
        if (event === 'session:pit_stop') resolve(payload);
      });
    });
    const observe = () => sync.handleStatus(simulator.getCuStatus());

    simulator.cars[0].inPit = false;
    observe();
    simulator.cars[0].inPit = true;
    observe();
    observe();
    await new Promise((resolve) => setTimeout(resolve, 10));
    simulator.cars[0].inPit = false;
    observe();
    observe();
    await completed;

    expect(await prisma.pitStop.count()).toBe(1);
    expect(await prisma.virtualFuelEvent.count({ where: { kind: 'refuel' } })).toBe(1);
    expect(service.getLeaderboard()[0].virtualFuelUnits).toBe(VIRTUAL_FUEL_FULL);
    observe();
    expect(await prisma.virtualFuelEvent.count({ where: { kind: 'refuel' } })).toBe(1);
  });

  test.each(['race', 'qualif'])(
    'a signed %s percent target needs no history and is consumed once at simulator exit',
    async (type) => {
      const data = await fixture();
      await prisma.session.update({ where: { id: data.session.id }, data: { type } });
      await prisma.sessionDriver.update({ where: { id: data.assigned.id }, data: { initialFuelUnits: 1700 } });
      await service.loadSession(data.session.id);
      process.env.RACE_CONTROL_SECRET = 'fuel-percent-integration-test-director-secret';
      setRaceControlServices(service, null);
      const app = express();
      app.use(express.json());
      app.use('/api/race-control', raceControl);
      const issued = await request(app)
        .post('/api/race-control/driver-link')
        .set('Authorization', `Bearer ${process.env.RACE_CONTROL_SECRET}`)
        .send({ sessionId: data.session.id, driverId: data.driver.id })
        .expect(200);
      const auth = `Bearer ${issued.body.token}`;
      await request(app)
        .post('/api/race-control/driver/fuel')
        .set('Authorization', auth)
        .send({ targetUnits: 2500, expectedVersion: 0, sessionDriverId: 'foreign', sessionId: 'foreign' })
        .expect(200);
      expect(await prisma.virtualFuelEvent.count()).toBe(0);
      await service.loadSession(data.session.id);
      expect(service.getLeaderboard()[0]).toMatchObject({
        pendingFuelUnits: 2500,
        pendingFuelLaps: null,
        virtualFuelUnits: 1700,
      });
      const entry = new Date(Date.now() - 5000);
      const exit = new Date();
      await service.recordPitStop({ controller: 0, enteredAt: entry, exitedAt: exit, source: 'cu' });
      expect(service.getLeaderboard()[0]).toMatchObject({
        pendingFuelUnits: 2500,
        virtualFuelUnits: 1700,
        fuelPlanVersion: 1,
      });
      await service.recordPitStop({ controller: 0, enteredAt: entry, exitedAt: exit, source: 'simulator' });
      const stored = await prisma.sessionDriver.findUnique({ where: { id: data.assigned.id } });
      expect(stored).toMatchObject({ pendingFuelUnits: null, pendingFuelLaps: null, fuelPlanVersion: 2 });
      const events = await prisma.virtualFuelEvent.findMany();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ targetUnits: 2500, kind: 'refuel' });
      await service.loadSession(data.session.id);
      expect(service.getLeaderboard()[0].virtualFuelUnits).toBe(2500);
      await request(app)
        .post('/api/race-control/driver/fuel')
        .set('Authorization', auth)
        .send({ targetUnits: 2500, expectedVersion: 1 })
        .expect(409);
      expect(await prisma.lap.count()).toBe(0);
    }
  );

  test('percent plans validate one bounded target and retain the existing session and version guards', async () => {
    const data = await fixture();
    await service.loadSession(data.session.id);
    for (const target of [
      {},
      { targetUnits: null },
      { targetUnits: -1 },
      { targetUnits: 10001 },
      { targetUnits: 1.5 },
      { targetUnits: '2500' },
      { targetUnits: Infinity },
      { targetUnits: 2500, targetLaps: 25 },
      { targetUnits: 0, targetLaps: null },
    ]) {
      await expect(service.requestFuelTarget(data.session.id, data.assigned.id, target, 0)).rejects.toMatchObject({
        status: 400,
      });
    }
    await service.requestFuelTarget(data.session.id, data.assigned.id, { targetUnits: 0 }, 0);
    expect(service.getLeaderboard()[0].pendingFuelUnits).toBe(0);
    await service.recordPitStop({
      controller: 0,
      enteredAt: new Date(Date.now() - 5000),
      exitedAt: new Date(),
      source: 'simulator',
    });
    expect(service.getLeaderboard()[0]).toMatchObject({
      virtualFuelUnits: 10000,
      pendingFuelUnits: null,
      fuelPlanVersion: 2,
    });
    await service.requestFuelTarget(data.session.id, data.assigned.id, { targetUnits: 10000 }, 2);
    await service.requestFuelTarget(data.session.id, data.assigned.id, { targetLaps: null }, 3);
    expect(service.getLeaderboard()[0]).toMatchObject({ pendingFuelUnits: null, fuelPlanVersion: 4 });
    for (const [sessionId, driverId, version] of [
      ['other', data.assigned.id, 4],
      [data.session.id, 'other', 4],
      [data.session.id, data.assigned.id, 3],
    ]) {
      await expect(
        service.requestFuelTarget(sessionId, driverId, { targetUnits: 2500 }, version)
      ).rejects.toMatchObject({ status: 409 });
    }
    service.sessionStatus = 'finished';
    await expect(
      service.requestFuelTarget(data.session.id, data.assigned.id, { targetUnits: 2500 }, 4)
    ).rejects.toMatchObject({ status: 409 });
    service.sessionStatus = 'active';
    service.sessionConfig.virtualFuelRate = null;
    await expect(
      service.requestFuelTarget(data.session.id, data.assigned.id, { targetUnits: 2500 }, 4)
    ).rejects.toMatchObject({ status: 409 });
  });

  test('wet tyres plus fuel for 25 laps applies automatically at a real simulator pit cycle and survives replay', async () => {
    const data = await fixture();
    await service.loadSession(data.session.id);
    await lap(800000);
    for (let i = 0; i < 3; i++) await lap(10000);
    const rawLaps = await prisma.lap.findMany({ orderBy: { timestamp: 'asc' } });
    expect(service.getLeaderboard()[0].virtualFuelUnits).toBe(1700);
    process.env.RACE_CONTROL_SECRET = 'fuel-integration-test-director-secret-only';
    setRaceControlServices(service, null);
    const app = express();
    app.use(express.json());
    app.use('/api/race-control', raceControl);
    const issued = await request(app)
      .post('/api/race-control/driver-link')
      .set('Authorization', `Bearer ${process.env.RACE_CONTROL_SECRET}`)
      .send({ sessionId: data.session.id, driverId: data.driver.id })
      .expect(200);
    const auth = `Bearer ${issued.body.token}`;
    await request(app)
      .post('/api/race-control/driver/tyres')
      .set('Authorization', auth)
      .send({ tyreType: 'wet' })
      .expect(200);
    const response = await request(app)
      .post('/api/race-control/driver/fuel')
      .set('Authorization', auth)
      .send({ targetLaps: 25, expectedVersion: 0 })
      .expect(200);
    const plan = response.body.data;
    expect(plan).toMatchObject({ pendingFuelLaps: 25, pendingFuelUnits: 2500, fuelPlanVersion: 1 });
    await expect(
      service.requestFuelTarget(data.session.id, data.assigned.id, { targetLaps: 25 }, 0)
    ).rejects.toMatchObject({
      status: 409,
    });
    expect(service.getLeaderboard()[0].virtualFuelUnits).toBe(1700);
    await service.loadSession(data.session.id);
    expect(service.getLeaderboard()[0].pendingFuelLaps).toBe(25);

    sync = new SyncService({ emit: jest.fn() });
    sync.setSessionService(service);
    service.setSyncService(sync);
    const simulator = new CarreraSimulator({ emit: jest.fn() });
    simulator.init(6);
    const hardwareFuel = simulator.cars[0].fuel;
    simulator.cuMode |= 0x4;
    simulator.cuState = 0;
    const observe = () => sync.handleStatus(simulator.getCuStatus());
    const completed = new Promise((resolve) =>
      io.emit.mockImplementation((event, payload) => {
        if (event === 'session:pit_stop') resolve(payload);
      })
    );
    simulator.cars[0].inPit = false;
    observe();
    simulator.cars[0].inPit = true;
    observe();
    observe();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await prisma.virtualFuelEvent.count({ where: { kind: 'refuel' } })).toBe(0);
    simulator.cars[0].inPit = false;
    observe();
    observe();
    await completed;
    expect(service.getLeaderboard()[0]).toMatchObject({
      tyreType: 'wet',
      pendingTyreType: null,
      pendingFuelLaps: null,
      virtualFuelUnits: 2500,
      fuelPlanVersion: 2,
    });
    expect(await prisma.virtualFuelEvent.count({ where: { kind: 'refuel' } })).toBe(1);
    expect(await prisma.tyreChange.count()).toBe(1);
    observe();
    await expect(
      service.requestFuelTarget(data.session.id, data.assigned.id, { targetLaps: 25 }, 0)
    ).rejects.toMatchObject({
      status: 409,
    });
    await service.loadSession(data.session.id);
    expect(service.getLeaderboard()[0]).toMatchObject({
      virtualFuelUnits: 2500,
      pendingFuelLaps: null,
      fuelPlanVersion: 2,
    });
    expect(await prisma.lap.findMany({ orderBy: { timestamp: 'asc' } })).toEqual(rawLaps);
    await lap(10000);
    await service.loadSession(data.session.id);
    expect(service.getLeaderboard()[0].virtualFuelUnits).toBe(2400);
    expect(simulator.cars[0].fuel).toBe(hardwareFuel);
  });

  test('CU, invalid and paused pit cycles do not execute or clear the saved plan', async () => {
    const data = await fixture();
    await service.loadSession(data.session.id);
    for (let i = 0; i < 3; i++) await lap(10000);
    await service.requestFuelTarget(data.session.id, data.assigned.id, { targetLaps: 25 }, 0);
    const enteredAt = new Date();
    for (const [source, duration, status] of [
      ['cu', 2000, 'active'],
      ['simulator', 0, 'active'],
      ['simulator', 2000, 'paused'],
    ]) {
      service.sessionStatus = status;
      await service.recordPitStop({
        controller: 0,
        enteredAt,
        exitedAt: new Date(enteredAt.getTime() + duration),
        source,
      });
      expect(service.getLeaderboard()[0]).toMatchObject({ pendingFuelLaps: 25, virtualFuelUnits: 9700 });
    }
    expect(await prisma.virtualFuelEvent.count({ where: { kind: 'refuel' } })).toBe(0);
    service.sessionStatus = 'active';
    await service.recordPitStop({
      controller: 0,
      enteredAt,
      exitedAt: new Date(enteredAt.getTime() + 2000),
      source: 'simulator',
    });
    expect(service.getLeaderboard()[0].virtualFuelUnits).toBe(9700); // topping up never drains a higher tank
    expect((await prisma.virtualFuelEvent.findFirst({ where: { kind: 'refuel' } })).targetUnits).toBe(9700);
  });

  test('a failed pit transaction leaves the plan and tank unchanged; queued lap burns precede a later refill', async () => {
    const data = await fixture();
    await service.loadSession(data.session.id);
    await lap(800000);
    for (let i = 0; i < 3; i++) await lap(10000);
    await service.requestFuelTarget(data.session.id, data.assigned.id, { targetLaps: 25 }, 0);
    const enteredAt = new Date();
    const stop = () =>
      service.recordPitStop({
        controller: 0,
        enteredAt,
        exitedAt: new Date(enteredAt.getTime() + 2000),
        source: 'simulator',
      });
    const failure = jest.spyOn(service.prisma, '$transaction').mockRejectedValueOnce(new Error('write failed'));
    await expect(stop()).rejects.toThrow('write failed');
    failure.mockRestore();
    expect(await prisma.pitStop.count()).toBe(0);
    expect(service.getLeaderboard()[0]).toMatchObject({
      pendingFuelLaps: 25,
      virtualFuelUnits: 1700,
      fuelPlanVersion: 1,
    });
    expect((await prisma.sessionDriver.findUnique({ where: { id: data.assigned.id } })).pendingFuelLaps).toBe(25);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const transaction = service.prisma.$transaction.bind(service.prisma);
    const held = jest.spyOn(service.prisma, '$transaction').mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return transaction(...args);
    });
    const burning = lap(10000);
    await started;
    const filling = stop();
    expect(service.getLeaderboard()[0].virtualFuelUnits).toBe(1700);
    release();
    await Promise.all([burning, filling]);
    held.mockRestore();
    expect(service.getLeaderboard()[0].virtualFuelUnits).toBe(2500);
    await service.loadSession(data.session.id);
    expect(service.getLeaderboard()[0].virtualFuelUnits).toBe(2500);
  });

  test('missing history, invalid targets, capacity and unavailable sessions fail without changing fuel', async () => {
    const data = await fixture();
    await service.loadSession(data.session.id);
    await expect(
      service.requestFuelTarget(data.session.id, data.assigned.id, { targetLaps: 25 }, 0)
    ).rejects.toMatchObject({
      status: 409,
    });
    for (const value of [undefined, '25', 0, 1.5, -1])
      await expect(
        service.requestFuelTarget(data.session.id, data.assigned.id, { targetLaps: value }, 0)
      ).rejects.toMatchObject({
        status: 400,
      });
    for (let i = 0; i < 3; i++) await lap(10000);
    await expect(
      service.requestFuelTarget(data.session.id, data.assigned.id, { targetLaps: 101 }, 0)
    ).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      service.requestFuelTarget(data.session.id, data.assigned.id, { targetLaps: 25 })
    ).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      service.requestFuelTarget('another-session', data.assigned.id, { targetLaps: 25 }, 0)
    ).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      service.requestFuelTarget(data.session.id, 'other-driver', { targetLaps: 25 }, 0)
    ).rejects.toMatchObject({
      status: 409,
    });
    service.sessionConfig.virtualFuelRate = null;
    await expect(
      service.requestFuelTarget(data.session.id, data.assigned.id, { targetLaps: 25 }, 0)
    ).rejects.toMatchObject({
      status: 409,
    });
    service.sessionConfig.virtualFuelRate = 6;
    service.sessionStatus = 'finished';
    await expect(
      service.requestFuelTarget(data.session.id, data.assigned.id, { targetLaps: 25 }, 0)
    ).rejects.toMatchObject({
      status: 409,
    });
    expect((await prisma.sessionDriver.findUnique({ where: { id: data.assigned.id } })).pendingFuelLaps).toBeNull();
    expect(await prisma.virtualFuelEvent.count({ where: { kind: 'refuel' } })).toBe(0);
  });

  test('qualifying plans can be changed, cancelled and reset without changing the tank', async () => {
    const data = await fixture();
    await prisma.session.update({ where: { id: data.session.id }, data: { type: 'qualif' } });
    await service.loadSession(data.session.id);
    for (let i = 0; i < 3; i++) await lap(10000);
    await service.requestFuelTarget(data.session.id, data.assigned.id, { targetLaps: 25 }, 0);
    await service.requestFuelTarget(data.session.id, data.assigned.id, { targetLaps: null }, 1);
    expect(service.getLeaderboard()[0]).toMatchObject({
      pendingFuelLaps: null,
      pendingFuelUnits: null,
      virtualFuelUnits: 9700,
    });
    await service.requestFuelTarget(data.session.id, data.assigned.id, { targetLaps: 100 }, 2);
    await service.resetSession(data.session.id);
    const stored = await prisma.sessionDriver.findUnique({ where: { id: data.assigned.id } });
    expect(stored).toMatchObject({ pendingFuelLaps: null, pendingFuelUnits: null, fuelPlanVersion: 4 });
  });

  test('a personal draft qualifying link saves starting fuel, locks at start and replays the measured consumption', async () => {
    const data = await fixture(6, 'draft');
    await prisma.session.update({ where: { id: data.session.id }, data: { type: 'qualif' } });
    process.env.RACE_CONTROL_SECRET = 'start-fuel-integration-test-secret-only';
    setRaceControlServices(service, null);
    setSessionService(service);
    const app = express();
    app.use(express.json());
    app.use('/api/race-control', raceControl);
    app.use('/api/sessions', sessionsRouter);
    const issued = await request(app)
      .post('/api/race-control/driver-link')
      .set('Authorization', `Bearer ${process.env.RACE_CONTROL_SECRET}`)
      .send({ sessionId: data.session.id, driverId: data.driver.id })
      .expect(200);
    const auth = `Bearer ${issued.body.token}`;
    const resolved = await request(app).get('/api/race-control/driver/session').set('Authorization', auth).expect(200);
    expect(resolved.body.data).toEqual({
      sessionId: data.session.id,
      sessionDriverId: data.assigned.id,
      driverId: data.driver.id,
    });
    const save = (units, version) =>
      request(app)
        .post('/api/race-control/driver/start-fuel')
        .set('Authorization', auth)
        .send({ initialFuelUnits: units, expectedVersion: version });
    await save(2500, 0).expect(200);
    const read = await request(app).get(`/api/sessions/${data.session.id}`).expect(200);
    expect(read.body.data.drivers[0]).toMatchObject({
      initialFuelUnits: 2500,
      virtualFuelUnits: 2500,
      fuelPlanVersion: 1,
    });
    const board = await request(app).get(`/api/sessions/${data.session.id}/leaderboard`).expect(200);
    expect(board.body.data[0].virtualFuelUnits).toBe(2500);
    expect(await prisma.virtualFuelEvent.count()).toBe(0);
    await service.loadSession(data.session.id);
    await save(0, 1).expect(200);
    expect(service.getLeaderboard()[0].virtualFuelUnits).toBe(0);
    await save(2500, 2).expect(200);
    service.setSyncService({
      isConnected: () => true,
      getDevice: () => null,
      reset: jest.fn(),
      prepareRace: jest.fn(),
      stopRace: jest.fn(),
    });
    service.applyCarConfigs = jest.fn();
    await service.startSession(data.session.id);
    expect(service.getLeaderboard()[0].virtualFuelUnits).toBe(2500);
    await save(10000, 3).expect(409);
    await service.onRaceStart();
    await lap(10000);
    expect(service.getLeaderboard()[0].virtualFuelUnits).toBe(2400);
    await service.loadSession(data.session.id);
    expect(service.getLeaderboard()[0].virtualFuelUnits).toBe(2400);
    expect((await prisma.lap.findFirst()).lapTime).toBe(10000);
    expect((await prisma.session.findUnique({ where: { id: data.session.id } })).fuelMode).toBe('OFF');
    await service.resetSession(data.session.id);
    await service.loadSession(data.session.id);
    expect(service.getLeaderboard()[0].virtualFuelUnits).toBe(2500);
    expect((await prisma.sessionDriver.findUnique({ where: { id: data.assigned.id } })).initialFuelUnits).toBe(2500);
  });

  test('starting fuel rejects invalid, stale and unavailable selections without changing the stored level', async () => {
    const data = await fixture(6, 'draft');
    const choose = (units, version = 0) =>
      service.setInitialFuel({
        sessionId: data.session.id,
        sessionDriverId: data.assigned.id,
        driverId: data.driver.id,
        controller: 0,
        initialFuelUnits: units,
        expectedVersion: version,
      });
    for (const units of [null, -1, 10001, 1.5, '2500'])
      await expect(choose(units)).rejects.toMatchObject({ status: 400 });
    await expect(choose(2500, null)).rejects.toMatchObject({ status: 400 });
    await choose(2500);
    await expect(choose(5000)).rejects.toMatchObject({ status: 409 });
    for (const status of ['active', 'paused', 'finishing', 'finished', 'interrupted']) {
      await prisma.session.update({ where: { id: data.session.id }, data: { status } });
      await expect(choose(1000, 1)).rejects.toMatchObject({ status: 409 });
    }
    await prisma.session.update({ where: { id: data.session.id }, data: { status: 'draft', virtualFuelRate: null } });
    await expect(choose(1000, 1)).rejects.toMatchObject({ status: 409 });
    await prisma.session.update({ where: { id: data.session.id }, data: { virtualFuelRate: 6, type: 'practice' } });
    await expect(choose(1000, 1)).rejects.toMatchObject({ status: 409 });
    expect((await prisma.sessionDriver.findUnique({ where: { id: data.assigned.id } })).initialFuelUnits).toBe(2500);
    expect(await prisma.virtualFuelEvent.count()).toBe(0);
  });

  test('a starting session waits for an already admitted fuel save before loading its initial tank', async () => {
    const data = await fixture(6, 'draft');
    const choose = () =>
      service.setInitialFuel({
        sessionId: data.session.id,
        sessionDriverId: data.assigned.id,
        driverId: data.driver.id,
        controller: 0,
        initialFuelUnits: 2500,
        expectedVersion: 0,
      });
    service.startingSessionId = data.session.id;
    await expect(choose()).rejects.toMatchObject({ status: 409 });
    service.startingSessionId = null;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const update = service.prisma.sessionDriver.updateMany.bind(service.prisma.sessionDriver);
    const held = jest.spyOn(service.prisma.sessionDriver, 'updateMany').mockImplementationOnce(async (args) => {
      entered();
      await gate;
      return update(args);
    });
    const saving = choose();
    await started;
    service.setSyncService({
      isConnected: () => true,
      getDevice: () => null,
      reset: jest.fn(),
      prepareRace: jest.fn(),
    });
    service.applyCarConfigs = jest.fn();
    const starting = service.startSession(data.session.id);
    release();
    await Promise.all([saving, starting]);
    held.mockRestore();
    expect(service.getLeaderboard()[0].virtualFuelUnits).toBe(2500);
    await expect(choose()).rejects.toMatchObject({ status: 409 });
  });

  test('an intervening database start or reassignment cannot receive a late starting-fuel write', async () => {
    const data = await fixture(6, 'draft');
    const choose = () =>
      service.setInitialFuel({
        sessionId: data.session.id,
        sessionDriverId: data.assigned.id,
        driverId: data.driver.id,
        controller: 0,
        initialFuelUnits: 2500,
        expectedVersion: 0,
      });
    const update = service.prisma.sessionDriver.updateMany.bind(service.prisma.sessionDriver);
    const raced = jest.spyOn(service.prisma.sessionDriver, 'updateMany').mockImplementationOnce(async (args) => {
      await prisma.session.update({ where: { id: data.session.id }, data: { status: 'active' } });
      return update(args);
    });
    await expect(choose()).rejects.toMatchObject({ status: 409 });
    raced.mockRestore();
    await prisma.session.update({ where: { id: data.session.id }, data: { status: 'draft' } });
    await prisma.sessionDriver.update({ where: { id: data.assigned.id }, data: { controller: 1 } });
    await expect(choose()).rejects.toMatchObject({ status: 409 });
    expect((await prisma.sessionDriver.findUnique({ where: { id: data.assigned.id } })).initialFuelUnits).toBe(10000);
  });

  test('session creation validates virtual rate; draft edit works but running races are locked', async () => {
    const data = await fixture(null, 'draft');
    const app = express();
    app.use(express.json());
    setSessionService(service);
    app.use('/api/sessions', sessionsRouter);

    await request(app).put(`/api/sessions/${data.session.id}`).send({ virtualFuelRate: 150 }).expect(400);
    for (const rate of [0, 101, 1.5, -1]) {
      await request(app).put(`/api/sessions/${data.session.id}`).send({ virtualFuelRate: rate }).expect(400);
    }
    const maximum = await request(app)
      .put(`/api/sessions/${data.session.id}`)
      .send({ virtualFuelRate: 100 })
      .expect(200);
    expect(maximum.body.data).toMatchObject({ virtualFuelRate: 100, fuelMode: 'OFF' });
    const disabled = await request(app)
      .put(`/api/sessions/${data.session.id}`)
      .send({ virtualFuelRate: null })
      .expect(200);
    expect(disabled.body.data).toMatchObject({ virtualFuelRate: null, fuelMode: 'OFF' });
    const updated = await request(app).put(`/api/sessions/${data.session.id}`).send({ virtualFuelRate: 8 }).expect(200);
    expect(updated.body.data.virtualFuelRate).toBe(8);
    await prisma.session.update({ where: { id: data.session.id }, data: { status: 'active' } });
    await request(app).put(`/api/sessions/${data.session.id}`).send({ virtualFuelRate: 7 }).expect(409);
    await request(app).put(`/api/sessions/${data.session.id}`).send({ virtualFuelRate: null }).expect(409);
    const unchanged = await prisma.session.findUnique({ where: { id: data.session.id } });
    expect(unchanged.virtualFuelRate).toBe(8);

    await expect(
      service.createSession({
        trackId: data.track.id,
        type: 'race',
        virtualFuelRate: -1,
      })
    ).rejects.toThrow('Virtual fuel rate');
    const created = await service.createSession({
      trackId: data.track.id,
      type: 'race',
      virtualFuelRate: 3,
    });
    expect(created.virtualFuelRate).toBe(3);
  });

  test('reset clears the virtual fuel event log and starts a new race at full', async () => {
    const data = await fixture();
    await service.loadSession(data.session.id);
    await lap(10000);
    expect(await prisma.virtualFuelEvent.count()).toBe(1);
    await service.resetSession(data.session.id);
    expect(await prisma.virtualFuelEvent.count()).toBe(0);
    const fresh = new SessionService({ emit: jest.fn() });
    try {
      await fresh.loadSession(data.session.id);
      expect(fresh.getLeaderboard()[0].virtualFuelUnits).toBe(VIRTUAL_FUEL_FULL);
    } finally {
      await fresh.prisma.$disconnect();
    }
  });
});

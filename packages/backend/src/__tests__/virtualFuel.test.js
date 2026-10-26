import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from './setup.js';
import { SessionService } from '../services/SessionService.js';
import { SyncService } from '../services/SyncService.js';
import { CarreraSimulator } from '../services/simulator.js';
import sessionsRouter, { setSessionService } from '../routes/sessions.js';
import { VIRTUAL_FUEL_FULL, validVirtualFuelRate, virtualFuelBurn, replayVirtualFuel } from '@racehubos/shared';

describe('virtual fuel arithmetic', () => {
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
    sync?.close();
    sync = null;
    await service.prisma.$disconnect();
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

  test('session creation validates virtual rate; draft edit works but running races are locked', async () => {
    const data = await fixture(null, 'draft');
    const app = express();
    app.use(express.json());
    setSessionService(service);
    app.use('/api/sessions', sessionsRouter);

    await request(app).put(`/api/sessions/${data.session.id}`).send({ virtualFuelRate: 150 }).expect(400);
    const updated = await request(app).put(`/api/sessions/${data.session.id}`).send({ virtualFuelRate: 8 }).expect(200);
    expect(updated.body.data.virtualFuelRate).toBe(8);
    await prisma.session.update({ where: { id: data.session.id }, data: { status: 'active' } });
    await request(app).put(`/api/sessions/${data.session.id}`).send({ virtualFuelRate: 7 }).expect(409);
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

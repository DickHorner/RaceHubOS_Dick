import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { prisma } from './setup.js';
import { SessionService } from '../services/SessionService.js';
import { ChampionshipService } from '../services/ChampionshipService.js';
import sessionsRouter, { setSessionService } from '../routes/sessions.js';
import championshipsRouter from '../routes/championships.js';

const Database = createRequire(import.meta.url)('better-sqlite3');

describe('persisted virtual fuel-weight scoring', () => {
  let service;
  let app;
  const lap = (time = 10000, controller = 0) =>
    service.handleLap({ controller, timestamp: Date.now(), lapTime: time, sector: 1 });
  const pit = () =>
    service.recordPitStop({
      controller: 0,
      enteredAt: new Date(Date.now() - 2000),
      exitedAt: new Date(),
      source: 'simulator',
    });

  async function fixture({ type = 'race', weight = 10, initial = 10000, ...config } = {}) {
    const track = await prisma.track.create({ data: { name: 'Fuel weight circuit' } });
    const session = await prisma.session.create({
      data: {
        type,
        status: 'active',
        trackId: track.id,
        virtualFuelRate: 60,
        fuelWeightPercent: weight,
        ...config,
      },
    });
    const assigned = [];
    for (const [controller, initialFuelUnits] of [initial, 0].entries()) {
      const driver = await prisma.driver.create({ data: { name: `Weight pilot ${controller}` } });
      const car = await prisma.car.create({ data: { brand: 'Carrera', model: `Weight car ${controller}` } });
      assigned.push(
        await prisma.sessionDriver.create({
          data: {
            sessionId: session.id,
            driverId: driver.id,
            carId: car.id,
            controller,
            initialFuelUnits,
          },
        })
      );
    }
    await service.loadSession(session.id);
    return { session, assigned, track };
  }

  beforeEach(async () => {
    await prisma.trackRecord.deleteMany();
    await prisma.controllerConfig.deleteMany();
    await prisma.virtualFuelEvent.deleteMany();
    await prisma.tyreChange.deleteMany();
    await prisma.pitStop.deleteMany();
    await prisma.lap.deleteMany();
    await prisma.sessionDriver.deleteMany();
    await prisma.championshipParticipant.deleteMany();
    await prisma.session.deleteMany();
    await prisma.championship.deleteMany();
    await prisma.driver.deleteMany();
    await prisma.car.deleteMany();
    await prisma.track.deleteMany();
    service = new SessionService({ emit: jest.fn() });
    setSessionService(service);
    app = express();
    app.use(express.json());
    app.use('/api/sessions', sessionsRouter);
    app.use('/api/championships', championshipsRouter);
  });

  afterEach(async () => {
    service.stopHeartbeat();
    await service.prisma.$disconnect();
  });

  test.each([
    [10000, 11000],
    [5000, 10500],
    [0, 10000],
  ])('saves tank %i before burning fuel, with raw and simulated lap times separate', async (initial, expected) => {
    const { session, assigned } = await fixture({ initial });
    await lap();
    expect(await prisma.lap.findFirst()).toMatchObject({
      lapTime: 10000,
      simulatedLapTime: expected,
      fuelUnitsAtLap: initial,
    });
    expect(await prisma.sessionDriver.findUnique({ where: { id: assigned[0].id } })).toMatchObject({
      totalLaps: 1,
      totalTime: 10000,
      bestLapTime: 10000,
      simulatedTotalTime: expected,
      simulatedBestLapTime: expected,
    });
    const fresh = new SessionService({ emit: jest.fn() });
    try {
      await fresh.loadSession(session.id);
      expect(fresh.getLeaderboard().find((d) => d.controller === 0)).toMatchObject({
        totalTime: 10000,
        simulatedTotalTime: expected,
        virtualFuelUnits: Math.max(0, initial - 1000),
      });
    } finally {
      fresh.stopHeartbeat();
      await fresh.prisma.$disconnect();
    }
  });

  test.each(['race', 'qualif'])('%s scoring reverses raw order and survives finish, REST and restart', async (type) => {
    const { session, assigned } = await fixture({ type });
    const setSpeed = jest.fn();
    const setFuel = jest.fn();
    service.syncService = { getDevice: () => ({ setSpeed, setFuel }), stopRace: jest.fn(), reset: jest.fn() };
    await lap(10000, 0);
    await lap(10500, 1);
    expect(service.getLeaderboard().map((d) => d.controller)).toEqual([1, 0]);
    expect(service.getLeaderboard()[1].gap).toBe(500);
    await service.finishSession('manual');
    const stored = await prisma.sessionDriver.findMany({
      where: { sessionId: session.id },
      orderBy: { finalPos: 'asc' },
    });
    expect(stored.map((d) => d.controller)).toEqual([1, 0]);
    expect(stored[1]).toMatchObject({ totalTime: 10000, bestLapTime: 10000, simulatedTotalTime: 11000, isDNF: false });
    const response = await request(app).get(`/api/sessions/${session.id}/leaderboard`).expect(200);
    expect(response.body.data.map((d) => d.controller)).toEqual([1, 0]);
    await service.loadSession(session.id);
    expect(service.getLeaderboard().map((d) => d.controller)).toEqual([1, 0]);
    expect(setSpeed).not.toHaveBeenCalled();
    expect(setFuel).not.toHaveBeenCalled();
    const raw = await prisma.lap.findMany({ orderBy: { controller: 'asc' } });
    expect(raw.map((d) => d.lapTime)).toEqual([10000, 10500]);
    expect(stored[1].id).toBe(assigned[0].id);
    const exported = await request(app).get(`/api/sessions/${session.id}/export?format=csv&table=laps`).expect(200);
    expect(exported.text).toContain('Temps simulé');
    expect(exported.text).toContain('Carburant avant tour (%)');
    expect(exported.text).toContain('Weight car 0,10,11,100');
    const cup = await prisma.championship.create({ data: { name: 'Scoring cup', season: '2026' } });
    await prisma.session.update({ where: { id: session.id }, data: { championshipId: cup.id } });
    const aggregate = await request(app).get(`/api/championships/${cup.id}/standings?type=${type}`).expect(200);
    expect(aggregate.body.standings.map((d) => d.driverId)).toEqual([assigned[1].driverId, assigned[0].driverId]);
    if (type === 'race') {
      expect(aggregate.body.standings[1]).toMatchObject({ totalTime: 10000, simulatedTotalTime: 11000 });
      const result = await request(app).get(`/api/championships/${cup.id}/results`).expect(200);
      expect(result.body.data.standings.map((d) => d.driverId)).toEqual([assigned[1].driverId, assigned[0].driverId]);
    }
  });

  test('tyre and fuel factors multiply before a single final rounding; consumption remains measured', async () => {
    await fixture({
      startedAt: new Date(),
      weatherSeed: 19,
      weatherInitial: 'rain',
      weatherRainChance: 100,
      weatherIntervalSeconds: 60,
      tyreMismatchPercent: 10,
    });
    await lap(10000.49);
    expect(await prisma.lap.findFirst()).toMatchObject({
      lapTime: 10000.49,
      simulatedLapTime: 12101,
      fuelUnitsAtLap: 10000,
      tyreAtLap: 'dry',
      weatherAtLap: 'rain',
    });
    expect((await prisma.virtualFuelEvent.findFirst()).units).toBe(1000);
  });

  test('zero/off leaves existing tyre timing and raw qualifying classification unchanged', async () => {
    const { session } = await fixture({ type: 'qualif', weight: 0 });
    await lap(10000);
    await lap(10500, 1);
    expect(service.getLeaderboard().map((d) => d.controller)).toEqual([0, 1]);
    expect(await prisma.lap.findFirst()).toMatchObject({
      lapTime: 10000,
      simulatedLapTime: null,
      fuelUnitsAtLap: null,
    });
    expect((await prisma.session.findUnique({ where: { id: session.id } })).fuelWeightPercent).toBe(0);
  });

  test('held lap, refill and next lap use committed event order, then replay identically', async () => {
    const { session } = await fixture({ initial: 5000 });
    let release;
    let entered;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const transaction = service.prisma.$transaction.bind(service.prisma);
    const held = jest.spyOn(service.prisma, '$transaction').mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return transaction(...args);
    });
    const first = lap();
    await started;
    const filling = pit();
    release();
    await Promise.all([first, filling]);
    held.mockRestore();
    await lap();
    const saved = await prisma.lap.findMany({ orderBy: { lapNumber: 'asc' } });
    expect(saved.map((row) => [row.fuelUnitsAtLap, row.simulatedLapTime])).toEqual([
      [5000, 10500],
      [10000, 11000],
    ]);
    await service.loadSession(session.id);
    expect(service.getLeaderboard().find((d) => d.controller === 0)).toMatchObject({
      virtualFuelUnits: 9000,
      simulatedTotalTime: 21500,
      totalTime: 20000,
    });
  });

  test('an earlier confirmed pit applies fuel and tyres before a simultaneously observed lap', async () => {
    const { session, assigned } = await fixture({
      initial: 5000,
      startedAt: new Date(),
      weatherSeed: 19,
      weatherInitial: 'rain',
      weatherRainChance: 100,
      weatherIntervalSeconds: 60,
      tyreMismatchPercent: 10,
    });
    await service.requestTyreChange(session.id, assigned[0].id, 'wet');
    await Promise.all([pit(), lap()]);
    expect(await prisma.lap.findFirst()).toMatchObject({
      fuelUnitsAtLap: 10000,
      tyreAtLap: 'wet',
      simulatedLapTime: 11000,
    });
  });

  test('failed fuel event rolls back lap and its weight snapshot without reporting simulated time', async () => {
    await fixture();
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER reject_weight_event BEFORE INSERT ON "VirtualFuelEvent" BEGIN SELECT RAISE(ABORT, 'weight write failure'); END;`
    );
    try {
      await expect(lap()).rejects.toThrow();
      expect(await prisma.lap.count()).toBe(0);
      expect(await prisma.virtualFuelEvent.count()).toBe(0);
      expect(service.getLeaderboard().find((d) => d.controller === 0)).toMatchObject({
        virtualFuelUnits: 10000,
        simulatedTotalTime: null,
      });
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER reject_weight_event');
    }
  });

  test('manual finish waits for an admitted lap before persisting simulated totals and final positions', async () => {
    const { session } = await fixture();
    let release;
    let entered;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const transaction = service.prisma.$transaction.bind(service.prisma);
    const held = jest.spyOn(service.prisma, '$transaction').mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return transaction(...args);
    });
    const recording = lap();
    await started;
    const finishing = service.finishSession('manual');
    await lap(1000, 1);
    release();
    await Promise.all([recording, finishing]);
    held.mockRestore();
    expect(await prisma.lap.count()).toBe(1);
    expect(await prisma.sessionDriver.findFirst({ where: { sessionId: session.id, controller: 0 } })).toMatchObject({
      simulatedTotalTime: 11000,
      finalPos: 1,
    });
  });

  test('draft saves validate dependencies and bounds; every post-start state rejects regrading', async () => {
    const { session, track } = await fixture({ status: 'draft', weight: 0 });
    const save = (changes) => request(app).put(`/api/sessions/${session.id}`).send(changes);
    for (const fuelWeightPercent of [-1, 31, 1.5, '10', null]) await save({ fuelWeightPercent }).expect(400);
    await save({ virtualFuelRate: null, fuelWeightPercent: 10 }).expect(400);
    await save({ type: 'practice', fuelWeightPercent: 10 }).expect(400);
    await save({ fuelWeightPercent: 30 }).expect(200);
    for (const status of ['active', 'paused', 'finishing', 'finished', 'interrupted']) {
      await prisma.session.update({ where: { id: session.id }, data: { status } });
      await save({ fuelWeightPercent: 0 }).expect(409);
      await save({ fuelWeightPercent: 30 }).expect(200);
      await save({ type: 'qualif' }).expect(409);
    }
    for (const config of [
      { fuelWeightPercent: 31 },
      { fuelWeightPercent: 10 },
      { fuelWeightPercent: 10, virtualFuelRate: 6, type: 'practice' },
    ])
      await expect(service.createSession({ trackId: track.id, type: 'race', ...config })).rejects.toThrow();
    const created = await service.createSession({
      trackId: track.id,
      type: 'qualif',
      virtualFuelRate: 6,
      fuelWeightPercent: 10,
    });
    expect(created.fuelWeightPercent).toBe(10);
    const disabled = await service.createSession({ trackId: track.id, type: 'race' });
    expect(disabled.fuelWeightPercent).toBe(0);
  });

  test('merged qualifying grid uses simulated best laps while measured bests stay intact', async () => {
    const { session, assigned, track } = await fixture({ type: 'qualif' });
    await lap(10000, 0);
    await lap(10500, 1);
    await service.finishSession('manual');
    const cup = await prisma.championship.create({
      data: {
        name: 'Weight cup',
        season: '2026',
        trackId: track.id,
        mode: 'auto',
        driversPerRace: 2,
        driversPerQualif: 2,
      },
    });
    await prisma.session.update({ where: { id: session.id }, data: { championshipId: cup.id } });
    for (const entry of assigned)
      await prisma.championshipParticipant.create({
        data: { championshipId: cup.id, driverId: entry.driverId },
      });
    const race = await prisma.session.create({
      data: { type: 'race', trackId: track.id, championshipId: cup.id, autoGroup: 0 },
    });
    const manager = new ChampionshipService({ emit: jest.fn() });
    try {
      await manager.assignDriversToRaces(cup.id);
      const bracket = await manager.getBracket(cup.id);
      expect(bracket.mergedRanking[0]).toMatchObject({
        driverId: assigned[1].driverId,
        bestTime: 10500,
        isSimulated: true,
      });
      const standings = await request(app).get(`/api/championships/${cup.id}/standings?type=qualif`).expect(200);
      expect(standings.body.standings.map((d) => d.driverId)).toEqual([assigned[1].driverId, assigned[0].driverId]);
      expect(standings.body.standings[1]).toMatchObject({
        bestTime: 11000,
        measuredBestTime: 10000,
        isSimulated: true,
      });
      const grid = await prisma.sessionDriver.findMany({ where: { sessionId: race.id }, orderBy: { gridPos: 'asc' } });
      expect(grid.map((d) => d.driverId)).toEqual([assigned[1].driverId, assigned[0].driverId]);
    } finally {
      await manager.prisma.$disconnect();
    }
    expect((await prisma.sessionDriver.findUnique({ where: { id: assigned[0].id } })).bestLapTime).toBe(10000);
  });
});

test('fuel-weight migration adds disabled defaults without altering existing laps or classification', () => {
  const db = new Database(':memory:');
  const migrations = new URL('../../prisma/migrations/', import.meta.url);
  try {
    const names = fs
      .readdirSync(migrations)
      .filter((n) => n < '20261031200000_fuel_weight_timing')
      .sort();
    for (const name of names) {
      const file = new URL(`${name}/migration.sql`, migrations);
      if (fs.existsSync(file)) db.exec(fs.readFileSync(file, 'utf8'));
    }
    db.exec(`INSERT INTO Track (id,name,createdAt,updatedAt) VALUES ('t','Old track',0,0);
      INSERT INTO Car (id,brand,model,createdAt,updatedAt) VALUES ('car','Carrera','Old car',0,0);
      INSERT INTO Session (id,type,status,trackId,createdAt,updatedAt) VALUES ('s','race','finished','t',0,0);
      INSERT INTO Lap (id,carId,trackId,sessionId,controller,phase,lapNumber,lapTime) VALUES ('l','car','t','s',0,'race',1,10000.49);`);
    db.exec(fs.readFileSync(new URL('20261031200000_fuel_weight_timing/migration.sql', migrations), 'utf8'));
    expect(db.prepare('SELECT fuelWeightPercent,status FROM Session').get()).toEqual({
      fuelWeightPercent: 0,
      status: 'finished',
    });
    expect(db.prepare('SELECT lapTime,simulatedLapTime,fuelUnitsAtLap FROM Lap').get()).toEqual({
      lapTime: 10000.49,
      simulatedLapTime: null,
      fuelUnitsAtLap: null,
    });
  } finally {
    db.close();
  }
});

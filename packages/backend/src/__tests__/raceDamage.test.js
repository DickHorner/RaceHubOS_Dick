import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from './setup.js';
import { SessionService } from '../services/SessionService.js';
import sessionsRouter, { setSessionService } from '../routes/sessions.js';
import { DamageStatus, SessionStatus, SessionType, validDamageConfig } from '@racehubos/shared';

describe('race damage configuration', () => {
  test('a disabled threshold is valid, invalid limits and pit intervals are rejected', () => {
    const config = { damageLapThresholdMs: null, damageRepairSeconds: 60, damagePitSeconds: 5 };
    expect(validDamageConfig(config)).toBe(true);
    expect(validDamageConfig({ ...config, damageLapThresholdMs: 1000 })).toBe(true);
    expect(validDamageConfig({ ...config, damageLapThresholdMs: 600000 })).toBe(true);
    expect(validDamageConfig({ ...config, damageLapThresholdMs: 0 })).toBe(false);
    expect(validDamageConfig({ ...config, damageLapThresholdMs: 1000.5 })).toBe(false);
    expect(validDamageConfig({ ...config, damageLapThresholdMs: 600001 })).toBe(false);
    expect(validDamageConfig({ ...config, damageRepairSeconds: 4 })).toBe(false);
    expect(validDamageConfig({ ...config, damageRepairSeconds: 3601 })).toBe(false);
    expect(validDamageConfig({ ...config, damagePitSeconds: 0 })).toBe(false);
    expect(validDamageConfig({ ...config, damagePitSeconds: 301 })).toBe(false);
    expect(validDamageConfig({ ...config, damageRepairSeconds: 5, damagePitSeconds: 6 })).toBe(false);
  });
});

describe('persisted race damage and pit repairs', () => {
  let service;
  let now;

  async function fixture({
    type = SessionType.RACE,
    threshold = 12000,
    deadline = 60,
    minPit = 5,
    started = true,
  } = {}) {
    const track = await prisma.track.create({ data: { name: 'Damage test track' } });
    const car = await prisma.car.create({ data: { brand: 'Carrera', model: 'Damage test car' } });
    const driver = await prisma.driver.create({ data: { name: 'Damage test driver' } });
    const session = await prisma.session.create({
      data: {
        type,
        status: SessionStatus.ACTIVE,
        trackId: track.id,
        damageLapThresholdMs: threshold,
        damageRepairSeconds: deadline,
        damagePitSeconds: minPit,
        startedAt: started ? new Date(now - 5000) : null,
      },
    });
    const assignment = await prisma.sessionDriver.create({
      data: { sessionId: session.id, driverId: driver.id, carId: car.id, controller: 0 },
    });
    await service.loadSession(session.id);
    service.stopHeartbeat();
    service.syncService = {
      isConnected: jest.fn(() => true),
      stopRace: jest.fn().mockResolvedValue(),
      reset: jest.fn().mockResolvedValue(),
      getDevice: jest.fn(() => null),
    };
    return { track, car, driver, session, assignment };
  }

  function lap(ms = 13000, controller = 0, sector = 1) {
    return service.handleLap({ controller, timestamp: 0, lapTime: ms, sector });
  }

  async function pit({ duration = 6000, source = 'simulator', entered = now + 1000 } = {}) {
    const enteredAt = new Date(entered);
    const exitedAt = new Date(entered + duration);
    jest.spyOn(Date, 'now').mockReturnValue(entered + duration + 1000);
    return service.recordPitStop({ controller: 0, enteredAt, exitedAt, source });
  }

  beforeEach(async () => {
    now = Date.now();
    await prisma.trackRecord.deleteMany();
    await prisma.controllerConfig.deleteMany();
    await prisma.pitStop.deleteMany();
    await prisma.lap.deleteMany();
    await prisma.sessionDriver.deleteMany();
    await prisma.championshipParticipant.deleteMany();
    await prisma.session.deleteMany();
    await prisma.championship.deleteMany();
    await prisma.driver.deleteMany();
    await prisma.car.deleteMany();
    await prisma.track.deleteMany();
    await prisma.team.deleteMany();
    service = new SessionService({ emit: jest.fn() });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    service.stopHeartbeat();
    await service.prisma.$disconnect();
  });

  test('valid slow race lap triggers once; measured lap and standings stay unmodified', async () => {
    const { session, assignment } = await fixture();
    await lap(12000);
    expect((await prisma.sessionDriver.findUnique({ where: { id: assignment.id } })).damageStatus).toBe(DamageStatus.NONE);
    await lap(13000);
    await lap(15000);
    const driver = await prisma.sessionDriver.findUnique({ where: { id: assignment.id } });
    expect(driver).toMatchObject({
      damageStatus: DamageStatus.ACTIVE,
      damageLapNumber: 2,
      totalLaps: 3,
      totalTime: 40000,
      isDNF: false,
    });
    expect(driver.damageTriggeredAt).toBeTruthy();
    expect(driver.damageDeadlineElapsedMs).toBeGreaterThan(60000);
    expect((await prisma.lap.findMany({ where: { sessionId: session.id } })).map((row) => row.lapTime))
      .toEqual([12000, 13000, 15000]);
    expect(service.io.emit.mock.calls.filter(([event]) => event === 'session:damage_changed')).toHaveLength(1);
  });

  test('disabled, paused, finishing, no-GO, non-race and invalid laps cannot trigger damage', async () => {
    const { assignment } = await fixture({ threshold: null });
    await lap(300000);
    expect(service.getLeaderboard()[0].damageStatus).toBe(DamageStatus.NONE);

    service.sessionConfig.damageLapThresholdMs = 12000;
    service.sessionStatus = SessionStatus.PAUSED;
    await lap(13000);
    service.sessionStatus = SessionStatus.FINISHING;
    await lap(13000);
    service.sessionStatus = SessionStatus.ACTIVE;
    await lap(13000, 0, 2);
    await lap(0);
    await lap(Infinity);
    expect(service.getLeaderboard()[0].damageStatus).toBe(DamageStatus.NONE);
    expect((await prisma.sessionDriver.findUnique({ where: { id: assignment.id } })).damageStatus).toBe(DamageStatus.NONE);

    service.sessionConfig.startedAt = null;
    await lap(13000);
    expect(service.getLeaderboard()[0].damageStatus).toBe(DamageStatus.NONE);
    service.sessionConfig.startedAt = new Date(now - 5000);
    service.currentPhase = SessionType.QUALIF;
    await lap(13000);
    expect(service.getLeaderboard()[0].damageStatus).toBe(DamageStatus.NONE);
  });

  test('a sufficiently long confirmed simulator pit clears damage, with one audit result', async () => {
    const { assignment } = await fixture();
    await lap();
    await pit({ duration: 2000 });
    expect(service.getLeaderboard()[0].damageStatus).toBe(DamageStatus.ACTIVE);
    await pit({ duration: 6000 });
    const saved = await prisma.sessionDriver.findUnique({ where: { id: assignment.id } });
    expect(saved).toMatchObject({
      damageStatus: DamageStatus.REPAIRED,
      damageRepairSource: 'simulator',
      isDNF: false,
    });
    expect(saved.damageRepairPitStopId).toBeTruthy();
    expect(await prisma.pitStop.count()).toBe(2);
    await lap(18000);
    expect(service.getLeaderboard()[0].damageStatus).toBe(DamageStatus.REPAIRED);
    expect(service.io.emit.mock.calls.filter(([event]) => event === 'session:damage_changed')).toHaveLength(2);
  });

  test('CU pit bitmask observations cannot repair without director confirmation', async () => {
    const { session, assignment } = await fixture();
    await lap();
    const pitStop = await pit({ source: 'cu' });
    expect(service.getLeaderboard()[0].damageStatus).toBe(DamageStatus.ACTIVE);
    await expect(service.confirmDamageRepair(session.id, assignment.id, 'not-a-pit'))
      .rejects.toMatchObject({ status: 409 });
    const repair = await service.confirmDamageRepair(session.id, assignment.id, pitStop.id);
    expect(repair).toMatchObject({ damageStatus: DamageStatus.REPAIRED, damageRepairSource: 'director' });
    await expect(service.confirmDamageRepair(session.id, assignment.id, pitStop.id))
      .rejects.toMatchObject({ status: 409 });
    expect((await prisma.sessionDriver.findUnique({ where: { id: assignment.id } })).damageRepairPitStopId)
      .toBe(pitStop.id);
  });

  test('cross-session, wrong-driver, short and simulator pit evidence are rejected', async () => {
    const { session, assignment } = await fixture();
    await lap();
    const shortPit = await pit({ source: 'cu', duration: 1000 });
    await expect(service.confirmDamageRepair(session.id, assignment.id, shortPit.id))
      .rejects.toMatchObject({ status: 409 });
    const simPit = await pit({ source: 'simulator', duration: 1000 });
    await expect(service.confirmDamageRepair(session.id, assignment.id, simPit.id))
      .rejects.toMatchObject({ status: 409 });
    await expect(service.confirmDamageRepair('stale-session', assignment.id, shortPit.id))
      .rejects.toMatchObject({ status: 409 });
    await expect(service.confirmDamageRepair(session.id, 'wrong-driver', shortPit.id))
      .rejects.toMatchObject({ status: 409 });
    expect(service.getLeaderboard()[0].damageStatus).toBe(DamageStatus.ACTIVE);
  });

  test('an expired repair deadline persists DNF and stops counting new laps', async () => {
    const { session, assignment } = await fixture({ deadline: 10, minPit: 5 });
    await lap();
    const damage = await prisma.sessionDriver.findUnique({ where: { id: assignment.id } });
    jest.spyOn(Date, 'now').mockReturnValue(now + 11000);
    await service.expireDamage();
    const expired = await prisma.sessionDriver.findUnique({ where: { id: assignment.id } });
    expect(expired).toMatchObject({ damageStatus: DamageStatus.DNF, isDNF: true, totalLaps: 1 });
    expect(expired.damageDeadlineElapsedMs).toBe(damage.damageDeadlineElapsedMs);
    await lap();
    await service.expireDamage();
    expect(await prisma.lap.count({ where: { sessionId: session.id } })).toBe(1);
    expect(service.io.emit.mock.calls.filter(([event, data]) =>
      event === 'session:damage_changed' && data.damageStatus === DamageStatus.DNF
    )).toHaveLength(1);
  });

  test('open pauses freeze the clock; reloading preserves deadline and damage state', async () => {
    const { session, assignment } = await fixture({ deadline: 30 });
    await lap();
    const saved = await prisma.sessionDriver.findUnique({ where: { id: assignment.id } });
    const pauseStart = now + 2000;
    service.sessionConfig.pauses = [{ start: pauseStart, end: null }];
    service.sessionStatus = SessionStatus.PAUSED;
    await prisma.session.update({
      where: { id: session.id },
      data: { status: SessionStatus.PAUSED, pauses: JSON.stringify(service.sessionConfig.pauses) },
    });
    const later = now + 200000;
    jest.spyOn(Date, 'now').mockReturnValue(later);
    expect(service.raceClock().elapsedTime).toBe(7000);
    await service.expireDamage();
    expect(service.getLeaderboard()[0].damageStatus).toBe(DamageStatus.ACTIVE);

    const reload = new SessionService({ emit: jest.fn() });
    try {
      await reload.loadSession(session.id);
      reload.stopHeartbeat();
      expect(reload.getLeaderboard()[0]).toMatchObject({
        damageStatus: DamageStatus.ACTIVE,
        damageDeadlineElapsedMs: saved.damageDeadlineElapsedMs,
      });
      expect(reload.raceClock().elapsedTime).toBe(7000);
    } finally {
      await reload.prisma.$disconnect();
    }

    service.sessionConfig.pauses[0].end = later;
    service.sessionStatus = SessionStatus.ACTIVE;
    jest.spyOn(Date, 'now').mockReturnValue(later + 28000);
    await service.expireDamage();
    expect(service.getLeaderboard()[0].damageStatus).toBe(DamageStatus.DNF);
  });

  test('active damage becomes DNF if the race is stopped before repair', async () => {
    const { session, assignment } = await fixture();
    await lap();
    await service.finishSession('manual_stop');
    const saved = await prisma.sessionDriver.findUnique({ where: { id: assignment.id } });
    expect(saved).toMatchObject({ damageStatus: DamageStatus.DNF, isDNF: true });
    expect((await prisma.session.findUnique({ where: { id: session.id } })).status).toBe(SessionStatus.FINISHED);
  });

  test('reset clears the damage episode and does not change the configured limits', async () => {
    const { session, assignment } = await fixture();
    await lap();
    await service.resetSession(session.id);
    const row = await prisma.sessionDriver.findUnique({ where: { id: assignment.id } });
    expect(row).toMatchObject({
      damageStatus: DamageStatus.NONE,
      damageTriggeredAt: null,
      damageDeadlineElapsedMs: null,
      damageLapNumber: null,
      isDNF: false,
    });
    const reset = await prisma.session.findUnique({ where: { id: session.id } });
    expect(reset).toMatchObject({ damageLapThresholdMs: 12000, status: SessionStatus.DRAFT });
  });

  test('race damage never programs the physical CU speed or brake', async () => {
    const { session, assignment } = await fixture();
    const setSpeed = jest.fn();
    const setBrake = jest.fn();
    service.syncService.getDevice = () => ({ setSpeed, setBrake });
    await lap();
    await pit({ source: 'cu' });
    await service.confirmDamageRepair(session.id, assignment.id, (await prisma.pitStop.findFirst()).id);
    expect(setSpeed).not.toHaveBeenCalled();
    expect(setBrake).not.toHaveBeenCalled();
  });

  test('session create and update validate draft-only race damage settings', async () => {
    const track = await prisma.track.create({ data: { name: 'Config test track' } });
    await expect(service.createSession({
      type: SessionType.PRACTICE, trackId: track.id, damageLapThresholdMs: 20000,
    })).rejects.toThrow('Invalid race damage configuration');
    await expect(service.createSession({
      type: SessionType.RACE, trackId: track.id, damageLapThresholdMs: 20000,
      damageRepairSeconds: 5, damagePitSeconds: 6,
    })).rejects.toThrow('Invalid race damage configuration');
    const created = await service.createSession({ type: SessionType.RACE, trackId: track.id });
    const app = express();
    setSessionService(service);
    app.use(express.json());
    app.use('/api/sessions', sessionsRouter);
    await request(app).put(`/api/sessions/${created.id}`)
      .send({ damageLapThresholdMs: 30000, damageRepairSeconds: 20, damagePitSeconds: 5 }).expect(200);
    await request(app).put(`/api/sessions/${created.id}`)
      .send({ damagePitSeconds: 21 }).expect(400);
    const stored = await prisma.session.findUnique({ where: { id: created.id } });
    expect(stored).toMatchObject({ damageLapThresholdMs: 30000, damageRepairSeconds: 20, damagePitSeconds: 5 });
    await prisma.session.update({ where: { id: created.id }, data: { status: SessionStatus.ACTIVE } });
    await request(app).put(`/api/sessions/${created.id}`)
      .send({ damageLapThresholdMs: 25000 }).expect(409);
    await request(app).put(`/api/sessions/${created.id}`)
      .send({ damageLapThresholdMs: 30000 }).expect(200);
  });
});

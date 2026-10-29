import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import { prisma } from './setup.js';
import { SessionService } from '../services/SessionService.js';
import sessionsRouter, { setSessionService } from '../routes/sessions.js';
import raceControl, { setRaceControlServices } from '../routes/raceControl.js';
import { SessionStatus, SessionType } from '@racehubos/shared';

describe('one running session per race PC', () => {
  let service;
  let sync;
  let track;
  let app;
  const directorKey = 'session-recovery-test-director-key-2026';
  const previousSecret = process.env.RACE_CONTROL_SECRET;
  const previousRequirement = process.env.RACE_CONTROL_REQUIRE_KEY;

  async function session(name, type, status = SessionStatus.DRAFT, extra = {}) {
    return prisma.session.create({ data: { name, type, status, trackId: track.id, ...extra } });
  }

  beforeEach(async () => {
    process.env.RACE_CONTROL_SECRET = directorKey;
    process.env.RACE_CONTROL_REQUIRE_KEY = 'true';
    await prisma.trackRecord.deleteMany();
    await prisma.tyreChange.deleteMany();
    await prisma.virtualFuelEvent.deleteMany();
    await prisma.sessionPenalty.deleteMany();
    await prisma.pitStop.deleteMany();
    await prisma.lap.deleteMany();
    await prisma.sessionDriver.deleteMany();
    await prisma.session.deleteMany();
    await prisma.track.deleteMany();

    track = await prisma.track.create({ data: { name: 'Exclusivity test track' } });
    service = new SessionService({ emit: jest.fn() });
    sync = {
      isConnected: jest.fn(() => true),
      reset: jest.fn().mockResolvedValue(),
      prepareRace: jest.fn().mockResolvedValue(),
      stopRace: jest.fn().mockResolvedValue(),
      getDevice: jest.fn(() => null),
    };
    service.setSyncService(sync);
    service.startHeartbeat = jest.fn();
    setSessionService(service);
    setRaceControlServices(service, sync);
    app = express();
    app.use(express.json());
    app.use('/api/sessions', sessionsRouter);
    app.use('/api/race-control', raceControl);
  });

  afterEach(async () => {
    service.stopHeartbeat();
    await service.prisma.$disconnect();
    if (previousSecret === undefined) delete process.env.RACE_CONTROL_SECRET;
    else process.env.RACE_CONTROL_SECRET = previousSecret;
    if (previousRequirement === undefined) delete process.env.RACE_CONTROL_REQUIRE_KEY;
    else process.env.RACE_CONTROL_REQUIRE_KEY = previousRequirement;
    jest.restoreAllMocks();
  });

  test('running free practice blocks championship start before any CU action', async () => {
    const practice = await session('Free practice', SessionType.PRACTICE, SessionStatus.ACTIVE);
    const race = await session('Championship heat', SessionType.RACE);
    service.activeSessionId = practice.id;
    service.sessionStatus = SessionStatus.ACTIVE;
    service.sessionDrivers = [{ id: 'still-racing', totalLaps: 12 }];

    await request(app).get(`/api/sessions/${race.id}`).expect(200);
    const rejected = await request(app).post(`/api/sessions/${race.id}/start`).expect(409);

    expect(rejected.body.error).toContain('Free practice');
    expect(rejected.body.runningSessions).toEqual([
      expect.objectContaining({ id: practice.id, name: 'Free practice', status: SessionStatus.ACTIVE }),
    ]);
    expect(service.activeSessionId).toBe(practice.id);
    expect(service.sessionDrivers).toEqual([{ id: 'still-racing', totalLaps: 12 }]);
    expect(sync.reset).not.toHaveBeenCalled();
    expect(sync.prepareRace).not.toHaveBeenCalled();
    expect((await prisma.session.findUnique({ where: { id: race.id } })).status).toBe(SessionStatus.DRAFT);
    expect((await prisma.session.findUnique({ where: { id: practice.id } })).status).toBe(SessionStatus.ACTIVE);
  });

  test('loading another draft cannot overwrite the running session or telemetry', async () => {
    const practice = await session('Practice', SessionType.PRACTICE, SessionStatus.ACTIVE);
    const draft = await session('Next race', SessionType.RACE);
    service.activeSessionId = practice.id;
    service.sessionStatus = SessionStatus.ACTIVE;
    service.sessionDrivers = [{ id: 'driver-1', totalLaps: 8 }];
    service.currentPhase = SessionType.PRACTICE;

    await expect(service.loadSession(draft.id)).rejects.toMatchObject({ status: 409 });
    expect(service.activeSessionId).toBe(practice.id);
    expect(service.sessionDrivers).toEqual([{ id: 'driver-1', totalLaps: 8 }]);
    expect(service.currentPhase).toBe(SessionType.PRACTICE);
    expect(sync.reset).not.toHaveBeenCalled();
  });

  test('two simultaneous starts produce only one CU start sequence and one active database row', async () => {
    const first = await session('First', SessionType.PRACTICE);
    const second = await session('Second', SessionType.RACE);
    let enteredPrepare;
    let completePrepare;
    const preparing = new Promise((resolve) => {
      enteredPrepare = resolve;
    });
    sync.prepareRace.mockImplementation(
      () =>
        new Promise((resolve) => {
          completePrepare = resolve;
          enteredPrepare();
        })
    );

    const firstStart = service.startSession(first.id);
    await preparing;
    await expect(service.startSession(second.id)).rejects.toMatchObject({ status: 409 });
    expect(sync.reset).toHaveBeenCalledTimes(1);
    expect(sync.prepareRace).toHaveBeenCalledTimes(1);
    completePrepare();
    await firstStart;

    expect(service.activeSessionId).toBe(first.id);
    expect((await prisma.session.findUnique({ where: { id: first.id } })).status).toBe(SessionStatus.ACTIVE);
    expect((await prisma.session.findUnique({ where: { id: second.id } })).status).toBe(SessionStatus.DRAFT);
    expect(service.startingSessionId).toBeNull();
  });

  test('loading a draft and starting another session cannot overlap', async () => {
    const draft = await session('Being opened', SessionType.PRACTICE);
    const race = await session('Being started', SessionType.RACE);
    let enterLoad;
    let completeLoad;
    const loading = new Promise((resolve) => {
      enterLoad = resolve;
    });
    service.loadSessionData = jest.fn(
      () =>
        new Promise((resolve) => {
          completeLoad = resolve;
          enterLoad();
        })
    );

    const firstLoad = service.loadSession(draft.id);
    await loading;
    await expect(service.startSession(race.id)).rejects.toMatchObject({ status: 409 });
    expect(sync.reset).not.toHaveBeenCalled();
    completeLoad({ id: draft.id, type: draft.type });
    await firstLoad;
    expect(service.loadingSessionId).toBeNull();
  });

  test('stale stop, pause, resume and status requests cannot operate on the current CU session', async () => {
    const old = await session('Stale practice', SessionType.PRACTICE, SessionStatus.ACTIVE);
    const current = await session('Current race', SessionType.RACE, SessionStatus.ACTIVE);
    service.activeSessionId = current.id;
    service.sessionStatus = SessionStatus.ACTIVE;
    service.finishSession = jest.fn();

    await request(app).post(`/api/sessions/${old.id}/stop`).expect(409);
    await request(app).post(`/api/sessions/${old.id}/pause`).expect(409);
    await request(app).patch(`/api/sessions/${old.id}/status`).send({ status: SessionStatus.FINISHED }).expect(409);
    await prisma.session.update({ where: { id: old.id }, data: { status: SessionStatus.PAUSED } });
    await request(app).post(`/api/sessions/${old.id}/resume`).expect(409);

    expect(sync.stopRace).not.toHaveBeenCalled();
    expect(sync.prepareRace).not.toHaveBeenCalled();
    expect(service.finishSession).not.toHaveBeenCalled();
    expect(service.activeSessionId).toBe(current.id);
    expect((await prisma.session.findUnique({ where: { id: current.id } })).status).toBe(SessionStatus.ACTIVE);
  });

  test('restart with multiple running database rows is diagnosed without choosing one', async () => {
    const first = await session('Orphan practice', SessionType.PRACTICE, SessionStatus.ACTIVE);
    await session('Orphan heat', SessionType.RACE, SessionStatus.PAUSED);
    const next = await session('Draft', SessionType.RACE);

    await expect(service.loadSession(first.id)).rejects.toMatchObject({ status: 409 });
    const error = await request(app).post(`/api/sessions/${next.id}/start`).expect(409);
    expect(error.body.runningSessions).toHaveLength(2);
    expect(service.activeSessionId).toBeNull();
    expect(sync.reset).not.toHaveBeenCalled();
    expect(sync.prepareRace).not.toHaveBeenCalled();
  });

  test('after restart the sole running database session can be reloaded, never replaced', async () => {
    const previous = await session('Restarted race', SessionType.RACE, SessionStatus.PAUSED);
    const next = await session('Draft', SessionType.PRACTICE);

    await expect(service.loadSession(previous.id)).resolves.toMatchObject({ id: previous.id });
    expect(service.activeSessionId).toBe(previous.id);
    expect(service.sessionStatus).toBe(SessionStatus.PAUSED);
    await request(app).post(`/api/sessions/${next.id}/start`).expect(409);
    expect(sync.reset).not.toHaveBeenCalled();
  });

  test('resetting an unrelated draft does not stop a live practice', async () => {
    const practice = await session('Practice', SessionType.PRACTICE, SessionStatus.ACTIVE);
    const draft = await session('Draft', SessionType.RACE);
    service.activeSessionId = practice.id;
    service.sessionStatus = SessionStatus.ACTIVE;

    await request(app).post(`/api/sessions/${draft.id}/reset`).expect(200);

    expect(service.activeSessionId).toBe(practice.id);
    expect(sync.stopRace).not.toHaveBeenCalled();
    expect(sync.reset).not.toHaveBeenCalled();
    expect((await prisma.session.findUnique({ where: { id: practice.id } })).status).toBe(SessionStatus.ACTIVE);
  });

  test('an orphan running session cannot be reset, restored or created as an active shortcut', async () => {
    const orphan = await session('Orphan', SessionType.RACE, SessionStatus.FINISHING);
    const deleted = await session('Deleted running', SessionType.RACE, SessionStatus.ACTIVE, {
      deletedAt: new Date(),
    });

    await request(app).post(`/api/sessions/${orphan.id}/reset`).expect(409);
    await request(app).patch(`/api/sessions/${deleted.id}/restore`).expect(409);
    await expect(
      service.createSession({ trackId: track.id, type: SessionType.RACE, status: SessionStatus.ACTIVE })
    ).rejects.toMatchObject({ status: 400 });
    expect(sync.reset).not.toHaveBeenCalled();
    expect(sync.stopRace).not.toHaveBeenCalled();
    expect((await prisma.session.findUnique({ where: { id: orphan.id } })).status).toBe(SessionStatus.FINISHING);
    expect((await prisma.session.findUnique({ where: { id: deleted.id } })).deletedAt).not.toBeNull();
  });

  test('director explicitly resolves two old running rows without deleting laps or finishing a race', async () => {
    const first = await session('Old practice', SessionType.PRACTICE, SessionStatus.ACTIVE, {
      startedAt: new Date(1000),
    });
    const second = await session('Old heat', SessionType.RACE, SessionStatus.PAUSED);
    const next = await session('Next race', SessionType.RACE);
    const driver = await prisma.driver.create({ data: { name: 'Recovery driver' } });
    const car = await prisma.car.create({ data: { brand: 'Carrera', model: 'Recovery car' } });
    const entry = await prisma.sessionDriver.create({
      data: { sessionId: first.id, driverId: driver.id, carId: car.id, controller: 0, totalLaps: 1, totalTime: 10000 },
    });
    const lap = await prisma.lap.create({
      data: {
        sessionId: first.id,
        trackId: track.id,
        driverId: driver.id,
        carId: car.id,
        controller: 0,
        phase: SessionType.PRACTICE,
        lapNumber: 1,
        lapTime: 10000,
      },
    });
    const pit = await prisma.pitStop.create({
      data: {
        sessionId: first.id,
        sessionDriverId: entry.id,
        controller: 0,
        enteredAt: new Date(1000),
        exitedAt: new Date(2000),
        durationMs: 1000,
        source: 'cu',
      },
    });
    const finished = jest.spyOn(service, 'finishSession');
    const listing = await request(app)
      .get('/api/race-control/director/session-recovery')
      .set('Authorization', `Bearer ${directorKey}`)
      .expect(200);
    expect(listing.body.data.boundSessionId).toBeNull();
    expect(listing.body.data.sessions.map((row) => row.id)).toEqual([first.id, second.id]);

    const recover = (row) =>
      request(app)
        .post(`/api/race-control/director/session-recovery/${row.id}`)
        .set('Authorization', `Bearer ${directorKey}`)
        .send({ confirmed: true, expectedStatus: row.status });
    const result = await recover(first).expect(200);
    expect(result.body.data).toMatchObject({
      sessionId: first.id,
      status: SessionStatus.INTERRUPTED,
      recoveredFromStatus: SessionStatus.ACTIVE,
    });
    expect(result.body.data.recoveredAt).toBeTruthy();
    const corrected = await prisma.session.findUnique({ where: { id: first.id } });
    expect(corrected).toMatchObject({
      status: SessionStatus.INTERRUPTED,
      startedAt: first.startedAt,
      finishedAt: null,
      deletedAt: null,
      recoveredFromStatus: SessionStatus.ACTIVE,
    });
    expect(corrected.recoveredAt).toBeInstanceOf(Date);
    expect(await prisma.sessionDriver.findUnique({ where: { id: entry.id } })).toEqual(entry);
    expect(await prisma.lap.findUnique({ where: { id: lap.id } })).toEqual(lap);
    expect(await prisma.pitStop.findUnique({ where: { id: pit.id } })).toEqual(pit);
    expect(service.activeSessionId).toBeNull();
    expect(finished).not.toHaveBeenCalled();
    expect(sync.reset).not.toHaveBeenCalled();
    expect(sync.stopRace).not.toHaveBeenCalled();
    expect(service.io.emit).toHaveBeenCalledWith(
      'session:status_changed',
      expect.objectContaining({ sessionId: first.id, status: SessionStatus.INTERRUPTED })
    );
    expect(service.io.emit).not.toHaveBeenCalledWith('session:finished', expect.anything());

    const blocked = await request(app).post(`/api/sessions/${next.id}/start`).expect(409);
    expect(blocked.body.recoveryUrl).toBe('/display/control#session-recovery');
    await recover(second).expect(200);
    await request(app).post(`/api/sessions/${next.id}/start`).expect(200);
    expect(service.activeSessionId).toBe(next.id);
  });

  test('recovery never touches the bound session, even with disconnected CU or non-running memory status', async () => {
    const bound = await session('Bound', SessionType.RACE, SessionStatus.ACTIVE);
    const other = await session('Unbound', SessionType.PRACTICE, SessionStatus.PAUSED);
    const deleted = await session('Deleted', SessionType.RACE, SessionStatus.ACTIVE, { deletedAt: new Date() });
    service.activeSessionId = bound.id;
    service.sessionStatus = SessionStatus.DRAFT;
    service.sessionDrivers = [{ id: 'current-telemetry', totalLaps: 12 }];
    sync.isConnected.mockReturnValue(false);
    await expect(service.recoverSession(bound.id, SessionStatus.ACTIVE)).rejects.toMatchObject({ status: 409 });
    const listing = await service.getSessionRecovery();
    expect(listing.boundSessionId).toBe(bound.id);
    expect(listing.sessions.map((row) => row.id)).toEqual([bound.id, other.id]);
    await expect(service.recoverSession(deleted.id, SessionStatus.ACTIVE)).rejects.toMatchObject({ status: 404 });
    await expect(service.recoverSession('missing', SessionStatus.ACTIVE)).rejects.toMatchObject({ status: 404 });
    await expect(service.recoverSession(other.id, SessionStatus.ACTIVE)).rejects.toMatchObject({ status: 409 });
    await service.recoverSession(other.id, SessionStatus.PAUSED);
    await expect(service.recoverSession(other.id, SessionStatus.PAUSED)).rejects.toMatchObject({ status: 409 });
    expect((await prisma.session.findUnique({ where: { id: bound.id } })).status).toBe(SessionStatus.ACTIVE);
    expect(service.sessionDrivers).toEqual([{ id: 'current-telemetry', totalLaps: 12 }]);
    expect(service.activeSessionId).toBe(bound.id);
    expect(sync.reset).not.toHaveBeenCalled();
    expect(sync.stopRace).not.toHaveBeenCalled();
  });

  test('recovery requires director authorization, confirmation and an expected running status', async () => {
    const orphan = await session('Orphan', SessionType.RACE, SessionStatus.ACTIVE);
    const driver = await prisma.driver.create({ data: { name: 'Scoped recovery test driver' } });
    await prisma.sessionDriver.create({ data: { sessionId: orphan.id, driverId: driver.id, controller: 0 } });
    const issued = await request(app)
      .post('/api/race-control/driver-link')
      .set('Authorization', `Bearer ${directorKey}`)
      .send({ sessionId: orphan.id, driverId: driver.id })
      .expect(200);
    const url = `/api/race-control/director/session-recovery/${orphan.id}`;
    await request(app).get('/api/race-control/director/session-recovery').expect(403);
    await request(app).post(url).send({ confirmed: true, expectedStatus: orphan.status }).expect(403);
    await request(app)
      .post(url)
      .set('Authorization', `Bearer ${issued.body.token}`)
      .send({ confirmed: true, expectedStatus: orphan.status })
      .expect(403);
    await request(app)
      .post(url)
      .set('Authorization', `Bearer ${directorKey}`)
      .send({ expectedStatus: orphan.status })
      .expect(400);
    await request(app)
      .post(url)
      .set('Authorization', `Bearer ${directorKey}`)
      .send({ confirmed: true, expectedStatus: SessionStatus.FINISHED })
      .expect(400);
    expect((await prisma.session.findUnique({ where: { id: orphan.id } })).status).toBe(SessionStatus.ACTIVE);
    process.env.RACE_CONTROL_REQUIRE_KEY = 'false';
    await request(app).post(url).send({ confirmed: true, expectedStatus: orphan.status }).expect(200);
  });

  test('recovery serializes with starts, loads, resets and other recovery attempts', async () => {
    const orphan = await session('Old', SessionType.RACE, SessionStatus.ACTIVE);
    const draft = await session('New', SessionType.PRACTICE);
    const find = service.prisma.session.findUnique.bind(service.prisma.session);
    let entered;
    let release;
    const reading = new Promise((resolve) => {
      entered = resolve;
    });
    jest.spyOn(service.prisma.session, 'findUnique').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = async () => resolve(await find({ where: { id: orphan.id } }));
          entered();
        })
    );
    const recovery = service.recoverSession(orphan.id, orphan.status);
    await reading;
    await expect(service.startSession(draft.id)).rejects.toMatchObject({ status: 409 });
    await expect(service.loadSession(draft.id)).rejects.toMatchObject({ status: 409 });
    await expect(service.resetSession(orphan.id)).rejects.toMatchObject({ status: 409 });
    await expect(service.recoverSession(orphan.id, orphan.status)).rejects.toMatchObject({ status: 409 });
    await release();
    await recovery;
    expect(service.recoveringSessionId).toBeNull();
    expect(sync.reset).not.toHaveBeenCalled();
    expect(sync.prepareRace).not.toHaveBeenCalled();
  });

  test.each(['startingSessionId', 'loadingSessionId', 'resettingSessionId'])(
    'recovery refuses an in-flight %s',
    async (field) => {
      const orphan = await session('Old', SessionType.RACE, SessionStatus.ACTIVE);
      service[field] = 'some-session';
      await expect(service.recoverSession(orphan.id, orphan.status)).rejects.toMatchObject({ status: 409 });
      expect((await prisma.session.findUnique({ where: { id: orphan.id } })).status).toBe(SessionStatus.ACTIVE);
      service[field] = null;
    }
  );

  test('a failed backup preserves the row and releases the recovery lock', async () => {
    const orphan = await session('Old', SessionType.RACE, SessionStatus.PAUSED);
    const mkdir = jest.spyOn(fs, 'mkdirSync').mockImplementationOnce(() => {
      throw new Error('backup unavailable');
    });
    await expect(service.recoverSession(orphan.id, orphan.status)).rejects.toThrow('backup unavailable');
    expect(service.recoveringSessionId).toBeNull();
    expect((await prisma.session.findUnique({ where: { id: orphan.id } })).status).toBe(SessionStatus.PAUSED);
    expect(service.io.emit).not.toHaveBeenCalled();
    mkdir.mockRestore();
    await service.recoverSession(orphan.id, orphan.status);
  });

  test('a database status change between lookup and correction is never overwritten', async () => {
    const orphan = await session('Old', SessionType.RACE, SessionStatus.ACTIVE);
    const update = service.prisma.session.updateMany.bind(service.prisma.session);
    jest.spyOn(service.prisma.session, 'updateMany').mockImplementationOnce(async (args) => {
      await prisma.session.update({ where: { id: orphan.id }, data: { status: SessionStatus.PAUSED } });
      return update(args);
    });
    await expect(service.recoverSession(orphan.id, orphan.status)).rejects.toMatchObject({ status: 409 });
    expect(await prisma.session.findUnique({ where: { id: orphan.id } })).toMatchObject({
      status: SessionStatus.PAUSED,
      recoveredAt: null,
    });
    expect(service.recoveringSessionId).toBeNull();
    expect(service.io.emit).not.toHaveBeenCalled();
  });
});

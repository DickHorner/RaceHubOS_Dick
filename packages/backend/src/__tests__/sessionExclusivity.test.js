import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from './setup.js';
import { SessionService } from '../services/SessionService.js';
import sessionsRouter, { setSessionService } from '../routes/sessions.js';
import { SessionStatus, SessionType } from '@racehubos/shared';

describe('one running session per race PC', () => {
  let service;
  let sync;
  let track;
  let app;

  async function session(name, type, status = SessionStatus.DRAFT, extra = {}) {
    return prisma.session.create({ data: { name, type, status, trackId: track.id, ...extra } });
  }

  beforeEach(async () => {
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
    app = express();
    app.use(express.json());
    app.use('/api/sessions', sessionsRouter);
  });

  afterEach(async () => {
    service.stopHeartbeat();
    await service.prisma.$disconnect();
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
});

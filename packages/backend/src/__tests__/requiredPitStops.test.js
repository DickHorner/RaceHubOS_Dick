import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { requiredPitProgress, validRequiredPitStops } from '@racehubos/shared';
import { prisma } from './setup.js';
import { SessionService } from '../services/SessionService.js';
import sessions, { setSessionService } from '../routes/sessions.js';

const stop = {
  id: 'pit-1',
  sessionId: 'session-1',
  sessionDriverId: 'entry-1',
  source: 'simulator',
  enteredAt: '2026-10-29T12:00:00Z',
  exitedAt: '2026-10-29T12:00:02Z',
  durationMs: 2000,
};

test('only unique, persisted completed simulator cycles fulfil the own session/assignment requirement', () => {
  const session = {
    id: 'session-1',
    requiredPitStops: 2,
    pitStops: [
      stop,
      stop,
      { ...stop, id: 'cu', source: 'cu' },
      { ...stop, id: 'foreign-driver', sessionDriverId: 'other' },
      { ...stop, id: 'foreign-session', sessionId: 'other' },
      { ...stop, id: 'open', exitedAt: null },
      { ...stop, id: 'wrong-time', durationMs: 1000 },
      { ...stop, id: 'negative', durationMs: -1 },
      { ...stop, id: 'unknown', source: 'unknown' },
      { ...stop, id: null },
    ],
  };
  expect(requiredPitProgress(session, 'entry-1')).toEqual({ required: 2, completed: 1, remaining: 1 });
  session.pitStops.push({ ...stop, id: 'pit-2' }, { ...stop, id: 'pit-3' });
  expect(requiredPitProgress(session, 'entry-1')).toEqual({ required: 2, completed: 3, remaining: 0 });
  expect(requiredPitProgress({ ...session, startedAt: '2026-10-29T12:01:00Z' }, 'entry-1').completed).toBe(0);
  expect(requiredPitProgress({ id: 'legacy' }, 'entry-1')).toEqual({ required: 0, completed: 0, remaining: 0 });
  for (const value of [-1, 1.5, 101, null, '2', Infinity]) expect(validRequiredPitStops(value)).toBe(false);
  for (const value of [0, 2, 100]) expect(validRequiredPitStops(value)).toBe(true);
});

describe('persisted session pit-stop requirement', () => {
  let service;
  let app;
  let track;
  beforeEach(async () => {
    await prisma.session.deleteMany();
    service = new SessionService({ emit: jest.fn() });
    setSessionService(service);
    app = express();
    app.use(express.json());
    app.use('/api/sessions', sessions);
    track = await prisma.track.create({ data: { name: 'Required pit test' } });
  });
  afterEach(async () => {
    service.stopHeartbeat();
    await service.prisma.$disconnect();
    jest.restoreAllMocks();
  });

  test('creation defaults to zero; free and championship sessions persist a validated minimum', async () => {
    const legacy = await service.createSession({ trackId: track.id, type: 'practice' });
    expect(legacy.requiredPitStops).toBe(0);
    const cup = await prisma.championship.create({ data: { name: 'Pit cup', season: '2026', trackId: track.id } });
    for (const championshipId of [null, cup.id]) {
      const created = await request(app)
        .post('/api/sessions')
        .send({ trackId: track.id, championshipId, type: 'race', requiredPitStops: 2 })
        .expect(201);
      const id = created.body.data.id;
      expect((await request(app).get(`/api/sessions/${id}`).expect(200)).body.data.requiredPitStops).toBe(2);
      for (const count of [-1, 1.5, 101, null, '2']) {
        await request(app).put(`/api/sessions/${id}`).send({ requiredPitStops: count }).expect(400);
        await request(app)
          .post('/api/sessions')
          .send({ trackId: track.id, type: 'race', requiredPitStops: count })
          .expect(400);
      }
      for (const count of [100, 0, 1]) {
        const changed = await request(app).put(`/api/sessions/${id}`).send({ requiredPitStops: count }).expect(200);
        expect(changed.body.data.requiredPitStops).toBe(count);
      }
    }
  });

  test('the minimum is locked after start and an intervening start atomically prevents a draft write', async () => {
    const session = await service.createSession({ trackId: track.id, type: 'race', requiredPitStops: 2 });
    for (const status of ['active', 'paused', 'finishing', 'finished', 'interrupted']) {
      await prisma.session.update({ where: { id: session.id }, data: { status } });
      await request(app).put(`/api/sessions/${session.id}`).send({ requiredPitStops: 0 }).expect(409);
    }
    await prisma.session.update({ where: { id: session.id }, data: { status: 'draft' } });
    const update = service.prisma.session.update.bind(service.prisma.session);
    jest.spyOn(service.prisma.session, 'update').mockImplementationOnce(async (args) => {
      await prisma.session.update({ where: { id: session.id }, data: { status: 'active' } });
      return update(args);
    });
    await request(app).put(`/api/sessions/${session.id}`).send({ requiredPitStops: 3 }).expect(409);
    expect((await prisma.session.findUnique({ where: { id: session.id } })).requiredPitStops).toBe(2);
    await request(app).put('/api/sessions/missing').send({ requiredPitStops: 2 }).expect(404);
  });

  test('persisted stop evidence survives reload; CU stops do not fulfil the minimum and reset retains the rule', async () => {
    const session = await service.createSession({ trackId: track.id, type: 'race', requiredPitStops: 2 });
    const driver = await prisma.driver.create({ data: { name: 'Pit driver' } });
    const car = await prisma.car.create({ data: { brand: 'Carrera', model: 'Test' } });
    const assigned = await prisma.sessionDriver.create({
      data: { sessionId: session.id, controller: 0, driverId: driver.id, carId: car.id },
    });
    await prisma.session.update({ where: { id: session.id }, data: { status: 'active' } });
    await service.loadSession(session.id);
    for (const source of ['simulator', 'cu'])
      await service.recordPitStop({
        controller: 0,
        enteredAt: new Date(Date.now() - 4000),
        exitedAt: new Date(Date.now() - 2000),
        source,
      });
    const read = async () => (await request(app).get(`/api/sessions/${session.id}`).expect(200)).body.data;
    expect(requiredPitProgress(await read(), assigned.id)).toEqual({ required: 2, completed: 1, remaining: 1 });
    await service.loadSession(session.id);
    expect(requiredPitProgress(await read(), assigned.id).remaining).toBe(1);
    await service.resetSession(session.id);
    const reset = await read();
    expect(reset.pitStops).toHaveLength(2);
    expect(reset.status).toBe('draft');
    expect(reset.startedAt).toBeNull();
    expect(requiredPitProgress(reset, assigned.id)).toEqual({ required: 2, completed: 0, remaining: 2 });
    await prisma.session.update({
      where: { id: session.id },
      data: { status: 'active', startedAt: new Date(Date.now() - 1500) },
    });
    await service.loadSession(session.id);
    await service.recordPitStop({
      controller: 0,
      source: 'simulator',
      enteredAt: new Date(Date.now() - 1000),
      exitedAt: new Date(Date.now() - 100),
    });
    const restarted = await read();
    expect(restarted.pitStops).toHaveLength(3);
    expect(requiredPitProgress(restarted, assigned.id)).toEqual({ required: 2, completed: 1, remaining: 1 });
  });
});

import { jest } from '@jest/globals';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { prisma } from './setup.js';
import { SessionService } from '../services/SessionService.js';
import { PenaltyKind, PenaltyStatus, rankRaceDrivers } from '@racehubos/shared';

const requestId = (number) => `penalty-request-${number}`;

async function makeRace(status = 'finished') {
  const track = await prisma.track.create({ data: { name: 'Penalty test track' } });
  const car = await prisma.car.create({ data: { brand: 'Carrera', model: 'Test car' } });
  const firstDriver = await prisma.driver.create({ data: { name: 'Driver A' } });
  const secondDriver = await prisma.driver.create({ data: { name: 'Driver B' } });
  const session = await prisma.session.create({
    data: { type: 'race', status, trackId: track.id },
  });
  const first = await prisma.sessionDriver.create({
    data: {
      sessionId: session.id,
      driverId: firstDriver.id,
      carId: car.id,
      controller: 0,
      totalLaps: 10,
      totalTime: 100000,
      finalPos: 1,
    },
  });
  const second = await prisma.sessionDriver.create({
    data: {
      sessionId: session.id,
      driverId: secondDriver.id,
      carId: car.id,
      controller: 1,
      totalLaps: 10,
      totalTime: 105000,
      finalPos: 2,
    },
  });
  const lap = await prisma.lap.create({
    data: {
      sessionId: session.id,
      trackId: track.id,
      carId: car.id,
      driverId: firstDriver.id,
      controller: 0,
      phase: 'race',
      lapNumber: 1,
      lapTime: 10000,
    },
  });
  return { session, first, second, lap };
}

describe('deterministic race classification with penalties', () => {
  const a = { id: 'a', controller: 0, totalLaps: 10, totalTime: 100000, isDNF: false };
  const b = { id: 'b', controller: 1, totalLaps: 10, totalTime: 105000, isDNF: false };
  const penalty = (kind, amount, status = PenaltyStatus.ACTIVE) => ({
    sessionDriverId: 'a',
    kind,
    amount,
    status,
  });

  test('time penalty changes rank without modifying raw lap or total time', () => {
    const ranked = rankRaceDrivers([a, b], [penalty(PenaltyKind.TIME, 10000)]);
    expect(ranked.map((row) => row.id)).toEqual(['b', 'a']);
    expect(ranked[1]).toMatchObject({
      totalTime: 100000,
      classifiedTime: 110000,
      penaltyTimeMs: 10000,
    });
    expect(a.totalTime).toBe(100000);
  });

  test('lap deductions accumulate but cannot make classified laps negative', () => {
    const ranked = rankRaceDrivers([a, b], [penalty(PenaltyKind.LAP, 7), penalty(PenaltyKind.LAP, 8)]);
    expect(ranked.map((row) => row.id)).toEqual(['b', 'a']);
    expect(ranked[1]).toMatchObject({ totalLaps: 10, classifiedLaps: 0, penaltyLaps: 15 });
  });

  test('revoked penalties are ignored and equal results have a stable controller tie-break', () => {
    const ranked = rankRaceDrivers(
      [b, { ...a, totalTime: 105000 }],
      [penalty(PenaltyKind.TIME, 20000, PenaltyStatus.REVOKED)]
    );
    expect(ranked.map((row) => row.controller)).toEqual([0, 1]);
  });

  test('DNF remains behind a classified driver even with more completed laps', () => {
    const ranked = rankRaceDrivers([{ ...a, totalLaps: 20, isDNF: true }, b], []);
    expect(ranked.map((row) => row.id)).toEqual(['b', 'a']);
  });
});

describe('persistent director penalties and audit', () => {
  let service;

  beforeEach(async () => {
    await prisma.sessionPenalty.deleteMany();
    await prisma.lap.deleteMany();
    await prisma.sessionDriver.deleteMany();
    await prisma.session.deleteMany();
    await prisma.driver.deleteMany();
    await prisma.car.deleteMany();
    await prisma.track.deleteMany();
    service = new SessionService({ emit: jest.fn() });
  });

  afterEach(async () => {
    await service.prisma.$disconnect();
  });

  test('issues and revokes a finished-race penalty, preserving the lap and raw times', async () => {
    const race = await makeRace();
    const issued = await service.issuePenalty({
      sessionId: race.session.id,
      sessionDriverId: race.first.id,
      kind: PenaltyKind.TIME,
      amount: 8000,
      reason: 'Unsafe overtake',
      requestId: requestId(1),
    });
    expect(issued).toMatchObject({
      sessionDriverId: race.first.id,
      driverId: race.first.driverId,
      controller: 0,
      status: PenaltyStatus.ACTIVE,
      amount: 8000,
    });
    const [first, second] = await Promise.all([
      prisma.sessionDriver.findUnique({ where: { id: race.first.id } }),
      prisma.sessionDriver.findUnique({ where: { id: race.second.id } }),
    ]);
    expect([first.finalPos, second.finalPos]).toEqual([2, 1]);
    expect([first.totalLaps, first.totalTime]).toEqual([10, 100000]);
    expect(await prisma.lap.findUnique({ where: { id: race.lap.id } })).toMatchObject({
      lapNumber: 1,
      lapTime: 10000,
    });

    const replay = new SessionService({ emit: jest.fn() });
    try {
      await replay.loadSession(race.session.id);
      expect(replay.getLeaderboard().map((row) => row.id)).toEqual([race.second.id, race.first.id]);
    } finally {
      await replay.prisma.$disconnect();
    }

    const revoked = await service.revokePenalty(race.session.id, issued.id);
    expect(revoked).toMatchObject({ id: issued.id, status: PenaltyStatus.REVOKED });
    expect(revoked.revokedAt).toBeInstanceOf(Date);
    expect(await prisma.sessionPenalty.findMany({ where: { sessionId: race.session.id } })).toHaveLength(1);
    const positions = await prisma.sessionDriver.findMany({
      where: { sessionId: race.session.id },
      orderBy: { controller: 'asc' },
    });
    expect(positions.map((row) => row.finalPos)).toEqual([1, 2]);
    expect((await prisma.lap.findUnique({ where: { id: race.lap.id } })).lapTime).toBe(10000);
  });

  test('refuses duplicate requests and does not create a second audit record', async () => {
    const race = await makeRace();
    const input = {
      sessionId: race.session.id,
      sessionDriverId: race.first.id,
      kind: PenaltyKind.LAP,
      amount: 1,
      reason: 'False start',
      requestId: requestId(2),
    };
    await service.issuePenalty(input);
    await expect(service.issuePenalty(input)).rejects.toMatchObject({ status: 409 });
    expect(await prisma.sessionPenalty.count({ where: { sessionId: race.session.id } })).toBe(1);
  });

  test('rejects invalid sizes, draft races and unrelated driver assignments', async () => {
    const race = await makeRace();
    const input = {
      sessionId: race.session.id,
      sessionDriverId: race.first.id,
      kind: PenaltyKind.TIME,
      amount: 0,
      reason: 'Unsafe overtake',
      requestId: requestId(3),
    };
    await expect(service.issuePenalty(input)).rejects.toMatchObject({ status: 400 });
    await expect(service.issuePenalty({ ...input, amount: 3600001 })).rejects.toMatchObject({ status: 400 });
    await expect(service.issuePenalty({ ...input, amount: 1000, sessionDriverId: 'wrong-id' })).rejects.toMatchObject({
      status: 409,
    });
    await prisma.session.update({ where: { id: race.session.id }, data: { status: 'draft' } });
    await expect(service.issuePenalty({ ...input, amount: 1000 })).rejects.toMatchObject({ status: 409 });
    expect(await prisma.sessionPenalty.count()).toBe(0);
  });

  test('live race standings update without reducing the actual lap counter', async () => {
    const race = await makeRace('active');
    await service.loadSession(race.session.id);
    const issued = await service.issuePenalty({
      sessionId: race.session.id,
      sessionDriverId: race.first.id,
      kind: PenaltyKind.LAP,
      amount: 1,
      reason: 'Track limits',
      requestId: requestId(4),
    });
    expect(service.getLeaderboard()[0].id).toBe(race.second.id);
    expect(service.getLeaderboard().find((row) => row.id === race.first.id)).toMatchObject({
      totalLaps: 10,
      classifiedLaps: 9,
      penaltyLaps: 1,
    });
    await service.revokePenalty(race.session.id, issued.id);
    expect(service.getLeaderboard()[0].id).toBe(race.first.id);
    expect(service.io.emit).toHaveBeenCalledWith('session:penalties_changed', {
      sessionId: race.session.id,
    });
  });

  test('committed penalty changes cue once; failed writes, duplicate requests and repeated serving stay silent', async () => {
    const race = await makeRace('active');
    await service.loadSession(race.session.id);
    const sounds = [];
    service.on('soundboardAutoEvent', (cue) => sounds.push(cue));
    const input = {
      sessionId: race.session.id,
      sessionDriverId: race.first.id,
      kind: PenaltyKind.TIME,
      amount: 8000,
      reason: 'Unsafe overtake',
      requestId: requestId('sounds'),
    };
    const transaction = jest.spyOn(service.prisma, '$transaction').mockRejectedValueOnce(new Error('Storage failed'));
    await expect(service.issuePenalty(input)).rejects.toThrow('Storage failed');
    expect(sounds).toEqual([]);
    transaction.mockRestore();
    const issued = await service.issuePenalty(input);
    await expect(service.issuePenalty(input)).rejects.toMatchObject({ status: 409 });
    expect(sounds.map((cue) => cue.type)).toEqual(['penaltyissued']);
    const serving = {
      sessionId: race.session.id,
      penaltyId: issued.id,
      method: 'manual',
      confirmedStationary: true,
      reason: 'Director confirms stationary time',
    };
    await service.servePenalty(serving);
    await service.servePenalty(serving);
    expect(sounds.map((cue) => cue.type)).toEqual(['penaltyissued', 'penaltyserved']);
    const other = await service.issuePenalty({ ...input, requestId: requestId('sounds-other') });
    await service.revokePenalty(race.session.id, other.id);
    await expect(service.revokePenalty(race.session.id, other.id)).rejects.toMatchObject({ status: 409 });
    expect(sounds.map((cue) => cue.type)).toEqual([
      'penaltyissued',
      'penaltyserved',
      'penaltyissued',
      'penaltyrevoked',
    ]);
    expect(sounds.every((cue) => cue.data.driverName === 'Driver A' && cue.data.controller === 0)).toBe(true);
    expect(new Set(sounds.map((cue) => cue.data.eventId)).size).toBe(4);
  });

  test('editing and reloading finished classification never replays penalty sounds', async () => {
    const race = await makeRace();
    await service.loadSession(race.session.id);
    const sounds = [];
    service.on('soundboardAutoEvent', (cue) => sounds.push(cue));
    const issued = await service.issuePenalty({
      sessionId: race.session.id,
      sessionDriverId: race.first.id,
      kind: PenaltyKind.TIME,
      amount: 8000,
      reason: 'Unsafe overtake',
      requestId: requestId('historical-sounds'),
    });
    await service.revokePenalty(race.session.id, issued.id);
    await service.loadSession(race.session.id);
    expect(sounds).toEqual([]);
  });

  test('reset revokes the active penalty while retaining its audit record', async () => {
    const race = await makeRace();
    const issued = await service.issuePenalty({
      sessionId: race.session.id,
      sessionDriverId: race.first.id,
      kind: PenaltyKind.LAP,
      amount: 1,
      reason: 'Track limits',
      requestId: requestId(5),
    });
    await service.resetSession(race.session.id);
    expect(await prisma.sessionPenalty.findUnique({ where: { id: issued.id } })).toMatchObject({
      status: PenaltyStatus.REVOKED,
    });
    expect((await prisma.sessionDriver.findUnique({ where: { id: race.first.id } })).totalLaps).toBe(0);
  });

  test('does not revoke a penalty belonging to another session', async () => {
    const race = await makeRace();
    const other = await prisma.session.create({ data: { type: 'race', trackId: race.session.trackId } });
    const issued = await service.issuePenalty({
      sessionId: race.session.id,
      sessionDriverId: race.first.id,
      kind: PenaltyKind.LAP,
      amount: 1,
      reason: 'Track limits',
      requestId: requestId(6),
    });
    await expect(service.revokePenalty(other.id, issued.id)).rejects.toMatchObject({ status: 404 });
    expect((await prisma.sessionPenalty.findUnique({ where: { id: issued.id } })).status).toBe(PenaltyStatus.ACTIVE);
  });
});

describe('serving time penalties with director evidence', () => {
  let service;
  let race;
  let penalty;
  beforeEach(async () => {
    await prisma.sessionPenalty.deleteMany();
    await prisma.pitStop.deleteMany();
    await prisma.lap.deleteMany();
    await prisma.sessionDriver.deleteMany();
    await prisma.session.deleteMany();
    await prisma.driver.deleteMany();
    await prisma.car.deleteMany();
    await prisma.track.deleteMany();
    service = new SessionService({ emit: jest.fn() });
    race = await makeRace();
    penalty = await service.issuePenalty({
      sessionId: race.session.id,
      sessionDriverId: race.first.id,
      kind: PenaltyKind.TIME,
      amount: 8000,
      reason: 'Unsafe overtake',
      requestId: requestId('serve'),
    });
    // Use a past issue time so the fixture represents an actually completed later stop.
    penalty = await prisma.sessionPenalty.update({
      where: { id: penalty.id },
      data: { issuedAt: new Date(Date.now() - 30000) },
    });
  });
  afterEach(async () => {
    service.stopHeartbeat();
    await service.prisma.$disconnect();
  });
  const serve = (changes) =>
    service.servePenalty({
      sessionId: race.session.id,
      penaltyId: penalty.id,
      method: 'pit',
      confirmedStationary: true,
      reason: 'Stationary time verified',
      ...changes,
    });
  const stop = (changes = {}) =>
    prisma.pitStop.create({
      data: {
        sessionId: race.session.id,
        sessionDriverId: race.first.id,
        controller: 0,
        source: 'simulator',
        enteredAt: new Date(Date.now() - 15000),
        exitedAt: new Date(Date.now() - 5000),
        durationMs: 10000,
        ...changes,
      },
    });

  test('a verified stop serves once, retains audit and raw times, and replays without a second time addition', async () => {
    const pit = await stop();
    const served = await serve({ pitStopId: pit.id });
    expect(served).toMatchObject({
      status: PenaltyStatus.SERVED,
      servedMethod: 'pit',
      servedPitStopId: pit.id,
      reason: 'Unsafe overtake',
      servedReason: 'Stationary time verified',
    });
    const events = service.io.emit.mock.calls.length;
    const repeated = await serve({ pitStopId: pit.id });
    expect(service.io.emit.mock.calls).toHaveLength(events);
    expect(repeated.servedAt).toEqual(served.servedAt);
    expect(await prisma.sessionDriver.findUnique({ where: { id: race.first.id } })).toMatchObject({
      finalPos: 1,
      totalTime: 100000,
      totalLaps: 10,
    });
    expect((await prisma.lap.findUnique({ where: { id: race.lap.id } })).lapTime).toBe(10000);
    await service.loadSession(race.session.id);
    expect(service.getLeaderboard()[0]).toMatchObject({ id: race.first.id, penaltyTimeMs: 0 });
    expect(await prisma.sessionPenalty.count()).toBe(1);
  });

  test('manual exception needs a reason and remains visibly distinct from a verified stop', async () => {
    await expect(serve({ method: 'manual', reason: '' })).rejects.toMatchObject({ status: 400 });
    const saved = await serve({ method: 'manual', reason: 'Video confirms stationary time after disconnect' });
    expect(saved).toMatchObject({ servedMethod: 'manual', servedPitStopId: null, status: PenaltyStatus.SERVED });
    await expect(serve({ method: 'manual', reason: 'Different evidence' })).rejects.toMatchObject({ status: 409 });
  });

  test('short, old, foreign, inconsistent or unconfirmed visits leave the penalty pending', async () => {
    const pit = await stop();
    await expect(serve({ pitStopId: pit.id, confirmedStationary: false })).rejects.toMatchObject({ status: 400 });
    for (const changes of [
      { durationMs: 1000, enteredAt: new Date(Date.now() - 6000) },
      { enteredAt: new Date(Date.now() - 60000), exitedAt: new Date(Date.now() - 50000) },
      { sessionDriverId: race.second.id, controller: 1 },
      { durationMs: 9000 },
      { exitedAt: new Date(Date.now() + 10000) },
    ]) {
      const invalid = await stop(changes);
      await expect(serve({ pitStopId: invalid.id })).rejects.toMatchObject({ status: 409 });
    }
    await expect(serve({ pitStopId: 'incomplete-stop' })).rejects.toMatchObject({ status: 409 });
    expect((await prisma.sessionPenalty.findUnique({ where: { id: penalty.id } })).status).toBe(PenaltyStatus.ACTIVE);
  });

  test('one pit visit cannot clear two penalties and failures do not partially change classification', async () => {
    const pit = await stop();
    await serve({ pitStopId: pit.id });
    const other = await service.issuePenalty({
      sessionId: race.session.id,
      sessionDriverId: race.first.id,
      kind: PenaltyKind.TIME,
      amount: 1000,
      reason: 'Second incident',
      requestId: requestId('other'),
    });
    await prisma.sessionPenalty.update({ where: { id: other.id }, data: { issuedAt: penalty.issuedAt } });
    await expect(serve({ penaltyId: other.id, pitStopId: pit.id })).rejects.toMatchObject({ status: 409 });
    expect((await prisma.sessionPenalty.findUnique({ where: { id: other.id } })).status).toBe(PenaltyStatus.ACTIVE);
    const fail = jest
      .spyOn(service, 'updatePenaltyPositions')
      .mockRejectedValueOnce(new Error('classification write failed'));
    await expect(serve({ penaltyId: other.id, method: 'manual' })).rejects.toThrow('classification write failed');
    fail.mockRestore();
    expect((await prisma.sessionPenalty.findUnique({ where: { id: other.id } })).servedAt).toBeNull();
  });

  test('wrong session, revoked and lap penalties cannot be marked served', async () => {
    await expect(serve({ sessionId: 'missing', method: 'manual' })).rejects.toMatchObject({ status: 404 });
    const other = await prisma.session.create({
      data: { trackId: race.session.trackId, type: 'race', status: 'active' },
    });
    await expect(serve({ sessionId: other.id, method: 'manual' })).rejects.toMatchObject({ status: 404 });
    await prisma.sessionPenalty.update({ where: { id: penalty.id }, data: { kind: PenaltyKind.LAP } });
    await expect(serve({ method: 'manual' })).rejects.toMatchObject({ status: 409 });
    await prisma.sessionPenalty.update({
      where: { id: penalty.id },
      data: { kind: PenaltyKind.TIME, status: PenaltyStatus.REVOKED },
    });
    await expect(serve({ method: 'manual' })).rejects.toMatchObject({ status: 409 });
  });
});

test('penalty-serving migration keeps existing penalties pending with no invented serving evidence', () => {
  const Database = createRequire(import.meta.url)('better-sqlite3');
  const db = new Database(':memory:');
  const directory = new URL('../../prisma/migrations/', import.meta.url);
  try {
    for (const name of fs
      .readdirSync(directory)
      .filter((name) => name < '20261031210000_penalty_serving')
      .sort()) {
      const file = new URL(`${name}/migration.sql`, directory);
      if (fs.existsSync(file)) db.exec(fs.readFileSync(file, 'utf8'));
    }
    db.exec(`INSERT INTO Track (id,name,createdAt,updatedAt) VALUES ('t','Old track',0,0);
      INSERT INTO Session (id,type,status,trackId,createdAt,updatedAt) VALUES ('s','race','finished','t',0,0);
      INSERT INTO SessionPenalty (id,sessionId,controller,requestId,kind,amount,reason) VALUES ('p','s',0,'old-request','time',5000,'Old reason');`);
    db.exec(fs.readFileSync(new URL('20261031210000_penalty_serving/migration.sql', directory), 'utf8'));
    expect(
      db.prepare('SELECT status,amount,servedAt,servedMethod,servedReason,servedPitStopId FROM SessionPenalty').get()
    ).toEqual({
      status: 'active',
      amount: 5000,
      servedAt: null,
      servedMethod: null,
      servedReason: null,
      servedPitStopId: null,
    });
  } finally {
    db.close();
  }
});

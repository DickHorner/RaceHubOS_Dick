import express from 'express';
import request from 'supertest';
import { prisma } from './setup.js';
import { ChampionshipService } from '../services/ChampionshipService.js';
import { SessionService } from '../services/SessionService.js';
import championshipsRouter, { setChampionshipService } from '../routes/championships.js';

describe('championship points without a custom points schema', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/championships', championshipsRouter);

  let service;
  let track;
  let championship;
  let drivers;

  beforeEach(async () => {
    await prisma.trackRecord.deleteMany();
    await prisma.controllerConfig.deleteMany();
    await prisma.tyreChange.deleteMany();
    await prisma.virtualFuelEvent.deleteMany();
    await prisma.sessionPenalty.deleteMany();
    await prisma.pitStop.deleteMany();
    await prisma.lap.deleteMany();
    await prisma.sessionDriver.deleteMany();
    await prisma.championshipParticipant.deleteMany();
    await prisma.session.deleteMany();
    await prisma.championship.deleteMany();
    await prisma.driver.deleteMany();
    await prisma.team.deleteMany();
    await prisma.car.deleteMany();
    await prisma.track.deleteMany();

    service = new ChampionshipService();
    setChampionshipService(service);
    track = await prisma.track.create({ data: { name: 'Points circuit' } });
    drivers = [];
    for (const name of ['Alex', 'Bea', 'Chris']) {
      drivers.push(await prisma.driver.create({ data: { name } }));
    }
    championship = await prisma.championship.create({
      data: { name: 'Points cup', season: '2026', trackId: track.id },
    });
  });

  afterEach(async () => {
    await service.close();
  });

  async function addSession(type, status, placements, deletedAt = null) {
    const session = await prisma.session.create({
      data: { championshipId: championship.id, trackId: track.id, type, status, deletedAt },
    });
    await prisma.sessionDriver.createMany({
      data: placements.map(({ driverIndex, finalPos, deleted = false }, controller) => ({
        sessionId: session.id,
        controller,
        driverId: drivers[driverIndex].id,
        finalPos,
        deletedAt: deleted ? new Date() : null,
      })),
    });
    return session;
  }

  it('ranks only completed race points, ignoring removed sessions and assignments', async () => {
    await addSession('race', 'finished', [
      { driverIndex: 0, finalPos: 1 },
      { driverIndex: 1, finalPos: 2 },
    ]);
    await addSession('race', 'finished', [
      { driverIndex: 0, finalPos: 2 },
      { driverIndex: 1, finalPos: 1 },
      { driverIndex: 2, finalPos: 1, deleted: true },
    ]);
    await addSession('qualif', 'finished', [
      { driverIndex: 0, finalPos: 1 },
      { driverIndex: 2, finalPos: 2 },
    ]);
    await addSession('race', 'draft', [{ driverIndex: 2, finalPos: 1 }]);
    await addSession('race', 'finished', [{ driverIndex: 2, finalPos: 1 }], new Date());

    const standings = await service.getStandings(championship.id);
    const byDriver = new Map(standings.map((entry) => [entry.driverId, entry]));

    expect(byDriver.get(drivers[0].id).totalPoints).toBe(43);
    expect(byDriver.get(drivers[1].id).totalPoints).toBe(43);
    expect(byDriver.get(drivers[2].id).totalPoints).toBe(0);
    expect(
      byDriver
        .get(drivers[0].id)
        .sessions.map((s) => s.points)
        .sort((a, b) => a - b)
    ).toEqual([0, 18, 25]);
    expect(
      byDriver
        .get(drivers[1].id)
        .sessions.map((s) => s.points)
        .sort((a, b) => a - b)
    ).toEqual([18, 25]);
    expect(standings.slice(0, 2).map((s) => s.driverId)).toEqual([drivers[0].id, drivers[1].id].sort());
    expect(standings.map((s) => s.position)).toEqual([1, 2, 3]);
  });

  it('handles absent and soft-deleted championships without phantom scores', async () => {
    expect(await service.getStandings('missing')).toBeNull();
    await prisma.championship.update({ where: { id: championship.id }, data: { deletedAt: new Date() } });
    expect(await service.getStandings(championship.id)).toBeNull();
  });

  it('rejects unsupported custom points at creation without persisting a championship', async () => {
    const response = await request(app)
      .post('/api/championships')
      .send({
        name: 'Unsupported cup',
        season: '2026',
        pointsSystem: { racePoints: { 1: 100 } },
      });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Custom points systems are not supported');
    expect(await prisma.championship.count()).toBe(1);

    const valid = await request(app).post('/api/championships').send({ name: 'Default cup', season: '2026' });
    expect(valid.status).toBe(201);
    expect(await prisma.championship.count()).toBe(2);
  });

  it('rejects unsupported custom points updates without changing valid fields', async () => {
    const invalid = await request(app).put(`/api/championships/${championship.id}`).send({
      name: 'Changed name',
      pointsSystem: '{"racePoints":{"1":100}}',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe('Custom points systems are not supported');
    expect((await prisma.championship.findUnique({ where: { id: championship.id } })).name).toBe('Points cup');

    const valid = await request(app).put(`/api/championships/${championship.id}`).send({ name: 'Updated cup' });
    expect(valid.status).toBe(200);
    expect(valid.body.data.name).toBe('Updated cup');
  });
  it('snapshots teams at first GO and retains points after a driver transfers', async () => {
    const red = await prisma.team.create({ data: { name: 'Red' } });
    const blue = await prisma.team.create({ data: { name: 'Blue' } });
    await prisma.driver.update({ where: { id: drivers[0].id }, data: { teamId: red.id } });
    await prisma.driver.update({ where: { id: drivers[1].id }, data: { teamId: blue.id } });

    const session = await addSession('race', 'active', [
      { driverIndex: 0, finalPos: 1 },
      { driverIndex: 1, finalPos: 2 },
      { driverIndex: 2, finalPos: 3 },
    ]);
    const events = [];
    const race = new SessionService({
      emit(event) {
        events.push(event);
      },
    });
    try {
      await race.loadSession(session.id);
      await Promise.all([race.onRaceStart(), race.onRaceStart()]);
      expect(events.filter((event) => event === 'session:race_started')).toHaveLength(1);

      const saved = await prisma.session.findUnique({
        where: { id: session.id },
        include: { drivers: true },
      });
      expect(saved.teamMembershipSnapshotted).toBe(true);
      expect(saved.startedAt).not.toBeNull();
      expect(saved.drivers.sort((a, b) => a.controller - b.controller).map((entry) => entry.teamIdAtStart)).toEqual([
        red.id,
        blue.id,
        null,
      ]);

      await prisma.session.update({ where: { id: session.id }, data: { status: 'finished' } });
      await prisma.driver.update({ where: { id: drivers[0].id }, data: { teamId: blue.id } });
      const result = await service.getTeamStandings(championship.id);
      expect(result.legacyRaces).toBe(0);
      expect(result.standings.map((entry) => [entry.teamId, entry.totalPoints])).toEqual([
        [red.id, 25],
        [blue.id, 18],
      ]);
      expect(result.standings.some((entry) => entry.totalPoints === 15)).toBe(false);
    } finally {
      await race.prisma.$disconnect();
    }
  });

  it('ranks tied team scores deterministically and excludes legacy or deleted races', async () => {
    const a = await prisma.team.create({ data: { name: 'A' } });
    const b = await prisma.team.create({ data: { name: 'B' } });
    const first = await addSession('race', 'finished', [
      { driverIndex: 0, finalPos: 1 },
      { driverIndex: 1, finalPos: 2 },
    ]);
    const second = await addSession('race', 'finished', [
      { driverIndex: 0, finalPos: 2 },
      { driverIndex: 1, finalPos: 1 },
    ]);
    for (const session of [first, second]) {
      await prisma.session.update({
        where: { id: session.id },
        data: { teamMembershipSnapshotted: true },
      });
      await prisma.sessionDriver.updateMany({
        where: { sessionId: session.id, driverId: drivers[0].id },
        data: { teamIdAtStart: a.id },
      });
      await prisma.sessionDriver.updateMany({
        where: { sessionId: session.id, driverId: drivers[1].id },
        data: { teamIdAtStart: b.id },
      });
    }
    await addSession('race', 'finished', [{ driverIndex: 2, finalPos: 1 }]);
    await addSession('race', 'finished', [{ driverIndex: 2, finalPos: 1 }], new Date());
    await addSession('qualif', 'finished', [{ driverIndex: 2, finalPos: 1 }]);
    await addSession('race', 'draft', [{ driverIndex: 2, finalPos: 1 }]);

    const before = await service.getStandings(championship.id);
    const result = await service.getTeamStandings(championship.id);
    expect(result.legacyRaces).toBe(1);
    expect(result.standings.map((entry) => [entry.teamId, entry.totalPoints])).toEqual(
      [a.id, b.id].sort().map((id) => [id, 43])
    );
    expect(await service.getStandings(championship.id)).toEqual(before);

    const response = await request(app).get(`/api/championships/${championship.id}/team-standings`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, legacyRaces: 1 });
    expect(response.body.standings).toHaveLength(2);
    const missing = await request(app).get('/api/championships/missing/team-standings');
    expect(missing.status).toBe(404);
  });
});

import express from 'express';
import request from 'supertest';
import { prisma } from './setup.js';
import { ChampionshipService } from '../services/ChampionshipService.js';
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
});

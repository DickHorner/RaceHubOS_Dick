import express from 'express';
import request from 'supertest';
import { prisma } from './setup.js';
import { ChampionshipService } from '../services/ChampionshipService.js';
import championshipsRouter, { setChampionshipService } from '../routes/championships.js';
import sessionsRouter, { setSessionService } from '../routes/sessions.js';

describe('championship car rotation', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/championships', championshipsRouter);
  app.use('/api/sessions', sessionsRouter);
  let service;

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
    setSessionService({ prisma });
  });

  afterEach(async () => {
    await service.close();
  });

  async function fixture(driverCount, carCount, qualifStatus = 'finished') {
    const track = await prisma.track.create({ data: { name: 'Rotation circuit' } });
    const drivers = [];
    const cars = [];
    for (let i = 0; i < driverCount; i++) {
      drivers.push(await prisma.driver.create({ data: { name: `Driver ${i}` } }));
    }
    for (let i = 0; i < carCount; i++) {
      cars.push(await prisma.car.create({ data: { brand: 'Carrera', model: `Model ${i}` } }));
    }
    const championship = await prisma.championship.create({
      data: {
        name: 'Rotation cup',
        season: '2026',
        mode: 'auto',
        driversPerQualif: 6,
        driversPerRace: 6,
        trackId: track.id,
      },
    });
    await prisma.championshipParticipant.createMany({
      data: drivers.map((driver, order) => ({ championshipId: championship.id, driverId: driver.id, order })),
    });
    const qualification = await prisma.session.create({
      data: { type: 'qualif', status: qualifStatus, championshipId: championship.id, trackId: track.id, order: 1 },
    });
    const oldRace = await prisma.session.create({
      data: { type: 'race', status: 'draft', championshipId: championship.id, trackId: track.id, order: 2 },
    });
    return { track, drivers, cars, championship, qualification, oldRace, carIds: cars.map((car) => car.id) };
  }

  test.each([
    [2, 2],
    [6, 6],
    [7, 3],
    [3, 5],
  ])('generates each driver/car pair exactly once for %i drivers and %i cars', async (driverCount, carCount) => {
    const { championship, carIds, oldRace } = await fixture(driverCount, carCount);
    const preview = await request(app)
      .post(`/api/championships/${championship.id}/car-rotation/preview`)
      .send({ carIds });
    expect(preview.status).toBe(200);
    const plan = preview.body.data;
    expect(plan.races).toHaveLength(Math.max(driverCount, carCount));
    expect(await prisma.session.count({ where: { championshipId: championship.id } })).toBe(2);

    const pairs = new Set();
    for (const race of plan.races) {
      expect(race.drivers).toHaveLength(Math.min(driverCount, carCount));
      expect(new Set(race.drivers.map((d) => d.carId)).size).toBe(race.drivers.length);
      expect(new Set(race.drivers.map((d) => d.driverId)).size).toBe(race.drivers.length);
      expect(race.drivers.every((d) => d.controller < 6)).toBe(true);
      for (const row of race.drivers) pairs.add(`${row.driverId}/${row.carId}`);
    }
    expect(pairs.size).toBe(driverCount * carCount);
    expect((await service.previewCarRotation(championship.id, carIds)).races).toEqual(plan.races);

    const apply = await request(app)
      .post(`/api/championships/${championship.id}/car-rotation`)
      .send({ carIds, participantIds: plan.participantIds });
    expect(apply.status).toBe(200);
    expect(apply.body.data.count).toBe(plan.races.length);
    expect(await prisma.session.findUnique({ where: { id: oldRace.id } })).toBeNull();
    const persisted = await prisma.session.findMany({
      where: { championshipId: championship.id, type: 'race' },
      include: { drivers: true },
      orderBy: { order: 'asc' },
    });
    expect(persisted.map((race) => race.drivers.length)).toEqual(plan.races.map((r) => r.drivers.length));
    const reloadedService = new ChampionshipService();
    try {
      const reloaded = await reloadedService.previewCarRotation(championship.id, carIds);
      expect(reloaded.races).toEqual(plan.races);
    } finally {
      await reloadedService.close();
    }
  });

  it('keeps manually corrected draft assignments when qualifying is recalculated', async () => {
    const { championship, carIds } = await fixture(3, 2);
    const plan = await service.previewCarRotation(championship.id, carIds);
    await service.applyCarRotation(championship.id, carIds, plan.participantIds);
    const race = await prisma.session.findFirst({ where: { championshipId: championship.id, type: 'race' } });
    const assigned = await prisma.sessionDriver.findMany({
      where: { sessionId: race.id },
      orderBy: { controller: 'asc' },
    });
    const swap = await request(app)
      .put(`/api/sessions/${race.id}/drivers`)
      .send({
        drivers: [
          { controller: 0, driverId: assigned[0].driverId, carId: assigned[1].carId },
          { controller: 1, driverId: assigned[1].driverId, carId: assigned[0].carId },
        ],
      });
    expect(swap.status).toBe(200);
    await service.assignDriversToRaces(championship.id);
    const after = await prisma.sessionDriver.findMany({
      where: { sessionId: race.id },
      orderBy: { controller: 'asc' },
    });
    expect(after.map((d) => d.carId)).toEqual([assigned[1].carId, assigned[0].carId]);
  });

  it('rejects stale participants and unavailable or duplicate cars', async () => {
    const { championship, drivers, carIds } = await fixture(3, 2);
    await expect(service.previewCarRotation(championship.id, [carIds[0], carIds[0]])).rejects.toThrow();
    await expect(service.previewCarRotation(championship.id, ['missing', carIds[0]])).rejects.toThrow();
    await expect(service.applyCarRotation(championship.id, carIds, [drivers[1].id, drivers[0].id])).rejects.toThrow();
  });

  it('does not replace races with history or started races, or uncompleted qualification', async () => {
    const { championship, carIds, oldRace, qualification } = await fixture(3, 2, 'draft');
    const plan = await service.previewCarRotation(championship.id, carIds);
    await expect(service.applyCarRotation(championship.id, carIds, plan.participantIds)).rejects.toThrow(
      'qualifications'
    );
    await prisma.session.update({ where: { id: qualification.id }, data: { status: 'finished' } });
    await prisma.session.update({ where: { id: oldRace.id }, data: { status: 'active' } });
    await expect(service.applyCarRotation(championship.id, carIds, plan.participantIds)).rejects.toThrow('Started');
    expect((await prisma.session.findUnique({ where: { id: oldRace.id } })).status).toBe('active');
    const forbidden = await request(app).put(`/api/sessions/${oldRace.id}/drivers`).send({ drivers: [] });
    expect(forbidden.status).toBe(409);
  });

  it('rejects duplicate draft controller or car assignments without erasing the previous grid', async () => {
    const { carIds, oldRace, drivers } = await fixture(2, 2);
    const first = await request(app)
      .put(`/api/sessions/${oldRace.id}/drivers`)
      .send({
        drivers: [{ controller: 0, driverId: drivers[0].id, carId: carIds[0] }],
      });
    expect(first.status).toBe(200);
    const duplicate = await request(app)
      .put(`/api/sessions/${oldRace.id}/drivers`)
      .send({
        drivers: [
          { controller: 0, driverId: drivers[0].id, carId: carIds[0] },
          { controller: 1, driverId: drivers[1].id, carId: carIds[0] },
        ],
      });
    expect(duplicate.status).toBe(400);
    expect(await prisma.sessionDriver.count({ where: { sessionId: oldRace.id } })).toBe(1);
  });
});

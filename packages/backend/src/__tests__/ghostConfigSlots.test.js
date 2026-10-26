import express from 'express';
import request from 'supertest';
import { prisma } from './setup.js';
import { ConfigService } from '../services/ConfigService.js';
import { SessionService } from '../services/SessionService.js';
import configRouter, { setConfigService } from '../routes/config.js';

describe('controller configuration reserves Ghost and Pace slots', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/config', configRouter);
  let configService;
  let sessionService;
  let track;
  let driver;
  let car;

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

    track = await prisma.track.create({ data: { name: 'Ghost-safe circuit' } });
    driver = await prisma.driver.create({ data: { name: 'Human driver' } });
    car = await prisma.car.create({ data: { brand: 'Carrera', model: 'Human car' } });
    configService = new ConfigService();
    sessionService = new SessionService();
    setConfigService(configService);
  });

  afterEach(async () => {
    setConfigService(null);
    await configService.prisma.$disconnect();
    await sessionService.prisma.$disconnect();
  });

  test('single-slot updates reject reserved and invalid addresses without database writes', async () => {
    for (const controller of ['6', '7', '-1', '0.5', 'not-a-controller']) {
      const result = await request(app).put(`/api/config/${controller}`).send({
        trackId: track.id,
        driverId: driver.id,
        carId: car.id,
      });
      expect(result.status).toBe(400);
      expect(result.body.error).toBe('Invalid controller (0-5)');
    }

    expect(await prisma.controllerConfig.count()).toBe(0);

    const valid = await request(app).put('/api/config/5').send({
      trackId: track.id,
      driverId: driver.id,
      carId: car.id,
    });
    expect(valid.status).toBe(200);
    expect(valid.body.data.controller).toBe(5);
  });

  test('bulk update rejects an invalid slot before persisting a preceding valid one', async () => {
    const result = await request(app)
      .put('/api/config/bulk')
      .send({
        trackId: track.id,
        controllers: [
          { controller: 0, driverId: driver.id, carId: car.id },
          { controller: 6, driverId: driver.id, carId: car.id },
        ],
      });

    expect(result.status).toBe(400);
    expect(result.body.error).toBe('Invalid controller (0-5)');
    expect(await prisma.controllerConfig.count()).toBe(0);
  });

  test('new sessions ignore old Ghost/Pace configs without deleting saved configuration', async () => {
    await prisma.controllerConfig.createMany({
      data: [
        { trackId: track.id, controller: 0, driverId: driver.id, carId: car.id },
        { trackId: track.id, controller: 6, driverId: driver.id, carId: car.id },
        { trackId: track.id, controller: 7, driverId: driver.id, carId: car.id },
      ],
    });

    const session = await sessionService.createSession({ trackId: track.id, type: 'practice' });

    expect(session.drivers.map((entry) => entry.controller)).toEqual([0]);
    expect(await prisma.sessionDriver.count({ where: { sessionId: session.id } })).toBe(1);
    expect(await prisma.controllerConfig.count({ where: { trackId: track.id } })).toBe(3);
  });
});

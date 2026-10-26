import express from 'express';
import request from 'supertest';
import { prisma } from './setup.js';
import sessionsRouter, { setSessionService } from '../routes/sessions.js';
import championshipsRouter, { setChampionshipService } from '../routes/championships.js';

describe('CSV download routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/championships', championshipsRouter);

  let sessionId;
  let championshipId;

  beforeAll(() => {
    setSessionService({ prisma });
    setChampionshipService({ prisma });
  });

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

    const track = await prisma.track.create({ data: { name: 'CSV ring' } });
    const driver = await prisma.driver.create({ data: { name: 'Émilie, "GP"' } });
    const hiddenDriver = await prisma.driver.create({ data: { name: 'Hidden row' } });
    const car = await prisma.car.create({ data: { brand: 'Carrera', model: 'R8 GT' } });
    const championship = await prisma.championship.create({
      data: { name: 'CSV cup', season: '2026', trackId: track.id },
    });
    championshipId = championship.id;

    const session = await prisma.session.create({
      data: {
        name: 'CSV session',
        type: 'race',
        status: 'finished',
        trackId: track.id,
        championshipId,
      },
    });
    sessionId = session.id;

    await prisma.sessionDriver.createMany({
      data: [
        {
          sessionId,
          controller: 0,
          driverId: driver.id,
          carId: car.id,
          finalPos: 1,
          totalLaps: 1,
          totalTime: 9_876,
          bestLapTime: 9_876,
          lastLapTime: 9_876,
        },
        {
          sessionId,
          controller: 1,
          driverId: hiddenDriver.id,
          carId: car.id,
          finalPos: 2,
          deletedAt: new Date(),
        },
      ],
    });

    await prisma.lap.createMany({
      data: [
        {
          sessionId,
          trackId: track.id,
          driverId: driver.id,
          carId: car.id,
          controller: 0,
          phase: 'race',
          lapNumber: 1,
          lapTime: 9_876,
          timestamp: new Date('2026-10-26T12:00:00.456Z'),
        },
        {
          sessionId,
          trackId: track.id,
          driverId: hiddenDriver.id,
          carId: car.id,
          controller: 1,
          phase: 'race',
          lapNumber: 1,
          lapTime: 11_000,
          deletedAt: new Date(),
        },
      ],
    });

    await prisma.session.create({
      data: {
        name: 'Removed session',
        type: 'race',
        status: 'finished',
        trackId: track.id,
        championshipId,
        deletedAt: new Date(),
      },
    });
  });

  it('exports result and lap tables without soft-deleted rows', async () => {
    const results = await request(app).get(`/api/sessions/${sessionId}/export?format=csv&table=results`).expect(200);
    expect(results.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
    expect(results.headers['content-disposition']).toMatch(/_results\.csv"$/);
    expect(results.text).toContain('Émilie');
    expect(results.text).not.toContain('Hidden row');
    expect(results.text).toContain('Temps total (s)');
    expect(results.text).toContain('9.876');

    const laps = await request(app).get(`/api/sessions/${sessionId}/export?format=csv&table=laps`).expect(200);
    expect(laps.headers['content-disposition']).toMatch(/_laps\.csv"$/);
    expect(laps.text).toContain('2026-10-26T12:00:00.456Z');
    expect(laps.text).not.toContain('Hidden row');
    expect(laps.text).not.toContain('11.000');
  });

  it('reuses championship Excel driver standings for CSV, without removed sessions', async () => {
    const response = await request(app).get(`/api/championships/${championshipId}/export?format=csv`).expect(200);
    expect(response.headers['content-disposition']).toMatch(/_standings\.csv"$/);
    expect(response.text).toContain('Émilie');
    expect(response.text).toContain('Victoires');
    expect(response.text).not.toContain('Hidden row');
    expect(response.text).not.toContain('Removed session');
  });

  it('leaves XLSX responses intact and refuses unknown CSV tables/formats', async () => {
    const xlsx = await request(app).get(`/api/sessions/${sessionId}/export`).expect(200);
    expect(xlsx.headers['content-type']).toMatch(/spreadsheetml/);
    expect(xlsx.headers['content-disposition']).toMatch(/\.xlsx"$/);

    await request(app).get(`/api/sessions/${sessionId}/export?format=csv&table=unknown`).expect(400);
    await request(app).get(`/api/sessions/${sessionId}/export?format=pdf`).expect(400);
    await request(app).get(`/api/championships/${championshipId}/export?format=pdf`).expect(400);
    await request(app).get('/api/sessions/missing/export?format=csv').expect(404);
    await request(app).get('/api/championships/missing/export?format=csv').expect(404);
  });

  it('returns an explicit empty-standings response for championships without drivers', async () => {
    const track = await prisma.track.findFirst({ where: { name: 'CSV ring' } });
    const empty = await prisma.championship.create({ data: { name: 'Empty cup', season: '2026', trackId: track.id } });
    const result = await request(app).get(`/api/championships/${empty.id}/export?format=csv`).expect(404);
    expect(result.body.error).toBe('No driver standings to export');
  });
});

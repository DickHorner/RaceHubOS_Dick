import express from 'express';
import request from 'supertest';
import { createPrismaClient } from '../lib/prisma.js';
import settingsRouter, { setSettingsSyncService } from '../routes/settings.js';
import { remoteWriteGuard } from '../routes/raceControl.js';
import { SyncService } from '../services/SyncService.js';

describe('start trace settings API', () => {
  const prisma = createPrismaClient();
  const oldTrace = process.env.RACEHUB_START_TRACE;
  let app;
  let sync;

  beforeEach(async () => {
    delete process.env.RACEHUB_START_TRACE;
    await prisma.preference.deleteMany({ where: { key: 'startTraceEnabled' } });
    sync = new SyncService(null);
    setSettingsSyncService(sync);
    app = express();
    app.use(express.json());
    app.use('/api', remoteWriteGuard);
    app.use('/api/settings', settingsRouter);
  });

  afterAll(async () => {
    setSettingsSyncService(null);
    await prisma.preference.deleteMany({ where: { key: 'startTraceEnabled' } });
    await prisma.$disconnect();
    if (oldTrace === undefined) delete process.env.RACEHUB_START_TRACE;
    else process.env.RACEHUB_START_TRACE = oldTrace;
  });

  test('toggle immediately, persist and download bounded records', async () => {
    expect((await request(app).get('/api/settings/start-trace').expect(200)).body.data.enabled).toBe(false);
    await request(app).put('/api/settings/start-trace').send({ enabled: true }).expect(200);
    expect(sync.getStartTraceEnabled()).toBe(true);
    const saved = await prisma.preference.findUnique({ where: { key: 'startTraceEnabled' } });
    expect(JSON.parse(saved.value)).toBe(true);
    sync.beginStartTrace('session');
    sync.traceStart('status', { start: 6 });
    const report = await request(app).get('/api/settings/start-trace/records').expect(200);
    expect(report.body.data.map(({ phase }) => phase)).toEqual(['accepted', 'status']);
    await request(app).put('/api/settings/start-trace').send({ enabled: false }).expect(200);
    expect(sync.getStartTraceEnabled()).toBe(false);
    expect((await request(app).get('/api/settings/start-trace/records')).body.data).toHaveLength(2);
  });

  test('invalid writes and untrusted browser cannot read diagnosis', async () => {
    await request(app).put('/api/settings/start-trace').send({ enabled: 'yes' }).expect(400);
    expect(sync.getStartTraceEnabled()).toBe(false);
    const denied = await request(app).get('/api/settings/start-trace/records').set('Origin', 'https://untrusted.example');
    expect([403, 503]).toContain(denied.status);
    expect(denied.body.data).toBeUndefined();
    await request(app).put('/api/settings/start-trace').set('Origin', 'https://untrusted.example').send({ enabled: true }).expect(403);
  });
});

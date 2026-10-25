import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import raceControl, { setRaceControlServices, remoteWriteGuard, mayControlSocket } from '../routes/raceControl.js';
import { SessionService } from '../services/SessionService.js';

const secret = 'this-is-a-long-private-race-director-secret-123456';
const assignment = { id: 'sd-1', sessionId: 'race-1', driverId: 'driver-1', controller: 2, deletedAt: null };

function setup() {
  const session = {
    activeSessionId: 'race-1',
    sessionStatus: 'active',
    pauseSession: jest.fn(async () => { session.sessionStatus = 'paused'; }),
    resumeSession: jest.fn(async () => { session.sessionStatus = 'active'; }),
    stopSession: jest.fn(async () => { session.sessionStatus = 'finished'; }),
    prisma: {
      session: { findUnique: jest.fn(async () => ({ id: 'race-1', status: 'active', drivers: [assignment] })) },
      sessionDriver: { findMany: jest.fn(async () => [assignment]) },
    },
  };
  const sync = { isConnected: jest.fn(() => true) };
  setRaceControlServices(session, sync);
  const app = express();
  app.use(express.json());
  app.use('/api/race-control', raceControl);
  return { app, session, sync };
}

async function issueToken(app) {
  const res = await request(app).post('/api/race-control/driver-link')
    .set('Authorization', `Bearer ${secret}`)
    .send({ sessionId: 'race-1', driverId: 'driver-1' });
  expect(res.status).toBe(200);
  return res.body.token;
}

describe('race director and driver-scoped chaos access', () => {
  const previousSecret = process.env.RACE_CONTROL_SECRET;
  beforeEach(() => { process.env.RACE_CONTROL_SECRET = secret; });
  afterEach(() => {
    if (previousSecret === undefined) delete process.env.RACE_CONTROL_SECRET;
    else process.env.RACE_CONTROL_SECRET = previousSecret;
    jest.restoreAllMocks();
  });

  test('refuses to mint driver access without the director credential', async () => {
    const { app } = setup();
    await request(app).post('/api/race-control/driver-link').send({ sessionId: 'race-1', driverId: 'driver-1' }).expect(403);
    await request(app).post('/api/race-control/driver-link').set('Authorization', 'Bearer forged')
      .send({ sessionId: 'race-1', driverId: 'driver-1' }).expect(403);
  });

  test('issues access only for one current driver assignment', async () => {
    const { app, session } = setup();
    session.prisma.session.findUnique.mockResolvedValueOnce({ id: 'race-1', status: 'draft', drivers: [assignment, { ...assignment, id: 'sd-2', controller: 3 }] });
    await request(app).post('/api/race-control/driver-link').set('Authorization', `Bearer ${secret}`)
      .send({ sessionId: 'race-1', driverId: 'driver-1' }).expect(409);
    await issueToken(app);
  });

  test('valid driver can pause exactly once even with a rapid repeat', async () => {
    const { app, session } = setup();
    const token = await issueToken(app);
    const calls = await Promise.all([
      request(app).post('/api/race-control/chaos').set('Authorization', `Bearer ${token}`),
      request(app).post('/api/race-control/chaos').set('Authorization', `Bearer ${token}`),
    ]);
    expect(calls.every((call) => call.status === 200)).toBe(true);
    expect(session.pauseSession).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.body.alreadyPaused).sort()).toEqual([false, true]);
  });

  test('driver access cannot resume, stop, or change controller assignments', async () => {
    const { app, session } = setup();
    const token = await issueToken(app);
    await request(app).post('/api/race-control/director/resume').set('Authorization', `Bearer ${token}`)
      .send({ sessionId: 'race-1' }).expect(403);
    await request(app).post('/api/race-control/director/stop').set('Authorization', `Bearer ${token}`)
      .send({ sessionId: 'race-1' }).expect(403);
    expect(session.stopSession).not.toHaveBeenCalled();
    expect(session.resumeSession).not.toHaveBeenCalled();
  });

  test('rejects forged, expired and stale driver links', async () => {
    const { app, session } = setup();
    const token = await issueToken(app);
    const forged = token.slice(0, -1) + (token.at(-1) === 'A' ? 'B' : 'A');
    await request(app).post('/api/race-control/chaos').set('Authorization', `Bearer ${forged}`).expect(403);
    session.prisma.sessionDriver.findMany.mockResolvedValueOnce([{ ...assignment, controller: 1 }]);
    await request(app).post('/api/race-control/chaos').set('Authorization', `Bearer ${token}`).expect(403);
    session.activeSessionId = 'race-2';
    await request(app).post('/api/race-control/chaos').set('Authorization', `Bearer ${token}`).expect(409);
    session.activeSessionId = 'race-1';
    const expiredAt = Date.now() + 7 * 60 * 60 * 1000;
    jest.spyOn(Date, 'now').mockReturnValue(expiredAt);
    await request(app).post('/api/race-control/chaos').set('Authorization', `Bearer ${token}`).expect(403);
  });

  test('disconnection does not report a successful pause', async () => {
    const { app, sync, session } = setup();
    const token = await issueToken(app);
    sync.isConnected.mockReturnValue(false);
    await request(app).post('/api/race-control/chaos').set('Authorization', `Bearer ${token}`).expect(503);
    expect(session.pauseSession).not.toHaveBeenCalled();
  });

  test('director alone may resume and stop', async () => {
    const { app, session } = setup();
    session.sessionStatus = 'paused';
    await request(app).post('/api/race-control/director/resume').set('Authorization', `Bearer ${secret}`)
      .send({ sessionId: 'race-1' }).expect(200);
    await request(app).post('/api/race-control/director/stop').set('Authorization', `Bearer ${secret}`)
      .send({ sessionId: 'race-1' }).expect(200);
    expect(session.resumeSession).toHaveBeenCalledTimes(1);
    expect(session.stopSession).toHaveBeenCalledTimes(1);
  });


  test('unconfigured status offers setup only on the race PC', async () => {
    const { app } = setup();
    delete process.env.RACE_CONTROL_SECRET;

    const local = await request(app).get('/api/race-control/status')
      .set('Host', 'localhost:3001').expect(200);
    expect(local.body).toMatchObject({ success: true, enabled: false, setupAvailable: true });
    expect(local.body.secret).toBeUndefined();

    const remoteHost = await request(app).get('/api/race-control/status')
      .set('Host', '192.168.0.10:3001').expect(200);
    expect(remoteHost.body.setupAvailable).toBe(false);
  });

  test('an invalid preconfigured secret does not offer first-run setup', async () => {
    const { app } = setup();
    process.env.RACE_CONTROL_SECRET = 'short';

    const status = await request(app).get('/api/race-control/status')
      .set('Host', 'localhost:3001').expect(200);
    expect(status.body).toMatchObject({ success: true, enabled: false, setupAvailable: false });
  });

  test('first-run setup generates and saves a key without restarting', async () => {
    const { app } = setup();
    delete process.env.RACE_CONTROL_SECRET;
    jest.spyOn(fs, 'readFile').mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' })
    );
    const append = jest.spyOn(fs, 'appendFile').mockResolvedValue();

    const result = await request(app).post('/api/race-control/setup')
      .set('Host', 'localhost:3001')
      .set('Origin', 'http://localhost:5173')
      .expect(200);

    expect(result.body.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(process.env.RACE_CONTROL_SECRET).toBe(result.body.secret);
    expect(append).toHaveBeenCalledWith(
      expect.stringMatching(/packages[\\/]backend[\\/]\.env$/),
      `RACE_CONTROL_SECRET=${result.body.secret}\n`,
      { mode: 0o600 },
    );
    await request(app).get('/api/race-control/director/check')
      .set('Authorization', `Bearer ${result.body.secret}`).expect(200);
    await request(app).post('/api/race-control/setup')
      .set('Host', 'localhost:3001')
      .set('Origin', 'http://localhost:5173').expect(409);
    expect(append).toHaveBeenCalledTimes(1);
  });

  test('first-run setup rejects non-local hosts, untrusted origins and existing keys', async () => {
    const { app } = setup();
    delete process.env.RACE_CONTROL_SECRET;
    const append = jest.spyOn(fs, 'appendFile').mockResolvedValue();

    await request(app).post('/api/race-control/setup')
      .set('Host', '192.168.0.10:3001')
      .set('Origin', 'http://192.168.0.10:3001').expect(403);
    await request(app).post('/api/race-control/setup')
      .set('Host', 'localhost:3001')
      .set('Origin', 'https://evil.test').expect(403);
    await request(app).post('/api/race-control/setup')
      .set('Host', 'localhost:3001').expect(403);
    expect(append).not.toHaveBeenCalled();

    process.env.RACE_CONTROL_SECRET = 'short';
    await request(app).post('/api/race-control/setup')
      .set('Host', 'localhost:3001')
      .set('Origin', 'http://localhost:5173').expect(409);
    expect(append).not.toHaveBeenCalled();
  });

  test('existing env key is never silently overwritten', async () => {
    const { app } = setup();
    delete process.env.RACE_CONTROL_SECRET;
    jest.spyOn(fs, 'readFile').mockResolvedValue('SITE_NAME=test\nRACE_CONTROL_SECRET=existing\n');
    const append = jest.spyOn(fs, 'appendFile').mockResolvedValue();

    await request(app).post('/api/race-control/setup')
      .set('Host', 'localhost:3001')
      .set('Origin', 'http://localhost:5173').expect(409);
    expect(append).not.toHaveBeenCalled();
  });

  test('missing server secret disables the new feature', async () => {
    const { app } = setup();
    delete process.env.RACE_CONTROL_SECRET;
    const status = await request(app).get('/api/race-control/status').expect(200);
    expect(status.body.enabled).toBe(false);
    await request(app).post('/api/race-control/driver-link').set('Authorization', `Bearer ${secret}`)
      .send({ sessionId: 'race-1', driverId: 'driver-1' }).expect(503);
  });
});

describe('legacy write boundaries', () => {
  const previousSecret = process.env.RACE_CONTROL_SECRET;
  beforeEach(() => { process.env.RACE_CONTROL_SECRET = secret; });
  afterEach(() => {
    if (previousSecret === undefined) delete process.env.RACE_CONTROL_SECRET;
    else process.env.RACE_CONTROL_SECRET = previousSecret;
  });

  const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
  const requestFor = ({ address, origin, token, method = 'POST', path = '/sessions/race-1/resume' }) => ({
    socket: { remoteAddress: address }, method, path,
    get: (name) => ({ host: 'localhost:3001', origin, authorization: token && `Bearer ${token}` }[name]),
  });

  test('remote legacy writes require director credentials, but GET stays readable', () => {
    let res = response(), next = jest.fn();
    remoteWriteGuard(requestFor({ address: '192.168.1.5' }), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();

    res = response(); next = jest.fn();
    remoteWriteGuard(requestFor({ address: '192.168.1.5', token: secret }), res, next);
    expect(next).toHaveBeenCalledTimes(1);

    res = response(); next = jest.fn();
    remoteWriteGuard(requestFor({ address: '192.168.1.5', method: 'GET' }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('loopback browser writes require a trusted Origin', () => {
    let res = response(), next = jest.fn();
    remoteWriteGuard(requestFor({ address: '127.0.0.1', origin: 'https://evil.test' }), res, next);
    expect(res.status).toHaveBeenCalledWith(403);

    res = response(); next = jest.fn();
    remoteWriteGuard(requestFor({ address: '::1', origin: 'http://localhost:5173' }), res, next);
    expect(next).toHaveBeenCalledTimes(1);

    // Reject DNS-rebinding origins even if their Host header matches.
    res = response(); next = jest.fn();
    const rebound = requestFor({ address: '127.0.0.1', origin: 'http://evil.test:3001' });
    rebound.get = (name) => ({ host: 'evil.test:3001', origin: 'http://evil.test:3001' }[name]);
    remoteWriteGuard(rebound, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('remote Socket.IO clients cannot use legacy race-control events', () => {
    expect(mayControlSocket({ handshake: { address: '192.168.1.6', headers: { host: 'localhost:3001' } } })).toBe(false);
    expect(mayControlSocket({ handshake: { address: '127.0.0.1', headers: { host: 'localhost:3001', origin: 'http://localhost:5173' } } })).toBe(true);
    expect(mayControlSocket({ handshake: { address: '127.0.0.1', headers: { host: 'localhost:3001', origin: 'https://evil.test' } } })).toBe(false);
  });
});


describe('SessionService physical-first pause and resume ordering', () => {
  test('does not report paused when the CU stop fails', async () => {
    const order = [];
    const service = {
      activeSessionId: 'race-1', sessionStatus: 'active', sessionConfig: { pauses: [] },
      syncService: { isConnected: () => true, stopRace: jest.fn(async () => { order.push('stop'); throw new Error('CU disconnected'); }) },
      prisma: { session: { update: jest.fn(async () => order.push('database')) } },
      emit: jest.fn(), emitStatusChanged: jest.fn(),
    };
    await expect(SessionService.prototype.pauseSession.call(service)).rejects.toThrow('CU disconnected');
    expect(order).toEqual(['stop']);
    expect(service.sessionStatus).toBe('active');
    expect(service.sessionConfig.pauses).toEqual([]);
  });

  test('does not mark a session resumed if preparing the CU fails', async () => {
    const order = [];
    const service = {
      activeSessionId: 'race-1', sessionStatus: 'paused',
      syncService: { isConnected: () => true, prepareRace: jest.fn(async () => { order.push('lights'); throw new Error('timeout'); }) },
      prisma: { session: { update: jest.fn(async () => order.push('database')) } },
      emit: jest.fn(), emitStatusChanged: jest.fn(),
    };
    await expect(SessionService.prototype.resumeSession.call(service)).rejects.toThrow('timeout');
    expect(order).toEqual(['lights']);
    expect(service.sessionStatus).toBe('paused');
  });
});
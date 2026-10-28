import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import raceControl, {
  setRaceControlServices,
  remoteWriteGuard,
  mayControlSocket,
  lanAddresses,
} from '../routes/raceControl.js';
import { SessionService } from '../services/SessionService.js';

const secret = 'this-is-a-long-private-race-director-secret-123456';
const assignment = { id: 'sd-1', sessionId: 'race-1', driverId: 'driver-1', controller: 2, deletedAt: null };

function setup() {
  const session = {
    activeSessionId: 'race-1',
    sessionStatus: 'active',
    pauseSession: jest.fn(async () => {
      session.sessionStatus = 'paused';
    }),
    resumeSession: jest.fn(async () => {
      session.sessionStatus = 'active';
    }),
    stopSession: jest.fn(async () => {
      session.sessionStatus = 'finished';
    }),
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
  const res = await request(app)
    .post('/api/race-control/driver-link')
    .set('Authorization', `Bearer ${secret}`)
    .send({ sessionId: 'race-1', driverId: 'driver-1' });
  expect(res.status).toBe(200);
  return res.body.token;
}

describe('race director and driver-scoped chaos access', () => {
  const previousSecret = process.env.RACE_CONTROL_SECRET;
  const previousRequirement = process.env.RACE_CONTROL_REQUIRE_KEY;
  beforeEach(() => {
    process.env.RACE_CONTROL_SECRET = secret;
    process.env.RACE_CONTROL_REQUIRE_KEY = 'true';
  });
  afterEach(() => {
    if (previousSecret === undefined) delete process.env.RACE_CONTROL_SECRET;
    else process.env.RACE_CONTROL_SECRET = previousSecret;
    if (previousRequirement === undefined) delete process.env.RACE_CONTROL_REQUIRE_KEY;
    else process.env.RACE_CONTROL_REQUIRE_KEY = previousRequirement;
    jest.restoreAllMocks();
  });

  test('refuses to mint driver access without the director credential', async () => {
    const { app } = setup();
    await request(app)
      .post('/api/race-control/driver-link')
      .send({ sessionId: 'race-1', driverId: 'driver-1' })
      .expect(403);
    await request(app)
      .post('/api/race-control/driver-link')
      .set('Authorization', 'Bearer forged')
      .send({ sessionId: 'race-1', driverId: 'driver-1' })
      .expect(403);
  });

  test('issues access only for one current driver assignment', async () => {
    const { app, session } = setup();
    session.prisma.session.findUnique.mockResolvedValueOnce({
      id: 'race-1',
      status: 'draft',
      drivers: [assignment, { ...assignment, id: 'sd-2', controller: 3 }],
    });
    await request(app)
      .post('/api/race-control/driver-link')
      .set('Authorization', `Bearer ${secret}`)
      .send({ sessionId: 'race-1', driverId: 'driver-1' })
      .expect(409);
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
    await request(app)
      .post('/api/race-control/director/resume')
      .set('Authorization', `Bearer ${token}`)
      .send({ sessionId: 'race-1' })
      .expect(403);
    await request(app)
      .post('/api/race-control/director/stop')
      .set('Authorization', `Bearer ${token}`)
      .send({ sessionId: 'race-1' })
      .expect(403);
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
    await request(app)
      .post('/api/race-control/director/resume')
      .set('Authorization', `Bearer ${secret}`)
      .send({ sessionId: 'race-1' })
      .expect(200);
    await request(app)
      .post('/api/race-control/director/stop')
      .set('Authorization', `Bearer ${secret}`)
      .send({ sessionId: 'race-1' })
      .expect(200);
    expect(session.resumeSession).toHaveBeenCalledTimes(1);
    expect(session.stopSession).toHaveBeenCalledTimes(1);
  });

  test('unconfigured status offers setup only on the race PC', async () => {
    const { app } = setup();
    delete process.env.RACE_CONTROL_SECRET;

    const local = await request(app).get('/api/race-control/status').set('Host', 'localhost:3001').expect(200);
    expect(local.body).toMatchObject({ success: true, enabled: false, setupAvailable: true });
    expect(local.body.secret).toBeUndefined();

    const remoteHost = await request(app).get('/api/race-control/status').set('Host', '192.168.0.10:3001').expect(200);
    expect(remoteHost.body.setupAvailable).toBe(false);
  });

  test('an invalid preconfigured secret does not offer first-run setup', async () => {
    const { app } = setup();
    process.env.RACE_CONTROL_SECRET = 'short';

    const status = await request(app).get('/api/race-control/status').set('Host', 'localhost:3001').expect(200);
    expect(status.body).toMatchObject({ success: true, enabled: false, setupAvailable: false });
  });

  test('first-run setup generates and saves a key without restarting', async () => {
    const { app } = setup();
    delete process.env.RACE_CONTROL_SECRET;
    jest.spyOn(fs, 'readFile').mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const append = jest.spyOn(fs, 'appendFile').mockResolvedValue();

    const result = await request(app)
      .post('/api/race-control/setup')
      .set('Host', 'localhost:3001')
      .set('Origin', 'http://localhost:5173')
      .expect(200);

    expect(result.body.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(process.env.RACE_CONTROL_SECRET).toBe(result.body.secret);
    expect(append).toHaveBeenCalledWith(
      expect.stringMatching(/packages[\\/]backend[\\/]\.env$/),
      `RACE_CONTROL_SECRET=${result.body.secret}\n`,
      { mode: 0o600 }
    );
    await request(app)
      .get('/api/race-control/director/check')
      .set('Authorization', `Bearer ${result.body.secret}`)
      .expect(200);
    await request(app)
      .post('/api/race-control/setup')
      .set('Host', 'localhost:3001')
      .set('Origin', 'http://localhost:5173')
      .expect(409);
    expect(append).toHaveBeenCalledTimes(1);
  });

  test('first-run setup rejects non-local hosts, untrusted origins and existing keys', async () => {
    const { app } = setup();
    delete process.env.RACE_CONTROL_SECRET;
    const append = jest.spyOn(fs, 'appendFile').mockResolvedValue();

    await request(app)
      .post('/api/race-control/setup')
      .set('Host', '192.168.0.10:3001')
      .set('Origin', 'http://192.168.0.10:3001')
      .expect(403);
    await request(app)
      .post('/api/race-control/setup')
      .set('Host', 'localhost:3001')
      .set('Origin', 'https://evil.test')
      .expect(403);
    await request(app).post('/api/race-control/setup').set('Host', 'localhost:3001').expect(403);
    expect(append).not.toHaveBeenCalled();

    process.env.RACE_CONTROL_SECRET = 'short';
    await request(app)
      .post('/api/race-control/setup')
      .set('Host', 'localhost:3001')
      .set('Origin', 'http://localhost:5173')
      .expect(409);
    expect(append).not.toHaveBeenCalled();
  });

  test('existing env key is never silently overwritten', async () => {
    const { app } = setup();
    delete process.env.RACE_CONTROL_SECRET;
    jest.spyOn(fs, 'readFile').mockResolvedValue('SITE_NAME=test\nRACE_CONTROL_SECRET=existing\n');
    const append = jest.spyOn(fs, 'appendFile').mockResolvedValue();

    await request(app)
      .post('/api/race-control/setup')
      .set('Host', 'localhost:3001')
      .set('Origin', 'http://localhost:5173')
      .expect(409);
    expect(append).not.toHaveBeenCalled();
  });

  test('first-run setup accepts a custom key but rejects unsafe or short keys', async () => {
    const { app } = setup();
    delete process.env.RACE_CONTROL_SECRET;
    jest.spyOn(fs, 'readFile').mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const append = jest.spyOn(fs, 'appendFile').mockResolvedValue();
    const url = '/api/race-control/setup';
    for (const value of ['too-short', 'x'.repeat(31), 'x'.repeat(129), `x${'a'.repeat(30)}\nBAD=1`, 10]) {
      await request(app)
        .post(url)
        .set('Host', 'localhost:3001')
        .set('Origin', 'http://localhost:5173')
        .send({ secret: value })
        .expect(400);
    }
    expect(append).not.toHaveBeenCalled();
    const requested = 'Test_Key-'.padEnd(40, 'a');
    const response = await request(app)
      .post(url)
      .set('Host', 'localhost:3001')
      .set('Origin', 'http://localhost:5173')
      .send({ secret: requested })
      .expect(200);
    expect(response.body.secret).toBe(requested);
    expect(append).toHaveBeenCalledWith(
      expect.stringMatching(/packages[\\/]backend[\\/]\.env$/),
      `RACE_CONTROL_SECRET=${requested}\n`,
      { mode: 0o600 }
    );
    await request(app).get('/api/race-control/director/check').set('Authorization', `Bearer ${requested}`).expect(200);
  });

  test('credential rotation requires the current key and atomically persists the replacement', async () => {
    const { app } = setup();
    const oldToken = await issueToken(app);
    jest.spyOn(fs, 'readFile').mockResolvedValue(`SITE_NAME=test\nRACE_CONTROL_SECRET=${secret}\nMODE=home\n`);
    const write = jest.spyOn(fs, 'writeFile').mockResolvedValue();
    const rename = jest.spyOn(fs, 'rename').mockResolvedValue();
    const replacement = 'My_New_Director-Key-2026'.padEnd(40, 'A');
    const url = '/api/race-control/director/credential';

    await request(app).post(url).send({ secret: replacement }).expect(403);
    await request(app).post(url).set('Authorization', 'Bearer wrong').send({ secret: replacement }).expect(403);
    await request(app).post(url).set('Authorization', `Bearer ${secret}`).send({ secret: 'short' }).expect(400);
    await request(app).post(url).set('Authorization', `Bearer ${secret}`).send({ secret: secret }).expect(409);
    expect(write).not.toHaveBeenCalled();

    const response = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${secret}`)
      .send({ secret: replacement })
      .expect(200);
    expect(response.body).toEqual({ success: true });
    const [temporary, written, opts] = write.mock.calls[0];
    expect(temporary).toMatch(/packages[\\/]backend[\\/]\.env\.[0-9a-f]{16}\.tmp$/);
    expect(written).toBe(`SITE_NAME=test\nRACE_CONTROL_SECRET=${replacement}\nMODE=home\n`);
    expect(opts).toEqual({ mode: 0o600, flag: 'wx' });
    expect(rename).toHaveBeenCalledWith(temporary, expect.stringMatching(/packages[\\/]backend[\\/]\.env$/));
    expect(process.env.RACE_CONTROL_SECRET).toBe(replacement);

    await request(app).get('/api/race-control/director/check').set('Authorization', `Bearer ${secret}`).expect(403);
    await request(app)
      .get('/api/race-control/director/check')
      .set('Authorization', `Bearer ${replacement}`)
      .expect(200);
    await request(app).post('/api/race-control/chaos').set('Authorization', `Bearer ${oldToken}`).expect(403);
  });

  test('rotation refuses externally managed keys and retains the active key after write failure', async () => {
    const { app } = setup();
    const url = '/api/race-control/director/credential';
    const replacement = 'Another_New_Director_Credential_2026';
    const read = jest.spyOn(fs, 'readFile').mockResolvedValue('RACE_CONTROL_SECRET=other-key\n');
    const write = jest.spyOn(fs, 'writeFile').mockResolvedValue();
    const rename = jest.spyOn(fs, 'rename').mockResolvedValue();
    await request(app).post(url).set('Authorization', `Bearer ${secret}`).send({ secret: replacement }).expect(409);
    expect(write).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();

    read.mockResolvedValue(`RACE_CONTROL_SECRET=${secret}\n`);
    write.mockRejectedValueOnce(new Error('disk full'));
    const unlink = jest.spyOn(fs, 'unlink').mockResolvedValue();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await request(app).post(url).set('Authorization', `Bearer ${secret}`).send({ secret: replacement }).expect(500);
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(process.env.RACE_CONTROL_SECRET).toBe(secret);
    expect(rename).not.toHaveBeenCalled();
    await request(app).get('/api/race-control/director/check').set('Authorization', `Bearer ${secret}`).expect(200);
  });

  test('director can turn the key requirement off and back on without erasing the signing secret', async () => {
    const { app } = setup();
    const url = '/api/race-control/director/key-required';
    const read = jest.spyOn(fs, 'readFile').mockResolvedValue(`RACE_CONTROL_SECRET=${secret}\n`);
    const write = jest.spyOn(fs, 'writeFile').mockResolvedValue();
    const rename = jest.spyOn(fs, 'rename').mockResolvedValue();

    await request(app).post(url).send({ keyRequired: false }).expect(403);
    await request(app)
      .post(url)
      .set('Authorization', `Bearer ${secret}`)
      .send({ keyRequired: 'false' })
      .expect(400);

    const disabled = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${secret}`)
      .send({ keyRequired: false })
      .expect(200);
    expect(disabled.body).toEqual({ success: true, keyRequired: false });
    expect(write.mock.calls[0][1]).toBe(`RACE_CONTROL_SECRET=${secret}\nRACE_CONTROL_REQUIRE_KEY=false\n`);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(process.env.RACE_CONTROL_REQUIRE_KEY).toBe('false');

    const status = await request(app).get('/api/race-control/status').expect(200);
    expect(status.body).toMatchObject({ enabled: true, keyRequired: false });
    await request(app).get('/api/race-control/director/check').expect(200);
    await request(app)
      .post('/api/race-control/driver-link')
      .send({ sessionId: 'race-1', driverId: 'driver-1' })
      .expect(200);

    read.mockResolvedValue(`RACE_CONTROL_SECRET=${secret}\nRACE_CONTROL_REQUIRE_KEY=false\n`);
    await request(app).post(url).send({ keyRequired: true }).expect(200);
    expect(write.mock.calls[1][1]).toBe(`RACE_CONTROL_SECRET=${secret}\nRACE_CONTROL_REQUIRE_KEY=true\n`);
    await request(app).get('/api/race-control/director/check').expect(403);
    await request(app).get('/api/race-control/director/check').set('Authorization', `Bearer ${secret}`).expect(200);
  });

  test('failed save and externally managed settings never disable authentication', async () => {
    const { app } = setup();
    const url = '/api/race-control/director/key-required';
    const read = jest.spyOn(fs, 'readFile').mockResolvedValue('RACE_CONTROL_REQUIRE_KEY=false\n');
    const write = jest.spyOn(fs, 'writeFile').mockResolvedValue();
    const rename = jest.spyOn(fs, 'rename').mockResolvedValue();

    await request(app).post(url).set('Authorization', `Bearer ${secret}`).send({ keyRequired: false }).expect(409);
    expect(write).not.toHaveBeenCalled();
    read.mockResolvedValue(`RACE_CONTROL_SECRET=${secret}\n`);
    write.mockRejectedValueOnce(new Error('disk full'));
    jest.spyOn(fs, 'unlink').mockResolvedValue();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await request(app).post(url).set('Authorization', `Bearer ${secret}`).send({ keyRequired: false }).expect(500);
    expect(rename).not.toHaveBeenCalled();
    expect(process.env.RACE_CONTROL_REQUIRE_KEY).toBe('true');
    await request(app).get('/api/race-control/director/check').expect(403);
  });

  test('missing server secret disables the new feature', async () => {
    const { app } = setup();
    delete process.env.RACE_CONTROL_SECRET;
    const status = await request(app).get('/api/race-control/status').expect(200);
    expect(status.body.enabled).toBe(false);
    await request(app)
      .post('/api/race-control/driver-link')
      .set('Authorization', `Bearer ${secret}`)
      .send({ sessionId: 'race-1', driverId: 'driver-1' })
      .expect(503);
  });
});

describe('legacy write boundaries', () => {
  const previousSecret = process.env.RACE_CONTROL_SECRET;
  beforeEach(() => {
    process.env.RACE_CONTROL_SECRET = secret;
  });
  afterEach(() => {
    if (previousSecret === undefined) delete process.env.RACE_CONTROL_SECRET;
    else process.env.RACE_CONTROL_SECRET = previousSecret;
  });

  const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
  const requestFor = ({ address, origin, token, method = 'POST', path = '/sessions/race-1/resume' }) => ({
    socket: { remoteAddress: address },
    method,
    path,
    get: (name) => ({ host: 'localhost:3001', origin, authorization: token && `Bearer ${token}` })[name],
  });

  test('remote legacy writes require director credentials, but GET stays readable', () => {
    let res = response(),
      next = jest.fn();
    remoteWriteGuard(requestFor({ address: '192.168.1.5' }), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();

    res = response();
    next = jest.fn();
    remoteWriteGuard(requestFor({ address: '192.168.1.5', token: secret }), res, next);
    expect(next).toHaveBeenCalledTimes(1);

    res = response();
    next = jest.fn();
    remoteWriteGuard(requestFor({ address: '192.168.1.5', method: 'GET' }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('loopback browser writes require a trusted Origin', () => {
    let res = response(),
      next = jest.fn();
    remoteWriteGuard(requestFor({ address: '127.0.0.1', origin: 'https://evil.test' }), res, next);
    expect(res.status).toHaveBeenCalledWith(403);

    res = response();
    next = jest.fn();
    remoteWriteGuard(requestFor({ address: '::1', origin: 'http://localhost:5173' }), res, next);
    expect(next).toHaveBeenCalledTimes(1);

    // Reject DNS-rebinding origins even if their Host header matches.
    res = response();
    next = jest.fn();
    const rebound = requestFor({ address: '127.0.0.1', origin: 'http://evil.test:3001' });
    rebound.get = (name) => ({ host: 'evil.test:3001', origin: 'http://evil.test:3001' })[name];
    remoteWriteGuard(rebound, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('remote Socket.IO clients cannot use legacy race-control events', () => {
    expect(mayControlSocket({ handshake: { address: '192.168.1.6', headers: { host: 'localhost:3001' } } })).toBe(
      false
    );
    expect(
      mayControlSocket({
        handshake: { address: '127.0.0.1', headers: { host: 'localhost:3001', origin: 'http://localhost:5173' } },
      })
    ).toBe(true);
    expect(
      mayControlSocket({
        handshake: { address: '127.0.0.1', headers: { host: 'localhost:3001', origin: 'https://evil.test' } },
      })
    ).toBe(false);
  });
});

describe('SessionService physical-first pause and resume ordering', () => {
  test('does not report paused when the CU stop fails', async () => {
    const order = [];
    const service = {
      activeSessionId: 'race-1',
      sessionStatus: 'active',
      sessionConfig: { pauses: [] },
      syncService: {
        isConnected: () => true,
        stopRace: jest.fn(async () => {
          order.push('stop');
          throw new Error('CU disconnected');
        }),
      },
      prisma: { session: { update: jest.fn(async () => order.push('database')) } },
      emit: jest.fn(),
      emitStatusChanged: jest.fn(),
    };
    await expect(SessionService.prototype.pauseSession.call(service)).rejects.toThrow('CU disconnected');
    expect(order).toEqual(['stop']);
    expect(service.sessionStatus).toBe('active');
    expect(service.sessionConfig.pauses).toEqual([]);
  });

  test('does not mark a session resumed if preparing the CU fails', async () => {
    const order = [];
    const service = {
      activeSessionId: 'race-1',
      sessionStatus: 'paused',
      syncService: {
        isConnected: () => true,
        prepareRace: jest.fn(async () => {
          order.push('lights');
          throw new Error('timeout');
        }),
      },
      prisma: { session: { update: jest.fn(async () => order.push('database')) } },
      emit: jest.fn(),
      emitStatusChanged: jest.fn(),
    };
    await expect(SessionService.prototype.resumeSession.call(service)).rejects.toThrow('timeout');
    expect(order).toEqual(['lights']);
    expect(service.sessionStatus).toBe('paused');
  });
});

describe('VSC director authorization and legacy speed boundary', () => {
  const previousSecret = process.env.RACE_CONTROL_SECRET;

  beforeEach(() => {
    process.env.RACE_CONTROL_SECRET = secret;
  });
  afterEach(() => {
    if (previousSecret === undefined) delete process.env.RACE_CONTROL_SECRET;
    else process.env.RACE_CONTROL_SECRET = previousSecret;
  });

  function setupVsc() {
    const { app, session, sync } = setup();
    session.vsc = null;
    session.getVscState = jest.fn(() =>
      session.vsc
        ? { status: session.vsc.status, sessionId: 'race-1', active: true, cap: session.vsc.cap }
        : { status: 'inactive', active: false }
    );
    session.startVsc = jest.fn(async (cap) => {
      session.vsc = { status: 'active', cap };
      return session.getVscState();
    });
    session.endVsc = jest.fn(async () => {
      session.vsc = null;
      return session.getVscState();
    });
    return { app, session, sync };
  }

  test('exposes VSC state without exposing director credentials', async () => {
    const { app } = setupVsc();
    const result = await request(app).get('/api/race-control/vsc').expect(200);

    expect(result.body).toEqual({
      success: true,
      data: { status: 'inactive', active: false },
    });
  });

  test('allows only the director to start and end VSC', async () => {
    const { app, session } = setupVsc();
    const url = '/api/race-control/director/vsc/start';
    const body = { sessionId: 'race-1', cap: 3, durationSeconds: 0 };

    await request(app).post(url).send(body).expect(403);
    await request(app).post(url).set('Authorization', 'Bearer forged').send(body).expect(403);
    await request(app)
      .post(url)
      .set('Authorization', 'Bearer ' + secret)
      .send(body)
      .expect(200);

    expect(session.startVsc).toHaveBeenCalledWith(3, 0);
    await request(app)
      .post('/api/race-control/director/vsc/end')
      .set('Authorization', 'Bearer ' + secret)
      .send({ sessionId: 'race-1' })
      .expect(200);
    expect(session.endVsc).toHaveBeenCalledTimes(1);
  });

  test('rejects invalid cap, duration and a stale session before calling the CU', async () => {
    const { app, session } = setupVsc();
    const url = '/api/race-control/director/vsc/start';
    const auth = 'Bearer ' + secret;

    await request(app).post(url).set('Authorization', auth).send({ sessionId: 'race-1', cap: 0 }).expect(400);
    await request(app)
      .post(url)
      .set('Authorization', auth)
      .send({ sessionId: 'race-1', cap: 3, durationSeconds: 2 })
      .expect(400);
    await request(app).post(url).set('Authorization', auth).send({ sessionId: 'old-race', cap: 3 }).expect(409);

    expect(session.startVsc).not.toHaveBeenCalled();
  });

  test.each(['activating', 'active', 'restoring', 'restore_failed', 'disconnected'])(
    'blocks the direct CU speed endpoint while VSC is %s',
    (status) => {
      const { session } = setupVsc();
      session.vsc = { status };
      const next = jest.fn();
      const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const req = { method: 'POST', path: '/bluetooth/set-speed', socket: { remoteAddress: '127.0.0.1' } };

      remoteWriteGuard(req, response, next);

      expect(response.status).toHaveBeenCalledWith(409);
      expect(next).not.toHaveBeenCalled();
    }
  );
});

describe('driver tyre requests and manual pit confirmation', () => {
  const previousSecret = process.env.RACE_CONTROL_SECRET;

  beforeEach(() => {
    process.env.RACE_CONTROL_SECRET = secret;
  });
  afterEach(() => {
    if (previousSecret === undefined) delete process.env.RACE_CONTROL_SECRET;
    else process.env.RACE_CONTROL_SECRET = previousSecret;
  });

  function setupTyres() {
    const { app, session } = setup();
    session.requestTyreChange = jest.fn().mockResolvedValue({ tyreType: 'dry', pendingTyreType: 'wet' });
    session.confirmTyreChange = jest.fn().mockResolvedValue({
      sessionId: 'race-1',
      sessionDriverId: 'sd-1',
      fromType: 'dry',
      toType: 'wet',
      source: 'director',
    });
    return { app, session };
  }

  test('only the signed driver may request tyres for their current assignment', async () => {
    const { app, session } = setupTyres();
    const token = await issueToken(app);
    await request(app).post('/api/race-control/driver/tyres').send({ tyreType: 'wet' }).expect(403);
    await request(app)
      .post('/api/race-control/driver/tyres')
      .set('Authorization', 'Bearer forged')
      .send({ tyreType: 'wet' })
      .expect(403);

    const result = await request(app)
      .post('/api/race-control/driver/tyres')
      .set('Authorization', `Bearer ${token}`)
      .send({ tyreType: 'wet' })
      .expect(200);
    expect(result.body.data.pendingTyreType).toBe('wet');
    expect(session.requestTyreChange).toHaveBeenCalledWith('race-1', 'sd-1', 'wet');

    session.prisma.sessionDriver.findMany.mockResolvedValueOnce([{ ...assignment, controller: 1 }]);
    await request(app)
      .post('/api/race-control/driver/tyres')
      .set('Authorization', `Bearer ${token}`)
      .send({ tyreType: 'dry' })
      .expect(403);

    session.activeSessionId = 'another-race';
    await request(app)
      .post('/api/race-control/driver/tyres')
      .set('Authorization', `Bearer ${token}`)
      .send({ tyreType: 'wet' })
      .expect(409);
    expect(session.requestTyreChange).toHaveBeenCalledTimes(1);
  });

  test('driver token cannot confirm a physical tyre change; only the director can', async () => {
    const { app, session } = setupTyres();
    const token = await issueToken(app);
    const url = '/api/race-control/director/tyres/confirm';
    const body = { sessionId: 'race-1', sessionDriverId: 'sd-1' };

    await request(app).post(url).send(body).expect(403);
    await request(app).post(url).set('Authorization', `Bearer ${token}`).send(body).expect(403);
    await request(app).post(url).set('Authorization', `Bearer ${secret}`).send({ sessionId: 'race-1' }).expect(400);

    const result = await request(app).post(url).set('Authorization', `Bearer ${secret}`).send(body).expect(200);
    expect(result.body.data.source).toBe('director');
    expect(session.confirmTyreChange).toHaveBeenCalledWith('race-1', 'sd-1');
  });

  test('a rejected or already completed tyre operation is not reported as success', async () => {
    const { app, session } = setupTyres();
    session.confirmTyreChange.mockRejectedValueOnce(
      Object.assign(new Error('No pending tyre change'), { status: 409 })
    );
    await request(app)
      .post('/api/race-control/director/tyres/confirm')
      .set('Authorization', `Bearer ${secret}`)
      .send({ sessionId: 'race-1', sessionDriverId: 'sd-1' })
      .expect(409);

    session.requestTyreChange.mockRejectedValueOnce(Object.assign(new Error('Invalid tyre choice'), { status: 400 }));
    const token = await issueToken(app);
    const denied = await request(app)
      .post('/api/race-control/driver/tyres')
      .set('Authorization', `Bearer ${token}`)
      .send({ tyreType: 'rainbow' })
      .expect(400);
    expect(denied.body.success).toBe(false);
  });
});

describe('director penalty permissions', () => {
  const previousSecret = process.env.RACE_CONTROL_SECRET;
  beforeEach(() => {
    process.env.RACE_CONTROL_SECRET = secret;
  });
  afterEach(() => {
    if (previousSecret === undefined) delete process.env.RACE_CONTROL_SECRET;
    else process.env.RACE_CONTROL_SECRET = previousSecret;
  });

  const input = {
    sessionId: 'race-1',
    sessionDriverId: 'sd-1',
    kind: 'time',
    amount: 5000,
    reason: 'Unsafe overtake',
    requestId: 'penalty-request-route-1',
  };

  function setupPenalties() {
    const { app, session } = setup();
    const penalty = { id: 'pen-1', ...input, status: 'active', controller: 2 };
    session.issuePenalty = jest.fn().mockResolvedValue(penalty);
    session.revokePenalty = jest.fn().mockResolvedValue({ ...penalty, status: 'revoked' });
    return { app, session };
  }

  test('only the director may issue or revoke penalties', async () => {
    const { app, session } = setupPenalties();
    const token = await issueToken(app);

    await request(app).post('/api/race-control/director/penalties').send(input).expect(403);
    await request(app)
      .post('/api/race-control/director/penalties')
      .set('Authorization', `Bearer ${token}`)
      .send(input)
      .expect(403);
    const issued = await request(app)
      .post('/api/race-control/director/penalties')
      .set('Authorization', `Bearer ${secret}`)
      .send(input)
      .expect(201);
    expect(issued.body.data.id).toBe('pen-1');
    expect(session.issuePenalty).toHaveBeenCalledWith(input);

    await request(app)
      .post('/api/race-control/director/penalties/pen-1/revoke')
      .send({ sessionId: 'race-1' })
      .expect(403);
    await request(app)
      .post('/api/race-control/director/penalties/pen-1/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({ sessionId: 'race-1' })
      .expect(403);
    await request(app)
      .post('/api/race-control/director/penalties/pen-1/revoke')
      .set('Authorization', `Bearer ${secret}`)
      .send({ sessionId: 'race-1' })
      .expect(200);
    expect(session.revokePenalty).toHaveBeenCalledWith('race-1', 'pen-1');
  });

  test('invalid requests return a validation error instead of a false success', async () => {
    const { app, session } = setupPenalties();
    session.issuePenalty.mockRejectedValueOnce(
      Object.assign(new Error('Invalid race penalty details'), { status: 400 })
    );
    const res = await request(app)
      .post('/api/race-control/director/penalties')
      .set('Authorization', `Bearer ${secret}`)
      .send({ ...input, amount: -1 })
      .expect(400);
    expect(res.body).toMatchObject({ success: false, error: 'Invalid race penalty details' });
  });

  test('replayed requests are rejected and serialized with other director commands', async () => {
    const { app, session } = setupPenalties();
    session.issuePenalty.mockRejectedValueOnce(Object.assign(new Error('Duplicate penalty request'), { status: 409 }));
    const res = await request(app)
      .post('/api/race-control/director/penalties')
      .set('Authorization', `Bearer ${secret}`)
      .send(input)
      .expect(409);
    expect(res.body.success).toBe(false);
  });
});

describe('director-only damage repair confirmation', () => {
  const previousSecret = process.env.RACE_CONTROL_SECRET;

  beforeEach(() => {
    process.env.RACE_CONTROL_SECRET = secret;
  });
  afterEach(() => {
    if (previousSecret === undefined) delete process.env.RACE_CONTROL_SECRET;
    else process.env.RACE_CONTROL_SECRET = previousSecret;
  });

  function setupDamage() {
    const { app, session } = setup();
    session.confirmDamageRepair = jest.fn().mockResolvedValue({
      damageStatus: 'repaired',
      damageRepairSource: 'director',
      damageRepairPitStopId: 'pit-1',
    });
    return { app, session };
  }

  test('only the director may confirm a recorded pit repair', async () => {
    const { app, session } = setupDamage();
    const token = await issueToken(app);
    const path = '/api/race-control/director/damage/repair';
    const data = { sessionId: 'race-1', sessionDriverId: 'sd-1', pitStopId: 'pit-1' };

    await request(app).post(path).send(data).expect(403);
    await request(app).post(path).set('Authorization', `Bearer ${token}`).send(data).expect(403);
    await request(app).post(path).set('Authorization', 'Bearer forged').send(data).expect(403);
    await request(app)
      .post(path)
      .set('Authorization', `Bearer ${secret}`)
      .send({ sessionId: 'race-1', sessionDriverId: 'sd-1' })
      .expect(400);
    expect(session.confirmDamageRepair).not.toHaveBeenCalled();

    const result = await request(app).post(path).set('Authorization', `Bearer ${secret}`).send(data).expect(200);
    expect(result.body.data.damageStatus).toBe('repaired');
    expect(session.confirmDamageRepair).toHaveBeenCalledWith('race-1', 'sd-1', 'pit-1');
  });

  test('stale, invalid or repeated repair confirmation returns an error', async () => {
    const { app, session } = setupDamage();
    session.confirmDamageRepair.mockRejectedValueOnce(
      Object.assign(new Error('No eligible observed pit interval'), { status: 409 })
    );
    const response = await request(app)
      .post('/api/race-control/director/damage/repair')
      .set('Authorization', `Bearer ${secret}`)
      .send({ sessionId: 'race-1', sessionDriverId: 'sd-1', pitStopId: 'wrong-pit' })
      .expect(409);
    expect(response.body.success).toBe(false);
  });
});

describe('read-only LAN share addresses', () => {
  test('returns only real private IPv4 interfaces, deduplicated and sorted', () => {
    const interfaces = {
      zWiFi: [
        { family: 'IPv4', internal: false, address: '192.168.178.42' },
        { family: 'IPv6', internal: false, address: 'fd00::42' },
      ],
      aEthernet: [
        { family: 'IPv4', internal: false, address: '10.0.1.4' },
        { family: 'IPv4', internal: false, address: '172.31.2.3' },
        { family: 'IPv4', internal: false, address: '172.32.2.3' },
        { family: 'IPv4', internal: false, address: '8.8.8.8' },
        { family: 'IPv4', internal: true, address: '127.0.0.1' },
        { family: 'IPv4', internal: false, address: '192.168.178.42' },
      ],
      disabled: undefined,
    };

    expect(lanAddresses(interfaces)).toEqual([
      { name: 'aEthernet', address: '10.0.1.4' },
      { name: 'aEthernet', address: '172.31.2.3' },
      { name: 'zWiFi', address: '192.168.178.42' },
    ]);
    expect(lanAddresses({ lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] })).toEqual([]);
  });

  test('GET exposes only private addresses and never requires the director credential', async () => {
    const { app } = setup();
    const res = await request(app).get('/api/race-control/lan-addresses').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    for (const entry of res.body.data) {
      expect(entry).toEqual({ name: expect.any(String), address: expect.any(String) });
      expect(entry.address).not.toMatch(/^(?:127\.|169\.254\.)/);
    }
  });
});

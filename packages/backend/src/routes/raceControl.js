import express from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SessionStatus } from '@racehubos/shared';

const router = express.Router();
const TOKEN_LIFETIME_MS = 6 * 60 * 60 * 1000;
const directorEnvPath = fileURLToPath(new URL('../../.env', import.meta.url));
let setupInProgress = false;
let sessionService;
let syncService;
let controlQueue = Promise.resolve();

export function setRaceControlServices(session, sync) {
  sessionService = session;
  syncService = sync;
}

function directorSecret() {
  const secret = process.env.RACE_CONTROL_SECRET || '';
  return Buffer.byteLength(secret) >= 32 ? secret : null;
}

function bearer(req) {
  const match = /^Bearer ([^\s]+)$/.exec(req.get('authorization') || '');
  return match?.[1] || '';
}

function equals(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isDirector(req) {
  const secret = directorSecret();
  return Boolean(secret && equals(bearer(req), secret));
}

function requireDirector(req, res, next) {
  if (!directorSecret()) return res.status(503).json({ success: false, error: 'Race control is not configured' });
  if (!isDirector(req)) return res.status(403).json({ success: false, error: 'Race director credential required' });
  next();
}

export function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function trustedOrigin(origin, host) {
  if (!origin) return true; // CLI and non-browser requests do not supply Origin.
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const hostName = new URL(`http://${host}`).hostname;
    const loopbackHosts = ['localhost', '127.0.0.1', '[::1]'];
    return loopbackHosts.includes(url.hostname) && loopbackHosts.includes(hostName);
  } catch {
    return false;
  }
}

// The legacy browser race controls remain available on the race PC itself.
// Remote clients must provide the director credential for any legacy API writes.
// The new race-control routes enforce their own finer-grained credentials.
export function remoteWriteGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path.startsWith('/race-control/')) return next();
  if (req.path === '/bluetooth/set-speed' && sessionService?.vsc) {
    return res.status(409).json({ success: false, error: 'Direct car speed changes are blocked during VSC' });
  }
  const local = isLoopback(req.socket.remoteAddress) && trustedOrigin(req.get('origin'), req.get('host'));
  if (local || isDirector(req)) return next();
  res.status(403).json({ success: false, error: 'Remote writes require race director authorization' });
}

// Socket.IO command events are legacy controls and never accept driver tokens.
export function mayControlSocket(socket) {
  const request = socket.handshake;
  return isLoopback(request.address) && trustedOrigin(request.headers.origin, request.headers.host);
}

function signDriverAccess(assignment, expiresAt) {
  const data = Buffer.from(JSON.stringify({
    sid: assignment.sessionId,
    sdid: assignment.id,
    did: assignment.driverId,
    controller: assignment.controller,
    exp: expiresAt,
  })).toString('base64url');
  const signature = createHmac('sha256', directorSecret()).update(data).digest('base64url');
  return `${data}.${signature}`;
}

function decodeDriverAccess(token) {
  const secret = directorSecret();
  if (!secret || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return null;
  const expected = createHmac('sha256', secret).update(parts[0]).digest('base64url');
  if (!equals(parts[1], expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (
      typeof data.sid !== 'string' || !data.sid ||
      typeof data.sdid !== 'string' || !data.sdid ||
      typeof data.did !== 'string' || !data.did ||
      !Number.isInteger(data.controller) || data.controller < 0 || data.controller > 5 ||
      !Number.isSafeInteger(data.exp) || data.exp <= Date.now() || data.exp > Date.now() + TOKEN_LIFETIME_MS
    ) return null;
    return data;
  } catch {
    return null;
  }
}

function serialize(action) {
  const result = controlQueue.then(action);
  controlQueue = result.catch(() => {});
  return result;
}

router.get('/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const local = isLoopback(req.socket.remoteAddress) &&
    trustedOrigin('http://localhost', req.get('host'));
  res.json({ success: true, enabled: Boolean(directorSecret()), setupAvailable: !process.env.RACE_CONTROL_SECRET && local });
});

// Only the browser running on the race PC may bootstrap a director credential.
// The server generates and stores the key; never accept a secret from remote input.
router.post('/setup', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!isLoopback(req.socket.remoteAddress) ||
      !req.get('origin') || !trustedOrigin(req.get('origin'), req.get('host'))) {
    return res.status(403).json({ success: false, error: 'Initial setup is only available on the race PC at localhost' });
  }
  if (directorSecret()) return res.status(409).json({ success: false, error: 'Race control is already configured' });
  if (process.env.RACE_CONTROL_SECRET) {
    return res.status(409).json({ success: false, error: 'Existing invalid RACE_CONTROL_SECRET must be corrected in the server configuration' });
  }
  if (setupInProgress) return res.status(409).json({ success: false, error: 'Race control setup is already running' });

  setupInProgress = true;
  try {
    let existing = '';
    let envExists = true;
    try {
      existing = await fs.readFile(directorEnvPath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      envExists = false;
    }
    if (/^\s*(?:export\s+)?RACE_CONTROL_SECRET\s*=/m.test(existing)) {
      return res.status(409).json({ success: false, error: 'RACE_CONTROL_SECRET already exists in .env; correct it there' });
    }

    if (envExists) await fs.chmod(directorEnvPath, 0o600);
    const secret = randomBytes(32).toString('hex');
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    await fs.appendFile(directorEnvPath, `${prefix}RACE_CONTROL_SECRET=${secret}\n`, { mode: 0o600 });
    process.env.RACE_CONTROL_SECRET = secret;

    res.json({ success: true, secret });
  } catch (error) {
    console.error('[RaceControl] Local setup failed:', error);
    res.status(500).json({ success: false, error: 'Could not save the race-control secret; check server file permissions' });
  } finally {
    setupInProgress = false;
  }
});

router.get('/director/check', requireDirector, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true });
});

router.post('/driver-link', requireDirector, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { sessionId, driverId } = req.body || {};
  if (typeof sessionId !== 'string' || !sessionId || typeof driverId !== 'string' || !driverId) {
    return res.status(400).json({ success: false, error: 'Session and driver are required' });
  }
  try {
    const session = await sessionService.prisma.session.findUnique({
      where: { id: sessionId }, include: { drivers: true },
    });
    if (!session || session.deletedAt || !['draft', 'active', 'paused'].includes(session.status)) {
      return res.status(409).json({ success: false, error: 'Session is not available for driver access' });
    }
    const assignments = session.drivers.filter((d) => d.driverId === driverId && !d.deletedAt);
    if (assignments.length !== 1) {
      return res.status(409).json({ success: false, error: 'Driver assignment is missing or ambiguous' });
    }
    const expiresAt = Date.now() + TOKEN_LIFETIME_MS;
    res.json({ success: true, token: signDriverAccess({ ...assignments[0], sessionId }, expiresAt), expiresAt });
  } catch (error) {
    console.error('[RaceControl] Driver access issuance failed:', error);
    res.status(500).json({ success: false, error: 'Could not issue driver access' });
  }
});

router.post('/chaos', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const access = decodeDriverAccess(bearer(req));
  if (!access) return res.status(403).json({ success: false, error: 'Invalid or expired driver access' });

  try {
    const result = await serialize(async () => {
      const assignments = await sessionService.prisma.sessionDriver.findMany({
        where: { sessionId: access.sid, driverId: access.did, deletedAt: null },
      });
      if (assignments.length !== 1 || assignments[0].id !== access.sdid || assignments[0].controller !== access.controller) {
        return { code: 403, error: 'Driver assignment has changed; request a new link' };
      }
      if (sessionService.activeSessionId !== access.sid) {
        return { code: 409, error: 'This driver link is not for the current session' };
      }
      if (sessionService.sessionStatus === SessionStatus.PAUSED) return { code: 200, paused: true, alreadyPaused: true };
      if (sessionService.sessionStatus !== SessionStatus.ACTIVE) return { code: 409, error: 'Race is not running' };
      if (!syncService?.isConnected()) return { code: 503, error: 'Control Unit is disconnected' };

      await sessionService.pauseSession();
      console.info(`[RaceControl] Chaos pause by driver=${access.did}, controller=${access.controller + 1}, session=${access.sid}`);
      return { code: 200, paused: true, alreadyPaused: false };
    });
    if (result.error) return res.status(result.code).json({ success: false, error: result.error });
    res.json({ success: true, paused: result.paused, alreadyPaused: result.alreadyPaused });
  } catch (error) {
    console.error('[RaceControl] Chaos pause failed:', error);
    res.status(500).json({ success: false, error: 'Could not pause race' });
  }
});

router.get('/vsc', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: sessionService.getVscState() });
});

router.post('/director/vsc/:action', requireDirector, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { action } = req.params;
  if (!['start', 'end'].includes(action)) {
    return res.status(400).json({ success: false, error: 'Unknown VSC action' });
  }
  const { sessionId, cap, durationSeconds = 0 } = req.body || {};
  if (typeof sessionId !== 'string' || !sessionId) {
    return res.status(400).json({ success: false, error: 'Session is required' });
  }
  if (action === 'start' &&
      (!Number.isInteger(cap) || cap < 1 || cap > 10 ||
       !Number.isInteger(durationSeconds) || durationSeconds < 0 || durationSeconds > 3600 ||
       (durationSeconds > 0 && durationSeconds < 5))) {
    return res.status(400).json({ success: false, error: 'Invalid VSC cap/duration' });
  }
  try {
    const result = await serialize(async () => {
      const existing = sessionService.getVscState();
      if (action === 'start') {
        if (sessionService.activeSessionId !== sessionId) {
          return { code: 409, error: 'Not the current session' };
        }
        const state = await sessionService.startVsc(cap, durationSeconds);
        return { code: 200, state };
      }
      if (existing.status !== 'inactive' && existing.sessionId !== sessionId) {
        return { code: 409, error: 'VSC belongs to another session' };
      }
      const state = await sessionService.endVsc();
      return { code: 200, state };
    });
    if (result.error) return res.status(result.code).json({ success: false, error: result.error });
    console.info(`[RaceControl] Director VSC ${action} for session=${sessionId}`);
    res.json({ success: true, data: result.state });
  } catch (error) {
    console.error('[RaceControl] VSC command failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/director/penalties', requireDirector, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const penalty = await serialize(() => sessionService.issuePenalty(req.body || {}));
    console.info(`[RaceControl] Penalty issued for session=${penalty.sessionId}, controller=${penalty.controller + 1}`);
    res.status(201).json({ success: true, data: penalty });
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error('[RaceControl] Penalty issue failed:', error);
    res.status(status).json({ success: false, error: status === 500 ? 'Could not issue penalty' : error.message });
  }
});

router.post('/director/penalties/:id/revoke', requireDirector, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const penalty = await serialize(() => sessionService.revokePenalty(req.body?.sessionId, req.params.id));
    console.info(`[RaceControl] Penalty revoked for session=${penalty.sessionId}, controller=${penalty.controller + 1}`);
    res.json({ success: true, data: penalty });
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error('[RaceControl] Penalty revocation failed:', error);
    res.status(status).json({ success: false, error: status === 500 ? 'Could not revoke penalty' : error.message });
  }
});

router.post('/director/:action', requireDirector, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { action } = req.params;
  if (!['pause', 'resume', 'stop'].includes(action)) {
    return res.status(400).json({ success: false, error: 'Unknown race control action' });
  }
  const { sessionId } = req.body || {};
  if (typeof sessionId !== 'string' || !sessionId) {
    return res.status(400).json({ success: false, error: 'Session is required' });
  }
  try {
    const result = await serialize(async () => {
      if (sessionService.activeSessionId !== sessionId) return { code: 409, error: 'Not the current session' };
      if (!syncService?.isConnected()) return { code: 503, error: 'Control Unit is disconnected' };
      const status = sessionService.sessionStatus;
      if (action === 'pause') {
        if (status === SessionStatus.PAUSED) return { code: 200, status };
        if (status !== SessionStatus.ACTIVE) return { code: 409, error: 'Race is not running' };
        await sessionService.pauseSession();
      } else if (action === 'resume') {
        if (status !== SessionStatus.PAUSED) return { code: 409, error: 'Race is not paused' };
        await sessionService.resumeSession();
      } else {
        if (!['active', 'paused', 'finishing'].includes(status)) return { code: 409, error: 'Race cannot be stopped' };
        await sessionService.stopSession();
      }
      console.info(`[RaceControl] Director ${action} for session=${sessionId}`);
      return { code: 200, status: sessionService.sessionStatus };
    });
    if (result.error) return res.status(result.code).json({ success: false, error: result.error });
    res.json({ success: true, status: result.status });
  } catch (error) {
    console.error('[RaceControl] Director action failed:', error);
    res.status(500).json({ success: false, error: 'Race control failed' });
  }
});

export default router;
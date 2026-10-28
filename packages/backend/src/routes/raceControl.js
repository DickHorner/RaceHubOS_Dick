import express from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { SessionStatus } from '@racehubos/shared';

const router = express.Router();
const TOKEN_LIFETIME_MS = 6 * 60 * 60 * 1000;
const directorEnvPath = fileURLToPath(new URL('../../.env', import.meta.url));
let setupInProgress = false;
let sessionService;
let syncService;
let controlQueue = Promise.resolve();
let soundReceiverId = null;
let lastSoundPlayAt = 0;
const soundRequests = new Map();
const SOUND_URL =
  /^\/api\/upload\/sounds\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(mp3|ogg|wav)$/;
const SOUND_REQUEST_ID = /^[a-f0-9]{32}$/;

function isPrivateIPv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return (
    parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168)
  );
}

export function lanAddresses(interfaces) {
  const found = new Map();
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const entry of addresses || []) {
      if (
        (entry.family === 'IPv4' || entry.family === 4) &&
        !entry.internal &&
        typeof entry.address === 'string' &&
        isPrivateIPv4(entry.address)
      ) {
        if (!found.has(entry.address)) found.set(entry.address, { name, address: entry.address });
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
}

router.get('/lan-addresses', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: lanAddresses(networkInterfaces()) });
});

// An automatic cue is delivered to the one director who opted in to receive audio.
function forwardAutoSoundEvent(payload) {
  const socket = soundReceiver();
  if (socket) socket.emit('soundboard:auto', payload);
}

export function setRaceControlServices(session, sync) {
  sessionService?.off?.('soundboardAutoEvent', forwardAutoSoundEvent);
  sessionService = session;
  syncService = sync;
  soundReceiverId = null;
  lastSoundPlayAt = 0;
  soundRequests.clear();
  sessionService?.on?.('soundboardAutoEvent', forwardAutoSoundEvent);
}

function directorSecret() {
  const secret = process.env.RACE_CONTROL_SECRET || '';
  return Buffer.byteLength(secret) >= 32 ? secret : null;
}

function validNewDirectorSecret(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
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

function directorKeyRequired() {
  return process.env.RACE_CONTROL_REQUIRE_KEY !== 'false';
}

function isDirector(req) {
  const secret = directorSecret();
  return Boolean(secret && (!directorKeyRequired() || equals(bearer(req), secret)));
}

function requireDirector(req, res, next) {
  if (!directorSecret()) return res.status(503).json({ success: false, error: 'Race control is not configured' });
  if (!isDirector(req)) return res.status(403).json({ success: false, error: 'Race director credential required' });
  next();
}

function requireLocalOrDirector(req, res, next) {
  if (isLoopback(req.socket.remoteAddress) && trustedOrigin(req.get('origin'), req.get('host'))) return next();
  return requireDirector(req, res, next);
}

function soundReceiver() {
  const socket = sessionService?.io?.sockets?.sockets?.get(soundReceiverId);
  if (!socket?.connected) {
    soundReceiverId = null;
    return null;
  }
  return socket;
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
  const data = Buffer.from(
    JSON.stringify({
      sid: assignment.sessionId,
      sdid: assignment.id,
      did: assignment.driverId,
      controller: assignment.controller,
      exp: expiresAt,
    })
  ).toString('base64url');
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
      typeof data.sid !== 'string' ||
      !data.sid ||
      typeof data.sdid !== 'string' ||
      !data.sdid ||
      typeof data.did !== 'string' ||
      !data.did ||
      !Number.isInteger(data.controller) ||
      data.controller < 0 ||
      data.controller > 5 ||
      !Number.isSafeInteger(data.exp) ||
      data.exp <= Date.now() ||
      data.exp > Date.now() + TOKEN_LIFETIME_MS
    )
      return null;
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
  const local = isLoopback(req.socket.remoteAddress) && trustedOrigin('http://localhost', req.get('host'));
  res.json({
    success: true,
    enabled: Boolean(directorSecret()),
    keyRequired: directorKeyRequired(),
    setupAvailable: !process.env.RACE_CONTROL_SECRET && local,
  });
});

// Only the browser running on the race PC may bootstrap a director credential.
// The server generates and stores the key; never accept a secret from remote input.
router.post('/setup', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (
    !isLoopback(req.socket.remoteAddress) ||
    !req.get('origin') ||
    !trustedOrigin(req.get('origin'), req.get('host'))
  ) {
    return res
      .status(403)
      .json({ success: false, error: 'Initial setup is only available on the race PC at localhost' });
  }
  if (directorSecret()) return res.status(409).json({ success: false, error: 'Race control is already configured' });
  if (process.env.RACE_CONTROL_SECRET) {
    return res.status(409).json({
      success: false,
      error: 'Existing invalid RACE_CONTROL_SECRET must be corrected in the server configuration',
    });
  }
  if (setupInProgress) return res.status(409).json({ success: false, error: 'Race control setup is already running' });
  const requested = req.body?.secret;
  if (requested !== undefined && requested !== '' && !validNewDirectorSecret(requested)) {
    return res.status(400).json({ success: false, error: 'Credential must be 32-128 letters, digits, - or _' });
  }

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
      return res
        .status(409)
        .json({ success: false, error: 'RACE_CONTROL_SECRET already exists in .env; correct it there' });
    }

    if (envExists) await fs.chmod(directorEnvPath, 0o600);
    const secret = requested || randomBytes(32).toString('hex');
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    await fs.appendFile(directorEnvPath, `${prefix}RACE_CONTROL_SECRET=${secret}\n`, { mode: 0o600 });
    process.env.RACE_CONTROL_SECRET = secret;

    res.json({ success: true, secret });
  } catch (error) {
    console.error('[RaceControl] Local setup failed:', error);
    res
      .status(500)
      .json({ success: false, error: 'Could not save the race-control secret; check server file permissions' });
  } finally {
    setupInProgress = false;
  }
});

router.get('/director/check', requireDirector, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true });
});

router.post('/director/key-required', requireDirector, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { keyRequired } = req.body || {};
  if (typeof keyRequired !== 'boolean') {
    return res.status(400).json({ success: false, error: 'keyRequired must be a boolean' });
  }
  if (keyRequired === directorKeyRequired()) return res.json({ success: true, keyRequired });
  if (setupInProgress) return res.status(409).json({ success: false, error: 'Credential setup is already running' });

  setupInProgress = true;
  let temporaryPath;
  try {
    let existing;
    try {
      existing = await fs.readFile(directorEnvPath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return res.status(409).json({ success: false, error: 'Race control config file is missing' });
    }

    const matches = [
      ...existing.matchAll(/^([ \t]*(?:export[ \t]+)?RACE_CONTROL_REQUIRE_KEY[ \t]*=[ \t]*)([^\r\n]*)/gm),
    ];
    const saved = matches[0]?.[2]?.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (matches.length > 1 || (saved !== undefined ? saved !== 'false' : true) !== directorKeyRequired()) {
      return res.status(409).json({ success: false, error: 'Race control key policy is managed externally' });
    }
    const requiredValue = String(keyRequired);
    const updated = matches.length
      ? existing.slice(0, matches[0].index) +
        matches[0][1] +
        requiredValue +
        existing.slice(matches[0].index + matches[0][0].length)
      : existing + (existing && !existing.endsWith('\n') ? '\n' : '') + `RACE_CONTROL_REQUIRE_KEY=${requiredValue}\n`;
    temporaryPath = `${directorEnvPath}.${randomBytes(8).toString('hex')}.tmp`;
    await fs.writeFile(temporaryPath, updated, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporaryPath, directorEnvPath);
    temporaryPath = null;
    process.env.RACE_CONTROL_REQUIRE_KEY = requiredValue;
    console.info(`[RaceControl] Race director key ${keyRequired ? 'required' : 'disabled'} by operator`);
    res.json({ success: true, keyRequired });
  } catch (error) {
    console.error('[RaceControl] Director key policy update failed:', error);
    res.status(500).json({ success: false, error: 'Could not save race director key policy' });
  } finally {
    if (temporaryPath) {
      try {
        await fs.unlink(temporaryPath);
      } catch {
        // The temporary file may never have been created.
      }
    }
    setupInProgress = false;
  }
});

// Existing director authorization is required to rotate the persisted credential.
// A new key immediately invalidates previously issued driver access tokens.
router.post('/director/credential', requireDirector, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const nextSecret = req.body?.secret;
  if (!validNewDirectorSecret(nextSecret)) {
    return res.status(400).json({ success: false, error: 'Credential must be 32-128 letters, digits, - or _' });
  }
  if (nextSecret === directorSecret()) {
    return res.status(409).json({ success: false, error: 'Credential is unchanged' });
  }
  if (setupInProgress) {
    return res.status(409).json({ success: false, error: 'Credential setup is already running' });
  }

  setupInProgress = true;
  let temporaryPath;
  try {
    let existing;
    try {
      existing = await fs.readFile(directorEnvPath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return res.status(409).json({ success: false, error: 'Credential is managed outside the server .env file' });
    }

    const matches = [...existing.matchAll(/^([ \t]*(?:export[ \t]+)?RACE_CONTROL_SECRET[ \t]*=[ \t]*)([^\r\n]*)/gm)];
    const fileSecret = matches[0]?.[2]?.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (matches.length !== 1 || fileSecret !== directorSecret()) {
      return res.status(409).json({ success: false, error: 'Credential is managed outside the server .env file' });
    }

    const entry = matches[0];
    const updated =
      existing.slice(0, entry.index) + entry[1] + nextSecret + existing.slice(entry.index + entry[0].length);
    temporaryPath = `${directorEnvPath}.${randomBytes(8).toString('hex')}.tmp`;
    await fs.writeFile(temporaryPath, updated, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporaryPath, directorEnvPath);
    temporaryPath = null;
    process.env.RACE_CONTROL_SECRET = nextSecret;

    const receiver = soundReceiver();
    soundReceiverId = null;
    soundRequests.clear();
    receiver?.emit('soundboard:deactivate');

    res.json({ success: true });
  } catch (error) {
    console.error('[RaceControl] Credential update failed:', error);
    res.status(500).json({ success: false, error: 'Could not save director credential' });
  } finally {
    if (temporaryPath) {
      try {
        await fs.unlink(temporaryPath);
      } catch {
        // The temporary file may never have been created.
      }
    }
    setupInProgress = false;
  }
});

router.post('/driver-link', requireDirector, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { sessionId, driverId } = req.body || {};
  if (typeof sessionId !== 'string' || !sessionId || typeof driverId !== 'string' || !driverId) {
    return res.status(400).json({ success: false, error: 'Session and driver are required' });
  }
  try {
    const session = await sessionService.prisma.session.findUnique({
      where: { id: sessionId },
      include: { drivers: true },
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

// A driver can plan their own tyres, but cannot claim that a pit stop has occurred.
router.post('/driver/tyres', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const access = decodeDriverAccess(bearer(req));
  if (!access) return res.status(403).json({ success: false, error: 'Invalid or expired driver access' });
  const { tyreType } = req.body || {};
  try {
    const result = await serialize(async () => {
      const assignments = await sessionService.prisma.sessionDriver.findMany({
        where: { sessionId: access.sid, driverId: access.did, deletedAt: null },
      });
      if (
        assignments.length !== 1 ||
        assignments[0].id !== access.sdid ||
        assignments[0].controller !== access.controller
      ) {
        return { status: 403, error: 'Driver assignment has changed; request a new link' };
      }
      if (sessionService.activeSessionId !== access.sid) {
        return { status: 409, error: 'Driver link is not for the current session' };
      }
      return { status: 200, data: await sessionService.requestTyreChange(access.sid, access.sdid, tyreType) };
    });
    if (result.error) return res.status(result.status).json({ success: false, error: result.error });
    res.json({ success: true, data: result.data });
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error('[RaceControl] Tyre request failed:', error);
    res.status(status).json({ success: false, error: status === 500 ? 'Could not request tyres' : error.message });
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
      if (
        assignments.length !== 1 ||
        assignments[0].id !== access.sdid ||
        assignments[0].controller !== access.controller
      ) {
        return { code: 403, error: 'Driver assignment has changed; request a new link' };
      }
      if (sessionService.activeSessionId !== access.sid) {
        return { code: 409, error: 'This driver link is not for the current session' };
      }
      if (sessionService.sessionStatus === SessionStatus.PAUSED)
        return { code: 200, paused: true, alreadyPaused: true };
      if (sessionService.sessionStatus !== SessionStatus.ACTIVE) return { code: 409, error: 'Race is not running' };
      if (!syncService?.isConnected()) return { code: 503, error: 'Control Unit is disconnected' };

      await sessionService.pauseSession();
      console.info(
        `[RaceControl] Chaos pause by driver=${access.did}, controller=${access.controller + 1}, session=${access.sid}`
      );
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

// A director browser explicitly owns the only soundboard output socket.
// The stored audio stays on the server and is fetched by that browser via HTTP.
router.get('/soundboard/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, ready: Boolean(soundReceiver()) });
});

router.post('/director/soundboard/receiver', requireDirector, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { socketId } = req.body || {};
  if (typeof socketId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(socketId)) {
    return res.status(400).json({ success: false, error: 'Invalid receiver connection' });
  }
  const next = sessionService?.io?.sockets?.sockets?.get(socketId);
  if (!next?.connected) return res.status(409).json({ success: false, error: 'Receiver is offline' });
  const previous = soundReceiver();
  if (previous && previous.id !== socketId) previous.emit('soundboard:deactivate');
  soundReceiverId = socketId;
  res.json({ success: true, ready: true });
});

router.post('/director/soundboard/release', requireDirector, (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.body?.socketId === soundReceiverId) soundReceiverId = null;
  res.json({ success: true });
});

// The race PC may trigger remotely via its existing trusted-loopback boundary;
// a remote browser requires the director credential, never a driver token.
router.post('/soundboard/:action', requireLocalOrDirector, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { action } = req.params;
  if (action !== 'play' && action !== 'stop') {
    return res.status(400).json({ success: false, error: 'Unknown soundboard action' });
  }
  const { presetId, requestId } = req.body || {};
  if (typeof requestId !== 'string' || !SOUND_REQUEST_ID.test(requestId)) {
    return res.status(400).json({ success: false, error: 'Invalid sound request' });
  }
  if (action === 'play' && (typeof presetId !== 'string' || !presetId || presetId.length > 80)) {
    return res.status(400).json({ success: false, error: 'Invalid preset ID' });
  }

  const now = Date.now();
  for (const [id, item] of soundRequests) {
    if (now - item.time > 60000) soundRequests.delete(id);
  }
  const existing = soundRequests.get(requestId);
  if (existing) {
    const reply = await existing.result;
    return res.status(reply.code).json(reply.body);
  }

  const socket = soundReceiver();
  if (!socket) return res.status(503).json({ success: false, error: 'Director audio receiver is offline' });

  // Reserve the request ID before the asynchronous preset lookup. Concurrent
  // retries must never send the same sound twice.
  const result = (async () => {
    let preset;
    if (action === 'play') {
      try {
        const stored = await sessionService.prisma.preference.findUnique({ where: { key: 'soundboard:presets' } });
        const presets = stored ? JSON.parse(stored.value) : [];
        const found = Array.isArray(presets) ? presets.slice(0, 32).find((item) => item?.id === presetId) : null;
        if (
          !found ||
          (found.kind === 'clip' && (typeof found.url !== 'string' || !SOUND_URL.test(found.url))) ||
          (found.kind === 'speech' &&
            (typeof found.text !== 'string' || !found.text.trim() || found.text.length > 300)) ||
          !['clip', 'speech'].includes(found.kind) ||
          typeof found.label !== 'string' ||
          !found.label ||
          found.label.length > 60
        ) {
          return { code: 400, body: { success: false, error: 'Unknown or invalid soundboard preset' } };
        }
        preset =
          found.kind === 'clip'
            ? { id: found.id, label: found.label, kind: 'clip', url: found.url }
            : { id: found.id, label: found.label, kind: 'speech', text: found.text };
      } catch (error) {
        console.error('[RaceControl] Soundboard preset lookup failed:', error);
        return { code: 500, body: { success: false, error: 'Could not load soundboard preset' } };
      }
      const time = Date.now();
      if (time - lastSoundPlayAt < 200) {
        return { code: 429, body: { success: false, error: 'Sound requests are too frequent' } };
      }
      lastSoundPlayAt = time;
    }

    if (!socket.connected) return { code: 503, body: { success: false, error: 'Director audio receiver is offline' } };

    return new Promise((resolve) => {
      socket
        .timeout(7000)
        .emit(`soundboard:${action}`, { requestId, ...(preset ? { preset } : {}) }, (error, answer) => {
          if (error) {
            resolve({ code: 504, body: { success: false, error: 'Audio playback was not confirmed' } });
            return;
          }
          const expected = action === 'play' ? 'started' : 'stopped';
          if (answer?.status === expected) {
            resolve({ code: 200, body: { success: true, status: answer.status } });
          } else {
            resolve({ code: 409, body: { success: false, error: answer?.status || 'Audio playback rejected' } });
          }
        });
    });
  })();

  soundRequests.set(requestId, { time: now, result });
  if (soundRequests.size > 64) soundRequests.delete(soundRequests.keys().next().value);
  const reply = await result;
  res.status(reply.code).json(reply.body);
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
  if (
    action === 'start' &&
    (!Number.isInteger(cap) ||
      cap < 1 ||
      cap > 10 ||
      !Number.isInteger(durationSeconds) ||
      durationSeconds < 0 ||
      durationSeconds > 3600 ||
      (durationSeconds > 0 && durationSeconds < 5))
  ) {
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

// Explicit human observation when the physical CU pit signals have not been validated.
router.post('/director/tyres/confirm', requireDirector, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { sessionId, sessionDriverId } = req.body || {};
  if (typeof sessionId !== 'string' || !sessionId || typeof sessionDriverId !== 'string' || !sessionDriverId) {
    return res.status(400).json({ success: false, error: 'Session and driver assignment are required' });
  }
  try {
    const change = await serialize(() => sessionService.confirmTyreChange(sessionId, sessionDriverId));
    console.info(`[RaceControl] Manual tyre change confirmed session=${sessionId} assignment=${sessionDriverId}`);
    res.json({ success: true, data: change });
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error('[RaceControl] Manual tyre confirmation failed:', error);
    res
      .status(status)
      .json({ success: false, error: status === 500 ? 'Could not confirm tyre change' : error.message });
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
    console.info(
      `[RaceControl] Penalty revoked for session=${penalty.sessionId}, controller=${penalty.controller + 1}`
    );
    res.json({ success: true, data: penalty });
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error('[RaceControl] Penalty revocation failed:', error);
    res.status(status).json({ success: false, error: status === 500 ? 'Could not revoke penalty' : error.message });
  }
});

// A CU pit flag is only an observation. The director must verify the actual repair.
router.post('/director/damage/repair', requireDirector, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { sessionId, sessionDriverId, pitStopId } = req.body || {};
  if (![sessionId, sessionDriverId, pitStopId].every((value) => typeof value === 'string' && value.length > 0)) {
    return res.status(400).json({ success: false, error: 'Session, driver assignment and pit stop are required' });
  }
  try {
    const data = await serialize(() => sessionService.confirmDamageRepair(sessionId, sessionDriverId, pitStopId));
    console.info(
      `[RaceControl] Verified pit repair session=${sessionId} assignment=${sessionDriverId} pit=${pitStopId}`
    );
    res.json({ success: true, data });
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error('[RaceControl] Pit repair failed:', error);
    res.status(status).json({
      success: false,
      error: status === 500 ? 'Could not confirm repair' : error.message,
    });
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

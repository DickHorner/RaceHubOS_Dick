import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import raceControl, { setRaceControlServices } from '../routes/raceControl.js';

const secret = 'test-director-secret-longer-than-32-bytes';
const clip = {
  id: 'clip-1',
  label: 'Pit gong',
  kind: 'clip',
  url: '/api/upload/sounds/12345678-1234-1234-1234-123456789abc.wav',
};
const speech = { id: 'speech-1', label: 'Ready', kind: 'speech', text: 'Race ready' };

function setup() {
  const events = [];
  const receiver = {
    id: 'receiver-one-12345',
    connected: true,
    response: 'started',
    timeout() {
      return this;
    },
    emit(event, data, acknowledge) {
      events.push({ event, data });
      if (acknowledge) acknowledge(null, { status: event === 'soundboard:stop' ? 'stopped' : this.response });
    },
  };
  const sockets = new Map([[receiver.id, receiver]]);
  setRaceControlServices(
    {
      io: { sockets: { sockets } },
      prisma: { preference: { findUnique: jest.fn(async () => ({ value: JSON.stringify([clip, speech]) })) } },
    },
    null
  );
  const app = express();
  app.use(express.json());
  app.use('/api/race-control', raceControl);
  const director = (path) => request(app).post(path).set('Authorization', `Bearer ${secret}`);
  return { app, director, events, receiver, sockets };
}

describe('soundboard director output routing', () => {
  const previousSecret = process.env.RACE_CONTROL_SECRET;
  beforeEach(() => {
    process.env.RACE_CONTROL_SECRET = secret;
  });
  afterEach(() => {
    if (previousSecret === undefined) delete process.env.RACE_CONTROL_SECRET;
    else process.env.RACE_CONTROL_SECRET = previousSecret;
  });

  it('requires the director key to register a connected receiver and refuses untrusted writers', async () => {
    const { app, director, receiver, events } = setup();
    await request(app).get('/api/race-control/soundboard/status').expect(200, { success: true, ready: false });
    await request(app)
      .post('/api/race-control/director/soundboard/receiver')
      .send({ socketId: receiver.id })
      .expect(403);
    await director('/api/race-control/director/soundboard/receiver').send({ socketId: 'missing-receiver' }).expect(409);
    await director('/api/race-control/director/soundboard/receiver').send({ socketId: receiver.id }).expect(200);
    await request(app).get('/api/race-control/soundboard/status').expect(200, { success: true, ready: true });
    await request(app)
      .post('/api/race-control/soundboard/play')
      .set('Origin', 'https://untrusted.invalid')
      .send({ presetId: clip.id, requestId: 'a'.repeat(32) })
      .expect(403);
    await request(app)
      .post('/api/race-control/soundboard/play')
      .set('Origin', 'https://untrusted.invalid')
      .set('Authorization', 'Bearer driver-token')
      .send({ presetId: clip.id, requestId: 'b'.repeat(32) })
      .expect(403);
    expect(events).toHaveLength(0);
  });

  it('resolves stored presets, acknowledges actual playback, and rejects unknown IDs and unsafe media', async () => {
    const { app, director, receiver, events } = setup();
    await director('/api/race-control/director/soundboard/receiver').send({ socketId: receiver.id }).expect(200);
    const result = await request(app)
      .post('/api/race-control/soundboard/play')
      .send({ presetId: clip.id, requestId: '1'.repeat(32) })
      .expect(200);
    expect(result.body.status).toBe('started');
    expect(events).toEqual([{ event: 'soundboard:play', data: { requestId: '1'.repeat(32), preset: clip } }]);
    await request(app)
      .post('/api/race-control/soundboard/play')
      .send({ presetId: clip.id, requestId: '1'.repeat(32) })
      .expect(200);
    expect(events).toHaveLength(1);
    await request(app)
      .post('/api/race-control/soundboard/play')
      .send({ presetId: 'arbitrary-file', requestId: '2'.repeat(32) })
      .expect(400);
    const stop = await request(app)
      .post('/api/race-control/soundboard/stop')
      .send({ requestId: '3'.repeat(32) })
      .expect(200);
    expect(stop.body.status).toBe('stopped');
    expect(events.at(-1).event).toBe('soundboard:stop');
  });

  it('coalesces simultaneous retries for the same sound request', async () => {
    const { app, director, receiver, events } = setup();
    await director('/api/race-control/director/soundboard/receiver').send({ socketId: receiver.id }).expect(200);
    const responses = await Promise.all([
      request(app).post('/api/race-control/soundboard/play').send({ presetId: clip.id, requestId: '7'.repeat(32) }),
      request(app).post('/api/race-control/soundboard/play').send({ presetId: clip.id, requestId: '7'.repeat(32) }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(events.filter((event) => event.event === 'soundboard:play')).toHaveLength(1);
  });

  it('reports muted or unreachable output without silent local fallback', async () => {
    const { app, director, receiver } = setup();
    await request(app)
      .post('/api/race-control/soundboard/play')
      .send({ presetId: speech.id, requestId: '4'.repeat(32) })
      .expect(503);
    await director('/api/race-control/director/soundboard/receiver').send({ socketId: receiver.id }).expect(200);
    receiver.response = 'muted';
    const muted = await request(app)
      .post('/api/race-control/soundboard/play')
      .send({ presetId: speech.id, requestId: '5'.repeat(32) })
      .expect(409);
    expect(muted.body.error).toBe('muted');
    receiver.connected = false;
    await request(app).get('/api/race-control/soundboard/status').expect(200, { success: true, ready: false });
    await request(app)
      .post('/api/race-control/soundboard/play')
      .send({ presetId: clip.id, requestId: '6'.repeat(32) })
      .expect(503);
  });

  it('allows exactly one receiver, and stale releases cannot deactivate the replacement', async () => {
    const { app, director, receiver, events, sockets } = setup();
    const second = { ...receiver, id: 'receiver-two-12345' };
    sockets.set(second.id, second);
    await director('/api/race-control/director/soundboard/receiver').send({ socketId: receiver.id }).expect(200);
    await director('/api/race-control/director/soundboard/receiver').send({ socketId: second.id }).expect(200);
    expect(events.some((event) => event.event === 'soundboard:deactivate')).toBe(true);
    await director('/api/race-control/director/soundboard/release').send({ socketId: receiver.id }).expect(200);
    await request(app).get('/api/race-control/soundboard/status').expect(200, { success: true, ready: true });
    await director('/api/race-control/director/soundboard/release').send({ socketId: second.id }).expect(200);
    await request(app).get('/api/race-control/soundboard/status').expect(200, { success: true, ready: false });
  });
});

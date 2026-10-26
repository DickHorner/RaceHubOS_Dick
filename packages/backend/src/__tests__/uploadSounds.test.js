import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import uploadRouter from '../routes/upload.js';

const soundsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../public/uploads/sounds');
const app = express();
app.use('/api/upload', uploadRouter);
const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(24)]);
let filesBefore;

beforeEach(() => {
  filesBefore = new Set(fs.readdirSync(soundsDir));
});

afterEach(() => {
  for (const filename of fs.readdirSync(soundsDir)) {
    if (!filesBefore.has(filename)) fs.unlinkSync(path.join(soundsDir, filename));
  }
});

test('uploads, serves and deletes a WAV clip under a generated safe filename', async () => {
  const uploaded = await request(app)
    .post('/api/upload/sounds')
    .attach('audio', wav, { filename: 'signal.wav', contentType: 'audio/wav' });

  expect(uploaded.status).toBe(200);
  expect(uploaded.body.data.url).toMatch(/^\/api\/upload\/sounds\/[a-f0-9-]{36}\.wav$/);
  expect(fs.existsSync(path.join(soundsDir, uploaded.body.data.filename))).toBe(true);
  const played = await request(app).get(uploaded.body.data.url);
  expect(played.status).toBe(200);
  expect(played.headers['content-type']).toMatch(/audio\/(?:x-)?wav/);
  expect(played.headers['x-content-type-options']).toBe('nosniff');

  const removed = await request(app).delete(uploaded.body.data.url);
  expect(removed.status).toBe(200);
  expect(fs.existsSync(path.join(soundsDir, uploaded.body.data.filename))).toBe(false);
});

test('rejects fake audio even with a valid MIME type and extension', async () => {
  const response = await request(app)
    .post('/api/upload/sounds')
    .attach('audio', Buffer.from('<html>bad upload</html>'), { filename: 'fake.wav', contentType: 'audio/wav' });

  expect(response.status).toBe(400);
  expect(response.body.error).toMatch(/valid MP3/);
  expect(fs.readdirSync(soundsDir).sort()).toEqual([...filesBefore].sort());
});

test('rejects unsupported extensions, oversized files and unsafe delete paths', async () => {
  const wrongType = await request(app)
    .post('/api/upload/sounds')
    .attach('audio', wav, { filename: 'script.html', contentType: 'text/html' });
  expect(wrongType.status).toBe(400);

  const oversized = await request(app)
    .post('/api/upload/sounds')
    .attach('audio', Buffer.alloc(5 * 1024 * 1024 + 1), { filename: 'large.wav', contentType: 'audio/wav' });
  expect(oversized.status).toBe(400);

  const deletion = await request(app).delete('/api/upload/sounds/%2e%2e%2fconfig.json');
  expect(deletion.status).toBe(400);
  expect(fs.readdirSync(soundsDir).sort()).toEqual([...filesBefore].sort());
});

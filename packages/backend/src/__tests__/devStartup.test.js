import { jest } from '@jest/globals';
import fs from 'node:fs';
import { waitForBackend } from '../../../../scripts/wait-for-backend.mjs';

describe('development startup readiness', () => {
  let fetchMock;
  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('holds the frontend through connection refusal, HTTP errors and an unhealthy response', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'starting' }) })
      .mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) });
    let ready = false;
    const pending = waitForBackend('http://localhost:3101/health').then(() => {
      ready = true;
    });
    await jest.advanceTimersByTimeAsync(2000);
    expect(ready).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1000);
    await pending;
    expect(ready).toBe(true);
    expect(fetchMock).toHaveBeenLastCalledWith('http://localhost:3101/health', { signal: expect.any(AbortSignal) });
  });

  it('does not mistake an invalid response for a healthy backend', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new Error('not JSON');
        },
      })
      .mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) });
    const pending = waitForBackend('http://localhost:3101/health');
    await jest.advanceTimersByTimeAsync(1000);
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails explicitly instead of launching the frontend when the backend never becomes ready', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const pending = expect(waitForBackend('http://localhost:3101/health')).rejects.toThrow(
      'Check the backend startup and migration log'
    );
    await jest.advanceTimersByTimeAsync(300_000);
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(300);
  });

  it('uses the readiness gate and stops both dev tasks when either startup fails', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts['dev:frontend']).toBe('node scripts/wait-for-backend.mjs && npm run dev -w @racehubos/frontend');
    expect(pkg.scripts.dev).toContain('--kill-others-on-fail');
  });
});

import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { SessionService } from '../services/SessionService.js';
import { SyncService } from '../services/SyncService.js';
import { CarreraSimulator } from '../services/simulator.js';
import { SessionStatus } from '@racehubos/shared';

describe('opt-in backend start trace', () => {
  const previousTrace = process.env.RACEHUB_START_TRACE;
  let service;
  let sync;
  let device;
  let info;

  const records = () => info.mock.calls.filter(([tag]) => tag === '[StartTrace]').map(([, row]) => row);
  const phases = () => records().map((row) => row.phase);
  const row = (phase) => records().find((entry) => entry.phase === phase);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.RACEHUB_START_TRACE = '1';
    info = jest.spyOn(console, 'info').mockImplementation(() => {});
    device = new EventEmitter();
    Object.assign(device, {
      isConnected: () => true,
      reset: jest.fn(() => wait(50)),
      start: jest.fn(() => wait(80)),
      setSpeed: jest.fn(() => wait(10)),
      setBrake: jest.fn(() => wait(20)),
      setFuel: jest.fn(() => wait(30)),
      poll: jest.fn(() => wait(40)),
      address: 'must-not-be-in-trace',
    });
    service = new SessionService({ emit: jest.fn() });
    const prisma = service.prisma;
    service.prisma = {
      session: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ status: SessionStatus.DRAFT }),
        update: jest.fn().mockResolvedValue({}),
      },
      $disconnect: () => prisma.$disconnect(),
    };
    sync = new SyncService(service.io);
    sync.setDevice(device);
    service.setSyncService(sync);
    service.loadSession = jest.fn(async () => {
      await wait(25);
      service.activeSessionId = 'session-1';
      service.sessionStatus = SessionStatus.DRAFT;
      service.sessionDrivers = [0, 2].map((controller) => ({
        controller,
        carId: `car-${controller}`,
        car: { id: `car-${controller}`, maxSpeed: 70, brakeForce: 60, fuelCapacity: 50 },
      }));
    });
    service.startHeartbeat = jest.fn();
  });

  afterEach(async () => {
    sync.close();
    await service.prisma.$disconnect();
    info.mockRestore();
    if (previousTrace === undefined) delete process.env.RACEHUB_START_TRACE;
    else process.env.RACEHUB_START_TRACE = previousTrace;
    jest.useRealTimers();
  });

  test('measures actual phases, both fixed waits and serial profiles without another START', async () => {
    const starting = service.startSession('session-1');
    await jest.advanceTimersByTimeAsync(3000);
    await starting;

    expect(phases().slice(0, 7)).toEqual([
      'accepted',
      'reset:begin',
      'reset:end',
      'load:begin',
      'load:end',
      'profiles:begin',
      'profile:request',
    ]);
    expect(row('reset:end').elapsedMs - row('reset:begin').elapsedMs).toBe(50);
    expect(row('load:end').elapsedMs - row('load:begin').elapsedMs).toBe(25);
    expect(row('profiles:end').elapsedMs - row('profiles:begin').elapsedMs).toBe(120);
    expect(
      records()
        .filter((entry) => entry.phase === 'profile:ack')
        .map(({ controller, field }) => [controller, field])
    ).toEqual([
      [0, 'speed'],
      [0, 'brake'],
      [0, 'fuel'],
      [2, 'speed'],
      [2, 'brake'],
      [2, 'fuel'],
    ]);
    for (const phase of ['wait:before_start', 'wait:after_start']) {
      expect(row(`${phase}:begin`).plannedMs).toBe(1000);
      expect(row(`${phase}:end`).elapsedMs - row(`${phase}:begin`).elapsedMs).toBe(1000);
    }
    expect(row('prepare_start:ack').elapsedMs - row('prepare_start:request').elapsedMs).toBe(80);
    expect(row('poll:end').elapsedMs - row('poll:begin').elapsedMs).toBe(40);
    expect(device.start).toHaveBeenCalledTimes(1);
    expect(service.sessionStatus).toBe(SessionStatus.ACTIVE);
    expect(new Set(records().map((entry) => entry.traceId)).size).toBe(1);
    expect(records().every((entry) => entry.sessionId === 'session-1')).toBe(true);
    expect(JSON.stringify(records())).not.toContain(device.address);
    expect(row('accepted').startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('a second click cannot replace the in-flight trace or send another START', async () => {
    const starting = service.startSession('session-1');
    await expect(service.startSession('session-2')).rejects.toMatchObject({ status: 409 });
    await jest.advanceTimersByTimeAsync(3000);
    await starting;
    expect(phases().filter((phase) => phase === 'accepted')).toHaveLength(1);
    expect(device.start).toHaveBeenCalledTimes(1);
    expect(records().every((entry) => entry.sessionId === 'session-1')).toBe(true);
  });

  test.each(['reset', 'setBrake', 'start'])(
    'records failure at %s without an active session or false ACK',
    async (field) => {
      device[field].mockRejectedValueOnce(new Error('private BLE payload must not be logged'));
      const starting = expect(service.startSession('session-1')).rejects.toThrow('private BLE payload');
      await jest.advanceTimersByTimeAsync(3000);
      await starting;
      expect(phases().at(-1)).toBe('failed');
      expect(service.prisma.session.update).not.toHaveBeenCalled();
      expect(phases()).not.toContain('prepare_start:ack');
      expect(phases()).not.toContain('session:active');
      expect(sync.startTrace).toBeNull();
      expect(JSON.stringify(records())).not.toContain('private BLE');
      if (field !== 'start') expect(device.start).not.toHaveBeenCalled();
    }
  );

  test('records each status transition before broadcast, excludes duplicates and stops at racing', async () => {
    sync.beginStartTrace('session-1');
    sync.setSessionService({ onRaceStart: jest.fn(), isActive: () => false });
    for (const start of [1, 1, 2, 3, 4, 5, 7, 0, 0]) {
      device.emit('status', { start, mode: 0, secret: 'not-in-trace' });
      await jest.advanceTimersByTimeAsync(10);
    }
    expect(
      records()
        .filter((entry) => entry.phase === 'status')
        .map((entry) => entry.start)
    ).toEqual([1, 2, 3, 4, 5, 7, 0]);
    expect(phases().at(-1)).toBe('racing');
    expect(sync.startTrace).toBeNull();
    expect(JSON.stringify(records())).not.toContain('not-in-trace');
    const traceOrder =
      info.mock.invocationCallOrder[info.mock.calls.findIndex(([, entry]) => entry?.phase === 'status')];
    expect(traceOrder).toBeLessThan(service.io.emit.mock.invocationCallOrder[0]);
  });

  test('uses monotonic time despite a wall-clock change and expires after sixty seconds', async () => {
    sync.beginStartTrace('session-1');
    await jest.advanceTimersByTimeAsync(100);
    jest.setSystemTime(new Date('2000-01-01T00:00:00Z'));
    sync.traceStart('profiles:end');
    expect(row('profiles:end').elapsedMs).toBe(100);
    await jest.advanceTimersByTimeAsync(60_000);
    sync.traceStart('poll:begin');
    sync.traceStart('poll:end');
    expect(phases()).toEqual(['accepted', 'profiles:end', 'expired']);
    expect(sync.startTrace).toBeNull();
  });

  test.each(['disconnect', 'replace', 'close'])('ends the trace on %s', (action) => {
    sync.beginStartTrace('session-1');
    if (action === 'disconnect') device.emit('disconnected');
    else if (action === 'replace') sync.setDevice(null);
    else sync.close();
    expect(phases().at(-1)).toBe({ disconnect: 'disconnected', replace: 'device_changed', close: 'closed' }[action]);
    expect(sync.startTrace).toBeNull();
    sync.beginStartTrace('session-2');
    expect(new Set(records().map((entry) => entry.traceId)).size).toBe(2);
  });

  test('operator switch activates tracing without restart and preserves download data after disabling', () => {
    delete process.env.RACEHUB_START_TRACE;
    expect(sync.getStartTraceEnabled()).toBe(false);
    sync.setStartTraceEnabled(true);
    sync.beginStartTrace('settings-toggle');
    device.emit('status', { start: 6, mode: 0 });
    expect(sync.getStartTraceRecords().map((entry) => entry.phase)).toEqual(['accepted', 'status']);
    expect(sync.getStartTraceRecords().at(-1).start).toBe(6);
    sync.setStartTraceEnabled(false);
    sync.traceStart('status', { start: 7 });
    expect(sync.getStartTraceRecords()).toHaveLength(2);
  });

  test('download buffer is bounded', () => {
    sync.beginStartTrace('bounded');
    for (let i = 0; i < 2005; i++) sync.traceStart('poll:begin');
    expect(sync.getStartTraceRecords()).toHaveLength(2000);
  });

  test('disabled by default; the same device sequence still runs without trace output', async () => {
    delete process.env.RACEHUB_START_TRACE;
    const starting = service.startSession('session-1');
    await jest.advanceTimersByTimeAsync(3000);
    await starting;
    expect(records()).toEqual([]);
    expect(sync.startTrace).toBeNull();
    expect(device.start).toHaveBeenCalledTimes(1);
    expect(service.sessionStatus).toBe(SessionStatus.ACTIVE);
  });

  test('poll errors remain visible and do not generate a successful poll completion', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      device.poll.mockRejectedValueOnce(new Error('Request timeout'));
      sync.beginStartTrace('session-1');
      sync.startPolling();
      await jest.advanceTimersByTimeAsync(1);
      expect(phases()).toEqual(['accepted', 'poll:begin', 'poll:error']);
      expect(warn).toHaveBeenCalledWith('[SyncService] Poll error:', 'Request timeout');
    } finally {
      warn.mockRestore();
    }
  });

  test('failed light advance propagates the failure and ends tracing without an ACK', async () => {
    sync.beginStartTrace('session-1');
    device.start.mockRejectedValueOnce(new Error('Request timeout'));
    await expect(sync.startRace()).rejects.toThrow('Request timeout');
    expect(phases()).toEqual(['accepted', 'advance_start:request', 'failed']);
    expect(sync.startTrace).toBeNull();
    expect(device.start).toHaveBeenCalledTimes(1);
  });

  test('traces the integrated simulator countdown through GO with one preparation and one advance', async () => {
    const simulator = new CarreraSimulator(service.io);
    sync.setDevice(simulator);
    sync.setSessionService({ onRaceStart: jest.fn(), isActive: () => false });
    await simulator.connect();
    try {
      sync.beginStartTrace('simulator-session');
      const start = jest.spyOn(simulator, 'start');
      const preparing = sync.prepareRace();
      await jest.advanceTimersByTimeAsync(2000);
      await preparing;
      expect(start).toHaveBeenCalledTimes(1);
      expect(phases()).toContain('prepare_start:ack');
      expect(records().some((entry) => entry.phase === 'status' && entry.start === 1)).toBe(true);
      const advancing = sync.startRace();
      await jest.advanceTimersByTimeAsync(4400);
      await advancing;
      expect(start).toHaveBeenCalledTimes(2);
      expect(
        records()
          .filter((entry) => entry.phase === 'status')
          .map((entry) => entry.start)
      ).toEqual([9, 1, 2, 3, 4, 5, 7, 0]);
      expect(phases().filter((phase) => phase === 'reset:lights')).toHaveLength(1);
      expect(phases()).toContain('advance_start:request');
      expect(phases().at(-1)).toBe('racing');
      expect(simulator.cuState).toBe(0);
    } finally {
      await simulator.disconnect();
    }
  });
});

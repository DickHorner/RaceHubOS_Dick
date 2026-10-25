import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { SyncService } from '../services/SyncService.js';
import { SessionService } from '../services/SessionService.js';
import { CarreraSimulator } from '../services/simulator.js';

const status = (pit, source = 'cu', mode = 0x4, start = 0) => ({
  start,
  mode,
  pit: [pit, false, false, false, false, false, false, false],
  source,
});

describe('pit stop observations', () => {
  let sync;
  let session;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-25T16:00:00.000Z'));
    sync = new SyncService({ emit: jest.fn() });
    session = {
      activeSessionId: 'session-1',
      sessionStatus: 'active',
      recordPitStop: jest.fn().mockResolvedValue(),
    };
    sync.setSessionService(session);
  });

  afterEach(() => {
    sync.close();
    jest.useRealTimers();
  });

  const sample = (pit, elapsed, source = 'cu', mode = 0x4, start = 0) => {
    jest.setSystemTime(new Date(Date.parse('2026-10-25T16:00:00.000Z') + elapsed));
    sync.handleStatus(status(pit, source, mode, start));
  };

  test('needs stable entry and exit; stores one completed observation', async () => {
    sample(false, 0);
    sample(true, 100);
    sample(true, 200);
    sample(false, 1200);
    sample(false, 1300);
    sample(false, 1400);
    await Promise.resolve();

    expect(session.recordPitStop).toHaveBeenCalledTimes(1);
    expect(session.recordPitStop).toHaveBeenCalledWith({
      controller: 0,
      enteredAt: new Date('2026-10-25T16:00:00.100Z'),
      exitedAt: new Date('2026-10-25T16:00:01.200Z'),
      source: 'cu',
    });
  });

  test('ignores single-status bounces and does not invent an entry at first observation', async () => {
    sample(true, 0);
    sample(false, 100);
    sample(false, 200);
    sample(true, 300);
    sample(false, 400);
    sample(false, 500);
    await Promise.resolve();

    expect(session.recordPitStop).not.toHaveBeenCalled();
  });

  test('pause or loss of pit-lane mode interrupts observation without fake exit', async () => {
    sample(false, 0);
    sample(true, 100);
    sample(true, 200);
    sample(false, 300, 'cu', 0x0);
    sample(false, 400);
    sample(false, 500);
    await Promise.resolve();
    expect(session.recordPitStop).not.toHaveBeenCalled();

    sample(true, 600);
    sample(true, 700);
    session.sessionStatus = 'paused';
    sample(false, 800);
    session.sessionStatus = 'active';
    sample(false, 900);
    sample(false, 1000);
    await Promise.resolve();
    expect(session.recordPitStop).not.toHaveBeenCalled();
  });

  test('disconnect clears an open pit observation', async () => {
    const device = new EventEmitter();
    sync.setDevice(device);
    sample(false, 0);
    sample(true, 100);
    sample(true, 200);
    device.emit('disconnected');
    sample(false, 300);
    sample(false, 400);
    await Promise.resolve();

    expect(session.recordPitStop).not.toHaveBeenCalled();
  });

  test('new session or device never closes a previous session pit', async () => {
    sample(false, 0);
    sample(true, 100);
    sample(true, 200);
    session.activeSessionId = 'session-2';
    sample(false, 300);
    sample(false, 400);
    sync.setDevice(null);
    sample(false, 500);
    sample(false, 600);
    await Promise.resolve();
    expect(session.recordPitStop).not.toHaveBeenCalled();
  });

  test('simulator emits the same pit status shape', async () => {
    const simulator = new CarreraSimulator({ emit: jest.fn() });
    simulator.init(6);
    simulator.cuMode |= 0x4;
    simulator.cuState = 0;
    simulator.cars[0].inPit = false;
    sync.handleStatus(simulator.getCuStatus());
    jest.advanceTimersByTime(100);
    simulator.cars[0].inPit = true;
    sync.handleStatus(simulator.getCuStatus());
    jest.advanceTimersByTime(100);
    sync.handleStatus(simulator.getCuStatus());
    jest.advanceTimersByTime(1000);
    simulator.cars[0].inPit = false;
    sync.handleStatus(simulator.getCuStatus());
    jest.advanceTimersByTime(100);
    sync.handleStatus(simulator.getCuStatus());
    await Promise.resolve();

    expect(session.recordPitStop).toHaveBeenCalledWith(
      expect.objectContaining({ controller: 0, source: 'simulator' })
    );
  });
});

describe('pit stop persistence', () => {
  let session;
  let create;

  beforeEach(() => {
    session = new SessionService({ emit: jest.fn() });
    const prisma = session.prisma;
    create = jest.fn(async ({ data }) => ({ id: 'pit-1', ...data }));
    session.prisma = {
      pitStop: { create },
      $disconnect: () => prisma.$disconnect(),
    };
    session.activeSessionId = 'session-1';
    session.sessionStatus = 'active';
    session.sessionDrivers = [{ id: 'sd-1', controller: 0, driverId: 'd-1', carId: 'car-1' }];
  });

  afterEach(async () => {
    await session.prisma.$disconnect();
  });

  test('persists the observed interval and emits the saved event', async () => {
    const enteredAt = new Date('2026-10-25T16:00:01.000Z');
    const exitedAt = new Date('2026-10-25T16:00:03.500Z');

    await session.recordPitStop({ controller: 0, enteredAt, exitedAt, source: 'cu' });

    expect(create).toHaveBeenCalledWith({ data: {
      sessionId: 'session-1',
      sessionDriverId: 'sd-1',
      controller: 0,
      enteredAt,
      exitedAt,
      durationMs: 2500,
      source: 'cu',
    } });
    expect(session.io.emit).toHaveBeenCalledWith('session:pit_stop', expect.objectContaining({ id: 'pit-1' }));
  });

  test('ignores unassigned controllers, invalid intervals and inactive sessions', async () => {
    const enteredAt = new Date('2026-10-25T16:00:01.000Z');
    await session.recordPitStop({ controller: 2, enteredAt, exitedAt: new Date('2026-10-25T16:00:04.000Z'), source: 'cu' });
    await session.recordPitStop({ controller: 0, enteredAt, exitedAt: enteredAt, source: 'cu' });
    session.sessionStatus = 'paused';
    await session.recordPitStop({ controller: 0, enteredAt, exitedAt: new Date('2026-10-25T16:00:04.000Z'), source: 'cu' });
    expect(create).not.toHaveBeenCalled();
  });
});

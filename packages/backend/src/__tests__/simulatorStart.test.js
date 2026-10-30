import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { prisma } from './setup.js';
import { SyncService } from '../services/SyncService.js';
import { SessionService } from '../services/SessionService.js';
import { CarreraSimulator } from '../services/simulator.js';

describe('simulator start reset boundaries', () => {
  let sync;
  let simulator;
  let io;

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    io = { emit: jest.fn() };
    sync = new SyncService(io);
    simulator = new CarreraSimulator(io);
    sync.setDevice(simulator);
    await simulator.connect();
  });

  afterEach(async () => {
    sync.close();
    await simulator.disconnect();
    jest.useRealTimers();
  });

  test('L1 resets timing and positions once while preserving the start state and tick loop', async () => {
    const fullReset = jest.spyOn(simulator, 'reset');
    const timerReset = jest.spyOn(simulator, 'resetTimer');
    simulator.raceTime = 45000;
    simulator.cars[0].totalLaps = 8;
    simulator.cars[0].position = 6;
    sync.lastTimestamps.set(0, 45000);

    const preparing = sync.prepareRace();
    await jest.advanceTimersByTimeAsync(2000);
    await preparing;
    simulator.emitCuStatus();
    simulator.emitCuStatus();

    expect(simulator.cuState).toBe(1);
    expect(sync.getCuStatus().start).toBe(1);
    expect(simulator.isRunning).toBe(true);
    expect(simulator.interval).not.toBeNull();
    expect(simulator.raceActive).toBe(false);
    expect(simulator.raceTime).toBe(0);
    expect(simulator.cars[0].totalLaps).toBe(0);
    expect(simulator.cars[0].position).toBe(1);
    expect(sync.lastTimestamps.size).toBe(0);
    expect(timerReset).toHaveBeenCalledTimes(1);
    expect(fullReset).not.toHaveBeenCalled();
    expect(io.emit.mock.calls.filter(([event]) => event === 'cu:reset')).toHaveLength(1);
  });

  test('explicit full reset still stops at L1 and clears the simulator loop', async () => {
    const preparing = sync.prepareRace();
    await jest.advanceTimersByTimeAsync(2000);
    await preparing;
    expect(simulator.cuState).toBe(1);

    await sync.reset();

    expect(simulator.cuState).toBe(9);
    expect(simulator.isRunning).toBe(false);
    expect(simulator.interval).toBeNull();
    expect(simulator.raceTime).toBe(0);
  });

  test('devices without resetTimer keep the existing reset and position-clear calls at L1', async () => {
    const device = new EventEmitter();
    device.reset = jest.fn().mockResolvedValue();
    device.clearPosition = jest.fn().mockResolvedValue();
    sync.setDevice(device);
    device.emit('status', { start: 1 });
    await Promise.resolve();
    device.emit('status', { start: 1 });

    expect(device.reset).toHaveBeenCalledTimes(1);
    expect(device.clearPosition).toHaveBeenCalledTimes(1);
    expect(sync.getCuStatus().start).toBe(1);
  });

  test('real session start and pause/resume reach GO and persist the clock only at GO', async () => {
    const session = await prisma.session.create({
      data: {
        name: 'Simulator countdown regression',
        type: 'race',
        status: 'draft',
        track: { create: { name: 'Simulator start track' } },
        drivers: {
          create: {
            controller: 0,
            driver: { create: { name: 'Simulator driver' } },
            car: { create: { brand: 'Test', model: 'Start car' } },
          },
        },
      },
    });
    const service = new SessionService(io);
    sync.setSessionService(service);
    service.setSyncService(sync);
    const start = jest.spyOn(simulator, 'start');
    const raceStarted = jest.spyOn(service, 'onRaceStart');
    const prepare = sync.prepareRace.bind(sync);
    let enteredPrepare;
    jest.spyOn(sync, 'prepareRace').mockImplementation(() => {
      const preparing = prepare();
      enteredPrepare();
      return preparing;
    });
    try {
      let ready = new Promise((resolve) => {
        enteredPrepare = resolve;
      });
      const starting = service.startSession(session.id);
      await ready;
      await jest.advanceTimersByTimeAsync(2000);
      await starting;
      expect(simulator.cuState).toBe(1);
      expect(start).toHaveBeenCalledTimes(1);
      expect((await prisma.session.findUnique({ where: { id: session.id } })).startedAt).toBeNull();

      let go = new Promise((resolve) => {
        io.emit.mockImplementation((event, data) => {
          if (event === 'session:race_started') resolve(data);
        });
      });
      const advancing = service.startRace();
      await jest.advanceTimersByTimeAsync(4400);
      await advancing;
      await go;
      const firstGo = (await prisma.session.findUnique({ where: { id: session.id } })).startedAt;
      expect(firstGo).toBeInstanceOf(Date);
      expect(simulator.cuState).toBe(0);
      expect(simulator.raceTime).toBeGreaterThan(0);
      expect(start).toHaveBeenCalledTimes(2);
      expect(raceStarted).toHaveBeenCalledTimes(1);

      await service.pauseSession(session.id);
      const paused = await prisma.session.findUnique({ where: { id: session.id } });
      expect(JSON.parse(paused.pauses).at(-1).end).toBeNull();
      ready = new Promise((resolve) => {
        enteredPrepare = resolve;
      });
      const resuming = service.resumeSession(session.id);
      await ready;
      await jest.advanceTimersByTimeAsync(2000);
      await resuming;
      expect(simulator.cuState).toBe(1);
      expect(JSON.parse((await prisma.session.findUnique({ where: { id: session.id } })).pauses).at(-1).end).toBeNull();

      go = new Promise((resolve) => {
        io.emit.mockImplementation((event, data) => {
          if (event === 'session:race_resumed') resolve(data);
        });
      });
      const resumeAdvance = service.startRace();
      await jest.advanceTimersByTimeAsync(4400);
      await resumeAdvance;
      await go;
      const resumed = await prisma.session.findUnique({ where: { id: session.id } });
      expect(resumed.startedAt).toEqual(firstGo);
      expect(JSON.parse(resumed.pauses).at(-1).end).not.toBeNull();
      expect(simulator.cuState).toBe(0);
      expect(start).toHaveBeenCalledTimes(4);
      expect(raceStarted).toHaveBeenCalledTimes(2);
    } finally {
      service.stopHeartbeat();
      await service.prisma.$disconnect();
    }
  });
});

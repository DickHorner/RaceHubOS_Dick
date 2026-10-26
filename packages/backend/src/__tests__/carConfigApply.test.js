import { jest } from '@jest/globals';
import { SessionService } from '../services/SessionService.js';
import { SessionStatus } from '@racehubos/shared';

describe('CU vehicle configuration', () => {
  let service;
  let device;
  let writes;

  beforeEach(() => {
    writes = [];
    device = {
      setSpeed: jest.fn(async (address, value) => {
        writes.push(['speed', address, value]);
      }),
      setBrake: jest.fn(async (address, value) => {
        writes.push(['brake', address, value]);
      }),
      setFuel: jest.fn(async (address, value) => {
        writes.push(['fuel', address, value]);
      }),
    };
    service = new SessionService({ emit: jest.fn() });
    const prisma = service.prisma;
    service.prisma = {
      session: { update: jest.fn() },
      $disconnect: () => prisma.$disconnect(),
    };
    service.syncService = {
      getDevice: () => device,
      isConnected: () => true,
      reset: jest.fn().mockResolvedValue(),
      prepareRace: jest.fn().mockResolvedValue(),
      startPolling: jest.fn(),
    };
  });

  afterEach(async () => {
    await service.prisma.$disconnect();
  });

  const driver = (controller, carId, maxSpeed, brakeForce, fuelCapacity) => ({
    controller,
    carId,
    car: { id: carId, maxSpeed, brakeForce, fuelCapacity },
  });

  test('sends independent speed/brake/fuel for assigned cars only', async () => {
    service.sessionDrivers = [driver(0, 'a', 30, 90, 70), driver(1, 'b', 100, 20, 40)];

    await service.applyCarConfigs();

    expect(writes).toEqual([
      ['speed', 0, 3],
      ['brake', 0, 9],
      ['fuel', 0, 7],
      ['speed', 1, 10],
      ['brake', 1, 2],
      ['fuel', 1, 4],
    ]);
  });

  test('never changes unassigned controllers without hardware readback', async () => {
    service.sessionDrivers = [driver(2, 'c', 60, 40, 50)];

    await service.applyCarConfigs();

    expect(writes).toEqual([
      ['speed', 2, 6],
      ['brake', 2, 4],
      ['fuel', 2, 5],
    ]);
  });

  test('reapplies the car rather than a previous controller profile after reassignment', async () => {
    const a = driver(0, 'a', 30, 90, 70);
    const b = driver(1, 'b', 100, 20, 40);
    service.sessionDrivers = [a, b];
    await service.applyCarConfigs();
    writes.length = 0;
    a.controller = 1;
    b.controller = 0;
    await service.applyCarConfigs();
    expect(writes.slice(0, 6)).toEqual([
      ['speed', 0, 10],
      ['brake', 0, 2],
      ['fuel', 0, 4],
      ['speed', 1, 3],
      ['brake', 1, 9],
      ['fuel', 1, 7],
    ]);
  });

  test('reports controller and field on failed CU command', async () => {
    service.sessionDrivers = [driver(0, 'a', 30, 90, 70)];
    device.setBrake.mockRejectedValueOnce(new Error('Request timeout'));
    await expect(service.applyCarConfigs()).rejects.toThrow(
      'CU brake programming failed for controller 1: Request timeout'
    );
    expect(device.setFuel).not.toHaveBeenCalled();
  });

  test('rejects missing saved car instead of programming factory defaults', async () => {
    service.sessionDrivers = [{ controller: 1, carId: 'missing', car: null }];
    await expect(service.applyCarConfigs()).rejects.toThrow('Car missing not found for controller 2');
    expect(device.setSpeed).not.toHaveBeenCalled();
  });

  test('programs before start lights and marks session active only after both succeed', async () => {
    const steps = [];
    service.syncService.reset.mockImplementation(async () => {
      steps.push('reset');
    });
    service.loadSession = jest.fn(async () => {
      steps.push('load');
      service.sessionDrivers = [driver(0, 'a', 30, 90, 70)];
      service.sessionStatus = SessionStatus.DRAFT;
    });
    service.applyCarConfigs = jest.fn(async () => {
      steps.push('program');
    });
    service.syncService.prepareRace.mockImplementation(async () => {
      steps.push('lights');
    });
    service.prisma.session.update = jest.fn(async () => {
      steps.push('active');
    });
    service.startHeartbeat = jest.fn();
    service.emitStatusChanged = jest.fn();

    await service.startSession('session-1');

    expect(steps).toEqual(['reset', 'load', 'program', 'lights', 'active']);
    expect(service.sessionStatus).toBe(SessionStatus.ACTIVE);
    expect(service.startHeartbeat).toHaveBeenCalledTimes(1);
  });

  test('failed programming prevents the start sequence and active DB status', async () => {
    service.loadSession = jest.fn(async () => {
      service.sessionDrivers = [driver(0, 'a', 30, 90, 70)];
    });
    service.prisma.session.update = jest.fn();
    device.setBrake.mockRejectedValueOnce(new Error('Not connected'));

    await expect(service.startSession('session-1')).rejects.toThrow(
      'CU brake programming failed for controller 1: Not connected'
    );
    expect(service.syncService.prepareRace).not.toHaveBeenCalled();
    expect(service.prisma.session.update).not.toHaveBeenCalled();
  });

  test('failed start-light command also leaves the session in draft', async () => {
    service.loadSession = jest.fn(async () => {
      service.sessionDrivers = [driver(0, 'a', 30, 90, 70)];
    });
    service.syncService.prepareRace.mockRejectedValueOnce(new Error('CU start timeout'));

    await expect(service.startSession('session-1')).rejects.toThrow('CU start timeout');
    expect(service.prisma.session.update).not.toHaveBeenCalled();
    expect(service.sessionStatus).not.toBe(SessionStatus.ACTIVE);
  });

  describe('first finish-line crossing', () => {
    beforeEach(() => {
      service.activeSessionId = 'session-1';
      service.sessionStatus = SessionStatus.ACTIVE;
      service.sessionDrivers = [driver(0, 'a', 30, 90, 70), driver(2, 'b', 100, 20, 40)];
    });

    test('reapplies speed and brake on the first crossing even when lapTime is zero', async () => {
      await service.handleLap({ controller: 0, timestamp: 0, lapTime: 0, sector: 1 });
      await service.handleLap({ controller: 0, timestamp: 1000, lapTime: 0, sector: 2 });
      expect(writes).toEqual([]);

      await service.handleLap({ controller: 0, timestamp: 1000, lapTime: 0, sector: 1 });
      await service.handleLap({ controller: 0, timestamp: 2000, lapTime: 0, sector: 1 });

      expect(writes).toEqual([
        ['speed', 0, 3],
        ['brake', 0, 9],
      ]);
      expect(device.setFuel).not.toHaveBeenCalled();
      expect(service.firstCrossingProgrammed.has(0)).toBe(true);
    });

    test('does not interrupt ordinary lap counting after reapplying on a measured lap', async () => {
      const activeDriver = service.sessionDrivers[0];
      Object.assign(activeDriver, {
        totalLaps: 0,
        crossings: 0,
        totalTime: 0,
        bestLapTime: null,
      });
      service.sessionDrivers[1].totalLaps = 0;
      service.recalculatePositions = jest.fn();
      service.getSessionBestLapTime = jest.fn().mockReturnValue(null);
      service.saveLap = jest.fn().mockResolvedValue();
      service.updateSessionDriver = jest.fn().mockResolvedValue();
      service.emitLeaderboard = jest.fn();
      service.throttleIfFinished = jest.fn().mockResolvedValue();
      service.checkSessionComplete = jest.fn().mockResolvedValue();

      await service.handleLap({ controller: 0, timestamp: 12000, lapTime: 12000, sector: 1 });

      expect(writes).toEqual([
        ['speed', 0, 3],
        ['brake', 0, 9],
      ]);
      expect(activeDriver.totalLaps).toBe(1);
      expect(service.saveLap).toHaveBeenCalledWith(activeDriver, 12000, null, null);
    });

    test('configures only the car assigned to each controller, one time each', async () => {
      await service.handleLap({ controller: 3, timestamp: 1000, lapTime: 0, sector: 1 });
      await service.handleLap({ controller: 2, timestamp: 1500, lapTime: 0, sector: 1 });
      await service.handleLap({ controller: 0, timestamp: 1600, lapTime: 0, sector: 1 });
      await service.handleLap({ controller: 2, timestamp: 2500, lapTime: 0, sector: 1 });

      expect(writes).toEqual([
        ['speed', 2, 10],
        ['brake', 2, 2],
        ['speed', 0, 3],
        ['brake', 0, 9],
      ]);
    });

    test('duplicate notifications while writes are pending do not duplicate commands', async () => {
      let finishSpeed;
      device.setSpeed.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSpeed = resolve;
          })
      );
      const first = service.handleLap({ controller: 0, timestamp: 1000, lapTime: 0, sector: 1 });
      const duplicate = service.handleLap({ controller: 0, timestamp: 1000, lapTime: 0, sector: 1 });

      await Promise.resolve();
      expect(device.setSpeed).toHaveBeenCalledTimes(1);
      finishSpeed();
      await Promise.all([first, duplicate]);
      expect(device.setBrake).toHaveBeenCalledTimes(1);
    });

    test('does not reprogram while paused or finishing', async () => {
      service.sessionStatus = SessionStatus.PAUSED;
      await service.handleLap({ controller: 0, timestamp: 1000, lapTime: 0, sector: 1 });
      service.sessionStatus = SessionStatus.FINISHING;
      await service.handleLap({ controller: 0, timestamp: 2000, lapTime: 0, sector: 1 });

      expect(writes).toEqual([]);
    });

    test('reports a failed first-crossing write without dropping the timer event', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        device.setBrake.mockRejectedValueOnce(new Error('write timeout'));
        await expect(
          service.handleLap({ controller: 0, timestamp: 1000, lapTime: 0, sector: 1 })
        ).resolves.toBeUndefined();
        await service.handleLap({ controller: 0, timestamp: 2000, lapTime: 0, sector: 1 });

        expect(service.io.emit).toHaveBeenCalledWith('session:config_error', {
          sessionId: 'session-1',
          controller: 0,
          field: 'brake',
          error: 'write timeout',
        });
        expect(device.setSpeed).toHaveBeenCalledTimes(1);
        expect(device.setBrake).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });

    test('retains the one-shot marker on an active reload, resets for the next session', async () => {
      service.firstCrossingProgrammed.add(0);
      service.prisma.session.findUnique = jest.fn().mockResolvedValue({
        id: 'session-1',
        status: SessionStatus.ACTIVE,
        type: 'practice',
        drivers: [],
        trackId: 'track-1',
      });
      service.recalculatePositions = jest.fn();
      service.emitLeaderboard = jest.fn();

      await service.loadSession('session-1');
      expect(service.firstCrossingProgrammed.has(0)).toBe(true);

      service.prisma.session.findUnique.mockResolvedValue({
        id: 'session-2',
        status: SessionStatus.DRAFT,
        type: 'practice',
        drivers: [],
        trackId: 'track-1',
      });
      await service.loadSession('session-2');
      expect(service.firstCrossingProgrammed.size).toBe(0);
    });
  });
});

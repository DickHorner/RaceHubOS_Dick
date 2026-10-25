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
      setSpeed: jest.fn(async (address, value) => { writes.push(['speed', address, value]); }),
      setBrake: jest.fn(async (address, value) => { writes.push(['brake', address, value]); }),
      setFuel: jest.fn(async (address, value) => { writes.push(['fuel', address, value]); }),
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
    controller, carId,
    car: { id: carId, maxSpeed, brakeForce, fuelCapacity },
  });

  test('sends independent speed/brake/fuel for assigned cars only', async () => {
    service.sessionDrivers = [
      driver(0, 'a', 30, 90, 70),
      driver(1, 'b', 100, 20, 40),
    ];

    await service.applyCarConfigs();

    expect(writes).toEqual([
      ['speed', 0, 3], ['brake', 0, 9], ['fuel', 0, 7],
      ['speed', 1, 10], ['brake', 1, 2], ['fuel', 1, 4],
    ]);
  });

  test('never changes unassigned controllers without hardware readback', async () => {
    service.sessionDrivers = [driver(2, 'c', 60, 40, 50)];

    await service.applyCarConfigs();

    expect(writes).toEqual([
      ['speed', 2, 6], ['brake', 2, 4], ['fuel', 2, 5],
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
      ['speed', 0, 10], ['brake', 0, 2], ['fuel', 0, 4],
      ['speed', 1, 3], ['brake', 1, 9], ['fuel', 1, 7],
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
    service.syncService.reset.mockImplementation(async () => { steps.push('reset'); });
    service.loadSession = jest.fn(async () => {
      steps.push('load');
      service.sessionDrivers = [driver(0, 'a', 30, 90, 70)];
      service.sessionStatus = SessionStatus.DRAFT;
    });
    service.applyCarConfigs = jest.fn(async () => { steps.push('program'); });
    service.syncService.prepareRace.mockImplementation(async () => { steps.push('lights'); });
    service.prisma.session.update = jest.fn(async () => { steps.push('active'); });
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
});

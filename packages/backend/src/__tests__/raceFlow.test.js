import { jest } from '@jest/globals';
import { SessionService } from '../services/SessionService.js';
import { SessionStatus, SessionType } from '@racehubos/shared';

/**
 * Le déroulé d'une course, du drapeau à damier au classement.
 *
 * La règle : à la fin du temps, chacun termine le tour en cours. Ce tour-là
 * compte et la vitesse est aussitôt réduite ; tout passage suivant est ignoré.
 * Qui n'a pas franchi la ligne avant la fin de la grâce est DNF.
 *
 * Treize engagements de qualification portaient un DNF alors qu'ils étaient
 * classés, d'où ces tests sur le chemin complet plutôt que sur handleLap seul.
 */
describe('déroulé de course', () => {
  let service;
  let setSpeed;

  const driver = (controller, laps) => ({
    id: `sd-${controller}`,
    controller,
    driverId: `driver-${controller}`,
    carId: `car-${controller}`,
    driver: { name: `Pilote ${controller}` },
    car: { brand: 'Carrera', model: 'Voiture' },
    totalLaps: laps,
    totalTime: laps * 12_000,
    bestLapTime: 11_500,
    lastLapTime: 12_000,
    lapsAtFinishing: null,
    crossings: laps,
    isDNF: false,
  });

  const passage = (controller, lapTime = 10_000) => service.handleLap({ controller, lapTime, sector: 1 });

  /** Fige lapsAtFinishing comme le fait startFinishingPhase. */
  const drapeau = () => {
    service.sessionStatus = SessionStatus.FINISHING;
    for (const d of service.sessionDrivers) d.lapsAtFinishing = d.totalLaps;
  };

  beforeEach(() => {
    setSpeed = jest.fn().mockResolvedValue(undefined);
    service = new SessionService({ emit: jest.fn() });
    service.activeSessionId = 'session-1';
    service.activeTrackId = 'track-1';
    service.currentPhase = SessionType.RACE;
    service.sessionStatus = SessionStatus.ACTIVE;
    service.sessionConfig = { maxLaps: null, gracePeriod: 30_000 };
    service.sessionDrivers = [driver(1, 10), driver(2, 9)];
    service.syncService = { getDevice: () => ({ setSpeed }) };

    service.saveLap = jest.fn();
    service.updateSessionDriver = jest.fn();
    service.emitLeaderboard = jest.fn();
    service.recalculatePositions = jest.fn();
    service.checkSessionComplete = jest.fn();
  });

  afterEach(async () => {
    await service.prisma.$disconnect();
  });

  describe('pendant la course', () => {
    it('compte les tours et ne touche pas à la vitesse', async () => {
      await passage(1);

      expect(service.sessionDrivers[0].totalLaps).toBe(11);
      expect(setSpeed).not.toHaveBeenCalled();
    });
  });

  describe('pendant la période de grâce', () => {
    it('compte le tour en cours et réduit aussitôt la vitesse', async () => {
      drapeau();

      await passage(1);

      expect(service.sessionDrivers[0].totalLaps).toBe(11);
      expect(service.saveLap).toHaveBeenCalledTimes(1);
      expect(setSpeed).toHaveBeenCalledWith(1, 1);
      expect(service.sessionDrivers[0]._throttled).toBe(true);
    });

    it('ignore les passages suivants du même pilote', async () => {
      drapeau();
      await passage(1);
      service.saveLap.mockClear();

      await passage(1);
      await passage(1);

      expect(service.sessionDrivers[0].totalLaps).toBe(11);
      expect(service.saveLap).not.toHaveBeenCalled();
    });

    it("ne ralentit pas celui qui n'a pas encore fini son tour", async () => {
      drapeau();

      await passage(1);

      // Le second n'a pas franchi la ligne : il court toujours
      expect(setSpeed).toHaveBeenCalledTimes(1);
      expect(service.sessionDrivers[1]._throttled).toBeUndefined();
    });

    it("ne réduit la vitesse qu'une fois", async () => {
      drapeau();

      await passage(1);
      await passage(1);

      expect(setSpeed).toHaveBeenCalledTimes(1);
    });
  });

  describe('classement à la fin de la grâce', () => {
    const dnfApres = async (passages) => {
      drapeau();
      for (const c of passages) await passage(c);

      service.prisma = {
        sessionDriver: {
          findUnique: jest.fn(({ where }) =>
            Promise.resolve({
              lapsAtFinishing: service.sessionDrivers.find((d) => d.id === where.id).lapsAtFinishing,
            })
          ),
          update: jest.fn().mockResolvedValue({}),
        },
        $disconnect: jest.fn(),
      };
      await service.calculateDNF();
      return service.sessionDrivers.map((d) => d.isDNF === true);
    };

    it("classe qui a franchi la ligne, marque DNF qui ne l'a pas fait", async () => {
      expect(await dnfApres([1])).toEqual([false, true]);
    });

    it('ne marque personne quand tous ont franchi la ligne', async () => {
      expect(await dnfApres([1, 2])).toEqual([false, false]);
    });

    it("marque tout le monde quand personne ne l'a franchie", async () => {
      expect(await dnfApres([])).toEqual([true, true]);
    });
  });

  describe('course au nombre de tours', () => {
    beforeEach(() => {
      service.sessionConfig.maxLaps = 11;
    });

    it('ralentit dès la limite atteinte, sans attendre le drapeau', async () => {
      await passage(1);

      expect(service.sessionDrivers[0].totalLaps).toBe(11);
      expect(setSpeed).toHaveBeenCalledWith(1, 1);
    });

    it('ignore les passages au-delà de la limite', async () => {
      await passage(1);
      service.saveLap.mockClear();

      await passage(1);

      expect(service.sessionDrivers[0].totalLaps).toBe(11);
      expect(service.saveLap).not.toHaveBeenCalled();
    });

    it("marque DNF qui n'a pas atteint la limite", async () => {
      drapeau();
      service.prisma = {
        sessionDriver: {
          findUnique: jest.fn().mockResolvedValue({ lapsAtFinishing: 10 }),
          update: jest.fn().mockResolvedValue({}),
        },
        $disconnect: jest.fn(),
      };

      await service.calculateDNF();

      // 10 et 9 tours pour une limite à 11
      expect(service.sessionDrivers.map((d) => d.isDNF === true)).toEqual([true, true]);
    });
  });

  describe('une fois la session terminée', () => {
    it('ignore tout passage tardif', async () => {
      service.sessionStatus = SessionStatus.FINISHED;

      await passage(1);

      expect(service.sessionDrivers[0].totalLaps).toBe(10);
      expect(service.saveLap).not.toHaveBeenCalled();
    });
  });

  describe('sans Control Unit', () => {
    it('compte le tour même si la vitesse ne peut pas être réduite', async () => {
      service.syncService = { getDevice: () => null };
      drapeau();

      await passage(1);

      expect(service.sessionDrivers[0].totalLaps).toBe(11);
      expect(service.sessionDrivers[0]._throttled).toBeUndefined();
    });
  });
});


describe('VSC speed cap and restoration', () => {
  let service;
  let device;
  let writes;
  let connected;

  const assignedDriver = (controller, maxSpeed) => ({
    id: 'assignment-' + controller,
    controller,
    carId: 'car-' + controller,
    car: { id: 'car-' + controller, maxSpeed },
    totalLaps: 0,
  });

  beforeEach(() => {
    writes = [];
    connected = true;
    device = {
      setSpeed: jest.fn(async (controller, level) => {
        writes.push([controller, level]);
      }),
    };
    service = new SessionService({ emit: jest.fn() });
    service.activeSessionId = 'race-1';
    service.currentPhase = SessionType.RACE;
    service.sessionStatus = SessionStatus.ACTIVE;
    service.sessionConfig = { maxLaps: null, pauses: [] };
    service.sessionDrivers = [assignedDriver(0, 70), assignedDriver(2, 100)];
    service.syncService = {
      getDevice: jest.fn(() => device),
      getCuStatus: jest.fn(() => ({ start: 0 })),
      isConnected: jest.fn(() => connected),
      stopRace: jest.fn().mockResolvedValue(),
      reset: jest.fn().mockResolvedValue(),
    };
  });

  afterEach(async () => {
    if (service.vsc?.timer) clearTimeout(service.vsc.timer);
    jest.useRealTimers();
    jest.restoreAllMocks();
    await service.prisma.$disconnect();
  });

  it('caps assigned cars and restores each saved speed', async () => {
    expect(await service.startVsc(3)).toMatchObject({ status: 'active', active: true, cap: 3 });
    expect(writes).toEqual([[0, 3], [2, 3]]);

    expect(await service.endVsc()).toMatchObject({ status: 'inactive', active: false });
    expect(writes).toEqual([[0, 3], [2, 3], [0, 7], [2, 10]]);
    expect(service.io.emit).toHaveBeenCalledWith('session:vsc', expect.objectContaining({ active: true }));
  });

  it('keeps other speed writes capped during VSC', async () => {
    await service.startVsc(4);
    await service.writeRaceSpeed(0, 9);
    await service.endVsc();

    expect(writes).toEqual([[0, 4], [2, 4], [0, 4], [0, 7], [2, 10]]);
  });

  it('restores automatically when the requested duration expires', async () => {
    jest.useFakeTimers();
    await service.startVsc(3, 5);
    expect(service.getVscState().expiresAt).toBeTruthy();

    await jest.advanceTimersByTimeAsync(5000);

    expect(service.getVscState().status).toBe('inactive');
    expect(writes).toEqual([[0, 3], [2, 3], [0, 7], [2, 10]]);
  });

  it('does not repeat CU commands on repeated activation', async () => {
    await service.startVsc(3);
    const repeated = await service.startVsc(4);

    expect(repeated.cap).toBe(3);
    expect(writes).toEqual([[0, 3], [2, 3]]);
    await service.endVsc();
  });

  it('serializes overlapping VSC activation and stop', async () => {
    await Promise.all([service.startVsc(3), service.endVsc()]);

    expect(service.getVscState().status).toBe('inactive');
    expect(writes).toEqual([[0, 3], [2, 3], [0, 7], [2, 10]]);
  });

  it.each([
    [0, 0],
    [11, 0],
    [3, 2],
    [3, 3601],
    [3, 0.5],
  ])('rejects invalid cap %s and duration %s', async (cap, duration) => {
    await expect(service.startVsc(cap, duration)).rejects.toThrow();
    expect(writes).toEqual([]);
    expect(service.getVscState().status).toBe('inactive');
  });

  it('refuses to activate without a connected, running race', async () => {
    connected = false;
    await expect(service.startVsc(3)).rejects.toThrow('does not support');
    connected = true;
    service.syncService.getCuStatus.mockReturnValue({ start: 1 });
    await expect(service.startVsc(3)).rejects.toThrow('requires a race');
    expect(writes).toEqual([]);
  });

  it('rolls back partial speed programming without reporting VSC active', async () => {
    let calls = 0;
    device.setSpeed.mockImplementation(async (controller, level) => {
      calls++;
      if (calls === 2) throw new Error('BLE timeout');
      writes.push([controller, level]);
    });

    await expect(service.startVsc(3)).rejects.toThrow('BLE timeout');

    expect(service.getVscState().status).toBe('inactive');
    expect(writes).toEqual([[0, 3], [0, 7], [2, 10]]);
  });

  it('retains an actionable error when partial rollback also fails', async () => {
    let calls = 0;
    device.setSpeed.mockImplementation(async (controller, level) => {
      calls++;
      if (calls === 2 || calls === 3) throw new Error('BLE timeout');
      writes.push([controller, level]);
    });

    await expect(service.startVsc(3)).rejects.toThrow('BLE timeout');

    expect(service.getVscState().status).toBe('restore_failed');
    expect(service.io.emit).toHaveBeenCalledWith('session:vsc_error', expect.any(Object));
    await expect(service.startVsc(3)).rejects.toThrow('restoration is pending');
    await service.endVsc();
    expect(service.getVscState().status).toBe('inactive');
  });

  it('retains the unresolved VSC after CU disconnection and permits a retry', async () => {
    await service.startVsc(3);
    connected = false;
    service.onVscDisconnect();

    expect(service.getVscState().status).toBe('disconnected');
    await expect(service.endVsc()).rejects.toThrow('disconnected');
    expect(service.getVscState().status).toBe('restore_failed');

    connected = true;
    await service.endVsc();
    expect(service.getVscState().status).toBe('inactive');
  });

  it('does not restore a speed to a different car on the same controller', async () => {
    await service.startVsc(3);
    service.sessionDrivers[0].carId = 'different-car';

    await expect(service.endVsc()).rejects.toThrow('vehicle assignment changed');

    expect(writes).toEqual([[0, 3], [2, 3], [2, 10]]);
    expect(service.getVscState().status).toBe('restore_failed');
  });

  it('preserves a driver finish throttle when the VSC ends', async () => {
    await service.startVsc(3);
    service.sessionDrivers[0]._throttled = true;
    await service.endVsc();

    expect(writes).toEqual([[0, 3], [2, 3], [0, 1], [2, 10]]);
  });

  it('stops the CU before restoring speeds on pause', async () => {
    const order = [];
    device.setSpeed.mockImplementation(async (controller, level) => {
      order.push('speed');
      writes.push([controller, level]);
    });
    service.syncService.stopRace.mockImplementation(async () => { order.push('stop'); });
    const prisma = service.prisma;
    service.prisma = {
      session: { update: jest.fn().mockResolvedValue({}) },
      $disconnect: () => prisma.$disconnect(),
    };

    await service.startVsc(3);
    order.length = 0;
    await service.pauseSession();

    expect(order).toEqual(['stop', 'speed', 'speed']);
    expect(service.sessionStatus).toBe(SessionStatus.PAUSED);
    expect(service.getVscState().status).toBe('inactive');
  });

  it('keeps failed cleanup visible and refuses another race until restoration', async () => {
    await service.startVsc(3);
    connected = false;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await service.resetForNewSession();

    expect(service.getVscState().status).toBe('restore_failed');
    connected = true;
    await expect(service.startSession('new-race')).rejects.toThrow('VSC speed restoration is unresolved');
    expect(service.syncService.reset).toHaveBeenCalledTimes(1);
  });
});

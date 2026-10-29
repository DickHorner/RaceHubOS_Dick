import { createPrismaClient } from '../lib/prisma.js';
import EventEmitter from 'events';
import {
  SESSION_TYPES,
  SessionStatus,
  SessionType,
  DamageStatus,
  PenaltyKind,
  PenaltyStatus,
  WeatherCondition,
  TyreType,
  isSessionType,
  toLevel,
  validWeatherConfig,
  weatherAtElapsed,
  weatherForSession,
  validTyreType,
  validTyreMismatchPercent,
  tyreAdjustedLapTime,
  validDamageConfig,
  validVirtualFuelRate,
  virtualFuelBurn,
  virtualFuelAfter,
  replayVirtualFuel,
  VIRTUAL_FUEL_FULL,
  withRacePenalties,
  compareRaceClassification,
  rankRaceDrivers,
} from '@racehubos/shared';
import { sessionName } from '../lib/sessionNames.js';

const DEFAULT_GRACE_PERIOD_MS = 30000;
const RUNNING_STATUSES = [SessionStatus.ACTIVE, SessionStatus.PAUSED, SessionStatus.FINISHING];

function penaltyError(message, status) {
  return Object.assign(new Error(message), { status });
}

/**
 * SessionService - Gestion de la logique session et emission vers clients
 *
 * Recoit les donnees formatees de SyncService et gere :
 * - Enregistrement des laps en DB
 * - Calcul des positions et gaps
 * - Detection fin de session (temps/tours)
 * - Emission des events aux clients
 *
 * Emet aussi des events internes via EventEmitter pour les autres services.
 */
export class SessionService extends EventEmitter {
  constructor(io) {
    super();
    this.io = io;
    this.prisma = createPrismaClient();
    this.syncService = null;

    // Session state
    this.activeSessionId = null;
    this.startingSessionId = null;
    this.activeTrackId = null;
    this.currentPhase = SessionType.PRACTICE;
    this.sessionConfig = null;
    this.sessionStatus = null;
    this.lastWeatherCondition = null;

    // Driver states
    this.sessionDrivers = [];
    this.tyreWrites = Promise.resolve();
    this.damageOperation = Promise.resolve();
    this.virtualFuelWrites = Promise.resolve();
    this.sessionPenalties = [];
    this.firstCrossingProgrammed = new Set();
    this.speedWrites = Promise.resolve();
    this.vscOperation = Promise.resolve();
    this.vsc = null;
    this.previousPositions = new Map(); // controller -> previous position
    this.displayedDeltas = new Map(); // controller -> delta to display

    // Grace period
    this.raceFinishTime = null;
    this.gracePeriodTimer = null;
    this.gracePeriodEndsAt = null;

    // Heartbeat
    this.heartbeatInterval = null;

    // Lap history for balancing sessions (controller -> [{lapNumber, lapTime}])
    this.lapHistory = new Map();
  }

  setSyncService(syncService) {
    this.syncService = syncService;
  }

  // ==================== Event Handlers (called by SyncService) ====================

  /**
   * Handle lap data from SyncService
   * @param {{ controller: number, timestamp: number, lapTime: number, sector: number }} data
   */
  async handleLap(data) {
    const { controller, timestamp, lapTime, sector } = data;

    // Ignore stale hardware events when there is no running session.
    if (!this.activeSessionId || !this.isActive() || this.sessionStatus === SessionStatus.PAUSED) {
      return;
    }

    if (sector !== 1) return;

    // CU slots 6 and 7 are reserved for Autonomous Car and Pace Car.
    // Never count them as human laps, even if old assignments contain them.
    if (!Number.isInteger(controller) || controller < 0 || controller > 5) return;

    const driver = this.getDriverByController(controller);
    if (driver?.damageStatus === DamageStatus.ACTIVE) await this.expireDamage();
    if (!driver || this.hasDriverFinished(driver)) return;

    // The first finish-line crossing often has lapTime=0; reapply before discarding it.
    if (
      this.sessionStatus === SessionStatus.ACTIVE &&
      timestamp > 0 &&
      lapTime >= 0 &&
      driver.carId &&
      driver.car &&
      !this.firstCrossingProgrammed.has(controller)
    ) {
      const device = this.syncService?.getDevice();
      if (device?.setSpeed && device?.setBrake) {
        this.firstCrossingProgrammed.add(controller);
        let field = 'speed';
        try {
          await this.writeRaceSpeed(controller, toLevel(driver.car.maxSpeed));
          field = 'brake';
          await device.setBrake(controller, toLevel(driver.car.brakeForce));
        } catch (error) {
          console.warn(
            `[SessionService] First-crossing ${field} failed for controller ${controller + 1}:`,
            error.message
          );
          this.emit('session:config_error', {
            sessionId: this.activeSessionId,
            controller,
            field,
            error: error.message,
          });
        }
      }
    }

    // Only record laps with a valid measured time.
    if (!Number.isFinite(lapTime) || lapTime <= 0) return;

    // Track crossings - first crossing is start, doesn't count as lap
    // const isFirstCrossing = driver.crossings === 0; // DISABLED: count first lap
    driver.crossings++;

    // if (isFirstCrossing) { // DISABLED
    // // First crossing = crossing start line from grid, not a lap
    // this.emitLeaderboard();
    // }

    // Balancing: ignore laps beyond maxLaps per controller
    const maxLaps = this.sessionConfig?.maxLaps;
    if (this.currentPhase === SessionType.BALANCING && maxLaps && driver.totalLaps >= maxLaps) {
      return;
    }

    // 1. Update RAM
    driver.totalLaps++;
    driver.lastLapTime = Math.round(lapTime);

    // Track lap history for balancing chart
    if (this.currentPhase === SessionType.BALANCING) {
      if (!this.lapHistory.has(controller)) {
        this.lapHistory.set(controller, []);
      }
      this.lapHistory.get(controller).push({
        lapNumber: driver.totalLaps,
        lapTime: Math.round(lapTime),
      });
    }

    const previousSessionBest = this.getSessionBestLapTime();
    if (driver.bestLapTime === null || lapTime < driver.bestLapTime) {
      driver.bestLapTime = Math.round(lapTime);
    }

    // Check if this is a new session best lap
    const roundedLap = Math.round(lapTime);
    if (previousSessionBest === null || roundedLap < previousSessionBest) {
      const bestLapEvent = {
        sessionId: this.activeSessionId,
        controller: driver.controller,
        driverName: driver.driver?.name || null,
        carBrand: driver.car?.brand || null,
        carModel: driver.car?.model || null,
        sessionType: this.currentPhase,
        lapTime: roundedLap,
        totalLaps: driver.totalLaps,
        maxLapsCompleted: Math.max(...this.sessionDrivers.map((d) => d.totalLaps)),
      };
      this.emit('session:bestlap', bestLapEvent);
      super.emit('soundboardAutoEvent', { type: 'bestlap', data: bestLapEvent });
    }

    // Measured and simulated lap times are separate; no CU speed command is sent.
    const weatherAtLap = this.sessionConfig ? weatherForSession(this.sessionConfig, Date.now()) : null;
    const simulate =
      this.currentPhase === SessionType.RACE && this.sessionConfig?.tyreMismatchPercent > 0 && weatherAtLap !== null;
    const simulatedLapTime = simulate
      ? tyreAdjustedLapTime(lapTime, driver.tyreType, weatherAtLap, this.sessionConfig.tyreMismatchPercent)
      : null;
    if (simulatedLapTime !== null) {
      driver.simulatedBestLapTime = Math.min(driver.simulatedBestLapTime ?? Infinity, simulatedLapTime);
    }

    // Extra laps during the grace period don't count toward the total.
    if (!maxLaps || driver.totalLaps <= maxLaps) {
      driver.totalTime += Math.round(lapTime);
      if (simulatedLapTime !== null) {
        driver.simulatedTotalTime = (driver.simulatedTotalTime ?? 0) + simulatedLapTime;
      }
    }

    // 2. Recalculate positions (pass controller who just completed a lap)
    this.recalculatePositions(controller);

    // 3. Save to DB
    await this.saveLap(driver, lapTime, simulatedLapTime, simulate ? weatherAtLap : null);
    await this.updateSessionDriver(driver);
    await this.triggerDamage(driver, lapTime);

    // 4. Emit leaderboard
    this.emitLeaderboard();

    // 5. Throttle car if this driver has met the finish condition
    await this.throttleIfFinished(driver);

    // 6. Check session completion
    await this.checkSessionComplete();
  }

  /**
   * Check whether a driver has completed their individual finish condition.
   * - Lap-based race: the configured lap limit has been reached.
   * - Time-based race: one final lap has been completed after the checkered flag.
   */
  hasDriverFinished(driver) {
    if (driver.damageStatus === DamageStatus.DNF) return true;
    const maxLaps = this.sessionConfig?.maxLaps;

    if (maxLaps) {
      return driver.totalLaps >= maxLaps;
    }

    return (
      this.sessionStatus === SessionStatus.FINISHING &&
      driver.lapsAtFinishing != null &&
      driver.totalLaps > driver.lapsAtFinishing
    );
  }

  /**
   * Reduce speed to 1 for a driver who has completed their finish condition.
   * Other drivers keep their normal speed.
   */
  async throttleIfFinished(driver) {
    if (driver._throttled) return;
    if (!this.hasDriverFinished(driver)) return;

    const device = this.syncService?.getDevice();
    if (!device?.setSpeed) return;

    try {
      await this.writeRaceSpeed(driver.controller, 1);
      driver._throttled = true;
    } catch (err) {
      console.warn('[SessionService] throttle failed:', err.message);
    }
  }

  // ==================== Session Lifecycle ====================

  async assertNoOtherRunningSession(sessionId) {
    const running = await this.prisma.session.findMany({
      where: { status: { in: RUNNING_STATUSES }, deletedAt: null },
      select: { id: true, name: true, status: true },
      take: 2,
    });
    if (this.isActive() && !running.some((session) => session.id === this.activeSessionId)) {
      running.push({ id: this.activeSessionId, name: null, status: this.sessionStatus });
    }
    if (running.length > 1 || running.some((session) => session.id !== sessionId)) {
      const details = running.map((session) => `${session.name || 'Session'} (${session.status}, ${session.id})`).join(', ');
      const error = penaltyError(
        `Another session is already running: ${details}. Stop or resolve it before switching sessions.`,
        409
      );
      error.runningSessions = running;
      throw error;
    }
    return running;
  }

  assertCurrentSession(sessionId) {
    if (this.startingSessionId || this._finishing || !this.isActive() || this.activeSessionId !== sessionId) {
      throw penaltyError(
        `Session ${sessionId} is not the current running session (${this.activeSessionId || 'none'}).`,
        409
      );
    }
  }

  /**
   * Load session from DB
   */
  async loadSession(sessionId) {
    if (this.startingSessionId && this.startingSessionId !== sessionId) {
      throw penaltyError(`Session ${this.startingSessionId} is starting; cannot load another session.`, 409);
    }
    await this.assertNoOtherRunningSession(sessionId);
    await this.tyreWrites;
    await this.virtualFuelWrites;
    await this.damageOperation;
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        drivers: {
          include: { driver: true, car: true },
          orderBy: { controller: 'asc' },
        },
        track: true,
        championship: true,
        virtualFuelEvents: { orderBy: { id: 'asc' } },
        penalties: true,
      },
    });

    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (this.activeSessionId !== session.id || session.status === SessionStatus.DRAFT) {
      this.firstCrossingProgrammed.clear();
    }
    this.activeSessionId = session.id;
    this.activeTrackId = session.trackId;
    // A lap's phase is its session's type; the ladder this replaces spelled out
    // that identity type by type, and silently fell back to race for a new one
    this.currentPhase = isSessionType(session.type) ? session.type : SessionType.RACE;

    // Reset position tracking for new session
    if (!this.previousPositions) {
      this.previousPositions = new Map();
    } else {
      this.previousPositions.clear();
    }
    if (!this.displayedDeltas) {
      this.displayedDeltas = new Map();
    } else {
      this.displayedDeltas.clear();
    }

    this.sessionConfig = {
      maxDuration: session.maxDuration,
      maxLaps: session.maxLaps,
      gracePeriod: session.gracePeriod || DEFAULT_GRACE_PERIOD_MS,
      startedAt: session.startedAt,
      championshipId: session.championshipId,
      finishedAt: session.finishedAt,
      weatherSeed: session.weatherSeed,
      weatherInitial: session.weatherInitial,
      weatherRainChance: session.weatherRainChance,
      weatherIntervalSeconds: session.weatherIntervalSeconds,
      weatherAdvanceDuringPause: session.weatherAdvanceDuringPause,
      tyreMismatchPercent: session.tyreMismatchPercent,
      virtualFuelRate: session.virtualFuelRate,
      damageLapThresholdMs: session.damageLapThresholdMs,
      damageRepairSeconds: session.damageRepairSeconds,
      damagePitSeconds: session.damagePitSeconds,
      pauses: session.pauses ? JSON.parse(session.pauses) : [],
    };
    this.sessionStatus = session.status;
    this.lastWeatherCondition = weatherForSession(this.sessionConfig, Date.now());
    this.sessionPenalties = (session.penalties || []).filter((penalty) => penalty.status === PenaltyStatus.ACTIVE);

    // Replay saved fuel events in database order; the cache is not the source of truth.
    const fuelLevels = replayVirtualFuel(session.virtualFuelEvents);
    this.sessionDrivers = session.drivers.map((sd) => ({
      id: sd.id,
      sessionId: session.id,
      controller: sd.controller,
      driverId: sd.driverId,
      carId: sd.carId,
      driver: sd.driver,
      car: sd.car,
      gridPos: sd.gridPos,
      position: sd.position || 0,
      totalLaps: sd.totalLaps || 0,
      totalTime: sd.totalTime || 0,
      simulatedTotalTime: sd.simulatedTotalTime,
      simulatedBestLapTime: sd.simulatedBestLapTime,
      tyreType: sd.tyreType,
      pendingTyreType: sd.pendingTyreType,
      bestLapTime: sd.bestLapTime || null,
      lastLapTime: sd.lastLapTime || null,
      virtualFuelUnits: session.virtualFuelRate == null ? null : (fuelLevels.get(sd.id) ?? VIRTUAL_FUEL_FULL),
      isDNF: sd.isDNF || false,
      damageStatus: sd.damageStatus,
      damageLapNumber: sd.damageLapNumber,
      damageTriggeredAt: sd.damageTriggeredAt,
      damageDeadlineElapsedMs: sd.damageDeadlineElapsedMs,
      damageRepairedAt: sd.damageRepairedAt,
      damageRepairPitStopId: sd.damageRepairPitStopId,
      damageRepairSource: sd.damageRepairSource,
      lapsAtFinishing: sd.lapsAtFinishing ?? null, // For checkered flag logic
      gap: null,
      crossings: sd.totalLaps || 0, // Track line crossings (first doesn't count as lap)
    }));

    // Load lap history for balancing sessions (needed for chart data)
    this.lapHistory = new Map();
    if (session.type === SessionType.BALANCING) {
      const existingLaps = await this.prisma.lap.findMany({
        where: { sessionId: session.id, deletedAt: null },
        orderBy: { lapNumber: 'asc' },
      });
      for (const lap of existingLaps) {
        if (!this.lapHistory.has(lap.controller)) {
          this.lapHistory.set(lap.controller, []);
        }
        this.lapHistory.get(lap.controller).push({
          lapNumber: lap.lapNumber,
          lapTime: Math.round(lap.lapTime),
        });
      }
    }

    this.raceFinishTime = null;
    this.recalculatePositions();
    this.emitLeaderboard();
    if (
      session.startedAt &&
      [SessionStatus.ACTIVE, SessionStatus.PAUSED, SessionStatus.FINISHING].includes(session.status)
    ) {
      this.startHeartbeat();
    }

    // If session is in finishing state, recreate grace period timer
    if (session.status === SessionStatus.FINISHING && session.finishingAt) {
      const gracePeriod = this.sessionConfig.gracePeriod || DEFAULT_GRACE_PERIOD_MS;
      const elapsed = Date.now() - new Date(session.finishingAt).getTime();
      const remaining = Math.max(0, gracePeriod - elapsed);

      this.gracePeriodEndsAt = Date.now() + remaining;

      if (remaining > 0) {
        this.gracePeriodTimer = setTimeout(async () => {
          if (this.sessionStatus === SessionStatus.FINISHING) {
            await this.finishSession('grace_period_elapsed');
          }
        }, remaining);
      } else {
        // Grace period already elapsed, finish immediately
        setImmediate(async () => {
          if (this.sessionStatus === SessionStatus.FINISHING) {
            await this.finishSession('grace_period_elapsed');
          }
        });
      }
    }

    return session;
  }

  /**
   * Start session
   * Puts session in 'active' state and triggers CU lights (1/5).
   * User must click START buttons to advance through lights (2/5...5/5) then race starts.
   * Note: startedAt is set later by onRaceStart() when CU goes to racing (GO!)
   */
  async startSession(sessionId) {
    if (this.startingSessionId || this._finishing) {
      throw penaltyError('Another session transition is already in progress.', 409);
    }
    this.startingSessionId = sessionId;
    try {
      if (!this.syncService?.isConnected()) {
        throw new Error('No device connected. Connect a CU or Simulator first.');
      }
      if (this.vsc) throw new Error('VSC speed restoration is unresolved; clear it before the next race');

      // Reject before touching the CU or replacing the running session in memory.
      const running = await this.assertNoOtherRunningSession(sessionId);
      if (running.length || this.isActive()) {
        throw penaltyError(`Session ${sessionId} is already running; stop it before starting again.`, 409);
      }
      const session = await this.prisma.session.findUnique({
        where: { id: sessionId },
        select: { status: true, deletedAt: true },
      });
      if (!session || session.deletedAt) throw penaltyError(`Session ${sessionId} not found`, 404);
      if (session.status !== SessionStatus.DRAFT) {
        throw penaltyError(`Session must be 'draft' to start, current: ${session.status}`, 409);
      }

      // Apply vehicle profiles while the CU is stopped, before starting the lights.
      // A failed write must not leave the session active or start the race.
      await this.syncService.reset();
      await this.loadSession(sessionId);
      await this.applyCarConfigs();
      await this.syncService.prepareRace();

      await this.prisma.session.update({
        where: { id: sessionId },
        data: { status: SessionStatus.ACTIVE },
      });
      this.sessionStatus = SessionStatus.ACTIVE;

      this.startHeartbeat();
      this.emit('session:started', { sessionId });
      this.emitStatusChanged('active', 'draft');

      return this.getState();
    } finally {
      this.startingSessionId = null;
    }
  }
  /**
   * Pause session
   */
  async pauseSession(sessionId) {
    if (sessionId !== undefined) this.assertCurrentSession(sessionId);
    if (!this.activeSessionId) return null;

    if (!this.syncService?.isConnected()) throw new Error('Control Unit disconnected');

    // Stop the physical race before reporting a successful pause.
    await this.syncService.stopRace();
    if (this.vsc) {
      try {
        await this.endVsc(true);
      } catch (error) {
        console.error('[SessionService] VSC restore after pause failed:', error.message);
      }
    }

    const now = Date.now();
    const pauses = [...(this.sessionConfig?.pauses || []), { start: now, end: null }];
    await this.prisma.session.update({
      where: { id: this.activeSessionId },
      data: { status: SessionStatus.PAUSED, pauses: JSON.stringify(pauses) },
    });
    this.sessionConfig.pauses = pauses;

    const previousStatus = this.sessionStatus;
    this.sessionStatus = 'paused';

    this.emit('session:paused', { sessionId: this.activeSessionId });
    this.emitStatusChanged('paused', previousStatus);

    return { sessionId: this.activeSessionId };
  }

  /**
   * Resume session
   * Puts CU in lights mode. Pause closes and chrono resumes at GO (via onRaceStart)
   */
  async resumeSession(sessionId) {
    if (sessionId !== undefined) this.assertCurrentSession(sessionId);
    if (!this.activeSessionId || this.sessionStatus !== SessionStatus.PAUSED) return null;

    if (!this.syncService?.isConnected()) throw new Error('Control Unit disconnected');
    if (this.vsc) await this.endVsc(true);

    // Start the CU lights before reporting the session as resumed.
    await this.syncService.prepareRace();

    // Keep the pause open until GO (handled by onRaceStart).
    await this.prisma.session.update({
      where: { id: this.activeSessionId },
      data: { status: SessionStatus.ACTIVE },
    });
    this.sessionStatus = 'active';

    this.emit('session:resumed', { sessionId: this.activeSessionId });
    this.emitStatusChanged('active', 'paused');

    return { sessionId: this.activeSessionId };
  }

  /**
   * Stop session manually
   */
  async stopSession(sessionId) {
    if (sessionId !== undefined) this.assertCurrentSession(sessionId);
    if (!this.activeSessionId) return null;

    const sessionId = this.activeSessionId;
    await this.finishSession('manual_stop');
    // Note: finishSession() already calls stopRace() and emits session:finished

    return { sessionId };
  }

  /**
   * Reset for new session
   */
  async resetForNewSession() {
    this.stopHeartbeat();
    await this.tyreWrites;
    await this.virtualFuelWrites;
    await this.damageOperation;
    if (this.vsc) {
      try {
        await this.syncService?.stopRace();
        await this.endVsc(true);
      } catch (error) {
        console.error('[SessionService] VSC cleanup failed; speed values may remain limited:', error.message);
      }
    }

    // Keep sessionDrivers for leaderboard queries until new session loads
    if (this.previousPositions) {
      this.previousPositions.clear();
    }
    if (this.displayedDeltas) {
      this.displayedDeltas.clear();
    }
    this.raceFinishTime = null;
    this.gracePeriodEndsAt = null;
    this.activeSessionId = null;
    this.activeTrackId = null;
    this.firstCrossingProgrammed.clear();
    this.currentPhase = SessionType.PRACTICE;
    this.sessionConfig = null;
    this.sessionStatus = null;
    this.lastWeatherCondition = null;
    this.sessionPenalties = [];
    this.lapHistory = new Map();

    if (this.gracePeriodTimer) {
      clearTimeout(this.gracePeriodTimer);
      this.gracePeriodTimer = null;
    }

    await this.syncService?.reset();
  }

  // ==================== Hardware Control ====================

  async startRace() {
    await this.syncService?.startRace();
  }

  async stopRace() {
    await this.syncService?.stopRace();
  }

  isConnected() {
    return this.syncService?.isConnected() || false;
  }

  /**
   * Called by SyncService when CU transitions to racing (GO!)
   * - First start: sets startedAt
   * - Resume from pause: closes pause entry
   */
  async onRaceStart() {
    if (!this.activeSessionId || this.sessionStatus !== SessionStatus.ACTIVE) return;

    const now = Date.now();

    // Check if resuming from pause (has open pause entry)
    const pauses = this.sessionConfig?.pauses || [];
    const lastPause = pauses[pauses.length - 1];
    const isResumingFromPause = lastPause && lastPause.end === null;

    if (isResumingFromPause) {
      // Close the pause entry
      lastPause.end = now;

      await this.prisma.session.update({
        where: { id: this.activeSessionId },
        data: { pauses: JSON.stringify(pauses) },
      });

      this.emit('session:race_resumed', {
        sessionId: this.activeSessionId,
        resumedAt: new Date(now).toISOString(),
      });
    } else if (!this.sessionConfig.startedAt) {
      // First start - set startedAt
      const startedAt = new Date(now);
      // Preserve the existing in-memory GO guard while the snapshot is being saved.
      this.sessionConfig.startedAt = startedAt;
      try {
        if (this.currentPhase === SessionType.RACE && this.sessionConfig.championshipId) {
          const assigned = this.sessionDrivers.filter((entry) => entry.driverId);
          const memberships = await this.prisma.driver.findMany({
            where: { id: { in: assigned.map((entry) => entry.driverId) } },
            select: { id: true, teamId: true },
          });
          const teamsByDriver = new Map(memberships.map((driver) => [driver.id, driver.teamId]));

          await this.prisma.$transaction(async (tx) => {
            for (const entry of assigned) {
              await tx.sessionDriver.update({
                where: { id: entry.id },
                data: { teamIdAtStart: teamsByDriver.get(entry.driverId) ?? null },
              });
            }
            await tx.session.update({
              where: { id: this.activeSessionId },
              data: { startedAt, teamMembershipSnapshotted: true },
            });
          });
        } else {
          await this.prisma.session.update({
            where: { id: this.activeSessionId },
            data: { startedAt },
          });
        }
      } catch (error) {
        this.sessionConfig.startedAt = null;
        throw error;
      }

      this.emit('session:race_started', {
        sessionId: this.activeSessionId,
        startedAt: startedAt.toISOString(),
      });
    }
  }

  // ==================== Position & Leaderboard ====================

  /**
   * Persist one completed pit cycle. The times are observed by the server,
   * not timestamped by the Carrera CU.
   */
  async recordPitStop({ controller, enteredAt, exitedAt, source }) {
    if (!this.activeSessionId || this.sessionStatus !== SessionStatus.ACTIVE) return;
    const driver = this.getDriverByController(controller);
    if (!driver?.id) return;

    const durationMs = exitedAt.getTime() - enteredAt.getTime();
    if (!Number.isFinite(durationMs) || durationMs <= 0) return;

    const sessionId = this.activeSessionId;
    const data = { sessionId, sessionDriverId: driver.id, controller, enteredAt, exitedAt, durationMs, source };
    return this.queueTyre(() =>
      this.queueDamage(async () => {
        if (this.activeSessionId !== sessionId || this.sessionStatus !== SessionStatus.ACTIVE) return;

        const applyTyres =
          source === 'simulator' && validTyreType(driver.pendingTyreType) && driver.pendingTyreType !== driver.tyreType;
        const refuel = this.sessionConfig?.virtualFuelRate != null && source === 'simulator';
        const repair =
          source === 'simulator' &&
          driver.damageStatus === DamageStatus.ACTIVE &&
          durationMs >= this.sessionConfig.damagePitSeconds * 1000 &&
          enteredAt.getTime() >= new Date(driver.damageTriggeredAt).getTime() &&
          this.raceClock(exitedAt.getTime()).elapsedTime < driver.damageDeadlineElapsedMs &&
          this.raceClock().elapsedTime < driver.damageDeadlineElapsedMs;
        let pitStop;
        if (applyTyres || refuel || repair) {
          const result = await this.prisma.$transaction(async (tx) => {
            const pit = await tx.pitStop.create({ data });
            let change = null;
            let event = null;
            let repaired = false;
            if (applyTyres) {
              change = await tx.tyreChange.create({
                data: {
                  sessionId,
                  sessionDriverId: driver.id,
                  controller,
                  fromType: driver.tyreType,
                  toType: driver.pendingTyreType,
                  source: 'simulator',
                  pitStopId: pit.id,
                },
              });
              await tx.sessionDriver.update({
                where: { id: driver.id },
                data: { tyreType: change.toType, pendingTyreType: null },
              });
            }
            if (refuel) {
              event = await tx.virtualFuelEvent.create({
                data: {
                  sessionId,
                  sessionDriverId: driver.id,
                  controller,
                  kind: 'refuel',
                  units: 0,
                  source: 'simulator',
                  reference: `pit:${pit.id}`,
                },
              });
            }
            if (repair) {
              await tx.sessionDriver.update({
                where: { id: driver.id },
                data: {
                  damageStatus: DamageStatus.REPAIRED,
                  damageRepairedAt: exitedAt,
                  damageRepairPitStopId: pit.id,
                  damageRepairSource: 'simulator',
                },
              });
              repaired = true;
            }
            return { pit, change, event, repaired };
          });
          pitStop = result.pit;
          if (result.change) {
            driver.tyreType = result.change.toType;
            driver.pendingTyreType = null;
            this.emit('session:tyre_changed', { sessionId, sessionDriverId: driver.id, change: result.change });
          }
          if (result.event) {
            driver.virtualFuelUnits = virtualFuelAfter(driver.virtualFuelUnits ?? VIRTUAL_FUEL_FULL, result.event);
          }
          if (result.repaired) {
            driver.damageStatus = DamageStatus.REPAIRED;
            driver.damageRepairedAt = exitedAt;
            driver.damageRepairPitStopId = pitStop.id;
            driver.damageRepairSource = 'simulator';
            this.emit('session:damage_changed', {
              sessionId,
              sessionDriverId: driver.id,
              controller,
              damageStatus: DamageStatus.REPAIRED,
            });
          }
          this.emitLeaderboard();
        } else {
          // Physical CU pit telemetry is not validated: record the stop, never infer a refuel or tyre change.
          pitStop = await this.prisma.pitStop.create({ data });
        }
        this.emit('session:pit_stop', pitStop);
        return pitStop;
      })
    );
  }

  // Matches the existing queueVsc pattern; requests and pit exits execute in order.
  queueTyre(action) {
    const result = this.tyreWrites.then(action);
    this.tyreWrites = result.catch(() => {});
    return result;
  }

  requestTyreChange(sessionId, sessionDriverId, tyreType) {
    return this.queueTyre(async () => {
      if (!validTyreType(tyreType)) throw Object.assign(new Error('Invalid tyre choice'), { status: 400 });
      if (
        sessionId !== this.activeSessionId ||
        this.currentPhase !== SessionType.RACE ||
        ![SessionStatus.ACTIVE, SessionStatus.PAUSED].includes(this.sessionStatus)
      ) {
        throw Object.assign(new Error('No active race for this tyre request'), { status: 409 });
      }
      const driver = this.sessionDrivers.find((row) => row.id === sessionDriverId);
      if (!driver?.driverId || !driver.carId) {
        throw Object.assign(new Error('Driver assignment is no longer available'), { status: 409 });
      }
      const pendingTyreType = tyreType === driver.tyreType ? null : tyreType;
      await this.prisma.sessionDriver.update({
        where: { id: driver.id },
        data: { pendingTyreType },
      });
      driver.pendingTyreType = pendingTyreType;
      this.emit('session:tyre_changed', { sessionId, sessionDriverId, tyreType: driver.tyreType, pendingTyreType });
      this.emitLeaderboard();
      return { tyreType: driver.tyreType, pendingTyreType };
    });
  }

  confirmTyreChange(sessionId, sessionDriverId) {
    return this.queueTyre(async () => {
      if (
        sessionId !== this.activeSessionId ||
        this.currentPhase !== SessionType.RACE ||
        ![SessionStatus.ACTIVE, SessionStatus.PAUSED].includes(this.sessionStatus)
      ) {
        throw Object.assign(new Error('No active race for tyre confirmation'), { status: 409 });
      }
      const driver = this.sessionDrivers.find((row) => row.id === sessionDriverId);
      if (!driver?.driverId || !validTyreType(driver.pendingTyreType) || driver.pendingTyreType === driver.tyreType) {
        throw Object.assign(new Error('No pending tyre change for this driver'), { status: 409 });
      }
      const change = await this.prisma.$transaction(async (tx) => {
        const record = await tx.tyreChange.create({
          data: {
            sessionId,
            sessionDriverId: driver.id,
            controller: driver.controller,
            fromType: driver.tyreType,
            toType: driver.pendingTyreType,
            source: 'director',
          },
        });
        await tx.sessionDriver.update({
          where: { id: driver.id },
          data: { tyreType: record.toType, pendingTyreType: null },
        });
        return record;
      });
      driver.tyreType = change.toType;
      driver.pendingTyreType = null;
      this.emit('session:tyre_changed', { sessionId, sessionDriverId, change });
      this.emitLeaderboard();
      return change;
    });
  }

  /** Recalculate persisted championship positions without modifying raw lap records. */
  async updatePenaltyPositions(tx, sessionId) {
    const drivers = await tx.sessionDriver.findMany({ where: { sessionId, deletedAt: null } });
    const penalties = await tx.sessionPenalty.findMany({
      where: { sessionId, status: PenaltyStatus.ACTIVE },
    });
    const ranked = rankRaceDrivers(drivers, penalties);
    for (const [index, driver] of ranked.entries()) {
      await tx.sessionDriver.update({ where: { id: driver.id }, data: { finalPos: index + 1 } });
    }
  }

  penaltyChanged(sessionId, championshipId, penalty) {
    if (this.activeSessionId === sessionId) {
      this.sessionPenalties = this.sessionPenalties.filter((row) => row.id !== penalty.id);
      if (penalty.status === PenaltyStatus.ACTIVE) this.sessionPenalties.push(penalty);
      this.recalculatePositions();
      this.emitLeaderboard();
    }
    this.emit('session:penalties_changed', { sessionId });
    if (championshipId) super.emit('sessionResultsChanged', { sessionId, championshipId });
  }

  async issuePenalty({ sessionId, sessionDriverId, kind, amount, reason, requestId }) {
    if (
      typeof sessionId !== 'string' ||
      !sessionId ||
      typeof sessionDriverId !== 'string' ||
      !sessionDriverId ||
      typeof requestId !== 'string' ||
      !/^[a-zA-Z0-9_-]{12,100}$/.test(requestId) ||
      typeof reason !== 'string' ||
      reason.trim().length < 3 ||
      reason.trim().length > 200 ||
      ![PenaltyKind.TIME, PenaltyKind.LAP].includes(kind) ||
      !Number.isInteger(amount) ||
      amount < 1 ||
      amount > (kind === PenaltyKind.TIME ? 3600000 : 100)
    ) {
      throw penaltyError('Invalid race penalty details', 400);
    }

    let result;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const session = await tx.session.findUnique({ where: { id: sessionId } });
        if (!session || session.deletedAt) throw penaltyError('Session not found', 404);
        if (
          session.type !== SessionType.RACE ||
          ![SessionStatus.ACTIVE, SessionStatus.PAUSED, SessionStatus.FINISHING, SessionStatus.FINISHED].includes(
            session.status
          )
        ) {
          throw penaltyError('Penalties require a started race', 409);
        }

        const assignment = await tx.sessionDriver.findUnique({ where: { id: sessionDriverId } });
        if (!assignment || assignment.sessionId !== sessionId || !assignment.driverId || assignment.deletedAt) {
          throw penaltyError('Driver assignment is missing or belongs to another race', 409);
        }

        const penalty = await tx.sessionPenalty.create({
          data: {
            sessionId,
            sessionDriverId,
            driverId: assignment.driverId,
            controller: assignment.controller,
            requestId,
            kind,
            amount,
            reason: reason.trim(),
          },
        });
        if (session.status === SessionStatus.FINISHED) await this.updatePenaltyPositions(tx, sessionId);
        return { penalty, championshipId: session.championshipId };
      });
    } catch (error) {
      if (error.code === 'P2002') throw penaltyError('Duplicate penalty request', 409);
      throw error;
    }

    this.penaltyChanged(sessionId, result.championshipId, result.penalty);
    return result.penalty;
  }

  async revokePenalty(sessionId, penaltyId) {
    if (typeof sessionId !== 'string' || !sessionId || typeof penaltyId !== 'string' || !penaltyId) {
      throw penaltyError('Session and penalty are required', 400);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const session = await tx.session.findUnique({ where: { id: sessionId } });
      if (!session || session.deletedAt) throw penaltyError('Session not found', 404);
      const old = await tx.sessionPenalty.findUnique({ where: { id: penaltyId } });
      if (!old || old.sessionId !== sessionId) throw penaltyError('Penalty not found for this race', 404);
      if (old.status !== PenaltyStatus.ACTIVE) throw penaltyError('Penalty was already revoked', 409);

      const penalty = await tx.sessionPenalty.update({
        where: { id: penaltyId },
        data: { status: PenaltyStatus.REVOKED, revokedAt: new Date() },
      });
      if (session.status === SessionStatus.FINISHED) await this.updatePenaltyPositions(tx, sessionId);
      return { penalty, championshipId: session.championshipId };
    });

    this.penaltyChanged(sessionId, result.championshipId, result.penalty);
    return result.penalty;
  }

  // As with VSC writes, state-changing operations must not race a deadline.
  queueDamage(action) {
    const result = this.damageOperation.then(action);
    this.damageOperation = result.catch(() => {});
    return result;
  }

  raceClock(now = Date.now()) {
    const pauses = this.sessionConfig?.pauses || [];
    let totalPauseDuration = 0;
    let currentPauseDuration = null;
    for (const pause of pauses) {
      const duration = Math.max(0, Math.min(pause.end ?? now, now) - pause.start);
      totalPauseDuration += duration;
      if (pause.end === null && now >= pause.start) currentPauseDuration = duration;
    }
    const startedAt = this.sessionConfig?.startedAt;
    const elapsedTime = startedAt ? Math.max(0, now - new Date(startedAt).getTime() - totalPauseDuration) : 0;
    return { pauses, totalPauseDuration, currentPauseDuration, elapsedTime };
  }

  async triggerDamage(driver, lapTime) {
    const threshold = this.sessionConfig?.damageLapThresholdMs;
    if (
      this.currentPhase !== SessionType.RACE ||
      this.sessionStatus !== SessionStatus.ACTIVE ||
      !this.sessionConfig?.startedAt ||
      threshold == null ||
      lapTime <= threshold ||
      (driver.damageStatus && driver.damageStatus !== DamageStatus.NONE)
    )
      return;

    const sessionId = this.activeSessionId;
    return this.queueDamage(async () => {
      if (
        sessionId !== this.activeSessionId ||
        this.sessionStatus !== SessionStatus.ACTIVE ||
        (driver.damageStatus && driver.damageStatus !== DamageStatus.NONE)
      )
        return;

      const now = Date.now();
      const data = {
        damageStatus: DamageStatus.ACTIVE,
        damageLapNumber: driver.totalLaps,
        damageTriggeredAt: new Date(now),
        damageDeadlineElapsedMs: this.raceClock(now).elapsedTime + this.sessionConfig.damageRepairSeconds * 1000,
      };
      await this.prisma.sessionDriver.update({ where: { id: driver.id }, data });
      Object.assign(driver, data);
      this.emit('session:damage_changed', {
        sessionId,
        sessionDriverId: driver.id,
        controller: driver.controller,
        ...data,
      });
    });
  }

  async expireDamage(force = false) {
    if (
      !this.activeSessionId ||
      this.currentPhase !== SessionType.RACE ||
      (!force && ![SessionStatus.ACTIVE, SessionStatus.FINISHING].includes(this.sessionStatus))
    )
      return;

    return this.queueDamage(async () => {
      const elapsed = this.raceClock().elapsedTime;
      let changed = false;
      for (const driver of this.sessionDrivers) {
        if (driver.damageStatus !== DamageStatus.ACTIVE || (!force && elapsed < driver.damageDeadlineElapsedMs))
          continue;

        await this.prisma.sessionDriver.update({
          where: { id: driver.id },
          data: { damageStatus: DamageStatus.DNF, isDNF: true },
        });
        driver.damageStatus = DamageStatus.DNF;
        driver.isDNF = true;
        changed = true;
        this.emit('session:damage_changed', {
          sessionId: this.activeSessionId,
          sessionDriverId: driver.id,
          controller: driver.controller,
          damageStatus: DamageStatus.DNF,
        });
      }
      if (changed) this.emitLeaderboard();
    });
  }

  confirmDamageRepair(sessionId, sessionDriverId, pitStopId) {
    return this.queueDamage(async () => {
      if (
        sessionId !== this.activeSessionId ||
        this.currentPhase !== SessionType.RACE ||
        ![SessionStatus.ACTIVE, SessionStatus.PAUSED, SessionStatus.FINISHING].includes(this.sessionStatus)
      ) {
        throw Object.assign(new Error('Race is not available for repair confirmation'), { status: 409 });
      }
      const driver = this.sessionDrivers.find((row) => row.id === sessionDriverId);
      if (driver?.damageStatus !== DamageStatus.ACTIVE) {
        throw Object.assign(new Error('Driver has no repairable damage'), { status: 409 });
      }
      if (this.raceClock().elapsedTime >= driver.damageDeadlineElapsedMs) {
        throw Object.assign(new Error('Repair deadline has passed'), { status: 409 });
      }
      const pitStop = await this.prisma.pitStop.findUnique({ where: { id: pitStopId } });
      if (
        !pitStop ||
        pitStop.sessionId !== sessionId ||
        pitStop.sessionDriverId !== driver.id ||
        pitStop.controller !== driver.controller ||
        pitStop.source !== 'cu' ||
        pitStop.durationMs < this.sessionConfig.damagePitSeconds * 1000 ||
        new Date(pitStop.enteredAt).getTime() < new Date(driver.damageTriggeredAt).getTime() ||
        this.raceClock(new Date(pitStop.exitedAt).getTime()).elapsedTime >= driver.damageDeadlineElapsedMs
      ) {
        throw Object.assign(new Error('No eligible observed pit interval for this repair'), { status: 409 });
      }

      const data = {
        damageStatus: DamageStatus.REPAIRED,
        damageRepairedAt: new Date(),
        damageRepairPitStopId: pitStop.id,
        damageRepairSource: 'director',
      };
      await this.prisma.sessionDriver.update({ where: { id: driver.id }, data });
      Object.assign(driver, data);
      this.emit('session:damage_changed', {
        sessionId,
        sessionDriverId,
        controller: driver.controller,
        ...data,
      });
      this.emitLeaderboard();
      return data;
    });
  }

  getDriverByController(controller) {
    return this.sessionDrivers.find((d) => d.controller === controller);
  }

  getSessionBestLapTime() {
    const times = this.sessionDrivers.map((d) => d.bestLapTime).filter((t) => t && t > 0);
    return times.length > 0 ? Math.min(...times) : null;
  }

  recalculatePositions(lapController = null) {
    if (this.sessionDrivers.length === 0) return;

    const isRace = this.currentPhase === SessionType.RACE;

    if (isRace) {
      for (const driver of this.sessionDrivers) {
        const { penaltyLaps, penaltyTimeMs, classifiedLaps, classifiedTime, classifiedSimulatedTime } =
          withRacePenalties(driver, this.sessionPenalties);
        Object.assign(driver, { penaltyLaps, penaltyTimeMs, classifiedLaps, classifiedTime, classifiedSimulatedTime });
      }
      this.sessionDrivers.sort(compareRaceClassification);
    } else {
      this.sessionDrivers.sort((a, b) => {
        if (a.bestLapTime === null && b.bestLapTime === null) return 0;
        if (a.bestLapTime === null) return 1;
        if (b.bestLapTime === null) return -1;
        return a.bestLapTime - b.bestLapTime;
      });
    }

    const leader = this.sessionDrivers[0];

    for (let i = 0; i < this.sessionDrivers.length; i++) {
      const driver = this.sessionDrivers[i];
      const newPosition = i + 1;
      const previousPosition = this.previousPositions.get(driver.controller);

      if (previousPosition !== undefined && previousPosition !== newPosition) {
        // Position changed - update delta for this driver
        this.displayedDeltas.set(driver.controller, previousPosition - newPosition);
      } else if (driver.controller === lapController) {
        // This driver just completed a lap but position didn't change - clear their delta
        this.displayedDeltas.set(driver.controller, 0);
      }
      // Other drivers with no position change keep their existing delta

      // Get displayed delta
      driver.positionDelta = this.displayedDeltas.get(driver.controller) || 0;

      // Update position
      driver.position = newPosition;

      // Store current position for next comparison
      this.previousPositions.set(driver.controller, newPosition);

      if (i === 0) {
        driver.gap = null;
      } else if (isRace) {
        const lapDiff = leader.classifiedLaps - driver.classifiedLaps;
        if (lapDiff > 0) {
          driver.gap = lapDiff;
        } else {
          driver.gap = driver.classifiedSimulatedTime - leader.classifiedSimulatedTime;
        }
      } else {
        if (leader.bestLapTime && driver.bestLapTime) {
          driver.gap = driver.bestLapTime - leader.bestLapTime;
        } else {
          driver.gap = null;
        }
      }
    }
  }

  getEnrichedLeaderboard() {
    if (this.currentPhase === SessionType.BALANCING && this.lapHistory.size > 0) {
      return this.sessionDrivers.map((d) => ({
        ...d,
        laps: this.lapHistory.get(d.controller) || [],
      }));
    }
    return this.sessionDrivers;
  }

  emitLeaderboard() {
    this.emit('session:leaderboard', this.getEnrichedLeaderboard());
  }

  /**
   * Static method to calculate gaps on drivers array
   * Used by API routes when returning session data
   */
  static calculateDriverGaps(drivers, sessionType, penalties = []) {
    if (!drivers || drivers.length === 0) return drivers;

    const isRace = sessionType === SessionType.RACE;
    const sorted = isRace
      ? rankRaceDrivers(drivers, penalties)
      : [...drivers].sort((a, b) => {
          if (a.bestLapTime === null && b.bestLapTime === null) return 0;
          if (a.bestLapTime === null) return 1;
          if (b.bestLapTime === null) return -1;
          return a.bestLapTime - b.bestLapTime;
        });

    const leader = sorted[0];
    return sorted.map((driver, i) => {
      let gap = null;
      if (i > 0 && leader) {
        if (isRace) {
          const lapDiff = leader.classifiedLaps - driver.classifiedLaps;
          gap = lapDiff > 0 ? lapDiff : driver.classifiedSimulatedTime - leader.classifiedSimulatedTime;
        } else {
          if (leader.bestLapTime && driver.bestLapTime) {
            gap = driver.bestLapTime - leader.bestLapTime;
          }
        }
      }
      return { ...driver, gap, position: i + 1 };
    });
  }

  // ==================== Heartbeat ====================

  startHeartbeat() {
    this.stopHeartbeat();

    this.heartbeatInterval = setInterval(async () => {
      if (!this.activeSessionId || !this.isActive()) {
        this.stopHeartbeat();
        return;
      }

      const now = Date.now();

      const { pauses, totalPauseDuration, currentPauseDuration, elapsedTime } = this.raceClock(now);
      try {
        await this.expireDamage();
      } catch (error) {
        console.error('[SessionService] Damage deadline update failed:', error);
        this.emit('session:damage_error', { sessionId: this.activeSessionId, error: error.message });
      }

      let remainingTime = null;
      if (this.sessionConfig?.maxDuration) {
        remainingTime = Math.max(0, this.sessionConfig.maxDuration - elapsedTime);

        // Time is up
        if (remainingTime === 0 && this.sessionStatus === SessionStatus.ACTIVE) {
          if (this.currentPhase === SessionType.BALANCING) {
            // Balancing: stop immediately, no grace period
            await this.finishSession('time_elapsed');
          } else {
            // Race: checkered flag + grace period
            await this.startFinishingPhase('time_elapsed');
          }
        }
      }

      let remainingLaps = null;
      if (this.sessionConfig?.maxLaps) {
        const leaderLaps = Math.max(...this.sessionDrivers.map((d) => d.totalLaps), 0);
        remainingLaps = Math.max(0, this.sessionConfig.maxLaps - leaderLaps);
      }

      let gracePeriodRemaining = null;
      if (this.sessionStatus === SessionStatus.FINISHING && this.gracePeriodEndsAt) {
        gracePeriodRemaining = Math.max(0, this.gracePeriodEndsAt - Date.now());
        // Check if all drivers finished their lap during finishing phase
        await this.checkSessionComplete();
      }

      // Weather uses the race clock or wall clock, depending on the session setting.
      const weatherElapsed =
        this.sessionConfig?.weatherAdvanceDuringPause && this.sessionConfig.startedAt
          ? now - new Date(this.sessionConfig.startedAt).getTime()
          : elapsedTime;
      const weatherCondition = this.sessionConfig ? weatherAtElapsed(this.sessionConfig, weatherElapsed) : null;
      if (this.activeSessionId && weatherCondition !== this.lastWeatherCondition) {
        this.lastWeatherCondition = weatherCondition;
        this.emit('session:weather_changed', {
          sessionId: this.activeSessionId,
          weatherCondition,
          elapsedTime,
        });
      }

      this.emit('session:heartbeat', {
        sessionId: this.activeSessionId,
        weatherCondition,
        status: this.sessionStatus,
        startedAt: this.sessionConfig?.startedAt,
        elapsedTime,
        remainingTime,
        remainingLaps,
        gracePeriodRemaining,
        pauseDuration: currentPauseDuration,
        totalPauseDuration,
        pauses,
        leaderboard: this.getEnrichedLeaderboard(),
      });
    }, 1000);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  // ==================== Session Completion ====================

  async checkSessionComplete() {
    if (!this.activeSessionId || !this.sessionConfig) return;
    if (this.sessionStatus !== SessionStatus.ACTIVE && this.sessionStatus !== SessionStatus.FINISHING) return;

    const { maxLaps } = this.sessionConfig;

    let shouldStop = false;
    let shouldStartFinishing = false;
    let reason = '';

    // Note: time-based finishing is now handled in heartbeat

    // Check lap limit
    if (maxLaps && this.sessionStatus === SessionStatus.ACTIVE) {
      if (this.currentPhase === SessionType.BALANCING) {
        // Balancing: finish when all active controllers reached maxLaps
        const activeDrivers = this.sessionDrivers.filter((d) => d.totalLaps > 0);
        if (activeDrivers.length > 0 && activeDrivers.every((d) => d.totalLaps >= maxLaps)) {
          shouldStop = true;
          reason = 'all_finished';
        }
      } else {
        // Race: checkered flag when leader reaches maxLaps
        const maxLapsReached = this.sessionDrivers.some((d) => d.totalLaps >= maxLaps);
        if (maxLapsReached) {
          shouldStartFinishing = true;
          reason = 'leader_finished';
        }
      }
    }

    // Checkered flag logic: check if all drivers finished
    if (this.sessionStatus === SessionStatus.FINISHING) {
      const allFinished = this.checkAllDriversFinished();
      if (allFinished) {
        shouldStop = true;
        reason = 'all_finished';
      }
    }

    if (shouldStartFinishing && !shouldStop) {
      await this.startFinishingPhase(reason);
    }

    if (shouldStop) {
      await this.finishSession(reason);
    }
  }

  /**
   * Check if all active drivers have finished
   * - Lap-based race: all must reach maxLaps
   * - Time-based race: all must complete their current lap (lapsAtFinishing + 1)
   */
  checkAllDriversFinished() {
    const maxLaps = this.sessionConfig?.maxLaps;

    const activeDrivers = this.sessionDrivers.filter((d) => {
      // Driver was active at checkered flag if they had completed at least 1 lap
      return d.lapsAtFinishing !== null && d.lapsAtFinishing !== undefined && d.lapsAtFinishing > 0;
    });

    if (activeDrivers.length === 0) {
      // No active drivers, finish immediately
      return true;
    }

    if (maxLaps) {
      // Lap-based race: all must reach maxLaps
      return activeDrivers.every((d) => d.totalLaps >= maxLaps);
    } else {
      // Time-based race: all must complete their current lap
      return activeDrivers.every((d) => d.totalLaps > d.lapsAtFinishing);
    }
  }

  async startFinishingPhase(reason) {
    await this.prisma.session.update({
      where: { id: this.activeSessionId },
      data: { status: SessionStatus.FINISHING, finishingAt: new Date() },
    });

    const previousStatus = this.sessionStatus;
    this.sessionStatus = 'finishing';

    // Snapshot laps for checkered flag logic (finish current lap)
    for (const driver of this.sessionDrivers) {
      driver.lapsAtFinishing = driver.totalLaps; // RAM state
      await this.prisma.sessionDriver.update({
        where: { id: driver.id },
        data: { lapsAtFinishing: driver.totalLaps },
      });
    }

    const gracePeriod = this.sessionConfig.gracePeriod || DEFAULT_GRACE_PERIOD_MS;
    this.gracePeriodEndsAt = Date.now() + gracePeriod;

    this.emit('session:finishing', {
      sessionId: this.activeSessionId,
      reason,
      gracePeriodMs: gracePeriod,
      endsAt: new Date(Date.now() + gracePeriod).toISOString(),
    });

    this.emitStatusChanged('finishing', previousStatus);

    // Auto-finish after grace period
    this.gracePeriodTimer = setTimeout(async () => {
      if (this.sessionStatus === SessionStatus.FINISHING) {
        await this.finishSession('grace_period_elapsed');
      }
    }, gracePeriod);
  }

  async finishSession(reason) {
    // Guard against multiple concurrent/repeated calls (grace timer + heartbeat + lap event)
    if (this.sessionStatus === SessionStatus.FINISHED || this._finishing) return;
    this._finishing = true;

    if (this.gracePeriodTimer) {
      clearTimeout(this.gracePeriodTimer);
      this.gracePeriodTimer = null;
    }

    const sessionId = this.activeSessionId;
    const previousStatus = this.sessionStatus;
    const championshipId = this.sessionConfig?.championshipId;

    // Unrepaired damage at race end is DNF, independently of the finish conditions.
    await this.expireDamage(true);
    // Calculate DNF, then sort the finished result using the persisted penalties.
    await this.calculateDNF();
    this.recalculatePositions();

    // Save final positions
    await this.prisma.$transaction([
      ...this.sessionDrivers.map((driver) =>
        this.prisma.sessionDriver.update({
          where: { id: driver.id },
          data: {
            finalPos: driver.position,
            totalLaps: driver.totalLaps,
            totalTime: driver.totalTime,
            bestLapTime: driver.bestLapTime,
            lastLapTime: driver.lastLapTime,
          },
        })
      ),
      this.prisma.session.update({
        where: { id: sessionId },
        data: { status: SessionStatus.FINISHED, finishedAt: new Date() },
      }),
    ]);

    // Broadcast to clients with final leaderboard
    const finishEvent = {
      sessionId,
      reason,
      championshipId,
      sessionType: this.currentPhase,
      startedAt: this.sessionConfig?.startedAt,
      weatherCondition: weatherForSession(this.sessionConfig, Date.now()),
      leaderboard: this.getEnrichedLeaderboard(),
    };
    this.emit('session:finished', finishEvent);
    super.emit('soundboardAutoEvent', { type: 'finished', data: finishEvent });
    this.emitStatusChanged('finished', previousStatus);

    // Emit internal event for other services (ChampionshipManager)
    super.emit('sessionFinished', { sessionId, championshipId });

    // Stop CU/Simulator
    await this.syncService?.stopRace();

    // Reset state
    await this.resetForNewSession();
    this._finishing = false;
  }

  /**
   * Apply car profile to CU for all 6 controller slots.
   * Used at session start (initial config) and at session end (restore after throttle/stop).
   * Car values are 0-100. CU usable range is 1-10 for speed/brake (factory default = 10),
   * 1-15 for fuel (factory default = 7). Slots without a driver get factory defaults.
   */
  async applyCarConfigs() {
    const device = this.syncService?.getDevice();
    if (!device?.setSpeed) return; // The simulator does not program physical car decoders.
    if (!device.setBrake || !device.setFuel) {
      throw new Error('Connected device does not support speed, brake and fuel programming');
    }

    const missingCar = this.sessionDrivers.find((driver) => driver.carId && !driver.car);
    if (missingCar) {
      throw new Error(`Car ${missingCar.carId} not found for controller ${missingCar.controller + 1}`);
    }

    const driverByController = new Map(this.sessionDrivers.map((driver) => [driver.controller, driver]));

    for (let addr = 0; addr < 6; addr++) {
      const driver = driverByController.get(addr);
      if (!driver?.carId) continue;
      const car = driver.car;
      const speed = toLevel(car.maxSpeed);
      const brake = toLevel(car.brakeForce);
      const fuel = toLevel(car.fuelCapacity);

      let field = 'speed';
      try {
        await this.writeRaceSpeed(addr, speed);
        field = 'brake';
        await device.setBrake(addr, brake);
        field = 'fuel';
        await device.setFuel(addr, fuel);
      } catch (error) {
        throw new Error(`CU ${field} programming failed for controller ${addr + 1}: ${error.message}`, {
          cause: error,
        });
      }
      if (driver) driver._throttled = false;
      console.info(
        `[SessionService] CU command acknowledged: controller=${addr + 1}, car=${car.id}, speed=${speed}, brake=${brake}, fuel=${fuel}`
      );
    }
  }
  // Serialize speed writes from first-crossing tuning, finish throttling and VSC.
  // Hardware acknowledgments are not a physical decoder readback.
  writeRaceSpeed(controller, level) {
    const device = this.syncService?.getDevice();
    const write = this.speedWrites.then(async () => {
      if (!Number.isInteger(controller) || controller < 0 || controller > 5) {
        throw new Error(`Controller ${controller} is not a human CU slot`);
      }
      if (!device?.setSpeed || this.syncService?.isConnected?.() === false) {
        throw new Error('CU speed programming unavailable');
      }
      if (this.vsc && this.syncService?.getDevice() !== this.vsc.device) {
        throw new Error('CU device changed while VSC settings are pending');
      }
      const cap = this.vsc && ['activating', 'active'].includes(this.vsc.status) ? this.vsc.cap : null;
      await device.setSpeed(controller, cap === null ? level : Math.min(level, cap));
    });
    this.speedWrites = write.catch(() => {});
    return write;
  }

  getVscState() {
    if (!this.vsc) return { status: 'inactive', active: false };
    const { sessionId, cap, expiresAt, status: vscStatus, error } = this.vsc;
    return { sessionId, cap, expiresAt, status: vscStatus, active: vscStatus === 'active', error };
  }

  // A single queue serializes manual activation, timer expiry and cleanup.
  queueVsc(action) {
    const result = this.vscOperation.then(action);
    this.vscOperation = result.catch(() => {});
    return result;
  }

  startVsc(cap, durationSeconds = 0) {
    return this.queueVsc(async () => {
      if (
        !Number.isInteger(cap) ||
        cap < 1 ||
        cap > 10 ||
        !Number.isInteger(durationSeconds) ||
        durationSeconds < 0 ||
        durationSeconds > 3600 ||
        (durationSeconds > 0 && durationSeconds < 5)
      ) {
        throw new Error('VSC speed must be 1-10; duration must be 0 or 5-3600 seconds');
      }
      if (this.vsc) {
        if (this.getVscState().active) return this.getVscState();
        throw new Error('VSC restoration is pending');
      }
      if (
        !this.activeSessionId ||
        this.sessionStatus !== SessionStatus.ACTIVE ||
        this.currentPhase !== SessionType.RACE ||
        this.syncService?.getCuStatus?.()?.start !== 0
      ) {
        throw new Error('VSC requires a race running on the CU (not the start lights)');
      }
      const device = this.syncService?.getDevice();
      if (!this.syncService?.isConnected() || !device?.setSpeed) {
        throw new Error('Connected CU does not support VSC speed programming');
      }

      const drivers = this.sessionDrivers.filter(
        (driver) => driver.carId && driver.car && !this.hasDriverFinished(driver) && !driver._throttled
      );
      const baseline = new Map(
        drivers.map((driver) => [
          driver.controller,
          {
            id: driver.id,
            carId: driver.carId,
            speed: toLevel(driver.car.maxSpeed),
          },
        ])
      );
      if (baseline.size !== drivers.length || baseline.size === 0) {
        throw new Error('No distinct assigned cars available for VSC');
      }

      const vsc = {
        sessionId: this.activeSessionId,
        device,
        baseline,
        cap,
        status: 'activating',
        expiresAt: durationSeconds ? new Date(Date.now() + durationSeconds * 1000).toISOString() : null,
        error: null,
        timer: null,
      };
      this.vsc = vsc;
      try {
        for (const [controller, config] of baseline) {
          await this.writeRaceSpeed(controller, config.speed);
        }
        if (!this.syncService?.isConnected() || vsc.status === 'disconnected') {
          throw new Error('CU disconnected during VSC activation');
        }
      } catch (error) {
        try {
          await this.restoreVscBaseline(true);
          this.vsc = null;
        } catch (restoreError) {
          vsc.status = 'restore_failed';
          vsc.error = restoreError.message;
          this.emit('session:vsc_error', this.getVscState());
        }
        throw new Error(`VSC could not limit all cars: ${error.message}`, { cause: error });
      }

      vsc.status = 'active';
      if (durationSeconds) {
        vsc.timer = setTimeout(() => {
          this.endVsc(false, vsc).catch((error) =>
            console.error('[SessionService] Timed VSC restoration failed:', error.message)
          );
        }, durationSeconds * 1000);
      }
      this.emit('session:vsc', this.getVscState());
      return this.getVscState();
    });
  }

  async restoreVscBaseline(cleanup) {
    const vsc = this.vsc;
    if (!vsc) return;
    vsc.status = 'restoring';
    if (!this.syncService?.isConnected() || this.syncService.getDevice() !== vsc.device) {
      throw new Error('Cannot restore VSC speeds while the original CU is disconnected');
    }

    const failures = [];
    for (const [controller, config] of vsc.baseline) {
      const driver = this.getDriverByController(controller);
      if (driver?.id !== config.id || driver.carId !== config.carId) {
        failures.push(`controller ${controller + 1}: vehicle assignment changed`);
        continue;
      }
      const speed = !cleanup && (driver._throttled || this.hasDriverFinished(driver)) ? 1 : config.speed;
      try {
        await this.writeRaceSpeed(controller, speed);
      } catch (error) {
        failures.push(`controller ${controller + 1}: ${error.message}`);
      }
    }
    if (failures.length) throw new Error(failures.join('; '));
  }

  endVsc(cleanup = false, expected = null) {
    return this.queueVsc(async () => {
      const vsc = this.vsc;
      if (!vsc || (expected && vsc !== expected)) return this.getVscState();
      if (vsc.timer) clearTimeout(vsc.timer);
      vsc.timer = null;
      try {
        await this.restoreVscBaseline(cleanup);
        this.vsc = null;
        this.emit('session:vsc', this.getVscState());
        return this.getVscState();
      } catch (error) {
        vsc.status = 'restore_failed';
        vsc.error = error.message;
        this.emit('session:vsc_error', this.getVscState());
        throw error;
      }
    });
  }

  onVscDisconnect() {
    if (!this.vsc) return;
    if (this.vsc.timer) clearTimeout(this.vsc.timer);
    this.vsc.timer = null;
    this.vsc.status = 'disconnected';
    this.vsc.error = 'CU disconnected before VSC speeds could be verified or restored';
    this.emit('session:vsc_error', this.getVscState());
  }

  async calculateDNF() {
    const maxLaps = this.sessionConfig?.maxLaps;

    for (const driver of this.sessionDrivers) {
      const sd = await this.prisma.sessionDriver.findUnique({
        where: { id: driver.id },
      });

      if (sd?.lapsAtFinishing !== null && sd.lapsAtFinishing > 0) {
        // Lap-based race: DNF if didn't reach maxLaps; time-based: DNF if didn't finish current lap
        const isDNF = maxLaps ? driver.totalLaps < maxLaps : driver.totalLaps === sd.lapsAtFinishing;

        if (isDNF) {
          driver.isDNF = true;
          await this.prisma.sessionDriver.update({
            where: { id: driver.id },
            data: { isDNF: true },
          });
        }
      }
    }
  }

  // ==================== DB Operations ====================

  async saveLap(driver, lapTime, simulatedLapTime = null, weatherAtLap = null) {
    const sessionId = this.activeSessionId;
    const data = {
      sessionId,
      trackId: this.activeTrackId,
      driverId: driver.driverId,
      carId: driver.carId,
      controller: driver.controller,
      phase: this.currentPhase,
      lapNumber: driver.totalLaps,
      lapTime,
      simulatedLapTime,
      tyreAtLap: simulatedLapTime !== null ? driver.tyreType : null,
      weatherAtLap,
    };

    const rate = this.sessionConfig?.virtualFuelRate;
    if (rate == null) {
      await this.prisma.lap.create({ data });
      return;
    }

    const write = this.virtualFuelWrites.then(async () => {
      const event = await this.prisma.$transaction(async (tx) => {
        const lap = await tx.lap.create({ data });
        return tx.virtualFuelEvent.create({
          data: {
            sessionId,
            sessionDriverId: driver.id,
            controller: driver.controller,
            kind: 'lap',
            units: virtualFuelBurn(lapTime, rate),
            source: 'lap',
            reference: `lap:${lap.id}`,
          },
        });
      });
      if (this.activeSessionId === sessionId) {
        driver.virtualFuelUnits = virtualFuelAfter(driver.virtualFuelUnits ?? VIRTUAL_FUEL_FULL, event);
      }
    });
    this.virtualFuelWrites = write.catch(() => {});
    await write;
  }

  async updateSessionDriver(driver) {
    await this.prisma.sessionDriver.update({
      where: { id: driver.id },
      data: {
        position: driver.position,
        totalLaps: driver.totalLaps,
        totalTime: driver.totalTime,
        simulatedTotalTime: driver.simulatedTotalTime,
        simulatedBestLapTime: driver.simulatedBestLapTime,
        bestLapTime: driver.bestLapTime,
        lastLapTime: driver.lastLapTime,
      },
    });
  }

  // ==================== Session Operations ====================

  /**
   * Create a session with drivers from track's controller config
   * @param {Object} params - { type, name, trackId, championshipId, maxDuration, maxLaps, order, gridFromQualifying }
   */
  async createSession(params) {
    const {
      type,
      name,
      trackId,
      championshipId,
      maxDuration,
      maxLaps,
      order,
      gridFromQualifying,
      status: initialStatus,
      weatherSeed = null,
      weatherInitial = WeatherCondition.DRY,
      weatherRainChance = 35,
      weatherIntervalSeconds = 60,
      weatherAdvanceDuringPause = false,
      tyreMismatchPercent = 0,
      virtualFuelRate = null,
      damageLapThresholdMs = null,
      damageRepairSeconds = 60,
      damagePitSeconds = 5,
    } = params;

    if (
      !validWeatherConfig({
        weatherSeed,
        weatherInitial,
        weatherRainChance,
        weatherIntervalSeconds,
        weatherAdvanceDuringPause,
      })
    ) {
      throw new Error('Invalid weather configuration');
    }
    if (!validTyreMismatchPercent(tyreMismatchPercent) || (tyreMismatchPercent > 0 && weatherSeed === null)) {
      throw new Error('Tyre time penalty requires enabled weather and 0-30 percent');
    }
    if (weatherSeed !== null && type !== SessionType.RACE) {
      throw new Error('Weather is only supported for race sessions');
    }

    if (!validVirtualFuelRate(virtualFuelRate)) {
      throw new Error('Virtual fuel rate must be 1-100 percent per minute or disabled');
    }

    if (!isSessionType(type)) {
      throw new Error(`Invalid session type. Must be one of: ${SESSION_TYPES.join(', ')}`);
    }
    if (
      !validDamageConfig({ damageLapThresholdMs, damageRepairSeconds, damagePitSeconds }) ||
      (damageLapThresholdMs !== null && type !== SessionType.RACE)
    ) {
      throw new Error('Invalid race damage configuration');
    }

    // Resolve trackId from championship if needed
    let finalTrackId = trackId;
    if (championshipId && !trackId) {
      const championship = await this.prisma.championship.findUnique({ where: { id: championshipId } });
      if (!championship?.trackId) {
        throw new Error('Championship has no track assigned');
      }
      finalTrackId = championship.trackId;
    }

    if (!finalTrackId) {
      throw new Error('trackId or championshipId required');
    }

    if (RUNNING_STATUSES.includes(initialStatus)) {
      throw penaltyError('Sessions cannot be created directly in a running state', 400);
    }

    // Create session
    const session = await this.prisma.session.create({
      data: {
        name: name || sessionName(type),
        type,
        status: initialStatus || 'draft',
        trackId: finalTrackId,
        championshipId: championshipId || null,
        maxDuration: maxDuration || null,
        maxLaps: maxLaps || null,
        weatherSeed,
        weatherInitial,
        weatherRainChance,
        weatherIntervalSeconds,
        weatherAdvanceDuringPause,
        tyreMismatchPercent,
        virtualFuelRate,
        damageLapThresholdMs,
        damageRepairSeconds,
        damagePitSeconds,
        order: order ?? 0,
      },
    });

    // Get controller configs for this track
    const configs = await this.prisma.controllerConfig.findMany({
      where: { trackId: finalTrackId, controller: { gte: 0, lte: 5 } },
      include: { driver: true, car: true },
      orderBy: { controller: 'asc' },
    });

    // Get grid order from last qualifying if requested (for race)
    let gridOrder = null;
    if (type === SessionType.RACE && gridFromQualifying) {
      const lastQualifying = await this.prisma.session.findFirst({
        where: { trackId: finalTrackId, type: SessionType.QUALIF, status: SessionStatus.FINISHED, deletedAt: null },
        orderBy: { finishedAt: 'desc' },
        include: { drivers: { where: { deletedAt: null }, orderBy: { finalPos: 'asc' } } },
      });
      if (lastQualifying) {
        gridOrder = lastQualifying.drivers.map((d) => d.driverId);
      }
    }

    // Add drivers from controller config
    for (let i = 0; i < configs.length; i++) {
      const config = configs[i];
      if (config.driverId && config.carId) {
        const gridPos = gridOrder ? gridOrder.indexOf(config.driverId) + 1 || configs.length : i + 1;

        await this.prisma.sessionDriver.create({
          data: {
            sessionId: session.id,
            driverId: config.driverId,
            carId: config.carId,
            controller: config.controller,
            gridPos: type === SessionType.RACE ? gridPos : null,
          },
        });
      }
    }

    // Return full session with relations
    return await this.prisma.session.findUnique({
      where: { id: session.id },
      include: {
        track: true,
        championship: true,
        drivers: {
          include: { driver: true, car: true },
          orderBy: type === SessionType.RACE ? { gridPos: 'asc' } : { controller: 'asc' },
        },
      },
    });
  }

  /**
   * Reset session to draft state
   * - Practice: soft delete laps (for stats)
   * - Qualif/Race: hard delete laps
   */
  async resetSession(sessionId) {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (this.startingSessionId || (RUNNING_STATUSES.includes(session.status) && this.activeSessionId !== sessionId)) {
      throw penaltyError(`Session ${sessionId} must be loaded as the current session before it can be reset`, 409);
    }

    // Resetting another draft must not stop the CU used by the running session.
    if (this.activeSessionId === sessionId) {
      await this.resetForNewSession();
      await this.syncService?.stopRace();
    }

    // Soft delete laps (keep for stats)
    await this.prisma.lap.updateMany({
      where: { sessionId, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    await this.prisma.tyreChange.deleteMany({ where: { sessionId } });
    // A restarted session begins with a full virtual tank and a fresh event log.
    await this.prisma.virtualFuelEvent.deleteMany({ where: { sessionId } });
    // Keep the audit trail, but do not carry penalties into a restarted race.
    await this.prisma.sessionPenalty.updateMany({
      where: { sessionId, status: PenaltyStatus.ACTIVE },
      data: { status: PenaltyStatus.REVOKED, revokedAt: new Date() },
    });

    // Reset session driver stats
    await this.prisma.sessionDriver.updateMany({
      where: { sessionId },
      data: {
        position: null,
        finalPos: null,
        totalLaps: 0,
        totalTime: 0,
        simulatedTotalTime: null,
        simulatedBestLapTime: null,
        tyreType: TyreType.DRY,
        pendingTyreType: null,
        bestLapTime: null,
        lastLapTime: null,
        isDNF: false,
        damageStatus: DamageStatus.NONE,
        damageLapNumber: null,
        damageTriggeredAt: null,
        damageDeadlineElapsedMs: null,
        damageRepairedAt: null,
        damageRepairPitStopId: null,
        damageRepairSource: null,
        lapsAtFinishing: null,
      },
    });

    // Reset session to draft
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { status: SessionStatus.DRAFT, startedAt: null, finishingAt: null, finishedAt: null, pauses: null },
    });

    // Emit internal event for ChampionshipService
    if (session.championshipId) {
      super.emit('sessionReset', { sessionId, championshipId: session.championshipId });
    }
  }

  /**
   * Delete a session and all related data
   */
  async deleteSession(sessionId) {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Stop if this is the active session
    if (this.activeSessionId === sessionId) {
      await this.resetForNewSession();
    }

    const now = new Date();

    // Soft delete cascade: laps, session drivers, track records, session
    await this.prisma.lap.updateMany({
      where: { sessionId, deletedAt: null },
      data: { deletedAt: now },
    });
    await this.prisma.sessionDriver.updateMany({
      where: { sessionId, deletedAt: null },
      data: { deletedAt: now },
    });
    // A record stands for one lap of this session: hiding the lap hides it too
    await this.prisma.trackRecord.updateMany({
      where: { sessionId, deletedAt: null },
      data: { deletedAt: now },
    });
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { deletedAt: now },
    });

    // Emit internal event for ChampionshipService
    if (session.championshipId) {
      super.emit('sessionDeleted', { sessionId, championshipId: session.championshipId });
    }
  }

  // ==================== Emit Helpers ====================

  /**
   * Emit to WebSocket clients (shadows EventEmitter.emit)
   */
  emit(event, data) {
    this.io?.emit(event, data);
  }

  emitStatusChanged(status, previousStatus) {
    this.emit('session:status_changed', {
      sessionId: this.activeSessionId,
      championshipId: this.sessionConfig?.championshipId,
      status,
      previousStatus,
      timestamp: new Date().toISOString(),
    });
  }

  // ==================== Getters ====================

  getState() {
    return {
      activeSessionId: this.activeSessionId,
      activeTrackId: this.activeTrackId,
      currentPhase: this.currentPhase,
      sessionStatus: this.sessionStatus,
      weatherCondition: this.sessionConfig ? weatherForSession(this.sessionConfig, Date.now()) : null,
      sessionDrivers: this.sessionDrivers,
    };
  }

  getLeaderboard() {
    return this.getEnrichedLeaderboard();
  }

  isActive() {
    return ['active', 'paused', 'finishing'].includes(this.sessionStatus);
  }

  async close() {
    await this.resetForNewSession();
    await this.prisma.$disconnect();
  }
}

export default SessionService;

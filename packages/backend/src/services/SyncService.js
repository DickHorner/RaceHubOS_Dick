/**
 * SyncService - Synchronisation hardware CU/Simulator
 *
 * Responsabilite unique : formater les donnees hardware et les transmettre
 * - Ecoute CU/Simulator events
 * - Formate les donnees (calcul lapTime depuis timestamps)
 * - Emet cu:* events pour le frontend (logs/footer)
 * - Appelle SessionService pour la logique session
 */
export class SyncService {
  constructor(io) {
    this.source = null; // ControlUnit ou Simulator (set via setDevice)
    this.io = io;
    this.sessionService = null;

    // Timestamps pour calcul lapTime
    this.lastTimestamps = new Map(); // controller -> timestamp

    // CU status & polling
    this.cuStatus = null;
    this.pitStates = new Map();
    this.pitSessionId = null;
    this.pollInterval = 500;
    this.pollTimer = null;
    this.startTrace = null;
    this.startTraceSequence = 0;

    // Bound handlers for cleanup
    this._onTimer = (event) => this.handleTimerEvent(event);
    this._onStatus = (status) => this.handleStatus(status);
    this._onConnected = () => this.io?.emit('cu:connected');
    this._onDisconnected = () => {
      this.traceStart('disconnected');
      this.pitStates.clear();
      this.pitSessionId = null;
      this.sessionService?.onVscDisconnect?.();
      this.io?.emit('cu:disconnected');
    };
  }

  setSessionService(sessionService) {
    this.sessionService = sessionService;
  }

  // Opt-in, bounded backend diagnostics; never records BLE payloads or credentials.
  beginStartTrace(sessionId) {
    this.startTrace = null;
    if (process.env.RACEHUB_START_TRACE !== '1') return;
    this.startTrace = {
      id: `${process.pid}-${++this.startTraceSequence}`,
      sessionId,
      started: performance.now(),
    };
    this.traceStart('accepted', { startedAt: new Date().toISOString() });
  }

  traceStart(phase, details) {
    const trace = this.startTrace;
    if (!trace) return;
    const elapsed = performance.now() - trace.started;
    if (elapsed > 60_000) {
      phase = 'expired';
      details = undefined;
    }
    console.info('[StartTrace]', {
      traceId: trace.id,
      sessionId: trace.sessionId,
      elapsedMs: Math.round(elapsed * 1000) / 1000,
      phase,
      ...details,
    });
    if (['racing', 'failed', 'disconnected', 'device_changed', 'closed', 'expired'].includes(phase)) {
      this.startTrace = null;
    }
  }

  // ==================== Device Management ====================

  /**
   * Set active device (hot-swap support)
   * @param {ControlUnit|CarreraSimulator} device
   */
  setDevice(device) {
    if (this.source !== device) this.traceStart('device_changed');
    if (this.source && this.source !== device) this.sessionService?.onVscDisconnect?.();
    // Remove listeners from old device
    if (this.source) {
      this.stopPolling();
      this.source.off('timer', this._onTimer);
      this.source.off('status', this._onStatus);
      this.source.off('connected', this._onConnected);
      this.source.off('disconnected', this._onDisconnected);
    }

    // Clear state
    this.lastTimestamps.clear();
    this.cuStatus = null;
    this.pitStates.clear();
    this.pitSessionId = null;

    // Set new device
    this.source = device;

    if (device) {
      this.setupListeners();
    }
  }

  /**
   * Get current device
   */
  getDevice() {
    return this.source;
  }

  // ==================== Event Listeners ====================

  setupListeners() {
    if (!this.source) return;

    this.source.on('timer', this._onTimer);
    this.source.on('status', this._onStatus);
    this.source.on('connected', this._onConnected);
    this.source.on('disconnected', this._onDisconnected);
  }

  // ==================== Hardware Event Handlers ====================

  /**
   * Handle timer event from CU/Simulator
   * Format: { controller: 0-5, timestamp: ms, sector: 1-3 }
   */
  async handleTimerEvent(event) {
    const { controller, timestamp, sector } = event;
    const isFinishLine = sector === 1;

    let lapTime = 0;
    if (isFinishLine && timestamp > 0) {
      const lastTimestamp = this.lastTimestamps.get(controller) || 0;
      lapTime = lastTimestamp > 0 ? timestamp - lastTimestamp : 0;
      if (lapTime >= 0) {
        this.lastTimestamps.set(controller, timestamp);
      } else {
        lapTime = 0; // CU glitch, treat as first pass
      }
    }

    // Emit raw timer (for frontend logs/footer)
    this.io?.emit('cu:timer', { controller, timestamp, lapTime, sector, isFinishLine });

    // Only forward finish line crossings to SessionService
    if (isFinishLine && this.sessionService?.isActive()) {
      await this.sessionService.handleLap({ controller, timestamp, lapTime, sector });
    }
  }

  /**
   * Handle status event from CU
   */
  handleStatus(status) {
    if (status?.start !== this.cuStatus?.start) {
      this.traceStart('status', { start: status?.start });
    }
    const wasInLights = this.isInLightsSequence(this.cuStatus);
    const isInLights = this.isInLightsSequence(status);
    const isNowRacing = status?.start === 0;
    const wasNotRacing = this.cuStatus?.start !== 0;

    const wasNotInLights = !wasInLights;
    const isFirstLight = status?.start === 1;

    this.cuStatus = status;
    this.io?.emit('cu:status', status);
    this.handlePitStatus(status);

    // Reset CU when entering 1/5 lights (clean slate before race)
    if (isFirstLight && wasNotInLights) {
      this.traceStart('reset:lights');
      this.reset({ timerOnly: true });
    }

    // Detect transition to racing (GO!) - start the timer
    if (isNowRacing && wasNotRacing && wasInLights) {
      this.traceStart('racing');
      this.sessionService?.onRaceStart();
    }

    // Adaptive polling: faster during lights sequence
    if (isInLights && !wasInLights) {
      this.setPollInterval(100);
    } else if (!isInLights && wasInLights) {
      this.setPollInterval(500);
    }
  }

  /**
   * Only confirmed changes in the CU pit bitmask form an observed pit stop.
   * Two consecutive polls must agree; a pre-existing pit flag is not an entry.
   */
  handlePitStatus(status) {
    const session = this.sessionService;
    const sessionId = session?.activeSessionId;
    if (
      !sessionId ||
      session.sessionStatus !== 'active' ||
      status?.start !== 0 ||
      (status.mode & 0x4) === 0 ||
      !Array.isArray(status.pit)
    ) {
      this.pitStates.clear();
      this.pitSessionId = null;
      return;
    }

    if (this.pitSessionId !== sessionId) {
      this.pitStates.clear();
      this.pitSessionId = sessionId;
    }

    const now = Date.now();
    for (let controller = 0; controller < 6; controller++) {
      const inPit = status.pit[controller];
      if (typeof inPit !== 'boolean') continue;

      let state = this.pitStates.get(controller);
      if (!state) {
        this.pitStates.set(controller, {
          confirmed: inPit,
          candidate: inPit,
          count: 1,
          changedAt: now,
          enteredAt: null,
        });
        continue;
      }

      if (state.candidate !== inPit) {
        state.candidate = inPit;
        state.count = 1;
        state.changedAt = now;
        continue;
      }

      if (state.count < 2) state.count++;
      if (state.count < 2 || state.confirmed === inPit) continue;

      state.confirmed = inPit;
      if (inPit) {
        state.enteredAt = state.changedAt;
      } else if (state.enteredAt !== null) {
        const enteredAt = new Date(state.enteredAt);
        const exitedAt = new Date(state.changedAt);
        state.enteredAt = null;
        Promise.resolve(
          session.recordPitStop({
            controller,
            enteredAt,
            exitedAt,
            source: status.source === 'simulator' ? 'simulator' : 'cu',
          })
        ).catch((error) => {
          console.error('[SyncService] Pit stop persistence failed:', error);
          this.io?.emit('session:pit_error', { sessionId, controller, error: error.message });
        });
      }
    }
  }

  isInLightsSequence(status) {
    if (!status) return false;
    return status.start >= 1 && status.start <= 7;
  }

  // ==================== Polling ====================

  setPollInterval(ms) {
    if (this.pollInterval === ms) return;
    this.pollInterval = ms;

    if (this.pollTimer) {
      this.stopPolling();
      this.startPolling();
    }
  }

  startPolling() {
    if (this.pollTimer || !this.source) return;

    const poll = async () => {
      try {
        if (this.source?.poll && this.source?.isConnected?.()) {
          this.traceStart('poll:begin');
          await this.source.poll();
          this.traceStart('poll:end');
        }
      } catch (error) {
        this.traceStart('poll:error');
        console.warn('[SyncService] Poll error:', error.message);
      }
      this.pollTimer = setTimeout(poll, this.pollInterval);
    };

    poll();
  }

  stopPolling() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ==================== CU Control ====================

  /**
   * Prepare race - puts CU in L1 state and waits
   */
  async prepareRace() {
    if (!this.source) return;
    if (!this.source.start) return;

    // Stop polling and wait for any in-flight poll to settle
    this.stopPolling();
    this.traceStart('wait:before_start:begin', { plannedMs: 1000 });
    await new Promise((r) => setTimeout(r, 1000));
    this.traceStart('wait:before_start:end');

    // Send START — CU will respond with 'T' ack
    this.traceStart('prepare_start:request');
    await this.source.start();
    this.traceStart('prepare_start:ack');
    // Wait for CU to process and discard stale BLE responses
    this.traceStart('wait:after_start:begin', { plannedMs: 1000 });
    await new Promise((r) => setTimeout(r, 1000));
    this.traceStart('wait:after_start:end');

    // Resume polling — next poll should see L1
    this.traceStart('polling:resume');
    this.startPolling();
  }

  /**
   * Start race - triggers START button (advances lights or starts countdown)
   */
  async startRace() {
    if (!this.source) return;
    if (this.source.start) {
      this.traceStart('advance_start:request');
      try {
        await this.source.start();
        this.traceStart('advance_start:ack');
      } catch (error) {
        this.traceStart('failed');
        throw error;
      }
    }
  }

  async stopRace() {
    if (!this.source) return;
    if (this.source.stopCars) {
      await this.source.stopCars();
    }
    if (this.source.pressEsc) {
      await this.source.pressEsc();
    } else if (this.source.stop) {
      await this.source.stop();
    }
  }

  async pressButton(button) {
    if (this.source?.pressButton) {
      await this.source.pressButton(button);
    }
  }

  async reset({ timerOnly = false } = {}) {
    this.lastTimestamps.clear();
    this.io?.emit('cu:reset');
    if (timerOnly && this.source?.resetTimer) {
      await this.source.resetTimer();
    } else if (this.source?.reset) {
      await this.source.reset();
    }
    if (this.source?.clearPosition) {
      await this.source.clearPosition();
    }
  }

  // ==================== Getters ====================

  getCuStatus() {
    return this.cuStatus;
  }

  isConnected() {
    return this.source?.isConnected?.() || false;
  }

  getInfo() {
    return (
      this.source?.getInfo?.() || {
        version: 'NOT CONNECTED',
        fuelMode: false,
        realMode: false,
        pitLane: false,
        lapCounter: false,
        numCars: 0,
      }
    );
  }

  getState() {
    return {
      connected: this.isConnected(),
      cuStatus: this.cuStatus,
      pollInterval: this.pollInterval,
    };
  }

  close() {
    this.traceStart('closed');
    this.stopPolling();
  }
}

export default SyncService;

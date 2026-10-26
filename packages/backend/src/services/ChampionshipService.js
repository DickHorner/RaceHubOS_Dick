import { createPrismaClient } from '../lib/prisma.js';
import { ChampionshipMode, ChampionshipStatus, SessionStatus, SessionType } from '@racehubos/shared';
import { sessionName } from '../lib/sessionNames.js';

/**
 * ChampionshipService - Championship-specific operations
 *
 * Responsibilities:
 * - Emit championship:standings_changed when standings need refresh
 * - Calculate championship standings
 */
export class ChampionshipService {
  constructor(io) {
    this.prisma = createPrismaClient();
    this.io = io;
    this.sessionService = null;
  }

  setSessionService(sessionService) {
    this.sessionService = sessionService;
  }

  // ==================== Session Creation ====================

  /**
   * Create a session in this championship
   */
  async createSession(championshipId, params) {
    const championship = await this.prisma.championship.findUnique({
      where: { id: championshipId },
    });

    if (!championship) {
      throw new Error('Championship not found');
    }

    return this.sessionService.createSession({
      ...params,
      championshipId,
      trackId: championship.trackId,
    });
  }

  // ==================== Auto Championship ====================

  /**
   * Distribute items evenly across groups using round-robin
   * e.g. 10 items, max 4 → 3 groups of [4, 3, 3] (interleaved)
   */
  distributeEvenly(items, maxPerGroup) {
    const n = items.length;
    const numGroups = Math.ceil(n / maxPerGroup);
    const groups = Array.from({ length: numGroups }, () => []);
    for (let i = 0; i < n; i++) {
      groups[i % numGroups].push(items[i]);
    }
    return groups;
  }

  /**
   * Distribute items into balanced sequential chunks
   * e.g. 10 items, max 6 → 2 groups of [5, 5] (sequential order preserved)
   */
  distributeSequential(items, maxPerGroup) {
    const n = items.length;
    const numGroups = Math.ceil(n / maxPerGroup);
    const baseSize = Math.floor(n / numGroups);
    const extra = n % numGroups;
    const groups = [];
    let offset = 0;
    for (let g = 0; g < numGroups; g++) {
      const size = baseSize + (g < extra ? 1 : 0);
      groups.push(items.slice(offset, offset + size));
      offset += size;
    }
    return groups;
  }

  /**
   * Preview a complete driver/car rotation without changing any sessions.
   * Each heat is a matching: no driver or physical car appears twice.
   */
  async previewCarRotation(championshipId, carIds) {
    const championship = await this.prisma.championship.findUnique({
      where: { id: championshipId, deletedAt: null },
      include: {
        participants: {
          where: { deletedAt: null },
          include: { driver: true },
          orderBy: { order: 'asc' },
        },
      },
    });

    if (!championship || championship.mode !== ChampionshipMode.AUTO) {
      throw new Error('Car rotation requires an automatic championship');
    }
    if (championship.status === ChampionshipStatus.FINISHED) {
      throw new Error('Finished championships cannot be rescheduled');
    }
    if (!championship.trackId || championship.participants.length < 2) {
      throw new Error('Car rotation requires a track and at least two drivers');
    }
    if (
      !Array.isArray(carIds) ||
      carIds.length < 2 ||
      carIds.length > 6 ||
      carIds.length > championship.driversPerRace ||
      carIds.some((id) => typeof id !== 'string' || !id) ||
      new Set(carIds).size !== carIds.length
    ) {
      throw new Error('Select 2 to 6 distinct cars, no more than drivers per race');
    }

    const availableCars = await this.prisma.car.findMany({
      where: { id: { in: carIds }, deletedAt: null },
      select: { id: true, brand: true, model: true },
    });
    if (availableCars.length !== carIds.length) {
      throw new Error('One or more selected cars are unavailable');
    }

    const carsById = new Map(availableCars.map((car) => [car.id, car]));
    const cars = carIds.map((id) => carsById.get(id));
    const participants = championship.participants;
    const driversOutnumberCars = participants.length >= cars.length;
    const heatSize = Math.min(participants.length, cars.length);
    const heatCount = Math.max(participants.length, cars.length);
    const races = Array.from({ length: heatCount }, (_, round) => ({
      round: round + 1,
      drivers: Array.from({ length: heatSize }, (_, controller) => {
        const participant =
          participants[driversOutnumberCars ? (round + controller) % participants.length : controller];
        const car = cars[driversOutnumberCars ? controller : (round + controller) % cars.length];
        return {
          controller,
          gridPos: controller + 1,
          driverId: participant.driverId,
          carId: car.id,
          driver: { id: participant.driverId, name: participant.driver.name },
          car,
        };
      }),
    }));

    return { participantIds: participants.map((p) => p.driverId), races };
  }

  /**
   * Replace only unstarted draft race shells; keep every qualification and
   * any race with results untouched. A stale preview must be regenerated.
   */
  async applyCarRotation(championshipId, carIds, expectedParticipantIds, sessionNames = {}) {
    const plan = await this.previewCarRotation(championshipId, carIds);
    if (
      !Array.isArray(expectedParticipantIds) ||
      JSON.stringify(expectedParticipantIds) !== JSON.stringify(plan.participantIds)
    ) {
      throw new Error('Participants changed; preview the rotation again');
    }

    const count = await this.prisma.$transaction(async (tx) => {
      const championship = await tx.championship.findUnique({
        where: { id: championshipId, deletedAt: null },
        include: {
          participants: { where: { deletedAt: null }, orderBy: { order: 'asc' } },
          sessions: { where: { deletedAt: null } },
        },
      });
      if (
        !championship ||
        championship.mode !== ChampionshipMode.AUTO ||
        championship.status === ChampionshipStatus.FINISHED ||
        JSON.stringify(championship.participants.map((p) => p.driverId)) !== JSON.stringify(plan.participantIds)
      ) {
        throw new Error('Championship changed; preview the rotation again');
      }

      const qualifications = championship.sessions.filter((session) => session.type === SessionType.QUALIF);
      if (!qualifications.length || qualifications.some((session) => session.status !== SessionStatus.FINISHED)) {
        throw new Error('Finish all qualifications before applying a car rotation');
      }

      const previousRaces = championship.sessions.filter((session) => session.type === SessionType.RACE);
      if (
        previousRaces.some(
          (race) => race.status !== SessionStatus.DRAFT || race.startedAt !== null || race.finishedAt !== null
        )
      ) {
        throw new Error('Started races cannot be replaced; edit remaining drafts individually');
      }

      const previousIds = previousRaces.map((race) => race.id);
      if (previousIds.length) {
        const withHistory = await tx.session.count({
          where: {
            id: { in: previousIds },
            OR: [
              { laps: { some: {} } },
              { pitStops: { some: {} } },
              { tyreChanges: { some: {} } },
              { virtualFuelEvents: { some: {} } },
              { penalties: { some: {} } },
              { trackRecords: { some: {} } },
            ],
          },
        });
        if (withHistory) throw new Error('Race history exists; draft sessions cannot be replaced');
        await tx.session.deleteMany({ where: { id: { in: previousIds } } });
      }

      const firstOrder =
        Math.max(
          0,
          ...championship.sessions.filter((session) => session.type !== SessionType.RACE).map((s) => s.order)
        ) + 1;
      for (let index = 0; index < plan.races.length; index++) {
        await tx.session.create({
          data: {
            name: `${sessionName(SessionType.RACE, sessionNames)} ${index + 1}`,
            type: SessionType.RACE,
            status: SessionStatus.DRAFT,
            trackId: championship.trackId,
            championshipId,
            maxDuration: championship.raceMaxDuration,
            maxLaps: championship.raceMaxLaps,
            order: firstOrder + index,
            autoGroup: index,
            drivers: {
              create: plan.races[index].drivers.map(({ controller, gridPos, driverId, carId }) => ({
                controller,
                gridPos,
                driverId,
                carId,
              })),
            },
          },
        });
      }
      return plan.races.length;
    });

    this.io?.emit('championship:races_assigned', {
      championshipId,
      timestamp: new Date().toISOString(),
    });
    return { count };
  }

  /**
   * Generate all qualif and race sessions for an auto championship
   * @param {object} [sessionNames] - names by session type, in the interface language
   */
  async generateAutoSessions(championshipId, sessionNames = {}) {
    const championship = await this.prisma.championship.findUnique({
      where: { id: championshipId, deletedAt: null },
      include: { participants: { where: { deletedAt: null }, orderBy: { order: 'asc' } } },
    });

    if (!championship || championship.mode !== ChampionshipMode.AUTO) return;

    const { participants, driversPerQualif, driversPerRace, trackId } = championship;
    if (!participants.length || !driversPerQualif || !driversPerRace || !trackId) return;

    // Delete existing draft auto-generated sessions (qualif + race only)
    await this.prisma.session.deleteMany({
      where: {
        championshipId,
        type: { in: [SessionType.QUALIF, SessionType.RACE] },
        status: SessionStatus.DRAFT,
        deletedAt: null,
      },
    });

    let sessionOrder = 1; // 0 = practice

    // Generate qualif sessions
    const qualifGroups = this.distributeEvenly(participants, driversPerQualif);
    for (let g = 0; g < qualifGroups.length; g++) {
      const group = qualifGroups[g];
      const session = await this.prisma.session.create({
        data: {
          name: `${sessionName(SessionType.QUALIF, sessionNames)} ${g + 1}`,
          type: SessionType.QUALIF,
          status: SessionStatus.DRAFT,
          trackId,
          championshipId,
          maxDuration: championship.qualifMaxDuration,
          maxLaps: championship.qualifMaxLaps,
          order: sessionOrder++,
          autoGroup: g,
        },
      });

      for (let i = 0; i < group.length; i++) {
        await this.prisma.sessionDriver.create({
          data: {
            sessionId: session.id,
            driverId: group[i].driverId,
            controller: i,
          },
        });
      }
    }

    // Generate race sessions (empty shells, filled after qualifs)
    const raceGroupCount = Math.ceil(participants.length / driversPerRace);
    for (let g = 0; g < raceGroupCount; g++) {
      await this.prisma.session.create({
        data: {
          name: `${sessionName(SessionType.RACE, sessionNames)} ${g + 1}`,
          type: SessionType.RACE,
          status: SessionStatus.DRAFT,
          trackId,
          championshipId,
          maxDuration: championship.raceMaxDuration,
          maxLaps: championship.raceMaxLaps,
          order: sessionOrder++,
          autoGroup: g,
        },
      });
    }
  }

  /**
   * Assign drivers to race sessions based on merged qualif results
   */
  async assignDriversToRaces(championshipId) {
    const championship = await this.prisma.championship.findUnique({
      where: { id: championshipId, deletedAt: null },
      include: { participants: { where: { deletedAt: null } } },
    });

    if (!championship || championship.mode !== ChampionshipMode.AUTO) return;

    // Get all finished qualif sessions with driver results
    const qualifSessions = await this.prisma.session.findMany({
      where: {
        championshipId,
        type: SessionType.QUALIF,
        status: SessionStatus.FINISHED,
        deletedAt: null,
      },
      include: {
        drivers: { where: { deletedAt: null } },
      },
    });

    // Merge: best lap per driver across all qualif sessions
    const driverBests = new Map();
    for (const session of qualifSessions) {
      for (const sd of session.drivers) {
        if (!sd.driverId) continue;
        const existing = driverBests.get(sd.driverId);
        const bestTime = sd.bestLapTime ?? Infinity;
        if (!existing || bestTime < existing.bestTime) {
          driverBests.set(sd.driverId, {
            driverId: sd.driverId,
            bestTime,
          });
        }
      }
    }

    // Include participants who didn't set a time (place at end)
    for (const p of championship.participants) {
      if (!driverBests.has(p.driverId)) {
        driverBests.set(p.driverId, {
          driverId: p.driverId,
          bestTime: Infinity,
        });
      }
    }

    // Sort by best time ascending
    const ranking = Array.from(driverBests.values()).sort((a, b) => a.bestTime - b.bestTime);

    // Get race sessions sorted by autoGroup
    const raceSessions = await this.prisma.session.findMany({
      where: {
        championshipId,
        type: SessionType.RACE,
        deletedAt: null,
      },
      orderBy: { autoGroup: 'asc' },
    });

    // Distribute ranking into balanced sequential groups (5+5 instead of 6+4, order preserved)
    const raceGroups = this.distributeSequential(ranking, championship.driversPerRace);

    for (let r = 0; r < raceSessions.length; r++) {
      const raceSession = raceSessions[r];
      const raceDrivers = raceGroups[r] || [];

      // Completed races and explicitly assigned cars are never overwritten by qualifying.
      if (raceSession.status !== SessionStatus.DRAFT) continue;
      const hasAssignedCar = await this.prisma.sessionDriver.count({
        where: { sessionId: raceSession.id, deletedAt: null, carId: { not: null } },
      });
      if (hasAssignedCar) continue;

      // Clear existing session drivers
      await this.prisma.sessionDriver.deleteMany({
        where: { sessionId: raceSession.id },
      });

      // Assign drivers
      for (let i = 0; i < raceDrivers.length; i++) {
        await this.prisma.sessionDriver.create({
          data: {
            sessionId: raceSession.id,
            driverId: raceDrivers[i].driverId,
            controller: i,
            gridPos: i + 1,
          },
        });
      }
    }

    this.io?.emit('championship:races_assigned', {
      championshipId,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Get bracket data for an auto championship
   */
  async getBracket(championshipId) {
    const championship = await this.prisma.championship.findUnique({
      where: { id: championshipId, deletedAt: null },
      include: {
        participants: {
          where: { deletedAt: null },
          include: { driver: true },
          orderBy: { order: 'asc' },
        },
      },
    });

    if (!championship || championship.mode !== ChampionshipMode.AUTO) return null;

    const sessions = await this.prisma.session.findMany({
      where: { championshipId, deletedAt: null },
      include: {
        drivers: {
          where: { deletedAt: null },
          include: { driver: true, car: true },
          orderBy: { controller: 'asc' },
        },
      },
      orderBy: { order: 'asc' },
    });

    const qualifSessions = sessions.filter((s) => s.type === SessionType.QUALIF);
    const raceSessions = sessions.filter((s) => s.type === SessionType.RACE);
    const allQualifsFinished =
      qualifSessions.length > 0 && qualifSessions.every((s) => s.status === SessionStatus.FINISHED);

    // Build merged qualif ranking if all qualifs are done
    let mergedRanking = [];
    if (allQualifsFinished) {
      const driverBests = new Map();
      for (const session of qualifSessions) {
        for (const sd of session.drivers) {
          if (!sd.driverId) continue;
          const existing = driverBests.get(sd.driverId);
          const bestTime = sd.bestLapTime ?? Infinity;
          if (!existing || bestTime < existing.bestTime) {
            driverBests.set(sd.driverId, {
              driverId: sd.driverId,
              driver: sd.driver,
              bestTime: bestTime === Infinity ? null : bestTime,
            });
          }
        }
      }
      mergedRanking = Array.from(driverBests.values())
        .sort((a, b) => (a.bestTime ?? Infinity) - (b.bestTime ?? Infinity))
        .map((entry, i) => ({ position: i + 1, ...entry }));
    }

    return {
      mode: ChampionshipMode.AUTO,
      driversPerQualif: championship.driversPerQualif,
      driversPerRace: championship.driversPerRace,
      participants: championship.participants,
      qualifGroups: qualifSessions.map((s) => ({
        sessionId: s.id,
        group: s.autoGroup,
        label: `Q${(s.autoGroup ?? 0) + 1}`,
        name: s.name,
        status: s.status,
        drivers: s.drivers,
      })),
      allQualifsFinished,
      mergedRanking,
      raceGroups: raceSessions.map((s) => ({
        sessionId: s.id,
        group: s.autoGroup,
        label: `R${(s.autoGroup ?? 0) + 1}`,
        name: s.name,
        status: s.status,
        drivers: s.drivers,
      })),
    };
  }

  // ==================== Callbacks from SessionService ====================

  /**
   * Called when a session finishes
   * Emits championship:standings_changed for frontend to refetch standings
   * For auto championships, checks if all qualifs are done to assign races
   */
  async onSessionFinished(sessionId, championshipId) {
    if (!championshipId) return;

    this.io?.emit('championship:standings_changed', {
      championshipId,
      sessionId,
      reason: 'session_finished',
      timestamp: new Date().toISOString(),
    });

    // Auto-progression: check if all qualifs finished
    const championship = await this.prisma.championship.findUnique({
      where: { id: championshipId, deletedAt: null },
      include: { sessions: { where: { deletedAt: null } } },
    });

    if (championship?.mode !== ChampionshipMode.AUTO) return;

    const finishedSession = championship.sessions.find((s) => s.id === sessionId);
    if (finishedSession?.type !== SessionType.QUALIF) return;

    const qualifSessions = championship.sessions.filter((s) => s.type === SessionType.QUALIF);
    const allFinished = qualifSessions.every((s) => s.status === SessionStatus.FINISHED);

    if (allFinished) {
      await this.assignDriversToRaces(championshipId);
    }
  }

  /**
   * Called when practice is reset or session deleted
   * For auto mode: if a qualif is reset, clear race driver assignments
   */
  async onStandingsChanged(championshipId, sessionId, reason) {
    if (!championshipId) return;

    this.io?.emit('championship:standings_changed', {
      championshipId,
      sessionId,
      reason,
      timestamp: new Date().toISOString(),
    });

    if (reason !== 'session_reset') return;

    const championship = await this.prisma.championship.findUnique({
      where: { id: championshipId, deletedAt: null },
      include: { sessions: { where: { deletedAt: null } } },
    });

    if (championship?.mode !== ChampionshipMode.AUTO) return;

    const resetSession = championship.sessions.find((s) => s.id === sessionId);
    if (resetSession?.type !== SessionType.QUALIF) return;

    // Clear race session drivers since qualif results changed
    const raceSessions = championship.sessions.filter(
      (s) => s.type === SessionType.RACE && s.status === SessionStatus.DRAFT
    );
    for (const race of raceSessions) {
      const hasAssignedCar = await this.prisma.sessionDriver.count({
        where: { sessionId: race.id, deletedAt: null, carId: { not: null } },
      });
      if (!hasAssignedCar) await this.prisma.sessionDriver.deleteMany({ where: { sessionId: race.id } });
    }

    this.io?.emit('championship:races_assigned', {
      championshipId,
      cleared: true,
      timestamp: new Date().toISOString(),
    });
  }

  // ==================== Standings ====================

  /**
   * Get championship standings (calculated from session results)
   */
  async getStandings(championshipId) {
    const championship = await this.prisma.championship.findUnique({
      where: { id: championshipId, deletedAt: null },
      include: {
        sessions: {
          where: { status: SessionStatus.FINISHED, deletedAt: null },
          include: {
            drivers: {
              where: { deletedAt: null },
              include: { driver: true },
              orderBy: { finalPos: 'asc' },
            },
          },
        },
      },
    });

    if (!championship) return null;

    // Build standings from finished sessions
    const driverPoints = new Map();

    for (const session of championship.sessions) {
      const points = this.getPointsForSession(session);

      for (const sd of session.drivers) {
        if (!sd.driverId) continue;

        const existing = driverPoints.get(sd.driverId) || {
          driverId: sd.driverId,
          driver: sd.driver,
          totalPoints: 0,
          sessions: [],
        };

        const sessionPoints = points[sd.finalPos] || 0;
        existing.totalPoints += sessionPoints;
        existing.sessions.push({
          sessionId: session.id,
          type: session.type,
          position: sd.finalPos,
          points: sessionPoints,
        });

        driverPoints.set(sd.driverId, existing);
      }
    }

    // Sort by total points descending
    const standings = Array.from(driverPoints.values())
      .sort((a, b) => b.totalPoints - a.totalPoints || a.driverId.localeCompare(b.driverId))
      .map((entry, index) => ({
        position: index + 1,
        ...entry,
      }));

    return standings;
  }

  /**
   * Get points distribution for a session type
   */
  getPointsForSession(session) {
    if (session.type !== SessionType.RACE) return {};
    // Default F1-style race points; custom point systems are not persisted.
    return { 1: 25, 2: 18, 3: 15, 4: 12, 5: 10, 6: 8, 7: 6, 8: 4, 9: 2, 10: 1 };
  }

  /**
   * Close connections
   */
  async close() {
    await this.prisma.$disconnect();
  }
}

export default ChampionshipService;

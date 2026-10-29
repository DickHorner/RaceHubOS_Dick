import express from 'express';
import SessionService from '../services/SessionService.js';
import { getReferenceDriver } from '../lib/referenceDriver.js';
import {
  SessionStatus,
  SessionType,
  validWeatherConfig,
  validTyreMismatchPercent,
  validDamageConfig,
  weatherForSession,
  validVirtualFuelRate,
  validRequiredPitStops,
  replayVirtualFuel,
  VIRTUAL_FUEL_FULL,
} from '@racehubos/shared';
import { idsFromQuery, sendWorkbook, sessionWorkbook, sessionsWorkbook } from '../lib/exportQueries.js';
import { sendCsv, worksheetTableRows } from '../lib/csvExport.js';

const router = express.Router();
let sessionService;

export function setSessionService(service) {
  sessionService = service;
}

// Helper: get prisma instance
const prisma = () => sessionService.prisma;

/**
 * GET /api/sessions
 */
router.get('/', async (req, res) => {
  try {
    const {
      status,
      championshipId,
      trackId,
      type,
      deleted,
      limit = '50',
      offset = '0',
      sortBy = 'updatedAt',
      sortOrder = 'desc',
    } = req.query;
    const where = deleted === 'true' ? { deletedAt: { not: null } } : { deletedAt: null };
    if (status && status !== 'all') where.status = status.includes(',') ? { in: status.split(',') } : status;
    if (trackId) where.trackId = trackId.includes(',') ? { in: trackId.split(',') } : trackId;
    if (type) where.type = type.includes(',') ? { in: type.split(',') } : type;
    // Filter: only sessions with a championship
    if (req.query.has_championship === 'true') {
      where.championshipId = { not: null };
    }
    // Handle championshipId=null explicitly (free sessions)
    if (championshipId) {
      const ids = championshipId.split(',');
      const hasNull = ids.includes('null');
      const realIds = ids.filter((id) => id !== 'null');
      if (hasNull && realIds.length) {
        where.OR = [{ championshipId: null }, { championshipId: { in: realIds } }];
      } else if (hasNull) {
        where.championshipId = null;
      } else {
        where.championshipId = realIds.length > 1 ? { in: realIds } : realIds[0];
      }
    }

    const parsedLimit = parseInt(limit);
    const parsedOffset = parseInt(offset);

    const computedSorts = ['track', 'championship', 'drivers', 'laps', 'duration'];
    const sortField = sortBy === 'date' ? 'createdAt' : sortBy;
    const useDbSort = !computedSorts.includes(sortField);

    const dbOrderBy = useDbSort
      ? sortField === 'track'
        ? { track: { name: sortOrder } }
        : sortField === 'championship'
          ? { championship: { name: sortOrder } }
          : { [sortField]: sortOrder }
      : undefined;

    const [allSessions, total] = await Promise.all([
      prisma().session.findMany({
        where,
        include: {
          track: true,
          championship: true,
          drivers: { where: { deletedAt: null }, include: { driver: true, car: true } },
          _count: { select: { laps: { where: { deletedAt: null } } } },
        },
        orderBy: dbOrderBy,
        ...(useDbSort ? { skip: parsedOffset, take: parsedLimit } : {}),
      }),
      prisma().session.count({ where }),
    ]);

    let sorted = allSessions;
    if (!useDbSort) {
      const dir = sortOrder === 'asc' ? 1 : -1;
      if (sortField === 'track') {
        sorted = [...allSessions].sort((a, b) => dir * (a.track?.name || '').localeCompare(b.track?.name || ''));
      } else if (sortField === 'championship') {
        sorted = [...allSessions].sort(
          (a, b) => dir * (a.championship?.name || '').localeCompare(b.championship?.name || '')
        );
      } else if (sortField === 'drivers') {
        sorted = [...allSessions].sort((a, b) => dir * ((a.drivers?.length || 0) - (b.drivers?.length || 0)));
      } else if (sortField === 'laps') {
        sorted = [...allSessions].sort((a, b) => dir * ((a._count?.laps || 0) - (b._count?.laps || 0)));
      } else if (sortField === 'duration') {
        const dur = (s) => (s.startedAt && s.finishedAt ? new Date(s.finishedAt) - new Date(s.startedAt) : 0);
        sorted = [...allSessions].sort((a, b) => dir * (dur(a) - dur(b)));
      }
    }

    const sessions = useDbSort ? sorted : sorted.slice(parsedOffset, parsedOffset + parsedLimit);

    res.json({ success: true, data: sessions, total, hasMore: parsedOffset + parsedLimit < total });
  } catch (error) {
    console.error('Error fetching sessions:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/sessions/export?ids=a,b,c
 * Excel workbook for a hand-picked set of sessions
 */
router.get('/export', async (req, res) => {
  try {
    const result = await sessionsWorkbook(prisma(), idsFromQuery(req.query.ids));
    if (!result) {
      return res.status(404).json({ success: false, error: 'No session to export' });
    }

    await sendWorkbook(res, result);
  } catch (error) {
    console.error('Error exporting sessions:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/sessions/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const session = await prisma().session.findUnique({
      where: { id: req.params.id, deletedAt: null },
      include: {
        track: true,
        championship: true,
        drivers: {
          where: { deletedAt: null },
          include: { driver: true, car: true },
          orderBy: { controller: 'asc' },
        },
        laps: {
          where: { deletedAt: null },
          include: { driver: true },
          orderBy: { timestamp: 'asc' },
        },
        pitStops: {
          include: { sessionDriver: { include: { driver: true, car: true } } },
          orderBy: { enteredAt: 'asc' },
        },
        tyreChanges: { orderBy: { changedAt: 'asc' } },
        virtualFuelEvents: { orderBy: { id: 'asc' } },
        penalties: { orderBy: { issuedAt: 'asc' } },
      },
    });

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    if (session.virtualFuelRate != null) {
      const levels = replayVirtualFuel(session.virtualFuelEvents, session.drivers);
      session.drivers = session.drivers.map((driver) => ({
        ...driver,
        virtualFuelUnits: levels.get(driver.id) ?? VIRTUAL_FUEL_FULL,
      }));
    }
    res.json({ success: true, data: { ...session, weatherCondition: weatherForSession(session, Date.now()) } });
  } catch (error) {
    console.error('Error fetching session:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/sessions/:id/export
 * Excel workbook for one session
 */
router.get('/:id/export', async (req, res) => {
  try {
    const result = await sessionWorkbook(prisma(), req.params.id);
    if (!result) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    if (req.query.format === 'csv') {
      const table = req.query.table ?? 'results';
      if (table !== 'results' && table !== 'laps') {
        return res.status(400).json({ success: false, error: 'Invalid CSV table (results or laps)' });
      }
      const heading = table === 'results' ? 'Engagements' : 'Tours';
      sendCsv(
        res,
        result.fileName.replace(/\.xlsx$/, `_${table}.csv`),
        worksheetTableRows(result.workbook.worksheets[1], heading)
      );
    } else if (req.query.format === undefined || req.query.format === 'xlsx') {
      await sendWorkbook(res, result);
    } else {
      res.status(400).json({ success: false, error: 'Invalid export format (xlsx or csv)' });
    }
  } catch (error) {
    console.error('Error exporting session:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/sessions
 * Create a standalone session (without championship)
 */
router.post('/', async (req, res) => {
  try {
    const session = await sessionService.createSession(req.body);
    res.status(201).json({ success: true, data: session });
  } catch (error) {
    console.error('Error creating session:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/sessions/:id
 */
router.put('/:id', async (req, res) => {
  try {
    const {
      name,
      type,
      trackId,
      championshipId,
      fuelMode,
      maxDuration,
      maxLaps,
      gracePeriod,
      order,
      weatherSeed,
      weatherInitial,
      weatherRainChance,
      weatherIntervalSeconds,
      weatherAdvanceDuringPause,
      tyreMismatchPercent,
      virtualFuelRate,
      requiredPitStops,
      damageLapThresholdMs,
      damageRepairSeconds,
      damagePitSeconds,
    } = req.body;

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (type !== undefined) updateData.type = type;
    if (trackId !== undefined) updateData.trackId = trackId;
    if (championshipId !== undefined) updateData.championshipId = championshipId === '' ? null : championshipId;
    if (fuelMode !== undefined) updateData.fuelMode = fuelMode;

    const weatherUpdate = {
      weatherSeed,
      weatherInitial,
      weatherRainChance,
      weatherIntervalSeconds,
      weatherAdvanceDuringPause,
    };
    const weatherKeys = Object.keys(weatherUpdate).filter((key) => weatherUpdate[key] !== undefined);
    if (weatherKeys.length || type !== undefined || tyreMismatchPercent !== undefined) {
      const current = await prisma().session.findUnique({ where: { id: req.params.id } });
      if (!current || current.deletedAt) {
        return res.status(404).json({ success: false, error: 'Session not found' });
      }
      const nextWeather = { ...current, ...Object.fromEntries(weatherKeys.map((key) => [key, weatherUpdate[key]])) };
      const nextTyrePercent = tyreMismatchPercent ?? current.tyreMismatchPercent;
      if (
        !validWeatherConfig(nextWeather) ||
        (nextWeather.weatherSeed !== null && (type ?? current.type) !== SessionType.RACE) ||
        !validTyreMismatchPercent(nextTyrePercent) ||
        (nextTyrePercent > 0 && (nextWeather.weatherSeed === null || (type ?? current.type) !== SessionType.RACE))
      ) {
        return res.status(400).json({ success: false, error: 'Invalid race weather configuration' });
      }
      if (
        current.status !== SessionStatus.DRAFT &&
        (weatherKeys.some((key) => current[key] !== nextWeather[key]) ||
          (tyreMismatchPercent !== undefined && current.tyreMismatchPercent !== nextTyrePercent))
      ) {
        return res.status(409).json({ success: false, error: 'Weather cannot be changed after race start' });
      }
      for (const key of weatherKeys) updateData[key] = nextWeather[key];
      if (tyreMismatchPercent !== undefined) updateData.tyreMismatchPercent = nextTyrePercent;
    }
    if (requiredPitStops !== undefined) {
      if (!validRequiredPitStops(requiredPitStops)) {
        return res
          .status(400)
          .json({ success: false, error: 'Required pit stops must be a whole number from 0 to 100' });
      }
      const current = await prisma().session.findUnique({ where: { id: req.params.id } });
      if (!current || current.deletedAt) return res.status(404).json({ success: false, error: 'Session not found' });
      if (current.status !== SessionStatus.DRAFT) {
        return res.status(409).json({ success: false, error: 'Required pit stops cannot change after session start' });
      }
      updateData.requiredPitStops = requiredPitStops;
    }
    if (virtualFuelRate !== undefined) {
      if (!validVirtualFuelRate(virtualFuelRate)) {
        return res.status(400).json({ success: false, error: 'Invalid virtual fuel rate (1-100 %/min or disabled)' });
      }
      const current = await prisma().session.findUnique({ where: { id: req.params.id } });
      if (!current || current.deletedAt) return res.status(404).json({ success: false, error: 'Session not found' });
      if (current.status !== SessionStatus.DRAFT && current.virtualFuelRate !== virtualFuelRate) {
        return res.status(409).json({ success: false, error: 'Virtual fuel cannot be changed after race start' });
      }
      updateData.virtualFuelRate = virtualFuelRate;
    }
    const damageUpdate = { damageLapThresholdMs, damageRepairSeconds, damagePitSeconds };
    const damageKeys = Object.keys(damageUpdate).filter((key) => damageUpdate[key] !== undefined);
    if (damageKeys.length || type !== undefined) {
      const current = await prisma().session.findUnique({ where: { id: req.params.id } });
      if (!current || current.deletedAt) {
        return res.status(404).json({ success: false, error: 'Session not found' });
      }
      const next = { ...current, ...Object.fromEntries(damageKeys.map((key) => [key, damageUpdate[key]])) };
      if (
        !validDamageConfig(next) ||
        (next.damageLapThresholdMs !== null && (type ?? current.type) !== SessionType.RACE)
      ) {
        return res.status(400).json({ success: false, error: 'Invalid race damage configuration' });
      }
      if (current.status !== SessionStatus.DRAFT && damageKeys.some((key) => current[key] !== next[key])) {
        return res.status(409).json({ success: false, error: 'Damage settings cannot change after race start' });
      }
      for (const key of damageKeys) updateData[key] = next[key];
    }
    if (maxDuration !== undefined) updateData.maxDuration = maxDuration || null;
    if (maxLaps !== undefined) updateData.maxLaps = maxLaps || null;
    if (gracePeriod !== undefined) updateData.gracePeriod = gracePeriod || null;
    if (order !== undefined) updateData.order = order;

    const session = await prisma().session.update({
      where: {
        id: req.params.id,
        ...(requiredPitStops !== undefined ? { status: SessionStatus.DRAFT, deletedAt: null } : {}),
      },
      data: updateData,
      include: {
        track: true,
        championship: true,
        drivers: { include: { driver: true, car: true } },
      },
    });

    res.json({ success: true, data: session });
  } catch (error) {
    if (error.code === 'P2025' && req.body?.requiredPitStops !== undefined) {
      return res.status(409).json({ success: false, error: 'Session changed before pit rules could be saved' });
    }
    console.error('Error updating session:', error);
    if (error.code === 'P2003') {
      return res.status(400).json({ success: false, error: 'Invalid trackId or championshipId' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/sessions/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const exists = await prisma().session.findUnique({ where: { id } });
    if (!exists) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    if (exists.deletedAt) {
      // Hard delete cascade: laps → session drivers → session
      await prisma().$transaction([
        prisma().lap.deleteMany({ where: { sessionId: id } }),
        prisma().sessionDriver.deleteMany({ where: { sessionId: id } }),
        prisma().session.delete({ where: { id } }),
      ]);
    } else {
      // Soft delete (via service for proper lifecycle handling)
      await sessionService.deleteSession(id);
    }

    res.json({ success: true, message: 'Session deleted' });
  } catch (error) {
    console.error('Error deleting session:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PATCH /api/sessions/:id/restore - Restore soft-deleted session
 */
router.patch('/:id/restore', async (req, res) => {
  try {
    const { id } = req.params;
    const entity = await prisma().session.findUnique({ where: { id } });
    if (!entity) return res.status(404).json({ success: false, error: 'Session not found' });
    if ([SessionStatus.ACTIVE, SessionStatus.PAUSED, SessionStatus.FINISHING].includes(entity.status)) {
      return res.status(409).json({ success: false, error: 'Resolve the running session before restoring it' });
    }

    // Restore cascade: session → session drivers → laps
    await prisma().session.update({
      where: { id },
      data: { deletedAt: null },
    });

    await prisma().sessionDriver.updateMany({
      where: { sessionId: id, deletedAt: entity.deletedAt },
      data: { deletedAt: null },
    });

    await prisma().lap.updateMany({
      where: { sessionId: id, deletedAt: entity.deletedAt },
      data: { deletedAt: null },
    });
    await prisma().trackRecord.updateMany({
      where: { sessionId: id, deletedAt: entity.deletedAt },
      data: { deletedAt: null },
    });

    res.json({ success: true, message: 'Session restored' });
  } catch (error) {
    console.error('Error restoring session:', error);
    res.status(500).json({ success: false, error: 'Failed to restore session' });
  }
});

/**
 * PUT /api/sessions/:id/drivers
 */
router.put('/:id/drivers', async (req, res) => {
  try {
    const { id } = req.params;
    const { drivers } = req.body;

    if (!Array.isArray(drivers)) {
      return res.status(400).json({ success: false, error: 'drivers must be an array' });
    }

    const session = await prisma().session.findUnique({ where: { id, deletedAt: null } });
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }
    if (session.status !== SessionStatus.DRAFT) {
      return res.status(409).json({ success: false, error: 'Only draft session assignments can be changed' });
    }

    // Accept partial configs for drafts, never duplicate a driver or physical car in a heat.
    const validDrivers = drivers.filter((d) => d && (d.driverId || d.carId));
    const unique = (values) =>
      new Set(values.filter((value) => value != null)).size === values.filter((value) => value != null).length;
    if (
      validDrivers.length > 6 ||
      validDrivers.some(
        (d) =>
          !Number.isInteger(Number(d.controller)) ||
          Number(d.controller) < 0 ||
          Number(d.controller) > 5 ||
          d.controller === null ||
          d.controller === undefined
      ) ||
      !unique(validDrivers.map((d) => Number(d.controller))) ||
      (session.type !== SessionType.BALANCING && !unique(validDrivers.map((d) => d.driverId))) ||
      !unique(validDrivers.map((d) => d.carId))
    ) {
      return res.status(400).json({ success: false, error: 'Duplicate or invalid controller, driver or car' });
    }

    // Balancing measures cars, not drivers: every entry belongs to the reference
    // driver, whoever actually holds the controller. Without one configured, the
    // chosen drivers are kept and the UI warns about it.
    const reference = session.type === SessionType.BALANCING ? await getReferenceDriver(prisma()) : null;

    await prisma().$transaction(async (tx) => {
      await tx.sessionDriver.deleteMany({ where: { sessionId: id } });
      if (validDrivers.length > 0) {
        await tx.sessionDriver.createMany({
          data: validDrivers.map((d, idx) => ({
            sessionId: id,
            driverId: reference?.id ?? d.driverId ?? null,
            carId: d.carId || null,
            controller: Number(d.controller),
            gridPos: d.gridPos ?? idx + 1,
          })),
        });
      }
    });

    const updatedSession = await prisma().session.findUnique({
      where: { id },
      include: {
        track: true,
        championship: true,
        drivers: { include: { driver: true, car: true }, orderBy: { controller: 'asc' } },
      },
    });

    res.json({ success: true, data: updatedSession });
  } catch (error) {
    console.error('Error updating drivers:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PATCH /api/sessions/:id/status
 */
router.patch('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status: newStatus } = req.body;

    const validStatuses = ['draft', 'active', 'paused', 'finishing', 'finished'];
    if (!newStatus || !validStatuses.includes(newStatus)) {
      return res.status(400).json({
        success: false,
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
      });
    }

    const session = await prisma().session.findUnique({
      where: { id },
      include: { drivers: { include: { driver: true, car: true } } },
    });

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const currentStatus = session.status;
    const allowedTransitions = {
      'draft': ['active'],
      'active': ['paused', 'finishing', 'finished'],
      'paused': ['active', 'finished'],
      'finishing': ['finished'],
      'finished': ['draft'],
    };

    if (!allowedTransitions[currentStatus]?.includes(newStatus)) {
      return res.status(400).json({
        success: false,
        error: `Cannot transition from '${currentStatus}' to '${newStatus}'`,
      });
    }

    // Delegate to SessionService for lifecycle transitions
    if (newStatus === 'active' && currentStatus === 'draft') {
      await sessionService.startSession(id);
    } else if (newStatus === 'paused' && currentStatus === 'active') {
      await sessionService.pauseSession(id);
    } else if (newStatus === 'active' && currentStatus === 'paused') {
      await sessionService.resumeSession(id);
    } else if (newStatus === 'finished') {
      await sessionService.stopSession(id);
    } else {
      // Simple status update (finished -> draft)
      const updateData = { status: newStatus };
      if (newStatus === 'draft' && currentStatus === 'finished') {
        updateData.startedAt = null;
        updateData.finishingAt = null;
        updateData.finishedAt = null;
      }
      await prisma().session.update({ where: { id }, data: updateData });
    }

    const updatedSession = await prisma().session.findUnique({
      where: { id },
      include: { track: true, championship: true, drivers: { include: { driver: true, car: true } } },
    });

    res.json({ success: true, data: updatedSession, message: `Status changed to '${newStatus}'` });
  } catch (error) {
    console.error('Error changing status:', error);
    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      runningSessions: error.runningSessions,
      recoveryUrl: error.recoveryUrl,
    });
  }
});

/**
 * POST /api/sessions/:id/start
 */
router.post('/:id/start', async (req, res) => {
  try {
    const { id } = req.params;

    const session = await prisma().session.findUnique({ where: { id } });
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    if (session.status !== SessionStatus.DRAFT) {
      return res.status(409).json({
        success: false,
        error: `Session must be 'draft' to start, current: ${session.status}`,
      });
    }

    await sessionService.startSession(id);

    const updatedSession = await prisma().session.findUnique({
      where: { id },
      include: { track: true, championship: true, drivers: { include: { driver: true, car: true } } },
    });

    res.json({ success: true, data: updatedSession, message: 'Session started' });
  } catch (error) {
    console.error('Error starting session:', error);
    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      runningSessions: error.runningSessions,
      recoveryUrl: error.recoveryUrl,
    });
  }
});

/**
 * POST /api/sessions/:id/pause
 */
router.post('/:id/pause', async (req, res) => {
  try {
    const { id } = req.params;

    const session = await prisma().session.findUnique({ where: { id } });
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    if (session.status !== SessionStatus.ACTIVE) {
      return res.status(400).json({
        success: false,
        error: `Session must be 'active' to pause, current: ${session.status}`,
      });
    }

    await sessionService.pauseSession(id);

    const updatedSession = await prisma().session.findUnique({
      where: { id },
      include: { track: true, championship: true, drivers: { include: { driver: true, car: true } } },
    });

    res.json({ success: true, data: updatedSession, message: 'Session paused' });
  } catch (error) {
    console.error('Error pausing session:', error);
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/sessions/:id/resume
 */
router.post('/:id/resume', async (req, res) => {
  try {
    const { id } = req.params;

    const session = await prisma().session.findUnique({ where: { id } });
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    if (session.status !== SessionStatus.PAUSED) {
      return res.status(400).json({
        success: false,
        error: `Session must be 'paused' to resume, current: ${session.status}`,
      });
    }

    await sessionService.resumeSession(id);

    const updatedSession = await prisma().session.findUnique({
      where: { id },
      include: { track: true, championship: true, drivers: { include: { driver: true, car: true } } },
    });

    res.json({ success: true, data: updatedSession, message: 'Session resumed' });
  } catch (error) {
    console.error('Error resuming session:', error);
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/sessions/:id/stop
 */
router.post('/:id/stop', async (req, res) => {
  try {
    const { id } = req.params;

    const session = await prisma().session.findUnique({ where: { id } });
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    if (!['active', 'paused', 'finishing'].includes(session.status)) {
      return res.status(400).json({
        success: false,
        error: `Session must be active/paused/finishing to stop, current: ${session.status}`,
      });
    }

    await sessionService.stopSession(id);

    const updatedSession = await prisma().session.findUnique({
      where: { id },
      include: { track: true, championship: true, drivers: { include: { driver: true, car: true } } },
    });

    res.json({ success: true, data: updatedSession, message: 'Session stopped' });
  } catch (error) {
    console.error('Error stopping session:', error);
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/sessions/:id/reset
 * Reset session to ready
 * - Practice: soft delete laps (for stats)
 * - Qualif/Race: hard delete laps
 */
router.post('/:id/reset', async (req, res) => {
  try {
    const { id } = req.params;

    await sessionService.resetSession(id);

    const updatedSession = await prisma().session.findUnique({
      where: { id },
      include: { track: true, championship: true, drivers: { include: { driver: true, car: true } } },
    });

    res.json({ success: true, data: updatedSession, message: 'Session reset' });
  } catch (error) {
    console.error('Error resetting session:', error);
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/sessions/:id/leaderboard
 */
router.get('/:id/leaderboard', async (req, res) => {
  try {
    const { id } = req.params;

    // If this is the active session, return live data
    if (sessionService.activeSessionId === id) {
      return res.json({ success: true, data: sessionService.getLeaderboard() });
    }

    // Otherwise calculate from DB
    const session = await prisma().session.findUnique({
      where: { id },
      include: {
        drivers: { include: { driver: true, car: true } },
        virtualFuelEvents: { orderBy: { id: 'asc' } },
        penalties: true,
      },
    });

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const fuelLevels =
      session.virtualFuelRate == null ? null : replayVirtualFuel(session.virtualFuelEvents, session.drivers);
    const entries = [];
    for (const sd of session.drivers) {
      const laps = await prisma().lap.findMany({
        where: { sessionId: id, controller: sd.controller, deletedAt: null },
        orderBy: { timestamp: 'desc' },
      });

      const entry = {
        id: sd.id,
        controller: sd.controller,
        driverId: sd.driverId,
        tyreType: sd.tyreType,
        pendingTyreType: sd.pendingTyreType,
        simulatedTotalTime: sd.simulatedTotalTime,
        simulatedBestLapTime: sd.simulatedBestLapTime,
        virtualFuelUnits: fuelLevels ? (fuelLevels.get(sd.id) ?? VIRTUAL_FUEL_FULL) : null,
        isDNF: sd.isDNF,
        driver: sd.driver,
        car: sd.car,
        gridPos: sd.gridPos,
        totalLaps: laps.length,
        totalTime: laps.reduce((sum, lap) => sum + Math.round(lap.lapTime), 0),
        bestLapTime: laps.length > 0 ? Math.min(...laps.map((l) => l.lapTime)) : null,
        lastLapTime: laps.length > 0 ? laps[0].lapTime : null,
      };

      // Include lap history for balancing sessions (needed for chart)
      if (session.type === SessionType.BALANCING) {
        const sortedLaps = [...laps].sort((a, b) => a.lapNumber - b.lapNumber);
        entry.laps = sortedLaps.map((l) => ({
          lapNumber: l.lapNumber,
          lapTime: Math.round(l.lapTime),
        }));
      }

      entries.push(entry);
    }

    // Calculate gaps and positions
    const sortedEntries = SessionService.calculateDriverGaps(entries, session.type, session.penalties);

    res.json({ success: true, data: sortedEntries });
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;

import express from 'express';
import { createPrismaClient } from '../lib/prisma.js';
import { requireLocalOrDirector } from './raceControl.js';

const router = express.Router();
const prisma = createPrismaClient();

// Live connection state (in-memory, not persisted)
let connectionState = {
  useMockDevice: process.env.USE_MOCK_DEVICE === 'true',
  connectedDevice: null,
  connectionStatus: 'disconnected',
};

// Store io instance for emitting events
let ioInstance = null;
let syncService = null;

export function setSettingsSyncService(service) {
  syncService = service;
}

export function setSettingsIo(io) {
  ioInstance = io;
}

// Update connection state (called by bluetooth.js or controlUnit)
export function updateConnectionState(updates) {
  connectionState = { ...connectionState, ...updates };
  if (ioInstance && updates.connectionStatus) {
    ioInstance.emit('cu:connection', {
      status: connectionState.connectionStatus,
      device: connectionState.connectedDevice,
    });
  }
}

// Toggle bounded start diagnostics without restarting the backend.
router.get('/start-trace', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: { enabled: syncService?.getStartTraceEnabled() ?? false } });
});

router.put('/start-trace', async (req, res) => {
  const { enabled } = req.body ?? {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ success: false, error: 'enabled must be boolean' });
  if (!syncService) return res.status(503).json({ success: false, error: 'Trace service unavailable' });
  try {
    await prisma.preference.upsert({
      where: { key: 'startTraceEnabled' },
      update: { value: JSON.stringify(enabled) },
      create: { key: 'startTraceEnabled', value: JSON.stringify(enabled) },
    });
    syncService.setStartTraceEnabled(enabled);
    res.json({ success: true, data: { enabled } });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to save trace setting' });
  }
});

router.get('/start-trace/records', requireLocalOrDirector, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: syncService?.getStartTraceRecords() ?? [] });
});

// GET /api/settings - Get current settings
router.get('/', async (req, res) => {
  try {
    res.json({
      success: true,
      data: connectionState,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to get settings' });
  }
});

// POST /api/settings/mock-device - Toggle mock device
router.post('/mock-device', async (req, res) => {
  try {
    const { enabled } = req.body;

    process.env.USE_MOCK_DEVICE = enabled ? 'true' : 'false';
    connectionState.useMockDevice = enabled;

    if (!enabled && connectionState.connectedDevice?.isMock) {
      connectionState.connectedDevice = null;
      connectionState.connectionStatus = 'disconnected';
    }

    if (ioInstance) {
      ioInstance.emit('race:status', {
        running: false,
        active: false,
        raceTime: 0,
        carCount: enabled ? 6 : 0,
        isMockDevice: enabled,
      });
    }

    res.json({ success: true, data: { useMockDevice: enabled } });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to toggle mock device' });
  }
});

// GET /api/settings/bluetooth-device - Get current connection info
router.get('/bluetooth-device', async (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        device: connectionState.connectedDevice,
        status: connectionState.connectionStatus,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to get bluetooth device' });
  }
});

// POST /api/settings/bluetooth-device - Update connection info (internal use)
router.post('/bluetooth-device', async (req, res) => {
  try {
    const { deviceId, deviceName, connected } = req.body;

    if (connected) {
      connectionState.connectedDevice = { id: deviceId, name: deviceName };
      connectionState.connectionStatus = 'connected';
    } else {
      connectionState.connectedDevice = null;
      connectionState.connectionStatus = 'disconnected';
    }

    res.json({
      success: true,
      data: {
        device: connectionState.connectedDevice,
        status: connectionState.connectionStatus,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update bluetooth device' });
  }
});

export default router;

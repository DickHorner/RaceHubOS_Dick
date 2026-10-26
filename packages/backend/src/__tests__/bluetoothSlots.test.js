import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import bluetoothRouter, { setSyncService } from '../routes/bluetooth.js';

describe('direct CU tuning addresses', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/bluetooth', bluetoothRouter);

  let device;

  beforeEach(() => {
    device = {
      setSpeed: jest.fn().mockResolvedValue(undefined),
      setBrake: jest.fn().mockResolvedValue(undefined),
      setFuel: jest.fn().mockResolvedValue(undefined),
    };
    setSyncService({ getDevice: () => device });
  });

  afterEach(() => {
    setSyncService(null);
  });

  test.each([
    ['set-speed', 'setSpeed'],
    ['set-brake', 'setBrake'],
    ['set-fuel', 'setFuel'],
  ])('%s rejects Ghost/Pace and malformed addresses before writing to the CU', async (endpoint, method) => {
    for (const address of [6, 7, -1, 8, 0.5, '6', null]) {
      const response = await request(app).post(`/api/bluetooth/${endpoint}`).send({ address, value: 5 });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ success: false, error: 'Invalid controller (0-5)' });
    }

    expect(device[method]).not.toHaveBeenCalled();
  });

  test.each([
    ['set-speed', 'setSpeed'],
    ['set-brake', 'setBrake'],
    ['set-fuel', 'setFuel'],
  ])('%s still accepts human slots 0 and 5', async (endpoint, method) => {
    for (const address of [0, 5]) {
      const response = await request(app).post(`/api/bluetooth/${endpoint}`).send({ address, value: 5 });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    }

    expect(device[method]).toHaveBeenNthCalledWith(1, 0, 5);
    expect(device[method]).toHaveBeenNthCalledWith(2, 5, 5);
  });
});

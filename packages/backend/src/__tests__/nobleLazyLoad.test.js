import { jest } from '@jest/globals';

jest.unstable_mockModule('@abandonware/noble', () => {
  throw new Error('No native build was found for win32 node=26');
});

test('missing Noble binary blocks CU operations but not BLE service construction', async () => {
  const { BLEService } = await import('../services/ble.js');
  const ble = new BLEService();

  expect(ble.isConnected()).toBe(false);
  await expect(ble.scan()).rejects.toThrow('No native build was found');
  await expect(ble.connect('00:11:22:33:44:55')).rejects.toThrow('No native build was found');
  expect(ble.connected).toBe(false);
  expect(ble.connecting).toBe(false);
});

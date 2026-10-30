import { jest } from '@jest/globals';
import { SessionService } from '../services/SessionService.js';

describe('confirmed automatic sound triggers', () => {
  let service;
  let sounds;
  beforeEach(() => {
    service = new SessionService({ emit: jest.fn() });
    service.activeSessionId = 's1';
    service.currentPhase = 'race';
    service.sessionDrivers = [
      { id: 'sd1', controller: 0, driver: { name: 'Alice' }, car: { brand: 'BMW', model: 'M4' } },
    ];
    sounds = [];
    service.on('soundboardAutoEvent', (cue) => sounds.push(cue));
  });
  afterEach(async () => {
    await service.prisma.$disconnect();
  });

  it.each([
    ['session:started', {}, 'prepared'],
    ['session:race_started', {}, 'started'],
    ['session:race_resumed', {}, 'resumed'],
    ['session:status_changed', { status: 'paused', previousStatus: 'active' }, 'paused'],
    ['session:finishing', {}, 'finishing'],
    ['session:weather_changed', { weatherCondition: 'rain' }, 'rain'],
    ['session:weather_changed', { weatherCondition: 'dry' }, 'dry'],
    ['session:pit_stop', { id: 'pit1', sessionDriverId: 'sd1' }, 'pitstop'],
    ['session:tyre_changed', { sessionDriverId: 'sd1', change: { id: 'tyre1' } }, 'tyrechanged'],
    ['session:damage_changed', { sessionDriverId: 'sd1', damageStatus: 'active' }, 'damage'],
    ['session:damage_changed', { sessionDriverId: 'sd1', damageStatus: 'repaired' }, 'repaired'],
    ['session:damage_changed', { sessionDriverId: 'sd1', damageStatus: 'dnf' }, 'dnf'],
    ['session:vsc', { status: 'active', active: true }, 'vscon'],
    ['session:vsc', { status: 'inactive' }, 'vscoff'],
  ])('%s emits %s only on the internal audio channel', (event, data, type) => {
    const payload = { sessionId: 's1', ...data };
    service.emit(event, payload);
    expect(service.io.emit).toHaveBeenCalledWith(event, payload);
    expect(sounds).toHaveLength(1);
    expect(sounds[0]).toMatchObject({
      type,
      data: { sessionId: 's1', sessionType: 'race', eventId: expect.any(String) },
    });
    if (data.sessionDriverId)
      expect(sounds[0].data).toMatchObject({ driverName: 'Alice', controller: 0, carBrand: 'BMW' });
    else expect(sounds[0].data.driverName).toBeNull();
  });

  it('suppresses snapshots, requests, unknown states, stale sessions and balancing', () => {
    for (const [event, data] of [
      ['session:heartbeat', { weatherCondition: 'rain' }],
      ['session:resumed', {}],
      ['session:tyre_changed', { pendingTyreType: 'wet' }],
      ['session:weather_changed', { weatherCondition: null }],
      ['session:vsc_error', { status: 'restore_failed' }],
      ['session:vsc', { status: 'restoring' }],
      ['session:damage_changed', { damageStatus: 'none' }],
      ['session:status_changed', { status: 'paused', previousStatus: 'paused' }],
    ])
      service.emit(event, { sessionId: 's1', ...data });
    service.emit('session:started', { sessionId: 'other' });
    service.emit('session:started', {});
    service.currentPhase = 'balancing';
    service.emit('session:started', { sessionId: 's1' });
    expect(sounds).toEqual([]);
  });

  it('announces actual GO once and resume only after the pause is closed', async () => {
    service.sessionStatus = 'active';
    service.sessionConfig = { startedAt: null, pauses: [] };
    service.prisma.session.update = jest.fn().mockResolvedValue({});
    await service.onRaceStart();
    await service.onRaceStart();
    expect(sounds.map((cue) => cue.type)).toEqual(['started']);
    service.sessionConfig.pauses = [{ start: Date.now() - 1000, end: null }];
    await service.onRaceStart();
    expect(service.sessionConfig.pauses[0].end).not.toBeNull();
    expect(sounds.map((cue) => cue.type)).toEqual(['started', 'resumed']);
  });

  it('does not announce GO when saving the start fails', async () => {
    service.sessionStatus = 'active';
    service.sessionConfig = { startedAt: null, pauses: [] };
    service.prisma.session.update = jest.fn().mockRejectedValue(new Error('storage failed'));
    await expect(service.onRaceStart()).rejects.toThrow('storage failed');
    expect(sounds).toEqual([]);
    expect(service.sessionConfig.startedAt).toBeNull();
  });

  it('uses separate occurrence IDs for repeated legitimate transitions and never substitutes a driver', () => {
    service.emit('session:damage_changed', {
      sessionId: 's1',
      sessionDriverId: 'missing',
      controller: 0,
      damageStatus: 'active',
    });
    service.emit('session:damage_changed', {
      sessionId: 's1',
      sessionDriverId: 'missing',
      controller: 0,
      damageStatus: 'active',
    });
    expect(sounds[0].data.driverName).toBeNull();
    expect(sounds[0].data.controller).toBeNull();
    expect(sounds[0].data.eventId).not.toBe(sounds[1].data.eventId);
  });
});

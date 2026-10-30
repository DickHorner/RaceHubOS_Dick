import test from 'node:test'
import assert from 'node:assert/strict'
import { AUTO_CUE_TYPES, autoCueKey, autoSpeechText } from '../src/lib/soundboardAuto.js'

test('best-lap identity requires a real session and measured lap', () => {
  const event = { sessionId: 's1', sessionType: 'race', controller: 0, totalLaps: 3, lapTime: 8501 }
  assert.equal(autoCueKey('bestlap', event), 'bestlap:s1:0:3:8501')
  assert.equal(autoCueKey('bestlap', { ...event, sessionId: null }), null)
  assert.equal(autoCueKey('bestlap', { ...event, totalLaps: 0 }), null)
  assert.equal(autoCueKey('bestlap', { ...event, sessionType: 'balancing' }), null)
  assert.equal(autoCueKey('bestlap', { ...event, controller: 6 }), null)
  assert.equal(autoCueKey('bestlap', { ...event, lapTime: NaN }), null)
  assert.equal(autoCueKey('any', event), null)
})

test('all additional triggers require a server occurrence identity and a supported session', () => {
  const data = { sessionId: 's1', sessionType: 'race', eventId: '12345678-1234-4234-8234-123456789abc' }
  assert.equal(AUTO_CUE_TYPES.length, 16)
  for (const type of AUTO_CUE_TYPES.filter((cue) => !['bestlap', 'finished'].includes(cue))) {
    assert.equal(autoCueKey(type, data), `${type}:s1:${data.eventId}`)
    assert.equal(autoCueKey(type, { ...data, eventId: null }), null)
    assert.equal(autoCueKey(type, { ...data, eventId: 'fake' }), null)
    assert.equal(autoCueKey(type, { ...data, sessionType: 'balancing' }), null)
  }
  assert.equal(autoCueKey('heartbeat', data), null)
  assert.notEqual(autoCueKey('rain', data), autoCueKey('dry', data))
})

test('pit and damage speech uses only the identified participant and never invents a lap time', () => {
  for (const type of ['pitstop', 'tyrechanged', 'damage', 'repaired', 'dnf']) {
    assert.equal(
      autoSpeechText(
        '{driver} / {car} / {controller}',
        type,
        { driverName: 'Alice', carBrand: 'BMW', carModel: 'M4', controller: 0 },
        String
      ),
      'Alice / BMW M4 / 1'
    )
    assert.equal(autoSpeechText('{lapTime}', type, {}, String), null)
    assert.equal(autoSpeechText('{driver}', type, { controller: 0 }, String), null)
  }
  for (const type of ['started', 'rain', 'vscon']) {
    assert.equal(autoSpeechText('Ready', type, {}, String), 'Ready')
    assert.equal(autoSpeechText('{driver}', type, { driverName: 'Alice' }, String), null)
  }
})

test('finish identity is stable but excludes balancing and missing session start', () => {
  const finished = { sessionId: 's1', sessionType: 'race', startedAt: '2026-10-28T12:00:00Z' }
  assert.equal(autoCueKey('finished', finished), 'finished:s1:2026-10-28T12:00:00Z')
  assert.equal(autoCueKey('finished', { ...finished, startedAt: null }), null)
  assert.equal(autoCueKey('finished', { ...finished, sessionType: 'balancing' }), null)
})

test('speech interpolation uses only measured payload fields and never invents a driver', () => {
  const lap = { driverName: 'Alice', controller: 0, lapTime: 8501, carBrand: 'BMW', carModel: 'M4' }
  assert.equal(
    autoSpeechText('{driver} / {car} / {controller} / {lapTime}', 'bestlap', lap, (ms) => `${ms}ms`),
    'Alice / BMW M4 / 1 / 8501ms'
  )
  assert.equal(
    autoSpeechText('{driver}', 'bestlap', { controller: 0 }, () => ''),
    null
  )
  assert.equal(
    autoSpeechText('Finished', 'finished', {}, () => ''),
    'Finished'
  )
  assert.equal(
    autoSpeechText('Good job {driver}', 'finished', {}, () => ''),
    null
  )
})

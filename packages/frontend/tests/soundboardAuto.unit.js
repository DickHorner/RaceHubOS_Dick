import test from 'node:test'
import assert from 'node:assert/strict'
import { autoCueKey, autoSpeechText } from '../src/lib/soundboardAuto.js'

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
  assert.equal(autoSpeechText('{driver}', 'bestlap', { controller: 0 }, () => ''), null)
  assert.equal(autoSpeechText('Finished', 'finished', {}, () => ''), 'Finished')
  assert.equal(autoSpeechText('Good job {driver}', 'finished', {}, () => ''), null)
})

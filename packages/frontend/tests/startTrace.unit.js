import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { beginStartTrace, traceStart, traceStartStatus, getStartTraceRecords, setStartTraceEnabled } from '../src/lib/startTrace.js'

let rows
let now
let enabled
beforeEach((t) => {
  rows = []
  now = 100
  enabled = '1'
  t.mock.method(console, 'info', (prefix, row) => rows.push({ prefix, ...row }))
  t.mock.method(performance, 'now', () => now)
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: { getItem: () => enabled },
  })
})
afterEach(() => {
  traceStart('failed')
  delete globalThis.sessionStorage
  delete globalThis.localStorage
})

test('disabled or unavailable tab storage produces no diagnostic output', () => {
  enabled = null
  beginStartTrace('s1')
  traceStartStatus(1)
  traceStart('audio:scheduled')
  sessionStorage.getItem = () => {
    throw new Error('Storage blocked')
  }
  beginStartTrace('s1')
  assert.deepEqual(rows, [])
})

test('click origin is monotonic, duplicate clicks retain it and status repeats are omitted', () => {
  beginStartTrace('s1')
  now += 125
  beginStartTrace('s2')
  traceStartStatus(1)
  traceStartStatus(1)
  now += 25
  traceStartStatus(2)
  assert.deepEqual(
    rows.map(({ phase, sessionId, elapsedMs }) => ({ phase, sessionId, elapsedMs })),
    [
      { phase: 'click', sessionId: 's1', elapsedMs: 0 },
      { phase: 'status:received', sessionId: 's1', elapsedMs: 125 },
      { phase: 'status:received', sessionId: 's1', elapsedMs: 150 },
    ]
  )
  assert.ok(rows.every((row) => row.traceId === rows[0].traceId))
  assert.equal(rows[0].prefix, '[BrowserStartTrace]')
  assert.ok(Number.isFinite(Date.parse(rows[0].startedAt)))
})

for (const phase of ['racing', 'failed', 'disconnected']) {
  test(`${phase} ends the capture; another click creates a new attempt`, () => {
    beginStartTrace('s1')
    traceStart(phase)
    traceStartStatus(2)
    traceStart('audio:scheduled')
    assert.deepEqual(
      rows.map((row) => row.phase),
      ['click', phase]
    )
    beginStartTrace('s2')
    assert.notEqual(rows[2].traceId, rows[0].traceId)
    assert.equal(rows[2].sessionId, 's2')
  })
}

test('capture expires on the next record after 60 seconds without a timer or retained payload', () => {
  beginStartTrace('s1')
  now += 60_001
  traceStart('audio:scheduled', { frequency: 600 })
  traceStartStatus(3)
  assert.deepEqual(
    rows.map((row) => row.phase),
    ['click', 'expired']
  )
  assert.equal(rows[1].elapsedMs, 60_001)
  assert.equal(rows[1].frequency, undefined)
})

test('unchanged status after the deadline also expires the capture', () => {
  beginStartTrace('s1')
  traceStartStatus(1)
  now += 60_001
  traceStartStatus(1)
  traceStartStatus(2)
  assert.deepEqual(
    rows.map((row) => row.phase),
    ['click', 'status:received', 'expired']
  )
})

test('settings switch controls browser capture and keeps downloadable records after disable', () => {
  let stored = null
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => stored,
      setItem: (_, value) => {
        stored = value
      },
    },
  })
  const before = getStartTraceRecords().length
  assert.equal(setStartTraceEnabled(true), true)
  beginStartTrace('ui-switch')
  traceStartStatus(6)
  traceStart('racing')
  assert.deepEqual(
    getStartTraceRecords()
      .slice(before)
      .map((row) => row.phase),
    ['click', 'status:received', 'racing']
  )
  assert.equal(setStartTraceEnabled(false), true)
  beginStartTrace('disabled-again')
  assert.equal(getStartTraceRecords().length, before + 3)
})

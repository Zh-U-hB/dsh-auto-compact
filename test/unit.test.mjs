import test from 'node:test'
import assert from 'node:assert/strict'
import { balancedCuts, resolveConfig, selectCompactableRange } from '../lib/index.js'

function surfaceSession(nodeSpecs) {
  const events = {}
  const surface = []
  for (const [type, seq, content] of nodeSpecs) {
    surface.push(seq)
    if (type === 'assistant/message') {
      events[seq] = {
        seq,
        type,
        data: { message: { content } },
      }
    } else {
      events[seq] = { seq, type, data: { message: { content } } }
    }
  }
  return { surface: { nodes: surface }, events }
}

test('resolveConfig applies the documented defaults', () => {
  assert.deepEqual(resolveConfig(undefined), {
    thresholdTokens: 262144,
    retainTokens: 32768,
    maxCompactions: 3,
    enabled: true,
  })
})

test('resolveConfig accepts human-size thresholds', () => {
  assert.equal(resolveConfig({ thresholdTokens: '256k' }).thresholdTokens, 262144)
  assert.equal(resolveConfig({ thresholdTokens: '256K' }).thresholdTokens, 262144)
  assert.equal(resolveConfig({ thresholdTokens: '1m' }).thresholdTokens, 1048576)
  assert.equal(resolveConfig({ thresholdTokens: 131072, retainTokens: '8k' }).retainTokens, 8192)
})

test('resolveConfig rejects unknown keys and invalid values', () => {
  assert.throws(() => resolveConfig({ typoThreshold: 1 }), /unknown config key/)
  assert.throws(() => resolveConfig({ thresholdTokens: 0 }), /positive integer/)
  assert.throws(() => resolveConfig({ thresholdTokens: 'lots' }), /positive integer/)
  assert.throws(() => resolveConfig({ enabled: 'yes' }), /boolean/)
})

test('balancedCuts reports cuts around an open tool pair', () => {
  const session = surfaceSession([
    ['user/message', 1, 'start'],
    ['assistant/message', 2, [{ type: 'tool-call' }]],
    ['tool/result', 3, [{ type: 'tool_result' }]],
    ['assistant/message', 4, [{ type: 'text', text: 'done' }]],
  ])
  assert.deepEqual(balancedCuts(session), [true, true, false, true, true])
})

test('balancedCuts rejects an unmatched tool result', () => {
  const session = surfaceSession([
    ['user/message', 1, 'start'],
    ['tool/result', 2, [{ type: 'tool_result' }]],
  ])
  assert.throws(() => balancedCuts(session), /no matching tool call/)
})

test('selectCompactableRange retains the tail and snaps to a balanced cut', () => {
  const session = surfaceSession([
    ['user/message', 1, 'start'],
    ['assistant/message', 2, [{ type: 'tool-call' }]],
    ['tool/result', 3, [{ type: 'tool_result' }]],
    ['assistant/message', 4, [{ type: 'text', text: 'done' }]],
  ])
  const measurement = {
    totalTokens: 130,
    nodes: [
      { seq: 1, tokens: 10 },
      { seq: 2, tokens: 10 },
      { seq: 3, tokens: 10 },
      { seq: 4, tokens: 100 },
    ],
  }
  assert.deepEqual(selectCompactableRange(session, measurement, 20), { start: 1, end: 3 })
})

test('selectCompactableRange returns null when the tail itself is not balanced', () => {
  const session = surfaceSession([
    ['assistant/message', 2, [{ type: 'tool-call' }]],
  ])
  const measurement = {
    totalTokens: 10,
    nodes: [{ seq: 2, tokens: 10 }],
  }
  assert.equal(selectCompactableRange(session, measurement, 0), null)
})

test('selectCompactableRange rejects mismatched meter/surface', () => {
  const session = surfaceSession([
    ['user/message', 1, 'start'],
    ['user/message', 2, 'next'],
  ])
  const measurement = {
    totalTokens: 20,
    nodes: [{ seq: 1, tokens: 10 }],
  }
  assert.throws(() => selectCompactableRange(session, measurement, 5), /does not match/)
})

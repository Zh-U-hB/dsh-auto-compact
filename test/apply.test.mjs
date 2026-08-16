import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

function makeSession() {
  const events = {}
  const surface = [1, 2, 3, 4]
  events[1] = { seq: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'start' }] } } }
  events[2] = { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } }
  events[3] = { seq: 3, type: 'tool/result', data: { message: { content: [{ type: 'tool_result' }] } } }
  events[4] = { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } }
  return { surface: { nodes: surface }, events }
}

function makeHarness({ totals, threshold = 262144, compactRegion, fallbackCompaction, fallbackEngine, maxCompactions }) {
  const calls = { compacted: [], infos: [], warns: [] }
  let index = 0
  const measurement = () => {
    const total = totals[index] ?? totals[totals.length - 1]
    return {
      totalTokens: total,
      nodes: [
        { seq: 1, tokens: 10 },
        { seq: 2, tokens: 10 },
        { seq: 3, tokens: 10 },
        { seq: 4, tokens: Math.max(0, total - 30) },
      ],
    }
  }
  const compaction = {
    compactRegion: compactRegion ?? (async (start, end, agent) => {
      calls.compacted.push({ start, end, agent })
      index += 1
      return { shadowedSeqs: [start], shadowedTokenCount: 100 }
    }),
  }
  const ctx = {
    tokenMeter: { measure: (session) => ({ ...measurement(), session }) },
    logger: {
      info: (message) => calls.infos.push(String(message)),
      warn: (message) => calls.warns.push(String(message)),
    },
    baseUrl: 'file:///test/',
    loader: {
      internal: {
        import: async (specifier) => {
          calls.imports ??= []
          calls.imports.push(specifier)
          if (specifier === '@deepseek-ai/dsh-compaction-basic' && fallbackEngine !== undefined) {
            return { BasicCompactionEngine: fallbackEngine }
          }
          return fallbackCompaction === undefined
            ? {}
            : { serviceForAgent: () => fallbackCompaction }
        },
      },
    },
    on: (event, handler) => {
      calls.handler = handler
    },
  }
  apply(ctx, { thresholdTokens: threshold, retainTokens: 5, ...(maxCompactions === undefined ? {} : { maxCompactions }) })
  return { ctx, calls, compaction }
}

function makeAgent(session, compaction) {
  return {
    id: 'test-agent',
    session,
    ctx: {
      get: (name) => name === 'compaction' ? (compaction ?? undefined) : undefined,
    },
  }
}

async function runStep(harness, session, compaction = harness.compaction) {
  return runStepAgent(harness, makeAgent(session, compaction))
}

async function runStepAgent(harness, agent) {
  let nextCalled = false
  await harness.calls.handler(
    {
      agent,
      signal: new AbortController().signal,
    },
    () => {
      nextCalled = true
    },
  )
  return nextCalled
}

test('apply compacts once the absolute threshold is reached', async () => {
  const session = makeSession()
  const harness = makeHarness({ totals: [300000, 100000], threshold: 200000 })
  const nextCalled = await runStep(harness, session)
  assert.equal(harness.calls.compacted.length, 1)
  assert.deepEqual(harness.calls.compacted[0].start, 1)
  assert.equal(nextCalled, true)
  assert.equal(harness.calls.warns.length, 0)
})

test('apply does nothing below the threshold', async () => {
  const session = makeSession()
  const harness = makeHarness({ totals: [100000], threshold: 200000 })
  await runStep(harness, session)
  assert.equal(harness.calls.compacted.length, 0)
})

test('apply continues the step when compaction throws', async () => {
  const session = makeSession()
  const harness = makeHarness({
    totals: [300000],
    threshold: 200000,
    compactRegion: async () => {
      throw new Error('backend failure')
    },
  })
  const nextCalled = await runStep(harness, session)
  assert.equal(nextCalled, true)
  assert.equal(harness.calls.warns.length, 1)
})

test('apply skips agents whose preset has no compaction backend', async () => {
  const session = makeSession()
  const harness = makeHarness({ totals: [300000], threshold: 200000 })
  const agent = makeAgent(session, null)
  await runStepAgent(harness, agent)
  assert.equal(harness.calls.compacted.length, 0)
  assert.equal(harness.calls.warns.length, 1)

  // The missing-backend warning is emitted once per agent, not once per step.
  await runStepAgent(harness, agent)
  assert.equal(harness.calls.warns.length, 1)
})

test('apply resolves preset-isolated compaction through serviceForAgent fallback', async () => {
  const session = makeSession()
  let fallbackCalls = 0
  const fallbackCompaction = {
    compactRegion: async (start, end) => {
      fallbackCalls += 1
      return { shadowedSeqs: [start, end], shadowedTokenCount: 100 }
    },
  }
  const harness = makeHarness({
    totals: [300000, 100000],
    threshold: 200000,
    fallbackCompaction,
    maxCompactions: 1,
  })
  const agent = makeAgent(session, null)
  await runStepAgent(harness, agent)
  assert.equal(harness.calls.imports[0], '@deepseek-ai/dsh-agent-presets')
  assert.equal(fallbackCalls, 1)
  assert.equal(harness.calls.warns.length, 1) // still-above warning after maxCompactions=1
})

test('settings namespace updates the threshold at runtime', async () => {
  const fakeZ = {
    object: (fields) => ({ fields }),
    union: (members) => ({ members, default: (value) => ({ members, defaultValue: value }) }),
    number: () => ({ step: () => ({ min: () => ({ kind: 'number' }) }) }),
    string: () => ({ min: () => ({ kind: 'string' }) }),
  }
  let scope
  const settings = {
    register(_namespace, schema, options) {
      let value = options.base.thresholdTokens ?? schema.fields.thresholdTokens.defaultValue
      let watcher
      scope = {
        get: () => ({ thresholdTokens: value }),
        watch: (callback) => { watcher = callback },
        setThreshold(next) { value = next; watcher() },
      }
      return scope
    },
  }
  const ctx = {
    tokenMeter: {
      measure: () => ({
        totalTokens: 300000,
        nodes: [
          { seq: 1, tokens: 10 },
          { seq: 2, tokens: 10 },
          { seq: 3, tokens: 10 },
          { seq: 4, tokens: 10 },
        ],
      }),
    },
    logger: { info: () => {}, warn: () => {} },
    baseUrl: 'file:///test/',
    loader: {
      internal: {
        import: async (specifier) => specifier === '@deepseek-ai/schemastery'
          ? { default: fakeZ }
          : {},
      },
    },
    on: (_event, handler) => { ctx.handler = handler },
    inject: (deps, callback) => {
      // Only the settings namespace sub-fiber is simulated here; the
      // webServer HTTP-route sub-fiber is covered by the web integration path.
      if (deps.includes('settings') && !deps.includes('webServer')) callback({ settings })
    },
  }
  apply(ctx, { thresholdTokens: 262144, retainTokens: 5, maxCompactions: 3 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(scope)

  const session = makeSession()
  const compacted = []
  const agent = makeAgent(session, {
    compactRegion: async (start, end) => {
      compacted.push({ start, end })
      return { shadowedSeqs: [start, end], shadowedTokenCount: 10 }
    },
  })
  const run = async () => {
    let nextCalled = false
    await ctx.handler({ agent, signal: new AbortController().signal }, () => { nextCalled = true })
    return nextCalled
  }

  assert.equal(await run(), true)
  assert.equal(compacted.length, 3)

  scope.setThreshold(400000)
  assert.equal(await run(), true)
  assert.equal(compacted.length, 3, 'raising the threshold through settings must stop compaction')
})

test('apply mounts a fallback compaction engine for presets without compaction', async () => {
  const session = makeSession()
  let fallbackCalls = 0
  let fallbackConstructed = 0
  class FallbackCompactionEngine {
    constructor(agentCtx, config) {
      fallbackConstructed += 1
      assert.equal(config.auto, false)
      assert.equal(typeof agentCtx?.get, 'function')
    }

    compactRegion = async (start, end) => {
      fallbackCalls += 1
      return { shadowedSeqs: [start, end], shadowedTokenCount: 100 }
    }
  }
  const harness = makeHarness({
    totals: [300000, 100000],
    threshold: 200000,
    fallbackEngine: FallbackCompactionEngine,
    maxCompactions: 1,
  })
  const agent = makeAgent(session, null)
  await runStepAgent(harness, agent)
  assert.ok(harness.calls.imports.includes('@deepseek-ai/dsh-agent-presets'))
  assert.ok(harness.calls.imports.includes('@deepseek-ai/dsh-compaction-basic'))
  assert.equal(fallbackConstructed, 1)
  assert.equal(fallbackCalls, 1)
})

/**
 * dsh-auto-compact — host half.
 *
 * Automatic compaction for DeepSeek Harness sessions: when the session's
 * measured context (ctx.tokenMeter) reaches an absolute token threshold,
 * compact the older surface through the harness's built-in compaction
 * service (`ctx.compaction`) — the exact same engine behind the built-in
 * `/compact` command — before the next model step starts.
 *
 * This file intentionally has NO runtime imports. It is designed to be copied
 * into an agent preset directory and mounted there as a local file plugin,
 * where Node's normal `node_modules` walk cannot reach the harness packages.
 * All service access goes through the Cordis context.
 *
 * Mount this row inside a preset's `compaction` group, AFTER `compaction-basic`
 * (or any other `ctx.compaction` provider), e.g.:
 *
 *   - id: auto-compact
 *     name: ./dsh-auto-compact.mjs
 *     config:
 *       thresholdTokens: 262144   # 256K
 *       retainTokens: 32768       # 32K tail kept verbatim
 *       maxCompactions: 3
 *       enabled: true
 */

export const name = 'dsh-auto-compact'

/** tokenMeter lives on the host plane; compaction is resolved lazily below. */
export const inject = ['tokenMeter']

const DEFAULT_THRESHOLD_TOKENS = 262144 // 256 * 1024
const DEFAULT_RETAIN_TOKENS = 32768 // 32K
const DEFAULT_MAX_COMPACTIONS = 3
const CONFIG_KEYS = new Set(['thresholdTokens', 'retainTokens', 'maxCompactions', 'enabled'])

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Accept either a plain token count (`262144`) or a human-size string
 * (`"256k"`, `"256K"`, `"1m"`). K/M are binary units (1024/1048576), which
 * matches how 256K contexts are usually specified.
 */
function parseTokenCount(value, fallback, label) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`dsh-auto-compact: ${label} must be a positive integer, got ${String(value)}`)
    }
    return value
  }
  if (typeof value === 'string') {
    const match = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(value)
    if (match !== null) {
      const number = Number(match[1])
      const unit = match[2].toLowerCase()
      const multiplier = unit === 'k' ? 1024 : unit === 'm' ? 1048576 : 1
      const resolved = number * multiplier
      if (Number.isInteger(resolved) && resolved > 0) return resolved
    }
    throw new Error(`dsh-auto-compact: ${label} must be a positive integer or a value like "256k", got ${JSON.stringify(value)}`)
  }
  throw new Error(`dsh-auto-compact: ${label} must be a positive integer or a value like "256k", got ${String(value)}`)
}

function parsePositiveInteger(value, fallback, label) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`dsh-auto-compact: ${label} must be a positive integer, got ${String(value)}`)
  }
  return value
}

/**
 * Validate the row's raw YAML config and apply defaults.
 *
 * @param raw - untrusted composition entry config.
 * @returns a detached frozen config snapshot.
 */
export function resolveConfig(raw) {
  if (raw === undefined || raw === null) raw = {}
  if (!isPlainObject(raw)) throw new Error('dsh-auto-compact: config must be a mapping of option keys')
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`dsh-auto-compact: unknown config key "${key}"`)
  }
  const enabled = raw.enabled ?? true
  if (typeof enabled !== 'boolean') throw new Error(`dsh-auto-compact: enabled must be a boolean, got ${String(enabled)}`)
  const thresholdTokens = parseTokenCount(raw.thresholdTokens, DEFAULT_THRESHOLD_TOKENS, 'thresholdTokens')
  const retainTokens = parseTokenCount(raw.retainTokens, DEFAULT_RETAIN_TOKENS, 'retainTokens')
  if (retainTokens >= thresholdTokens) {
    throw new Error(`dsh-auto-compact: retainTokens (${String(retainTokens)}) must be less than thresholdTokens (${String(thresholdTokens)})`)
  }
  return Object.freeze({
    thresholdTokens,
    retainTokens,
    maxCompactions: parsePositiveInteger(raw.maxCompactions, DEFAULT_MAX_COMPACTIONS, 'maxCompactions'),
    enabled,
  })
}

/** How one surface event changes the number of unanswered assistant tool calls. */
function toolCallDelta(event) {
  switch (event?.type) {
    case 'assistant/message': {
      const blocks = event.data?.message?.content
      if (!Array.isArray(blocks)) return 0
      let calls = 0
      for (const block of blocks) if (block?.type === 'tool-call') calls += 1
      return calls
    }
    case 'tool/result':
      return -1
    default:
      return 0
  }
}

/**
 * Fold the surface in order and report whether the cut BEFORE each surface
 * position is balanced (no unanswered assistant tool call would cross it).
 *
 * @param session - live session owning the authoritative surface and event log.
 * @returns boolean array; `cuts[i]` is true when the cut before surface node
 *   index `i` is safe. `cuts[0]` is always true.
 */
export function balancedCuts(session) {
  const surface = session?.surface?.nodes
  const events = session?.events
  if (!Array.isArray(surface) || events === undefined) {
    throw new Error('dsh-auto-compact: session has no readable surface')
  }
  const cuts = new Array(surface.length + 1)
  cuts[0] = true
  let balance = 0
  for (let index = 0; index < surface.length; index += 1) {
    const seq = surface[index]
    const event = events[seq]
    if (event === undefined || event.seq !== seq) {
      throw new Error(`dsh-auto-compact: surface seq ${String(seq)} has no matching session event (corrupt surface)`)
    }
    balance += toolCallDelta(event)
    if (balance < 0) {
      throw new Error(`dsh-auto-compact: tool/result at surface seq ${String(seq)} has no matching tool call (corrupt surface)`)
    }
    cuts[index + 1] = balance === 0
  }
  return cuts
}

/**
 * Select the next head-anchored span to compact: everything older than a
 * recent tail worth at least `retainTokens`, snapped back to a balanced cut so
 * an assistant tool call is never separated from its result.
 *
 * Mirrors the selection policy of the built-in `compaction-basic` backend,
 * which this plugin deliberately reuses through `ctx.compaction.compactRegion`.
 *
 * @returns `{ start, end }` inclusive surface seqs, or `null` when there is no
 *   useful compactable range.
 */
export function selectCompactableRange(session, measurement, retainTokens) {
  const nodes = measurement?.nodes
  const surface = session?.surface?.nodes
  if (!Array.isArray(nodes) || !Array.isArray(surface)) return null
  if (nodes.length === 0) return null
  if (nodes.length !== surface.length || nodes.some((node, index) => node?.seq !== surface[index])) {
    throw new Error('dsh-auto-compact: tokenMeter surface does not match the current session surface')
  }

  let keepFrom = nodes.length
  let retained = 0
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    retained += typeof nodes[index]?.tokens === 'number' && nodes[index].tokens > 0 ? nodes[index].tokens : 0
    keepFrom = index
    if (retained >= retainTokens) break
  }
  if (keepFrom <= 0) return null

  const cuts = balancedCuts(session)
  while (keepFrom > 0 && !cuts[keepFrom]) keepFrom -= 1
  if (keepFrom <= 0) return null

  return {
    start: surface[0],
    end: surface[keepFrom - 1],
  }
}

function formatCount(value) {
  return new Intl.NumberFormat('en-US').format(value)
}

async function enforceThreshold(ctx, compaction, agent, config, signal, warned) {
  for (let attempt = 0; attempt < config.maxCompactions; attempt += 1) {
    if (signal.aborted) return
    const measurement = ctx.tokenMeter.measure(agent.session)
    const total = typeof measurement?.totalTokens === 'number' ? measurement.totalTokens : 0
    if (total < config.thresholdTokens) {
      warned.noRange.delete(agent.session)
      warned.stillAbove.delete(agent.session)
      return
    }

    const range = selectCompactableRange(agent.session, measurement, config.retainTokens)
    if (range === null) {
      if (!warned.noRange.has(agent.session)) {
        warned.noRange.add(agent.session)
        ctx.logger.warn(
          `dsh-auto-compact: context at ${formatCount(total)} tokens is at/above the ${formatCount(config.thresholdTokens)} threshold, ` +
          `but no tool-pair-balanced older span is compactable; leaving the turn unchanged`,
        )
      }
      return
    }
    warned.noRange.delete(agent.session)

    ctx.logger.info(
      `dsh-auto-compact: context at ${formatCount(total)} tokens reached the ${formatCount(config.thresholdTokens)} threshold; ` +
      `compacting surface seqs ${range.start}-${range.end} (attempt ${attempt + 1}/${config.maxCompactions})`,
    )
    const result = await compaction.compactRegion(range.start, range.end, agent, signal)
    if (result !== null && result !== undefined) {
      const shadowed = Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0
      const shadowedTokens = typeof result.shadowedTokenCount === 'number' ? result.shadowedTokenCount : 0
      ctx.logger.info(
        `dsh-auto-compact: compacted ${String(shadowed)} history items (~${formatCount(shadowedTokens)} tokens shadowed)`,
      )
    }
  }

  if (signal.aborted) return
  const final = ctx.tokenMeter.measure(agent.session)
  const finalTotal = typeof final?.totalTokens === 'number' ? final.totalTokens : 0
  if (finalTotal >= config.thresholdTokens) {
    if (!warned.stillAbove.has(agent.session)) {
      warned.stillAbove.add(agent.session)
      ctx.logger.warn(
        `dsh-auto-compact: context is still at ${formatCount(finalTotal)} tokens after ${String(config.maxCompactions)} compaction attempt(s); ` +
        `continuing the turn (threshold ${formatCount(config.thresholdTokens)})`,
      )
    }
  } else {
    warned.stillAbove.delete(agent.session)
  }
}

/**
 * Install the automatic threshold check on the agent/pre-step waterfall.
 *
 * Compaction failures never veto the step: the built-in backend already
 * reports its own failures through the session log, and this wrapper logs a
 * warning and lets the model request proceed exactly as before.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return

  const compaction = ctx.get('compaction')
  if (compaction === undefined || typeof compaction.compactRegion !== 'function') {
    ctx.logger.warn(
      'dsh-auto-compact: ctx.compaction is not composed in this realm; the plugin is mounted but inactive. ' +
      'Place this row inside the preset group that also mounts compaction-basic.',
    )
    return
  }

  const warned = {
    noRange: new WeakSet(),
    stillAbove: new WeakSet(),
  }

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    try {
      await enforceThreshold(ctx, compaction, agent, config, signal, warned)
    } catch (error) {
      if (!signal.aborted) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`dsh-auto-compact: automatic compaction failed (${message}); continuing the turn`)
      }
    }
    return next()
  })
}

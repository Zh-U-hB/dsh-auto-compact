/**
 * dsh-auto-compact — host-plane plugin.
 *
 * Automatic compaction for DeepSeek Harness sessions: when the session's
 * measured context (ctx.tokenMeter) reaches an absolute token threshold,
 * compact the older surface through the harness's built-in compaction
 * service (`ctx.compaction`) — the exact same engine behind the built-in
 * `/compact` command — before the next model step starts.
 *
 * The plugin is mounted ONCE on the host plane (as a profile bundle) and
 * listens to `agent/pre-step` for EVERY session in the process. For each
 * agent it resolves that agent's own preset-isolated `ctx.compaction`
 * instance — directly when it is visible, otherwise through the official
 * `serviceForAgent(ctx, agent, 'compaction')` read-addressing helper from
 * `@deepseek-ai/dsh-agent-presets` — so it works no matter which agent preset
 * mounted the compaction backend. Standard, locally authored presets, resumed
 * sessions, and subagents all share the same threshold policy.
 *
 * This file has no static runtime imports, so it can be installed as a linked
 * local package; the one helper package it needs is loaded lazily through the
 * harness loader's own module resolver (`ctx.loader.internal`).
 */

export const name = 'dsh-auto-compact'

/** tokenMeter lives on the host plane in every profile. */
export const inject = ['tokenMeter']

const DEFAULT_THRESHOLD_TOKENS = 262144 // 256 * 1024
const DEFAULT_RETAIN_TOKENS = 32768 // 32K
const DEFAULT_MAX_COMPACTIONS = 3
const CONFIG_KEYS = new Set(['thresholdTokens', 'retainTokens', 'maxCompactions', 'enabled'])
const SETTINGS_NAMESPACE = 'auto-compact'

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

/**
 * Build a best-effort surface-only measurement when `ctx.tokenMeter.measure`
 * cannot replay a session log (for example a log interrupted across a step
 * boundary lacks a matching `step/start` for an `assistant/message`).
 *
 * The built-in compaction backend calls `tokenMeter.measure` internally as
 * well, so the fallback is installed on the tokenMeter instance itself and
 * only activates when the real replay throws. Normal sessions are unaffected.
 */
function estimateSurfaceMeasurement(ctx, session) {
  const nodes = []
  let surfaceTokens = 0
  const surface = session?.surface?.nodes
  if (Array.isArray(surface)) {
    for (const seq of surface) {
      const event = session?.events?.[seq]
      const message = event?.type === 'user/message' ? event?.data : event?.data?.message
      let tokens = 0
      if (message !== undefined && typeof ctx.tokenMeter.estimateMessage === 'function') {
        try {
          tokens = ctx.tokenMeter.estimateMessage(message)
        } catch {
          tokens = 0
        }
      }
      if (!Number.isFinite(tokens) || tokens < 0) tokens = 0
      nodes.push({ seq, tokens })
      surfaceTokens += tokens
    }
  }
  return {
    baseline: { kind: 'estimated', tokens: surfaceTokens },
    surfaceTokens,
    totalTokens: surfaceTokens,
    nodes,
  }
}

const METER_WRAP_FLAG = Symbol.for('dsh-auto-compact.meterMeasureFallback')

function rawTokenMeter(ctx) {
  try {
    const impl = ctx.reflect?._getImpl?.('tokenMeter')
    if (impl?.value !== undefined) return impl.value
  } catch {}
  try {
    return ctx.fiber?.store?.tokenMeter?.value
  } catch {}
  return ctx.tokenMeter
}

/**
 * Wrap the live tokenMeter instance once per process. When the platform's
 * replay-aware `measure()` throws (a corrupted/interrupted log), return the
 * surface-only estimate instead of failing the compaction path entirely.
 */
function installMeterFallback(ctx, warnedMeter) {
  const meter = rawTokenMeter(ctx)
  if (meter === undefined || typeof meter.measure !== 'function') return
  if (meter.measure[METER_WRAP_FLAG]) return
  const original = meter.measure.bind(meter)
  const wrapped = function measureWithFallback(session, requestHeader) {
    try {
      return original(session, requestHeader)
    } catch (error) {
      if (!warnedMeter.has(session)) {
        warnedMeter.add(session)
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`dsh-auto-compact: tokenMeter replay failed (${message}); using a surface-only estimate for compaction decisions`)
      }
      return estimateSurfaceMeasurement(ctx, session)
    }
  }
  Object.defineProperty(wrapped, METER_WRAP_FLAG, { value: true })
  try {
    meter.measure = wrapped
  } catch {
    // The fallback is best-effort: if the instance is sealed, keep the
    // unwrapped behavior rather than failing plugin load.
  }
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
 * Resolve the compaction backend that belongs to THIS agent.
 *
 * The direct `agent.ctx.get('compaction')` path works on host-plane profiles
 * (headless/CLI) and for presets that publish the service into a visible
 * realm. In the web profile the preset's compaction service lives inside an
 * isolated realm that is invisible from the host plane, so the official
 * `serviceForAgent(ctx, agent, 'compaction')` read-addressing helper from
 * `@deepseek-ai/dsh-agent-presets` is used.
 *
 * Presets without a compaction backend — the shipped `minimal` preset is
 * deliberately "context compaction is absent" — get a fallback: the plugin
 * mounts a non-automatic `compaction-basic` engine directly into the agent's
 * context and drives it from the same absolute-threshold pre-step check. The
 * preset stays minimal (no `/compact` command, no pruner, no built-in ratio
 * pressure); dsh-auto-compact supplies the trigger, and the harness's own
 * engine performs the durable compaction.
 *
 * Both helper packages are imported lazily through the harness loader's own
 * module resolver, keeping this file free of static imports (and therefore
 * installable as a linked local package).
 */
function loadFallbackEngineClass(ctx, engineState) {
  const internal = ctx.loader?.internal
  if (internal === undefined || typeof internal.import !== 'function') return undefined
  engineState.promise ??= internal.import('@deepseek-ai/dsh-compaction-basic', ctx.baseUrl ?? import.meta.url, {})
    .then((resolved) => {
      const Engine = resolved?.BasicCompactionEngine ?? resolved?.default
      return typeof Engine === 'function' ? Engine : undefined
    })
    .catch(() => undefined)
  return engineState.promise
}

async function mountFallbackCompaction(ctx, agent, fallbackEngines, engineState) {
  const cached = fallbackEngines.get(agent)
  if (cached !== undefined) return cached

  const Engine = await loadFallbackEngineClass(ctx, engineState)
  if (Engine === undefined) return undefined
  try {
    const backend = new Engine(agent.ctx, { auto: false })
    if (typeof backend?.compactRegion !== 'function') return undefined
    fallbackEngines.set(agent, backend)
    ctx.logger.info(`dsh-auto-compact: agent "${agent.id}" preset mounts no ctx.compaction; using a plugin-owned compaction-basic fallback engine`)
    return backend
  } catch {
    return undefined
  }
}

async function resolveCompaction(ctx, agent, fallbackEngines, engineState) {
  const direct = typeof agent?.ctx?.get === 'function' ? agent.ctx.get('compaction') : undefined
  if (direct !== undefined && typeof direct.compactRegion === 'function') return direct

  const internal = ctx.loader?.internal
  if (typeof internal?.import === 'function') {
    try {
      const resolved = await internal.import('@deepseek-ai/dsh-agent-presets', ctx.baseUrl ?? import.meta.url, {})
      const serviceForAgent = resolved?.serviceForAgent
      if (typeof serviceForAgent === 'function') {
        const addressed = serviceForAgent(ctx, agent, 'compaction')
        if (addressed !== undefined && typeof addressed.compactRegion === 'function') return addressed
      }
    } catch {
      // fall through to the plugin-owned fallback engine
    }
  }

  return mountFallbackCompaction(ctx, agent, fallbackEngines, engineState)
}

/**
 * Register the `auto-compact` user-settings namespace when a settings
 * provider exists (the web profile does; headless profiles may not). The
 * schema exposes exactly one field — `thresholdTokens` — which the client
 * settings card reads/writes, and the composition entry config stays the
 * base layer so a GUI edit wins while an unset field falls back to the row.
 *
 * Like the compaction resolver, schemastery is imported through the harness
 * loader so this file keeps working as a linked local package.
 */
async function importSchemastery(ctx) {
  const internal = ctx.loader?.internal
  if (typeof internal?.import !== 'function') return undefined
  try {
    const resolved = await internal.import('@deepseek-ai/schemastery', ctx.baseUrl ?? import.meta.url, {})
    const schemas = resolved?.default ?? resolved
    return typeof schemas?.object === 'function' ? schemas : undefined
  } catch {
    return undefined
  }
}

function buildSettingsSchema(z) {
  return z.object({
    thresholdTokens: z.union([
      z.number().step(1).min(1),
      z.string().min(1),
    ]).default(DEFAULT_THRESHOLD_TOKENS),
  })
}

function installSettings(ctx, rawConfig, onConfig, onScope) {
  if (typeof ctx.inject !== 'function') return
  void (async () => {
    const z = await importSchemastery(ctx)
    if (z === undefined) {
      ctx.logger.warn('dsh-auto-compact: settings UI is unavailable (@deepseek-ai/schemastery could not be resolved); configure the threshold in the bundle row instead')
      return
    }
    // The injected callback itself is synchronous: an async Cordis fiber would
    // be disposed as soon as it returned its promise, taking the namespace
    // registration effect down with it.
    ctx.inject(['settings'], (sctx) => {
      const scope = sctx.settings.register(SETTINGS_NAMESPACE, buildSettingsSchema(z), {
        base: rawConfig.thresholdTokens === undefined ? {} : { thresholdTokens: rawConfig.thresholdTokens },
      })
      const publish = () => {
        try {
          onConfig({ ...rawConfig, ...scope.get() })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`dsh-auto-compact: settings value rejected (${message})`)
        }
      }
      scope.watch(publish)
      publish()
      onScope?.(scope)
    })
  })().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`dsh-auto-compact: settings registration failed (${message})`)
  })
}

/**
 * The web API proxy intentionally exposes only a hardcoded settings-namespace
 * allowlist (`dsh-host-apiproxy`), so a third-party namespace is not readable
 * through the generic `settings.describe` wire face. The settings card in
 * `lib/client.js` therefore talks to this small plugin-owned HTTP route,
 * which bridges to the same platform settings service on the host side.
 */
const SETTINGS_HTTP_PATH = '/dsh-auto-compact/settings'

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function isSameOriginRequest(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

async function readJsonBody(req, limit = 65536) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new Error('request body is too large')
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const value = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
  } catch {
    const error = new Error('request body must be JSON')
    error.statusCode = 400
    throw error
  }
}

function settingsUserOverrides(settings) {
  try {
    const descriptor = settings.describe({}).find((entry) => entry.ns === SETTINGS_NAMESPACE)
    return descriptor?.user?.thresholdTokens !== undefined
  } catch {
    return false
  }
}

function installSettingsHttp(ctx, getScope) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer', 'settings'], (sctx) => {
    sctx.effect(() => sctx.webServer.register({
      kind: 'prefix',
      path: SETTINGS_HTTP_PATH,
      handler: async (req, res) => {
        if (!isSameOriginRequest(req)) {
          sendJson(res, 403, { ok: false, error: 'cross-origin settings requests are not allowed' })
          return
        }
        if (req.method === 'GET') {
          const scope = getScope()
          const current = scope?.get() ?? sctx.settings.get(SETTINGS_NAMESPACE)
          if (current === undefined) {
            sendJson(res, 503, { ok: false, error: 'auto-compact settings are still loading' })
            return
          }
          sendJson(res, 200, {
            ok: true,
            thresholdTokens: current.thresholdTokens,
            overridden: settingsUserOverrides(sctx.settings),
          })
          return
        }
        if (req.method === 'POST') {
          const scope = getScope()
          if (scope === undefined) {
            sendJson(res, 503, { ok: false, error: 'auto-compact settings are still loading' })
            return
          }
          try {
            const body = await readJsonBody(req)
            if (body.unset === true) {
              await sctx.settings.mutate(SETTINGS_NAMESPACE, [{ op: 'unset', path: ['thresholdTokens'] }])
            } else if (body.thresholdTokens !== undefined) {
              await sctx.settings.update(SETTINGS_NAMESPACE, { thresholdTokens: body.thresholdTokens })
            } else {
              sendJson(res, 400, { ok: false, error: 'missing thresholdTokens' })
              return
            }
            const current = sctx.settings.get(SETTINGS_NAMESPACE)
            sendJson(res, 200, {
              ok: true,
              thresholdTokens: current?.thresholdTokens,
              overridden: settingsUserOverrides(sctx.settings),
            })
          } catch (error) {
            const status = typeof error?.statusCode === 'number' ? error.statusCode : 400
            const message = error instanceof Error ? error.message : String(error)
            sendJson(res, status, { ok: false, error: message })
          }
          return
        }
        res.writeHead(405, { allow: 'GET, POST' })
        res.end()
      },
    }), 'dsh-auto-compact: settings HTTP route')
  })
}

/**
 * Install the automatic threshold check on the agent/pre-step waterfall.
 *
 * Compaction failures never veto the step: the built-in backend already
 * reports its own failures through the session log, and this wrapper logs a
 * warning and lets the model request proceed exactly as before.
 */
export function apply(ctx, rawConfig) {
  rawConfig ??= {}
  let config = resolveConfig(rawConfig)
  if (!config.enabled) return

  let settingsScope
  installSettings(ctx, rawConfig, (nextRaw) => {
    const next = resolveConfig(nextRaw)
    if (next.thresholdTokens !== config.thresholdTokens) {
      ctx.logger.info(`dsh-auto-compact: threshold set to ${formatCount(next.thresholdTokens)} tokens`)
    }
    config = next
  }, (scope) => {
    settingsScope = scope
  })
  installSettingsHttp(ctx, () => settingsScope)

  const warned = {
    noRange: new WeakSet(),
    stillAbove: new WeakSet(),
    missingCompaction: new WeakSet(),
    meterFallback: new WeakSet(),
    fallbackEngines: new WeakMap(),
    fallbackEngineClass: { promise: undefined },
  }

  installMeterFallback(ctx, warned.meterFallback)

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const compaction = await resolveCompaction(ctx, agent, warned.fallbackEngines, warned.fallbackEngineClass)
    if (compaction === undefined || typeof compaction.compactRegion !== 'function') {
      if (!warned.missingCompaction.has(agent)) {
        warned.missingCompaction.add(agent)
        ctx.logger.warn(
          `dsh-auto-compact: agent "${agent.id}" has no ctx.compaction service and no fallback engine could be mounted; ` +
          'threshold compaction is skipped for this agent',
        )
      }
      return next()
    }
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

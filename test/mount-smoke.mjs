/**
 * mount-smoke.mjs — one-shot smoke check for dsh-auto-compact.
 *
 * Compose a fresh agent from a local preset (same path the web surface uses),
 * confirm that the preset mounts without error and that the built-in
 * compaction service is reachable from the agent realm, then exit WITHOUT
 * making any model request.
 *
 * Run through the headless profile with a patch overlay that disables the
 * headless runner and inserts agent-presets + this file.
 */

import { randomUUID } from 'node:crypto'

export const name = 'auto-compact-mount-smoke'
export const inject = ['agents', 'agentPresets']

const PRESET_ID = process.env.SMOKE_PRESET ?? 'anchored-standard'

function fail(exit, error) {
  process.stderr.write(`mount-smoke: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  exit(1)
}

async function run(ctx) {
  await ctx.get('loader')?.await()
  const handle = await ctx.agents.create({
    sessionId: `auto-compact-smoke-${randomUUID()}`,
    meta: { cwd: process.cwd(), agentPreset: PRESET_ID },
    agentOptions: { provider: 'auto-compact-smoke', model: 'auto-compact-smoke' },
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, PRESET_ID)
    },
  })

  const compaction = handle.agent.ctx.get('compaction')
  if (compaction === undefined) {
    throw new Error(`preset '${PRESET_ID}' mounted but ctx.compaction is missing from the agent realm`)
  }

  await handle.dispose()
  process.stdout.write(`AUTO_COMPACT_SMOKE_OK preset=${PRESET_ID}\n`)
}

export function apply(ctx) {
  const exit = ctx.get('appExit') ?? ((code) => process.exit(code))
  void run(ctx).then(
    () => exit(0),
    (error) => fail(exit, error),
  )
}

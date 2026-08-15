# dsh-auto-compact

A DeepSeek Harness plugin that automatically invokes the harness's built-in
compaction engine (the same `ctx.compaction` backend behind `/compact`) when a
session's measured context reaches a configurable absolute token threshold.
Default threshold: **262144 tokens (256K)**.

[中文](README.zh.md)

## Why it covers every session

The plugin is installed on the **host plane** as a profile bundle, not inside
one agent preset:

- it listens to `agent/pre-step` process-wide, so it applies to **every
  session**;
- it resolves each agent's own `ctx.compaction` via
  `agent.ctx.get('compaction')`, so it works regardless of which preset the
  session uses (standard / minimal / custom, including subagents);
- resumed sessions are covered too — no need to create a new session.

## Features

- Measures context with `ctx.tokenMeter` before every model step.
- At the threshold, compacts an older span through the built-in
  `ctx.compaction.compactRegion()`.
- Configurable threshold, default `262144` (256K); keeps a `32768`-token tail;
  up to `3` compactions per check.
- Failures are logged and never interrupt the turn.
- Tool-call/tool-result pairs are never split by the compaction cut.

## Requirements

- DeepSeek Harness `0.1.0-rc.6`
- `dsh` and `pnpm` on `PATH`
- Presets used by sessions must mount `@deepseek-ai/dsh-compaction-basic`
  (official standard/code/cordis and `minimal-compact`/`anchored-standard`
  already do; presets without a compaction backend are skipped automatically).

## Install

```bash
cd /path/to/dsh-auto-compact
./install.sh
```

The script removes legacy preset-local rows and runs
`dsh plugin --profile web add <plugin-dir>`, which appends the bundle and the
row:

```yaml
- id: auto-compact
  name: dsh-auto-compact
```

Then restart the web surface and hard-refresh the browser:

```bash
dsh web
```

## Configuration

Edit `~/.dsh/profiles/web/cordis.patch.yml`; this config applies to every
session in the profile:

```yaml
- id: auto-compact
  config:
    thresholdTokens: 262144   # 256K; 128k / 1m also accepted
    retainTokens: 32768
    maxCompactions: 3
    enabled: true
```

Restart `dsh web` after changes.

## Uninstall

```bash
./uninstall.sh
```

## License

[MIT](LICENSE)

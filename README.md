# dsh-auto-compact

A DeepSeek Harness plugin that automatically invokes the harness's built-in
compaction engine (the same `ctx.compaction` backend behind `/compact`) when a
session's measured context reaches a configurable absolute token threshold.
The default threshold is **262144 tokens (256K)**.

[中文](README.zh.md)

## Features

- Measures the session context with `ctx.tokenMeter` on every `agent/pre-step`.
- Once the threshold is reached, selects an older span and compacts it through
  the built-in `ctx.compaction.compactRegion()`.
- Configurable threshold, default `262144` tokens (256K).
- Keeps a recent verbatim tail, default `32768` tokens (32K).
- Up to `3` consecutive compactions per check.
- Compaction failures are logged and never interrupt the turn.
- Safe cuts: an unanswered assistant tool call is never separated from its result.

## Requirements

- DeepSeek Harness `0.1.0-rc.6`
- A target agent preset that already mounts `@deepseek-ai/dsh-compaction-basic`
  (the backend of the built-in `/compact`; the official standard/code/cordis
  presets and `minimal-compact` / `anchored-standard` all do)

## Install

In the web profile, the compaction service lives inside each **agent preset**,
not in the profile bundle, so this plugin is installed into local presets:

```bash
cd /path/to/dsh-auto-compact
./install.sh
```

The script scans `~/.dsh/.agent-presets`, and for every preset that already
contains `compaction-basic` it:

1. copies `lib/index.js` to `<preset>/dsh-auto-compact.mjs`;
2. inserts after the `compaction-basic` row:

```yaml
    - id: auto-compact
      name: ./dsh-auto-compact.mjs
      config:
        thresholdTokens: 262144
        retainTokens: 32768
        maxCompactions: 3
        enabled: true
```

Target one preset:

```bash
./install.sh --preset anchored-standard
./install.sh --preset anchored-standard --threshold 128k
```

After installation, **start a new session** (or restart `dsh web`). Existing
sessions keep the preset generation they were created with and are not
hot-switched.

## Configuration

Edit the `auto-compact` row in
`~/.dsh/.agent-presets/<preset-id>/agent.cordis.yml`:

| Key | Default | Meaning |
|---|---|---|
| `thresholdTokens` | `262144` | Automatic compaction threshold; number or `128k` / `1m` |
| `retainTokens` | `32768` | Minimum recent tail kept verbatim |
| `maxCompactions` | `3` | Maximum consecutive compactions per check |
| `enabled` | `true` | Set to `false` to pause without uninstalling |

Changes apply to sessions created afterwards.

## Relationship to built-in auto compaction

The built-in `compaction-basic` already auto-compacts at a context-window ratio
(default 0.8). This plugin runs after it and adds an absolute-token policy:

- If the built-in ratio policy fires first, this plugin re-measures and stays
  idle.
- If your absolute threshold is lower than the built-in ratio threshold, this
  plugin fires first.
- Both share the same `ctx.compaction` service: lock, durability, summary format.

## Uninstall

```bash
./uninstall.sh
# or
./uninstall.sh --preset anchored-standard
```

The script removes the `auto-compact` row block from `agent.cordis.yml` and
deletes `dsh-auto-compact.mjs`.

## Safety

- Read-only use of platform services (`ctx.tokenMeter`, `ctx.compaction`);
  no HTTP endpoints or tools are registered.
- All compaction mechanics (range validation, tool pairing, summarization,
  durable lock, persistence) run inside the harness's built-in backend.
- Zero runtime npm dependencies; mounted as a local file inside the preset.

## License

[MIT](LICENSE)

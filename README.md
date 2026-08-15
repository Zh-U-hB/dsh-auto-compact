# dsh-auto-compact

[English](#dsh-auto-compact) | [中文](./README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that
**automatically compacts a session once its measured context reaches a
configurable absolute token threshold**.

It does not invent a new summarizer: it drives the harness's built-in
compaction engine — the exact `ctx.compaction` service behind the built-in
`/compact` command — through the same durable, lock-protected surface
replacement path. The only thing this plugin adds is a user-controlled
**absolute threshold policy**.

Default threshold: **262144 tokens (256K)**.

---

## Table of contents

- [Why it exists](#why-it-exists)
- [How it works](#how-it-works)
- [Coverage: every session, every preset](#coverage-every-session-every-preset)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Behavior and semantics](#behavior-and-semantics)
- [Logging](#logging)
- [Uninstallation](#uninstallation)
- [Local development and tests](#local-development-and-tests)
- [Repository layout](#repository-layout)
- [Compatibility](#compatibility)
- [Troubleshooting](#troubleshooting)
- [Security model](#security-model)
- [License](#license)

---

## Why it exists

The harness's built-in `@deepseek-ai/dsh-compaction-basic` backend already
compacts automatically, but its trigger is **relative**: a fraction of the
current model's context window (`thresholdRatio`, default `0.8`).

That is a great default, but some users want a policy that does not move when
the routed model changes:

| Policy | Built-in | This plugin |
|---|---|---|
| Trigger | `0.8 × model context window` | explicit token count, e.g. `262144` |
| Default | varies with the model | `262144` (256K) |
| Scope | one compaction backend instance | process-wide, per-session backend resolution |
| Manual `/compact` | still available | still available |

When the absolute threshold is lower than the built-in ratio threshold, this
plugin fires first. When it is higher, the built-in policy may fire first and
this plugin re-measures and stays idle — both share the same engine, lock, and
summary format, so they cannot double-compact the same span concurrently.

---

## How it works

```text
agent/pre-step (every session)
        │
        ▼
ctx.tokenMeter.measure(agent.session)
        │
        │  totalTokens < thresholdTokens ?
        ├── yes ──▶ do nothing, continue the step
        │
        ▼ no
resolve the agent's own compaction backend:
        agent.ctx.get('compaction')
        │
        ├── absent ──▶ one warning per agent, skip (preset has no /compact)
        │
        ▼ present
select the older, tool-pair-balanced surface span
(keep a recent tail worth at least retainTokens)
        │
        ▼
ctx.compaction.compactRegion(start, end, agent, signal)
        │
        ▼
re-measure; compact again if still above the threshold
(up to maxCompactions times per check)
        │
        ▼
continue the model step no matter what happened
```

Key points:

1. **Measurement** uses the platform's own `ctx.tokenMeter`, the same replay-aware
   estimator the built-in compaction backend consumes. `totalTokens` includes the
   latest durable request envelope plus the current conversation surface.
2. **Range selection** walks the token-priced surface from the tail, keeps a
   recent verbatim budget (`retainTokens`), and snaps the cut backwards until no
   unanswered assistant `tool-call`/`tool-result` pair is split.
3. **Execution** is the built-in `ctx.compaction.compactRegion()` call: the
   compaction backend records its durable `compaction/start` … `compaction/end`
   bracket, asks the model for a summary, and replaces the selected surface span
   with one user-role checkpoint. All lock, persistence, retry, and summary
   semantics belong to the harness, not to this plugin.
4. **Failure handling** is non-blocking. A failed or impossible compaction is
   logged and the model step continues unchanged; this plugin never vetoes a turn.

---

## Coverage: every session, every preset

The plugin is installed **on the host plane** (a profile bundle), not inside a
single agent preset:

- It registers one `agent/pre-step` listener process-wide.
- For every event it asks the *agent itself* for its compaction service
  (`agent.ctx.get('compaction')`), so the correct per-preset, per-session
  isolated backend instance is used.
- Consequently it works for:
  - every agent preset that mounts a compaction backend
    (`standard`, `code`, `cordis`, local `minimal-compact`, `anchored-standard`, …);
  - fresh sessions, resumed sessions, and sessions loaded after a restart;
  - top-level agents and subagents.

Presets that intentionally mount no compaction backend (for example the shipped
`minimal` preset, which has no `/compact` at all) are detected and skipped with
a single warning per agent. There is nothing to compact with there.

---

## Features

- Absolute, user-configurable threshold — default `262144` tokens (256K).
- Human-friendly values accepted: `262144`, `"256k"`, `"256K"`, `"1m"`.
- Configurable verbatim tail (`retainTokens`, default `32768`).
- Configurable per-check retry cap (`maxCompactions`, default `3`).
- Configurable kill switch (`enabled`, default `true`).
- Tool-call/tool-result aware cuts — never splits an open tool pairing.
- Zero runtime npm dependencies; pure ESM host plugin.
- All compaction work executes inside the harness's built-in backend.
- Idempotent installer and uninstaller.

---

## Requirements

| Requirement | Version / note |
|---|---|
| DeepSeek Harness | `0.1.0-rc.6` (web profile developed and verified against) |
| `dsh` on `PATH` | launcher for `dsh plugin ...` |
| `pnpm` on `PATH` | used internally by `dsh plugin` |
| Node.js | `>= 20` (the plugin itself is dependency-free) |
| Preset compaction backend | sessions should use a preset that mounts `@deepseek-ai/dsh-compaction-basic` |

---

## Installation

### From a local checkout

```bash
git clone https://github.com/Zh-U-hB/dsh-auto-compact.git
cd dsh-auto-compact
./install.sh
```

Or, if the repository is already checked out:

```bash
cd /path/to/dsh-auto-compact
./install.sh
```

### What `install.sh` does

1. Removes any rows a pre-1.0 prototype may have written into
   `~/.dsh/.agent-presets/*/agent.cordis.yml`.
2. Runs:

   ```bash
   dsh plugin --profile web add /absolute/path/to/dsh-auto-compact
   ```

   Because `package.json` declares `dsh.bundle.patch`, `dsh plugin` appends the
   bundle to the web profile and inserts the row:

   ```yaml
   - id: auto-compact
     name: dsh-auto-compact
   ```

### Activate

Profile bundles are loaded when the process boots, so restart the web surface:

```bash
# Ctrl+C in the terminal running dsh web, then:
dsh web
```

Then hard-refresh the browser once (`Cmd+Shift+R` / `Ctrl+Shift+R`).

From that point on the policy is active for **every session in the process**,
including sessions you resume afterwards.

### Install into another profile

```bash
DSH_PROFILE=tui ./install.sh        # or any other profile name
```

For profiles without agent presets, the plugin still works as long as the
profile composes a `ctx.compaction` backend and `ctx.tokenMeter` on the host
plane (the standard `dsh-base` composition does).

---

## Configuration

Edit the profile's own patch layer:

```text
~/.dsh/profiles/web/cordis.patch.yml
```

Default configuration (this block is optional — every key shown is the default):

```yaml
- id: auto-compact
  config:
    thresholdTokens: 262144   # 256 × 1024; "256k" / "1m" also accepted
    retainTokens: 32768       # minimum recent tail kept verbatim
    maxCompactions: 3         # maximum consecutive compactions per check
    enabled: true             # false pauses the plugin without uninstalling
```

Examples:

```yaml
# Compact earlier: at 128K tokens.
- id: auto-compact
  config:
    thresholdTokens: 131072
```

```yaml
# Use human units and keep a larger tail.
- id: auto-compact
  config:
    thresholdTokens: 256k
    retainTokens: 64k
```

```yaml
# Pause without uninstalling.
- id: auto-compact
  config:
    enabled: false
```

Restart `dsh web` after changing the profile patch.

### Validation rules

- `thresholdTokens` and `retainTokens` must be positive integers (or
  human-unit strings that resolve to one).
- `retainTokens < thresholdTokens`.
- `maxCompactions` must be a positive integer.
- Unknown config keys fail plugin load with a descriptive error, so a typo
  cannot silently fall back to defaults.

---

## Behavior and semantics

### When the check runs

The check runs on the `agent/pre-step` waterfall — immediately before the model
request for a step is assembled. Because compaction then runs inside the open
turn, the compaction backend's automatic path is used, which is the same
mechanism the built-in ratio policy uses.

### What "context reached the threshold" means

`ctx.tokenMeter.measure(session).totalTokens` is used. It is the harness's own
replay-aware estimate of the latest durable request envelope plus the current
conversation surface. It is an estimate, not a provider-exact token count, and
it is deliberately the same number the built-in compaction backend compares
against.

### What happens when compaction is impossible

- No safe cut exists (for example, the tail is one huge unfinished tool unit):
  one warning is logged per session until the condition clears.
- The threshold is reached but the backend refuses (`busy`, `changed`,
  `summary`, `commit`, `persistence`, …): the error is logged and the step
  continues.
- The threshold is still exceeded after `maxCompactions` attempts: the plugin
  logs a warning and continues the turn. A single oversized indivisible node
  cannot be repaired by surface compaction — the same limitation the built-in
  backend documents.

### Relationship with the built-in `/compact` command

`/compact` keeps working exactly as before. The manual command compacts one
useful balanced span below pressure thresholds on an idle agent; this plugin
compacts at step boundaries when the absolute threshold is crossed. Both use
the same `ctx.compaction` implementation and therefore the same durable lock,
so concurrent or nested runs are impossible.

### Threshold policy and model changes

Because the threshold is absolute, switching the routed model does not change
when this plugin fires. The built-in ratio policy still runs alongside it and
may fire earlier for models with a small context window; that is intentional
and safe.

---

## Logging

All messages are prefixed with `dsh-auto-compact:` and use the harness logger:

| Level | Message pattern | Meaning |
|---|---|---|
| `info` | `context at N tokens reached the ... threshold` | a compaction attempt starts |
| `info` | `compacted N history items (~N tokens shadowed)` | an attempt succeeded |
| `warn` | `no tool-pair-balanced older span is compactable` | threshold exceeded, nothing safe to compact (rate-limited per session) |
| `warn` | `context is still at N tokens after N compaction attempt(s)` | retry cap exhausted (rate-limited per session) |
| `warn` | `agent "..." has no ctx.compaction service` | the session's preset mounts no backend (once per agent) |
| `warn` | `automatic compaction failed (...)` | backend error; the turn continues |

---

## Uninstallation

```bash
./uninstall.sh
```

The script runs:

```bash
dsh plugin --profile web remove dsh-auto-compact
```

and also removes any legacy preset-local rows. Restart `dsh web` afterwards.

---

## Local development and tests

No package installation is required for development: the runtime plugin has no
dependencies.

```bash
npm test        # node --test unit + integration-style apply tests
npm run check   # syntax-check plugin and scripts, then run tests
```

Test coverage:

- config parsing/validation (defaults, `128k`/`1m`, rejections);
- balanced-cut folding around open tool pairings;
- surface-span selection against token-meter measurements;
- `apply()` behavior: threshold reached, below threshold, backend throwing,
  missing backend (warning once per agent).

A `test/mount-smoke.mjs` helper is included for one-shot headless checks that a
preset composition mounts and exposes `ctx.compaction` without making any model
request.

---

## Repository layout

```text
dsh-auto-compact/
├── lib/
│   └── index.js              # the entire host plugin (zero runtime imports)
├── scripts/
│   └── manage-presets.mjs    # legacy preset-row cleanup helper
├── test/
│   ├── unit.test.mjs         # config + range-selection unit tests
│   ├── apply.test.mjs        # apply() integration-style tests
│   └── mount-smoke.mjs       # headless preset-mount smoke helper
├── cordis.patch.yml          # bundle patch: inserts the auto-compact row
├── install.sh                # dsh plugin add wrapper
├── uninstall.sh              # dsh plugin remove wrapper
├── package.json              # package + dsh.bundle.patch metadata
└── README.md / README.zh.md
```

---

## Compatibility

Developed and verified against **DeepSeek Harness `0.1.0-rc.6`** (web profile).
The plugin depends on stable harness seams (`ctx.tokenMeter`,
`agent/pre-step`, `agent.ctx`, `ctx.compaction.compactRegion`) but these are
developer-preview internals: after a harness upgrade, re-run the test suite and
start a fresh session before relying on the plugin.

The installer works with the standard `dsh plugin` command and keeps the plugin
as a linked local package, so edits to your checkout are visible after the next
`dsh web` restart.

---

## Troubleshooting

### The plugin row is in `dsh --profile web --dump-config`, but nothing happens

The process must be restarted. Host-plane bundles are loaded at boot; editing
the profile on disk is not hot-reloaded into a running `dsh web`.

### A session never compacts

- Check `enabled` is not `false`.
- Check the session's preset actually mounts
  `@deepseek-ai/dsh-compaction-basic`; the shipped `minimal` preset does not.
- Check the harness log for the `dsh-auto-compact:` messages above.
- Remember the threshold counts the whole measured request envelope plus
  surface; a mostly-tool-call session can take longer to cross it than the raw
  transcript size suggests.

### A preset shows "has no ctx.compaction service"

That preset has no compaction backend. Either switch to a preset that includes
one, or compose `compaction-basic`/`command-compact` into it.

### I edited `cordis.patch.yml` and nothing changed

Profile patch changes also require a `dsh web` restart.

---

## Security model

- The plugin registers no HTTP endpoints, tools, commands, or settings writers.
- It only reads `ctx.tokenMeter` and invokes the existing `ctx.compaction`
  service that the session's preset already trusts.
- It never constructs file paths, performs I/O, or handles user input beyond
  validating its own YAML config.
- Every mutation of conversation history is performed by the harness's built-in
  compaction backend under its existing sandbox/durability rules.

---

## License

[MIT](./LICENSE)

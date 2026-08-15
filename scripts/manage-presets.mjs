#!/usr/bin/env node
/**
 * manage-presets.mjs — install/uninstall dsh-auto-compact into local agent
 * presets under $DSH_HOME/.agent-presets.
 *
 * The web profile keeps compaction inside each agent preset (not the profile
 * bundle), so this is the supported install path for the web surface.
 *
 * Usage:
 *   node scripts/manage-presets.mjs install [--preset <id>]... [--threshold <count>] [--all]
 *   node scripts/manage-presets.mjs uninstall [--preset <id>]... [--all]
 *
 * With no --preset and no --all, every local preset that already mounts
 * `compaction-basic` is patched. The copied file is `<preset>/dsh-auto-compact.mjs`
 * and the composition row is inserted directly after the `compaction-basic`
 * row, so `ctx.compaction` is guaranteed to be available when this plugin loads.
 */

import { constants as fsConstants } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_SOURCE = resolve(HERE, '../lib/index.js')
const COPIED_NAME = 'dsh-auto-compact.mjs'
const ROW_ID = 'auto-compact'

function usage() {
  process.stderr.write(
    'usage: node manage-presets.mjs <install|uninstall> [--preset <id>]... [--all] [--threshold <tokens>]\n',
  )
  process.exit(2)
}

function parseArgs(argv) {
  const args = { action: '', presets: [], all: false, threshold: 262144 }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--preset') {
      const value = argv[++index]
      if (value === undefined) usage()
      args.presets.push(value)
    } else if (arg === '--all') {
      args.all = true
    } else if (arg === '--threshold') {
      const value = argv[++index]
      if (value === undefined) usage()
      args.threshold = Number.isFinite(Number(value)) ? Number(value) : value
    } else if (args.action === '') {
      args.action = arg
    } else {
      usage()
    }
  }
  if (args.action !== 'install' && args.action !== 'uninstall') usage()
  return args
}

function tokenCountLiteral(value) {
  if (typeof value === 'number') return String(value)
  const text = String(value).trim()
  if (/^\d+$/.test(text)) return text
  return JSON.stringify(text)
}

function rowIndent(line) {
  const match = /^\s*/.exec(line)
  return match === null ? '' : match[0]
}

function findCompactionBasicRow(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*- id:\s*compaction-basic\s*$/.test(lines[index])) return index
  }
  return -1
}

function findAutoCompactRow(lines) {
  const pattern = new RegExp(`^\\s*- id:\\s*${ROW_ID}\\s*$`)
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) return index
  }
  return -1
}

/**
 * Find the insertion point for a new sibling row after `start`: the line just
 * before the next row that shares the anchor row's indentation (or EOF).
 */
function siblingBoundary(lines, start) {
  const indent = rowIndent(lines[start])
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*-\s/.test(line) && rowIndent(line) === indent) return index
  }
  return lines.length
}

/**
 * Remove the `auto-compact` row block: every indented line that follows the
 * row until the next sibling row at the same indentation.
 */
function stripAutoCompactRow(lines) {
  const out = []
  let removing = false
  let removeIndent = ''
  let removed = false
  for (const line of lines) {
    if (!removing) {
      const match = /^(\s*)- id:\s*auto-compact\s*$/.exec(line)
      if (match !== null) {
        removing = true
        removeIndent = match[1]
        removed = true
        continue
      }
      out.push(line)
      continue
    }
    const sibling = /^\s*-\s/.test(line)
    const indented = rowIndent(line)
    if (sibling && indented === removeIndent) {
      removing = false
      out.push(line)
    }
    // Indented lines (deeper than the row) belong to the removed block.
  }
  return { lines: out, removed }
}

function installRowBlock(indent, threshold) {
  return [
    `${indent}- id: ${ROW_ID}`,
    `${indent}  name: ./${COPIED_NAME}`,
    `${indent}  config:`,
    `${indent}    thresholdTokens: ${tokenCountLiteral(threshold)}`,
    `${indent}    retainTokens: 32768`,
    `${indent}    maxCompactions: 3`,
    `${indent}    enabled: true`,
  ].join('\n') + '\n'
}

async function ensurePluginFile(presetDir) {
  await copyFile(PLUGIN_SOURCE, join(presetDir, COPIED_NAME))
}

async function installPreset(presetDir, threshold) {
  const file = join(presetDir, 'agent.cordis.yml')
  const original = await readFile(file, 'utf8')
  if (!original.includes('- id: compaction-basic')) return { file, changed: false, reason: 'no compaction-basic row' }

  await ensurePluginFile(presetDir)

  const lines = original.split(/\r?\n/)
  if (findAutoCompactRow(lines) !== -1) return { file, changed: false, reason: 'already configured' }

  const anchor = findCompactionBasicRow(lines)
  if (anchor === -1) return { file, changed: false, reason: 'no compaction-basic row' }
  const indent = rowIndent(lines[anchor])
  const insertAt = siblingBoundary(lines, anchor)
  const block = installRowBlock(indent, threshold)
  lines.splice(insertAt, 0, block)
  const next = lines.join('\n').replace(/\n$/, '') + '\n'
  await writeFile(file, next, 'utf8')
  return { file, changed: true }
}

async function uninstallPreset(presetDir) {
  const file = join(presetDir, 'agent.cordis.yml')
  const original = await readFile(file, 'utf8')
  const { lines, removed } = stripAutoCompactRow(original.split(/\r?\n/))
  if (removed) {
    const next = lines.join('\n').replace(/\n$/, '') + '\n'
    await writeFile(file, next, 'utf8')
  }
  await rm(join(presetDir, COPIED_NAME), { force: true })
  return { file, changed: removed }
}

async function discoverPresets(presetRoot) {
  let entries
  try {
    entries = await readdir(presetRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = join(presetRoot, entry.name, 'agent.cordis.yml')
    try {
      await readFile(file)
    } catch {
      continue
    }
    found.push({ id: entry.name, dir: join(presetRoot, entry.name), file })
  }
  return found.sort((left, right) => left.id.localeCompare(right.id))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const presetRoot = process.env.DSH_PRESET_ROOT ?? join(dshHome, '.agent-presets')
  const discovered = await discoverPresets(presetRoot)

  const wanted = new Set(args.presets)
  const selected = args.all
    ? discovered
    : args.presets.length > 0
      ? discovered.filter((preset) => wanted.has(preset.id))
      : discovered

  if (args.presets.length > 0 && selected.length !== wanted.size) {
    const found = new Set(selected.map((preset) => preset.id))
    for (const id of wanted) if (!found.has(id)) console.error(`preset not found: ${id}`)
  }

  let done = 0
  let applicable = 0
  for (const preset of selected) {
    const result = args.action === 'install'
      ? await installPreset(preset.dir, args.threshold)
      : await uninstallPreset(preset.dir)
    if (args.action === 'install') {
      if (result.changed) {
        console.log(`installed into preset '${preset.id}': ${result.file}`)
        done += 1
      } else {
        console.log(`skipped preset '${preset.id}' (${result.reason})`)
      }
      if (result.reason !== 'no compaction-basic row') applicable += 1
    } else {
      console.log(`${result.changed ? 'uninstalled from' : 'clean preset'} '${preset.id}'`)
      done += result.changed ? 1 : 0
    }
  }

  if (args.action === 'install' && done === 0 && applicable > 0) {
    console.log('dsh-auto-compact: already installed in every applicable preset.')
    return
  }
  if (args.action === 'install' && done === 0) {
    console.error(
      'dsh-auto-compact: nothing installed — no local preset mounts compaction-basic. ' +
      'Add this row manually inside the preset group that mounts @deepseek-ai/dsh-compaction-basic.',
    )
    process.exit(1)
  }
}

main().catch((error) => {
  console.error(`dsh-auto-compact: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})

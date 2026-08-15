#!/usr/bin/env bash
set -euo pipefail

PROFILE="${DSH_PROFILE:-web}"
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v dsh >/dev/null 2>&1; then
  echo "dsh-auto-compact: dsh was not found on PATH" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "dsh-auto-compact: pnpm was not found on PATH (dsh plugin install uses pnpm)" >&2
  exit 1
fi

echo "==> removing any legacy preset-local dsh-auto-compact rows"
node "${PLUGIN_DIR}/scripts/manage-presets.mjs" uninstall >/dev/null 2>&1 || true

echo "==> installing dsh-auto-compact into profile '${PROFILE}' (host plane)"
dsh plugin --profile "${PROFILE}" add "${PLUGIN_DIR}"

echo
echo "Installed for EVERY session and agent preset in this profile."
echo "Restart the web surface to load the host plugin:"
echo
echo "  dsh web"
echo
echo "Then hard-refresh the browser once (Cmd+Shift+R / Ctrl+Shift+R)."

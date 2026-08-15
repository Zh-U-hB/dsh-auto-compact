#!/usr/bin/env bash
set -euo pipefail

PROFILE="${DSH_PROFILE:-web}"
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> removing dsh-auto-compact from profile '${PROFILE}'"
dsh plugin --profile "${PROFILE}" remove dsh-auto-compact || true

echo "==> removing any legacy preset-local dsh-auto-compact rows"
node "${PLUGIN_DIR}/scripts/manage-presets.mjs" uninstall || true

echo
echo "Uninstalled. Restart dsh to apply."

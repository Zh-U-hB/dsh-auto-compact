#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> installing dsh-auto-compact into local agent presets (default threshold: 256K tokens)"
node "${SCRIPT_DIR}/scripts/manage-presets.mjs" install "$@"

echo
echo "Installed. Start a NEW session (or restart dsh) to mount the updated preset:"
echo
echo "  dsh web"
echo
echo "Current sessions keep the preset generation they were created with and are"
echo "left untouched."

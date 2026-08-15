#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> removing dsh-auto-compact from local agent presets"
node "${SCRIPT_DIR}/scripts/manage-presets.mjs" uninstall "$@"

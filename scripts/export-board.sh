#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
REPO_ROOT=${SCRIPT_DIR:h}
timestamp="$(date +%Y-%m-%d-%H%M%S)"
OUTPUT_FILE="${1:-$HOME/Desktop/Aboard Backup $timestamp.json}"
OUTPUT_DIR="${OUTPUT_FILE:h}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" && -x "/Applications/Aboard.app/Contents/Resources/runtime/node" ]]; then
  NODE_BIN="/Applications/Aboard.app/Contents/Resources/runtime/node"
fi
[[ -n "$NODE_BIN" ]] || { echo "Node.js is required. Open Aboard once, then retry." >&2; exit 1; }
mkdir -p "$OUTPUT_DIR"
resolved_output="${OUTPUT_FILE:A}"
[[ "$resolved_output" != "$REPO_ROOT" && "$resolved_output" != "$REPO_ROOT"/* ]] || {
  echo "For privacy, Aboard backups cannot be written inside the source repository." >&2
  exit 1
}
"$NODE_BIN" "$REPO_ROOT/desktop/board-storage.mjs" backup "$resolved_output"
chmod 600 "$resolved_output"
echo "Saved private Aboard backup to $resolved_output"

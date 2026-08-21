#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
REPO_ROOT=${SCRIPT_DIR:h}
BOARD_FILE="${1:-}"
[[ -n "$BOARD_FILE" ]] || {
  echo "Usage: ./scripts/import-board.sh /path/to/private-backup.json" >&2
  exit 2
}
BOARD_FILE="${BOARD_FILE:A}"
[[ -f "$BOARD_FILE" && ! -L "$BOARD_FILE" ]] || { echo "Backup file not found: $BOARD_FILE" >&2; exit 1; }
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" && -x "/Applications/Aboard.app/Contents/Resources/runtime/node" ]]; then
  NODE_BIN="/Applications/Aboard.app/Contents/Resources/runtime/node"
fi
[[ -n "$NODE_BIN" ]] || { echo "Node.js is required." >&2; exit 1; }

timestamp="$(date +%Y-%m-%d-%H%M%S)"
SAFETY_BACKUP="$HOME/Desktop/Aboard Before Restore $timestamp.json"
"$NODE_BIN" "$REPO_ROOT/desktop/board-storage.mjs" backup "$SAFETY_BACKUP" || true
[[ ! -s "$SAFETY_BACKUP" ]] || chmod 600 "$SAFETY_BACKUP"
"$NODE_BIN" "$REPO_ROOT/desktop/board-storage.mjs" restore "$BOARD_FILE"
echo "Restored Aboard data from $BOARD_FILE"
if [[ -s "$SAFETY_BACKUP" ]]; then echo "Previous board saved to $SAFETY_BACKUP"; fi

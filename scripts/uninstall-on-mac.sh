#!/bin/zsh
set -euo pipefail

SOURCE_APP="/Applications/ChatGPT.app"
TARGET_APP="/Applications/Aboard.app"
SUPPORT_ROOT="$HOME/Library/Application Support/Conversation Dashboard"
PROFILE_ROOT="$SUPPORT_ROOT/ChatGPT Profile"
DATA_ROOT="$HOME/.codex/plugin-data/conversation-dashboard"
LOG_ROOT="$HOME/Library/Logs/Conversation Dashboard"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
runtime_pid=""

while IFS= read -r pid; do
  [[ -n "$pid" ]] || continue
  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if [[ "$command_line" == "$SOURCE_APP/Contents/MacOS/ChatGPT"* \
    && "$command_line" == *"--user-data-dir=$PROFILE_ROOT"* \
    && "$command_line" == *"--remote-debugging-port=9237"* ]]; then
    [[ -z "$runtime_pid" ]] || { echo "Multiple Aboard runtimes were found; uninstall stopped." >&2; exit 1; }
    runtime_pid="$pid"
  fi
done < <(/usr/bin/pgrep -x ChatGPT 2>/dev/null || true)

if [[ -n "$runtime_pid" ]]; then
  kill -TERM "$runtime_pid"
  for _ in {1..80}; do
    kill -0 "$runtime_pid" 2>/dev/null || break
    sleep 0.25
  done
  kill -0 "$runtime_pid" 2>/dev/null && { echo "Aboard is still running. Quit it normally and retry." >&2; exit 1; }
fi

CODEX_BIN="$SOURCE_APP/Contents/Resources/codex"
if [[ -x "$CODEX_BIN" ]]; then
  "$CODEX_BIN" plugin remove conversation-dashboard@personal >/dev/null 2>&1 || true
fi

if [[ -d "$TARGET_APP" && ! -L "$TARGET_APP" ]]; then
  "$LSREGISTER" -u "$TARGET_APP" >/dev/null 2>&1 || true
  /usr/bin/osascript -l JavaScript -e 'ObjC.import("Foundation"); ObjC.import("AppKit"); const path = "/Applications/Aboard.app"; const fm = $.NSFileManager.defaultManager; const url = $.NSURL.fileURLWithPath(path); const result = Ref(); const error = Ref(); if (!fm.trashItemAtURLResultingItemURLError(url, result, error)) throw new Error(ObjC.unwrap(error[0].localizedDescription));'
elif [[ -e "$TARGET_APP" ]]; then
  echo "Unexpected Aboard application type; uninstall stopped: $TARGET_APP" >&2
  exit 1
fi

echo "Aboard application and plugin were removed."
echo "Local Aboard data and diagnostic logs were preserved in three locations:"
echo "  Desktop profile and automatic install backups: $SUPPORT_ROOT"
echo "  Codex MCP board: $DATA_ROOT"
echo "  Local technical logs: $LOG_ROOT"
echo "None of these directories was removed. To delete all local Aboard data, first confirm no backup is needed, then move all three exact directories to Trash manually."

#!/bin/zsh
set -euo pipefail
umask 077

APP_ROOT="${0:A:h:h}"
SOURCE_APP="${ABOARD_SOURCE_APP:-/Applications/ChatGPT.app}"
SOURCE_RUNTIME="$SOURCE_APP/Contents/MacOS/ChatGPT"
DATA_ROOT="$HOME/Library/Application Support/Conversation Dashboard"
PROFILE_ROOT="$DATA_ROOT/ChatGPT Profile"
LOG_ROOT="$HOME/Library/Logs/Conversation Dashboard"
PORT=9237
DOCK_INSPECTOR_PORT=9238

secure_private_directory() {
  local directory="$1"
  if [[ -e "$directory" ]]; then
    [[ -d "$directory" && ! -L "$directory" ]] || {
      echo "Aboard refused an unsafe private data path: $directory" >&2
      return 1
    }
  else
    mkdir -p "$directory"
  fi
  chmod 700 "$directory"
}

secure_private_directory "$DATA_ROOT"
secure_private_directory "$PROFILE_ROOT"
secure_private_directory "$LOG_ROOT"
setopt local_options null_glob
for existing_log in "$LOG_ROOT"/*.log; do
  [[ -f "$existing_log" && ! -L "$existing_log" ]] || {
    echo "Aboard refused an unsafe log file: $existing_log" >&2
    exit 1
  }
  chmod 600 "$existing_log"
done
[[ -x "$SOURCE_RUNTIME" && ! -L "$SOURCE_RUNTIME" ]] || {
  echo "Aboard needs the official ChatGPT app in /Applications." >&2
  exit 1
}
if [[ "$SOURCE_APP" == "/Applications/ChatGPT.app" ]]; then
  "$APP_ROOT/Resources/dashboard/desktop/verify-official-runtime.zsh" "$SOURCE_APP"
elif [[ "${ABOARD_TEST_MODE:-}" != "1" ]]; then
  echo "Aboard refused an unverified ChatGPT runtime override." >&2
  exit 1
fi

# Aboard can be launched from inside a running Codex task (for example by the
# installer). Do not pass that task's process-scoped identity to the cloned
# desktop runtime: doing so makes Aboard resume the same task as the official
# app before the dashboard is injected, and both app servers then compete for
# the task writer. Keep the normal desktop-origin variables intact.
unset CODEX_THREAD_ID CODEX_SESSION_ID CODEX_CI

profile_is_in_use=false
if [[ "$SOURCE_APP" == "/Applications/ChatGPT.app" ]]; then
  while IFS= read -r candidate_pid; do
    [[ "$candidate_pid" == <-> ]] || continue
    candidate_command="$(ps -p "$candidate_pid" -o command= 2>/dev/null || true)"
    if [[ "$candidate_command" == "$SOURCE_RUNTIME"* && "$candidate_command" == *"--user-data-dir=$PROFILE_ROOT"* ]]; then
      profile_is_in_use=true
      break
    fi
  done < <(/usr/bin/pgrep -x ChatGPT 2>/dev/null || true)
fi

if [[ "$profile_is_in_use" != true ]]; then
  if ! "$APP_ROOT/Resources/runtime/node" \
    "$APP_ROOT/Resources/dashboard/desktop/prepare-runtime-profile.mjs" \
    "$PROFILE_ROOT" \
    >>"$LOG_ROOT/launcher.stdout.log" \
    2>>"$LOG_ROOT/launcher.stderr.log"; then
    print -r -- "Aboard profile preparation was skipped; startup will continue." >>"$LOG_ROOT/launcher.stderr.log"
  fi
fi

ABOARD_RUNTIME_PID=$$ "$APP_ROOT/Resources/runtime/node" \
  "$APP_ROOT/Resources/dashboard/desktop/launcher.mjs" \
  >>"$LOG_ROOT/launcher.stdout.log" \
  2>>"$LOG_ROOT/launcher.stderr.log" &

# Replace the LaunchServices-owned wrapper process with the untouched,
# Developer-ID-signed ChatGPT runtime. The supported user-data override keeps
# this board-only host separate from the user's official ChatGPT window.
export CODEX_ELECTRON_USER_DATA_PATH="$PROFILE_ROOT"
exec "$SOURCE_RUNTIME" \
  "--user-data-dir=$PROFILE_ROOT" \
  --remote-debugging-address=localhost \
  "--remote-debugging-port=$PORT" \
  "--remote-allow-origins=http://localhost:$PORT" \
  "--inspect=127.0.0.1:$DOCK_INSPECTOR_PORT" \
  >>"$LOG_ROOT/runtime.stdout.log" \
  2>>"$LOG_ROOT/runtime.stderr.log"

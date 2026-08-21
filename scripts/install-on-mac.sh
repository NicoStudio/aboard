#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
REPO_ROOT=${SCRIPT_DIR:h}
SOURCE_APP="/Applications/ChatGPT.app"
TARGET_APP="/Applications/Aboard.app"
LEGACY_RUNTIME_APP="/Applications/.Conversation Dashboard Runtime.app"
SUPPORT_ROOT="$HOME/Library/Application Support/Conversation Dashboard"
LEGACY_BACKUP_ROOT="$SUPPORT_ROOT/Legacy Apps"
READY_APP="/tmp/Aboard.ready.app"
READY_STAGING_APP="/tmp/Aboard.ready.building.app"
BOARD_BACKUP="$SUPPORT_ROOT/board-before-install-$(date +%Y%m%d-%H%M%S).json"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

secure_existing_board_backups() {
  local support_root="$1" backup
  if [[ -e "$support_root" ]]; then
    [[ -d "$support_root" && ! -L "$support_root" ]] || {
      echo "Unexpected Aboard support directory type: $support_root" >&2
      return 1
    }
  else
    mkdir -p "$support_root"
  fi
  setopt local_options null_glob
  for backup in "$support_root"/board-before-install-*.json; do
    [[ -f "$backup" && ! -L "$backup" ]] || {
      echo "Unexpected Aboard board backup type: $backup" >&2
      return 1
    }
    chmod 600 "$backup"
  done
}

ensure_marketplace_plugin_link() {
  local plugin_path="$1" repo_root="$2" current_real repo_real previous_target
  mkdir -p "${plugin_path:h}"
  repo_real="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$repo_root")"
  if [[ -L "$plugin_path" ]]; then
    current_real="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$plugin_path")"
    [[ "$current_real" == "$repo_real" ]] && return 0
    previous_target="$(readlink "$plugin_path")"
    [[ -n "$previous_target" ]] || { echo "Could not inspect the existing Aboard marketplace link." >&2; return 1; }
    unlink "$plugin_path"
    if ! ln -s "$repo_root" "$plugin_path"; then
      ln -s "$previous_target" "$plugin_path" >/dev/null 2>&1 || true
      echo "Could not update the Aboard marketplace link." >&2
      return 1
    fi
    return 0
  fi
  if [[ -e "$plugin_path" ]]; then
    echo "The Aboard marketplace path is a real file or directory and will not be overwritten: $plugin_path" >&2
    return 1
  fi
  ln -s "$repo_root" "$plugin_path"
}

port_is_open() {
  /usr/bin/nc -z 127.0.0.1 "$1" >/dev/null 2>&1
}

port_listener_pids() {
  /usr/sbin/lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}

stop_aboard_runtime() {
  local pid command_line parent matched root_pid=""
  local profile_root="$HOME/Library/Application Support/Conversation Dashboard/ChatGPT Profile"
  local listener_pids=()
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if [[ "$command_line" == "$SOURCE_APP/Contents/MacOS/ChatGPT"* \
      && "$command_line" == *"--user-data-dir=$profile_root"* \
      && "$command_line" == *"--remote-debugging-port=9237"* ]]; then
      [[ -z "$root_pid" ]] || { echo "Multiple Aboard runtimes are active; installation stopped." >&2; exit 1; }
      root_pid="$pid"
    fi
  done < <(/usr/bin/pgrep -x ChatGPT 2>/dev/null || true)
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    [[ "$pid" == <-> ]] || { echo "Unexpected Aboard process id: $pid" >&2; exit 1; }
    listener_pids+=("$pid")
    command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if [[ "$command_line" == "$SOURCE_APP/Contents/MacOS/ChatGPT"* \
      && "$command_line" == *"--user-data-dir=$profile_root"* \
      && "$command_line" == *"--remote-debugging-port=9237"* ]]; then
      if [[ -n "$root_pid" && "$root_pid" != "$pid" ]]; then
        echo "Multiple Aboard runtimes own port 9237; installation stopped." >&2
        exit 1
      fi
      root_pid="$pid"
    elif [[ ("$command_line" == "$TARGET_APP/Contents/MacOS/AboardRuntime"* \
      || "$command_line" == "$LEGACY_RUNTIME_APP/Contents/MacOS/ChatGPT"*) \
      && "$command_line" == *"--remote-debugging-port=9237"* ]]; then
      [[ -z "$root_pid" ]] || { echo "Multiple Aboard runtimes own port 9237; installation stopped." >&2; exit 1; }
      root_pid="$pid"
    fi
  done < <(port_listener_pids 9237)
  if [[ ${#listener_pids[@]} -eq 0 ]]; then
    [[ -n "$root_pid" ]] || return 0
    kill -TERM "$root_pid"
    return 0
  fi
  [[ -n "$root_pid" ]] || { echo "Port 9237 is not owned by the expected Aboard runtime; installation stopped." >&2; exit 1; }
  for pid in "${listener_pids[@]}"; do
    [[ "$pid" == "$root_pid" ]] && continue
    matched=false
    parent="$pid"
    for _ in {1..32}; do
      parent="$(ps -p "$parent" -o ppid= 2>/dev/null | tr -d ' ' || true)"
      [[ "$parent" == <-> && "$parent" -gt 1 ]] || break
      if [[ "$parent" == "$root_pid" ]]; then matched=true; break; fi
    done
    [[ "$matched" == true ]] || {
      command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      echo "Port 9237 is also owned by an unrelated process; installation stopped: $command_line" >&2
      exit 1
    }
  done
  kill -TERM "$root_pid"
}

unregister_app() {
  local app_path="$1"
  if [[ -d "$app_path" && ! -L "$app_path" ]]; then
    "$LSREGISTER" -u "$app_path" >/dev/null 2>&1 || true
  fi
}

disable_legacy_apps() {
  mkdir -p "$LEGACY_BACKUP_ROOT"
  setopt local_options null_glob
  local legacy_apps=("$LEGACY_BACKUP_ROOT"/*.app)
  for legacy_app in "${legacy_apps[@]}"; do
    [[ -d "$legacy_app" && ! -L "$legacy_app" ]] || { echo "Unexpected legacy app type: $legacy_app" >&2; exit 1; }
    local disabled_path="${legacy_app}.disabled"
    [[ ! -e "$disabled_path" ]] || { echo "Legacy backup target already exists: $disabled_path" >&2; exit 1; }
    unregister_app "$legacy_app"
    mv "$legacy_app" "$disabled_path"
  done
}

if [[ ! -d "$SOURCE_APP" ]]; then
  echo "Install the ChatGPT/Codex desktop app in /Applications first." >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required to install and run Aboard. Install Python 3, then retry." >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  for candidate in "$SOURCE_APP/Contents/Resources/cua_node/bin/node" "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" "/Applications/Aboard.app/Contents/Resources/runtime/node"; do
    if [[ -x "$candidate" ]]; then NODE_BIN="$candidate"; break; fi
  done
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js is required to build Aboard." >&2
  exit 1
fi

export NODE_BIN
secure_existing_board_backups "$SUPPORT_ROOT"
if curl --max-time 2 -sf http://localhost:9237/json/list >/dev/null 2>&1; then
  "$NODE_BIN" "$REPO_ROOT/desktop/board-storage.mjs" backup "$BOARD_BACKUP"
  [[ -s "$BOARD_BACKUP" ]] || { echo "Could not create an Aboard data backup; installation stopped." >&2; exit 1; }
  chmod 600 "$BOARD_BACKUP"
fi
[[ ! -e "$READY_APP" && ! -e "$READY_STAGING_APP" ]] || { echo "A previous Aboard build is still present in /tmp. Ask Codex to inspect it before retrying." >&2; exit 1; }
ABOARD_OUTPUT_APP="$READY_APP" ABOARD_STAGING_APP="$READY_STAGING_APP" "$REPO_ROOT/desktop/build-app.sh"

# Stop only Aboard's current foreground runtime before the atomic migration.
/usr/bin/osascript -e 'tell application id "app.aboard.dashboard" to quit' >/dev/null 2>&1 || true
stop_aboard_runtime
for attempt in {1..80}; do
  if ! pgrep -f '^/Applications/(Aboard|\.Conversation Dashboard Runtime)\.app/Contents/MacOS/(AboardRuntime|Aboard|ChatGPT)( |$)' >/dev/null; then break; fi
  sleep 0.25
done
if pgrep -f '^/Applications/(Aboard|\.Conversation Dashboard Runtime)\.app/Contents/MacOS/(AboardRuntime|Aboard|ChatGPT)( |$)' >/dev/null; then
  echo "Aboard is still running. Quit Aboard normally, then retry the installer." >&2
  exit 1
fi
for attempt in {1..40}; do
  if ! port_is_open 9237; then break; fi
  sleep 0.25
done
if port_is_open 9237; then
  echo "Aboard's previous debugging endpoint is still active. Wait a moment, then retry the installer." >&2
  exit 1
fi
for attempt in {1..40}; do
  if ! port_is_open 47844; then break; fi
  sleep 0.25
done
if port_is_open 47844; then
  echo "Aboard's previous handoff bridge is still active. Wait a moment, then retry the installer." >&2
  exit 1
fi

mkdir -p "$LEGACY_BACKUP_ROOT"
disable_legacy_apps
migration_stamp="$(date +%Y%m%d-%H%M%S)"
previous_backup=""
legacy_runtime_backup=""
install_committed=false
rollback_install() {
  [[ "$install_committed" == true ]] && return 0
  (stop_aboard_runtime) >/dev/null 2>&1 || true
  for _ in {1..40}; do
    if ! port_is_open 9237; then break; fi
    sleep 0.25
  done
  local failed_app="$LEGACY_BACKUP_ROOT/Aboard-failed-$migration_stamp.app.disabled"
  if [[ -d "$TARGET_APP" && ! -L "$TARGET_APP" && ! -e "$failed_app" ]]; then
    unregister_app "$TARGET_APP"
    mv "$TARGET_APP" "$failed_app"
  fi
  if [[ -n "$previous_backup" && -d "$previous_backup" && ! -L "$previous_backup" && ! -e "$TARGET_APP" ]]; then
    mv "$previous_backup" "$TARGET_APP"
    "$LSREGISTER" -f "$TARGET_APP" >/dev/null 2>&1 || true
  fi
  if [[ -n "$legacy_runtime_backup" && -d "$legacy_runtime_backup" && ! -L "$legacy_runtime_backup" && ! -e "$LEGACY_RUNTIME_APP" ]]; then
    mv "$legacy_runtime_backup" "$LEGACY_RUNTIME_APP"
    "$LSREGISTER" -f "$LEGACY_RUNTIME_APP" >/dev/null 2>&1 || true
  fi
}
handle_install_signal() {
  local signal_status="$1"
  trap - EXIT INT TERM
  rollback_install
  exit "$signal_status"
}
trap rollback_install EXIT
trap 'handle_install_signal 130' INT
trap 'handle_install_signal 143' TERM
if [[ -e "$TARGET_APP" ]]; then
  [[ -d "$TARGET_APP" && ! -L "$TARGET_APP" ]] || { echo "Unexpected Aboard target type: $TARGET_APP" >&2; exit 1; }
  unregister_app "$TARGET_APP"
  previous_backup="$LEGACY_BACKUP_ROOT/Aboard-previous-$migration_stamp.app.disabled"
  [[ ! -e "$previous_backup" ]]
  mv "$TARGET_APP" "$previous_backup"
fi
if [[ -e "$LEGACY_RUNTIME_APP" ]]; then
  [[ -d "$LEGACY_RUNTIME_APP" && ! -L "$LEGACY_RUNTIME_APP" ]] || { echo "Unexpected legacy runtime type: $LEGACY_RUNTIME_APP" >&2; exit 1; }
  unregister_app "$LEGACY_RUNTIME_APP"
  legacy_runtime_backup="$LEGACY_BACKUP_ROOT/Conversation-Dashboard-Runtime-$migration_stamp.app.disabled"
  [[ ! -e "$legacy_runtime_backup" ]]
  mv "$LEGACY_RUNTIME_APP" "$legacy_runtime_backup"
fi
mv "$READY_APP" "$TARGET_APP"

"$LSREGISTER" -f "$TARGET_APP" >/dev/null 2>&1 || true
# Historical Aboard bundles once claimed codex/http/https. LaunchServices keeps
# the chosen handler by bundle id even after those plist keys are removed, so
# explicitly restore native Codex deep links to the official desktop app.
/usr/bin/osascript -l JavaScript -e 'ObjC.import("CoreServices"); const status = $.LSSetDefaultHandlerForURLScheme($("codex"), $("com.openai.codex")); if (Number(status) !== 0) throw new Error("Could not restore the Codex URL handler: " + status);'
killall Dock >/dev/null 2>&1 || true

open -a "$TARGET_APP"
"$NODE_BIN" "$REPO_ROOT/desktop/verify-installed.mjs"
install_committed=true
trap - EXIT INT TERM

# Update the Codex plugin only after the replacement app has launched and its
# bundled MCP server has passed verification. This keeps a failed app migration
# from leaving a newly cached .mcp.json pointing at an app that rollback removes.
# From this point the verified app remains installed even if plugin refresh is
# interrupted; rerunning the installer safely completes that independent step.
CODEX_BIN="$SOURCE_APP/Contents/Resources/codex"
if [[ -x "$CODEX_BIN" ]]; then
  MARKETPLACE="$HOME/.agents/plugins/marketplace.json"
  MARKETPLACE_ROOT="$HOME/.agents/plugins"
  MARKETPLACE_PLUGIN="$MARKETPLACE_ROOT/plugins/conversation-dashboard"
  mkdir -p "$MARKETPLACE_ROOT/plugins"
  if [[ ! -f "$MARKETPLACE" ]]; then
    cp "$REPO_ROOT/setup/personal-marketplace.json" "$MARKETPLACE"
  elif ! grep -q '"name"[[:space:]]*:[[:space:]]*"conversation-dashboard"' "$MARKETPLACE"; then
    echo "Your personal marketplace already exists but does not contain Aboard. Ask Codex to add the conversation-dashboard entry safely." >&2
    exit 1
  fi
  ensure_marketplace_plugin_link "$MARKETPLACE_PLUGIN" "$REPO_ROOT"
  DESIRED_PLUGIN_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$REPO_ROOT/.codex-plugin/plugin.json")"
  installed_plugin_version() {
    "$CODEX_BIN" plugin list --json | python3 -c 'import json,sys; data=json.load(sys.stdin); print(next((item.get("version", "") for item in data.get("installed", []) if item.get("pluginId") == "conversation-dashboard@personal"), ""))'
  }
  INSTALLED_PLUGIN_VERSION="$(installed_plugin_version)"
  if [[ "$INSTALLED_PLUGIN_VERSION" != "$DESIRED_PLUGIN_VERSION" ]]; then
    "$CODEX_BIN" plugin add conversation-dashboard@personal
    echo "Aboard plugin updated. Restart Codex once to activate the new plugin process."
  else
    echo "Aboard plugin $DESIRED_PLUGIN_VERSION is already installed."
  fi
  INSTALLED_PLUGIN_VERSION="$(installed_plugin_version)"
  [[ "$INSTALLED_PLUGIN_VERSION" == "$DESIRED_PLUGIN_VERSION" ]] || {
    echo "Aboard plugin version mismatch after installation: expected $DESIRED_PLUGIN_VERSION, found ${INSTALLED_PLUGIN_VERSION:-none}." >&2
    exit 1
  }
fi
echo "Aboard is installed. Look below Plugins in the left sidebar."

#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
REPO_ROOT=${SCRIPT_DIR:h}
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then
  for candidate in "/Applications/Aboard.app/Contents/Resources/runtime/node" "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"; do
    if [[ -x "$candidate" ]]; then NODE_BIN="$candidate"; break; fi
  done
fi
if [[ -z "$NODE_BIN" ]]; then echo "Node.js is required." >&2; exit 1; fi

PLUGIN_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$REPO_ROOT/.codex-plugin/plugin.json")"
PRODUCT_VERSION="${PLUGIN_VERSION%%+*}"
python3 - "$PLUGIN_VERSION" <<'PY'
import re
import sys
if not re.fullmatch(r"\d+\.\d+\.\d+\+codex\.\d{14}", sys.argv[1]):
    raise SystemExit(f"Aboard plugin version must use one SemVer cachebuster: {sys.argv[1]}")
PY
APP_VERSION="$(python3 -c 'import plistlib,sys; print(plistlib.load(open(sys.argv[1], "rb"))["CFBundleShortVersionString"])' "$REPO_ROOT/desktop/Aboard-Info.plist")"
APP_BUILD_VERSION="$(python3 -c 'import plistlib,sys; print(plistlib.load(open(sys.argv[1], "rb"))["CFBundleVersion"])' "$REPO_ROOT/desktop/Aboard-Info.plist")"
LAUNCHER_VERSION="$(python3 -c 'import re,sys; text=open(sys.argv[1]).read(); match=re.search(r"clientInfo:\s*\{\s*name:\s*[\"\x27]aboard[\"\x27],\s*version:\s*[\"\x27]([^\"\x27]+)", text); print(match.group(1) if match else "")' "$REPO_ROOT/desktop/launcher.mjs")"
MCP_VERSION="$(python3 -c 'import re,sys; text=open(sys.argv[1]).read(); match=re.search(r"serverInfo\s*[\"\x27]?\s*:\s*\{[^}]*[\"\x27]version[\"\x27]\s*:\s*[\"\x27]([^\"\x27]+)", text); print(match.group(1) if match else "")' "$REPO_ROOT/server/dashboard_mcp.py")"
INJECTION_VERSION="$(python3 -c 'import re,sys; text=open(sys.argv[1]).read(); match=re.search(r"const INJECTION_VERSION = (\d+);", text); print(match.group(1) if match else "")' "$REPO_ROOT/desktop/inject.js")"
HANDOFF_INJECTION_VERSION="$(python3 -c 'import re,sys; text=open(sys.argv[1]).read(); match=re.search(r"last verified injection version is \*\*(\d+)\*\*", text, re.I); print(match.group(1) if match else "")' "$REPO_ROOT/HANDOFF.md")"
[[ -n "$PRODUCT_VERSION" && "$PRODUCT_VERSION" == "$APP_VERSION" && "$PRODUCT_VERSION" == "$APP_BUILD_VERSION" && "$PRODUCT_VERSION" == "$LAUNCHER_VERSION" && "$PRODUCT_VERSION" == "$MCP_VERSION" ]] || {
  echo "Aboard product versions are inconsistent: plugin=$PRODUCT_VERSION app=$APP_VERSION build=$APP_BUILD_VERSION launcher=$LAUNCHER_VERSION mcp=$MCP_VERSION" >&2
  exit 1
}
[[ -n "$INJECTION_VERSION" && "$INJECTION_VERSION" == "$HANDOFF_INJECTION_VERSION" ]] || {
  echo "Aboard injection versions are inconsistent: source=$INJECTION_VERSION handoff=$HANDOFF_INJECTION_VERSION" >&2
  exit 1
}

"$NODE_BIN" --check "$REPO_ROOT/desktop/inject.js"
"$NODE_BIN" --check "$REPO_ROOT/desktop/launcher.mjs"
"$NODE_BIN" "$REPO_ROOT/desktop/test-startup-isolation.mjs"
"$NODE_BIN" "$REPO_ROOT/desktop/test-installer-safety.mjs"
"$NODE_BIN" "$REPO_ROOT/desktop/test-launcher-race.mjs"
"$NODE_BIN" "$REPO_ROOT/desktop/test-runtime-progress.mjs"
"$NODE_BIN" "$REPO_ROOT/desktop/test-recents-hydration.mjs"
"$NODE_BIN" "$REPO_ROOT/desktop/test-create-conversation-lifecycle.mjs"
"$NODE_BIN" --input-type=module -e "import {readFileSync} from 'node:fs'; const html=readFileSync(process.argv[1],'utf8'); const scripts=[...html.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/g)].map(match=>match[1]); new Function(scripts.at(-1));" "$REPO_ROOT/web/dashboard.html"
python3 -m json.tool "$REPO_ROOT/.codex-plugin/plugin.json" >/dev/null
[[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["interface"]["brandColor"])' "$REPO_ROOT/.codex-plugin/plugin.json")" == "#0B4F43" ]]
python3 "$REPO_ROOT/desktop/test-mcp-resource-cache.py"
python3 "$REPO_ROOT/desktop/test-mcp-cold-start.py"
python3 "$REPO_ROOT/desktop/test-mcp-open-conversation.py"

if [[ "${1:-}" == "--installed" ]]; then
  ABOARD_APP="/Applications/Aboard.app"
  [[ -d "$ABOARD_APP" && ! -L "$ABOARD_APP" ]]
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$ABOARD_APP/Contents/Info.plist")" == "Aboard" ]]
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$ABOARD_APP/Contents/Info.plist")" == "Aboard" ]]
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$ABOARD_APP/Contents/Info.plist")" == "Aboard" ]]
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ABOARD_APP/Contents/Info.plist")" == "$PRODUCT_VERSION" ]]
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$ABOARD_APP/Contents/Info.plist")" == "$PRODUCT_VERSION" ]]
  [[ -x "$ABOARD_APP/Contents/MacOS/Aboard" ]]
  [[ -f "$REPO_ROOT/assets/Aboard.icns" && ! -L "$REPO_ROOT/assets/Aboard.icns" ]]
  [[ -f "$REPO_ROOT/assets/Aboard.png" && ! -L "$REPO_ROOT/assets/Aboard.png" ]]
  cmp -s "$REPO_ROOT/assets/Aboard.icns" "$ABOARD_APP/Contents/Resources/Aboard.icns"
  cmp -s "$REPO_ROOT/assets/Aboard.png" "$ABOARD_APP/Contents/Resources/Aboard.png"
  [[ ! -e "$ABOARD_APP/Contents/MacOS/AboardRuntime" ]]
  [[ ! -e "$ABOARD_APP/Contents/Resources/app.asar" ]]
  [[ ! -e "$ABOARD_APP/Contents/Frameworks" ]]
  [[ ! -e "$ABOARD_APP/Contents/PlugIns" ]]
  [[ -x "$ABOARD_APP/Contents/Resources/dashboard/server/dashboard_mcp.py" ]]
  [[ -f "$ABOARD_APP/Contents/Resources/dashboard/web/dashboard.html" ]]
  cmp -s "$REPO_ROOT/desktop/inject.js" "$ABOARD_APP/Contents/Resources/dashboard/desktop/inject.js"
  cmp -s "$REPO_ROOT/desktop/launcher.mjs" "$ABOARD_APP/Contents/Resources/dashboard/desktop/launcher.mjs"
  cmp -s "$REPO_ROOT/server/dashboard_mcp.py" "$ABOARD_APP/Contents/Resources/dashboard/server/dashboard_mcp.py"
  cmp -s "$REPO_ROOT/web/dashboard.html" "$ABOARD_APP/Contents/Resources/dashboard/web/dashboard.html"
  "$REPO_ROOT/desktop/verify-official-runtime.zsh" "/Applications/ChatGPT.app"
  [[ ! -e "/Applications/.Conversation Dashboard Runtime.app" ]]
  for key in NSDockTilePlugIn CFBundleAlternateNames CFBundleURLTypes CFBundleDocumentTypes; do
    if /usr/libexec/PlistBuddy -c "Print :$key" "$ABOARD_APP/Contents/Info.plist" >/dev/null 2>&1; then
      echo "Aboard still exposes upstream application registration key: $key" >&2
      exit 1
    fi
  done
  codesign --verify --deep --strict "$ABOARD_APP"
  python3 "$REPO_ROOT/desktop/test-mcp-cold-start.py" --installed
  python3 "$REPO_ROOT/desktop/test-mcp-open-conversation.py" --installed
fi

if [[ "${1:-}" == "--installed" ]]; then
  ABOARD_APP="/Applications/Aboard.app"
  # Start the installed runtime once for the entire live matrix. Reopening the
  # LaunchServices wrapper before every case creates unnecessary secondary
  # Electron contenders and can leave the shared renderer on a transient
  # loading surface, which makes geometry tests report false failures.
  open -a "$ABOARD_APP"
  for attempt in {1..40}; do
    if curl -fsS --max-time 1 "http://127.0.0.1:47844/health" >/dev/null 2>&1 \
      && curl -fsS --max-time 1 "http://127.0.0.1:9237/json/list" >/dev/null 2>&1; then
      break
    fi
    if (( attempt == 40 )); then
      echo "Installed Aboard runtime did not become ready." >&2
      exit 1
    fi
    sleep 0.25
  done
  active_installed_test_pid=0
  active_installed_launch_in_progress=false
  active_installed_deferred_signal=0
  active_installed_signal_phase="probe"
  stop_active_installed_test() {
    local test_pid="${active_installed_test_pid:-0}"
    active_installed_test_pid=0
    [[ "$test_pid" == <-> && "$test_pid" -gt 1 ]] || return 0
    kill -TERM "$test_pid" >/dev/null 2>&1 || true
    wait "$test_pid" >/dev/null 2>&1 || true
  }
  dispatch_active_installed_signal() {
    local signal_status="$1"
    if [[ "$active_installed_launch_in_progress" == true ]]; then
      active_installed_deferred_signal="$signal_status"
      return
    fi
    if [[ "$active_installed_signal_phase" == "verify" ]]; then
      handle_verify_signal "$signal_status"
    else
      handle_installed_probe_signal "$signal_status"
    fi
  }
  finish_active_installed_launch() {
    local deferred_signal="$active_installed_deferred_signal"
    active_installed_launch_in_progress=false
    active_installed_deferred_signal=0
    if [[ "$deferred_signal" == <-> && "$deferred_signal" -gt 0 ]]; then
      dispatch_active_installed_signal "$deferred_signal"
    fi
  }
  run_installed_test() {
    local test_file="$1" test_status
    curl -fsS --max-time 1 "http://127.0.0.1:47844/health" >/dev/null
    curl -fsS --max-time 1 "http://127.0.0.1:9237/json/list" >/dev/null
    active_installed_launch_in_progress=true
    python3 "$REPO_ROOT/scripts/installed-test-supervisor.py" "$NODE_BIN" "$test_file" 45000 1000 &
    active_installed_test_pid=$!
    finish_active_installed_launch
    set +e
    wait "$active_installed_test_pid"
    test_status=$?
    active_installed_test_pid=0
    set -e
    stop_active_installed_test
    return "$test_status"
  }
  handle_installed_probe_signal() {
    local signal_status="$1"
    trap - EXIT
    trap '' INT TERM
    stop_active_installed_test
    exit "$signal_status"
  }
  # Installed verification is mandatory. A stopped or half-started runtime
  # must fail instead of silently skipping every live regression.
  trap 'dispatch_active_installed_signal 130' INT
  trap 'dispatch_active_installed_signal 143' TERM
  run_installed_test "$REPO_ROOT/desktop/verify-installed.mjs"
  trap - INT TERM
  discard_sensitive_temp() {
    local candidate="$1"
    [[ "$candidate" == /tmp/aboard-verify-board.* && -f "$candidate" && ! -L "$candidate" ]] || return 1
    : > "$candidate"
    rm -f -- "$candidate"
  }
  BOARD_BACKUP="$(mktemp /tmp/aboard-verify-board.XXXXXX)"
  cleanup_incomplete_backup() {
    local original_status="$?"
    trap - EXIT
    trap '' INT TERM
    discard_sensitive_temp "$BOARD_BACKUP" || true
    exit "$original_status"
  }
  cleanup_incomplete_backup_signal() {
    local signal_status="$1"
    trap - EXIT
    trap '' INT TERM
    discard_sensitive_temp "$BOARD_BACKUP" || true
    exit "$signal_status"
  }
  trap cleanup_incomplete_backup EXIT
  trap 'cleanup_incomplete_backup_signal 130' INT
  trap 'cleanup_incomplete_backup_signal 143' TERM
  chmod 600 "$BOARD_BACKUP"
  "$NODE_BIN" "$REPO_ROOT/desktop/board-storage.mjs" backup "$BOARD_BACKUP"
  [[ -s "$BOARD_BACKUP" ]]
  restore_board() {
    local verification_backup
    [[ -s "$BOARD_BACKUP" && ! -L "$BOARD_BACKUP" ]] || {
      echo "Aboard verification backup is unavailable; restoration stopped." >&2
      return 1
    }
    if ! "$NODE_BIN" "$REPO_ROOT/desktop/board-storage.mjs" restore "$BOARD_BACKUP" >/dev/null 2>&1; then
      echo "Could not restore the Aboard board. Recovery backup preserved at: $BOARD_BACKUP" >&2
      return 1
    fi
    verification_backup="$(mktemp /tmp/aboard-verify-board.XXXXXX)"
    chmod 600 "$verification_backup"
    if ! "$NODE_BIN" "$REPO_ROOT/desktop/board-storage.mjs" backup "$verification_backup" >/dev/null 2>&1 \
      || ! cmp -s "$BOARD_BACKUP" "$verification_backup"; then
      discard_sensitive_temp "$verification_backup" || true
      echo "Aboard board restoration could not be verified. Recovery backup preserved at: $BOARD_BACKUP" >&2
      return 1
    fi
    discard_sensitive_temp "$verification_backup"
    discard_sensitive_temp "$BOARD_BACKUP"
  }
  handle_verify_exit() {
    local original_status="$?"
    trap - EXIT
    trap '' INT TERM
    stop_active_installed_test
    if ! restore_board; then exit 1; fi
    exit "$original_status"
  }
  handle_verify_signal() {
    local signal_status="$1"
    trap - EXIT
    trap '' INT TERM
    stop_active_installed_test
    if ! restore_board; then exit 1; fi
    exit "$signal_status"
  }
  active_installed_signal_phase="verify"
  trap handle_verify_exit EXIT
  trap 'dispatch_active_installed_signal 130' INT
  trap 'dispatch_active_installed_signal 143' TERM
  # Run the trusted cross-frame CDP paths before the synthetic drag matrix.
  # Chromium's Input domain can become unresponsive after many independent
  # pointer sessions even though the renderer and product state are healthy.
  run_installed_test "$REPO_ROOT/desktop/test-cdp-native-drag.mjs"
  run_installed_test "$REPO_ROOT/desktop/test-cdp-native-chat-drag.mjs"
  run_installed_test "$REPO_ROOT/desktop/test-drag-safety.mjs"
  run_installed_test "$REPO_ROOT/desktop/test-mouse-only-drag.mjs"
  run_installed_test "$REPO_ROOT/desktop/test-drag-preview-parity.mjs"
  run_installed_test "$REPO_ROOT/desktop/test-native-hover-drag.mjs"
  run_installed_test "$REPO_ROOT/desktop/test-invalid-native-drag.mjs"
  run_installed_test "$REPO_ROOT/desktop/test-drag-integration.mjs"
  run_installed_test "$REPO_ROOT/desktop/test-project-thread-row-variants.mjs"
  run_installed_test "$REPO_ROOT/desktop/test-title-visibility.mjs"
  run_installed_test "$REPO_ROOT/desktop/test-theme-sync.mjs"
  run_installed_test "$REPO_ROOT/desktop/test-runtime-progress-ui.mjs"
  run_installed_test "$REPO_ROOT/desktop/test-project-compact-layout.mjs"
  run_installed_test "$REPO_ROOT/desktop/test-internal-open-routing.mjs"
  run_installed_test "$REPO_ROOT/desktop/test-native-open-routing.mjs"
  run_installed_test "$REPO_ROOT/desktop/test-detail-navigation.mjs"
  run_installed_test "$REPO_ROOT/desktop/test-mcp-app-ui.mjs"
  run_installed_test "$REPO_ROOT/desktop/test-renderer-binding.mjs"
  run_installed_test "$REPO_ROOT/desktop/test-drag-type-guard.mjs"
  run_installed_test "$REPO_ROOT/desktop/test-aboard-features.mjs"
  run_installed_test "$REPO_ROOT/desktop/test-item-manual-sort.mjs"
  restore_board
  trap - EXIT INT TERM
fi

echo "Aboard verification passed."

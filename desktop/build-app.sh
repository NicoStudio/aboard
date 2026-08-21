#!/bin/zsh
set -euo pipefail

SOURCE_APP="/Applications/ChatGPT.app"
TARGET_APP="${ABOARD_OUTPUT_APP:-/Applications/Aboard.app}"
PLUGIN_ROOT="${0:A:h:h}"
NODE_SOURCE="${NODE_BIN:-$(command -v node || true)}"
STAGING_APP="${ABOARD_STAGING_APP:-/tmp/Aboard.building.app}"
SOURCE_RUNTIME="$SOURCE_APP/Contents/MacOS/ChatGPT"
SOURCE_ICON="$PLUGIN_ROOT/assets/Aboard.icns"
SOURCE_DOCK_ICON="$PLUGIN_ROOT/assets/Aboard.png"
MANIFEST="$PLUGIN_ROOT/.codex-plugin/plugin.json"

[[ -d "$SOURCE_APP" ]] || { echo "ChatGPT is not installed at $SOURCE_APP" >&2; exit 1; }
[[ -x "$SOURCE_RUNTIME" && ! -L "$SOURCE_RUNTIME" ]] || { echo "The signed ChatGPT runtime is unavailable" >&2; exit 1; }
[[ -f "$SOURCE_ICON" && ! -L "$SOURCE_ICON" ]] || { echo "The Aboard application icon is unavailable" >&2; exit 1; }
[[ -f "$SOURCE_DOCK_ICON" && ! -L "$SOURCE_DOCK_ICON" ]] || { echo "The Aboard Dock icon is unavailable" >&2; exit 1; }
[[ -n "$NODE_SOURCE" && -x "$NODE_SOURCE" ]] || { echo "Node runtime is unavailable" >&2; exit 1; }
[[ "$TARGET_APP" == "/Applications/Aboard.app" || "$TARGET_APP" == "/tmp/Aboard.ready.app" ]] || { echo "Unexpected Aboard output: $TARGET_APP" >&2; exit 1; }
[[ "$STAGING_APP" == "/tmp/Aboard.building.app" || "$STAGING_APP" == "/tmp/Aboard.ready.building.app" ]] || { echo "Unexpected Aboard staging path: $STAGING_APP" >&2; exit 1; }
[[ ! -e "$STAGING_APP" ]] || { echo "Staging app already exists: $STAGING_APP" >&2; exit 1; }
[[ ! -e "$TARGET_APP" ]] || { echo "Target already exists: $TARGET_APP" >&2; exit 1; }
"$PLUGIN_ROOT/desktop/verify-official-runtime.zsh" "$SOURCE_APP"

# The current ChatGPT desktop build requires OpenAI's original signature and
# entitlements to complete its authenticated startup. Aboard therefore ships
# only a small launcher and executes the untouched runtime already installed
# in /Applications. Never copy or re-sign the ChatGPT application here.
mkdir -p "$STAGING_APP/Contents/MacOS" "$STAGING_APP/Contents/Resources"
cp "$PLUGIN_ROOT/desktop/Aboard-Info.plist" "$STAGING_APP/Contents/Info.plist"
cp "$PLUGIN_ROOT/desktop/aboard-runtime-launcher.zsh" "$STAGING_APP/Contents/MacOS/Aboard"
cp "$SOURCE_ICON" "$STAGING_APP/Contents/Resources/Aboard.icns"
cp "$SOURCE_DOCK_ICON" "$STAGING_APP/Contents/Resources/Aboard.png"
chmod 755 "$STAGING_APP/Contents/MacOS/Aboard"

mkdir -p "$STAGING_APP/Contents/Resources/dashboard"
ditto "$PLUGIN_ROOT/web" "$STAGING_APP/Contents/Resources/dashboard/web"
ditto "$PLUGIN_ROOT/desktop" "$STAGING_APP/Contents/Resources/dashboard/desktop"
ditto "$PLUGIN_ROOT/server" "$STAGING_APP/Contents/Resources/dashboard/server"
chmod 755 "$STAGING_APP/Contents/Resources/dashboard/server/dashboard_mcp.py"
mkdir -p "$STAGING_APP/Contents/Resources/runtime"
cp "$NODE_SOURCE" "$STAGING_APP/Contents/Resources/runtime/node"
chmod 755 "$STAGING_APP/Contents/Resources/runtime/node"

PLUGIN_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$MANIFEST")"
SHORT_VERSION="${PLUGIN_VERSION%%+*}"
[[ "$SHORT_VERSION" == <->.<->.<-> ]] || { echo "Invalid Aboard version: $PLUGIN_VERSION" >&2; exit 1; }
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $SHORT_VERSION" "$STAGING_APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $SHORT_VERSION" "$STAGING_APP/Contents/Info.plist"

# Only the small Aboard shell is signed here. The OpenAI runtime remains at its
# original path with its original Developer ID signature intact.
/usr/bin/codesign --force --deep --sign - "$STAGING_APP"
mv "$STAGING_APP" "$TARGET_APP"
echo "$TARGET_APP"

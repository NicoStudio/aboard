#!/bin/zsh
set -euo pipefail

SOURCE_APP="${1:-/Applications/ChatGPT.app}"
SOURCE_RUNTIME="$SOURCE_APP/Contents/MacOS/ChatGPT"
SOURCE_PLIST="$SOURCE_APP/Contents/Info.plist"

[[ "$SOURCE_APP" == /* && -d "$SOURCE_APP" && ! -L "$SOURCE_APP" ]] || {
  echo "The official ChatGPT application bundle is unavailable: $SOURCE_APP" >&2
  exit 1
}
[[ -x "$SOURCE_RUNTIME" && ! -L "$SOURCE_RUNTIME" ]] || {
  echo "The official ChatGPT runtime is unavailable: $SOURCE_RUNTIME" >&2
  exit 1
}
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$SOURCE_PLIST" 2>/dev/null || true)" == "com.openai.codex" ]] || {
  echo "The ChatGPT bundle identifier is not the official Codex identifier." >&2
  exit 1
}
/usr/bin/codesign --verify --deep --strict "$SOURCE_APP"
/usr/bin/codesign --verify --strict \
  -R='identifier "com.openai.codex" and anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"' \
  "$SOURCE_APP"

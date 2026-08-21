#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
REPO_ROOT=${SCRIPT_DIR:h}
MANIFEST="$REPO_ROOT/.codex-plugin/plugin.json"
PLUGIN_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$MANIFEST")"
SHORT_VERSION="${PLUGIN_VERSION%%+*}"
DIST_ROOT="$REPO_ROOT/dist"
ARCHIVE="$DIST_ROOT/Aboard-macOS-$SHORT_VERSION.zip"
CHECKSUM="$ARCHIVE.sha256"
TEMP_ROOT="$(mktemp -d /tmp/aboard-release.XXXXXX)"
PACKAGE_ROOT="$TEMP_ROOT/Aboard"
VERIFY_HOME="$TEMP_ROOT/verify-home"

cleanup() {
  [[ -n "$TEMP_ROOT" && "$TEMP_ROOT" == /tmp/aboard-release.* && -d "$TEMP_ROOT" && ! -L "$TEMP_ROOT" ]] || return 0
  rm -rf -- "$TEMP_ROOT"
}
trap cleanup EXIT INT TERM

mkdir -p "$VERIFY_HOME"
chmod 700 "$VERIFY_HOME"
HOME="$VERIFY_HOME" "$REPO_ROOT/scripts/verify.sh"
"$REPO_ROOT/scripts/privacy-check.sh" "$REPO_ROOT"
[[ ! -e "$ARCHIVE" && ! -e "$CHECKSUM" ]] || {
  echo "Release output already exists: $ARCHIVE" >&2
  exit 1
}

mkdir -p "$PACKAGE_ROOT/assets" "$DIST_ROOT"
for release_path in \
  .codex-plugin .mcp.json \
  desktop docs server setup skills web scripts \
  CHANGELOG.md HANDOFF.md LICENSE PRIVACY.md README.md RELEASE_NOTES.md SECURITY.md \
  "Install Aboard.command" "Uninstall Aboard.command"; do
  [[ -e "$REPO_ROOT/$release_path" ]] || { echo "Missing release input: $release_path" >&2; exit 1; }
  /usr/bin/ditto "$REPO_ROOT/$release_path" "$PACKAGE_ROOT/$release_path"
done
for asset in Aboard.icns Aboard.png aboard-app-icon.svg; do
  [[ -f "$REPO_ROOT/assets/$asset" ]] || { echo "Missing release asset: $asset" >&2; exit 1; }
  /bin/cp "$REPO_ROOT/assets/$asset" "$PACKAGE_ROOT/assets/$asset"
done

find "$PACKAGE_ROOT" -type f \( -name '*.command' -o -name '*.sh' -o -name '*.zsh' -o -name 'dashboard_mcp.py' \) -exec chmod 755 {} +
"$PACKAGE_ROOT/scripts/privacy-check.sh" "$PACKAGE_ROOT"
(cd "$TEMP_ROOT" && /usr/bin/zip -qry "$ARCHIVE" Aboard)
(cd "$DIST_ROOT" && /usr/bin/shasum -a 256 "${ARCHIVE:t}" > "${CHECKSUM:t}")
echo "$ARCHIVE"
echo "$CHECKSUM"

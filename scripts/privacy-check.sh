#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
DEFAULT_ROOT=${SCRIPT_DIR:h}
SCAN_ROOT="${1:-$DEFAULT_ROOT}"
SCAN_ROOT="${SCAN_ROOT:A}"
[[ -d "$SCAN_ROOT" && ! -L "$SCAN_ROOT" ]] || { echo "Privacy scan root is invalid: $SCAN_ROOT" >&2; exit 1; }

python3 - "$SCAN_ROOT" <<'PY'
import json
import os
import pathlib
import re
import subprocess
import sys

root = pathlib.Path(sys.argv[1]).resolve()

def publication_files():
    if (root / ".git").is_dir():
        raw = subprocess.check_output(
            ["git", "-C", str(root), "ls-files", "-z", "--cached", "--others", "--exclude-standard"]
        )
        return [root / item.decode() for item in raw.split(b"\0") if item]
    files = []
    for current, dirs, names in os.walk(root):
        dirs[:] = [name for name in dirs if name != ".git"]
        files.extend(pathlib.Path(current) / name for name in names)
    return files

files = publication_files()
problems = []
allowed_binary_images = {
    "assets/Aboard.icns",
    "assets/Aboard.png",
    "assets/aboard-app-icon.png",
    "docs/aboard-demo.png",
}
blocked_parts = {"outputs", "dist", "coverage", ".cache"}
blocked_names = {
    ".DS_Store",
    "aboard-board.json",
    "dashboard.json",
}
text_suffixes = {
    "", ".command", ".css", ".html", ".js", ".json", ".md", ".mjs", ".plist",
    ".py", ".sh", ".svg", ".toml", ".txt", ".yaml", ".yml", ".zsh",
}
secret_patterns = [
    re.compile(r"gho_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----"),
]
conversation_pattern = re.compile(
    r"(?:codex://threads/|https://(?:www\.)?(?:chatgpt\.com|chat\.openai\.com)/c/)"
    r"([0-9a-f]{8}-[0-9a-f-]{27,}|[A-Za-z0-9_-]{12,})",
    re.IGNORECASE,
)
synthetic_prefixes = ("00000000-", "11111111-", "22222222-", "33333333-", "44444444-")
uuid_shape = re.compile(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", re.IGNORECASE)

for path in files:
    try:
        relative = path.resolve().relative_to(root).as_posix()
    except (OSError, ValueError):
        problems.append(f"path escapes release root: {path}")
        continue
    parts = pathlib.PurePosixPath(relative).parts
    lower_name = path.name.lower()
    if blocked_parts.intersection(parts):
        problems.append(f"local-data directory is publishable: {relative}")
    if path.name in blocked_names or lower_name.endswith((".log", ".sqlite", ".sqlite3", ".db")):
        problems.append(f"local-data file is publishable: {relative}")
    if lower_name.startswith(("board-before", "board-after", "board-backup")):
        problems.append(f"board backup is publishable: {relative}")
    if path.suffix.lower() in {".png", ".icns"} and relative not in allowed_binary_images:
        problems.append(f"unreviewed image is publishable: {relative}")
    if path.suffix.lower() not in text_suffixes:
        if relative not in allowed_binary_images:
            problems.append(f"unreviewed binary file is publishable: {relative}")
        continue
    try:
        text = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        continue
    absolute_user_pattern = re.compile("/" + "Users" + r"/[^/\s]+/")
    if absolute_user_pattern.search(text):
        problems.append(f"absolute macOS user path found: {relative}")
    for pattern in secret_patterns:
        if pattern.search(text):
            problems.append(f"possible secret found: {relative}")
            break
    for match in conversation_pattern.finditer(text):
        identifier = match.group(1).lower()
        if uuid_shape.fullmatch(identifier) and not identifier.startswith(synthetic_prefixes):
            problems.append(f"non-synthetic conversation link found: {relative}")
            break
    for match in uuid_shape.finditer(text):
        identifier = match.group(0).lower()
        if not identifier.startswith(synthetic_prefixes):
            problems.append(f"non-synthetic conversation identifier found: {relative}")
            break
    if path.suffix.lower() == ".json":
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and (
            (isinstance(value.get("items"), list) and value["items"])
            or (isinstance(value.get("projects"), list) and value["projects"])
        ):
            problems.append(f"non-empty board-like JSON found: {relative}")

if problems:
    for problem in sorted(set(problems)):
        print(f"privacy-check: {problem}", file=sys.stderr)
    raise SystemExit(1)

print(f"Privacy check passed for {len(files)} publication files.")
PY

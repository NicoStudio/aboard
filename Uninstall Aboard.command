#!/bin/zsh
set -euo pipefail

PROJECT_ROOT=${0:A:h}
cd "$PROJECT_ROOT"
./scripts/uninstall-on-mac.sh
echo
echo "Aboard was removed. Your board data was preserved."
read -k 1 "?Press any key to close…"
echo

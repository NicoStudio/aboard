#!/bin/zsh
set -euo pipefail

PROJECT_ROOT=${0:A:h}
cd "$PROJECT_ROOT"
./scripts/install-on-mac.sh
echo
echo "Aboard installation finished. You may close this window."
read -k 1 "?Press any key to close…"
echo

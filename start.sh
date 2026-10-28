#!/usr/bin/env bash
# Start abltx and open the panel in the browser.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "abltx: нужен Node.js 22+" >&2
  exit 1
fi

MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$MAJOR" -lt 22 ]; then
  echo "abltx: Node $(node -v) слишком старый, нужен 22+" >&2
  exit 1
fi

exec node server.mjs --open

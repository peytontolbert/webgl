#!/usr/bin/env bash
set -euo pipefail

# Build + preview the WebGL viewer (Linux hosting friendly).
#
# Usage:
#   ./scripts/linux_viewer_build_preview.sh
#   WEBGL_VIEWER_HOST=0.0.0.0 WEBGL_VIEWER_PORT=4173 ./scripts/linux_viewer_build_preview.sh
#
# Note: expects runtime assets under webgl_viewer/assets (populated by setup_assets + exporters).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_env.sh"

HOST="${WEBGL_VIEWER_HOST:-0.0.0.0}"
PORT="${WEBGL_VIEWER_PORT:-4173}"

cd "webgl_viewer"

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not found in PATH." >&2
  exit 1
fi

if [ ! -d "node_modules" ]; then
  npm install
fi

npm run build

echo ""
echo "Viewer preview:"
echo "  http://${HOST}:${PORT}/"
echo ""

# Vite preview runs until interrupted.
npm run preview -- --host "${HOST}" --port "${PORT}" --strictPort



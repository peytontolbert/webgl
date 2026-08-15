#!/bin/sh

APP_DIR="/data/NexusAI/webglgta-demo"
PORT="${DEMO_PORT:-5173}"

if ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
  exit 0
fi

cd "$APP_DIR" || exit 1
exec env DEMO_PORT="$PORT" node demo_server.js >> demo_server.log 2>&1

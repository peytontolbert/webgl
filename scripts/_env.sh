#!/usr/bin/env bash
set -euo pipefail

# Shared env loader for Linux wrappers.
#
# - Loads env.local (preferred) or .env (fallback) if present
# - Sets default GTA path to /data/webglgta/gta5
# - Exports gta_location + gta5_path (both used across scripts)
# - Sets PYTHONNET_RUNTIME=coreclr by default on Linux (override if needed)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "$REPO_DIR"

set -a
if [ -f "env.local" ]; then
  # shellcheck disable=SC1091
  . "./env.local"
elif [ -f ".env" ]; then
  # shellcheck disable=SC1091
  . "./.env"
fi
set +a

export gta_location="${gta_location:-/data/webglgta/gta5}"
export gta5_path="${gta5_path:-$gta_location}"

# IMPORTANT (Linux):
# CodeWalker.Core.dll + SharpDX are generally more compatible with Mono on Linux than CoreCLR.
# So we do NOT force PYTHONNET_RUNTIME here.
# If you need to override, set it explicitly before running wrappers, e.g.:
#   PYTHONNET_RUNTIME=mono  ./scripts/linux_full_export_models_textures_materials.sh

# Export absolute repo path for other wrappers (so they can default output/assets dirs to absolute paths).
export WEBGLGTA_REPO_DIR="$REPO_DIR"



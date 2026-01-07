#!/usr/bin/env bash
set -euo pipefail

# One-command export -> viewer assets setup (Linux).
#
# Defaults:
# - GTA root: /data/webglgta/gta5 (or env.local/.env, or GTA_PATH env var)
# - Python venv: <repo>/.venv
#
# Usage:
#   ./scripts/linux_export_and_setup_assets.sh
#   GTA_PATH=/path/to/GTAV ./scripts/linux_export_and_setup_assets.sh
#   ./scripts/linux_export_and_setup_assets.sh --no-extract   # only run setup_assets from existing output/

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_env.sh"

NO_EXTRACT=0
for arg in "$@"; do
  case "$arg" in
    --no-extract) NO_EXTRACT=1 ;;
    *)
      echo "Unknown arg: $arg" >&2
      echo "Supported: --no-extract" >&2
      exit 2
      ;;
  esac
done

export gta_location="${GTA_PATH:-$gta_location}"
export gta5_path="${GTA_PATH:-$gta5_path}"

OUT_DIR="${OUT_DIR:-${WEBGLGTA_REPO_DIR}/output}"
ASSETS_DIR="${ASSETS_DIR:-${WEBGLGTA_REPO_DIR}/webgl_viewer/assets}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 not found in PATH." >&2
  exit 1
fi

if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate

python -m pip install -U pip setuptools wheel >/dev/null
python -m pip install -r requirements.txt

if [ "$NO_EXTRACT" -eq 0 ]; then
  echo "Running export (terrain + buildings) into $OUT_DIR ..."
  # Prefer the more complete pipeline if present.
  python gta5_terrain_extractor.py --game-path "$gta_location" --output-dir "$OUT_DIR"
else
  echo "Skipping extract (using existing $OUT_DIR)"
fi

echo "Setting up viewer assets from $OUT_DIR -> $ASSETS_DIR ..."
python webgl_viewer/setup_assets.py

echo ""
echo "Verifying entity chunks (integrity) ..."
python verify_entities_index.py --assets-dir "$ASSETS_DIR"

echo ""
echo "Verifying entity export coverage vs CodeWalker (all + patchday27ng union) ..."
python verify_export_vs_codewalker.py --game-path "$gta_location" --assets-dir "$ASSETS_DIR"

echo "Done."
echo "- output:         $OUT_DIR"
echo "- viewer assets:  $ASSETS_DIR"



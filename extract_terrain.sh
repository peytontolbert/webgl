#!/usr/bin/env bash
# Linux-friendly runner for the extractor.
#
# - Loads `env.local` if present (preferred)
# - Defaults GTA path to /data/webglgta/gta5 if nothing is set
# - Creates a local venv and installs requirements (non-interactive)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

echo "GTA 5 Terrain Extractor"
echo "----------------------"

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 not found in PATH (need Python 3.8+)." >&2
  exit 1
fi

python3 - <<'PY'
import sys
maj, min = sys.version_info[:2]
if (maj, min) < (3, 8):
    raise SystemExit(f"ERROR: Python 3.8+ required, found {maj}.{min}")
print(f"Python OK: {maj}.{min}")
PY

# Load env.local/.env if present (Bash-friendly KEY="VALUE" format).
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
# So we do NOT force PYTHONNET_RUNTIME here. Override explicitly if needed.

echo "Using GTA path:"
echo "  gta_location=$gta_location"
echo "  gta5_path=$gta5_path"

# Local venv
if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

python -m pip install -U pip setuptools wheel >/dev/null
python -m pip install -r requirements.txt

mkdir -p output

echo "Running terrain extractor..."
python extract_gta_terrain.py

echo "Terrain extraction completed successfully."
echo "Output files are in the output directory: ${REPO_DIR}/output"
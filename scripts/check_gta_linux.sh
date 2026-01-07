#!/usr/bin/env bash
set -euo pipefail

# Linux GTA-root sanity check + optional "backslash-compat" symlink fixups for CodeWalker.
#
# Why:
# CodeWalker sometimes uses Windows-style relative paths like:
#   update\update.rpf
#   \gta5.exe
# On Linux, backslashes are literal characters in file names, so these lookups fail unless
# we provide symlinks with those literal names.
#
# Usage:
#   ./scripts/check_gta_linux.sh
#   ./scripts/check_gta_linux.sh --fix
#   GTA_PATH=/data/webglgta/gta5 ./scripts/check_gta_linux.sh --fix
#
# Exit codes:
# - 0: OK
# - 2: missing required files

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_env.sh"

FIX=0
for arg in "$@"; do
  case "$arg" in
    --fix) FIX=1 ;;
    *)
      echo "Unknown arg: $arg" >&2
      echo "Supported: --fix" >&2
      exit 2
      ;;
  esac
done

GTA_ROOT="${GTA_PATH:-$gta_location}"

echo "GTA root: ${GTA_ROOT}"

missing=0

req_file() {
  local p="$1"
  if [ ! -e "$p" ]; then
    echo "MISSING: $p" >&2
    missing=1
  else
    echo "OK:      $p"
  fi
}

# Basic required archives for most pipelines.
req_file "${GTA_ROOT}/common.rpf"
req_file "${GTA_ROOT}/update/update.rpf"

# Exe presence (for keys). We accept any GTA5*.exe but still validate canonical ones.
if ls "${GTA_ROOT}"/GTA5*.exe >/dev/null 2>&1; then
  echo "OK:      ${GTA_ROOT}/GTA5*.exe"
else
  echo "MISSING: ${GTA_ROOT}/GTA5*.exe (needed for keys)" >&2
  missing=1
fi

if [ "$FIX" -eq 1 ]; then
  echo ""
  echo "Applying Linux backslash-compat symlinks (best-effort)..."

  # 1) Literal filename with leading backslash: "\gta5.exe"
  if [ ! -e "${GTA_ROOT}/\\gta5.exe" ]; then
    if [ -e "${GTA_ROOT}/GTA5.exe" ]; then
      ln -s "${GTA_ROOT}/GTA5.exe" "${GTA_ROOT}/\\gta5.exe" || true
    elif [ -e "${GTA_ROOT}/gta5.exe" ]; then
      ln -s "${GTA_ROOT}/gta5.exe" "${GTA_ROOT}/\\gta5.exe" || true
    fi
  fi

  # 2) Literal backslash in the middle: "update\update.rpf" in the GTA root
  if [ ! -e "${GTA_ROOT}/update\\update.rpf" ] && [ -e "${GTA_ROOT}/update/update.rpf" ]; then
    ln -s "${GTA_ROOT}/update/update.rpf" "${GTA_ROOT}/update\\update.rpf" || true
  fi

  # 3) Some CodeWalker code paths look for "update.rpf" directly in the GTA root.
  # Provide that name as a symlink to the real nested archive.
  if [ ! -e "${GTA_ROOT}/update.rpf" ] && [ -e "${GTA_ROOT}/update/update.rpf" ]; then
    ln -s "${GTA_ROOT}/update/update.rpf" "${GTA_ROOT}/update.rpf" || true
  fi
fi

echo ""
echo "Backslash-compat checks:"
req_file "${GTA_ROOT}/\\gta5.exe"
req_file "${GTA_ROOT}/update\\update.rpf"
req_file "${GTA_ROOT}/update.rpf"

if [ "$missing" -ne 0 ]; then
  echo ""
  echo "One or more required files are missing." >&2
  echo "If your GTA root is correct but the backslash-compat files are missing, run:" >&2
  echo "  ./scripts/check_gta_linux.sh --fix" >&2
  exit 2
fi

echo ""
echo "OK."



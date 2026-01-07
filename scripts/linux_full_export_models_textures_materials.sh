#!/usr/bin/env bash
set -euo pipefail

# Full WebGL viewer dataset export (Linux).
#
# Produces / updates:
# - output/: terrain + entities_index.json + entities_chunks/*.jsonl (via gta5_terrain_extractor.py)
# - webgl_viewer/assets/: synced terrain/entity assets (via webgl_viewer/setup_assets.py)
# - webgl_viewer/assets/models/*.bin + manifest.json (via export_drawables_all_chunks.py)
# - webgl_viewer/assets/models_textures/* (via export_* with --export-textures)
# - webgl_viewer/assets/models/manifest_shards/* + manifest_index.json (via setup_assets.py)
# - material/shader-derived fields in shard manifests (via update_models_manifest_shards_materials.py)
# - a readiness summary (via final_export_report.py)
#
# Defaults:
# - GTA root: /data/webglgta/gta5 (or env.local/.env, or GTA_PATH env var)
# - Python venv: <repo>/.venv
#
# Optional env limits (useful to iterate fast):
# - MAX_CHUNKS, MAX_ARCHETYPES_PER_CHUNK
# - MAX_VEHICLES, MAX_PEDS
#
# Usage:
#   ./scripts/linux_full_export_models_textures_materials.sh
#   GTA_PATH=/path/to/GTAV ./scripts/linux_full_export_models_textures_materials.sh
#
# Notes:
# - This can take a long time and write a lot of data if limits are not set.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_env.sh"

export gta_location="${GTA_PATH:-$gta_location}"
export gta5_path="${GTA_PATH:-$gta5_path}"

ASSETS_DIR="${ASSETS_DIR:-${WEBGLGTA_REPO_DIR}/webgl_viewer/assets}"
OUT_DIR="${OUT_DIR:-${WEBGLGTA_REPO_DIR}/output}"

MAX_CHUNKS="${MAX_CHUNKS:-0}"
MAX_ARCHETYPES_PER_CHUNK="${MAX_ARCHETYPES_PER_CHUNK:-0}"
MAX_VEHICLES="${MAX_VEHICLES:-0}"
MAX_PEDS="${MAX_PEDS:-0}"

echo "=== webgl-gta: full export (models + textures + materials) ==="
echo "GTA:"
echo "  gta_location=$gta_location"
echo "Output:"
echo "  OUT_DIR=$OUT_DIR"
echo "Viewer assets:"
echo "  ASSETS_DIR=$ASSETS_DIR"
echo "Limits:"
echo "  MAX_CHUNKS=$MAX_CHUNKS"
echo "  MAX_ARCHETYPES_PER_CHUNK=$MAX_ARCHETYPES_PER_CHUNK"
echo "  MAX_VEHICLES=$MAX_VEHICLES"
echo "  MAX_PEDS=$MAX_PEDS"

echo ""
echo "## 0) Check GTA root + Linux backslash-compat symlinks"
./scripts/check_gta_linux.sh --fix

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 not found in PATH." >&2
  exit 1
fi

if ! command -v dotnet >/dev/null 2>&1; then
  echo "ERROR: dotnet not found in PATH (required by pythonnet/CodeWalker on Linux)." >&2
  echo "Install the .NET runtime (e.g. dotnet 8) and retry." >&2
  exit 1
fi

if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate

python -m pip install -U pip setuptools wheel >/dev/null
python -m pip install -r requirements.txt

mkdir -p "$OUT_DIR"

echo ""
echo "## 1) Extract terrain + entities (writes $OUT_DIR/entities_index.json + entities_chunks/)"
python gta5_terrain_extractor.py --game-path "$gta_location" --output-dir "$OUT_DIR"

echo ""
echo "## 2) Sync output -> viewer assets (writes $ASSETS_DIR/entities_index.json, etc.)"
python webgl_viewer/setup_assets.py

echo ""
echo "## 3) Verify entity chunk index (catches duplicated/missing chunks)"
python verify_entities_index.py --assets-dir "$ASSETS_DIR"

echo ""
echo "## 3.1) Verify entity export coverage vs CodeWalker (all + patchday27ng union)"
python verify_export_vs_codewalker.py --game-path "$gta_location" --assets-dir "$ASSETS_DIR"

echo ""
echo "## 4) Export streamed-world drawables (meshes + textures)"
python export_drawables_all_chunks.py \
  --game-path "$gta_location" \
  --assets-dir "$ASSETS_DIR" \
  --selected-dlc all \
  --split-by-dlc \
  --max-chunks "$MAX_CHUNKS" \
  --max-archetypes "$MAX_ARCHETYPES_PER_CHUNK" \
  --skip-existing \
  --export-textures

echo ""
echo "## 5) Export vehicles/peds/fragments (optional but included; meshes + textures)"
python export_vehicles_peds_fragments.py \
  --game-path "$gta_location" \
  --assets-dir "$ASSETS_DIR" \
  --selected-dlc all \
  --split-by-dlc \
  --max-vehicles "$MAX_VEHICLES" \
  --max-peds "$MAX_PEDS" \
  --skip-existing \
  --export-textures

echo ""
echo "## 6) Ensure sharded manifests exist / updated"
python webgl_viewer/setup_assets.py

echo ""
echo "## 6.1) Build binary instance chunks for fast model streaming (removes entities_chunks_inst 404s)"
python webgl_viewer/setup_assets.py --build-entity-inst-bins

echo ""
echo "## 6.2) Verify model manifest references actual on-disk .bin files"
python verify_models_manifest_files.py --assets-dir "$ASSETS_DIR" --write-missing-json "$OUT_DIR/missing_mesh_bins.json"

echo ""
echo "## 6.3) Repair missing mesh bins (targeted re-export)"
python export_drawables_from_list.py \
  --game-path "$gta_location" \
  --assets-dir "$ASSETS_DIR" \
  --input "$OUT_DIR/missing_mesh_bins.json" \
  --write-report

echo ""
echo "## 7) Final-pass material/shader-derived fields into shard manifests (textures if missing)"
python update_models_manifest_shards_materials.py \
  --game-path "$gta_location" \
  --assets-dir "$ASSETS_DIR" \
  --only-missing

echo ""
echo "## 7.1) Texture backfill for manifest (fastest way to stop models_textures/<hash>.png 404s)"
python export_textures_for_manifest.py \
  --game-path "$gta_location" \
  --assets-dir "$ASSETS_DIR" \
  --selected-dlc all \
  --split-by-dlc \
  --only-missing \
  --only-missing-files \
  --only-missing-maps "diffuse,diffuse2,normal,spec,emissive,detail,ao,alphaMask"

echo ""
echo "## 7.2) Refresh models_textures indices (base + packs) after texture/material backfills"
python webgl_viewer/setup_assets.py

echo ""
echo "## 7.3) Detect any remaining missing model textures from sharded manifests and write a 'missing with refs' list"
MISSING_MODEL_TEX_JSON="$OUT_DIR/missing_model_textures_from_manifest_with_refs.json"
# Default to a manageable batch size for the drawable-based repair step (can be overridden).
MAX_MISSING_TEX="${MAX_MISSING_TEX:-8000}"
MAX_REFS_PER_TEX="${MAX_REFS_PER_TEX:-200}"
python webgl_viewer/tools/build_missing_textures_remaining_from_manifests.py \
  --root "$ASSETS_DIR/.." \
  --max-textures "$MAX_MISSING_TEX" \
  --max-refs-per-texture "$MAX_REFS_PER_TEX" \
  --out "$MISSING_MODEL_TEX_JSON"

# Targeted indexing for faster repairs (optional but recommended).
echo ""
echo "## 7.3.1) Build missing-texture -> YTD index (targeted; speeds up extraction)"
TEX_INDEX_JSON="$OUT_DIR/texture_hash_index_missing_only.json"
python webgl_viewer/tools/build_texture_hash_index.py \
  --gta-path "$gta_location" \
  --selected-dlc all \
  --also-scan-dlc patchday27ng \
  --need "$MISSING_MODEL_TEX_JSON" \
  --assets-dir "$ASSETS_DIR" \
  --out "$TEX_INDEX_JSON"

echo ""
echo "## 7.3.2) Global YTD-based missing texture export (targeted via index)"
python webgl_viewer/tools/extract_missing_textures_global_scan.py \
  --gta-path "$gta_location" \
  --selected-dlc all \
  --also-scan-dlc patchday27ng \
  --dump "$MISSING_MODEL_TEX_JSON" \
  --assets-dir "$ASSETS_DIR" \
  --split-by-dlc \
  --texture-index "$TEX_INDEX_JSON"

echo ""
echo "## 7.3.3) Refresh models_textures indices after global YTD-based repair"
python webgl_viewer/setup_assets.py

# If the report is an empty array, skip.
if [ -s "$MISSING_MODEL_TEX_JSON" ] && ! grep -q '^\s*\[\s*\]\s*$' "$MISSING_MODEL_TEX_JSON"; then
  echo ""
  echo "## 7.4) Recompute missing list (post-YTD repair) for drawable-based export"
  python webgl_viewer/tools/build_missing_textures_remaining_from_manifests.py \
    --root "$ASSETS_DIR/.." \
    --max-textures "$MAX_MISSING_TEX" \
    --max-refs-per-texture "$MAX_REFS_PER_TEX" \
    --out "$MISSING_MODEL_TEX_JSON"

  echo ""
  echo "## 7.5) Drawable-based missing texture export (targeted; fixes textures not reachable via YTD scan/lookup)"
  python webgl_viewer/tools/extract_missing_textures_from_drawables.py \
    --gta-path "$gta_location" \
    --assets-dir "$ASSETS_DIR" \
    --selected-dlc all \
    --also-scan-dlc patchday27ng \
    --split-by-dlc \
    --missing "$MISSING_MODEL_TEX_JSON" \
    --drawable-spins 400

  echo ""
  echo "## 7.6) Refresh models_textures indices after drawable-based repair"
  python webgl_viewer/setup_assets.py
else
  echo "[ok] No remaining missing model textures detected in manifests."
fi

echo ""
echo "## 8) Export readiness report"
python final_export_report.py --assets-dir "$ASSETS_DIR"

echo ""
echo "Done."
echo "- output:        $OUT_DIR"
echo "- viewer assets: $ASSETS_DIR"



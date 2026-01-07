#!/usr/bin/env python3
"""
Final-pass material + texture export into sharded model manifest files.

Why:
- Monolithic assets/models/manifest.json can be huge.
- The viewer prefers sharded manifests (manifest_index.json + manifest_shards/*.json).
- We want a one-time "final export" pass that fills per-submesh material fields
  (diffuse/normal/spec + scalar params) and writes referenced textures to disk,
  WITHOUT re-exporting geometry bins.

This script updates ONLY the shard files by default.

Usage:
  python webgl/update_models_manifest_shards_materials.py --game-path "X:\\GTA5" --assets-dir webgl/webgl_viewer/assets
"""

import argparse
import json
import os
from pathlib import Path

from gta5_modules.dll_manager import DllManager
from gta5_modules.rpf_reader import RpfReader
from gta5_modules.script_paths import auto_assets_dir
from gta5_modules.hash_utils import as_u32_int as _as_u32_int
from gta5_modules.codewalker_archetypes import get_archetype_best_effort
from gta5_modules.cw_loaders import try_get_drawable as _try_get_drawable
from gta5_modules.cw_loaders import try_get_ytd as _try_get_ytd


def _as_u32(s: str):
    # Wrapper kept for backwards-compat within this script.
    return _as_u32_int(s)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-path", default=os.getenv("gta_location", ""), help="GTA5 install folder (or set gta_location)")
    ap.add_argument("--assets-dir", default="", help="webgl_viewer/assets folder (auto if omitted)")
    ap.add_argument("--max-meshes", type=int, default=0, help="Limit number of meshes processed (0 = all)")
    ap.add_argument("--only-missing", action="store_true", help="Only write textures/material fields when material.diffuse is missing")
    ap.add_argument(
        "--only-empty-materials",
        action="store_true",
        help="Only process entries that have at least one EMPTY submesh material dict (lods[].submeshes[].material == {}). "
             "This is a fast repair mode for 'untextured' props caused by missing material metadata.",
    )
    ap.add_argument("--write-monolithic", action="store_true", help="Also update assets/models/manifest.json (slow/huge)")
    args = ap.parse_args()

    game_path = (args.game_path or "").strip('"').strip("'")
    if not game_path:
        raise SystemExit("Missing --game-path (or gta_location env var)")

    assets_dir = auto_assets_dir(args.assets_dir)

    models_dir = assets_dir / "models"
    index_path = models_dir / "manifest_index.json"
    shard_dir = models_dir / "manifest_shards"
    if not index_path.exists() or not shard_dir.exists():
        raise SystemExit(f"Missing sharded manifest. Expected {index_path} and {shard_dir}")

    idx = json.loads(index_path.read_text(encoding="utf-8", errors="ignore"))
    if not isinstance(idx, dict) or idx.get("schema") != "webglgta-manifest-index-v1":
        raise SystemExit(f"Unexpected manifest index schema in {index_path}")

    dm = DllManager(game_path)
    if not dm.initialized:
        raise SystemExit("Failed to initialize DllManager")
    if not dm.init_game_file_cache():
        raise SystemExit("Failed to init GameFileCache (required for textures/materials)")
    gfc = dm.get_game_file_cache()
    try:
        gfc.MaxItemsPerLoop = 50
    except Exception:
        pass

    rpf_reader = RpfReader(str(game_path), dm)

    # Reuse the (now richer) material update logic from the chunk exporter.
    from export_drawables_for_chunk import (  # type: ignore
        _extract_drawable_lod_submeshes,
        _update_existing_manifest_materials_for_drawable,
    )

    # Iterate shards.
    shard_files = sorted(shard_dir.glob("*.json"))
    if not shard_files:
        raise SystemExit(f"No shard files found in {shard_dir}")

    processed = 0
    wrote_textures = 0
    updated_entries = 0
    def _entry_has_any_empty_submesh_material(entry: dict) -> bool:
        try:
            lods = entry.get("lods") if isinstance(entry, dict) else None
            if not isinstance(lods, dict):
                return False
            for lod_meta in lods.values():
                if not isinstance(lod_meta, dict):
                    continue
                subs = lod_meta.get("submeshes")
                if not isinstance(subs, list):
                    continue
                for sm in subs:
                    if not isinstance(sm, dict):
                        continue
                    m = sm.get("material")
                    if isinstance(m, dict) and (len(m) == 0):
                        return True
            return False
        except Exception:
            return False

    def _count_empty_submesh_materials(entry: dict) -> int:
        try:
            c = 0
            lods = entry.get("lods") if isinstance(entry, dict) else None
            if not isinstance(lods, dict):
                return 0
            for lod_meta in lods.values():
                if not isinstance(lod_meta, dict):
                    continue
                subs = lod_meta.get("submeshes")
                if not isinstance(subs, list):
                    continue
                for sm in subs:
                    if not isinstance(sm, dict):
                        continue
                    m = sm.get("material")
                    if isinstance(m, dict) and (len(m) == 0):
                        c += 1
            return int(c)
        except Exception:
            return 0

    for si, sf in enumerate(shard_files):
        payload = json.loads(sf.read_text(encoding="utf-8", errors="ignore"))
        meshes = (payload.get("meshes") or {}) if isinstance(payload, dict) else {}
        if not isinstance(meshes, dict) or not meshes:
            continue

        changed = False
        for hs, entry in list(meshes.items()):
            if args.max_meshes and int(args.max_meshes) > 0 and processed >= int(args.max_meshes):
                break

            h = _as_u32(hs)
            if h is None or not isinstance(entry, dict):
                processed += 1
                continue

            # Fast repair mode: only touch meshes whose submesh materials are literally empty.
            if bool(args.only_empty_materials) and (not _entry_has_any_empty_submesh_material(entry)):
                processed += 1
                continue

            # Optional "only-missing" quick gate.
            if args.only_missing:
                try:
                    # Old behavior skipped the whole mesh if ANY submesh had diffuse, which prevented
                    # repairing partially-missing materials and stale shaderParams. Instead, skip only
                    # when ALL submeshes already have diffuse (ie nothing to repair).
                    lods = (entry.get("lods") or {})
                    any_missing = False
                    any_seen = False
                    if isinstance(lods, dict):
                        for lod_meta in lods.values():
                            subs = (lod_meta or {}).get("submeshes") if isinstance(lod_meta, dict) else None
                            if not isinstance(subs, list):
                                continue
                            for sm in subs:
                                if not isinstance(sm, dict):
                                    continue
                                mat = sm.get("material")
                                if not isinstance(mat, dict):
                                    continue
                                any_seen = True
                                if not mat.get("diffuse"):
                                    any_missing = True
                                    break
                            if any_missing:
                                break
                    # If we saw submeshes and none are missing diffuse, skip.
                    if any_seen and (not any_missing):
                        processed += 1
                        continue
                except Exception:
                    pass

            arch = get_archetype_best_effort(gfc, int(h) & 0xFFFFFFFF, dll_manager=dm)
            if arch is None:
                processed += 1
                continue

            # Load drawable and pump loader briefly.
            drawable = _try_get_drawable(gfc, arch, spins=400)
            if drawable is None:
                processed += 1
                continue

            # Load texdict textures (best-effort).
            td_hash = None
            textures = None
            try:
                tdh = getattr(arch, "TextureDict", None)
                if tdh is not None:
                    td_hash = int(getattr(tdh, "Hash", int(tdh))) & 0xFFFFFFFF
            except Exception:
                td_hash = None
            try:
                if td_hash and td_hash != 0:
                    ytd = _try_get_ytd(gfc, int(td_hash) & 0xFFFFFFFF, spins=400)
                    if ytd is not None and getattr(ytd, "Loaded", True):
                        textures = rpf_reader.get_ytd_textures(ytd)
            except Exception:
                textures = None

            tex_dir = assets_dir / "models_textures"
            tex_dir.mkdir(parents=True, exist_ok=True)

            # Ensure we can map submesh index ordering similarly to the exporter.
            # (If not, we still update what we can.)
            _ = _extract_drawable_lod_submeshes(drawable, "High")

            before_wrote = wrote_textures
            before_empty = _count_empty_submesh_materials(entry) if bool(args.only_empty_materials) else 0
            wrote_textures += int(
                _update_existing_manifest_materials_for_drawable(
                    entry=entry,
                    drawable=drawable,
                    textures=textures,
                    td_hash=td_hash,
                    tex_dir=tex_dir,
                    dll_manager=dm,
                )
                or 0
            )
            after_empty = _count_empty_submesh_materials(entry) if bool(args.only_empty_materials) else before_empty
            # Treat either newly written textures OR newly filled material metadata as a change.
            if (wrote_textures != before_wrote) or (after_empty < before_empty):
                changed = True
                updated_entries += 1

            processed += 1

        if changed:
            sf.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")

        if (si + 1) % 25 == 0:
            print(f"[shards {si+1}/{len(shard_files)}] meshes_processed={processed} entries_updated={updated_entries} textures_written={wrote_textures}")

        if args.max_meshes and int(args.max_meshes) > 0 and processed >= int(args.max_meshes):
            break

    print(f"Done. meshes_processed={processed} entries_updated={updated_entries} textures_written={wrote_textures}")

    if args.write_monolithic:
        # Optional: rewrite monolithic manifest by merging shards into it (expensive).
        mp = models_dir / "manifest.json"
        if mp.exists():
            mm = json.loads(mp.read_text(encoding="utf-8", errors="ignore"))
            if isinstance(mm, dict) and isinstance(mm.get("meshes"), dict):
                # Merge shards in.
                for sf in sorted(shard_dir.glob("*.json")):
                    payload = json.loads(sf.read_text(encoding="utf-8", errors="ignore"))
                    meshes = (payload.get("meshes") or {}) if isinstance(payload, dict) else {}
                    if isinstance(meshes, dict):
                        for k, v in meshes.items():
                            mm["meshes"][k] = v
                mp.write_text(json.dumps(mm), encoding="utf-8")
                print(f"Wrote monolithic manifest (no pretty-print): {mp}")


if __name__ == "__main__":
    main()



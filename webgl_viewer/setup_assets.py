import shutil
import json
from pathlib import Path
import re
import struct
from typing import Optional

# Optional (best-effort) deps for generating a viewer blend mask from height/normal images.
try:
    import numpy as np  # type: ignore
except Exception:
    np = None
try:
    from PIL import Image  # type: ignore
except Exception:
    Image = None
import argparse
import time
from array import array
import zlib
from collections import OrderedDict

# CLI-tunable globals (defaults keep current behavior)
_SHOULD_BUILD_ENTITY_BINS = False
_MAX_BINS_CHUNKS = 0
_SHOULD_BUILD_ENTITY_INST_BINS = False
_MAX_INST_BINS_CHUNKS = 0
_SHOULD_BUILD_CHUNK_SHARD_INDEX = False
_MAX_CHUNK_SHARD_INDEX_CHUNKS = 0

def setup_assets():
    """Set up assets for the WebGL viewer"""
    viewer_dir = Path(__file__).parent.resolve()
    webgl_dir = viewer_dir.parent.resolve()
    output_dir = webgl_dir / 'output'

    # Create legacy assets directory (this is where all exporters/scripts expect to write).
    assets_dir = viewer_dir / 'assets'
    assets_dir.mkdir(parents=True, exist_ok=True)

    # Linux hosting gotcha:
    # Some older workflows created symlinks inside assets/ (e.g. assets/ymap/entities -> output/ymap/entities).
    # If the target later moves or isn't generated, the symlink becomes broken and Vite preview (sirv/totalist)
    # will crash when it tries to stat() it.
    #
    # Repair common broken symlink directories by converting them into real directories.
    def _repair_dir_path(p: Path) -> None:
        try:
            if p.is_symlink() and not p.exists():
                p.unlink()
        except Exception:
            pass
        if p.exists() and not p.is_dir():
            raise SystemExit(f"Expected directory at {p} but found a file. Please remove it and retry.")
        p.mkdir(parents=True, exist_ok=True)

    # Ensure assets/ymap/entities is a real directory (or a valid symlink), so preview servers don't crash.
    try:
        ymap_dir = assets_dir / "ymap"
        if ymap_dir.exists() and ymap_dir.is_dir():
            _repair_dir_path(ymap_dir / "entities")
    except Exception:
        # Keep setup best-effort; missing ymap content is not fatal to the core viewer.
        pass
    
    # Copy terrain.obj if it exists
    terrain_obj = output_dir / 'terrain.obj'
    if terrain_obj.exists():
        shutil.copy2(terrain_obj, assets_dir / 'terrain.obj')
        print("Copied terrain.obj")
    else:
        print("Warning: terrain.obj not found")
    
    # Copy terrain_info.json if it exists
    terrain_info = output_dir / 'terrain_info.json'
    if terrain_info.exists():
        # Patch the OUTPUT terrain_info.json too (not just the assets copy) so it doesn't stay at num_textures=0
        # when output/textures contains real exported PNGs.
        _patch_terrain_info_with_detected_textures(terrain_info, output_dir / 'textures')
        shutil.copy2(terrain_info, assets_dir / 'terrain_info.json')
        print("Copied terrain_info.json")
    else:
        print("Warning: terrain_info.json not found")
    
    # Copy heightmap.png if it exists
    # Prefer collision-derived heightmap if available (looks much more like “game ground”).
    heightmap_collision = output_dir / 'heightmap_collision.png'
    heightmap = output_dir / 'heightmap.png'
    if heightmap_collision.exists():
        shutil.copy2(heightmap_collision, assets_dir / 'heightmap.png')
        print("Copied heightmap_collision.png -> assets/heightmap.png")
    elif heightmap.exists():
        shutil.copy2(heightmap, assets_dir / 'heightmap.png')
        print("Copied heightmap.png")
    else:
        print("Warning: heightmap.png not found")

    # Copy 16-bit heightmap assets if they exist (preferred by the viewer when present).
    # Browser image decode paths are effectively 8-bit, so we use a raw uint16 blob + small JSON metadata.
    # Expected output files:
    # - heightmap_u16.json + heightmap_u16.bin
    # - OR collision-derived: heightmap_collision_u16.json + heightmap_collision_u16.bin
    hm16_json_collision = output_dir / 'heightmap_collision_u16.json'
    hm16_bin_collision = output_dir / 'heightmap_collision_u16.bin'
    hm16_json = output_dir / 'heightmap_u16.json'
    hm16_bin = output_dir / 'heightmap_u16.bin'

    if hm16_bin_collision.exists() and hm16_json_collision.exists():
        shutil.copy2(hm16_json_collision, assets_dir / 'heightmap_u16.json')
        shutil.copy2(hm16_bin_collision, assets_dir / 'heightmap_u16.bin')
        print("Copied heightmap_collision_u16.(json|bin) -> assets/heightmap_u16.(json|bin)")
    elif hm16_bin.exists() and hm16_json.exists():
        shutil.copy2(hm16_json, assets_dir / 'heightmap_u16.json')
        shutil.copy2(hm16_bin, assets_dir / 'heightmap_u16.bin')
        print("Copied heightmap_u16.(json|bin) -> assets/heightmap_u16.(json|bin)")
    elif hm16_bin_collision.exists() or hm16_json_collision.exists() or hm16_bin.exists() or hm16_json.exists():
        print("Warning: Found partial 16-bit heightmap outputs; expected both .json and .bin (viewer will fall back to heightmap.png).")

    # Copy normalmap/lod visualization if they exist (useful for viewer shading/debug)
    normalmap = output_dir / 'normalmap.png'
    if normalmap.exists():
        shutil.copy2(normalmap, assets_dir / 'normalmap.png')
        print("Copied normalmap.png")

    lod_levels = output_dir / 'lod_levels.png'
    if lod_levels.exists():
        shutil.copy2(lod_levels, assets_dir / 'lod_levels.png')
        print("Copied lod_levels.png")

    # Optional: copy entities/buildings outputs for debugging/inspection
    entities_obj = output_dir / 'entities.obj'
    if entities_obj.exists():
        shutil.copy2(entities_obj, assets_dir / 'entities.obj')
        print("Copied entities.obj")

    buildings_obj = output_dir / 'buildings.obj'
    if buildings_obj.exists():
        shutil.copy2(buildings_obj, assets_dir / 'buildings.obj')
        print("Copied buildings.obj")

    building_info = output_dir / 'building_info.json'
    if building_info.exists():
        shutil.copy2(building_info, assets_dir / 'building_info.json')
        print("Copied building_info.json")

    # Client-like entity streaming assets
    entities_index = output_dir / 'entities_index.json'
    if entities_index.exists():
        shutil.copy2(entities_index, assets_dir / 'entities_index.json')
        print("Copied entities_index.json")

    chunks_src = output_dir / 'entities_chunks'
    if chunks_src.exists():
        chunks_dst = assets_dir / 'entities_chunks'
        # Linux gotcha: a broken symlink returns exists()==False, but still blocks mkdir().
        # If a previous workflow created `assets/entities_chunks` as a symlink (and the target moved),
        # remove it and recreate a real directory so setup is idempotent.
        try:
            if chunks_dst.is_symlink() and not chunks_dst.exists():
                chunks_dst.unlink()
        except Exception:
            pass
        # If it exists but isn't a directory, fail loudly (we can't safely proceed).
        if chunks_dst.exists() and not chunks_dst.is_dir():
            raise SystemExit(f"Expected directory at {chunks_dst} but found a file. Please remove it and retry.")
        chunks_dst.mkdir(parents=True, exist_ok=True)
        # Copy chunk files (jsonl)
        for chunk_file in chunks_src.glob('*.jsonl'):
            shutil.copy2(chunk_file, chunks_dst / chunk_file.name)
        print("Copied entities_chunks/*.jsonl")

        # Optional interiors (MLO archetype defs): output/interiors/*.json -> assets/interiors/*.json
        interiors_src = output_dir / 'interiors'
        if interiors_src.exists():
            interiors_dst = assets_dir / 'interiors'
            interiors_dst.mkdir(exist_ok=True)
            for f in interiors_src.glob('*.json'):
                shutil.copy2(f, interiors_dst / f.name)
            print("Copied interiors/*.json")

        # Optional: build fast binary position chunks for dot rendering
        # (keeps JSONL for model streaming / archetype data).
        if _SHOULD_BUILD_ENTITY_BINS:
            try:
                _build_entity_position_bins(assets_dir, max_chunks=_MAX_BINS_CHUNKS)
            except Exception as e:
                print(f"Warning: failed to build entity position bins: {e}")

        # Optional: build binary instance chunks for drawable streaming (archetype + transform).
        if _SHOULD_BUILD_ENTITY_INST_BINS:
            try:
                _build_entity_instance_bins(assets_dir, max_chunks=_MAX_INST_BINS_CHUNKS)
            except Exception as e:
                print(f"Warning: failed to build entity instance bins: {e}")

        # Backfill YMAP-level entity JSON files if a YMAP index exists.
        # This is used by some coverage tooling (`report_world_coverage.py`) and older workflows.
        try:
            _ensure_ymap_entities_from_streamed_chunks(assets_dir)
        except Exception as e:
            print(f"Warning: failed to build assets/ymap/entities from entities_chunks: {e}")
    
    # Copy terrain textures from output/textures directory (optional; not related to model textures).
    textures_dir = output_dir / 'textures'
    if textures_dir.exists():
        # Create textures directory in assets
        assets_textures_dir = assets_dir / 'textures'
        assets_textures_dir.mkdir(exist_ok=True)
        
        # Copy all texture files
        for texture_file in textures_dir.glob('*.png'):
            shutil.copy2(texture_file, assets_textures_dir / texture_file.name)
            print(f"Copied texture: {texture_file.name}")
    else:
        print("Warning: output/textures directory not found (terrain textures). This is OK for models-only exports.")

    # Copy model textures from common export output layouts into assets/models_textures/.
    #
    # Notes:
    # - Some exporters write directly into webgl/webgl_viewer/assets/models_textures/ already.
    # - Other pipelines export into webgl/output/... first (historical layouts vary).
    # - The runtime expects model textures under assets/models_textures/ (not assets/textures/).
    def _copy_newer(src: Path, dst: Path) -> bool:
        try:
            dst.parent.mkdir(parents=True, exist_ok=True)
            if dst.exists():
                try:
                    if dst.stat().st_mtime >= src.stat().st_mtime:
                        return False
                except Exception:
                    pass
            shutil.copy2(src, dst)
            return True
        except Exception:
            return False

    model_tex_candidates = [
        output_dir / 'models_textures',
        output_dir / 'models' / 'models_textures',
        output_dir / 'models_textures_png',
        # Common "stage into viewer assets directly" layouts (some export scripts write here).
        assets_dir / 'models_textures',
    ]
    assets_models_textures_dir = assets_dir / 'models_textures'
    copied_model_textures = 0
    found_model_tex_src_dirs = []
    for src_dir in model_tex_candidates:
        if not src_dir.exists():
            continue
        found_model_tex_src_dirs.append(str(src_dir))
        try:
            assets_models_textures_dir.mkdir(parents=True, exist_ok=True)
            # Viewer supports these extensions for model textures.
            for p in (
                list(src_dir.glob('*.png'))
                + list(src_dir.glob('*.dds'))
                + list(src_dir.glob('*.jpg'))
                + list(src_dir.glob('*.jpeg'))
                + list(src_dir.glob('*.webp'))
            ):
                if _copy_newer(p, assets_models_textures_dir / p.name):
                    copied_model_textures += 1
        except Exception:
            # Keep asset setup best-effort.
            continue
    # Always print a diagnostic summary (this avoids "it looked like it worked" confusion).
    try:
        existing_assets_model_textures = 0
        if assets_models_textures_dir.exists():
            existing_assets_model_textures = len([p for p in assets_models_textures_dir.iterdir() if p.is_file() and p.suffix.lower() in ('.png', '.dds', '.jpg', '.jpeg', '.webp')])
        if copied_model_textures > 0:
            print(f"Copied model textures into assets/models_textures: {copied_model_textures} files")
        else:
            if found_model_tex_src_dirs:
                print("No newer model textures to copy into assets/models_textures (sources were present, but nothing needed updating).")
            else:
                print("Warning: No model texture source directories found in output/. If you expected model textures, ensure your export writes to output/models_textures/ (or similar).")
        print(f"Model textures staged: assets/models_textures files={existing_assets_model_textures}")
    except Exception:
        pass

    # Optional: copy model textures KTX2 (if your exporter/repair tools emitted them).
    # Layout:
    #   output/models_textures_ktx2/*.ktx2 -> assets/models_textures_ktx2/*.ktx2
    model_tex_ktx2_candidates = [
        output_dir / 'models_textures_ktx2',
        output_dir / 'models' / 'models_textures_ktx2',
        # Some pipelines stage directly into viewer assets.
        assets_dir / 'models_textures_ktx2',
    ]
    assets_models_textures_ktx2_dir = assets_dir / 'models_textures_ktx2'
    copied_model_textures_ktx2 = 0
    found_model_tex_k2_src_dirs = []
    for src_dir in model_tex_ktx2_candidates:
        if not src_dir.exists():
            continue
        found_model_tex_k2_src_dirs.append(str(src_dir))
        try:
            assets_models_textures_ktx2_dir.mkdir(parents=True, exist_ok=True)
            for p in list(src_dir.glob('*.ktx2')):
                if _copy_newer(p, assets_models_textures_ktx2_dir / p.name):
                    copied_model_textures_ktx2 += 1
        except Exception:
            # Keep asset setup best-effort.
            continue
    try:
        existing_assets_model_textures_ktx2 = 0
        if assets_models_textures_ktx2_dir.exists():
            existing_assets_model_textures_ktx2 = len([p for p in assets_models_textures_ktx2_dir.iterdir() if p.is_file() and p.suffix.lower() == '.ktx2'])
        if copied_model_textures_ktx2 > 0:
            print(f"Copied model textures into assets/models_textures_ktx2: {copied_model_textures_ktx2} files")
        else:
            if found_model_tex_k2_src_dirs:
                print("No newer model KTX2 textures to copy into assets/models_textures_ktx2.")
        if existing_assets_model_textures_ktx2:
            print(f"Model textures staged: assets/models_textures_ktx2 files={existing_assets_model_textures_ktx2}")
    except Exception:
        pass

    # Optional: copy asset packs from output into assets.
    #
    # Layout:
    #   output/packs/<packId>/models_textures/*.png  -> assets/packs/<packId>/models_textures/*.png
    #
    # This lets exporters/repair tools write to output/ first and rely on setup_assets to stage into assets/.
    try:
        out_packs = output_dir / "packs"
        if out_packs.exists() and out_packs.is_dir():
            assets_packs = assets_dir / "packs"
            copied_packs = 0
            for pack_dir in sorted([p for p in out_packs.iterdir() if p.is_dir()]):
                pack_id = pack_dir.name
                src_mt = pack_dir / "models_textures"
                if not (src_mt.exists() and src_mt.is_dir()):
                    continue
                dst_mt = assets_packs / pack_id / "models_textures"
                dst_mt.mkdir(parents=True, exist_ok=True)
                for p in (
                    list(src_mt.glob("*.png"))
                    + list(src_mt.glob("*.dds"))
                    + list(src_mt.glob("*.jpg"))
                    + list(src_mt.glob("*.jpeg"))
                    + list(src_mt.glob("*.webp"))
                ):
                    if _copy_newer(p, dst_mt / p.name):
                        copied_packs += 1
                # Optional KTX2 pack textures
                src_k2 = pack_dir / "models_textures_ktx2"
                if src_k2.exists() and src_k2.is_dir():
                    dst_k2 = assets_packs / pack_id / "models_textures_ktx2"
                    dst_k2.mkdir(parents=True, exist_ok=True)
                    for p in list(src_k2.glob("*.ktx2")):
                        if _copy_newer(p, dst_k2 / p.name):
                            copied_packs += 1
            if copied_packs > 0:
                print(f"Copied pack model textures into assets/packs/**/models_textures: {copied_packs} files")
    except Exception:
        pass

    # Optional but important: build a texture index so the runtime can resolve hash-only <-> hash+slug
    # naming discrepancies without spamming 404 probes or leaving materials untextured.
    try:
        _ensure_models_textures_index(assets_dir)
    except Exception as e:
        print(f"Warning: failed to generate models_textures/index.json: {e}")

    # If terrain_info.json indicates no textures, try to auto-link terrain textures from the copied PNGs.
    _patch_terrain_info_with_detected_textures(assets_dir / 'terrain_info.json', assets_dir / 'textures')

    # Best-effort: if we don't have a real terrain blend mask, generate one from height/normal maps so
    # the WebGL viewer can do true 4-layer splat blending (still heuristic, but much better than 1-texture).
    _ensure_terrain_blend_mask_from_height_slope(assets_dir)
    
    # Create a manifest file for the viewer
    manifest = {
        'version': '1.0',
        'terrain': {
            'obj_file': 'terrain.obj',
            'info_file': 'terrain_info.json',
            'heightmap_file': 'heightmap.png',
            'textures_dir': 'textures'
        }
    }
    
    with open(assets_dir / 'manifest.json', 'w') as f:
        json.dump(manifest, f, indent=2)

    # Build / repair models manifest if model bins exist.
    _ensure_models_manifest(assets_dir / 'models')
    # Generate a sharded manifest (manifest_index.json + manifest_shards/*.json) for faster web startup.
    _ensure_models_manifest_shards(assets_dir / 'models')

    # Optional but very useful: export CodeWalker ShaderParamNames (hash -> name) for
    # viewer-side shaderParams introspection + best-effort material normalization.
    # This is fast (~1-2s) and produces a small JSON file under assets/.
    try:
        _ensure_shader_param_name_map(assets_dir)
    except Exception as e:
        print(f"Warning: failed to generate shader_param_names.json: {e}")

    # Optional: build a small chunk->model-manifest-shards index to enable faster runtime prefetching.
    # This is separate from entities_index.json (which only maps chunk keys to filenames/counts).
    if _SHOULD_BUILD_CHUNK_SHARD_INDEX:
        try:
            _build_entities_chunk_shard_index(assets_dir, max_chunks=_MAX_CHUNK_SHARD_INDEX_CHUNKS)
        except Exception as e:
            print(f"Warning: failed to build entities_chunk_shards.json: {e}")
    
    print("\nAsset setup complete!")
    print(f"Assets directory: {assets_dir.absolute()}")


def _ensure_ymap_entities_from_streamed_chunks(assets_dir: Path, *, force: bool = False) -> None:
    """
    Ensure `assets/ymap/entities/*.json` exists for every entry in `assets/ymap/index.json`.

    Why:
      - `report_world_coverage.py` reports YMAP coverage by checking these files.
      - Some older pipelines produced per-YMAP entity JSON, while newer ones produce chunked `entities_chunks/*.jsonl`.
      - When sharding/export pipelines change, it’s easy to end up with `ymap/index.json` but no `ymap/entities/*`,
        which makes coverage reports misleading (`missing ymap entity json files: N`).

    Source of truth:
      - We build these files from the already-exported streamed entities under `assets/entities_chunks/*.jsonl`.

    Output format:
      - JSON object with schema + an `entities` array.
      - Written in a streaming fashion (no need to hold all entities in memory).
    """
    ymap_index_path = assets_dir / "ymap" / "index.json"
    chunks_dir = assets_dir / "entities_chunks"
    if not ymap_index_path.exists():
        return
    if not chunks_dir.exists():
        return

    ymap_dir = assets_dir / "ymap"
    ent_dir = ymap_dir / "entities"
    ent_dir.mkdir(parents=True, exist_ok=True)

    # If we already have any entity files, assume this step was run before.
    # (Avoid rewriting 19k+ files on every setup_assets run.)
    if not force:
        try:
            any_existing = next(iter([p for p in ent_dir.glob("*.json") if p.is_file()]), None)
            if any_existing is not None:
                return
        except Exception:
            pass

    try:
        idx = json.loads(ymap_index_path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return

    rows = idx.get("ymaps") if isinstance(idx, dict) else None
    if not isinstance(rows, list) or not rows:
        return

    expected_files = set()
    base_to_variants = {}
    for r in rows:
        if not isinstance(r, dict):
            continue
        fn = str(r.get("file") or "").strip()
        if not fn:
            continue
        expected_files.add(fn)
        base = fn
        if base.lower().endswith(".json"):
            base = base[:-5]
        # Map base -> list of variant filenames (for __<hash> disambiguation)
        base_key = base.split("__", 1)[0]
        base_to_variants.setdefault(base_key, []).append(fn)

    def _basename_no_ext(path: str) -> str:
        s = str(path or "").replace("/", "\\")
        name = s.split("\\")[-1]
        if name.lower().endswith(".ymap"):
            name = name[:-5]
        return name

    def _choose_target_filename(ymap_path: str) -> str:
        base = _basename_no_ext(ymap_path)
        # Fast path: direct base.json exists in the index.
        direct = f"{base}.json"
        if direct in expected_files:
            return direct
        # If there’s exactly one indexed variant for this base, use it.
        vs = base_to_variants.get(base) or []
        if len(vs) == 1:
            return vs[0]
        # If there are multiple variants, try a stable hash suffix candidate.
        # NOTE: the original pipeline that produced `__<8hex>` may use a different hash;
        # we try CRC32 first (common + stable) and fall back to the first variant.
        if vs:
            h = zlib.crc32(str(ymap_path).encode("utf-8", errors="ignore")) & 0xFFFFFFFF
            cand = f"{base}__{h:08x}.json"
            if cand in expected_files:
                return cand
            return sorted(vs)[0]
        # Not present in the index: still write a file so coverage can find it.
        return direct

    class _Writer:
        __slots__ = ("path", "f", "first")
        def __init__(self, path: Path):
            self.path = path
            self.f = open(path, "w", encoding="utf-8")
            self.f.write('{"schema":"webglgta-ymap-entities-v1","entities":[\n')
            self.first = True
        def write_entity(self, obj: dict):
            if not self.first:
                self.f.write(",\n")
            else:
                self.first = False
            self.f.write(json.dumps(obj, separators=(",", ":")))
        def close(self):
            try:
                self.f.write("\n]}\n")
            except Exception:
                pass
            try:
                self.f.close()
            except Exception:
                pass

    # LRU cache of open writers to avoid "too many open files".
    max_open = 96
    writers: "OrderedDict[str, _Writer]" = OrderedDict()
    counts_by_file = {}
    total_entities = 0

    # Iterate streamed entities and append to per-YMAP files.
    for p in sorted([q for q in chunks_dir.glob("*.jsonl") if q.is_file()], key=lambda q: q.name):
        with open(p, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                s = line.strip()
                if not s:
                    continue
                try:
                    obj = json.loads(s)
                except Exception:
                    continue
                y = obj.get("ymap")
                if not isinstance(y, str) or not y.strip():
                    continue
                fn = _choose_target_filename(y)
                out_path = ent_dir / fn

                w = writers.get(fn)
                if w is None:
                    # Evict LRU if needed.
                    if len(writers) >= max_open:
                        k0, w0 = writers.popitem(last=False)
                        try:
                            w0.close()
                        except Exception:
                            pass
                    w = _Writer(out_path)
                    writers[fn] = w
                else:
                    # Touch for LRU.
                    writers.move_to_end(fn, last=True)

                w.write_entity(obj)
                counts_by_file[fn] = int(counts_by_file.get(fn) or 0) + 1
                total_entities += 1

    # Close remaining writers.
    for _k, w in list(writers.items()):
        try:
            w.close()
        except Exception:
            pass
    writers.clear()

    # Ensure every indexed file exists (even if empty) so coverage reports are stable.
    created_empty = 0
    for fn in expected_files:
        out_path = ent_dir / fn
        if out_path.exists():
            continue
        try:
            out_path.write_text('{"schema":"webglgta-ymap-entities-v1","entities":[]}\n', encoding="utf-8")
            created_empty += 1
        except Exception:
            pass

    # Patch ymap/index.json entityCount fields based on what we observed.
    try:
        changed = 0
        for r in rows:
            if not isinstance(r, dict):
                continue
            fn = str(r.get("file") or "").strip()
            if not fn:
                continue
            c = int(counts_by_file.get(fn) or 0)
            if int(r.get("entityCount") or 0) != c:
                r["entityCount"] = c
                changed += 1
        if changed:
            ymap_index_path.write_text(json.dumps(idx, indent=2), encoding="utf-8")
    except Exception:
        pass

    # Patch entities_index.json counts so coverage tooling sees non-zero ymaps_processed/entities.
    try:
        idx_path = assets_dir / "entities_index.json"
        if idx_path.exists():
            ent_idx = json.loads(idx_path.read_text(encoding="utf-8", errors="ignore"))
            if isinstance(ent_idx, dict):
                counts = ent_idx.get("counts")
                if not isinstance(counts, dict):
                    counts = {}
                    ent_idx["counts"] = counts
                counts["entities"] = int(total_entities)
                counts["ymaps_processed"] = int(idx.get("numYmaps") or len(rows) or 0)
                counts["chunks"] = int(len((ent_idx.get("chunks") or {})) if isinstance(ent_idx.get("chunks"), dict) else 0)
                idx_path.write_text(json.dumps(ent_idx, indent=2) + "\n", encoding="utf-8")
    except Exception:
        pass

    print(f"Built assets/ymap/entities from streamed chunks: ymaps={len(expected_files)} entities={total_entities} empty_files={created_empty}")


def _ensure_models_textures_index(assets_dir: Path) -> None:
    """
    Generate `assets/models_textures/index.json`.

    Why:
      - Some pipelines export only `models_textures/<hash>.png`
      - Others export only `models_textures/<hash>_<slug>.png`
      - Some export both

    The viewer can always fall back from hash+slug -> hash-only, but without an index it cannot
    reliably do the reverse when only slug variants exist. This index makes that deterministic.

    Output schema (v1):
      {
        "schema": "webglgta-models-textures-index-v1",
        "generatedAtUnix": <int>,
        "byHash": {
          "<hash>": {
            "hash": "<hash>",
            "hashOnly": <bool>,
            "preferredFile": "<filename>",
            "files": ["<filename>", ...]
          },
          ...
        }
      }
    """
    if not assets_dir.exists() or not assets_dir.is_dir():
        return

    def _write_index_for_dir(mdir: Path, *, create_if_missing: bool = False, exts: tuple[str, ...] = ("png", "dds")) -> None:
        if not mdir.exists() or not mdir.is_dir():
            if not create_if_missing:
                return
            try:
                mdir.mkdir(parents=True, exist_ok=True)
            except Exception:
                return

        # Index is authoritative for what filename to request for a given hash.
        ext_re = "|".join([re.escape(e) for e in exts])
        re_hash_only = re.compile(rf"^(?P<hash>\d+)\.({ext_re})$", re.IGNORECASE)
        re_hash_slug = re.compile(rf"^(?P<hash>\d+)_(?P<slug>[^/]+)\.({ext_re})$", re.IGNORECASE)

        by_hash = {}

        globs = []
        for e in exts:
            globs += list(mdir.glob(f"*.{e}"))
        for p in sorted(globs):
            name = p.name
            m1 = re_hash_only.match(name)
            m2 = re_hash_slug.match(name) if not m1 else None
            if not (m1 or m2):
                continue
            h = (m1 or m2).group("hash")
            ent = by_hash.get(h)
            if ent is None:
                ent = {"hash": str(h), "hashOnly": False, "preferredFile": None, "files": []}
                by_hash[h] = ent
            ent["files"].append(name)
            if m1:
                # Keep legacy meaning:
                # - For PNG/DDS index: "hash-only PNG exists" (fast path in viewer)
                # - For KTX2 index: "hash-only KTX2 exists"
                if name.lower().endswith(".png") or name.lower().endswith(".ktx2"):
                    ent["hashOnly"] = True

        # Choose a stable preferred file per hash:
        # - If hash-only exists, prefer it (common + fastest).
        # - Else, pick the lexicographically-smallest slug variant for determinism.
        for h, ent in by_hash.items():
            files = list(ent.get("files") or [])
            files.sort()
            # Prefer hash-only when possible (fast path), otherwise stable smallest variant.
            prefer_ext = None
            for e in exts:
                if str(e).lower() in ("png", "ktx2"):
                    prefer_ext = str(e).lower()
                    break
            if prefer_ext:
                ho = f"{h}.{prefer_ext}"
                if ho in files:
                    ent["preferredFile"] = ho
                else:
                    ent["preferredFile"] = files[0] if files else None
            else:
                ent["preferredFile"] = files[0] if files else None

        out = {
            "schema": "webglgta-models-textures-index-v1",
            "generatedAtUnix": int(time.time()),
            "byHash": by_hash,
        }

        out_path = mdir / "index.json"
        tmp_path = mdir / "index.json.tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(out, f, indent=2, sort_keys=True)
        tmp_path.replace(out_path)

    mdir = assets_dir / "models_textures"
    # Include all model-texture extensions the viewer can load.
    _write_index_for_dir(mdir, create_if_missing=False, exts=("png", "dds", "jpg", "jpeg", "webp"))

    # Optional: KTX2 (preferred GPU upload format when present).
    #
    # IMPORTANT:
    # The viewer will opportunistically fetch `assets/models_textures_ktx2/index.json`.
    # If it doesn't exist, browsers/dev-servers log a noisy 404 even though the resolver treats it as optional.
    # Create an empty index + directory so the fetch is clean and pack-aware KTX2 resolution can still work.
    mdir_k2 = assets_dir / "models_textures_ktx2"
    _write_index_for_dir(mdir_k2, create_if_missing=True, exts=("ktx2",))

    # Optional: generate indices for asset packs (base + DLC overlays) if configured.
    # This is used by `TexturePathResolver` when `assets/asset_packs.json` exists.
    try:
        packs_path = assets_dir / "asset_packs.json"
        if packs_path.exists():
            cfg = json.loads(packs_path.read_text(encoding="utf-8", errors="ignore"))
            packs = cfg.get("packs") if isinstance(cfg, dict) else None
            if isinstance(packs, list):
                for p in packs:
                    if not isinstance(p, dict):
                        continue
                    if p.get("enabled") is False:
                        continue
                    pid = str(p.get("id") or "").strip()
                    if not pid:
                        continue
                    root_rel = str(p.get("rootRel") or p.get("root") or "").strip()
                    if not root_rel:
                        root_rel = f"packs/{pid}"
                    root_rel = root_rel.strip("/").lstrip("/")
                    pack_dir = assets_dir / root_rel / "models_textures"
                    # IMPORTANT: create empty pack indices even when the pack has no exported textures yet.
                    # This avoids noisy 404 spam in dev when TexturePathResolver probes pack indices.
                    _write_index_for_dir(pack_dir, create_if_missing=True, exts=("png", "dds", "jpg", "jpeg", "webp"))
                    pack_dir_k2 = assets_dir / root_rel / "models_textures_ktx2"
                    _write_index_for_dir(pack_dir_k2, create_if_missing=True, exts=("ktx2",))
    except Exception:
        # Best-effort; ignore.
        pass


def _ensure_shader_param_name_map(assets_dir: Path) -> None:
    """
    Generate `assets/shader_param_names.json` by parsing CodeWalker's ShaderParamNames enum:
      CodeWalker.Core/GameFiles/Resources/ShaderParams.cs

    Output schema:
      {
        "schema": "codewalker-shader-param-names-v1",
        "source": "<path>",
        "source_mtime_ns": <int>,
        "byHash": { "<u32>": "<Name>", ... }
      }

    The viewer uses this to resolve shaderParams.{texturesByHash,vectorsByHash} into friendly names,
    and to auto-populate common material fields (bumpiness/specular/etc).
    """
    if not assets_dir.exists() or not assets_dir.is_dir():
        return

    # Locate CodeWalker source relative to this repo layout.
    # This repo may include either:
    # - `webgl/CodeWalker/...` (older layout)
    # - `webgl/CodeWalker-master/...` (current vendored layout)
    viewer_dir = Path(__file__).resolve().parent
    candidates = [
        (viewer_dir.parent / "CodeWalker" / "CodeWalker.Core" / "GameFiles" / "Resources" / "ShaderParams.cs"),
        (viewer_dir.parent / "CodeWalker-master" / "CodeWalker.Core" / "GameFiles" / "Resources" / "ShaderParams.cs"),
    ]
    codewalker_shaderparams = None
    for p in candidates:
        if p.exists():
            codewalker_shaderparams = p
            break
    if codewalker_shaderparams is None:
        # Allow running viewer without CodeWalker sources checked out.
        return

    out_path = assets_dir / "shader_param_names.json"
    try:
        src_mtime_ns = int(codewalker_shaderparams.stat().st_mtime_ns)
    except Exception:
        src_mtime_ns = 0

    # Skip if already up to date.
    if out_path.exists():
        try:
            existing = json.loads(out_path.read_text(encoding="utf-8", errors="ignore"))
            if (
                isinstance(existing, dict)
                and existing.get("schema") == "codewalker-shader-param-names-v1"
                and int(existing.get("source_mtime_ns") or 0) == int(src_mtime_ns)
            ):
                return
        except Exception:
            pass

    text = Path(codewalker_shaderparams).read_text(encoding="utf-8", errors="ignore")
    # Match lines like: "DiffuseSampler = 4059966321,"
    pat = re.compile(r"^\s*(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?P<val>\d+)\s*,\s*$", re.MULTILINE)
    by_hash = {}
    for m in pat.finditer(text):
        name = m.group("name")
        val = m.group("val")
        # Keep as decimal string; manifests also use decimal strings.
        by_hash[str(val)] = str(name)

    if not by_hash:
        return

    payload = {
        "schema": "codewalker-shader-param-names-v1",
        "source": str(codewalker_shaderparams),
        "source_mtime_ns": int(src_mtime_ns),
        "byHash": by_hash,
    }
    out_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"Generated shader_param_names.json ({len(by_hash)} entries): {out_path}")

def _build_entity_position_bins(assets_dir: Path, max_chunks: int = 0):
    """
    Build positions-only binary chunks for fast client loading:
      assets/entities_chunks_bin/<chunk>.bin

    Format:
      - 4 bytes: b'ENT0'
      - u32 little-endian: pointCount
      - pointCount * 3 float32 little-endian: x,y,z

    The viewer will prefer these for dot rendering, and fall back to JSONL if missing.
    """
    idx_path = assets_dir / "entities_index.json"
    chunks_dir = assets_dir / "entities_chunks"
    if not idx_path.exists() or not chunks_dir.exists():
        return

    idx = json.loads(idx_path.read_text(encoding="utf-8", errors="ignore"))
    chunks = list((idx.get("chunks") or {}).items())
    chunks.sort(key=lambda kv: kv[0])
    if max_chunks and max_chunks > 0:
        chunks = chunks[: int(max_chunks)]

    out_dir = assets_dir / "entities_chunks_bin"
    out_dir.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    built = 0
    skipped = 0
    total_points = 0
    for i, (key, meta) in enumerate(chunks):
        file0 = (meta or {}).get("file") or f"{key}.jsonl"
        src = chunks_dir / file0
        if not src.exists():
            continue
        out = out_dir / (Path(file0).stem + ".bin")
        # Skip if already built and newer than source
        try:
            if out.exists() and out.stat().st_mtime >= src.stat().st_mtime:
                skipped += 1
                continue
        except Exception:
            pass

        pts = array("f")
        # Read line-by-line to keep memory stable.
        with open(src, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                pos = obj.get("position")
                if not pos or len(pos) < 3:
                    continue
                try:
                    x = float(pos[0])
                    y = float(pos[1])
                    z = float(pos[2])
                except Exception:
                    continue
                pts.append(x)
                pts.append(y)
                pts.append(z)

        count = len(pts) // 3
        if count <= 0:
            # Still write an empty bin so the client can fast-path without retrying JSONL.
            with open(out, "wb") as fo:
                fo.write(b"ENT0")
                fo.write(struct.pack("<I", 0))
            built += 1
            continue

        # Ensure little-endian float32 on disk.
        if pts.itemsize != 4:
            raise RuntimeError("Unexpected float array itemsize")
        if struct.pack("=I", 1) == struct.pack(">I", 1):
            pts.byteswap()

        with open(out, "wb") as fo:
            fo.write(b"ENT0")
            fo.write(struct.pack("<I", int(count)))
            pts.tofile(fo)

        built += 1
        total_points += count
        if (i + 1) % 25 == 0:
            print(f"[bins] {i+1}/{len(chunks)} built={built} skipped={skipped} points={total_points}")

    dt = max(0.001, time.time() - t0)
    print(f"Built entity position bins: {built} (skipped={skipped}), points={total_points}, seconds={dt:.1f}")


def _build_entity_instance_bins(assets_dir: Path, max_chunks: int = 0):
    """
    Build archetype+transform binary chunks for fast drawable streaming:
      assets/entities_chunks_inst/<chunk>.bin

    Format (ENT1):
      - 4 bytes: b'ENT1'
      - u32 little-endian: recordCount
      - recordCount records of:
          v1: <I3f4f3f> = archetypeHash(u32), pos(xyz), quat(xyzw), scale(xyz)
          v2: <I3f4f3fI> adds u32 tintIndex
          v3: <I3f4f3f5I> adds u32 tintIndex, u32 guid, u32 mloParentGuid, u32 mloEntitySetHash, u32 flags

     flags bits (v3):
       - 1: isMloInstance
       - 2: isInteriorChild (mloParentGuid != 0)
       - 4: isEntitySetChild (mloEntitySetHash != 0)
    """
    idx_path = assets_dir / "entities_index.json"
    chunks_dir = assets_dir / "entities_chunks"
    if not idx_path.exists() or not chunks_dir.exists():
        return

    idx = json.loads(idx_path.read_text(encoding="utf-8", errors="ignore"))
    chunks = list((idx.get("chunks") or {}).items())
    chunks.sort(key=lambda kv: kv[0])
    if max_chunks and max_chunks > 0:
        chunks = chunks[: int(max_chunks)]

    out_dir = assets_dir / "entities_chunks_inst"
    out_dir.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    built = 0
    skipped = 0
    total_records = 0

    for i, (_key, meta) in enumerate(chunks):
        file0 = (meta or {}).get("file")
        if not file0:
            continue
        src = chunks_dir / file0
        if not src.exists():
            continue
        out = out_dir / (Path(file0).stem + ".bin")
        try:
            if out.exists() and out.stat().st_mtime >= src.stat().st_mtime:
                skipped += 1
                continue
        except Exception:
            pass

        count = 0
        buf = bytearray()
        with open(out, "wb") as fo:
            fo.write(b"ENT1")
            fo.write(struct.pack("<I", 0))  # placeholder count

            with open(src, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue

                    arch = obj.get("archetype")
                    if arch is None:
                        continue
                    # Accept either numeric hashes or model/archetype names (joaat).
                    try:
                        h = _normalize_archetype_to_u32(arch)
                    except Exception:
                        continue

                    pos = obj.get("position") or (0.0, 0.0, 0.0)
                    if not pos or len(pos) < 3:
                        continue
                    try:
                        x = float(pos[0])
                        y = float(pos[1])
                        z = float(pos[2])
                    except Exception:
                        continue

                    q = obj.get("rotation_quat") or (0.0, 0.0, 0.0, 1.0)
                    if not q or len(q) < 4:
                        q = (0.0, 0.0, 0.0, 1.0)
                    try:
                        qx = float(q[0])
                        qy = float(q[1])
                        qz = float(q[2])
                        qw = float(q[3])
                    except Exception:
                        qx, qy, qz, qw = 0.0, 0.0, 0.0, 1.0

                    sc = obj.get("scale") or (1.0, 1.0, 1.0)
                    if not sc or len(sc) < 3:
                        sc = (1.0, 1.0, 1.0)
                    try:
                        sx = float(sc[0])
                        sy = float(sc[1])
                        sz = float(sc[2])
                    except Exception:
                        sx, sy, sz = 1.0, 1.0, 1.0

                    # Optional metadata (v3)
                    tint = obj.get("tintIndex", obj.get("tint", 0))
                    try:
                        tint_u32 = int(tint) & 0xFFFFFFFF
                    except Exception:
                        tint_u32 = 0
                    guid = obj.get("guid", 0)
                    try:
                        guid_u32 = int(guid) & 0xFFFFFFFF
                    except Exception:
                        guid_u32 = 0
                    mlo_parent = obj.get("mlo_parent_guid", 0)
                    try:
                        mlo_parent_u32 = int(mlo_parent) & 0xFFFFFFFF
                    except Exception:
                        mlo_parent_u32 = 0
                    mlo_set = obj.get("mlo_entity_set_hash", 0)
                    try:
                        mlo_set_u32 = int(mlo_set) & 0xFFFFFFFF
                    except Exception:
                        mlo_set_u32 = 0
                    is_mlo_instance = bool(obj.get("is_mlo_instance", False))
                    flags = 0
                    if is_mlo_instance:
                        flags |= 1
                    if mlo_parent_u32 != 0:
                        flags |= 2
                    if mlo_set_u32 != 0:
                        flags |= 4

                    buf += struct.pack(
                        "<I3f4f3f5I",
                        int(h),
                        x, y, z,
                        qx, qy, qz, qw,
                        sx, sy, sz,
                        int(tint_u32),
                        int(guid_u32),
                        int(mlo_parent_u32),
                        int(mlo_set_u32),
                        int(flags),
                    )
                    count += 1
                    if len(buf) >= 4 * 1024 * 1024:
                        fo.write(buf)
                        buf.clear()

            if buf:
                fo.write(buf)

            # patch count
            fo.seek(4)
            fo.write(struct.pack("<I", int(count)))

        built += 1
        total_records += count
        if (i + 1) % 25 == 0:
            print(f"[inst] {i+1}/{len(chunks)} built={built} skipped={skipped} records={total_records}")

    dt = max(0.001, time.time() - t0)
    print(f"Built entity instance bins: {built} (skipped={skipped}), records={total_records}, seconds={dt:.1f}")


def _joaat_py(input0) -> int:
    """
    GTA "joaat" (Jenkins one-at-a-time) hash.
    Mirrors webgl_viewer/js/joaat.js.
    Returns unsigned 32-bit int.
    """
    s = str(input0 or "").lower()
    h = 0
    for ch in s:
        h = (h + ord(ch)) & 0xFFFFFFFF
        h = (h + ((h << 10) & 0xFFFFFFFF)) & 0xFFFFFFFF
        h ^= (h >> 6)
        h &= 0xFFFFFFFF
    h = (h + ((h << 3) & 0xFFFFFFFF)) & 0xFFFFFFFF
    h ^= (h >> 11)
    h &= 0xFFFFFFFF
    h = (h + ((h << 15) & 0xFFFFFFFF)) & 0xFFFFFFFF
    return h & 0xFFFFFFFF


def _normalize_archetype_to_u32(arch) -> int:
    """
    Normalize archetype identifier into unsigned 32-bit integer:
    - numeric => u32
    - other string => joaat(name)
    """
    if arch is None:
        raise ValueError("null archetype")
    s = str(arch).strip()
    if not s:
        raise ValueError("empty archetype")
    if s.lstrip("-").isdigit():
        return int(s, 10) & 0xFFFFFFFF
    return _joaat_py(s)


def _build_entities_chunk_shard_index(assets_dir: Path, max_chunks: int = 0):
    """
    Build a compact mapping of entity chunk -> model manifest shard IDs.

    Output:
      assets/entities_chunk_shards.json

    Why:
      The viewer uses a sharded models manifest (manifest_index.json + manifest_shards/*.json) and needs
      to know which shards to prefetch for nearby chunks *before* it parses the chunk JSONL/ENT1.

    Format:
      {
        "schema": "webglgta-entities-chunk-shards-v1",
        "chunk_size": <float>,
        "shard_bits": <int>,
        "chunks": { "<cx>_<cy>": [ <shardId:int>, ... ], ... }
      }

    Notes:
      - Prefers scanning ENT1 instance bins in assets/entities_chunks_inst/*.bin (fast) when present.
      - Falls back to parsing assets/entities_chunks/*.jsonl otherwise.
    """
    idx_path = assets_dir / "entities_index.json"
    chunks_dir = assets_dir / "entities_chunks"
    if not idx_path.exists() or not chunks_dir.exists():
        return

    # Require a sharded models manifest index so we know shard_bits.
    models_dir = assets_dir / "models"
    manifest_index_path = models_dir / "manifest_index.json"
    if not manifest_index_path.exists():
        print("Skipping chunk shard index: no assets/models/manifest_index.json (models manifest not sharded).")
        return
    try:
        m_idx = json.loads(manifest_index_path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return
    if not isinstance(m_idx, dict) or m_idx.get("schema") != "webglgta-manifest-index-v1":
        print("Skipping chunk shard index: unexpected models manifest_index schema.")
        return

    shard_bits = int(m_idx.get("shard_bits") or 0)
    shard_bits = max(4, min(12, shard_bits))
    mask = (1 << shard_bits) - 1

    idx = json.loads(idx_path.read_text(encoding="utf-8", errors="ignore"))
    chunk_size = float(idx.get("chunk_size") or 512.0)
    chunks = list((idx.get("chunks") or {}).items())
    chunks.sort(key=lambda kv: kv[0])
    if max_chunks and max_chunks > 0:
        chunks = chunks[: int(max_chunks)]

    inst_dir = assets_dir / "entities_chunks_inst"
    prefer_ent1 = inst_dir.exists()

    out_chunks = {}
    t0 = time.time()
    built = 0

    for i, (key, meta) in enumerate(chunks):
        file0 = (meta or {}).get("file")
        if not file0:
            continue

        shard_ids = set()

        # Prefer ENT1 (fast): each record begins with archetypeHash(u32)
        used_ent1 = False
        if prefer_ent1:
            bin_path = inst_dir / (Path(file0).stem + ".bin")
            if bin_path.exists():
                try:
                    with open(bin_path, "rb") as f:
                        head = f.read(8)
                        if len(head) == 8 and head[:4] == b"ENT1":
                            count = struct.unpack("<I", head[4:8])[0]
                            # Detect stride based on file size (v1=44, v2=48, v3=64)
                            try:
                                size = bin_path.stat().st_size
                            except Exception:
                                size = 0
                            payload_bytes = max(0, int(size) - 8)
                            stride = 44
                            if count > 0:
                                if payload_bytes == int(count) * 64:
                                    stride = 64
                                elif payload_bytes == int(count) * 48:
                                    stride = 48
                                else:
                                    stride = 44
                            # Stream records to avoid loading huge files into memory.
                            # Read in blocks aligned to stride.
                            remaining = int(count) * stride
                            bufsize = 1024 * 1024
                            carry = b""
                            while remaining > 0:
                                take = min(bufsize, remaining)
                                data = f.read(take)
                                if not data:
                                    break
                                remaining -= len(data)
                                data = carry + data
                                nrec = len(data) // stride
                                end = nrec * stride
                                mv = memoryview(data)
                                for r in range(nrec):
                                    off = r * stride
                                    h = struct.unpack_from("<I", mv, off)[0]
                                    shard_ids.add(int(h) & mask)
                                carry = bytes(mv[end:])
                            used_ent1 = True
                except Exception:
                    used_ent1 = False

        if not used_ent1:
            # Fallback JSONL parse
            src = chunks_dir / file0
            if not src.exists():
                continue
            with open(src, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue
                    arch = obj.get("archetype")
                    if arch is None:
                        continue
                    try:
                        h = _normalize_archetype_to_u32(arch)
                    except Exception:
                        continue
                    shard_ids.add(int(h) & mask)

        out_chunks[str(key)] = sorted(int(x) for x in shard_ids)
        built += 1
        if (i + 1) % 50 == 0:
            print(f"[chunk_shards] {i+1}/{len(chunks)} built={built}")

    payload = {
        "schema": "webglgta-entities-chunk-shards-v1",
        "chunk_size": float(chunk_size),
        "shard_bits": int(shard_bits),
        "source": "entities_chunks_inst" if prefer_ent1 else "entities_chunks",
        "chunks": out_chunks,
    }
    out_path = assets_dir / "entities_chunk_shards.json"
    out_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    dt = max(0.001, time.time() - t0)
    print(f"Built {out_path.name}: chunks={len(out_chunks)} shard_bits={shard_bits} seconds={dt:.1f}")

def _patch_terrain_info_with_detected_textures(terrain_info_path: Path, textures_dir: Path):
    """
    Pragmatic fix-up for the viewer: if `terrain_info.json` has `num_textures=0`, but we *do* have
    a pile of exported `*_diffuse.png` textures, pick representative grass/rock/dirt/sand/snow pairs
    and write them back into `assets/terrain_info.json` so the viewer can bind real textures.
    """
    try:
        if not terrain_info_path.exists() or not textures_dir.exists():
            return

        try:
            info = json.loads(terrain_info_path.read_text(encoding='utf-8'))
        except Exception:
            return

        texture_info = info.get('texture_info')
        if not isinstance(texture_info, dict):
            texture_info = {}
            info['texture_info'] = texture_info

        num_textures = int(info.get('num_textures') or 0)
        layers = texture_info.get('layers')
        if num_textures > 0 or (isinstance(layers, list) and len(layers) > 0):
            return

        diffuse_files = list(textures_dir.glob('*_diffuse.png'))
        if not diffuse_files:
            return

        bases = set()
        for p in diffuse_files:
            n = p.name
            if n.lower().endswith('_diffuse.png'):
                bases.add(n[:-len('_diffuse.png')])

        def has_normal(base: str) -> bool:
            return (textures_dir / f'{base}_normal.png').exists()

        def pick_base(keywords):
            candidates = []
            for b in bases:
                bl = b.lower()
                if any(k in bl for k in keywords):
                    if 'mask' in bl or 'alpha' in bl or 'decal' in bl or 'gradient' in bl:
                        continue
                    score = 0
                    for k in keywords:
                        if k in bl:
                            score += 10
                    score -= min(200, len(bl))
                    if has_normal(b):
                        score += 5
                    candidates.append((score, b))
            if not candidates:
                return None
            candidates.sort(reverse=True)
            return candidates[0][1]

        picks = {
            'grass': pick_base(['grass', 'meadow', 'lush', 'scrub']),
            'rock': pick_base(['rock', 'cliff', 'stone', 'canyon']),
            'dirt': pick_base(['dirt', 'mud', 'earth', 'soil', 'track']),
            'sand': pick_base(['sand', 'beach', 'desert']),
            'snow': pick_base(['snow', 'ice']),
        }

        used = set()
        ordered = []
        for k in ['grass', 'rock', 'dirt', 'sand', 'snow']:
            b = picks.get(k)
            if not b or b in used:
                continue
            used.add(b)
            ordered.append((k, b))

        if not ordered:
            return

        for (_k, base) in ordered:
            texture_info[base] = {'format': 'png', 'has_normal': bool(has_normal(base)), 'source': 'setup_assets_autofill'}

        texture_info['terrain_types'] = {
            kind: {'name': base, 'has_normal': bool(has_normal(base))}
            for (kind, base) in ordered
        }
        texture_info['layers'] = [{'name': base, 'has_normal': bool(has_normal(base))} for (_k, base) in ordered[:4]]
        info['num_textures'] = len([k for k in texture_info.keys() if k not in ('layers', 'blend_mask', 'terrain_types')])

        terrain_info_path.write_text(json.dumps(info, indent=2), encoding='utf-8')
        print(f"Patched terrain_info.json with detected textures (num_textures={info['num_textures']})")
    except Exception:
        # Don't fail asset setup if this patching step fails.
        return

def _ensure_terrain_blend_mask_from_height_slope(assets_dir: Path):
    """
    Create `assets/textures/terrain_blend_mask.png` if missing, using heightmap + normalmap heuristics.
    This enables the viewer's 4-layer blending shader even when the extractor didn't export a real mask.

    Channel convention (matches viewer): R=layer1, G=layer2, B=layer3, A=layer4.
    """
    try:
        if np is None or Image is None:
            return
        tex_dir = assets_dir / 'textures'
        tex_dir.mkdir(exist_ok=True)
        out_path = tex_dir / 'terrain_blend_mask.png'
        if out_path.exists():
            return

        heightmap_path = assets_dir / 'heightmap.png'
        if not heightmap_path.exists():
            return

        # Heightmap is expected to be single-channel (or RGB with identical channels).
        hm = Image.open(heightmap_path).convert('L')
        h = np.asarray(hm, dtype=np.float32) / 255.0  # 0..1

        # Optional slope from normalmap (if present); else approximate from gradients.
        slope = None
        normalmap_path = assets_dir / 'normalmap.png'
        if normalmap_path.exists():
            nm = Image.open(normalmap_path).convert('RGB')
            n = (np.asarray(nm, dtype=np.float32) / 255.0) * 2.0 - 1.0
            # normalmap in viewer is stored in RGB; treat B as "up-ish" component in Z-up space.
            nz = np.clip(np.abs(n[..., 2]), 0.0, 1.0)
            slope = np.clip(1.0 - nz, 0.0, 1.0)

        if slope is None:
            gy, gx = np.gradient(h)
            slope = np.clip(np.sqrt(gx * gx + gy * gy) * 4.0, 0.0, 1.0)

        # Heuristic weights for 4 layers (R,G,B,A) = (grass, rock, dirt, sand)
        sand = np.clip((0.18 - h) / 0.18, 0.0, 1.0)
        sand = sand * sand

        rock = np.clip((slope - 0.25) / 0.55, 0.0, 1.0)
        rock = rock * rock
        rock = np.clip(rock + 0.35 * np.clip((h - 0.75) / 0.25, 0.0, 1.0), 0.0, 1.0)

        grass = np.clip((h - 0.08) / 0.55, 0.0, 1.0) * np.clip((0.35 - slope) / 0.35, 0.0, 1.0)
        grass = np.clip(grass, 0.0, 1.0)

        dirt = np.clip(1.0 - (grass + rock + sand), 0.0, 1.0)

        sumw = grass + rock + dirt + sand
        sumw[sumw < 1e-6] = 1.0
        w = np.stack([grass, rock, dirt, sand], axis=2) / sumw[..., None]
        rgba = np.clip(np.round(w * 255.0), 0, 255).astype(np.uint8)

        Image.fromarray(rgba, mode='RGBA').save(out_path)
        print("Generated terrain_blend_mask.png (height/slope heuristic)")

        # Advertise it in terrain_info.json so the viewer loads it.
        ti_path = assets_dir / 'terrain_info.json'
        if ti_path.exists():
            try:
                info = json.loads(ti_path.read_text(encoding='utf-8'))
                texture_info = info.get('texture_info')
                if not isinstance(texture_info, dict):
                    texture_info = {}
                    info['texture_info'] = texture_info
                texture_info['blend_mask'] = True
                ti_path.write_text(json.dumps(info, indent=2), encoding='utf-8')
            except Exception:
                pass
    except Exception:
        return

def _ensure_models_manifest(models_dir: Path):
    """
    Ensure `assets/models/manifest.json` exists and contains entries for the exported `*.bin` meshes.

    The WebGL viewer requires this manifest to know which archetype hashes have meshes and which
    lod files to load. If it's empty, you'll only see point entities ("yellow dots").
    """
    if not models_dir.exists() or not models_dir.is_dir():
        return

    manifest_path = models_dir / 'manifest.json'
    existing = None
    if manifest_path.exists():
        try:
            existing = json.loads(manifest_path.read_text(encoding='utf-8'))
        except Exception:
            existing = None

    def _looks_like_degenerate_autogen(m: dict) -> bool:
        """
        Detect the common failure mode: setup_assets generated a manifest from *_high.bin only and
        filled lodDistances with 9998 everywhere, which disables distance-based LOD switching.
        If we detect that, we patch-in sane defaults without clobbering real exporter distances.
        """
        try:
            meshes0 = m.get('meshes') if isinstance(m, dict) else None
            if not isinstance(meshes0, dict) or not meshes0:
                return False
            # Sample up to N entries
            keys = list(meshes0.keys())[:200]
            if not keys:
                return False
            deg = 0
            for k in keys:
                e = meshes0.get(k) or {}
                lods = e.get('lods') or {}
                ld = e.get('lodDistances') or {}
                # "only high" plus "all distances ~9998"
                only_high = (isinstance(lods, dict) and len(lods) == 1 and ('high' in lods))
                try:
                    vals = [float(ld.get('High', 0.0)), float(ld.get('Med', 0.0)), float(ld.get('Low', 0.0)), float(ld.get('VLow', 0.0))]
                except Exception:
                    vals = [0.0, 0.0, 0.0, 0.0]
                all_9998 = all(v >= 9990.0 for v in vals)
                if only_high and all_9998:
                    deg += 1
            return deg >= max(3, int(0.25 * len(keys)))
        except Exception:
            return False

    def _default_lod_distances(vertex_count: Optional[int] = None) -> dict:
        """
        Reasonable viewer defaults in GTA/data-space units.
        We bias slightly larger for bigger meshes so they don't snap too early.
        """
        vc = int(vertex_count) if isinstance(vertex_count, int) else 0
        # scale factor in [0..1] from vertex count
        s = 0.0
        try:
            if vc > 0:
                s = min(1.0, max(0.0, (vc ** 0.5) / 200.0))
        except Exception:
            s = 0.0
        hi = 90.0 + 60.0 * s
        med = 220.0 + 160.0 * s
        low = 520.0 + 420.0 * s
        vlow = 1200.0 + 900.0 * s
        return {'High': float(hi), 'Med': float(med), 'Low': float(low), 'VLow': float(vlow)}

    # If manifest already has meshes, keep it unless it looks like the degenerate auto-generated one.
    if isinstance(existing, dict) and isinstance(existing.get('meshes'), dict) and len(existing.get('meshes')) > 0:
        if not _looks_like_degenerate_autogen(existing):
            return
        # Patch distances in-place (do NOT regenerate lods/files).
        try:
            patched = 0
            for _h, e in (existing.get('meshes') or {}).items():
                if not isinstance(e, dict):
                    continue
                ld = e.get('lodDistances')
                lods = e.get('lods') or {}
                # Only patch entries that still have the 9998 defaults.
                try:
                    vals = [float((ld or {}).get('High', 0.0)), float((ld or {}).get('Med', 0.0)), float((ld or {}).get('Low', 0.0)), float((ld or {}).get('VLow', 0.0))]
                except Exception:
                    vals = [0.0, 0.0, 0.0, 0.0]
                if ld and all(v >= 9990.0 for v in vals):
                    # Use vertexCount from whatever LOD we have.
                    vc = None
                    try:
                        any_lod = next(iter(lods.values())) if isinstance(lods, dict) and lods else None
                        vc = int(any_lod.get('vertexCount')) if isinstance(any_lod, dict) and any_lod.get('vertexCount') is not None else None
                    except Exception:
                        vc = None
                    e['lodDistances'] = _default_lod_distances(vc)
                    patched += 1
            manifest_path.write_text(json.dumps(existing, indent=2), encoding='utf-8')
            print(f"Patched models manifest LOD distances for {patched} meshes: {manifest_path}")
        except Exception:
            return
        return

    bins = list(models_dir.glob('*.bin'))
    if not bins:
        return

    pat = re.compile(r'^(?P<hash>\d+)_(?P<lod>[a-zA-Z0-9]+)\.bin$')

    def _norm_lod(lod: str) -> Optional[str]:
        lod_s = (lod or '').strip().lower()
        if not lod_s:
            return None
        # Common aliases
        if lod_s in ('hi', 'high', 'lod0'):
            return 'high'
        if lod_s in ('med', 'mid', 'medium', 'lod1'):
            return 'med'
        if lod_s in ('low', 'lod2'):
            return 'low'
        if lod_s in ('vlow', 'vl', 'verylow', 'very_low', 'lod3'):
            return 'vlow'
        # Already normalized?
        if lod_s in ('high', 'med', 'low', 'vlow'):
            return lod_s
        return lod_s

    meshes = {}
    for p in bins:
        m = pat.match(p.name)
        if not m:
            continue
        h = m.group('hash')
        lod = _norm_lod(m.group('lod'))
        if not lod:
            continue

        try:
            with open(p, 'rb') as f:
                header = f.read(20)
            if len(header) < 20:
                continue
            magic = header[0:4].decode('ascii', errors='ignore')
            if magic != 'MSH0':
                continue
            version, vertex_count, index_count, flags = struct.unpack('<IIII', header[4:20])
        except Exception:
            continue

        entry = meshes.get(h)
        if not entry:
            entry = {
                'lods': {},
                # Reasonable defaults; real exporter writes actual Drawable LodDist* values.
                'lodDistances': _default_lod_distances(int(vertex_count) if isinstance(vertex_count, int) else None),
                'material': {},
            }
            meshes[h] = entry

        entry['lods'][lod] = {
            'file': p.name,
            'vertexCount': int(vertex_count),
            'indexCount': int(index_count),
            'hasNormals': bool(version >= 2 and (flags & 1) == 1),
            'hasUvs': bool(version >= 3 and (flags & 2) == 2),
            'hasTangents': bool(version >= 4 and (flags & 4) == 4),
        }

    out = {
        'version': 4,
        'meshes': meshes,
    }
    manifest_path.write_text(json.dumps(out, indent=2), encoding='utf-8')
    print(f"Generated models manifest with {len(meshes)} meshes: {manifest_path}")


def _ensure_models_manifest_shards(models_dir: Path, shard_bits: int = 8) -> None:
    """
    Generate a sharded manifest for the WebGL viewer:

      assets/models/manifest_index.json
      assets/models/manifest_shards/<xx>.json   (for shard_bits=8 => 256 files, xx in 00..ff)

    Why:
    - `assets/models/manifest.json` can be tens+ of MB. Even with a Worker, parsing/allocating it is heavy.
    - At runtime we only need metadata for archetypes near the player; the viewer can fetch shards on-demand.

    Sharding scheme:
    - Hash keys in the manifest are decimal strings for unsigned 32-bit joaat hashes.
    - We shard by the LOW `shard_bits` of that u32 (uniform-ish distribution).
    """
    if not models_dir.exists() or not models_dir.is_dir():
        return

    manifest_path = models_dir / "manifest.json"
    if not manifest_path.exists():
        return

    shard_bits_i = int(shard_bits)
    if shard_bits_i < 4 or shard_bits_i > 12:
        # keep shard count sane: 16..4096
        shard_bits_i = 8
    shard_count = 1 << shard_bits_i
    mask = shard_count - 1

    shard_dir = models_dir / "manifest_shards"
    index_path = models_dir / "manifest_index.json"

    try:
        src_mtime_ns = manifest_path.stat().st_mtime_ns
    except Exception:
        src_mtime_ns = 0

    # If index exists and matches source mtime, assume shards are up-to-date.
    if index_path.exists():
        try:
            idx_existing = json.loads(index_path.read_text(encoding="utf-8", errors="ignore"))
            if (
                isinstance(idx_existing, dict)
                and idx_existing.get("schema") == "webglgta-manifest-index-v1"
                and int(idx_existing.get("source_mtime_ns") or 0) == int(src_mtime_ns)
                and int(idx_existing.get("shard_bits") or 0) == int(shard_bits_i)
            ):
                return
        except Exception:
            pass

    # Load the monolithic manifest.
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return

    meshes = (manifest.get("meshes") if isinstance(manifest, dict) else None) or {}
    if not isinstance(meshes, dict) or not meshes:
        return

    # Build shards in-memory (dict per shard).
    shards = [{} for _ in range(shard_count)]
    bad_keys = 0
    for k, v in meshes.items():
        try:
            # Keys are decimal strings.
            n = int(str(k))
            sid = (n & mask)
            shards[sid][str(k)] = v
        except Exception:
            bad_keys += 1
            continue

    shard_dir.mkdir(parents=True, exist_ok=True)

    # Write shards (compact JSON).
    wrote = 0
    for sid in range(shard_count):
        if not shards[sid]:
            continue
        name = format(sid, "x").rjust((shard_bits_i + 3) // 4, "0") + ".json"
        out_path = shard_dir / name
        payload = {
            "schema": "webglgta-manifest-shard-v1",
            "manifest_version": manifest.get("version", 1),
            "shard_bits": shard_bits_i,
            "shard_id": sid,
            "meshes": shards[sid],
        }
        out_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        wrote += 1

    idx = {
        "schema": "webglgta-manifest-index-v1",
        "source": "manifest.json",
        "source_mtime_ns": int(src_mtime_ns),
        "manifest_version": manifest.get("version", 1),
        "mesh_count": int(len(meshes)),
        "bad_keys": int(bad_keys),
        "shard_bits": int(shard_bits_i),
        "shard_count": int(shard_count),
        "shard_dir": "manifest_shards",
        # the viewer computes shard file as <hex(shard_id) padded>.json
        "shard_file_ext": ".json",
        "shard_key": "u32_low_bits",
    }
    index_path.write_text(json.dumps(idx, indent=2), encoding="utf-8")
    print(f"Generated sharded models manifest: {index_path} (shards_written={wrote}/{shard_count})")

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument("--build-entity-bins", action="store_true", help="Build assets/entities_chunks_bin/*.bin (positions-only) for faster dot streaming")
    ap.add_argument("--max-bins-chunks", type=int, default=0, help="Limit number of chunks converted to bins (0 = all)")
    ap.add_argument("--build-entity-inst-bins", action="store_true", help="Build assets/entities_chunks_inst/*.bin (archetype+transform) for faster model streaming")
    ap.add_argument("--max-inst-bins-chunks", type=int, default=0, help="Limit number of chunks converted to inst bins (0 = all)")
    ap.add_argument("--build-chunk-shard-index", action="store_true", help="Build assets/entities_chunk_shards.json (chunk -> models manifest shard IDs) for faster model-meta prefetch")
    ap.add_argument("--max-chunk-shard-index-chunks", type=int, default=0, help="Limit number of chunks scanned for entities_chunk_shards.json (0 = all)")
    args = ap.parse_args()

    # module-global flag used inside setup_assets() without changing call sites
    _SHOULD_BUILD_ENTITY_BINS = bool(args.build_entity_bins)
    _MAX_BINS_CHUNKS = int(args.max_bins_chunks or 0)
    _SHOULD_BUILD_ENTITY_INST_BINS = bool(args.build_entity_inst_bins)
    _MAX_INST_BINS_CHUNKS = int(args.max_inst_bins_chunks or 0)
    _SHOULD_BUILD_CHUNK_SHARD_INDEX = bool(args.build_chunk_shard_index)
    _MAX_CHUNK_SHARD_INDEX_CHUNKS = int(args.max_chunk_shard_index_chunks or 0)
    setup_assets()
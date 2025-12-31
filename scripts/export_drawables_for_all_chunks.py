#!/usr/bin/env python3
"""
Bulk export drawables for *all* streamed entity chunks into the WebGL viewer assets bundle.

Why this exists:
- `export_drawables_for_chunk.py` exports for a single chunk.
- Doing that for hundreds of chunks via subprocess would re-initialize CodeWalker each time (very slow).
- This script scans *all* chunk jsonl files, builds a global archetype frequency table,
  then exports missing meshes (and optional textures) in one CodeWalker session.

Inputs (from --assets-dir):
- assets/entities_index.json
- assets/entities_chunks/*.jsonl

Outputs (to --assets-dir):
- assets/models/manifest.json updated/extended
- assets/models/*.bin mesh files
- optional: assets/models_textures/*.png when --export-textures

Notes:
- This is resumable: rerun with --skip-existing to only export missing hashes (and optionally missing textures).
- Exporting *all* unique archetypes may take a long time. Use --max-total or --time-budget-sec for iteration.
"""

from __future__ import annotations

import sys
import argparse
import json
import os
import time
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

# Allow running as `python scripts/export_drawables_for_all_chunks.py` from repo root (or elsewhere)
# by ensuring the repo root is on sys.path.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from gta5_modules.dll_manager import DllManager
from gta5_modules.rpf_reader import RpfReader

# Reuse the proven per-archetype export logic + helpers.
import export_drawables_for_chunk as edc


def _load_json(p: Path) -> Any:
    return json.loads(p.read_text(encoding="utf-8"))


def _iter_chunk_files_from_index(assets_dir: Path) -> List[Tuple[str, Path]]:
    idx_path = assets_dir / "entities_index.json"
    if not idx_path.exists():
        raise FileNotFoundError(f"Missing: {idx_path} (run scripts/build_entities_streaming_index.py and webgl_viewer/setup_assets.py)")
    idx = _load_json(idx_path)
    chunks = idx.get("chunks") or {}
    out: List[Tuple[str, Path]] = []
    for key, meta in chunks.items():
        f = str((meta or {}).get("file") or "").strip()
        if not f:
            continue
        out.append((str(key), assets_dir / "entities_chunks" / f))
    out.sort(key=lambda kv: kv[0])
    return out


def _scan_archetypes(
    chunk_files: List[Tuple[str, Path]],
    *,
    max_entities_per_chunk: int,
    max_unique_per_chunk: int,
    verbose_every_chunks: int = 20,
) -> Dict[int, int]:
    """
    Return {archetypeHash:uint32 -> countAcrossScannedEntities}.

    We scan jsonl files once; this is cheap compared to mesh extraction.
    """
    counts: Dict[int, int] = defaultdict(int)
    started = time.time()
    for ci, (key, path) in enumerate(chunk_files):
        if verbose_every_chunks and (ci % verbose_every_chunks == 0):
            dt = time.time() - started
            print(f"[scan] chunk {ci+1}/{len(chunk_files)} ({key})  unique_so_far={len(counts)}  elapsed={dt:.1f}s")

        if not path.exists():
            continue
        seen_in_chunk: set[int] = set()
        total_lines = 0
        try:
            with path.open("r", encoding="utf-8") as f:
                for line in f:
                    if max_entities_per_chunk and total_lines >= max_entities_per_chunk:
                        break
                    total_lines += 1
                    s = line.strip()
                    if not s:
                        continue
                    try:
                        e = json.loads(s)
                    except Exception:
                        continue
                    a = e.get("archetype")
                    if a is None:
                        continue
                    try:
                        h = edc._as_uint32(a)
                    except Exception:
                        continue
                    counts[h] += 1
                    if max_unique_per_chunk and h not in seen_in_chunk:
                        seen_in_chunk.add(h)
                        if len(seen_in_chunk) >= max_unique_per_chunk:
                            # Still count occurrences for already-seen hashes if present in file,
                            # but avoid growing the unique set too fast for huge chunks.
                            pass
        except Exception as e:
            print(f"[scan] warning: failed scanning {path}: {e}")
            continue
    return counts


def _get_game_file_cache(dm: DllManager):
    # Keep this consistent with export_drawables_for_chunk.py
    gfc = None
    if hasattr(dm, "get_game_file_cache"):
        try:
            gfc = dm.get_game_file_cache()
        except Exception:
            gfc = None
    if gfc is None and hasattr(dm, "get_game_cache"):
        try:
            gfc = dm.get_game_cache()
        except Exception:
            gfc = None
    if gfc is None:
        gfc = getattr(dm, "game_file_cache", None)
    if gfc is None:
        raise RuntimeError("GameFileCache not available on DllManager (required for drawables)")
    try:
        gfc.MaxItemsPerLoop = 50
    except Exception:
        pass
    return gfc


def _load_models_manifest(models_dir: Path) -> Dict[str, Any]:
    manifest_path = models_dir / "manifest.json"
    manifest: Dict[str, Any] = {"version": 4, "meshes": {}}
    if manifest_path.exists():
        try:
            existing = json.loads(manifest_path.read_text(encoding="utf-8"))
            if isinstance(existing, dict) and isinstance(existing.get("meshes"), dict):
                manifest = existing
                if "version" not in manifest:
                    manifest["version"] = 4
        except Exception:
            pass
    if "meshes" not in manifest or not isinstance(manifest.get("meshes"), dict):
        manifest["meshes"] = {}
    return manifest


def _entry_has_any_diffuse(entry: Any) -> bool:
    """
    Manifest v4 stores diffuse per-submesh: entry.lods.<lod>.submeshes[i].material.diffuse.
    Older manifests may store it at entry.material.diffuse.
    """
    try:
        if isinstance(entry, dict) and isinstance(entry.get("material"), dict) and entry["material"].get("diffuse"):
            return True
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
                mat = sm.get("material")
                if isinstance(mat, dict) and mat.get("diffuse"):
                    return True
    except Exception:
        return False
    return False


def main() -> int:
    ap = argparse.ArgumentParser(description="Bulk export drawables for ALL entity chunks (single CodeWalker session).")
    ap.add_argument("--game-path", default=os.getenv("gta_location", ""), help="GTA5 install folder (or set gta_location)")
    ap.add_argument("--assets-dir", default="/data/webglgta/webgl-gta/webgl_viewer/assets", help="webgl_viewer/assets directory")
    ap.add_argument("--export-textures", action="store_true", help="Export one diffuse texture per submesh (slow)")
    ap.add_argument("--skip-existing", action="store_true", help="Skip meshes already present in assets/models/manifest.json")
    ap.add_argument("--force", action="store_true", help="Force re-export mesh bins even if present in manifest")
    ap.add_argument("--time-budget-sec", type=float, default=0.0, help="Stop after this many seconds (0 = no limit)")
    ap.add_argument("--max-total", type=int, default=0, help="Only export top-N archetypes globally (0 = no limit)")
    ap.add_argument("--max-entities-per-chunk", type=int, default=0, help="Scan at most N lines per chunk file (0 = no limit)")
    ap.add_argument("--scan-only", action="store_true", help="Only scan archetypes and print counts; do not export")
    ap.add_argument("--write-report", action="store_true", help="Write a JSON report into assets/models/")
    args = ap.parse_args()

    game_path = (args.game_path or "").strip('"').strip("'")
    if not game_path:
        raise SystemExit("Missing --game-path (or gta_location env var)")

    assets_dir = Path(args.assets_dir).expanduser().resolve()
    chunk_files = _iter_chunk_files_from_index(assets_dir)
    if not chunk_files:
        raise SystemExit(f"No chunks found in {assets_dir / 'entities_index.json'}")

    print(f"Found chunks: {len(chunk_files)}")
    counts = _scan_archetypes(
        chunk_files,
        max_entities_per_chunk=int(args.max_entities_per_chunk or 0),
        max_unique_per_chunk=0,
    )
    print(f"Unique archetypes discovered: {len(counts)}")

    # Rank by how often the archetype appears (most visible first).
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    if args.max_total and args.max_total > 0:
        ranked = ranked[: int(args.max_total)]

    if args.scan_only:
        print("Top 25 archetypes by frequency:")
        for h, c in ranked[:25]:
            print(f"  {h}  count={c}")
        return 0

    models_dir = assets_dir / "models"
    models_dir.mkdir(parents=True, exist_ok=True)
    manifest = _load_models_manifest(models_dir)
    already = set((manifest.get("meshes") or {}).keys())

    dm = DllManager(game_path)
    if not dm.initialized:
        raise SystemExit("Failed to initialize DllManager")
    gfc = _get_game_file_cache(dm)

    tex_dir = assets_dir / "models_textures"
    rpf_reader = RpfReader(str(game_path), dm) if args.export_textures else None

    started = time.time()
    requested = 0
    exported_now = 0
    textures_exported_now = 0
    skipped_existing = 0
    no_archetype = 0
    no_drawable = 0
    no_lods = 0
    errors = 0
    failures_sample: List[Dict[str, Any]] = []

    def _time_up() -> bool:
        if not args.time_budget_sec or args.time_budget_sec <= 0:
            return False
        return (time.time() - started) >= float(args.time_budget_sec)

    for h, _cnt in ranked:
        if _time_up():
            print("Time budget reached; stopping.")
            break

        requested += 1
        hs = str(int(h) & 0xFFFFFFFF)
        existing_entry = (manifest.get("meshes") or {}).get(hs) if isinstance(manifest.get("meshes"), dict) else None
        have_mesh_already = bool(existing_entry and isinstance(existing_entry, dict) and (existing_entry.get("lods") or {}))
        have_diffuse_already = _entry_has_any_diffuse(existing_entry) if isinstance(existing_entry, dict) else False

        if args.skip_existing and (not args.force) and hs in already and (not args.export_textures or have_diffuse_already):
            skipped_existing += 1
            continue

        try:
            arch = gfc.GetArchetype(int(h) & 0xFFFFFFFF)
        except Exception:
            arch = None
        if arch is None:
            no_archetype += 1
            if len(failures_sample) < 200:
                failures_sample.append({"hash": hs, "reason": "no_archetype"})
            continue

        # Trigger drawable load and pump the content loader.
        drawable = gfc.TryGetDrawable(arch)
        spins = 0
        while drawable is None and spins < 400:
            gfc.ContentThreadProc()
            drawable = gfc.TryGetDrawable(arch)
            spins += 1
        if drawable is None:
            no_drawable += 1
            if len(failures_sample) < 200:
                failures_sample.append({"hash": hs, "reason": "no_drawable"})
            continue

        entry = existing_entry if (have_mesh_already and isinstance(existing_entry, dict)) else {"lods": {}, "lodDistances": {}, "material": {}}
        if not isinstance(entry, dict):
            entry = {"lods": {}, "lodDistances": {}, "material": {}}

        # Read texdict + textures once per archetype (used for per-submesh texture selection).
        td_hash = None
        textures = None
        if args.export_textures and rpf_reader:
            try:
                tdh = getattr(arch, "TextureDict", None)
                if tdh is not None:
                    # NOTE: `arch.TextureDict` is often a CodeWalker `MetaHash`.
                    # Don't use `getattr(tdh, "Hash", int(tdh))` because Python eagerly evaluates
                    # the default arg (and `int(MetaHash)` throws). Fetch Hash explicitly.
                    try:
                        td_hash = int(getattr(tdh, "Hash")) & 0xFFFFFFFF
                    except Exception:
                        td_hash = int(tdh) & 0xFFFFFFFF
            except Exception:
                td_hash = None
            try:
                if td_hash and td_hash != 0:
                    ytd = gfc.GetYtd(td_hash)
                    spins = 0
                    while (ytd is not None) and (not getattr(ytd, "Loaded", True)) and spins < 400:
                        gfc.ContentThreadProc()
                        spins += 1
                    if ytd is not None and getattr(ytd, "Loaded", True):
                        textures = rpf_reader.get_ytd_textures(ytd)
            except Exception:
                textures = None

        if (not have_mesh_already) or bool(args.force):
            lod_distances = {}
            for k in ("High", "Med", "Low", "VLow"):
                prop = "LodDist" + ("Vlow" if k == "VLow" else k)
                try:
                    lod_distances[k] = float(getattr(drawable, prop))
                except Exception:
                    pass
            entry["lodDistances"] = lod_distances
            entry.setdefault("lods", {})
            entry.setdefault("material", {})

        if (not have_mesh_already) or bool(args.force):
            try:
                for lod in ("High", "Med", "Low", "VLow"):
                    lod_key = lod.lower()
                    subs = edc._extract_drawable_lod_submeshes(drawable, lod)
                    if not subs:
                        continue
                    sub_entries = []
                    for si, sub in enumerate(subs):
                        positions = sub["positions"]
                        indices = sub["indices"]
                        normals = sub["normals"]
                        uv0 = sub.get("uv0")
                        shader = sub.get("shader")

                        uvs = uv0 if (uv0 is not None and getattr(uv0, "size", 0)) else edc._compute_planar_uvs_xy01(positions)

                        out_bin = models_dir / f"{int(h)}_{lod_key}_{si}.bin"
                        edc._write_mesh_bin(out_bin, positions, indices, normals, uvs)

                        mat = {}
                        uvso = edc._extract_uv0_scale_offset_from_shader(shader)
                        if uvso and len(uvso) >= 4:
                            mat["uv0ScaleOffset"] = [float(uvso[0]), float(uvso[1]), float(uvso[2]), float(uvso[3])]

                        if textures and isinstance(textures, dict) and td_hash:
                            pick = edc._pick_diffuse_texture_name_from_shader(textures, shader)
                            if pick and pick in textures:
                                img, _fmt = textures[pick]
                                try:
                                    if img is not None:
                                        import numpy as np
                                        from PIL import Image

                                        if img.shape[2] == 3:
                                            rgba = np.concatenate(
                                                [img, 255 * np.ones((img.shape[0], img.shape[1], 1), dtype=np.uint8)], axis=2
                                            )
                                        else:
                                            rgba = img
                                        tex_dir.mkdir(parents=True, exist_ok=True)
                                        safe = edc._safe_tex_name(pick)
                                        out_tex = tex_dir / f"{td_hash}_{safe}.png"
                                        if not out_tex.exists():
                                            Image.fromarray(rgba, mode="RGBA").save(out_tex)
                                            textures_exported_now += 1
                                        mat["diffuse"] = f"models_textures/{td_hash}_{safe}.png"
                                        mat["diffuseName"] = str(pick)
                                except Exception:
                                    pass

                        sub_entries.append(
                            {
                                "file": f"{int(h)}_{lod_key}_{si}.bin",
                                "vertexCount": int(positions.shape[0]),
                                "indexCount": int(indices.shape[0]),
                                "hasNormals": True,
                                "hasUvs": True,
                                "material": mat,
                            }
                        )
                    if sub_entries:
                        entry["lods"][lod_key] = {"submeshes": sub_entries}

                if not entry.get("lods"):
                    no_lods += 1
                    if len(failures_sample) < 200:
                        failures_sample.append({"hash": hs, "reason": "no_lods"})
                    continue

                manifest["meshes"][hs] = entry
                already.add(hs)
                if not have_mesh_already:
                    exported_now += 1

                # Periodically flush manifest so the job is resumable even if interrupted.
                if exported_now and (exported_now % 50 == 0):
                    (models_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
                    dt = time.time() - started
                    print(
                        f"[export] exported_now={exported_now} textures_exported_now={textures_exported_now} "
                        f"unique_manifest={len(manifest['meshes'])} elapsed={dt:.1f}s"
                    )

            except Exception:
                errors += 1
                if len(failures_sample) < 200:
                    failures_sample.append({"hash": hs, "reason": "exception_writing"})
        else:
            # Texture-only update for already-exported meshes.
            if args.export_textures and textures and isinstance(textures, dict) and td_hash:
                try:
                    for lod in ("High", "Med", "Low", "VLow"):
                        lod_key = lod.lower()
                        lod_meta = entry.get("lods", {}).get(lod_key) if isinstance(entry.get("lods"), dict) else None
                        if not isinstance(lod_meta, dict):
                            continue
                        submeshes = lod_meta.get("submeshes")
                        if not isinstance(submeshes, list) or not submeshes:
                            continue

                        # Re-extract submesh shaders so we can pick a diffuse texture name.
                        subs = edc._extract_drawable_lod_submeshes(drawable, lod)
                        if not subs:
                            continue

                        for si, sub in enumerate(subs):
                            if si >= len(submeshes):
                                break
                            sm = submeshes[si]
                            if not isinstance(sm, dict):
                                continue
                            mat = sm.get("material")
                            if not isinstance(mat, dict):
                                mat = {}
                                sm["material"] = mat
                            if mat.get("diffuse"):
                                continue

                            shader = sub.get("shader")
                            pick = edc._pick_diffuse_texture_name_from_shader(textures, shader)
                            if not pick or pick not in textures:
                                continue
                            img, _fmt = textures[pick]
                            if img is None:
                                continue
                            try:
                                import numpy as np
                                from PIL import Image

                                if img.shape[2] == 3:
                                    rgba = np.concatenate([img, 255 * np.ones((img.shape[0], img.shape[1], 1), dtype=np.uint8)], axis=2)
                                else:
                                    rgba = img
                                tex_dir.mkdir(parents=True, exist_ok=True)
                                safe = edc._safe_tex_name(pick)
                                out_tex = tex_dir / f"{td_hash}_{safe}.png"
                                if not out_tex.exists():
                                    Image.fromarray(rgba, mode="RGBA").save(out_tex)
                                    textures_exported_now += 1
                                mat["diffuse"] = f"models_textures/{td_hash}_{safe}.png"
                                mat["diffuseName"] = str(pick)
                            except Exception:
                                pass
                except Exception:
                    pass

            manifest["meshes"][hs] = entry

    # Final manifest write
    (models_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(
        f"Done. requested={requested} exported_now={exported_now} textures_exported_now={textures_exported_now} "
        f"skipped_existing={skipped_existing} no_archetype={no_archetype} no_drawable={no_drawable} no_lods={no_lods} errors={errors}"
    )

    if args.write_report:
        report = {
            "version": 1,
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "assetsDir": str(assets_dir),
            "modelsDir": str(models_dir),
            "counts": {
                "chunks": len(chunk_files),
                "unique_archetypes_scanned": len(counts),
                "requested": requested,
                "exportedNow": exported_now,
                "texturesExportedNow": textures_exported_now,
                "skippedExisting": skipped_existing,
                "noArchetype": no_archetype,
                "noDrawable": no_drawable,
                "noLods": no_lods,
                "errors": errors,
            },
            "failuresSample": failures_sample,
        }
        rp = models_dir / f"export_report_allchunks_{int(time.time())}.json"
        rp.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"Wrote report: {rp}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())



#!/usr/bin/env python3
"""
Export drawable meshes for a specific list of archetypes (hashes).

This is meant to pair with the viewer-side "Download missing archetypes (json)" button:
- Fly/stream an area
- Download missing list (hash + count)
- Export top-N missing archetypes into webgl_viewer/assets/models/manifest.json

Usage:
  python webgl/export_drawables_from_list.py --game-path "X:\\GTA5" --assets-dir webgl/webgl_viewer/assets --input missing_archetypes_*.json --top 2000 --skip-existing
"""

import argparse
import json
import os
from pathlib import Path
import time
import glob

from gta5_modules.dll_manager import DllManager
from gta5_modules.rpf_reader import RpfReader
from gta5_modules.script_paths import auto_assets_dir
from gta5_modules.manifest_utils import load_or_init_models_manifest
from gta5_modules.codewalker_archetypes import get_archetype_best_effort
from gta5_modules.cw_loaders import try_get_drawable as _try_get_drawable
from gta5_modules.cw_loaders import try_get_ytd as _try_get_ytd


def _load_hashes_from_input(p: Path) -> list[int]:
    """
    Accepts:
    - viewer json: { missingTop: [ {hash: "123", count: 999}, ... ] }
    - simple array: [ "123", 456, ... ] or [ {hash: "..."} , ... ]
    - newline-delimited text: one hash per line
    """
    if not p.exists():
        # PowerShell/cmd won't always expand wildcards for Python args.
        # Support passing a glob like "missing_archetypes_*.json".
        pat = str(p)
        if any(ch in pat for ch in ("*", "?", "[")):
            matches = [Path(x) for x in glob.glob(pat)]
            matches = [m for m in matches if m.exists() and m.is_file()]
            if not matches:
                raise FileNotFoundError(p)
            # Prefer the newest match.
            matches.sort(key=lambda mp: mp.stat().st_mtime, reverse=True)
            p = matches[0]
        else:
            raise FileNotFoundError(p)

    txt = p.read_text(encoding="utf-8", errors="ignore").strip()
    if not txt:
        return []

    # JSON?
    if txt[0] in ("{", "["):
        obj = json.loads(txt)
        items = None
        if isinstance(obj, dict):
            items = obj.get("missingTop") or obj.get("hashes") or obj.get("archetypes") or []
        elif isinstance(obj, list):
            items = obj
        else:
            items = []

        hashes: list[int] = []
        for it in items:
            h = None
            if isinstance(it, dict):
                h = it.get("hash")
            else:
                h = it
            if h is None:
                continue
            s = str(h).strip()
            if not s or not s.lstrip("-").isdigit():
                continue
            hashes.append(int(s, 10) & 0xFFFFFFFF)
        return hashes

    # Text lines
    hashes = []
    for line in txt.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if not s.lstrip("-").isdigit():
            continue
        hashes.append(int(s, 10) & 0xFFFFFFFF)
    return hashes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-path", default=os.getenv("gta_location", ""), help="GTA5 install folder (or set gta_location)")
    ap.add_argument("--assets-dir", default="", help="WebGL viewer assets directory (auto if omitted)")
    ap.add_argument("--input", required=True, help="Path to missing archetypes json (from viewer) or newline list")
    ap.add_argument("--top", type=int, default=0, help="Only export first N hashes from the input (0 = all)")
    ap.add_argument("--skip-existing", action="store_true", help="Skip archetypes already present in assets/models/manifest.json")
    ap.add_argument("--force", action="store_true", help="Force re-export mesh bins even if present in manifest (useful after exporter changes)")
    ap.add_argument("--export-textures", action="store_true", help="Export one diffuse texture per archetype (slow)")
    ap.add_argument("--write-report", action="store_true", help="Write a JSON report of export outcomes into assets/models")
    args = ap.parse_args()

    game_path = (args.game_path or "").strip('"').strip("'")
    if not game_path:
        raise SystemExit("Missing --game-path (or gta_location env var)")

    # Import helpers from the chunk exporter so both code paths (chunk + list) produce identical outputs.
    from export_drawables_for_chunk import (  # type: ignore
        _as_uint32,
        _compute_planar_uvs_xy01,
        _extract_drawable_lod_submeshes,
        _extract_uv0_scale_offset_from_shader,
        _pick_diffuse_texture_name_from_shader,
        _safe_tex_name,
        _write_mesh_bin,
    )

    assets_dir = auto_assets_dir(args.assets_dir)

    models_dir = assets_dir / "models"
    manifest_path, manifest = load_or_init_models_manifest(models_dir, min_version=4)
    already = set((manifest.get("meshes") or {}).keys())

    hashes = _load_hashes_from_input(Path(args.input))
    # Dedupe but keep stable order.
    seen = set()
    hashes2: list[int] = []
    for h in hashes:
        hh = int(h) & 0xFFFFFFFF
        if hh in seen:
            continue
        seen.add(hh)
        hashes2.append(hh)
    hashes = hashes2

    if args.top and args.top > 0:
        hashes = hashes[: int(args.top)]
    if not hashes:
        raise SystemExit("No hashes found in --input")

    print(f"Export list: {len(hashes)} archetypes (top={args.top or 0}, skip_existing={bool(args.skip_existing)})")

    dm = DllManager(game_path)
    if not dm.initialized:
        raise SystemExit("Failed to initialize DllManager")
    if not dm.init_game_file_cache():
        raise SystemExit("Failed to init GameFileCache (required for drawables)")
    gfc = dm.get_game_file_cache()
    try:
        gfc.MaxItemsPerLoop = 50
    except Exception:
        pass

    tex_dir = assets_dir / "models_textures"
    rpf_reader = RpfReader(str(game_path), dm) if args.export_textures else None

    skipped_existing = 0
    exported_now = 0
    textures_exported_now = 0
    requested = 0
    no_archetype = 0
    no_drawable = 0
    no_lods = 0
    errors = 0
    failures_sample = []  # [{hash, reason}...]
    for i, h in enumerate(hashes):
        requested += 1
        hs = str(int(h) & 0xFFFFFFFF)
        existing_entry = (manifest.get("meshes") or {}).get(hs) if isinstance(manifest.get("meshes"), dict) else None
        have_mesh_already = bool(existing_entry and isinstance(existing_entry, dict) and (existing_entry.get("lods") or {}))
        have_diffuse_already = bool(isinstance(existing_entry, dict) and isinstance(existing_entry.get("material"), dict) and existing_entry["material"].get("diffuse"))

        # If we're only missing textures, allow "--skip-existing" to still process texture export.
        if args.skip_existing and (not args.force) and hs in already and (not args.export_textures or have_diffuse_already):
            skipped_existing += 1
            continue

        if (i + 1) % 100 == 0:
            print(f"[{i+1}/{len(hashes)}] ... exported_now={exported_now} skipped_existing={skipped_existing}")

        try:
            hu = _as_uint32(h)
        except Exception:
            continue

        arch = get_archetype_best_effort(gfc, int(hu) & 0xFFFFFFFF, dll_manager=dm)
        if arch is None:
            no_archetype += 1
            if len(failures_sample) < 200:
                failures_sample.append({"hash": hs, "reason": "no_archetype"})
            continue

        drawable = _try_get_drawable(gfc, arch, spins=400)
        if drawable is None:
            no_drawable += 1
            if len(failures_sample) < 200:
                failures_sample.append({"hash": hs, "reason": "no_drawable"})
            continue

        # If mesh already exists and we only want textures, skip geometry work.
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

        if (not have_mesh_already) or bool(args.force):
            # Export per-geometry submeshes per LOD.
            lod_distances = {}
            for k in ("High", "Med", "Low", "VLow"):
                prop = "LodDist" + ("Vlow" if k == "VLow" else k)
                try:
                    lod_distances[k] = float(getattr(drawable, prop))
                except Exception:
                    pass
            entry["lodDistances"] = lod_distances
            if "lods" not in entry or not isinstance(entry.get("lods"), dict):
                entry["lods"] = {}
            if "material" not in entry or not isinstance(entry.get("material"), dict):
                entry["material"] = {}

        if (not have_mesh_already) or bool(args.force):
            try:
                for lod in ("High", "Med", "Low", "VLow"):
                    lod_key = lod.lower()
                    subs = _extract_drawable_lod_submeshes(drawable, lod)
                    if not subs:
                        continue
                    sub_entries = []
                    for si, sub in enumerate(subs):
                        positions = sub["positions"]
                        indices = sub["indices"]
                        normals = sub["normals"]
                        uv0 = sub.get("uv0")
                        shader = sub.get("shader")

                        uvs = uv0 if (uv0 is not None and getattr(uv0, "size", 0)) else _compute_planar_uvs_xy01(positions)
                        out_bin = models_dir / f"{hu}_{lod_key}_{si}.bin"
                        tangents = None
                        try:
                            from export_drawables_for_chunk import _compute_vertex_tangents  # type: ignore
                            tangents = _compute_vertex_tangents(positions, uvs, indices, normals)
                        except Exception:
                            tangents = None
                        _write_mesh_bin(out_bin, positions, indices, normals, uvs, tangents)

                        mat = {}
                        uvso = _extract_uv0_scale_offset_from_shader(shader)
                        if uvso and len(uvso) >= 4:
                            mat["uv0ScaleOffset"] = [float(uvso[0]), float(uvso[1]), float(uvso[2]), float(uvso[3])]

                        if textures and isinstance(textures, dict) and td_hash:
                            pick = _pick_diffuse_texture_name_from_shader(textures, shader)
                            if pick and pick in textures:
                                img, _fmt = textures[pick]
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
                                    safe = _safe_tex_name(pick)
                                    out_tex = tex_dir / f"{td_hash}_{safe}.png"
                                    if not out_tex.exists():
                                        Image.fromarray(rgba, mode="RGBA").save(out_tex)
                                        textures_exported_now += 1
                                    mat["diffuse"] = f"models_textures/{td_hash}_{safe}.png"
                                    mat["diffuseName"] = str(pick)

                        sub_entries.append(
                            {
                                "file": f"{hu}_{lod_key}_{si}.bin",
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
                    entry = None
            except Exception:
                errors += 1
                if len(failures_sample) < 200:
                    failures_sample.append({"hash": hs, "reason": "exception_writing"})
                entry = None

        if entry is not None:
            manifest["meshes"][hs] = entry
            already.add(hs)
            if not have_mesh_already:
                exported_now += 1

    models_dir.mkdir(parents=True, exist_ok=True)
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    print(
        f"Done. manifestMeshes={len(manifest.get('meshes') or {})} "
        f"requested={requested} exported_now={exported_now} textures_exported_now={textures_exported_now} skipped_existing={skipped_existing} "
        f"no_archetype={no_archetype} no_drawable={no_drawable} no_lods={no_lods} errors={errors}"
    )

    if args.write_report:
        try:
            report = {
                "version": 1,
                "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "input": str(args.input),
                "top": int(args.top or 0),
                "assetsDir": str(assets_dir),
                "modelsDir": str(models_dir),
                "requested": requested,
                "exportedNow": exported_now,
                "texturesExportedNow": textures_exported_now,
                "skippedExisting": skipped_existing,
                "noArchetype": no_archetype,
                "noDrawable": no_drawable,
                "noLods": no_lods,
                "errors": errors,
                "failuresSample": failures_sample,
            }
            rp = models_dir / f"export_report_list_{int(time.time())}.json"
            rp.write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(f"Wrote export report: {rp}")
        except Exception:
            pass


if __name__ == "__main__":
    main()



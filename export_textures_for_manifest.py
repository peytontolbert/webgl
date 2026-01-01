#!/usr/bin/env python3
"""
Export diffuse textures for meshes already present in assets/models/manifest.json.

This is the fastest way to make textures show up without re-exporting geometry.

Usage:
  python webgl/export_textures_for_manifest.py --game-path "X:\\GTA5" --assets-dir webgl/webgl_viewer/assets --max 2000
"""

import argparse
import json
import os
import traceback
from pathlib import Path
from typing import Optional

from gta5_modules.dll_manager import DllManager
from gta5_modules.rpf_reader import RpfReader


def _as_u32(s: str) -> Optional[int]:
    try:
        ss = str(s).strip()
        if not ss or not ss.lstrip("-").isdigit():
            return None
        return int(ss, 10) & 0xFFFFFFFF
    except Exception:
        return None


def _ensure_entry_material(entry: dict) -> dict:
    if not isinstance(entry, dict):
        return {}
    mat0 = entry.get("material")
    if not isinstance(mat0, dict):
        mat0 = {}
        entry["material"] = mat0
    return mat0


def _entry_has_any_map(entry: dict, key: str) -> bool:
    if not isinstance(entry, dict):
        return False
    mat = entry.get("material")
    if isinstance(mat, dict) and mat.get(key):
        return True
    lods = entry.get("lods")
    if isinstance(lods, dict):
        for lod_meta in lods.values():
            if not isinstance(lod_meta, dict):
                continue
            subs = lod_meta.get("submeshes")
            if not isinstance(subs, list):
                continue
            for sm in subs:
                if not isinstance(sm, dict):
                    continue
                smm = sm.get("material")
                if isinstance(smm, dict) and smm.get(key):
                    return True
    return False


def _entry_has_any_diffuse(entry: dict) -> bool:
    return _entry_has_any_map(entry, "diffuse")


def _promote_first_submesh_material_to_entry_level(entry: dict) -> bool:
    """
    If v4 per-submesh materials exist, copy the first found submesh material fields
    (diffuse/normal/spec + uv0ScaleOffset/scalars) up to entry["material"].

    This keeps v3/back-compat paths (and viewer fallbacks) looking reasonable.
    """
    if not isinstance(entry, dict):
        return False
    lods = entry.get("lods")
    if not isinstance(lods, dict):
        return False
    first_mat = None
    for lod_meta in lods.values():
        if not isinstance(lod_meta, dict):
            continue
        subs = lod_meta.get("submeshes")
        if not isinstance(subs, list) or not subs:
            continue
        for sm in subs:
            if not isinstance(sm, dict):
                continue
            m = sm.get("material")
            if isinstance(m, dict) and m:
                first_mat = m
                break
        if first_mat:
            break
    if not isinstance(first_mat, dict) or not first_mat:
        return False

    mat0 = _ensure_entry_material(entry)
    changed = False
    for k in ("diffuse", "normal", "spec", "uv0ScaleOffset", "bumpiness", "specularIntensity", "specularPower"):
        if k in first_mat and mat0.get(k) != first_mat.get(k):
            mat0[k] = first_mat.get(k)
            changed = True
    return changed


#
# NOTE: `_entry_has_any_diffuse` used to be duplicated in this file as a "back-compat alias".
# Keep a single definition to avoid confusion.


def _load_shard_index(models_dir: Path) -> Optional[dict]:
    idx_path = models_dir / "manifest_index.json"
    if not idx_path.exists():
        return None
    try:
        idx = json.loads(idx_path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return None
    if not isinstance(idx, dict) or idx.get("schema") != "webglgta-manifest-index-v1":
        return None
    return idx


def _shard_path_for_hash(models_dir: Path, idx: dict, h_u32: int) -> Path:
    bits = int(idx.get("shard_bits") or 8)
    bits = max(4, min(12, bits))
    mask = (1 << bits) - 1
    shard_id = (int(h_u32) & 0xFFFFFFFF) & mask
    hex_digits = (bits + 3) // 4
    shard_hex = format(shard_id, "x").zfill(hex_digits)
    shard_dir = str(idx.get("shard_dir") or "manifest_shards")
    shard_ext = str(idx.get("shard_file_ext") or ".json")
    return models_dir / shard_dir / f"{shard_hex}{shard_ext}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-path", default=os.getenv("gta_location", ""), help="GTA5 install folder (or set gta_location)")
    ap.add_argument("--assets-dir", default="", help="webgl_viewer/assets folder (auto if omitted)")
    ap.add_argument("--max", type=int, default=0, help="Limit number of textures exported (0 = all)")
    ap.add_argument("--only-missing", action="store_true", help="Only export when material.diffuse is missing")
    ap.add_argument("--ytd-spins", type=int, default=2000, help="Max ContentThreadProc spins while waiting for a YTD to load")
    ap.add_argument("--drawable-spins", type=int, default=600, help="Max ContentThreadProc spins while waiting for a Drawable to load")
    ap.add_argument("--export-ktx2", action="store_true", help="Also write .ktx2 copies for exported textures (requires toktx; writes *Ktx2 fields in materials)")
    ap.add_argument("--toktx", default="toktx", help="Path to toktx executable (KTX-Software). Used when --export-ktx2 is set.")
    ap.add_argument("--max-items-per-loop", type=int, default=200, help="GameFileCache.MaxItemsPerLoop (higher can load faster but may hitch)")
    ap.add_argument(
        "--dump-shader-params",
        action="store_true",
        help="Debug: print shader parameter hashes/types/texture names for the first few drawables processed",
    )
    ap.add_argument("--dump-shader-params-count", type=int, default=5, help="How many drawables to dump when --dump-shader-params is set")
    ap.add_argument("--dump-shader-params-limit", type=int, default=250, help="Max shader params to print per drawable")
    ap.add_argument("--debug-ytd", action="store_true", help="Print debug info about first few loaded YTDs/texture dicts")
    ap.add_argument("--debug-ytd-count", type=int, default=3, help="How many YTDs to debug when --debug-ytd is set")
    ap.add_argument("--dump-skip-samples", action="store_true", help="Print a sample of mesh hashes for each non-zero skip reason")
    ap.add_argument("--skip-samples", type=int, default=25, help="Max samples to print per skip reason")
    args = ap.parse_args()

    game_path = (args.game_path or "").strip('"').strip("'")
    if not game_path:
        raise SystemExit("Missing --game-path (or gta_location env var)")

    if args.assets_dir:
        assets_dir = Path(args.assets_dir)
    else:
        assets_dir = Path(__file__).parent / "webgl_viewer" / "assets"
        if not assets_dir.exists():
            alt = Path.cwd() / "webgl_viewer" / "assets"
            if alt.exists():
                assets_dir = alt

    manifest_path = assets_dir / "models" / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit(f"Missing {manifest_path}")

    mm = json.loads(manifest_path.read_text(encoding="utf-8", errors="ignore"))
    meshes = (mm.get("meshes") or {}) if isinstance(mm, dict) else {}
    if not isinstance(meshes, dict) or not meshes:
        raise SystemExit("Manifest has no meshes.")

    tex_dir = assets_dir / "models_textures"
    tex_dir.mkdir(parents=True, exist_ok=True)
    ktx2_dir = assets_dir / "models_textures_ktx2"
    if args.export_ktx2:
        ktx2_dir.mkdir(parents=True, exist_ok=True)

    # Optional sharded-manifest support: if present, we should update the shard files too,
    # because the WebGL viewer prefers loading shards via manifest_index.json.
    models_dir = assets_dir / "models"
    shard_idx = _load_shard_index(models_dir)
    shard_payloads = {}  # Path -> dict payload (loaded lazily)

    dm = DllManager(game_path)
    if not dm.initialized:
        raise SystemExit("Failed to initialize DllManager")
    if not dm.init_game_file_cache():
        raise SystemExit("Failed to init GameFileCache (required for textures)")
    # NOTE: Texture decode can happen either via CodeWalker texture.GetPixels(0) or via DDSIO.GetPixels(tex,0).
    # RpfReader.get_ytd_textures handles both paths, so do not hard-fail here.
    gfc = dm.get_game_file_cache()
    try:
        gfc.MaxItemsPerLoop = int(args.max_items_per_loop or 200)
    except Exception:
        pass

    rpf_reader = RpfReader(str(game_path), dm)

    # Reuse CodeWalker-aware material export helpers from the main drawable exporter.
    # This script is specifically for "fast texture/material fixups" without re-exporting geometry.
    from export_drawables_for_chunk import _update_existing_manifest_materials_for_drawable  # type: ignore

    keys = list(meshes.keys())
    maxn = int(args.max or 0)
    if maxn > 0:
        keys = keys[:maxn]

    entries_updated = 0
    textures_written = 0
    skipped = 0
    skip_reasons = {
        "bad_hash": 0,
        "only_missing_already_has_diffuse": 0,
        "no_archetype": 0,
        "no_drawable": 0,
        "no_texture_dict": 0,
        "bad_texture_dict_hash": 0,
        "no_ytd": 0,
        "ytd_not_loaded": 0,
        "no_textures_in_ytd": 0,
        "exception": 0,
    }
    first_exception = None  # (type, message, traceback)
    exception_counts = {}  # "Type: message" -> count
    debug_left = int(args.debug_ytd_count or 0) if args.debug_ytd else 0
    debug_empty_dumped = False
    dump_shader_left = int(args.dump_shader_params_count or 0) if args.dump_shader_params else 0
    skip_samples = {}  # reason -> list[dict]
    max_skip_samples = max(1, int(args.skip_samples or 25))

    def _iter_shader_params(shader):
        """
        Yield (hash_u32, dataTypeInt, paramObj) for a shader's parameter list.
        dataType values come from CodeWalker:
          0 = Texture, 1 = Vector4, >1 = array-ish.
        """
        if shader is None:
            return
        plist = getattr(shader, "ParametersList", None)
        if plist is None:
            return
        hashes = getattr(plist, "Hashes", None)
        params = getattr(plist, "Parameters", None)
        if hashes is None or params is None:
            return
        count = int(getattr(plist, "Count", 0) or 0)
        if count <= 0:
            try:
                count = len(params)
            except Exception:
                count = 0
        for ii in range(count):
            try:
                hv = int(hashes[ii]) & 0xFFFFFFFF
            except Exception:
                continue
            try:
                p = params[ii]
            except Exception:
                continue
            try:
                dt = int(getattr(p, "DataType", 255))
            except Exception:
                dt = 255
            yield hv, dt, p

    def _dump_drawable_shader_params(mesh_hash_u32: int, drawable_obj):
        nonlocal dump_shader_left
        if dump_shader_left <= 0:
            return
        dump_shader_left -= 1
        try:
            lim = int(args.dump_shader_params_limit or 250)
        except Exception:
            lim = 250
        lim = max(10, min(2000, lim))

        print(f"[shader-dump] mesh_hash={int(mesh_hash_u32) & 0xFFFFFFFF}")
        printed = 0
        try:
            models_block = getattr(drawable_obj, "DrawableModels", None)
            arr = getattr(models_block, "High", None) if models_block is not None else None
            models = list(arr) if arr is not None else []
        except Exception:
            models = []
        for mi, m in enumerate(models):
            gs = getattr(m, "Geometries", None)
            if gs is None:
                continue
            for gi, g in enumerate(list(gs)):
                shader = getattr(g, "Shader", None)
                if shader is None:
                    continue
                for hv, dt, p in _iter_shader_params(shader) or []:
                    if printed >= lim:
                        print(f"[shader-dump] ... truncated (limit={lim})")
                        return
                    tex_name = None
                    if dt == 0:
                        try:
                            tex = getattr(p, "Data", None)
                            tex_name = str(getattr(tex, "Name", "")).strip() if tex is not None else None
                        except Exception:
                            tex_name = None
                    # Keep it mostly machine-readable: hv, dtype, texName?
                    if tex_name:
                        print(f"[shader-dump] model={mi} geom={gi} hv={hv} dt={dt} tex={tex_name}")
                    else:
                        print(f"[shader-dump] model={mi} geom={gi} hv={hv} dt={dt}")
                    printed += 1
        if printed == 0:
            print("[shader-dump] (no shader params found)")

    def _sample(reason: str, **payload):
        if not args.dump_skip_samples:
            return
        lst = skip_samples.get(reason)
        if lst is None:
            lst = []
            skip_samples[reason] = lst
        if len(lst) >= max_skip_samples:
            return
        payload2 = {"mesh_hash": hs}
        payload2.update(payload)
        lst.append(payload2)
    for i, hs in enumerate(keys):
        h = _as_u32(hs)
        if h is None:
            skip_reasons["bad_hash"] += 1
            _sample("bad_hash")
            skipped += 1
            continue
        entry = meshes.get(hs) or {}
        have = _entry_has_any_diffuse(entry) if isinstance(entry, dict) else False
        if args.only_missing and have:
            skip_reasons["only_missing_already_has_diffuse"] += 1
            _sample("only_missing_already_has_diffuse")
            skipped += 1
            continue

        arch = gfc.GetArchetype(h)
        if arch is None:
            skip_reasons["no_archetype"] += 1
            _sample("no_archetype", archetype=None)
            skipped += 1
            continue

        try:
            # Load the Drawable too so we can read per-geometry shader params (uv tiling + correct sampler picks).
            drawable = None
            try:
                drawable = gfc.TryGetDrawable(arch)
            except Exception:
                drawable = None
            spins_d = 0
            max_spins_d = int(args.drawable_spins or 600)
            if max_spins_d < 0:
                max_spins_d = 0
            while drawable is None and spins_d < max_spins_d:
                gfc.ContentThreadProc()
                spins_d += 1
                try:
                    drawable = gfc.TryGetDrawable(arch)
                except Exception:
                    drawable = None
            if drawable is None:
                skip_reasons["no_drawable"] += 1
                _sample("no_drawable", spins=spins_d)
                skipped += 1
                continue

            if dump_shader_left > 0:
                _dump_drawable_shader_params(h, drawable)

            tdh = getattr(arch, "TextureDict", None)
            td_hash = None
            if tdh is not None:
                # Be defensive: different CodeWalker builds expose different types here.
                # Prefer a .Hash property, otherwise try casting.
                hv = None
                try:
                    hv = getattr(tdh, "Hash", None)
                except Exception:
                    hv = None
                if hv is None:
                    try:
                        hv = int(tdh)
                    except Exception:
                        hv = None
                try:
                    td_hash = (int(hv) & 0xFFFFFFFF) if hv is not None else None
                except Exception:
                    td_hash = None
                    skip_reasons["bad_texture_dict_hash"] += 1
                    _sample("bad_texture_dict_hash", texture_dict_raw=str(tdh))
                    skipped += 1
                    continue
            if not td_hash or td_hash == 0:
                skip_reasons["no_texture_dict"] += 1
                _sample("no_texture_dict", texture_dict_hash=td_hash)
                skipped += 1
                continue

            # Primary: treat TextureDict as a YTD shortname hash (common case).
            ytd = gfc.GetYtd(td_hash)
            # CodeWalker has additional indirection helpers for cases where a hash is a *texture* name
            # (not the ytd shortname) or when a texture dict is inherited from a parent.
            if ytd is None:
                try:
                    # If td_hash is actually a texture name hash, resolve it to the owning YTD.
                    ytd = gfc.TryGetTextureDictForTexture(td_hash)
                except Exception:
                    ytd = None
            if ytd is None:
                try:
                    # Try parent texture dict chain (rare but exists for some assets).
                    ph = gfc.TryGetParentYtdHash(td_hash)
                    if ph and int(ph) != 0:
                        ytd = gfc.GetYtd(int(ph) & 0xFFFFFFFF)
                except Exception:
                    pass
            spins = 0
            max_spins = int(args.ytd_spins or 2000)
            if max_spins < 0:
                max_spins = 0
            while (ytd is not None) and (not getattr(ytd, "Loaded", True)) and spins < max_spins:
                gfc.ContentThreadProc()
                spins += 1
            if ytd is None or not getattr(ytd, "Loaded", True):
                if ytd is None:
                    skip_reasons["no_ytd"] += 1
                    _sample("no_ytd", texture_dict_hash=td_hash)
                else:
                    skip_reasons["ytd_not_loaded"] += 1
                    _sample("ytd_not_loaded", texture_dict_hash=td_hash, spins=spins)
                skipped += 1
                continue

            if debug_left > 0:
                debug_left -= 1
                try:
                    td = getattr(ytd, "TextureDict", None)
                    td_has = td is not None
                    tlist = getattr(td, "Textures", None) if td_has else None
                    dct = getattr(td, "Dict", None) if td_has else None
                    # Attempt to count textures without forcing pixel decode.
                    tcount = None
                    try:
                        di = getattr(tlist, "data_items", None)
                        if di is not None:
                            tcount = len(di)
                    except Exception:
                        tcount = None
                    if tcount is None:
                        try:
                            vals = getattr(dct, "Values", None)
                            if vals is not None:
                                tcount = len(list(vals))
                        except Exception:
                            tcount = None
                    print(
                        f"[debug] ytd Loaded={getattr(ytd,'Loaded',None)} "
                        f"TextureDict={td_has} "
                        f"Textures.data_items_len={tcount}"
                    )
                except Exception:
                    pass

            textures = rpf_reader.get_ytd_textures(ytd)
            if not textures:
                if not debug_empty_dumped:
                    debug_empty_dumped = True
                    try:
                        td = getattr(ytd, "TextureDict", None)
                        tlist = getattr(td, "Textures", None) if td is not None else None
                        thashes = getattr(td, "TextureNameHashes", None) if td is not None else None
                        di = getattr(tlist, "data_items", None) if tlist is not None else None
                        dhi = getattr(thashes, "data_items", None) if thashes is not None else None
                        d = getattr(td, "Dict", None) if td is not None else None
                        dv = getattr(d, "Values", None) if d is not None else None
                        try:
                            dict_count = len(list(dv)) if dv is not None else None
                        except Exception:
                            dict_count = None

                        print("[debug-empty] First YTD returned 0 decoded textures.")
                        print(f"[debug-empty] ytd.Loaded={getattr(ytd,'Loaded',None)} td_hash={td_hash}")
                        print(
                            f"[debug-empty] TextureDict present={td is not None} "
                            f"Textures.data_items_len={(len(di) if di is not None else None)} "
                            f"TextureNameHashes.data_items_len={(len(dhi) if dhi is not None else None)} "
                            f"Dict.Values_len={dict_count}"
                        )

                        # Try probing the first texture entry and DDSIO.
                        if di is not None and len(di) > 0:
                            tex0 = di[0]
                            print(
                                f"[debug-empty] tex0 name={getattr(tex0,'Name',None)} "
                                f"w={getattr(tex0,'Width',None)} h={getattr(tex0,'Height',None)} "
                                f"stride={getattr(tex0,'Stride',None)} fmt={getattr(getattr(tex0,'Format',None),'ToString',lambda: getattr(tex0,'Format',None))()}"
                            )
                            # DDSIO probe
                            ddsio = getattr(dm, "DDSIO", None)
                            print(f"[debug-empty] dm.DDSIO type={type(ddsio).__name__} has_GetPixels={hasattr(ddsio,'GetPixels')}")
                            try:
                                if ddsio is not None and hasattr(ddsio, "GetPixels"):
                                    px = ddsio.GetPixels(tex0, 0)
                                    blen = len(bytes(px)) if px is not None else 0
                                    print(f"[debug-empty] DDSIO.GetPixels(tex0,0) bytes_len={blen}")
                            except Exception as e:
                                print(f"[debug-empty] DDSIO.GetPixels threw: {type(e).__name__}: {e}")
                    except Exception:
                        pass
                skip_reasons["no_textures_in_ytd"] += 1
                _sample("no_textures_in_ytd", texture_dict_hash=td_hash)
                skipped += 1
                continue
            # Update manifest materials and export textures (diffuse/normal/spec + params) using shader-aware picks.
            if not isinstance(entry, dict):
                entry = {}
                meshes[hs] = entry

            wrote_now = _update_existing_manifest_materials_for_drawable(
                entry=entry,
                drawable=drawable,
                textures=textures,
                td_hash=int(td_hash) & 0xFFFFFFFF,
                tex_dir=tex_dir,
                export_ktx2=bool(args.export_ktx2),
                ktx2_dir=ktx2_dir,
                toktx_exe=str(args.toktx or "toktx"),
            )
            # NOTE:
            # `_update_existing_manifest_materials_for_drawable(...)` returns the number of *new PNG files written*.
            # That can legitimately be 0 even when it updated manifest material params (or when textures already existed).
            # Treat this as success as long as we decoded a non-empty textures dict.
            try:
                wn = int(wrote_now or 0)
            except Exception:
                wn = 0
            if wn > 0:
                textures_written += wn

            _promote_first_submesh_material_to_entry_level(entry)

            # If sharded manifests exist, update the correct shard entry too.
            if shard_idx is not None:
                sp = _shard_path_for_hash(models_dir, shard_idx, h)
                try:
                    payload = shard_payloads.get(sp)
                    if payload is None:
                        if sp.exists():
                            payload = json.loads(sp.read_text(encoding="utf-8", errors="ignore"))
                        else:
                            payload = {}
                        shard_payloads[sp] = payload
                    if isinstance(payload, dict):
                        pmeshes = payload.get("meshes")
                        if not isinstance(pmeshes, dict):
                            pmeshes = {}
                            payload["meshes"] = pmeshes
                        pentry = pmeshes.get(hs)
                        if not isinstance(pentry, dict):
                            pentry = {}
                            pmeshes[hs] = pentry
                        _update_existing_manifest_materials_for_drawable(
                            entry=pentry,
                            drawable=drawable,
                            textures=textures,
                            td_hash=int(td_hash) & 0xFFFFFFFF,
                            tex_dir=tex_dir,
                            export_ktx2=bool(args.export_ktx2),
                            ktx2_dir=ktx2_dir,
                            toktx_exe=str(args.toktx or "toktx"),
                        )
                        _promote_first_submesh_material_to_entry_level(pentry)
                except Exception:
                    # Don't fail the whole run because a shard couldn't be updated.
                    pass
            entries_updated += 1
        except Exception as e:
            skip_reasons["exception"] += 1
            _sample("exception", texture_dict_hash=locals().get("td_hash", None), error=f"{type(e).__name__}: {e}")
            skipped += 1
            # Capture the first traceback + a summary of exception types/messages.
            try:
                et = type(e).__name__
                msg = str(e)
                key = f"{et}: {msg}"
                exception_counts[key] = int(exception_counts.get(key, 0)) + 1
                if first_exception is None:
                    first_exception = (et, msg, traceback.format_exc())
            except Exception:
                pass

        if (i + 1) % 250 == 0:
            print(f"[{i+1}/{len(keys)}] entries_updated={entries_updated} textures_written={textures_written} skipped={skipped}")

    # Write manifest back
    mm["meshes"] = meshes
    manifest_path.write_text(json.dumps(mm, indent=2), encoding="utf-8")

    # Write updated shards back (if any were touched/loaded).
    if shard_payloads:
        wrote = 0
        for sp, payload in shard_payloads.items():
            try:
                if not isinstance(payload, dict):
                    continue
                sp.parent.mkdir(parents=True, exist_ok=True)
                sp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
                wrote += 1
            except Exception:
                continue
        print(f"Updated shard files: {wrote}")

    # Print a quick breakdown to make "everything skipped" diagnosable.
    try:
        print("Skip reasons:")
        for k in sorted(skip_reasons.keys()):
            v = int(skip_reasons.get(k, 0) or 0)
            if v:
                print(f"  - {k}: {v}")
    except Exception:
        pass

    # Print some concrete examples for each skip bucket so it's actionable.
    if args.dump_skip_samples and skip_samples:
        try:
            print("Skip samples:")
            for reason in sorted(skip_samples.keys()):
                rows = skip_samples.get(reason) or []
                if not rows:
                    continue
                print(f"  - {reason}:")
                for row in rows:
                    print(f"    - {row}")
        except Exception:
            pass

    # Print exception detail (first traceback + most common messages).
    if first_exception is not None:
        try:
            et, msg, tb = first_exception
            print("First exception:")
            print(f"  {et}: {msg}")
            print(tb)
        except Exception:
            pass
    try:
        if exception_counts:
            print("Top exceptions:")
            top = sorted(exception_counts.items(), key=lambda kv: kv[1], reverse=True)[:10]
            for k, v in top:
                print(f"  - {k} -> {v}")
    except Exception:
        pass

    print(f"Done. entries_updated={entries_updated} textures_written={textures_written} skipped={skipped} -> {manifest_path}")


if __name__ == "__main__":
    main()



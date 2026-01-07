#!/usr/bin/env python3
"""
Export vehicle + ped models (including fragment/YFT cases) into the WebGL viewer format.

This does NOT write .ydr/.ydd/.yft files. It *reads* them via CodeWalker and writes:
- webgl_viewer/assets/models/<hash>_<lod>_<sub>.bin
- webgl_viewer/assets/models/manifest.json (v4, with per-submesh material)
- optionally textures into webgl_viewer/assets/models_textures/

Usage (cmd.exe):
  python webgl/export_vehicles_peds_fragments.py --game-path "%gta_location%" --assets-dir webgl/webgl_viewer/assets --max-vehicles 200 --max-peds 200 --export-textures
"""

import argparse
import json
import os
from pathlib import Path

from gta5_modules.dll_manager import DllManager
from gta5_modules.rpf_reader import RpfReader
from gta5_modules.script_paths import auto_assets_dir
from gta5_modules.hash_utils import try_coerce_u32 as _try_coerce_u32
from gta5_modules.manifest_utils import load_or_init_models_manifest as _load_or_init_models_manifest
from gta5_modules.codewalker_archetypes import get_archetype_best_effort


def _as_u32(x) -> int:
    """
    Best-effort conversion to unsigned 32-bit int.

    pythonnet doesn't always allow `int(MetaHash(...))` even though MetaHash has an
    implicit conversion to uint in C#; explicitly read `.Hash` when present.
    """
    # Wrapper kept for legacy callers in this script.
    if x is None:
        return 0
    v = _try_coerce_u32(x, allow_hex=True)
    if v is None:
        raise TypeError(f"Cannot convert to u32: {type(x)} {x!r}")
    return int(v) & 0xFFFFFFFF


def _load_or_init_manifest(models_dir: Path) -> tuple[Path, dict]:
    # Wrapper kept for legacy callers in this script.
    return _load_or_init_models_manifest(models_dir, min_version=4)


def _iter_dict_keys(d):
    """Iterate keys of a .NET Dictionary via pythonnet (best-effort)."""
    if d is None:
        return []
    try:
        ks = getattr(d, "Keys", None)
        if ks is not None:
            return list(ks)
    except Exception:
        pass
    try:
        return list(d.keys())
    except Exception:
        pass
    try:
        return list(d)
    except Exception:
        return []


def _resolve_drawable_for_model_hash(gfc, model_hash_u32: int, spins: int = 800):
    """
    Returns (drawable_base, archetype_or_none).

    drawable_base can be:
    - CodeWalker.GameFiles.Drawable
    - CodeWalker.GameFiles.FragDrawable
    """
    arch = get_archetype_best_effort(gfc, int(model_hash_u32) & 0xFFFFFFFF, dll_manager=None)

    # 1) Archetype path (best: includes TextureDict)
    if arch is not None:
        try:
            drawable = gfc.TryGetDrawable(arch)
        except Exception:
            drawable = None
        s = 0
        while drawable is None and s < spins:
            try:
                gfc.ContentThreadProc()
            except Exception:
                break
            try:
                drawable = gfc.TryGetDrawable(arch)
            except Exception:
                drawable = None
            s += 1
        if drawable is not None:
            return drawable, arch

    # 2) YFT fragment path (vehicles)
    try:
        yft = gfc.GetYft(int(model_hash_u32) & 0xFFFFFFFF)
    except Exception:
        yft = None
    s = 0
    while (yft is not None) and (not getattr(yft, "Loaded", True)) and s < spins:
        try:
            gfc.ContentThreadProc()
        except Exception:
            break
        s += 1
    if yft is not None and getattr(yft, "Loaded", True):
        frag = getattr(yft, "Fragment", None)
        if frag is not None:
            dr = getattr(frag, "Drawable", None)
            if dr is not None:
                return dr, arch
            darr = getattr(frag, "DrawableArray", None)
            try:
                di = getattr(darr, "data_items", None)
                if di:
                    for cand in di:
                        if cand is not None:
                            return cand, arch
            except Exception:
                pass

    # 3) YDR direct
    try:
        ydr = gfc.GetYdr(int(model_hash_u32) & 0xFFFFFFFF)
    except Exception:
        ydr = None
    s = 0
    while (ydr is not None) and (not getattr(ydr, "Loaded", True)) and s < spins:
        try:
            gfc.ContentThreadProc()
        except Exception:
            break
        s += 1
    if ydr is not None and getattr(ydr, "Loaded", True):
        dr = getattr(ydr, "Drawable", None)
        if dr is not None:
            return dr, arch

    # 4) YDD (rare to resolve without knowing dict membership); skip for now.
    return None, arch


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-path", default=os.getenv("gta_location", ""), help="GTA5 install folder (or set gta_location)")
    ap.add_argument("--assets-dir", default="", help="webgl_viewer/assets folder (auto if omitted)")
    ap.add_argument(
        "--selected-dlc",
        default="all",
        help="CodeWalker DLC level. Use 'all' for full DLC overlays (except patchday27ng unless explicitly selected).",
    )
    ap.add_argument("--split-by-dlc", action="store_true", help="Write exported textures into assets/packs/<dlcname>/models_textures when possible.")
    ap.add_argument("--pack-root-prefix", default="packs", help="Pack root dir under assets/ (default: packs).")
    ap.add_argument("--force-pack", default="", help="Force writing all exported textures into a single pack id.")
    ap.add_argument("--max-vehicles", type=int, default=0, help="Limit vehicle models exported (0=all)")
    ap.add_argument("--max-peds", type=int, default=0, help="Limit ped models exported (0=all)")
    ap.add_argument("--skip-existing", action="store_true", help="Skip model hashes already in manifest with any LODs")
    ap.add_argument("--force", action="store_true", help="Force re-export mesh bins for matching hashes")
    ap.add_argument("--export-textures", action="store_true", help="Export diffuse/normal/spec per submesh (slow)")
    ap.add_argument("--ytd-spins", type=int, default=5000, help="Max ContentThreadProc spins while waiting for a YTD to load")
    ap.add_argument("--max-items-per-loop", type=int, default=200, help="GameFileCache.MaxItemsPerLoop")
    args = ap.parse_args()

    game_path = (args.game_path or "").strip('"').strip("'")
    if not game_path:
        raise SystemExit("Missing --game-path (or gta_location env var)")

    assets_dir = auto_assets_dir(args.assets_dir)

    models_dir = assets_dir / "models"
    models_dir.mkdir(parents=True, exist_ok=True)
    manifest_path, manifest = _load_or_init_manifest(models_dir)

    dm = DllManager(game_path)
    if not dm.initialized:
        raise SystemExit("Failed to initialize DllManager")
    if not dm.init_game_file_cache(load_vehicles=True, load_peds=True, load_audio=False, selected_dlc=str(args.selected_dlc or "").strip() or None):
        raise SystemExit("Failed to init GameFileCache (required for vehicles/peds)")

    gfc = dm.get_game_file_cache()
    try:
        gfc.MaxItemsPerLoop = int(args.max_items_per_loop or 200)
    except Exception:
        pass

    rpf_reader = RpfReader(str(game_path), dm) if args.export_textures else None
    tex_dir_base = assets_dir / "models_textures"
    packs_root = assets_dir / str(args.pack_root_prefix or "packs").strip().strip("/").strip("\\")
    force_pack = str(args.force_pack or "").strip().lower()
    split_by_dlc = bool(args.split_by_dlc)

    def _infer_dlc_name_from_entry_path(p: str) -> str:
        s = str(p or "").strip().lower().replace("/", "\\")
        m = re.search(r"\\dlcpacks\\([^\\]+)\\", s)
        return str(m.group(1) or "").strip().lower() if m else ""

    # Reuse helpers from the chunk exporter so results match the viewer.
    from export_drawables_for_chunk import (  # type: ignore
        _extract_drawable_lod_submeshes,
        _compute_planar_uvs_xy01,
        _compute_vertex_tangents,
        _write_mesh_bin,
        _extract_uv0_scale_offset_from_shader,
        _extract_scalar_x_from_shader,
        _pick_diffuse_texture_name_from_shader,
        _pick_texture_name_from_shader,
        _pick_texture_by_keywords,
        _export_texture_png,
        _SP_NORMAL_PREFERRED,
        _SP_SPEC_PREFERRED,
        _SP_BUMPINESS,
        _SP_SPEC_INTENSITY_PREFERRED,
        _SP_SPEC_POWER_PREFERRED,
    )

    # Collect model hashes from CodeWalker dictionaries.
    veh_keys = _iter_dict_keys(getattr(gfc, "VehiclesInitDict", None))
    ped_keys = _iter_dict_keys(getattr(gfc, "PedsInitDict", None))

    # Normalize keys to u32 ints
    vehicles = [_as_u32(k) for k in veh_keys]
    peds = [_as_u32(k) for k in ped_keys]
    vehicles.sort()
    peds.sort()
    if args.max_vehicles and args.max_vehicles > 0:
        vehicles = vehicles[: int(args.max_vehicles)]
    if args.max_peds and args.max_peds > 0:
        peds = peds[: int(args.max_peds)]

    print(f"Vehicles in cache: {len(veh_keys)} (exporting {len(vehicles)})")
    print(f"Peds in cache: {len(ped_keys)} (exporting {len(peds)})")

    exported_now = 0
    skipped_existing = 0
    no_drawable = 0
    errors = 0

    def export_one(h_u32: int):
        nonlocal exported_now, skipped_existing, no_drawable, errors
        hs = str(int(h_u32) & 0xFFFFFFFF)
        meshes = manifest.get("meshes") or {}
        existing_entry = meshes.get(hs) if isinstance(meshes, dict) else None
        have_mesh_already = bool(isinstance(existing_entry, dict) and (existing_entry.get("lods") or {}))
        if args.skip_existing and (not args.force) and have_mesh_already:
            skipped_existing += 1
            return

        drawable, arch = _resolve_drawable_for_model_hash(gfc, int(h_u32) & 0xFFFFFFFF)
        if drawable is None:
            no_drawable += 1
            return

        # Try to load textures once per model hash (best-effort).
        textures = None
        td_hash = None
        if args.export_textures and rpf_reader is not None and arch is not None:
            try:
                tdh = getattr(arch, "TextureDict", None)
                hv = getattr(tdh, "Hash", None) if tdh is not None else None
                if hv is None and tdh is not None:
                    hv = int(tdh)
                td_hash = (int(hv) & 0xFFFFFFFF) if hv is not None else None
            except Exception:
                td_hash = None

        # Choose output dir for textures for this model (base vs pack).
        tex_dir = tex_dir_base
        if args.export_textures:
            if force_pack:
                tex_dir = packs_root / force_pack / "models_textures"
            elif split_by_dlc and td_hash:
                try:
                    ytd = gfc.GetYtd(int(td_hash) & 0xFFFFFFFF)
                except Exception:
                    ytd = None
                ep = ""
                if ytd is not None:
                    try:
                        ent = getattr(ytd, "RpfFileEntry", None)
                        ep = str(getattr(ent, "Path", "") or "") if ent is not None else ""
                    except Exception:
                        ep = ""
                dlc = _infer_dlc_name_from_entry_path(ep)
                if dlc:
                    tex_dir = packs_root / dlc / "models_textures"

            if td_hash and int(td_hash) != 0:
                try:
                    ytd = gfc.GetYtd(int(td_hash) & 0xFFFFFFFF)
                except Exception:
                    ytd = None
                spins = 0
                while (ytd is not None) and (not getattr(ytd, "Loaded", True)) and spins < int(args.ytd_spins or 5000):
                    gfc.ContentThreadProc()
                    spins += 1
                if ytd is not None and getattr(ytd, "Loaded", True):
                    try:
                        textures = rpf_reader.get_ytd_textures(ytd)
                    except Exception:
                        textures = None

        entry = existing_entry if isinstance(existing_entry, dict) else {"lods": {}, "lodDistances": {}, "material": {}}
        if not isinstance(entry, dict):
            entry = {"lods": {}, "lodDistances": {}, "material": {}}

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
                    out_bin = models_dir / f"{h_u32}_{lod_key}_{si}.bin"
                    tangents = None
                    try:
                        tangents = _compute_vertex_tangents(positions, uvs, indices, normals)
                    except Exception:
                        tangents = None
                    _write_mesh_bin(out_bin, positions, indices, normals, uvs, tangents)

                    mat = {}
                    uvso = _extract_uv0_scale_offset_from_shader(shader)
                    if uvso and len(uvso) >= 4:
                        mat["uv0ScaleOffset"] = [float(uvso[0]), float(uvso[1]), float(uvso[2]), float(uvso[3])]
                    bumpiness = _extract_scalar_x_from_shader(shader, [_SP_BUMPINESS])
                    if bumpiness is not None:
                        mat["bumpiness"] = float(bumpiness)
                    spec_int = _extract_scalar_x_from_shader(shader, _SP_SPEC_INTENSITY_PREFERRED)
                    if spec_int is not None:
                        mat["specularIntensity"] = float(spec_int)
                    spec_pow = _extract_scalar_x_from_shader(shader, _SP_SPEC_POWER_PREFERRED)
                    if spec_pow is not None:
                        mat["specularPower"] = float(spec_pow)

                    if textures and isinstance(textures, dict) and td_hash:
                        pick_d = _pick_diffuse_texture_name_from_shader(textures, shader)
                        rel_d, _wrote_d = _export_texture_png(textures, pick_d, tex_dir, int(td_hash) & 0xFFFFFFFF) if pick_d else (None, False)
                        if rel_d:
                            mat["diffuse"] = rel_d
                            mat["diffuseName"] = str(pick_d)

                        pick_n = _pick_texture_name_from_shader(textures, shader, _SP_NORMAL_PREFERRED, require_keywords=("normal", "bump", "_n", "nrm", "nm_"))
                        if not pick_n:
                            pick_n = _pick_texture_name_from_shader(textures, shader, _SP_NORMAL_PREFERRED, require_keywords=None)
                        if not pick_n:
                            pick_n = _pick_texture_by_keywords(textures, include_keywords=("_n", "normal", "nrm", "nm_", "bump"))
                        rel_n, _wrote_n = _export_texture_png(textures, pick_n, tex_dir, int(td_hash) & 0xFFFFFFFF) if pick_n else (None, False)
                        if rel_n:
                            mat["normal"] = rel_n
                            mat["normalName"] = str(pick_n)

                        pick_s = _pick_texture_name_from_shader(textures, shader, _SP_SPEC_PREFERRED, require_keywords=("spec", "srm"))
                        if not pick_s:
                            pick_s = _pick_texture_name_from_shader(textures, shader, _SP_SPEC_PREFERRED, require_keywords=None)
                        if not pick_s:
                            pick_s = _pick_texture_by_keywords(textures, include_keywords=("spec", "srm"))
                        rel_s, _wrote_s = _export_texture_png(textures, pick_s, tex_dir, int(td_hash) & 0xFFFFFFFF) if pick_s else (None, False)
                        if rel_s:
                            mat["spec"] = rel_s
                            mat["specName"] = str(pick_s)

                    sub_entries.append(
                        {
                            "file": f"{h_u32}_{lod_key}_{si}.bin",
                            "vertexCount": int(positions.shape[0]),
                            "indexCount": int(indices.shape[0]),
                            "hasNormals": True,
                            "hasUvs": True,
                            "hasTangents": bool(tangents is not None),
                            "material": mat,
                        }
                    )

                if sub_entries:
                    entry["lods"][lod_key] = {"submeshes": sub_entries}

            (manifest.get("meshes") or {})[hs] = entry
            exported_now += 1
        except Exception:
            errors += 1

    for h in vehicles:
        export_one(h)
    for h in peds:
        export_one(h)

    # Save manifest
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(
        f"Done. exported_now={exported_now} skipped_existing={skipped_existing} no_drawable={no_drawable} errors={errors} -> {manifest_path}"
    )


if __name__ == "__main__":
    main()



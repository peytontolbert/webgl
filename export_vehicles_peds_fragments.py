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
import re
import traceback
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent / ".env")
except Exception:
    pass

from gta5_modules.dll_manager import DllManager
from gta5_modules.rpf_reader import RpfReader
from gta5_modules.script_paths import auto_assets_dir
from gta5_modules.hash_utils import try_coerce_u32 as _try_coerce_u32
from gta5_modules.hash_utils import joaat as _joaat
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


def _wait_loaded(gfc, obj, spins: int = 800):
    s = 0
    while (obj is not None) and (not getattr(obj, "Loaded", True)) and s < int(spins or 800):
        try:
            gfc.ContentThreadProc()
        except Exception:
            break
        s += 1
    return obj


def _resolve_drawables_for_model_hash(gfc, model_hash_u32: int, spins: int = 800):
    """
    Returns (drawables, archetype_or_none, texture_dict_hash_or_none).

    Direct ped models are usually YDD drawable dictionaries. Prefer those over
    YFT skeleton fragments so a ped export becomes a visible body, not just a rig.
    """
    h = int(model_hash_u32) & 0xFFFFFFFF
    arch = get_archetype_best_effort(gfc, h, dll_manager=None)

    # Archetype path (best for map/static drawables).
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
            td_hash = None
            try:
                tdh = getattr(arch, "TextureDict", None)
                hv = getattr(tdh, "Hash", None) if tdh is not None else None
                if hv is None and tdh is not None:
                    hv = int(tdh)
                td_hash = (int(hv) & 0xFFFFFFFF) if hv is not None else None
            except Exception:
                td_hash = None
            return [drawable], arch, td_hash

    # Direct YDD path (complete ambient peds such as a_m_y_skater_01).
    try:
        ydd = gfc.GetYdd(h)
    except Exception:
        ydd = None
    _wait_loaded(gfc, ydd, spins=spins)
    if ydd is not None and getattr(ydd, "Loaded", True):
        drawables = []
        try:
            arr = getattr(ydd, "Drawables", None)
            if arr:
                drawables = [d for d in list(arr) if d is not None]
        except Exception:
            drawables = []
        if not drawables:
            try:
                dct = getattr(ydd, "Dict", None)
                keys = list(getattr(dct, "Keys", [])) if dct is not None else []
                drawables = [dct[k] for k in keys if dct[k] is not None]
            except Exception:
                drawables = []
        if drawables:
            return drawables, arch, h

    # YFT fragment path (vehicles, ped skeleton fallback).
    try:
        yft = gfc.GetYft(h)
    except Exception:
        yft = None
    _wait_loaded(gfc, yft, spins=spins)
    if yft is not None and getattr(yft, "Loaded", True):
        frag = getattr(yft, "Fragment", None)
        if frag is not None:
            dr = getattr(frag, "Drawable", None)
            if dr is not None:
                return [dr], arch, h
            darr = getattr(frag, "DrawableArray", None)
            try:
                di = getattr(darr, "data_items", None)
                if di:
                    out = [cand for cand in di if cand is not None]
                    if out:
                        return out, arch, h
            except Exception:
                pass

    # YDR direct.
    try:
        ydr = gfc.GetYdr(h)
    except Exception:
        ydr = None
    _wait_loaded(gfc, ydr, spins=spins)
    if ydr is not None and getattr(ydr, "Loaded", True):
        dr = getattr(ydr, "Drawable", None)
        if dr is not None:
            return [dr], arch, h

    return [], arch, None


def _vehicle_wheel_specs(gfc, model_hash_u32: int):
    """Return fragment wheel drawables with baked local bone translations."""
    try:
        yft = _wait_loaded(gfc, gfc.GetYft(int(model_hash_u32) & 0xFFFFFFFF))
        frag = getattr(yft, "Fragment", None)
        main = getattr(frag, "Drawable", None)
        lod = getattr(getattr(frag, "PhysicsLODGroup", None), "PhysicsLOD1", None)
        children = getattr(getattr(lod, "Children", None), "data_items", None)
        bones_block = getattr(getattr(main, "Skeleton", None), "Bones", None)
        bones = getattr(bones_block, "Items", None)
        if not children:
            return []

        bone_positions = {}
        for bone in bones or []:
            tag = int(getattr(bone, "Tag", 0) or 0)
            mat = getattr(bone, "AnimTransform", None)
            xyz = None
            if mat is not None:
                try:
                    xyz = (float(mat.M41), float(mat.M42), float(mat.M43))
                except Exception:
                    xyz = None
            if xyz is None:
                vec = getattr(bone, "Translation", None)
                try:
                    xyz = (float(vec.X), float(vec.Y), float(vec.Z))
                except Exception:
                    xyz = None
            if xyz is not None:
                bone_positions[tag] = xyz

        defaults = {
            27922: (-0.82, 1.36, 0.34),  # wheel_lf
            26418: (0.82, 1.36, 0.34),   # wheel_rf
            27902: (-0.82, -1.36, 0.34), # wheel_lr
            26398: (0.82, -1.36, 0.34),  # wheel_rr
        }
        front = None
        rear = None
        by_tag = {}
        for child in children:
            tag = int(getattr(child, "BoneTag", 0) or 0)
            drawable = getattr(child, "Drawable1", None)
            if drawable is not None and len(getattr(drawable, "AllModels", []) or []) > 0:
                by_tag[tag] = drawable
                if tag in (27922, 26418):
                    front = drawable
                elif tag in (27902, 26398):
                    rear = drawable
        front = front or rear
        rear = rear or front
        if front is None:
            return []
        out = []
        for tag in (27922, 26418, 27902, 26398):
            drawable = by_tag.get(tag) or (front if tag in (27922, 26418) else rear)
            if drawable is not None:
                out.append((drawable, bone_positions.get(tag) or defaults[tag], tag))
        return out
    except Exception:
        return []


def _parse_model_specs(values: list[str]) -> list[int]:
    out: list[int] = []
    seen: set[int] = set()
    for value in values:
        for token in re.split(r"[\s,;]+", str(value or "").strip()):
            if not token:
                continue
            h = _try_coerce_u32(token, allow_hex=True)
            if h is None:
                h = _joaat(token, lower=True)
            h = int(h) & 0xFFFFFFFF
            if h not in seen:
                seen.add(h)
                out.append(h)
    return out


def _load_manifest_entry_from_shard(models_dir: Path, model_hash_u32: int):
    index_path = models_dir / "manifest_index.json"
    if not index_path.exists():
        return None
    try:
        idx = json.loads(index_path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return None
    if not isinstance(idx, dict) or idx.get("schema") != "webglgta-manifest-index-v1":
        return None
    try:
        bits = int(idx.get("shard_bits") or 8)
    except Exception:
        bits = 8
    bits = max(4, min(12, bits))
    sid = (int(model_hash_u32) & 0xFFFFFFFF) & ((1 << bits) - 1)
    hex_digits = max(1, (bits + 3) // 4)
    ext = str(idx.get("shard_file_ext") or ".json")
    if not ext.startswith("."):
        ext = "." + ext
    shard_path = models_dir / str(idx.get("shard_dir") or "manifest_shards") / f"{sid:0{hex_digits}x}{ext}"
    if not shard_path.exists():
        return None
    try:
        payload = json.loads(shard_path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return None
    meshes = payload.get("meshes") if isinstance(payload, dict) else None
    if not isinstance(meshes, dict):
        return None
    ent = meshes.get(str(int(model_hash_u32) & 0xFFFFFFFF))
    return ent if isinstance(ent, dict) else None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-path", default=(os.getenv("gta_location") or os.getenv("gta5_path") or ""), help="GTA5 install folder (or set gta_location/gta5_path)")
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
    ap.add_argument("--models", default="", help="Comma/space separated model names or hashes to export exactly")
    ap.add_argument("--model", action="append", default=[], help="Single model name/hash to export; can be repeated")
    ap.add_argument("--skip-existing", action="store_true", help="Skip model hashes already in manifest with any LODs")
    ap.add_argument("--force", action="store_true", help="Force re-export mesh bins for matching hashes")
    ap.add_argument("--shard-only", action="store_true", help="Patch touched manifest shards without loading/writing the huge monolithic manifest")
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
    if args.shard_only:
        manifest_path = models_dir / "manifest.json"
        manifest = {"version": 4, "meshes": {}}
    else:
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
        _material_flags_from_shader,
        _extract_shader_params,
        _shader_param_iter,
        _SP_NORMAL_PREFERRED,
        _SP_SPEC_PREFERRED,
        _SP_BUMPINESS,
        _SP_SPEC_INTENSITY_PREFERRED,
        _SP_SPEC_POWER_PREFERRED,
    )

    explicit_models = _parse_model_specs([args.models, *(args.model or [])])
    if explicit_models:
        vehicles = []
        peds = explicit_models
        print(f"Explicit models requested: {len(explicit_models)} -> {', '.join(str(x) for x in explicit_models)}")
    else:
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
    error_details: list[str] = []
    touched_hashes: set[str] = set()

    def export_one(h_u32: int):
        nonlocal exported_now, skipped_existing, no_drawable, errors
        hs = str(int(h_u32) & 0xFFFFFFFF)
        meshes = manifest.get("meshes")
        if not isinstance(meshes, dict):
            meshes = {}
            manifest["meshes"] = meshes
        existing_entry = meshes.get(hs)
        if existing_entry is None and args.shard_only:
            existing_entry = _load_manifest_entry_from_shard(models_dir, int(h_u32) & 0xFFFFFFFF)
        have_mesh_already = bool(isinstance(existing_entry, dict) and (existing_entry.get("lods") or {}))
        if args.skip_existing and (not args.force) and have_mesh_already:
            skipped_existing += 1
            return

        drawables, arch, resolved_td_hash = _resolve_drawables_for_model_hash(gfc, int(h_u32) & 0xFFFFFFFF)
        if not drawables:
            no_drawable += 1
            return
        wheel_specs = _vehicle_wheel_specs(gfc, int(h_u32) & 0xFFFFFFFF)

        # Try to load textures once per model hash (best-effort).
        textures = None
        td_hash = resolved_td_hash
        if args.export_textures and rpf_reader is not None and arch is not None and not td_hash:
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
                sub_entries = []
                si = 0
                drawable_specs = [(drawable, None, None) for drawable in drawables]
                if lod == "High":
                    drawable_specs.extend(wheel_specs)
                for drawable, baked_translation, wheel_tag in drawable_specs:
                    # Fragment child drawables inherit the main vehicle shader group.
                    # CodeWalker normally wires this for rendering, but older YFTs can
                    # arrive through pythonnet with Geometry.Shader still unset.
                    try:
                        owner = getattr(drawable, "OwnerDrawable", None)
                        shader_group = getattr(drawable, "ShaderGroup", None) or getattr(owner, "ShaderGroup", None)
                        if shader_group is not None:
                            drawable.AssignGeometryShaders(shader_group)
                    except Exception:
                        shader_group = None
                    subs = _extract_drawable_lod_submeshes(drawable, lod)
                    if not subs:
                        continue
                    for drawable_sub_index, sub in enumerate(subs):
                        positions = sub["positions"]
                        if baked_translation is not None:
                            positions = positions.copy()
                            positions[:, 0] += float(baked_translation[0])
                            positions[:, 1] += float(baked_translation[1])
                            positions[:, 2] += float(baked_translation[2])
                        indices = sub["indices"]
                        normals = sub["normals"]
                        uv0 = sub.get("uv0")
                        col0 = sub.get("color0")
                        uv1 = sub.get("uv1")
                        uv2 = sub.get("uv2")
                        col1 = sub.get("color1")
                        blend_weights = sub.get("blendWeights")
                        blend_indices = sub.get("blendIndices")
                        bone_ids = sub.get("boneIds")
                        shader = sub.get("shader")
                        if shader is None and shader_group is not None:
                            try:
                                shaders = getattr(getattr(shader_group, "Shaders", None), "data_items", None)
                                shader_id = int(sub.get("shaderId") or 0)
                                if shaders is not None and 0 <= shader_id < len(shaders):
                                    shader = shaders[shader_id]
                            except Exception:
                                shader = None

                        uvs = uv0 if (uv0 is not None and getattr(uv0, "size", 0)) else _compute_planar_uvs_xy01(positions)
                        uvs1 = uv1 if (uv1 is not None and getattr(uv1, "size", 0)) else uvs
                        uvs2 = uv2 if (uv2 is not None and getattr(uv2, "size", 0)) else uvs
                        out_bin = models_dir / f"{h_u32}_{lod_key}_{si}.bin"
                        tangents = None
                        try:
                            tangents = _compute_vertex_tangents(positions, uvs, indices, normals)
                        except Exception:
                            tangents = None
                        _write_mesh_bin(
                            out_bin,
                            positions,
                            indices,
                            normals,
                            uvs,
                            tangents,
                            color0=col0,
                            uvs1=uvs1,
                            uvs2=uvs2,
                            color1=col1,
                            blend_weights=blend_weights,
                            blend_indices=blend_indices,
                        )

                        mat = {}
                        try:
                            mat.update(_material_flags_from_shader(shader))
                        except Exception:
                            pass
                        try:
                            shader_params = _extract_shader_params(shader, max_textures=64, max_vectors=96)
                            if shader_params:
                                mat["shaderParams"] = shader_params
                        except Exception:
                            pass

                        # Vehicle materials commonly reference shared vehshare dictionaries,
                        # not just the model's own YTD. Decode the actual shader texture
                        # objects so every hash emitted by shaderParams is locally available.
                        if args.export_textures and shader is not None:
                            try:
                                for _param_hash, param in _shader_param_iter(shader) or []:
                                    if int(getattr(param, "DataType", 255)) != 0:
                                        continue
                                    tex_obj = getattr(param, "Data", None)
                                    tex_name = str(getattr(tex_obj, "Name", "") or "").strip() if tex_obj is not None else ""
                                    if not tex_name:
                                        continue
                                    _export_texture_png(
                                        textures if isinstance(textures, dict) else {},
                                        tex_name,
                                        tex_dir,
                                        td_hash=int(td_hash or 0) & 0xFFFFFFFF,
                                        shader_tex_obj=tex_obj,
                                        dll_manager=dm,
                                    )
                            except Exception:
                                pass
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
                            rel_d, _wrote_d = _export_texture_png(
                                textures,
                                pick_d,
                                tex_dir,
                                td_hash=int(td_hash) & 0xFFFFFFFF,
                            ) if pick_d else (None, False)
                            if rel_d:
                                mat["diffuse"] = rel_d
                                mat["diffuseName"] = str(pick_d)

                            pick_n = _pick_texture_name_from_shader(textures, shader, _SP_NORMAL_PREFERRED, require_keywords=("normal", "bump", "_n", "nrm", "nm_"))
                            if not pick_n:
                                pick_n = _pick_texture_name_from_shader(textures, shader, _SP_NORMAL_PREFERRED, require_keywords=None)
                            if not pick_n:
                                pick_n = _pick_texture_by_keywords(textures, include_keywords=("_n", "normal", "nrm", "nm_", "bump"))
                            rel_n, _wrote_n = _export_texture_png(
                                textures,
                                pick_n,
                                tex_dir,
                                td_hash=int(td_hash) & 0xFFFFFFFF,
                            ) if pick_n else (None, False)
                            if rel_n:
                                mat["normal"] = rel_n
                                mat["normalName"] = str(pick_n)

                            pick_s = _pick_texture_name_from_shader(textures, shader, _SP_SPEC_PREFERRED, require_keywords=("spec", "srm"))
                            if not pick_s:
                                pick_s = _pick_texture_name_from_shader(textures, shader, _SP_SPEC_PREFERRED, require_keywords=None)
                            if not pick_s:
                                pick_s = _pick_texture_by_keywords(textures, include_keywords=("spec", "srm"))
                            rel_s, _wrote_s = _export_texture_png(
                                textures,
                                pick_s,
                                tex_dir,
                                td_hash=int(td_hash) & 0xFFFFFFFF,
                            ) if pick_s else (None, False)
                            if rel_s:
                                mat["spec"] = rel_s
                                mat["specName"] = str(pick_s)

                        shader_name = str(mat.get("shaderName") or "").lower()
                        shader_textures = mat.get("shaderParams", {}).get("texturesByHash", {})
                        if isinstance(shader_textures, dict):
                            shader_textures = {
                                k: v for k, v in shader_textures.items()
                                if isinstance(v, str) and (assets_dir / v).exists()
                            }
                            mat["shaderParams"]["texturesByHash"] = shader_textures

                        # Fragment vehicle materials often use shared vehshare maps that
                        # are only symbolic references in the YFT. Never substitute an
                        # unrelated texture from the model YTD; use a stable material
                        # color when the intended diffuse map is unavailable.
                        intended_diffuse = shader_textures.get("4059966321") if isinstance(shader_textures, dict) else None
                        if "vehicle_" in shader_name and not intended_diffuse:
                            for key in ("diffuse", "diffuseName", "diffuseParamHash", "diffuseKtx2"):
                                mat.pop(key, None)
                            if "paint" in shader_name:
                                mat["baseColor"] = [0.42, 0.025, 0.018]
                            elif "tire" in shader_name:
                                if wheel_tag is not None and drawable_sub_index > 0:
                                    mat["baseColor"] = [0.16, 0.17, 0.18]
                                    mat["specularIntensity"] = 0.72
                                    mat["specularPower"] = 72.0
                                    mat["vehicleWheelPart"] = "rim"
                                else:
                                    mat["baseColor"] = [0.018, 0.019, 0.020]
                                    mat["specularIntensity"] = 0.08
                                    mat["specularPower"] = 10.0
                                    mat["vehicleWheelPart"] = "tire"
                            elif "glass" in shader_name:
                                mat["baseColor"] = [0.08, 0.12, 0.15]
                            elif "badge" in shader_name or "licenseplate" in shader_name:
                                mat["baseColor"] = [0.72, 0.72, 0.68]
                            elif "interior" in shader_name or "dash" in shader_name:
                                mat["baseColor"] = [0.09, 0.09, 0.085]
                            elif "light" in shader_name:
                                mat["baseColor"] = [0.72, 0.18, 0.08]
                            else:
                                mat["baseColor"] = [0.20, 0.20, 0.19]

                        sub_entries.append(
                            {
                                "file": f"{h_u32}_{lod_key}_{si}.bin",
                                "vertexCount": int(positions.shape[0]),
                                "indexCount": int(indices.shape[0]),
                                "hasNormals": True,
                                "hasUvs": True,
                                "hasTangents": bool(tangents is not None),
                                "hasColor0": bool(col0 is not None),
                                "hasColor1": bool(col1 is not None),
                                "hasBlendWeights": bool(blend_weights is not None),
                                "hasBlendIndices": bool(blend_indices is not None),
                                "skinned": bool(blend_weights is not None and blend_indices is not None and bone_ids),
                                "boneIds": bone_ids if bone_ids else [],
                                "fragmentBoneTag": int(wheel_tag) if wheel_tag is not None else None,
                                "material": mat,
                            }
                        )
                        si += 1

                if sub_entries:
                    entry["lods"][lod_key] = {"submeshes": sub_entries}

            meshes[hs] = entry
            touched_hashes.add(hs)
            exported_now += 1
        except Exception:
            errors += 1
            error_details.append(f"ERROR exporting model {hs}:\n{traceback.format_exc()}")

    for h in vehicles:
        export_one(h)
    for h in peds:
        export_one(h)

    # Save manifest
    if args.shard_only:
        from export_drawables_from_list import _update_manifest_shards_for_hashes  # type: ignore

        _update_manifest_shards_for_hashes(models_dir, manifest, sorted(touched_hashes))
    else:
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        if touched_hashes:
            from export_drawables_from_list import _update_manifest_shards_for_hashes  # type: ignore

            _update_manifest_shards_for_hashes(models_dir, manifest, sorted(touched_hashes))
    print(
        f"Done. exported_now={exported_now} skipped_existing={skipped_existing} no_drawable={no_drawable} errors={errors} -> {manifest_path}"
    )
    for detail in error_details:
        print(detail)


if __name__ == "__main__":
    main()



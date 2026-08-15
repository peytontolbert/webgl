#!/usr/bin/env python3
"""
Export the current runtime ped's skinned component drawables.

This is the bridge between FiveM appearance data and browser-native ped rendering:
- reads webgl_viewer/assets/runtime_character.json
- loads the ped model YDD through CodeWalker
- exports the selected component drawable meshes as MSH0 v8 with blend weights/indices
- writes per-submesh bone palettes into the models manifest
- writes the shared skeleton contract to webgl_viewer/assets/peds/<modelHash>_skeleton.json

It does not attempt to emulate GTA's animation graph. It preserves the data needed
for a browser skinned-ped renderer to use real component skinning instead of static
component placement.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path
from typing import Any

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent / ".env")
except Exception:
    pass

from gta5_modules.dll_manager import DllManager
from gta5_modules.hash_utils import joaat as _joaat
from gta5_modules.hash_utils import try_coerce_u32 as _try_coerce_u32
from gta5_modules.manifest_utils import load_or_init_models_manifest as _load_or_init_models_manifest
from gta5_modules.script_paths import auto_assets_dir


def _as_float_list(v: Any, fields: tuple[str, ...]) -> list[float]:
    out: list[float] = []
    for f in fields:
        try:
            out.append(float(getattr(v, f)))
        except Exception:
            out.append(0.0)
    return out


def _vec4_to_list(v: Any) -> list[float]:
    return _as_float_list(v, ("X", "Y", "Z", "W"))


def _matrix_to_list(m: Any) -> list[float]:
    vals: list[float] = []
    for name in (
        "M11", "M12", "M13", "M14",
        "M21", "M22", "M23", "M24",
        "M31", "M32", "M33", "M34",
        "M41", "M42", "M43", "M44",
    ):
        try:
            vals.append(float(getattr(m, name)))
        except Exception:
            vals.append(0.0)
    return vals


def _matrix3_to_rows(m: Any) -> list[float] | None:
    if m is None:
        return None
    rows: list[float] = []
    for row_name in ("Row1", "Row2", "Row3"):
        try:
            rv = getattr(m, row_name)
        except Exception:
            return None
        rows.extend(_vec4_to_list(rv))
    return rows if len(rows) == 12 else None


def _wait_loaded(gfc: Any, obj: Any, spins: int) -> Any:
    for _ in range(max(0, int(spins or 0))):
        try:
            if obj is None or bool(getattr(obj, "Loaded", True)):
                break
        except Exception:
            break
        try:
            gfc.ContentThreadProc()
        except Exception:
            break
    return obj


def _as_u32(value: Any) -> int | None:
    v = _try_coerce_u32(value, allow_hex=True)
    if v is not None:
        return int(v) & 0xFFFFFFFF
    try:
        hv = getattr(value, "Hash", None)
        if hv is not None:
            return int(hv) & 0xFFFFFFFF
    except Exception:
        pass
    try:
        return int(value) & 0xFFFFFFFF
    except Exception:
        return None


def _iter_dict_keys(d: Any) -> list[Any]:
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


def _load_ydd(gfc: Any, ped_hash: int, spins: int) -> Any:
    try:
        ydd = gfc.GetYdd(int(ped_hash) & 0xFFFFFFFF)
    except Exception:
        ydd = None
    ydd = _wait_loaded(gfc, ydd, spins)
    if ydd is None or not getattr(ydd, "Loaded", True):
        return None
    return ydd


def _load_yft_skeleton(gfc: Any, ped_hash: int, spins: int) -> Any:
    try:
        yft = gfc.GetYft(int(ped_hash) & 0xFFFFFFFF)
    except Exception:
        yft = None
    yft = _wait_loaded(gfc, yft, spins)
    if yft is None or not getattr(yft, "Loaded", True):
        return None
    try:
        fragment = getattr(yft, "Fragment", None)
        drawable = getattr(fragment, "Drawable", None) if fragment is not None else None
        skeleton = getattr(drawable, "Skeleton", None) if drawable is not None else None
    except Exception:
        skeleton = None
    if skeleton is None:
        return None
    try:
        skeleton = skeleton.Clone()
    except Exception:
        pass
    try:
        skeleton.ResetBoneTransforms()
    except Exception:
        try:
            skeleton.UpdateBoneTransforms()
        except Exception:
            pass
    return skeleton


def _ped_component_file_entries(gfc: Any, ped_hash: int, collection_name: str) -> dict[int, Any]:
    """
    Freemode components are stored as per-ped files, not as one global model
    dictionary. CodeWalker preserves the active DLC overlay order in these maps,
    which avoids collisions between male/female and pack variants.
    """
    out: dict[int, Any] = {}
    try:
        coll = getattr(gfc, collection_name, None)
    except Exception:
        coll = None
    if coll is None:
        return out

    ped_u32 = int(ped_hash) & 0xFFFFFFFF
    entry_dict = None
    for k in _iter_dict_keys(coll):
        ku = _as_u32(k)
        if ku == ped_u32:
            try:
                entry_dict = coll[k]
            except Exception:
                entry_dict = None
            break
    if entry_dict is None:
        return out

    for k in _iter_dict_keys(entry_dict):
        ku = _as_u32(k)
        if ku is None:
            continue
        try:
            entry = entry_dict[k]
        except Exception:
            entry = None
        if entry is not None:
            out[int(ku) & 0xFFFFFFFF] = entry
    return out


def _ped_component_ydd_entries(gfc: Any, ped_hash: int) -> dict[int, Any]:
    return _ped_component_file_entries(gfc, ped_hash, "PedDrawableDicts")


def _ped_component_ytd_entries(gfc: Any, ped_hash: int) -> dict[int, Any]:
    return _ped_component_file_entries(gfc, ped_hash, "PedTextureDicts")


def _ped_variation_selection(gfc: Any, ped_hash: int, component: dict[str, Any]) -> dict[str, Any] | None:
    """Resolve FiveM component indices through the exact CodeWalker PedFile table."""
    try:
        variations = getattr(gfc, "PedVariationsDict", None)
    except Exception:
        variations = None
    if variations is None:
        return None

    ped_file = None
    target = int(ped_hash) & 0xFFFFFFFF
    for key in _iter_dict_keys(variations):
        if _as_u32(key) != target:
            continue
        try:
            ped_file = variations[key]
        except Exception:
            ped_file = None
        break
    if ped_file is None:
        return None

    try:
        component_id = int(component.get("componentId"))
        drawable_id = int(component.get("drawable"))
        palette_id = int(component.get("palette") or 0)
        texture_id = int(component.get("texture") or 0)
        variation_info = getattr(ped_file, "VariationInfo", None)
        component_data = variation_info.GetComponentData(component_id) if variation_info is not None else None
        drawable_data = getattr(component_data, "DrawblData3", None)
        if drawable_data is None or drawable_id < 0:
            return None
        item = drawable_data[drawable_id]
        if item is None:
            return None
        drawable_name = str(item.GetDrawableName(palette_id) or "").strip()
        texture_name = str(item.GetTextureName(texture_id) or "").strip()
        if not drawable_name:
            return None
        return {
            "componentId": component_id,
            "drawable": drawable_id,
            "palette": palette_id,
            "texture": texture_id,
            "drawableName": drawable_name,
            "textureName": texture_name or None,
        }
    except Exception:
        return None


def _load_ydd_from_entry(gfc: Any, ydd_cls: Any, entry: Any, drawable_hash: int, spins: int) -> Any:
    ydd = None
    if entry is not None:
        try:
            rpfman = getattr(gfc, "RpfMan", None)
        except Exception:
            rpfman = None
        if rpfman is not None and ydd_cls is not None:
            try:
                ydd = rpfman.GetFile[ydd_cls](entry)
            except Exception:
                ydd = None
    if ydd is None:
        ydd = _load_ydd(gfc, int(drawable_hash) & 0xFFFFFFFF, spins)
    else:
        ydd = _wait_loaded(gfc, ydd, spins)
    if ydd is None or not getattr(ydd, "Loaded", True):
        return None
    return ydd


def _load_ytd_from_entry(gfc: Any, ytd_cls: Any, entry: Any, spins: int) -> Any:
    if entry is None or ytd_cls is None:
        return None
    try:
        # Match CodeWalker.World.Ped.SetComponentDrawable: ped component YTDs
        # are loaded through GameFileCache, not RpfManager's generic file path.
        ytd = gfc.GetFileUncached[ytd_cls](entry)
        if ytd is not None and not getattr(ytd, "Loaded", True):
            try:
                gfc.TryLoadEnqueue(ytd)
            except Exception:
                pass
    except Exception:
        ytd = None
    ytd = _wait_loaded(gfc, ytd, spins)
    if ytd is None or not getattr(ytd, "Loaded", True):
        return None
    return ytd


def _dict_get_drawable(ydd: Any, drawable_hash: int) -> Any:
    h = int(drawable_hash) & 0xFFFFFFFF
    dct = getattr(ydd, "Dict", None)
    if dct is not None:
        try:
            return dct[h]
        except Exception:
            pass
        try:
            if dct.ContainsKey(h):
                return dct[h]
        except Exception:
            pass
    try:
        hashes = list(getattr(getattr(ydd, "DrawableDict", None), "Hashes", []) or [])
        drawables = list(getattr(getattr(getattr(ydd, "DrawableDict", None), "Drawables", None), "data_items", []) or [])
        for i, hv in enumerate(hashes):
            if (int(hv) & 0xFFFFFFFF) == h and i < len(drawables):
                return drawables[i]
    except Exception:
        pass
    try:
        drawables = list(getattr(ydd, "Drawables", []) or [])
        if len(drawables) == 1:
            return drawables[0]
    except Exception:
        pass
    return None


def _shader_texture_name_cache(drawable: Any) -> dict[str, tuple[None, None]]:
    """
    Seed the shared material exporter with texture names referenced by a ped YDD.

    Ped component YDDs do not have an archetype TextureDict, so the normal world
    exporter cannot pre-populate this mapping. The material helper can then resolve
    each shader object through its embedded/shared GTA texture dictionary.
    """
    from export_drawables_for_chunk import _extract_drawable_lod_submeshes, _shader_param_iter  # type: ignore

    names: dict[str, tuple[None, None]] = {}
    for lod in ("High", "Med", "Low", "VLow"):
        for sub in _extract_drawable_lod_submeshes(drawable, lod):
            shader = sub.get("shader")
            for _hash, param in _shader_param_iter(shader) or []:
                try:
                    if int(getattr(param, "DataType", 255)) != 0:
                        continue
                    texture = getattr(param, "Data", None)
                    name = str(getattr(texture, "Name", "") or "").strip()
                    if name:
                        names.setdefault(name, (None, None))
                except Exception:
                    continue
    return names


def _refresh_model_texture_index(assets_dir: Path) -> None:
    """Keep the runtime texture resolver aware of files emitted by this exporter."""
    try:
        import importlib.util

        setup_path = assets_dir.parent / "setup_assets.py"
        spec = importlib.util.spec_from_file_location("runtime_ped_setup_assets", setup_path)
        if spec is None or spec.loader is None:
            return
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        refresh = getattr(module, "_ensure_models_textures_index", None)
        if callable(refresh):
            refresh(assets_dir)
    except Exception:
        pass


def _export_selected_component_diffuse(
    *,
    dll_manager: DllManager,
    ytd: Any,
    expected_name: str,
    tex_dir: Path,
) -> str | None:
    """
    Export the exact texture selected by PedFile variation data.

    Several freemode YTDs reuse names such as `feet_diff_000`; a global lookup can
    therefore return a texture from a different clothing pack. Ped.SetComponentDrawable
    selects the first texture of the matched per-ped YTD, so mirror that behavior here.
    """
    try:
        texture_dict = getattr(ytd, "TextureDict", None)
        textures = getattr(texture_dict, "Textures", None) if texture_dict is not None else None
        items = list(getattr(textures, "data_items", []) or [])
        texture = items[0] if items else None
    except Exception:
        texture = None
    if texture is None:
        return None

    actual_name = str(getattr(texture, "Name", "") or expected_name or "").strip()
    if not actual_name:
        return None
    try:
        from export_drawables_for_chunk import _decode_texture_object_to_img_rgba  # type: ignore

        image, _format = _decode_texture_object_to_img_rgba(dll_manager, texture)
        if image is None:
            return None
        from PIL import Image

        texture_hash = int(_joaat(actual_name, lower=True)) & 0xFFFFFFFF
        tex_dir.mkdir(parents=True, exist_ok=True)
        Image.fromarray(image, mode="RGBA").save(tex_dir / f"{texture_hash}.png")
        return f"models_textures/{texture_hash}.png"
    except Exception:
        return None


def _set_component_diffuse(entry: dict[str, Any], diffuse_rel: str | None) -> None:
    if not diffuse_rel:
        return
    try:
        for lod in (entry.get("lods") or {}).values():
            for submesh in (lod.get("submeshes") or []):
                if not isinstance(submesh, dict):
                    continue
                material = submesh.setdefault("material", {})
                if isinstance(material, dict):
                    material["diffuse"] = diffuse_rel
    except Exception:
        pass


def _texture_rel_to_path(assets_dir: Path, rel: str | None) -> Path | None:
    s = str(rel or "").replace("\\", "/").lstrip("/")
    if not s:
        return None
    if s.startswith("assets/"):
        s = s[len("assets/"):]
    return assets_dir / s


def _sample_diffuse_base_color(path: Path | None) -> list[float] | None:
    if path is None or not path.exists():
        return None
    try:
        from PIL import Image

        img = Image.open(path).convert("RGBA")
        # Downsample first so this remains cheap for 512/1024 textures.
        img.thumbnail((64, 64))
        pixels = list(img.getdata())
    except Exception:
        return None

    total = [0.0, 0.0, 0.0]
    count = 0
    for r, g, b, a in pixels:
        if int(a) < 32:
            continue
        # Skip near-black mask/control texels; they are not useful albedo samples.
        if (int(r) + int(g) + int(b)) < 24:
            continue
        total[0] += float(r)
        total[1] += float(g)
        total[2] += float(b)
        count += 1
    if count <= 0:
        return None
    return [round(max(0.0, min(1.0, (v / count) / 255.0)), 4) for v in total]


def _mark_ped_skin_mask_material(entry: dict[str, Any], skin_color: list[float] | None) -> None:
    if not skin_color or len(skin_color) < 3:
        return
    try:
        for lod in (entry.get("lods") or {}).values():
            for submesh in (lod.get("submeshes") or []):
                if not isinstance(submesh, dict):
                    continue
                material = submesh.setdefault("material", {})
                if not isinstance(material, dict):
                    continue
                diffuse = material.get("diffuse")
                if diffuse:
                    material.setdefault("pedSkinMaskDiffuse", diffuse)
                material["pedSkinMask"] = True
                material["baseColor"] = skin_color[:3]
    except Exception:
        pass


def _export_skeleton_json(
    drawables: list[Any],
    out_path: Path,
    model_name: str,
    model_hash: int,
    skeleton: Any = None,
    source: str = "CodeWalker YDD DrawableBase.Skeleton",
) -> bool:
    if skeleton is None:
        for d in drawables:
            try:
                skeleton = getattr(d, "Skeleton", None)
            except Exception:
                skeleton = None
            if skeleton is not None:
                break
    if skeleton is None:
        return False

    try:
        skeleton.ResetBoneTransforms()
    except Exception:
        try:
            skeleton.UpdateBoneTransforms()
        except Exception:
            pass

    bones_raw = []
    try:
        bones_raw = list(getattr(getattr(skeleton, "Bones", None), "Items", []) or [])
    except Exception:
        bones_raw = []
    if not bones_raw:
        return False

    transforms_inv = []
    transforms = []
    try:
        transforms_inv = list(getattr(skeleton, "TransformationsInverted", []) or [])
    except Exception:
        transforms_inv = []
    try:
        transforms = list(getattr(skeleton, "Transformations", []) or [])
    except Exception:
        transforms = []
    try:
        skin_rows = [
            _matrix3_to_rows(m)
            for m in list(getattr(skeleton, "BoneTransforms", []) or [])
        ]
    except Exception:
        skin_rows = []

    bones = []
    for i, b in enumerate(bones_raw):
        try:
            index = int(getattr(b, "Index", i))
        except Exception:
            index = i
        try:
            tag = int(getattr(b, "Tag", 0)) & 0xFFFF
        except Exception:
            tag = 0
        try:
            parent_index = int(getattr(b, "ParentIndex", -1))
        except Exception:
            parent_index = -1
        bind_inv = None
        if i < len(transforms_inv):
            bind_inv = _matrix_to_list(transforms_inv[i])
        else:
            try:
                bind_inv = _matrix_to_list(getattr(b, "BindTransformInv"))
            except Exception:
                bind_inv = None
        rest = None
        if i < len(transforms):
            rest = _matrix_to_list(transforms[i])
        skin_transform = skin_rows[i] if i < len(skin_rows) else None
        bones.append(
            {
                "index": index,
                "name": str(getattr(b, "Name", "") or ""),
                "tag": tag,
                "parentIndex": parent_index,
                "translation": _as_float_list(getattr(b, "Translation", None), ("X", "Y", "Z")),
                "rotation": _as_float_list(getattr(b, "Rotation", None), ("X", "Y", "Z", "W")),
                "scale": _as_float_list(getattr(b, "Scale", None), ("X", "Y", "Z")),
                "bindTransformInv": bind_inv,
                "restTransform": rest,
                "skinTransform3x4": skin_transform,
            }
        )

    valid_skin_rows = [r for r in skin_rows if isinstance(r, list) and len(r) == 12]
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema": "webglgta-ped-skeleton-v1",
        "source": source,
        "modelName": model_name,
        "modelHash": int(model_hash) & 0xFFFFFFFF,
        "boneCount": len(bones),
        "skinTransformFormat": "row_major_float3x4",
        "skinTransforms3x4": skin_rows if len(valid_skin_rows) == len(bones) else [],
        "bones": bones,
    }
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return True


def _remap_freemode_component_bone_ids(
    bone_ids: Any,
    component_selection: dict[str, Any] | None,
) -> list[int]:
    """
    Freemode component YDDs can use compact component palettes even when the
    geometry BoneIds array is an identity sequence. The shared browser skeleton
    is the full ped YFT skeleton, so those compact slots must be expanded before
    writing the manifest palette consumed by WebGL.
    """
    try:
        ids = [int(x) & 0xFFFF for x in list(bone_ids or [])]
    except Exception:
        return []
    if not ids:
        return []

    try:
        component_id = int((component_selection or {}).get("componentId"))
    except Exception:
        component_id = -1
    drawable_name = str((component_selection or {}).get("drawableName") or "").strip().lower()

    remap: dict[int, int] = {}
    if component_id == 5 and drawable_name.startswith("hand_"):
        # hand_000_u uses an implicit compact freemode hand palette. The high LOD
        # source slots 27..41 / 51..65 form five three-bone finger chains; mapping
        # the range linearly into the full YFT skeleton incorrectly lands the last
        # chain on PH/IK helper bones, which creates long finger spikes once YCD
        # animation rows are applied.
        remap.update(
            {
                25: 42,  # lower LOD left hand base
                26: 42,
                27: 43,
                28: 44,
                29: 45,
                30: 48,
                31: 49,
                32: 50,
                33: 52,
                34: 53,
                35: 54,
                36: 55,
                37: 56,
                38: 57,
                39: 58,
                40: 59,
                41: 60,
                44: 42,
                49: 71,  # lower LOD right hand base
                50: 71,
                51: 72,
                52: 73,
                53: 74,
                54: 77,
                55: 78,
                56: 79,
                57: 81,
                58: 82,
                59: 83,
                60: 84,
                61: 85,
                62: 86,
                63: 87,
                64: 88,
                65: 89,
                68: 71,
            }
        )
    elif component_id == 6 and drawable_name.startswith("feet_"):
        # feet_000_u stores the right calf/foot/toe in compact palette slots
        # 11/12/13; the full freemode YFT skeleton stores them at 15/16/17.
        remap.update({11: 15, 12: 16, 13: 17})

    if not remap:
        return ids
    return [int(remap.get(i, i)) & 0xFFFF for i in ids]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-path", default=(os.getenv("gta_location") or os.getenv("gta5_path") or ""), help="GTA5 install folder")
    ap.add_argument("--assets-dir", default="", help="webgl_viewer/assets folder (auto if omitted)")
    ap.add_argument("--runtime-character", default="", help="runtime_character.json path (defaults under assets dir)")
    ap.add_argument("--selected-dlc", default="all", help="CodeWalker DLC level")
    ap.add_argument("--spins", type=int, default=1200, help="ContentThreadProc spins while loading YDD assets")
    ap.add_argument("--force", action="store_true", help="Overwrite existing component mesh bins")
    args = ap.parse_args()

    game_path = (args.game_path or "").strip('"').strip("'")
    if not game_path:
        raise SystemExit("Missing --game-path (or gta_location/gta5_path env var)")

    assets_dir = auto_assets_dir(args.assets_dir)
    runtime_path = Path(args.runtime_character) if args.runtime_character else (assets_dir / "runtime_character.json")
    if not runtime_path.exists():
        raise SystemExit(f"Missing runtime character profile: {runtime_path}")

    profile = json.loads(runtime_path.read_text(encoding="utf-8"))
    model_name = str(profile.get("modelName") or "").strip()
    model_hash = int(profile.get("modelHash") or (_joaat(model_name, lower=True) if model_name else 0)) & 0xFFFFFFFF
    names = [
        str(x or "").strip()
        for x in ((profile.get("render") or {}).get("modelNames") or [])
        if str(x or "").strip()
    ]
    if not model_name or not model_hash or not names:
        raise SystemExit("runtime_character.json does not include modelName/modelHash/render.modelNames")

    dm = DllManager(game_path)
    if not dm.initialized:
        raise SystemExit("Failed to initialize DllManager")
    if not dm.init_game_file_cache(load_vehicles=False, load_peds=True, load_audio=False, selected_dlc=str(args.selected_dlc or "").strip() or None):
        raise SystemExit("Failed to init GameFileCache with peds enabled")
    gfc = dm.get_game_file_cache()

    selected_components: dict[str, dict[str, Any]] = {}
    selected_component_variations: dict[str, list[dict[str, Any]]] = {}
    profile_components = profile.get("components") if isinstance(profile.get("components"), list) else []
    for component in profile_components:
        if not isinstance(component, dict):
            continue
        selection = _ped_variation_selection(gfc, model_hash, component)
        if selection is None:
            continue
        drawable_name = str(selection.get("drawableName") or "").strip()
        if not drawable_name:
            continue
        component["assetName"] = drawable_name
        component["drawableName"] = drawable_name
        component["textureName"] = selection.get("textureName")
        selected_components.setdefault(drawable_name, selection)
        selected_component_variations.setdefault(drawable_name, []).append(selection)

    if selected_components:
        names = list(selected_components.keys())
        profile.setdefault("render", {})["modelNames"] = names

    component_entries = _ped_component_ydd_entries(gfc, model_hash)
    component_texture_entries = _ped_component_ytd_entries(gfc, model_hash)
    if not component_entries:
        ydd = _load_ydd(gfc, model_hash, args.spins)
        if ydd is None:
            raise SystemExit(f"Could not resolve component YDD entries for ped {model_name} ({model_hash})")
    else:
        ydd = None

    from export_drawables_for_chunk import (  # type: ignore
        _compute_planar_uvs_xy01,
        _extract_drawable_lod_submeshes,
        _update_existing_manifest_materials_for_drawable,
        _write_mesh_bin,
    )
    from export_drawables_from_list import _update_manifest_shards_for_hashes  # type: ignore

    models_dir = assets_dir / "models"
    models_dir.mkdir(parents=True, exist_ok=True)
    manifest_path, manifest = _load_or_init_models_manifest(models_dir, min_version=4)
    meshes = manifest.setdefault("meshes", {})
    if not isinstance(meshes, dict):
        meshes = {}
        manifest["meshes"] = meshes

    resolved_drawables: list[Any] = []
    touched: set[str] = set()
    exported_components = 0
    exported_textures = 0
    missing_components: list[str] = []
    selected_diffuse_by_component_id: dict[int, str] = {}

    for name in names:
        h = int(_joaat(name, lower=True)) & 0xFFFFFFFF
        hs = str(h)
        component_entry = component_entries.get(h)
        component_ydd = _load_ydd_from_entry(gfc, getattr(dm, "YddFile", None), component_entry, h, args.spins)
        if component_ydd is None and ydd is not None:
            component_ydd = ydd
        if component_ydd is None:
            missing_components.append(name)
            continue
        drawable = _dict_get_drawable(component_ydd, h)
        if drawable is None:
            missing_components.append(name)
            continue
        resolved_drawables.append(drawable)

        entry = meshes.get(hs) if isinstance(meshes.get(hs), dict) else {"lods": {}, "lodDistances": {}, "material": {}}
        entry.setdefault("lods", {})
        entry.setdefault("lodDistances", {})
        entry.setdefault("material", {})
        entry["pedComponent"] = {
            "modelName": model_name,
            "modelHash": model_hash,
            "drawableName": name,
            "drawableHash": h,
            "skeleton": f"peds/{model_hash}_skeleton.json",
        }
        component_selection = selected_components.get(name)
        if component_selection:
            entry["pedComponent"].update(component_selection)

        for lod in ("High", "Med", "Low", "VLow"):
            lod_key = lod.lower()
            subs = _extract_drawable_lod_submeshes(drawable, lod)
            if not subs:
                continue
            old_subs = (((entry.get("lods") or {}).get(lod_key) or {}).get("submeshes") or [])
            sub_entries = []
            for si, sub in enumerate(subs):
                positions = sub["positions"]
                indices = sub["indices"]
                normals = sub["normals"]
                uv0 = sub.get("uv0")
                uv1 = sub.get("uv1")
                uv2 = sub.get("uv2")
                col0 = sub.get("color0")
                col1 = sub.get("color1")
                tangents = sub.get("tangents")
                blend_weights = sub.get("blendWeights")
                blend_indices = sub.get("blendIndices")
                bone_ids = _remap_freemode_component_bone_ids(sub.get("boneIds"), component_selection)

                uvs = uv0 if (uv0 is not None and getattr(uv0, "size", 0)) else _compute_planar_uvs_xy01(positions)
                uvs1 = uv1 if (uv1 is not None and getattr(uv1, "size", 0)) else uvs
                uvs2 = uv2 if (uv2 is not None and getattr(uv2, "size", 0)) else uvs

                out_name = f"{h}_{lod_key}_{si}.bin"
                out_bin = models_dir / out_name
                if args.force or not out_bin.exists():
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

                old_mat = {}
                try:
                    old_mat = old_subs[si].get("material") if si < len(old_subs) and isinstance(old_subs[si], dict) else {}
                except Exception:
                    old_mat = {}
                sub_entries.append(
                    {
                        "file": out_name,
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
                        "material": old_mat if isinstance(old_mat, dict) else {},
                    }
                )
            if sub_entries:
                entry["lods"][lod_key] = {"submeshes": sub_entries}

        meshes[hs] = entry
        # Component YDDs are not world archetypes, so they have no archetype
        # TextureDict to carry into the generic exporter. Use the component hash
        # as the local lookup start and let the helper fall through to the shader
        # texture object/shared YTDs as CodeWalker does.
        texture_names = _shader_texture_name_cache(drawable)
        if texture_names:
            exported_textures += int(
                _update_existing_manifest_materials_for_drawable(
                    entry=entry,
                    drawable=drawable,
                    textures=texture_names,
                    td_hash=h,
                    tex_dir=assets_dir / "models_textures",
                    dll_manager=dm,
                )
                or 0
            )
        selected_diffuse = None
        texture_variations = selected_component_variations.get(name) or ([component_selection] if component_selection else [])
        for texture_selection in texture_variations:
            texture_name = str((texture_selection or {}).get("textureName") or "").strip()
            if not texture_name:
                continue
            texture_hash = int(_joaat(texture_name, lower=True)) & 0xFFFFFFFF
            texture_entry = component_texture_entries.get(texture_hash)
            component_ytd = _load_ytd_from_entry(gfc, getattr(dm, "YtdFile", None), texture_entry, args.spins)
            diffuse = _export_selected_component_diffuse(
                dll_manager=dm,
                ytd=component_ytd,
                expected_name=texture_name,
                tex_dir=assets_dir / "models_textures",
            )
            if not diffuse:
                continue
            exported_textures += 1
            texture_id = int((texture_selection or {}).get("texture") or 0)
            if selected_diffuse is None:
                selected_diffuse = diffuse
                _set_component_diffuse(entry, diffuse)
                try:
                    cid = int((texture_selection or {}).get("componentId"))
                    selected_diffuse_by_component_id.setdefault(cid, diffuse)
                except Exception:
                    pass

            # The renderer caches materials by manifest hash. Texture-specific
            # aliases reuse the same mesh bins while carrying a different diffuse.
            if texture_id == int((component_selection or {}).get("texture") or 0):
                texture_asset_hash = h
                texture_entry_manifest = entry
            else:
                texture_asset_hash = int(_joaat(f"{model_name}:{name}:texture:{texture_id}", lower=True)) & 0xFFFFFFFF
                texture_entry_manifest = copy.deepcopy(entry)
                texture_entry_manifest["pedComponent"] = {
                    **texture_entry_manifest.get("pedComponent", {}),
                    **texture_selection,
                    "drawableName": name,
                    "drawableHash": h,
                    "sourceDrawableHash": h,
                    "assetHash": texture_asset_hash,
                }
                _set_component_diffuse(texture_entry_manifest, diffuse)
                meshes[str(texture_asset_hash)] = texture_entry_manifest
                touched.add(str(texture_asset_hash))
        touched.add(hs)
        exported_components += 1

    skin_color = None
    for cid in (3, 0, 11):
        skin_color = _sample_diffuse_base_color(_texture_rel_to_path(assets_dir, selected_diffuse_by_component_id.get(cid)))
        if skin_color:
            break
    if skin_color:
        for name, selection in selected_components.items():
            try:
                cid = int(selection.get("componentId"))
            except Exception:
                continue
            if cid != 5 or not str(name or "").lower().startswith("hand_"):
                continue
            h = int(_joaat(name, lower=True)) & 0xFFFFFFFF
            entry = meshes.get(str(h))
            if isinstance(entry, dict):
                _mark_ped_skin_mask_material(entry, skin_color)
                touched.add(str(h))

    ped_skeleton = _load_yft_skeleton(gfc, model_hash, args.spins)
    skeleton_source = (
        "CodeWalker YFT Fragment.Drawable.Skeleton"
        if ped_skeleton is not None
        else "CodeWalker YDD DrawableBase.Skeleton"
    )
    skeleton_path = assets_dir / "peds" / f"{model_hash}_skeleton.json"
    skeleton_ok = _export_skeleton_json(
        resolved_drawables,
        skeleton_path,
        model_name,
        model_hash,
        skeleton=ped_skeleton,
        source=skeleton_source,
    )

    render = profile.setdefault("render", {})
    render["meshComposition"] = "skinned_drawable_components" if skeleton_ok else "static_drawable_components"
    render["skinning"] = bool(skeleton_ok)
    render["skeleton"] = f"peds/{model_hash}_skeleton.json" if skeleton_ok else None
    render["exactness"] = (
        "component meshes include GTA blend weights/indices and the ped YFT skeleton; animation graph still pending"
        if skeleton_ok
        else "component meshes exported, but no skeleton was found on the selected drawables"
    )
    runtime_path.write_text(json.dumps(profile, indent=2), encoding="utf-8")

    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    if touched:
        _update_manifest_shards_for_hashes(models_dir, manifest, sorted(touched))

    if exported_textures:
        _refresh_model_texture_index(assets_dir)

    print(
        "Done. "
        f"model={model_name}({model_hash}) exportedComponents={exported_components}/{len(names)} "
        f"textures={exported_textures} skeleton={skeleton_ok} touched={len(touched)} missing={missing_components[:12]}"
    )


if __name__ == "__main__":
    main()

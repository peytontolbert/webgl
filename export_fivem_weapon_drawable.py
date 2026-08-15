#!/usr/bin/env python3
"""Export a standalone FiveM weapon YDR/YTD pair into the viewer mesh format."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from gta5_modules.dll_manager import DllManager
from gta5_modules.hash_utils import joaat
from export_drawables_for_chunk import (
    _decode_texture_object_to_img_rgba,
    _extract_drawable_lod_submeshes,
    _extract_shader_params,
    _extract_uv_scale_offset_from_shader,
    _material_flags_from_shader,
    _pick_diffuse_texture_name_from_shader_with_hash,
    _pick_texture_name_from_shader_with_hash,
    _SP_NORMAL_PREFERRED,
    _SP_SPEC_PREFERRED,
    _write_mesh_bin,
)


def _u32_name(value: str) -> int:
    return int(joaat(value, lower=True)) & 0xFFFFFFFF


def _load_raw_resource(dm: DllManager, cls: Any, path: Path) -> Any:
    resource = cls()
    resource.Load(path.read_bytes())
    if not getattr(resource, "Loaded", True):
        raise RuntimeError(f"CodeWalker did not load {path.name}")
    return resource


def _texture_items(ytd: Any) -> list[Any]:
    try:
        items = getattr(getattr(ytd, "TextureDict", None), "Textures", None)
        return [item for item in list(getattr(items, "data_items", []) or []) if item is not None]
    except Exception:
        return []


def _write_ytd_textures(dm: DllManager, ytd: Any, texture_dir: Path) -> dict[str, tuple[np.ndarray | None, str | None, str]]:
    from PIL import Image

    texture_dir.mkdir(parents=True, exist_ok=True)
    out: dict[str, tuple[np.ndarray | None, str | None, str]] = {}
    for texture in _texture_items(ytd):
        name = str(getattr(texture, "Name", "") or "").strip()
        if not name:
            continue
        image, fmt = _decode_texture_object_to_img_rgba(dm, texture)
        if image is None:
            continue
        texture_hash = _u32_name(name)
        target = texture_dir / f"{texture_hash}.png"
        Image.fromarray(image, mode="RGBA").save(target)
        out[name] = (image, fmt, f"models_textures/{texture_hash}.png")
    return out


def _material_for_shader(shader: Any, textures: dict[str, tuple[np.ndarray | None, str | None, str]]) -> dict[str, Any]:
    material: dict[str, Any] = {}
    material.update(_material_flags_from_shader(shader))
    shader_params = _extract_shader_params(shader, max_textures=32, max_vectors=64)
    if shader_params:
        material["shaderParams"] = shader_params

    for uv_index in range(3):
        uvso = _extract_uv_scale_offset_from_shader(shader, uv_index)
        if uvso and len(uvso) >= 4:
            material[f"uv{uv_index}ScaleOffset"] = [float(uvso[0]), float(uvso[1]), float(uvso[2]), float(uvso[3])]

    diffuse_name, diffuse_param = _pick_diffuse_texture_name_from_shader_with_hash(textures, shader)
    if diffuse_name and diffuse_name in textures:
        material["diffuse"] = textures[diffuse_name][2]
        material["diffuseName"] = diffuse_name
        if diffuse_param is not None:
            material["diffuseParamHash"] = int(diffuse_param) & 0xFFFFFFFF

    normal_name, normal_param = _pick_texture_name_from_shader_with_hash(
        textures, shader, _SP_NORMAL_PREFERRED, require_keywords=("normal", "bump", "_n", "nrm")
    )
    if normal_name and normal_name in textures:
        material["normal"] = textures[normal_name][2]
        material["normalName"] = normal_name
        if normal_param is not None:
            material["normalParamHash"] = int(normal_param) & 0xFFFFFFFF

    spec_name, spec_param = _pick_texture_name_from_shader_with_hash(
        textures, shader, _SP_SPEC_PREFERRED, require_keywords=("spec", "srm")
    )
    if spec_name and spec_name in textures:
        material["spec"] = textures[spec_name][2]
        material["specName"] = spec_name
        if spec_param is not None:
            material["specParamHash"] = int(spec_param) & 0xFFFFFFFF
    return material


def _bounds_for_submesh(positions: np.ndarray) -> dict[str, Any]:
    minimum = positions.min(axis=0)
    maximum = positions.max(axis=0)
    center = (minimum + maximum) * 0.5
    radius = float(np.max(np.linalg.norm(positions - center, axis=1)))
    return {
        "bounds": {
            "min": [float(v) for v in minimum],
            "max": [float(v) for v in maximum],
            "center": [float(v) for v in center],
        },
        "radius": radius,
    }


def export_weapon(*, game_path: Path, assets_dir: Path, ydr_path: Path, ytd_path: Path, asset_name: str) -> Path:
    dm = DllManager(str(game_path))
    if not dm.initialized:
        raise RuntimeError("CodeWalker initialization failed")

    ydr = _load_raw_resource(dm, dm.YdrFile, ydr_path)
    ytd = _load_raw_resource(dm, dm.YtdFile, ytd_path)
    drawable = getattr(ydr, "Drawable", None)
    if drawable is None:
        raise RuntimeError(f"No drawable found in {ydr_path.name}")

    model_hash = _u32_name(asset_name)
    model_dir = assets_dir / "models" / "weapons" / asset_name
    texture_dir = assets_dir / "models_textures"
    textures = _write_ytd_textures(dm, ytd, texture_dir)
    entry: dict[str, Any] = {
        "name": asset_name,
        "source": "FiveM standalone YDR/YTD",
        "lods": {},
        "lodDistances": {},
        "material": {},
    }

    for lod_name in ("high", "med", "low", "vlow"):
        submeshes = _extract_drawable_lod_submeshes(drawable, lod_name.capitalize())
        if not submeshes:
            continue
        output_submeshes: list[dict[str, Any]] = []
        for index, submesh in enumerate(submeshes):
            positions = submesh["positions"]
            indices = submesh["indices"]
            filename = f"weapons/{asset_name}/{model_hash}_{lod_name}_{index}.bin"
            _write_mesh_bin(
                model_dir / f"{model_hash}_{lod_name}_{index}.bin",
                positions,
                indices,
                submesh.get("normals"),
                submesh.get("uv0"),
                submesh.get("tangents"),
                submesh.get("color0"),
                submesh.get("uv1"),
                submesh.get("uv2"),
                submesh.get("color1"),
            )
            out = {"file": filename, "material": _material_for_shader(submesh.get("shader"), textures)}
            out.update(_bounds_for_submesh(positions))
            output_submeshes.append(out)
        entry["lods"][lod_name] = {"submeshes": output_submeshes}

    if not entry["lods"]:
        raise RuntimeError(f"No drawable geometry extracted from {ydr_path.name}")
    payload = {
        "schema": "webglgta-custom-weapon-v1",
        "weapon": {
            "id": "weapon_glock17",
            "modelName": asset_name,
            "hash": str(model_hash),
            "source": "FiveM WeaponPack stream/glock17",
        },
        "meshes": {str(model_hash): entry},
        "textureCount": len(textures),
    }
    output_path = assets_dir / "custom_weapons" / "glock17.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return output_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--game-path", required=True)
    parser.add_argument("--assets-dir", default=str(ROOT / "webgl_viewer" / "assets"))
    parser.add_argument("--ydr", required=True)
    parser.add_argument("--ytd", required=True)
    parser.add_argument("--asset-name", default="w_pi_glock17_luxe")
    args = parser.parse_args()
    output = export_weapon(
        game_path=Path(args.game_path),
        assets_dir=Path(args.assets_dir),
        ydr_path=Path(args.ydr),
        ytd_path=Path(args.ytd),
        asset_name=str(args.asset_name),
    )
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

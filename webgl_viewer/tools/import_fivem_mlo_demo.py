#!/usr/bin/env python3
"""Import selected loose FiveM MLOs into the fixed browser demo district.

The input metadata comes from ``CodeWalker.Cli export-mlo-metadata``.  Keeping
the metadata pass separate lets CodeWalker calculate GTA's MLO child transforms,
room bounds, portals, and entity-set ownership before this script exports the
referenced loose FiveM YDR/YTD assets for WebGL.
"""

from __future__ import annotations

import argparse
import copy
import json
import logging
import math
import struct
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from gta5_modules.dll_manager import DllManager
from gta5_modules.hash_utils import joaat
from gta5_modules.rpf_reader import RpfReader
from gta5_modules.codewalker_archetypes import get_archetype_best_effort
from gta5_modules.cw_loaders import try_get_drawable, try_get_ytd
from export_drawables_for_chunk import (
    _decode_texture_object_to_img_rgba,
    _extract_drawable_lod_submeshes,
    _extract_shader_params,
    _extract_uv_scale_offset_from_shader,
    _material_flags_from_shader,
    _pick_diffuse_texture_name_from_shader_with_hash,
    _pick_texture_name_from_shader_with_hash,
    _shader_param_iter,
    _SP_NORMAL_PREFERRED,
    _SP_SPEC_PREFERRED,
    _write_mesh_bin,
)


MLO_FLAG_INSTANCE = 1
MLO_FLAG_CHILD = 2
MLO_FLAG_ENTITY_SET = 4
MLO_FLAG_ENTITY_SET_DEFAULT = 8
MLO_ROOM_SHIFT = 8
MLO_PORTAL_SHIFT = 16
MLO_TAKEOVER_ORIGIN_XY_TOLERANCE = 0.35
MLO_TAKEOVER_ORIGIN_Z_TOLERANCE = 0.75
# Some map detail drawables use a different origin than the building shell.
# Match those by archetype and authored position so unrelated world instances
# of the same archetype remain intact.
MLO_TAKEOVER_INSTANCE_OVERRIDES = {
    # legion_int_weed supplies hei_dt1_rd1_strm_6.ymap. Its complete resource
    # YMAP replaces the GTA map cell, so no proximity-based removals belong here.
    2219659007: (),
    251203108: (
        (1770924169, -29.8342, -1054.5892, 33.5143),  # dt1_22_bldg2_detail
        (588287455, 18.3656, -1077.9160, 33.1381),  # Office Supply shell/decal group
        (1229793133, 10.4776, -1095.8137, 32.8424),  # Office Supply main shell
        (1294959359, 10.4776, -1095.8137, 32.8424),  # Office Supply wall overlay
        (514495009, 10.4776, -1095.8137, 32.8424),  # Office Supply facade material layer
        # This second Office Supply assembly is centered well behind the
        # storefront even though its bounds cover the weed-shop entrance.
        (654395831, -44.7890, -1101.2382, 30.8605),  # parent shell and awning
        (791833817, -43.5612, -1101.7195, 29.7697),  # fake storefront interior
        (3730562202, -39.9621, -1101.0970, 28.7147),  # storefront glazing/detail
        (2174057576, -44.7890, -1101.2382, 30.8605),  # emissive/signage layer
    ),
}
# Loose FiveM resources can replace a world drawable while intentionally
# reusing its base-game hash. These are mesh overrides, not takeover removals.
MLO_WORLD_DRAWABLE_OVERRIDES = {
    2219659007: frozenset({
        2721482282,  # dt1_14_build3
        45717283,  # dt1_14_details1
    }),
}
# The Legion weed-shop replacement keeps the large dt1_14_details1 drawable,
# but its first geometry still contains the closed vanilla lower facade across
# the authored MLO doors. Retain the remaining facade/detail geometry.
MLO_WORLD_DRAWABLE_SUBMESH_EXCLUSIONS = {
    45717283: {
        "high": frozenset({0}),
    },
}
# Florek's Legion Square shell contains a closed two-sided partition below the
# lintel between the retail floor and the rear room. FiveM removes that section
# in the playable layout; keep the lintel and floor, but open the passage.
LEGION_WEEDSHOP_OPENING_ARCHETYPE = 2037494739


def _remove_legion_weedshop_partition(
    archetype_hash: int,
    lod_key: str,
    submesh_index: int,
    positions: np.ndarray,
    indices: np.ndarray,
) -> tuple[np.ndarray, int]:
    if archetype_hash != LEGION_WEEDSHOP_OPENING_ARCHETYPE or lod_key != "high" or submesh_index not in (1, 7):
        return indices, 0
    triangles = np.asarray(indices).reshape(-1, 3)
    vertices = np.asarray(positions)[triangles]
    centers = vertices.mean(axis=1)
    edges_a = vertices[:, 1] - vertices[:, 0]
    edges_b = vertices[:, 2] - vertices[:, 0]
    normals = np.cross(edges_a, edges_b)
    lengths = np.linalg.norm(normals, axis=1)
    valid = lengths > 1e-8
    normals[valid] /= lengths[valid, None]
    plane_normal = np.asarray((0.337, 0.941, 0.0), dtype=np.float32)
    plane_distance = plane_normal @ np.asarray((-25.9839, 32.8231, 0.0), dtype=np.float32)
    remove = (
        valid
        & (np.abs(np.abs(normals[:, :2] @ plane_normal[:2]) - 1.0) < 0.01)
        & (np.abs(centers @ plane_normal - plane_distance) < 0.1)
        & (centers[:, 0] > -26.2) & (centers[:, 0] < -19.0)
        & (centers[:, 1] > 30.2) & (centers[:, 1] < 33.0)
        & (vertices[:, :, 2].min(axis=1) < -5.5)
        & (vertices[:, :, 2].max(axis=1) > -3.0)
        & (vertices[:, :, 2].max(axis=1) < -2.7)
    )
    removed = int(remove.sum())
    return triangles[~remove].reshape(-1).astype(np.asarray(indices).dtype, copy=False), removed
# The compact demo manifest replaces the full world manifest at boot. Keep
# gameplay-only drawables that are not world entities available in that subset.
RUNTIME_DEMO_MODEL_HASHES = frozenset({
    "1581098148",  # s_m_y_cop_01
})
# `prop_plant_florek` references a diffuse atlas that is absent from the loose
# resource. Its foliage cards become opaque placeholder planes without it, so
# omit the decorative plant until the resource ships the required YTD texture.
MLO_NONRENDERABLE_ARCHETYPE_HASHES = frozenset({
    "1993703776",  # prop_plant_florek.ydr
})


def _u32(value: Any, fallback: int = 0) -> int:
    try:
        return int(value) & 0xFFFFFFFF
    except (TypeError, ValueError):
        return fallback


def _finite(value: Any, fallback: float = 0.0) -> float:
    try:
        value = float(value)
    except (TypeError, ValueError):
        return fallback
    return value if math.isfinite(value) else fallback


def _vec(value: Any, count: int, fallback: tuple[float, ...]) -> list[float]:
    source = value if isinstance(value, (list, tuple)) else []
    return [_finite(source[index] if index < len(source) else fallback[index], fallback[index]) for index in range(count)]


def _parse_root_positions(values: list[str]) -> list[tuple[float, float]]:
    positions: list[tuple[float, float]] = []
    for raw in values:
        parts = [part.strip() for part in str(raw or "").split(",")]
        if len(parts) != 2:
            raise ValueError(f"Invalid --root-position '{raw}'; expected x,y")
        try:
            x, y = float(parts[0]), float(parts[1])
        except ValueError as error:
            raise ValueError(f"Invalid --root-position '{raw}'; expected numeric x,y") from error
        if not (math.isfinite(x) and math.isfinite(y)):
            raise ValueError(f"Invalid --root-position '{raw}'; expected finite x,y")
        positions.append((x, y))
    return positions


def _joaat_name(path: Path) -> int:
    return _u32(joaat(path.stem, lower=True))


def _load_raw_resource(cls: Any, path: Path) -> Any:
    resource = cls()
    resource.Load(path.read_bytes())
    if not getattr(resource, "Loaded", True):
        raise RuntimeError(f"CodeWalker did not load {path}")
    return resource


def _texture_items(container: Any) -> list[Any]:
    candidates = (
        getattr(container, "TextureDict", None),
        getattr(container, "TextureDictionary", None),
        container,
    )
    for candidate in candidates:
        try:
            textures = getattr(candidate, "Textures", None)
            values = list(getattr(textures, "data_items", None) or [])
            if values:
                return [item for item in values if item is not None]
        except Exception:
            continue
    return []


def _write_texture_set(
    dll: DllManager,
    container: Any,
    output_dir: Path,
    relative_dir: str,
) -> dict[str, tuple[np.ndarray | None, str | None, str]]:
    output_dir.mkdir(parents=True, exist_ok=True)
    result: dict[str, tuple[np.ndarray | None, str | None, str]] = {}
    for texture in _texture_items(container):
        name = str(getattr(texture, "Name", "") or "").strip()
        if not name:
            continue
        image, fmt = _decode_texture_object_to_img_rgba(dll, texture)
        if image is None:
            continue
        texture_hash = _u32(joaat(name, lower=True))
        filename = f"{texture_hash}.png"
        target = output_dir / filename
        if not target.exists():
            Image.fromarray(image, mode="RGBA").save(target)
        result[name] = (image, fmt, f"{relative_dir}/{filename}")
    return result


def _write_image_texture_set(
    textures: dict[str, tuple[np.ndarray | None, str | None]],
    output_dir: Path,
    relative_dir: str,
) -> dict[str, tuple[np.ndarray | None, str | None, str]]:
    """Persist decoded GameFileCache textures with the same lookup shape as loose YTDs."""
    output_dir.mkdir(parents=True, exist_ok=True)
    result: dict[str, tuple[np.ndarray | None, str | None, str]] = {}
    for name, value in textures.items():
        image = value[0] if isinstance(value, tuple) and value else None
        fmt = value[1] if isinstance(value, tuple) and len(value) > 1 else None
        if image is None:
            continue
        texture_name = str(name or "").strip()
        if not texture_name:
            continue
        values = np.asarray(image, dtype=np.uint8)
        if values.ndim != 3 or values.shape[2] not in (3, 4):
            continue
        if values.shape[2] == 3:
            alpha = np.full((values.shape[0], values.shape[1], 1), 255, dtype=np.uint8)
            values = np.concatenate((values, alpha), axis=2)
        texture_hash = _u32(joaat(texture_name, lower=True))
        filename = f"{texture_hash}.png"
        target = output_dir / filename
        if not target.exists():
            Image.fromarray(values, mode="RGBA").save(target)
        result[texture_name] = (values, str(fmt) if fmt is not None else None, f"{relative_dir}/{filename}")
    return result


def _merge_texture_maps(*maps: dict[str, tuple[np.ndarray | None, str | None, str]]) -> dict[str, tuple[np.ndarray | None, str | None, str]]:
    merged: dict[str, tuple[np.ndarray | None, str | None, str]] = {}
    for texture_map in maps:
        merged.update(texture_map)
    return merged


def _material_for_shader(shader: Any, textures: dict[str, tuple[np.ndarray | None, str | None, str]]) -> dict[str, Any]:
    material: dict[str, Any] = {}
    material.update(_material_flags_from_shader(shader))
    shader_params = _extract_shader_params(shader, max_textures=32, max_vectors=64)
    if shader_params:
        textures_by_hash = shader_params.get("texturesByHash") or {}
        for parameter_hash, parameter in _shader_param_iter(shader) or []:
            try:
                if int(getattr(parameter, "DataType", 255)) != 0:
                    continue
                texture = getattr(parameter, "Data", None)
                name = str(getattr(texture, "Name", "") or "").strip()
            except Exception:
                continue
            resolved = textures.get(name)
            key = str(_u32(parameter_hash))
            if resolved and key in textures_by_hash:
                textures_by_hash[key] = resolved[2]
        material["shaderParams"] = shader_params

    for uv_index in range(3):
        scale_offset = _extract_uv_scale_offset_from_shader(shader, uv_index)
        if scale_offset and len(scale_offset) >= 4:
            material[f"uv{uv_index}ScaleOffset"] = [_finite(value) for value in scale_offset[:4]]

    # Export helpers select from decoded ``(image, format)`` pairs. The MLO map
    # retains an additional browser path, so provide a compact selection view.
    texture_selection = {name: (value[0], value[1]) for name, value in textures.items()}
    diffuse_name, diffuse_param = _pick_diffuse_texture_name_from_shader_with_hash(texture_selection, shader)
    if diffuse_name and diffuse_name in textures:
        material["diffuse"] = textures[diffuse_name][2]
        material["diffuseName"] = diffuse_name
        if diffuse_param is not None:
            material["diffuseParamHash"] = _u32(diffuse_param)

    normal_name, normal_param = _pick_texture_name_from_shader_with_hash(
        texture_selection, shader, _SP_NORMAL_PREFERRED, require_keywords=("normal", "bump", "_n", "nrm")
    )
    if normal_name and normal_name in textures:
        material["normal"] = textures[normal_name][2]
        material["normalName"] = normal_name
        if normal_param is not None:
            material["normalParamHash"] = _u32(normal_param)

    spec_name, spec_param = _pick_texture_name_from_shader_with_hash(
        texture_selection, shader, _SP_SPEC_PREFERRED, require_keywords=("spec", "srm")
    )
    if spec_name and spec_name in textures:
        material["spec"] = textures[spec_name][2]
        material["specName"] = spec_name
        if spec_param is not None:
            material["specParamHash"] = _u32(spec_param)
    return material


def _bounds_for_submesh(positions: np.ndarray) -> dict[str, Any]:
    values = np.asarray(positions, dtype=np.float32)
    minimum = values.min(axis=0)
    maximum = values.max(axis=0)
    center = (minimum + maximum) * 0.5
    radius = float(np.max(np.linalg.norm(values - center, axis=1)))
    return {
        "bounds": {
            "min": [float(value) for value in minimum],
            "max": [float(value) for value in maximum],
            "center": [float(value) for value in center],
        },
        "radius": radius,
    }


def _merge_bounds(parts: list[dict[str, Any]]) -> dict[str, Any]:
    values = [part.get("bounds") or {} for part in parts if isinstance(part, dict)]
    if not values:
        return {"bounds": {"min": [0.0, 0.0, 0.0], "max": [0.0, 0.0, 0.0], "center": [0.0, 0.0, 0.0]}, "radius": 0.0}
    minimum = np.min(np.asarray([item.get("min", [0.0, 0.0, 0.0]) for item in values], dtype=np.float32), axis=0)
    maximum = np.max(np.asarray([item.get("max", [0.0, 0.0, 0.0]) for item in values], dtype=np.float32), axis=0)
    center = (minimum + maximum) * 0.5
    radius = max(float(item.get("radius", 0.0) or 0.0) for item in parts)
    radius = max(radius, float(np.linalg.norm(maximum - center)))
    return {
        "bounds": {
            "min": [float(value) for value in minimum],
            "max": [float(value) for value in maximum],
            "center": [float(value) for value in center],
        },
        "radius": radius,
    }


def _merge_compatible_submeshes(
    submeshes: list[dict[str, Any]],
    textures: dict[str, tuple[np.ndarray | None, str | None, str]],
) -> list[dict[str, Any]]:
    """Collapse authored geometry splits that resolve to the same runtime draw."""
    streams = ("normals", "uv0", "tangents", "color0", "uv1", "uv2", "color1")
    groups: dict[tuple[str, tuple[bool, ...]], list[dict[str, Any]]] = {}
    order: list[tuple[str, tuple[bool, ...]]] = []
    for submesh in submeshes:
        material = submesh.get("_material") or _material_for_shader(submesh.get("shader"), textures)
        key = (
            json.dumps(material, sort_keys=True, separators=(",", ":")),
            tuple(submesh.get(stream) is not None for stream in streams),
        )
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(submesh)

    merged: list[dict[str, Any]] = []
    for key in order:
        values = groups[key]
        if len(values) == 1:
            merged.append(values[0])
            continue
        vertex_offset = 0
        indices: list[np.ndarray] = []
        for value in values:
            source_indices = np.asarray(value["indices"], dtype=np.uint32).reshape(-1)
            indices.append(source_indices + vertex_offset)
            vertex_offset += len(value["positions"])
        output: dict[str, Any] = {
            "shader": values[0].get("shader"),
            "_material": values[0].get("_material"),
            "positions": np.concatenate([np.asarray(value["positions"]) for value in values], axis=0),
            "indices": np.concatenate(indices, axis=0),
        }
        for stream in streams:
            output[stream] = np.concatenate(
                [np.asarray(value[stream]) for value in values], axis=0,
            ) if values[0].get(stream) is not None else None
        merged.append(output)
    return merged


def _atlas_compatible_diffuse_submeshes(
    submeshes: list[dict[str, Any]],
    textures: dict[str, tuple[np.ndarray | None, str | None, str]],
    assets_dir: Path,
    archetype_hash: int,
    lod_key: str,
) -> int:
    """Atlas safe one-texture materials before merging redundant GTA splits."""
    by_path = {value[2]: value[0] for value in textures.values() if value[0] is not None and len(value) >= 3}
    groups: dict[str, list[tuple[dict[str, Any], dict[str, Any], np.ndarray]]] = {}
    for submesh in submeshes:
        uv0 = submesh.get("uv0")
        if uv0 is None:
            continue
        material = _material_for_shader(submesh.get("shader"), textures)
        diffuse = str(material.get("diffuse") or "")
        image = by_path.get(diffuse)
        if image is None or material.get("normal") or material.get("spec"):
            continue
        uv = np.asarray(uv0, dtype=np.float32)
        if uv.size == 0 or not np.isfinite(uv).all():
            continue
        normalized_uv = uv.copy()
        for axis in (0, 1):
            normalized_uv[:, axis] -= math.floor(float(normalized_uv[:, axis].min()))
        if float(normalized_uv.min()) < -0.001 or float(normalized_uv.max()) > 1.001:
            continue
        submesh["_atlas_uv0"] = normalized_uv
        base = {key: value for key, value in material.items() if key not in {
            "diffuse", "diffuseName", "diffuseParamHash", "shaderParams",
        }}
        signature = json.dumps(base, sort_keys=True, separators=(",", ":"))
        groups.setdefault(signature, []).append((submesh, material, np.asarray(image, dtype=np.uint8)))

    atlas_count = 0
    output_dir = assets_dir / "mlo_textures" / "atlases" / str(archetype_hash)
    for signature, candidates in groups.items():
        unique: dict[str, np.ndarray] = {}
        for _, material, image in candidates:
            unique.setdefault(str(material["diffuse"]), image)
        if len(unique) < 4:
            continue
        max_width = max(image.shape[1] for image in unique.values())
        max_height = max(image.shape[0] for image in unique.values())
        padding = 2
        cell_width = max_width + padding * 2
        cell_height = max_height + padding * 2
        columns = max(1, 4096 // cell_width)
        rows = max(1, 4096 // cell_height)
        capacity = columns * rows
        paths = list(unique)
        for page_start in range(0, len(paths), capacity):
            page_paths = paths[page_start:page_start + capacity]
            used_columns = min(columns, len(page_paths))
            used_rows = (len(page_paths) + columns - 1) // columns
            atlas_width = used_columns * cell_width
            atlas_height = used_rows * cell_height
            atlas = np.zeros((atlas_height, atlas_width, 4), dtype=np.uint8)
            placements: dict[str, tuple[int, int, int, int]] = {}
            for page_index, path in enumerate(page_paths):
                image = unique[path]
                height, width = image.shape[:2]
                column = page_index % columns
                row = page_index // columns
                x = column * cell_width + padding
                y = row * cell_height + padding
                atlas[y:y + height, x:x + width] = image
                atlas[y:y + height, x - padding:x] = image[:, :1]
                atlas[y:y + height, x + width:x + width + padding] = image[:, -1:]
                atlas[y - padding:y, x - padding:x + width + padding] = atlas[y:y + 1, x - padding:x + width + padding]
                atlas[y + height:y + height + padding, x - padding:x + width + padding] = atlas[y + height - 1:y + height, x - padding:x + width + padding]
                placements[path] = (x, y, width, height)
            output_dir.mkdir(parents=True, exist_ok=True)
            atlas_path = output_dir / f"{lod_key}_{atlas_count}.png"
            Image.fromarray(atlas, mode="RGBA").save(atlas_path)
            relative = f"mlo_textures/atlases/{archetype_hash}/{atlas_path.name}"
            base_material = json.loads(signature)
            base_material.update({"diffuse": relative, "diffuseName": atlas_path.stem})
            for submesh, material, _ in candidates:
                placement = placements.get(str(material.get("diffuse") or ""))
                if placement is None:
                    continue
                x, y, width, height = placement
                uv = np.asarray(submesh.pop("_atlas_uv0"), dtype=np.float32)
                uv[:, 0] = (x + uv[:, 0] * width) / atlas_width
                uv[:, 1] = (y + uv[:, 1] * height) / atlas_height
                submesh["uv0"] = uv
                submesh["_material"] = base_material
            atlas_count += 1
    return atlas_count


def _export_archetype_drawable(
    dll: DllManager,
    ydr_path: Path,
    archetype_hash: int,
    texture_map: dict[str, tuple[np.ndarray | None, str | None, str]],
    assets_dir: Path,
) -> dict[str, Any] | None:
    ydr = _load_raw_resource(dll.YdrFile, ydr_path)
    drawable = getattr(ydr, "Drawable", None)
    return _export_drawable(dll, drawable, archetype_hash, texture_map, assets_dir, f"FiveM MLO loose YDR: {ydr_path.name}")


def _export_drawable(
    dll: DllManager,
    drawable: Any,
    archetype_hash: int,
    texture_map: dict[str, tuple[np.ndarray | None, str | None, str]],
    assets_dir: Path,
    source: str,
) -> dict[str, Any] | None:
    if drawable is None:
        return None

    embedded_dir = assets_dir / "mlo_textures" / "embedded" / str(archetype_hash)
    embedded = _write_texture_set(dll, drawable, embedded_dir, f"mlo_textures/embedded/{archetype_hash}")
    textures = _merge_texture_maps(texture_map, embedded)
    lods: dict[str, Any] = {}
    all_submeshes: list[dict[str, Any]] = []
    model_dir = assets_dir / "models" / "mlo" / str(archetype_hash)
    for lod in ("High", "Med", "Low", "Vlow"):
        source_submeshes = _extract_drawable_lod_submeshes(drawable, lod)
        if not source_submeshes:
            continue
        lod_key = lod.lower()
        # Keep index-sensitive surgical fixes in their authored order. Other
        # MLO drawables frequently contain hundreds of redundant geometry
        # splits that normalize to an identical browser material.
        if archetype_hash != LEGION_WEEDSHOP_OPENING_ARCHETYPE:
            _atlas_compatible_diffuse_submeshes(
                source_submeshes, textures, assets_dir, archetype_hash, lod_key,
            )
            source_submeshes = _merge_compatible_submeshes(source_submeshes, textures)
        output_submeshes: list[dict[str, Any]] = []
        for index, submesh in enumerate(source_submeshes):
            positions = submesh.get("positions")
            indices = submesh.get("indices")
            if positions is None or indices is None or len(positions) == 0 or len(indices) == 0:
                continue
            indices, _removed_triangles = _remove_legion_weedshop_partition(
                archetype_hash, lod_key, index, positions, indices,
            )
            opening_suffix = (
                "_open_v1"
                if archetype_hash == LEGION_WEEDSHOP_OPENING_ARCHETYPE and lod_key == "high" and index in (1, 7)
                else ""
            )
            filename = f"mlo/{archetype_hash}/{archetype_hash}_{lod_key}_{index}{opening_suffix}.bin"
            _write_mesh_bin(
                model_dir / Path(filename).name,
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
            output = {
                "file": filename,
                "vertexCount": int(len(positions)),
                "indexCount": int(len(indices)),
                "hasNormals": submesh.get("normals") is not None,
                "hasUvs": submesh.get("uv0") is not None,
                "hasTangents": submesh.get("tangents") is not None,
                "hasColor0": submesh.get("color0") is not None,
                "material": submesh.get("_material") or _material_for_shader(submesh.get("shader"), textures),
            }
            output.update(_bounds_for_submesh(positions))
            output_submeshes.append(output)
            all_submeshes.append(output)
        if output_submeshes:
            lod_info = {"submeshes": output_submeshes}
            lod_info.update(_merge_bounds(output_submeshes))
            lods[lod_key] = lod_info
    if not lods:
        return None

    entry: dict[str, Any] = {
        "source": source,
        "lods": lods,
        "lodDistances": {"High": 100.0, "Med": 250.0, "Low": 520.0, "VLow": 1000.0},
        "material": {},
    }
    entry.update(_merge_bounds(all_submeshes))
    return entry


def _texture_dictionary_hash(archetype: Any) -> int:
    try:
        texture_dict = getattr(archetype, "TextureDict", None)
        if texture_dict is None:
            return 0
        return _u32(getattr(texture_dict, "Hash", texture_dict))
    except Exception:
        return 0


def _export_game_archetype_drawable(
    dll: DllManager,
    game_cache: Any,
    rpf_reader: RpfReader,
    archetype_hash: int,
    assets_dir: Path,
    texture_cache: dict[int, dict[str, tuple[np.ndarray | None, str | None, str]]],
) -> tuple[dict[str, Any] | None, str]:
    """Export a GTA base-game/DLC drawable not supplied as a loose FiveM YDR."""
    archetype = get_archetype_best_effort(game_cache, archetype_hash, dll_manager=dll)
    if archetype is None:
        return None, "GTA GameFileCache has no archetype"
    drawable = try_get_drawable(game_cache, archetype, spins=800)
    if drawable is None:
        return None, "GTA archetype has no drawable"

    dictionary_hash = _texture_dictionary_hash(archetype)
    textures = texture_cache.get(dictionary_hash)
    if textures is None:
        textures = {}
        if dictionary_hash:
            ytd = try_get_ytd(game_cache, dictionary_hash, spins=800)
            if ytd is not None:
                decoded = rpf_reader.get_ytd_textures(ytd)
                textures = _write_image_texture_set(
                    decoded,
                    assets_dir / "mlo_textures" / "gta_dictionaries" / str(dictionary_hash),
                    f"mlo_textures/gta_dictionaries/{dictionary_hash}",
                )
        texture_cache[dictionary_hash] = textures

    entry = _export_drawable(
        dll,
        drawable,
        archetype_hash,
        textures,
        assets_dir,
        f"GTA GameFileCache archetype: {archetype_hash}",
    )
    return entry, "" if entry is not None else "GTA drawable has no usable mesh"


def _load_global_manifest_entries(assets_dir: Path, hashes: set[str]) -> dict[str, Any]:
    index_path = assets_dir / "models" / "manifest_index.json"
    if not index_path.is_file() or not hashes:
        return {}
    index = json.loads(index_path.read_text(encoding="utf-8"))
    if index.get("schema") != "webglgta-manifest-index-v1":
        return {}
    bits = int(index.get("shard_bits", 8))
    mask = (1 << bits) - 1
    digits = (bits + 3) // 4
    shard_dir = str(index.get("shard_dir", "manifest_shards"))
    extension = str(index.get("shard_file_ext", ".json"))
    result: dict[str, Any] = {}
    for shard_id in sorted({_u32(value) & mask for value in hashes}):
        path = assets_dir / "models" / shard_dir / f"{shard_id:0{digits}x}{extension}"
        if not path.is_file():
            continue
        shard = json.loads(path.read_text(encoding="utf-8"))
        for hash_id, entry in (shard.get("meshes") or {}).items():
            if str(hash_id) in hashes:
                result[str(hash_id)] = copy.deepcopy(entry)
    return result


def _read_ent1_records(path: Path) -> tuple[list[bytes], int]:
    data = path.read_bytes()
    if data[:4] != b"ENT1" or len(data) < 8:
        raise ValueError(f"{path} is not an ENT1 file")
    count = struct.unpack_from("<I", data, 4)[0]
    for stride in (64, 48, 44):
        if len(data) == 8 + count * stride:
            return [data[8 + index * stride:8 + (index + 1) * stride] for index in range(count)], stride
    raise ValueError(f"{path} has an unsupported ENT1 record length")


def _pack_ent1_record(
    archetype_hash: int,
    position: list[float],
    rotation: list[float],
    scale: list[float],
    *,
    guid: int = 0,
    parent_guid: int = 0,
    entity_set_hash: int = 0,
    flags: int = 0,
) -> bytes:
    return struct.pack(
        "<I3f4f3f5I",
        _u32(archetype_hash),
        *_vec(position, 3, (0.0, 0.0, 0.0)),
        *_vec(rotation, 4, (0.0, 0.0, 0.0, 1.0)),
        *_vec(scale, 3, (1.0, 1.0, 1.0)),
        0,
        _u32(guid),
        _u32(parent_guid),
        _u32(entity_set_hash),
        _u32(flags),
    )


def _upgrade_ent1_record(record: bytes, stride: int) -> bytes:
    if stride == 64:
        return record
    if stride not in (44, 48):
        raise ValueError(f"Unsupported ENT1 stride {stride}")
    values = record[:44]
    tint = struct.unpack_from("<I", record, 44)[0] if stride == 48 else 0
    return values + struct.pack("<5I", tint, 0, 0, 0, 0)


def _takeover_root_for_record(record: bytes, roots: list[dict[str, Any]]) -> tuple[int, str] | None:
    archetype_hash, x, y, z = struct.unpack_from("<I3f", record, 0)
    for root in roots:
        root_hash = _u32(root.get("archetypeHash"))
        rx, ry, rz = _vec(root.get("position"), 3, (0.0, 0.0, 0.0))
        if math.hypot(x - rx, y - ry) <= MLO_TAKEOVER_ORIGIN_XY_TOLERANCE and abs(z - rz) <= MLO_TAKEOVER_ORIGIN_Z_TOLERANCE:
            return root_hash, "shared_origin"
        for override_hash, ox, oy, oz in MLO_TAKEOVER_INSTANCE_OVERRIDES.get(root_hash, ()):
            if archetype_hash == override_hash and math.dist((x, y, z), (ox, oy, oz)) <= 0.75:
                return root_hash, "authored_override"
    return None


def _filter_mlo_takeover_records(records: list[bytes], roots: list[dict[str, Any]]) -> tuple[list[bytes], dict[str, Any]]:
    kept: list[bytes] = []
    suppressed: list[dict[str, Any]] = []
    root_counts: Counter[str] = Counter()
    child_counts: Counter[str] = Counter()
    # Re-importing an MLO must replace both its root and the previously emitted
    # children.  A root is suppressed by its world position, but child records
    # live at their authored local positions, so a position-only takeover leaves
    # stale geometry behind and doubles the interior on the next export.
    root_by_parent_guid = {
        _u32(root.get("parentGuid")): _u32(root.get("archetypeHash"))
        for root in roots
        if _u32(root.get("parentGuid"))
    }
    for index, record in enumerate(records):
        if len(record) >= 64:
            parent_guid = struct.unpack_from("<I", record, 52)[0]
            child_root_hash = root_by_parent_guid.get(parent_guid)
            if child_root_hash is not None:
                child_counts[str(child_root_hash)] += 1
                continue
        match = _takeover_root_for_record(record, roots)
        if match is None:
            kept.append(record)
            continue
        root_hash, reason = match
        archetype_hash, x, y, z = struct.unpack_from("<I3f", record, 0)
        root_counts[str(root_hash)] += 1
        suppressed.append({
            "sourceIndex": index,
            "archetypeHash": str(archetype_hash),
            "rootArchetypeHash": str(root_hash),
            "reason": reason,
            "position": [round(x, 4), round(y, 4), round(z, 4)],
        })
    return kept, {
        "suppressedBaseInstanceCount": len(suppressed),
        "suppressedBaseInstancesByRoot": dict(sorted(root_counts.items())),
        "suppressedBaseInstances": suppressed,
        "suppressedExistingMloChildCount": sum(child_counts.values()),
        "suppressedExistingMloChildrenByRoot": dict(sorted(child_counts.items())),
    }


def _write_mlo_ent1(base_path: Path, destination: Path, roots: list[dict[str, Any]], allowed_children: set[str]) -> dict[str, Any]:
    records, stride = _read_ent1_records(base_path)
    filtered_records, takeover_stats = _filter_mlo_takeover_records(records, roots)
    output = [_upgrade_ent1_record(record, stride) for record in filtered_records]
    child_count = 0
    skipped = 0
    for root in roots:
        output.append(_pack_ent1_record(
            _u32(root.get("archetypeHash")),
            root.get("position"), root.get("rotation"), root.get("scale"),
            guid=_u32(root.get("parentGuid")), flags=MLO_FLAG_INSTANCE,
        ))
        parent_guid = _u32(root.get("parentGuid"))
        for child in root.get("children") or []:
            archetype_hash = str(_u32(child.get("archetypeHash")))
            if archetype_hash not in allowed_children:
                skipped += 1
                continue
            entity_set_hash = _u32(child.get("entitySetHash"))
            flags = MLO_FLAG_CHILD | (MLO_FLAG_ENTITY_SET if entity_set_hash else 0)
            if entity_set_hash and bool(child.get("entitySetDefault")):
                flags |= MLO_FLAG_ENTITY_SET_DEFAULT
            room_index = int(child.get("roomIndex", -1))
            portal_index = int(child.get("portalIndex", -1))
            if 0 <= room_index < 255:
                flags |= (room_index + 1) << MLO_ROOM_SHIFT
            if 0 <= portal_index < 255:
                flags |= (portal_index + 1) << MLO_PORTAL_SHIFT
            output.append(_pack_ent1_record(
                _u32(child.get("archetypeHash")),
                child.get("position"), child.get("rotation"), child.get("scale"),
                parent_guid=parent_guid, entity_set_hash=entity_set_hash, flags=flags,
            ))
            child_count += 1
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as handle:
        handle.write(b"ENT1")
        handle.write(struct.pack("<I", len(output)))
        for record in output:
            handle.write(record)
    return {
        "baseInstanceCount": len(records),
        "retainedBaseInstanceCount": len(filtered_records),
        **takeover_stats,
        "mloRootCount": len(roots),
        "mloChildCount": child_count,
        "skippedChildCount": skipped,
        "totalInstanceCount": len(output),
    }


def _write_interior_definitions(interiors: dict[str, Any], assets_dir: Path) -> int:
    output_dir = assets_dir / "interiors"
    output_dir.mkdir(parents=True, exist_ok=True)
    for hash_id, definition in interiors.items():
        payload = {
            "schema": "webglgta-interior-v2",
            "archetypeHash": str(hash_id),
            "assetHash": str(_u32(definition.get("assetHash"))),
            "rooms": definition.get("rooms") or [],
            "portals": definition.get("portals") or [],
            "entitySets": definition.get("entitySets") or [],
            "timecycleModifiers": definition.get("timecycleModifiers") or [],
        }
        (output_dir / f"{hash_id}.json").write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    return len(interiors)


def _build_texture_banks(dll: DllManager, resource_dir: Path, assets_dir: Path) -> tuple[dict[int, dict[str, tuple[np.ndarray | None, str | None, str]]], dict[str, tuple[np.ndarray | None, str | None, str]], int]:
    by_dictionary: dict[int, dict[str, tuple[np.ndarray | None, str | None, str]]] = {}
    fallback: dict[str, tuple[np.ndarray | None, str | None, str]] = {}
    count = 0
    for path in sorted(resource_dir.rglob("*.ytd")):
        dictionary_hash = _joaat_name(path)
        ytd = _load_raw_resource(dll.YtdFile, path)
        textures = _write_texture_set(
            dll,
            ytd,
            assets_dir / "mlo_textures" / "dictionaries" / str(dictionary_hash),
            f"mlo_textures/dictionaries/{dictionary_hash}",
        )
        if not textures:
            continue
        by_dictionary[dictionary_hash] = textures
        fallback.update(textures)
        count += len(textures)
    return by_dictionary, fallback, count


def _build_external_texture_bank(
    source_dir: Path | None,
    assets_dir: Path,
) -> dict[str, tuple[np.ndarray | None, str | None, str]]:
    if source_dir is None:
        return {}
    if not source_dir.is_dir():
        raise FileNotFoundError(f"External texture directory not found: {source_dir}")

    output_dir = assets_dir / "mlo_textures" / "external"
    output_dir.mkdir(parents=True, exist_ok=True)
    textures: dict[str, tuple[np.ndarray | None, str | None, str]] = {}
    for path in sorted(source_dir.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
            continue
        # ambientCG packages include a short preview PNG beside the authored maps.
        # Only ingest files whose stem carries the exported resolution/type marker.
        if "_1K-JPG_" not in path.stem:
            continue
        name = path.stem
        with Image.open(path) as source:
            image = np.asarray(source.convert("RGBA"), dtype=np.uint8)
        texture_hash = _u32(joaat(name, lower=True))
        target = output_dir / f"{texture_hash}.png"
        if not target.exists():
            Image.fromarray(image, mode="RGBA").save(target)
        textures[name] = (image, "RGBA8", f"mlo_textures/external/{target.name}")
    return textures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-path", required=True)
    parser.add_argument("--resource-dir", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--assets-dir", type=Path, default=ROOT / "webgl_viewer" / "assets")
    parser.add_argument("--base-descriptor", type=Path, default=None)
    parser.add_argument("--base-instance-file", default="", help="Optional original ENT1 path relative to assets; avoids re-importing a generated MLO ENT1.")
    parser.add_argument("--base-manifest-file", default="", help="Optional original manifest path relative to assets; avoids re-importing a generated MLO manifest.")
    parser.add_argument("--root-position", action="append", default=[], help="Restrict import to an MLO root at x,y. Repeat for each wanted root.")
    parser.add_argument("--chunk-size", type=float, default=None, help="Spatial tile size for the regenerated streamed MLO index.")
    parser.add_argument(
        "--additional-archetype-hash",
        action="append",
        default=[],
        help="Also export an exterior/resource archetype required by a companion YMAP. Repeatable.",
    )
    parser.add_argument("--external-texture-dir", type=Path, default=None, help="Optional loose texture maps referenced by incomplete MLO resources.")
    args = parser.parse_args()

    resource_dir = args.resource_dir.resolve()
    assets_dir = args.assets_dir.resolve()
    metadata = json.loads(args.metadata.read_text(encoding="utf-8"))
    roots = [item for item in (metadata.get("roots") or []) if isinstance(item, dict)]
    requested_positions = _parse_root_positions(args.root_position)
    if requested_positions:
        root_tolerance = 0.05
        selected_roots: list[dict[str, Any]] = []
        for root in roots:
            position = _vec(root.get("position"), 3, (float("nan"), float("nan"), 0.0))
            if any(math.hypot(position[0] - x, position[1] - y) <= root_tolerance for x, y in requested_positions):
                selected_roots.append(root)
        if len(selected_roots) != len(requested_positions):
            raise SystemExit(
                f"Matched {len(selected_roots)} MLO roots for {len(requested_positions)} --root-position values; refusing a partial import"
            )
        roots = selected_roots
    interiors = metadata.get("interiors") or {}
    archetypes = metadata.get("archetypes") or {}
    if not roots or not isinstance(interiors, dict):
        raise SystemExit("MLO metadata contains no roots or interior definitions")

    descriptor_path = (args.base_descriptor or (assets_dir / "demo" / "spawn_district.json")).resolve()
    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
    demo_dir = descriptor_path.parent
    base_manifest_file = str(args.base_manifest_file or descriptor["manifestFile"]).replace("\\", "/")
    base_instance_file = str(args.base_instance_file or descriptor["instanceFile"]).replace("\\", "/")
    base_manifest_path = assets_dir / base_manifest_file
    base_manifest = json.loads(base_manifest_path.read_text(encoding="utf-8"))
    base_instances_path = assets_dir / base_instance_file

    logging.disable(logging.CRITICAL)
    dll = DllManager(str(Path(args.game_path).resolve()))
    if not getattr(dll, "initialized", False):
        raise SystemExit("CodeWalker initialization failed")

    ydr_by_hash: dict[int, Path] = {}
    for path in sorted(resource_dir.rglob("*.ydr")):
        ydr_by_hash.setdefault(_joaat_name(path), path)
    textures_by_dict, fallback_textures, texture_count = _build_texture_banks(dll, resource_dir, assets_dir)
    external_textures = _build_external_texture_bank(
        args.external_texture_dir.resolve() if args.external_texture_dir else None,
        assets_dir,
    )
    fallback_textures.update(external_textures)
    texture_count += len(external_textures)

    required_hashes = sorted(
        {str(_u32(child.get("archetypeHash"))) for root in roots for child in (root.get("children") or [])}
        | {str(_u32(value)) for value in args.additional_archetype_hash if _u32(value)}
    )
    existing_meshes = dict(base_manifest.get("meshes") or {})
    runtime_hashes = set(RUNTIME_DEMO_MODEL_HASHES) - set(existing_meshes)
    global_meshes = _load_global_manifest_entries(
        assets_dir,
        (set(required_hashes) | runtime_hashes) - set(existing_meshes),
    )
    exported_meshes: dict[str, Any] = {}
    unresolved: list[dict[str, Any]] = []
    nonrenderable: set[str] = set(str(value) for value in (base_manifest.get("nonRenderableHashes") or []))
    source_counts: Counter[str] = Counter()
    game_cache: Any | None = None
    game_cache_error = ""
    game_rpf_reader: RpfReader | None = None
    game_texture_cache: dict[int, dict[str, tuple[np.ndarray | None, str | None, str]]] = {}

    def ensure_game_cache() -> tuple[Any | None, RpfReader | None, str]:
        nonlocal game_cache, game_cache_error, game_rpf_reader
        if game_cache is not None:
            return game_cache, game_rpf_reader, ""
        if game_cache_error:
            return None, None, game_cache_error
        print("[mlo] Initializing GTA GameFileCache for referenced base-game archetypes...", flush=True)
        if not dll.init_game_file_cache():
            game_cache_error = "GTA GameFileCache initialization failed"
            return None, None, game_cache_error
        game_cache = dll.get_game_file_cache()
        if game_cache is None:
            game_cache_error = "GTA GameFileCache is unavailable after initialization"
            return None, None, game_cache_error
        try:
            game_cache.MaxItemsPerLoop = 50
        except Exception:
            pass
        game_rpf_reader = RpfReader(str(Path(args.game_path).resolve()), dll)
        print("[mlo] GTA GameFileCache ready.", flush=True)
        return game_cache, game_rpf_reader, ""

    print(f"[mlo] Resolving {len(required_hashes)} unique child archetypes...", flush=True)
    for index, hash_id in enumerate(required_hashes, start=1):
        if index % 25 == 0:
            print(f"[mlo] Resolved {index}/{len(required_hashes)} child archetypes.", flush=True)
        archetype = archetypes.get(hash_id) or {}
        asset_hash = _u32(archetype.get("assetHash"))
        ydr_path = ydr_by_hash.get(asset_hash)
        if ydr_path is None:
            if hash_id in existing_meshes:
                source_counts["demo"] += 1
                continue
            if hash_id in global_meshes:
                exported_meshes[hash_id] = global_meshes[hash_id]
                nonrenderable.discard(hash_id)
                source_counts["gta"] += 1
                continue
            cache, rpf_reader, cache_error = ensure_game_cache()
            if cache is None or rpf_reader is None:
                unresolved.append({"archetypeHash": hash_id, "assetHash": str(asset_hash), "reason": cache_error or "GTA GameFileCache unavailable"})
                nonrenderable.add(hash_id)
                continue
            try:
                entry, reason = _export_game_archetype_drawable(
                    dll,
                    cache,
                    rpf_reader,
                    _u32(hash_id),
                    assets_dir,
                    game_texture_cache,
                )
            except Exception as error:
                entry, reason = None, str(error)
            if entry is None:
                unresolved.append({"archetypeHash": hash_id, "assetHash": str(asset_hash), "reason": reason or "GTA drawable export failed"})
                nonrenderable.add(hash_id)
                continue
            exported_meshes[hash_id] = entry
            nonrenderable.discard(hash_id)
            source_counts["gtaExport"] += 1
            continue
        dictionary_hash = _u32(archetype.get("textureDictionaryHash"))
        texture_map = _merge_texture_maps(fallback_textures, textures_by_dict.get(dictionary_hash, {}))
        try:
            entry = _export_archetype_drawable(dll, ydr_path, _u32(hash_id), texture_map, assets_dir)
        except Exception as error:
            unresolved.append({"archetypeHash": hash_id, "assetHash": str(asset_hash), "source": str(ydr_path), "reason": str(error)})
            nonrenderable.add(hash_id)
            continue
        if entry is None:
            unresolved.append({"archetypeHash": hash_id, "assetHash": str(asset_hash), "source": str(ydr_path), "reason": "drawable has no usable mesh"})
            nonrenderable.add(hash_id)
            continue
        exported_meshes[hash_id] = entry
        nonrenderable.discard(hash_id)
        source_counts["fivem"] += 1

    for hash_id in sorted(runtime_hashes, key=int):
        entry = global_meshes.get(hash_id)
        if entry is None:
            unresolved.append({
                "archetypeHash": hash_id,
                "assetHash": hash_id,
                "reason": "required runtime drawable is absent from the global manifest",
            })
            continue
        exported_meshes[hash_id] = entry
        nonrenderable.discard(hash_id)
        source_counts["runtime"] += 1

    merged_meshes = {**existing_meshes, **exported_meshes}
    # MLO roots are discovery anchors; their authored child drawables provide the visuals.
    nonrenderable.update(str(_u32(root.get("archetypeHash"))) for root in roots)
    nonrenderable.update(MLO_NONRENDERABLE_ARCHETYPE_HASHES)
    allowed_children = set(merged_meshes)
    ent1_path = demo_dir / "spawn_district_entities_mlo.bin"
    instance_stats = _write_mlo_ent1(base_instances_path, ent1_path, roots, allowed_children)
    interior_count = _write_interior_definitions(interiors, assets_dir)

    merged_manifest = copy.deepcopy(base_manifest)
    merged_manifest["schema"] = "webglgta-demo-manifest-mlo-v1"
    merged_manifest["meshes"] = merged_meshes
    merged_manifest["nonRenderableHashes"] = sorted(nonrenderable, key=int)
    merged_manifest["mloImport"] = {
        "rootCount": len(roots),
        "interiorDefinitionCount": interior_count,
        "runtimeModelHashes": sorted(RUNTIME_DEMO_MODEL_HASHES, key=int),
        "worldDrawableOverrides": sorted(
            {
                str(_u32(value))
                for values in MLO_WORLD_DRAWABLE_OVERRIDES.values()
                for value in values
            },
            key=int,
        ),
        "meshSources": dict(source_counts),
        "unresolvedArchetypes": unresolved,
    }
    manifest_path = demo_dir / "spawn_district_models_mlo.json"
    manifest_path.write_text(json.dumps(merged_manifest, separators=(",", ":")), encoding="utf-8")

    output_descriptor = copy.deepcopy(descriptor)
    output_descriptor["schema"] = "webglgta-spawn-district-mlo-v1"
    output_descriptor["instanceFile"] = "demo/spawn_district_entities_mlo.bin"
    output_descriptor["manifestFile"] = "demo/spawn_district_models_mlo.json"
    output_descriptor["instanceCount"] = instance_stats["totalInstanceCount"]
    output_descriptor["recordStride"] = 64
    output_descriptor["mloImport"] = {
        **instance_stats,
        "interiorDefinitionCount": interior_count,
        "uniqueChildArchetypeCount": len(required_hashes),
        "meshSources": dict(source_counts),
        "textureCount": texture_count,
        "unresolvedArchetypes": unresolved,
    }
    descriptor_path.write_text(json.dumps(output_descriptor, indent=2) + "\n", encoding="utf-8")

    # /demo uses its spatial index when one is present. Regenerate that index
    # from the newly written ENT1 stream so MLO roots and children are emitted
    # into the same streamed tiles as the rest of the district.
    chunk_size = args.chunk_size
    if chunk_size is None:
        chunk_size = _finite(output_descriptor.get("instanceChunkSize"), 256.0)
    if chunk_size <= 0:
        raise SystemExit("--chunk-size must be positive")
    from shard_spawn_district_entities import shard as shard_spawn_district_entities
    chunk_stats = shard_spawn_district_entities(descriptor_path, chunk_size)

    report = {
        "ok": True,
        "descriptor": str(descriptor_path),
        "manifest": str(manifest_path),
        "instances": instance_stats,
        "interiorDefinitions": interior_count,
        "uniqueChildArchetypes": len(required_hashes),
        "meshSources": dict(source_counts),
        "textureCount": texture_count,
        "unresolvedArchetypes": unresolved,
        "streamingChunks": chunk_stats,
    }
    report_path = demo_dir / "spawn_district_mlo_import.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

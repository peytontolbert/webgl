#!/usr/bin/env python3
"""Convert a clothingpack5m selection into skinned browser components."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import struct
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from gta5_modules.dll_manager import DllManager
from gta5_modules.hash_utils import joaat
from export_drawables_for_chunk import _compute_planar_uvs_xy01, _extract_drawable_lod_submeshes, _write_mesh_bin
from export_drawables_for_chunk import (
    FLAG_HAS_BLEND_INDICES, FLAG_HAS_BLEND_WEIGHTS, FLAG_HAS_COLOR0, FLAG_HAS_COLOR1,
    FLAG_HAS_NORMALS, FLAG_HAS_TANGENTS, FLAG_HAS_UV1, FLAG_HAS_UV2, FLAG_HAS_UVS,
    MESH_MAGIC, _decode_texture_object_to_img_rgba,
)
from export_fivem_weapon_drawable import _load_raw_resource, _material_for_shader, _texture_items
from export_runtime_ped_skinning import _remap_freemode_component_bone_ids


def u32_name(value: str) -> int:
    return int(joaat(value, lower=True)) & 0xFFFFFFFF


def first_drawable(ydd: Any) -> Any:
    values = getattr(getattr(getattr(ydd, "DrawableDict", None), "Drawables", None), "data_items", []) or []
    return next(iter(values), None)


def encode_delta_indices(indices: Any) -> bytes:
    out = bytearray()
    previous = 0
    for raw_value in indices:
        value = int(raw_value)
        delta = value - previous
        previous = value
        encoded = (delta << 1) ^ (delta >> 63)
        while encoded >= 0x80:
            out.append((encoded & 0x7F) | 0x80)
            encoded >>= 7
        out.append(encoded)
    return bytes(out)


def clone_geometry(entry: dict[str, Any]) -> dict[str, Any]:
    cloned = {key: value for key, value in entry.items() if key != "lods"}
    cloned["lods"] = {}
    for lod_name, lod in entry.get("lods", {}).items():
        cloned["lods"][lod_name] = {
            **{key: value for key, value in lod.items() if key != "submeshes"},
            "submeshes": [dict(submesh) for submesh in lod.get("submeshes", [])],
        }
    return cloned


def write_quantized_mesh(
    output_dir: Path, positions: Any, indices: Any, normals: Any, uvs: Any, tangents: Any,
    color0: Any, uvs1: Any, uvs2: Any, color1: Any, blend_weights: Any, blend_indices: Any,
) -> str:
    import numpy as np

    position_values = np.asarray(positions, dtype=np.float32)
    position_values = np.nan_to_num(position_values, nan=0.0, posinf=65504.0, neginf=-65504.0)
    positions = np.clip(position_values, -65504.0, 65504.0).astype(np.float16)
    indices = np.asarray(indices, dtype=np.uint32)
    flags = 0
    streams: list[bytes] = [positions.tobytes(order="C")]

    def append(value: Any, flag: int, dtype: Any, width: int, *, normalized: bool = False) -> None:
        nonlocal flags
        if value is None:
            return
        array = np.asarray(value)
        if array.shape[0] != positions.shape[0] or array.shape[1] != width:
            raise ValueError(f"attribute shape mismatch for flag {flag}")
        if normalized:
            limit = np.iinfo(dtype).max
            array = np.nan_to_num(array, nan=0.0, posinf=1.0, neginf=-1.0)
            array = np.rint(np.clip(array, -1.0, 1.0) * limit).astype(dtype)
        else:
            if np.issubdtype(dtype, np.floating):
                array = np.nan_to_num(array, nan=0.0, posinf=65504.0, neginf=-65504.0)
                if dtype == np.float16:
                    array = np.clip(array, -65504.0, 65504.0)
            array = array.astype(dtype)
        flags |= flag
        streams.append(array.tobytes(order="C"))

    if normals is not None:
        normal_values = np.asarray(normals)
        if normal_values.shape != (positions.shape[0], 3):
            raise ValueError("normal attribute shape mismatch")
        normal_values = np.nan_to_num(normal_values, nan=0.0, posinf=1.0, neginf=-1.0)
        packed_normals = np.rint(np.clip(normal_values, -1.0, 1.0) * 127).astype(np.int8)
        streams.append(packed_normals.tobytes(order="C"))
        if (positions.nbytes + packed_normals.nbytes) % 2:
            streams.append(b"\0")
        flags |= FLAG_HAS_NORMALS
        flags |= 1024 | 2048
    append(uvs, FLAG_HAS_UVS, np.float16, 2)
    # Missing secondary UVs are bound to UV0 by ModelManager; do not store duplicates.
    if uvs1 is not None and not np.array_equal(np.asarray(uvs1), np.asarray(uvs)):
        append(uvs1, FLAG_HAS_UV1, np.float16, 2)
    if uvs2 is not None and not np.array_equal(np.asarray(uvs2), np.asarray(uvs)):
        append(uvs2, FLAG_HAS_UV2, np.float16, 2)
    append(tangents, FLAG_HAS_TANGENTS, np.int8, 4, normalized=True)
    append(color0, FLAG_HAS_COLOR0, np.uint8, 4)
    append(color1, FLAG_HAS_COLOR1, np.uint8, 4)
    append(blend_weights, FLAG_HAS_BLEND_WEIGHTS, np.uint8, 4)
    append(blend_indices, FLAG_HAS_BLEND_INDICES, np.uint8, 4)
    index_dtype = np.uint16 if indices.size == 0 or int(indices.max()) <= 0xFFFF else np.uint32
    if index_dtype == np.uint16:
        flags |= 512 | 4096
        disk_indices = encode_delta_indices(indices)
    else:
        disk_indices = indices.astype(index_dtype, copy=False).tobytes(order="C")
    header = struct.pack("<4sIIII", MESH_MAGIC, 9, int(positions.shape[0]), int(indices.shape[0]), flags)
    vertex_payload = b"".join(streams)
    index_padding = b"\0" * (-(len(header) + len(vertex_payload)) % 4)
    raw = b"".join([header, vertex_payload, index_padding, disk_indices])
    digest = hashlib.sha256(raw).hexdigest()[:24]
    filename = f"{digest}.msh9.gz"
    target = output_dir / filename
    if not target.exists():
        target.write_bytes(gzip.compress(raw, compresslevel=9, mtime=0))
    return filename


def write_capped_textures(dm: Any, ytd: Any, texture_dir: Path, max_size: int = 512) -> dict:
    from PIL import Image

    texture_dir.mkdir(parents=True, exist_ok=True)
    out = {}
    for texture in _texture_items(ytd):
        name = str(getattr(texture, "Name", "") or "").strip()
        if not name:
            continue
        image, fmt = _decode_texture_object_to_img_rgba(dm, texture)
        if image is None:
            continue
        pil = Image.fromarray(image, mode="RGBA")
        cap = 256 if any(token in name.lower() for token in ("normal", "bump", "_n", "nrm", "spec")) else max_size
        if max(pil.size) > cap:
            scale = cap / max(pil.size)
            pil = pil.resize((max(1, round(pil.width * scale)), max(1, round(pil.height * scale))), Image.Resampling.LANCZOS)
        encoded = io.BytesIO()
        pil.save(encoded, format="WEBP", quality=82, method=6, exact=True)
        payload = encoded.getvalue()
        content_id = int.from_bytes(hashlib.sha256(payload).digest()[:4], "little")
        target = texture_dir / f"{content_id}.webp"
        if not target.exists():
            target.write_bytes(payload)
        out[name] = (image, fmt, f"models_textures/{content_id}.webp")
    return out


def geometry_entry(drawable: Any, output_dir: Path, relative_dir: str, base_hash: int, item: dict) -> dict[str, Any]:
    entry: dict[str, Any] = {"lods": {}, "lodDistances": {}, "material": {}}
    selection = {"componentId": int(item["componentId"]), "drawableName": Path(item["drawablePath"]).stem.split("^")[-1]}
    for lod in ("High", "Med", "Low", "VLow"):
        submeshes = _extract_drawable_lod_submeshes(drawable, lod)
        if not submeshes:
            continue
        rows = []
        for index, submesh in enumerate(submeshes):
            positions = submesh["positions"]
            uv0 = submesh.get("uv0")
            uvs = uv0 if uv0 is not None and getattr(uv0, "size", 0) else _compute_planar_uvs_xy01(positions)
            filename = write_quantized_mesh(
                output_dir, positions, submesh["indices"], submesh.get("normals"), uvs,
                submesh.get("tangents"), submesh.get("color0"), submesh.get("uv1"), submesh.get("uv2"),
                submesh.get("color1"), submesh.get("blendWeights"), submesh.get("blendIndices"),
            )
            bone_ids = _remap_freemode_component_bone_ids(submesh.get("boneIds"), selection)
            rows.append({
                "file": f"{relative_dir}/{filename}", "vertexCount": int(positions.shape[0]),
                "indexCount": int(submesh["indices"].shape[0]), "hasNormals": submesh.get("normals") is not None,
                "hasUvs": True, "hasTangents": submesh.get("tangents") is not None,
                "hasColor0": submesh.get("color0") is not None, "hasColor1": submesh.get("color1") is not None,
                "hasBlendWeights": submesh.get("blendWeights") is not None,
                "hasBlendIndices": submesh.get("blendIndices") is not None,
                "skinned": bool(submesh.get("blendWeights") is not None and submesh.get("blendIndices") is not None and bone_ids),
                "boneIds": bone_ids, "material": {}, "_shader": submesh.get("shader"),
            })
        entry["lods"][lod.lower()] = {"submeshes": rows}
    return entry


def apply_texture(entry: dict[str, Any], textures: dict, fallback: str | None) -> None:
    for lod in entry.get("lods", {}).values():
        for submesh in lod.get("submeshes", []):
            shader = submesh.pop("_shader", None)
            try:
                material = _material_for_shader(shader, textures) if shader is not None else {}
            except (TypeError, ValueError):
                material = {}
            if fallback and not material.get("diffuse"):
                material["diffuse"] = fallback
                material["diffuseName"] = next(iter(textures), "clothingpack5m")
            submesh["material"] = material


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--game-path", required=True)
    parser.add_argument("--resource", type=Path, required=True, help="Local clothingpack5m resource root")
    parser.add_argument("--selection", type=Path, required=True)
    parser.add_argument("--assets-dir", type=Path, default=Path(__file__).resolve().parents[1] / "assets")
    args = parser.parse_args()
    resource = args.resource.resolve()
    assets = args.assets_dir.resolve()
    selected = json.loads(args.selection.read_text(encoding="utf-8")).get("items", [])

    dm = DllManager(str(Path(args.game_path).resolve()))
    if not dm.initialized:
        raise RuntimeError("CodeWalker initialization failed")
    from CodeWalker.GameFiles import YddFile

    relative_dir = "custom_clothing/clothingpack5m"
    model_dir = assets / "models" / relative_dir
    model_dir.mkdir(parents=True, exist_ok=True)
    target = assets / "custom_clothing" / "clothingpack5m.json"
    existing = {}
    if target.is_file():
        try:
            existing = json.loads(target.read_text(encoding="utf-8"))
        except Exception:
            existing = {}
    geometry: dict[str, dict[str, Any]] = {}
    meshes: dict[str, Any] = dict(existing.get("meshes") or {})
    models: dict[str, dict[str, list]] = {
        model: {slot: list(rows) for slot, rows in slots.items()}
        for model, slots in (existing.get("models") or {}).items()
    }
    skipped = []

    for item in selected:
        ydd_path = resource / str(item.get("drawablePath", ""))
        ytd_path = resource / str(item.get("texturePath", ""))
        if not ydd_path.is_file() or not ytd_path.is_file():
            skipped.append({"id": item.get("id"), "reason": "missing source file"})
            continue
        geometry_key = str(ydd_path.relative_to(resource)).lower()
        if geometry_key not in geometry:
            ydd = _load_raw_resource(dm, YddFile, ydd_path)
            drawable = first_drawable(ydd)
            if drawable is None:
                skipped.append({"id": item.get("id"), "reason": "empty drawable dictionary"})
                continue
            geometry[geometry_key] = geometry_entry(drawable, model_dir, relative_dir, u32_name(f"webgl:clothingpack5m:{item['id']}"), item)

        ytd = _load_raw_resource(dm, dm.YtdFile, ytd_path)
        textures = write_capped_textures(dm, ytd, assets / "models_textures")
        fallback = next((value[2] for value in textures.values()), None)
        entry = clone_geometry(geometry[geometry_key])
        apply_texture(entry, textures, fallback)
        texture = int(item.get("texture", 0))
        item_hash = str(u32_name(f"webgl:clothingpack5m:{item['id']}:texture:{texture}"))
        model_name = "mp_f_freemode_01" if item.get("sex") == "female" else "mp_m_freemode_01"
        component_id = int(item["componentId"])
        entry["pedComponent"] = {
            "modelName": model_name, "modelHash": 2627665880 if item.get("sex") == "female" else 1885233650,
            "componentId": component_id, "drawable": int(item["drawable"]), "texture": texture,
            "drawableName": Path(item["drawablePath"]).stem, "collection": "clothingpack5m",
            "skeleton": f"peds/{2627665880 if item.get('sex') == 'female' else 1885233650}_skeleton.json",
        }
        meshes[item_hash] = entry
        rows = models.setdefault(model_name, {}).setdefault(str(component_id), [])
        prior = next((existing_row for existing_row in rows if existing_row.get("itemId") == item["id"]), None)
        texture_assets = dict(prior.get("textureAssets") or {}) if prior else {}
        texture_assets[str(texture)] = item_hash
        prior_textures = list(prior.get("textures") or []) if prior else []
        available_textures = sorted({int(value) for value in [*prior_textures, texture]})
        row = {
            "variantKey": f"clothingpack5m:{item['id']}", "itemId": item["id"], "label": item.get("label") or item["id"],
            "componentId": component_id, "drawable": int(item["drawable"]), "texture": texture,
            "assetName": Path(item["drawablePath"]).stem, "hash": item_hash, "textures": available_textures,
            "textureAssets": texture_assets, "collection": "clothingpack5m",
        }
        rows[:] = [existing_row for existing_row in rows if existing_row.get("itemId") != item["id"]]
        rows.append(row)

    referenced_hashes = {
        str(value)
        for slots in models.values()
        for rows in slots.values()
        for row in rows
        for value in [row.get("hash"), *(row.get("textureAssets") or {}).values()]
        if value is not None
    }
    meshes = {key: value for key, value in meshes.items() if key in referenced_hashes}
    payload = {"schema": "webglgta-custom-clothing-v1", "collection": "clothingpack5m", "models": models, "meshes": meshes, "skipped": skipped}
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"items": sum(len(rows) for slots in models.values() for rows in slots.values()), "meshes": len(meshes), "skipped": skipped}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Convert nx-mod-chains streamed YDD/YTD assets into skinned browser components."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from gta5_modules.dll_manager import DllManager
from gta5_modules.hash_utils import joaat
from export_drawables_for_chunk import _compute_planar_uvs_xy01, _extract_drawable_lod_submeshes, _write_mesh_bin
from export_fivem_weapon_drawable import _load_raw_resource, _material_for_shader, _write_ytd_textures
from export_runtime_ped_skinning import _remap_freemode_component_bone_ids


def u32_name(value: str) -> int:
    return int(joaat(value, lower=True)) & 0xFFFFFFFF


def first_drawable(ydd: Any) -> Any:
    return next(iter(getattr(getattr(getattr(ydd, "DrawableDict", None), "Drawables", None), "data_items", []) or []), None)


def source_file(stream: Path, drawable: int, suffix: str) -> Path | None:
    stem = f"mp_m_freemode_01^teef_{drawable:03d}_u" if suffix == "ydd" else ""
    if stem:
        target = stream / f"{stem}.{suffix}"
        return target if target.is_file() else None
    return None


def texture_file(stream: Path, drawable: int, texture: int) -> Path | None:
    letter = chr(ord("a") + texture)
    target = stream / f"mp_m_freemode_01^teef_diff_{drawable:03d}_{letter}_uni.ytd"
    return target if target.is_file() else None


def geometry_entry(drawable: Any, output_dir: Path, base_hash: int) -> dict[str, Any]:
    entry: dict[str, Any] = {"lods": {}, "lodDistances": {}, "material": {}}
    selection = {"componentId": 7, "drawableName": f"teef_{base_hash}_u"}
    for lod in ("High", "Med", "Low", "VLow"):
        submeshes = _extract_drawable_lod_submeshes(drawable, lod)
        if not submeshes:
            continue
        rows = []
        for index, submesh in enumerate(submeshes):
            positions = submesh["positions"]
            uv0 = submesh.get("uv0")
            uvs = uv0 if uv0 is not None and getattr(uv0, "size", 0) else _compute_planar_uvs_xy01(positions)
            filename = f"custom_clothing/nx_chains/{base_hash}_{lod.lower()}_{index}.bin"
            _write_mesh_bin(
                output_dir / f"{base_hash}_{lod.lower()}_{index}.bin",
                positions,
                submesh["indices"],
                submesh.get("normals"),
                uvs,
                submesh.get("tangents"),
                color0=submesh.get("color0"),
                uvs1=submesh.get("uv1") if submesh.get("uv1") is not None else uvs,
                uvs2=submesh.get("uv2") if submesh.get("uv2") is not None else uvs,
                color1=submesh.get("color1"),
                blend_weights=submesh.get("blendWeights"),
                blend_indices=submesh.get("blendIndices"),
            )
            bone_ids = _remap_freemode_component_bone_ids(submesh.get("boneIds"), selection)
            rows.append({
                "file": filename,
                "vertexCount": int(positions.shape[0]),
                "indexCount": int(submesh["indices"].shape[0]),
                "hasNormals": submesh.get("normals") is not None,
                "hasUvs": True,
                "hasTangents": submesh.get("tangents") is not None,
                "hasColor0": submesh.get("color0") is not None,
                "hasColor1": submesh.get("color1") is not None,
                "hasBlendWeights": submesh.get("blendWeights") is not None,
                "hasBlendIndices": submesh.get("blendIndices") is not None,
                "skinned": bool(submesh.get("blendWeights") is not None and submesh.get("blendIndices") is not None and bone_ids),
                "boneIds": bone_ids,
                "material": {},
                "_shader": submesh.get("shader"),
            })
        entry["lods"][lod.lower()] = {"submeshes": rows}
    return entry


def apply_texture(entry: dict[str, Any], textures: dict, fallback: str | None) -> None:
    for lod in entry.get("lods", {}).values():
        for submesh in lod.get("submeshes", []):
            shader = submesh.pop("_shader", None)
            material = _material_for_shader(shader, textures) if shader is not None else {}
            if fallback and not material.get("diffuse"):
                material["diffuse"] = fallback
                material["diffuseName"] = next(iter(textures), "nx_chain")
            submesh["material"] = material


def clone_geometry(entry: dict[str, Any]) -> dict[str, Any]:
    cloned = {key: value for key, value in entry.items() if key != "lods"}
    cloned["lods"] = {}
    for lod_name, lod in entry.get("lods", {}).items():
        cloned["lods"][lod_name] = {
            **{key: value for key, value in lod.items() if key != "submeshes"},
            "submeshes": [dict(submesh) for submesh in lod.get("submeshes", [])],
        }
    return cloned


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--game-path", required=True)
    parser.add_argument("--resource", type=Path, required=True)
    parser.add_argument("--assets-dir", type=Path, default=Path(__file__).resolve().parents[1] / "assets")
    args = parser.parse_args()
    resource = args.resource.resolve()
    stream = resource / "stream"
    contracts = json.loads((args.assets_dir / "fivem_appearance_contracts.json").read_text(encoding="utf-8"))
    items = contracts.get("nxChains", {}).get("items", [])

    dm = DllManager(str(Path(args.game_path).resolve()))
    if not dm.initialized:
        raise RuntimeError("CodeWalker initialization failed")
    from CodeWalker.GameFiles import YddFile

    model_dir = args.assets_dir / "models" / "custom_clothing" / "nx_chains"
    model_dir.mkdir(parents=True, exist_ok=True)
    geometry: dict[int, dict[str, Any]] = {}
    meshes: dict[str, Any] = {}
    catalog: list[dict[str, Any]] = []
    skipped: list[str] = []

    for item in items:
        drawable_id = int(item.get("drawable", 0))
        texture_id = int(item.get("texture", 0))
        ydd_path = source_file(stream, drawable_id, "ydd")
        ytd_path = texture_file(stream, drawable_id, texture_id)
        if not ydd_path or not ytd_path:
            skipped.append(str(item.get("id")))
            continue
        if drawable_id not in geometry:
            ydd = _load_raw_resource(dm, YddFile, ydd_path)
            drawable = first_drawable(ydd)
            if drawable is None:
                skipped.append(str(item.get("id")))
                continue
            base_hash = u32_name(f"webgl:nx-mod-chains:male:teef:{drawable_id}")
            geometry[drawable_id] = geometry_entry(drawable, model_dir, base_hash)

        ytd = _load_raw_resource(dm, dm.YtdFile, ytd_path)
        textures = _write_ytd_textures(dm, ytd, args.assets_dir / "models_textures")
        fallback = next((value[2] for value in textures.values()), None)
        entry = clone_geometry(geometry[drawable_id])
        apply_texture(entry, textures, fallback)
        item_hash = str(u32_name(f"webgl:nx-mod-chains:{item.get('id')}"))
        entry["pedComponent"] = {
            "modelName": "mp_m_freemode_01",
            "modelHash": 1885233650,
            "componentId": 7,
            "drawable": drawable_id,
            "texture": texture_id,
            "drawableName": f"nx_chain_{item.get('id')}",
            "collection": "nx-mod-chains",
            "skeleton": "peds/1885233650_skeleton.json",
        }
        meshes[item_hash] = entry
        catalog.append({
            "variantKey": f"nx-mod-chains:{item.get('id')}",
            "itemId": item.get("id"),
            "label": item.get("label") or item.get("id"),
            "componentId": 7,
            "drawable": drawable_id,
            "texture": texture_id,
            "assetName": f"nx_chain_{item.get('id')}",
            "hash": item_hash,
            "textures": [texture_id],
            "textureAssets": {str(texture_id): item_hash},
            "collection": "nx-mod-chains",
        })

    payload = {
        "schema": "webglgta-custom-clothing-v1",
        "collection": "nx-mod-chains",
        "models": {"mp_m_freemode_01": {"7": catalog}},
        "meshes": meshes,
        "skipped": skipped,
    }
    target = args.assets_dir / "custom_clothing" / "nx_chains.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(json.dumps({"items": len(catalog), "meshes": len(meshes), "drawables": len(geometry), "skipped": skipped}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

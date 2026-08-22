#!/usr/bin/env python3
"""Export GTA YFT fragment children used by the bounded spawn-district demo.

The normal world export bakes a fragment's intact drawable into the streamed
mesh pack.  That is correct for the undamaged state, but it discards the
``FragPhysicsLOD.Children`` ownership and per-child ``FragTransforms``.  This
tool exports that missing data into a small, independently loaded manifest.

For every fragment archetype in ``spawn_district_destructibles.json`` it:

* exports authored ``FragPhysTypeChild.Drawable1/Drawable2`` meshes when a YFT
  supplies them;
* otherwise partitions the root fragment drawable by the child bone palette;
* retains GTA's child mass, group, bone tag, and local physics transform;
* copies the already-preprocessed demo material bindings, avoiding another
  texture dump or runtime RPF access.

The browser only simulates records with exported source geometry.  Unsupported
YFTs remain explicitly reported instead of being replaced with invented debris.
"""

from __future__ import annotations

import argparse
import copy
import json
import logging
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from export_drawables_for_chunk import (  # noqa: E402
    _compute_vertex_normals,
    _extract_drawable_lod_submeshes,
    _extract_geometry_positions_indices_uv0_uv1_color0,
    _fragment_model_pose_matrix,
    _iter_drawable_models_for_lod,
    _transform_rigid_fragment_geometry,
    _write_mesh_bin,
)
from gta5_modules.codewalker_archetypes import get_archetype_best_effort  # noqa: E402
from gta5_modules.cw_loaders import try_get_drawable  # noqa: E402
from gta5_modules.dll_manager import DllManager  # noqa: E402
from gta5_modules.hash_utils import joaat  # noqa: E402


def _finite(value: Any, fallback: float = 0.0) -> float:
    try:
        value = float(value)
    except Exception:
        return fallback
    return value if math.isfinite(value) else fallback


def _matrix4f_to_column_major(matrix: Any) -> list[float]:
    """Convert CodeWalker's Matrix4F_s (four columns) to WebGL mat4 data."""
    if matrix is None:
        return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]
    columns = []
    for name, fallback in (
        ("Column1", (1.0, 0.0, 0.0)),
        ("Column2", (0.0, 1.0, 0.0)),
        ("Column3", (0.0, 0.0, 1.0)),
        ("Column4", (0.0, 0.0, 0.0)),
    ):
        column = getattr(matrix, name, None)
        columns.extend((
            _finite(getattr(column, "X", fallback[0]), fallback[0]),
            _finite(getattr(column, "Y", fallback[1]), fallback[1]),
            _finite(getattr(column, "Z", fallback[2]), fallback[2]),
            0.0 if name != "Column4" else 1.0,
        ))
    return columns


def _root_materials(entry: dict) -> list[dict]:
    out: list[dict] = []
    for lod in (entry.get("lods") or {}).values():
        for submesh in lod.get("submeshes") or []:
            material = submesh.get("material")
            if isinstance(material, dict):
                out.append(copy.deepcopy(material))
    return out


def _subset_vertices(values: np.ndarray | None, indices: np.ndarray) -> np.ndarray | None:
    if values is None:
        return None
    return np.asarray(values)[indices].copy()


def _partition_root_drawable_by_child(
    drawable: Any,
    child: Any,
    child_index: int,
) -> list[dict]:
    """Extract root geometry owned by one fragment child bone.

    Vanilla roadside props often omit Drawable1/Drawable2.  Their intact
    drawable is still source geometry, usually skinned to the fragment
    skeleton.  Selecting triangles by the child BoneTag gives the browser a
    real source-mesh shard instead of a fake cube.
    """
    skeleton = getattr(drawable, "Skeleton", None)
    bone_tags = list(getattr(getattr(skeleton, "BoneTags", None), "data_items", None) or [])
    child_tag = int(getattr(child, "BoneTag", -1) or -1)
    target_indices = {
        int(getattr(bone_tag, "BoneIndex", -1) or -1)
        for bone_tag in bone_tags
        if int(getattr(bone_tag, "BoneTag", -2) or -2) == child_tag
    }
    if not target_indices:
        return []

    out: list[dict] = []
    for lod in ("High", "Med", "Low", "VLow"):
        for model in _iter_drawable_models_for_lod(drawable, lod) or []:
            rigid_pose = _fragment_model_pose_matrix(drawable, model)
            model_bone = int(getattr(model, "BoneIndex", -1) or -1)
            model_has_skin = int(getattr(model, "HasSkin", 0) or 0) != 0
            for geometry in getattr(model, "Geometries", None) or []:
                raw = _extract_geometry_positions_indices_uv0_uv1_color0(geometry)
                if raw is None:
                    continue
                pos, indices, uv0, uv1, uv2, col0, col1, tangent, weights, blend_indices = raw
                if pos.size == 0 or indices.size < 3:
                    continue

                chosen_indices: np.ndarray | None = None
                if not model_has_skin and model_bone in target_indices:
                    chosen_indices = np.asarray(indices, dtype=np.uint32)
                elif weights is not None and blend_indices is not None:
                    palette = [int(value) for value in list(getattr(geometry, "BoneIds", None) or [])]
                    if palette:
                        dominant_slots = np.argmax(np.asarray(weights, dtype=np.uint8), axis=1)
                        selected_bones = np.full((pos.shape[0],), -1, dtype=np.int32)
                        raw_blends = np.asarray(blend_indices, dtype=np.uint8)
                        for vertex_index, slot in enumerate(dominant_slots):
                            palette_index = int(raw_blends[vertex_index, int(slot)])
                            if 0 <= palette_index < len(palette):
                                selected_bones[vertex_index] = palette[palette_index]
                        triangles = np.asarray(indices, dtype=np.uint32).reshape((-1, 3))
                        keep = np.count_nonzero(np.isin(selected_bones[triangles], list(target_indices)), axis=1) >= 2
                        if np.any(keep):
                            chosen_indices = triangles[keep].reshape((-1,)).astype(np.uint32, copy=False)

                if chosen_indices is None or chosen_indices.size < 3:
                    continue
                used, remapped = np.unique(chosen_indices, return_inverse=True)
                if used.size < 3:
                    continue
                selected_pos = np.asarray(pos, dtype=np.float32)[used].copy()
                selected_tangent = _subset_vertices(tangent, used)
                selected_pos, selected_tangent = _transform_rigid_fragment_geometry(selected_pos, selected_tangent, rigid_pose)
                out.append({
                    "lod": lod,
                    "positions": selected_pos,
                    "indices": remapped.astype(np.uint32, copy=False),
                    "normals": _compute_vertex_normals(selected_pos, remapped.astype(np.uint32, copy=False)),
                    "uv0": _subset_vertices(uv0, used),
                    "uv1": _subset_vertices(uv1, used),
                    "uv2": _subset_vertices(uv2, used),
                    "color0": _subset_vertices(col0, used),
                    "color1": _subset_vertices(col1, used),
                    "tangents": selected_tangent,
                    "source": "root-bone-palette",
                })
    return out


def _authored_child_submeshes(fragment: Any, child: Any) -> list[dict]:
    # Drawable2 is GTA's damaged child drawable when present. Prefer it so the
    # first frame after a break already reflects the fragment's damaged state.
    drawable = getattr(child, "Drawable2", None) or getattr(child, "Drawable1", None)
    if drawable is None:
        return []
    try:
        drawable.OwnerFragment = fragment
    except Exception:
        pass
    for lod in ("High", "Med", "Low", "VLow"):
        extracted = _extract_drawable_lod_submeshes(drawable, lod)
        if not extracted:
            continue
        result = []
        for submesh in extracted:
            result.append({
                "lod": lod,
                "positions": submesh["positions"],
                "indices": submesh["indices"],
                "normals": submesh["normals"],
                "uv0": submesh.get("uv0"),
                "uv1": submesh.get("uv1"),
                "uv2": submesh.get("uv2"),
                "color0": submesh.get("color0"),
                "color1": submesh.get("color1"),
                "tangents": submesh.get("tangents"),
                "source": "authored-child-drawable2" if getattr(child, "Drawable2", None) is not None else "authored-child-drawable1",
            })
        return result
    return []


def _write_child_meshes(
    assets_dir: Path,
    parent_hash: int,
    child_index: int,
    submeshes: list[dict],
    materials: list[dict],
) -> tuple[int, dict] | None:
    if not submeshes:
        return None
    mesh_hash = int(joaat(f"webglgta_fragment_{parent_hash}_{child_index}")) & 0xFFFFFFFF
    entry = {"lods": {"high": {"submeshes": []}}, "lodDistances": {}, "material": {}}
    material_list = materials or [{}]
    for index, submesh in enumerate(submeshes):
        positions = np.asarray(submesh["positions"], dtype=np.float32)
        indices = np.asarray(submesh["indices"], dtype=np.uint32)
        if positions.size == 0 or indices.size < 3:
            continue
        file = f"fragments/{mesh_hash}_{index}.bin"
        _write_mesh_bin(
            assets_dir / "models" / file,
            positions,
            indices,
            np.asarray(submesh.get("normals"), dtype=np.float32) if submesh.get("normals") is not None else None,
            np.asarray(submesh.get("uv0"), dtype=np.float32) if submesh.get("uv0") is not None else None,
            tangents=np.asarray(submesh.get("tangents"), dtype=np.float32) if submesh.get("tangents") is not None else None,
            color0=np.asarray(submesh.get("color0"), dtype=np.uint8) if submesh.get("color0") is not None else None,
            uvs1=np.asarray(submesh.get("uv1"), dtype=np.float32) if submesh.get("uv1") is not None else None,
            uvs2=np.asarray(submesh.get("uv2"), dtype=np.float32) if submesh.get("uv2") is not None else None,
            color1=np.asarray(submesh.get("color1"), dtype=np.uint8) if submesh.get("color1") is not None else None,
        )
        entry["lods"]["high"]["submeshes"].append({
            "file": file,
            "vertexCount": int(positions.shape[0]),
            "indexCount": int(indices.shape[0]),
            "hasNormals": submesh.get("normals") is not None,
            "hasUvs": submesh.get("uv0") is not None,
            "hasTangents": submesh.get("tangents") is not None,
            "hasColor0": submesh.get("color0") is not None,
            "hasColor1": submesh.get("color1") is not None,
            "hasBlendWeights": False,
            "hasBlendIndices": False,
            "skinned": False,
            "boneIds": [],
            "material": copy.deepcopy(material_list[index % len(material_list)]),
        })
    return (mesh_hash, entry) if entry["lods"]["high"]["submeshes"] else None


def main() -> None:
    parser = argparse.ArgumentParser(description="Export physical YFT fragment children for the spawn district.")
    parser.add_argument("--game-path", required=True, help="GTA V installation directory")
    parser.add_argument("--assets-dir", default=str(ROOT / "webgl_viewer" / "assets"))
    parser.add_argument("--destructibles", default="demo/spawn_district_destructibles.json")
    parser.add_argument("--source-manifest", default="demo/spawn_district_models_compressed_v2.json")
    parser.add_argument("--output", default="demo/spawn_district_fragment_children.json")
    parser.add_argument("--selected-dlc", default="all")
    args = parser.parse_args()

    logging.disable(logging.CRITICAL)
    assets_dir = Path(args.assets_dir).resolve()
    destructible_path = assets_dir / args.destructibles
    source_manifest_path = assets_dir / args.source_manifest
    output_path = assets_dir / args.output
    if not destructible_path.exists():
        raise SystemExit(f"Destructible manifest not found: {destructible_path}")
    if not source_manifest_path.exists():
        raise SystemExit(f"Demo model manifest not found: {source_manifest_path}")

    destructibles = json.loads(destructible_path.read_text(encoding="utf-8"))
    source_manifest = json.loads(source_manifest_path.read_text(encoding="utf-8"))
    source_meshes = source_manifest.get("meshes") or {}
    parent_hashes = sorted({int(record.get("archetypeHash")) & 0xFFFFFFFF for record in destructibles.get("destructibles") or []})

    manager = DllManager(str(Path(args.game_path).resolve()))
    if not manager.initialized or not manager.init_game_file_cache(selected_dlc=str(args.selected_dlc or "all")):
        raise SystemExit("Could not initialize the CodeWalker game-file cache")
    cache = manager.get_game_file_cache()

    meshes: dict[str, dict] = {}
    profiles: dict[str, dict] = {}
    errors: list[dict] = []
    authored_child_count = 0
    root_palette_count = 0
    skipped_child_count = 0

    for sequence, parent_hash in enumerate(parent_hashes, start=1):
        print(f"[{sequence}/{len(parent_hashes)}] fragment {parent_hash}")
        try:
            archetype = get_archetype_best_effort(cache, parent_hash, dll_manager=manager)
            drawable = try_get_drawable(cache, archetype, spins=500) if archetype is not None else None
            fragment = getattr(drawable, "OwnerFragment", None)
            physics_lod = getattr(getattr(fragment, "PhysicsLODGroup", None), "PhysicsLOD1", None)
            children = list(getattr(getattr(physics_lod, "Children", None), "data_items", None) or [])
            transforms = list(getattr(getattr(physics_lod, "FragTransforms", None), "Matrices", None) or [])
            if drawable is None or fragment is None or physics_lod is None or not children:
                errors.append({"archetypeHash": str(parent_hash), "reason": "missing_fragment_physics_children"})
                continue

            materials = _root_materials(source_meshes.get(str(parent_hash), {}))
            profile_children = []
            for child_index, child in enumerate(children):
                submeshes = _authored_child_submeshes(fragment, child)
                source = "authored-child-drawable"
                if submeshes:
                    authored_child_count += 1
                else:
                    submeshes = _partition_root_drawable_by_child(drawable, child, child_index)
                    source = "root-bone-palette"
                    if submeshes:
                        root_palette_count += 1
                written = _write_child_meshes(assets_dir, parent_hash, child_index, submeshes, materials)
                if written is None:
                    skipped_child_count += 1
                    continue
                mesh_hash, entry = written
                meshes[str(mesh_hash)] = entry
                transform = transforms[child_index] if child_index < len(transforms) else None
                profile_children.append({
                    "childIndex": child_index,
                    "meshHash": str(mesh_hash),
                    "boneTag": int(getattr(child, "BoneTag", 0) or 0),
                    "groupIndex": int(getattr(child, "GroupIndex", 0) or 0),
                    "mass": max(0.01, _finite(getattr(child, "DamagedMass", None), _finite(getattr(child, "PristineMass", None), 1.0))),
                    "pristineMass": max(0.01, _finite(getattr(child, "PristineMass", None), 1.0)),
                    "transform": _matrix4f_to_column_major(transform),
                    "geometrySource": source,
                })
            if profile_children:
                profiles[str(parent_hash)] = {
                    "archetypeHash": str(parent_hash),
                    "fragmentName": str(getattr(fragment, "Name", "") or ""),
                    "gravityFactor": _finite(getattr(fragment, "GravityFactor", None), 1.0),
                    "positionOffset": [
                        _finite(getattr(getattr(physics_lod, "PositionOffset", None), "X", None)),
                        _finite(getattr(getattr(physics_lod, "PositionOffset", None), "Y", None)),
                        _finite(getattr(getattr(physics_lod, "PositionOffset", None), "Z", None)),
                    ],
                    "children": profile_children,
                }
        except Exception as exc:
            errors.append({"archetypeHash": str(parent_hash), "reason": str(exc)})

    report = {
        "schema": "webglgta-fragment-children-v1",
        "sourceDestructibles": args.destructibles,
        "sourceManifestName": Path(args.source_manifest).name,
        "parentProfileCount": len(parent_hashes),
        "renderableProfileCount": len(profiles),
        "meshCount": len(meshes),
        "authoredChildDrawableCount": authored_child_count,
        "rootBonePaletteChildCount": root_palette_count,
        "skippedChildCount": skipped_child_count,
        "errors": errors,
        "meshes": meshes,
        "profiles": profiles,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, separators=(",", ":")), encoding="utf-8")
    print(
        f"Wrote {output_path}: profiles={len(profiles)} meshes={len(meshes)} "
        f"authored={authored_child_count} root_palette={root_palette_count} skipped={skipped_child_count} errors={len(errors)}"
    )


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Convert a spatially-packed TNM track scene into the demo renderer format.

The runtime track scene used to own a second WebGL renderer.  This importer
turns every authored spatial cell/material group into an ordinary MSH10
submesh and emits a runtime manifest plus one transform per spatial cell.
The resulting geometry therefore uses ModelManager, InstancedModelRenderer,
TextureStreamer, culling, diagnostics, and asset picking like every other
demo drawable.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import struct
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np


HEADER_BYTES = 44
TNM_HEADER = struct.Struct("<4sIIII6f")
MSH10_HEADER = struct.Struct("<4sIIII6f")


def read_tnm(path: Path) -> dict[str, Any]:
    raw = gzip.decompress(path.read_bytes()) if path.suffix.lower() == ".gz" else path.read_bytes()
    if len(raw) < HEADER_BYTES:
        raise ValueError(f"truncated TNM: {path}")
    magic, version, vertices, indices, groups, *bounds = TNM_HEADER.unpack_from(raw)
    if magic != b"TNM1" or version not in (2, 3, 4):
        raise ValueError(f"expected TNM v2/v3/v4: {path}")
    cursor = HEADER_BYTES
    if version == 2:
        # Retained early Nordschleife sectors use quantized TNM2. Two large
        # visual sectors (19/25) were silently excluded when the later spatial
        # compiler accepted only absolute-position v3/v4, despite containing
        # 994k valid triangles. Decode them to the same absolute float space.
        packed = np.frombuffer(raw, dtype="<u2", count=vertices * 3, offset=cursor).reshape(-1, 3)
        minimum = np.asarray(bounds[:3], dtype=np.float32)
        span = np.asarray(bounds[3:], dtype=np.float32)
        positions = minimum + packed.astype(np.float32) * (span / np.float32(65535.0))
        cursor += vertices * 6
    else:
        positions = np.frombuffer(raw, dtype="<f4", count=vertices * 3, offset=cursor).reshape(-1, 3)
        cursor += vertices * 12
    normals = np.frombuffer(raw, dtype=np.int8, count=vertices * 3, offset=cursor).reshape(-1, 3)
    cursor += vertices * 3
    tangents = None
    if version >= 4:
        tangents = np.frombuffer(raw, dtype=np.int8, count=vertices * 3, offset=cursor).reshape(-1, 3)
        cursor += vertices * 3
    uvs = np.frombuffer(raw, dtype="<f4", count=vertices * 2, offset=cursor).reshape(-1, 2)
    cursor += vertices * 8
    index_data = np.frombuffer(raw, dtype="<u4", count=indices, offset=cursor)
    return {
        "positions": positions,
        "normals": normals,
        "tangents": tangents,
        "uvs": uvs,
        "indices": index_data,
        "group_count": groups,
    }


def align(payload: bytearray, multiple: int) -> None:
    payload.extend(b"\0" * ((-len(payload)) % multiple))


def derive_tangents(
    positions: np.ndarray,
    normals_i8: np.ndarray,
    uvs: np.ndarray,
    indices: np.ndarray,
) -> np.ndarray:
    """Build a signed tangent frame from the retained position/UV streams.

    TNM v3 does not contain tangents.  Treating that as "the mesh has no
    tangents" made the unified renderer intentionally drop every authored
    normal, maps, and normal-detail texture on the largest track sector.
    Rebuilding the frame is lossless with respect to the retained attributes
    and also supplies the handedness byte that TNM v4 itself does not store.
    """
    vertex_count = len(positions)
    tangents = np.zeros((vertex_count, 3), dtype=np.float64)
    bitangents = np.zeros((vertex_count, 3), dtype=np.float64)
    triangles = indices.reshape(-1, 3)
    p0, p1, p2 = positions[triangles[:, 0]], positions[triangles[:, 1]], positions[triangles[:, 2]]
    uv0, uv1, uv2 = uvs[triangles[:, 0]], uvs[triangles[:, 1]], uvs[triangles[:, 2]]
    edge1, edge2 = p1 - p0, p2 - p0
    duv1, duv2 = uv1 - uv0, uv2 - uv0
    determinant = duv1[:, 0] * duv2[:, 1] - duv1[:, 1] * duv2[:, 0]
    valid = np.isfinite(determinant) & (np.abs(determinant) > 1e-12)
    reciprocal = np.zeros_like(determinant, dtype=np.float64)
    reciprocal[valid] = 1.0 / determinant[valid]
    triangle_tangent = (edge1 * duv2[:, 1, None] - edge2 * duv1[:, 1, None]) * reciprocal[:, None]
    triangle_bitangent = (edge2 * duv1[:, 0, None] - edge1 * duv2[:, 0, None]) * reciprocal[:, None]
    triangle_tangent[~valid] = 0.0
    triangle_bitangent[~valid] = 0.0
    for corner in range(3):
        np.add.at(tangents, triangles[:, corner], triangle_tangent)
        np.add.at(bitangents, triangles[:, corner], triangle_bitangent)

    normals = normals_i8.astype(np.float64) / 127.0
    normal_length = np.linalg.norm(normals, axis=1)
    valid_normal = normal_length > 1e-8
    normals[valid_normal] /= normal_length[valid_normal, None]
    normals[~valid_normal] = (0.0, 0.0, 1.0)
    tangents -= normals * np.sum(normals * tangents, axis=1, keepdims=True)
    tangent_length = np.linalg.norm(tangents, axis=1)
    valid_tangent = tangent_length > 1e-8
    tangents[valid_tangent] /= tangent_length[valid_tangent, None]

    # Stable orthogonal fallback for degenerate/missing UV triangles.
    fallback_axis = np.zeros_like(normals)
    use_x = np.abs(normals[:, 0]) < 0.9
    fallback_axis[use_x, 0] = 1.0
    fallback_axis[~use_x, 1] = 1.0
    fallback = np.cross(fallback_axis, normals)
    fallback /= np.maximum(np.linalg.norm(fallback, axis=1, keepdims=True), 1e-8)
    tangents[~valid_tangent] = fallback[~valid_tangent]
    handedness = np.where(
        # The unified shader follows CodeWalker BasicVS and reconstructs B as
        # cross(T, N) * tangent.w (the reverse of the common cross(N, T)).
        np.sum(np.cross(tangents, normals) * bitangents, axis=1) < 0.0,
        -127,
        127,
    ).astype(np.int8)
    packed = np.empty((vertex_count, 4), dtype=np.int8)
    packed[:, :3] = np.rint(np.clip(tangents, -1.0, 1.0) * 127.0).astype(np.int8)
    packed[:, 3] = handedness
    return packed


def msh10(group: dict[str, np.ndarray], origin: np.ndarray) -> tuple[bytes, dict[str, Any]]:
    indices = group["indices"]
    used, inverse = np.unique(indices, return_inverse=True)
    positions = group["positions"][used].astype(np.float32) - origin
    normals = group["normals"][used].astype(np.int8)
    uvs = group["uvs"][used].astype(np.float16)
    # Always derive a complete tangent frame. TNM v3 has no tangent stream and
    # TNM v4 has xyz only, so copying either form cannot provide reliable
    # mirrored-UV handedness to the renderer.
    tangents = derive_tangents(positions, normals, group["uvs"][used].astype(np.float64), inverse)

    minimum = positions.min(axis=0).astype(np.float32)
    maximum = positions.max(axis=0).astype(np.float32)
    extent = np.maximum(maximum - minimum, np.float32(1e-5))
    packed_pos = np.rint(np.clip((positions - minimum) / extent, 0.0, 1.0) * 65535.0).astype("<u2")
    flags = 1 | 2 | 1024 | 2048
    if tangents is not None:
        flags |= 4
    local_indices = inverse.astype("<u2" if len(used) <= 65535 else "<u4")
    if local_indices.dtype.itemsize == 2:
        flags |= 512

    payload = bytearray(MSH10_HEADER.pack(
        b"MSH0", 10, len(used), len(local_indices), flags,
        *minimum.tolist(), *extent.tolist(),
    ))
    payload.extend(packed_pos.tobytes())
    payload.extend(normals.tobytes())
    align(payload, 2)
    payload.extend(uvs.astype("<f2").tobytes())
    if tangents is not None:
        payload.extend(tangents.tobytes())
    align(payload, 4)
    payload.extend(local_indices.tobytes())
    center = ((minimum + maximum) * 0.5).tolist()
    radius = float(np.linalg.norm((maximum - minimum) * 0.5))
    return bytes(payload), {
        "min": minimum.tolist(), "max": maximum.tolist(), "center": center, "radius": radius,
        "vertices": int(len(used)), "indices": int(len(local_indices)),
    }


def texture_ref(value: Any, texture_root: str) -> str | None:
    raw = str(value or "").replace("\\", "/").strip()
    if not raw:
        return None
    return f"{texture_root.rstrip('/')}/{Path(raw).name}"


def material_for(group: dict[str, Any], texture_root: str) -> dict[str, Any]:
    textures = group.get("textures") if isinstance(group.get("textures"), dict) else {}
    props = group.get("properties") if isinstance(group.get("properties"), dict) else {}
    vectors = group.get("propertyVectors") if isinstance(group.get("propertyVectors"), dict) else {}
    color = group.get("color") if isinstance(group.get("color"), list) else [255, 255, 255]
    ref = lambda key: texture_ref(textures.get(key), texture_root)
    diffuse = ref("diffuse")
    authored_normal = ref("normal")
    normal_detail = ref("normalDetail") or ref("detailNormal")
    normal = authored_normal or normal_detail
    detail_mult = vectors.get("detailnmmult") or []
    scalar_detail = props.get("detailuvmultiplier", props.get("detailuvmult", 1.0))
    scale_x = float(scalar_detail) if math.isfinite(float(scalar_detail or 0.0)) and float(scalar_detail or 0.0) > 0 else 1.0
    scale_y = scale_x
    if len(detail_mult) > 1 and math.isfinite(float(detail_mult[1])) and float(detail_mult[1]) > 0:
        scale_x = float(detail_mult[1])
        scale_y = float(detail_mult[2]) if len(detail_mult) > 2 and math.isfinite(float(detail_mult[2])) and float(detail_mult[2]) > 0 else scale_x
    alpha_ref = float(props.get("ksalpharef", 0.33) or 0.33)
    specular = max(0.0, float(props.get("ksspecular", 0.0) or 0.0))
    tarmac_specular = float(props.get("tarmacspecularmultiplier", 0.0) or 0.0)
    if tarmac_specular > 0:
        specular *= tarmac_specular
    detail_normal_blend = max(0.0, float(props.get("detailnormalblend", 1.0) or 1.0))
    alpha_scale = float(props.get("alpha", 1.0) or 1.0)
    result: dict[str, Any] = {
        "shaderName": str(group.get("shader") or "track"),
        "shaderFamily": "basic",
        "alphaMode": str(group.get("alphaMode") or "opaque"),
        "alphaCutoff": max(0.0, min(1.0, alpha_ref)),
        "alphaScale": max(0.0, min(1.0, alpha_scale)),
        "doubleSided": True,
        "minDrawDistance": max(0.0, float(group.get("lodIn", 0.0) or 0.0)),
        "maxDrawDistance": max(0.0, float(group.get("lodOut", 0.0) or 0.0)),
        # The compiler palette is an untextured fallback, not a tint. Applying
        # it to an authored diffuse map makes every surface dark green/grey.
        "baseColor": [1.0, 1.0, 1.0] if diffuse else [max(0, min(255, int(v))) / 255.0 for v in color[:3]],
        "specularIntensity": specular,
        "specularPower": max(1.0, float(props.get("ksspecularexp", 10.0) or 10.0)),
        "specularFresnel": max(0.0, float(props.get("fresnelc", 0.0) or 0.0)),
        "reflectionIntensity": max(0.0, float(props.get("fresnelmaxlevel", 0.0) or 0.0)),
        "fresnelPower": max(0.5, float(props.get("fresnelexp", 5.0) or 5.0)),
        "emissiveIntensity": max(0.0, float(props.get("ksemissive", 0.0) or 0.0)),
        "detailSettings": [0.0, detail_normal_blend, max(0.001, scale_x), max(0.001, scale_y)],
        # Preserve the complete authored Kunos material for the unified shader.
        "trackMaterial": {
            "name": str(group.get("material") or "track"),
            "shader": str(group.get("shader") or "track"),
            "properties": props,
            "propertyVectors": vectors,
            "textures": {},
            "nodeTransparent": bool(group.get("nodeTransparent", False)),
            "castShadows": bool(group.get("castShadows", True)),
            "layer": int(group.get("layer", 0) or 0),
            "lodIn": max(0.0, float(group.get("lodIn", 0.0) or 0.0)),
            "lodOut": max(0.0, float(group.get("lodOut", 0.0) or 0.0)),
        },
    }
    channel_map = {
        "diffuse": "diffuse", "normal": "normal", "detail": "trackDetailColor",
        "maps": "spec", "mask": "trackMask", "detailNormal": "trackDetailNormal",
        "normalDetail": "trackNormalDetail", "variation": "trackVariation",
        "detailR": "trackDetailR", "detailG": "trackDetailG",
        "detailB": "trackDetailB", "detailA": "trackDetailA",
    }
    use_detail = float(props.get("usedetail", 0.0) or 0.0) > 0.5
    for source, target in channel_map.items():
        value = ref(source)
        if value:
            result["trackMaterial"]["textures"][source] = value
            # Kunos materials often retain a txDetail binding while useDetail
            # is zero. It is metadata in that state, not an active color layer.
            if source != "detail" or use_detail:
                result[target] = value
    if normal:
        result["normal"] = normal
    # Kunos NMDetail shaders carry a color-detail map and a separate normal
    # detail map. The generic renderer's `detail` slot is the latter.
    if authored_normal and normal_detail:
        result["detail"] = normal_detail
    return result


def identity_with_translation(origin: list[float]) -> list[float]:
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, origin[0], origin[1], origin[2], 1]


def build(args: argparse.Namespace) -> None:
    scene_path = args.scene.resolve()
    scene = json.loads(scene_path.read_text(encoding="utf-8"))
    appended_scenes = [path.resolve() for path in (args.append_scene or [])]
    out_dir = args.output.resolve()
    pack_dir = out_dir / "packs"
    pack_dir.mkdir(parents=True, exist_ok=True)
    cell_entries: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    decoded_cache: dict[str, dict[str, Any]] = {}
    seen_sources: set[str] = set()
    for current_scene_path in [scene_path, *appended_scenes]:
        current_scene = scene if current_scene_path == scene_path else json.loads(current_scene_path.read_text(encoding="utf-8"))
        default_cell_size = int(current_scene.get("spatialPartition", {}).get("cellSize") or args.cell_size)
        for model in current_scene.get("models", []):
            groups = model.get("groups") or []
            if not groups:
                continue
            source_name = str(model.get("source") or model.get("file"))
            if source_name in seen_sources:
                raise ValueError(f"duplicate source across input scenes: {source_name}")
            seen_sources.add(source_name)
            model_path = current_scene_path.parent / str(model["file"])
            decoded = read_tnm(model_path)
            decoded_cache[str(model_path)] = decoded
            if decoded["group_count"] != len(groups):
                raise ValueError(f"group count mismatch for {model_path}")
            emitted_group = 0
            for material_group_index, meta in enumerate(groups):
                offset, count = int(meta["offset"]), int(meta["count"])
                source_indices = decoded["indices"][offset:offset + count]
                cell = meta.get("spatialCell") or {}
                partitions: list[tuple[int, int, np.ndarray]] = []
                if all(k in cell for k in ("x", "y", "size")):
                    partitions.append((int(cell["x"]), int(cell["y"]), source_indices))
                    cell_size = int(cell["size"])
                else:
                    if len(source_indices) < 3 or len(source_indices) % 3:
                        continue
                    cell_size = default_cell_size
                    triangles = source_indices.reshape(-1, 3)
                    centroids = decoded["positions"][triangles].mean(axis=1)
                    triangle_cells = np.floor(centroids[:, :2] / float(cell_size)).astype(np.int32)
                    unique_cells, inverse_cells = np.unique(triangle_cells, axis=0, return_inverse=True)
                    for partition_index, (cell_x, cell_y) in enumerate(unique_cells.tolist()):
                        partitions.append((int(cell_x), int(cell_y), triangles[inverse_cells == partition_index].reshape(-1)))
                for cell_x, cell_y, partition_indices in partitions:
                    split_meta = dict(meta)
                    split_meta["spatialCell"] = {"x": cell_x, "y": cell_y, "size": cell_size}
                    cell_entries[(cell_x, cell_y)].append({
                        "decoded": decoded, "indices": partition_indices,
                        "meta": split_meta, "source": source_name,
                        "dynamic": model.get("dynamic"),
                        "group_index": emitted_group,
                        "material_group_index": material_group_index,
                        "size": cell_size,
                    })
                    emitted_group += 1

    meshes: dict[str, Any] = {}
    instances: list[dict[str, Any]] = []
    pack_revisions: dict[str, str] = {}
    pack_payloads: dict[tuple[int, int], bytearray] = defaultdict(bytearray)
    pack_fixups: list[tuple[dict[str, Any], tuple[int, int], int, int]] = []
    totals = defaultdict(int)
    for cell_index, ((cell_x, cell_y), groups) in enumerate(sorted(cell_entries.items())):
        size = groups[0]["size"]
        origin = np.array([cell_x * size, cell_y * size, 0.0], dtype=np.float32)
        archetype = str(args.hash_base + cell_index)
        subs = []
        union_min = np.array([np.inf, np.inf, np.inf], dtype=np.float64)
        union_max = np.array([-np.inf, -np.inf, -np.inf], dtype=np.float64)
        macro = (cell_x // args.pack_cells, cell_y // args.pack_cells)
        for sequence, item in enumerate(groups):
            decoded = item["decoded"]
            raw, bounds = msh10({
                "positions": decoded["positions"], "normals": decoded["normals"],
                "tangents": decoded["tangents"], "uvs": decoded["uvs"], "indices": item["indices"],
            }, origin)
            pack = pack_payloads[macro]
            offset = len(pack)
            pack.extend(raw)
            file_slot: dict[str, Any] = {}
            pack_fixups.append((file_slot, macro, offset, len(raw)))
            union_min = np.minimum(union_min, bounds["min"])
            union_max = np.maximum(union_max, bounds["max"])
            submesh = {
                "fileSlot": file_slot,
                "material": material_for(item["meta"], args.texture_root),
                "bounds": {k: bounds[k] for k in ("min", "max", "center")},
                "radius": bounds["radius"],
                "vertexCount": bounds["vertices"],
                "indexCount": bounds["indices"],
                "hasNormals": True,
                "hasUvs": True,
                "hasTangents": True,
                "loadPriority": 50,
                "trackSource": item["source"], "trackGroup": item["group_index"],
                "trackMaterialGroup": item.get("material_group_index", item["group_index"]),
            }
            if item.get("dynamic"):
                submesh["trackDynamic"] = item["dynamic"]
            subs.append(submesh)
            totals["submeshes"] += 1
            totals["vertices"] += bounds["vertices"]
            totals["indices"] += bounds["indices"]
        for sub in subs:
            sub["file"] = sub.pop("fileSlot")["file"] if "file" in sub["fileSlot"] else "__pending__"
        center = ((union_min + union_max) * 0.5).tolist()
        bounds = {"min": union_min.tolist(), "max": union_max.tolist(), "center": center}
        radius = float(np.linalg.norm((union_max - union_min) * 0.5))
        meshes[archetype] = {
            "name": f"nordschleife_cell_{cell_x}_{cell_y}",
            "bounds": bounds,
            "radius": radius,
            "supermesh": {"cell": f"track:{cell_x}:{cell_y}", "sourcePartCount": len(groups)},
            "lods": {"high": {"submeshes": subs, "bounds": bounds, "radius": radius}},
        }
        instances.append({"hash": archetype, "lod": "high", "matrix": identity_with_translation(origin.tolist()),
                          "cell": [cell_x, cell_y], "loadPriority": 50})

    # Resolve pack refs after deterministic payload construction.
    pack_names: dict[tuple[int, int], str] = {}
    pack_tag = "".join(ch for ch in str(args.pack_tag or "") if ch.isalnum() or ch in ("-", "_"))
    pack_tag = f"_{pack_tag}" if pack_tag else ""
    for macro, payload in sorted(pack_payloads.items()):
        name = f"track_nordschleife{pack_tag}_{macro[0]}_{macro[1]}.meshpack"
        target = pack_dir / name
        target.write_bytes(payload)
        # ModelManager deliberately prefers deterministic gzip sidecars for
        # binary packs because browser DecompressionStream can expand them
        # without depending on proxy/server Content-Encoding behaviour.
        target.with_name(f"{target.name}.gz").write_bytes(gzip.compress(bytes(payload), compresslevel=7, mtime=0))
        digest = hashlib.sha256(payload).hexdigest()[:16]
        pack_names[macro] = f"tracks/nordschleife/packs/{name}"
        pack_revisions[pack_names[macro]] = digest
        totals["packBytes"] += len(payload)
    # fileSlot dicts are shared with the temporary records; replace pending refs.
    for slot, macro, offset, length in pack_fixups:
        slot["file"] = f"@demo-pack/{pack_names[macro]}#{offset}:{length}"
    for mesh in meshes.values():
        for sub in mesh["lods"]["high"]["submeshes"]:
            # The first pass could not retain the shared slot after pop; reconstruct
            # refs in the same deterministic cell/group order below.
            if sub["file"] == "__pending__":
                slot, _, _, _ = pack_fixups.pop(0)
                sub["file"] = slot["file"]

    source_coverage: dict[str, Any] = {
        "spatialScene": str(scene.get("id") or ""),
        "appendedScenes": [
            {
                "id": str(appended.get("id") or ""),
                "sources": [str(model.get("source") or model.get("file") or "") for model in (appended.get("models") or [])],
            }
            for appended in (
                json.loads(path.read_text(encoding="utf-8")) for path in appended_scenes
            )
        ],
        "tangentPolicy": "derived-from-position-normal-uv-indices",
        "allSubmeshesHaveSignedTangents": True,
    }
    if args.source_scene:
        authored_scene = json.loads(args.source_scene.resolve().read_text(encoding="utf-8"))
        authored_counts = {
            str(model.get("source") or model.get("file") or ""): sum(
                int(group.get("count") or 0) for group in (model.get("groups") or [])
            )
            for model in (authored_scene.get("models") or [])
        }
        spatial_counts = {
            str(model.get("source") or model.get("file") or ""): sum(
                int(group.get("count") or 0) for group in (model.get("groups") or [])
            )
            for model in (scene.get("models") or [])
        }
        source_coverage.update({
            "authoredScene": str(authored_scene.get("id") or ""),
            "indexDeltas": [
                {
                    "source": source_name,
                    "authoredIndices": int(authored_counts.get(source_name, 0)),
                    "spatialIndices": int(spatial_counts.get(source_name, 0)),
                    "delta": int(spatial_counts.get(source_name, 0) - authored_counts.get(source_name, 0)),
                }
                for source_name in sorted(set(authored_counts) | set(spatial_counts))
                if authored_counts.get(source_name, 0) != spatial_counts.get(source_name, 0)
            ],
        })
    output = {
        "schema": "webglgta-demo-track-import-v1", "track": "nordschleife",
        "sourceScene": scene.get("id"), "meshes": meshes, "instances": instances,
        "meshPackRevisions": pack_revisions,
        "sourceCoverage": source_coverage,
        "stats": {"cells": len(instances), **{k: int(v) for k, v in totals.items()}},
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "demo_renderer.json").write_text(json.dumps(output, separators=(",", ":")), encoding="utf-8")
    print(json.dumps(output["stats"], indent=2))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scene", type=Path, required=True, help="spatially-packed scene.json")
    parser.add_argument("--source-scene", type=Path, help="pre-spatial scene.json used for source delta accounting")
    parser.add_argument("--append-scene", type=Path, action="append", default=[], help="additional authored scene to spatialize and merge")
    parser.add_argument("--cell-size", type=int, default=512, help="cell size for appended non-spatial scenes")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--texture-root", default="tracks/nordschleife/scene_full_v3/textures")
    parser.add_argument("--hash-base", type=int, default=3900000000)
    parser.add_argument("--pack-cells", type=int, default=4, help="cells per mesh-pack side")
    parser.add_argument("--pack-tag", default="", help="revision tag for atomic side-by-side deployment")
    build(parser.parse_args())


if __name__ == "__main__":
    main()

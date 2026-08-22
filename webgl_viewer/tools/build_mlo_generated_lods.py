#!/usr/bin/env python3
"""Generate compact medium/low LODs for heavy static children of imported MLOs."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import re
import struct
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np

from build_spawn_district_demo import _quantize_mesh_payload


STREAMS = (
    ("normals", 1, 2, 3, "<f4"),
    ("uvs", 2, 3, 2, "<f4"),
    ("uv1", 16, 6, 2, "<f4"),
    ("uv2", 32, 7, 2, "<f4"),
    ("tangents", 4, 4, 4, "<f4"),
    ("color0", 8, 5, 4, "u1"),
    ("color1", 64, 7, 4, "u1"),
    ("blend_weights", 128, 8, 4, "u1"),
    ("blend_indices", 256, 8, 4, "u1"),
)


def read_ent1(path: Path) -> tuple[list[bytes], int]:
    raw = path.read_bytes()
    if raw[:4] != b"ENT1" or len(raw) < 8:
        raise ValueError(f"not an ENT1 stream: {path}")
    count = struct.unpack_from("<I", raw, 4)[0]
    for stride in (64, 48, 44):
        if len(raw) == 8 + count * stride:
            return [raw[8 + i * stride:8 + (i + 1) * stride] for i in range(count)], stride
    raise ValueError(f"unsupported ENT1 layout: {path}")


def decode_delta_indices(raw: bytes, offset: int, count: int) -> np.ndarray:
    indices = np.empty(count, dtype=np.uint32)
    cursor = offset
    previous = 0
    for index in range(count):
        value = 0
        shift = 0
        while True:
            if cursor >= len(raw) or shift > 28:
                raise ValueError("invalid MSH10 delta-index stream")
            byte = raw[cursor]
            cursor += 1
            value |= (byte & 0x7f) << shift
            if not byte & 0x80:
                break
            shift += 7
        delta = (value >> 1) ^ -(value & 1)
        previous = (previous + delta) & 0xffffffff
        indices[index] = previous
    if cursor != len(raw):
        raise ValueError("unexpected bytes after MSH10 delta indices")
    return indices


def parse_mesh(raw: bytes) -> dict[str, Any]:
    if len(raw) < 20 or raw[:4] != b"MSH0":
        raise ValueError("not an MSH0 mesh")
    version, vertex_count, index_count, flags = struct.unpack_from("<4I", raw, 4)
    if version == 10:
        if len(raw) < 44:
            raise ValueError("truncated MSH10 header")
        minimum = np.asarray(struct.unpack_from("<3f", raw, 20), dtype=np.float32)
        extent = np.asarray(struct.unpack_from("<3f", raw, 32), dtype=np.float32)
        cursor = 44
        disk_positions = np.frombuffer(raw, "<u2", vertex_count * 3, cursor).reshape(vertex_count, 3)
        positions = minimum + (disk_positions.astype(np.float32) / 65535.0) * extent
        cursor += vertex_count * 6
        streams: dict[str, np.ndarray] = {}
        if flags & 1:
            width = 3 if flags & 2048 else 4
            streams["normals"] = (
                np.frombuffer(raw, "i1", vertex_count * width, cursor)
                .reshape(vertex_count, width)[:, :3].astype(np.float32) / 127.0
            )
            cursor += vertex_count * width
            if flags & 2048:
                cursor = (cursor + 1) & ~1
        for name, flag in (("uvs", 2), ("uv1", 16), ("uv2", 32)):
            if flags & flag:
                streams[name] = np.frombuffer(raw, "<f2", vertex_count * 2, cursor).reshape(vertex_count, 2).astype(np.float32)
                cursor += vertex_count * 4
        if flags & 4:
            streams["tangents"] = (
                np.frombuffer(raw, "i1", vertex_count * 4, cursor).reshape(vertex_count, 4).astype(np.float32) / 127.0
            )
            cursor += vertex_count * 4
        for name, flag in (("color0", 8), ("color1", 64), ("blend_weights", 128), ("blend_indices", 256)):
            if flags & flag:
                streams[name] = np.frombuffer(raw, "u1", vertex_count * 4, cursor).reshape(vertex_count, 4).copy()
                cursor += vertex_count * 4
        cursor = (cursor + 3) & ~3
        if flags & 4096:
            flat_indices = decode_delta_indices(raw, cursor, index_count)
        else:
            dtype = "<u2" if flags & 512 else "<u4"
            flat_indices = np.frombuffer(raw, dtype, index_count, cursor).astype(np.uint32)
            if cursor + index_count * np.dtype(dtype).itemsize != len(raw):
                raise ValueError("unexpected MSH10 index payload length")
        legacy_flags = flags & (1 | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256)
        return {
            "version": 8,
            "flags": legacy_flags,
            "positions": positions,
            "streams": streams,
            "faces": flat_indices.reshape(-1, 3).astype(np.int32),
        }
    if not 1 <= version <= 8:
        raise ValueError(f"expected MSH0 version 1-8 or 10, got {version}")
    cursor = 20
    positions = np.frombuffer(raw, "<f4", vertex_count * 3, cursor).reshape(vertex_count, 3).copy()
    cursor += vertex_count * 12
    streams: dict[str, np.ndarray] = {}
    for name, flag, minimum_version, width, dtype in STREAMS:
        if version >= minimum_version and flags & flag:
            item_size = np.dtype(dtype).itemsize
            streams[name] = np.frombuffer(raw, dtype, vertex_count * width, cursor).reshape(vertex_count, width).copy()
            cursor += vertex_count * width * item_size
    end = cursor + index_count * 4
    if end != len(raw):
        raise ValueError(f"unexpected legacy mesh size: expected {end}, got {len(raw)}")
    indices = np.frombuffer(raw, "<u4", index_count, cursor).reshape(-1, 3).astype(np.int32)
    return {"version": version, "flags": flags, "positions": positions, "streams": streams, "faces": indices}


def remap_stream(values: np.ndarray, mapping: np.ndarray, output_count: int, *, normalize_xyz: bool = False) -> np.ndarray:
    valid = mapping >= 0
    sums = np.zeros((output_count, values.shape[1]), dtype=np.float64)
    counts = np.zeros(output_count, dtype=np.float64)
    np.add.at(sums, mapping[valid], values[valid].astype(np.float64))
    np.add.at(counts, mapping[valid], 1.0)
    result = sums / np.maximum(counts[:, None], 1.0)
    if normalize_xyz and result.shape[1] >= 3:
        lengths = np.linalg.norm(result[:, :3], axis=1)
        nonzero = lengths > 1e-12
        result[nonzero, :3] /= lengths[nonzero, None]
        # Opposing source frames can cancel during an edge collapse. Retain a
        # stable contributing frame rather than emitting a zero normal/tangent.
        if not np.all(nonzero):
            first_source = np.full(output_count, -1, dtype=np.int64)
            for source_index, target_index in enumerate(mapping):
                if target_index >= 0 and first_source[target_index] < 0:
                    first_source[target_index] = source_index
            repair = (~nonzero) & (first_source >= 0)
            result[repair, :3] = values[first_source[repair], :3]
            repaired_lengths = np.linalg.norm(result[repair, :3], axis=1)
            result[repair, :3] /= np.maximum(repaired_lengths[:, None], 1e-12)
    if values.dtype == np.uint8:
        return np.rint(np.clip(result, 0, 255)).astype(np.uint8)
    return result.astype(np.float32)


def encode_legacy_mesh(mesh: dict[str, Any], positions: np.ndarray, faces: np.ndarray, mapping: np.ndarray) -> bytes:
    streams = mesh["streams"]
    output_streams: list[bytes] = []
    for name, _flag, _minimum_version, _width, _dtype in STREAMS:
        values = streams.get(name)
        if values is None:
            continue
        remapped = remap_stream(
            values,
            mapping,
            len(positions),
            normalize_xyz=name in {"normals", "tangents"},
        )
        if name == "tangents" and remapped.shape[1] >= 4:
            remapped[:, 3] = np.where(remapped[:, 3] < 0.0, -1.0, 1.0)
        output_streams.append(remapped.tobytes())
    header = struct.pack(
        "<4s4I", b"MSH0", mesh["version"], len(positions), int(faces.size), mesh["flags"],
    )
    return header + positions.astype("<f4").tobytes() + b"".join(output_streams) + faces.astype("<u4").tobytes()


def simplify_mesh(raw: bytes, reduction: float) -> tuple[bytes, int, int]:
    import fast_simplification

    mesh = parse_mesh(raw)
    if mesh["flags"] & (128 | 256):
        raise ValueError("skinned mesh cannot be simplified by the static MLO pass")
    source_faces = mesh["faces"]
    if len(source_faces) < 96:
        return _quantize_mesh_payload(raw)[0], len(mesh["positions"]), int(source_faces.size)
    positions, faces, collapses = fast_simplification.simplify(
        mesh["positions"],
        source_faces,
        target_reduction=reduction,
        agg=5.0,
        # Each material/cell partition is simplified independently. Retaining
        # its border is required to prevent cracks between neighbouring track
        # cells and between road/kerb material partitions.
        preserve_border=True,
        return_collapses=True,
    )
    replay_positions, replay_faces, mapping = fast_simplification.replay_simplification(
        mesh["positions"], source_faces, collapses,
    )
    # replay provides the original-to-decimated mapping needed for UV/color streams.
    if replay_faces.shape != faces.shape:
        raise ValueError("simplification replay topology mismatch")
    legacy = encode_legacy_mesh(mesh, replay_positions, replay_faces, mapping)
    packed, _changed = _quantize_mesh_payload(legacy)
    return packed, len(replay_positions), int(replay_faces.size)


def mesh_bounds(positions: np.ndarray) -> tuple[dict[str, list[float]], float]:
    minimum = positions.min(axis=0)
    maximum = positions.max(axis=0)
    center = (minimum + maximum) * 0.5
    radius = float(np.linalg.norm(maximum - minimum) * 0.5)
    return {
        "min": minimum.tolist(),
        "max": maximum.tolist(),
        "center": center.tolist(),
    }, radius


def resolve_source(assets: Path, source_assets: list[Path], relative: str) -> bytes:
    if relative.startswith("@demo-pack/"):
        match = re.match(r"^@demo-pack/([^#]+)#(\d+):(\d+)$", relative)
        if not match:
            raise ValueError(f"invalid demo-pack reference: {relative}")
        filename, offset_text, length_text = match.groups()
        pack_path = assets / "demo" / filename
        if not pack_path.is_file():
            pack_path = next(
                (root / "demo" / filename for root in source_assets if (root / "demo" / filename).is_file()),
                pack_path,
            )
        payload = pack_path.read_bytes()
        offset, length = int(offset_text), int(length_text)
        if offset < 0 or length <= 0 or offset + length > len(payload):
            raise ValueError(f"demo-pack slice outside payload: {relative}")
        return payload[offset:offset + length]
    for root in (assets, *source_assets):
        path = root / "models" / relative
        if path.is_file():
            return path.read_bytes()
    raise FileNotFoundError(relative)


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mlo-root", default="3384310300")
    parser.add_argument("--all-mlo", action="store_true")
    parser.add_argument("--assets", type=Path, default=root / ".mlo_repair_20260818" / "assets")
    parser.add_argument("--source-assets", type=Path, action="append")
    parser.add_argument("--minimum-weighted-triangles", type=int, default=20_000)
    args = parser.parse_args()

    assets = args.assets.resolve()
    source_assets = [path.resolve() for path in (args.source_assets or [root / ".walmart_import_release2" / "assets"])]
    manifest_path = assets / "demo" / "spawn_district_models_mlo.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    meshes = manifest["meshes"]
    records, stride = read_ent1(assets / "demo" / "spawn_district_entities_mlo.bin")
    root_records = [
        record for record in records
        if stride >= 64 and struct.unpack_from("<I", record, 60)[0] & 1
        and (args.all_mlo or struct.unpack_from("<I", record, 0)[0] == int(args.mlo_root))
    ]
    if not root_records:
        raise ValueError(f"MLO root {args.mlo_root} was not found")
    root_children: dict[str, Counter[int]] = {}
    for root_record in root_records:
        root_hash = str(struct.unpack_from("<I", root_record, 0)[0])
        parent_guid = struct.unpack_from("<I", root_record, 48)[0]
        counts = Counter(
            struct.unpack_from("<I", record, 0)[0]
            for record in records
            if struct.unpack_from("<I", record, 52)[0] == parent_guid
        )
        root_children.setdefault(root_hash, Counter()).update(counts)

    interactables_path = assets / "demo" / "interactables.json"
    interactables = json.loads(interactables_path.read_text(encoding="utf-8")) if interactables_path.is_file() else {}
    door_hashes = {str(door.get("archetypeHash")) for door in interactables.get("doors", [])}
    candidate_hashes = sorted({
        hash_value
        for counts in root_children.values()
        for hash_value, instance_count in counts.items()
        if hash_value not in {int(value) for value in door_hashes}
        and sum(
            int(submesh.get("indexCount") or 0) // 3
            for submesh in (((meshes.get(str(hash_value)) or {}).get("lods") or {}).get("high") or {}).get("submeshes", [])
        ) * instance_count >= args.minimum_weighted_triangles
    })

    generated_triangles: dict[int, dict[str, int]] = {}
    generated_bytes: dict[int, int] = {}
    generated_submeshes: list[tuple[dict[str, Any], bytes]] = []
    for hash_value in candidate_hashes:
        entry = meshes.get(str(hash_value))
        if not isinstance(entry, dict):
            continue
        high = (entry.get("lods") or {}).get("high")
        submeshes = high.get("submeshes") if isinstance(high, dict) else None
        if not isinstance(submeshes, list) or not submeshes:
            continue
        if any(bool(submesh.get("skinned")) for submesh in submeshes):
            continue

        lod_triangle_counts = {"high": sum(int(submesh.get("indexCount") or 0) // 3 for submesh in submeshes)}
        archetype_bytes = 0
        generated_lods: dict[str, dict[str, Any]] = {}
        for lod_name, reduction in (("med", 0.58), ("low", 0.82)):
            lod_submeshes = []
            lod_min = np.array([math.inf, math.inf, math.inf], dtype=np.float64)
            lod_max = np.array([-math.inf, -math.inf, -math.inf], dtype=np.float64)
            lod_triangles = 0
            for index, source_submesh in enumerate(submeshes):
                source_rel = str(source_submesh.get("file") or "")
                packed, vertex_count, index_count = simplify_mesh(
                    resolve_source(assets, source_assets, source_rel), reduction,
                )
                archetype_bytes += len(packed)
                lod_triangles += index_count // 3
                metadata = copy.deepcopy(source_submesh)
                metadata["vertexCount"] = vertex_count
                metadata["indexCount"] = index_count
                if not isinstance(metadata.get("bounds"), dict):
                    packed_mesh = parse_mesh(packed)
                    bounds, _radius = mesh_bounds(packed_mesh["positions"])
                    metadata["bounds"] = bounds
                generated_submeshes.append((metadata, packed))
                bounds = metadata.get("bounds") or {}
                if isinstance(bounds.get("min"), list) and isinstance(bounds.get("max"), list):
                    lod_min = np.minimum(lod_min, np.asarray(bounds["min"], dtype=np.float64))
                    lod_max = np.maximum(lod_max, np.asarray(bounds["max"], dtype=np.float64))
                lod_submeshes.append(metadata)
            lod_bounds = {
                "min": lod_min.tolist(),
                "max": lod_max.tolist(),
                "center": ((lod_min + lod_max) * 0.5).tolist(),
            }
            generated_lods[lod_name] = {
                "submeshes": lod_submeshes,
                "bounds": lod_bounds,
                "radius": float(np.linalg.norm(lod_max - lod_min) * 0.5),
            }
            lod_triangle_counts[lod_name] = lod_triangles
        entry.setdefault("lods", {}).update(generated_lods)
        entry["lodDistances"] = {"High": 14.0, "Med": 45.0, "Low": 1000.0, "VLow": 1000.0}
        generated_triangles[hash_value] = lod_triangle_counts
        generated_bytes[hash_value] = archetype_bytes

    pack_limit = 4 * 1024 * 1024
    packs: list[bytearray] = []
    pack_members: list[list[tuple[dict[str, Any], int, int]]] = []
    for metadata, raw in generated_submeshes:
        if not packs or len(packs[-1]) + len(raw) > pack_limit:
            packs.append(bytearray())
            pack_members.append([])
        offset = len(packs[-1])
        packs[-1].extend(raw)
        pack_members[-1].append((metadata, offset, len(raw)))
    revisions = manifest.setdefault("meshPackRevisions", {})
    pack_tag = "all" if args.all_mlo else str(args.mlo_root)
    for index, (payload, members) in enumerate(zip(packs, pack_members)):
        filename = f"spawn_district_mlo_lod_pack_{pack_tag}_{index}.bin"
        destination = assets / "demo" / filename
        destination.write_bytes(payload)
        revisions[filename] = hashlib.sha256(payload).hexdigest()[:16]
        for metadata, offset, length in members:
            metadata["file"] = f"@demo-pack/{filename}#{offset}:{length}"

    reports: dict[str, dict[str, int]] = {}
    for root_hash, counts in root_children.items():
        included = {hash_value: count for hash_value, count in counts.items() if hash_value in generated_triangles}
        reports[root_hash] = {
            "archetypes": len(included),
            "originalWeightedTriangles": sum(generated_triangles[h]["high"] * count for h, count in included.items()),
            "mediumWeightedTriangles": sum(generated_triangles[h]["med"] * count for h, count in included.items()),
            "lowWeightedTriangles": sum(generated_triangles[h]["low"] * count for h, count in included.items()),
            "outputBytes": sum(generated_bytes[h] for h in included),
            "packCount": len(packs),
        }
    if args.all_mlo:
        manifest["generatedMloLods"] = reports
    else:
        manifest.setdefault("generatedMloLods", {}).update(reports)
    manifest_bytes = json.dumps(manifest, separators=(",", ":")).encode("utf-8")
    manifest_path.write_bytes(manifest_bytes)

    descriptor_path = assets / "demo" / "spawn_district.json"
    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
    descriptor["sourceRevision"] = hashlib.sha256(manifest_bytes).hexdigest()[:16]
    descriptor["generatedMloLods"] = manifest["generatedMloLods"]
    descriptor_path.write_text(json.dumps(descriptor, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({
        "roots": len(reports),
        "archetypes": len(generated_triangles),
        "doorArchetypesExcluded": len(door_hashes),
        "packs": len(packs),
        "reports": reports,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

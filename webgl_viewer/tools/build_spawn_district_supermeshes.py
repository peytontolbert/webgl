#!/usr/bin/env python3
"""Bake profitable static /demo geometry into chunk-local material supermeshes.

The runtime already instances identical source meshes globally.  A bake is only
profitable when one material's unique source-mesh count exceeds the number of
spatial chunks that material occupies.  Unsafe geometry (MLOs, destructibles,
skinning, tint palettes, alpha, decals, water, and animated UVs) is retained in
the source manifest and ENT1 stream.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import re
import struct
import zlib
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np

from build_spawn_district_demo import _quantize_mesh_payload


PACK_RE = re.compile(r"^@demo-pack/([^#]+)#(\d+):(\d+)$")
LOD_ORDER = ("med", "low", "vlow", "high")
MLO_FLAG = 1


def read_ent1(path: Path) -> tuple[int, list[bytes]]:
    raw = path.read_bytes()
    if len(raw) < 8 or raw[:4] != b"ENT1":
        raise ValueError(f"not an ENT1 file: {path}")
    count = struct.unpack_from("<I", raw, 4)[0]
    for stride in (64, 48, 44):
        if len(raw) == 8 + count * stride:
            return stride, [raw[8 + i * stride:8 + (i + 1) * stride] for i in range(count)]
    raise ValueError(f"unsupported ENT1 payload: {path}")


def selected_lod(entry: dict[str, Any]) -> tuple[str, dict[str, Any]] | tuple[None, None]:
    lods = entry.get("lods") if isinstance(entry, dict) else None
    if not isinstance(lods, dict):
        return None, None
    for key in LOD_ORDER:
        if isinstance(lods.get(key), dict):
            return key, lods[key]
    return None, None


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def material_is_safe(material: dict[str, Any], submesh: dict[str, Any]) -> bool:
    shader = str(material.get("shaderName") or "").lower()
    family = str(material.get("shaderFamily") or "").lower()
    alpha = str(material.get("alphaMode") or "opaque").lower()
    return (
        alpha == "opaque"
        and not submesh.get("skinned")
        and not submesh.get("fragmentBoneTag")
        and not material.get("tintPalette")
        and not material.get("globalAnimUV0")
        and not material.get("globalAnimUV1")
        and family not in {"water", "decal"}
        and not any(token in shader for token in ("glass", "water", "decal"))
    )


def prune_redundant_texture_params(value: Any) -> int:
    """Remove legacy texture bindings already represented by normalized fields."""
    removed = 0
    if isinstance(value, dict):
        shader_params = value.get("shaderParams")
        textures = shader_params.get("texturesByHash") if isinstance(shader_params, dict) else None
        if isinstance(textures, dict):
            for key, param_hash in list(value.items()):
                if not key.endswith("ParamHash"):
                    continue
                semantic = key[:-9]
                if not value.get(semantic):
                    continue
                hash_key = str(param_hash)
                if hash_key in textures:
                    del textures[hash_key]
                    removed += 1
            if not textures:
                shader_params.pop("texturesByHash", None)
        for child in value.values():
            removed += prune_redundant_texture_params(child)
    elif isinstance(value, list):
        for child in value:
            removed += prune_redundant_texture_params(child)
    return removed


class MeshSource:
    def __init__(self, assets: Path, demo: Path):
        self.assets = assets
        self.demo = demo
        self.payload_cache: dict[str, bytes] = {}

    def payload(self, ref: str) -> bytes:
        cached = self.payload_cache.get(ref)
        if cached is not None:
            return cached
        match = PACK_RE.match(ref)
        if match:
            raw = (self.demo / match.group(1)).read_bytes()
            offset, length = int(match.group(2)), int(match.group(3))
            payload = raw[offset:offset + length]
        else:
            payload = (self.assets / "models" / ref).read_bytes()
        if len(payload) < 20 or payload[:4] != b"MSH0":
            raise ValueError(f"invalid mesh payload: {ref}")
        self.payload_cache[ref] = payload
        return payload

    def layout(self, ref: str) -> tuple[int, int]:
        raw = self.payload(ref)
        version, _vertices, _indices, flags = struct.unpack_from("<IIII", raw, 4)
        # Only attributes represented by the v8 output format affect compatibility.
        return version, flags & 0x1FF


def half_to_float(values: np.ndarray) -> np.ndarray:
    return values.view(np.float16).astype(np.float32)


def decode_indices(encoded: bytes, count: int) -> np.ndarray:
    output = np.empty(count, dtype=np.uint32)
    cursor = previous = 0
    for index in range(count):
        value = shift = 0
        while True:
            byte = encoded[cursor]
            cursor += 1
            value |= (byte & 0x7F) << shift
            if not byte & 0x80:
                break
            shift += 7
        delta = (value >> 1) ^ -(value & 1)
        previous = (previous + delta) & 0xFFFFFFFF
        output[index] = previous
    return output


def decode_mesh(raw: bytes) -> dict[str, np.ndarray | None]:
    version, vertex_count, index_count, flags = struct.unpack_from("<IIII", raw, 4)
    packed = version >= 9
    affine = version == 10
    cursor = 44 if affine else 20

    def take(width: int, dtype: str, enabled: bool = True, count: int | None = None) -> np.ndarray | None:
        nonlocal cursor
        if not enabled:
            return None
        rows = vertex_count if count is None else count
        result = np.frombuffer(raw, dtype=dtype, count=rows * width, offset=cursor).reshape(rows, width)
        cursor += result.nbytes
        return result

    disk_positions = take(3, "<u2" if packed else "<f4")
    if affine:
        minimum = np.asarray(struct.unpack_from("<3f", raw, 20), dtype=np.float32)
        extent = np.asarray(struct.unpack_from("<3f", raw, 32), dtype=np.float32)
        positions = minimum + disk_positions.astype(np.float32) * (extent / 65535.0)
    elif packed:
        positions = half_to_float(disk_positions.copy()).reshape(vertex_count, 3)
    else:
        positions = disk_positions.astype(np.float32, copy=True)

    has_normals = version >= 2 and bool(flags & 1)
    int8_normals = packed and bool(flags & 1024)
    tight_normals = int8_normals and bool(flags & 2048)
    if has_normals:
        if int8_normals:
            normals = take(3 if tight_normals else 4, "i1")[:, :3].astype(np.float32) / 127.0
            if tight_normals and cursor & 1:
                cursor += 1
        elif packed:
            normals = take(3, "<i2").astype(np.float32) / 32767.0
        else:
            normals = take(3, "<f4").astype(np.float32, copy=True)
    else:
        normals = None

    def uv(flag: int, minimum_version: int) -> np.ndarray | None:
        values = take(2, "<u2" if packed else "<f4", version >= minimum_version and bool(flags & flag))
        if values is None:
            return None
        return half_to_float(values.copy()).reshape(vertex_count, 2) if packed else values.astype(np.float32, copy=True)

    uv0 = uv(2, 3)
    uv1 = uv(16, 6)
    uv2 = uv(32, 7)
    tangents_raw = take(4, "i1" if packed else "<f4", version >= 4 and bool(flags & 4))
    tangents = None if tangents_raw is None else (tangents_raw.astype(np.float32) / 127.0 if packed else tangents_raw.astype(np.float32, copy=True))
    color0 = take(4, "u1", version >= 5 and bool(flags & 8))
    color1 = take(4, "u1", version >= 7 and bool(flags & 64))
    weights = take(4, "u1", version >= 8 and bool(flags & 128))
    bones = take(4, "u1", version >= 8 and bool(flags & 256))
    if packed:
        cursor = (cursor + 3) & ~3
    if packed and flags & 512:
        indices = decode_indices(raw[cursor:], index_count) if flags & 4096 else np.frombuffer(raw, "<u2", index_count, cursor).astype(np.uint32)
    else:
        indices = np.frombuffer(raw, "<u4", index_count, cursor).astype(np.uint32, copy=True)
    return {"positions": positions, "normals": normals, "uv0": uv0, "uv1": uv1, "uv2": uv2,
            "tangents": tangents, "color0": color0, "color1": color1, "weights": weights,
            "bones": bones, "indices": indices}


def transform_matrix(record: bytes, stride: int) -> np.ndarray:
    px, py, pz, qx, qy, qz, qw, sx, sy, sz = struct.unpack_from("<10f", record, 4)
    flags = struct.unpack_from("<I", record, 60)[0] if stride >= 64 else 0
    parent = struct.unpack_from("<I", record, 52)[0] if stride >= 64 else 0
    if not flags & MLO_FLAG and parent == 0:
        qx, qy, qz = -qx, -qy, -qz
    length = math.sqrt(qx*qx + qy*qy + qz*qz + qw*qw) or 1.0
    x, y, z, w = qx/length, qy/length, qz/length, qw/length
    rotation = np.asarray([
        [1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
        [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
        [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)],
    ], dtype=np.float32)
    matrix = np.eye(4, dtype=np.float32)
    matrix[:3, :3] = rotation @ np.diag([sx, sy, sz])
    matrix[:3, 3] = [px, py, pz]
    return matrix


def append_transformed(parts: dict[str, list[np.ndarray]], mesh: dict[str, np.ndarray | None], matrix: np.ndarray) -> None:
    positions = mesh["positions"]
    parts["positions"].append(positions @ matrix[:3, :3].T + matrix[:3, 3])
    normal_matrix = np.linalg.pinv(matrix[:3, :3]).T
    if mesh["normals"] is not None:
        normals = mesh["normals"] @ normal_matrix.T
        lengths = np.linalg.norm(normals, axis=1, keepdims=True)
        parts["normals"].append(normals / np.maximum(lengths, 1e-12))
    if mesh["tangents"] is not None:
        tangents = mesh["tangents"].copy()
        xyz = tangents[:, :3] @ normal_matrix.T
        tangents[:, :3] = xyz / np.maximum(np.linalg.norm(xyz, axis=1, keepdims=True), 1e-12)
        if np.linalg.det(matrix[:3, :3]) < 0:
            tangents[:, 3] *= -1
        parts["tangents"].append(tangents)
    for key in ("uv0", "uv1", "uv2", "color0", "color1", "weights", "bones"):
        if mesh[key] is not None:
            parts[key].append(mesh[key])
    offset = sum(len(value) for value in parts["positions"][:-1])
    indices = mesh["indices"].astype(np.uint64) + offset
    if np.linalg.det(matrix[:3, :3]) < 0:
        indices = indices.reshape(-1, 3)[:, [0, 2, 1]].reshape(-1)
    parts["indices"].append(indices.astype(np.uint32))


def write_mesh(parts: dict[str, list[np.ndarray]], path: Path, origin: np.ndarray) -> tuple[int, int, dict[str, Any], int]:
    keys = ("positions", "indices", "normals", "uv0", "uv1", "uv2", "tangents",
            "color0", "color1", "weights", "bones")
    arrays = {key: np.concatenate(parts.get(key, [])) if parts.get(key) else None for key in keys}
    positions, indices = arrays["positions"], arrays["indices"]
    positions -= origin
    flags = 0
    flags_by_key = {"normals": 1, "uv0": 2, "tangents": 4, "color0": 8, "uv1": 16,
                    "uv2": 32, "color1": 64, "weights": 128, "bones": 256}
    for key, flag in flags_by_key.items():
        if arrays[key] is not None:
            flags |= flag
    streams = [positions.astype("<f4").tobytes()]
    # MSH0 stores UV1/UV2 before tangents and colors regardless of flag values.
    for key in ("normals", "uv0", "uv1", "uv2", "tangents", "color0", "color1", "weights", "bones"):
        value = arrays[key]
        if value is not None:
            streams.append(value.astype("u1" if key in {"color0", "color1", "weights", "bones"} else "<f4").tobytes())
    raw = struct.pack("<4sIIII", b"MSH0", 8, len(positions), len(indices), flags) + b"".join(streams) + indices.astype("<u4").tobytes()
    packed, _ = _quantize_mesh_payload(raw)
    path.write_bytes(packed)
    minimum, maximum = positions.min(axis=0), positions.max(axis=0)
    center = (minimum + maximum) * 0.5
    radius = float(np.linalg.norm((maximum - minimum) * 0.5))
    bounds = {"min": minimum.tolist(), "max": maximum.tolist(), "center": center.tolist()}
    return len(positions), len(indices), bounds, len(packed)


def identity_record(hash_id: int, center: list[float]) -> bytes:
    return struct.pack("<I3f4f3f5I", hash_id, *center, 0.0, 0.0, 0.0, 1.0,
                       1.0, 1.0, 1.0, 0, 0, 0, 0, 0)


def is_mlo_record(record: bytes, stride: int) -> bool:
    if stride < 64:
        return False
    return bool(struct.unpack_from("<I", record, 52)[0] or struct.unpack_from("<I", record, 60)[0])


def build(args: argparse.Namespace) -> dict[str, Any]:
    descriptor_path = args.descriptor.resolve()
    demo = descriptor_path.parent
    assets = demo.parent
    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
    source_manifest_rel = str(args.source_manifest or descriptor["manifestFile"])
    source_instance_rel = str(descriptor.get("sourceInstanceFile") or descriptor["instanceFile"])
    source_manifest_path = assets / source_manifest_rel
    staged_manifest_path = demo / Path(source_manifest_rel).name
    if staged_manifest_path.is_file():
        source_manifest_path = staged_manifest_path
    source_instance_path = assets / source_instance_rel
    staged_instance_path = demo / Path(source_instance_rel).name
    if staged_instance_path.is_file():
        source_instance_path = staged_instance_path
    manifest = json.loads(source_manifest_path.read_text(encoding="utf-8"))
    stride, records = read_ent1(source_instance_path)
    source_revision_hash = hashlib.sha256()
    source_revision_hash.update(source_instance_path.read_bytes())
    source_revision_hash.update(source_manifest_path.read_bytes())
    source_revision = source_revision_hash.hexdigest()[:16]
    by_hash: dict[str, list[bytes]] = defaultdict(list)
    for record in records:
        by_hash[str(struct.unpack_from("<I", record, 0)[0])].append(record)
    destructibles = json.loads((demo / "spawn_district_destructibles.json").read_text(encoding="utf-8"))
    blocked = {str(item.get("archetypeHash")) for item in destructibles.get("destructibles", [])}
    # A FiveM resource can replace a base-world drawable while retaining its
    # archetype hash. Never bake those replacements into static supermeshes;
    # doing so can preserve an older GTA shell beside the resource mesh.
    blocked.update(
        str(value)
        for value in (manifest.get("mloImport") or {}).get("worldDrawableOverrides", [])
    )
    source = MeshSource(assets, demo)

    candidates: dict[tuple[str, tuple[int, int]], list[dict[str, Any]]] = defaultdict(list)
    for hash_id, entity_records in by_hash.items():
        if hash_id in blocked or any(is_mlo_record(record, stride) for record in entity_records):
            continue
        entry = manifest.get("meshes", {}).get(hash_id)
        lod_key, lod = selected_lod(entry)
        if not lod:
            continue
        entry_material = entry.get("material") if isinstance(entry.get("material"), dict) else {}
        for index, submesh in enumerate(lod.get("submeshes") or []):
            material = dict(entry_material)
            if isinstance(submesh.get("material"), dict):
                material.update(submesh["material"])
            if not material_is_safe(material, submesh):
                continue
            ref = str(submesh.get("file") or "")
            if not ref:
                continue
            key = (canonical(material), source.layout(ref))
            candidates[key].append({"hash": hash_id, "lod": lod_key, "index": index, "ref": ref,
                                    "material": material, "records": entity_records})

    chosen: list[tuple[tuple[str, tuple[int, int]], list[dict[str, Any]]]] = []
    for key, items in candidates.items():
        files = {item["ref"] for item in items}
        cells = {f"{math.floor(struct.unpack_from('<f', record, 4)[0] / args.chunk_size)}_"
                 f"{math.floor(struct.unpack_from('<f', record, 8)[0] / args.chunk_size)}"
                 for item in items for record in item["records"]}
        if len(files) - len(cells) >= args.min_draw_savings:
            chosen.append((key, items))

    output_dir = demo / "spawn_district_supermeshes"
    output_dir.mkdir(parents=True, exist_ok=True)
    for stale in output_dir.glob("*.bin"):
        stale.unlink()
    used_hashes = {int(value) for value in manifest.get("meshes", {}) if str(value).isdigit()}
    synthetic_records: list[bytes] = []
    generated_submeshes: list[tuple[dict[str, Any], Path]] = []
    stripped: dict[tuple[str, str], set[int]] = defaultdict(set)
    generated_bytes = 0
    generated_draws = 0

    for (material_json, _layout), items in chosen:
        material = json.loads(material_json)
        cell_items: dict[str, list[tuple[dict[str, Any], bytes]]] = defaultdict(list)
        for item in items:
            stripped[(item["hash"], item["lod"])].add(item["index"])
            for record in item["records"]:
                x, y = struct.unpack_from("<2f", record, 4)
                cell_items[f"{math.floor(x / args.chunk_size)}_{math.floor(y / args.chunk_size)}"].append((item, record))
        for cell, contributions in cell_items.items():
            parts: dict[str, list[np.ndarray]] = defaultdict(list)
            decoded: dict[str, dict[str, np.ndarray | None]] = {}
            for item, record in contributions:
                mesh = decoded.get(item["ref"])
                if mesh is None:
                    mesh = decode_mesh(source.payload(item["ref"]))
                    decoded[item["ref"]] = mesh
                append_transformed(parts, mesh, transform_matrix(record, stride))
            digest = hashlib.sha1((cell + material_json + str(_layout)).encode("utf-8")).hexdigest()[:16]
            filename = f"static_{cell}_{digest}.bin"
            cell_x, cell_y = (int(value) for value in cell.split("_", 1))
            origin = np.asarray([(cell_x + 0.5) * args.chunk_size, (cell_y + 0.5) * args.chunk_size, 0.0], dtype=np.float32)
            mesh_path = output_dir / filename
            vertex_count, index_count, bounds, byte_count = write_mesh(parts, mesh_path, origin)
            generated_bytes += byte_count
            seed = zlib.crc32(f"supermesh:{digest}".encode("ascii")) | 0x80000000
            while seed in used_hashes:
                seed = (seed + 1) & 0xFFFFFFFF
            used_hashes.add(seed)
            radius = float(np.linalg.norm((np.asarray(bounds["max"]) - np.asarray(bounds["min"])) * 0.5))
            generated_submesh = {"file": "",
                    "vertexCount": vertex_count, "indexCount": index_count, "material": material,
                    "bounds": bounds, "radius": radius}
            generated_submeshes.append((generated_submesh, mesh_path))
            manifest["meshes"][str(seed)] = {
                "lods": {"med": {"submeshes": [generated_submesh], "bounds": bounds, "radius": radius}},
                "lodDistances": {"High": 90, "Med": 220, "Low": 520, "VLow": 1200},
                "material": {}, "bounds": bounds, "radius": radius,
                "supermesh": {
                    "cell": cell,
                    "sourcePartCount": len(contributions),
                    "sourceInstanceCount": len({record for _item, record in contributions}),
                    "sourceArchetypeHashes": sorted(
                        {item["hash"] for item, _record in contributions}, key=int
                    ),
                    "sourceRevision": source_revision,
                },
            }
            synthetic_records.append(identity_record(seed, origin.tolist()))
            generated_draws += 1

    pack_target = max(1024 * 1024, int(args.pack_target_mib * 1024 * 1024))
    pack_index = 0
    pending: list[tuple[dict[str, Any], Path, bytes]] = []
    pending_bytes = 0

    def flush_pack() -> None:
        nonlocal pack_index, pending, pending_bytes
        if not pending:
            return
        payload = b"".join(raw for _submesh, _path, raw in pending)
        digest = hashlib.sha256(payload).hexdigest()[:16]
        pack_name = f"static_pack_{pack_index:03d}_{digest}.bin"
        (output_dir / pack_name).write_bytes(payload)
        offset = 0
        for submesh, path, raw in pending:
            submesh["file"] = f"@demo-pack/spawn_district_supermeshes/{pack_name}#{offset}:{len(raw)}"
            offset += len(raw)
            path.unlink()
        pack_index += 1
        pending = []
        pending_bytes = 0

    for submesh, path in generated_submeshes:
        raw = path.read_bytes()
        if pending and pending_bytes + len(raw) > pack_target:
            flush_pack()
        pending.append((submesh, path, raw))
        pending_bytes += len(raw)
    flush_pack()

    for (hash_id, lod_key), indices in stripped.items():
        lod = manifest["meshes"][hash_id]["lods"][lod_key]
        lod["submeshes"] = [value for index, value in enumerate(lod.get("submeshes") or []) if index not in indices]

    redundant_texture_params = prune_redundant_texture_params(manifest.get("meshes", {}))
    manifest["schema"] = "webglgta-demo-supermesh-manifest-v1"
    manifest["supermesh"] = {"chunkSize": args.chunk_size, "generatedDraws": generated_draws,
                             "strippedSourceSubmeshes": sum(len(value) for value in stripped.values()),
                             "generatedBytes": generated_bytes,
                             "prunedTextureParams": redundant_texture_params,
                             "sourceRevision": source_revision}
    manifest_name = "spawn_district_models_supermesh.json"
    (demo / manifest_name).write_text(json.dumps(manifest, separators=(",", ":")) + "\n", encoding="utf-8")

    ent_name = "spawn_district_entities_supermesh.bin"
    with (demo / ent_name).open("wb") as handle:
        handle.write(b"ENT1")
        handle.write(struct.pack("<I", len(records) + len(synthetic_records)))
        handle.writelines(records)
        handle.writelines(synthetic_records)

    all_records = records + synthetic_records
    chunks: dict[str, list[bytes]] = defaultdict(list)
    z_values = []
    for record in all_records:
        x, y, z = struct.unpack_from("<3f", record, 4)
        chunks[f"{math.floor(x / args.chunk_size)}_{math.floor(y / args.chunk_size)}"].append(record)
        z_values.append(z)
    chunks_dir = demo / "spawn_district_supermesh_chunks"
    chunks_dir.mkdir(parents=True, exist_ok=True)
    chunk_index = {}
    chunk_revision = hashlib.sha256()
    for cell, values in sorted(chunks.items()):
        filename = f"{cell}.bin"
        payload = b"ENT1" + struct.pack("<I", len(values)) + b"".join(values)
        with (chunks_dir / filename).open("wb") as handle:
            handle.write(payload)
        chunk_revision.update(cell.encode("ascii"))
        chunk_revision.update(payload)
        chunk_index[cell] = {"count": len(values), "file": filename,
                             "binaryFile": f"demo/spawn_district_supermesh_chunks/{filename}"}
    index_name = "spawn_district_entities_supermesh_index.json"
    bounds = descriptor["bounds"]
    index = {"version": 1, "schema": "webglgta-demo-entity-chunks-v1",
             "revision": chunk_revision.hexdigest()[:16], "chunk_size": args.chunk_size,
             "chunks_dir": "demo/spawn_district_supermesh_chunks", "total_entities": len(all_records),
             "bounds": {"min_x": bounds["minX"], "min_y": bounds["minY"], "min_z": min(z_values),
                        "max_x": bounds["maxX"], "max_y": bounds["maxY"], "max_z": max(z_values)},
             "chunks": dict(sorted(chunk_index.items()))}
    (demo / index_name).write_text(json.dumps(index, separators=(",", ":")) + "\n", encoding="utf-8")

    descriptor["sourceManifestFile"] = source_manifest_rel
    descriptor.setdefault("sourceInstanceFile", descriptor["instanceFile"])
    descriptor.setdefault("sourceInstanceIndexFile", descriptor.get("instanceIndexFile"))
    descriptor["staticSupermesh"] = {"schema": "webglgta-demo-static-supermesh-v1", "enabled": True,
        "manifestFile": f"demo/{manifest_name}", "instanceFile": f"demo/{ent_name}",
        "instanceIndexFile": f"demo/{index_name}", "chunkSize": args.chunk_size,
        "generatedDraws": generated_draws, "generatedBytes": generated_bytes,
        "strippedSourceSubmeshes": sum(len(value) for value in stripped.values()),
        "prunedTextureParams": redundant_texture_params,
        "sourceRevision": source_revision}
    descriptor_path.write_text(json.dumps(descriptor, indent=2) + "\n", encoding="utf-8")
    return descriptor["staticSupermesh"] | {"sourceInstances": len(records), "syntheticInstances": len(synthetic_records)}


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--descriptor", type=Path, default=root / "assets/demo/spawn_district.json")
    parser.add_argument("--source-manifest", default=None, help="Asset-relative compressed manifest to bake (defaults to descriptor manifestFile).")
    parser.add_argument("--config", type=Path, default=root / "demo_world.json")
    parser.add_argument("--chunk-size", type=float, default=None)
    parser.add_argument("--min-draw-savings", type=int, default=2)
    parser.add_argument("--pack-target-mib", type=float, default=8.0)
    args = parser.parse_args()
    config = json.loads(args.config.resolve().read_text(encoding="utf-8"))
    streaming = config.get("streaming") if isinstance(config.get("streaming"), dict) else {}
    if args.chunk_size is None:
        args.chunk_size = float(streaming.get("entityChunkSize", 256.0))
    if args.pack_target_mib == 8.0 and "supermeshPackMiB" in streaming:
        args.pack_target_mib = float(streaming["supermeshPackMiB"])
    if args.chunk_size <= 0 or args.min_draw_savings < 1:
        parser.error("chunk size and minimum draw savings must be positive")
    print(json.dumps(build(args), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

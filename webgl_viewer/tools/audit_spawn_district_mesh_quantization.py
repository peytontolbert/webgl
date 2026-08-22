#!/usr/bin/env python3
"""Verify compact demo meshes preserve source geometry within tolerance."""

from __future__ import annotations

import json
import re
import struct
from pathlib import Path
from typing import Any

import numpy as np

from build_spawn_district_demo import _lod_files, _manifest_entries, _selected_lod


PACK_RE = re.compile(r"^@demo-pack/(?P<name>[^#]+)#(?P<offset>\d+):(?P<length>\d+)$")


def legacy_indices(raw: bytes) -> tuple[np.ndarray, np.ndarray, int]:
    magic, version, vertex_count, index_count, flags = struct.unpack_from("<4sIIII", raw)
    if magic != b"MSH0" or not 1 <= version <= 8:
        raise ValueError("unsupported source mesh")
    positions = np.frombuffer(raw, dtype="<f4", count=vertex_count * 3, offset=20).reshape(vertex_count, 3)
    cursor = 20 + vertex_count * 12
    for enabled, width, item_bytes in (
        (version >= 2 and bool(flags & 1), 3, 4),
        (version >= 3 and bool(flags & 2), 2, 4),
        (version >= 6 and bool(flags & 16), 2, 4),
        (version >= 7 and bool(flags & 32), 2, 4),
        (version >= 4 and bool(flags & 4), 4, 4),
        (version >= 5 and bool(flags & 8), 4, 1),
        (version >= 7 and bool(flags & 64), 4, 1),
        (version >= 8 and bool(flags & 128), 4, 1),
        (version >= 8 and bool(flags & 256), 4, 1),
    ):
        if enabled:
            cursor += vertex_count * width * item_bytes
    indices = np.frombuffer(raw, dtype="<u4", count=index_count, offset=cursor)
    if cursor + index_count * 4 != len(raw):
        raise ValueError("source mesh length mismatch")
    return positions, indices, flags


def packed_indices(raw: bytes) -> tuple[np.ndarray, np.ndarray, int]:
    magic, version, vertex_count, index_count, flags = struct.unpack_from("<4sIIII", raw)
    if magic != b"MSH0" or version not in (9, 10):
        raise ValueError("packed mesh is not MSH9/MSH10")
    if version == 10:
        position_min = np.asarray(struct.unpack_from("<3f", raw, 20), dtype=np.float32)
        position_extent = np.asarray(struct.unpack_from("<3f", raw, 32), dtype=np.float32)
        quantized = np.frombuffer(raw, dtype="<u2", count=vertex_count * 3, offset=44).astype(np.float32).reshape(vertex_count, 3)
        positions = position_min + (quantized / 65535.0) * position_extent
        cursor = 44 + vertex_count * 6
    else:
        positions = np.frombuffer(raw, dtype="<f2", count=vertex_count * 3, offset=20).astype(np.float32).reshape(vertex_count, 3)
        cursor = 20 + vertex_count * 6
    if flags & 1:
        cursor += vertex_count * (3 if flags & 1024 and flags & 2048 else (4 if flags & 1024 else 6))
        if flags & 1024 and flags & 2048:
            cursor = (cursor + 1) & ~1
    for flag, width, item_bytes in (
        (2, 2, 2), (16, 2, 2), (32, 2, 2), (4, 4, 1),
        (8, 4, 1), (64, 4, 1), (128, 4, 1), (256, 4, 1),
    ):
        if flags & flag:
            cursor += vertex_count * width * item_bytes
    cursor = (cursor + 3) & ~3
    if flags & 4096:
        indices = np.empty(index_count, dtype=np.uint32)
        previous = 0
        for index in range(index_count):
            value = shift = 0
            while True:
                byte = raw[cursor]
                cursor += 1
                value |= (byte & 0x7F) << shift
                if not byte & 0x80:
                    break
                shift += 7
            delta = (value >> 1) ^ -(value & 1)
            previous = (previous + delta) & 0xFFFFFFFF
            indices[index] = previous
    else:
        dtype = "<u2" if flags & 512 else "<u4"
        indices = np.frombuffer(raw, dtype=dtype, count=index_count, offset=cursor).astype(np.uint32)
        cursor += index_count * np.dtype(dtype).itemsize
    if cursor != len(raw):
        raise ValueError("packed mesh length mismatch")
    return positions, indices, flags


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo-dir", type=Path, default=Path(__file__).resolve().parents[1] / "assets" / "demo")
    parser.add_argument("--manifest", default="", help="Optional manifest filename inside --demo-dir.")
    args = parser.parse_args()

    assets = Path(__file__).resolve().parents[1] / "assets"
    demo_dir = args.demo_dir.resolve()
    descriptor = json.loads((demo_dir / "spawn_district.json").read_text(encoding="utf-8"))
    manifest_name = Path(str(args.manifest or descriptor.get("manifestFile") or "demo/spawn_district_models.json")).name
    demo = json.loads((demo_dir / manifest_name).read_text(encoding="utf-8"))
    hashes = set(demo.get("meshes", {}))
    original = _manifest_entries(assets, hashes).get("meshes", {})
    packs: dict[str, bytes] = {}
    compared = failures = 0
    max_position_error = 0.0
    samples: list[dict[str, Any]] = []

    for hash_id, demo_entry in demo.get("meshes", {}).items():
        source_entry = original.get(hash_id)
        demo_files = _lod_files(_selected_lod(demo_entry, "med"))
        source_files = _lod_files(_selected_lod(source_entry, "med"))
        if len(demo_files) != len(source_files):
            failures += 1
            samples.append({"hash": hash_id, "error": "file count mismatch"})
            continue
        for packed_ref, source_relative in zip(demo_files, source_files):
            match = PACK_RE.match(packed_ref)
            if not match:
                failures += 1
                samples.append({"hash": hash_id, "file": source_relative, "error": "not packed"})
                continue
            pack_name = match.group("name")
            pack = packs.setdefault(pack_name, (demo_dir / pack_name).read_bytes())
            offset = int(match.group("offset"))
            length = int(match.group("length"))
            try:
                source = (assets / "models" / source_relative).read_bytes()
                packed = pack[offset:offset + length]
                source_positions, source_indices, _source_flags = legacy_indices(source)
                packed_positions, packed_index_values, _packed_flags = packed_indices(packed)
                if not np.array_equal(source_indices, packed_index_values):
                    raise ValueError("index stream differs from source")
                position_error = float(np.max(np.abs(source_positions - packed_positions))) if source_positions.size else 0.0
                extent = float(np.max(np.ptp(source_positions, axis=0))) if source_positions.size else 0.0
                tolerance = max(0.001, extent / 65535.0 * 1.1)
                if position_error > tolerance:
                    raise ValueError(f"position error {position_error:.6f} exceeds {tolerance:.6f}")
                max_position_error = max(max_position_error, position_error)
                compared += 1
            except (OSError, IndexError, TypeError, ValueError, struct.error) as error:
                failures += 1
                if len(samples) < 20:
                    samples.append({"hash": hash_id, "file": source_relative, "error": str(error)})

    result = {
        "compared": compared,
        "failures": failures,
        "packCount": len(packs),
        "geometryValid": failures == 0,
        "maxPositionError": max_position_error,
        "samples": samples[:20],
    }
    print(json.dumps(result, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

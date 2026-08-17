#!/usr/bin/env python3
"""Validate a staged CWCT static-collision compile without changing it."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct


HEADER = struct.Struct("<4sIIIIIII")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--source-bin", type=Path, required=True)
    args = parser.parse_args()
    manifest_path = args.manifest.resolve()
    root = manifest_path.parent
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema") != "webglgta-static-collision-v1":
        raise ValueError("unexpected static collision manifest schema")
    expected_source_hash = str(manifest.get("source", {}).get("sha256") or "")
    actual_source_hash = sha256(args.source_bin.resolve())
    if actual_source_hash != expected_source_hash:
        raise ValueError("source fingerprint differs from the staged compile manifest")

    total_bytes = 0
    total_triangles = 0
    total_ground_refs = 0
    total_wall_refs = 0
    u16_chunks = 0
    u32_chunks = 0
    for chunk_id, item in (manifest.get("chunks") or {}).items():
        path = root / str(item["file"])
        data = path.read_bytes()
        if len(data) < HEADER.size:
            raise ValueError(f"{chunk_id}: truncated header")
        magic, version, flags, vertex_count, triangle_count, ground_refs, wall_refs, cell_count = HEADER.unpack_from(data)
        if magic != b"CWCT" or version != 4 or flags & ~0b11:
            raise ValueError(f"{chunk_id}: unsupported chunk header")
        index_bytes = 4 if flags & 1 else 2
        reference_bytes = 4 if flags & 2 else 2
        expected_size = (
            HEADER.size
            + 16  # minZ, maxZ, broad-phase cell size, reserved
            + vertex_count * 3 * 2
            + triangle_count * 3 * index_bytes
            + triangle_count * 2
            + (cell_count + 1) * 4 + ground_refs * reference_bytes
            + (cell_count + 1) * 4 + wall_refs * reference_bytes
        )
        if len(data) != expected_size or len(data) != int(item["byte_length"]):
            raise ValueError(f"{chunk_id}: byte length mismatch")
        if int(item.get("material_count", triangle_count)) != triangle_count:
            raise ValueError(f"{chunk_id}: material stream is not aligned with triangles")
        total_bytes += len(data)
        total_triangles += triangle_count
        total_ground_refs += ground_refs
        total_wall_refs += wall_refs
        if flags:
            u32_chunks += 1
        else:
            u16_chunks += 1

    report = {
        "valid": True,
        "chunks": len(manifest.get("chunks") or {}),
        "compiled_bytes": total_bytes,
        "source_bytes": int(manifest["source"]["byte_length"]),
        "source_sha256": actual_source_hash,
        "source_triangles": int(manifest["source"]["triangle_count"]),
        "chunk_triangle_copies": total_triangles,
        "ground_reference_copies": total_ground_refs,
        "wall_reference_copies": total_wall_refs,
        "u16_only_chunks": u16_chunks,
        "mixed_or_u32_chunks": u32_chunks,
        "material_palette_entries": len(manifest.get("surface_materials") or []),
    }
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

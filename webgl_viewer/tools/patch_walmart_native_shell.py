#!/usr/bin/env python3
"""Carve the Walmart MLO takeover aperture out of the native mall shell."""

from __future__ import annotations

import argparse
import json
import math
import struct
from pathlib import Path


ARCHETYPE_HASH = "2185785507"
PATCHED_SUBMESHES = (3, 4, 18)
ROOT_COS = 0.6424
ROOT_SIN = 0.7664
NATIVE_MINUS_MLO_ROOT = (1.6252133, 3.0769418)


def mesh_layout(data: bytes) -> tuple[int, int, int, int]:
    magic, version, vertex_count, index_count, flags = struct.unpack_from("<4s4I", data, 0)
    if magic != b"MSH0" or version not in range(1, 8):
        raise ValueError(f"unsupported mesh header: magic={magic!r}, version={version}")
    offset = 20 + vertex_count * 12
    for flag, minimum_version, bytes_per_vertex in (
        (1, 2, 12),
        (2, 3, 8),
        (16, 6, 8),
        (32, 7, 8),
        (4, 4, 16),
        (8, 5, 4),
        (64, 7, 4),
    ):
        if version >= minimum_version and flags & flag:
            offset += vertex_count * bytes_per_vertex
    if offset + index_count * 4 > len(data):
        raise ValueError("truncated mesh index stream")
    return vertex_count, index_count, flags, offset


def root_local(vertex: tuple[float, float, float]) -> tuple[float, float, float]:
    dx = vertex[0] + NATIVE_MINUS_MLO_ROOT[0]
    dy = vertex[1] + NATIVE_MINUS_MLO_ROOT[1]
    return (
        ROOT_COS * dx + ROOT_SIN * dy,
        -ROOT_SIN * dx + ROOT_COS * dy,
        vertex[2],
    )


def should_remove(vertices: tuple[tuple[float, float, float], ...]) -> bool:
    transformed = tuple(root_local(vertex) for vertex in vertices)
    centroid = tuple(sum(vertex[axis] for vertex in transformed) / 3 for axis in range(3))
    ab = tuple(transformed[1][axis] - transformed[0][axis] for axis in range(3))
    ac = tuple(transformed[2][axis] - transformed[0][axis] for axis in range(3))
    normal = (
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    )
    magnitude = math.sqrt(sum(value * value for value in normal))
    vertical = magnitude > 0 and abs(normal[2] / magnitude) < 0.3
    min_z = min(vertex[2] for vertex in transformed)
    max_z = max(vertex[2] for vertex in transformed)
    return (
        vertical
        and -9.0 <= centroid[0] <= 20.0
        and 6.25 <= centroid[1] <= 7.8
        and max_z >= -7.4
        and min_z <= 2.8
    )


def patch_mesh(source: Path, destination: Path) -> tuple[int, int]:
    data = source.read_bytes()
    vertex_count, index_count, _flags, index_offset = mesh_layout(data)
    positions = tuple(struct.iter_unpack("<3f", data[20:20 + vertex_count * 12]))
    indices = struct.unpack_from(f"<{index_count}I", data, index_offset)
    retained: list[int] = []
    removed = 0
    for offset in range(0, index_count, 3):
        triangle_indices = indices[offset:offset + 3]
        vertices = tuple(positions[index] for index in triangle_indices)
        if should_remove(vertices):
            removed += 1
        else:
            retained.extend(triangle_indices)
    if not removed:
        raise ValueError(f"takeover aperture matched no triangles in {source}")
    output = bytearray(data[:index_offset])
    struct.pack_into("<I", output, 12, len(retained))
    output.extend(struct.pack(f"<{len(retained)}I", *retained))
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(output)
    return removed, len(retained)


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=Path, default=root / ".mlo_repair_20260818" / "assets")
    parser.add_argument("--source-models", type=Path, default=root / "assets" / "models")
    args = parser.parse_args()

    assets = args.assets.resolve()
    manifest_path = assets / "demo" / "spawn_district_models_mlo.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    submeshes = manifest["meshes"][ARCHETYPE_HASH]["lods"]["high"]["submeshes"]
    total_removed = 0
    for submesh_index in PATCHED_SUBMESHES:
        filename = f"{ARCHETYPE_HASH}_high_{submesh_index}.bin"
        relative = Path("mlo_overrides") / ARCHETYPE_HASH / filename
        removed, retained_indices = patch_mesh(
            args.source_models.resolve() / filename,
            assets / "models" / relative,
        )
        submeshes[submesh_index]["file"] = relative.as_posix()
        submeshes[submesh_index]["indexCount"] = retained_indices
        total_removed += removed
        print(f"submesh {submesh_index}: removed {removed} triangles, retained {retained_indices} indices")

    manifest_path.write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
    print(f"removed {total_removed} native triangles from the Walmart takeover aperture")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

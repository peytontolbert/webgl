#!/usr/bin/env python3
"""Compile a YBNC tile into independently streamable static-collision chunks.

This is deliberately a *derived-data* compiler.  It never writes the input YBNC
file, its metadata, render meshes, or the asset-collider manifest.  YBNC contains
the authored static world collision (YBN); movable/interactable entity colliders
are intentionally not an input to this tool.

Each output chunk preserves every source triangle whose XY bounds overlap the
source tile. Positions are quantized to unsigned 16-bit values within the source
geometry bounds (normally sub-centimetre error), vertices are local to a chunk, and the
existing ground/wall broad-phase classification is retained.  The chunks can be
loaded independently by a browser runtime instead of loading the whole tile.

Example (from repository root):
  python webgl_viewer/tools/compile_static_collision.py
"""

from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path
import shutil
import struct
from typing import Iterator


MAGIC = b"CWCT"
VERSION = 4
CHUNK_HEADER = struct.Struct("<4sIIIIIII")
# magic, version, flags, vertex count, triangle count, ground ref count, wall
# ref count, cell count. Bit 0 selects U32 local indices; bit 1 selects U32
# grid references. Most chunks stay U16, while unusually dense chunks remain
# complete without special-casing or data loss.


def source_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_ybnc(meta_path: Path) -> dict:
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    source_path = (meta_path.parent / str(meta["file"])).resolve()
    data = source_path.read_bytes()
    if len(data) < 44 or data[:4] != b"YBNC":
        raise ValueError(f"{source_path}: not a packed YBNC tile")
    version, vertex_count, index_count = struct.unpack_from("<III", data, 4)
    if version not in (3, 4) or index_count % 3:
        raise ValueError(f"{source_path}: unsupported YBNC v{version}")
    cell_size, min_gx, min_gy, width, height, reference_count, wall_reference_count = struct.unpack_from(
        "<fiiIIII", data, 16
    )
    cell_count = width * height
    offset = 44
    vertices_bytes = vertex_count * 12
    indices_bytes = index_count * 4
    grid_offsets_bytes = (cell_count + 1) * 4
    references_bytes = reference_count * 4
    wall_offsets_bytes = (cell_count + 1) * 4
    wall_references_bytes = wall_reference_count * 4
    material_bytes = (index_count // 3) * 2 if version >= 4 else 0
    expected = offset + vertices_bytes + indices_bytes + grid_offsets_bytes + references_bytes + wall_offsets_bytes + wall_references_bytes + material_bytes
    if len(data) != expected:
        raise ValueError(f"{source_path}: truncated or unsupported size ({len(data)}, expected {expected})")
    view = memoryview(data)
    vertices = view[offset:offset + vertices_bytes].cast("f")
    offset += vertices_bytes
    indices = view[offset:offset + indices_bytes].cast("I")
    offset += indices_bytes
    # The source ground grid captures an important authored distinction: a
    # vertical BoundPolygonTriangle can be a wall but must also remain available
    # to a vertical ground query.  Retain that exact membership rather than
    # trying to infer polygon type from the flattened triangle stream.
    offset += grid_offsets_bytes
    source_ground_triangle_ids = frozenset(int(value) // 3 for value in view[offset:offset + references_bytes].cast("I"))
    triangle_material_offset = 44 + vertices_bytes + indices_bytes + grid_offsets_bytes + references_bytes + wall_offsets_bytes + wall_references_bytes
    triangle_materials = view[triangle_material_offset:triangle_material_offset + material_bytes].cast("H") if material_bytes else None
    bounds = meta.get("bounds") or {}
    min_x, min_y, max_x, max_y = (float(bounds[key]) for key in ("min_x", "min_y", "max_x", "max_y"))
    if not all(math.isfinite(value) for value in (min_x, min_y, max_x, max_y)) or max_x <= min_x or max_y <= min_y:
        raise ValueError(f"{meta_path}: invalid XY bounds")
    return {
        "meta": meta,
        "meta_path": meta_path,
        "path": source_path,
        "sha256": source_sha256(source_path),
        "vertices": vertices,
        "indices": indices,
        "vertex_count": vertex_count,
        "triangle_count": index_count // 3,
        "ground_triangle_ids": source_ground_triangle_ids,
        "triangle_materials": triangle_materials,
        "material_palette": list(meta.get("surface_materials") or []),
        "bounds": (min_x, min_y, max_x, max_y),
        "geometry_bounds": (
            min(float(value) for value in vertices[0::3]), min(float(value) for value in vertices[1::3]), min(float(value) for value in vertices[2::3]),
            max(float(value) for value in vertices[0::3]), max(float(value) for value in vertices[1::3]), max(float(value) for value in vertices[2::3]),
        ),
        "source_grid_cell_size": float(cell_size),
        "source_grid": {"min_gx": min_gx, "min_gy": min_gy, "width": width, "height": height},
    }


def triangle_normal_is_wall(vertices: memoryview, indices: memoryview, triangle_index: int, threshold: float) -> bool:
    offset = triangle_index * 3
    ia, ib, ic = indices[offset] * 3, indices[offset + 1] * 3, indices[offset + 2] * 3
    ax, ay, az = vertices[ia], vertices[ia + 1], vertices[ia + 2]
    bx, by, bz = vertices[ib], vertices[ib + 1], vertices[ib + 2]
    cx, cy, cz = vertices[ic], vertices[ic + 1], vertices[ic + 2]
    e1x, e1y, e1z = bx - ax, by - ay, bz - az
    e2x, e2y, e2z = cx - ax, cy - ay, cz - az
    nx = e1y * e2z - e1z * e2y
    ny = e1z * e2x - e1x * e2z
    nz = e1x * e2y - e1y * e2x
    length = math.sqrt(nx * nx + ny * ny + nz * nz)
    return length >= 1e-7 and math.hypot(nx, ny) / length >= threshold


def triangle_bounds_xy(vertices: memoryview, indices: memoryview, triangle_index: int) -> tuple[float, float, float, float]:
    offset = triangle_index * 3
    ids = (indices[offset] * 3, indices[offset + 1] * 3, indices[offset + 2] * 3)
    xs = (vertices[ids[0]], vertices[ids[1]], vertices[ids[2]])
    ys = (vertices[ids[0] + 1], vertices[ids[1] + 1], vertices[ids[2] + 1])
    return min(xs), min(ys), max(xs), max(ys)


def quantize(value: float, low: float, high: float) -> int:
    if high <= low:
        return 0
    return max(0, min(65535, int(round((value - low) * 65535.0 / (high - low)))))


def iter_chunk_ids(bounds: tuple[float, float, float, float], chunk_size: float) -> Iterator[tuple[int, int]]:
    min_x, min_y, max_x, max_y = bounds
    for gy in range(math.floor(min_y / chunk_size), math.floor(max_y / chunk_size) + 1):
        for gx in range(math.floor(min_x / chunk_size), math.floor(max_x / chunk_size) + 1):
            yield gx, gy


def write_chunk(
    path: Path,
    source: dict,
    triangle_ids: list[int],
    chunk_bounds: tuple[float, float, float, float],
    chunk_size: float,
    broadphase_cell_size: float,
    wall_threshold: float,
) -> dict:
    vertices: memoryview = source["vertices"]
    indices: memoryview = source["indices"]
    min_x, min_y, _min_z, max_x, max_y, _max_z = source["geometry_bounds"]
    used = sorted({int(indices[triangle * 3 + corner]) for triangle in triangle_ids for corner in range(3)})
    source_to_local = {source_id: local_id for local_id, source_id in enumerate(used)}
    local_vertices: list[int] = []
    z_values: list[float] = []
    for source_id in used:
        offset = source_id * 3
        z_values.append(float(vertices[offset + 2]))
    min_z, max_z = min(z_values), max(z_values)
    if max_z - min_z < 1e-6:
        max_z = min_z + 1e-6
    for source_id in used:
        offset = source_id * 3
        local_vertices.extend((
            quantize(float(vertices[offset]), min_x, max_x),
            quantize(float(vertices[offset + 1]), min_y, max_y),
            quantize(float(vertices[offset + 2]), min_z, max_z),
        ))
    local_indices: list[int] = []
    local_materials: list[int] = []
    ground_by_cell: dict[int, list[int]] = defaultdict(list)
    walls_by_cell: dict[int, list[int]] = defaultdict(list)
    chunk_min_x, chunk_min_y, chunk_max_x, chunk_max_y = chunk_bounds
    cells_per_side = max(1, round(chunk_size / broadphase_cell_size))
    actual_cell_size = chunk_size / cells_per_side
    for local_triangle, source_triangle in enumerate(triangle_ids):
        source_offset = source_triangle * 3
        local_indices.extend(source_to_local[int(indices[source_offset + corner])] for corner in range(3))
        source_materials = source.get("triangle_materials")
        local_materials.append(int(source_materials[source_triangle]) if source_materials is not None else 0)
        tri_min_x, tri_min_y, tri_max_x, tri_max_y = triangle_bounds_xy(vertices, indices, source_triangle)
        wall = triangle_normal_is_wall(vertices, indices, source_triangle, wall_threshold)
        gx0 = max(0, min(cells_per_side - 1, math.floor((tri_min_x - chunk_min_x) / actual_cell_size)))
        gy0 = max(0, min(cells_per_side - 1, math.floor((tri_min_y - chunk_min_y) / actual_cell_size)))
        gx1 = max(0, min(cells_per_side - 1, math.floor((tri_max_x - chunk_min_x) / actual_cell_size)))
        gy1 = max(0, min(cells_per_side - 1, math.floor((tri_max_y - chunk_min_y) / actual_cell_size)))
        # Preserve YBNC's existing ground/wall membership exactly.  This avoids
        # treating primitive wall faces as walkable while retaining authored
        # triangle faces that are intentionally present in both grids.
        source_is_ground_triangle = source_triangle in source["ground_triangle_ids"]
        for gy in range(gy0, gy1 + 1):
            for gx in range(gx0, gx1 + 1):
                cell = gy * cells_per_side + gx
                if source_is_ground_triangle:
                    ground_by_cell[cell].append(local_triangle)
                if wall:
                    walls_by_cell[cell].append(local_triangle)
    cell_count = cells_per_side * cells_per_side
    ground_offsets = [0]
    ground_refs: list[int] = []
    wall_offsets = [0]
    wall_refs: list[int] = []
    for cell in range(cell_count):
        ground_refs.extend(ground_by_cell.get(cell, ()))
        ground_offsets.append(len(ground_refs))
        wall_refs.extend(walls_by_cell.get(cell, ()))
        wall_offsets.append(len(wall_refs))
    index_component_bits = 32 if len(used) > 65535 else 16
    reference_component_bits = 32 if len(triangle_ids) > 65535 else 16
    flags = (1 if index_component_bits == 32 else 0) | (2 if reference_component_bits == 32 else 0)
    index_format = "I" if index_component_bits == 32 else "H"
    reference_format = "I" if reference_component_bits == 32 else "H"
    with path.open("wb") as handle:
        handle.write(CHUNK_HEADER.pack(MAGIC, VERSION, flags, len(used), len(triangle_ids), len(ground_refs), len(wall_refs), cell_count))
        handle.write(struct.pack("<4f", min_z, max_z, actual_cell_size, 0.0))
        handle.write(struct.pack(f"<{len(local_vertices)}H", *local_vertices))
        handle.write(struct.pack(f"<{len(local_indices)}{index_format}", *local_indices))
        handle.write(struct.pack(f"<{len(local_materials)}H", *local_materials))
        handle.write(struct.pack(f"<{len(ground_offsets)}I", *ground_offsets))
        handle.write(struct.pack(f"<{len(ground_refs)}{reference_format}", *ground_refs))
        handle.write(struct.pack(f"<{len(wall_offsets)}I", *wall_offsets))
        handle.write(struct.pack(f"<{len(wall_refs)}{reference_format}", *wall_refs))
    return {
        "file": path.name,
        "bounds": {"min_x": chunk_min_x, "min_y": chunk_min_y, "max_x": chunk_max_x, "max_y": chunk_max_y, "min_z": min_z, "max_z": max_z},
        "vertex_count": len(used),
        "triangle_count": len(triangle_ids),
        "ground_reference_count": len(ground_refs),
        "wall_reference_count": len(wall_refs),
        "material_count": len(local_materials),
        "index_component_bits": index_component_bits,
        "reference_component_bits": reference_component_bits,
        "byte_length": path.stat().st_size,
    }


def compile_tile(source: dict, output_dir: Path, name: str, chunk_size: float, cell_size: float, wall_threshold: float) -> dict:
    if output_dir.exists():
        raise FileExistsError(f"Refusing to overwrite existing derived output: {output_dir}. Use --replace to replace it.")
    staging = output_dir.with_name(f"{output_dir.name}.staging")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    vertices: memoryview = source["vertices"]
    indices: memoryview = source["indices"]
    triangle_buckets: dict[tuple[int, int], list[int]] = defaultdict(list)
    source_min_x, source_min_y, source_max_x, source_max_y = source["bounds"]
    for triangle in range(source["triangle_count"]):
        tri_min_x, tri_min_y, tri_max_x, tri_max_y = triangle_bounds_xy(vertices, indices, triangle)
        clipped_bounds = (
            max(source_min_x, tri_min_x), max(source_min_y, tri_min_y),
            min(source_max_x, tri_max_x), min(source_max_y, tri_max_y),
        )
        if clipped_bounds[0] > clipped_bounds[2] or clipped_bounds[1] > clipped_bounds[3]:
            continue
        for chunk_id in iter_chunk_ids(clipped_bounds, chunk_size):
            triangle_buckets[chunk_id].append(triangle)
    chunks: dict[str, dict] = {}
    for (gx, gy), triangles in sorted(triangle_buckets.items(), key=lambda item: (item[0][1], item[0][0])):
        chunk_min_x, chunk_min_y = gx * chunk_size, gy * chunk_size
        chunk_max_x, chunk_max_y = chunk_min_x + chunk_size, chunk_min_y + chunk_size
        filename = f"{name}_{gx}_{gy}.cwct"
        chunks[f"{gx}:{gy}"] = write_chunk(
            staging / filename, source, triangles, (chunk_min_x, chunk_min_y, chunk_max_x, chunk_max_y), chunk_size, cell_size, wall_threshold
        )
    total_bytes = sum(item["byte_length"] for item in chunks.values())
    source_size = source["path"].stat().st_size
    manifest = {
        "schema": "webglgta-static-collision-v1",
        "role": "static_ybn_ground_and_building_collision",
        "source": {
            "metadata": source["meta_path"].name,
            "binary": source["path"].name,
            "sha256": source["sha256"],
            "byte_length": source_size,
            "triangle_count": source["triangle_count"],
            "vertex_count": source["vertex_count"],
        },
        "quantization": {"bits_per_component": 16, "space": "source_geometry_bounds", "maximum_axis_error": "axis_extent / 131070"},
        "surface_materials": source["material_palette"],
        "surface_material_triangle_count": source["triangle_count"],
        "chunk_size": chunk_size,
        "broadphase_cell_size": cell_size,
        "wall_normal_horizontal_threshold": wall_threshold,
        "bounds": {"min_x": source_min_x, "min_y": source_min_y, "max_x": source_max_x, "max_y": source_max_y},
        "geometry_bounds": dict(zip(("min_x", "min_y", "min_z", "max_x", "max_y", "max_z"), source["geometry_bounds"])),
        "chunk_count": len(chunks),
        "compiled_byte_length": total_bytes,
        "source_byte_length": source_size,
        "ratio_to_source": total_bytes / source_size if source_size else None,
        "chunks": chunks,
        "excludes": ["asset_colliders", "destructibles", "doors", "dynamic entities", "render geometry"],
    }
    (staging / f"{name}.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    staging.rename(output_dir)
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("webgl_viewer/assets/collision/ybn_spawn.json"))
    parser.add_argument("--output-dir", type=Path, default=Path("webgl_viewer/assets/collision/compiled/ybn_spawn"))
    parser.add_argument("--name", default="ybn_spawn_static")
    parser.add_argument("--chunk-size", type=float, default=32.0)
    parser.add_argument("--cell-size", type=float, default=8.0)
    parser.add_argument("--wall-threshold", type=float, default=0.8)
    parser.add_argument("--replace", action="store_true", help="Replace only the derived output directory.")
    args = parser.parse_args()
    if not math.isfinite(args.chunk_size) or args.chunk_size < 8:
        parser.error("--chunk-size must be at least 8 metres")
    if not math.isfinite(args.cell_size) or args.cell_size <= 0 or args.cell_size > args.chunk_size:
        parser.error("--cell-size must be positive and no larger than --chunk-size")
    if not math.isfinite(args.wall_threshold) or not 0 <= args.wall_threshold <= 1:
        parser.error("--wall-threshold must be in [0, 1]")
    source_path = args.source.resolve()
    output_dir = args.output_dir.resolve()
    if output_dir.exists() and args.replace:
        # This target is explicit and always compiler-generated.  The source remains untouched.
        shutil.rmtree(output_dir)
    source_before = source_sha256(source_path.with_name(json.loads(source_path.read_text(encoding="utf-8"))["file"]))
    source = load_ybnc(source_path)
    manifest = compile_tile(source, output_dir, str(args.name), float(args.chunk_size), float(args.cell_size), float(args.wall_threshold))
    source_after = source_sha256(source["path"])
    if source_after != source_before:
        raise RuntimeError("Source collision changed during compilation; derived output was not accepted")
    print(json.dumps({"ok": True, "output": str(output_dir), "source_unchanged": True, **{key: manifest[key] for key in ("chunk_count", "compiled_byte_length", "source_byte_length", "ratio_to_source")}}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

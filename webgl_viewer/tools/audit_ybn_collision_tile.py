#!/usr/bin/env python3
"""Validate a packed YBNC tile and compare its ground coverage to another tile."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import struct
from typing import Any


def load_tile(meta_path: Path) -> dict[str, Any]:
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    data = (meta_path.parent / meta["file"]).read_bytes()
    if len(data) < 44 or data[:4] != b"YBNC":
        raise ValueError(f"{meta_path}: invalid YBNC header")
    version, vertex_count, index_count = struct.unpack_from("<III", data, 4)
    if version != 3 or index_count % 3:
        raise ValueError(f"{meta_path}: expected YBNC v3 triangle data")
    cell_size, min_gx, min_gy, width, height, reference_count, wall_reference_count = struct.unpack_from("<fiiIIII", data, 16)
    cell_count = width * height
    offset = 44
    vertices_bytes = vertex_count * 3 * 4
    indices_bytes = index_count * 4
    cell_offsets_bytes = (cell_count + 1) * 4
    references_bytes = reference_count * 4
    wall_offsets_bytes = (cell_count + 1) * 4
    wall_references_bytes = wall_reference_count * 4
    expected_size = offset + vertices_bytes + indices_bytes + cell_offsets_bytes + references_bytes + wall_offsets_bytes + wall_references_bytes
    if len(data) != expected_size:
        raise ValueError(f"{meta_path}: size is {len(data)}, expected {expected_size}")

    view = memoryview(data)
    vertices = view[offset:offset + vertices_bytes].cast("f")
    offset += vertices_bytes
    indices = view[offset:offset + indices_bytes].cast("I")
    offset += indices_bytes
    cell_offsets = view[offset:offset + cell_offsets_bytes].cast("I")
    offset += cell_offsets_bytes
    references = view[offset:offset + references_bytes].cast("I")
    offset += references_bytes
    wall_offsets = view[offset:offset + wall_offsets_bytes].cast("I")
    offset += wall_offsets_bytes
    wall_references = view[offset:offset + wall_references_bytes].cast("I")

    if any(index >= vertex_count for index in indices):
        raise ValueError(f"{meta_path}: triangle index exceeds vertex count")
    if cell_offsets[0] != 0 or cell_offsets[-1] != reference_count:
        raise ValueError(f"{meta_path}: ground grid offsets are invalid")
    if wall_offsets[0] != 0 or wall_offsets[-1] != wall_reference_count:
        raise ValueError(f"{meta_path}: wall grid offsets are invalid")
    if any(value % 3 or value >= index_count for value in references):
        raise ValueError(f"{meta_path}: ground grid contains an invalid triangle offset")
    if any(value % 3 or value >= index_count for value in wall_references):
        raise ValueError(f"{meta_path}: wall grid contains an invalid triangle offset")

    bounds = meta["bounds"]
    return {
        "meta": meta,
        "bytes": data,
        "vertices": vertices,
        "indices": indices,
        "cellOffsets": cell_offsets,
        "references": references,
        "cellSize": float(cell_size),
        "minGX": int(min_gx),
        "minGY": int(min_gy),
        "width": int(width),
        "height": int(height),
        "bounds": (float(bounds["min_x"]), float(bounds["min_y"]), float(bounds["max_x"]), float(bounds["max_y"])),
    }


def ground_at(tile: dict[str, Any], x: float, y: float, ceiling: float = math.inf) -> float | None:
    gx = math.floor(x / tile["cellSize"])
    gy = math.floor(y / tile["cellSize"])
    local_x = gx - tile["minGX"]
    local_y = gy - tile["minGY"]
    if local_x < 0 or local_y < 0 or local_x >= tile["width"] or local_y >= tile["height"]:
        return None
    cell = local_y * tile["width"] + local_x
    best = -math.inf
    vertices = tile["vertices"]
    indices = tile["indices"]
    for reference_index in range(tile["cellOffsets"][cell], tile["cellOffsets"][cell + 1]):
        triangle_offset = tile["references"][reference_index]
        ia = indices[triangle_offset] * 3
        ib = indices[triangle_offset + 1] * 3
        ic = indices[triangle_offset + 2] * 3
        ax, ay, az = vertices[ia], vertices[ia + 1], vertices[ia + 2]
        bx, by, bz = vertices[ib], vertices[ib + 1], vertices[ib + 2]
        cx, cy, cz = vertices[ic], vertices[ic + 1], vertices[ic + 2]
        denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(denominator) < 1e-6:
            continue
        u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / denominator
        v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / denominator
        w = 1.0 - u - v
        if u < -1e-4 or v < -1e-4 or w < -1e-4:
            continue
        z = u * az + v * bz + w * cz
        if math.isfinite(z) and z <= ceiling and z > best:
            best = z
    return best if math.isfinite(best) else None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--spacing", type=float, default=5.0)
    parser.add_argument("--ceiling", type=float, default=80.0, help="Highest baseline surface considered during comparison.")
    args = parser.parse_args()
    candidate = load_tile(args.candidate.resolve())
    report: dict[str, Any] = {
        "candidate": str(args.candidate.resolve()),
        "binaryBytes": len(candidate["bytes"]),
        "vertexCount": candidate["meta"]["vertex_count"],
        "triangleCount": candidate["meta"]["triangle_count"],
        "gridReferenceCount": candidate["meta"]["grid_reference_count"],
        "wallGridReferenceCount": candidate["meta"]["wall_grid_reference_count"],
        "integrity": "passed",
    }
    if args.baseline:
        baseline = load_tile(args.baseline.resolve())
        bounds = (
            max(candidate["bounds"][0], baseline["bounds"][0]),
            max(candidate["bounds"][1], baseline["bounds"][1]),
            min(candidate["bounds"][2], baseline["bounds"][2]),
            min(candidate["bounds"][3], baseline["bounds"][3]),
        )
        spacing = max(1.0, float(args.spacing))
        counts = {
            "samples": 0,
            "baselineGround": 0,
            "candidateGround": 0,
            "baselineMissingInCandidate": 0,
            "candidateAddedGround": 0,
            "changedOver25cm": 0,
            "changedOver1m": 0,
        }
        maximum_delta = 0.0
        missing_samples: list[dict[str, float]] = []
        largest_changes: list[dict[str, float]] = []
        y = bounds[1] + spacing * 0.5
        while y < bounds[3]:
            x = bounds[0] + spacing * 0.5
            while x < bounds[2]:
                counts["samples"] += 1
                old_z = ground_at(baseline, x, y, float(args.ceiling))
                new_z = ground_at(candidate, x, y, old_z + 1.5 if old_z is not None else math.inf)
                if old_z is not None:
                    counts["baselineGround"] += 1
                if new_z is not None:
                    counts["candidateGround"] += 1
                if old_z is not None and new_z is None:
                    counts["baselineMissingInCandidate"] += 1
                    if len(missing_samples) < 20:
                        missing_samples.append({"x": x, "y": y, "baselineZ": old_z})
                elif old_z is None and new_z is not None:
                    counts["candidateAddedGround"] += 1
                elif old_z is not None and new_z is not None:
                    delta = abs(new_z - old_z)
                    maximum_delta = max(maximum_delta, delta)
                    largest_changes.append({"x": x, "y": y, "baselineZ": old_z, "candidateZ": new_z, "delta": delta})
                    if delta > 0.25:
                        counts["changedOver25cm"] += 1
                    if delta > 1.0:
                        counts["changedOver1m"] += 1
                x += spacing
            y += spacing
        largest_changes.sort(key=lambda item: item["delta"], reverse=True)
        report["comparison"] = {
            **counts,
            "maximumGroundDelta": maximum_delta,
            "spacing": spacing,
            "ceiling": float(args.ceiling),
            "missingSamples": missing_samples,
            "largestChanges": largest_changes[:20],
        }
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

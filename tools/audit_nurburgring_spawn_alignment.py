#!/usr/bin/env python3
"""Audit whether the derived AI-road spawn intersects rendered AC asphalt.

This is deliberately source-side: it reads the official KN5 meshes at the
same authored origin used by the road compiler, so a result does not depend on
the browser cache or a streamed LOD already being loaded.
"""

from __future__ import annotations

import argparse
import importlib.util
import math
import sys
from pathlib import Path


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if not spec or not spec.loader:
        raise RuntimeError(f"Cannot import {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--track-root", type=Path, required=True)
    parser.add_argument("--kn5-parser", type=Path, required=True)
    parser.add_argument("--scene-reader", type=Path, required=True)
    parser.add_argument("--origin", default="-516.27001953125,139.69944763183594,2351.260498046875")
    parser.add_argument("--radius", type=float, default=40.0)
    parser.add_argument("--source", action="append", default=[], help="KN5 filename to inspect; repeatable")
    args = parser.parse_args()
    origin = tuple(float(value) for value in args.origin.split(","))
    if len(origin) != 3:
        parser.error("--origin must contain AC X,up,Z")

    reader = load_module("ac_kn5_reader_audit", args.kn5_parser.resolve())
    scene = load_module("ac_scene_audit", args.scene_reader.resolve())
    target_x, target_up, target_z = origin
    limit_squared = args.radius * args.radius
    candidates: list[tuple[float, str, str, float, float, float]] = []

    requested = {name.lower() for name in args.source}
    sources = [path for path in sorted(args.track_root.glob("*.kn5")) if not requested or path.name.lower() in requested]
    if requested and len(sources) != len(requested):
        missing = sorted(requested - {path.name.lower() for path in sources})
        parser.error(f"source KN5 not found: {', '.join(missing)}")
    for source in sources:
        materials, nodes, _textures = scene.read_kn5_textured(reader, source)
        for node in nodes:
            if node.type not in (2, 3) or not node.indices:
                continue
            material = str(materials[node.material_id].get("name") or "track") if 0 <= node.material_id < len(materials) else "track"
            # Only real driveable-looking source surfaces can establish an
            # asphalt placement. Do not let signs/buildings skew the report.
            if not any(token in material.lower() for token in ("asph", "road", "tarmac", "kerb", "curb")):
                continue
            nearest: tuple[float, float, float, float] | None = None
            for index in range(node.vertex_count):
                x, up, z = reader._apply_mat_pos(node.hmatrix, node.pos[index * 3], node.pos[index * 3 + 1], node.pos[index * 3 + 2])
                distance_squared = (x - target_x) ** 2 + (z - target_z) ** 2
                if distance_squared <= limit_squared and (nearest is None or distance_squared < nearest[0]):
                    nearest = (distance_squared, x, up, z)
            if nearest:
                candidates.append((math.sqrt(nearest[0]), source.name, material, nearest[1], nearest[2], nearest[3]))

    candidates.sort()
    print(f"AC road origin: x={target_x:.6f}, up={target_up:.6f}, z={target_z:.6f}; radius={args.radius:.1f}m")
    if not candidates:
        print("FAIL: no rendered asphalt/kerb vertices found near the road origin")
        raise SystemExit(2)
    print("Nearest rendered drive-surface vertices:")
    for distance, source, material, x, up, z in candidates[:30]:
        print(f"  {distance:7.3f}m  {source:22s} {material:30s} at ({x:.3f}, {up:.3f}, {z:.3f})")
    nearest = candidates[0]
    vertical_offset = nearest[4] - target_up
    print(f"RESULT: nearest visual surface is {nearest[0]:.3f}m laterally from the AI start and {vertical_offset:+.3f}m vertically.")


if __name__ == "__main__":
    main()

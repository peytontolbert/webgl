#!/usr/bin/env python3
"""Compile TagTool's Guardian collision OBJ into a compact WebGL collision mesh.

TagTool's collision exporter writes OBJ coordinates as ``X, Z, -Y`` for DCC
tools. Guardian's WebGL scene is intentionally in Halo 3's native ``X, Y, Z``
space, so this compiler restores ``X, -Z, Y`` before writing the binary.
"""

from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path


MAGIC = b"NWC1"


def read_obj(path: Path) -> tuple[list[tuple[float, float, float]], list[int]]:
    vertices: list[tuple[float, float, float]] = []
    indices: list[int] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "v":
            if len(parts) != 4:
                raise ValueError(f"{path}:{line_number}: malformed vertex")
            x, z, negative_y = map(float, parts[1:])
            vertices.append((x, -negative_y, z))
        elif parts[0] == "f":
            face = [int(value.split("/", 1)[0]) - 1 for value in parts[1:]]
            if len(face) < 3 or any(index < 0 or index >= len(vertices) for index in face):
                raise ValueError(f"{path}:{line_number}: malformed face")
            for index in range(1, len(face) - 1):
                indices.extend((face[0], face[index], face[index + 1]))
    if not vertices or not indices:
        raise ValueError(f"{path}: no collision geometry")
    return vertices, indices


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    vertices, indices = read_obj(args.input)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("wb") as stream:
        stream.write(MAGIC)
        stream.write(struct.pack("<II", len(vertices), len(indices)))
        for vertex in vertices:
            stream.write(struct.pack("<3f", *vertex))
        stream.write(struct.pack(f"<{len(indices)}I", *indices))
    minimum = [min(vertex[axis] for vertex in vertices) for axis in range(3)]
    maximum = [max(vertex[axis] for vertex in vertices) for axis in range(3)]
    report = {
        "schema": "guardian-authored-collision-v1",
        "source": str(args.input),
        "coordinateSystem": "Halo 3 native: X forward, Y right, Z up",
        "vertices": len(vertices),
        "triangles": len(indices) // 3,
        "bounds": {"min": minimum, "max": maximum},
        "binary": str(args.output),
    }
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    main()

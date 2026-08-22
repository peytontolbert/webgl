#!/usr/bin/env python3
"""Compile a local Assetto Corsa AI line into a compact, drivable road package.

The package is a derived road ribbon, not a copy of KN5 models/textures.  It is
purpose-built for the WebGL demo: an elevation-preserving centerline is resampled
to a fixed spacing, expanded to a road-width ribbon, then quantized to 16-bit
coordinates.  The same ribbon is used for rendering and ground contact so the
visible road and vehicle surface cannot diverge.
"""

from __future__ import annotations

import argparse
import configparser
import json
import math
import struct
from pathlib import Path
from typing import Iterable


HEADER = struct.Struct("<4sIIII6f")
POINT = struct.Struct("<4fi")


def read_ai_line(path: Path) -> list[tuple[float, float, float]]:
    with path.open("rb") as stream:
        header = stream.read(16)
        if len(header) != 16:
            raise ValueError("AI line header is truncated")
        _, count, _, _ = struct.unpack("<4i", header)
        if count < 2 or count > 5_000_000:
            raise ValueError(f"AI line point count is invalid: {count}")
        raw = stream.read(count * POINT.size)
        if len(raw) != count * POINT.size:
            raise ValueError("AI line points are truncated")

    # Assetto's conventional storage is (X, up, Z, distance, id); the demo's
    # data space is (X, Y, up).  Do this conversion once at compile time.
    return [(x, z, up) for x, up, z, _distance, _id in struct.iter_unpack("<4fi", raw)]


def interpolate(a: tuple[float, float, float], b: tuple[float, float, float], t: float) -> tuple[float, float, float]:
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def resample(points: list[tuple[float, float, float]], spacing: float) -> list[tuple[float, float, float]]:
    """Evenly resample a potentially very dense AI spline without losing height."""
    output = [points[0]]
    carry = 0.0
    previous = points[0]
    for current in points[1:]:
        ax, ay, az = previous
        bx, by, bz = current
        length = math.dist(previous, current)
        if length < 1e-5 or length > 80.0:  # malformed/restarted samples
            previous = current
            continue
        while carry + length >= spacing:
            amount = (spacing - carry) / length
            sample = interpolate((ax, ay, az), (bx, by, bz), amount)
            output.append(sample)
            ax, ay, az = sample
            length = math.dist((ax, ay, az), (bx, by, bz))
            carry = 0.0
        carry += length
        previous = current
    # Closed layouts need their last segment too, unless it already nearly joins.
    if math.dist(output[-1], output[0]) > spacing * 0.4:
        output.append(points[-1])
    if len(output) < 3:
        raise ValueError("AI line did not produce enough valid road samples")
    return output


def ribbon(points: list[tuple[float, float, float]], width: float, place_x: float, place_y: float, place_z: float) -> list[tuple[float, float, float]]:
    origin_x, origin_y, origin_z = points[0]
    vertices: list[tuple[float, float, float]] = []
    half_width = width * 0.5
    count = len(points)
    for i, point in enumerate(points):
        before = points[(i - 1) % count]
        after = points[(i + 1) % count]
        dx, dy = after[0] - before[0], after[1] - before[1]
        length = math.hypot(dx, dy)
        if length < 1e-5:
            dx, dy, length = 1.0, 0.0, 1.0
        nx, ny = -dy / length, dx / length
        x, y, z = point
        cx, cy, cz = x - origin_x + place_x, y - origin_y + place_y, z - origin_z + place_z
        vertices.append((cx + nx * half_width, cy + ny * half_width, cz))
        vertices.append((cx - nx * half_width, cy - ny * half_width, cz))
    return vertices


def surface_values(path: Path) -> tuple[str, float]:
    parser = configparser.ConfigParser(interpolation=None)
    parser.optionxform = str.upper
    parser.read(path, encoding="utf-8-sig")
    preferred = None
    for section in parser.sections():
        key = parser.get(section, "KEY", fallback="").strip().lower()
        try:
            friction = float(parser.get(section, "FRICTION", fallback="1"))
        except ValueError:
            friction = 1.0
        if key == "asph-nurb":
            return key, friction
        if preferred is None and parser.get(section, "IS_VALID_TRACK", fallback="0").strip() == "1":
            preferred = (key or "asphalt", friction)
    return preferred or ("asphalt", 1.0)


def quantize(value: float, minimum: float, span: float) -> int:
    return max(0, min(65535, round((value - minimum) / span * 65535.0)))


def bounds(vertices: Iterable[tuple[float, float, float]]) -> tuple[list[float], list[float]]:
    rows = list(vertices)
    return [min(v[i] for v in rows) for i in range(3)], [max(v[i] for v in rows) for i in range(3)]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ai", type=Path, required=True, help="Authorized local fast_lane.ai")
    parser.add_argument("--surfaces", type=Path, required=True, help="Authorized local surfaces.ini")
    parser.add_argument("--out-dir", type=Path, required=True, help="Output directory in the demo workspace")
    parser.add_argument("--spacing", type=float, default=3.0, help="Centerline sample spacing in metres (default: 3)")
    parser.add_argument("--width", type=float, default=10.0, help="Generated road width in metres (default: 10)")
    parser.add_argument("--place-x", type=float, default=1800.0, help="Demo data-space X at the circuit start")
    parser.add_argument("--place-y", type=float, default=-850.0, help="Demo data-space Y at the circuit start")
    parser.add_argument("--place-z", type=float, default=32.0, help="Demo data-space Z at the circuit start")
    parser.add_argument("--id", default="nordschleife-road", help="Stable demo track id")
    args = parser.parse_args()
    if not args.ai.is_file() or not args.surfaces.is_file():
        parser.error("--ai and --surfaces must be existing local files")
    if not (0.5 <= args.spacing <= 20 and 4 <= args.width <= 40):
        parser.error("spacing must be 0.5..20 and width must be 4..40 metres")

    centerline = resample(read_ai_line(args.ai), args.spacing)
    closure_distance = math.dist(centerline[0], centerline[-1])
    closed = closure_distance <= max(12.0, args.spacing * 4.0)
    # Explicitly append the first sample so render and collision both own the
    # start/finish segment. Do not force-close an AI line that is genuinely open.
    if closed and closure_distance > 0.02:
        centerline.append(centerline[0])
    vertices = ribbon(centerline, args.width, args.place_x, args.place_y, args.place_z)
    minimum, maximum = bounds(vertices)
    span = [max(0.01, maximum[i] - minimum[i]) for i in range(3)]
    surface, grip = surface_values(args.surfaces)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    binary_path = args.out_dir / "road.nrb"
    with binary_path.open("wb") as stream:
        stream.write(HEADER.pack(b"NRB1", 1, len(vertices), len(centerline) - 1, 0, *minimum, *span))
        for vertex in vertices:
            stream.write(struct.pack("<3H", *(quantize(vertex[i], minimum[i], span[i]) for i in range(3))))

    metadata = {
        "schema": "webglgta-derived-road-v1",
        "id": str(args.id),
        "file": binary_path.name,
        "coordinateSystem": "demo-data-x-y-z-up",
        "closed": closed,
        "closureDistanceM": closure_distance,
        "vertexCount": len(vertices),
        "segmentCount": len(centerline) - 1,
        "bounds": {"minX": minimum[0], "minY": minimum[1], "minZ": minimum[2], "maxX": maximum[0], "maxY": maximum[1], "maxZ": maximum[2]},
        "surface": {"name": surface, "grip": grip},
        "roadWidthM": args.width,
        "sampleSpacingM": args.spacing,
        "compression": {"positions": "uint16 affine quantized", "indices": "implicit ribbon triangles"},
    }
    metadata_path = args.out_dir / "road.json"
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"metadata": str(metadata_path), "binary": str(binary_path), "samples": len(centerline), "bytes": binary_path.stat().st_size, "bounds": metadata["bounds"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

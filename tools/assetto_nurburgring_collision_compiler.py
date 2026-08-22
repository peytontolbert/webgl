#!/usr/bin/env python3
"""Compile authored Assetto physics meshes into indexed WebGL collision data."""

from __future__ import annotations

import argparse
import configparser
import gzip
import json
import math
import re
import struct
from array import array
from pathlib import Path

from assetto_nurburgring_road_compiler import read_ai_line
from assetto_nurburgring_scene_compiler import load_parser, read_kn5_textured, static_model_entries


HEADER = struct.Struct("<4sIIIII6f")
FALLBACK_SURFACES = {
    "GRASS": {"friction": 0.60, "validTrack": False, "pitlane": False, "damping": 0.0},
    "SAND": {"friction": 0.60, "validTrack": False, "pitlane": False, "damping": 0.02},
    "GRAVEL": {"friction": 0.60, "validTrack": False, "pitlane": False, "damping": 0.02},
    "WALL": {"friction": 1.00, "validTrack": False, "pitlane": False, "damping": 0.0},
}


def vector(raw: str) -> tuple[float, float, float]:
    values = tuple(float(part.strip()) for part in raw.split(","))
    if len(values) != 3 or not all(math.isfinite(value) for value in values):
        raise ValueError("expected three finite comma-separated values")
    return values


def read_surfaces(path: Path) -> dict[str, dict[str, object]]:
    parser = configparser.ConfigParser(interpolation=None)
    parser.read(path, encoding="utf-8-sig")
    result: dict[str, dict[str, object]] = {}
    for section in parser.sections():
        key = parser.get(section, "KEY", fallback="").strip().upper()
        if not key:
            continue
        result[key] = {
            "name": key.lower(),
            "friction": parser.getfloat(section, "FRICTION", fallback=1.0),
            "validTrack": parser.getboolean(section, "IS_VALID_TRACK", fallback=False),
            "pitlane": parser.getboolean(section, "IS_PITLANE", fallback=False),
            "damping": parser.getfloat(section, "DAMPING", fallback=0.0),
        }
    for key, record in FALLBACK_SURFACES.items():
        result.setdefault(key, {"name": key.lower(), **record})
    return result


def collision_surface(node_name: str, surfaces: dict[str, dict[str, object]]) -> str | None:
    name = str(node_name or "").strip().upper()
    # Kunos' dedicated `physics` sector numbers its authored surface nodes;
    # strip that numeric node ID before matching the surfaces.ini KEY.
    if not re.match(r"^\d", name):
        return None
    payload = re.sub(r"^\d+", "", name)
    matches = [key for key in surfaces if payload == key or payload.startswith(key + "_") or re.match(rf"^{re.escape(key)}\d", payload)]
    if matches:
        return max(matches, key=len)
    family = re.split(r"[_\d]", payload, maxsplit=1)[0]
    return family if family in surfaces else None


def rotation(values: tuple[float, float, float]):
    rx, ry, rz = (math.radians(value) for value in values)
    sx, cx = math.sin(rx), math.cos(rx)
    sy, cy = math.sin(ry), math.cos(ry)
    sz, cz = math.sin(rz), math.cos(rz)

    def apply(x: float, y: float, z: float) -> tuple[float, float, float]:
        y, z = y * cx - z * sx, y * sx + z * cx
        x, z = x * cy + z * sy, -x * sy + z * cy
        return x * cz - y * sz, x * sz + y * cz, z

    return apply


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--track-root", required=True, type=Path)
    parser.add_argument("--surfaces", required=True, type=Path)
    parser.add_argument("--pit-ai", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--layout", default="models_nordschleife.ini")
    parser.add_argument("--kn5-parser", type=Path, default=Path(r"K:\WebGL_Tools\tools\assetto_corsa_kn5_to_obj.py"))
    parser.add_argument("--origin", default="-516.2700195,139.6994476,2351.2604980")
    parser.add_argument("--placement", default="7000,-850,32")
    args = parser.parse_args()

    track_root = args.track_root.resolve()
    origin, placement = vector(args.origin), vector(args.placement)
    surfaces = read_surfaces(args.surfaces)
    reader = load_parser(args.kn5_parser.resolve())
    positions = array("f")
    indices = array("I")
    triangle_materials = array("H")
    position_lookup: dict[tuple[float, float, float], int] = {}
    palette: list[dict[str, object]] = []
    palette_index: dict[str, int] = {}
    source_counts: dict[str, int] = {}
    surface_counts: dict[str, int] = {}

    def material_id(key: str) -> int:
        if key not in palette_index:
            palette_index[key] = len(palette)
            palette.append({"key": key, **surfaces[key]})
        return palette_index[key]

    def vertex_id(value: tuple[float, float, float]) -> int:
        key = tuple(round(axis, 5) for axis in value)
        found = position_lookup.get(key)
        if found is not None:
            return found
        found = len(positions) // 3
        position_lookup[key] = found
        positions.extend(value)
        return found

    for entry in static_model_entries(track_root, args.layout):
        source = str(entry["file"])
        model_materials, nodes, _textures = read_kn5_textured(reader, track_root / source)
        rotate = rotation(entry["rotation"])
        model_position = entry["position"]
        before = len(triangle_materials)
        for node in nodes:
            node_indices = getattr(node, "indices", None) or []
            surface = collision_surface(str(getattr(node, "name", "")), surfaces)
            if not surface or getattr(node, "type", None) not in (2, 3) or len(node_indices) < 3:
                continue
            converted: dict[int, int] = {}
            for offset in range(0, len(node_indices) - 2, 3):
                triangle: list[int] = []
                world_points: list[tuple[float, float, float]] = []
                for raw_index in node_indices[offset:offset + 3]:
                    raw_index = int(raw_index)
                    cached = converted.get(raw_index)
                    px = float(node.pos[raw_index * 3]); py = float(node.pos[raw_index * 3 + 1]); pz = float(node.pos[raw_index * 3 + 2])
                    px, py, pz = reader._apply_mat_pos(node.hmatrix, px, py, pz)
                    px, py, pz = rotate(px, py, pz)
                    px += float(model_position[0]); py += float(model_position[1]); pz += float(model_position[2])
                    data = (px - origin[0] + placement[0], pz - origin[2] + placement[1], py - origin[1] + placement[2])
                    world_points.append(data)
                    if cached is None:
                        cached = vertex_id(data)
                        converted[raw_index] = cached
                    triangle.append(cached)
                ax, ay, az = world_points[0]; bx, by, bz = world_points[1]; cx, cy, cz = world_points[2]
                cross = ((by - ay) * (cz - az) - (bz - az) * (cy - ay), (bz - az) * (cx - ax) - (bx - ax) * (cz - az), (bx - ax) * (cy - ay) - (by - ay) * (cx - ax))
                if math.sqrt(sum(value * value for value in cross)) < 1e-7:
                    continue
                indices.extend(triangle)
                triangle_materials.append(material_id(surface))
                surface_counts[surface] = surface_counts.get(surface, 0) + 1
        source_counts[source] = len(triangle_materials) - before

    if not triangle_materials:
        raise RuntimeError("No authored collision triangles were found")
    values = list(zip(positions[0::3], positions[1::3], positions[2::3]))
    minimum = [min(value[axis] for value in values) for axis in range(3)]
    maximum = [max(value[axis] for value in values) for axis in range(3)]

    def place(point: tuple[float, float, float]) -> list[float]:
        return [point[0] - origin[0] + placement[0], point[1] - origin[2] + placement[1], point[2] - origin[1] + placement[2]]

    triangle_grid: dict[tuple[int, int], list[int]] = {}
    cell_size = 16.0
    for triangle in range(len(triangle_materials)):
        ia, ib, ic = (indices[triangle * 3 + axis] * 3 for axis in range(3))
        ax, ay, az = positions[ia:ia + 3]; bx, by, bz = positions[ib:ib + 3]; cx, cy, cz = positions[ic:ic + 3]
        for gy in range(math.floor(min(ay, by, cy) / cell_size), math.floor(max(ay, by, cy) / cell_size) + 1):
            for gx in range(math.floor(min(ax, bx, cx) / cell_size), math.floor(max(ax, bx, cx) / cell_size) + 1):
                triangle_grid.setdefault((gx, gy), []).append(triangle)

    def contact(point: list[float]) -> tuple[float, int, float] | None:
        best_contact: tuple[float, int, float] | None = None
        candidates = triangle_grid.get((math.floor(point[0] / cell_size), math.floor(point[1] / cell_size)), [])
        for triangle in candidates:
            ia, ib, ic = (indices[triangle * 3 + axis] * 3 for axis in range(3))
            ax, ay, az = positions[ia:ia + 3]; bx, by, bz = positions[ib:ib + 3]; cx, cy, cz = positions[ic:ic + 3]
            denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
            if abs(denominator) < 1e-7:
                continue
            u = ((by - cy) * (point[0] - cx) + (cx - bx) * (point[1] - cy)) / denominator
            v = ((cy - ay) * (point[0] - cx) + (ax - cx) * (point[1] - cy)) / denominator
            w = 1.0 - u - v
            if min(u, v, w) < -1e-5:
                continue
            z = u * az + v * bz + w * cz
            distance = abs(z - point[2])
            if best_contact is None or distance < best_contact[0]:
                best_contact = (distance, triangle, z)
        return best_contact

    pit = read_ai_line(args.pit_ai)
    supported: list[tuple[int, list[float], tuple[float, int, float], str]] = []
    for pit_index, raw_point in enumerate(pit):
        point = place(raw_point)
        hit = contact(point)
        if hit is None or hit[0] > 3.0:
            continue
        key = str(palette[int(triangle_materials[hit[1]])]["key"])
        supported.append((pit_index, point, hit, key))
    candidates = [candidate for candidate in supported if palette[int(triangle_materials[candidate[2][1]])].get("validTrack")]
    if not candidates:
        candidates = [candidate for candidate in supported if candidate[3] == "PITS"]
    if not candidates:
        raise RuntimeError("Pit/paddock AI line has no authored collision support")
    target_index = len(pit) // 2
    pit_index, spawn, best_contact, spawn_surface = min(candidates, key=lambda candidate: abs(candidate[0] - target_index))
    spawn_kind = "tourist-entry-access"
    spawn[2] = best_contact[2]
    ahead_index = min(len(pit) - 1, pit_index + 10)
    ahead = place(pit[ahead_index])
    heading = math.atan2(ahead[1] - spawn[1], ahead[0] - spawn[0])

    args.out_dir.mkdir(parents=True, exist_ok=True)
    binary = args.out_dir / "surface_collision.ncv"
    payload = bytearray(HEADER.pack(b"NCV1", 1, len(positions) // 3, len(indices), len(triangle_materials), len(palette), *minimum, *maximum))
    payload.extend(positions.tobytes())
    payload.extend(indices.tobytes())
    payload.extend(triangle_materials.tobytes())
    binary.write_bytes(payload)
    with gzip.open(binary.with_suffix(binary.suffix + ".gz"), "wb", compresslevel=9) as stream:
        stream.write(payload)
    metadata = {
        "schema": "webglgta-authored-track-collision-v1",
        "id": "nordschleife-authored-surfaces",
        "file": binary.name,
        "coordinateSystem": "demo-data-x-y-z-up",
        "layout": args.layout,
        "vertices": len(positions) // 3,
        "triangles": len(triangle_materials),
        "bounds": {"minX": minimum[0], "minY": minimum[1], "minZ": minimum[2], "maxX": maximum[0], "maxY": maximum[1], "maxZ": maximum[2]},
        "spawn": {"kind": spawn_kind, "x": spawn[0], "y": spawn[1], "feetZ": spawn[2], "headingRad": heading, "surface": spawn_surface},
        "surfaces": palette,
        "surfaceTriangles": surface_counts,
        "sourceTriangles": source_counts,
        "compression": {"positions": "float32 authored", "indices": "uint32", "triangleMaterials": "uint16", "transport": "gzip sidecar"},
    }
    (args.out_dir / "surface_collision.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"metadata": str(args.out_dir / "surface_collision.json"), "binary": str(binary), **metadata}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

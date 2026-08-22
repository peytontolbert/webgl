#!/usr/bin/env python3
"""Export complete exterior GTA YBN collision geometry for a browser tile.

CodeWalker stores triangle, box, capsule, cylinder, and sphere polygons in YBN files.
The browser format tessellates every authored shape into a packed spatial index used
for vertical ground, movement, and weapon ray queries; it does not render the mesh.

Run from the repository root on Windows:
  python webgl_viewer/tools/export_ybn_collision_tile.py --gta-path "K:\\steam\\steamapps\\common\\Grand Theft Auto V" --x 186.94 --y -850.84
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import json
import logging
import math
import struct
import sys
from pathlib import Path
from typing import Any, Iterable


DEFAULT_GRID_CELL_SIZE = 8.0
ROUND_SIDES = 12
CAPSULE_HEMISPHERE_SEGMENTS = 2

Vec3 = tuple[float, float, float]
Triangle = tuple[Vec3, Vec3, Vec3]
Quat = tuple[float, float, float, float]

SURFACE_GRIP = {
    "asphalt": 1.00,
    "concrete": 0.98,
    "metal": 0.78,
    "dirt": 0.72,
    "gravel": 0.66,
    "grass": 0.58,
    "sand": 0.48,
    "mud": 0.42,
    "ice": 0.18,
}


def _surface_profile_for_material_name(value: Any) -> dict[str, Any]:
    raw = str(value or "DEFAULT").strip() or "DEFAULT"
    name = raw.casefold().replace("_", " ")
    surface = "asphalt"
    groups = (
        ("ice", ("ice", "snow")),
        ("mud", ("mud", "marsh", "swamp")),
        ("sand", ("sand", "beach")),
        ("grass", ("grass", "hay", "bush", "plant")),
        ("gravel", ("gravel", "loose", "rubble")),
        ("dirt", ("dirt", "soil", "clay", "earth")),
        ("metal", ("metal", "steel", "iron", "grate")),
        ("concrete", ("concrete", "paving", "brick", "stone", "kerb", "curb")),
    )
    for candidate, needles in groups:
        if any(needle in name for needle in needles):
            surface = candidate
            break
    return {"gta_name": raw, "surface": surface, "grip": SURFACE_GRIP[surface]}


def _polygon_material(geometry: Any, polygon: Any) -> tuple[str, dict[str, Any]]:
    try:
        material_index = int(getattr(polygon, "MaterialIndex"))
        materials = getattr(geometry, "Materials", None) or []
        material = materials[material_index]
        material_type = getattr(material, "Type", None)
        material_data = getattr(material_type, "MaterialData", None)
        raw_name = str(getattr(material_data, "Name", None) or material_type or f"MATERIAL_{int(getattr(material_type, 'Index', 0))}")
        profile = _surface_profile_for_material_name(raw_name)
        profile["gta_index"] = int(getattr(material_type, "Index", int(getattr(material, "Data1", 0)) & 0xFF))
        for output_name, attribute in (
            ("grip", "TyreGrip"),
            ("wet_grip", "WetGrip"),
            ("tyre_drag", "TyreDrag"),
            ("top_speed_mult", "TopSpeedMult"),
        ):
            try:
                parsed = float(str(getattr(material_data, attribute)))
                if math.isfinite(parsed):
                    profile[output_name] = parsed
            except Exception:
                pass
        return raw_name, profile
    except Exception:
        return "DEFAULT", _surface_profile_for_material_name("DEFAULT")


def _add(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def _rotate_quaternion(point: Vec3, rotation: Quat) -> Vec3:
    """Rotate a point by an XYZW unit quaternion."""
    x, y, z, w = rotation
    qvec = (x, y, z)
    uv = _cross(qvec, point)
    uuv = _cross(qvec, uv)
    return _add(point, _mul(_add(_mul(uv, w), uuv), 2.0))


def _sub(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _mul(a: Vec3, scalar: float) -> Vec3:
    return (a[0] * scalar, a[1] * scalar, a[2] * scalar)


def _cross(a: Vec3, b: Vec3) -> Vec3:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _length(a: Vec3) -> float:
    return math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])


def _normalize(a: Vec3) -> Vec3:
    length = _length(a)
    return _mul(a, 1.0 / length) if length > 1e-8 else (0.0, 0.0, 1.0)


def _point(value: Any) -> Vec3:
    return (float(value.X), float(value.Y), float(value.Z))


def _ring(center: Vec3, basis_x: Vec3, basis_y: Vec3, radius: float, sides: int = ROUND_SIDES) -> list[Vec3]:
    return [
        _add(center, _add(_mul(basis_x, radius * math.cos(2.0 * math.pi * i / sides)),
                          _mul(basis_y, radius * math.sin(2.0 * math.pi * i / sides))))
        for i in range(sides)
    ]


def _axis_basis(start: Vec3, end: Vec3) -> tuple[Vec3, Vec3, Vec3]:
    axis = _normalize(_sub(end, start))
    reference = (0.0, 0.0, 1.0) if abs(axis[2]) < 0.9 else (0.0, 1.0, 0.0)
    basis_x = _normalize(_cross(axis, reference))
    return axis, basis_x, _normalize(_cross(axis, basis_x))


def _connect_rings(first: list[Vec3], second: list[Vec3]) -> list[Triangle]:
    triangles: list[Triangle] = []
    count = len(first)
    for i in range(count):
        next_i = (i + 1) % count
        triangles.append((first[i], second[i], second[next_i]))
        triangles.append((first[i], second[next_i], first[next_i]))
    return triangles


def _box_triangles(points: list[Vec3]) -> list[Triangle]:
    if len(points) != 4:
        return []
    # This is CodeWalker's BoundPolygonBox reconstruction. The four stored points
    # are a compact oriented-box basis, not a polygon face.
    p1, p2, p3, p4 = points
    axis1 = _mul(_sub(_add(p3, p4), _add(p1, p2)), 0.5)
    axis2 = _sub(p3, _add(p1, axis1))
    axis3 = _sub(p4, _add(p1, axis1))
    if min(_length(axis1), _length(axis2), _length(axis3)) < 1e-7:
        return []
    corners = [
        _add(p1, _add(_mul(axis1, x), _add(_mul(axis2, y), _mul(axis3, z))))
        for z in (0.0, 1.0)
        for y in (0.0, 1.0)
        for x in (0.0, 1.0)
    ]
    faces = (
        (0, 4, 6, 2), (1, 3, 7, 5),
        (0, 1, 5, 4), (2, 6, 7, 3),
        (0, 2, 3, 1), (4, 5, 7, 6),
    )
    return [triangle for a, b, c, d in faces for triangle in ((corners[a], corners[b], corners[c]), (corners[a], corners[c], corners[d]))]


def _cylinder_triangles(start: Vec3, end: Vec3, radius: float) -> list[Triangle]:
    if radius <= 1e-7 or _length(_sub(end, start)) <= 1e-7:
        return _sphere_triangles(start, radius)
    _, basis_x, basis_y = _axis_basis(start, end)
    first = _ring(start, basis_x, basis_y, radius)
    second = _ring(end, basis_x, basis_y, radius)
    triangles = _connect_rings(first, second)
    for i in range(ROUND_SIDES):
        next_i = (i + 1) % ROUND_SIDES
        triangles.append((start, first[next_i], first[i]))
        triangles.append((end, second[i], second[next_i]))
    return triangles


def _sphere_triangles(center: Vec3, radius: float) -> list[Triangle]:
    if radius <= 1e-7:
        return []
    north = _add(center, (0.0, 0.0, radius))
    south = _add(center, (0.0, 0.0, -radius))
    rings = [
        _ring(_add(center, (0.0, 0.0, radius * math.sin(latitude))), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), radius * math.cos(latitude))
        for latitude in (-math.pi / 4.0, 0.0, math.pi / 4.0)
    ]
    triangles: list[Triangle] = []
    for i in range(ROUND_SIDES):
        next_i = (i + 1) % ROUND_SIDES
        triangles.append((south, rings[0][i], rings[0][next_i]))
        triangles.append((north, rings[-1][next_i], rings[-1][i]))
    triangles.extend(_connect_rings(rings[0], rings[1]))
    triangles.extend(_connect_rings(rings[1], rings[2]))
    return triangles


def _capsule_triangles(start: Vec3, end: Vec3, radius: float) -> list[Triangle]:
    if radius <= 1e-7:
        return []
    if _length(_sub(end, start)) <= 1e-7:
        return _sphere_triangles(start, radius)
    axis, basis_x, basis_y = _axis_basis(start, end)
    levels: list[list[Vec3]] = [[_sub(start, _mul(axis, radius))]]
    for segment in range(1, CAPSULE_HEMISPHERE_SEGMENTS + 1):
        angle = -math.pi / 2.0 + (math.pi / 2.0) * segment / CAPSULE_HEMISPHERE_SEGMENTS
        levels.append(_ring(_add(start, _mul(axis, radius * math.sin(angle))), basis_x, basis_y, radius * math.cos(angle)))
    levels.append(_ring(end, basis_x, basis_y, radius))
    for segment in range(1, CAPSULE_HEMISPHERE_SEGMENTS):
        angle = (math.pi / 2.0) * segment / CAPSULE_HEMISPHERE_SEGMENTS
        levels.append(_ring(_add(end, _mul(axis, radius * math.sin(angle))), basis_x, basis_y, radius * math.cos(angle)))
    levels.append([_add(end, _mul(axis, radius))])

    triangles: list[Triangle] = []
    for first, second in zip(levels, levels[1:]):
        if len(first) == 1:
            triangles.extend((first[0], second[i], second[(i + 1) % len(second)]) for i in range(len(second)))
        elif len(second) == 1:
            triangles.extend((second[0], first[(i + 1) % len(first)], first[i]) for i in range(len(first)))
        else:
            triangles.extend(_connect_rings(first, second))
    return triangles


def _polygon_triangles(polygon: Any) -> list[Triangle]:
    type_name = type(polygon).__name__
    points = [_point(value) for value in (getattr(polygon, "VertexPositions", None) or [])]
    if type_name == "BoundPolygonTriangle" and len(points) == 3:
        return [(points[0], points[1], points[2])]
    if type_name == "BoundPolygonBox":
        return _box_triangles(points)
    if type_name == "BoundPolygonCapsule" and len(points) == 2:
        return _capsule_triangles(points[0], points[1], float(polygon.capsuleRadius))
    if type_name == "BoundPolygonCylinder" and len(points) == 2:
        return _cylinder_triangles(points[0], points[1], float(polygon.cylinderRadius))
    if type_name == "BoundPolygonSphere" and len(points) == 1:
        return _sphere_triangles(points[0], float(polygon.sphereRadius))
    return []


def _joaat(value: str) -> int:
    result = 0
    for byte in value.lower().encode("utf-8"):
        result = (result + byte) & 0xFFFFFFFF
        result = (result + (result << 10)) & 0xFFFFFFFF
        result ^= result >> 6
    result = (result + (result << 3)) & 0xFFFFFFFF
    result ^= result >> 11
    return (result + (result << 15)) & 0xFFFFFFFF


def _iter_geometries(bounds: Any) -> Iterable[Any]:
    children = getattr(getattr(bounds, "Children", None), "data_items", None)
    if children is not None:
        for child in children:
            if child is not None:
                yield from _iter_geometries(child)
        return
    if getattr(bounds, "Vertices", None) is not None and getattr(bounds, "Polygons", None) is not None:
        yield bounds


def _overlaps_xy(points: tuple[tuple[float, float, float], ...], min_x: float, min_y: float, max_x: float, max_y: float) -> bool:
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return max(xs) >= min_x and min(xs) <= max_x and max(ys) >= min_y and min(ys) <= max_y


def _parse_resource_ybn_offsets(values: list[str]) -> dict[str, Vec3]:
    offsets: dict[str, Vec3] = {}
    for raw in values:
        parts = [part.strip() for part in str(raw).split(",")]
        if len(parts) != 4:
            raise ValueError(f"Invalid --resource-ybn-offset '{raw}'; expected stem,x,y,z")
        stem = parts[0].lower()
        offset = (float(parts[1]), float(parts[2]), float(parts[3]))
        if not stem or not all(math.isfinite(value) for value in offset):
            raise ValueError(f"Invalid --resource-ybn-offset '{raw}'")
        offsets[stem] = offset
    return offsets


def _parse_resource_ybn_transforms(values: list[str]) -> dict[str, tuple[Vec3, Quat]]:
    transforms: dict[str, tuple[Vec3, Quat]] = {}
    for raw in values:
        parts = [part.strip() for part in str(raw).split(",")]
        if len(parts) != 8:
            raise ValueError(
                f"Invalid --resource-ybn-transform '{raw}'; expected stem,x,y,z,qx,qy,qz,qw"
            )
        stem = parts[0].lower()
        translation = (float(parts[1]), float(parts[2]), float(parts[3]))
        rotation_values = [float(value) for value in parts[4:8]]
        length = math.sqrt(sum(value * value for value in rotation_values))
        if not stem or not all(math.isfinite(value) for value in (*translation, *rotation_values)) or length <= 1e-8:
            raise ValueError(f"Invalid --resource-ybn-transform '{raw}'")
        rotation = tuple(value / length for value in rotation_values)
        transforms[stem] = (translation, rotation)  # type: ignore[assignment]
    return transforms


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(Path(__file__).resolve().parents[1] / "demo_world.json"))
    ap.add_argument("--gta-path", required=True, help="Path to the GTA V installation.")
    ap.add_argument("--x", type=float, default=None, help="Override configured tile center X in GTA data space.")
    ap.add_argument("--y", type=float, default=None, help="Override configured tile center Y in GTA data space.")
    ap.add_argument("--radius", type=float, default=None, help="Override configured half-width in meters.")
    ap.add_argument("--load-passes", type=int, default=24, help="CodeWalker lazy-cache drain passes per YBN.")
    ap.add_argument("--grid-cell-size", type=float, default=None, help="Override configured packed XY collision-grid cell size.")
    ap.add_argument(
        "--resource-ybn-dir",
        action="append",
        default=[],
        help="Directory containing loose FiveM YBN files to merge with the GTA collision tile. Repeatable.",
    )
    ap.add_argument(
        "--resource-ybn-offset",
        action="append",
        default=[],
        help="Translate a local MLO collision resource into world space as stem,x,y,z. Repeatable.",
    )
    ap.add_argument(
        "--resource-ybn-transform",
        action="append",
        default=[],
        help="Transform a local MLO collision resource as stem,x,y,z,qx,qy,qz,qw. Repeatable.",
    )
    ap.add_argument(
        "--output-dir",
        default=str(Path(__file__).resolve().parents[1] / "assets" / "collision"),
        help="Output directory for the tile binary and metadata.",
    )
    ap.add_argument("--name", default="ybn_spawn", help="Output base name without extension.")
    ap.add_argument(
        "--trace-triangle-offset",
        type=int,
        default=-1,
        help="Include source polygon diagnostics for the emitted triangle containing this index offset.",
    )
    args = ap.parse_args()
    config = json.loads(Path(args.config).resolve().read_text(encoding="utf-8")) if args.config else {}
    center = config.get("center") if isinstance(config.get("center"), dict) else {}
    collision = config.get("collision") if isinstance(config.get("collision"), dict) else {}
    args.x = float(args.x if args.x is not None else center.get("x"))
    args.y = float(args.y if args.y is not None else center.get("y"))
    args.radius = float(args.radius if args.radius is not None else float(config.get("size")) * 0.5)
    args.grid_cell_size = float(
        args.grid_cell_size if args.grid_cell_size is not None
        else collision.get("gridCellSize", DEFAULT_GRID_CELL_SIZE)
    )
    if not all(math.isfinite(value) for value in (args.x, args.y, args.radius)) or args.radius <= 0:
        ap.error("demo world center/size must be finite and size must be positive")
    resource_ybn_offsets = _parse_resource_ybn_offsets(args.resource_ybn_offset)
    resource_ybn_transforms = _parse_resource_ybn_transforms(args.resource_ybn_transform)

    logging.disable(logging.CRITICAL)
    # DllManager changes the process working directory while loading CodeWalker.
    # Resolve loose resource paths before initialization so relative CLI paths survive.
    loose_paths: list[Path] = []
    for raw_dir in args.resource_ybn_dir:
        candidate = Path(raw_dir).resolve()
        if candidate.is_dir():
            loose_paths.extend(sorted(candidate.rglob("*.ybn")))
        elif candidate.is_file() and candidate.suffix.lower() == ".ybn":
            loose_paths.append(candidate)
    repo_root = Path(__file__).resolve().parents[2]
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

    from gta5_modules.dll_manager import DllManager

    radius = max(10.0, float(args.radius))
    grid_cell_size = max(2.0, min(32.0, float(args.grid_cell_size)))
    min_x = float(args.x) - radius
    min_y = float(args.y) - radius
    max_x = float(args.x) + radius
    max_y = float(args.y) + radius

    dll = DllManager(str(args.gta_path))
    if not getattr(dll, "initialized", False):
        raise SystemExit("DllManager failed to initialize.")
    # DllManager loads CodeWalker's SharpDX assembly during construction.
    import SharpDX  # type: ignore
    import System  # type: ignore
    from CodeWalker.GameFiles import BoundsMaterialTypes, YbnFile  # type: ignore
    if not dll.init_world_space():
        raise SystemExit("CodeWalker World.Space failed to initialize.")
    BoundsMaterialTypes.Init(dll.game_file_cache)

    layers = System.Array[System.Boolean]([True, False, False])
    result = dll.world_space.BoundsStore.GetItems(
        SharpDX.Vector3(min_x, min_y, -1000.0),
        SharpDX.Vector3(max_x, max_y, 3000.0),
        layers,
    )
    items = result[0]

    loose_ybns: dict[int, tuple[Path, Any]] = {}
    loose_skipped = 0
    for path in dict.fromkeys(loose_paths):
        try:
            ybn = YbnFile()
            ybn.Load(System.Array[System.Byte](path.read_bytes()))
            if getattr(ybn, "Bounds", None) is None:
                raise RuntimeError("loaded file has no Bounds")
            loose_ybns[_joaat(path.stem)] = (path, ybn)
        except Exception:
            loose_skipped += 1

    vertices: list[float] = []
    indices: list[int] = []
    authored_ground_flags: list[bool] = []
    triangle_materials: list[int] = []
    material_palette: list[dict[str, Any]] = []
    material_palette_indices: dict[str, int] = {}
    ybn_names: list[str] = []
    skipped_ybns = 0
    replaced_base_ybns = 0
    source_polygon_counts: Counter[str] = Counter()
    emitted_triangle_counts: Counter[str] = Counter()
    unsupported_polygon_counts: Counter[str] = Counter()
    traced_triangle: dict[str, Any] | None = None

    def append_bounds(
        bounds: Any,
        name: str,
        translation: Vec3 = (0.0, 0.0, 0.0),
        rotation: Quat = (0.0, 0.0, 0.0, 1.0),
    ) -> bool:
        """Append triangles from one authored collision bound into the tile."""
        nonlocal traced_triangle
        vertex_map: dict[Vec3, int] = {}
        added = False
        for geometry_index, geometry in enumerate(_iter_geometries(bounds)):
            polygons = getattr(geometry, "Polygons", None) or []
            for polygon_index, polygon in enumerate(polygons):
                type_name = type(polygon).__name__
                _, material_profile = _polygon_material(geometry, polygon)
                palette_key = json.dumps(material_profile, sort_keys=True)
                material_palette_index = material_palette_indices.get(palette_key)
                if material_palette_index is None:
                    material_palette_index = len(material_palette)
                    if material_palette_index >= 65535:
                        raise RuntimeError("YBN material palette exceeds Uint16 capacity")
                    material_palette_indices[palette_key] = material_palette_index
                    material_palette.append(material_profile)
                source_polygon_counts[type_name] += 1
                try:
                    authored_triangles = _polygon_triangles(polygon)
                except Exception:
                    authored_triangles = []
                if not authored_triangles:
                    unsupported_polygon_counts[type_name] += 1
                    continue
                for points in authored_triangles:
                    if rotation != (0.0, 0.0, 0.0, 1.0):
                        points = tuple(_rotate_quaternion(point, rotation) for point in points)
                    if translation != (0.0, 0.0, 0.0):
                        points = tuple(_add(point, translation) for point in points)
                    if not _overlaps_xy(points, min_x, min_y, max_x, max_y):
                        continue
                    triangle_offset = len(indices)
                    if (
                        traced_triangle is None
                        and args.trace_triangle_offset >= triangle_offset
                        and args.trace_triangle_offset < triangle_offset + 3
                    ):
                        trace_attributes = {}
                        for attribute in (
                            "MaterialIndex", "MaterialColorIndex", "PolyFlags", "Flags",
                            "Unk", "Unk1", "Unk2", "capsuleRadius", "cylinderRadius", "sphereRadius",
                        ):
                            try:
                                value = getattr(polygon, attribute)
                                if isinstance(value, (str, int, float, bool)):
                                    trace_attributes[attribute] = value
                                elif value is not None:
                                    trace_attributes[attribute] = str(value)
                            except Exception:
                                pass
                        trace_material = {}
                        try:
                            material_index = int(getattr(polygon, "MaterialIndex"))
                            materials = getattr(geometry, "Materials", None) or []
                            material = materials[material_index]
                            for attribute in dir(material):
                                if attribute.startswith("_"):
                                    continue
                                try:
                                    value = getattr(material, attribute)
                                except Exception:
                                    continue
                                if isinstance(value, (str, int, float, bool)):
                                    trace_material[attribute] = value
                                elif value is not None and not callable(value):
                                    rendered = str(value)
                                    if len(rendered) <= 160:
                                        trace_material[attribute] = rendered
                        except Exception as error:
                            trace_material["error"] = str(error)
                        traced_triangle = {
                            "triangle_offset": triangle_offset,
                            "ybn": name,
                            "geometry_index": geometry_index,
                            "polygon_index": polygon_index,
                            "polygon_type": type_name,
                            "polygon_attributes": trace_attributes,
                            "material": trace_material,
                            "source_points": points,
                        }
                    triangle: list[int] = []
                    for point in points:
                        output_index = vertex_map.get(point)
                        if output_index is None:
                            output_index = len(vertices) // 3
                            vertex_map[point] = output_index
                            vertices.extend(point)
                        triangle.append(output_index)
                    indices.extend(triangle)
                    authored_ground_flags.append(type_name == "BoundPolygonTriangle")
                    triangle_materials.append(material_palette_index)
                    emitted_triangle_counts[type_name] += 1
                    added = True
        if added:
            ybn_names.append(name)
        return added

    for item in items:
        name_hash = int(item.Name.Hash)
        if name_hash in loose_ybns:
            replaced_base_ybns += 1
            continue
        ybn = dll.game_file_cache.GetYbn(name_hash)
        for _ in range(max(0, int(args.load_passes))):
            if ybn is not None and bool(getattr(ybn, "Loaded", False)):
                break
            dll.game_file_cache.ContentThreadProc()
            ybn = dll.game_file_cache.GetYbn(name_hash)
        if ybn is None or not bool(getattr(ybn, "Loaded", False)) or getattr(ybn, "Bounds", None) is None:
            skipped_ybns += 1
            continue

        append_bounds(ybn.Bounds, str(item.Name))

    loose_added = 0
    for path, ybn in loose_ybns.values():
        stem = path.stem.lower()
        translation, rotation = resource_ybn_transforms.get(
            stem,
            (resource_ybn_offsets.get(stem, (0.0, 0.0, 0.0)), (0.0, 0.0, 0.0, 1.0)),
        )
        if append_bounds(ybn.Bounds, f"FiveM:{path.name}", translation, rotation):
            loose_added += 1

    if not indices:
        raise SystemExit("No YBN triangles were found in the requested tile.")
    if len(triangle_materials) != len(indices) // 3:
        raise RuntimeError("YBN triangle material channel is misaligned")

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    base_name = str(args.name).strip() or "ybn_spawn"
    bin_path = output_dir / f"{base_name}.bin"
    meta_path = output_dir / f"{base_name}.json"
    min_gx = int(min_x // grid_cell_size)
    min_gy = int(min_y // grid_cell_size)
    max_gx = int(max_x // grid_cell_size)
    max_gy = int(max_y // grid_cell_size)
    grid_width = max_gx - min_gx + 1
    grid_height = max_gy - min_gy + 1
    buckets: dict[int, list[int]] = defaultdict(list)
    wall_buckets: dict[int, list[int]] = defaultdict(list)
    wall_triangle_count = 0
    for triangle_offset in range(0, len(indices), 3):
        ia = indices[triangle_offset] * 3
        ib = indices[triangle_offset + 1] * 3
        ic = indices[triangle_offset + 2] * 3
        ax, ay, az = vertices[ia], vertices[ia + 1], vertices[ia + 2]
        bx, by, bz = vertices[ib], vertices[ib + 1], vertices[ib + 2]
        cx, cy, cz = vertices[ic], vertices[ic + 1], vertices[ic + 2]
        e1x, e1y, e1z = bx - ax, by - ay, bz - az
        e2x, e2y, e2z = cx - ax, cy - ay, cz - az
        nx = e1y * e2z - e1z * e2y
        ny = e1z * e2x - e1x * e2z
        nz = e1x * e2y - e1y * e2x
        normal_length = (nx * nx + ny * ny + nz * nz) ** 0.5
        if normal_length < 1e-7:
            continue
        # Do not reject zero-area XY projections here: vertical YBN faces project
        # to lines, but those are the exact faces needed for building collision.
        gx0 = max(min_gx, int(min(ax, bx, cx) // grid_cell_size))
        gy0 = max(min_gy, int(min(ay, by, cy) // grid_cell_size))
        gx1 = min(max_gx, int(max(ax, bx, cx) // grid_cell_size))
        gy1 = min(max_gy, int(max(ay, by, cy) // grid_cell_size))
        is_wall = ((nx * nx + ny * ny) ** 0.5 / normal_length) >= 0.8
        if is_wall:
            wall_triangle_count += 1
        for gy in range(gy0, gy1 + 1):
            row = (gy - min_gy) * grid_width
            for gx in range(gx0, gx1 + 1):
                cell_index = row + gx - min_gx
                if authored_ground_flags[triangle_offset // 3] or not is_wall:
                    buckets[cell_index].append(triangle_offset)
                if is_wall:
                    wall_buckets[cell_index].append(triangle_offset)

    cell_offsets = [0]
    triangle_offsets: list[int] = []
    for cell_index in range(grid_width * grid_height):
        triangle_offsets.extend(buckets.get(cell_index, ()))
        cell_offsets.append(len(triangle_offsets))
    wall_cell_offsets = [0]
    wall_triangle_offsets: list[int] = []
    for cell_index in range(grid_width * grid_height):
        wall_triangle_offsets.extend(wall_buckets.get(cell_index, ()))
        wall_cell_offsets.append(len(wall_triangle_offsets))

    with bin_path.open("wb") as handle:
        handle.write(b"YBNC")
        handle.write(struct.pack("<III", 4, len(vertices) // 3, len(indices)))
        handle.write(struct.pack(
            "<fiiIIII",
            grid_cell_size,
            min_gx,
            min_gy,
            grid_width,
            grid_height,
            len(triangle_offsets),
            len(wall_triangle_offsets),
        ))
        handle.write(struct.pack(f"<{len(vertices)}f", *vertices))
        handle.write(struct.pack(f"<{len(indices)}I", *indices))
        handle.write(struct.pack(f"<{len(cell_offsets)}I", *cell_offsets))
        handle.write(struct.pack(f"<{len(triangle_offsets)}I", *triangle_offsets))
        handle.write(struct.pack(f"<{len(wall_cell_offsets)}I", *wall_cell_offsets))
        handle.write(struct.pack(f"<{len(wall_triangle_offsets)}I", *wall_triangle_offsets))
        handle.write(struct.pack(f"<{len(triangle_materials)}H", *triangle_materials))

    metadata = {
        "format": "YBNC",
        "version": 4,
        "file": bin_path.name,
        "center": {"x": float(args.x), "y": float(args.y)},
        "bounds": {"min_x": min_x, "min_y": min_y, "max_x": max_x, "max_y": max_y},
        "vertex_count": len(vertices) // 3,
        "triangle_count": len(indices) // 3,
        "grid_cell_size": grid_cell_size,
        "grid_cell_count": grid_width * grid_height,
        "grid_reference_count": len(triangle_offsets),
        "wall_triangle_count": wall_triangle_count,
        "wall_grid_reference_count": len(wall_triangle_offsets),
        "surface_materials": material_palette,
        "surface_material_triangle_count": len(triangle_materials),
        "ybn_count": len(ybn_names),
        "source_ybn_names": ybn_names,
        "base_ybn_candidate_count": len(items),
        "skipped_ybn_count": skipped_ybns,
        "replaced_base_ybn_count": replaced_base_ybns,
        "loose_ybn_source_count": len(loose_paths),
        "loose_ybn_loaded_count": len(loose_ybns),
        "loose_ybn_duplicate_hash_count": max(0, len(loose_paths) - loose_skipped - len(loose_ybns)),
        "loose_ybn_count": loose_added,
        "loose_ybn_skipped_count": loose_skipped,
        "resource_ybn_offsets": {key: list(value) for key, value in sorted(resource_ybn_offsets.items())},
        "resource_ybn_transforms": {
            key: {"translation": list(value[0]), "rotation": list(value[1])}
            for key, value in sorted(resource_ybn_transforms.items())
        },
        "source_polygon_counts": dict(source_polygon_counts),
        "emitted_triangle_counts": dict(emitted_triangle_counts),
        "unsupported_polygon_counts": dict(unsupported_polygon_counts),
        "traced_triangle": traced_triangle,
        "role": "exterior_ybn_ground_collision",
    }
    meta_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "binary": str(bin_path), "metadata": str(meta_path), **metadata}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

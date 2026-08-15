#!/usr/bin/env python3
"""Export exterior GTA YBN collision triangles for a browser-ground tile.

The output is deliberately a small binary format rather than JSON: static collision is
often several hundred thousand triangles even for a short walking radius. The viewer
uses these triangles for vertical ground queries; it does not render them.

Run from the repository root on Windows:
  python webgl_viewer/tools/export_ybn_collision_tile.py --gta-path "K:\\steam\\steamapps\\common\\Grand Theft Auto V" --x 186.94 --y -850.84
"""

from __future__ import annotations

import argparse
import json
import logging
import struct
import sys
from pathlib import Path
from typing import Any, Iterable


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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gta-path", required=True, help="Path to the GTA V installation.")
    ap.add_argument("--x", type=float, required=True, help="Tile center X in GTA data space.")
    ap.add_argument("--y", type=float, required=True, help="Tile center Y in GTA data space.")
    ap.add_argument("--radius", type=float, default=350.0, help="Half-width of the collision tile in meters.")
    ap.add_argument("--load-passes", type=int, default=24, help="CodeWalker lazy-cache drain passes per YBN.")
    ap.add_argument(
        "--output-dir",
        default=str(Path(__file__).resolve().parents[1] / "assets" / "collision"),
        help="Output directory for the tile binary and metadata.",
    )
    ap.add_argument("--name", default="ybn_spawn", help="Output base name without extension.")
    args = ap.parse_args()

    logging.disable(logging.CRITICAL)
    repo_root = Path(__file__).resolve().parents[2]
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

    from gta5_modules.dll_manager import DllManager

    radius = max(10.0, float(args.radius))
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
    if not dll.init_world_space():
        raise SystemExit("CodeWalker World.Space failed to initialize.")

    layers = System.Array[System.Boolean]([True, False, False])
    result = dll.world_space.BoundsStore.GetItems(
        SharpDX.Vector3(min_x, min_y, -1000.0),
        SharpDX.Vector3(max_x, max_y, 3000.0),
        layers,
    )
    items = result[0]

    vertices: list[float] = []
    indices: list[int] = []
    ybn_names: list[str] = []
    skipped_ybns = 0

    for item in items:
        name_hash = int(item.Name.Hash)
        ybn = dll.game_file_cache.GetYbn(name_hash)
        for _ in range(max(0, int(args.load_passes))):
            if ybn is not None and bool(getattr(ybn, "Loaded", False)):
                break
            dll.game_file_cache.ContentThreadProc()
            ybn = dll.game_file_cache.GetYbn(name_hash)
        if ybn is None or not bool(getattr(ybn, "Loaded", False)) or getattr(ybn, "Bounds", None) is None:
            skipped_ybns += 1
            continue

        vertex_map: dict[int, int] = {}
        added_for_ybn = False
        for geometry in _iter_geometries(ybn.Bounds):
            polygons = getattr(geometry, "Polygons", None) or []
            for polygon in polygons:
                source_indices = list(getattr(polygon, "VertexIndices", None) or [])
                if len(source_indices) != 3:
                    continue
                try:
                    points = tuple(
                        (
                            float(geometry.GetVertexPos(int(source_index)).X),
                            float(geometry.GetVertexPos(int(source_index)).Y),
                            float(geometry.GetVertexPos(int(source_index)).Z),
                        )
                        for source_index in source_indices
                    )
                except Exception:
                    continue
                if not _overlaps_xy(points, min_x, min_y, max_x, max_y):
                    continue

                triangle: list[int] = []
                for source_index, point in zip(source_indices, points):
                    key = (id(geometry), int(source_index))
                    output_index = vertex_map.get(key)
                    if output_index is None:
                        output_index = len(vertices) // 3
                        vertex_map[key] = output_index
                        vertices.extend(point)
                    triangle.append(output_index)
                indices.extend(triangle)
                added_for_ybn = True
        if added_for_ybn:
            ybn_names.append(str(item.Name))

    if not indices:
        raise SystemExit("No YBN triangles were found in the requested tile.")

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    base_name = str(args.name).strip() or "ybn_spawn"
    bin_path = output_dir / f"{base_name}.bin"
    meta_path = output_dir / f"{base_name}.json"
    with bin_path.open("wb") as handle:
        handle.write(b"YBNC")
        handle.write(struct.pack("<III", 1, len(vertices) // 3, len(indices)))
        handle.write(struct.pack(f"<{len(vertices)}f", *vertices))
        handle.write(struct.pack(f"<{len(indices)}I", *indices))

    metadata = {
        "format": "YBNC",
        "version": 1,
        "file": bin_path.name,
        "center": {"x": float(args.x), "y": float(args.y)},
        "bounds": {"min_x": min_x, "min_y": min_y, "max_x": max_x, "max_y": max_y},
        "vertex_count": len(vertices) // 3,
        "triangle_count": len(indices) // 3,
        "ybn_count": len(ybn_names),
        "skipped_ybn_count": skipped_ybns,
        "role": "exterior_ybn_ground_collision",
    }
    meta_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "binary": str(bin_path), "metadata": str(meta_path), **metadata}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

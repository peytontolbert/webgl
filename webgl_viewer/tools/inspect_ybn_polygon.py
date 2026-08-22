#!/usr/bin/env python3
"""Inspect one CodeWalker YBN polygon and its collision material."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any

from export_ybn_collision_tile import _iter_geometries, _joaat, _point


def scalar_attributes(value: Any) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for attribute in dir(value):
        if attribute.startswith("_"):
            continue
        try:
            item = getattr(value, attribute)
        except Exception:
            continue
        if isinstance(item, (str, int, float, bool)):
            output[attribute] = item
        elif item is not None and not callable(item):
            rendered = str(item)
            if len(rendered) <= 160:
                output[attribute] = rendered
    return output


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gta-path", required=True)
    parser.add_argument("--ybn", required=True)
    parser.add_argument("--geometry-index", type=int, required=True)
    parser.add_argument("--polygon-index", type=int, required=True)
    parser.add_argument("--load-passes", type=int, default=24)
    args = parser.parse_args()

    logging.disable(logging.CRITICAL)
    repo_root = Path(__file__).resolve().parents[2]
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))
    from gta5_modules.dll_manager import DllManager

    dll = DllManager(str(args.gta_path))
    from CodeWalker.GameFiles import BoundsMaterialTypes
    if not getattr(dll, "initialized", False) or not dll.init_world_space():
        raise SystemExit("CodeWalker failed to initialize")
    BoundsMaterialTypes.Init(dll.game_file_cache)
    ybn = dll.game_file_cache.GetYbn(_joaat(args.ybn))
    for _ in range(max(0, args.load_passes)):
        if ybn is not None and bool(getattr(ybn, "Loaded", False)):
            break
        dll.game_file_cache.ContentThreadProc()
        ybn = dll.game_file_cache.GetYbn(_joaat(args.ybn))
    if ybn is None or not bool(getattr(ybn, "Loaded", False)):
        raise SystemExit(f"YBN did not load: {args.ybn}")

    geometries = list(_iter_geometries(ybn.Bounds))
    geometry = geometries[args.geometry_index]
    polygon = geometry.Polygons[args.polygon_index]
    material_index = int(polygon.MaterialIndex)
    material = geometry.Materials[material_index]
    material_type = material.Type
    material_data = material_type.MaterialData
    print(json.dumps({
        "ybn": args.ybn,
        "geometry_index": args.geometry_index,
        "polygon_index": args.polygon_index,
        "polygon_type": type(polygon).__name__,
        "polygon": scalar_attributes(polygon),
        "points": [_point(point) for point in (polygon.VertexPositions or [])],
        "material_index": material_index,
        "material": scalar_attributes(material),
        "material_type": scalar_attributes(material_type),
        "material_data": scalar_attributes(material_data) if material_data is not None else None,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

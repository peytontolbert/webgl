#!/usr/bin/env python3
"""Export GTA V YNV pedestrian polygons for the bounded browser demo."""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from gta5_modules.dll_manager import DllManager
from gta5_modules.hash_utils import joaat


logging.getLogger("gta5_modules.dll_manager").setLevel(logging.WARNING)


def _vec3(value) -> list[float]:
    return [round(float(value.X), 4), round(float(value.Y), 4), round(float(value.Z), 4)]


def _wait_loaded(gfc, asset, spins: int):
    for _ in range(max(1, spins)):
        if asset is None or bool(getattr(asset, "Loaded", False)):
            break
        gfc.ContentThreadProc()
    return asset if asset is not None and bool(getattr(asset, "Loaded", False)) else None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=str(Path(__file__).resolve().parents[1] / "demo_world.json"))
    parser.add_argument("--game-path", default=os.getenv("gta_location") or os.getenv("gta5_path") or "")
    parser.add_argument("--output", default="webgl_viewer/assets/navigation/demo_navmesh.json")
    parser.add_argument("--center-x", type=float, default=None)
    parser.add_argument("--center-y", type=float, default=None)
    parser.add_argument("--size", type=float, default=None)
    parser.add_argument("--min-z", type=float, default=-10.0)
    parser.add_argument("--max-z", type=float, default=80.0)
    parser.add_argument("--spins", type=int, default=1600)
    args = parser.parse_args()

    config = json.loads(Path(args.config).resolve().read_text(encoding="utf-8")) if args.config else {}
    center = config.get("center") if isinstance(config.get("center"), dict) else {}
    args.center_x = float(args.center_x if args.center_x is not None else center.get("x"))
    args.center_y = float(args.center_y if args.center_y is not None else center.get("y"))
    args.size = float(args.size if args.size is not None else config.get("size"))
    if not all(math.isfinite(value) for value in (args.center_x, args.center_y, args.size)) or args.size <= 0:
        parser.error("demo world center/size must be finite and size must be positive")

    game_path = str(args.game_path or "").strip().strip('"').strip("'")
    if not game_path:
        raise SystemExit("Missing --game-path")

    half = args.size * 0.5
    bounds = {
        "minX": args.center_x - half,
        "maxX": args.center_x + half,
        "minY": args.center_y - half,
        "maxY": args.center_y + half,
    }
    cell_size = 150.0
    corner = -6000.0
    min_cell_x = max(0, int(math.floor((bounds["minX"] - corner) / cell_size)))
    max_cell_x = min(99, int(math.floor((bounds["maxX"] - corner) / cell_size)))
    min_cell_y = max(0, int(math.floor((bounds["minY"] - corner) / cell_size)))
    max_cell_y = min(99, int(math.floor((bounds["maxY"] - corner) / cell_size)))

    dm = DllManager(game_path)
    if not dm.initialized or not dm.init_game_file_cache(
        load_vehicles=False,
        load_peds=False,
        load_audio=False,
        selected_dlc="all",
    ):
        raise SystemExit("Could not initialize CodeWalker GameFileCache")
    gfc = dm.get_game_file_cache()

    nodes: dict[str, dict] = {}
    tile_names: list[str] = []
    for cell_x in range(min_cell_x, max_cell_x + 1):
        for cell_y in range(min_cell_y, max_cell_y + 1):
            name = f"navmesh[{cell_x * 3}][{cell_y * 3}]"
            nav_hash = int(joaat(name)) & 0xFFFFFFFF
            ynv = _wait_loaded(gfc, gfc.GetYnv(nav_hash), args.spins)
            if ynv is None:
                continue
            tile_names.append(name)
            area_id = int(getattr(ynv, "AreaID", cell_y * 100 + cell_x))
            for poly in list(getattr(ynv, "Polys", None) or []):
                center = _vec3(poly.Position)
                if not (
                    bounds["minX"] - cell_size <= center[0] <= bounds["maxX"] + cell_size
                    and bounds["minY"] - cell_size <= center[1] <= bounds["maxY"] + cell_size
                ):
                    continue
                poly_index = int(poly.Index)
                node_id = f"{area_id}:{poly_index}"
                links: set[str] = set()
                for edge in list(getattr(poly, "Edges", None) or []):
                    for adjacent_area, adjacent_poly in (
                        (int(edge.AreaID1), int(edge.PolyID1)),
                        (int(edge.AreaID2), int(edge.PolyID2)),
                    ):
                        if adjacent_area == 0x3FFF or adjacent_poly == 0x3FFF:
                            continue
                        adjacent_id = f"{adjacent_area}:{adjacent_poly}"
                        if adjacent_id != node_id:
                            links.add(adjacent_id)
                nodes[node_id] = {
                    "id": node_id,
                    "areaId": area_id,
                    "polyIndex": poly_index,
                    "center": center,
                    "vertices": [_vec3(vertex) for vertex in list(poly.Vertices or [])],
                    "links": sorted(links),
                    "flags": {
                        "footpath": bool(poly.B02_IsFootpath),
                        "underground": bool(poly.B03_IsUnderground),
                        "steep": bool(poly.B06_SteepSlope),
                        "water": bool(poly.B07_IsWater),
                        "interior": bool(poly.B14_IsInterior),
                        "flatGround": bool(poly.B17_IsFlatGround),
                        "road": bool(poly.B18_IsRoad),
                    },
                }

    source_poly_count = len(nodes)
    # Runtime pedestrians use authored footpaths and non-road flat ground. GTA's
    # YNV also contains roads, water, tunnels, interiors, and vertically stacked
    # surfaces that do not belong in this bounded street-level demo graph.
    nodes = {
        node_id: {
            "id": node_id,
            "center": node["center"],
            "links": node["links"],
            "walkClass": "footpath" if node["flags"]["footpath"] else "flatGround",
        }
        for node_id, node in nodes.items()
        if bounds["minX"] <= node["center"][0] <= bounds["maxX"]
        and bounds["minY"] <= node["center"][1] <= bounds["maxY"]
        and args.min_z <= node["center"][2] <= args.max_z
        and not node["flags"]["water"]
        and not node["flags"]["steep"]
        and not node["flags"]["underground"]
        and not node["flags"]["interior"]
        and (node["flags"]["footpath"] or (node["flags"]["flatGround"] and not node["flags"]["road"]))
    }

    # Remove links to polygons outside the compact street-level graph.
    node_ids = set(nodes)
    for node in nodes.values():
        node["links"] = [link for link in node["links"] if link in node_ids]

    payload = {
        "schema": "webglgta-ynv-navigation-v1",
        "source": "GTA V YNV via CodeWalker",
        "bounds": {key: round(value, 4) for key, value in bounds.items()},
        "cellSize": cell_size,
        "tiles": tile_names,
        "sourcePolygonCount": source_poly_count,
        "nodes": list(nodes.values()),
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    link_count = sum(len(node["links"]) for node in nodes.values())
    print(f"Exported {len(nodes)} polygons and {link_count} directed links from {len(tile_names)} YNV tiles to {output}")


if __name__ == "__main__":
    main()

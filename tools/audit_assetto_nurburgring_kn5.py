#!/usr/bin/env python3
"""Report why individual Nordschleife KN5 sectors are or are not rendered."""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

from assetto_nurburgring_scene_compiler import NON_VISUAL_MATERIALS, is_non_visual_node, load_parser, read_kn5_textured


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--track-root", required=True, type=Path)
    parser.add_argument("--kn5-parser", type=Path, default=Path(r"K:\WebGL_Tools\tools\assetto_corsa_kn5_to_obj.py"))
    parser.add_argument("sectors", nargs="+", help="KN5 names relative to --track-root")
    args = parser.parse_args()
    reader = load_parser(args.kn5_parser.resolve())
    report = []
    for name in args.sectors:
        path = args.track_root / name
        materials, nodes, _textures = read_kn5_textured(reader, path)
        node_types = Counter()
        triangles_by_material = defaultdict(int)
        visual_by_material = defaultdict(int)
        helper_triangles = 0
        mesh_nodes = []
        for node in nodes:
            node_types[str(getattr(node, "type", None))] += 1
            indices = getattr(node, "indices", None) or []
            triangles = len(indices) // 3
            if not triangles:
                continue
            material_id = int(getattr(node, "material_id", -1))
            material = str(materials[material_id].get("name") if 0 <= material_id < len(materials) else "unknown")
            triangles_by_material[material] += triangles
            is_geometry = getattr(node, "type", None) in (2, 3)
            is_helper = is_non_visual_node(str(getattr(node, "name", "")))
            if is_geometry and not is_helper and material.strip().lower() not in NON_VISUAL_MATERIALS:
                visual_by_material[material] += triangles
            elif is_helper:
                helper_triangles += triangles
            mesh_nodes.append({
                "name": str(getattr(node, "name", "")),
                "type": int(getattr(node, "type", -1)),
                "parent": int(getattr(node, "parent", -1)),
                "material": material,
                "triangles": triangles,
                "active": bool(getattr(node, "active", True)),
                "visible": bool(getattr(node, "visible", True)),
                "renderable": bool(getattr(node, "renderable", True)),
                "transparent": bool(getattr(node, "transparent", False)),
                "castShadows": bool(getattr(node, "cast_shadows", True)),
                "layer": int(getattr(node, "layer", 0) or 0),
                "lodIn": float(getattr(node, "lod_in", 0.0) or 0.0),
                "lodOut": float(getattr(node, "lod_out", 0.0) or 0.0),
            })
        report.append({
            "source": name,
            "nodeTypes": dict(sorted(node_types.items())),
            "trianglesByMaterial": dict(sorted(triangles_by_material.items(), key=lambda row: (-row[1], row[0]))),
            "renderableTrianglesByMaterial": dict(sorted(visual_by_material.items(), key=lambda row: (-row[1], row[0]))),
            "helperTriangles": helper_triangles,
            "renderableTriangleCount": sum(visual_by_material.values()),
            "meshNodes": mesh_nodes,
        })
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

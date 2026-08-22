#!/usr/bin/env python3
"""Audit authored Assetto surface nodes and physics coverage for a track layout."""

from __future__ import annotations

import argparse
import configparser
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

from assetto_nurburgring_scene_compiler import load_parser, read_kn5_textured, static_model_entries


def read_surfaces(path: Path) -> dict[str, dict[str, object]]:
    parser = configparser.ConfigParser(interpolation=None)
    parser.read(path, encoding="utf-8-sig")
    result: dict[str, dict[str, object]] = {}
    for section in parser.sections():
        key = parser.get(section, "KEY", fallback="").strip().upper()
        if not key:
            continue
        result[key] = {
            "friction": parser.getfloat(section, "FRICTION", fallback=1.0),
            "validTrack": parser.getboolean(section, "IS_VALID_TRACK", fallback=False),
            "pitlane": parser.getboolean(section, "IS_PITLANE", fallback=False),
            "damping": parser.getfloat(section, "DAMPING", fallback=0.0),
        }
    return result


def surface_key(node_name: str, known: set[str]) -> str | None:
    # Kunos' dedicated physics KN5 numbers its nodes before the surfaces.ini
    # key (for example 88TRM-NRM or 1PITS12).
    name = str(node_name or "").strip().upper()
    if not re.match(r"^\d", name):
        return None
    payload = re.sub(r"^\d+", "", name)
    matches = [key for key in known if payload == key or payload.startswith(key + "_") or re.match(rf"^{re.escape(key)}\d", payload)]
    return max(matches, key=len) if matches else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--track-root", required=True, type=Path)
    parser.add_argument("--layout", default="models_nordschleife.ini")
    parser.add_argument("--surfaces", required=True, type=Path)
    parser.add_argument("--kn5-parser", type=Path, default=Path(r"K:\WebGL_Tools\tools\assetto_corsa_kn5_to_obj.py"))
    args = parser.parse_args()

    surfaces = read_surfaces(args.surfaces)
    reader = load_parser(args.kn5_parser.resolve())
    totals: Counter[str] = Counter()
    nodes_by_surface: dict[str, list[dict[str, object]]] = defaultdict(list)
    unmatched: Counter[str] = Counter()
    for entry in static_model_entries(args.track_root, args.layout):
        source = str(entry["file"])
        _materials, nodes, _textures = read_kn5_textured(reader, args.track_root / source)
        for node in nodes:
            indices = getattr(node, "indices", None) or []
            triangles = len(indices) // 3
            if not triangles or getattr(node, "type", None) not in (2, 3):
                continue
            key = surface_key(str(getattr(node, "name", "")), set(surfaces))
            if not key:
                if re.match(r"^\d", str(getattr(node, "name", "")).strip().upper()):
                    unmatched[str(getattr(node, "name", ""))] += triangles
                continue
            totals[key] += triangles
            nodes_by_surface[key].append({"source": source, "name": str(node.name), "triangles": triangles})

    unmatched_families: Counter[str] = Counter()
    for name, triangles in unmatched.items():
        family = re.sub(r"[_\d].*$", "", re.sub(r"^\d+", "", name.upper())) or "UNKNOWN"
        unmatched_families[family] += triangles
    print(json.dumps({
        "schema": "webglgta-assetto-surface-audit-v1",
        "layout": args.layout,
        "surfaces": {
            key: {**record, "triangles": totals[key], "nodes": nodes_by_surface[key]}
            for key, record in surfaces.items()
        },
        "matchedTriangles": sum(totals.values()),
        "unmatchedNumericPrefixNodes": dict(unmatched.most_common()),
        "unmatchedFamilies": dict(unmatched_families.most_common()),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

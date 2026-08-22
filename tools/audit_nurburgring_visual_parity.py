#!/usr/bin/env python3
"""Read-only visual-coverage audit for the local Assetto Nordschleife source.

Compares every official static layout sector and the layout's dynamic-object
assets with a generated browser scene.  It intentionally reports source
channels the WebGL material renderer does not yet consume: those are fidelity
gaps, not missing files.
"""

from __future__ import annotations

import argparse
import configparser
import json
from collections import Counter
from pathlib import Path

from assetto_nurburgring_scene_compiler import (
    NON_VISUAL_MATERIALS,
    is_non_visual_node,
    load_parser,
    read_kn5_textured,
    static_model_entries,
)


LAYOUTS = (
    "models_endurance.ini",
    "models_endurance_cup.ini",
    "models_nordschleife.ini",
    "models_touristenfahrten.ini",
)
PACKED_CHANNELS = {
    "txDiffuse", "txNormal", "txMaps", "txDetail", "txMask", "txDetailNM",
    "txNormalDetail", "txVariation", "txDetailR", "txDetailG", "txDetailB", "txDetailA",
}
RENDERED_CHANNELS = {
    "txDiffuse", "txNormal", "txMaps", "txDetail", "txMask", "txDetailNM",
    "txNormalDetail", "txVariation", "txDetailR", "txDetailG", "txDetailB", "txDetailA",
}


def dynamic_sources(track_root: Path, layout: str) -> set[str]:
    parser = configparser.ConfigParser(interpolation=None)
    parser.read(track_root / layout, encoding="utf-8-sig")
    return {
        parser.get(section, "FILE").strip()
        for section in parser.sections()
        if section.upper().startswith("DYNAMIC_OBJECT_")
        and parser.has_option(section, "FILE")
        and (track_root / parser.get(section, "FILE").strip()).is_file()
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--track-root", required=True, type=Path)
    parser.add_argument("--scene-dir", required=True, type=Path)
    parser.add_argument("--append-scene", action="append", default=[], type=Path)
    parser.add_argument("--kn5-parser", type=Path, default=Path(r"K:\WebGL_Tools\tools\assetto_corsa_kn5_to_obj.py"))
    args = parser.parse_args()
    root = args.track_root.resolve()
    scene_path = args.scene_dir if args.scene_dir.is_file() else args.scene_dir / "scene.json"
    manifest = json.loads(scene_path.read_text(encoding="utf-8"))
    manifests = [manifest, *(json.loads(path.read_text(encoding="utf-8")) for path in args.append_scene)]
    browser_sources = {
        str(model.get("source", "")).lower()
        for current in manifests
        for model in current.get("models", [])
    }
    static = {str(entry["file"]) for layout in LAYOUTS for entry in static_model_entries(root, layout)}
    dynamic = {name for layout in LAYOUTS for name in dynamic_sources(root, layout)}
    reader = load_parser(args.kn5_parser.resolve())
    channel_uses: Counter[str] = Counter()
    missing_embedded: Counter[str] = Counter()
    sectors: list[dict[str, object]] = []

    def visual_node(node: object, materials: list[dict[str, object]]) -> bool:
        material_id = int(getattr(node, "material_id", -1))
        return (
            getattr(node, "type", None) in (2, 3)
            and bool(getattr(node, "indices", None))
            and bool(getattr(node, "active", True))
            and bool(getattr(node, "visible", True))
            and bool(getattr(node, "renderable", True))
            and not is_non_visual_node(str(getattr(node, "name", "")))
            and 0 <= material_id < len(materials)
            and str(materials[material_id].get("name", "")).lower() not in NON_VISUAL_MATERIALS
        )

    for name in sorted(static | dynamic, key=str.lower):
        materials, nodes, embedded = read_kn5_textured(reader, root / name)
        used_materials = {
            int(getattr(node, "material_id", -1))
            for node in nodes
            if visual_node(node, materials)
        }
        triangles = sum(
            len(getattr(node, "indices", []) or []) // 3
            for node in nodes
            if visual_node(node, materials)
        )
        for material_id in used_materials:
            for channel, texture in dict(materials[material_id].get("samples", {})).items():
                channel_uses[channel] += 1
                if str(texture).replace("\\", "/").lower() not in embedded:
                    missing_embedded[channel] += 1
        sectors.append({
            "source": name,
            "kind": "dynamic" if name in dynamic else "static",
            "renderableTriangles": triangles,
            "inBrowserScene": name.lower() in browser_sources,
        })
    print(json.dumps({
        "staticSources": len(static),
        "dynamicSources": len(dynamic),
        "browserSources": len(browser_sources),
        "missingStaticSources": sorted(name for name in static if name.lower() not in browser_sources),
        "omittedDynamicSources": sorted(name for name in dynamic if name.lower() not in browser_sources),
        "sourceTextureChannels": dict(sorted(channel_uses.items())),
        "packedButNotRenderedChannels": sorted(channel for channel in channel_uses if channel in PACKED_CHANNELS - RENDERED_CHANNELS),
        "unpackedChannels": sorted(channel for channel in channel_uses if channel not in PACKED_CHANNELS),
        "missingEmbeddedTextureReferences": dict(sorted(missing_embedded.items())),
        "sectors": sectors,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

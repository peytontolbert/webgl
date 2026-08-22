#!/usr/bin/env python3
"""Compile Assetto layout dynamic objects into an auditable browser scene.

Assetto chooses random positions and velocities at runtime. The WebGL demo
currently consumes static spatial cells, so this compiler resolves one stable
position per dynamic source while retaining the complete authored INI record
for a future moving-object runtime.
"""

from __future__ import annotations

import argparse
import configparser
import hashlib
import json
from pathlib import Path
from typing import Any

from assetto_nurburgring_scene_compiler import TexturePack, compile_model, load_parser


def vector(raw: str, default: tuple[float, float, float]) -> tuple[float, float, float]:
    try:
        values = tuple(float(part.strip()) for part in raw.split(","))
    except (TypeError, ValueError):
        return default
    return values if len(values) == 3 else default


def resolved_position(source: str, center: tuple[float, float, float], span: tuple[float, float, float]) -> tuple[float, float, float]:
    digest = hashlib.sha256(source.lower().encode("utf-8")).digest()
    # Stay away from the extreme edge of the authored random range. The hash
    # keeps generation reproducible without hardcoding per-asset coordinates.
    offsets = tuple(((digest[index] / 255.0) * 2.0 - 1.0) * component * 0.7 for index, component in enumerate(span))
    return tuple(center[index] + offsets[index] for index in range(3))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--track-root", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--layout", default="models_nordschleife.ini")
    parser.add_argument("--kn5-parser", type=Path, default=Path(r"K:\WebGL_Tools\tools\assetto_corsa_kn5_to_obj.py"))
    parser.add_argument("--origin", default="-516.2700195,139.6994476,2351.2604980")
    parser.add_argument("--placement", default="7000,-850,32")
    parser.add_argument("--bounds-min", default="4300,-5900,-400")
    parser.add_argument("--bounds-span", default="7300,5600,1200")
    parser.add_argument("--texture-quality", type=int, default=82)
    parser.add_argument("--texture-max-size", type=int, default=2048)
    args = parser.parse_args()

    track_root = args.track_root.resolve()
    out_dir = args.out_dir.resolve()
    layout_path = track_root / Path(args.layout).name
    ini = configparser.ConfigParser(interpolation=None)
    if not ini.read(layout_path, encoding="utf-8-sig"):
        parser.error(f"layout not found: {layout_path}")

    origin = vector(args.origin, (0.0, 0.0, 0.0))
    placement = vector(args.placement, (0.0, 0.0, 0.0))
    bounds_min = vector(args.bounds_min, (0.0, 0.0, 0.0))
    bounds_span = vector(args.bounds_span, (1.0, 1.0, 1.0))
    reader = load_parser(args.kn5_parser.resolve())
    texture_pack = TexturePack(out_dir, quality=args.texture_quality, max_size=args.texture_max_size)
    models: list[dict[str, Any]] = []
    seen: set[str] = set()
    for section in ini.sections():
        if not section.upper().startswith("DYNAMIC_OBJECT_") or not ini.has_option(section, "FILE"):
            continue
        authored = {key.upper(): value.strip() for key, value in ini.items(section)}
        source_name = authored["FILE"]
        if source_name.lower() in seen:
            raise ValueError(f"duplicate dynamic source in {layout_path.name}: {source_name}")
        seen.add(source_name.lower())
        source = track_root / source_name
        if not source.is_file():
            raise FileNotFoundError(source)
        center = vector(authored.get("RND_POS_CENTER", ""), (0.0, 0.0, 0.0))
        span = vector(authored.get("RND_POS_RANGE", ""), (0.0, 0.0, 0.0))
        position = resolved_position(source_name, center, span) if authored.get("POS_MODE", "").upper() == "RANDOM" else center
        print(f"Compiling {source_name} at {position}", flush=True)
        model = compile_model(
            reader, source, out_dir / f"{Path(source_name).stem}.tnm",
            origin=origin, placement=placement, bounds_min=bounds_min, bounds_span=bounds_span,
            cell=0.0, texture_pack=texture_pack, model_position=position,
            position_format="float32",
        )
        if model["vertices"] < 3 or model["trianglesOutput"] < 1 or not model["groups"]:
            raise ValueError(f"dynamic source has no renderable output: {source_name}")
        model["dynamic"] = {
            "layout": layout_path.name,
            "section": section,
            "authored": authored,
            "resolvedPosition": list(position),
            "placementPolicy": "stable-sha256-within-authored-random-range-v1",
        }
        models.append(model)

    manifest = {
        "schema": "webglgta-track-scene-v1",
        "id": "nordschleife-dynamic-authored-v1",
        "coordinateSystem": "demo-data-x-y-z-up",
        "compression": {"positions": "float32 authored", "indices": "uint32", "transport": "gzip", "clusterCellM": 0},
        "bounds": {
            "minX": bounds_min[0], "minY": bounds_min[1], "minZ": bounds_min[2],
            "maxX": bounds_min[0] + bounds_span[0], "maxY": bounds_min[1] + bounds_span[1], "maxZ": bounds_min[2] + bounds_span[2],
        },
        "models": models,
        "source": {
            "layout": layout_path.name,
            "modelCount": len(models),
            "kind": "dynamic-object-static-spatial-adaptation",
            "attributes": ["position", "normal", "tangent", "uv0"],
            "textures": "webp",
            "materialChannels": "Assetto samples",
        },
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "scene.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "manifest": str(manifest_path), "models": len(models),
        "sources": [model["source"] for model in models],
        "triangles": sum(model["trianglesOutput"] for model in models),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

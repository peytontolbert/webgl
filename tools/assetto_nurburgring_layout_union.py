#!/usr/bin/env python3
"""Append every non-empty static KN5 used by the official Nordschleife layouts.

The initial browser scene used the Endurance layout alone. Assetto ships
separate static sectors for the standard, Cup, and Touristenfahrten layouts;
this tool makes the WebGL scene a union of those layout manifests.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from assetto_nurburgring_scene_compiler import TexturePack, compile_model, load_parser, static_model_entries


LAYOUTS = (
    "models_endurance.ini",
    "models_endurance_cup.ini",
    "models_nordschleife.ini",
    "models_touristenfahrten.ini",
)

# Audited from the local Kunos KN5 sources: both sectors contain only the
# `physics` material and must not be rendered (otherwise they become the large
# orange collision blob reported in the demo).
COLLISION_ONLY_SECTORS = frozenset({"19.kn5", "25.kn5"})


def vector(raw: str) -> tuple[float, float, float]:
    values = tuple(float(part.strip()) for part in raw.split(","))
    if len(values) != 3:
        raise ValueError("expected three comma-separated values")
    return values


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--track-root", required=True, type=Path)
    parser.add_argument("--scene-dir", required=True, type=Path)
    parser.add_argument("--kn5-parser", type=Path, default=Path(r"K:\WebGL_Tools\tools\assetto_corsa_kn5_to_obj.py"))
    parser.add_argument("--origin", default="-516.2700195,139.6994476,2351.2604980")
    parser.add_argument("--placement", default="7000,-850,32")
    parser.add_argument("--bounds-min", default="4300,-5900,-400")
    parser.add_argument("--bounds-span", default="7300,5600,1200")
    parser.add_argument("--cell", type=float, default=1.0)
    parser.add_argument("--position-format", choices=("quantized16", "float32"), default="quantized16")
    parser.add_argument("--texture-quality", type=int, default=82)
    parser.add_argument("--texture-max-size", type=int, default=2048)
    parser.add_argument("--replace", action="append", default=[], help="Recompile this existing KN5 source name; repeatable")
    args = parser.parse_args()

    manifest_path = args.scene_dir / "scene.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    models = manifest.get("models")
    if not isinstance(models, list):
        raise RuntimeError("scene manifest has no model list")
    if args.position_format == "float32":
        compression = manifest.setdefault("compression", {})
        compression["positions"] = "mixed: uint16 scenery, float32 authored parity sectors"
        compression["clusterCellM"] = 0
    # Earlier exports retained empty collision-only entries. They inflate the
    # streamed-sector count while producing no drawable geometry, so clean
    # them before calculating the resumable union.
    models[:] = [model for model in models if isinstance(model, dict) and model.get("groups")]
    track_root = args.track_root.resolve()
    desired: list[str] = []
    transforms: dict[str, dict] = {}
    for layout in LAYOUTS:
        for entry in static_model_entries(track_root, layout):
            name = str(entry["file"])
            if name not in desired:
                desired.append(name)
                transforms[name.lower()] = entry
    present = {str(model.get("source", "")).lower() for model in models}
    # The official layouts list collision-only sectors alongside scenery. A
    # scene manifest records sectors that were deliberately excluded so a
    # resumable union does not decompress and reprocess hundreds of thousands
    # of invisible physics triangles on every incremental export.
    source_meta = manifest.setdefault("source", {})
    excluded = {str(name).lower() for name in source_meta.get("excludedVisualSectors", [])} | COLLISION_ONLY_SECTORS
    replace = {str(name).lower() for name in args.replace}
    unknown_replace = replace - {name.lower() for name in desired}
    if unknown_replace:
        parser.error(f"--replace is not part of the official layout union: {sorted(unknown_replace)}")
    missing = [name for name in desired if (name.lower() not in present and name.lower() not in excluded) or name.lower() in replace]
    reader = load_parser(args.kn5_parser.resolve())
    texture_pack = TexturePack(args.scene_dir, quality=args.texture_quality, max_size=args.texture_max_size)
    origin, placement = vector(args.origin), vector(args.placement)
    bounds_min, bounds_span = vector(args.bounds_min), vector(args.bounds_span)
    added = []
    for name in missing:
        print(f"Compiling missing layout sector {name}", flush=True)
        models[:] = [model for model in models if str(model.get("source", "")).lower() != name.lower()]
        transform = transforms[name.lower()]
        model = compile_model(
            reader, track_root / name, args.scene_dir / f"{Path(name).stem}.tnm",
            origin=origin, placement=placement, bounds_min=bounds_min,
            bounds_span=bounds_span, cell=args.cell, texture_pack=texture_pack,
            model_position=transform["position"], model_rotation=transform["rotation"], position_format=args.position_format,
        )
        if model["vertices"] >= 3 and model["trianglesOutput"] >= 1 and model["groups"]:
            models.append(model)
            added.append(name)
        else:
            excluded.add(name.lower())
        # Make an interrupted export resumable instead of leaving an unknown
        # partially generated scene manifest.
        models.sort(key=lambda model: (0 if str(model.get("source", "")).lower() == "ks_nordschleife.kn5" else 1, str(model.get("source", "")).lower()))
        source_meta["layouts"] = list(LAYOUTS)
        source_meta["excludedVisualSectors"] = sorted(excluded)
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"requested": desired, "added": added, "models": len(models)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

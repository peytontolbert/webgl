#!/usr/bin/env python3
"""Audit CodeWalker YBN shape coverage used by the browser collision exporter."""

from __future__ import annotations

import argparse
from collections import Counter
import json
import logging
from pathlib import Path
import sys
from typing import Any, Iterable


def iter_bounds(bound: Any) -> Iterable[Any]:
    yield bound
    children = getattr(getattr(bound, "Children", None), "data_items", None)
    if children is not None:
        for child in children:
            if child is not None:
                yield from iter_bounds(child)


def joaat(value: str) -> int:
    result = 0
    for byte in value.lower().encode("utf-8"):
        result = (result + byte) & 0xFFFFFFFF
        result = (result + (result << 10)) & 0xFFFFFFFF
        result ^= result >> 6
    result = (result + (result << 3)) & 0xFFFFFFFF
    result ^= result >> 11
    return (result + (result << 15)) & 0xFFFFFFFF


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gta-path", required=True)
    parser.add_argument("--x", type=float, default=186.94)
    parser.add_argument("--y", type=float, default=-850.84)
    parser.add_argument("--radius", type=float, default=260.0)
    parser.add_argument("--resource-ybn-dir", action="append", default=[])
    parser.add_argument("--names-only", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    logging.disable(logging.CRITICAL)
    output_path = args.output.resolve() if args.output else None
    resource_paths = []
    for raw in args.resource_ybn_dir:
        candidate = Path(raw).resolve()
        if candidate.is_dir():
            resource_paths.extend(sorted(candidate.rglob("*.ybn")))
        elif candidate.is_file() and candidate.suffix.lower() == ".ybn":
            resource_paths.append(candidate)

    repo_root = Path(__file__).resolve().parents[2]
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))
    from gta5_modules.dll_manager import DllManager

    dll = DllManager(args.gta_path)
    if not getattr(dll, "initialized", False) or not dll.init_world_space():
        raise SystemExit("CodeWalker initialization failed")

    import SharpDX  # type: ignore
    import System  # type: ignore
    from CodeWalker.GameFiles import YbnFile  # type: ignore

    min_x = args.x - args.radius
    min_y = args.y - args.radius
    max_x = args.x + args.radius
    max_y = args.y + args.radius
    layers = System.Array[System.Boolean]([True, False, False])
    items = dll.world_space.BoundsStore.GetItems(
        SharpDX.Vector3(min_x, min_y, -1000.0),
        SharpDX.Vector3(max_x, max_y, 3000.0),
        layers,
    )[0]

    loose_by_hash: dict[int, list[str]] = {}
    for path in resource_paths:
        loose_by_hash.setdefault(joaat(path.stem), []).append(str(path))
    base_sources = [
        {
            "name": str(item.Name),
            "hash": int(item.Name.Hash),
            "replacementPaths": loose_by_hash.get(int(item.Name.Hash), []),
        }
        for item in items
    ]
    if args.names_only:
        print(json.dumps({
            "baseCandidates": len(items),
            "baseSources": base_sources,
            "replacementCount": sum(bool(item["replacementPaths"]) for item in base_sources),
        }, indent=2))
        return 0

    bound_types: Counter[str] = Counter()
    polygon_types: Counter[str] = Counter()
    index_counts: Counter[str] = Counter()
    property_samples: dict[str, list[str]] = {}
    value_samples: dict[str, dict[str, Any]] = {}
    loaded = 0
    skipped = 0

    def inspect(bounds: Any) -> None:
        for bound in iter_bounds(bounds):
            bound_types[type(bound).__name__] += 1
            for polygon in getattr(bound, "Polygons", None) or []:
                type_name = type(polygon).__name__
                polygon_types[type_name] += 1
                indices = list(getattr(polygon, "VertexIndices", None) or [])
                index_counts[f"{type_name}:{len(indices)}"] += 1
                if type_name not in property_samples:
                    property_samples[type_name] = sorted(
                        name for name in dir(polygon)
                        if not name.startswith("_") and name not in {"Equals", "GetHashCode", "GetType", "ToString"}
                    )
                    sample: dict[str, Any] = {}
                    for name in (
                        "VertexPositions", "VertexIndices", "BoxMin", "BoxMax",
                        "Position", "Scale", "Orientation", "capsuleRadius",
                        "cylinderRadius", "sphereRadius",
                    ):
                        value = getattr(polygon, name, None)
                        if value is None:
                            continue
                        try:
                            if hasattr(value, "X"):
                                sample[name] = [float(value.X), float(value.Y), float(value.Z)]
                                if hasattr(value, "W"):
                                    sample[name].append(float(value.W))
                            else:
                                converted = []
                                for item in value:
                                    if hasattr(item, "X"):
                                        converted.append([float(item.X), float(item.Y), float(item.Z)])
                                    else:
                                        converted.append(int(item))
                                sample[name] = converted
                        except (TypeError, ValueError):
                            try:
                                sample[name] = float(value)
                            except (TypeError, ValueError):
                                sample[name] = str(value)
                    value_samples[type_name] = sample

    for item in items:
        ybn = dll.game_file_cache.GetYbn(int(item.Name.Hash))
        for _ in range(24):
            if ybn is not None and bool(getattr(ybn, "Loaded", False)):
                break
            dll.game_file_cache.ContentThreadProc()
            ybn = dll.game_file_cache.GetYbn(int(item.Name.Hash))
        if ybn is None or not bool(getattr(ybn, "Loaded", False)) or getattr(ybn, "Bounds", None) is None:
            skipped += 1
            continue
        loaded += 1
        inspect(ybn.Bounds)

    loose_loaded = 0
    loose_errors: list[dict[str, str]] = []
    loose_bounds: list[dict[str, Any]] = []
    for path in dict.fromkeys(resource_paths):
        try:
            ybn = YbnFile()
            payload = System.Array[System.Byte](path.read_bytes())
            ybn.Load(payload)
            if getattr(ybn, "Bounds", None) is None:
                raise RuntimeError("loaded file has no Bounds")
            loose_loaded += 1
            bounds = ybn.Bounds
            bounds_min = getattr(bounds, "BoxMin", None)
            bounds_max = getattr(bounds, "BoxMax", None)
            bounds_center = getattr(bounds, "SphereCenter", None)
            loose_bounds.append({
                "file": path.name,
                "stem": path.stem,
                "boxMin": [float(bounds_min.X), float(bounds_min.Y), float(bounds_min.Z)] if bounds_min is not None else None,
                "boxMax": [float(bounds_max.X), float(bounds_max.Y), float(bounds_max.Z)] if bounds_max is not None else None,
                "sphereCenter": [float(bounds_center.X), float(bounds_center.Y), float(bounds_center.Z)] if bounds_center is not None else None,
            })
            inspect(ybn.Bounds)
        except Exception as error:
            loose_errors.append({"file": path.name, "error": str(error)})

    report = {
        "baseCandidates": len(items),
        "baseSources": base_sources,
        "baseLoaded": loaded,
        "baseSkipped": skipped,
        "looseCandidates": len(resource_paths),
        "looseLoaded": loose_loaded,
        "looseErrors": loose_errors[:10],
        "looseBounds": loose_bounds,
        "boundTypes": dict(bound_types.most_common()),
        "polygonTypes": dict(polygon_types.most_common()),
        "polygonIndexCounts": dict(index_counts.most_common()),
        "polygonPropertySamples": property_samples,
        "polygonValueSamples": value_samples,
    }
    rendered = json.dumps(report, indent=2)
    if output_path:
        output_path.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

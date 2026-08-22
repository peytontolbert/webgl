#!/usr/bin/env python3
"""Synchronize TrackSceneRenderer descriptors with their deployed TNM binaries.

The source exporter records authored counts, while later filtering/welding can
change the runtime TNM stream.  This tool records both and repairs only the safe
case where contiguous material ranges differ at their final range.  Interior
gaps, overlaps, missing files, and invalid triangle streams are hard failures.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from import_track_into_demo_renderer import read_tnm


def normalize(path: Path, *, write: bool) -> dict:
    descriptor = json.loads(path.read_text(encoding="utf-8"))
    models = descriptor.get("models") or []
    if not models:
        raise ValueError("descriptor contains no track models")
    changes: list[dict] = []
    totals = {"vertices": 0, "indices": 0, "groups": 0, "compressedBytes": 0}

    for model in models:
        relative = str(model.get("file") or "")
        binary_path = path.parent / relative
        if not relative or not binary_path.is_file():
            raise FileNotFoundError(f"missing track binary: {relative}")
        decoded = read_tnm(binary_path)
        vertices = len(decoded["positions"])
        indices = len(decoded["indices"])
        binary_groups = int(decoded.get("group_count") or 0)
        groups = model.get("groups") or []
        if indices < 3 or indices % 3:
            raise ValueError(f"invalid triangle stream: {relative} ({indices} indices)")
        if not groups:
            raise ValueError(f"descriptor has no material groups: {relative}")

        cursor = 0
        for group_index, group in enumerate(groups):
            offset = int(group.get("offset") or 0)
            count = int(group.get("count") or 0)
            if offset != cursor:
                raise ValueError(f"ambiguous material gap/overlap: {relative} group {group_index} starts {offset}, expected {cursor}")
            if count < 0 or count % 3:
                raise ValueError(f"invalid material count: {relative} group {group_index} ({count})")
            cursor += count
        if cursor != indices:
            last = groups[-1]
            last_offset = int(last.get("offset") or 0)
            corrected = indices - last_offset
            if corrected < 3 or corrected % 3:
                raise ValueError(f"cannot safely reconcile terminal range: {relative} {cursor} != {indices}")
            changes.append({
                "file": relative,
                "field": f"groups[{len(groups) - 1}].count",
                "before": int(last.get("count") or 0),
                "after": corrected,
            })
            last["count"] = corrected

        exact = {
            "binaryVertexCount": vertices,
            "binaryIndexCount": indices,
            "binaryGroupCount": binary_groups,
            "trianglesOutput": indices // 3,
            "compressedBytes": binary_path.stat().st_size,
        }
        for field, value in exact.items():
            if model.get(field) != value:
                changes.append({"file": relative, "field": field, "before": model.get(field), "after": value})
                model[field] = value
        model["materialGroupCount"] = len(groups)
        totals["vertices"] += vertices
        totals["indices"] += indices
        totals["groups"] += len(groups)
        totals["compressedBytes"] += binary_path.stat().st_size

    source = descriptor.setdefault("source", {})
    if source.get("modelCount") != len(models):
        changes.append({"file": "scene.json", "field": "source.modelCount", "before": source.get("modelCount"), "after": len(models)})
        source["modelCount"] = len(models)
    descriptor["runtimeCoverage"] = {
        "models": len(models),
        "materialGroups": totals["groups"],
        "binaryVertices": totals["vertices"],
        "binaryIndices": totals["indices"],
        "binaryTriangles": totals["indices"] // 3,
        "compressedBytes": totals["compressedBytes"],
        "descriptorBinarySynchronized": True,
    }
    if write:
        path.write_text(json.dumps(descriptor, separators=(",", ":")) + "\n", encoding="utf-8")
    return {"ok": True, "descriptor": str(path), "write": write, "changes": changes, "runtimeCoverage": descriptor["runtimeCoverage"]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("descriptor", type=Path)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    print(json.dumps(normalize(args.descriptor.resolve(), write=args.write), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

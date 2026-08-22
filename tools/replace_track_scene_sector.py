#!/usr/bin/env python3
"""Replace one generated track sector while preserving scene-level metadata."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scene", required=True, type=Path)
    parser.add_argument("--replacement-scene", required=True, type=Path)
    parser.add_argument("--source", required=True)
    args = parser.parse_args()

    scene_path = args.scene.resolve()
    replacement_path = args.replacement_scene.resolve()
    scene = json.loads(scene_path.read_text(encoding="utf-8"))
    replacement_scene = json.loads(replacement_path.read_text(encoding="utf-8"))
    wanted = Path(args.source).name.lower()
    replacements = [model for model in replacement_scene.get("models", []) if str(model.get("source", "")).lower() == wanted]
    if len(replacements) != 1:
        raise RuntimeError(f"expected one replacement for {args.source}, found {len(replacements)}")
    indexes = [index for index, model in enumerate(scene.get("models", [])) if str(model.get("source", "")).lower() == wanted]
    if len(indexes) != 1:
        raise RuntimeError(f"expected one existing sector for {args.source}, found {len(indexes)}")

    replacement = replacements[0]
    previous = scene["models"][indexes[0]]
    scene["models"][indexes[0]] = replacement
    source_payload = replacement_path.parent / str(replacement["file"])
    target_payload = scene_path.parent / str(replacement["file"])
    target_payload.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_payload, target_payload)
    for group in replacement.get("groups", []):
        for reference in (group.get("textures") or {}).values():
            source_texture = replacement_path.parent / str(reference)
            target_texture = scene_path.parent / str(reference)
            if source_texture.is_file() and not target_texture.is_file():
                target_texture.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source_texture, target_texture)

    models = scene["models"]
    scene.setdefault("source", {})["modelCount"] = len(models)
    if "sectorCount" in scene:
        scene["sectorCount"] = len(models)
    if "renderableSectorCount" in scene:
        scene["renderableSectorCount"] = sum(bool(model.get("groups")) and int(model.get("trianglesOutput", 0)) > 0 for model in models)
    measured_totals = {
        "vertices": sum(int(model.get("vertices", 0)) for model in models),
        "trianglesInput": sum(int(model.get("trianglesInput", 0)) for model in models),
        "trianglesOutput": sum(int(model.get("trianglesOutput", 0)) for model in models),
        "compressedBytes": sum(int(model.get("compressedBytes", model.get("bytes", 0))) for model in models),
        "decodedBytes": sum(int(model.get("decodedBytes", 0)) for model in models),
    }
    if isinstance(scene.get("completeness"), dict):
        totals = scene["completeness"].setdefault("totals", {})
        for key in ("vertices", "trianglesInput", "trianglesOutput", "compressedBytes", "decodedBytes"):
            old_value = int(previous.get(key, previous.get("bytes", 0) if key == "compressedBytes" else 0))
            new_value = int(replacement.get(key, replacement.get("bytes", 0) if key == "compressedBytes" else 0))
            totals[key] = int(totals.get(key, 0)) - old_value + new_value
    else:
        totals = measured_totals
    if isinstance(scene.get("spatialPartition"), dict):
        scene["spatialPartition"]["triangles"] = totals["trianglesOutput"]

    scene_path.write_text(json.dumps(scene, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"scene": str(scene_path), "source": args.source, "payload": str(target_payload), "totals": totals, "measuredTotals": measured_totals}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

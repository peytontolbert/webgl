#!/usr/bin/env python3
"""Register exported FiveM interiors with the streamed demo descriptor."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def _load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected an object in {path}")
    return value


def _coverage(path: Path) -> dict[str, int | str]:
    interior = _load_json(path)
    rooms = [item for item in interior.get("rooms", []) if isinstance(item, dict)]
    portals = [item for item in interior.get("portals", []) if isinstance(item, dict)]
    entity_sets = [item for item in interior.get("entitySets", []) if isinstance(item, dict)]
    return {
        "schema": str(interior.get("schema") or "webglgta-interior-v2"),
        "rooms": len(rooms),
        "portals": len(portals),
        "entitySets": len(entity_sets),
        "roomsWithTimecycle": sum(bool(item.get("timecycle")) for item in rooms),
        "portalsWithFlags": sum(bool(item.get("flags")) for item in portals),
        "portalsWithAudioOcclusion": sum(bool(item.get("audioOcclusion")) for item in portals),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets-dir", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, action="append", required=True)
    args = parser.parse_args()

    assets_dir = args.assets_dir.resolve()
    descriptor_path = assets_dir / "demo" / "spawn_district.json"
    descriptor = _load_json(descriptor_path)
    runtime = descriptor.setdefault("mloRuntime", {})
    if not isinstance(runtime, dict):
        raise ValueError("descriptor mloRuntime must be an object")

    root_hashes = {str(value) for value in runtime.get("interiorArchetypeHashes", [])}
    imported_root_hashes: set[str] = set()
    for metadata_path in args.metadata:
        metadata = _load_json(metadata_path.resolve())
        for root in metadata.get("roots", []):
            if isinstance(root, dict) and root.get("archetypeHash") is not None:
                hash_id = str(root["archetypeHash"])
                root_hashes.add(hash_id)
                imported_root_hashes.add(hash_id)

    coverage: dict[str, Any] = dict(runtime.get("coverage") or {})
    missing: list[str] = []
    for hash_id in sorted(imported_root_hashes, key=int):
        definition_path = assets_dir / "interiors" / f"{hash_id}.json"
        if not definition_path.is_file():
            missing.append(hash_id)
            continue
        coverage[hash_id] = _coverage(definition_path)
    if missing:
        raise ValueError(f"Interior definition files are missing for: {', '.join(missing)}")

    runtime["schema"] = "webglgta-mlo-runtime-v1"
    runtime["enabled"] = True
    runtime["interiorArchetypeHashes"] = sorted(root_hashes, key=int)
    runtime["coverage"] = coverage
    revision_source = json.dumps(
        {"roots": runtime["interiorArchetypeHashes"], "coverage": coverage},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    runtime["revision"] = hashlib.sha256(revision_source).hexdigest()[:16]
    descriptor_path.write_text(json.dumps(descriptor, indent=2) + "\n", encoding="utf-8")
    print(f"[mlo-runtime] registered {len(root_hashes)} interiors; revision={runtime['revision']}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Persist authoritative local MLO content bounds from the shipped ENT1/manifest.

This is both a migration tool for existing packages and a release repair tool.
New imports write the same field directly in import_fivem_mlo_demo.py.
"""

from __future__ import annotations

import argparse
import json
import struct
from collections import defaultdict
from pathlib import Path
from typing import Any

from import_fivem_mlo_demo import _content_bounds_for_archetype, _read_ent1_records


def decode_record(record: bytes) -> dict[str, Any]:
    return {
        "archetypeHash": str(struct.unpack_from("<I", record, 0)[0]),
        "position": list(struct.unpack_from("<3f", record, 4)),
        "rotation": list(struct.unpack_from("<4f", record, 16)),
        "scale": list(struct.unpack_from("<3f", record, 32)),
        "parentGuid": struct.unpack_from("<I", record, 52)[0],
        "flags": struct.unpack_from("<I", record, 60)[0],
        "children": [],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--descriptor", type=Path, required=True)
    parser.add_argument("--check", action="store_true", help="Validate without writing definitions")
    args = parser.parse_args()

    descriptor_path = args.descriptor.resolve()
    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
    assets = descriptor_path.parents[1]
    entity_path = assets / str(descriptor["instanceFile"])
    manifest_path = assets / str(descriptor["manifestFile"])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    records, stride = _read_ent1_records(entity_path)
    if stride != 64:
        raise SystemExit(f"authoritative MLO bounds require ENT1 stride 64, got {stride}")

    roots_by_guid: dict[int, dict[str, Any]] = {}
    children_by_guid: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for raw in records:
        record = decode_record(raw)
        guid = struct.unpack_from("<I", raw, 48)[0]
        if record["flags"] & 1 and guid:
            roots_by_guid[guid] = record
        if record["parentGuid"]:
            children_by_guid[record["parentGuid"]].append(record)
    for guid, root in roots_by_guid.items():
        root["children"] = children_by_guid.get(guid, [])

    roots = list(roots_by_guid.values())
    meshes = manifest.get("meshes") or {}
    nonrenderable = {str(value) for value in (manifest.get("nonRenderableHashes") or [])}
    definitions = assets / "interiors"
    report: dict[str, Any] = {}
    failures: list[str] = []
    for root_hash in sorted({root["archetypeHash"] for root in roots}, key=int):
        definition_path = definitions / f"{root_hash}.json"
        if not definition_path.is_file():
            failures.append(f"{root_hash}:missing-definition")
            continue
        definition = json.loads(definition_path.read_text(encoding="utf-8"))
        bounds = _content_bounds_for_archetype(root_hash, roots, meshes, nonrenderable, assets)
        if bounds is None or not bounds.get("complete"):
            failures.append(f"{root_hash}:incomplete-content-bounds")
        report[root_hash] = bounds
        if not args.check and bounds is not None:
            definition["schema"] = "webglgta-interior-v3"
            definition["contentBounds"] = bounds
            definition_path.write_text(json.dumps(definition, separators=(",", ":")), encoding="utf-8")

    output = {
        "schema": "webglgta-mlo-content-bounds-audit-v1",
        "ok": not failures,
        "roots": len(roots),
        "rootArchetypes": len(report),
        "failures": failures,
        "coverage": report,
    }
    print(json.dumps(output, indent=2))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())

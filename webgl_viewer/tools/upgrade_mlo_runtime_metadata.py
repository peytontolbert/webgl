#!/usr/bin/env python3
"""Embed exported room/portal ownership into an existing MLO ENT1 tile."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
from collections import defaultdict
from pathlib import Path
from typing import Any

from import_fivem_mlo_demo import (
    MLO_FLAG_ENTITY_SET_DEFAULT,
    MLO_PORTAL_SHIFT,
    MLO_ROOM_SHIFT,
    _read_ent1_records,
    _u32,
    _write_interior_definitions,
)


MATCH_POSITION_TOLERANCE = 0.2


def _record_position(record: bytes | bytearray) -> tuple[float, float, float]:
    return struct.unpack_from("<3f", record, 4)


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--metadata",
        type=Path,
        action="append",
        default=[],
        help="Exported MLO metadata file. Repeat to upgrade multiple resources in one pass.",
    )
    parser.add_argument(
        "--report-only",
        action="store_true",
        help="Refresh runtime coverage/report metadata without rewriting ENT1 ownership.",
    )
    parser.add_argument("--descriptor", type=Path, default=root / "assets/demo/spawn_district.json")
    args = parser.parse_args()
    if not args.metadata and not args.report_only:
        parser.error("at least one --metadata is required unless --report-only is used")

    descriptor_path = args.descriptor.resolve()
    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
    assets_dir = descriptor_path.parents[1]
    instance_path = descriptor_path.parent / Path(str(descriptor["instanceFile"])).name
    if not instance_path.is_file():
        instance_path = assets_dir / str(descriptor["instanceFile"])
    records, stride = _read_ent1_records(instance_path)
    if stride != 64:
        raise ValueError(f"Expected ENT1 stride 64, got {stride}")

    by_parent: dict[int, dict[int, set[int]]] = defaultdict(lambda: defaultdict(set))
    for index, record in enumerate(records):
        parent_guid = struct.unpack_from("<I", record, 52)[0]
        if not parent_guid:
            continue
        hash_id = struct.unpack_from("<I", record, 0)[0]
        by_parent[parent_guid][hash_id].add(index)

    metadata_inputs = [
        (path.resolve(), json.loads(path.resolve().read_text(encoding="utf-8")))
        for path in args.metadata
    ]
    updated = 0
    updated_by_metadata: dict[str, int] = {}
    missing: list[dict[str, Any]] = []
    mutable = [bytearray(record) for record in records]
    for metadata_path, metadata in metadata_inputs:
        input_updated = 0
        for root_item in metadata.get("roots") or []:
            root_hash = _u32(root_item.get("archetypeHash"))
            root_position = tuple(float(value) for value in (root_item.get("position") or (0, 0, 0))[:3])
            parent_guid = 0
            best_root_distance = float("inf")
            for record in records:
                hash_id = struct.unpack_from("<I", record, 0)[0]
                flags = struct.unpack_from("<I", record, 60)[0]
                if not (flags & 1) or hash_id != root_hash:
                    continue
                distance = math.dist(_record_position(record), root_position)
                if distance <= MATCH_POSITION_TOLERANCE and distance < best_root_distance:
                    parent_guid = struct.unpack_from("<I", record, 48)[0]
                    best_root_distance = distance
            if not parent_guid:
                raise RuntimeError(
                    f"Failed to find existing MLO root {root_hash} at {root_position} from {metadata_path}"
                )
            candidates = by_parent.get(parent_guid, {})
            for child in root_item.get("children") or []:
                child_hash = _u32(child.get("archetypeHash"))
                child_position = tuple(float(value) for value in (child.get("position") or (0, 0, 0))[:3])
                indices = candidates.get(child_hash) or set()
                record_index = min(
                    indices,
                    key=lambda index: math.dist(_record_position(records[index]), child_position),
                    default=-1,
                )
                distance = (
                    math.dist(_record_position(records[record_index]), child_position)
                    if record_index >= 0 else float("inf")
                )
                if record_index < 0 or distance > MATCH_POSITION_TOLERANCE:
                    missing.append({
                        "metadata": str(metadata_path),
                        "parentGuid": parent_guid,
                        "archetypeHash": child_hash,
                        "position": child_position,
                        "nearestDistance": None if not math.isfinite(distance) else round(distance, 6),
                    })
                    continue
                indices.remove(record_index)
                flags = struct.unpack_from("<I", mutable[record_index], 60)[0] & 0xFF
                room_index = int(child.get("roomIndex", -1))
                portal_index = int(child.get("portalIndex", -1))
                if child.get("entitySetHash") and bool(child.get("entitySetDefault")):
                    flags |= MLO_FLAG_ENTITY_SET_DEFAULT
                if 0 <= room_index < 255:
                    flags |= (room_index + 1) << MLO_ROOM_SHIFT
                if 0 <= portal_index < 255:
                    flags |= (portal_index + 1) << MLO_PORTAL_SHIFT
                struct.pack_into("<I", mutable[record_index], 60, flags)
                input_updated += 1
        updated += input_updated
        updated_by_metadata[str(metadata_path)] = input_updated

    if missing:
        raise RuntimeError(f"Failed to match {len(missing)} MLO children; first={missing[:3]}")

    if not args.report_only:
        temporary = instance_path.with_suffix(instance_path.suffix + ".tmp")
        with temporary.open("wb") as handle:
            handle.write(b"ENT1")
            handle.write(struct.pack("<I", len(mutable)))
            handle.writelines(mutable)
        temporary.replace(instance_path)

    descriptor_manifest = assets_dir / str(descriptor.get("manifestFile") or "")
    manifest = json.loads(descriptor_manifest.read_text(encoding="utf-8")) if descriptor_manifest.is_file() else {}
    meshes = manifest.get("meshes") or {}
    nonrenderable = {str(value) for value in (manifest.get("nonRenderableHashes") or [])}
    metadata_roots = [
        root_item
        for _, metadata in metadata_inputs
        for root_item in (metadata.get("roots") or [])
        if isinstance(root_item, dict)
    ]
    interior_count = 0
    for _, metadata in metadata_inputs:
        interior_count += _write_interior_definitions(
            metadata.get("interiors") or {}, assets_dir, metadata_roots, meshes, nonrenderable
        )

    coverage: dict[str, Any] = {}
    for path in sorted((assets_dir / "interiors").glob("*.json"), key=lambda item: int(item.stem)):
        if not path.stem.isdigit():
            continue
        definition = json.loads(path.read_text(encoding="utf-8"))
        rooms = definition.get("rooms") or []
        portals = definition.get("portals") or []
        coverage[path.stem] = {
            "schema": definition.get("schema"),
            "rooms": len(rooms),
            "portals": len(portals),
            "entitySets": len(definition.get("entitySets") or []),
            "roomsWithTimecycle": sum(1 for room in rooms if _u32(room.get("timecycleName"))),
            "portalsWithFlags": sum(1 for portal in portals if "flags" in portal),
            "portalsWithAudioOcclusion": sum(1 for portal in portals if "audioOcclusion" in portal),
            "authoritativeContentBounds": bool(definition.get("contentBounds", {}).get("complete")),
        }
    revision_digest = hashlib.sha256(instance_path.read_bytes())
    for hash_id in sorted(coverage, key=int):
        revision_digest.update((assets_dir / "interiors" / f"{hash_id}.json").read_bytes())
    revision = revision_digest.hexdigest()[:16]
    report = {
        "schema": "webglgta-mlo-runtime-upgrade-v1",
        "instanceFile": str(instance_path),
        "metadataFiles": [str(path) for path, _ in metadata_inputs],
        "updatedChildren": updated,
        "updatedChildrenByMetadata": updated_by_metadata,
        "interiorDefinitions": interior_count if metadata_inputs else len(coverage),
        "revision": revision,
        "coverage": coverage,
    }
    report_path = descriptor_path.parent / "spawn_district_mlo_runtime.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    interior_hashes = sorted(
        (path.stem for path in (assets_dir / "interiors").glob("*.json") if path.stem.isdigit()),
        key=int,
    )
    root_records = [
        record for record in records
        if len(record) >= 64 and (struct.unpack_from("<I", record, 60)[0] & 1)
    ]
    child_records = [
        record for record in records
        if len(record) >= 64 and struct.unpack_from("<I", record, 52)[0]
    ]
    imported_hashes = {str(struct.unpack_from("<I", record, 0)[0]) for record in child_records}
    # Later import passes may append complete MLO resources after the original
    # district build. Recompute the authoritative aggregate instead of leaving
    # the descriptor frozen at whichever resource happened to run first.
    descriptor["mloImport"] = {
        **(descriptor.get("mloImport") or {}),
        "retainedBaseInstanceCount": len(records) - len(root_records) - len(child_records),
        "mloRootCount": len(root_records),
        "mloChildCount": len(child_records),
        "totalInstanceCount": len(records),
        "interiorDefinitionCount": len(interior_hashes),
        "uniqueChildArchetypeCount": len(imported_hashes),
    }
    descriptor["instanceCount"] = len(records)
    descriptor["mloRuntime"] = {
        "schema": "webglgta-mlo-runtime-v1",
        "enabled": True,
        "roomPortalOwnership": True,
        "timecycles": True,
        "audioOcclusion": True,
        "entitySets": True,
        "revision": revision,
        "interiorArchetypeHashes": interior_hashes,
        "coverage": coverage,
        "reportFile": f"demo/{report_path.name}",
    }
    descriptor_path.write_text(json.dumps(descriptor, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

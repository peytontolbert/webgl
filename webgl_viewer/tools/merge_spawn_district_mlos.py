#!/usr/bin/env python3
"""Merge existing flagged MLO records into a newly built district stage."""

from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path


def read_records(path: Path) -> tuple[int, list[bytes]]:
    data = path.read_bytes()
    if len(data) < 8 or data[:4] != b"ENT1":
        raise ValueError(f"invalid ENT1 file: {path}")
    count = struct.unpack_from("<I", data, 4)[0]
    stride = (len(data) - 8) // count
    if count <= 0 or stride not in (44, 48, 64) or 8 + count * stride != len(data):
        raise ValueError(f"invalid ENT1 layout: {path}")
    return stride, [data[8 + i * stride:8 + (i + 1) * stride] for i in range(count)]


def to_v3(record: bytes) -> bytes:
    if len(record) == 64:
        return record
    if len(record) == 48:
        return record + bytes(16)
    return record + bytes(20)


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-demo-dir", type=Path, default=root / "assets/demo")
    parser.add_argument("--target-demo-dir", type=Path, required=True)
    args = parser.parse_args()
    source = args.source_demo_dir.resolve()
    target = args.target_demo_dir.resolve()
    source_descriptor = json.loads((source / "spawn_district.json").read_text(encoding="utf-8"))
    target_descriptor = json.loads((target / "spawn_district.json").read_text(encoding="utf-8"))

    # Residency preprocessing may later repoint the descriptor at a bounded
    # derivative. The canonical imported stream remains the complete source of
    # MLO roots/children and must win when it is present.
    source_ent = source / "spawn_district_entities_mlo.bin"
    if not source_ent.is_file():
        source_ent = source / Path(str(source_descriptor["instanceFile"])).name
    # A previously merged staging directory still retains its pristine base
    # outputs. Prefer them so rerunning this tool is deterministic and cannot
    # append the MLO segment more than once.
    target_ent = target / "spawn_district_entities.bin"
    if not target_ent.is_file():
        target_ent = target / Path(str(target_descriptor["instanceFile"])).name
    _, source_records = read_records(source_ent)
    _, target_records = read_records(target_ent)
    source_mlo = source_descriptor.get("mloImport") or {}
    # Takeover passes can remove source records and append exterior replacements,
    # so authored MLO records are not guaranteed to remain one contiguous slice.
    # Extended ENT1 ownership fields are stable across those transformations.
    mlo_records = [
        record for record in source_records
        if len(record) >= 64
        and (struct.unpack_from("<I", record, 60)[0] or struct.unpack_from("<I", record, 52)[0])
    ]
    selection = "metadata-flags"
    merged_records = [to_v3(r) for r in target_records] + mlo_records
    output_ent = target / "spawn_district_entities_mlo.bin"
    with output_ent.open("wb") as out:
        out.write(b"ENT1")
        out.write(struct.pack("<I", len(merged_records)))
        out.writelines(merged_records)

    source_manifest_path = source / "spawn_district_models_mlo.json"
    if not source_manifest_path.is_file():
        source_manifest_path = source / Path(str(source_descriptor["manifestFile"])).name
    source_manifest = json.loads(source_manifest_path.read_text(encoding="utf-8"))
    target_manifest_path = target / "spawn_district_models.json"
    if not target_manifest_path.is_file():
        target_manifest_path = target / Path(str(target_descriptor["manifestFile"])).name
    target_manifest = json.loads(target_manifest_path.read_text(encoding="utf-8"))
    source_meshes = source_manifest.get("meshes") or {}
    target_meshes = target_manifest.setdefault("meshes", {})
    mlo_hashes = {str(struct.unpack_from("<I", record, 0)[0]) for record in mlo_records}
    added = 0
    for hash_id in sorted(mlo_hashes, key=int):
        if hash_id not in target_meshes and hash_id in source_meshes:
            target_meshes[hash_id] = source_meshes[hash_id]
            added += 1
    target_manifest["schema"] = "webglgta-demo-manifest-mlo-streamed-v1"
    target_manifest["nonRenderableHashes"] = sorted(
        set(map(str, target_manifest.get("nonRenderableHashes") or []))
        | set(map(str, source_manifest.get("nonRenderableHashes") or [])),
        key=int,
    )
    output_manifest = target / "spawn_district_models_mlo.json"
    output_manifest.write_text(json.dumps(target_manifest, separators=(",", ":")), encoding="utf-8")

    target_descriptor["schema"] = "webglgta-spawn-district-mlo-streamed-v1"
    target_descriptor["instanceFile"] = "demo/spawn_district_entities_mlo.bin"
    target_descriptor["manifestFile"] = "demo/spawn_district_models_mlo.json"
    target_descriptor["instanceCount"] = len(merged_records)
    target_descriptor["recordStride"] = 64
    target_descriptor["mloImport"] = {
        **(source_descriptor.get("mloImport") or {}),
        "mloSegmentStart": len(target_records),
        "mergedMloRecordCount": len(mlo_records),
        "mloSelection": selection,
    }
    source_runtime = source_descriptor.get("mloRuntime")
    if isinstance(source_runtime, dict):
        target_descriptor["mloRuntime"] = source_runtime
    (target / "spawn_district.json").write_text(json.dumps(target_descriptor, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "baseInstances": len(target_records),
        "mloInstances": len(mlo_records),
        "mloSelection": selection,
        "totalInstances": len(merged_records),
        "mloArchetypesAdded": added,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

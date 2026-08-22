#!/usr/bin/env python3
"""Build a bounded playable descriptor for one exported MLO root."""

from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RECORD_STRIDE = 64


def read_records(path: Path) -> list[bytes]:
    data = path.read_bytes()
    if len(data) < 8 or data[:4] != b"ENT1":
        raise ValueError(f"{path} is not an ENT1 file")
    count = struct.unpack_from("<I", data, 4)[0]
    if len(data) != 8 + count * RECORD_STRIDE:
        raise ValueError(f"{path} is not a 64-byte ENT1 stream")
    return [data[8 + index * RECORD_STRIDE:8 + (index + 1) * RECORD_STRIDE] for index in range(count)]


def write_records(path: Path, records: list[bytes]) -> None:
    path.write_bytes(b"ENT1" + struct.pack("<I", len(records)) + b"".join(records))


def record_summary(record: bytes) -> dict[str, float | int]:
    archetype_hash, x, y, z = struct.unpack_from("<I3f", record, 0)
    return {
        "archetypeHash": archetype_hash,
        "x": x,
        "y": y,
        "z": z,
        "guid": struct.unpack_from("<I", record, 48)[0],
        "parentGuid": struct.unpack_from("<I", record, 52)[0],
        "flags": struct.unpack_from("<I", record, 60)[0],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root-hash", type=int, default=251203108)
    parser.add_argument("--name", default="weed_shop")
    parser.add_argument("--size", type=float, default=300.0)
    parser.add_argument("--spawn", type=float, nargs=3, metavar=("X", "Y", "Z"), default=None,
                        help="Optional world-space playable spawn; MLO roots are often exterior anchors.")
    parser.add_argument("--camera", type=float, nargs=3, metavar=("DISTANCE", "HEIGHT", "SIDE"), default=None,
                        help="Optional third-person rig for a compact interior spawn.")
    parser.add_argument("--demo-dir", type=Path, default=ROOT / "assets" / "demo")
    args = parser.parse_args()

    demo_dir = args.demo_dir.resolve()
    base_descriptor = json.loads((demo_dir / "spawn_district.json").read_text(encoding="utf-8"))
    full_manifest = json.loads((demo_dir / "spawn_district_models_mlo.json").read_text(encoding="utf-8"))
    records = read_records(demo_dir / "spawn_district_entities_mlo.bin")

    root = next((record_summary(record) for record in records if (
        record_summary(record)["archetypeHash"] == args.root_hash and record_summary(record)["flags"] & 1
    )), None)
    if root is None:
        raise ValueError(f"MLO root {args.root_hash} was not found")
    root_guid = int(root["guid"])
    selected = [record for record in records if (
        record_summary(record)["guid"] == root_guid or record_summary(record)["parentGuid"] == root_guid
    )]
    if len(selected) < 2:
        raise ValueError(f"MLO root {args.root_hash} has no child records")

    hashes = {str(record_summary(record)["archetypeHash"]) for record in selected}
    meshes = full_manifest.get("meshes") or {}
    missing = sorted(hash_id for hash_id in hashes if hash_id not in meshes and hash_id != str(args.root_hash))
    if missing:
        raise ValueError(f"MLO manifest is missing {len(missing)} child archetypes")
    out_name = str(args.name).strip().replace("/", "_").replace("\\", "_")
    entity_name = f"{out_name}_entities.bin"
    manifest_name = f"{out_name}_models.json"
    write_records(demo_dir / entity_name, selected)
    manifest = {
        "schema": "webglgta-demo-mlo-outpost-manifest-v1",
        "meshes": {hash_id: meshes[hash_id] for hash_id in sorted(hashes, key=int) if hash_id in meshes},
        "nonRenderableHashes": sorted({str(args.root_hash)} | set(full_manifest.get("nonRenderableHashes") or []) & hashes, key=int),
        "mloOutpost": {"rootArchetypeHash": str(args.root_hash), "childArchetypeCount": len(hashes) - 1},
    }
    (demo_dir / manifest_name).write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")

    half = max(20.0, float(args.size) * 0.5)
    x, y, z = float(root["x"]), float(root["y"]), float(root["z"])
    spawn_x, spawn_y, spawn_z = (tuple(args.spawn) if args.spawn else (x, y, z))
    descriptor = {
        "schema": "webglgta-spawn-district-mlo-outpost-v1",
        "id": out_name,
        "generatedFrom": "demo/spawn_district_entities_mlo.bin",
        "center": {"x": x, "y": y},
        "size": half * 2.0,
        "bounds": {"minX": x - half, "minY": y - half, "maxX": x + half, "maxY": y + half},
        "spawn": {"x": spawn_x, "y": spawn_y, "pedZ": spawn_z, "source": "configured_fivem_profile"},
        "instanceFile": f"demo/{entity_name}",
        "manifestFile": f"demo/{manifest_name}",
        "instanceCount": len(selected),
        "archetypeCount": len(hashes),
        "recordStride": RECORD_STRIDE,
        "mloRuntime": {
            "schema": "webglgta-mlo-runtime-v1",
            "enabled": True,
            "roomPortalOwnership": True,
            "timecycles": True,
            "audioOcclusion": True,
            "entitySets": True,
            "interiorArchetypeHashes": [str(args.root_hash)],
        },
        "mloOutpost": {
            "rootArchetypeHash": str(args.root_hash),
            "rootGuid": root_guid,
            "childInstanceCount": len(selected) - 1,
        },
    }
    if args.camera:
        distance, height, side = (float(value) for value in args.camera)
        descriptor["camera"] = {
            "distanceData": distance,
            "heightData": height,
            "sideData": side,
        }
    descriptor_name = f"{out_name}_district.json"
    (demo_dir / descriptor_name).write_text(json.dumps(descriptor, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"descriptor": descriptor_name, "instances": len(selected), "archetypes": len(hashes), "missing": missing}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

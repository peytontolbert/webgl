#!/usr/bin/env python3
"""Verify static supermeshes contain no MLO-owned source geometry."""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_spawn_district_supermeshes import decode_mesh


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--descriptor", type=Path, default=root / "assets/demo/spawn_district.json")
    args = parser.parse_args()

    descriptor_path = args.descriptor.resolve()
    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
    assets = descriptor_path.parents[1]
    source_entities = assets / str(descriptor["sourceInstanceFile"])
    source_manifest = assets / str(descriptor["sourceManifestFile"])
    supermesh_manifest = assets / str(descriptor["staticSupermesh"]["manifestFile"])

    data = source_entities.read_bytes()
    count = struct.unpack_from("<I", data, 4)[0]
    stride = (len(data) - 8) // count
    mlo_hashes: set[str] = set()
    for index in range(count):
        record = data[8 + index * stride:8 + (index + 1) * stride]
        if stride >= 64 and (struct.unpack_from("<I", record, 52)[0] or struct.unpack_from("<I", record, 60)[0]):
            mlo_hashes.add(str(struct.unpack_from("<I", record, 0)[0]))

    source_manifest_payload = json.loads(source_manifest.read_text(encoding="utf-8"))
    world_override_hashes = {
        str(value)
        for value in (source_manifest_payload.get("mloImport") or {}).get("worldDrawableOverrides", [])
    }
    if not {"2721482282", "45717283"} <= world_override_hashes:
        raise AssertionError(f"Missing Legion world drawable overrides: {sorted(world_override_hashes, key=int)}")
    protected_hashes = mlo_hashes | world_override_hashes

    building_override = source_manifest_payload["meshes"]["2721482282"]
    building_parts = building_override["lods"]["high"]["submeshes"]
    if len(building_parts) != 36 or building_parts[13].get("indexCount") != 2223:
        raise AssertionError("Legion dt1_14_build3 resource override was replaced by the stale 37-part GTA shell")
    if any(not str(part.get("file") or "").startswith("mlo/2721482282/") for part in building_parts):
        raise AssertionError("Legion dt1_14_build3 does not exclusively reference the loose FiveM replacement")

    wall_mesh = decode_mesh((assets / "models" / building_parts[13]["file"]).read_bytes())
    triangles = wall_mesh["positions"][wall_mesh["indices"].reshape(-1, 3)]
    wall_hit = np.asarray((17.33277, -46.39421, -20.25136), dtype=np.float32)
    coplanar = np.max(np.abs(triangles[:, :, 1] - wall_hit[1]), axis=1) < 0.01
    spans_hit = (
        (triangles[:, :, 0].min(axis=1) <= wall_hit[0])
        & (triangles[:, :, 0].max(axis=1) >= wall_hit[0])
        & (triangles[:, :, 2].min(axis=1) <= wall_hit[2])
        & (triangles[:, :, 2].max(axis=1) >= wall_hit[2])
    )
    if np.any(coplanar & spans_hit):
        raise AssertionError("Closed Legion weed-shop wall triangle returned in dt1_14_build3")

    manifest = json.loads(supermesh_manifest.read_text(encoding="utf-8"))
    used_mlo_hashes: dict[str, list[str]] = {}
    missing_provenance = []
    for hash_id, mesh in (manifest.get("meshes") or {}).items():
        metadata = mesh.get("supermesh") if isinstance(mesh, dict) else None
        if not metadata:
            continue
        sources = metadata.get("sourceArchetypeHashes")
        if not isinstance(sources, list):
            missing_provenance.append(hash_id)
            continue
        overlap = sorted(protected_hashes.intersection(map(str, sources)), key=int)
        if overlap:
            used_mlo_hashes[hash_id] = overlap

    revision_hash = hashlib.sha256()
    revision_hash.update(data)
    revision_hash.update(source_manifest.read_bytes())
    expected_revision = revision_hash.hexdigest()[:16]
    actual_revision = str(descriptor["staticSupermesh"].get("sourceRevision") or "")
    if missing_provenance or used_mlo_hashes or actual_revision != expected_revision:
        raise AssertionError(json.dumps({
            "missingProvenance": missing_provenance[:20],
            "mloSourcesInSupermeshes": used_mlo_hashes,
            "expectedSourceRevision": expected_revision,
            "actualSourceRevision": actual_revision,
        }, indent=2))

    print(json.dumps({
        "sourceRevision": actual_revision,
        "mloArchetypeCount": len(mlo_hashes),
        "worldDrawableOverrideCount": len(world_override_hashes),
        "supermeshCount": sum(1 for mesh in manifest["meshes"].values() if mesh.get("supermesh")),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

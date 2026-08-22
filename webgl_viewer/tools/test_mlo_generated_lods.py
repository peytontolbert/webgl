#!/usr/bin/env python3
"""Validate generated Walmart MLO LOD packs and manifest metadata."""

from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path

from audit_spawn_district_mesh_quantization import packed_indices


PACK_REF = re.compile(r"^@demo-pack/([^#]+)#(\d+):(\d+)$")


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    assets = root / ".mlo_repair_20260818" / "assets"
    manifest_path = assets / "demo" / "spawn_district_models_mlo.json"
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    descriptor = json.loads((assets / "demo" / "spawn_district.json").read_text(encoding="utf-8"))
    assert descriptor["sourceRevision"] == hashlib.sha256(manifest_bytes).hexdigest()[:16]
    assert descriptor["generatedMloLods"] == manifest["generatedMloLods"]
    reports = manifest["generatedMloLods"]
    assert len(reports) >= 18
    for report in reports.values():
        if not report["archetypes"]:
            continue
        assert report["mediumWeightedTriangles"] < report["originalWeightedTriangles"] * 0.6
        assert report["lowWeightedTriangles"] <= report["originalWeightedTriangles"] * 0.36

    interactables = json.loads((assets / "demo" / "interactables.json").read_text(encoding="utf-8"))
    door_hashes = {str(door["archetypeHash"]) for door in interactables["doors"]}

    packs: dict[str, bytes] = {}
    checked = 0
    generated_hashes = set()
    for hash_value, entry in manifest["meshes"].items():
        lods = entry.get("lods") or {}
        if "med" not in lods or "low" not in lods:
            continue
        for lod_name in ("med", "low"):
            bounds = lods[lod_name].get("bounds") or {}
            assert all(math.isfinite(float(value)) for key in ("min", "max", "center") for value in bounds.get(key, []))
            for submesh in lods[lod_name].get("submeshes") or []:
                match = PACK_REF.match(str(submesh.get("file") or ""))
                if not match or not match.group(1).startswith("spawn_district_mlo_lod_pack_all_"):
                    continue
                generated_hashes.add(hash_value)
                filename, offset_text, length_text = match.groups()
                payload = packs.setdefault(filename, (assets / "demo" / filename).read_bytes())
                expected_revision = hashlib.sha256(payload).hexdigest()[:16]
                assert manifest["meshPackRevisions"][filename] == expected_revision
                offset, length = int(offset_text), int(length_text)
                assert offset >= 0 and length > 0 and offset + length <= len(payload)
                positions, indices, _flags = packed_indices(payload[offset:offset + length])
                assert len(positions) == int(submesh["vertexCount"])
                assert len(indices) == int(submesh["indexCount"])
                assert not len(indices) or int(indices.max()) < len(positions)
                checked += 1

    assert checked >= 1000, f"expected generated LOD slices, checked {checked}"
    assert len(packs) == max(report["packCount"] for report in reports.values())
    assert generated_hashes.isdisjoint(door_hashes)
    print(f"MLO generated LOD validation passed: {checked} slices across {len(packs)} packs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

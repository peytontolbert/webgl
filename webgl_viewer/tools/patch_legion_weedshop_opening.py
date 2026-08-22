#!/usr/bin/env python3
"""Remove the closed partition from the current Legion weed-shop export."""

from __future__ import annotations

import json
import hashlib
from pathlib import Path

from import_fivem_mlo_demo import (
    LEGION_WEEDSHOP_OPENING_ARCHETYPE,
    _remove_legion_weedshop_partition,
)
from build_spawn_district_supermeshes import decode_mesh
from export_drawables_for_chunk import _write_mesh_bin


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    models = root / "assets/models/mlo" / str(LEGION_WEEDSHOP_OPENING_ARCHETYPE)
    removed_total = 0
    counts: dict[str, int] = {}
    renamed: dict[str, str] = {}
    for submesh_index in (1, 7):
        original_name = f"{LEGION_WEEDSHOP_OPENING_ARCHETYPE}_high_{submesh_index}.bin"
        revised_name = f"{LEGION_WEEDSHOP_OPENING_ARCHETYPE}_high_{submesh_index}_open_v1.bin"
        revised_path = models / revised_name
        path = revised_path if revised_path.is_file() else models / original_name
        mesh = decode_mesh(path.read_bytes())
        indices, removed = _remove_legion_weedshop_partition(
            LEGION_WEEDSHOP_OPENING_ARCHETYPE,
            "high",
            submesh_index,
            mesh["positions"],
            mesh["indices"],
        )
        if removed:
            _write_mesh_bin(
                path,
                mesh["positions"], indices, mesh["normals"], mesh["uv0"],
                mesh["tangents"], mesh["color0"], mesh["uv1"], mesh["uv2"],
                mesh["color1"],
            )
        if path != revised_path:
            path.replace(revised_path)
        counts[revised_name] = int(len(indices))
        renamed[original_name] = revised_name
        removed_total += removed

    updated_manifests = 0
    for manifest_path in (root / "assets/demo").glob("*.json"):
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(manifest, dict):
            continue
        entry = (manifest.get("meshes") or {}).get(str(LEGION_WEEDSHOP_OPENING_ARCHETYPE))
        changed = False
        for lod in (entry or {}).get("lods", {}).values():
            for submesh in lod.get("submeshes") or []:
                filename = Path(str(submesh.get("file") or "")).name
                revised_name = renamed.get(filename, filename)
                if revised_name in counts and (
                    filename != revised_name or int(submesh.get("indexCount") or 0) != counts[revised_name]
                ):
                    submesh["file"] = f"mlo/{LEGION_WEEDSHOP_OPENING_ARCHETYPE}/{revised_name}"
                    submesh["indexCount"] = counts[revised_name]
                    changed = True
        if changed:
            manifest_path.write_text(json.dumps(manifest, separators=(",", ":")) + "\n", encoding="utf-8")
            updated_manifests += 1

    descriptor_path = root / "assets/demo/spawn_district.json"
    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
    source_entities = root / "assets" / str(descriptor["sourceInstanceFile"])
    source_manifest = root / "assets" / str(descriptor["sourceManifestFile"])
    source_revision_hash = hashlib.sha256()
    source_revision_hash.update(source_entities.read_bytes())
    source_revision_hash.update(source_manifest.read_bytes())
    source_revision = source_revision_hash.hexdigest()[:16]
    descriptor["staticSupermesh"]["sourceRevision"] = source_revision
    descriptor_path.write_text(json.dumps(descriptor, indent=2) + "\n", encoding="utf-8")

    supermesh_path = root / "assets" / str(descriptor["staticSupermesh"]["manifestFile"])
    supermesh = json.loads(supermesh_path.read_text(encoding="utf-8"))
    supermesh.setdefault("supermesh", {})["sourceRevision"] = source_revision
    for mesh in (supermesh.get("meshes") or {}).values():
        if isinstance(mesh, dict) and isinstance(mesh.get("supermesh"), dict):
            mesh["supermesh"]["sourceRevision"] = source_revision
    supermesh_path.write_text(json.dumps(supermesh, separators=(",", ":")) + "\n", encoding="utf-8")

    outpost_descriptor_path = root / "assets/demo/weed_shop_district.json"
    outpost_descriptor = json.loads(outpost_descriptor_path.read_text(encoding="utf-8"))
    outpost_manifest_path = root / "assets" / str(outpost_descriptor["manifestFile"])
    outpost_descriptor["sourceRevision"] = hashlib.sha256(outpost_manifest_path.read_bytes()).hexdigest()[:16]
    outpost_descriptor_path.write_text(json.dumps(outpost_descriptor, indent=2) + "\n", encoding="utf-8")

    print(json.dumps({
        "removedTriangles": removed_total,
        "indexCounts": counts,
        "updatedManifests": updated_manifests,
        "sourceRevision": source_revision,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

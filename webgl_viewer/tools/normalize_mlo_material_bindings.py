#!/usr/bin/env python3
"""Normalize direct runtime texture fields for imported MLO child materials."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from apply_fivem_world_drawable_overrides import _apply_texture_aliases, _build_texture_aliases


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--root-hash", action="append", required=True)
    parser.add_argument("--manifest", type=Path, action="append", required=True)
    parser.add_argument("--texture-source-manifest", type=Path, default=root / "assets/demo/spawn_district_models.json")
    parser.add_argument("--texture-runtime-manifest", type=Path, default=root / "assets/demo/spawn_district_models_quantized_v3.json")
    args = parser.parse_args()

    metadata = json.loads(args.metadata.resolve().read_text(encoding="utf-8"))
    selected_roots = {str(int(value) & 0xFFFFFFFF) for value in args.root_hash}
    roots = [item for item in (metadata.get("roots") or []) if str(item.get("archetypeHash")) in selected_roots]
    if len(roots) != len(selected_roots):
        raise ValueError(f"Matched {len(roots)} of {len(selected_roots)} requested MLO roots")
    child_hashes = {
        str(int(child.get("archetypeHash")) & 0xFFFFFFFF)
        for item in roots
        for child in (item.get("children") or [])
    }

    texture_source = json.loads(args.texture_source_manifest.resolve().read_text(encoding="utf-8"))
    texture_runtime = json.loads(args.texture_runtime_manifest.resolve().read_text(encoding="utf-8"))
    aliases = _build_texture_aliases(texture_source, texture_runtime)

    reports = []
    for manifest_path in (path.resolve() for path in args.manifest):
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        resolved = 0
        unresolved: set[str] = set()
        submesh_count = 0
        diffuse_count = 0
        for hash_id in child_hashes:
            entry = (payload.get("meshes") or {}).get(hash_id)
            if entry is None:
                continue
            count, missing = _apply_texture_aliases(entry, aliases)
            resolved += count
            unresolved.update(missing)
            for lod in (entry.get("lods") or {}).values():
                for part in lod.get("submeshes") or []:
                    submesh_count += 1
                    if (part.get("material") or {}).get("diffuse"):
                        diffuse_count += 1
        payload.setdefault("mloImport", {})["normalizedMaterialRootHashes"] = sorted(selected_roots, key=int)
        manifest_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        reports.append({
            "manifest": str(manifest_path),
            "childArchetypes": len(child_hashes),
            "submeshes": submesh_count,
            "diffuseBindings": diffuse_count,
            "inheritedAliases": resolved,
            "unresolvedTextureHashes": sorted(unresolved, key=int),
        })
    print(json.dumps(reports, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

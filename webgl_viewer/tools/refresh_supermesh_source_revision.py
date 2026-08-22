#!/usr/bin/env python3
"""Refresh static-supermesh provenance after a source-manifest-only repair."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def _load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected object JSON: {path}")
    return value


def _revision(instance_path: Path, manifest_path: Path) -> str:
    digest = hashlib.sha256()
    digest.update(instance_path.read_bytes())
    digest.update(manifest_path.read_bytes())
    return digest.hexdigest()[:16]


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--descriptor", type=Path, default=root / "assets/demo/spawn_district.json")
    args = parser.parse_args()

    descriptor_path = args.descriptor.resolve()
    descriptor = _load_json(descriptor_path)
    assets_dir = descriptor_path.parents[1]
    source_instances = assets_dir / str(descriptor["sourceInstanceFile"])
    source_manifest = assets_dir / str(descriptor["sourceManifestFile"])
    static = descriptor.get("staticSupermesh")
    if not isinstance(static, dict):
        raise SystemExit("Descriptor does not contain staticSupermesh metadata")
    supermesh_path = assets_dir / str(static["manifestFile"])

    revision = _revision(source_instances, source_manifest)
    supermesh = _load_json(supermesh_path)
    static["sourceRevision"] = revision
    root_metadata = supermesh.get("supermesh")
    if isinstance(root_metadata, dict):
        root_metadata["sourceRevision"] = revision
    mesh_updates = 0
    for mesh in (supermesh.get("meshes") or {}).values():
        metadata = mesh.get("supermesh") if isinstance(mesh, dict) else None
        if isinstance(metadata, dict):
            metadata["sourceRevision"] = revision
            mesh_updates += 1

    descriptor_path.write_text(json.dumps(descriptor, indent=2) + "\n", encoding="utf-8")
    supermesh_path.write_text(json.dumps(supermesh, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({
        "sourceRevision": revision,
        "descriptor": str(descriptor_path),
        "supermeshManifest": str(supermesh_path),
        "supermeshEntriesUpdated": mesh_updates,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

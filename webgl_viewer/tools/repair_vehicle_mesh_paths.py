#!/usr/bin/env python3
"""Normalize custom-vehicle mesh references relative to assets/models."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def iter_submeshes(document: dict):
    for mesh in (document.get("meshes") or {}).values():
        for lod in (mesh.get("lods") or {}).values():
            yield from (lod.get("submeshes") or [])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets-dir", type=Path, default=Path(__file__).resolve().parents[1] / "assets")
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    assets = args.assets_dir.resolve()
    manifests = sorted((assets / "custom_vehicles").glob("*.json"))
    changed_manifests = 0
    changed_paths = 0
    missing = []
    for path in manifests:
        if path.name == "catalog.json":
            continue
        document = json.loads(path.read_text(encoding="utf-8"))
        changed = False
        for submesh in iter_submeshes(document):
            old = str(submesh.get("file") or "")
            # ModelManager resolves every ordinary mesh relative to assets/models.
            # A manifest value of models/custom_vehicles/... therefore became
            # assets/models/models/custom_vehicles/... at runtime and retried as
            # a 404. Keep manifest references relative to that established base.
            if old.startswith("models/custom_vehicles/"):
                new = old.removeprefix("models/")
                submesh["file"] = new
                old = new
                changed = True
                changed_paths += 1
            if old and not (assets / "models" / old).is_file():
                missing.append(f"{path.name}:{old}")
        if changed:
            changed_manifests += 1
            if args.write:
                path.write_text(json.dumps(document, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({
        "manifests": len(manifests) - 1,
        "changedManifests": changed_manifests,
        "changedPaths": changed_paths,
        "missingFiles": len(missing),
        "missingSample": missing[:10],
        "written": bool(args.write),
    }, indent=2))
    return 0 if not missing else 1


if __name__ == "__main__":
    raise SystemExit(main())

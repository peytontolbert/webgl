#!/usr/bin/env python3
"""Repair legacy bare MLO mesh paths in a spawn-district manifest.

Some older merged demo manifests retained files such as
``2513000025_med_1.bin`` while their exported payload lives at
``models/mlo/2513000025/2513000025_med_1.bin``.  The browser resolves a mesh
path relative to ``assets/models``; leaving that prefix out produces a 404 and
also prevents static-cell preprocessing from reading the drawable.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def _load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected JSON object: {path}")
    return value


def _repair_manifest(
    assets_dir: Path,
    manifest_path: Path,
    *,
    write: bool,
    drop_unresolved: bool,
) -> dict[str, Any]:
    manifest = _load_json(manifest_path)
    meshes = manifest.get("meshes")
    if not isinstance(meshes, dict):
        raise ValueError(f"Manifest has no meshes object: {manifest_path}")

    repaired: list[dict[str, str]] = []
    dropped: list[dict[str, str]] = []
    unresolved: list[dict[str, str]] = []
    for hash_id, entry in meshes.items():
        if not isinstance(entry, dict):
            continue
        lods = entry.get("lods")
        if not isinstance(lods, dict):
            continue
        for lod, lod_entry in lods.items():
            if not isinstance(lod_entry, dict):
                continue
            submeshes = lod_entry.get("submeshes")
            if not isinstance(submeshes, list):
                continue
            drop_indices: list[int] = []
            for index, submesh in enumerate(submeshes):
                if not isinstance(submesh, dict):
                    continue
                source_file = str(submesh.get("file") or "")
                if not source_file or source_file.startswith("@demo-pack/"):
                    continue
                direct_path = assets_dir / "models" / source_file
                if direct_path.is_file():
                    continue
                # A normal path may already contain a different directory. Only
                # repair legacy bare names; never reinterpret arbitrary paths.
                if "/" in source_file.replace("\\", "/"):
                    unresolved.append({
                        "hash": str(hash_id),
                        "lod": str(lod),
                        "index": str(index),
                        "file": source_file,
                    })
                    continue
                fixed_file = f"mlo/{hash_id}/{source_file}"
                fixed_path = assets_dir / "models" / fixed_file
                if fixed_path.is_file():
                    if write:
                        submesh["file"] = fixed_file
                    repaired.append({
                        "hash": str(hash_id),
                        "lod": str(lod),
                        "index": str(index),
                        "from": source_file,
                        "to": fixed_file,
                    })
                else:
                    issue = {
                        "hash": str(hash_id),
                        "lod": str(lod),
                        "index": str(index),
                        "file": source_file,
                    }
                    if drop_unresolved:
                        drop_indices.append(index)
                        dropped.append(issue)
                    else:
                        unresolved.append(issue)
            for index in reversed(drop_indices):
                del submeshes[index]

    if write and (repaired or dropped):
        manifest_path.write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
    return {
        "manifest": str(manifest_path),
        "repaired": len(repaired),
        "dropped": len(dropped),
        "unresolved": len(unresolved),
        "repairs": repaired,
        "droppedEntries": dropped,
        "unresolvedEntries": unresolved,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--check", action="store_true", help="Report changes without writing the manifest")
    parser.add_argument(
        "--drop-unresolved",
        action="store_true",
        help="Remove bare mesh records which have no declared or canonical MLO payload",
    )
    args = parser.parse_args()

    result = _repair_manifest(
        args.assets_dir.resolve(),
        args.manifest.resolve(),
        write=not args.check,
        drop_unresolved=args.drop_unresolved,
    )
    print(json.dumps(result, indent=2))
    return 0 if not result["unresolved"] else 2


if __name__ == "__main__":
    raise SystemExit(main())

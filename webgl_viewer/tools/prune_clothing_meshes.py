#!/usr/bin/env python3
"""Remove unreferenced files from the dedicated clothingpack5m mesh directory."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets-dir", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    assets = args.assets_dir.resolve()
    mesh_dir = (assets / "models" / "custom_clothing" / "clothingpack5m").resolve()
    if mesh_dir.parent.name != "custom_clothing" or mesh_dir.name != "clothingpack5m":
        raise ValueError(f"refusing unexpected mesh directory: {mesh_dir}")
    manifest = json.loads((assets / "custom_clothing" / "clothingpack5m.json").read_text(encoding="utf-8"))
    keep = {
        Path(str(submesh["file"])).name
        for entry in manifest.get("meshes", {}).values()
        for lod in entry.get("lods", {}).values()
        for submesh in lod.get("submeshes", [])
        if str(submesh.get("file") or "").startswith("custom_clothing/clothingpack5m/")
    }
    candidates = [path for path in mesh_dir.iterdir() if path.is_file() and path.name not in keep]
    bytes_to_remove = sum(path.stat().st_size for path in candidates)
    if args.apply:
        for path in candidates:
            path.unlink()
    print(json.dumps({
        "meshDir": str(mesh_dir),
        "keptFiles": len(keep),
        "removedFiles": len(candidates) if args.apply else 0,
        "candidateFiles": len(candidates),
        "removedBytes": bytes_to_remove if args.apply else 0,
        "candidateBytes": bytes_to_remove,
        "applied": args.apply,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

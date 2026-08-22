"""Mark generated custom-resource materials as having verified texture bindings."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def mark_manifest(path: Path) -> tuple[int, int]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    material_count = 0
    changed_count = 0

    for mesh in (payload.get("meshes") or {}).values():
        if not isinstance(mesh, dict):
            continue
        for lod in (mesh.get("lods") or {}).values():
            if not isinstance(lod, dict):
                continue
            for submesh in lod.get("submeshes") or []:
                material = submesh.get("material") if isinstance(submesh, dict) else None
                if not isinstance(material, dict):
                    continue
                material_count += 1
                if material.get("textureBindingsExplicit") is not True:
                    material["textureBindingsExplicit"] = True
                    changed_count += 1

    if changed_count:
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        temporary.replace(path)
    return material_count, changed_count


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifests", nargs="+", type=Path)
    args = parser.parse_args()

    for manifest in args.manifests:
        total, changed = mark_manifest(manifest)
        print(f"{manifest}: materials={total} changed={changed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

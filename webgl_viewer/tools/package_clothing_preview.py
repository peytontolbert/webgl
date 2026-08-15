#!/usr/bin/env python3
"""Build a deployment tar containing only manifest-referenced clothing assets."""

from __future__ import annotations

import argparse
import json
import tarfile
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, default=Path("clothing-preview-compressed.tar"))
    args = parser.parse_args()
    root = args.root.resolve()
    output = args.output.resolve()
    assets = root / "assets"
    manifest_path = assets / "custom_clothing" / "clothingpack5m.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    files = {manifest_path}
    for entry in manifest.get("meshes", {}).values():
        for lod in entry.get("lods", {}).values():
            for submesh in lod.get("submeshes", []):
                relative = submesh.get("file")
                if relative:
                    files.add(assets / "models" / str(relative))
                for value in (submesh.get("material") or {}).values():
                    if isinstance(value, str) and value.startswith("models_textures/"):
                        files.add(assets / value)
    missing = sorted(str(path) for path in files if not path.is_file())
    if missing:
        raise FileNotFoundError(f"missing {len(missing)} referenced files: {missing[:5]}")
    dist = root / "dist"
    code_files = [dist / "clothing.html", dist / "index.html", *sorted((dist / "bundled").glob("*.js"))]
    with tarfile.open(output, "w") as archive:
        for path in sorted(files):
            archive.add(path, arcname=path.relative_to(root).as_posix(), recursive=False)
        for path in code_files:
            archive.add(path, arcname=path.relative_to(dist).as_posix(), recursive=False)
    print(json.dumps({
        "output": str(output),
        "assetFiles": len(files),
        "codeFiles": len(code_files),
        "bytes": output.stat().st_size,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

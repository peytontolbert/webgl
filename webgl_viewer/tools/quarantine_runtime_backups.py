#!/usr/bin/env python3
"""Move backup/debug payloads out of a served runtime tree without deleting them."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path


MARKERS = (".before-", ".pre-", ".bak", ".backup", ".old", ".orig", ".tmp", ".zero-")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("quarantine", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    quarantine = args.quarantine.resolve()
    if not root.is_dir() or root == root.parent:
        parser.error("root must be an existing non-filesystem-root directory")
    if quarantine == root or root in quarantine.parents:
        parser.error("quarantine must be outside the served runtime tree")

    candidates = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        lower = relative.as_posix().lower()
        if any(marker in lower for marker in MARKERS):
            candidates.append((relative, path.stat().st_size))
    candidates.sort(key=lambda row: row[0].as_posix())

    if args.apply:
        for relative, _size in candidates:
            source = root / relative
            target = quarantine / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                raise FileExistsError(f"quarantine target already exists: {target}")
            shutil.move(str(source), str(target))

    print(json.dumps({
        "schema": "webglgta-runtime-backup-quarantine-v1",
        "root": str(root),
        "quarantine": str(quarantine),
        "apply": args.apply,
        "files": len(candidates),
        "bytes": sum(size for _relative, size in candidates),
        "paths": [relative.as_posix() for relative, _size in candidates],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Move legacy runtime images out of a served tree after verifying WebP peers."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil

from PIL import Image


LEGACY_SUFFIXES = {".png", ".jpg", ".jpeg"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("quarantine", type=Path)
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    quarantine = args.quarantine.resolve()
    if quarantine == root or root in quarantine.parents:
        parser.error("quarantine must be outside the served root")

    sources = sorted(path for path in root.rglob("*") if path.is_file() and path.suffix.lower() in LEGACY_SUFFIXES)
    legacy_bytes = sum(source.stat().st_size for source in sources)
    errors: list[dict[str, str]] = []
    verified: list[tuple[Path, Path]] = []
    for source in sources:
        target = source.with_suffix(".webp")
        try:
            if not target.is_file():
                raise FileNotFoundError("WebP peer is missing")
            with Image.open(target) as image:
                image.verify()
                if image.format != "WEBP":
                    raise ValueError(f"peer format is {image.format}, not WEBP")
            verified.append((source, target))
        except Exception as error:
            errors.append({"source": source.relative_to(root).as_posix(), "error": str(error)})

    moved = 0
    if args.write and not errors:
        for source, _target in verified:
            destination = quarantine / source.relative_to(root)
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists():
                raise FileExistsError(f"quarantine destination already exists: {destination}")
            shutil.move(str(source), str(destination))
            moved += 1

    report = {
        "schema": "webglgta-legacy-runtime-image-quarantine-v1",
        "root": str(root), "quarantine": str(quarantine), "write": args.write,
        "legacyFiles": len(sources), "legacyBytes": legacy_bytes,
        "verifiedWebpPeers": len(verified), "errors": errors, "moved": moved,
    }
    encoded = json.dumps(report, indent=2, sort_keys=True)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Repair PNGs previously written from CodeWalker BGRA decoder output.

The first global texture extractor treated DDSIO.GetPixels output as RGBA. The
bytes are BGRA, so those exported PNGs have red and blue exchanged. This tool
uses the original missing-texture dump to swap only that known affected set.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from PIL import Image


MODEL_TEX_RE = re.compile(r"^models_textures/(?P<hash>\d+)(?:_(?P<slug>[^/]+))?\.png$", re.IGNORECASE)


def wanted_files(dump_path: Path, texture_dir: Path) -> list[Path]:
    rows = json.loads(dump_path.read_text(encoding="utf-8-sig", errors="ignore"))
    if not isinstance(rows, list):
        raise ValueError("dump must be a JSON array")

    out: set[Path] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        match = MODEL_TEX_RE.match(str(row.get("requestedRel") or "").strip().replace("\\", "/"))
        if not match:
            continue
        texture_hash = match.group("hash")
        slug = match.group("slug") or ""
        out.add(texture_dir / f"{texture_hash}.png")
        if slug:
            out.add(texture_dir / f"{texture_hash}_{slug}.png")
    return sorted(out)


def swap_red_blue(path: Path) -> None:
    with Image.open(path) as source:
        rgba = source.convert("RGBA")
        red, green, blue, alpha = rgba.split()
        fixed = Image.merge("RGBA", (blue, green, red, alpha))
        temp = path.with_name(f"{path.name}.tmp")
        fixed.save(temp, format="PNG")
        temp.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dump", required=True, type=Path)
    parser.add_argument("--texture-dir", required=True, type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    paths = wanted_files(args.dump, args.texture_dir)
    repaired = 0
    missing = 0
    for path in paths:
        if not path.is_file():
            missing += 1
            continue
        if not args.dry_run:
            swap_red_blue(path)
        repaired += 1

    print(f"bgra repair: repaired={repaired} missing={missing} dryRun={bool(args.dry_run)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

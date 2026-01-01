#!/usr/bin/env python3
"""
Verify entity chunk outputs vs entities_index.json.

This catches:
- duplicated entities due to append-mode chunk writing across multiple extractions
- missing chunk files referenced in the index
- chunk count mismatches

Usage:
  python webgl/verify_entities_index.py --assets-dir webgl/webgl_viewer/assets
"""

import argparse
import json
from pathlib import Path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--assets-dir", default="", help="webgl_viewer/assets folder (auto if omitted)")
    ap.add_argument("--limit", type=int, default=0, help="Only check first N chunks (0 = all)")
    args = ap.parse_args()

    if args.assets_dir:
        assets_dir = Path(args.assets_dir)
    else:
        assets_dir = Path(__file__).parent / "webgl_viewer" / "assets"
        if not assets_dir.exists():
            alt = Path.cwd() / "webgl_viewer" / "assets"
            if alt.exists():
                assets_dir = alt

    idx_path = assets_dir / "entities_index.json"
    chunks_dir = assets_dir / "entities_chunks"
    if not idx_path.exists():
        raise SystemExit(f"Missing {idx_path}")
    if not chunks_dir.exists():
        raise SystemExit(f"Missing {chunks_dir}")

    idx = json.loads(idx_path.read_text(encoding="utf-8", errors="ignore"))
    chunks = list((idx.get("chunks") or {}).items())
    chunks.sort(key=lambda kv: kv[0])
    lim = int(args.limit or 0)
    if lim > 0:
        chunks = chunks[:lim]

    bad = 0
    scanned = 0
    sum_index = 0
    sum_lines = 0
    for key, meta in chunks:
        file0 = (meta or {}).get("file") or f"{key}.jsonl"
        exp = int((meta or {}).get("count") or 0)
        p = chunks_dir / file0
        sum_index += exp
        if not p.exists():
            bad += 1
            print(f"{key}: MISSING file {p} (index count={exp})")
            continue
        # Count lines without loading whole file.
        n = 0
        with open(p, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                if line.strip():
                    n += 1
        sum_lines += n
        scanned += 1
        if n != exp:
            bad += 1
            print(f"{key}: count mismatch index={exp} fileLines={n} file={file0}")

    print(f"Chunks checked: {scanned}/{len(chunks)}")
    print(f"Mismatches/missing: {bad}")
    print(f"Sum index counts: {sum_index}")
    print(f"Sum file lines:  {sum_lines}")
    ti = int(idx.get("total_entities") or 0)
    if ti:
        print(f"Index total_entities: {ti}")


if __name__ == "__main__":
    main()



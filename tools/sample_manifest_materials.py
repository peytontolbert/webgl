#!/usr/bin/env python3
"""
Utility: sample a few material-related fields out of the huge viewer manifest
without loading the full JSON into memory.

Usage:
  python webgl/tools/sample_manifest_materials.py --manifest webgl/webgl_viewer/assets/models/manifest.json --limit 20
"""

from __future__ import annotations

import argparse
import os
import re
from collections import deque


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default="webgl/webgl_viewer/assets/models/manifest.json")
    ap.add_argument("--limit", type=int, default=25, help="Number of hits to print")
    ap.add_argument("--context", type=int, default=2, help="Context lines before/after match")
    args = ap.parse_args()

    path = str(args.manifest)
    if not os.path.exists(path):
        print(f"Missing manifest: {path}")
        return 2

    limit = max(1, int(args.limit or 25))
    ctxn = max(0, min(20, int(args.context or 2)))

    keys = [
        '"uv0ScaleOffset"',
        '"globalAnimUV0"',
        '"globalAnimUV1"',
        '"detailSettings"',
        '"diffuseKtx2"',
        '"diffuse"',
        '"normalSwizzle"',
        '"normalReconstructZ"',
    ]
    pat = re.compile("|".join(re.escape(k) for k in keys))

    before: deque[tuple[int, str]] = deque(maxlen=ctxn)
    after_remaining = 0
    hits = 0

    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for i, line in enumerate(f, 1):
            s = line.rstrip("\n")

            if after_remaining > 0:
                print(f"{i}: {s[:240]}")
                after_remaining -= 1
                continue

            if pat.search(s):
                # Print leading context
                for ln, txt in before:
                    print(f"{ln}: {txt[:240]}")
                # Print match line
                print(f"{i}: {s[:240]}")
                # Print trailing context lines
                after_remaining = ctxn
                print("---")
                hits += 1
                if hits >= limit:
                    break

            before.append((i, s))

    print(f"hits={hits}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



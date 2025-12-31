#!/usr/bin/env python3
"""
Quick sanity report for "did we actually extract all the placement-like things we care about?"

Reads:
- output/ymap/ymap_index.json
- output/ymap/entities/*.json

Prints totals for:
- CEntityDefs
- CMloInstanceDefs
- GrassInstanceBatches + total GrassInstances
- Timecycle modifiers, occluders, etc.

This is intentionally lightweight so you can run it after changing `extract_ymaps.py`
without opening CodeWalker UI.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any, Dict, Iterable


def _iter_json_files(root: Path) -> Iterable[Path]:
    if not root.exists():
        return []
    return sorted([p for p in root.rglob("*.json") if p.is_file()])


def _load_json(p: Path) -> Any:
    return json.loads(p.read_text(encoding="utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser(description="Report extracted YMAP placement coverage from output/ymap/entities/*.json")
    ap.add_argument("--ymap-entities", type=Path, default=Path("output/ymap/entities"))
    ap.add_argument("--max-files", type=int, default=0, help="Limit number of files to scan (0 = no limit)")
    args = ap.parse_args()

    files = list(_iter_json_files(args.ymap_entities))
    if args.max_files and args.max_files > 0:
        files = files[: args.max_files]
    if not files:
        print(f"ERROR: no files under {args.ymap_entities}")
        return 1

    totals: Counter[str] = Counter()
    with_lod = 0
    with_grass_instances = 0

    for fp in files:
        try:
            doc = _load_json(fp)
        except Exception:
            continue
        c: Dict[str, Any] = doc.get("counts") or {}
        if isinstance(c, dict):
            for k, v in c.items():
                try:
                    totals[k] += int(v or 0)
                except Exception:
                    pass
        if (doc.get("lodLights") or doc.get("distantLodLights")):
            with_lod += 1
        # If grass instances are present, they are stored under grassInstanceBatches[].instances
        try:
            for gb in (doc.get("grassInstanceBatches") or []):
                if isinstance(gb, dict) and "instances" in gb:
                    with_grass_instances += 1
                    break
        except Exception:
            pass

    print("Scanned YMAP JSON files:")
    print(f"  {len(files)}")
    print("")
    print("Summed counts (across scanned files):")
    for k in sorted(totals.keys()):
        print(f"  {k}: {totals[k]}")
    print("")
    print("Feature flags observed in outputs:")
    print(f"  files_with_lod_lights: {with_lod}")
    print(f"  files_with_grass_instances_expanded: {with_grass_instances}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



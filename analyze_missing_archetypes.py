#!/usr/bin/env python3
"""
Analyze patterns in missing archetypes (hashes) by joining them back to streamed entity placements.

Input:
  - a JSON file like output/missing_archetypes.json written by report_missing_meshes.py
  - webgl_viewer/assets/entities_chunks/*.jsonl (streamed entities)

Output (stdout):
  - top missing archetypes by occurrence with name + ymap source samples
  - breakdown by:
      - is_mlo_instance
      - ymap path category (interiors vs non-interiors)
      - top YMAP RPFS / directories contributing missing archetypes
      - name-prefix buckets (metro_, v_, des_, etc.)
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Tuple

from gta5_modules.entity_coverage import auto_assets_dir, iter_entity_objects

def _as_u32_str(x: Any) -> Optional[str]:
    try:
        s = str(x).strip()
        if not s:
            return None
        if s.lstrip("-").isdigit():
            return str(int(s, 10) & 0xFFFFFFFF)
        return None
    except Exception:
        return None


def _iter_entity_lines(chunks_dir: Path) -> Iterable[Tuple[str, dict]]:
    # Backwards compatible name for older callers; delegate to shared iterator.
    return iter_entity_objects(chunks_dir)


def _ymap_category(ymap_path: str) -> str:
    s = (ymap_path or "").lower()
    if "\\interiors\\" in s or "/interiors/" in s:
        return "interiors"
    if "\\dlcpacks\\" in s or "/dlcpacks/" in s:
        return "dlc_world"
    if "\\update\\" in s or "/update/" in s:
        return "update_world"
    return "base_world"


def _name_prefix(name: str) -> str:
    s = str(name or "").strip().lower()
    if not s:
        return ""
    m = re.match(r"^([a-z]+)(?:[_-].*)?$", s)
    if m:
        return m.group(1)
    # fallback: take up to first underscore token
    return s.split("_", 1)[0]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--missing", required=True, help="Path to missing_archetypes.json from report_missing_meshes.py")
    ap.add_argument("--assets-dir", default="", help="webgl_viewer/assets folder (auto if omitted)")
    ap.add_argument("--top", type=int, default=40, help="Show top N missing archetypes")
    ap.add_argument("--max-samples-per-hash", type=int, default=3, help="Cap per-hash sample refs printed")
    args = ap.parse_args()

    assets_dir = auto_assets_dir(args.assets_dir)
    chunks_dir = assets_dir / "entities_chunks"
    if not chunks_dir.exists():
        raise SystemExit(f"Missing entities_chunks dir: {chunks_dir}")

    missing_path = Path(args.missing).resolve()
    missing_obj = json.loads(missing_path.read_text(encoding="utf-8", errors="ignore"))
    items = (missing_obj.get("missingTop") or []) if isinstance(missing_obj, dict) else []
    missing_hashes = []
    missing_counts = {}
    for it in items:
        if not isinstance(it, dict):
            continue
        h = _as_u32_str(it.get("hash"))
        if not h:
            continue
        missing_hashes.append(h)
        try:
            missing_counts[h] = int(it.get("count") or 0)
        except Exception:
            missing_counts[h] = 0
    missing_set = set(missing_hashes)
    if not missing_set:
        raise SystemExit("No hashes found in --missing")

    # Aggregate from entity placements.
    seen_missing_entities = 0
    samples_by_hash: Dict[str, list] = defaultdict(list)
    name_by_hash: Dict[str, str] = {}

    by_is_mlo = Counter()
    by_ymap_cat = Counter()
    by_ymap_rpf = Counter()
    by_name_prefix = Counter()
    by_entity_set = Counter()

    for _chunk_file, ent in _iter_entity_lines(chunks_dir):
        h = _as_u32_str(ent.get("archetype_hash") or ent.get("archetype"))
        if not h or h not in missing_set:
            continue
        seen_missing_entities += 1
        nm = str(ent.get("archetype_raw") or ent.get("name") or "")
        if nm and h not in name_by_hash:
            name_by_hash[h] = nm

        ymap = str(ent.get("ymap") or "")
        cat = _ymap_category(ymap)
        by_ymap_cat[cat] += 1

        is_mlo = bool(ent.get("is_mlo_instance"))
        by_is_mlo["mlo_instance" if is_mlo else "not_mlo_instance"] += 1

        if nm:
            by_name_prefix[_name_prefix(nm)] += 1

        es = str(ent.get("mlo_entity_set_name") or "")
        if es:
            by_entity_set[es] += 1

        # Coarse "RPF group" bucket: take last *.rpf component if present.
        low = ymap.replace("\\", "/")
        rpf = ""
        if ".rpf/" in low:
            # take the last segment ending in .rpf
            parts = low.split("/")
            for i in range(len(parts) - 1, -1, -1):
                if parts[i].endswith(".rpf"):
                    rpf = parts[i]
                    break
        if rpf:
            by_ymap_rpf[rpf] += 1

        # Keep a few samples for printing.
        if len(samples_by_hash[h]) < int(args.max_samples_per_hash or 3):
            samples_by_hash[h].append(
                {
                    "ymap": ymap,
                    "name": str(ent.get("name") or ""),
                    "is_mlo_instance": bool(ent.get("is_mlo_instance")),
                }
            )

    print("== Missing archetype patterns ==")
    print(f"missing set size: {len(missing_set)} (from {missing_path.name})")
    print(f"missing entities observed in streamed chunks: {seen_missing_entities}")
    print("")

    print("-- breakdown: ymap category (by placement count) --")
    for k, v in by_ymap_cat.most_common():
        print(f"{k:>12}: {v}")
    print("")

    print("-- breakdown: MLO instance flag (by placement count) --")
    for k, v in by_is_mlo.most_common():
        print(f"{k:>16}: {v}")
    print("")

    print("-- top name prefixes (by placement count) --")
    for k, v in by_name_prefix.most_common(20):
        if not k:
            continue
        print(f"{k:>12}: {v}")
    print("")

    print("-- top YMAP RPF buckets (by placement count) --")
    for k, v in by_ymap_rpf.most_common(15):
        print(f"{k:>28}: {v}")
    print("")

    # Top missing archetypes by the *global* missing counts file (not just observed in sampled scan).
    topn = max(0, int(args.top or 0))
    rows = [(h, int(missing_counts.get(h) or 0)) for h in missing_set]
    rows.sort(key=lambda kv: kv[1], reverse=True)
    print(f"-- top {topn} missing archetypes (by occurrence in entities stream) --")
    for h, cnt in rows[:topn]:
        nm = name_by_hash.get(h, "")
        nm_s = f" {nm}" if nm else ""
        print(f"{h}: {cnt}{nm_s}")
        for s in samples_by_hash.get(h, [])[: int(args.max_samples_per_hash or 3)]:
            y = str(s.get('ymap') or '')
            im = "mlo" if s.get("is_mlo_instance") else "ent"
            print(f"  - ({im}) {y}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



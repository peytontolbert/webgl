#!/usr/bin/env python3
"""
Build a render-asset request list from the resolved archetype index.

Inputs:
- output/world/archetype_index.json   (from scripts/resolve_ymap_archetypes.py)
- output/world/archetype_missing.json (optional; for reporting)

Outputs (under --outdir, default: output/world):
- render_asset_requests.json
  - unique lists of:
    - ydr_asset_names: assetName values that likely correspond to drawable/model names
    - ydd_drawable_dicts: drawableDictionary names/hashes (when present)
    - ytd_texture_dicts: textureDictionary names/hashes (when present)

Why:
This gives you a concrete, de-duplicated list of what to extract/convert next for a viewer:
- models: YDR/YDD
- textures: YTD/GTXD (then decode to PNG/KTX2)
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, Tuple


def _load_json(p: Path) -> Any:
    return json.loads(p.read_text(encoding="utf-8"))


def _get(d: Dict[str, Any], path: str, default=None):
    cur: Any = d
    for part in path.split("."):
        if not isinstance(cur, dict):
            return default
        cur = cur.get(part)
    return cur if cur is not None else default


def _norm_name(x: Any) -> str:
    if x is None:
        return ""
    s = str(x).strip()
    if s in {"0", "hash_0", ""}:
        return ""
    return s


def _iter_resolved(archetype_index: Dict[str, Any]) -> Iterable[Tuple[int, Dict[str, Any]]]:
    resolved = archetype_index.get("resolved") or {}
    if not isinstance(resolved, dict):
        return []
    for h_str, rec in resolved.items():
        try:
            h = int(h_str)
        except Exception:
            continue
        if not isinstance(rec, dict):
            continue
        yield h, rec


def main() -> int:
    ap = argparse.ArgumentParser(description="Build render asset request lists from archetype_index.json")
    ap.add_argument("--archetype-index", type=Path, default=Path("output/world/archetype_index.json"))
    ap.add_argument("--archetype-missing", type=Path, default=Path("output/world/archetype_missing.json"))
    ap.add_argument("--outdir", type=Path, default=Path("output/world"))
    ap.add_argument("--top", type=int, default=200, help="How many top entries to include in each list for convenience")
    args = ap.parse_args()

    idx_path = args.archetype_index
    if not idx_path.exists():
        raise SystemExit(f"Missing: {idx_path}. Run scripts/resolve_ymap_archetypes.py first.")

    outdir = args.outdir
    outdir.mkdir(parents=True, exist_ok=True)

    idx = _load_json(idx_path)

    # Aggregate counts (placements) per asset name / dict name.
    ydr_counts: Dict[str, int] = defaultdict(int)
    ytd_counts: Dict[str, int] = defaultdict(int)
    ydd_counts: Dict[str, int] = defaultdict(int)

    # Keep representative hashes for debugging.
    ydr_hash: Dict[str, int] = {}
    ytd_hash: Dict[str, int] = {}
    ydd_hash: Dict[str, int] = {}

    total_resolved = 0
    for h, rec in _iter_resolved(idx):
        total_resolved += 1
        cnt = int(rec.get("count", 0) or 0)
        a = rec.get("archetype") or {}
        if not isinstance(a, dict):
            continue

        asset_name = _norm_name(_get(a, "assetName.name", ""))
        drawable_dict = _norm_name(_get(a, "drawableDict.name", ""))
        texture_dict = _norm_name(_get(a, "textureDict.name", ""))

        if asset_name:
            ydr_counts[asset_name] += cnt
            ydr_hash.setdefault(asset_name, int(_get(a, "assetName.hash", h) or h))

        # drawableDictionary usually corresponds to a YDD name when non-zero.
        if drawable_dict:
            ydd_counts[drawable_dict] += cnt
            ydd_hash.setdefault(drawable_dict, int(_get(a, "drawableDict.hash", 0) or 0))

        # textureDictionary corresponds to a YTD dictionary name.
        if texture_dict:
            ytd_counts[texture_dict] += cnt
            ytd_hash.setdefault(texture_dict, int(_get(a, "textureDict.hash", 0) or 0))

    def _top_list(counts: Dict[str, int], hashes: Dict[str, int]) -> list[dict]:
        items = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        out = []
        for name, c in items[: max(0, int(args.top))]:
            out.append({"name": name, "count": int(c), "hash": int(hashes.get(name, 0))})
        return out

    missing = None
    if args.archetype_missing.exists():
        try:
            missing = _load_json(args.archetype_missing).get("stats")
        except Exception:
            missing = None

    out = {
        "source": {
            "archetype_index": str(idx_path),
            "archetype_missing_stats": missing,
        },
        "counts": {
            "resolved_archetypes": int(total_resolved),
            "unique_ydr_asset_names": int(len(ydr_counts)),
            "unique_ytd_texture_dicts": int(len(ytd_counts)),
            "unique_ydd_drawable_dicts": int(len(ydd_counts)),
        },
        "top": {
            "ydr_asset_names": _top_list(ydr_counts, ydr_hash),
            "ytd_texture_dicts": _top_list(ytd_counts, ytd_hash),
            "ydd_drawable_dicts": _top_list(ydd_counts, ydd_hash),
        },
    }

    out_path = outdir / "render_asset_requests.json"
    out_path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print("Wrote:")
    print(f"  {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



#!/usr/bin/env python3
"""
Resolve YMAP entity archetypes using exported YTYP archetype JSON.

Inputs:
- output/ymap/entities/*.json            (from extract_ymaps.py)
- output/ytyp/archetypes/**/*.ytyp.json  (from extract_ytyp_linux.py)

Outputs:
- output/world/archetype_index.json      (hash -> resolved archetype record)
- output/world/archetype_missing.json    (hashes referenced by YMAPs but not found in YTYPs)

This doesn't extract models/textures; it only resolves "what is this archetype?" so the viewer
can decide what to request next (ydr/ytd/etc).
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple


def _iter_json_files(root: Path) -> Iterable[Path]:
    if not root.exists():
        return []
    return sorted([p for p in root.rglob("*.json") if p.is_file()])


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _get(d: Dict[str, Any], path: str, default=None):
    cur: Any = d
    for part in path.split("."):
        if not isinstance(cur, dict):
            return default
        cur = cur.get(part)
    return cur if cur is not None else default


def _norm_name(s: Any) -> str:
    if s is None:
        return ""
    return str(s).strip().lower()


def _add_ref(*, refs_by_hash: Dict[int, int], refs_by_name: Dict[str, int], h: Any, n: Any, weight: int = 1) -> None:
    try:
        w = int(weight)
    except Exception:
        w = 1
    if w <= 0:
        w = 1
    if isinstance(h, int) and h != 0:
        refs_by_hash[h] += w
    if n:
        refs_by_name[_norm_name(n)] += w


def main() -> int:
    ap = argparse.ArgumentParser(description="Resolve YMAP archetypes using YTYP exports.")
    ap.add_argument("--ymap-entities", type=Path, default=Path("output/ymap/entities"), help="Directory of YMAP entity JSON files")
    ap.add_argument("--ytyp-archetypes", type=Path, default=Path("output/ytyp/archetypes"), help="Directory of YTYP archetype JSON files")
    ap.add_argument("--outdir", type=Path, default=Path("output/world"), help="Output directory")
    ap.add_argument("--max-ymaps", type=int, default=0, help="Limit number of YMAP JSON files to scan (0 = no limit)")
    args = ap.parse_args()

    ymap_dir = args.ymap_entities
    ytyp_dir = args.ytyp_archetypes
    outdir = args.outdir
    outdir.mkdir(parents=True, exist_ok=True)

    # 1) Build archetype DB from YTYP JSON
    archetypes_by_hash: Dict[int, Dict[str, Any]] = {}
    archetypes_by_name: Dict[str, Dict[str, Any]] = {}
    ytyp_files = list(_iter_json_files(ytyp_dir))
    if not ytyp_files:
        print(f"ERROR: no YTYP archetype JSON files found under: {ytyp_dir}")
        print("Run: python3 extract_ytyp_linux.py --game-path <GTA_ROOT> --output-dir output")
        return 1

    for fp in ytyp_files:
        try:
            doc = _load_json(fp)
        except Exception:
            continue
        for a in (doc.get("archetypes") or []):
            if not isinstance(a, dict):
                continue
            h = _get(a, "name.hash", None)
            nm = _get(a, "name.name", None)
            if isinstance(h, int) and h != 0:
                # Prefer first-seen; keep stable.
                archetypes_by_hash.setdefault(h, a)
            if nm:
                archetypes_by_name.setdefault(_norm_name(nm), a)

    # 2) Scan YMAP entity JSON and count references
    refs_by_hash: Dict[int, int] = defaultdict(int)
    refs_by_name: Dict[str, int] = defaultdict(int)
    ymap_files = list(_iter_json_files(ymap_dir))
    if args.max_ymaps and args.max_ymaps > 0:
        ymap_files = ymap_files[: args.max_ymaps]

    if not ymap_files:
        print(f"ERROR: no YMAP entity JSON files found under: {ymap_dir}")
        print("Run: python3 extract_ymaps.py --game-path <GTA_ROOT> --output-dir output")
        return 1

    for fp in ymap_files:
        try:
            doc = _load_json(fp)
        except Exception:
            continue

        # 1) Standard placed entities (CEntityDefs)
        for ent in (doc.get("entities") or []):
            if not isinstance(ent, dict):
                continue
            _add_ref(refs_by_hash=refs_by_hash, refs_by_name=refs_by_name, h=ent.get("archetypeHash"), n=ent.get("archetypeName"), weight=1)

        # 2) MLO instances (CMloInstanceDefs) - stored under mloInstances[].entity
        for mlo in (doc.get("mloInstances") or []):
            if not isinstance(mlo, dict):
                continue
            ent = mlo.get("entity") or {}
            if not isinstance(ent, dict):
                continue
            _add_ref(refs_by_hash=refs_by_hash, refs_by_name=refs_by_name, h=ent.get("archetypeHash"), n=ent.get("archetypeName"), weight=1)

        # 3) Instanced grass batches: count by instanceCount for better ranking.
        for gb in (doc.get("grassInstanceBatches") or []):
            if not isinstance(gb, dict):
                continue
            _add_ref(
                refs_by_hash=refs_by_hash,
                refs_by_name=refs_by_name,
                h=gb.get("archetypeHash"),
                n=gb.get("archetypeName"),
                weight=int(gb.get("instanceCount", 1) or 1),
            )

    # 3) Resolve references
    resolved: Dict[str, Any] = {}
    missing: Dict[str, Any] = {}

    for h, count in sorted(refs_by_hash.items(), key=lambda kv: (-kv[1], kv[0])):
        a = archetypes_by_hash.get(h)
        if a is not None:
            resolved[str(h)] = {
                "count": count,
                "by": "hash",
                "archetype": a,
            }
        else:
            missing[str(h)] = {
                "count": count,
                "by": "hash",
            }

    # Also attempt name-based resolution for missing hashes (best-effort).
    for nm, count in sorted(refs_by_name.items(), key=lambda kv: (-kv[1], kv[0])):
        a = archetypes_by_name.get(nm)
        if a is None:
            continue
        # Try to attach this name resolution if the hash is missing.
        ah = _get(a, "name.hash", None)
        if isinstance(ah, int) and str(ah) in missing:
            missing[str(ah)]["nameHint"] = nm
            missing[str(ah)]["resolvedByName"] = a

    out_index = outdir / "archetype_index.json"
    out_missing = outdir / "archetype_missing.json"
    out_index.write_text(json.dumps({"resolved": resolved}, indent=2), encoding="utf-8")
    out_missing.write_text(
        json.dumps(
            {
                "missing": missing,
                "stats": {
                    "unique_archetype_hashes_in_ymaps": len(refs_by_hash),
                    "resolved_hashes": len(resolved),
                    "missing_hashes": len(missing),
                    "ytyp_files_scanned": len(ytyp_files),
                    "ymap_files_scanned": len(ymap_files),
                },
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    print("Wrote:")
    print(f"  {out_index}")
    print(f"  {out_missing}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



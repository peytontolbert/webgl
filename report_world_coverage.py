#!/usr/bin/env python3
"""
Production coverage report for "map import looks like GTA":

- YMAP export presence: assets/ymap/index.json + referenced ymap entity JSONs exist.
- Entity streaming integrity: assets/entities_index.json + entities_chunks/*.jsonl exist and counts match (sampled).
- Archetype -> mesh coverage (sampled): for entities in sampled chunks, how many archetype hashes exist in the
  sharded models manifest (assets/models/manifest_shards/*.json).

This is meant to answer:
  "Did we import 100% of the YMAPs and do placed things resolve to exported meshes?"

Texture completeness is a separate step (run the repair pipeline):
  python3 webgl-gta/webgl_viewer/tools/repair_missing_model_textures.py ...
"""

from __future__ import annotations

import argparse
import json
import os
from collections import Counter
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

from gta5_modules.entity_coverage import auto_assets_dir, iter_chunk_rows, iter_jsonl_objects, load_entities_index

from gta5_modules.archetype_utils import normalize_archetype_to_hash_str
from gta5_modules.hash_utils import as_u32_str, joaat


def _as_uint32_str(x) -> Optional[str]:
    # Backwards-compatible wrapper
    return as_u32_str(x)


def _joaat(s: str) -> int:
    # Backwards-compatible wrapper (legacy scripts did NOT lowercase here)
    return int(joaat(s, lower=False))


def _normalize_archetype_to_hash_str(obj: dict) -> Optional[str]:
    # Backwards-compatible wrapper
    return normalize_archetype_to_hash_str(obj)


def _iter_sampled_chunk_files(idx: dict, chunks_dir: Path, max_chunks: int) -> List[Tuple[str, Path, int]]:
    rows = iter_chunk_rows(idx)
    if max_chunks and max_chunks > 0:
        rows = rows[: int(max_chunks)]
    return [(k, chunks_dir / fn, int(exp)) for (k, fn, exp) in rows]


def _load_manifest_shard(mesh_hash_u32: str, models_dir: Path, shard_bits: int, shard_dir: str) -> Optional[dict]:
    try:
        u = int(mesh_hash_u32, 10) & 0xFFFFFFFF
    except Exception:
        return None
    mask = (1 << int(shard_bits)) - 1
    shard_id = u & mask
    fname = f"{shard_id:02x}.json"
    p = models_dir / str(shard_dir) / fname
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--assets-dir", default="", help="webgl_viewer/assets folder (auto if omitted)")
    ap.add_argument("--chunk-limit", type=int, default=60, help="Sample N chunks for checks (0 = all; can be slow)")
    ap.add_argument("--max-entities", type=int, default=150000, help="Cap entity lines parsed across sampled chunks")
    ap.add_argument("--out", default="", help="Write JSON report to this path (optional)")
    args = ap.parse_args()

    assets_dir = auto_assets_dir(args.assets_dir)
    if not assets_dir.exists():
        raise SystemExit(f"Missing assets dir: {assets_dir}")

    # --- YMAP coverage (presence + index consistency) ---
    ymap_index_path = assets_dir / "ymap" / "index.json"
    ymap_entities_dir = assets_dir / "ymap" / "entities"
    ymap = json.loads(ymap_index_path.read_text(encoding="utf-8", errors="ignore")) if ymap_index_path.exists() else None
    ymap_missing_files: List[str] = []
    ymap_num = int((ymap or {}).get("numYmaps") or 0) if isinstance(ymap, dict) else 0
    if isinstance(ymap, dict) and isinstance(ymap.get("ymaps"), list) and ymap_entities_dir.exists():
        for row in ymap.get("ymaps")[:]:
            fn = (row or {}).get("file")
            if not fn:
                continue
            p = ymap_entities_dir / str(fn)
            if not p.exists():
                ymap_missing_files.append(str(fn))

    # --- Entity streaming index integrity (sampled) ---
    idx_path = assets_dir / "entities_index.json"
    chunks_dir = assets_dir / "entities_chunks"
    if not idx_path.exists():
        raise SystemExit(f"Missing {idx_path}")
    if not chunks_dir.exists():
        raise SystemExit(f"Missing {chunks_dir}")
    idx = load_entities_index(assets_dir)

    chunk_rows = _iter_sampled_chunk_files(idx, chunks_dir, int(args.chunk_limit or 0))
    missing_chunk_files: List[str] = []
    mismatched_chunks: List[dict] = []
    sampled_entities = 0

    # Sample archetype hashes from entity JSONL.
    archetype_counts = Counter()
    archetype_name_samples: Dict[str, Counter] = {}

    for chunk_key, p, exp in chunk_rows:
        if not p.exists():
            missing_chunk_files.append(str(p))
            continue
        n = 0
        for obj in iter_jsonl_objects(p):
            n += 1
            if sampled_entities >= int(args.max_entities or 0) > 0:
                break
            sampled_entities += 1
            h = _normalize_archetype_to_hash_str(obj)
            if not h:
                continue
            archetype_counts[h] += 1
            nm = str(obj.get("name") or "")
            if nm:
                c = archetype_name_samples.get(h)
                if c is None:
                    c = Counter()
                    archetype_name_samples[h] = c
                c[nm] += 1
        # NOTE: this is a *sampled* report; mismatches here indicate either:
        # - index/file mismatch (real integrity issue), OR
        # - we stopped early due to --max-entities cap.
        # Only flag mismatch when we fully scanned the chunk file.
        capped = (int(args.max_entities or 0) > 0) and (sampled_entities >= int(args.max_entities or 0))
        if (not capped) and (n != exp):
            mismatched_chunks.append({"chunk": chunk_key, "expected": exp, "fileLines": n, "file": str(p.name)})
        if sampled_entities >= int(args.max_entities or 0) > 0:
            break

    # --- Archetype -> mesh coverage (sampled, shard-on-demand) ---
    models_dir = assets_dir / "models"
    manifest_index_path = models_dir / "manifest_index.json"
    mi = json.loads(manifest_index_path.read_text(encoding="utf-8", errors="ignore")) if manifest_index_path.exists() else {}
    shard_bits = int(mi.get("shard_bits") or 8)
    shard_dir = str(mi.get("shard_dir") or "manifest_shards")

    exported = 0
    missing = 0
    missing_archetypes = Counter()

    # Cache shard loads for speed.
    shard_cache: Dict[int, dict] = {}

    def _has_mesh(h_u32: str) -> bool:
        nonlocal exported, missing
        try:
            u = int(h_u32, 10) & 0xFFFFFFFF
        except Exception:
            return False
        mask = (1 << int(shard_bits)) - 1
        sid = u & mask
        payload = shard_cache.get(sid)
        if payload is None:
            payload = _load_manifest_shard(h_u32, models_dir, shard_bits, shard_dir) or {}
            shard_cache[sid] = payload
        meshes = payload.get("meshes") if isinstance(payload, dict) else None
        ok = isinstance(meshes, dict) and (h_u32 in meshes)
        if ok:
            exported += 1
        else:
            missing += 1
        return ok

    for h_u32, cnt in archetype_counts.most_common():
        if not _has_mesh(h_u32):
            missing_archetypes[h_u32] += int(cnt)

    report = {
        "assetsDir": str(assets_dir),
        "ymap": {
            "hasIndex": bool(ymap_index_path.exists()),
            "numYmaps": ymap_num,
            "ymapEntitiesDir": str(ymap_entities_dir) if ymap_entities_dir.exists() else "",
            "missingEntityJsonFiles": ymap_missing_files[:200],
            "missingEntityJsonFileCount": int(len(ymap_missing_files)),
        },
        "entitiesIndex": {
            # Prefer authoritative fields from entities_index.json.
            "chunks": int(len(idx.get("chunks") or {})),
            "entities": int(idx.get("total_entities") or 0),
            # ymap_stats is authoritative for how many YMAPs were enumerated by the exporter.
            "ymapsProcessed": int(((idx.get("ymap_stats") or {}).get("total_entries")) or ((idx.get("counts") or {}).get("ymaps_processed")) or 0),
        },
        "entityChunksSample": {
            "chunkLimit": int(args.chunk_limit or 0),
            "maxEntities": int(args.max_entities or 0),
            "sampledEntityLines": int(sampled_entities),
            "missingChunkFiles": missing_chunk_files[:200],
            "missingChunkFileCount": int(len(missing_chunk_files)),
            "mismatchedChunks": mismatched_chunks[:200],
            "mismatchedChunkCount": int(len(mismatched_chunks)),
        },
        "archetypesSample": {
            "uniqueArchetypes": int(len(archetype_counts)),
            "exportedArchetypes": int(exported),
            "missingArchetypes": int(missing),
            "missingTop": [
                {
                    "hash": h,
                    "count": int(n),
                    "names": [k for k, _v in archetype_name_samples.get(h, Counter()).most_common(2)],
                }
                for h, n in missing_archetypes.most_common(40)
            ],
        },
        "notes": [
            "This report is sampled unless --chunk-limit=0 (all) and --max-entities=0 (no cap).",
            "To backfill missing model textures, use: webgl_viewer/tools/repair_missing_model_textures.py",
        ],
    }

    # Quick console summary
    print("== World coverage (sampled) ==")
    print(f"assets: {assets_dir}")
    if ymap_index_path.exists():
        print(f"ymaps: {ymap_num} | missing ymap entity json files: {len(ymap_missing_files)}")
    else:
        print("ymaps: (no assets/ymap/index.json)")
    print(
        f"entities_index: ymaps_processed={report['entitiesIndex']['ymapsProcessed']} "
        f"entities={report['entitiesIndex']['entities']} chunks={report['entitiesIndex']['chunks']}"
    )
    print(
        f"entity chunks: sampled_lines={sampled_entities} missing_files={len(missing_chunk_files)} "
        f"count_mismatches={len(mismatched_chunks)}"
    )
    print(
        f"archetypes (sampled): unique={len(archetype_counts)} exported={exported} missing={missing} "
        f"(missingTop shows most frequent missing archetypes in sampled chunks)"
    )

    if args.out:
        out_path = Path(args.out).resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(f"\nwrote: {out_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())



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
import zlib
from pathlib import Path

from gta5_modules.entity_coverage import auto_assets_dir, iter_chunk_rows, load_entities_index


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--assets-dir", default="", help="webgl_viewer/assets folder (auto if omitted)")
    ap.add_argument("--limit", type=int, default=0, help="Only check first N chunks (0 = all)")
    ap.add_argument(
        "--dup-samples",
        type=int,
        default=0,
        help=(
            "If >0, record and print up to N duplicate (ymap, ymap_entity_index) sample locations "
            "to help diagnose export duplication."
        ),
    )
    ap.add_argument(
        "--check-hierarchy",
        action="store_true",
        help=(
            "Parse JSONL and validate presence of CodeWalker-style hierarchy/LOD fields "
            "(ymap_entity_index, parent_index, num_children, lod_dist, child_lod_dist, lod_level)."
        ),
    )
    ap.add_argument(
        "--check-unique-ymap-entity-index",
        action="store_true",
        help="Check that (ymap, ymap_entity_index) pairs are globally unique (detects duplication across chunks).",
    )
    args = ap.parse_args()

    assets_dir = auto_assets_dir(args.assets_dir)

    idx_path = assets_dir / "entities_index.json"
    chunks_dir = assets_dir / "entities_chunks"
    if not idx_path.exists():
        raise SystemExit(f"Missing {idx_path}")
    if not chunks_dir.exists():
        raise SystemExit(f"Missing {chunks_dir}")

    idx = load_entities_index(assets_dir)
    chunks = [(k, {"file": fn, "count": exp}) for (k, fn, exp) in iter_chunk_rows(idx)]
    lim = int(args.limit or 0)
    if lim > 0:
        chunks = chunks[:lim]

    bad = 0
    scanned = 0
    sum_index = 0
    sum_lines = 0
    field_missing = {
        "ymap": 0,
        "ymap_entity_index": 0,
        "archetype": 0,
        "position": 0,
        # hierarchy/LOD fields (needed for CodeWalker-like traversal)
        "parent_index": 0,
        "num_children": 0,
        "lod_dist": 0,
        "child_lod_dist": 0,
        "lod_level": 0,
    }
    parsed = 0
    parse_errors = 0
    dup_count = 0
    seen_pairs = set()  # u64-ish packed key: (crc32(ymap) << 32) | (ymap_entity_index)
    dup_samples = []
    # Only used when args.dup_samples > 0 AND we haven't collected enough samples yet.
    # We intentionally stop tracking after collecting enough samples to avoid high memory usage.
    first_loc = {}  # packed -> (ymap, ei, chunkKey, file, lineNo)
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
            line_no = 0
            for line in f:
                if line.strip():
                    line_no += 1
                    n += 1
                    if args.check_hierarchy or args.check_unique_ymap_entity_index:
                        try:
                            obj = json.loads(line)
                            parsed += 1
                        except Exception:
                            parse_errors += 1
                            continue

                        # Minimal required fields for entity streaming.
                        if not obj.get("ymap"):
                            field_missing["ymap"] += 1
                        if obj.get("ymap_entity_index") is None:
                            field_missing["ymap_entity_index"] += 1
                        if obj.get("archetype") is None and obj.get("archetype_hash") is None:
                            field_missing["archetype"] += 1
                        pos = obj.get("position")
                        if (not isinstance(pos, list)) or (len(pos) < 3):
                            field_missing["position"] += 1

                        # CodeWalker-like hierarchy/LOD fields.
                        if args.check_hierarchy:
                            if obj.get("parent_index") is None:
                                field_missing["parent_index"] += 1
                            if obj.get("num_children") is None:
                                field_missing["num_children"] += 1
                            if obj.get("lod_dist") is None:
                                field_missing["lod_dist"] += 1
                            if obj.get("child_lod_dist") is None:
                                field_missing["child_lod_dist"] += 1
                            if obj.get("lod_level") is None:
                                field_missing["lod_level"] += 1

                        if args.check_unique_ymap_entity_index:
                            try:
                                ymap = str(obj.get("ymap") or "")
                                ei = int(obj.get("ymap_entity_index"))
                                # Ignore invalid indices (commonly -1 for interior child entities)
                                # since they aren't meaningful for uniqueness and will explode dup counts.
                                if ei < 0:
                                    continue
                                ycrc = zlib.crc32(ymap.encode("utf-8")) & 0xFFFFFFFF
                                packed = (ycrc << 32) | (ei & 0xFFFFFFFF)
                                if packed in seen_pairs:
                                    dup_count += 1
                                    if args.dup_samples and (len(dup_samples) < int(args.dup_samples or 0)):
                                        first = first_loc.get(packed)
                                        if first is not None:
                                            dup_samples.append(
                                                {
                                                    "ymap": ymap,
                                                    "ymap_entity_index": ei,
                                                    "first": {
                                                        "chunk": first[2],
                                                        "file": first[3],
                                                        "line": first[4],
                                                    },
                                                    "dup": {"chunk": key, "file": file0, "line": line_no},
                                                }
                                            )
                                else:
                                    seen_pairs.add(packed)
                                    if args.dup_samples and (len(dup_samples) < int(args.dup_samples or 0)):
                                        first_loc[packed] = (ymap, ei, key, file0, line_no)
                            except Exception:
                                # treat malformed as non-unique-checkable, but don't crash.
                                pass
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
    if args.check_hierarchy or args.check_unique_ymap_entity_index:
        print("")
        print(f"Parsed entity JSON objects: {parsed}")
        print(f"JSON parse errors: {parse_errors}")
        if args.check_unique_ymap_entity_index:
            print(f"Duplicate (ymap, ymap_entity_index) pairs: {dup_count}")
            if args.dup_samples:
                print(f"Duplicate samples (up to {int(args.dup_samples or 0)}):")
                if not dup_samples:
                    print("- (none captured; try increasing --dup-samples or ensure --check-unique-ymap-entity-index is set)")
                else:
                    for s in dup_samples:
                        y = s.get("ymap")
                        ei = s.get("ymap_entity_index")
                        f0 = s.get("first") or {}
                        d0 = s.get("dup") or {}
                        print(
                            f"- (ymap_entity_index={ei}) ymap={y}\n"
                            f"  first: {f0.get('chunk')} {f0.get('file')} line={f0.get('line')}\n"
                            f"  dup:   {d0.get('chunk')} {d0.get('file')} line={d0.get('line')}"
                        )
        print("Missing-field counts:")
        for k, v in field_missing.items():
            print(f"- {k}: {v}")


if __name__ == "__main__":
    main()



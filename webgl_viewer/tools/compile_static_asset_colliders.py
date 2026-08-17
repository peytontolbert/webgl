#!/usr/bin/env python3
"""Split authored asset collider records into immutable, streamable chunks.

The input manifest is never changed.  Every record is copied verbatim into
exactly one derived output: ``static`` records are located by their authored
center, while destructible/pushable/non-static records remain in the live
overlay.  The latter must stay resident because gameplay is allowed to move or
remove them.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
from collections import defaultdict
from pathlib import Path


SCHEMA = "webglgta-compiled-asset-colliders-v1"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def is_immutable(record: object) -> bool:
    if not isinstance(record, dict):
        return False
    if str(record.get("destructibleId") or "").strip():
        return False
    # Only a literal static response is immutable.  Unknown responses stay
    # live so a new gameplay response never becomes silently frozen.
    return str(record.get("response") or "static").strip().lower() == "static"


def center_key(record: dict, cell_size: float) -> tuple[int, int]:
    x = float(record["x"])
    y = float(record["y"])
    if not math.isfinite(x) or not math.isfinite(y):
        raise ValueError("collider has no finite x/y center")
    return math.floor(x / cell_size), math.floor(y / cell_size)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--cell-size", type=float, default=64.0)
    args = parser.parse_args()
    if not math.isfinite(args.cell_size) or args.cell_size <= 0:
        raise SystemExit("--cell-size must be positive")

    source = args.source.resolve()
    out_dir = args.out_dir.resolve()
    payload = json.loads(source.read_text(encoding="utf-8"))
    records = payload.get("colliders") if isinstance(payload, dict) else None
    if not isinstance(records, list):
        raise SystemExit(f"{source}: expected a colliders array")

    stage = out_dir.with_name(out_dir.name + ".tmp")
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    chunks: dict[tuple[int, int], list[dict]] = defaultdict(list)
    live: list[object] = []
    invalid = 0
    for record in records:
        if not isinstance(record, dict):
            live.append(record)
            invalid += 1
            continue
        if not is_immutable(record):
            live.append(record)
            continue
        try:
            chunks[center_key(record, args.cell_size)].append(record)
        except (KeyError, TypeError, ValueError, OverflowError):
            # Keep malformed records in the live layer.  This fails safe: the
            # compiled layer cannot make an authored collider disappear.
            live.append(record)
            invalid += 1

    chunk_entries = []
    for (gx, gy), chunk_records in sorted(chunks.items()):
        name = f"chunk_{gx}_{gy}.json"
        (stage / name).write_text(json.dumps({"colliders": chunk_records}, separators=(",", ":")), encoding="utf-8")
        chunk_entries.append({"gx": gx, "gy": gy, "file": name, "count": len(chunk_records)})

    live_payload = {
        "colliders": live,
        "ybnCollisionExclusions": payload.get("ybnCollisionExclusions", []),
    }
    (stage / "live_overlay.json").write_text(json.dumps(live_payload, separators=(",", ":")), encoding="utf-8")
    manifest = {
        "schema": SCHEMA,
        "source": source.name,
        "source_sha256": sha256(source),
        "source_record_count": len(records),
        "immutable_record_count": sum(entry["count"] for entry in chunk_entries),
        "live_record_count": len(live),
        "invalid_static_candidates_kept_live": invalid,
        "cell_size": args.cell_size,
        "chunks": chunk_entries,
        "live_overlay": "live_overlay.json",
        "ybn_collision_exclusion_count": len(payload.get("ybnCollisionExclusions", [])),
    }
    (stage / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    if out_dir.exists():
        shutil.rmtree(out_dir)
    stage.rename(out_dir)
    print(json.dumps({"out_dir": str(out_dir), **{key: manifest[key] for key in (
        "source_record_count", "immutable_record_count", "live_record_count",
        "invalid_static_candidates_kept_live")}, "chunks": len(chunk_entries)}, indent=2))


if __name__ == "__main__":
    main()

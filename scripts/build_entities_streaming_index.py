#!/usr/bin/env python3
"""
Build a chunked entity streaming index for the WebGL viewer.

Inputs:
- output/ymap/entities/*.json (from extract_ymaps.py)

Outputs:
- <outdir>/entities_index.json
- <outdir>/entities_chunks/<chunkKey>.jsonl    (NDJSON)

Each line in a chunk file is a compact entity record:
  {"archetype": <u32>, "position":[x,y,z], "rotation":[w,x,y,z], "scale":[x,y,z]}

This makes the viewer behave more like a GTA client: stream by camera chunk neighborhood
instead of scanning thousands of ymap AABBs.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import time
from collections import OrderedDict, defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, Tuple


def _load_json(p: Path) -> Any:
    return json.loads(p.read_text(encoding="utf-8"))


def _as_f3(v) -> Tuple[float, float, float] | None:
    if not isinstance(v, (list, tuple)) or len(v) < 3:
        return None
    try:
        x = float(v[0])
        y = float(v[1])
        z = float(v[2])
        if not (math.isfinite(x) and math.isfinite(y) and math.isfinite(z)):
            return None
        return x, y, z
    except Exception:
        return None


def _as_u32(x) -> int | None:
    try:
        if isinstance(x, str):
            s = x.strip()
            if not s or not s.lstrip("-").isdigit():
                return None
            x = int(s, 10)
        n = int(x)
        return n & 0xFFFFFFFF
    except Exception:
        return None


def _chunk_key(x: float, y: float, chunk_size: float) -> str:
    cx = int(math.floor(x / chunk_size))
    cy = int(math.floor(y / chunk_size))
    return f"{cx}_{cy}"


class _ChunkWriterPool:
    """
    LRU pool of open file handles to avoid hitting OS limits.
    """

    def __init__(self, chunks_dir: Path, max_open: int = 64):
        self.chunks_dir = chunks_dir
        self.max_open = max(8, int(max_open))
        self._open: "OrderedDict[str, Any]" = OrderedDict()  # key -> file handle
        self.chunks_dir.mkdir(parents=True, exist_ok=True)

    def _evict_if_needed(self):
        while len(self._open) > self.max_open:
            _k, fh = self._open.popitem(last=False)
            try:
                fh.close()
            except Exception:
                pass

    def write_line(self, key: str, line: str) -> None:
        fh = self._open.get(key)
        if fh is None:
            path = self.chunks_dir / f"{key}.jsonl"
            fh = open(path, "a", encoding="utf-8")
            self._open[key] = fh
        else:
            # mark as recently used
            self._open.move_to_end(key, last=True)

        fh.write(line)
        fh.write("\n")
        self._evict_if_needed()

    def close_all(self):
        for fh in self._open.values():
            try:
                fh.close()
            except Exception:
                pass
        self._open.clear()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ymap-entities-dir", type=Path, default=Path("output/ymap/entities"))
    ap.add_argument("--outdir", type=Path, default=Path("output/entities_streaming"))
    ap.add_argument("--chunk-size", type=float, default=512.0)
    ap.add_argument("--max-ymaps", type=int, default=0, help="0 = all")
    ap.add_argument("--filter", type=str, default="", help="only process ymap entity json whose filename contains this substring (case-insensitive)")
    ap.add_argument("--max-open-files", type=int, default=64)
    ap.add_argument("--max-entities-per-chunk", type=int, default=0, help="0 = unlimited (debug safety)")
    args = ap.parse_args()

    ent_dir: Path = args.ymap_entities_dir
    if not ent_dir.exists():
        raise SystemExit(f"Missing: {ent_dir} (run extract_ymaps.py first)")

    outdir: Path = args.outdir
    outdir.mkdir(parents=True, exist_ok=True)
    chunks_dir = outdir / "entities_chunks"
    index_path = outdir / "entities_index.json"

    chunk_size = float(args.chunk_size)
    if not math.isfinite(chunk_size) or chunk_size <= 0:
        raise SystemExit("--chunk-size must be > 0")

    files = sorted([p for p in ent_dir.glob("*.json") if p.is_file()])
    if args.filter:
        f = args.filter.lower()
        files = [p for p in files if f in p.name.lower()]
    if args.max_ymaps and args.max_ymaps > 0:
        files = files[: int(args.max_ymaps)]

    # Reset output chunk files (keep directory, remove old jsonl)
    if chunks_dir.exists():
        for p in chunks_dir.glob("*.jsonl"):
            try:
                p.unlink()
            except Exception:
                pass
    chunks_dir.mkdir(parents=True, exist_ok=True)

    pool = _ChunkWriterPool(chunks_dir, max_open=args.max_open_files)

    bounds = {
        "min_x": float("inf"),
        "min_y": float("inf"),
        "min_z": float("inf"),
        "max_x": float("-inf"),
        "max_y": float("-inf"),
        "max_z": float("-inf"),
    }

    chunk_counts: Dict[str, int] = defaultdict(int)
    total_entities = 0
    started = time.time()

    try:
        for i, p in enumerate(files, start=1):
            j = _load_json(p)
            ents = j.get("entities") or []
            if not isinstance(ents, list) or not ents:
                continue

            for e in ents:
                ah = _as_u32(e.get("archetypeHash"))
                if ah is None:
                    continue
                pos = _as_f3(e.get("position"))
                if pos is None:
                    continue
                rot = e.get("rotation")
                if not isinstance(rot, (list, tuple)) or len(rot) < 4:
                    rot = [1.0, 0.0, 0.0, 0.0]  # wxyz
                sc = e.get("scale")
                if not isinstance(sc, (list, tuple)) or len(sc) < 3:
                    sc = [1.0, 1.0, 1.0]

                x, y, z = pos
                k = _chunk_key(x, y, chunk_size)

                if args.max_entities_per_chunk and args.max_entities_per_chunk > 0:
                    if chunk_counts[k] >= int(args.max_entities_per_chunk):
                        continue

                rec = {
                    "archetype": int(ah),
                    "position": [x, y, z],
                    "rotation": [float(rot[0]), float(rot[1]), float(rot[2]), float(rot[3])],
                    "scale": [float(sc[0]), float(sc[1]), float(sc[2])],
                }
                pool.write_line(k, json.dumps(rec, separators=(",", ":")))

                chunk_counts[k] += 1
                total_entities += 1

                bounds["min_x"] = min(bounds["min_x"], x)
                bounds["min_y"] = min(bounds["min_y"], y)
                bounds["min_z"] = min(bounds["min_z"], z)
                bounds["max_x"] = max(bounds["max_x"], x)
                bounds["max_y"] = max(bounds["max_y"], y)
                bounds["max_z"] = max(bounds["max_z"], z)

            if i % 250 == 0:
                dt = max(1e-6, time.time() - started)
                print(f"[{i}/{len(files)}] ymaps processed, entities={total_entities} ({total_entities/dt:.0f}/s), chunks={len(chunk_counts)}")

    finally:
        pool.close_all()

    # Normalize bounds if no entities
    if not math.isfinite(bounds["min_x"]):
        bounds = {"min_x": 0.0, "min_y": 0.0, "min_z": 0.0, "max_x": 0.0, "max_y": 0.0, "max_z": 0.0}

    # Build index
    chunks_meta = {}
    for k, n in chunk_counts.items():
        chunks_meta[k] = {"file": f"{k}.jsonl", "count": int(n)}

    index = {
        "version": 1,
        "chunk_size": float(chunk_size),
        "chunks_dir": "entities_chunks",
        "bounds": bounds,
        "counts": {
            "ymaps_processed": int(len(files)),
            "chunks": int(len(chunk_counts)),
            "entities": int(total_entities),
        },
        "chunks": chunks_meta,
    }
    index_path.write_text(json.dumps(index, indent=2), encoding="utf-8")

    print("Wrote:")
    print(f"  {index_path}")
    print(f"  {chunks_dir}  ({len(chunk_counts)} chunks)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



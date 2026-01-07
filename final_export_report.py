#!/usr/bin/env python3
"""
Generate a lightweight "are we ready for final export?" report.

Checks:
- Mesh bins: how many are MSH0 v4 + have tangents.
- Model manifest shards: how many submeshes have diffuse/normal/spec fields.
- Referenced texture files exist on disk.

Usage:
  python webgl/final_export_report.py --assets-dir webgl/webgl_viewer/assets
"""

import argparse
import json
import struct
from pathlib import Path

from gta5_modules.script_paths import auto_assets_dir

FLAG_HAS_TANGENTS = 4


def _read_u32le(b: bytes, off: int) -> int:
    return struct.unpack_from("<I", b, off)[0]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--assets-dir", default="", help="webgl_viewer/assets folder (auto if omitted)")
    ap.add_argument("--max-shards", type=int, default=0, help="Limit number of shard files scanned (0 = all)")
    ap.add_argument("--max-missing", type=int, default=50, help="Max missing texture paths to print")
    args = ap.parse_args()

    assets_dir = auto_assets_dir(args.assets_dir)

    models_dir = assets_dir / "models"
    shard_dir = models_dir / "manifest_shards"

    # 1) Bin scan (cheap header reads)
    bins = list(models_dir.glob("*.bin"))
    v4 = 0
    v4_tan = 0
    bad = 0
    for p in bins:
        try:
            head = p.read_bytes()[:20]
            if len(head) < 20:
                bad += 1
                continue
            if head[0:4] != b"MSH0":
                bad += 1
                continue
            version = _read_u32le(head, 4)
            flags = _read_u32le(head, 16)
            if version >= 4:
                v4 += 1
                if (flags & FLAG_HAS_TANGENTS) == FLAG_HAS_TANGENTS:
                    v4_tan += 1
        except Exception:
            bad += 1

    # 2) Manifest/material scan
    sub_total = 0
    sub_diff = 0
    sub_norm = 0
    sub_spec = 0
    missing = []

    if shard_dir.exists():
        shard_files = sorted(shard_dir.glob("*.json"))
        if args.max_shards and int(args.max_shards) > 0:
            shard_files = shard_files[: int(args.max_shards)]
        for sf in shard_files:
            try:
                payload = json.loads(sf.read_text(encoding="utf-8", errors="ignore"))
                meshes = (payload.get("meshes") or {}) if isinstance(payload, dict) else {}
                if not isinstance(meshes, dict):
                    continue
                for _h, entry in meshes.items():
                    if not isinstance(entry, dict):
                        continue
                    lods = entry.get("lods") or {}
                    if not isinstance(lods, dict):
                        continue
                    for lod_meta in lods.values():
                        if not isinstance(lod_meta, dict):
                            continue
                        subs = lod_meta.get("submeshes")
                        if not isinstance(subs, list):
                            continue
                        for sm in subs:
                            if not isinstance(sm, dict):
                                continue
                            sub_total += 1
                            mat = sm.get("material") if isinstance(sm.get("material"), dict) else {}
                            d = mat.get("diffuse") if isinstance(mat, dict) else None
                            n = mat.get("normal") if isinstance(mat, dict) else None
                            s = mat.get("spec") if isinstance(mat, dict) else None
                            if d:
                                sub_diff += 1
                                if not (assets_dir / str(d)).exists() and len(missing) < int(args.max_missing):
                                    missing.append(str(d))
                            if n:
                                sub_norm += 1
                                if not (assets_dir / str(n)).exists() and len(missing) < int(args.max_missing):
                                    missing.append(str(n))
                            if s:
                                sub_spec += 1
                                if not (assets_dir / str(s)).exists() and len(missing) < int(args.max_missing):
                                    missing.append(str(s))
            except Exception:
                continue

    print("=== Final export readiness ===")
    print(f"Mesh bins: {len(bins)} (bad={bad})")
    print(f"  v4: {v4} ({(v4/len(bins)*100.0) if bins else 0.0:.1f}%)")
    print(f"  v4+Tangents flag: {v4_tan} ({(v4_tan/len(bins)*100.0) if bins else 0.0:.1f}%)")
    print(f"Submeshes scanned (shards): {sub_total}")
    if sub_total:
        print(f"  with diffuse: {sub_diff} ({sub_diff/sub_total*100.0:.1f}%)")
        print(f"  with normal:  {sub_norm} ({sub_norm/sub_total*100.0:.1f}%)")
        print(f"  with spec:    {sub_spec} ({sub_spec/sub_total*100.0:.1f}%)")
    if missing:
        print(f"Missing referenced textures (showing up to {int(args.max_missing)}):")
        for m in missing:
            print(f"  - {m}")


if __name__ == "__main__":
    main()



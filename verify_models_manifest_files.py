#!/usr/bin/env python3
"""
Verify that assets/models/manifest.json is consistent with on-disk *.bin files.

This catches a common "looks exported but still dots" issue:
- manifest entry exists, but referenced bin file is missing/corrupt (partial export / stale manifest)

Usage:
  python webgl/verify_models_manifest_files.py --assets-dir webgl/webgl_viewer/assets
"""

import argparse
import json
import struct
from pathlib import Path
from typing import Set, List

from gta5_modules.script_paths import auto_assets_dir

def _read_u32le(b: bytes, off: int) -> int:
    return struct.unpack_from("<I", b, off)[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--assets-dir", default="", help="webgl_viewer/assets folder (auto if omitted)")
    ap.add_argument("--max-errors", type=int, default=50, help="Max errors to print (0 = unlimited)")
    ap.add_argument(
        "--write-missing-json",
        default="",
        help="If set, write a JSON payload containing missing mesh hashes (for export_drawables_from_list.py).",
    )
    args = ap.parse_args()

    assets_dir = auto_assets_dir(args.assets_dir)

    manifest_path = assets_dir / "models" / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit(f"Missing {manifest_path}")

    mm = json.loads(manifest_path.read_text(encoding="utf-8", errors="ignore"))
    meshes = (mm.get("meshes") or {}) if isinstance(mm, dict) else {}
    if not isinstance(meshes, dict) or not meshes:
        raise SystemExit("Manifest has no meshes.")

    errors = 0
    checked = 0
    max_errors = int(args.max_errors or 0)
    missing_hashes: Set[str] = set()

    for h, entry in meshes.items():
        if not isinstance(entry, dict):
            errors += 1
            if max_errors == 0 or errors <= max_errors:
                print(f"{h}: bad entry type")
            missing_hashes.add(str(h))
            continue
        lods = entry.get("lods") or {}
        if not isinstance(lods, dict) or not lods:
            errors += 1
            if max_errors == 0 or errors <= max_errors:
                print(f"{h}: missing/empty lods")
            missing_hashes.add(str(h))
            continue

        for lod, meta in lods.items():
            if not isinstance(meta, dict):
                errors += 1
                if max_errors == 0 or errors <= max_errors:
                    print(f"{h}:{lod}: bad meta type")
                missing_hashes.add(str(h))
                continue
            rel = meta.get("file")
            if not rel:
                errors += 1
                if max_errors == 0 or errors <= max_errors:
                    print(f"{h}:{lod}: missing file field")
                missing_hashes.add(str(h))
                continue
            p = assets_dir / "models" / str(rel)
            checked += 1
            if not p.exists():
                errors += 1
                if max_errors == 0 or errors <= max_errors:
                    print(f"{h}:{lod}: missing file {p}")
                missing_hashes.add(str(h))
                continue
            try:
                head = p.read_bytes()[:20]
            except Exception:
                errors += 1
                if max_errors == 0 or errors <= max_errors:
                    print(f"{h}:{lod}: failed to read {p}")
                missing_hashes.add(str(h))
                continue
            if len(head) < 20:
                errors += 1
                if max_errors == 0 or errors <= max_errors:
                    print(f"{h}:{lod}: truncated file {p}")
                missing_hashes.add(str(h))
                continue
            magic = head[0:4].decode("ascii", errors="ignore")
            if magic != "MSH0":
                errors += 1
                if max_errors == 0 or errors <= max_errors:
                    print(f"{h}:{lod}: bad magic {magic!r} in {p}")
                missing_hashes.add(str(h))
                continue
            version = _read_u32le(head, 4)
            vcount = _read_u32le(head, 8)
            icount = _read_u32le(head, 12)
            if version not in (1, 2, 3, 4) or vcount == 0 or icount == 0:
                errors += 1
                if max_errors == 0 or errors <= max_errors:
                    print(f"{h}:{lod}: suspicious header version={version} v={vcount} i={icount} in {p}")
                missing_hashes.add(str(h))

    print(f"Checked files: {checked}")
    print(f"Errors: {errors}")

    # Optional: emit missing hashes for automated repair runs.
    out_path = str(args.write_missing_json or "").strip()
    if out_path:
        # export_drawables_from_list.py accepts:
        # - {"hashes":[...]} (simple)
        # - or viewer-style {"missingTop":[{hash,count},...]}
        hashes_out: List[int] = []
        for s in sorted(missing_hashes):
            try:
                if str(s).lstrip("-").isdigit():
                    hashes_out.append(int(str(s), 10) & 0xFFFFFFFF)
            except Exception:
                continue
        payload = {"hashes": hashes_out}
        Path(out_path).write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(f"Wrote missing hashes JSON: {out_path} (n={len(hashes_out)})")


if __name__ == "__main__":
    main()



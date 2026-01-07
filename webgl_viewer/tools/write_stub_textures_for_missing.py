"""
Write stub PNGs for textures that remain missing after extraction.

This is a pragmatic "get to zero missing files" step when the referenced texture names/hashes
cannot be found in any YTD in the current GTA install (or you don't have the DLC installed).

It reads a `debug_textures_near_coords.py` dump, finds non-ok textures, and writes:
  - <hash>.png
  - <hash>_<slug>.png (if slug exists in the dump)

The image is a small 4x4 checkerboard (magenta/black) so it's visually obvious it's a stub.

Usage:
  python3 webgl-gta/webgl_viewer/tools/write_stub_textures_for_missing.py \\
    --dump webgl-gta/webgl_viewer/tools/out/tex_dump_at_point_after_global_scan2.json \\
    --out-dir webgl-gta/webgl_viewer/assets/models_textures \\
    --regen-index
"""

from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path
from typing import Dict

from PIL import Image


_MODEL_TEX_RE = re.compile(r"^models_textures/(?P<hash>\d+)(?:_(?P<slug>[^/]+))?\.png$", re.IGNORECASE)


def _regen_models_textures_index(models_textures_dir: Path) -> None:
    re_hash_only = re.compile(r"^(?P<hash>\d+)\.png$", re.IGNORECASE)
    re_hash_slug = re.compile(r"^(?P<hash>\d+)_(?P<slug>[^/]+)\.png$", re.IGNORECASE)
    by_hash: Dict[str, dict] = {}

    for p in sorted(models_textures_dir.glob("*.png")):
        name = p.name
        m1 = re_hash_only.match(name)
        m2 = re_hash_slug.match(name) if not m1 else None
        if not (m1 or m2):
            continue
        h = (m1 or m2).group("hash")
        ent = by_hash.get(h)
        if ent is None:
            ent = {"hash": str(h), "hashOnly": False, "preferredFile": None, "files": []}
            by_hash[h] = ent
        ent["files"].append(name)
        if m1:
            ent["hashOnly"] = True

    for h, ent in by_hash.items():
        files = list(ent.get("files") or [])
        files.sort()
        ho = f"{h}.png"
        ent["preferredFile"] = ho if ho in files else (files[0] if files else None)

    out = {
        "schema": "webglgta-models-textures-index-v1",
        "generatedAtUnix": int(time.time()),
        "byHash": by_hash,
    }
    out_path = models_textures_dir / "index.json"
    tmp_path = models_textures_dir / "index.json.tmp"
    tmp_path.write_text(json.dumps(out, indent=2, sort_keys=True), encoding="utf-8")
    tmp_path.replace(out_path)


def _make_stub_png(size: int = 4) -> Image.Image:
    img = Image.new("RGBA", (size, size))
    mag = (255, 0, 255, 255)
    blk = (0, 0, 0, 255)
    px = img.load()
    for y in range(size):
        for x in range(size):
            px[x, y] = mag if ((x ^ y) & 1) else blk
    return img


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", required=True)
    ap.add_argument("--out-dir", default="", help="defaults to webgl_viewer/assets/models_textures next to this script")
    ap.add_argument("--regen-index", action="store_true", default=False)
    ap.add_argument("--overwrite", action="store_true", default=False)
    args = ap.parse_args()

    dump = json.loads(Path(args.dump).read_text(encoding="utf-8", errors="ignore"))
    rows = dump.get("textures")
    if not isinstance(rows, list):
        raise SystemExit("dump has no textures[]")

    viewer_root = Path(__file__).resolve().parents[1]
    out_dir = Path(args.out_dir) if args.out_dir else (viewer_root / "assets" / "models_textures")
    out_dir.mkdir(parents=True, exist_ok=True)

    stub = _make_stub_png(4)

    wrote = 0
    skipped = 0
    for r in rows:
        if not isinstance(r, dict):
            continue
        if str(r.get("reason") or "") == "ok":
            continue
        rel = str(r.get("requestedRel") or "").strip()
        m = _MODEL_TEX_RE.match(rel)
        if not m:
            continue
        h = str(int(m.group("hash")) & 0xFFFFFFFF)
        slug = str(m.group("slug") or "").strip()

        p0 = out_dir / f"{h}.png"
        if not p0.exists() or args.overwrite:
            stub.save(p0)
            wrote += 1
        else:
            skipped += 1
        if slug:
            p1 = out_dir / f"{h}_{slug}.png"
            if not p1.exists() or args.overwrite:
                stub.save(p1)
                wrote += 1
            else:
                skipped += 1

    if args.regen_index:
        _regen_models_textures_index(out_dir)

    print(f"stub textures: wrote={wrote} skipped={skipped} out={out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



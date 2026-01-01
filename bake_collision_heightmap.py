"""
Bake a higher-resolution heightfield from CodeWalker collision raycasts.

This produces a "game-ground-ish" heightmap by raycasting downward against CodeWalker.World.Space:
- YBN collision bounds (primary)
- Optionally ignores HD entity bounds (bridges/props) so you get "ground" not "top of prop"

Output:
  webgl/output/heightmap_collision.png

Then run:
  python webgl/webgl_viewer/setup_assets.py
to copy it into webgl/webgl_viewer/assets/heightmap.png (preferred if present).
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Optional, Tuple

import numpy as np

from webgl.gta5_modules.dll_manager import DllManager


def _load_bounds_from_terrain_info(output_dir: Path) -> Optional[Tuple[float, float, float, float, float, float]]:
    info_path = output_dir / "terrain_info.json"
    if not info_path.exists():
        return None
    try:
        info = json.loads(info_path.read_text(encoding="utf-8", errors="ignore"))
        gb = info.get("global_bounds") or {}
        return (
            float(gb["min_x"]),
            float(gb["min_y"]),
            float(gb["min_z"]),
            float(gb["max_x"]),
            float(gb["max_y"]),
            float(gb["max_z"]),
        )
    except Exception:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-path", required=True, help="Path to GTA5 installation (same as other tools)")
    ap.add_argument("--output-dir", default=str(Path(__file__).resolve().parent / "output"), help="webgl/output dir")
    ap.add_argument("--width", type=int, default=512, help="Base bake width (before optional upscale)")
    ap.add_argument("--height", type=int, default=512, help="Base bake height (before optional upscale)")
    ap.add_argument("--z-above", type=float, default=2500.0, help="Ray start height above max_z")
    ap.add_argument("--max-dist", type=float, default=15000.0, help="Ray max distance")
    ap.add_argument("--ybn-only", action="store_true", help="Ignore entity-only hits (recommended)")
    ap.add_argument("--upscale", type=int, default=2048, help="If >0, upscale output to this max dimension for nicer viewer rendering")
    args = ap.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    bounds = _load_bounds_from_terrain_info(output_dir)
    if not bounds:
        raise SystemExit(f"Could not read bounds from {output_dir / 'terrain_info.json'}. Run terrain extraction first.")
    min_x, min_y, min_z, max_x, max_y, max_z = bounds

    w = max(8, int(args.width))
    h = max(8, int(args.height))

    dll = DllManager(args.game_path)
    if not dll.initialized:
        raise SystemExit("DllManager failed to initialize.")

    # This is the expensive part.
    ok = dll.init_world_space()
    if not ok:
        raise SystemExit("Failed to init CodeWalker World Space (collision).")

    z0 = float(max_z + args.z_above)
    max_dist = float(args.max_dist)

    out = np.full((h, w), np.nan, dtype=np.float32)
    hits = 0
    total = h * w

    for iy in range(h):
        y = min_y + (max_y - min_y) * (iy / float(h - 1))
        for ix in range(w):
            x = min_x + (max_x - min_x) * (ix / float(w - 1))
            res = dll.raycast_down(x, y, z_start=z0, max_dist=max_dist, ybn_only=bool(args.ybn_only))
            if res and res.get("hit"):
                out[iy, ix] = float(res["z"])
                hits += 1

        if (iy + 1) % max(1, h // 20) == 0:
            done = (iy + 1) * w
            pct = 100.0 * done / float(total)
            print(f"[collision_heightmap] {iy+1}/{h} rows, hits={hits}/{done} ({pct:.1f}%)")

    # Fill holes by simple nearest-neighbor along scanlines (cheap). If still NaN, clamp to min_z.
    # (Most misses happen over water/outside collision coverage.)
    for iy in range(h):
        row = out[iy]
        if np.all(np.isnan(row)):
            continue
        # forward fill
        last = math.nan
        for ix in range(w):
            if not math.isnan(row[ix]):
                last = float(row[ix])
            elif not math.isnan(last):
                row[ix] = last
        # backward fill
        last = math.nan
        for ix in range(w - 1, -1, -1):
            if not math.isnan(row[ix]):
                last = float(row[ix])
            elif not math.isnan(last):
                row[ix] = last

    out = np.nan_to_num(out, nan=float(min_z), posinf=float(max_z), neginf=float(min_z))

    # Normalize to 0..255 based on global bounds.
    denom = max(1e-6, float(max_z - min_z))
    hm01 = (out - float(min_z)) / denom
    hm01 = np.clip(hm01, 0.0, 1.0)
    img = np.round(hm01 * 255.0).astype(np.uint8)

    # Optional upscale for viewer quality.
    target = int(args.upscale)
    out_path = output_dir / "heightmap_collision.png"
    try:
        import cv2  # type: ignore

        if target and target > 0:
            # Fit within target x target while preserving aspect.
            s = min(target / float(w), target / float(h))
            nw = max(1, int(round(w * s)))
            nh = max(1, int(round(h * s)))
            if nw != w or nh != h:
                img = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_CUBIC)

        cv2.imwrite(str(out_path), img)
    except Exception as e:
        raise SystemExit(f"Failed to write PNG (need opencv-python): {e}")

    print(f"Wrote collision heightmap: {out_path} (base={w}x{h}, hits={hits}/{total})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



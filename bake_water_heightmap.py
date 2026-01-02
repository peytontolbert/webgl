#!/usr/bin/env python3
"""
Bake a water surface heightmap from CodeWalker waterheight.dat (WatermapFile).

Outputs (in webgl/output by default):
  - water_heightmap.png   (grayscale height encoded against terrain_info.json global bounds)
  - water_mask.png        (255 where water exists, 0 otherwise)

This is useful for GTA5-parity analysis because CodeWalker's `World.Space.RayIntersect`
does not include water surfaces; water is a separate system in GTA.
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
    ap.add_argument("--width", type=int, default=512, help="Bake width")
    ap.add_argument("--height", type=int, default=512, help="Bake height")
    ap.add_argument("--upscale", type=int, default=2048, help="If >0, upscale output to this max dimension")
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
    if not dll.init_watermap():
        raise SystemExit("Failed to init watermap (waterheight.dat).")

    out = np.full((h, w), np.nan, dtype=np.float32)
    mask = np.zeros((h, w), dtype=np.uint8)

    hits = 0
    total = h * w
    for iy in range(h):
        y = min_y + (max_y - min_y) * (iy / float(h - 1))
        for ix in range(w):
            x = min_x + (max_x - min_x) * (ix / float(w - 1))
            wz = dll.get_water_height_at(x, y)
            if wz is None or not math.isfinite(wz):
                continue
            out[iy, ix] = float(wz)
            mask[iy, ix] = 255
            hits += 1

        if (iy + 1) % max(1, h // 20) == 0:
            done = (iy + 1) * w
            pct = 100.0 * done / float(total)
            print(f"[water_heightmap] {iy+1}/{h} rows, hits={hits}/{done} ({pct:.1f}%)")

    # Fill NaNs with min_z so normalization is stable (water mask preserves actual coverage).
    out = np.nan_to_num(out, nan=float(min_z), posinf=float(max_z), neginf=float(min_z))

    # Normalize to 0..255 using terrain global bounds (same convention as other heightmaps).
    denom = max(1e-6, float(max_z - min_z))
    hm01 = (out - float(min_z)) / denom
    hm01 = np.clip(hm01, 0.0, 1.0)
    img = np.round(hm01 * 255.0).astype(np.uint8)

    out_path = output_dir / "water_heightmap.png"
    mask_path = output_dir / "water_mask.png"

    try:
        import cv2  # type: ignore

        target = int(args.upscale)
        if target and target > 0:
            s = min(target / float(w), target / float(h))
            nw = max(1, int(round(w * s)))
            nh = max(1, int(round(h * s)))
            if nw != w or nh != h:
                img = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_CUBIC)
                mask = cv2.resize(mask, (nw, nh), interpolation=cv2.INTER_NEAREST)

        cv2.imwrite(str(out_path), img)
        cv2.imwrite(str(mask_path), mask)
    except Exception as e:
        raise SystemExit(f"Failed to write PNGs (need opencv-python): {e}")

    print(f"Wrote water heightmap: {out_path} (base={w}x{h}, hits={hits}/{total})")
    print(f"Wrote water mask:     {mask_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



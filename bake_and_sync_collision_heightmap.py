#!/usr/bin/env python3
"""
One-command GTA-like ground for the WebGL viewer.

This runs:
  1) CodeWalker collision raycast bake -> webgl/output/heightmap_collision.png
  2) webgl/webgl_viewer/setup_assets.py (which prefers heightmap_collision.png when present)
  3) (optional) webgl/webgl_viewer/sync_assets_to_dist.py if dist/ exists

Why:
  - The viewer's normal `heightmap.png` is terrain-only.
  - CodeWalker's `World.Space.RayIntersect` hits YBN collision (and optionally entity bounds),
    so a baked heightmap looks much closer to GTA5 "ground".
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def _run(cmd: list[str], cwd: Path) -> None:
    print(f"\n> {' '.join(cmd)}\n(cwd={cwd})")
    subprocess.run(cmd, cwd=str(cwd), check=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-path", required=True, help="Path to GTA5 installation (same as other tools)")
    ap.add_argument("--output-dir", default=None, help="webgl/output dir (default: <repo>/webgl/output)")
    ap.add_argument("--width", type=int, default=512, help="Base bake width (before optional upscale)")
    ap.add_argument("--height", type=int, default=512, help="Base bake height (before optional upscale)")
    ap.add_argument("--z-above", type=float, default=2500.0, help="Ray start height above max_z")
    ap.add_argument("--max-dist", type=float, default=15000.0, help="Ray max distance")
    ap.add_argument("--ybn-only", action="store_true", help="Ignore entity-only hits (recommended for 'ground')")
    ap.add_argument("--upscale", type=int, default=2048, help="If >0, upscale output to this max dimension")
    ap.add_argument("--sync-dist", action="store_true", help="Also sync assets -> dist/assets (requires dist/ exists)")
    args = ap.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    webgl_dir = repo_root / "webgl"
    viewer_dir = webgl_dir / "webgl_viewer"

    output_dir = Path(args.output_dir).resolve() if args.output_dir else (webgl_dir / "output")

    bake = webgl_dir / "bake_collision_heightmap.py"
    setup_assets = viewer_dir / "setup_assets.py"
    sync_dist = viewer_dir / "sync_assets_to_dist.py"

    if not bake.exists():
        raise SystemExit(f"Missing {bake}")
    if not setup_assets.exists():
        raise SystemExit(f"Missing {setup_assets}")

    py = sys.executable
    _run(
        [
            py,
            str(bake),
            "--game-path",
            str(args.game_path),
            "--output-dir",
            str(output_dir),
            "--width",
            str(int(args.width)),
            "--height",
            str(int(args.height)),
            "--z-above",
            str(float(args.z_above)),
            "--max-dist",
            str(float(args.max_dist)),
            "--upscale",
            str(int(args.upscale)),
        ]
        + (["--ybn-only"] if args.ybn_only else []),
        cwd=repo_root,
    )

    # Copies output/heightmap_collision.png -> viewer/assets/heightmap.png (preferred) and writes assets/manifest.json.
    _run([py, str(setup_assets)], cwd=repo_root)

    if args.sync_dist:
        dist_dir = viewer_dir / "dist"
        if dist_dir.exists() and sync_dist.exists():
            _run([py, str(sync_dist)], cwd=repo_root)
        else:
            print(f"Skipping dist sync (missing {dist_dir} or {sync_dist}).")

    print("\nDone.")
    print(f"- collision heightmap: {output_dir / 'heightmap_collision.png'}")
    print(f"- viewer assets:       {viewer_dir / 'assets' / 'heightmap.png'}")
    if args.sync_dist:
        print(f"- dist assets:         {viewer_dir / 'dist' / 'assets' / 'heightmap.png'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



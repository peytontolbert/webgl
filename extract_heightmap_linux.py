#!/usr/bin/env python3
"""
Linux-friendly heightmap extraction (no CodeWalker / pythonnet).

This script works when `heightmap.dat` exists as a real file on disk
(e.g. FiveM client data, or already-extracted GTA files). It does NOT
parse `.rpf` archives directly.

Outputs:
- output/heightmap.png (downsampled to 256x256 by default, compatible with the WebGL viewer)
- output/terrain_info.json (bounds + dimensions for the viewer)
"""

import argparse
import json
import os
from pathlib import Path
from typing import Iterable, Optional, Tuple

import dotenv
import numpy as np
from PIL import Image

from gta5_modules.heightmap import HeightmapFile


DEFAULT_RELATIVE_HEIGHTMAPS = [
    # FiveM (often unarchived)
    "citizen/common/data/levels/gta5/heightmap.dat",
    "citizen/dlc_patchday2ng/common/data/levels/gta5/heightmap.dat",
    # Already extracted layouts (common patterns)
    "data/levels/gta5/heightmap.dat",
    "common/data/levels/gta5/heightmap.dat",
    "common/data/levels/gta5/heightmapheistisland.dat",
]


def _iter_candidates(game_path: Path, extra_paths: Iterable[str]) -> Iterable[Path]:
    for rel in DEFAULT_RELATIVE_HEIGHTMAPS:
        yield game_path / Path(rel)
    for p in extra_paths:
        yield Path(p)


def _find_first_existing(game_path: Path, extra_paths: Iterable[str]) -> Optional[Path]:
    for p in _iter_candidates(game_path, extra_paths):
        if p.exists() and p.is_file():
            return p
    return None


def _try_extract_from_rpf(game_path: Path, output_dir: Path) -> Optional[Path]:
    """
    If heightmap.dat isn't available as a loose file, attempt to extract it from
    the GTA V RPF archives using the bundled CodeWalker CLI via dotnet.
    """
    rpf_candidates = [
        # (rpf_rel, internal_path, output_name)
        ("common.rpf", "data/levels/gta5/heightmap.dat", "heightmap.dat"),
        ("update/update.rpf", "common/data/levels/gta5/heightmap.dat", "heightmap_update.dat"),
        ("update/update.rpf", "common/data/levels/gta5/heightmapheistisland.dat", "heightmapheistisland.dat"),
    ]

    cli_project = Path(__file__).resolve().parent / "CodeWalker.Cli" / "CodeWalker.Cli.csproj"
    if not cli_project.exists():
        return None

    # Build the CLI once (Release) so subsequent runs are fast.
    build_cmd = ["dotnet", "build", str(cli_project), "-c", "Release", "-v", "minimal"]
    try:
        import subprocess

        subprocess.run(build_cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        return None

    cli_dll = Path(__file__).resolve().parent / "CodeWalker.Cli" / "bin" / "Release" / "net8.0" / "CodeWalker.Cli.dll"
    if not cli_dll.exists():
        return None

    output_dir.mkdir(parents=True, exist_ok=True)

    for rpf_rel, internal_path, out_name in rpf_candidates:
        rpf_path = game_path / Path(rpf_rel)
        if not rpf_path.exists():
            continue

        out_path = output_dir / out_name
        run_cmd = [
            "dotnet",
            str(cli_dll),
            "extract",
            "--game",
            str(game_path),
            "--rpf",
            str(rpf_path),
            "--file",
            internal_path,
            "--output",
            str(out_path),
        ]
        try:
            subprocess.run(run_cmd, check=True)
            if out_path.exists() and out_path.stat().st_size > 0:
                return out_path
        except Exception:
            continue

    return None


def _load_heightmap(path: Path) -> HeightmapFile:
    data = path.read_bytes()
    # No DllManager on Linux: pure-Python parsing path.
    return HeightmapFile(data, dll_manager=None)


def _downsample_uint8(img: np.ndarray, size: int) -> np.ndarray:
    if img.dtype != np.uint8:
        img = img.astype(np.uint8, copy=False)
    pil = Image.fromarray(img, mode="L")
    pil = pil.resize((size, size), resample=Image.BILINEAR)
    return np.asarray(pil, dtype=np.uint8)


def _write_outputs(
    *,
    output_dir: Path,
    source_key: str,
    heightmap_u8: np.ndarray,
    bounds: dict,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)

    # Viewer expects assets/heightmap.png
    Image.fromarray(heightmap_u8, mode="L").save(output_dir / "heightmap.png")

    terrain_info = {
        "num_heightmaps": 1,
        "num_textures": 0,
        "dimensions": {source_key: {"width": int(heightmap_u8.shape[1]), "height": int(heightmap_u8.shape[0])}},
        "bounds": {source_key: bounds},
        "texture_info": {},
    }
    (output_dir / "terrain_info.json").write_text(json.dumps(terrain_info, indent=2))


def main() -> int:
    # Prefer standard .env when available, but also support env.local for environments
    # that block dotfiles or when you want per-machine configs without git noise.
    dotenv.load_dotenv()
    dotenv.load_dotenv(dotenv_path=Path(__file__).resolve().parent / "env.local", override=False)

    parser = argparse.ArgumentParser(description="Extract heightmap assets on Linux (no CodeWalker).")
    parser.add_argument("--game-path", default=os.getenv("gta_location") or os.getenv("gta5_path"), help="Path to GTA/FiveM data root")
    parser.add_argument(
        "--heightmap",
        action="append",
        default=[],
        help="Explicit path to a heightmap.dat file (can be provided multiple times).",
    )
    parser.add_argument("--output-dir", default="output", help="Output directory (default: output)")
    parser.add_argument("--size", type=int, default=256, help="Downsample size for heightmap.png (default: 256)")
    args = parser.parse_args()

    if not args.game_path:
        print("ERROR: missing --game-path (or gta_location/gta5_path in environment).")
        return 2

    game_path = Path(args.game_path).expanduser()
    if not game_path.exists():
        print(f"ERROR: game path does not exist: {game_path}")
        return 2

    heightmap_path = _find_first_existing(game_path, args.heightmap)
    if not heightmap_path:
        # Try to extract from RPF archives (GTA V install layout).
        extracted = _try_extract_from_rpf(game_path, Path(args.output_dir) / "_extracted")
        if extracted:
            heightmap_path = extracted
        else:
            print("ERROR: could not find a heightmap.dat on disk, and RPF extraction failed.")
            print("Looked in common FiveM/extracted locations under:")
            print(f"  {game_path}")
            print("You can also pass explicit files via --heightmap /path/to/heightmap.dat")
            print("")
            print("Tried (via CodeWalker.Cli/dotnet) to extract from:")
            print(f"  {game_path / 'common.rpf'}")
            print(f"  {game_path / 'update' / 'update.rpf'}")
            return 1

    hm = _load_heightmap(heightmap_path)

    # Use max heights (0-255) and downsample to viewer-friendly size.
    max_u8 = hm.max_heights
    if max_u8 is None:
        print("ERROR: parsed heightmap but max_heights is missing.")
        return 1

    max_u8 = np.asarray(max_u8, dtype=np.uint8)
    if max_u8.ndim != 2:
        print(f"ERROR: unexpected heightmap shape: {max_u8.shape}")
        return 1

    resized = _downsample_uint8(max_u8, args.size)

    b = hm.bounds
    if not b:
        # fallback bounds if missing
        bounds = {"min_x": 0.0, "min_y": 0.0, "min_z": 0.0, "max_x": float(args.size), "max_y": float(args.size), "max_z": 255.0}
    else:
        bounds = {
            "min_x": float(b.min_x),
            "min_y": float(b.min_y),
            "min_z": float(b.min_z),
            "max_x": float(b.max_x),
            "max_y": float(b.max_y),
            "max_z": float(b.max_z),
        }

    output_dir = Path(args.output_dir)
    source_key = str(heightmap_path)
    _write_outputs(output_dir=output_dir, source_key=source_key, heightmap_u8=resized, bounds=bounds)

    print("Wrote:")
    print(f"  {output_dir / 'heightmap.png'}")
    print(f"  {output_dir / 'terrain_info.json'}")
    print("")
    print("Next step (optional): sync into viewer assets:")
    print("  python3 webgl_viewer_old/setup_assets.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



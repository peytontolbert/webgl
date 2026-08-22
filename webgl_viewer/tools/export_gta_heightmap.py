#!/usr/bin/env python3
"""Export GTA's main-map upper height surface for the WebGL terrain proxy.

This is not GTA render geometry or a gameplay floor. YBN remains authoritative
for gameplay and streamed drawables provide visible terrain and road surfaces.

Run from the repository root on Windows:
  python webgl_viewer/tools/export_gta_heightmap.py --gta-path "K:\\steam\\steamapps\\common\\Grand Theft Auto V"
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np


MAIN_HEIGHTMAP_PATH = r"update\update.rpf\common\data\levels\gta5\heightmap.dat"


def _write_png(path: Path, samples_u16: np.ndarray) -> None:
    try:
        from PIL import Image  # type: ignore
    except Exception as exc:
        raise SystemExit("Pillow is required to write the PNG fallback.") from exc

    image_u8 = np.round(samples_u16.astype(np.float32) * (255.0 / 65535.0)).astype(np.uint8)
    Image.fromarray(image_u8, mode="L").save(path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gta-path", required=True, help="Path to the GTA V install directory.")
    ap.add_argument(
        "--assets-dir",
        default=str(Path(__file__).resolve().parents[1] / "assets"),
        help="Viewer assets directory to update.",
    )
    ap.add_argument(
        "--heightmap-path",
        default=MAIN_HEIGHTMAP_PATH,
        help="CodeWalker virtual path to the main-map heightmap.",
    )
    args = ap.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

    from gta5_modules.dll_manager import DllManager
    from gta5_modules.heightmap import HeightmapFile
    from gta5_modules.rpf_reader import RpfReader

    assets_dir = Path(args.assets_dir).resolve()
    assets_dir.mkdir(parents=True, exist_ok=True)
    virtual_path = str(args.heightmap_path).replace("/", "\\")

    dll = DllManager(str(args.gta_path))
    if not getattr(dll, "initialized", False):
        raise SystemExit("DllManager failed to initialize.")

    raw = RpfReader(str(args.gta_path), dll).get_file_data(virtual_path)
    if not raw:
        raise SystemExit(f"Could not read {virtual_path} from the game install.")
    heightmap = HeightmapFile(raw, dll)
    if heightmap.bounds is None or heightmap.max_heights is None:
        raise SystemExit("CodeWalker did not return a usable MaxHeights raster.")
    if heightmap.valid_mask is None:
        raise SystemExit("CodeWalker did not return a terrain coverage mask.")

    bounds = heightmap.bounds
    z_range = max(1e-6, float(bounds.max_z - bounds.min_z))
    normalized = np.clip(heightmap.max_heights.astype(np.float32) / 255.0, 0.0, 1.0)
    samples_u16 = np.round(normalized * 65535.0).astype("<u2")

    bin_path = assets_dir / "heightmap_max_u16.bin"
    meta_path = assets_dir / "heightmap_max_u16.json"
    png_path = assets_dir / "heightmap.png"
    coverage_path = assets_dir / "heightmap_coverage_u8.bin"
    bin_path.write_bytes(samples_u16.tobytes(order="C"))
    meta_path.write_text(
        json.dumps(
            {
                "width": int(heightmap.width),
                "height": int(heightmap.height),
                "file": bin_path.name,
                "endian": "little",
                "surface": "max_heights",
                "row_order": "world_min_y_to_world_max_y",
                "role": "debug_height_bounds_envelope",
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    _write_png(png_path, samples_u16)
    coverage_path.write_bytes(heightmap.valid_mask.astype(np.uint8, copy=False).tobytes(order="C"))

    info_path = assets_dir / "terrain_info.json"
    try:
        info = json.loads(info_path.read_text(encoding="utf-8"))
    except Exception:
        info = {}
    info.setdefault("dimensions", {})[virtual_path] = {
        "width": int(heightmap.width),
        "height": int(heightmap.height),
    }
    info.setdefault("bounds", {})[virtual_path] = {
        "min_x": float(bounds.min_x),
        "min_y": float(bounds.min_y),
        "min_z": float(bounds.min_z),
        "max_x": float(bounds.max_x),
        "max_y": float(bounds.max_y),
        "max_z": float(bounds.max_z),
    }
    info["render_heightmap_key"] = virtual_path
    info["render_surface"] = "max_heights"
    info["render_row_order"] = "world_min_y_to_world_max_y"
    info["render_role"] = "debug_height_bounds_envelope"
    info["render_coverage_mask"] = {
        "file": coverage_path.name,
        "width": int(heightmap.width),
        "height": int(heightmap.height),
        "row_order": "world_min_y_to_world_max_y",
    }
    info["render_sample_spacing"] = {
        "x": float((bounds.max_x - bounds.min_x) / max(1, heightmap.width - 1)),
        "y": float((bounds.max_y - bounds.min_y) / max(1, heightmap.height - 1)),
        "z_range": z_range,
    }
    info_path.write_text(json.dumps(info, indent=2), encoding="utf-8")

    print(f"Wrote {bin_path} ({heightmap.width}x{heightmap.height}, MaxHeights)")
    print(f"Wrote {meta_path}")
    print(f"Wrote {png_path}")
    print(f"Wrote {coverage_path}")
    print(f"Updated {info_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

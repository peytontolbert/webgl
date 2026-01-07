#!/usr/bin/env python3
"""
Convert a 16-bit grayscale PNG heightmap into the WebGL viewer's preferred 16-bit assets:

- heightmap_u16.bin: raw uint16 samples, row-major, top-to-bottom
- heightmap_u16.json: { width, height, file, endian }

Why: browsers decode images to 8-bit channels for ImageBitmap/canvas, so using a raw uint16 file
is the simplest way to preserve true 16-bit height precision in the viewer.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

try:
    from PIL import Image  # type: ignore
except Exception as e:
    raise SystemExit("Pillow is required: pip install pillow") from e


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input_png", type=str, help="Path to a 16-bit grayscale PNG (mode I;16 preferred).")
    ap.add_argument("--out-dir", type=str, default=".", help="Output directory (default: current directory).")
    ap.add_argument("--prefix", type=str, default="heightmap_u16", help="Output basename (default: heightmap_u16).")
    ap.add_argument("--endian", type=str, default="little", choices=["little", "big"], help="Endianness for .bin (default: little).")
    args = ap.parse_args()

    in_path = Path(args.input_png)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    img = Image.open(in_path)
    # Force 16-bit grayscale. Pillow uses mode "I;16" for 16-bit.
    if img.mode not in ("I;16", "I;16B", "I"):
        img = img.convert("I;16")

    w, h = img.size
    # Get raw bytes in row-major, top-to-bottom order.
    raw = img.tobytes()

    # Pillow's I;16 is little-endian on most platforms; normalize to requested endianness.
    if args.endian == "big":
        # swap every 2-byte word
        b = bytearray(raw)
        for i in range(0, len(b), 2):
            b[i], b[i + 1] = b[i + 1], b[i]
        raw = bytes(b)

    bin_path = out_dir / f"{args.prefix}.bin"
    json_path = out_dir / f"{args.prefix}.json"

    bin_path.write_bytes(raw)
    json_path.write_text(
        json.dumps(
            {"width": int(w), "height": int(h), "file": bin_path.name, "endian": args.endian},
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"Wrote {bin_path} ({bin_path.stat().st_size} bytes)")
    print(f"Wrote {json_path}")


if __name__ == "__main__":
    main()



#!/usr/bin/env python3
"""
Convert a grayscale PNG heightmap into the WebGL viewer's preferred 16-bit assets:

- heightmap_u16.bin: raw uint16 samples, row-major, top-to-bottom
- heightmap_u16.json: { width, height, file, endian }

Why: browsers decode images to 8-bit channels for ImageBitmap/canvas, so using a raw uint16 file
is the simplest way to preserve true 16-bit height precision in the viewer. If the source PNG is
8-bit, samples are scaled from 0..255 to 0..65535 so the generated sidecar matches the existing
PNG fallback visually.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

try:
    from PIL import Image  # type: ignore
except Exception as e:
    raise SystemExit("Pillow is required: pip install pillow") from e


def _swap_u16_bytes(raw: bytes) -> bytes:
    b = bytearray(raw)
    for i in range(0, len(b), 2):
        b[i], b[i + 1] = b[i + 1], b[i]
    return bytes(b)


def _pack_u16(values, endian: str) -> bytes:
    order = "big" if endian == "big" else "little"
    out = bytearray()
    for value in values:
        v = max(0, min(65535, int(value)))
        out.extend(v.to_bytes(2, order, signed=False))
    return bytes(out)


def _image_to_u16_bytes(img: Image.Image, endian: str) -> bytes:
    if img.mode in ("I;16", "I;16L"):
        raw = img.tobytes()
        return _swap_u16_bytes(raw) if endian == "big" else raw

    if img.mode == "I;16B":
        raw = img.tobytes()
        return raw if endian == "big" else _swap_u16_bytes(raw)

    if img.mode == "I":
        return _pack_u16(img.getdata(), endian)

    gray = img.convert("L")
    return _pack_u16((v * 257 for v in gray.tobytes()), endian)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input_png", type=str, help="Path to a grayscale PNG (16-bit preferred; 8-bit is scaled).")
    ap.add_argument("--out-dir", type=str, default=".", help="Output directory (default: current directory).")
    ap.add_argument("--prefix", type=str, default="heightmap_u16", help="Output basename (default: heightmap_u16).")
    ap.add_argument("--endian", type=str, default="little", choices=["little", "big"], help="Endianness for .bin (default: little).")
    args = ap.parse_args()

    in_path = Path(args.input_png)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    img = Image.open(in_path)

    w, h = img.size
    raw = _image_to_u16_bytes(img, args.endian)

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



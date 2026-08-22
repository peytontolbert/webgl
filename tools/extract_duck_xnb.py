#!/usr/bin/env python3
"""Extract uncompressed XNA Texture2D XNB assets from the local Duck Game Content.

Duck Game's shipped art uses uncompressed XNB Texture2D resources. This reader
keeps the conversion in the workspace and writes standard PNGs for the browser.
"""
from __future__ import annotations

import argparse
import struct
from pathlib import Path

from PIL import Image


class Reader:
    def __init__(self, data: bytes): self.data, self.pos = data, 0
    def take(self, count: int) -> bytes:
        value = self.data[self.pos:self.pos + count]
        if len(value) != count: raise ValueError('truncated XNB')
        self.pos += count
        return value
    def u8(self) -> int: return self.take(1)[0]
    def u32(self) -> int: return struct.unpack('<I', self.take(4))[0]
    def seven(self) -> int:
        value = shift = 0
        while True:
            byte = self.u8(); value |= (byte & 0x7f) << shift
            if not byte & 0x80: return value
            shift += 7
            if shift > 35: raise ValueError('invalid 7-bit integer')
    def string(self) -> str: return self.take(self.seven()).decode('utf-8')


def texture(source: Path) -> tuple[int, int, bytes]:
    reader = Reader(source.read_bytes())
    if reader.take(3) != b'XNB': raise ValueError('not an XNB file')
    reader.u8(); version = reader.u8(); flags = reader.u8(); size = reader.u32()
    if flags & 0x80: raise ValueError(f'{source.name} is LZX-compressed')
    if version not in {4, 5}: raise ValueError(f'unsupported XNB version {version}')
    readers = reader.seven()
    type_names = []
    for _ in range(readers): type_names.append(reader.string()); reader.u32()
    for _ in range(reader.seven()): pass
    primary = reader.seven()
    if not primary or 'Texture2DReader' not in type_names[primary - 1]: raise ValueError('asset is not Texture2D')
    surface_format, width, height, mipmaps = reader.u32(), reader.u32(), reader.u32(), reader.u32()
    if surface_format != 0: raise ValueError(f'unsupported surface format {surface_format}')
    if not width or not height or mipmaps < 1: raise ValueError('invalid texture dimensions')
    pixels = reader.take(reader.u32())
    if len(pixels) != width * height * 4: raise ValueError(f'unexpected Color pixel size {len(pixels)} for {width}x{height}')
    return width, height, pixels


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    width, height, pixels = texture(args.source)
    args.destination.parent.mkdir(parents=True, exist_ok=True)
    Image.frombytes('RGBA', (width, height), pixels, 'raw', 'BGRA').save(args.destination)
    print(f'{args.source.name}: {width}x{height} -> {args.destination}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

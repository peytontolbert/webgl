#!/usr/bin/env python3
"""Remove non-playable multiplayer editor overlays from an NWG3 world mesh."""

from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path


OVERLAY_PREFIXES = ("spawn_point_",)
OVERLAY_NAMES = {"multiplayer_return_plate", "multiplayer_flag_return", "koth_shield_generator"}


def is_overlay(name: str) -> bool:
    normalized = name.lower()
    return normalized.startswith(OVERLAY_PREFIXES) or normalized in OVERLAY_NAMES


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mesh", type=Path)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()

    data = args.mesh.read_bytes()
    if data[:4] != b"NWG3":
        raise ValueError(f"{args.mesh} is not an NWG3 mesh")
    vertex_count, index_count, segment_count = struct.unpack_from("<III", data, 4)
    segment_offset = 16 + vertex_count * 32 + index_count * 4
    expected = segment_offset + segment_count * 12
    if len(data) != expected:
        raise ValueError(f"invalid NWG3 length: expected {expected}, found {len(data)}")

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    materials = manifest["materials"]
    keep: list[bytes] = []
    removed: list[str] = []
    for index in range(segment_count):
        offset = segment_offset + index * 12
        _, _, material_index = struct.unpack_from("<IIi", data, offset)
        name = (materials[material_index].get("name") or materials[material_index].get("Name") or "") if material_index >= 0 else ""
        if is_overlay(name):
            removed.append(name)
        else:
            keep.append(data[offset : offset + 12])

    header = b"NWG3" + struct.pack("<III", vertex_count, index_count, len(keep))
    temporary = args.mesh.with_suffix(args.mesh.suffix + ".tmp")
    temporary.write_bytes(header + data[16:segment_offset] + b"".join(keep))
    temporary.replace(args.mesh)
    print(json.dumps({"mesh": str(args.mesh), "keptSegments": len(keep), "removedSegments": len(removed), "removedMaterials": sorted(set(removed))}, indent=2))


if __name__ == "__main__":
    main()

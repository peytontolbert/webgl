#!/usr/bin/env python3
"""Focused regression checks for the YMAP takeover packer."""

from __future__ import annotations

from apply_fivem_ymap_override import _dedupe_records, _pack_entity


def main() -> int:
    bounds = {"minX": -10.0, "minY": -10.0, "maxX": 10.0, "maxY": 10.0}
    entity = {
        "archetypeHash": 123,
        "position": [1.0, 2.0, 3.0],
        "rotation": [0.0, 0.0, 0.0, 1.0],
        "scale": [1.0, 1.0, 1.0],
        "guid": 456,
        "lodLevel": "LODTYPES_DEPTH_ORPHANHD",
    }
    packed = _pack_entity(entity, bounds)
    assert packed is not None and len(packed) == 64
    unique, duplicate_count = _dedupe_records([packed, packed])
    assert unique == [packed]
    assert duplicate_count == 1
    assert _pack_entity({**entity, "isMloInstance": True}, bounds) is None
    assert _pack_entity({**entity, "position": [20.0, 2.0, 3.0]}, bounds) is None
    print("YMAP takeover regression checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

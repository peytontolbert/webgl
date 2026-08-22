#!/usr/bin/env python3
"""Verify the Legion weed-shop passage is open below its retained lintel."""

from __future__ import annotations

from pathlib import Path

from build_spawn_district_supermeshes import decode_mesh
from import_fivem_mlo_demo import (
    LEGION_WEEDSHOP_OPENING_ARCHETYPE,
    _remove_legion_weedshop_partition,
)


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    models = root / "assets/models/mlo" / str(LEGION_WEEDSHOP_OPENING_ARCHETYPE)
    for submesh_index in (1, 7):
        path = models / f"{LEGION_WEEDSHOP_OPENING_ARCHETYPE}_high_{submesh_index}_open_v1.bin"
        mesh = decode_mesh(path.read_bytes())
        _indices, removable = _remove_legion_weedshop_partition(
            LEGION_WEEDSHOP_OPENING_ARCHETYPE,
            "high",
            submesh_index,
            mesh["positions"],
            mesh["indices"],
        )
        assert removable == 0, f"closed partition remains in {path.name}: {removable} triangles"
    print("Legion weed-shop partition opening passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

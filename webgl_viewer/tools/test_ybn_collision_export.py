#!/usr/bin/env python3
"""Regression checks for GTA YBN primitive conversion."""

from __future__ import annotations

import math

from export_ybn_collision_tile import (
    ROUND_SIDES,
    _box_triangles,
    _capsule_triangles,
    _cylinder_triangles,
    _joaat,
    _sphere_triangles,
    _surface_profile_for_material_name,
    _parse_resource_ybn_offsets,
)


def vertices(triangles):
    return {point for triangle in triangles for point in triangle}


def main() -> int:
    assert _parse_resource_ybn_offsets(["int_weed,378.5,-822,30"]) == {
        "int_weed": (378.5, -822.0, 30.0)
    }
    encoded_box = [
        (-1.0, -2.0, -3.0),
        (-1.0, 2.0, 3.0),
        (1.0, -2.0, 3.0),
        (1.0, 2.0, -3.0),
    ]
    box = _box_triangles(encoded_box)
    box_vertices = vertices(box)
    assert len(box) == 12
    assert len(box_vertices) == 8
    assert {point[0] for point in box_vertices} == {-1.0, 1.0}
    assert {point[1] for point in box_vertices} == {-2.0, 2.0}
    assert {point[2] for point in box_vertices} == {-3.0, 3.0}

    cylinder = _cylinder_triangles((0.0, 0.0, 0.0), (0.0, 0.0, 2.0), 1.0)
    assert len(cylinder) == ROUND_SIDES * 4
    assert min(point[2] for point in vertices(cylinder)) == 0.0
    assert max(point[2] for point in vertices(cylinder)) == 2.0

    capsule = _capsule_triangles((0.0, 0.0, 0.0), (0.0, 0.0, 2.0), 1.0)
    assert len(capsule) == ROUND_SIDES * 8
    assert math.isclose(min(point[2] for point in vertices(capsule)), -1.0)
    assert math.isclose(max(point[2] for point in vertices(capsule)), 3.0)

    sphere = _sphere_triangles((2.0, 3.0, 4.0), 2.0)
    assert len(sphere) == ROUND_SIDES * 6
    assert math.isclose(min(point[2] for point in vertices(sphere)), 2.0)
    assert math.isclose(max(point[2] for point in vertices(sphere)), 6.0)

    # FiveM replacement lookup uses the same case-insensitive JOAAT filename hash.
    assert _joaat("id1_rd_7") == _joaat("ID1_RD_7")
    assert _joaat("id1_rd_7") != _joaat("id1_rd_12")
    assert _surface_profile_for_material_name("CONCRETE_POTHOLE")["surface"] == "concrete"
    assert _surface_profile_for_material_name("METAL_GRILLE")["surface"] == "metal"
    assert _surface_profile_for_material_name("SAND_DEEP")["grip"] < _surface_profile_for_material_name("TARMAC")["grip"]
    assert _surface_profile_for_material_name("SNOW_LOOSE")["surface"] == "ice"
    print("ybn_collision_export: primitives, materials, and replacement hashing passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

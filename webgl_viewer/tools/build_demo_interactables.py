#!/usr/bin/env python3
"""Build geometry-backed interactables for the browser demo district."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import struct
from collections import Counter
from pathlib import Path
from typing import Any


DOOR_PATTERN = re.compile(r"(?:door|gate|shutter|roller|barrier|hatch)", re.IGNORECASE)
NON_INTERACTIVE_DOOR_PATTERN = re.compile(
    r"(?:door[_\s-]*frame|door[_\s-]*det(?:al|ail)|barrier[_\s-]*rope)",
    re.IGNORECASE,
)
AUTOMATIC_LIFT_BARRIERS = {
    "3110450777": "Parking Barrier",
}
CATEGORY_PATTERNS = {
    "doors": DOOR_PATTERN,
    "elevators": re.compile(r"(?:elevator|lift)", re.IGNORECASE),
    "vending": re.compile(r"(?:vending|vender|atm|cashmachine)", re.IGNORECASE),
    "seating": re.compile(r"(?:chair|seat|bench|stool|sofa)", re.IGNORECASE),
    "storage": re.compile(r"(?:stash|locker|safe|cabinet|wardrobe)", re.IGNORECASE),
    "crafting": re.compile(r"(?:workbench|crafting)", re.IGNORECASE),
    "terminals": re.compile(r"(?:terminal|keypad|console|switchbox)", re.IGNORECASE),
    "registers": re.compile(r"(?:cashregister|cash_register|till)", re.IGNORECASE),
}


def read_ent1(path: Path) -> tuple[int, list[bytes]]:
    raw = path.read_bytes()
    if len(raw) < 8 or raw[:4] != b"ENT1":
        raise ValueError(f"{path} is not an ENT1 file")
    count = struct.unpack_from("<I", raw, 4)[0]
    if count <= 0 or (len(raw) - 8) % count:
        raise ValueError(f"{path} has an invalid ENT1 payload")
    stride = (len(raw) - 8) // count
    if stride not in (44, 48, 64):
        raise ValueError(f"unsupported ENT1 stride: {stride}")
    return stride, [raw[8 + index * stride:8 + (index + 1) * stride] for index in range(count)]


def mesh_bounds(mesh: dict[str, Any]) -> tuple[list[float], list[float]] | None:
    lods = mesh.get("lods") or {}
    lod = lods.get("high") or lods.get("med") or lods.get("low") or next(iter(lods.values()), {})
    bounds = [item.get("bounds") for item in lod.get("submeshes", []) if item.get("bounds")]
    if not bounds:
        return None
    minimum = [min(float(item["min"][axis]) for item in bounds) for axis in range(3)]
    maximum = [max(float(item["max"][axis]) for item in bounds) for axis in range(3)]
    return minimum, maximum


def rotate_quaternion(point: list[float], quaternion: list[float]) -> list[float]:
    qx, qy, qz, qw = quaternion
    px, py, pz = point
    ux = qy * pz - qz * py
    uy = qz * px - qx * pz
    uz = qx * py - qy * px
    uux = qy * uz - qz * uy
    uuy = qz * ux - qx * uz
    uuz = qx * uy - qy * ux
    return [
        px + 2.0 * (qw * ux + uux),
        py + 2.0 * (qw * uy + uuy),
        pz + 2.0 * (qw * uz + uuz),
    ]


def transform_point(record: bytes, stride: int, point: list[float]) -> list[float]:
    position = list(struct.unpack_from("<3f", record, 4))
    quaternion = list(struct.unpack_from("<4f", record, 16))
    scale = list(struct.unpack_from("<3f", record, 32))
    flags = struct.unpack_from("<I", record, 60)[0] if stride >= 64 else 0
    parent = struct.unpack_from("<I", record, 52)[0] if stride >= 64 else 0
    if not (flags & 1) and not parent:
        quaternion[0] *= -1.0
        quaternion[1] *= -1.0
        quaternion[2] *= -1.0
    scaled = [point[axis] * scale[axis] for axis in range(3)]
    rotated = rotate_quaternion(scaled, quaternion)
    return [position[axis] + rotated[axis] for axis in range(3)]


def source_name(mesh: dict[str, Any], hash_id: str) -> str:
    source = str(mesh.get("source") or "")
    match = re.search(r"([^/\\:]+)\.ydr", source, re.IGNORECASE)
    return match.group(1) if match else str(mesh.get("name") or hash_id)


def stable_id(hash_id: str, position: list[float]) -> str:
    key = f"{hash_id}:{position[0]:.4f}:{position[1]:.4f}:{position[2]:.4f}"
    return f"door_{hashlib.sha1(key.encode('ascii')).hexdigest()[:12]}"


def build(models_path: Path, entities_path: Path, existing_path: Path | None = None) -> dict[str, Any]:
    manifest = json.loads(models_path.read_text(encoding="utf-8"))
    meshes = manifest.get("meshes") or {}
    stride, records = read_ent1(entities_path)
    records_by_hash: dict[str, list[bytes]] = {}
    for record in records:
        records_by_hash.setdefault(str(struct.unpack_from("<I", record, 0)[0]), []).append(record)

    inventory: dict[str, list[dict[str, Any]]] = {category: [] for category in CATEGORY_PATTERNS}
    for hash_id, mesh in meshes.items():
        instances = records_by_hash.get(str(hash_id), [])
        if not instances:
            continue
        text = " ".join(str(mesh.get(key) or "") for key in ("source", "name", "assetName", "drawableName"))
        for category, pattern in CATEGORY_PATTERNS.items():
            if pattern.search(text):
                inventory[category].append({
                    "archetypeHash": str(hash_id),
                    "name": source_name(mesh, str(hash_id)),
                    "instances": len(instances),
                    "source": str(mesh.get("source") or ""),
                })

    doors = []
    per_hash_index: Counter[str] = Counter()
    for hash_id, mesh in meshes.items():
        identifying_text = " ".join(str(mesh.get(key) or "") for key in ("source", "name", "assetName", "drawableName"))
        if not DOOR_PATTERN.search(identifying_text) or NON_INTERACTIVE_DOOR_PATTERN.search(identifying_text):
            continue
        bounds = mesh_bounds(mesh)
        if not bounds:
            continue
        minimum, maximum = bounds
        center = [(minimum[axis] + maximum[axis]) * 0.5 for axis in range(3)]
        name = source_name(mesh, str(hash_id))
        is_sliding = bool(re.search(r"(?:elevator|lift|slid(?:e|ing)?)", name, re.IGNORECASE))
        for record in records_by_hash.get(str(hash_id), []):
            origin = list(struct.unpack_from("<3f", record, 4))
            coords = transform_point(record, stride, center)
            index = per_hash_index[str(hash_id)]
            per_hash_index[str(hash_id)] += 1
            doors.append({
                "id": stable_id(str(hash_id), origin),
                "type": "door",
                "action": "use_door",
                "label": name.replace("_", " ").strip().title(),
                "archetypeHash": str(hash_id),
                "coords": {"x": round(coords[0], 5), "y": round(coords[1], 5), "z": round(coords[2], 5)},
                "origin": {"x": round(origin[0], 5), "y": round(origin[1], 5), "z": round(origin[2], 5)},
                "radius": 2.35,
                "passageRadius": 0.9,
                "passageHalfHeight": 1.3,
                "motion": "slide" if is_sliding else "swing",
                "openAmount": 0.82 if is_sliding else math.radians(92.0),
                "openSign": 1 if index % 2 == 0 else -1,
                "automatic": False,
                "locked": False,
                "autoCloseMs": 1300,
                "source": str(mesh.get("source") or ""),
            })

    # This GTA fragment's human-readable name only exists in the YFT audit.
    # The model origin is its hinge; coords remains the arm center for proximity.
    for hash_id, label in AUTOMATIC_LIFT_BARRIERS.items():
        mesh = meshes.get(hash_id)
        bounds = mesh_bounds(mesh or {})
        if not mesh or not bounds:
            continue
        minimum, maximum = bounds
        center = [(minimum[axis] + maximum[axis]) * 0.5 for axis in range(3)]
        for record in records_by_hash.get(hash_id, []):
            origin = list(struct.unpack_from("<3f", record, 4))
            doors.append({
                "id": stable_id(hash_id, origin),
                "type": "door",
                "action": "use_door",
                "label": label,
                "archetypeHash": hash_id,
                "coords": {"x": round(origin[0], 5), "y": round(origin[1], 5), "z": round(origin[2], 5)},
                "origin": {"x": round(origin[0], 5), "y": round(origin[1], 5), "z": round(origin[2], 5)},
                "radius": 7.0,
                "passageRadius": 5.0,
                "passageHalfHeight": 2.5,
                "motion": "lift",
                "openAmount": math.radians(86.0),
                "openSign": 1,
                "automatic": True,
                "locked": False,
                "autoCloseMs": 1800,
                "source": "GTA YFT: prop_sec_barrier_ld_01a.yft",
            })

    # A named fragment may also be discovered by the ordinary geometry pass.
    # The explicit fragment profile carries the correct lift motion and must
    # replace that generic record instead of creating a duplicate interaction.
    doors = list({item["id"]: item for item in doors}.values())

    # Portal-only openings have no independently rendered archetype. Preserve
    # metadata-derived records from the previous manifest while geometry-backed
    # records are regenerated from the authoritative model/entity catalogs.
    # This keeps authored MLO portals data-driven without baking destination
    # coordinates into this builder.
    if existing_path and existing_path.exists():
        existing = json.loads(existing_path.read_text(encoding="utf-8"))
        generated_ids = {item["id"] for item in doors}
        for item in existing.get("doors") or []:
            if item.get("id") in generated_ids:
                continue
            if str(item.get("archetypeHash") or "") != "0":
                continue
            if "mlo portal" not in str(item.get("source") or "").lower():
                continue
            doors.append(item)

    doors.sort(key=lambda item: (item["archetypeHash"], item["origin"]["x"], item["origin"]["y"], item["origin"]["z"]))
    for values in inventory.values():
        values.sort(key=lambda item: (item["name"], item["archetypeHash"]))
    return {
        "schema": "webglgta-demo-interactables-v1",
        "sourceEntities": entities_path.name,
        "sourceModels": models_path.name,
        "doors": doors,
        "inventory": inventory,
        "summary": {
            "doors": len(doors),
            "doorArchetypes": len({item["archetypeHash"] for item in doors}),
            "candidateArchetypesByCategory": {key: len(value) for key, value in inventory.items()},
            "candidateInstancesByCategory": {
                key: sum(int(item["instances"]) for item in value) for key, value in inventory.items()
            },
        },
    }


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--descriptor", type=Path, default=root / "assets/demo/spawn_district.json")
    parser.add_argument("--models", type=Path)
    parser.add_argument("--entities", type=Path)
    parser.add_argument("--output", type=Path, default=root / "assets/demo/interactables.json")
    args = parser.parse_args()
    descriptor_path = args.descriptor.resolve()
    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
    assets_root = descriptor_path.parents[1]
    models_path = args.models.resolve() if args.models else assets_root / str(descriptor["manifestFile"])
    entities_path = args.entities.resolve() if args.entities else assets_root / str(descriptor["instanceFile"])
    output_path = args.output.resolve()
    payload = build(models_path.resolve(), entities_path.resolve(), output_path)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload["summary"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

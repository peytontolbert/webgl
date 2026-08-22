#!/usr/bin/env python3
"""Build compact runtime data for the fixed 500 x 500 m /demo district.

The normal world index uses 512 m source chunks.  The FiveM spawn district sits
inside one of those chunks, so filtering in the browser still required parsing
every record in that source chunk.  This script creates a tiny ENT1 tile, an
optional ENT0 point tile, and one manifest subset that the browser can load at
startup without requesting hundreds of manifest shards.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import struct
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_CENTER_X = 186.94
DEFAULT_CENTER_Y = -850.84
DEFAULT_SIZE = 500.0
# This is the persisted FiveM player location used to construct the demo.
# Preserve it instead of inferring a spawn from a nearby prop material name.
DEFAULT_SPAWN_X = 186.94
DEFAULT_SPAWN_Y = -850.84
DEFAULT_SPAWN_PED_Z = 31.17
EDGE_OVERLAP_CANDIDATE_MARGIN = 100.0
# GTA renders one branch of its drawable LOD hierarchy at a time. The compact
# demo has no parent/child traversal metadata, so retaining parent LOD/SLOD
# records alongside HD children creates overlapping roads and building shells.
DEMO_EXCLUDED_LOD_LEVELS = frozenset({
    "LODTYPES_DEPTH_LOD",
    "LODTYPES_DEPTH_SLOD1",
    "LODTYPES_DEPTH_SLOD2",
    "LODTYPES_DEPTH_SLOD3",
    "LODTYPES_DEPTH_SLOD4",
})


def _encode_delta_indices(indices: Any) -> bytes:
    encoded = bytearray()
    previous = 0
    for raw_value in indices:
        value = int(raw_value)
        delta = value - previous
        previous = value
        zigzag = (delta << 1) ^ (delta >> 63)
        while zigzag >= 0x80:
            encoded.append((zigzag & 0x7F) | 0x80)
            zigzag >>= 7
        encoded.append(zigzag)
    return bytes(encoded)


def _quantize_mesh_payload(raw: bytes) -> tuple[bytes, bool]:
    """Convert legacy MSH0 streams to compact scale-aware MSH10."""
    if len(raw) < 20 or raw[:4] != b"MSH0":
        return raw, False
    version, vertex_count, index_count, flags = struct.unpack_from("<IIII", raw, 4)
    if version in (9, 10):
        return raw, False
    if version < 1 or version > 8:
        return raw, False

    import numpy as np

    cursor = 20

    def take(width: int, dtype: Any, enabled: bool = True) -> Any:
        nonlocal cursor
        if not enabled:
            return None
        byte_count = vertex_count * width * np.dtype(dtype).itemsize
        end = cursor + byte_count
        if end > len(raw):
            raise ValueError("truncated MSH0 vertex stream")
        result = np.frombuffer(raw, dtype=dtype, count=vertex_count * width, offset=cursor).reshape(vertex_count, width)
        cursor = end
        return result

    positions = take(3, "<f4")
    normals = take(3, "<f4", version >= 2 and bool(flags & 1))
    uvs = take(2, "<f4", version >= 3 and bool(flags & 2))
    uv1 = take(2, "<f4", version >= 6 and bool(flags & 16))
    uv2 = take(2, "<f4", version >= 7 and bool(flags & 32))
    tangents = take(4, "<f4", version >= 4 and bool(flags & 4))
    color0 = take(4, "u1", version >= 5 and bool(flags & 8))
    color1 = take(4, "u1", version >= 7 and bool(flags & 64))
    blend_weights = take(4, "u1", version >= 8 and bool(flags & 128))
    blend_indices = take(4, "u1", version >= 8 and bool(flags & 256))
    index_end = cursor + index_count * 4
    if index_end != len(raw):
        raise ValueError("unexpected MSH0 index payload length")
    indices = np.frombuffer(raw, dtype="<u4", count=index_count, offset=cursor)

    packed_flags = flags & (1 | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256)
    position_values = np.nan_to_num(positions, nan=0.0, posinf=65504.0, neginf=-65504.0)
    position_min = position_values.min(axis=0).astype("<f4")
    position_extent = (position_values.max(axis=0) - position_min).astype("<f4")
    safe_extent = np.where(position_extent > 1e-12, position_extent, 1.0)
    quantized_positions = np.rint(
        np.clip((position_values - position_min) / safe_extent, 0.0, 1.0) * 65535.0
    ).astype("<u2")
    streams: list[bytes] = [quantized_positions.tobytes()]
    if normals is not None:
        normal_values = np.nan_to_num(normals, nan=0.0, posinf=1.0, neginf=-1.0)
        streams.append(np.rint(np.clip(normal_values, -1.0, 1.0) * 127.0).astype("i1").tobytes())
        if (vertex_count * 6 + vertex_count * 3) % 2:
            streams.append(b"\0")
        packed_flags |= 1024 | 2048

    for stream in (uvs, uv1, uv2):
        if stream is not None:
            values = np.nan_to_num(stream, nan=0.0, posinf=65504.0, neginf=-65504.0)
            streams.append(np.clip(values, -65504.0, 65504.0).astype("<f2").tobytes())
    if tangents is not None:
        values = np.nan_to_num(tangents, nan=0.0, posinf=1.0, neginf=-1.0)
        streams.append(np.rint(np.clip(values, -1.0, 1.0) * 127.0).astype("i1").tobytes())
    for stream in (color0, color1, blend_weights, blend_indices):
        if stream is not None:
            streams.append(stream.tobytes())

    if index_count == 0 or int(indices.max()) <= 0xFFFF:
        packed_flags |= 512 | 4096
        disk_indices = _encode_delta_indices(indices)
    else:
        disk_indices = indices.tobytes()
    vertex_payload = b"".join(streams)
    header = struct.pack(
        "<4sIIII6f", b"MSH0", 10, vertex_count, index_count, packed_flags,
        *position_min.tolist(), *position_extent.tolist(),
    )
    padding = b"\0" * (-(len(header) + len(vertex_payload)) % 4)
    return header + vertex_payload + padding + disk_indices, True


def _read_ent1(path: Path) -> tuple[int, int, bytes]:
    data = path.read_bytes()
    if len(data) < 8 or data[:4] != b"ENT1":
        raise ValueError(f"{path} is not an ENT1 tile")
    count = struct.unpack_from("<I", data, 4)[0]
    for stride in (64, 48, 44):
        if len(data) == 8 + count * stride:
            return count, stride, data
    raise ValueError(f"{path} has an unsupported ENT1 record size")


def _chunk_intersects(key: str, chunk_size: float, bounds: dict[str, float]) -> bool:
    try:
        sx, sy = (int(v) for v in key.split("_", 1))
    except ValueError:
        return False
    min_x = sx * chunk_size
    min_y = sy * chunk_size
    return (
        min_x + chunk_size > bounds["minX"]
        and min_x < bounds["maxX"]
        and min_y + chunk_size > bounds["minY"]
        and min_y < bounds["maxY"]
    )


def _ymap_overlay_key(path: object) -> str:
    """Return the virtual YMAP path used to resolve base/DLC archive overlays.

    The entity extractor records the physical RPF location.  A single logical map
    can therefore appear once from the base archive and again from update/DLC
    patch archives.  CodeWalker/GTA resolves one of those records; emitting all
    of them makes whole buildings, their LODs, and decals overlap in WebGL.
    """
    raw = str(path or "").strip().replace("\\", "/").lower()
    marker = "levels/gta5/"
    marker_index = raw.find(marker)
    virtual_path = raw[marker_index + len(marker):] if marker_index >= 0 else raw
    parent, sep, filename = virtual_path.rpartition("/")
    # Heists uses `hei_` aliases for YMAPs that replace the base map with the
    # same virtual identity. Other filename differences remain distinct maps.
    if filename.startswith("hei_"):
        filename = filename[4:]
    return f"{parent}{sep}{filename}" if sep else filename


def _ymap_overlay_rank(path: object) -> tuple[int, str]:
    """Rank physical archive paths using GTA's base -> update -> DLC precedence."""
    raw = str(path or "").strip().replace("\\", "/").lower()
    rank = 0
    if raw.startswith("fivem:") or "/fivem_resources/" in raw:
        rank = 10000
    if "/update.rpf/" in raw:
        rank = 100
    if "/dlcpacks/" in raw:
        rank = 1000
    patchday = re.search(r"(?:^|/)patchday(\d+)", raw)
    if patchday:
        rank = 2000 + int(patchday.group(1))
    elif "/mpheist/" in raw:
        rank = max(rank, 1500)
    # A deterministic tie-breaker is important when two archive aliases carry
    # the same effective map data.
    return rank, raw


def _active_ymap_paths(rows_by_chunk: list[list[dict[str, Any]]]) -> dict[str, str]:
    """Choose the effective physical YMAP for every virtual map in the tile."""
    chosen: dict[str, tuple[tuple[int, str], str]] = {}
    for rows in rows_by_chunk:
        for row in rows:
            ymap = str(row.get("ymap") or "").strip()
            if not ymap:
                continue
            key = _ymap_overlay_key(ymap)
            candidate = _ymap_overlay_rank(ymap)
            current = chosen.get(key)
            if current is None or candidate > current[0]:
                chosen[key] = (candidate, ymap)
    return {key: value[1] for key, value in chosen.items()}


def _is_demo_detail_entity(row: dict[str, Any]) -> bool:
    """Keep the locally-rendered HD branch and drop overlapping parent LODs."""
    level = str(row.get("lod_level") or "").strip().upper()
    return level not in DEMO_EXCLUDED_LOD_LEVELS


def _manifest_entries(assets_dir: Path, hashes: set[str]) -> dict[str, Any]:
    index = json.loads((assets_dir / "models" / "manifest_index.json").read_text(encoding="utf-8"))
    if index.get("schema") != "webglgta-manifest-index-v1":
        raise ValueError("models/manifest_index.json is not a supported sharded manifest")
    bits = int(index.get("shard_bits", 8))
    shard_dir = str(index.get("shard_dir", "manifest_shards"))
    shard_ext = str(index.get("shard_file_ext", ".json"))
    digits = (bits + 3) // 4
    mask = (1 << bits) - 1
    needed_shards = sorted({(int(h) & mask) for h in hashes})

    meshes: dict[str, Any] = {}
    for shard_id in needed_shards:
        filename = f"{shard_id:0{digits}x}{shard_ext}"
        shard_path = assets_dir / "models" / shard_dir / filename
        shard = json.loads(shard_path.read_text(encoding="utf-8"))
        for hash_id, entry in (shard.get("meshes") or {}).items():
            if hash_id in hashes:
                meshes[hash_id] = entry
    return {"index": index, "meshes": meshes, "shards": needed_shards}


def _joaat(value: object) -> int:
    """Return GTA's unsigned Jenkins one-at-a-time hash for asset names."""
    text = str(value or "").lower()
    h = 0
    for ch in text:
        h = (h + ord(ch)) & 0xFFFFFFFF
        h = (h + ((h << 10) & 0xFFFFFFFF)) & 0xFFFFFFFF
        h ^= h >> 6
    h = (h + ((h << 3) & 0xFFFFFFFF)) & 0xFFFFFFFF
    h ^= h >> 11
    h = (h + ((h << 15) & 0xFFFFFFFF)) & 0xFFFFFFFF
    return h & 0xFFFFFFFF


def _slugify_texture_name(value: object) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return ""
    text = re.sub(r"[^a-z0-9]+", "_", text)
    return text.strip("_")


def _looks_like_texture_path(value: str) -> bool:
    if "/" in value or "\\" in value:
        return True
    return re.search(r"\.(png|ktx2|jpg|jpeg|webp|dds)$", value, re.IGNORECASE) is not None


def _texture_rel_from_shader_param_value(value: object) -> str | None:
    """Mirror ModelManager's shader-param texture path convention for demo manifests."""
    raw = str(value or "").strip()
    if not raw:
        return None
    rel = raw.replace("\\", "/")
    if _looks_like_texture_path(rel):
        rel = re.sub(r"^/+","", rel)
        rel = re.sub(r"^assets/", "", rel, flags=re.IGNORECASE)
        rel = re.sub(r"^(model_texture|model_textures|models_texture)/", "models_textures/", rel, flags=re.IGNORECASE)
        return rel

    slug = _slugify_texture_name(raw)
    if not slug:
        return f"models_textures/{_joaat(raw)}.png"
    return f"models_textures/{_joaat(raw)}_{slug}.png"


_TEXTURE_SLOT_HASHES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("diffuse", ("4059966321", "1732587965", "1399472831", "2669264211", "934209648", "3576369631", "2946270081", "1616890976")),
    ("diffuse2", ("181641832",)),
    ("normal", ("1186448975", "2327911600", "1073714531", "1422769919", "2745359528", "2975430677")),
    ("spec", ("1619499462", "2134197289")),
    ("detail", ("3393362404", "1041827691")),
    ("ao", ("50748941", "1212577329")),
    ("alphaMask", ("1705051233",)),
    ("height", ("1008099585", "4049987115", "4152773162")),
    ("tintPalette", ("4131954791", "2878898974")),
    ("tint", ("1530343050",)),
    ("env", ("3317411368", "2951443911", "3837901164")),
    ("dirt", ("2124031998",)),
    ("damage", ("3579349756", "4132715990")),
    ("damageSpec", ("3820652825",)),
    ("damageMask", ("1117905904",)),
    ("puddleMask", ("1899494261",)),
    ("waterFlow", ("1214194352",)),
    ("waterFoam", ("3266349336",)),
    ("terrainColor1", ("255045494",)),
    ("terrainColor2", ("2707084226",)),
    ("terrainColor3", ("2981196911",)),
    ("terrainColor4", ("3291650421",)),
    ("terrainNormal1", ("1422769919",)),
    ("terrainNormal2", ("2745359528",)),
    ("terrainNormal3", ("2975430677",)),
    ("terrainNormal4", ("2417505683",)),
)


def _texture_param_value(tex_by_hash: dict[str, Any], hash_id: str) -> Any:
    if hash_id in tex_by_hash:
        return tex_by_hash[hash_id]
    try:
        return tex_by_hash[int(hash_id)]
    except (TypeError, ValueError, KeyError):
        return None


def _clear_texture_slot(material: dict[str, Any], slot: str) -> None:
    for key in (slot, f"{slot}Ktx2", f"{slot}Name", f"{slot}ParamHash"):
        material.pop(key, None)
    if slot == "diffuse2":
        material.pop("diffuse2Uv", None)


def _set_texture_slot(material: dict[str, Any], slot: str, rel: str, hash_id: str) -> None:
    material[slot] = rel
    material.pop(f"{slot}Ktx2", None)
    material[f"{slot}ParamHash"] = int(hash_id)
    if slot == "diffuse2":
        material["diffuse2Uv"] = "uv1"


def _normalize_material_from_shader_params(material: Any) -> int:
    """Make shaderParams texture bindings authoritative in the compact demo manifest."""
    if not isinstance(material, dict):
        return 0
    shader_params = material.get("shaderParams")
    tex_by_hash = shader_params.get("texturesByHash") if isinstance(shader_params, dict) else None
    if not isinstance(tex_by_hash, dict):
        return 0

    changed = 0
    for slot, hashes in _TEXTURE_SLOT_HASHES:
        resolved: str | None = None
        resolved_hash: str | None = None
        for hash_id in hashes:
            value = _texture_param_value(tex_by_hash, hash_id)
            if not isinstance(value, str) or not value:
                continue
            rel = _texture_rel_from_shader_param_value(value)
            if rel:
                resolved = rel
                resolved_hash = hash_id
                break
        if resolved and resolved_hash:
            old = material.get(slot)
            old_hash = material.get(f"{slot}ParamHash")
            _set_texture_slot(material, slot, resolved, resolved_hash)
            if old != resolved or old_hash != int(resolved_hash):
                changed += 1
            continue

        try:
            source_hash = int(material.get(f"{slot}ParamHash"))
        except (TypeError, ValueError):
            source_hash = None
        if source_hash is None or source_hash not in {int(h) for h in hashes}:
            if isinstance(material.get(slot), str) and material.get(slot):
                _clear_texture_slot(material, slot)
                changed += 1

    shader_name = str(material.get("shaderName") or "").lower()
    if "emissive" in shader_name and isinstance(material.get("diffuse"), str) and material["diffuse"]:
        material["emissive"] = material["diffuse"]
        material.pop("emissiveKtx2", None)
        material["emissiveParamHash"] = 4059966321
    else:
        _clear_texture_slot(material, "emissive")

    return changed


def _normalize_manifest_materials(meshes: dict[str, Any]) -> int:
    normalized = 0
    for entry in meshes.values():
        if not isinstance(entry, dict):
            continue
        normalized += _normalize_material_from_shader_params(entry.get("material"))
        lods = entry.get("lods")
        if not isinstance(lods, dict):
            continue
        for lod in lods.values():
            if not isinstance(lod, dict):
                continue
            normalized += _normalize_material_from_shader_params(lod.get("material"))
            submeshes = lod.get("submeshes")
            if not isinstance(submeshes, list):
                continue
            for submesh in submeshes:
                if isinstance(submesh, dict):
                    normalized += _normalize_material_from_shader_params(submesh.get("material"))
    return normalized


def _clear_stale_entry_roadmarking_fallbacks(meshes: dict[str, Any]) -> int:
    """Drop entry-level road-marking fallbacks when v4 submeshes own their materials."""
    cleared = 0
    texture_keys = {
        "diffuse", "diffuseKtx2", "diffuseName", "diffuseParamHash",
        "diffuse2", "diffuse2Ktx2", "diffuse2Name", "diffuse2ParamHash", "diffuse2Uv",
        "normal", "normalKtx2", "normalName", "normalParamHash",
        "spec", "specKtx2", "specName", "specParamHash",
        "detail", "detailKtx2", "detailName", "detailParamHash",
        "ao", "aoKtx2", "aoName", "aoParamHash",
        "alphaMask", "alphaMaskKtx2", "alphaMaskName", "alphaMaskParamHash",
        "height", "heightKtx2", "heightName", "heightParamHash",
        "emissive", "emissiveKtx2", "emissiveName", "emissiveParamHash",
    }
    for entry in meshes.values():
        if not isinstance(entry, dict):
            continue
        material = entry.get("material")
        if not isinstance(material, dict):
            continue
        if isinstance(material.get("shaderParams"), dict):
            continue
        diffuse = str(material.get("diffuse") or "").lower()
        if "roadmarkings" not in diffuse:
            continue
        if any(key not in texture_keys for key in material.keys()):
            continue

        submesh_count = 0
        submesh_material_count = 0
        lods = entry.get("lods")
        if isinstance(lods, dict):
            for lod in lods.values():
                if not isinstance(lod, dict):
                    continue
                submeshes = lod.get("submeshes")
                if not isinstance(submeshes, list):
                    continue
                for submesh in submeshes:
                    if not isinstance(submesh, dict):
                        continue
                    submesh_count += 1
                    if isinstance(submesh.get("material"), dict):
                        submesh_material_count += 1
        if submesh_count > 0 and submesh_count == submesh_material_count:
            entry.pop("material", None)
            cleared += 1
    return cleared


def _entry_has_ground_material(entry: Any) -> bool:
    if not isinstance(entry, dict):
        return False
    try:
        text = json.dumps(entry, separators=(",", ":")).lower()
    except (TypeError, ValueError):
        text = str(entry).lower()
    return any(term in text for term in ("sidewalk", "road", "kerb", "crossing", "terrain", "grass"))


def _choose_demo_spawn(
    records: list[bytes],
    stride: int,
    bounds: dict[str, float],
    meshes: dict[str, Any],
    configured_spawn: dict[str, float] | None = None,
) -> dict[str, Any] | None:
    if configured_spawn is not None:
        x = float(configured_spawn.get("x", float("nan")))
        y = float(configured_spawn.get("y", float("nan")))
        # FiveM returns a ped root coordinate. Accept the old key as input so
        # existing command invocations still work, but always write `pedZ`.
        ped_z = float(configured_spawn.get("pedZ", configured_spawn.get("groundZ", float("nan"))))
        if (
            all(math.isfinite(v) for v in (x, y, ped_z))
            and bounds["minX"] <= x <= bounds["maxX"]
            and bounds["minY"] <= y <= bounds["maxY"]
        ):
            return {
                "x": x,
                "y": y,
                "pedZ": ped_z,
                "source": "configured_fivem_profile",
            }
    if not records or stride < 16:
        return None
    preferred_x = (bounds["minX"] + bounds["maxX"]) * 0.5
    preferred_y = (bounds["minY"] + bounds["maxY"]) * 0.5

    best: tuple[float, dict[str, Any]] | None = None
    for record in records:
        if len(record) < stride:
            continue
        try:
            hash_id = str(struct.unpack_from("<I", record, 0)[0])
            x, y, z = struct.unpack_from("<3f", record, 4)
        except struct.error:
            continue
        if not all(math.isfinite(v) for v in (x, y, z)):
            continue
        if not _entry_has_ground_material(meshes.get(hash_id)):
            continue
        if z < -10 or z > 120:
            continue
        d = ((x - preferred_x) * (x - preferred_x) + (y - preferred_y) * (y - preferred_y)) ** 0.5
        item = {
            "x": preferred_x,
            "y": preferred_y,
            "groundZ": z,
            "sourceHash": hash_id,
            "sourceX": x,
            "sourceY": y,
            "sourceZ": z,
            "sourceDistance": d,
        }
        if best is None or d < best[0]:
            best = (d, item)
    return best[1] if best else None


def _low_lod_files(meshes: dict[str, Any]) -> set[str]:
    files: set[str] = set()
    for entry in meshes.values():
        lods = entry.get("lods") if isinstance(entry, dict) else None
        lods = lods if isinstance(lods, dict) else {}
        lod = lods.get("low") or lods.get("vlow") or lods.get("med") or lods.get("high")
        if not isinstance(lod, dict):
            continue
        if isinstance(lod.get("file"), str) and lod["file"]:
            files.add(lod["file"])
        submeshes = lod.get("submeshes") or lod.get("meshes") or []
        if isinstance(submeshes, list):
            for submesh in submeshes:
                if isinstance(submesh, dict) and isinstance(submesh.get("file"), str) and submesh["file"]:
                    files.add(submesh["file"])
    return files


def _selected_lod(entry: Any, requested: str = "med") -> dict[str, Any] | None:
    if not isinstance(entry, dict) or not isinstance(entry.get("lods"), dict):
        return None
    orders = {
        "high": ("high", "med", "low", "vlow"),
        "med": ("med", "low", "vlow", "high"),
        "low": ("low", "vlow", "med", "high"),
        "vlow": ("vlow", "low", "med", "high"),
    }
    lods = entry["lods"]
    for key in orders.get(requested, orders["med"]):
        lod = lods.get(key)
        if isinstance(lod, dict):
            return lod
    return None


def _retain_selected_lod(meshes: dict[str, Any], requested: str = "med") -> int:
    orders = {
        "high": ("high", "med", "low", "vlow"),
        "med": ("med", "low", "vlow", "high"),
        "low": ("low", "vlow", "med", "high"),
        "vlow": ("vlow", "low", "med", "high"),
    }
    removed = 0
    for entry in meshes.values():
        lods = entry.get("lods") if isinstance(entry, dict) else None
        if not isinstance(lods, dict):
            continue
        selected_key = next((key for key in orders.get(requested, orders["med"]) if isinstance(lods.get(key), dict)), None)
        if selected_key is None:
            continue
        removed += max(0, len(lods) - 1)
        entry["lods"] = {selected_key: lods[selected_key]}
    return removed


def _lod_files(lod: Any) -> list[str]:
    if not isinstance(lod, dict):
        return []
    files: list[str] = []
    if isinstance(lod.get("file"), str) and lod["file"]:
        files.append(lod["file"])
    submeshes = lod.get("submeshes") or lod.get("meshes") or []
    if isinstance(submeshes, list):
        for submesh in submeshes:
            if isinstance(submesh, dict) and isinstance(submesh.get("file"), str) and submesh["file"]:
                files.append(submesh["file"])
    return files


def _pack_default_lod_meshes(
    assets_dir: Path,
    demo_dir: Path,
    meshes: dict[str, Any],
    archetype_min_distance: dict[str, float],
    target_bytes: int = 6 * 1024 * 1024,
    quantize_meshes: bool = False,
) -> dict[str, Any]:
    """Pack the runtime-resolved medium LOD into shared transport files."""
    priorities: dict[str, float] = {}
    for hash_id, entry in meshes.items():
        distance = float(archetype_min_distance.get(hash_id, float("inf")))
        for rel in _lod_files(_selected_lod(entry, "med")):
            priorities[rel] = min(distance, priorities.get(rel, float("inf")))

    missing: list[str] = []
    source_file_count = 0
    quantized_count = 0
    quantize_fallbacks: list[str] = []
    source_bytes = 0
    packed_refs: dict[str, str] = {}
    pack_names: list[str] = []
    pack_bytes = 0
    current: list[tuple[str, bytes]] = []
    current_size = 0

    def flush() -> None:
        nonlocal current, current_size, pack_bytes
        if not current:
            return
        payload = b"".join(data for _rel, data in current)
        digest = hashlib.sha256(payload).hexdigest()[:16]
        name = f"spawn_district_meshpack_{digest}.bin"
        path = demo_dir / name
        if not path.is_file() or path.stat().st_size != len(payload):
            path.write_bytes(payload)
        offset = 0
        for rel, data in current:
            packed_refs[rel] = f"@demo-pack/{name}#{offset}:{len(data)}"
            offset += len(data)
        pack_names.append(name)
        pack_bytes += len(payload)
        current = []
        current_size = 0

    for rel in sorted(priorities, key=lambda item: (priorities[item], item)):
        path = assets_dir / "models" / rel
        try:
            payload = path.read_bytes()
        except OSError:
            missing.append(rel)
            continue
        if not payload:
            continue
        source_file_count += 1
        source_bytes += len(payload)
        if quantize_meshes:
            try:
                compact, converted = _quantize_mesh_payload(payload)
                if converted:
                    payload = compact
                    quantized_count += 1
            except (ValueError, OverflowError, struct.error) as error:
                quantize_fallbacks.append(f"{rel}: {error}")
        if current and current_size + len(payload) > target_bytes:
            flush()
        current.append((rel, payload))
        current_size += len(payload)
    flush()

    rewritten = 0
    for entry in meshes.values():
        if not isinstance(entry, dict) or not isinstance(entry.get("lods"), dict):
            continue
        for lod in entry["lods"].values():
            if not isinstance(lod, dict):
                continue
            old = lod.get("file")
            if isinstance(old, str) and old in packed_refs:
                lod["file"] = packed_refs[old]
                rewritten += 1
            submeshes = lod.get("submeshes") or lod.get("meshes") or []
            if not isinstance(submeshes, list):
                continue
            for submesh in submeshes:
                if not isinstance(submesh, dict):
                    continue
                old = submesh.get("file")
                if isinstance(old, str) and old in packed_refs:
                    submesh["file"] = packed_refs[old]
                    rewritten += 1

    return {
        "files": pack_names,
        "packCount": len(pack_names),
        "sourceFileCount": source_file_count,
        "sourceBytes": source_bytes,
        "packBytes": pack_bytes,
        "quantizedFileCount": quantized_count,
        "quantizeFallbackCount": len(quantize_fallbacks),
        "quantizeFallbacks": quantize_fallbacks,
        "rewrittenReferences": rewritten,
        "missingFiles": missing,
    }


def _mesh_bounds(path: Path) -> dict[str, Any] | None:
    """Read local-space bounds from a viewer MSH0 mesh bin without decoding the whole mesh."""
    try:
        data = path.read_bytes()
    except OSError:
        return None
    if len(data) < 20 or data[:4] != b"MSH0":
        return None

    try:
        version, vertex_count, _index_count, flags = struct.unpack_from("<IIII", data, 4)
    except struct.error:
        return None
    if version < 1 or vertex_count <= 0:
        return None

    pos_bytes = vertex_count * 3 * 4
    if 20 + pos_bytes > len(data):
        return None

    min_x = min_y = min_z = float("inf")
    max_x = max_y = max_z = float("-inf")
    off = 20
    for _ in range(vertex_count):
        try:
            x, y, z = struct.unpack_from("<3f", data, off)
        except struct.error:
            return None
        off += 12
        min_x = min(min_x, x)
        min_y = min(min_y, y)
        min_z = min(min_z, z)
        max_x = max(max_x, x)
        max_y = max(max_y, y)
        max_z = max(max_z, z)

    if not all(math.isfinite(v) for v in (min_x, min_y, min_z, max_x, max_y, max_z)):
        return None

    cx = (min_x + max_x) * 0.5
    cy = (min_y + max_y) * 0.5
    cz = (min_z + max_z) * 0.5
    dx = (max_x - min_x) * 0.5
    dy = (max_y - min_y) * 0.5
    dz = (max_z - min_z) * 0.5
    radius = (dx * dx + dy * dy + dz * dz) ** 0.5

    return {
        "min": [min_x, min_y, min_z],
        "max": [max_x, max_y, max_z],
        "center": [cx, cy, cz],
        "radius": radius,
        "flags": int(flags),
    }


def _merge_bounds(items: list[dict[str, Any]]) -> dict[str, Any] | None:
    boxes = [it for it in items if isinstance(it, dict) and isinstance(it.get("min"), list) and isinstance(it.get("max"), list)]
    if not boxes:
        return None
    min_v = [min(float(b["min"][i]) for b in boxes) for i in range(3)]
    max_v = [max(float(b["max"][i]) for b in boxes) for i in range(3)]
    center = [(min_v[i] + max_v[i]) * 0.5 for i in range(3)]
    ext = [(max_v[i] - min_v[i]) * 0.5 for i in range(3)]
    radius = (ext[0] * ext[0] + ext[1] * ext[1] + ext[2] * ext[2]) ** 0.5
    return {"min": min_v, "max": max_v, "center": center, "radius": radius}


def _manifest_shard_ids(index: dict[str, Any], hashes: set[str]) -> list[int]:
    bits = int(index.get("shard_bits", 8))
    mask = (1 << bits) - 1
    return sorted({(int(h) & mask) for h in hashes})


def _entry_xy_radius(assets_dir: Path, entry: Any, cache: dict[str, dict[str, Any] | None]) -> float | None:
    if not isinstance(entry, dict):
        return None
    best: float | None = None

    def add_file(rel: Any) -> None:
        nonlocal best
        if not isinstance(rel, str) or not rel:
            return
        cached = cache.get(rel)
        if rel not in cache:
            cached = _mesh_bounds(assets_dir / "models" / rel)
            cache[rel] = cached
        if not cached:
            return
        min_v = cached.get("min")
        max_v = cached.get("max")
        center = cached.get("center")
        if not (isinstance(min_v, list) and isinstance(max_v, list) and isinstance(center, list)):
            return
        try:
            dx = (float(max_v[0]) - float(min_v[0])) * 0.5
            dy = (float(max_v[1]) - float(min_v[1])) * 0.5
            cx = float(center[0])
            cy = float(center[1])
            r = (cx * cx + cy * cy) ** 0.5 + (dx * dx + dy * dy) ** 0.5
        except (TypeError, ValueError):
            return
        if math.isfinite(r) and r > 0 and (best is None or r > best):
            best = r

    lods = entry.get("lods")
    if isinstance(lods, dict):
        for lod in lods.values():
            if not isinstance(lod, dict):
                continue
            add_file(lod.get("file"))
            submeshes = lod.get("submeshes")
            if isinstance(submeshes, list):
                for submesh in submeshes:
                    if isinstance(submesh, dict):
                        add_file(submesh.get("file"))

    return best


def _entity_intersects_bounds_by_radius(
    assets_dir: Path,
    manifest_meshes: dict[str, Any],
    radius_cache: dict[str, float | None],
    mesh_bounds_cache: dict[str, dict[str, Any] | None],
    hash_id: str,
    data: bytes,
    offset: int,
    stride: int,
    bounds: dict[str, float],
) -> bool:
    try:
        x, y = struct.unpack_from("<2f", data, offset + 4)
    except struct.error:
        return False
    if bounds["minX"] <= x <= bounds["maxX"] and bounds["minY"] <= y <= bounds["maxY"]:
        return True

    if hash_id not in radius_cache:
        radius_cache[hash_id] = _entry_xy_radius(assets_dir, manifest_meshes.get(hash_id), mesh_bounds_cache)
    radius = radius_cache.get(hash_id)
    if not (isinstance(radius, (int, float)) and math.isfinite(radius) and radius > 0):
        return False

    scale = 1.0
    if stride >= 44:
        try:
            sx, sy, sz = struct.unpack_from("<3f", data, offset + 32)
            vals = [abs(float(sx)), abs(float(sy)), abs(float(sz))]
            finite = [v for v in vals if math.isfinite(v) and v > 0]
            if finite:
                scale = max(finite)
        except struct.error:
            scale = 1.0

    dx = 0.0
    if x < bounds["minX"]:
        dx = bounds["minX"] - x
    elif x > bounds["maxX"]:
        dx = x - bounds["maxX"]
    dy = 0.0
    if y < bounds["minY"]:
        dy = bounds["minY"] - y
    elif y > bounds["maxY"]:
        dy = y - bounds["maxY"]
    dist = (dx * dx + dy * dy) ** 0.5
    return dist <= (radius * scale + 2.0)


def _annotate_mesh_bounds(assets_dir: Path, meshes: dict[str, Any]) -> int:
    """Attach local-space bounds/radius to demo manifest entries for runtime culling."""
    annotated = 0
    for entry in meshes.values():
        if not isinstance(entry, dict):
            continue
        lods = entry.get("lods")
        if not isinstance(lods, dict):
            continue
        entry_bounds: list[dict[str, Any]] = []
        for lod in lods.values():
            if not isinstance(lod, dict):
                continue
            lod_bounds: list[dict[str, Any]] = []
            subs = lod.get("submeshes")
            if isinstance(subs, list):
                for submesh in subs:
                    if not isinstance(submesh, dict):
                        continue
                    rel = submesh.get("file")
                    if not isinstance(rel, str) or not rel:
                        continue
                    b = _mesh_bounds(assets_dir / "models" / rel)
                    if not b:
                        continue
                    submesh["bounds"] = {k: b[k] for k in ("min", "max", "center")}
                    submesh["radius"] = b["radius"]
                    lod_bounds.append(b)
                    annotated += 1
            elif isinstance(lod.get("file"), str):
                b = _mesh_bounds(assets_dir / "models" / lod["file"])
                if b:
                    lod["bounds"] = {k: b[k] for k in ("min", "max", "center")}
                    lod["radius"] = b["radius"]
                    lod_bounds.append(b)
                    annotated += 1

            merged_lod = _merge_bounds(lod_bounds)
            if merged_lod:
                lod["bounds"] = {k: merged_lod[k] for k in ("min", "max", "center")}
                lod["radius"] = merged_lod["radius"]
                entry_bounds.append(merged_lod)

        merged_entry = _merge_bounds(entry_bounds)
        if merged_entry:
            entry["bounds"] = {k: merged_entry[k] for k in ("min", "max", "center")}
            entry["radius"] = merged_entry["radius"]
    return annotated


def _non_renderable_hashes(assets_dir: Path, hashes: set[str]) -> set[str]:
    path = assets_dir / "models" / "non_renderable_archetypes.json"
    if not path.is_file():
        return set()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        known = {str(int(raw) & 0xFFFFFFFF) for raw in (data.get("hashes") or [])}
    except (OSError, TypeError, ValueError):
        return set()
    return hashes.intersection(known)


def build(
    assets_dir: Path,
    center_x: float,
    center_y: float,
    size: float,
    configured_spawn: dict[str, float] | None = None,
    quantize_meshes: bool = False,
    mesh_pack_target_bytes: int = 6 * 1024 * 1024,
    output_demo_dir: Path | None = None,
) -> dict[str, Any]:
    half = size * 0.5
    bounds = {
        "minX": center_x - half,
        "minY": center_y - half,
        "maxX": center_x + half,
        "maxY": center_y + half,
    }
    index = json.loads((assets_dir / "entities_index.json").read_text(encoding="utf-8"))
    chunk_size = float(index.get("chunk_size", 512.0))
    chunk_metas = index.get("chunks") or {}
    source_chunks = sorted(key for key in chunk_metas if _chunk_intersects(key, chunk_size, bounds))
    if not source_chunks:
        raise ValueError("no source entity chunks overlap the requested district")

    # Pair each ENT1 record with its source JSON row. The binary format is fast
    # at runtime but intentionally omits the physical YMAP path required to
    # resolve base/update/DLC overlay precedence.
    chunk_sources: list[tuple[bytes, int, list[dict[str, Any]]]] = []
    rows_by_chunk: list[list[dict[str, Any]]] = []
    for key in source_chunks:
        meta = chunk_metas[key]
        jsonl_file = str(meta.get("file", "")).strip()
        source_jsonl = assets_dir / "entities_chunks" / jsonl_file
        source_file = jsonl_file.replace(".jsonl", ".bin")
        source_path = assets_dir / "entities_chunks_inst" / source_file
        count, stride, data = _read_ent1(source_path)
        rows: list[dict[str, Any]] = []
        with source_jsonl.open("r", encoding="utf-8", errors="ignore") as source:
            for line in source:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(row, dict):
                    rows.append(row)
        if len(rows) != count:
            raise ValueError(
                f"ENT1/JSONL record mismatch for {key}: bin={count}, jsonl={len(rows)}. "
                "Rebuild assets/entities_chunks_inst before making a demo bundle."
            )
        chunk_sources.append((data, stride, rows))
        rows_by_chunk.append(rows)

    active_ymaps = _active_ymap_paths(rows_by_chunk)
    active_candidate_hashes: set[str] = set()
    record_stride: int | None = None
    for data, stride, rows in chunk_sources:
        count = len(rows)
        if record_stride is None:
            record_stride = stride
        elif record_stride != stride:
            raise ValueError(f"mixed ENT1 strides are not supported ({record_stride} vs {stride})")
        for index_in_chunk in range(count):
            ymap = str(rows[index_in_chunk].get("ymap") or "").strip()
            if ymap and active_ymaps.get(_ymap_overlay_key(ymap)) != ymap:
                continue
            if not _is_demo_detail_entity(rows[index_in_chunk]):
                continue
            offset = 8 + index_in_chunk * stride
            x, y = struct.unpack_from("<2f", data, offset + 4)
            if not (
                bounds["minX"] - EDGE_OVERLAP_CANDIDATE_MARGIN <= x <= bounds["maxX"] + EDGE_OVERLAP_CANDIDATE_MARGIN
                and bounds["minY"] - EDGE_OVERLAP_CANDIDATE_MARGIN <= y <= bounds["maxY"] + EDGE_OVERLAP_CANDIDATE_MARGIN
            ):
                continue
            active_candidate_hashes.add(str(struct.unpack_from("<I", data, offset)[0]))

    candidate_manifest_data = _manifest_entries(assets_dir, active_candidate_hashes)
    radius_cache: dict[str, float | None] = {}
    mesh_bounds_cache: dict[str, dict[str, Any] | None] = {}

    records: list[bytes] = []
    points: list[tuple[float, float, float]] = []
    archetype_counts: Counter[str] = Counter()
    archetype_min_distance: dict[str, float] = {}
    source_instance_count = 0
    bounds_overlap_entities = 0
    dropped_overlay_entities = 0
    dropped_overlap_overlay_entities = 0
    dropped_lod_entities = 0
    for data, stride, rows in chunk_sources:
        count = len(rows)
        for index_in_chunk in range(count):
            offset = 8 + index_in_chunk * stride
            x, y, z = struct.unpack_from("<3f", data, offset + 4)
            origin_inside = bounds["minX"] <= x <= bounds["maxX"] and bounds["minY"] <= y <= bounds["maxY"]
            if origin_inside:
                source_instance_count += 1
            hash_id = str(struct.unpack_from("<I", data, offset)[0])
            overlaps = origin_inside or _entity_intersects_bounds_by_radius(
                assets_dir,
                candidate_manifest_data["meshes"],
                radius_cache,
                mesh_bounds_cache,
                hash_id,
                data,
                offset,
                stride,
                bounds,
            )
            if not overlaps:
                continue
            ymap = str(rows[index_in_chunk].get("ymap") or "").strip()
            if ymap and active_ymaps.get(_ymap_overlay_key(ymap)) != ymap:
                if origin_inside:
                    dropped_overlay_entities += 1
                else:
                    dropped_overlap_overlay_entities += 1
                continue
            if not _is_demo_detail_entity(rows[index_in_chunk]):
                dropped_lod_entities += 1
                continue
            if not origin_inside:
                bounds_overlap_entities += 1
            records.append(data[offset:offset + stride])
            points.append((x, y, z))
            archetype_counts[hash_id] += 1
            distance = math.hypot(x - center_x, y - center_y)
            archetype_min_distance[hash_id] = min(distance, archetype_min_distance.get(hash_id, float("inf")))

    if not records or record_stride is None:
        raise ValueError("the requested district contains no ENT1 records")

    demo_dir = output_demo_dir or (assets_dir / "demo")
    demo_dir.mkdir(parents=True, exist_ok=True)
    instance_path = demo_dir / "spawn_district_entities.bin"
    with instance_path.open("wb") as out:
        out.write(b"ENT1")
        out.write(struct.pack("<I", len(records)))
        for record in records:
            out.write(record)

    points_path = demo_dir / "spawn_district_points.bin"
    with points_path.open("wb") as out:
        out.write(b"ENT0")
        out.write(struct.pack("<I", len(points)))
        for point in points:
            out.write(struct.pack("<3f", *point))

    manifest_hashes = set(archetype_counts)
    manifest_data = {
        "index": candidate_manifest_data["index"],
        "meshes": {
            hash_id: entry
            for hash_id, entry in candidate_manifest_data["meshes"].items()
            if hash_id in manifest_hashes
        },
        "shards": _manifest_shard_ids(candidate_manifest_data["index"], manifest_hashes),
    }
    pruned_lod_count = _retain_selected_lod(manifest_data["meshes"], "med")
    material_bindings_normalized = _normalize_manifest_materials(manifest_data["meshes"])
    stale_entry_materials_cleared = _clear_stale_entry_roadmarking_fallbacks(manifest_data["meshes"])
    bounds_annotated = _annotate_mesh_bounds(assets_dir, manifest_data["meshes"])
    low_lod_files = _low_lod_files(manifest_data["meshes"])
    low_lod_bytes = sum(
        (assets_dir / "models" / file).stat().st_size
        for file in low_lod_files
        if (assets_dir / "models" / file).is_file()
    )
    default_lod_files = {
        rel
        for entry in manifest_data["meshes"].values()
        for rel in _lod_files(_selected_lod(entry, "med"))
    }
    default_lod_bytes = sum(
        (assets_dir / "models" / file).stat().st_size
        for file in default_lod_files
        if (assets_dir / "models" / file).is_file()
    )
    mesh_pack = _pack_default_lod_meshes(
        assets_dir,
        demo_dir,
        manifest_data["meshes"],
        archetype_min_distance,
        target_bytes=max(256 * 1024, int(mesh_pack_target_bytes)),
        quantize_meshes=quantize_meshes,
    )
    recommended_spawn = _choose_demo_spawn(
        records,
        record_stride,
        bounds,
        manifest_data["meshes"],
        configured_spawn=configured_spawn,
    )
    missing_top = [
        {"hash": hash_id, "count": count}
        for hash_id, count in archetype_counts.most_common()
        if hash_id not in manifest_data["meshes"]
    ]
    non_renderable = _non_renderable_hashes(assets_dir, {item["hash"] for item in missing_top})
    non_renderable_top = [item for item in missing_top if item["hash"] in non_renderable]
    unexported_top = [item for item in missing_top if item["hash"] not in non_renderable]
    # Keep this in the same shape as the viewer's missing-archetype download so
    # export_drawables_from_list.py can consume it directly on Windows.
    missing_path = demo_dir / "spawn_district_unexported.json"
    missing_path.write_text(
        json.dumps(
            {
                "schema": "webglgta-demo-unexported-v1",
                "bounds": bounds,
                "missingTop": unexported_top,
                "nonRenderableTop": non_renderable_top,
            },
            indent=2,
        ) + "\n",
        encoding="utf-8",
    )
    manifest_path = demo_dir / "spawn_district_models.json"
    manifest_path.write_text(
        json.dumps(
            {
                "schema": "webglgta-demo-manifest-v1",
                "sourceManifestVersion": manifest_data["index"].get("manifest_version"),
                "materialTextureBindingsNormalized": material_bindings_normalized,
                "staleEntryMaterialsCleared": stale_entry_materials_cleared,
                "meshes": manifest_data["meshes"],
                "nonRenderableHashes": sorted(non_renderable, key=int),
            },
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )

    descriptor = {
        "schema": "webglgta-spawn-district-v1",
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "center": {"x": center_x, "y": center_y},
        "size": size,
        "bounds": bounds,
        "spawn": recommended_spawn,
        "sourceChunks": source_chunks,
        "instanceFile": "demo/spawn_district_entities.bin",
        "pointFile": "demo/spawn_district_points.bin",
        "manifestFile": "demo/spawn_district_models.json",
        "destructibleManifestFile": "demo/spawn_district_destructibles.json",
        "assetColliderManifestFile": "demo/spawn_district_asset_colliders.json",
        "fragmentChildrenManifestFile": "demo/spawn_district_fragment_children.json",
        "instanceCount": len(records),
        "sourceInstanceCount": source_instance_count,
        "boundsOverlapEntityCount": bounds_overlap_entities,
        "droppedOverlayEntityCount": dropped_overlay_entities,
        "droppedBoundsOverlapOverlayEntityCount": dropped_overlap_overlay_entities,
        "droppedParentLodEntityCount": dropped_lod_entities,
        "sourceYmapPathCount": len({str(row.get('ymap') or '') for rows in rows_by_chunk for row in rows if row.get('ymap')}),
        "activeYmapPathCount": len(active_ymaps),
        "archetypeCount": len(archetype_counts),
        "manifestArchetypeCount": len(manifest_data["meshes"]),
        "manifestShardCount": len(manifest_data["shards"]),
        "unexportedArchetypeCount": len(unexported_top),
        "unexportedEntityCount": sum(item["count"] for item in unexported_top),
        "nonRenderableArchetypeCount": len(non_renderable_top),
        "nonRenderableEntityCount": sum(item["count"] for item in non_renderable_top),
        "unexportedFile": "demo/spawn_district_unexported.json",
        "recordStride": record_stride,
        "lowLodFileCount": len(low_lod_files),
        "lowLodBytes": low_lod_bytes,
        "defaultLod": "med",
        "prunedUnusedLodCount": pruned_lod_count,
        "defaultLodFileCount": len(default_lod_files),
        "defaultLodBytes": default_lod_bytes,
        "meshPackCount": mesh_pack["packCount"],
        "meshPackSourceFileCount": mesh_pack["sourceFileCount"],
        "meshPackBytes": mesh_pack["packBytes"],
        "meshPackSourceBytes": mesh_pack["sourceBytes"],
        "meshPackQuantizedFileCount": mesh_pack["quantizedFileCount"],
        "meshPackQuantizeFallbackCount": mesh_pack["quantizeFallbackCount"],
        "meshPackRewrittenReferences": mesh_pack["rewrittenReferences"],
        "meshPackMissingFileCount": len(mesh_pack["missingFiles"]),
        "boundsAnnotatedSubmeshes": bounds_annotated,
        "materialTextureBindingsNormalized": material_bindings_normalized,
        "staleEntryMaterialsCleared": stale_entry_materials_cleared,
    }
    (demo_dir / "spawn_district.json").write_text(json.dumps(descriptor, indent=2) + "\n", encoding="utf-8")
    return descriptor


def main() -> int:
    default_assets = Path(__file__).resolve().parents[1] / "assets"
    default_config = Path(__file__).resolve().parents[1] / "demo_world.json"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets-dir", type=Path, default=default_assets)
    parser.add_argument("--config", type=Path, default=default_config)
    parser.add_argument(
        "--output-demo-dir", type=Path, default=None,
        help="Optional staging directory for generated demo files.",
    )
    parser.add_argument("--center-x", type=float, default=None)
    parser.add_argument("--center-y", type=float, default=None)
    parser.add_argument("--size", type=float, default=None)
    parser.add_argument("--spawn-x", type=float, default=None)
    parser.add_argument("--spawn-y", type=float, default=None)
    parser.add_argument(
        "--spawn-ped-z", "--spawn-ground-z", dest="spawn_ped_z", type=float,
        default=None,
        help="Saved FiveM player root Z (--spawn-ground-z remains a legacy alias).",
    )
    parser.add_argument(
        "--quantize-meshes", action="store_true",
        help="Convert packed world meshes to compact scale-aware MSH10 streams.",
    )
    parser.add_argument(
        "--mesh-pack-mb", type=float, default=6.0,
        help="Maximum transport pack size in MiB (smaller packs improve visible-mesh latency).",
    )
    args = parser.parse_args()
    config = json.loads(args.config.resolve().read_text(encoding="utf-8")) if args.config else {}
    center = config.get("center") if isinstance(config.get("center"), dict) else {}
    spawn = config.get("spawn") if isinstance(config.get("spawn"), dict) else {}
    streaming = config.get("streaming") if isinstance(config.get("streaming"), dict) else {}
    args.center_x = float(args.center_x if args.center_x is not None else center.get("x", DEFAULT_CENTER_X))
    args.center_y = float(args.center_y if args.center_y is not None else center.get("y", DEFAULT_CENTER_Y))
    args.size = float(args.size if args.size is not None else config.get("size", DEFAULT_SIZE))
    args.spawn_x = float(args.spawn_x if args.spawn_x is not None else spawn.get("x", DEFAULT_SPAWN_X))
    args.spawn_y = float(args.spawn_y if args.spawn_y is not None else spawn.get("y", DEFAULT_SPAWN_Y))
    args.spawn_ped_z = float(
        args.spawn_ped_z if args.spawn_ped_z is not None else spawn.get("pedZ", DEFAULT_SPAWN_PED_Z)
    )
    if args.mesh_pack_mb == 6.0 and "meshPackMiB" in streaming:
        args.mesh_pack_mb = float(streaming["meshPackMiB"])
    if args.size <= 0:
        parser.error("--size must be positive")
    result = build(
        args.assets_dir.resolve(),
        args.center_x,
        args.center_y,
        args.size,
        configured_spawn={"x": args.spawn_x, "y": args.spawn_y, "pedZ": args.spawn_ped_z},
        quantize_meshes=args.quantize_meshes,
        mesh_pack_target_bytes=max(0.25, args.mesh_pack_mb) * 1024 * 1024,
        output_demo_dir=args.output_demo_dir.resolve() if args.output_demo_dir else None,
    )
    config_revision = hashlib.sha256(args.config.resolve().read_bytes()).hexdigest()[:16]
    result["worldConfig"] = {
        "schema": str(config.get("schema") or "webglgta-demo-world-config-v1"),
        "file": "demo_world.json",
        "revision": config_revision,
    }
    result_dir = args.output_demo_dir.resolve() if args.output_demo_dir else args.assets_dir.resolve() / "demo"
    (result_dir / "spawn_district.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

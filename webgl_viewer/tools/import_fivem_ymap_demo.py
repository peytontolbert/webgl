#!/usr/bin/env python3
"""Merge ordinary loose FiveM YMAP entities into a browser demo asset stage.

``import_fivem_mlo_demo.py`` intentionally handles only interior roots and their
authored children.  A number of custom resources, including the recording
studio, are ordinary YMAP placements: their meshes are loose YDR files and
their placement data has no MLO root.  This tool resolves that separate form
without inventing a synthetic interior hierarchy.
"""

from __future__ import annotations

import argparse
import copy
import json
import logging
import math
import struct
import sys
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from gta5_modules.dll_manager import DllManager
from gta5_modules.rpf_reader import RpfReader

from build_spawn_district_demo import DEMO_EXCLUDED_LOD_LEVELS
from import_fivem_mlo_demo import (
    _build_texture_banks,
    _export_archetype_drawable,
    _export_game_archetype_drawable,
    _joaat_name,
    _load_global_manifest_entries,
    _merge_texture_maps,
    _read_ent1_records,
    _u32,
    _upgrade_ent1_record,
    _vec,
)


def _asset_path(assets_dir: Path, relative: str) -> Path:
    cleaned = str(relative or "").replace("\\", "/").lstrip("/")
    staged = assets_dir / cleaned
    if staged.is_file():
        return staged
    return assets_dir / "demo" / Path(cleaned).name


def _pack_entity(entity: dict[str, Any]) -> bytes | None:
    if bool(entity.get("isMloInstance")):
        return None
    if str(entity.get("lodLevel") or "").upper() in DEMO_EXCLUDED_LOD_LEVELS:
        return None
    archetype_hash = _u32(entity.get("archetypeHash"))
    if not archetype_hash:
        return None
    position = _vec(entity.get("position"), 3, (0.0, 0.0, 0.0))
    rotation = _vec(entity.get("rotation"), 4, (0.0, 0.0, 0.0, 1.0))
    scale = _vec(entity.get("scale"), 3, (1.0, 1.0, 1.0))
    if not all(math.isfinite(value) for value in (*position, *rotation, *scale)):
        return None
    return struct.pack(
        "<I3f4f3f5I",
        archetype_hash,
        *position,
        *rotation,
        *scale,
        0,
        _u32(entity.get("guid")),
        0,
        0,
        0,
    )


def _audit_entities(audits: list[Path], selected_names: set[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    entities: list[dict[str, Any]] = []
    reports: list[dict[str, Any]] = []
    wanted = {name.lower() for name in selected_names}
    for audit_path in audits:
        payload = json.loads(audit_path.read_text(encoding="utf-8"))
        for ymap in payload.get("ymaps") or []:
            filename = Path(str(ymap.get("file") or "")).name
            if wanted and filename.lower() not in wanted:
                continue
            source = [item for item in (ymap.get("entities") or []) if isinstance(item, dict)]
            packed = [item for item in source if _pack_entity(item) is not None]
            if not source:
                continue
            entities.extend(packed)
            reports.append({
                "file": filename,
                "sourceEntityCount": len(source),
                "importedEntityCount": len(packed),
                "bounds": ymap.get("bounds"),
            })
    if not reports:
        requested = ", ".join(sorted(wanted)) or "any YMAP in the supplied audit"
        raise ValueError(f"No audited entities matched {requested}")
    return entities, reports


def _resolve_meshes(
    *,
    required_hashes: set[str],
    archetypes: dict[str, Any],
    resource_dir: Path,
    assets_dir: Path,
    base_manifest: dict[str, Any],
    game_path: Path,
) -> tuple[dict[str, Any], dict[str, int], int, list[dict[str, str]]]:
    dll = DllManager(str(game_path))
    if not getattr(dll, "initialized", False):
        raise RuntimeError("CodeWalker initialization failed")

    ydr_by_hash = {_u32(_joaat_name(path)): path for path in sorted(resource_dir.rglob("*.ydr"))}
    textures_by_dictionary, fallback_textures, texture_count = _build_texture_banks(dll, resource_dir, assets_dir)
    existing_meshes = dict(base_manifest.get("meshes") or {})
    global_meshes = _load_global_manifest_entries(assets_dir, required_hashes - set(existing_meshes))
    exported: dict[str, Any] = {}
    unresolved: list[dict[str, str]] = []
    sources: Counter[str] = Counter()
    cache = None
    rpf_reader = None
    cache_error = ""
    texture_cache: dict[int, dict[str, Any]] = {}

    def ensure_cache():
        nonlocal cache, rpf_reader, cache_error
        if cache is not None:
            return cache, rpf_reader, ""
        if cache_error:
            return None, None, cache_error
        if not dll.init_game_file_cache():
            cache_error = "GTA GameFileCache initialization failed"
            return None, None, cache_error
        cache = dll.get_game_file_cache()
        if cache is None:
            cache_error = "GTA GameFileCache is unavailable"
            return None, None, cache_error
        rpf_reader = RpfReader(str(game_path), dll)
        return cache, rpf_reader, ""

    for hash_id in sorted(required_hashes, key=int):
        archetype = archetypes.get(hash_id) or {}
        asset_hash = _u32(archetype.get("assetHash"))
        ydr_path = ydr_by_hash.get(asset_hash)
        if ydr_path is not None:
            dictionary_hash = _u32(archetype.get("textureDictionaryHash"))
            texture_map = _merge_texture_maps(fallback_textures, textures_by_dictionary.get(dictionary_hash, {}))
            try:
                entry = _export_archetype_drawable(dll, ydr_path, _u32(hash_id), texture_map, assets_dir)
            except Exception as error:
                unresolved.append({"archetypeHash": hash_id, "assetHash": str(asset_hash), "reason": str(error)})
                continue
            if entry is None:
                unresolved.append({"archetypeHash": hash_id, "assetHash": str(asset_hash), "reason": "drawable has no usable mesh"})
                continue
            exported[hash_id] = entry
            sources["fivem"] += 1
            continue
        if hash_id in existing_meshes:
            sources["demo"] += 1
            continue
        if hash_id in global_meshes:
            exported[hash_id] = global_meshes[hash_id]
            sources["gta"] += 1
            continue
        cache_value, reader, reason = ensure_cache()
        if cache_value is None or reader is None:
            unresolved.append({"archetypeHash": hash_id, "assetHash": str(asset_hash), "reason": reason})
            continue
        try:
            entry, reason = _export_game_archetype_drawable(
                dll,
                cache_value,
                reader,
                _u32(hash_id),
                assets_dir,
                texture_cache,
            )
        except Exception as error:
            entry, reason = None, str(error)
        if entry is None:
            unresolved.append({"archetypeHash": hash_id, "assetHash": str(asset_hash), "reason": reason or "GTA drawable export failed"})
            continue
        exported[hash_id] = entry
        sources["gtaExport"] += 1
    return exported, dict(sources), texture_count, unresolved


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-path", type=Path, required=True)
    parser.add_argument("--resource-dir", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--audit", type=Path, action="append", required=True)
    parser.add_argument("--ymap", action="append", default=[], help="YMAP basename to import. Repeatable.")
    parser.add_argument("--assets-dir", type=Path, required=True)
    parser.add_argument("--bounds", type=float, nargs=4, metavar=("MIN_X", "MIN_Y", "MAX_X", "MAX_Y"))
    args = parser.parse_args()

    assets_dir = args.assets_dir.resolve()
    descriptor_path = assets_dir / "demo" / "spawn_district.json"
    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
    instance_path = _asset_path(assets_dir, str(descriptor.get("instanceFile") or ""))
    manifest_path = _asset_path(assets_dir, str(descriptor.get("manifestFile") or ""))
    if not instance_path.is_file() or not manifest_path.is_file():
        raise FileNotFoundError("The stage does not contain the descriptor's active entity stream and manifest")
    metadata = json.loads(args.metadata.resolve().read_text(encoding="utf-8"))
    archetypes = metadata.get("archetypes") or {}
    if not isinstance(archetypes, dict):
        raise ValueError("metadata has no archetype table")
    entities, reports = _audit_entities([path.resolve() for path in args.audit], set(args.ymap))
    required_hashes = {str(_u32(entity.get("archetypeHash"))) for entity in entities}
    base_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    logging.disable(logging.CRITICAL)
    exported, sources, texture_count, unresolved = _resolve_meshes(
        required_hashes=required_hashes,
        archetypes=archetypes,
        resource_dir=args.resource_dir.resolve(),
        assets_dir=assets_dir,
        base_manifest=base_manifest,
        game_path=args.game_path.resolve(),
    )
    if unresolved:
        details = ", ".join(item["archetypeHash"] for item in unresolved[:12])
        raise RuntimeError(f"Refusing partial YMAP import; unresolved archetypes: {details}")

    records, stride = _read_ent1_records(instance_path)
    output = [_upgrade_ent1_record(record, stride) for record in records]
    seen = {record[:44] for record in output}
    added = 0
    duplicates = 0
    for entity in entities:
        record = _pack_entity(entity)
        if record is None:
            continue
        signature = record[:44]
        if signature in seen:
            duplicates += 1
            continue
        seen.add(signature)
        output.append(record)
        added += 1

    temporary = instance_path.with_suffix(instance_path.suffix + ".tmp")
    with temporary.open("wb") as stream:
        stream.write(b"ENT1")
        stream.write(struct.pack("<I", len(output)))
        stream.writelines(output)
    temporary.replace(instance_path)

    merged_manifest = copy.deepcopy(base_manifest)
    merged_manifest.setdefault("meshes", {}).update(exported)
    generic_import = merged_manifest.setdefault("ymapImport", {})
    generic_import["meshSources"] = sources
    generic_import["textureCount"] = texture_count
    generic_import["reports"] = reports
    manifest_path.write_text(json.dumps(merged_manifest, separators=(",", ":")), encoding="utf-8")

    output_descriptor = copy.deepcopy(descriptor)
    output_descriptor["instanceCount"] = len(output)
    output_descriptor["recordStride"] = 64
    output_descriptor.setdefault("mloImport", {}).setdefault("genericYmapImports", []).append({
        "maps": reports,
        "addedEntityCount": added,
        "duplicateEntityCount": duplicates,
        "uniqueArchetypeCount": len(required_hashes),
        "meshSources": sources,
        "textureCount": texture_count,
    })
    if args.bounds:
        min_x, min_y, max_x, max_y = args.bounds
        if not min_x < max_x or not min_y < max_y:
            raise ValueError("bounds must have positive extent")
        output_descriptor["bounds"] = {"minX": min_x, "minY": min_y, "maxX": max_x, "maxY": max_y}
        output_descriptor["size"] = max(max_x - min_x, max_y - min_y)
    static_supermesh = output_descriptor.get("staticSupermesh")
    if isinstance(static_supermesh, dict):
        static_supermesh["enabled"] = False
        static_supermesh["staleReason"] = "ordinary-ymap-import"
    descriptor_path.write_text(json.dumps(output_descriptor, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "maps": [report["file"] for report in reports],
        "addedEntities": added,
        "duplicates": duplicates,
        "archetypes": len(required_hashes),
        "meshSources": sources,
        "textureCount": texture_count,
        "instanceCount": len(output),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

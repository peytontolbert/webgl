#!/usr/bin/env python3
"""Validate the runtime dependency closure of a packaged WebGL GTA demo."""

from __future__ import annotations

import argparse
import json
import re
import struct
from pathlib import Path
from typing import Any


ASSET_PREFIXES = (
    "audio/",
    "collision/",
    "custom_clothing/",
    "custom_vehicles/",
    "custom_weapons/",
    "demo/",
    "emotes/",
    "gta_audio/",
    "inventory/",
    "meta/",
    "mlo_textures/",
    "models/",
    "models_textures/",
    "navigation/",
    "nexus-resources/",
    "nexus_inventory/",
    "nx-items/",
    "peds/",
    "physics/",
    "tracks/",
    "vehicle_audio/",
)
PACK_REF_RE = re.compile(r"^@demo-pack/(?P<file>[^#]+)(?:#(?P<offset>\d+):(?P<length>\d+))?$")
MESH_SUFFIXES = (".bin", ".bin.gz")


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def iter_strings(value: Any):
    if isinstance(value, dict):
        for child in value.values():
            yield from iter_strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_strings(child)
    elif isinstance(value, str):
        yield value.replace("\\", "/").lstrip("/")


def asset_reference(value: str) -> tuple[str, int | None, int | None] | None:
    pack = PACK_REF_RE.match(value)
    if pack:
        return (
            f"demo/{pack.group('file')}",
            int(pack.group("offset")) if pack.group("offset") else None,
            int(pack.group("length")) if pack.group("length") else None,
        )
    clean = value.split("?", 1)[0]
    if (clean == "demo_world.json" or clean.startswith(ASSET_PREFIXES)) and Path(clean).suffix:
        return clean, None, None
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path, help="Packaged assets directory")
    parser.add_argument("--demo-dir", type=Path, default=None)
    parser.add_argument("--collision-dir", type=Path, default=None)
    parser.add_argument("--navigation-dir", type=Path, default=None)
    parser.add_argument(
        "--fallback-assets-dir",
        type=Path,
        default=None,
        help="Secondary thin-release asset root used by the server for non-world assets.",
    )
    parser.add_argument(
        "--world-overlay",
        action="store_true",
        help="Validate a world-only overlay without requiring gameplay-base ped animation packs.",
    )
    args = parser.parse_args()
    root = args.root.resolve()
    demo_dir = args.demo_dir.resolve() if args.demo_dir else root / "demo"
    collision_dir = args.collision_dir.resolve() if args.collision_dir else root / "collision"
    navigation_dir = args.navigation_dir.resolve() if args.navigation_dir else root / "navigation"
    fallback_assets_dir = args.fallback_assets_dir.resolve() if args.fallback_assets_dir else None

    def resolve_asset(relative: str) -> Path:
        clean = str(relative).replace("\\", "/").lstrip("/")
        if clean.startswith("demo/"):
            staged = demo_dir / clean.removeprefix("demo/")
            return staged if staged.is_file() else root / clean
        if clean.startswith("collision/"):
            return collision_dir / clean.removeprefix("collision/")
        if clean.startswith("navigation/"):
            return navigation_dir / clean.removeprefix("navigation/")
        primary = root / clean
        if primary.is_file() or fallback_assets_dir is None:
            return primary
        return fallback_assets_dir / clean

    descriptor_path = demo_dir / "spawn_district.json"
    descriptor = load_json(descriptor_path)

    json_queue = [descriptor_path]
    conventional_json = [
        "models/manifest_index.json",
        "models/non_renderable_archetypes.json",
        "meta/steps.json",
        "custom_vehicles/catalog.json",
    ]
    world_config_rel = str((descriptor.get("worldConfig") or {}).get("file") or "demo_world.json")
    conventional_json.append(world_config_rel)
    conventional_json.extend(
        f"interiors/{interior_hash}.json"
        for interior_hash in (descriptor.get("mloRuntime") or {}).get("interiorArchetypeHashes") or []
    )
    ped_models = (
        "1885233650",
        "1581098148",
        "1068876755",
        "1446741360",
        "3014915558",
        "3250873975",
        "826475330",
    )
    required_ped_manifests = [
        f"peds/{model_hash}_{kind}.json"
        for model_hash in ped_models
        for kind in ("skeleton", "animations", "combat_animations", "melee_animations")
    ]
    for rel in (
        "collision/ybn_spawn.json",
        "navigation/demo_navmesh.json",
        *required_ped_manifests,
    ):
        path = resolve_asset(rel)
        if path.is_file():
            json_queue.append(path)

    seen_json: set[Path] = set()
    references: dict[str, set[str]] = {}
    ranges: list[tuple[str, int, int, str]] = []
    parse_errors: list[str] = []
    for rel in conventional_json:
        references.setdefault(rel, set()).add("runtime-convention")
        path = resolve_asset(rel)
        if path.is_file():
            json_queue.append(path)
    while json_queue:
        source = json_queue.pop()
        if source in seen_json:
            continue
        seen_json.add(source)
        try:
            payload = load_json(source)
        except Exception as error:
            parse_errors.append(f"{source.relative_to(root)}: {error}")
            continue
        try:
            source_rel = source.relative_to(root).as_posix()
        except ValueError:
            source_rel = f"fallback/{source.name}"
        for value in iter_strings(payload):
            ref = asset_reference(value)
            if not ref:
                continue
            rel, offset, length = ref
            if (
                source_rel.startswith("custom_vehicles/")
                and rel.startswith("custom_vehicles/")
                and rel.lower().endswith((".bin", ".bin.gz", ".msh9.gz"))
            ):
                rel = f"models/{rel}"
            references.setdefault(rel, set()).add(source_rel)
            if offset is not None and length is not None:
                ranges.append((rel, offset, length, source_rel))
            if rel.endswith(".json"):
                candidate = resolve_asset(rel)
                if candidate.is_file() and candidate not in seen_json:
                    json_queue.append(candidate)

    index_rel = str(descriptor.get("instanceIndexFile") or "demo/spawn_district_entities_index.json")
    index_path = resolve_asset(index_rel)
    index = load_json(index_path)
    chunk_total = 0
    for chunk in (index.get("chunks") or {}).values():
        rel = str(chunk.get("binaryFile") or "").replace("\\", "/")
        if rel:
            references.setdefault(rel, set()).add(index_rel)
        chunk_total += int(chunk.get("count") or 0)

    missing = {
        rel: sorted(sources)
        for rel, sources in references.items()
        if not resolve_asset(rel).is_file()
    }
    invalid_ranges = []
    for rel, offset, length, source in ranges:
        path = resolve_asset(rel)
        if path.is_file() and offset + length > path.stat().st_size:
            invalid_ranges.append({
                "file": rel,
                "offset": offset,
                "length": length,
                "bytes": path.stat().st_size,
                "source": source,
            })

    entity_file = demo_dir / "spawn_district_entities_mlo.bin"
    entity_count = None
    if entity_file.is_file():
        with entity_file.open("rb") as stream:
            header = stream.read(8)
        if len(header) == 8 and header[:4] == b"ENT1":
            entity_count = struct.unpack_from("<I", header, 4)[0]

    manifest_rel = str(descriptor.get("manifestFile") or "")
    manifest_path = resolve_asset(manifest_rel)
    manifest = load_json(manifest_path) if manifest_rel and manifest_path.is_file() else {}
    runtime_loose_mesh_references = sorted({
        value
        for entry in (manifest.get("meshes") or {}).values()
        for value in iter_strings(entry)
        if value.lower().endswith(MESH_SUFFIXES) and not PACK_REF_RE.match(value)
    })
    texture_compression = manifest.get("textureCompression") or {}
    unresolved_textures = int(texture_compression.get("unresolvedReferences") or 0)
    unresolved_texture_refs = {
        rel: sources for rel, sources in missing.items() if rel.startswith("models_textures/")
    }
    hard_missing = {
        rel: sources for rel, sources in missing.items() if rel not in unresolved_texture_refs
    }
    unresolved_texture_count_matches = len(unresolved_texture_refs) == unresolved_textures

    missing_ped_assets = [rel for rel in required_ped_manifests if not resolve_asset(rel).is_file()]
    descriptor_count = int(descriptor.get("instanceCount") or 0)
    index_count = int(index.get("total_entities") or 0)
    count_consistent = bool(descriptor_count and descriptor_count == index_count == chunk_total == entity_count)

    report = {
        "schema": "webglgta-demo-release-closure-v1",
        "demoSize": descriptor.get("size"),
        "bounds": descriptor.get("bounds"),
        "descriptorEntities": descriptor_count,
        "entityChunks": len(index.get("chunks") or {}),
        "chunkEntities": chunk_total,
        "binaryEntities": entity_count,
        "entityCountsConsistent": count_consistent,
        "manifestMeshes": len(manifest.get("meshes") or {}),
        "runtimeLooseMeshReferences": {
            "count": len(runtime_loose_mesh_references),
            "samples": runtime_loose_mesh_references[:20],
        },
        "referencedFiles": len(references),
        "checkedJsonFiles": len(seen_json),
        "checkedPackRanges": len(ranges),
        "missingReferences": hard_missing,
        "knownUnresolvedTextureReferences": {
            "count": len(unresolved_texture_refs),
            "manifestCount": unresolved_textures,
            "countMatchesManifest": unresolved_texture_count_matches,
            "samples": sorted(unresolved_texture_refs)[:10],
        },
        "invalidPackRanges": invalid_ranges,
        "missingPedAssets": missing_ped_assets,
        "unresolvedTextureBindings": unresolved_textures,
        "jsonParseErrors": parse_errors,
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    hard_failure = bool(
        hard_missing
        or runtime_loose_mesh_references
        or invalid_ranges
        or (missing_ped_assets and not args.world_overlay)
        or parse_errors
        or not count_consistent
        or not unresolved_texture_count_matches
    )
    return 1 if hard_failure else 0


if __name__ == "__main__":
    raise SystemExit(main())

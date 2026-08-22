#!/usr/bin/env python3
"""Replace a GTA demo map cell with a loose FiveM resource YMAP."""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
from pathlib import Path
from typing import Any

from build_spawn_district_demo import DEMO_EXCLUDED_LOD_LEVELS
from import_fivem_mlo_demo import _read_ent1_records


def _vec(values: Any, size: int, fallback: tuple[float, ...]) -> tuple[float, ...]:
    if not isinstance(values, (list, tuple)) or len(values) < size:
        return fallback
    try:
        return tuple(float(values[index]) for index in range(size))
    except (TypeError, ValueError):
        return fallback


def _basename_key(path: object) -> str:
    filename = str(path or "").strip().replace("\\", "/").rsplit("/", 1)[-1].lower()
    return filename[4:] if filename.startswith("hei_") else filename


def _source_signatures_by_overlay(
    assets_dir: Path,
    overlay_keys: set[str],
    bounds: dict[str, Any],
) -> dict[str, set[bytes]]:
    index = json.loads((assets_dir / "entities_index.json").read_text(encoding="utf-8"))
    signatures = {key: set() for key in overlay_keys}
    chunk_size = float(index.get("chunk_size") or 512.0)
    min_chunk_x = int(float(bounds.get("minX", 0.0)) // chunk_size)
    max_chunk_x = int(float(bounds.get("maxX", 0.0)) // chunk_size)
    min_chunk_y = int(float(bounds.get("minY", 0.0)) // chunk_size)
    max_chunk_y = int(float(bounds.get("maxY", 0.0)) // chunk_size)
    for chunk_key, metadata in (index.get("chunks") or {}).items():
        try:
            chunk_x, chunk_y = (int(value) for value in chunk_key.split("_", 1))
        except (TypeError, ValueError):
            continue
        if not (min_chunk_x <= chunk_x <= max_chunk_x and min_chunk_y <= chunk_y <= max_chunk_y):
            continue
        filename = str(metadata.get("file") or "").strip()
        if not filename:
            continue
        rows_path = assets_dir / "entities_chunks" / filename
        records_path = assets_dir / "entities_chunks_inst" / filename.replace(".jsonl", ".bin")
        records, stride = _read_ent1_records(records_path)
        rows: list[dict[str, Any]] = []
        with rows_path.open("r", encoding="utf-8", errors="ignore") as source:
            for line in source:
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(row, dict):
                    rows.append(row)
        if len(rows) != len(records):
            raise ValueError(f"ENT1/JSONL mismatch for {filename}: {len(records)} != {len(rows)}")
        for row, record in zip(rows, records):
            key = _basename_key(row.get("ymap"))
            if key in signatures:
                signatures[key].add(record[: min(stride, 44)])
    return signatures


def _pack_entity(entity: dict[str, Any], bounds: dict[str, Any]) -> bytes | None:
    # Imported MLO roots carry room/portal ownership in the extended ENT1
    # fields. Keep those enriched records; this pass only replaces exterior
    # world entities authored alongside the interior.
    if bool(entity.get("isMloInstance")):
        return None
    lod_level = str(entity.get("lodLevel") or "").strip().upper()
    if lod_level in DEMO_EXCLUDED_LOD_LEVELS:
        return None
    hash_id = int(entity.get("archetypeHash") or 0) & 0xFFFFFFFF
    if not hash_id:
        return None
    position = _vec(entity.get("position"), 3, (0.0, 0.0, 0.0))
    if not (
        float(bounds.get("minX", float("-inf"))) <= position[0] <= float(bounds.get("maxX", float("inf")))
        and float(bounds.get("minY", float("-inf"))) <= position[1] <= float(bounds.get("maxY", float("inf")))
    ):
        return None
    rotation = _vec(entity.get("rotation"), 4, (0.0, 0.0, 0.0, 1.0))
    scale = _vec(entity.get("scale"), 3, (1.0, 1.0, 1.0))
    guid = int(entity.get("guid") or 0) & 0xFFFFFFFF
    return struct.pack(
        "<I3f4f3f5I",
        hash_id,
        *position,
        *rotation,
        *scale,
        0,
        guid,
        0,
        0,
        0,
    )


def _dedupe_records(records: list[bytes]) -> tuple[list[bytes], int]:
    """Keep the first record for each render-equivalent ENT1 signature."""
    unique: dict[bytes, bytes] = {}
    for record in records:
        unique.setdefault(record[:44], record)
    return list(unique.values()), len(records) - len(unique)


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--ymap", action="append", required=True, help="YMAP filename represented by the audit. Repeat for a complete resource takeover.")
    parser.add_argument("--descriptor", type=Path, default=root / "assets/demo/spawn_district.json")
    parser.add_argument("--dry-run", action="store_true", help="Report source/replacement differences without changing generated assets.")
    args = parser.parse_args()

    descriptor_path = args.descriptor.resolve()
    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
    assets_dir = descriptor_path.parents[1]
    instance_path = descriptor_path.parent / Path(str(descriptor["instanceFile"])).name
    if not instance_path.is_file():
        instance_path = assets_dir / str(descriptor["instanceFile"])
    records, stride = _read_ent1_records(instance_path)
    if stride != 64:
        raise ValueError(f"Expected a 64-byte MLO ENT1, got {stride}")

    audit = json.loads(args.audit.resolve().read_text(encoding="utf-8"))
    reports_by_name = {
        Path(str(item.get("file") or "")).name.lower(): item
        for item in (audit.get("ymaps") or [])
    }
    requested_names = list(dict.fromkeys(Path(value).name.lower() for value in args.ymap))
    missing_reports = [name for name in requested_names if name not in reports_by_name]
    if missing_reports:
        raise ValueError(f"Audit does not contain: {', '.join(missing_reports)}")
    overlay_keys = {_basename_key(name) for name in requested_names}
    bounds = descriptor.get("bounds") or {}
    source_by_overlay = _source_signatures_by_overlay(assets_dir, overlay_keys, bounds)
    # Validate replacement entities against the active post-import manifest.
    # sourceManifestFile intentionally points at the pristine world and cannot
    # contain loose resource drawables exported by import_fivem_mlo_demo.py.
    manifest_rel = str(descriptor.get("manifestFile") or descriptor.get("sourceManifestFile") or "")
    manifest_path = assets_dir / manifest_rel.removeprefix("assets/")
    if not manifest_path.is_file():
        manifest_path = descriptor_path.parent / Path(manifest_rel).name
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    meshes = manifest.get("meshes") or {}
    non_renderable = set(map(str, manifest.get("nonRenderableHashes") or []))
    output = list(records)
    details = []
    for requested_name in requested_names:
        report = reports_by_name[requested_name]
        entities = report.get("entities") or []
        if not entities or not all("rotation" in entity and "lodLevel" in entity for entity in entities):
            raise ValueError(f"YMAP audit for {requested_name} lacks full transform/LOD fields")
        overlay_key = _basename_key(requested_name)
        source_signatures = source_by_overlay.get(overlay_key, set())
        packed_replacements = [record for entity in entities if (record := _pack_entity(entity, bounds)) is not None]
        replacements, duplicate_count = _dedupe_records(packed_replacements)
        replacement_signatures = {record[:44] for record in replacements}
        previous_count = len(output)
        output = [
            record for record in output
            if record[:44] not in source_signatures and record[:44] not in replacement_signatures
        ]
        removed = previous_count - len(output)
        output.extend(replacements)
        source_only = source_signatures - replacement_signatures
        replacement_only = replacement_signatures - source_signatures
        replacement_hashes = {str(struct.unpack_from("<I", record, 0)[0]) for record in replacements}
        missing_hashes = sorted(
            (hash_id for hash_id in replacement_hashes if hash_id not in meshes and hash_id not in non_renderable),
            key=int,
        )
        details.append({
            "ymap": requested_name,
            "overlayKey": overlay_key,
            "sourceSignatureCount": len(source_signatures),
            "replacementSignatureCount": len(replacement_signatures),
            "sourceOnlyCount": len(source_only),
            "replacementOnlyCount": len(replacement_only),
            "removedCurrentInstanceCount": removed,
            "retainedResourceEntityCount": len(replacements),
            "duplicateResourceEntityCount": duplicate_count,
            "missingModelHashes": missing_hashes,
        })

    missing_models = sorted({hash_id for item in details for hash_id in item["missingModelHashes"]}, key=int)
    if missing_models and not args.dry_run:
        raise ValueError(f"Replacement YMAPs reference {len(missing_models)} unavailable model hashes: {missing_models[:12]}")

    summary = {
        "schema": "webglgta-fivem-ymap-takeover-v2",
        "dryRun": args.dry_run,
        "inputInstanceCount": len(records),
        "outputInstanceCount": len(output),
        "maps": details,
        "missingModelHashes": missing_models,
    }
    if not args.dry_run:
        temporary = instance_path.with_suffix(instance_path.suffix + ".tmp")
        with temporary.open("wb") as handle:
            handle.write(b"ENT1")
            handle.write(struct.pack("<I", len(output)))
            handle.writelines(output)
        temporary.replace(instance_path)
        takeover_revision = hashlib.sha256(instance_path.read_bytes()).hexdigest()[:16]
        descriptor["instanceCount"] = len(output)
        mlo_import = descriptor.setdefault("mloImport", {})
        mlo_import["resourceYmapOverrides"] = details
        mlo_import["takeoverRevision"] = takeover_revision
        mlo_import.pop("resourceYmapOverride", None)
        static_supermesh = descriptor.get("staticSupermesh")
        if isinstance(static_supermesh, dict):
            static_supermesh["enabled"] = False
            static_supermesh["staleReason"] = "source-entities-changed"
        descriptor_path.write_text(json.dumps(descriptor, indent=2) + "\n", encoding="utf-8")
        (descriptor_path.parent / "spawn_district_ymap_override.json").write_text(
            json.dumps(summary, indent=2) + "\n",
            encoding="utf-8",
        )
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

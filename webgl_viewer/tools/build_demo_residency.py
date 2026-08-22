#!/usr/bin/env python3
"""Build a bounded, chunked /demo residency set from an existing ENT1 stream.

The source stream can contain FiveM MLO children and other authored additions.
Records are preserved byte-for-byte. When CodeWalker JSONL entity metadata is
available, GTA YMAP LOD parents are removed for the close-range demo so their
HD leaf children are not rendered on top of them. The output uses the same
256 m chunk-index format consumed by DrawableStreamer.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import struct
from pathlib import Path


def read_ent1(path: Path) -> tuple[int, list[bytes]]:
    raw = path.read_bytes()
    if len(raw) < 8 or raw[:4] != b"ENT1":
        raise ValueError(f"not an ENT1 file: {path}")
    count = struct.unpack_from("<I", raw, 4)[0]
    if count <= 0 or (len(raw) - 8) % count:
        raise ValueError(f"invalid ENT1 payload: {path}")
    stride = (len(raw) - 8) // count
    if stride not in (44, 48, 64):
        raise ValueError(f"unsupported ENT1 record stride: {stride}")
    return stride, [raw[8 + i * stride:8 + (i + 1) * stride] for i in range(count)]


def write_ent1(path: Path, records: list[bytes]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        handle.write(b"ENT1")
        handle.write(struct.pack("<I", len(records)))
        for record in records:
            handle.write(record)


def record_position(record: bytes) -> tuple[float, float, float]:
    return struct.unpack_from("<3f", record, 4)


def record_hash(record: bytes) -> str:
    return str(struct.unpack_from("<I", record, 0)[0])


def record_identity(record: bytes) -> tuple[int, ...]:
    """Stable key shared by ENT1 records and CodeWalker JSONL entity entries."""
    h = struct.unpack_from("<I", record, 0)[0]
    values = struct.unpack_from("<10f", record, 4)
    # CodeWalker emits the same source floats as decimal JSON. Quantizing to
    # 1e-4 tolerates JSON conversion without merging nearby repeated props.
    return (h, *(round(value * 10000.0) for value in values))


def raw_entity_identity(entry: dict) -> tuple[int, ...] | None:
    try:
        h = int(entry.get("archetype_hash", entry.get("archetype")))
        position = entry["position"]
        rotation = entry["rotation_quat"]
        scale = entry.get("scale", [1.0, 1.0, 1.0])
        values = [*position, *rotation, *scale]
        if len(values) != 10:
            return None
        return (h, *(round(float(value) * 10000.0) for value in values))
    except (KeyError, TypeError, ValueError):
        return None


def resolve_lod_parent_records(records: list[bytes], hierarchy_root: Path) -> tuple[set[int], dict]:
    """Return source-record indexes that are proven GTA YMAP LOD parents.

    The compact ENT1 format intentionally omits source YMAP identity. The
    CodeWalker JSONL source retains it, including ``parent_index``. We only
    suppress a record if every matching source entity identifies it as a
    parent referenced by another entity in the same YMAP. Ambiguous matches
    remain visible rather than risking removal of authored geometry.
    """
    if not hierarchy_root.is_dir():
        raise ValueError(f"hierarchy root is not a directory: {hierarchy_root}")

    source_by_identity: dict[tuple[int, ...], list[int]] = {}
    for index, record in enumerate(records):
        source_by_identity.setdefault(record_identity(record), []).append(index)

    matches: dict[int, list[tuple[str, int, str]]] = {}
    referenced_parents: set[tuple[str, int]] = set()
    scanned_files = 0
    scanned_entities = 0
    malformed_lines = 0
    for path in sorted(hierarchy_root.glob("*.jsonl")):
        scanned_files += 1
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    malformed_lines += 1
                    continue
                scanned_entities += 1
                ymap = str(entry.get("ymap") or "")
                parent_index = int(entry.get("parent_index", -1))
                if ymap and parent_index >= 0:
                    referenced_parents.add((ymap, parent_index))
                identity = raw_entity_identity(entry)
                indexes = source_by_identity.get(identity or ())
                if not indexes or not ymap:
                    continue
                try:
                    entity_index = int(entry.get("ymap_entity_index", -1))
                except (TypeError, ValueError):
                    entity_index = -1
                for index in indexes:
                    matches.setdefault(index, []).append((ymap, entity_index, str(entry.get("name") or "")))

    suppressed: set[int] = set()
    ambiguous = 0
    parent_details: list[dict] = []
    for index, candidates in matches.items():
        unique = {(ymap, entity_index, name) for ymap, entity_index, name in candidates}
        if not unique:
            continue
        parent_candidates = [candidate for candidate in unique if (candidate[0], candidate[1]) in referenced_parents]
        if not parent_candidates:
            continue
        # A duplicated entity from a different YMAP can share the same exact
        # transform. Suppress only when every source candidate agrees it is a
        # hierarchy parent; keeping ambiguous data is visually safer.
        if len(parent_candidates) != len(unique):
            ambiguous += 1
            continue
        suppressed.add(index)
        x, y, z = record_position(records[index])
        parent_details.append({
            "hash": record_hash(records[index]),
            "position": [x, y, z],
            "sources": [
                {"ymap": ymap, "entityIndex": entity_index, "name": name}
                for ymap, entity_index, name in sorted(parent_candidates)
            ],
        })

    return suppressed, {
        "schema": "webglgta-demo-lod-parent-audit-v1",
        "hierarchyRoot": str(hierarchy_root),
        "scannedFiles": scanned_files,
        "scannedEntities": scanned_entities,
        "malformedLines": malformed_lines,
        "matchedSourceRecords": len(matches),
        "suppressedParentRecords": len(suppressed),
        "ambiguousRecordsKept": ambiguous,
        "suppressed": parent_details,
    }


def build(
    source: Path,
    output_file: Path,
    chunk_dir: Path,
    index_file: Path,
    manifest_source: Path,
    manifest_output: Path,
    *,
    center_x: float,
    center_y: float,
    size: float,
    chunk_size: float,
    min_z: float | None,
    max_z: float | None,
    hierarchy_root: Path | None,
    hierarchy_audit_file: Path | None,
    excluded_hashes: set[str],
) -> dict:
    stride, source_records = read_ent1(source)
    half = size * 0.5
    bounds = {
        "min_x": center_x - half,
        "min_y": center_y - half,
        "max_x": center_x + half,
        "max_y": center_y + half,
    }

    def in_bounds(record: bytes) -> bool:
        x, y, z = record_position(record)
        return (
            bounds["min_x"] <= x <= bounds["max_x"]
            and bounds["min_y"] <= y <= bounds["max_y"]
            and (min_z is None or z >= min_z)
            and (max_z is None or z <= max_z)
        )

    kept = [
        record for record in source_records
        if in_bounds(record) and record_hash(record) not in excluded_hashes
    ]
    if not kept:
        raise ValueError("the requested bounds retained no ENT1 records")

    hierarchy_audit = None
    if hierarchy_root:
        lod_parent_indexes, hierarchy_audit = resolve_lod_parent_records(kept, hierarchy_root)
        kept = [record for index, record in enumerate(kept) if index not in lod_parent_indexes]
        if not kept:
            raise ValueError("hierarchy filtering retained no ENT1 records")
        if hierarchy_audit_file:
            hierarchy_audit_file.parent.mkdir(parents=True, exist_ok=True)
            hierarchy_audit_file.write_text(json.dumps(hierarchy_audit, indent=2), encoding="utf-8")

    write_ent1(output_file, kept)
    if chunk_dir.exists():
        shutil.rmtree(chunk_dir)
    chunk_dir.mkdir(parents=True, exist_ok=True)
    by_chunk: dict[str, list[bytes]] = {}
    for record in kept:
        x, y, _ = record_position(record)
        key = f"{math.floor(x / chunk_size)}_{math.floor(y / chunk_size)}"
        by_chunk.setdefault(key, []).append(record)

    chunks: dict[str, dict] = {}
    for key, records in sorted(by_chunk.items()):
        filename = f"{key}.bin"
        write_ent1(chunk_dir / filename, records)
        chunks[key] = {
            "count": len(records),
            "file": filename,
            "binaryFile": f"demo/{chunk_dir.name}/{filename}",
        }

    z_values = [record_position(record)[2] for record in kept]
    index = {
        "version": 1,
        "schema": "webglgta-demo-entity-chunks-v1",
        "revision": f"district-{size:g}m",
        "chunk_size": chunk_size,
        "chunks_dir": f"demo/{chunk_dir.name}",
        "total_entities": len(kept),
        "bounds": {
            **bounds,
            "min_z": min(z_values),
            "max_z": max(z_values),
        },
        "chunks": chunks,
    }
    index_file.write_text(json.dumps(index, separators=(",", ":")), encoding="utf-8")

    source_manifest = json.loads(manifest_source.read_text(encoding="utf-8"))
    active_hashes = {record_hash(record) for record in kept}
    meshes = source_manifest.get("meshes")
    if not isinstance(meshes, dict):
        raise ValueError(f"manifest has no meshes map: {manifest_source}")
    filtered = dict(source_manifest)
    filtered["meshes"] = {key: value for key, value in meshes.items() if str(key) in active_hashes}
    manifest_output.write_text(json.dumps(filtered, separators=(",", ":")), encoding="utf-8")

    return {
        "sourceEntities": len(source_records),
        "retainedEntities": len(kept),
        "recordStride": stride,
        "chunkCount": len(chunks),
        "retainedArchetypes": len(active_hashes),
        "manifestArchetypes": len(filtered["meshes"]),
        "bounds": bounds,
        "verticalBounds": {"min_z": min_z, "max_z": max_z},
        "excludedHashes": sorted(excluded_hashes),
        "lodParentAudit": hierarchy_audit,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output-file", type=Path, required=True)
    parser.add_argument("--chunk-dir", type=Path, required=True)
    parser.add_argument("--index-file", type=Path, required=True)
    parser.add_argument("--manifest-source", type=Path, required=True)
    parser.add_argument("--manifest-output", type=Path, required=True)
    parser.add_argument("--center-x", type=float, default=186.94)
    parser.add_argument("--center-y", type=float, default=-850.84)
    parser.add_argument("--size", type=float, default=300.0)
    parser.add_argument("--chunk-size", type=float, default=256.0)
    parser.add_argument("--min-z", type=float, default=None)
    parser.add_argument("--max-z", type=float, default=None)
    parser.add_argument("--hierarchy-root", type=Path, default=None,
                        help="CodeWalker JSONL entity directory used to remove parent LOD records")
    parser.add_argument("--hierarchy-audit-file", type=Path, default=None,
                        help="optional JSON report for hierarchy filtering")
    parser.add_argument("--exclude-hash", action="append", default=[],
                        help="archetype hash to exclude (repeatable; diagnostic export use)")
    args = parser.parse_args()
    if args.size <= 0 or args.chunk_size <= 0:
        parser.error("size and chunk size must be positive")
    print(json.dumps(build(
        args.source,
        args.output_file,
        args.chunk_dir,
        args.index_file,
        args.manifest_source,
        args.manifest_output,
        center_x=args.center_x,
        center_y=args.center_y,
        size=args.size,
        chunk_size=args.chunk_size,
        min_z=args.min_z,
        max_z=args.max_z,
        hierarchy_root=args.hierarchy_root,
        hierarchy_audit_file=args.hierarchy_audit_file,
        excluded_hashes={str(value).strip() for value in args.exclude_hash if str(value).strip()},
    ), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

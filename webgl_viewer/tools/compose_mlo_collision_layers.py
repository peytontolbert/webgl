#!/usr/bin/env python3
"""Overlay destination YBN chunks onto a deployed static-collision manifest.

Only overlay chunk records and material indices are rewritten. Unrelated base
chunk files remain referenced in place, so the 4 km city package is untouched.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import struct


HEADER = struct.Struct("<4sIIIIIII")


def canonical(record: object) -> str:
    return json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def quantize(value: float, low: float, high: float) -> int:
    return max(0, min(65535, round((value - low) * 65535.0 / (high - low))))


def remap_chunk(path: Path, material_map: list[int], source_geometry: dict, target_geometry: dict) -> bytes:
    data = bytearray(path.read_bytes())
    if len(data) < 48:
        raise ValueError(f"{path}: truncated CWCT")
    magic, version, flags, vertex_count, triangle_count, _ground_refs, _wall_refs, _cells = HEADER.unpack_from(data, 0)
    if magic != b"CWCT" or version != 4:
        raise ValueError(f"{path}: unsupported CWCT header")
    source_min_x = float(source_geometry["min_x"])
    source_min_y = float(source_geometry["min_y"])
    source_span_x = float(source_geometry["max_x"]) - source_min_x
    source_span_y = float(source_geometry["max_y"]) - source_min_y
    target_min_x = float(target_geometry["min_x"])
    target_min_y = float(target_geometry["min_y"])
    target_max_x = float(target_geometry["max_x"])
    target_max_y = float(target_geometry["max_y"])
    if min(source_span_x, source_span_y, target_max_x - target_min_x, target_max_y - target_min_y) <= 0:
        raise ValueError(f"{path}: invalid source/target geometry bounds")
    for vertex in range(vertex_count):
        offset = 48 + vertex * 6
        source_x = source_min_x + struct.unpack_from("<H", data, offset)[0] / 65535.0 * source_span_x
        source_y = source_min_y + struct.unpack_from("<H", data, offset + 2)[0] / 65535.0 * source_span_y
        struct.pack_into("<H", data, offset, quantize(source_x, target_min_x, target_max_x))
        struct.pack_into("<H", data, offset + 2, quantize(source_y, target_min_y, target_max_y))

    index_bytes = 4 if flags & 1 else 2
    material_offset = 48 + vertex_count * 3 * 2 + triangle_count * 3 * index_bytes
    material_end = material_offset + triangle_count * 2
    if material_end > len(data):
        raise ValueError(f"{path}: truncated material channel")
    for offset in range(material_offset, material_end, 2):
        source_index = struct.unpack_from("<H", data, offset)[0]
        if source_index >= len(material_map):
            raise ValueError(f"{path}: material {source_index} is outside overlay palette")
        struct.pack_into("<H", data, offset, material_map[source_index])
    return bytes(data)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-manifest", type=Path, required=True)
    parser.add_argument("--base-metadata", type=Path, help="Original base YBNC metadata for provenance.")
    parser.add_argument("--overlay", action="append", nargs=2, metavar=("LABEL", "MANIFEST"), required=True)
    parser.add_argument(
        "--overlay-metadata", action="append", nargs=2,
        metavar=("LABEL", "SOURCE_METADATA"), default=[],
        help="Original YBNC metadata; preserves source YBNs and transforms in the release manifest.",
    )
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--output-manifest", default="ybn_spawn_static.json")
    args = parser.parse_args()

    base = json.loads(args.base_manifest.read_text(encoding="utf-8"))
    if base.get("schema") != "webglgta-static-collision-v1" or not isinstance(base.get("chunks"), dict):
        raise SystemExit("base manifest has an unexpected schema")
    if args.base_metadata:
        base_metadata = json.loads(args.base_metadata.read_text(encoding="utf-8"))
        base["source_ybn_names"] = list(base_metadata.get("source_ybn_names") or [])
        base["resource_ybn_transforms"] = dict(base_metadata.get("resource_ybn_transforms") or {})
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    palette = list(base.get("surface_materials") or [])
    palette_index = {canonical(record): index for index, record in enumerate(palette)}
    source_metadata_by_label = {
        "".join(ch if ch.isalnum() else "_" for ch in raw_label.lower()).strip("_"): Path(raw_path).resolve()
        for raw_label, raw_path in args.overlay_metadata
    }
    overlay_records = []
    replaced_keys: set[str] = set()

    for label_raw, manifest_raw in args.overlay:
        label = "".join(ch if ch.isalnum() else "_" for ch in label_raw.lower()).strip("_")
        manifest_path = Path(manifest_raw).resolve()
        overlay = json.loads(manifest_path.read_text(encoding="utf-8"))
        if overlay.get("schema") != "webglgta-static-collision-v1" or not isinstance(overlay.get("chunks"), dict):
            raise SystemExit(f"{manifest_path}: unexpected overlay schema")
        if float(overlay.get("chunk_size") or 0) != float(base.get("chunk_size") or 0):
            raise SystemExit(f"{manifest_path}: chunk size differs from base")
        source_metadata_path = source_metadata_by_label.get(label)
        source_metadata = (
            json.loads(source_metadata_path.read_text(encoding="utf-8"))
            if source_metadata_path is not None else {}
        )
        material_map = []
        for material in overlay.get("surface_materials") or []:
            key = canonical(material)
            target = palette_index.get(key)
            if target is None:
                target = len(palette)
                if target > 0xFFFF:
                    raise SystemExit("merged material palette exceeds u16")
                palette_index[key] = target
                palette.append(material)
            material_map.append(target)

        chunk_hashes = {}
        for key, source_entry in overlay["chunks"].items():
            if key in replaced_keys:
                raise SystemExit(f"overlay collision key {key} is supplied more than once")
            replaced_keys.add(key)
            source_file = manifest_path.parent / str(source_entry["file"])
            payload = remap_chunk(source_file, material_map, overlay["geometry_bounds"], base["geometry_bounds"])
            gx, gy = (int(value) for value in key.split(":"))
            filename = f"destination_{label}_{gx}_{gy}.cwct"
            output_file = output_dir / filename
            output_file.write_bytes(payload)
            with gzip.GzipFile(filename=output_file.with_suffix(output_file.suffix + ".gz"), mode="wb", compresslevel=9, mtime=0) as handle:
                handle.write(payload)
            output_file.unlink()
            entry = dict(source_entry)
            entry["file"] = filename
            entry["byte_length"] = len(payload)
            entry["destination_overlay"] = label
            base["chunks"][key] = entry
            chunk_hashes[key] = hashlib.sha256(payload).hexdigest()

        overlay_records.append({
            "id": label,
            "source": overlay.get("source"),
            "source_ybn_names": list(source_metadata.get("source_ybn_names") or []),
            "resource_ybn_transforms": dict(source_metadata.get("resource_ybn_transforms") or {}),
            "chunk_count": len(overlay["chunks"]),
            "chunk_keys": sorted(overlay["chunks"]),
            "chunk_sha256": chunk_hashes,
        })

    base["surface_materials"] = palette
    base["chunk_count"] = len(base["chunks"])
    base["destination_overlays"] = overlay_records
    output_manifest = output_dir / args.output_manifest
    output_manifest.write_text(json.dumps(base, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "manifest": str(output_manifest),
        "base_chunk_count": base["chunk_count"],
        "overlay_chunk_count": len(replaced_keys),
        "material_count": len(palette),
        "compressed_files": len(list(output_dir.glob("*.cwct.gz"))),
    }, indent=2))


if __name__ == "__main__":
    main()

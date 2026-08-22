#!/usr/bin/env python3
"""Validate every mesh-pack slice and texture reference in a demo track import."""

from __future__ import annotations

import argparse
import json
import re
import struct
from collections import defaultdict
from pathlib import Path

import numpy as np


REF = re.compile(r"^@demo-pack/([^#]+)#(\d+):(\d+)$")


def expected_msh10_bytes(raw: memoryview) -> tuple[int, int, int, int, int]:
    if len(raw) < 44:
        raise ValueError("truncated MSH10 header")
    magic, version, vertices, indices, flags = struct.unpack_from("<4sIIII", raw)
    if magic != b"MSH0" or version != 10 or vertices < 3 or indices < 3 or indices % 3:
        raise ValueError("invalid MSH10 header")
    cursor = 44 + vertices * 6
    if flags & 1:
        cursor += vertices * (3 if flags & 2048 else (4 if flags & 1024 else 6))
    if flags & 2048:
        cursor = (cursor + 1) & ~1
    if flags & 2:
        cursor += vertices * 4
    if flags & 16:
        cursor += vertices * 4
    if flags & 32:
        cursor += vertices * 4
    invalid_tangents = 0
    if flags & 4:
        tangent_data = np.frombuffer(raw, dtype=np.int8, count=vertices * 4, offset=cursor).reshape(-1, 4)
        tangent_length_sq = np.sum(tangent_data[:, :3].astype(np.int32) ** 2, axis=1)
        invalid_tangents = int(np.count_nonzero((tangent_length_sq < 120 * 120) | (np.abs(tangent_data[:, 3].astype(np.int16)) != 127)))
        cursor += vertices * 4
    for flag in (8, 64, 128, 256):
        if flags & flag:
            cursor += vertices * 4
    cursor = (cursor + 3) & ~3
    if flags & 4096:
        index_data = np.empty(indices, dtype=np.uint32)
        previous = 0
        for index in range(indices):
            value = 0
            shift = 0
            while True:
                if cursor >= len(raw) or shift > 28:
                    raise ValueError("invalid MSH10 delta-index stream")
                byte = int(raw[cursor])
                cursor += 1
                value |= (byte & 0x7f) << shift
                if not byte & 0x80:
                    break
                shift += 7
            delta = (value >> 1) ^ -(value & 1)
            previous = (previous + delta) & 0xffffffff
            index_data[index] = previous
        if cursor != len(raw):
            raise ValueError(f"unexpected bytes after MSH10 delta indices: {len(raw) - cursor}")
    else:
        index_width = 2 if flags & 512 else 4
        end = cursor + indices * index_width
        if end != len(raw):
            raise ValueError(f"MSH10 length mismatch: expected {end}, found {len(raw)}")
        index_data = np.frombuffer(raw, dtype="<u2" if index_width == 2 else "<u4", count=indices, offset=cursor)
    if int(index_data.max(initial=0)) >= vertices:
        raise ValueError("MSH10 index outside vertex stream")
    return vertices, indices, len(raw), flags, invalid_tangents


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("descriptor", type=Path)
    parser.add_argument("--web-root", type=Path, required=True)
    parser.add_argument("--pack-dir", type=Path, help="isolated build pack directory (defaults to deployed web root)")
    parser.add_argument("--source-scene", type=Path, help="original scene manifest before spatial packing")
    parser.add_argument("--spatial-scene", type=Path, help="spatial scene consumed by the demo importer")
    parser.add_argument("--append-scene", type=Path, action="append", default=[], help="additional authored scene merged by the importer")
    args = parser.parse_args()
    descriptor = json.loads(args.descriptor.read_text(encoding="utf-8"))
    packs: dict[str, bytes] = {}
    totals = {
        "cells": 0, "submeshes": 0, "vertices": 0, "indices": 0,
        "bytes": 0, "textures": 0, "tangentSubmeshes": 0, "tangentIndices": 0,
        "invalidTangentVertices": 0,
    }
    property_keys: set[str] = set()
    texture_channels: set[str] = set()
    source_spatial_deltas: list[dict] = []
    spatial = json.loads(args.spatial_scene.read_text(encoding="utf-8")) if args.spatial_scene else None
    source = json.loads(args.source_scene.read_text(encoding="utf-8")) if args.source_scene else None
    appended = [json.loads(path.read_text(encoding="utf-8")) for path in args.append_scene]
    spatial_groups: dict[tuple[str, int], dict] = {}
    appended_groups: dict[tuple[str, int], dict] = {}
    appended_models: dict[str, dict] = {}
    spatial_indices = defaultdict(int)
    appended_indices = defaultdict(int)
    demo_indices = defaultdict(int)
    recovered_indices = {
        str(row.get("source") or ""): int(row.get("indices") or 0)
        for row in (descriptor.get("sourceCoverage", {}).get("recoveredSectors") or [])
        if str(row.get("source") or "")
    }
    if spatial:
        for model in spatial.get("models") or []:
            source_name = str(model.get("source") or model.get("file") or "")
            for group_index, group in enumerate(model.get("groups") or []):
                spatial_groups[(source_name, group_index)] = group
                spatial_indices[source_name] += int(group.get("count") or 0)
    for append_scene in appended:
        for model in append_scene.get("models") or []:
            source_name = str(model.get("source") or model.get("file") or "")
            if source_name in appended_models or source_name in spatial_indices:
                raise ValueError(f"duplicate authored source across audit scenes: {source_name}")
            appended_models[source_name] = model
            for group_index, group in enumerate(model.get("groups") or []):
                appended_groups[(source_name, group_index)] = group
                appended_indices[source_name] += int(group.get("count") or 0)
    instances = descriptor.get("instances") or []
    meshes = descriptor.get("meshes") or {}
    if len(instances) != len(meshes):
        raise ValueError("instance/archetype count mismatch")
    for record in instances:
        matrix = record.get("matrix") or []
        if str(record.get("hash")) not in meshes or len(matrix) != 16 or not np.isfinite(matrix).all():
            raise ValueError("invalid track instance record")
        totals["cells"] += 1
    for entry in meshes.values():
        for sub in entry.get("lods", {}).get("high", {}).get("submeshes", []):
            match = REF.match(str(sub.get("file") or ""))
            if not match:
                raise ValueError(f"invalid demo pack reference: {sub.get('file')}")
            name, offset, length = match.group(1), int(match.group(2)), int(match.group(3))
            if name not in packs:
                pack_path = (
                    args.pack_dir / Path(name).name
                    if args.pack_dir
                    else args.web_root / "assets" / "demo" / name
                )
                packs[name] = pack_path.read_bytes()
            payload = packs[name]
            if offset + length > len(payload):
                raise ValueError(f"slice outside pack: {name}#{offset}:{length}")
            vertices, indices, size, flags, invalid_tangents = expected_msh10_bytes(memoryview(payload)[offset:offset + length])
            totals["submeshes"] += 1
            totals["vertices"] += vertices
            totals["indices"] += indices
            totals["bytes"] += size
            if flags & 4:
                totals["tangentSubmeshes"] += 1
                totals["tangentIndices"] += indices
                totals["invalidTangentVertices"] += invalid_tangents
            if bool(sub.get("hasTangents")) != bool(flags & 4):
                raise ValueError(f"descriptor/MSH tangent flag mismatch: {sub.get('file')}")
            track_source = str(sub.get("trackSource") or "")
            track_group = int(sub.get("trackGroup", -1))
            track_material_group = int(sub.get("trackMaterialGroup", track_group))
            demo_indices[track_source] += indices
            material = sub.get("material") or {}
            track_textures = material.get("trackMaterial", {}).get("textures", {})
            for rel in set(track_textures.values()):
                if not (args.web_root / "assets" / rel).is_file():
                    raise ValueError(f"missing texture: {rel}")
                totals["textures"] += 1
            if spatial:
                authored = spatial_groups.get((track_source, track_group))
                appended_model = appended_models.get(track_source)
                if authored is None and appended_model is not None:
                    authored = appended_groups.get((track_source, track_material_group))
                    if sub.get("trackDynamic") != appended_model.get("dynamic"):
                        raise ValueError(f"dynamic source metadata coverage mismatch: {track_source}")
                if authored is None and track_source in recovered_indices:
                    # Retained TNM2 sectors have geometry/UVs but lost their
                    # original material partitions. Their generated groups use
                    # the explicitly recorded authored-terrain recovery.
                    continue
                if authored is None:
                    raise ValueError(f"demo submesh has no spatial source group: {track_source}#{track_group}")
                track_material = material.get("trackMaterial") or {}
                property_keys.update((authored.get("properties") or {}).keys())
                texture_channels.update((authored.get("textures") or {}).keys())
                expected_textures = {
                    key: f"tracks/nordschleife/scene_full_v3/textures/{Path(str(value)).name}"
                    for key, value in (authored.get("textures") or {}).items()
                    if value
                }
                for key, expected_value in (
                    ("name", str(authored.get("material") or "track")),
                    ("shader", str(authored.get("shader") or "track")),
                    ("properties", authored.get("properties") or {}),
                    ("propertyVectors", authored.get("propertyVectors") or {}),
                    ("textures", expected_textures),
                ):
                    if track_material.get(key) != expected_value:
                        raise ValueError(f"track material {key} coverage mismatch: {track_source}#{track_group}")
                if expected_textures.get("diffuse") and material.get("baseColor") != [1.0, 1.0, 1.0]:
                    raise ValueError(f"authored diffuse is incorrectly proxy-tinted: {track_source}#{track_group}")
                renderer_channels = {
                    "diffuse": "diffuse",
                    "normal": "normal",
                    "maps": "spec",
                    "detail": "trackDetailColor",
                    "mask": "trackMask",
                    "variation": "trackVariation",
                    "detailR": "trackDetailR",
                    "detailG": "trackDetailG",
                    "detailB": "trackDetailB",
                    "detailA": "trackDetailA",
                }
                for source_channel, renderer_channel in renderer_channels.items():
                    expected_texture = expected_textures.get(source_channel)
                    if source_channel == "detail" and float((authored.get("properties") or {}).get("usedetail", 0.0) or 0.0) <= 0.5:
                        expected_texture = None
                    if expected_texture and material.get(renderer_channel) != expected_texture:
                        raise ValueError(
                            f"authored {source_channel} is not mapped to {renderer_channel}: "
                            f"{track_source}#{track_group}"
                        )
                    if source_channel == "detail" and not expected_texture and material.get(renderer_channel):
                        raise ValueError(
                            f"disabled authored detail is incorrectly active in {renderer_channel}: "
                            f"{track_source}#{track_group}"
                        )
                normal_detail = expected_textures.get("normalDetail") or expected_textures.get("detailNormal")
                if normal_detail:
                    expected_slot = "detail" if expected_textures.get("normal") else "normal"
                    if material.get(expected_slot) != normal_detail:
                        raise ValueError(
                            f"normal-detail channel is not mapped to {expected_slot}: {track_source}#{track_group}"
                        )
    expected = descriptor.get("stats") or {}
    for key, source_key in (("cells", "cells"), ("submeshes", "submeshes"), ("vertices", "vertices"), ("indices", "indices")):
        if int(expected.get(source_key, -1)) != totals[key]:
            raise ValueError(f"descriptor {source_key} mismatch: {expected.get(source_key)} != {totals[key]}")
    if spatial:
        expected_extra_sources = set(recovered_indices) | set(appended_indices)
        if set(demo_indices) - set(spatial_indices) != expected_extra_sources:
            raise ValueError("unexpected recovered demo sector set")
        if set(spatial_indices) - set(demo_indices):
            raise ValueError("spatial/demo source sector set mismatch")
        for source_name, count in spatial_indices.items():
            if demo_indices[source_name] != count:
                raise ValueError(f"spatial/demo index coverage mismatch for {source_name}: {count} != {demo_indices[source_name]}")
        for source_name, count in recovered_indices.items():
            if demo_indices[source_name] != count:
                raise ValueError(f"recovered/demo index coverage mismatch for {source_name}: {count} != {demo_indices[source_name]}")
        for source_name, count in appended_indices.items():
            if demo_indices[source_name] != count:
                raise ValueError(f"appended/demo index coverage mismatch for {source_name}: {count} != {demo_indices[source_name]}")
    if source and spatial:
        source_by_name = {str(model.get("source") or ""): model for model in source.get("models") or []}
        spatial_by_name = {str(model.get("source") or ""): model for model in spatial.get("models") or []}
        if set(source_by_name) != set(spatial_by_name):
            raise ValueError("source/spatial visual sector set mismatch")
        for source_name, model in source_by_name.items():
            source_count = sum(int(group.get("count") or 0) for group in model.get("groups") or [])
            packed_count = sum(int(group.get("count") or 0) for group in spatial_by_name[source_name].get("groups") or [])
            if source_count != packed_count:
                source_spatial_deltas.append({
                    "source": source_name,
                    "authoredIndices": source_count,
                    "spatialIndices": packed_count,
                    "delta": packed_count - source_count,
                })
            source_file = args.source_scene.parent / str(model.get("file") or "")
            declared_bytes = int(model.get("bytes") or 0)
            if source_file.exists() and declared_bytes > 0 and source_file.stat().st_size != declared_bytes:
                raise ValueError(f"source binary byte mismatch for {source_name}: {source_file.stat().st_size} != {declared_bytes}")
    if totals["tangentSubmeshes"] != totals["submeshes"]:
        raise ValueError(
            "incomplete signed-tangent coverage: "
            f"{totals['tangentSubmeshes']} / {totals['submeshes']} submeshes"
        )
    if totals["invalidTangentVertices"]:
        raise ValueError(f"invalid signed tangent vertices: {totals['invalidTangentVertices']}")
    declared_deltas = (descriptor.get("sourceCoverage") or {}).get("indexDeltas") or []
    normalized_declared = sorted(declared_deltas, key=lambda row: str(row.get("source") or ""))
    normalized_actual = sorted(source_spatial_deltas, key=lambda row: str(row.get("source") or ""))
    if source and spatial and normalized_declared != normalized_actual:
        raise ValueError("descriptor does not explicitly account for every source/spatial index delta")
    print(json.dumps({
        "ok": True,
        "packs": len(packs),
        **totals,
        "sourceSpatialIndexDeltas": normalized_actual,
        "authoredPropertyKeys": sorted(property_keys),
        "authoredTextureChannels": sorted(texture_channels),
    }, indent=2))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Audit actual geometry LOD and runtime texture-tier coverage for a track descriptor."""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

from PIL import Image

from audit_demo_track_import import REF, expected_msh10_bytes
from import_track_into_demo_renderer import read_tnm


TEXTURE_KEYS = {
    "diffuse", "diffuse2", "normal", "spec", "detail", "ao", "height", "emissive",
    "alphaMask", "env", "dirt", "damage", "damageMask", "puddleMask", "tintPalette",
    "trackMask", "trackDetailR", "trackDetailG", "trackDetailB", "trackDetailA",
    "trackDetailColor", "trackVariation", "trackDetailNormal", "trackNormalDetail",
}


def tier_size(width: int, height: int, tier: str) -> tuple[int, int]:
    scale = {"high": 1.0, "medium": 0.5, "low": 0.25}[tier]
    maximum = {"high": 1 << 30, "medium": 2048, "low": 1024}[tier]
    size_scale = min(1.0, maximum / max(width, height))
    final = min(scale, size_scale)
    return max(1, int(width * final)), max(1, int(height * final))


def audit_track_scene(descriptor: dict, descriptor_path: Path) -> dict:
    """Audit the TrackSceneRenderer sector schema without reporting an empty pass."""
    models = descriptor.get("models") or []
    missing_models: list[str] = []
    invalid_models: list[dict[str, str]] = []
    missing_textures: list[str] = []
    decode_errors: list[dict[str, str]] = []
    texture_paths: set[str] = set()
    texture_slots: Counter[str] = Counter()
    source_names: set[str] = set()
    binary_material_group_mismatches: list[dict[str, int | str]] = []
    totals = Counter()

    for model in models:
        relative = str(model.get("file") or "")
        source = str(model.get("source") or "")
        if not relative:
            invalid_models.append({"file": relative, "error": "missing model file"})
            continue
        if not source or source in source_names:
            invalid_models.append({"file": relative, "error": "missing or duplicate source identity"})
        source_names.add(source)
        path = descriptor_path.parent / relative
        if not path.is_file():
            missing_models.append(relative)
            continue
        try:
            decoded = read_tnm(path)
            vertices = len(decoded["positions"])
            indices = len(decoded["indices"])
            groups = model.get("groups") or []
            declared_group_count = int(decoded.get("group_count") or 0)
            # `vertices` is the authored/source count. TNM writers may weld or
            # omit non-visual vertices, so only a dedicated binary count is an
            # exact contract for the decoded stream.
            if model.get("binaryVertexCount") is not None and int(model["binaryVertexCount"]) != vertices:
                raise ValueError(f"binary vertex count {vertices} != {model.get('binaryVertexCount')}")
            if int(model.get("binaryIndexCount") or indices) != indices:
                raise ValueError(f"index count {indices} != {model.get('binaryIndexCount')}")
            if int(model.get("binaryGroupCount") or declared_group_count) != declared_group_count:
                raise ValueError(f"binary group count {declared_group_count} != {model.get('binaryGroupCount')}")
            if len(groups) != declared_group_count:
                # Retained TNM2 sectors can deliberately collapse binary
                # partitions when their original material table was lost. The
                # descriptor ranges remain authoritative for rendering.
                binary_material_group_mismatches.append({
                    "file": relative,
                    "binaryGroups": declared_group_count,
                    "materialGroups": len(groups),
                })
            if int(model.get("compressedBytes") or path.stat().st_size) != path.stat().st_size:
                raise ValueError("compressed byte count does not match file")
            previous_end = 0
            for group_index, group in enumerate(groups):
                offset = int(group.get("offset") or 0)
                count = int(group.get("count") or 0)
                if offset != previous_end or count < 0 or offset + count > indices or count % 3:
                    raise ValueError(f"invalid group range {group_index}: {offset}+{count}/{indices}")
                previous_end = offset + count
                if not str(group.get("material") or "") or not str(group.get("shader") or ""):
                    raise ValueError(f"group {group_index} lacks material/shader identity")
                textures = group.get("textures") or ({"diffuse": group.get("texture")} if group.get("texture") else {})
                for channel, value in textures.items():
                    if isinstance(value, str) and value:
                        texture_slots[str(channel)] += 1
                        texture_paths.add(value)
            if previous_end != indices:
                raise ValueError(f"material ranges cover {previous_end} of {indices} indices")
            declared_triangles = int(model.get("trianglesOutput") or 0)
            if declared_triangles and declared_triangles * 3 != indices:
                raise ValueError(f"triangle count {indices // 3} != {declared_triangles}")
            totals["models"] += 1
            totals["groups"] += len(groups)
            totals["vertices"] += vertices
            totals["indices"] += indices
            totals["compressedBytes"] += path.stat().st_size
        except Exception as error:
            invalid_models.append({"file": relative, "error": str(error)})

    dimension_histogram: Counter[str] = Counter()
    for relative in sorted(texture_paths):
        path = descriptor_path.parent / relative
        if not path.is_file():
            missing_textures.append(relative)
            continue
        try:
            with Image.open(path) as image:
                image.verify()
            with Image.open(path) as image:
                width, height = image.size
            if width < 1 or height < 1:
                raise ValueError(f"invalid dimensions {width}x{height}")
            dimension_histogram[f"{width}x{height}"] += 1
        except Exception as error:
            decode_errors.append({"path": relative, "error": str(error)})

    declared_model_count = int((descriptor.get("source") or {}).get("modelCount") or len(models))
    declared_channels = set((descriptor.get("source") or {}).get("materialChannels") or [])
    referenced_channels = set(texture_slots)
    ok = bool(models) and declared_model_count == len(models) and not (
        missing_models or invalid_models or missing_textures or decode_errors
    )
    return {
        "ok": ok,
        "schema": descriptor.get("schema"),
        "qualityPackage": {
            "declaredModels": declared_model_count,
            "descriptorModels": len(models),
            "validatedModels": totals["models"],
            "groups": totals["groups"],
            "vertices": totals["vertices"],
            "triangles": totals["indices"] // 3,
            "compressedBytes": totals["compressedBytes"],
            "missingModels": missing_models,
            "invalidModels": invalid_models,
            "binaryMaterialGroupMismatches": binary_material_group_mismatches,
            "complete": ok,
        },
        "textures": {
            "uniqueReferenced": len(texture_paths),
            "slotUses": dict(sorted(texture_slots.items())),
            "declaredChannels": sorted(declared_channels),
            "referencedChannels": sorted(referenced_channels),
            "decodable": len(texture_paths) - len(missing_textures) - len(decode_errors),
            "missing": missing_textures,
            "decodeErrors": decode_errors,
            "sourceDimensions": dict(sorted(dimension_histogram.items())),
            "complete": not missing_textures and not decode_errors,
        },
        "lodPolicy": {
            "dedicatedGeometryLods": False,
            "runtimePackages": ["balanced", "full"],
            "note": "Low/medium use the balanced scene; high uses the full scene. Audit both descriptors separately.",
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("descriptor", type=Path)
    parser.add_argument("--web-root", type=Path, required=True)
    parser.add_argument("--texture-web-root", type=Path, help="alternate root containing assets/ for staged texture audits")
    parser.add_argument("--source-pack-dir", type=Path, action="append", default=[], help="staged pack directory searched before the served tree")
    args = parser.parse_args()
    descriptor = json.loads(args.descriptor.read_text(encoding="utf-8"))

    if isinstance(descriptor.get("models"), list) and not descriptor.get("meshes"):
        result = audit_track_scene(descriptor, args.descriptor.resolve())
        print(json.dumps(result, indent=2))
        return 0 if result["ok"] else 1

    lod_archetypes: Counter[str] = Counter()
    lod_submeshes: Counter[str] = Counter()
    lod_indices: Counter[str] = Counter()
    texture_slots: Counter[str] = Counter()
    texture_paths: set[str] = set()
    pack_cache: dict[str, bytes] = {}
    metadata_mismatches: list[str] = []
    invalid_meshes: list[dict[str, str]] = []
    for mesh in (descriptor.get("meshes") or {}).values():
        lods = mesh.get("lods") or {}
        high_submeshes = ((lods.get("high") or {}).get("submeshes") or [])
        for lod in ("med", "low"):
            candidates = ((lods.get(lod) or {}).get("submeshes") or [])
            if len(candidates) != len(high_submeshes):
                metadata_mismatches.append(f"{mesh.get('name')}:{lod}:submesh-count")
                continue
            for index, (high, candidate) in enumerate(zip(high_submeshes, candidates)):
                for key in ("material", "trackSource", "trackMaterialGroup", "trackDynamic", "bounds"):
                    if candidate.get(key) != high.get(key):
                        metadata_mismatches.append(f"{mesh.get('name')}:{lod}:{index}:{key}")
                if int(candidate.get("indexCount") or 0) > int(high.get("indexCount") or 0):
                    metadata_mismatches.append(f"{mesh.get('name')}:{lod}:{index}:index-growth")
        for lod, lod_meta in (mesh.get("lods") or {}).items():
            lod_archetypes[lod] += 1
            for submesh in (lod_meta.get("submeshes") or []):
                lod_submeshes[lod] += 1
                lod_indices[lod] += int(submesh.get("indexCount") or 0)
                reference = str(submesh.get("file") or "")
                match = REF.match(reference)
                if not match:
                    invalid_meshes.append({"file": reference, "error": "invalid pack reference"})
                else:
                    name, offset, length = match.group(1), int(match.group(2)), int(match.group(3))
                    try:
                        payload = pack_cache.get(name)
                        if payload is None:
                            candidates = [directory / Path(name).name for directory in args.source_pack_dir]
                            candidates.append(args.web_root / "assets" / "demo" / name)
                            path = next(path for path in candidates if path.is_file())
                            payload = path.read_bytes()
                            pack_cache[name] = payload
                        if offset < 0 or length <= 0 or offset + length > len(payload):
                            raise ValueError("slice outside pack")
                        vertices, indices, _size, _flags, invalid_tangents = expected_msh10_bytes(memoryview(payload)[offset:offset + length])
                        if vertices != int(submesh.get("vertexCount") or 0) or indices != int(submesh.get("indexCount") or 0):
                            raise ValueError("descriptor/header count mismatch")
                        if invalid_tangents:
                            raise ValueError(f"{invalid_tangents} invalid tangent vertices")
                    except Exception as error:
                        invalid_meshes.append({"file": reference, "error": str(error)})
                material = submesh.get("material") or {}
                for key, value in material.items():
                    if key in TEXTURE_KEYS and isinstance(value, str) and value:
                        texture_slots[key] += 1
                        texture_paths.add(value)
                for key, value in ((material.get("trackMaterial") or {}).get("textures") or {}).items():
                    if isinstance(value, str) and value:
                        texture_slots[f"trackMaterial.{key}"] += 1
                        texture_paths.add(value)

    missing: list[str] = []
    decode_errors: list[dict[str, str]] = []
    dimension_histogram: Counter[str] = Counter()
    tier_pixels: defaultdict[str, int] = defaultdict(int)
    tier_nonzero: Counter[str] = Counter()
    for relative in sorted(texture_paths):
        path = (args.texture_web_root or args.web_root) / "assets" / relative
        if not path.is_file():
            missing.append(relative)
            continue
        try:
            with Image.open(path) as image:
                image.verify()
            with Image.open(path) as image:
                width, height = image.size
            if width < 1 or height < 1:
                raise ValueError(f"invalid dimensions {width}x{height}")
            dimension_histogram[f"{width}x{height}"] += 1
            for tier in ("high", "medium", "low"):
                target_width, target_height = tier_size(width, height, tier)
                tier_pixels[tier] += target_width * target_height
                if target_width >= 1 and target_height >= 1:
                    tier_nonzero[tier] += 1
        except Exception as error:  # audit output must retain the failing path
            decode_errors.append({"path": relative, "error": str(error)})

    mesh_count = len(descriptor.get("meshes") or {})
    geometry_full = all(lod_archetypes.get(lod, 0) == mesh_count for lod in ("high", "med", "low"))
    texture_full = not missing and not decode_errors and all(tier_nonzero[tier] == len(texture_paths) for tier in ("high", "medium", "low"))
    geometry_full = geometry_full and not metadata_mismatches and not invalid_meshes
    result = {
        "ok": geometry_full and texture_full,
        "geometry": {
            "archetypes": dict(sorted(lod_archetypes.items())),
            "submeshes": dict(sorted(lod_submeshes.items())),
            "indices": dict(sorted(lod_indices.items())),
            "fullHighMedLowCoverage": geometry_full,
            "lodDistancesDeclared": sum(1 for mesh in (descriptor.get("meshes") or {}).values() if mesh.get("lodDistances")),
            "metadataMismatches": metadata_mismatches,
            "invalidMeshes": invalid_meshes,
            "packsRead": len(pack_cache),
        },
        "textures": {
            "uniqueReferenced": len(texture_paths),
            "slotUses": dict(sorted(texture_slots.items())),
            "decodable": len(texture_paths) - len(missing) - len(decode_errors),
            "missing": missing,
            "decodeErrors": decode_errors,
            "sourceDimensions": dict(sorted(dimension_histogram.items())),
            "runtimeTierCoverage": {tier: tier_nonzero[tier] for tier in ("high", "medium", "low")},
            "runtimeTierTotalPixels": {tier: tier_pixels[tier] for tier in ("high", "medium", "low")},
            "tierPolicy": {"high": "source resolution", "medium": "0.5x, max 2048", "low": "0.25x, max 1024"},
            "dedicatedTierFiles": False,
            "fullHighMediumLowCoverage": texture_full,
        },
    }
    print(json.dumps(result, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

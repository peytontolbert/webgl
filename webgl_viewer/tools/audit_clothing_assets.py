#!/usr/bin/env python3
"""Audit ped clothing exports and optionally remove broken variants from catalogs."""

from __future__ import annotations

import argparse
import gzip
import json
import math
import re
import struct
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


REQUIRED_SLOTS = tuple(range(12))
CUSTOM_MANIFESTS = ("nx_chains.json", "clothingpack5m.json")
PROP_TOKEN_RE = re.compile(r"(?:^|[\^:])p_(?:head|eyes|ears|lwrist)(?:_|:)", re.IGNORECASE)


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")


def base_entry(assets: Path, cache: dict[str, dict[str, Any]], asset_hash: str) -> dict[str, Any] | None:
    try:
        shard = f"{int(asset_hash) & 0xff:02x}"
    except ValueError:
        return None
    if shard not in cache:
        path = assets / "models" / "manifest_shards" / f"{shard}.json"
        cache[shard] = load_json(path).get("meshes", {}) if path.is_file() else {}
    return cache[shard].get(asset_hash)


def material_diffuse(entry: dict[str, Any], submesh: dict[str, Any]) -> str:
    material = dict(entry.get("material") or {})
    material.update(submesh.get("material") or {})
    return str(material.get("diffuse") or "").strip().replace("\\", "/")


def texture_ok(assets: Path, relative: str) -> tuple[bool, str]:
    if not relative:
        return False, "missing-diffuse-metadata"
    relative = relative.removeprefix("assets/")
    path = assets / relative
    if not path.is_file():
        return False, "missing-diffuse-file"
    try:
        head = path.read_bytes()[:16]
    except OSError:
        return False, "unreadable-diffuse-file"
    valid = head.startswith(b"\x89PNG\r\n\x1a\n") or head.startswith(b"RIFF") or head.startswith(b"\xff\xd8")
    return (valid, "" if valid else "invalid-diffuse-file")


def half_to_float(value: int) -> float:
    return struct.unpack("<e", struct.pack("<H", value))[0]


def mesh_ok(assets: Path, submesh: dict[str, Any]) -> tuple[bool, str, dict[str, Any]]:
    relative = str(submesh.get("file") or "").strip().replace("\\", "/")
    path = assets / "models" / relative
    if not relative or not path.is_file():
        return False, "missing-mesh-file", {}
    try:
        opener = gzip.open if path.suffix.lower() in {".gz", ".gzip"} else open
        with opener(path, "rb") as stream:
            head = stream.read(20)
            if len(head) != 20:
                return False, "truncated-mesh-header", {}
            magic, version, vertex_count, index_count, flags = struct.unpack("<4sIIII", head)
            if magic != b"MSH0" or version not in (8, 9):
                return False, "invalid-skinned-mesh-header", {}
            if vertex_count < 3 or index_count < 3 or index_count % 3:
                return False, "invalid-mesh-counts", {}
            if not (flags & 128) or not (flags & 256):
                return False, "missing-blend-attributes", {}
            if int(submesh.get("vertexCount") or 0) != vertex_count or int(submesh.get("indexCount") or 0) != index_count:
                return False, "manifest-mesh-count-mismatch", {}

            packed = version == 9
            position_bytes = vertex_count * 3 * (2 if packed else 4)
            positions_raw = stream.read(position_bytes)
            if len(positions_raw) != position_bytes:
                return False, "truncated-positions", {}
            if packed:
                positions = (half_to_float(value) for value in struct.unpack(f"<{vertex_count * 3}H", positions_raw))
            else:
                positions = iter(struct.unpack(f"<{vertex_count * 3}f", positions_raw))
            mins = [math.inf, math.inf, math.inf]
            maxs = [-math.inf, -math.inf, -math.inf]
            for index, value in enumerate(positions):
                if not math.isfinite(value):
                    return False, "nonfinite-position", {}
                axis = index % 3
                mins[axis] = min(mins[axis], value)
                maxs[axis] = max(maxs[axis], value)
            extents = [maxs[i] - mins[i] for i in range(3)]
            radius = math.sqrt(sum((extent * 0.5) ** 2 for extent in extents))
            if radius < 0.005 or radius > 4.0 or max(abs(v) for v in (*mins, *maxs)) > 6.0:
                return False, "implausible-ped-bounds", {"min": mins, "max": maxs, "radius": radius}

            has_normals = bool(flags & 1)
            has_int8_normals = packed and bool(flags & 1024)
            tight_normals = has_int8_normals and bool(flags & 2048)
            normal_bytes = vertex_count * (3 if tight_normals else (4 if has_int8_normals else (6 if packed else 12))) if has_normals else 0
            if tight_normals and (20 + position_bytes + normal_bytes) % 2:
                normal_bytes += 1
            uv_bytes = vertex_count * 2 * (2 if packed else 4) if flags & 2 else 0
            uv1_bytes = vertex_count * 2 * (2 if packed else 4) if flags & 16 else 0
            uv2_bytes = vertex_count * 2 * (2 if packed else 4) if flags & 32 else 0
            tangent_bytes = vertex_count * 4 * (1 if packed else 4) if flags & 4 else 0
            color0_bytes = vertex_count * 4 if flags & 8 else 0
            color1_bytes = vertex_count * 4 if flags & 64 else 0
            skip = normal_bytes + uv_bytes + uv1_bytes + uv2_bytes + tangent_bytes + color0_bytes + color1_bytes
            if len(stream.read(skip)) != skip:
                return False, "truncated-vertex-attributes", {}
            weights = stream.read(vertex_count * 4)
            indices = stream.read(vertex_count * 4)
            if len(weights) != vertex_count * 4 or len(indices) != vertex_count * 4:
                return False, "truncated-blend-attributes", {}
            weighted_vertices = sum(1 for i in range(0, len(weights), 4) if sum(weights[i:i + 4]) > 0)
            if weighted_vertices < math.ceil(vertex_count * 0.98):
                return False, "unweighted-vertices", {"weighted": weighted_vertices, "vertices": vertex_count}
            bone_ids = submesh.get("boneIds") or []
            if not bone_ids or max(indices) >= len(bone_ids):
                return False, "blend-index-out-of-range", {"maxIndex": max(indices), "paletteSize": len(bone_ids)}
            return True, "", {"min": mins, "max": maxs, "radius": radius}
    except (OSError, EOFError, struct.error, ValueError) as error:
        return False, "unreadable-mesh", {"error": str(error)}


def entry_ok(assets: Path, entry: dict[str, Any] | None, model: str, slot: int) -> tuple[bool, str, dict[str, Any]]:
    if not entry:
        return False, "missing-manifest-entry", {}
    ped = entry.get("pedComponent") or {}
    if str(ped.get("modelName") or "") != model:
        return False, "wrong-ped-model", {"actual": ped.get("modelName")}
    if int(ped.get("componentId", -1)) != slot:
        return False, "wrong-component-slot", {"actual": ped.get("componentId")}
    high = (entry.get("lods") or {}).get("high") or {}
    submeshes = high.get("submeshes") or []
    if not submeshes:
        return False, "missing-high-lod", {}
    bounds = []
    for submesh in submeshes:
        if not submesh.get("skinned") or not submesh.get("hasBlendWeights") or not submesh.get("hasBlendIndices"):
            return False, "manifest-missing-skinning", {}
        good, reason, detail = mesh_ok(assets, submesh)
        if not good:
            return False, reason, detail
        bounds.append(detail)
        good, reason = texture_ok(assets, material_diffuse(entry, submesh))
        if not good:
            return False, reason, {"diffuse": material_diffuse(entry, submesh)}
    if slot == 6:
        # A valid freemode feet drawable is authored around the ped's shoe plane
        # near local Z=-1. Some mislabeled exports are valid skinned meshes but sit
        # around the torso/head and must never be offered as shoes.
        min_z = min(float(item["min"][2]) for item in bounds)
        max_z = max(float(item["max"][2]) for item in bounds)
        if min_z > -0.55 or max_z > 0.25 or min_z < -1.45:
            return False, "invalid-feet-placement", {"minZ": min_z, "maxZ": max_z, "submeshes": len(bounds)}
    return True, "", {"submeshes": len(submeshes), "bounds": bounds}


def filter_models(
    assets: Path,
    payload: dict[str, Any],
    mesh_source: dict[str, Any] | None,
    shard_cache: dict[str, dict[str, Any]],
    source_name: str,
    rejected: list[dict[str, Any]],
    only_slots: set[int] | None = None,
) -> dict[str, int]:
    counts = {"variantsBefore": 0, "variantsAfter": 0, "texturesBefore": 0, "texturesAfter": 0}
    referenced_hashes: set[str] = set()
    for model, slots in list((payload.get("models") or {}).items()):
        for slot_key, variants in list(slots.items()):
            slot = int(slot_key)
            if only_slots is not None and slot not in only_slots:
                continue
            kept_variants = []
            for variant in variants:
                counts["variantsBefore"] += 1
                texture_assets = variant.get("textureAssets") or {}
                textures = list(variant.get("textures") or sorted(int(k) for k in texture_assets))
                counts["texturesBefore"] += len(textures)
                semantic_name = f"{variant.get('assetName') or ''}:{variant.get('itemId') or ''}"
                if PROP_TOKEN_RE.search(semantic_name):
                    for texture in textures:
                        rejected.append({
                            "source": source_name,
                            "model": model,
                            "slot": slot,
                            "drawable": variant.get("drawable"),
                            "texture": texture,
                            "assetHash": str(texture_assets.get(str(texture)) or variant.get("hash") or ""),
                            "reason": "prop-in-component-catalog",
                            "detail": {"assetName": variant.get("assetName"), "itemId": variant.get("itemId")},
                        })
                    continue
                kept_textures = []
                kept_assets: dict[str, str] = {}
                for texture in textures:
                    asset_hash = str(texture_assets.get(str(texture)) or variant.get("hash") or "").strip()
                    entry = (mesh_source or {}).get(asset_hash) if mesh_source is not None else base_entry(assets, shard_cache, asset_hash)
                    good, reason, detail = entry_ok(assets, entry, model, slot)
                    if good:
                        kept_textures.append(int(texture))
                        kept_assets[str(texture)] = asset_hash
                        referenced_hashes.add(asset_hash)
                    else:
                        rejected.append({"source": source_name, "model": model, "slot": slot, "drawable": variant.get("drawable"), "texture": texture, "assetHash": asset_hash, "reason": reason, "detail": detail})
                if kept_textures:
                    clean = dict(variant)
                    clean["textures"] = kept_textures
                    clean["textureAssets"] = kept_assets
                    clean["hash"] = kept_assets[str(kept_textures[0])]
                    if int(clean.get("texture", kept_textures[0])) not in kept_textures:
                        clean["texture"] = kept_textures[0]
                    kept_variants.append(clean)
                    counts["texturesAfter"] += len(kept_textures)
            slots[slot_key] = kept_variants
            counts["variantsAfter"] += len(kept_variants)
    if mesh_source is not None:
        payload["meshes"] = {key: value for key, value in mesh_source.items() if key in referenced_hashes}
    return counts


def filter_preview_catalog(assets: Path, clothing_manifest: dict[str, Any], apply: bool) -> dict[str, int]:
    path = assets / "clothingpack5m_catalog.json"
    if not path.is_file():
        return {"itemsBefore": 0, "itemsAfter": 0, "texturesBefore": 0, "texturesAfter": 0}
    catalog = load_json(path)
    accepted: dict[str, set[int]] = {}
    for slots in (clothing_manifest.get("models") or {}).values():
        for variants in slots.values():
            for variant in variants:
                item_id = str(variant.get("itemId") or "")
                if item_id:
                    accepted[item_id] = {int(value) for value in variant.get("textures") or []}
    items = list(catalog.get("items") or [])
    filtered = []
    seen_ids: set[str] = set()
    textures_before = sum(len(item.get("textures") or []) for item in items)
    for item in items:
        item_id = str(item.get("id") or "")
        allowed = accepted.get(item_id)
        if not allowed or item_id in seen_ids:
            continue
        clean = dict(item)
        seen_textures: set[int] = set()
        clean["textures"] = []
        for row in item.get("textures") or []:
            texture_index = int(row.get("index", -1))
            if texture_index not in allowed or texture_index in seen_textures:
                continue
            clean["textures"].append(row)
            seen_textures.add(texture_index)
        if not clean["textures"]:
            continue
        clean["renderStatus"] = "converted_verified"
        filtered.append(clean)
        seen_ids.add(item_id)
    catalog["items"] = filtered
    summary = dict(catalog.get("summary") or {})
    summary["items"] = len(filtered)
    summary["textures"] = sum(len(item["textures"]) for item in filtered)
    summary["bytes"] = sum(
        int(item.get("drawableBytes") or 0) + sum(int(tex.get("bytes") or 0) for tex in item["textures"])
        for item in filtered
    )
    catalog["summary"] = summary
    if apply:
        write_json(path, catalog)
    return {
        "itemsBefore": len(items),
        "itemsAfter": len(filtered),
        "texturesBefore": textures_before,
        "texturesAfter": summary["textures"],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    root = Path(__file__).resolve().parents[1]
    parser.add_argument("--assets", type=Path, default=root / "assets")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--preview-only", action="store_true")
    parser.add_argument("--base-only", action="store_true")
    parser.add_argument("--slot", type=int, action="append", default=[])
    parser.add_argument("--report", type=Path, default=root / "reports" / "clothing_asset_audit.json")
    args = parser.parse_args()
    assets = args.assets.resolve()
    if args.preview_only:
        manifest = load_json(assets / "custom_clothing" / "clothingpack5m.json")
        print(json.dumps(filter_preview_catalog(assets, manifest, args.apply), indent=2))
        return 0
    shard_cache: dict[str, dict[str, Any]] = {}
    rejected: list[dict[str, Any]] = []
    outputs: dict[str, dict[str, Any]] = {}
    summaries: dict[str, dict[str, int]] = {}

    catalog_path = assets / "character_component_catalog.json"
    catalog = load_json(catalog_path)
    only_slots = set(args.slot) if args.slot else None
    summaries[catalog_path.name] = filter_models(
        assets, catalog, None, shard_cache, catalog_path.name, rejected, only_slots,
    )
    outputs[str(catalog_path)] = catalog

    preview_summary = {"itemsBefore": 0, "itemsAfter": 0, "texturesBefore": 0, "texturesAfter": 0}
    if not args.base_only:
        for name in CUSTOM_MANIFESTS:
            path = assets / "custom_clothing" / name
            payload = load_json(path)
            meshes = payload.get("meshes") or {}
            summaries[name] = filter_models(
                assets, payload, meshes, shard_cache, name, rejected, only_slots,
            )
            outputs[str(path)] = payload

        preview_summary = filter_preview_catalog(
            assets,
            outputs[str(assets / "custom_clothing" / "clothingpack5m.json")],
            args.apply,
        )

    slot_counts: dict[str, dict[str, int]] = {}
    for model, slots in (catalog.get("models") or {}).items():
        slot_counts[model] = {str(slot): len(slots.get(str(slot)) or []) for slot in REQUIRED_SLOTS}
        missing = [slot for slot, count in slot_counts[model].items() if count <= 0]
        if missing:
            raise SystemExit(f"refusing filtered catalog with empty required slots for {model}: {missing}")

    report = {
        "schema": "webglgta-clothing-asset-audit-v1",
        "applied": bool(args.apply),
        "summaries": summaries,
        "previewCatalog": preview_summary,
        "baseSlotCounts": slot_counts,
        "rejectedCount": len(rejected),
        "rejectedByReason": dict(sorted(Counter(row["reason"] for row in rejected).items())),
        "rejected": rejected,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2), encoding="utf-8")
    if args.apply:
        for path_text, payload in outputs.items():
            write_json(Path(path_text), payload)
    print(json.dumps({key: value for key, value in report.items() if key != "rejected"}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Build a capped, content-addressed WebP texture pack for the 500 m demo district."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
import os
from pathlib import Path
from typing import Any

from PIL import Image


COLOR_KEYS = {"diffuse", "foliagediffuse", "diffuse2", "emissive", "env"}
LOSSLESS_KEYS = {"normal", "spec", "detail", "height", "tintpalette"}
TEXTURE_SLOT_KEYS = COLOR_KEYS | LOSSLESS_KEYS | {
    "ao", "alphamask", "dirt", "damage", "damagespec", "damagemask", "puddlemask",
    "terraincolor1", "terraincolor2", "terraincolor3", "terraincolor4",
    "terrainnormal1", "terrainnormal2", "terrainnormal3", "terrainnormal4",
    "waterflow", "waterfoam", "tint",
}
SOURCE_TEXTURE_PREFIXES = ("models_textures/", "mlo_textures/")


def requires_lossless(roles: set[str]) -> bool:
    return any(role not in COLOR_KEYS for role in roles)


def diagnostic_texture(roles: set[str]) -> bytes:
    if any("normal" in role for role in roles):
        image = Image.new("RGBA", (1, 1), (128, 128, 255, 255))
    elif roles and not roles & COLOR_KEYS:
        image = Image.new("RGBA", (1, 1), (0, 0, 0, 255))
    else:
        image = Image.new("RGBA", (8, 8), (255, 0, 255, 255))
        pixels = image.load()
        for y in range(8):
            for x in range(8):
                if (x // 2 + y // 2) % 2:
                    pixels[x, y] = (20, 20, 20, 255)
    output = io.BytesIO()
    image.save(output, format="WEBP", lossless=True, method=6)
    return output.getvalue()


def is_source_texture_reference(value: Any) -> bool:
    return isinstance(value, str) and value.startswith(SOURCE_TEXTURE_PREFIXES)


def encode_texture(job: tuple[str, Path, tuple[str, ...], int]) -> dict[str, Any]:
    relative, source, role_values, quality = job
    roles = set(role_values)
    neutralized = False
    try:
        source_payload = source.read_bytes()
        cache_key = hashlib.sha256(
            source_payload + b"\0" + ",".join(role_values).encode("utf-8") + f"\0q={quality}".encode("ascii")
        ).hexdigest()
        with Image.open(io.BytesIO(source_payload)) as opened:
            image = opened.convert("RGBA")
    except (OSError, ValueError) as error:
        if roles and not roles & COLOR_KEYS:
            source_payload = b""
            cache_key = hashlib.sha256(
                relative.encode("utf-8") + b"\0neutral-data\0" + ",".join(role_values).encode("utf-8")
            ).hexdigest()
            normal_like = any("normal" in role for role in roles)
            image = Image.new("RGBA", (1, 1), (128, 128, 255, 255) if normal_like else (0, 0, 0, 255))
            neutralized = True
        else:
            return {
                "relative": relative,
                "source": str(source),
                "error": str(error),
            }
    cap = 512 if roles & COLOR_KEYS else 256
    if max(image.size) > cap:
        scale = cap / max(image.size)
        image = image.resize(
            (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
            Image.Resampling.LANCZOS,
        )
    encoded = io.BytesIO()
    is_lossless = requires_lossless(roles)
    if is_lossless:
        image.save(encoded, format="WEBP", lossless=True, method=4, exact=True)
    else:
        image.save(encoded, format="WEBP", quality=quality, method=6, exact=True)
    payload = encoded.getvalue()
    return {
        "relative": relative,
        "cacheKey": cache_key,
        "payload": payload,
        "digest": hashlib.sha256(payload).hexdigest()[:24],
        "sourceBytes": len(source_payload),
        "decodedBytes": image.width * image.height * 4 * 4 // 3,
        "lossless": is_lossless,
        "neutralized": neutralized,
    }


def expected_output_size(source: Path, roles: set[str]) -> tuple[int, int]:
    with Image.open(source) as image:
        width, height = image.size
    cap = 512 if roles & COLOR_KEYS else 256
    if max(width, height) <= cap:
        return width, height
    scale = cap / max(width, height)
    return max(1, round(width * scale)), max(1, round(height * scale))


def cached_target_is_current(source: Path, target: Path, roles: set[str]) -> bool:
    try:
        legacy_lossless = bool(roles & LOSSLESS_KEYS) or any(role.startswith("terrainnormal") for role in roles)
        if requires_lossless(roles) and not legacy_lossless:
            return False
        if source.stat().st_mtime_ns > target.stat().st_mtime_ns:
            return False
        with Image.open(target) as image:
            return image.size == expected_output_size(source, roles)
    except OSError:
        return False


def walk_texture_refs(value: Any, refs: dict[str, set[str]], parent_key: str = "") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            walk_texture_refs(child, refs, str(key).lower())
    elif isinstance(value, list):
        for child in value:
            walk_texture_refs(child, refs, parent_key)
    elif is_source_texture_reference(value):
        refs.setdefault(value, set()).add(parent_key)


def replace_refs(value: Any, replacements: dict[str, str]) -> Any:
    if isinstance(value, dict):
        return {key: replace_refs(child, replacements) for key, child in value.items()}
    if isinstance(value, list):
        return [replace_refs(child, replacements) for child in value]
    if isinstance(value, str):
        return replacements.get(value, value)
    return value


def collect_existing_replacements(source: Any, compressed: Any, output: dict[str, str]) -> None:
    if isinstance(source, dict) and isinstance(compressed, dict):
        for key, child in source.items():
            if key in compressed:
                collect_existing_replacements(child, compressed[key], output)
    elif isinstance(source, list) and isinstance(compressed, list):
        for left, right in zip(source, compressed):
            collect_existing_replacements(left, right, output)
    elif (
        is_source_texture_reference(source)
        and isinstance(compressed, str)
        and compressed.startswith("demo/models_textures_v2/")
    ):
        output[source] = compressed


def collect_compatible_mesh_replacements(source: Any, compressed: Any, output: dict[str, str]) -> int:
    """Recover cached texture mappings for mesh entries whose structure is unchanged."""
    source_meshes = source.get("meshes") if isinstance(source, dict) else None
    compressed_meshes = compressed.get("meshes") if isinstance(compressed, dict) else None
    if not isinstance(source_meshes, dict) or not isinstance(compressed_meshes, dict):
        return 0
    compatible = 0
    for hash_id, source_mesh in source_meshes.items():
        compressed_mesh = compressed_meshes.get(hash_id)
        if compressed_mesh is None or not matching_structure(source_mesh, compressed_mesh):
            continue
        collect_existing_replacements(source_mesh, compressed_mesh, output)
        compatible += 1
    return compatible


def matching_structure(source: Any, compressed: Any) -> bool:
    if isinstance(source, dict):
        return isinstance(compressed, dict) and all(
            (key in compressed and matching_structure(child, compressed[key]))
            or (key not in compressed and is_source_texture_reference(child))
            for key, child in source.items()
        )
    if isinstance(source, list):
        return isinstance(compressed, list) and len(source) == len(compressed) and all(
            matching_structure(left, right) for left, right in zip(source, compressed)
        )
    return not isinstance(compressed, (dict, list))


def build_texture_source_index(assets: Path) -> tuple[dict[str, Path], dict[str, list[Path]]]:
    by_file: dict[str, Path] = {}
    by_slug: dict[str, list[Path]] = {}
    texture_dir = assets / "models_textures"
    if not texture_dir.is_dir():
        return by_file, by_slug
    for path in sorted(texture_dir.iterdir(), key=lambda item: item.name.lower()):
        if not path.is_file():
            continue
        by_file[path.name.lower()] = path
        parts = path.name.split("_", 1)
        if len(parts) == 2:
            by_slug.setdefault(parts[1].lower(), []).append(path)
    return by_file, by_slug


def resolve_identical_slug_source(paths: list[Path] | None) -> Path | None:
    candidates = [path for path in (paths or []) if path.is_file()]
    if not candidates:
        return None
    expected = candidates[0].read_bytes()
    if any(path.read_bytes() != expected for path in candidates[1:]):
        return None
    return candidates[0]


def resolve_texture_source(
    source_roots: list[Path] | Path,
    relative: str,
    texture_index: dict[str, Any],
    by_file: dict[str, Path],
    by_slug: dict[str, list[Path]],
) -> Path | None:
    if isinstance(source_roots, Path):
        source_roots = [source_roots]
    for root in source_roots:
        exact = root / relative
        if exact.is_file():
            return exact
    filename = Path(relative).name
    parts = filename.split("_", 1)
    hash_id = parts[0].split(".", 1)[0]
    extension = Path(filename).suffix.lower()
    hash_only = by_file.get(f"{hash_id}{extension}".lower())
    if hash_only and hash_only.is_file():
        return hash_only
    entry = texture_index.get(hash_id) if isinstance(texture_index, dict) else None
    preferred = str(entry.get("preferredFile", "")) if isinstance(entry, dict) else ""
    preferred_path = by_file.get(preferred.lower()) if preferred else None
    if preferred_path and preferred_path.is_file():
        return preferred_path
    if len(parts) != 2:
        return None
    slug = parts[1].lower()
    same_slug = resolve_identical_slug_source(by_slug.get(slug))
    if same_slug:
        return same_slug
    base_slug = slug[:-len(extension)] if extension and slug.endswith(extension) else slug
    alternate_slug = (
        f"{base_slug[:-4]}{extension}"
        if base_slug.endswith("_lod")
        else f"{base_slug}_lod{extension}"
    )
    lod_source = resolve_identical_slug_source(by_slug.get(alternate_slug))
    if lod_source:
        return lod_source
    return None


def drop_unresolved_texture_slots(value: Any, unresolved: set[str]) -> int:
    dropped = 0
    if isinstance(value, dict):
        for key in list(value.keys()):
            child = value[key]
            if str(key).lower() in TEXTURE_SLOT_KEYS and isinstance(child, str) and child in unresolved:
                del value[key]
                dropped += 1
            else:
                dropped += drop_unresolved_texture_slots(child, unresolved)
    elif isinstance(value, list):
        for child in value:
            dropped += drop_unresolved_texture_slots(child, unresolved)
    return dropped


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets-dir", type=Path, default=Path(__file__).resolve().parents[1] / "assets")
    parser.add_argument(
        "--source-assets-dir",
        type=Path,
        action="append",
        default=[],
        help="Additional read-only asset roots used to resolve source textures. Repeatable.",
    )
    parser.add_argument("--demo-dir", type=Path, default=None, help="Descriptor/manifest staging directory (defaults to assets/demo).")
    parser.add_argument(
        "--reuse-demo-dir",
        type=Path,
        default=None,
        help="Reuse verified source-to-compressed mappings from another demo stage.",
    )
    parser.add_argument("--quality", type=int, default=90)
    parser.add_argument("--output-dir", default="demo/models_textures_v2")
    parser.add_argument("--workers", type=int, default=min(16, max(4, os.cpu_count() or 4)))
    args = parser.parse_args()
    assets = args.assets_dir.resolve()
    source_roots = [assets, *(path.resolve() for path in args.source_assets_dir)]
    demo_dir = args.demo_dir.resolve() if args.demo_dir else assets / "demo"
    descriptor_path = demo_dir / "spawn_district.json"
    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
    source_manifest = demo_dir / Path(str(descriptor.get("manifestFile") or "spawn_district_models.json")).name
    target_manifest = demo_dir / "spawn_district_models_compressed_v2.json"
    if source_manifest.name in {
        target_manifest.name,
        "spawn_district_models_bootstrap_v1.json",
        "spawn_district_models_supermesh.json",
    }:
        canonical_mlo = demo_dir / "spawn_district_models_mlo.json"
        canonical_base = demo_dir / "spawn_district_models.json"
        source_manifest = canonical_mlo if canonical_mlo.is_file() else canonical_base
    output_relative = str(args.output_dir).strip("/\\").replace("\\", "/")
    texture_dir = assets / output_relative
    texture_dir.mkdir(parents=True, exist_ok=True)
    quality = max(1, min(100, args.quality))

    manifest = json.loads(source_manifest.read_text(encoding="utf-8"))
    texture_index: dict[str, Any] = {}
    by_file: dict[str, Path] = {}
    by_slug: dict[str, list[Path]] = {}
    for source_root in source_roots:
        try:
            source_index = json.loads((source_root / "models_textures" / "index.json").read_text(encoding="utf-8")).get("byHash", {})
            for key, value in source_index.items():
                texture_index.setdefault(key, value)
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            pass
        source_by_file, source_by_slug = build_texture_source_index(source_root)
        for key, value in source_by_file.items():
            by_file.setdefault(key, value)
        for key, values in source_by_slug.items():
            by_slug.setdefault(key, []).extend(values)
    cached_replacements: dict[str, str] = {}
    if target_manifest.is_file():
        try:
            prior_manifest = json.loads(target_manifest.read_text(encoding="utf-8"))
            if matching_structure(manifest, prior_manifest):
                collect_existing_replacements(manifest, prior_manifest, cached_replacements)
            else:
                collect_compatible_mesh_replacements(manifest, prior_manifest, cached_replacements)
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            cached_replacements.clear()
    if args.reuse_demo_dir:
        reuse_demo_dir = args.reuse_demo_dir.resolve()
        try:
            reuse_descriptor = json.loads((reuse_demo_dir / "spawn_district.json").read_text(encoding="utf-8"))
            reuse_source = reuse_demo_dir / Path(
                str(reuse_descriptor.get("sourceManifestFile") or reuse_descriptor.get("manifestFile") or "spawn_district_models.json")
            ).name
            if reuse_source.name in {
                "spawn_district_models_compressed_v2.json",
                "spawn_district_models_bootstrap_v1.json",
                "spawn_district_models_supermesh.json",
            }:
                reuse_mlo = reuse_demo_dir / "spawn_district_models_mlo.json"
                reuse_base = reuse_demo_dir / "spawn_district_models.json"
                reuse_source = reuse_mlo if reuse_mlo.is_file() else reuse_base
            reuse_compressed = reuse_demo_dir / "spawn_district_models_compressed_v2.json"
            reuse_source_payload = json.loads(reuse_source.read_text(encoding="utf-8"))
            reuse_compressed_payload = json.loads(reuse_compressed.read_text(encoding="utf-8"))
            if matching_structure(reuse_source_payload, reuse_compressed_payload):
                collect_existing_replacements(reuse_source_payload, reuse_compressed_payload, cached_replacements)
            else:
                collect_compatible_mesh_replacements(
                    reuse_source_payload,
                    reuse_compressed_payload,
                    cached_replacements,
                )
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            pass
    refs: dict[str, set[str]] = {}
    walk_texture_refs(manifest, refs)
    replacements: dict[str, str] = {}
    missing: list[str] = []
    unresolved_sources: list[str] = []
    aliased_sources = 0
    source_bytes = output_bytes = decoded_bytes = 0

    output_sizes: dict[str, int] = {}
    lossless_count = 0
    lossy_count = 0

    jobs: list[tuple[str, Path, tuple[str, ...], int]] = []
    for relative, roles in sorted(refs.items()):
        source = resolve_texture_source(source_roots, relative, texture_index, by_file, by_slug)
        if source is None:
            unresolved_sources.append(relative)
            payload = diagnostic_texture(set(roles))
            digest = hashlib.sha256(payload).hexdigest()[:24]
            target = texture_dir / f"{digest}.webp"
            if not target.exists():
                target.write_bytes(payload)
            target_relative = f"{output_relative}/{target.name}"
            replacements[relative] = target_relative
            output_sizes[target_relative] = len(payload)
            continue
        if relative.replace("\\", "/").startswith(output_relative + "/") and source.is_file():
            target = assets / relative
            if not target.is_file():
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.read_bytes())
            replacements[relative] = relative
            output_sizes[relative] = target.stat().st_size
            source_bytes += source.stat().st_size
            continue
        if source != assets / relative:
            aliased_sources += 1
        cached_relative = cached_replacements.get(relative)
        cached_target = assets / cached_relative if cached_relative else None
        if cached_target and cached_target.is_file() and cached_target_is_current(source, cached_target, roles):
            replacements[relative] = cached_relative
            output_sizes[cached_relative] = cached_target.stat().st_size
            source_bytes += source.stat().st_size
            is_lossless = requires_lossless(roles)
            if is_lossless:
                lossless_count += 1
            else:
                lossy_count += 1
            try:
                with Image.open(cached_target) as image:
                    decoded_bytes += image.width * image.height * 4 * 4 // 3
            except OSError:
                pass
            continue
        jobs.append((relative, source, tuple(sorted(roles)), quality))

    workers = max(1, min(32, int(args.workers)))
    completed = 0
    neutralized = 0
    reused = len(replacements)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for batch_start in range(0, len(jobs), 128):
            for result in pool.map(encode_texture, jobs[batch_start:batch_start + 128]):
                relative = result["relative"]
                if result.get("error"):
                    missing.append(relative)
                    print(
                        f"invalid texture source: {relative} -> {result.get('source')} ({result['error']})",
                        flush=True,
                    )
                    continue
                payload = result["payload"]
                target = texture_dir / f"{result['digest']}.webp"
                if not target.exists():
                    target.write_bytes(payload)
                target_relative = f"{output_relative}/{target.name}"
                replacements[relative] = target_relative
                output_sizes[target_relative] = len(payload)
                source_bytes += result["sourceBytes"]
                decoded_bytes += result["decodedBytes"]
                if result["lossless"]:
                    lossless_count += 1
                else:
                    lossy_count += 1
                if result.get("neutralized"):
                    neutralized += 1
                completed += 1
            print(f"encoded {completed}/{len(jobs)} textures", flush=True)

    output_bytes = sum(output_sizes.values())

    compressed = replace_refs(manifest, replacements)
    # Keep unresolved bindings intact. ModelManager uses their sampler metadata
    # to classify materials before TexturePathResolver applies its runtime
    # fallback; deleting the slots can make otherwise valid submeshes disappear.
    dropped_unresolved_slots = 0
    compressed["schema"] = "webglgta-demo-manifest-compressed-v1"
    compressed["textureCompression"] = {
        "format": "webp",
        "colorCap": 512,
        "dataCap": 256,
        "quality": quality,
        "dataEncoding": "lossless",
        "alphaEncoding": "lossless",
        "sourceReferences": len(refs),
        "convertedReferences": len(replacements),
        "aliasedSourceReferences": aliased_sources,
        "unresolvedReferences": len(missing),
        "unresolvedSourceReferences": len(unresolved_sources),
        "generatedDiagnosticReferences": len(unresolved_sources),
        "droppedUnresolvedSlots": dropped_unresolved_slots,
        "losslessTextures": lossless_count,
        "lossyColorTextures": lossy_count,
    }
    target_manifest.write_text(json.dumps(compressed, separators=(",", ":")), encoding="utf-8")
    descriptor["manifestFile"] = "demo/spawn_district_models_compressed_v2.json"
    descriptor["compressedTextureBytes"] = output_bytes
    descriptor["compressedTextureCount"] = len(set(replacements.values()))
    descriptor_path.write_text(json.dumps(descriptor, indent=2), encoding="utf-8")
    print(json.dumps({
        "references": len(refs),
        "converted": len(replacements),
        "reused": reused,
        "neutralizedDataTextures": neutralized,
        "missing": len(missing),
        "sourceUnresolved": len(unresolved_sources),
        "generatedDiagnostics": len(unresolved_sources),
        "aliasedSources": aliased_sources,
        "droppedUnresolvedSlots": dropped_unresolved_slots,
        "uniqueOutputs": len(set(replacements.values())),
        "sourceBytes": source_bytes,
        "outputBytes": output_bytes,
        "decodedMipBytes": decoded_bytes,
        "manifestBytes": target_manifest.stat().st_size,
        "missingSamples": missing[:10],
        "unresolvedSourceSamples": unresolved_sources[:10],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

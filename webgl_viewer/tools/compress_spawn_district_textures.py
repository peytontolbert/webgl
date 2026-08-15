#!/usr/bin/env python3
"""Build a capped, content-addressed WebP texture pack for the 150 m demo district."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path
from typing import Any

from PIL import Image


COLOR_KEYS = {"diffuse", "foliagediffuse", "diffuse2", "emissive", "env"}
LOSSLESS_KEYS = {"normal", "spec", "detail", "height", "tintpalette"}


def walk_texture_refs(value: Any, refs: dict[str, set[str]], parent_key: str = "") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            walk_texture_refs(child, refs, str(key).lower())
    elif isinstance(value, list):
        for child in value:
            walk_texture_refs(child, refs, parent_key)
    elif isinstance(value, str) and value.startswith("models_textures/"):
        refs.setdefault(value, set()).add(parent_key)


def replace_refs(value: Any, replacements: dict[str, str]) -> Any:
    if isinstance(value, dict):
        return {key: replace_refs(child, replacements) for key, child in value.items()}
    if isinstance(value, list):
        return [replace_refs(child, replacements) for child in value]
    if isinstance(value, str):
        return replacements.get(value, value)
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets-dir", type=Path, default=Path(__file__).resolve().parents[1] / "assets")
    parser.add_argument("--quality", type=int, default=90)
    parser.add_argument("--output-dir", default="demo/models_textures_v2")
    args = parser.parse_args()
    assets = args.assets_dir.resolve()
    source_manifest = assets / "demo" / "spawn_district_models.json"
    target_manifest = assets / "demo" / "spawn_district_models_compressed_v2.json"
    descriptor_path = assets / "demo" / "spawn_district.json"
    output_relative = str(args.output_dir).strip("/\\").replace("\\", "/")
    texture_dir = assets / output_relative
    texture_dir.mkdir(parents=True, exist_ok=True)

    manifest = json.loads(source_manifest.read_text(encoding="utf-8"))
    refs: dict[str, set[str]] = {}
    walk_texture_refs(manifest, refs)
    replacements: dict[str, str] = {}
    missing: list[str] = []
    source_bytes = output_bytes = decoded_bytes = 0

    output_sizes: dict[str, int] = {}
    lossless_count = 0
    lossy_count = 0

    for relative, roles in sorted(refs.items()):
        source = assets / relative
        if not source.is_file():
            missing.append(relative)
            continue
        source_bytes += source.stat().st_size
        with Image.open(source) as opened:
            image = opened.convert("RGBA")
        cap = 512 if roles & COLOR_KEYS else 256
        if max(image.size) > cap:
            scale = cap / max(image.size)
            image = image.resize(
                (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
                Image.Resampling.LANCZOS,
            )
        encoded = io.BytesIO()
        is_lossless = bool(roles & LOSSLESS_KEYS) or any(role.startswith("terrainnormal") for role in roles)
        if is_lossless:
            image.save(encoded, format="WEBP", lossless=True, method=4, exact=True)
            lossless_count += 1
        else:
            image.save(encoded, format="WEBP", quality=max(1, min(100, args.quality)), method=6, exact=True)
            lossy_count += 1
        payload = encoded.getvalue()
        digest = hashlib.sha256(payload).hexdigest()[:24]
        target = texture_dir / f"{digest}.webp"
        if not target.exists():
            target.write_bytes(payload)
        target_relative = f"{output_relative}/{target.name}"
        replacements[relative] = target_relative
        output_sizes[target_relative] = len(payload)
        decoded_bytes += image.width * image.height * 4 * 4 // 3

    output_bytes = sum(output_sizes.values())

    compressed = replace_refs(manifest, replacements)
    compressed["schema"] = "webglgta-demo-manifest-compressed-v1"
    compressed["textureCompression"] = {
        "format": "webp",
        "colorCap": 512,
        "dataCap": 256,
        "quality": max(1, min(100, args.quality)),
        "dataEncoding": "lossless",
        "alphaEncoding": "lossless",
        "sourceReferences": len(refs),
        "convertedReferences": len(replacements),
        "losslessTextures": lossless_count,
        "lossyColorTextures": lossy_count,
    }
    target_manifest.write_text(json.dumps(compressed, separators=(",", ":")), encoding="utf-8")
    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
    descriptor["manifestFile"] = "demo/spawn_district_models_compressed_v2.json"
    descriptor["compressedTextureBytes"] = output_bytes
    descriptor["compressedTextureCount"] = len(set(replacements.values()))
    descriptor_path.write_text(json.dumps(descriptor, indent=2), encoding="utf-8")
    print(json.dumps({
        "references": len(refs),
        "converted": len(replacements),
        "missing": len(missing),
        "uniqueOutputs": len(set(replacements.values())),
        "sourceBytes": source_bytes,
        "outputBytes": output_bytes,
        "decodedMipBytes": decoded_bytes,
        "manifestBytes": target_manifest.stat().st_size,
        "missingSamples": missing[:10],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Compress texture payloads recovered from loose FiveM MLO drawables."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
from typing import Any

from compress_spawn_district_textures import encode_texture, replace_refs


RECOVERED_PREFIX = "mlo_textures/embedded_recovered/"
PARAMETER_ROLES = {
    "4059966321": "diffuse",
    "1186448975": "normal",
    "1619499462": "spec",
    "4131954791": "tintpalette",
}


def collect_references(value: Any, output: dict[str, set[str]], parent_key: str = "") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            collect_references(child, output, str(key).lower())
    elif isinstance(value, list):
        for child in value:
            collect_references(child, output, parent_key)
    elif isinstance(value, str) and value.startswith(RECOVERED_PREFIX):
        output.setdefault(value, set()).add(PARAMETER_ROLES.get(parent_key, parent_key))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output-dir", default="mlo_textures/recovered_v2")
    parser.add_argument("--quality", type=int, default=90)
    parser.add_argument("--workers", type=int, default=min(16, max(4, os.cpu_count() or 4)))
    args = parser.parse_args()

    assets = args.assets_dir.resolve()
    manifest_path = args.manifest.resolve()
    output_relative = str(args.output_dir).strip("/\\").replace("\\", "/")
    output_dir = assets / output_relative
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    references: dict[str, set[str]] = {}
    collect_references(manifest, references)

    jobs = []
    for relative, roles in sorted(references.items()):
        source = assets / relative
        if not source.is_file():
            raise FileNotFoundError(f"Recovered MLO texture is missing: {source}")
        jobs.append((relative, source, tuple(sorted(roles)), max(1, min(100, args.quality))))

    replacements = {}
    source_bytes = 0
    output_bytes = 0
    lossless = 0
    with ThreadPoolExecutor(max_workers=max(1, min(32, args.workers))) as pool:
        for result in pool.map(encode_texture, jobs):
            if result.get("error"):
                raise RuntimeError(f"Could not compress {result['relative']}: {result['error']}")
            target = output_dir / f"{result['digest']}.webp"
            if not target.exists():
                target.write_bytes(result["payload"])
            replacements[result["relative"]] = f"{output_relative}/{target.name}"
            source_bytes += int(result["sourceBytes"])
            output_bytes += len(result["payload"])
            lossless += int(bool(result["lossless"]))

    compressed = replace_refs(manifest, replacements)
    summary = compressed.setdefault("textureCompression", {})
    summary["recoveredMloTextures"] = len(replacements)
    summary["recoveredMloSourceBytes"] = source_bytes
    summary["recoveredMloCompressedBytes"] = output_bytes
    summary["recoveredMloLosslessTextures"] = lossless
    manifest_path.write_text(json.dumps(compressed, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({
        "textures": len(replacements),
        "losslessTextures": lossless,
        "sourceBytes": source_bytes,
        "compressedBytes": output_bytes,
        "ratio": round(output_bytes / source_bytes, 4) if source_bytes else 0,
        "outputDir": str(output_dir),
        "manifest": str(manifest_path),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

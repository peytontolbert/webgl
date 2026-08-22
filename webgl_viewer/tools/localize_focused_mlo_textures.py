#!/usr/bin/env python3
"""Localize focused base texture references into the self-contained MLO namespace."""

from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path

from repair_mlo_texture_bindings import (
    _codewalker_checker_path,
    _load_json,
    _repair_manifest,
    _update_texture_compression_metadata,
    _wanted_hashes,
)


HASH_FILE_RE = re.compile(r"^(\d+)(?:_|\.)", re.IGNORECASE)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--missing-report", type=Path, required=True)
    parser.add_argument("--source-dir", type=Path, action="append", default=[])
    args = parser.parse_args()

    assets_dir = args.assets_dir.resolve()
    manifest_path = args.manifest.resolve()
    wanted = _wanted_hashes(_load_json(args.missing_report.resolve()))
    candidates: dict[str, Path] = {}
    for source_dir in [assets_dir / "models_textures", *args.source_dir]:
        source_dir = source_dir.resolve()
        if not source_dir.is_dir():
            continue
        for source in sorted(source_dir.iterdir()):
            if not source.is_file():
                continue
            match = HASH_FILE_RE.match(source.name)
            texture_hash = str(int(match.group(1))) if match else ""
            if texture_hash not in wanted:
                continue
            previous = candidates.get(texture_hash)
            if previous is None or source.name.lower() == f"{texture_hash}.png":
                candidates[texture_hash] = source

    relative_dir = "mlo_textures/embedded_recovered/focused_base"
    output_dir = assets_dir / relative_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    paths: dict[str, str] = {}
    copied_bytes = 0
    for texture_hash, source in sorted(candidates.items(), key=lambda item: int(item[0])):
        suffix = source.suffix.lower() if source.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"} else ".png"
        target = output_dir / f"{texture_hash}{suffix}"
        if source.resolve() != target.resolve():
            shutil.copy2(source, target)
        paths[texture_hash] = f"{relative_dir}/{target.name}"
        copied_bytes += target.stat().st_size

    if "1551155749" in wanted:
        paths["1551155749"] = _codewalker_checker_path(assets_dir)

    manifest = _load_json(manifest_path)
    repaired, unresolved = _repair_manifest(manifest, wanted, paths)
    metadata_changed = _update_texture_compression_metadata(manifest, unresolved)
    if repaired or metadata_changed:
        manifest_path.write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")

    print(json.dumps({
        "wantedHashes": len(wanted),
        "localizedTextures": len(paths),
        "localizedBytes": copied_bytes,
        "repairedBindings": repaired,
        "unresolvedHashes": sorted(unresolved, key=int),
        "manifest": str(manifest_path),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

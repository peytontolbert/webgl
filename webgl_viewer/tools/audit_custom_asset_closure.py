#!/usr/bin/env python3
"""Check that custom-runtime JSON manifests only reference files that ship.

This intentionally checks relative paths against the manifest that owns them.
That is important for small, independently streamed props (for example the
held phone): copying their mesh payload to ``assets/models`` while leaving the
manifest path local creates a runtime 404 which the normal world-pack closure
check cannot see.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Iterator


DEFAULT_ROOTS = ("custom_phone", "custom_weapons", "custom_vehicles", "custom_clothing")
FILE_SUFFIXES = (".bin", ".bin.gz", ".json", ".png", ".jpg", ".jpeg", ".webp", ".ktx2", ".skp", ".skp.gz", ".pal", ".pal.gz", ".mp3", ".ogg", ".wav", ".webm")
TEXTURE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp", ".ktx2")
ASSET_ROOTS = ("audio/", "collision/", "custom_", "demo/", "meta/", "mlo_textures/", "models/", "models_textures/", "navigation/", "peds/", "nexus_")


def iter_keyed_values(value: Any, path: str = "$") -> Iterator[tuple[str, str, str]]:
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}"
            if isinstance(child, str):
                yield str(key), child, child_path
            else:
                yield from iter_keyed_values(child, child_path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            child_path = f"{path}[{index}]"
            if isinstance(child, str):
                yield "", child, child_path
            else:
                yield from iter_keyed_values(child, child_path)


def is_file_reference(key: str, value: str, include_textures: bool) -> bool:
    clean = value.replace("\\", "/").split("?", 1)[0].strip()
    if not clean or clean.startswith(("@demo-pack/", "data:", "http://", "https://")):
        return False
    lower = clean.lower()
    if not lower.endswith(FILE_SUFFIXES):
        return False
    if lower.endswith(TEXTURE_SUFFIXES) and not include_textures:
        return False
    return key.lower() in {"file", "binaryfile", "manifestfile", "assetmanifest", "modelfile", "skeletonfile", "animationfile"}


def resolve_reference(assets_root: Path, manifest: Path, value: str) -> Path:
    clean = value.replace("\\", "/").split("?", 1)[0].lstrip("/")
    # ModelManager treats every loose mesh filename as relative to
    # ``assets/models``. It does not resolve mesh paths relative to the JSON
    # manifest that supplied them.
    if clean.lower().endswith((".bin", ".bin.gz")):
        return (assets_root / "models" / clean).resolve()
    if clean.startswith("assets/"):
        return (assets_root / clean.removeprefix("assets/")).resolve()
    if clean.startswith(ASSET_ROOTS):
        return (assets_root / clean).resolve()
    return (manifest.parent / clean).resolve()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("assets", type=Path, help="Deployed assets directory")
    parser.add_argument("--roots", nargs="*", default=list(DEFAULT_ROOTS), help="Asset subdirectories containing custom manifests")
    parser.add_argument("--prefix", action="append", default=[], help="Only inspect manifests whose filename starts with this prefix (repeatable)")
    parser.add_argument("--include-textures", action="store_true", help="Also report texture references (normally audited separately because texture fallback is supported)")
    args = parser.parse_args()
    assets_root = args.assets.resolve()
    prefixes = tuple(str(prefix).lower() for prefix in args.prefix if str(prefix))
    manifests = [
        path
        for name in args.roots
        for path in (assets_root / name).rglob("*.json")
        if path.is_file() and (not prefixes or path.name.lower().startswith(prefixes))
    ]
    reference_count = 0
    missing: list[dict[str, str]] = []
    parse_errors: list[dict[str, str]] = []
    existence_cache: dict[Path, bool] = {}
    for manifest in sorted(manifests):
        try:
            payload = json.loads(manifest.read_text(encoding="utf-8"))
        except Exception as error:
            parse_errors.append({"manifest": manifest.relative_to(assets_root).as_posix(), "error": str(error)})
            continue
        for key, value, json_path in iter_keyed_values(payload):
            if not is_file_reference(key, value, args.include_textures):
                continue
            target = resolve_reference(assets_root, manifest, value)
            exists = existence_cache.setdefault(target, target.is_file())
            reference_count += 1
            entry = {
                "manifest": manifest.relative_to(assets_root).as_posix(),
                "jsonPath": json_path,
                "reference": value,
                "resolved": target.relative_to(assets_root).as_posix() if target.is_relative_to(assets_root) else str(target),
                "exists": str(exists).lower(),
            }
            if not exists:
                missing.append(entry)
    print(json.dumps({
        "schema": "webglgta-custom-asset-closure-v1",
        "manifests": len(manifests),
        "references": reference_count,
        "missing": missing,
        "parseErrors": parse_errors,
    }, indent=2, sort_keys=True))
    return 1 if missing or parse_errors else 0


if __name__ == "__main__":
    raise SystemExit(main())

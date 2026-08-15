#!/usr/bin/env python3
"""Build a compact, demo-only production directory from the local asset export."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"


def json_file(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def resolve_mesh_entry(manifest: dict[str, Any], hash_id: str) -> Any:
    entry = manifest.get("meshes", {}).get(hash_id)
    if entry:
        return entry
    shard_id = int(hash_id) & 0xFF
    shard_path = ASSETS / "models" / "manifest_shards" / f"{shard_id:02x}.json"
    if not shard_path.is_file():
        return None
    return json_file(shard_path).get("meshes", {}).get(hash_id)


def collect_entry_paths(value: Any, output: set[Path]) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if isinstance(child, str):
                rel = child.replace("\\", "/").lstrip("/")
                if rel.startswith("@demo-pack/"):
                    continue
                if key == "file" and rel.endswith(".bin"):
                    output.add(ASSETS / "models" / rel)
                elif rel.startswith(("models_textures/", "peds/", "custom_weapons/", "custom_clothing/")):
                    output.add(ASSETS / rel)
            else:
                collect_entry_paths(child, output)
    elif isinstance(value, list):
        for child in value:
            collect_entry_paths(child, output)


def copy_file(source: Path, target_root: Path, copied: set[Path], missing: set[Path]) -> None:
    if not source.is_file():
        missing.add(source)
        return
    try:
        rel = source.relative_to(ROOT)
    except ValueError:
        return
    if rel.parts and rel.parts[0] == "assets":
        rel = Path("dist") / rel
    target = target_root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    copied.add(rel)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "demo_deploy")
    args = parser.parse_args()
    output = args.output.resolve()
    if output == ROOT or ROOT not in output.parents:
        raise SystemExit("output must be a child of the webgl_viewer directory")
    output.mkdir(parents=True, exist_ok=True)

    wanted: set[Path] = set()
    copied: set[Path] = set()
    missing: set[Path] = set()

    for path in (ROOT / "dist" / "bundled").glob("*"):
        if path.is_file():
            wanted.add(path)
    wanted.add(ROOT / "dist" / "index.html")
    for name in ("demo_server.js", "multiplayer_server.js", "package.json", "package-lock.json"):
        wanted.add(ROOT / name)

    for path in ASSETS.iterdir():
        if path.is_file():
            wanted.add(path)
    for dirname in ("demo", "collision", "peds", "custom_weapons", "custom_clothing"):
        wanted.update(path for path in (ASSETS / dirname).rglob("*") if path.is_file())
    wanted.add(ASSETS / "models" / "manifest.json")

    manifest = json_file(ASSETS / "models" / "manifest.json")
    meshes = manifest.get("meshes", {})
    catalog = json_file(ASSETS / "character_component_catalog.json")
    hashes = {"970598228"}  # Sultan used by the bounded demo.
    for components in catalog.get("models", {}).values():
        for variants in components.values():
            for item in variants:
                if item.get("hash"):
                    hashes.add(str(item["hash"]))
                hashes.update(str(value) for value in (item.get("textureAssets") or {}).values() if value)
    for hash_id in hashes:
        entry = resolve_mesh_entry(manifest, hash_id)
        if entry:
            meshes[hash_id] = entry
            collect_entry_paths(entry, wanted)

    for manifest_path in (
        ASSETS / "demo" / "spawn_district_models.json",
        ASSETS / "custom_weapons" / "glock17.json",
        ASSETS / "custom_clothing" / "nx_chains.json",
    ):
        collect_entry_paths(json_file(manifest_path), wanted)

    for source in sorted(wanted):
        copy_file(source, output, copied, missing)

    # The production demo intentionally omits the large shard index. Merge any
    # requested shard-only assets into its standalone manifest before serving.
    packaged_manifest = output / "dist" / "assets" / "models" / "manifest.json"
    packaged_manifest.write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")

    total = sum((output / rel).stat().st_size for rel in copied)
    report = {
        "schema": "webglgta-demo-deployment-v1",
        "files": len(copied),
        "bytes": total,
        "mib": round(total / (1024 * 1024), 1),
        "appearanceHashes": len(hashes),
        "missing": [str(path.relative_to(ROOT)) for path in sorted(missing) if ROOT in path.parents],
    }
    (output / "deployment_manifest.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

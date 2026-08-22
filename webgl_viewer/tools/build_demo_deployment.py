#!/usr/bin/env python3
"""Build a compact, demo-only production directory from the local asset export."""

from __future__ import annotations

import argparse
import gzip
import json
import re
import shutil
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
TEXTURE_FILE_RE = re.compile(r"^(?P<hash>\d+)(?:_(?P<slug>.*))?\.(?:png|webp|jpg|jpeg)$", re.IGNORECASE)
GAMEPLAY_DIRS = (
    "custom_clothing", "custom_phone", "custom_vehicles", "custom_weapons",
    "emotes", "gta_audio", "inventory", "nexus-resources", "nexus_inventory",
    "nx-items", "peds", "physics", "tracks", "vehicle_audio",
)


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
                    pack_name = rel[len("@demo-pack/"):].split("#", 1)[0]
                    if pack_name:
                        output.add(ASSETS / "demo" / pack_name)
                    continue
                if rel.startswith("demo/"):
                    output.add(ASSETS / rel)
                    continue
                if key == "file" and rel.endswith((".bin", ".msh9.gz")):
                    output.add(ASSETS / "models" / rel)
                elif rel.startswith(("models_textures/", "peds/", "custom_weapons/", "custom_clothing/", "custom_vehicles/")):
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
        rel = Path("dist") / "assets" / source.relative_to(ASSETS)
    except ValueError:
        try:
            rel = source.relative_to(ROOT)
        except ValueError:
            return
    target = target_root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    copied.add(rel)


def write_compact_texture_index(texture_dir: Path) -> None:
    """Index only textures that are physically present in the compact deployment."""
    by_hash: dict[str, dict[str, Any]] = {}
    if texture_dir.is_dir():
        for path in sorted(texture_dir.iterdir(), key=lambda item: item.name.lower()):
            if not path.is_file():
                continue
            match = TEXTURE_FILE_RE.match(path.name)
            if not match:
                continue
            hash_id = match.group("hash")
            entry = by_hash.setdefault(hash_id, {"files": [], "hash": hash_id})
            entry["files"].append(path.name)

    for entry in by_hash.values():
        hash_id = entry["hash"]
        hash_only = next((name for name in entry["files"] if Path(name).stem == hash_id), None)
        entry["hashOnly"] = hash_only is not None
        entry["preferredFile"] = hash_only or entry["files"][0]

    texture_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema": "webglgta-models-textures-index-v1",
        "count": len(by_hash),
        "byHash": by_hash,
    }
    (texture_dir / "index.json").write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")


def compress_runtime_binaries(output: Path, *, keep_raw: bool) -> dict[str, int | bool]:
    """Replace runtime MSH0/YBNC/compiled collision binaries with deterministic gzip files.

    The browser requests `<file>.gz` first through `fetchArrayBufferPreferredCompressed()`
    and still supports a raw fallback for older deployments. We deliberately only
    transform binaries whose runtime readers use that helper: model/demo mesh packs
    and collision `.bin`/`.cwct` files.
    """
    assets = output / "dist" / "assets"
    candidates: list[Path] = []
    demo_dir = assets / "demo"
    if demo_dir.is_dir():
        for path in demo_dir.rglob("*.bin"):
            try:
                with path.open("rb") as source:
                    if source.read(4) == b"MSH0":
                        candidates.append(path)
            except OSError:
                continue
    models_dir = assets / "models"
    if models_dir.is_dir():
        candidates.extend(path for path in models_dir.rglob("*.bin") if path.is_file())
    collision_dir = assets / "collision"
    if collision_dir.is_dir():
        candidates.extend(
            path for path in collision_dir.rglob("*")
            if path.is_file() and path.suffix.lower() in {".bin", ".cwct"}
        )

    source_bytes = 0
    compressed_bytes = 0
    for source in candidates:
        source_bytes += source.stat().st_size
        target = source.with_name(source.name + ".gz")
        temporary = target.with_name(target.name + ".tmp")
        try:
            with source.open("rb") as input_file, temporary.open("wb") as output_file:
                # Fixed mtime makes repeated deployments byte-for-byte reproducible.
                with gzip.GzipFile(fileobj=output_file, mode="wb", compresslevel=9, mtime=0) as compressed:
                    shutil.copyfileobj(input_file, compressed, length=1024 * 1024)
            temporary.replace(target)
        finally:
            if temporary.exists():
                temporary.unlink()
        compressed_bytes += target.stat().st_size
        if not keep_raw:
            source.unlink()

    return {
        "files": len(candidates),
        "sourceBytes": source_bytes,
        "compressedBytes": compressed_bytes,
        "savedBytes": (source_bytes - compressed_bytes) if not keep_raw else 0,
        "keptRaw": keep_raw,
    }


def main() -> int:
    global ASSETS
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "demo_deploy")
    parser.add_argument(
        "--assets-dir",
        type=Path,
        default=ASSETS,
        help="Asset tree to package; defaults to the repository assets directory.",
    )
    parser.add_argument(
        "--world-only",
        action="store_true",
        help="Build an overlay containing code, the active demo world, and collision only.",
    )
    parser.add_argument(
        "--vehicle-overlay",
        action="store_true",
        help="Build only production code and lazy custom-vehicle assets for an existing demo deployment.",
    )
    parser.add_argument(
        "--keep-runtime-binaries",
        action="store_true",
        help="Keep raw demo mesh/collision binaries alongside .gz files for legacy browser compatibility.",
    )
    args = parser.parse_args()
    ASSETS = args.assets_dir.resolve()
    if not ASSETS.is_dir():
        raise SystemExit(f"assets directory does not exist: {ASSETS}")
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

    if args.vehicle_overlay:
        custom_root = ASSETS / "custom_vehicles"
        wanted.update(path for path in custom_root.rglob("*") if path.is_file())
        catalog_path = custom_root / "catalog.json"
        catalog = json_file(catalog_path)
        for vehicle in catalog.get("vehicles", []):
            manifest_path = ASSETS / str(vehicle.get("manifest") or "")
            wanted.add(manifest_path)
            if manifest_path.is_file():
                collect_entry_paths(json_file(manifest_path), wanted)
        for source in sorted(wanted):
            copy_file(source, output, copied, missing)
        total = sum((output / rel).stat().st_size for rel in copied)
        report = {
            "schema": "webglgta-demo-vehicle-overlay-v1",
            "files": len(copied), "bytes": total, "mib": round(total / (1024 * 1024), 1),
            "vehicles": len(catalog.get("vehicles", [])),
            "missing": [str(path.relative_to(ROOT)) for path in sorted(missing) if ROOT in path.parents],
        }
        (output / "deployment_manifest.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report, indent=2))
        return 1 if missing else 0

    if not args.world_only:
        for path in ASSETS.iterdir():
            if path.is_file():
                wanted.add(path)
        # Interior manifests can refer to standalone MLO meshes rather than
        # the district mesh packs. They are small enough to ship as a complete
        # set and omitting them turns a normal MLO stream into repeated 404s.
        wanted.update(path for path in (ASSETS / "models" / "mlo").rglob("*") if path.is_file())
    runtime_dirs = ("collision", "interiors") if args.world_only else ("collision", "interiors", "meta", "navigation", *GAMEPLAY_DIRS)
    for dirname in runtime_dirs:
        wanted.update(path for path in (ASSETS / dirname).rglob("*") if path.is_file())
    if not args.world_only:
        wanted.add(ASSETS / "models" / "manifest.json")
        vehicle_catalog_path = ASSETS / "custom_vehicles" / "catalog.json"
        if vehicle_catalog_path.is_file():
            vehicle_catalog = json_file(vehicle_catalog_path)
            for vehicle in vehicle_catalog.get("vehicles", []):
                manifest_rel = str(vehicle.get("manifest") or "")
                if not manifest_rel:
                    continue
                manifest_path = ASSETS / manifest_rel
                wanted.add(manifest_path)
                if manifest_path.is_file():
                    collect_entry_paths(json_file(manifest_path), wanted)

    manifest = json_file(ASSETS / "models" / "manifest.json") if not args.world_only else {"meshes": {}}
    meshes = manifest.get("meshes", {})
    catalog = json_file(ASSETS / "character_component_catalog.json") if not args.world_only else {"models": {}}
    hashes = set() if args.world_only else {"970598228"}  # Sultan used by the bounded demo.
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

    demo_descriptor_path = ASSETS / "demo" / "spawn_district.json"
    wanted.add(demo_descriptor_path)
    demo_descriptor = json_file(demo_descriptor_path)
    compiled_collision_manifest = str(demo_descriptor.get("compiledCollisionManifestFile") or "").strip()
    # A descriptor selecting compiled collision never loads the monolithic YBNC
    # fallback. Keeping it in a compact deployment wastes disk and forces the
    # browser to download a payload that is immediately discarded.
    if compiled_collision_manifest:
        wanted.discard(ASSETS / "collision" / "ybn_spawn.json")
        wanted.discard(ASSETS / "collision" / "ybn_spawn.bin")

    # These files are fetched by runtime convention rather than through a
    # normal manifest edge, so include them explicitly in the closure.
    if not args.world_only:
        wanted.update((
            ASSETS / "models" / "non_renderable_archetypes.json",
            ASSETS / "meta" / "steps.json",
        ))
    for interior_hash in (demo_descriptor.get("mloRuntime") or {}).get("interiorArchetypeHashes") or []:
        wanted.add(ASSETS / "interiors" / f"{interior_hash}.json")

    world_config = demo_descriptor.get("worldConfig") or {}
    world_config_rel = str(world_config.get("file") or "demo_world.json").replace("\\", "/").lstrip("/")
    world_config_source = ASSETS / world_config_rel
    if not world_config_source.is_file() and world_config_rel == "demo_world.json":
        world_config_source = ROOT / "demo_world.json"
    collect_entry_paths(demo_descriptor, wanted)
    fragment_rel = str(demo_descriptor.get("fragmentChildrenManifestFile") or "").strip()
    if fragment_rel:
        fragment_path = ASSETS / fragment_rel
        wanted.add(fragment_path)
        if fragment_path.is_file():
            collect_entry_paths(json_file(fragment_path), wanted)
    supermesh = demo_descriptor.get("staticSupermesh") if isinstance(demo_descriptor.get("staticSupermesh"), dict) else {}
    index_rels = {
        str(demo_descriptor.get("instanceIndexFile") or "").strip(),
        str(demo_descriptor.get("sourceInstanceIndexFile") or "").strip(),
        str(supermesh.get("instanceIndexFile") or "").strip(),
    }
    for demo_index_rel in index_rels - {""}:
        demo_index_path = ASSETS / demo_index_rel
        if demo_index_path.is_file():
            wanted.add(demo_index_path)
            demo_index = json_file(demo_index_path)
            for chunk in (demo_index.get("chunks") or {}).values():
                binary_rel = str(chunk.get("binaryFile") or "").strip()
                if binary_rel:
                    wanted.add(ASSETS / binary_rel)

    manifest_rels = {
        str(demo_descriptor.get("manifestFile") or "demo/spawn_district_models_compressed_v2.json"),
        str(demo_descriptor.get("sourceManifestFile") or "").strip(),
        str(supermesh.get("manifestFile") or "").strip(),
    }
    manifests = [ASSETS / rel for rel in manifest_rels - {""}]
    if not args.world_only:
        manifests.extend((
            ASSETS / "custom_weapons" / "glock17.json",
            ASSETS / "custom_clothing" / "nx_chains.json",
        ))
    for manifest_path in manifests:
        collect_entry_paths(json_file(manifest_path), wanted)

    for source in sorted(wanted):
        copy_file(source, output, copied, missing)

    world_config_target = output / "dist" / "assets" / world_config_rel
    world_config_target.parent.mkdir(parents=True, exist_ok=True)
    if world_config_source.is_file():
        shutil.copy2(world_config_source, world_config_target)
        copied.add(Path("dist") / "assets" / world_config_rel)
    else:
        missing.add(world_config_source)

    # The production demo intentionally omits the large shard index. Merge any
    # requested shard-only assets into its standalone manifest before serving.
    if not args.world_only:
        packaged_manifest = output / "dist" / "assets" / "models" / "manifest.json"
        packaged_manifest.write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
        # ModelManager probes this path before manifest.json. A small non-sharded
        # sentinel prevents a stale full-game index from advertising shards that
        # are intentionally absent from the compact deployment.
        packaged_index = packaged_manifest.with_name("manifest_index.json")
        packaged_index.write_text(json.dumps({
            "schema": "webglgta-compact-manifest-v1",
            "source": "manifest.json",
        }, separators=(",", ":")), encoding="utf-8")
        stale_shards = packaged_manifest.parent / "manifest_shards"
        if stale_shards.is_dir():
            shutil.rmtree(stale_shards)
        write_compact_texture_index(output / "dist" / "assets" / "models_textures")

    compression = compress_runtime_binaries(output, keep_raw=bool(args.keep_runtime_binaries))

    deployed_files = [path for path in output.rglob("*") if path.is_file()]
    total = sum(path.stat().st_size for path in deployed_files)
    report = {
        "schema": "webglgta-demo-deployment-v1",
        "files": len(deployed_files),
        "bytes": total,
        "mib": round(total / (1024 * 1024), 1),
        "appearanceHashes": len(hashes),
        "worldOnly": bool(args.world_only),
        "legacyYbnOmitted": bool(compiled_collision_manifest),
        "runtimeBinaryCompression": compression,
        "missing": [str(path.relative_to(ROOT)) for path in sorted(missing) if ROOT in path.parents],
    }
    (output / "deployment_manifest.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

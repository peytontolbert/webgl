#!/usr/bin/env python3
"""Export the GTA Online mpApartment barefoot components without hash collisions."""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
logging.disable(logging.CRITICAL)
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import export_runtime_ped_skinning as ped_export
from webgl_viewer.tools.export_runtime_character_catalog import namespace_model_assets, prune_missing_material_assets


COMPONENTS = (
    {
        "modelName": "mp_m_freemode_01",
        "modelHash": 1885233650,
        "drawable": 34,
        "collection": "male_apt01",
        "folder": "mp_m_freemode_01_male_apt01",
        "skinColor": [0.6756, 0.5159, 0.4382],
    },
    {
        "modelName": "mp_f_freemode_01",
        "modelHash": 2627665880,
        "drawable": 35,
        "collection": "female_apt01",
        "folder": "mp_f_freemode_01_female_apt01",
        "skinColor": [0.6734, 0.5307, 0.4734],
    },
)


def find_entry(cache, suffix: str):
    wanted = suffix.replace("/", "\\").lower()
    for rpf in list(cache.RpfMan.AllRpfs or []):
        for entry in list(getattr(rpf, "AllEntries", []) or []):
            path = str(getattr(entry, "Path", "") or "").replace("/", "\\").lower()
            if path.endswith(wanted):
                return entry
    raise RuntimeError(f"GTA archive entry not found: {suffix}")


def copy_tree_files(source: Path, target: Path) -> None:
    if not source.is_dir():
        return
    for path in source.rglob("*"):
        if not path.is_file():
            continue
        if path.name.startswith("manifest") and path.suffix == ".json":
            continue
        destination = target / path.relative_to(source)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)


def load_or_rebuild_manifest(assets: Path) -> dict:
    manifest_path = assets / "models" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    index_path = assets / "models" / "manifest_index.json"
    if not index_path.is_file():
        return manifest
    index = json.loads(index_path.read_text(encoding="utf-8"))
    expected = int(index.get("mesh_count") or 0)
    if len(manifest.get("meshes", {})) >= max(1, expected // 2):
        return manifest
    meshes = {}
    shard_dir = assets / "models" / str(index.get("shard_dir") or "manifest_shards")
    for shard_path in sorted(shard_dir.glob("*.json")):
        shard = json.loads(shard_path.read_text(encoding="utf-8"))
        meshes.update(shard.get("meshes", {}))
    if expected and len(meshes) < expected - 16:
        raise RuntimeError(f"Refusing incomplete manifest rebuild: {len(meshes)} of {expected} meshes")
    manifest = {"version": int(index.get("manifest_version") or 4), "meshes": meshes}
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Rebuilt aggregate manifest from shards ({len(meshes)} meshes)")
    return manifest


def export_component(game_path: str, assets: Path, spec: dict) -> str:
    manager = ped_export.DllManager(game_path)
    if not manager.initialized:
        raise RuntimeError("Failed to initialize CodeWalker")
    if not manager.init_game_file_cache(load_vehicles=False, load_peds=True, load_audio=False):
        raise RuntimeError("Failed to initialize GTA ped cache")
    cache = manager.get_game_file_cache()
    base = (
        "update\\x64\\dlcpacks\\mpapartment\\dlc.rpf\\x64\\models\\cdimages\\mpapt01.rpf\\"
        + spec["folder"]
    )
    ydd_entry = find_entry(cache, base + "\\feet_000_u.ydd")
    ytd_entry = find_entry(cache, base + "\\feet_diff_000_a_uni.ytd")

    original_selection = ped_export._ped_variation_selection
    original_ydds = ped_export._ped_component_ydd_entries
    original_ytds = ped_export._ped_component_ytd_entries
    source_hash = int(ped_export._joaat("feet_000_u", lower=True)) & 0xFFFFFFFF
    texture_hash = int(ped_export._joaat("feet_diff_000_a_uni", lower=True)) & 0xFFFFFFFF

    selection = {
        "componentId": 6,
        "drawable": int(spec["drawable"]),
        "palette": 0,
        "texture": 0,
        "drawableName": "feet_000_u",
        "textureName": "feet_diff_000_a_uni",
        "collection": spec["collection"],
        "collectionDrawable": 0,
        "label": "Barefoot",
        "barefoot": True,
    }
    profile = {
        "modelName": spec["modelName"],
        "modelHash": spec["modelHash"],
        "components": [dict(selection)],
        "render": {"mode": "freemode_components", "modelNames": ["feet_000_u"]},
    }

    with tempfile.TemporaryDirectory(prefix="webglgta-barefoot-") as temp_name:
        temp_assets = Path(temp_name) / "assets"
        temp_assets.mkdir(parents=True)
        profile_path = Path(temp_name) / "profile.json"
        profile_path.write_text(json.dumps(profile), encoding="utf-8")
        ped_export._ped_variation_selection = lambda *_args, **_kwargs: dict(selection)
        ped_export._ped_component_ydd_entries = lambda *_args, **_kwargs: {source_hash: ydd_entry}
        ped_export._ped_component_ytd_entries = lambda *_args, **_kwargs: {texture_hash: ytd_entry}
        old_argv = sys.argv
        try:
            sys.argv = [
                "export_runtime_ped_skinning.py",
                "--game-path", game_path,
                "--assets-dir", str(temp_assets),
                "--runtime-character", str(profile_path),
                "--selected-dlc", "all",
                "--force",
            ]
            ped_export.main()
        finally:
            sys.argv = old_argv
            ped_export._ped_variation_selection = original_selection
            ped_export._ped_component_ydd_entries = original_ydds
            ped_export._ped_component_ytd_entries = original_ytds

        manifest_path = temp_assets / "models" / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if namespace_model_assets(temp_assets, manifest, spec["modelName"]) != 1:
            raise RuntimeError(f"Expected one exported barefoot mesh for {spec['modelName']}")
        mesh_hash, mesh = next(iter(manifest["meshes"].items()))
        mesh["pedComponent"].update(selection)
        mesh["pedComponent"]["browserAssetHash"] = int(mesh_hash)
        mark_barefoot_skin_material(mesh, spec["skinColor"])
        prune_missing_material_assets(mesh, temp_assets)

        destination_manifest_path = assets / "models" / "manifest.json"
        destination_manifest = load_or_rebuild_manifest(assets)
        destination_manifest.setdefault("meshes", {})[mesh_hash] = mesh
        destination_manifest_path.write_text(json.dumps(destination_manifest, indent=2), encoding="utf-8")
        copy_tree_files(temp_assets / "models", assets / "models")
        copy_tree_files(temp_assets / "models_textures", assets / "models_textures")
    return mesh_hash


def mark_barefoot_skin_material(mesh: dict, skin_color: list[float]) -> None:
    for lod in (mesh.get("lods") or {}).values():
        for submesh in (lod.get("submeshes") or []):
            material = submesh.setdefault("material", {})
            diffuse = material.get("diffuse")
            if diffuse:
                material["pedSkinMaskDiffuse"] = diffuse
            material["pedSkinMask"] = True
            material["baseColor"] = list(skin_color)


def fix_existing_materials(assets: Path) -> dict[str, str]:
    manifest = load_or_rebuild_manifest(assets)
    hashes = {}
    for spec in COMPONENTS:
        for mesh_hash, mesh in manifest.get("meshes", {}).items():
            component = mesh.get("pedComponent") if isinstance(mesh, dict) else None
            if not isinstance(component, dict):
                continue
            if component.get("barefoot") is True and component.get("modelName") == spec["modelName"]:
                mark_barefoot_skin_material(mesh, spec["skinColor"])
                prune_missing_material_assets(mesh, assets)
                hashes[spec["modelName"]] = str(mesh_hash)
                break
    if len(hashes) != len(COMPONENTS):
        raise RuntimeError(f"Could not find both existing barefoot meshes: {hashes}")
    manifest_path = assets / "models" / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    from export_drawables_from_list import _update_manifest_shards_for_hashes

    _update_manifest_shards_for_hashes(assets / "models", manifest, list(hashes.values()))
    return hashes


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--game-path", required=True)
    parser.add_argument("--assets-dir", default=str(ROOT / "webgl_viewer" / "assets"))
    parser.add_argument("--fix-existing-materials-only", action="store_true")
    args = parser.parse_args()
    assets = Path(args.assets_dir).resolve()
    if args.fix_existing_materials_only:
        print(json.dumps(fix_existing_materials(assets), indent=2))
        return 0
    exported = {}
    for spec in COMPONENTS:
        exported[spec["modelName"]] = export_component(args.game_path, assets, spec)

    manifest = json.loads((assets / "models" / "manifest.json").read_text(encoding="utf-8"))
    from export_drawables_from_list import _update_manifest_shards_for_hashes

    _update_manifest_shards_for_hashes(assets / "models", manifest, list(exported.values()))
    catalog_path = assets / "character_component_catalog.json"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    for spec in COMPONENTS:
        mesh_hash = exported[spec["modelName"]]
        variants = catalog.setdefault("models", {}).setdefault(spec["modelName"], {}).setdefault("6", [])
        variants[:] = [variant for variant in variants if not bool(variant.get("barefoot"))]
        variants.insert(0, {
            "componentId": 6,
            "label": "Barefoot",
            "drawable": spec["drawable"],
            "assetName": "feet_000_u",
            "hash": mesh_hash,
            "textures": [0],
            "textureAssets": {"0": mesh_hash},
            "collection": spec["collection"],
            "collectionDrawable": 0,
            "variantKey": f"{spec['collection']}:6:0",
            "barefoot": True,
        })
    catalog_path.write_text(json.dumps(catalog, indent=2), encoding="utf-8")
    print(json.dumps(exported, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Export unique saved Illenium freemode components and build a browser catalog."""

from __future__ import annotations

import argparse
import copy
import json
import shutil
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path


COMPONENT_LABELS = {
    0: "Head", 1: "Mask", 2: "Hair", 3: "Upper body", 4: "Lower body",
    5: "Bags", 6: "Shoes", 7: "Accessories", 8: "Shirt", 9: "Body armor",
    10: "Decals", 11: "Jacket",
}


def joaat(value: str) -> int:
    result = 0
    for byte in value.lower().encode("utf-8"):
        result = (result + byte) & 0xFFFFFFFF
        result = (result + (result << 10)) & 0xFFFFFFFF
        result ^= result >> 6
    result = (result + (result << 3)) & 0xFFFFFFFF
    result ^= result >> 11
    result = (result + (result << 15)) & 0xFFFFFFFF
    return result & 0xFFFFFFFF


def namespace_model_assets(assets: Path, manifest: dict, model_name: str) -> int:
    """Move one freemode model off GTA's shared drawable-name hashes."""
    meshes = manifest.get("meshes", {})
    selected = []
    for source_hash, mesh in list(meshes.items()):
        component = mesh.get("pedComponent") if isinstance(mesh, dict) else None
        if not isinstance(component, dict) or str(component.get("modelName") or "") != model_name:
            continue
        if str(component.get("drawableHash", "")) != str(source_hash):
            continue
        selected.append((str(source_hash), mesh))

    texture_aliases: dict[str, str] = {}

    def alias_texture(relative: str) -> str:
        cached = texture_aliases.get(relative)
        if cached:
            return cached
        source = assets / relative
        suffix = source.suffix or ".png"
        token = joaat(f"webgl:{model_name}:{relative}")
        target_relative = f"models_textures/{model_name}_{token}{suffix}"
        target = assets / target_relative
        if source.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        texture_aliases[relative] = target_relative
        return target_relative

    def rewrite_paths(value, source_hash: str, alias_hash: str):
        if isinstance(value, dict):
            return {key: rewrite_paths(item, source_hash, alias_hash) for key, item in value.items()}
        if isinstance(value, list):
            return [rewrite_paths(item, source_hash, alias_hash) for item in value]
        if not isinstance(value, str):
            return value
        normalized = value.replace("\\", "/")
        if normalized.startswith("models_textures/"):
            return alias_texture(normalized)
        if normalized.endswith(".bin") and normalized.startswith(source_hash):
            target_name = alias_hash + normalized[len(source_hash):]
            source = assets / "models" / normalized
            target = assets / "models" / target_name
            if source.is_file():
                shutil.copy2(source, target)
            return target_name
        return value

    for source_hash, mesh in selected:
        alias_hash = str(joaat(f"webgl:{model_name}:{source_hash}"))
        salt = 0
        while alias_hash in meshes and alias_hash != source_hash:
            salt += 1
            alias_hash = str(joaat(f"webgl:{model_name}:{source_hash}:{salt}"))
        cloned = rewrite_paths(copy.deepcopy(mesh), source_hash, alias_hash)
        cloned["pedComponent"]["browserAssetHash"] = int(alias_hash)
        cloned["pedComponent"]["sourceDrawableHash"] = int(source_hash)
        meshes[alias_hash] = cloned
        del meshes[source_hash]
    return len(selected)


def prune_missing_material_assets(value, assets: Path) -> int:
    removed = 0
    if isinstance(value, dict):
        for key, item in list(value.items()):
            if isinstance(item, str) and item.replace("\\", "/").startswith("models_textures/"):
                if not (assets / item.replace("\\", "/")).is_file():
                    del value[key]
                    removed += 1
                    continue
            removed += prune_missing_material_assets(item, assets)
    elif isinstance(value, list):
        for item in value:
            removed += prune_missing_material_assets(item, assets)
    return removed


def full_variation_profile(root: Path, game_path: str, model_name: str, selected_dlc: str) -> dict:
    """Enumerate the exact base PedFile component table, including texture alternatives."""
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    from export_runtime_ped_skinning import DllManager, _as_u32, _iter_dict_keys, _joaat

    manager = DllManager(game_path)
    if not manager.initialized:
        raise RuntimeError("Failed to initialize CodeWalker DllManager")
    if not manager.init_game_file_cache(
        load_vehicles=False, load_peds=True, load_audio=False, selected_dlc=selected_dlc,
    ):
        raise RuntimeError("Failed to initialize GTA ped cache")
    cache = manager.get_game_file_cache()
    model_hash = int(_joaat(model_name, lower=True)) & 0xFFFFFFFF
    variations = getattr(cache, "PedVariationsDict", None)
    ped_file = None
    for key in _iter_dict_keys(variations):
        if _as_u32(key) == model_hash:
            ped_file = variations[key]
            break
    if ped_file is None:
        raise RuntimeError(f"No PedFile variation table for {model_name}")

    variation_info = getattr(ped_file, "VariationInfo", None)
    components = []
    names = []
    for component_id in range(12):
        component_data = variation_info.GetComponentData(component_id)
        drawable_data = getattr(component_data, "DrawblData3", None) or []
        for drawable_id, item in enumerate(drawable_data):
            if item is None:
                continue
            drawable_name = str(item.GetDrawableName(0) or "").strip()
            if not drawable_name:
                continue
            names.append(drawable_name)
            texture_data = getattr(item, "TexData", None)
            texture_count = max(1, len(texture_data) if texture_data is not None else int(item.NumAlternatives or 1))
            for texture_id in range(texture_count):
                try:
                    texture_name = str(item.GetTextureName(texture_id) or "").strip()
                except Exception:
                    texture_name = ""
                components.append({
                    "componentId": component_id,
                    "drawable": drawable_id,
                    "texture": texture_id,
                    "palette": 0,
                    "assetName": drawable_name,
                    "drawableName": drawable_name,
                    "textureName": texture_name or None,
                    "source": "CodeWalker PedFile full variation table",
                })

    return {
        "ok": True,
        "source": "CodeWalker PedFile full variation table",
        "modelName": model_name,
        "modelHash": model_hash,
        "components": components,
        "props": [],
        "appearance": {"hair": {"color": 0, "highlight": 0}},
        "render": {"mode": "freemode_components", "modelNames": sorted(set(names))},
    }


def signature(profile: dict) -> tuple:
    return tuple(
        sorted(
            (int(c.get("componentId", -1)), int(c.get("drawable", 0)), int(c.get("texture", 0)))
            for c in profile.get("components", []) if isinstance(c, dict)
        )
    )


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    assets = root / "webgl_viewer" / "assets"
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-path", required=True)
    ap.add_argument("--assets-dir", default=str(assets))
    ap.add_argument("--skip-default", action="store_true")
    ap.add_argument("--full-base-catalog", action="store_true", help="Export every drawable/texture in the ped variation table")
    ap.add_argument("--model", default="mp_m_freemode_01")
    ap.add_argument("--selected-dlc", default="all")
    ap.add_argument("--spins", type=int, default=120, help="Content load spins per drawable")
    ap.add_argument("--catalog-only", action="store_true", help="Rebuild catalog metadata from the existing manifest")
    ap.add_argument("--namespace-model-assets", action="store_true", help="Preserve this model under browser-only hashes before restoring another freemode model")
    args = ap.parse_args()
    assets = Path(args.assets_dir).resolve()
    source = json.loads((assets / "runtime_characters.json").read_text(encoding="utf-8"))
    profiles = [p for p in source.get("characters", []) if isinstance(p, dict)]
    if args.full_base_catalog:
        profiles = [full_variation_profile(root, args.game_path, args.model, args.selected_dlc)]

    unique: dict[tuple, dict] = {}
    for profile in profiles:
        sig = signature(profile)
        if args.skip_default and all(drawable == 0 and texture == 0 for _, drawable, texture in sig):
            continue
        unique.setdefault(sig, profile)

    if not args.catalog_only:
        exporter = root / "export_runtime_ped_skinning.py"
        with tempfile.TemporaryDirectory(prefix="webglgta-character-catalog-") as temp_dir:
            for index, profile in enumerate(unique.values()):
                temp_profile = Path(temp_dir) / f"profile_{index}.json"
                temp_profile.write_text(json.dumps(profile), encoding="utf-8")
                subprocess.run(
                    [
                        sys.executable, str(exporter), "--game-path", args.game_path,
                        "--assets-dir", str(assets), "--runtime-character", str(temp_profile),
                        "--selected-dlc", args.selected_dlc, "--spins", str(args.spins),
                    ],
                    cwd=str(root), check=True,
                )

    manifest = json.loads((assets / "models" / "manifest.json").read_text(encoding="utf-8"))
    if args.namespace_model_assets:
        count = namespace_model_assets(assets, manifest, args.model)
        print(f"Namespaced {count} {args.model} drawable assets")
    pruned_material_paths = 0
    for mesh in manifest.get("meshes", {}).values():
        component = mesh.get("pedComponent") if isinstance(mesh, dict) else None
        if not isinstance(component, dict):
            continue
        pruned_material_paths += prune_missing_material_assets(mesh, assets)
        is_tint_mask = int(component.get("componentId", -1)) == 2 and int(component.get("texture", 0)) == 0
        for lod in (mesh.get("lods") or {}).values():
            for submesh in (lod or {}).get("submeshes", []):
                material = submesh.get("material") if isinstance(submesh, dict) else None
                if isinstance(material, dict):
                    material["pedHairTint"] = bool(is_tint_mask)
                    if int(component.get("componentId", -1)) == 2:
                        order = ((material.get("shaderParams") or {}).get("vectorsByHash") or {}).get("1617153586")
                        material["skipColorPass"] = bool(isinstance(order, list) and order and float(order[0]) > 0.0)
                        material["alphaMode"] = "cutout"
                        material["alphaCutoff"] = 0.22
                        material["alphaToCoverage"] = True
                        material["doubleSided"] = True
    (assets / "models" / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    if pruned_material_paths:
        print(f"Pruned {pruned_material_paths} missing ped material asset references")
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    from export_drawables_from_list import _update_manifest_shards_for_hashes
    _update_manifest_shards_for_hashes(assets / "models", manifest, list(manifest.get("meshes", {}).keys()))
    variants: dict[tuple[str, int, int], dict] = {}
    for mesh_hash, mesh in manifest.get("meshes", {}).items():
        component = mesh.get("pedComponent")
        if not isinstance(component, dict):
            continue
        model = str(component.get("modelName") or "")
        component_id = int(component.get("componentId", -1))
        drawable = int(component.get("drawable", 0))
        texture = int(component.get("texture", 0))
        key = (model, component_id, drawable)
        row = variants.setdefault(key, {
            "componentId": component_id,
            "label": COMPONENT_LABELS.get(component_id, f"Component {component_id}"),
            "drawable": drawable,
            "assetName": str(component.get("drawableName") or ""),
            "hash": str(mesh_hash),
            "textures": [],
            "textureAssets": {},
        })
        if texture not in row["textures"]:
            row["textures"].append(texture)
        row["textureAssets"][str(texture)] = str(mesh_hash)

    models: dict[str, dict[str, list]] = defaultdict(lambda: defaultdict(list))
    for (model, component_id, _), row in sorted(variants.items()):
        row["textures"].sort()
        models[model][str(component_id)].append(row)

    catalog = {
        "schema": "nx-illenium-browser-character-catalog-v1",
        "source": "runtime_characters.json + CodeWalker PedFile tables",
        "models": models,
    }
    target = assets / "character_component_catalog.json"
    target.write_text(json.dumps(catalog, indent=2), encoding="utf-8")
    print(f"Wrote {target} with {len(variants)} drawable variants from {len(unique)} unique profiles")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

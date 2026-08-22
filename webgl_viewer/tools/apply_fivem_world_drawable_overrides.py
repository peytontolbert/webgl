#!/usr/bin/env python3
"""Export loose FiveM YDR hash replacements into existing demo manifests."""

from __future__ import annotations

import argparse
import copy
import json
import logging
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from gta5_modules.dll_manager import DllManager
from gta5_modules.hash_utils import joaat
from import_fivem_mlo_demo import (
    MLO_WORLD_DRAWABLE_SUBMESH_EXCLUSIONS,
    _build_texture_banks,
    _export_archetype_drawable,
    _merge_texture_maps,
)


def _apply_submesh_exclusions(hash_id: str, entry: dict) -> int:
    exclusions = MLO_WORLD_DRAWABLE_SUBMESH_EXCLUSIONS.get(int(hash_id), {})
    removed = 0
    for lod_name, indexes in exclusions.items():
        lod = (entry.get("lods") or {}).get(str(lod_name).lower())
        if not lod:
            continue
        submeshes = list(lod.get("submeshes") or [])
        invalid = sorted(index for index in indexes if index < 0 or index >= len(submeshes))
        if invalid:
            raise RuntimeError(f"Invalid {hash_id} {lod_name} submesh exclusions: {invalid}")
        lod["submeshes"] = [part for index, part in enumerate(submeshes) if index not in indexes]
        removed += len(submeshes) - len(lod["submeshes"])
    return removed


def _texture_hash(path: object) -> str:
    match = re.search(r"(?:^|/)(\d+)(?:_|\.|$)", str(path or ""))
    return match.group(1) if match else ""


def _build_texture_aliases(source: dict, runtime: dict) -> dict[str, str]:
    aliases: dict[str, str] = {}
    for hash_id, source_entry in (source.get("meshes") or {}).items():
        runtime_entry = (runtime.get("meshes") or {}).get(hash_id) or {}
        for lod_key, source_lod in (source_entry.get("lods") or {}).items():
            runtime_lod = (runtime_entry.get("lods") or {}).get(lod_key) or {}
            for source_part, runtime_part in zip(source_lod.get("submeshes") or [], runtime_lod.get("submeshes") or []):
                source_material = source_part.get("material") or {}
                runtime_material = runtime_part.get("material") or {}
                for key in ("diffuse", "normal", "spec", "detail", "emissive", "tintPalette"):
                    source_hash = _texture_hash(source_material.get(key))
                    runtime_path = runtime_material.get(key)
                    if source_hash and runtime_path:
                        aliases[source_hash] = str(runtime_path)
                source_params = (source_material.get("shaderParams") or {}).get("texturesByHash") or {}
                runtime_params = (runtime_material.get("shaderParams") or {}).get("texturesByHash") or {}
                for parameter_hash, source_path in source_params.items():
                    source_hash = _texture_hash(source_path)
                    runtime_path = runtime_params.get(parameter_hash)
                    if source_hash and runtime_path:
                        aliases[source_hash] = str(runtime_path)
    return aliases


def _apply_texture_aliases(entry: dict, aliases: dict[str, str]) -> tuple[int, set[str]]:
    resolved = 0
    missing: set[str] = set()
    for lod in (entry.get("lods") or {}).values():
        for part in lod.get("submeshes") or []:
            material = part.get("material") or {}
            textures = (material.get("shaderParams") or {}).get("texturesByHash") or {}
            for parameter_hash, source_path in list(textures.items()):
                if not str(source_path).startswith("models_textures/"):
                    continue
                source_hash = _texture_hash(source_path)
                replacement = aliases.get(source_hash)
                if replacement:
                    textures[parameter_hash] = replacement
                    resolved += 1
                elif source_hash:
                    missing.add(source_hash)
            material.setdefault("diffuse", textures.get("4059966321"))
            material.setdefault("normal", textures.get("1186448975"))
            material.setdefault("spec", textures.get("1619499462"))
            material.setdefault("tintPalette", textures.get("4131954791"))
            for key in ("diffuse", "normal", "spec", "tintPalette"):
                if material.get(key) is None:
                    material.pop(key, None)
    return resolved, missing


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-path", required=True)
    parser.add_argument("--resource-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, action="append", required=True)
    parser.add_argument("--drawable", action="append", required=True, help="Loose YDR stem to export; repeat as needed.")
    parser.add_argument("--assets-dir", type=Path, default=root / "assets")
    parser.add_argument("--texture-source-manifest", type=Path, default=root / "assets/demo/spawn_district_models.json")
    parser.add_argument("--texture-runtime-manifest", type=Path, default=root / "assets/demo/spawn_district_models_quantized_v3.json")
    args = parser.parse_args()

    resource_dir = args.resource_dir.resolve()
    assets_dir = args.assets_dir.resolve()
    logging.disable(logging.CRITICAL)
    dll = DllManager(str(Path(args.game_path).resolve()))
    if not getattr(dll, "initialized", False):
        raise SystemExit("CodeWalker initialization failed")

    texture_source = json.loads(args.texture_source_manifest.read_text(encoding="utf-8"))
    texture_runtime = json.loads(args.texture_runtime_manifest.read_text(encoding="utf-8"))
    texture_aliases = _build_texture_aliases(texture_source, texture_runtime)
    _, fallback_textures, _ = _build_texture_banks(dll, resource_dir, assets_dir)
    exported: dict[str, dict] = {}
    inherited_texture_count = 0
    excluded_submesh_count = 0
    unresolved_texture_hashes: set[str] = set()
    for name in dict.fromkeys(str(value).strip().lower() for value in args.drawable):
        path = next((item for item in resource_dir.rglob("*.ydr") if item.stem.lower() == name), None)
        if path is None:
            raise FileNotFoundError(f"Loose drawable not found: {name}.ydr")
        hash_id = str(int(joaat(name, lower=True)) & 0xFFFFFFFF)
        entry = _export_archetype_drawable(
            dll, path, int(hash_id), _merge_texture_maps(fallback_textures), assets_dir,
        )
        if entry is None:
            raise RuntimeError(f"Drawable has no usable mesh: {path}")
        resolved, missing = _apply_texture_aliases(entry, texture_aliases)
        excluded_submesh_count += _apply_submesh_exclusions(hash_id, entry)
        inherited_texture_count += resolved
        unresolved_texture_hashes.update(missing)
        exported[hash_id] = entry

    if unresolved_texture_hashes:
        raise RuntimeError(f"Unresolved inherited GTA texture hashes: {sorted(unresolved_texture_hashes, key=int)}")

    for manifest_path in (path.resolve() for path in args.manifest):
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        updated = copy.deepcopy(payload)
        updated.setdefault("meshes", {}).update(copy.deepcopy(exported))
        updated.setdefault("mloImport", {})["worldDrawableOverrides"] = sorted(exported, key=int)
        manifest_path.write_text(json.dumps(updated, separators=(",", ":")), encoding="utf-8")
        print(
            f"Updated {manifest_path} with {len(exported)} world drawable overrides, "
            f"{inherited_texture_count} inherited texture bindings, and "
            f"{excluded_submesh_count} excluded takeover submeshes"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

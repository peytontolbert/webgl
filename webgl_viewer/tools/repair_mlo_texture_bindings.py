#!/usr/bin/env python3
"""Repair unresolved FiveM MLO material bindings from local YTD/YDR sources."""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from pathlib import Path
from typing import Any, Iterable

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from gta5_modules.dll_manager import DllManager
from import_fivem_mlo_demo import _build_texture_banks
from export_drawables_for_chunk import _decode_texture_object_to_img_rgba, _shader_param_iter


MODEL_TEXTURE_RE = re.compile(r"^models_textures/(\d+)(?:_[^/]+)?\.(?:png|dds|jpg|jpeg|webp)$", re.IGNORECASE)


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _iter_materials(manifest: dict[str, Any]) -> Iterable[dict[str, Any]]:
    for entry in (manifest.get("meshes") or {}).values():
        if not isinstance(entry, dict):
            continue
        material = entry.get("material")
        if isinstance(material, dict):
            yield material
        for lod in (entry.get("lods") or {}).values():
            if not isinstance(lod, dict):
                continue
            for submesh in (lod.get("submeshes") or []):
                material = submesh.get("material") if isinstance(submesh, dict) else None
                if isinstance(material, dict):
                    yield material


def _texture_hash(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    match = MODEL_TEXTURE_RE.match(value.strip().replace("\\", "/"))
    return str(int(match.group(1))) if match else None


def _wanted_hashes(report: Any) -> set[str]:
    rows = report if isinstance(report, list) else report.get("textures") if isinstance(report, dict) else []
    out: set[str] = set()
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        h = _texture_hash(row.get("requestedRel"))
        if h:
            out.add(h)
    return out


def _texture_paths(fallback: dict[str, tuple[Any, Any, str]]) -> dict[str, str]:
    out: dict[str, str] = {}
    for name, value in fallback.items():
        if not isinstance(value, tuple) or len(value) < 3:
            continue
        path = str(value[2] or "").strip().replace("\\", "/")
        match = re.search(r"/(\d+)\.png$", path, re.IGNORECASE)
        if match:
            out[str(int(match.group(1)))] = path
    return out


def _u32(value: object) -> int:
    try:
        return int(value) & 0xFFFFFFFF
    except (TypeError, ValueError):
        return 0


def _embedded_ydr_texture_paths(
    dll: DllManager,
    ydr_dir: Path | None,
    assets_dir: Path,
    wanted: set[str],
) -> tuple[dict[str, str], int, int]:
    """Recover the texture payloads embedded in loose FiveM YDR shaders.

    FiveM MLO drawables often carry their source texture bytes directly in the
    shader parameter rather than in an accompanying YTD.  The original export
    preserved the NameHash as a numeric ``models_textures`` path, which left
    the browser with no file to fetch.  Retain that one-to-one hash relation
    while putting the recovered browser image under the MLO asset namespace.
    """
    if ydr_dir is None or not ydr_dir.is_dir():
        return {}, 0, 0

    result: dict[str, str] = {}
    decoded = 0
    files = sorted(path for path in ydr_dir.rglob("*.ydr") if path.is_file())
    for ydr_path in files:
        try:
            ydr = dll.YdrFile()
            ydr.Load(ydr_path.read_bytes())
            drawable = getattr(ydr, "Drawable", None)
            shader_group = getattr(drawable, "ShaderGroup", None)
            shaders = list(getattr(getattr(shader_group, "Shaders", None), "data_items", None) or [])
        except Exception as error:
            print(f"[warn] Could not load {ydr_path.name}: {error}", file=sys.stderr)
            continue

        relative_dir = f"mlo_textures/embedded_recovered/{ydr_path.stem.lower()}"
        output_dir = assets_dir / relative_dir
        for shader in shaders:
            for _parameter_hash, parameter in _shader_param_iter(shader) or []:
                try:
                    if int(getattr(parameter, "DataType", 255)) != 0:
                        continue
                    texture = getattr(parameter, "Data", None)
                    texture_hash = str(_u32(getattr(texture, "NameHash", 0)))
                except Exception:
                    continue
                if texture_hash not in wanted or texture_hash in result:
                    continue
                image, _fmt = _decode_texture_object_to_img_rgba(dll, texture)
                if image is None:
                    continue
                output_dir.mkdir(parents=True, exist_ok=True)
                target = output_dir / f"{texture_hash}.png"
                Image.fromarray(image, mode="RGBA").save(target)
                result[texture_hash] = f"{relative_dir}/{texture_hash}.png"
                decoded += 1
    return result, decoded, len(files)


def _codewalker_checker_path(assets_dir: Path) -> str:
    """Persist CodeWalker's explicit missing-texture diagnostic as a real asset.

    ``givemechecker`` is not a lookupable GTA texture.  It is the exporter
    marker used when an authored shader has no backing image, so retaining a
    checker is more accurate than incorrectly borrowing a nearby diffuse map.
    """
    relative = "mlo_textures/codewalker_givemechecker.png"
    target = assets_dir / relative
    if not target.exists():
        image = Image.new("RGBA", (64, 64), (24, 24, 24, 255))
        pixels = image.load()
        for y in range(64):
            for x in range(64):
                if ((x // 16) + (y // 16)) % 2:
                    pixels[x, y] = (224, 0, 224, 255)
        image.save(target)
    return relative


def _replace_value(value: object, wanted: set[str], paths: dict[str, str]) -> tuple[object, bool]:
    h = _texture_hash(value)
    if not h or h not in wanted:
        return value, False
    replacement = paths.get(h)
    return (replacement, True) if replacement else (value, False)


def _remaining_wanted_hashes(manifest: dict[str, Any], wanted: set[str]) -> set[str]:
    """Return only unresolved references that still exist after repair."""
    remaining: set[str] = set()
    for material in _iter_materials(manifest):
        for value in material.values():
            texture_hash = _texture_hash(value)
            if texture_hash in wanted:
                remaining.add(texture_hash)
        textures = (material.get("shaderParams") or {}).get("texturesByHash")
        if not isinstance(textures, dict):
            continue
        for value in textures.values():
            texture_hash = _texture_hash(value)
            if texture_hash in wanted:
                remaining.add(texture_hash)
            if isinstance(value, str) and value.strip().lower() == "givemechecker" and "1551155749" in wanted:
                remaining.add("1551155749")
    return remaining


def _repair_manifest(manifest: dict[str, Any], wanted: set[str], paths: dict[str, str]) -> tuple[int, set[str]]:
    repaired = 0
    for material in _iter_materials(manifest):
        for key, value in list(material.items()):
            replacement, changed = _replace_value(value, wanted, paths)
            if changed:
                material[key] = replacement
                repaired += 1
        textures = (material.get("shaderParams") or {}).get("texturesByHash")
        if not isinstance(textures, dict):
            continue
        for key, value in list(textures.items()):
            replacement, changed = _replace_value(value, wanted, paths)
            if changed:
                textures[key] = replacement
                repaired += 1
                continue
            # CodeWalker exposes its synthetic checker by name inside shader
            # metadata, while the selected material field stores the numeric
            # hash. Keep both representations on the same local asset.
            if isinstance(value, str) and value.strip().lower() == "givemechecker":
                checker = paths.get("1551155749")
                if checker:
                    textures[key] = checker
                    repaired += 1
        for field, param_hash in (("diffuse", "4059966321"), ("normal", "1186448975"), ("spec", "1619499462")):
            current = material.get(field)
            if _texture_hash(current) in wanted:
                replacement = textures.get(param_hash)
                if isinstance(replacement, str) and replacement.startswith("mlo_textures/"):
                    material[field] = replacement
                    repaired += 1
    return repaired, _remaining_wanted_hashes(manifest, wanted)


def _all_unresolved_texture_hashes(manifest: dict[str, Any]) -> set[str]:
    unresolved: set[str] = set()
    for material in _iter_materials(manifest):
        for value in material.values():
            texture_hash = _texture_hash(value)
            if texture_hash:
                unresolved.add(texture_hash)
        textures = (material.get("shaderParams") or {}).get("texturesByHash")
        if isinstance(textures, dict):
            for value in textures.values():
                texture_hash = _texture_hash(value)
                if texture_hash:
                    unresolved.add(texture_hash)
    return unresolved


def _update_texture_compression_metadata(manifest: dict[str, Any], focused_unresolved: set[str]) -> bool:
    """Keep global and focused unresolved counts separate and accurate."""
    summary = manifest.get("textureCompression")
    if not isinstance(summary, dict):
        return False
    previous = int(summary.get("unresolvedReferences") or 0)
    current = len(_all_unresolved_texture_hashes(manifest))
    previous_focused = summary.get("focusedUnresolvedReferences")
    summary["unresolvedReferences"] = current
    summary["focusedUnresolvedReferences"] = len(focused_unresolved)
    return previous != current or previous_focused != len(focused_unresolved)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-path", type=Path, required=True)
    parser.add_argument("--ytd-dir", type=Path, required=True)
    parser.add_argument("--ydr-dir", type=Path)
    parser.add_argument("--assets-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--missing-report", type=Path, required=True)
    args = parser.parse_args()

    ytd_dir = args.ytd_dir.resolve()
    assets_dir = args.assets_dir.resolve()
    manifest_path = args.manifest.resolve()
    wanted = _wanted_hashes(_load_json(args.missing_report.resolve()))
    if not wanted:
        raise SystemExit("Missing report contains no models_textures references")
    if not ytd_dir.is_dir():
        raise SystemExit(f"YTD directory not found: {ytd_dir}")

    # CodeWalker logs every scanned archive at INFO. The repair's structured
    # result is the useful output, so keep the archive inventory quiet.
    logging.getLogger().setLevel(logging.WARNING)
    dll = DllManager(str(args.game_path.resolve()))
    if not getattr(dll, "initialized", False):
        raise SystemExit("CodeWalker initialization failed")
    _by_dictionary, fallback, decoded_count = _build_texture_banks(dll, ytd_dir, assets_dir)
    paths = _texture_paths(fallback)
    embedded_paths, embedded_decoded, ydr_count = _embedded_ydr_texture_paths(
        dll,
        args.ydr_dir.resolve() if args.ydr_dir else None,
        assets_dir,
        wanted,
    )
    # A drawable-local payload is the source selected by the corresponding
    # MLO, so prefer it over a same-named texture from an unrelated YTD.
    paths.update(embedded_paths)
    if "1551155749" in wanted:
        paths["1551155749"] = _codewalker_checker_path(assets_dir)
    manifest = _load_json(manifest_path)
    repaired, unresolved = _repair_manifest(manifest, wanted, paths)
    metadata_changed = _update_texture_compression_metadata(manifest, unresolved)
    if repaired or metadata_changed:
        manifest_path.write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")

    print(json.dumps({
        "manifest": str(manifest_path),
        "wantedHashes": len(wanted),
        "decodedTextures": decoded_count,
        "ydrFiles": ydr_count,
        "embeddedTextures": embedded_decoded,
        "embeddedBindings": len(embedded_paths),
        "availableBindings": len(paths),
        "repairedBindings": repaired,
        "unresolvedHashes": sorted(unresolved, key=int),
        "textureCompressionMetadataUpdated": metadata_changed,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

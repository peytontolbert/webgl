#!/usr/bin/env python3
"""Attach original KN5 material channels to an already-compiled TNM scene.

This deliberately does not re-walk or re-encode the millions of mesh vertices.
The TNM source has already preserved UVs and normals; this low-memory pass reads
the KN5 material tables, converts their embedded maps to WebP, and updates the
matching manifest groups.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

from assetto_nurburgring_scene_compiler import NON_VISUAL_MATERIALS, TexturePack, load_parser, read_kn5_textured


SAMPLE_CHANNELS = {
    "diffuse": "txDiffuse",
    "normal": "txNormal",
    "maps": "txMaps",
    "detail": "txDetail",
    "mask": "txMask",
    "detailNormal": "txDetailNM",
    "normalDetail": "txNormalDetail",
    "variation": "txVariation",
    "detailR": "txDetailR",
    "detailG": "txDetailG",
    "detailB": "txDetailB",
    "detailA": "txDetailA",
}


def material_groups(reader: Any, source: Path, texture_pack: TexturePack) -> list[dict[str, Any]]:
    materials, nodes, embedded_textures = read_kn5_textured(reader, source)
    used_material_ids = {
        int(getattr(node, "material_id", -1))
        for node in nodes
        if getattr(node, "type", None) in (2, 3)
        and getattr(node, "indices", None)
        # Match the scene compiler: AC_ is not a blanket non-visual prefix
        # in Kunos tracks (start structures, crews and flags are visible).
        # Only the audio helper planes are deliberately absent from the
        # browser scene, so the material and geometry group order must use
        # that exact same filter.
        and not str(getattr(node, "name", "")).startswith("AC_AUDIO")
        and 0 <= int(getattr(node, "material_id", -1)) < len(materials)
    }
    rows: list[dict[str, Any]] = []
    for material_id in sorted(used_material_ids, key=lambda value: f"{value}:{materials[value].get('name', '')}".lower()):
        material = materials[material_id]
        # Geometry export omits the KN5 internal physics/debug material; omit
        # it here as well so group offsets still pair with the TNM payload.
        if str(material.get("name") or "").strip().lower() in NON_VISUAL_MATERIALS:
            continue
        samples = material.get("samples", {})
        textures: dict[str, str] = {}
        for channel, sample_name in SAMPLE_CHANNELS.items():
            source_name = str(samples.get(sample_name, "")).replace("\\", "/")
            texture = texture_pack.add(source_name, embedded_textures.get(source_name.lower(), b"")) if source_name else None
            if texture:
                textures[channel] = texture
        shader = str(material.get("shader", ""))
        shader_key = shader.lower()
        alpha_mode = "cutout" if any(token in shader_key for token in ("at", "tree", "grass", "flags")) else ("blend" if "alpha" in shader_key else "opaque")
        properties = {
            str(key).lower(): float(value)
            for key, value in dict(material.get("props", {})).items()
            if isinstance(value, (int, float)) and math.isfinite(float(value))
        }
        property_vectors = {
            str(key).lower(): [float(component) for component in value]
            for key, value in dict(material.get("propertyVectors", {})).items()
            if isinstance(value, (list, tuple)) and len(value) == 10
            and all(isinstance(component, (int, float)) and math.isfinite(float(component)) for component in value)
        }
        rows.append({
            "material": str(material.get("name") or "track"),
            "shader": shader,
            "textures": textures,
            "alphaMode": alpha_mode,
            "properties": properties,
            "propertyVectors": property_vectors,
        })
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--track-root", required=True, type=Path)
    parser.add_argument("--scene-dir", required=True, type=Path)
    parser.add_argument("--kn5-parser", type=Path, default=Path(r"K:\WebGL_Tools\tools\assetto_corsa_kn5_to_obj.py"))
    parser.add_argument("--texture-quality", type=int, default=82)
    parser.add_argument("--texture-max-size", type=int, default=2048)
    parser.add_argument("--model", action="append", default=[], help="Pack only this KN5 source name; repeatable")
    parser.add_argument("--strip-non-visual-materials", action="store_true", help="Remove known Assetto physics/debug groups from the rendered manifest")
    args = parser.parse_args()

    manifest_path = args.scene_dir / "scene.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest.get("models"), list):
        raise RuntimeError("scene manifest has no model list")
    reader = load_parser(args.kn5_parser.resolve())
    texture_pack = TexturePack(args.scene_dir, quality=args.texture_quality, max_size=args.texture_max_size)
    requested = {str(name).lower() for name in args.model}
    packed = 0
    for model in manifest["models"]:
        source_name = str(model.get("source", ""))
        if requested and source_name.lower() not in requested:
            continue
        source = args.track_root / source_name
        groups = model.get("groups")
        if not source.is_file() or not isinstance(groups, list):
            raise RuntimeError(f"scene model is invalid: {source_name}")
        print(f"Packing materials {source_name}", flush=True)
        source_groups = material_groups(reader, source, texture_pack)
        if len(groups) != len(source_groups):
            raise RuntimeError(f"material group count differs for {source_name}: scene={len(groups)} kn5={len(source_groups)}")
        for group, source_group in zip(groups, source_groups):
            if str(group.get("material", "")) != source_group["material"]:
                raise RuntimeError(f"material group order differs for {source_name}: {group.get('material')} != {source_group['material']}")
            group.update({key: value for key, value in source_group.items() if key != "material"})
            if source_group["textures"].get("diffuse"):
                group["texture"] = source_group["textures"]["diffuse"]
        # Persist every completed sector. A main Nordschleife source can take
        # longer than a normal interactive command window permits, and a
        # completed material table must never be lost with a later sector.
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        packed += 1
    if args.strip_non_visual_materials:
        stripped = 0
        for model in manifest["models"]:
            groups = model.get("groups")
            if not isinstance(groups, list):
                continue
            retained = [group for group in groups if str(group.get("material", "")).strip().lower() not in NON_VISUAL_MATERIALS]
            stripped += len(groups) - len(retained)
            model["groups"] = retained
        print(f"Stripped {stripped} non-visual material groups", flush=True)
    manifest.setdefault("source", {})["materialChannels"] = list(SAMPLE_CHANNELS)
    manifest.setdefault("source", {})["materialPass"] = "KN5 embedded maps"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"manifest": str(manifest_path), "models": packed, "webpTextures": len(list((args.scene_dir / "textures").glob("*.webp")))}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

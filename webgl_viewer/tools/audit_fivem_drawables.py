#!/usr/bin/env python3
"""Report geometry, material, and embedded-texture coverage for loose FiveM YDRs."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any

import numpy as np


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from export_drawables_for_chunk import _extract_drawable_lod_submeshes, _shader_param_iter
from gta5_modules.dll_manager import DllManager
from gta5_modules.hash_utils import joaat
from webgl_viewer.tools.import_fivem_mlo_demo import _texture_items


def _texture_name(texture: Any) -> str:
    return str(getattr(texture, "Name", "") or "").strip()


def _shader_textures(shader: Any) -> set[str]:
    names: set[str] = set()
    for _parameter_hash, parameter in _shader_param_iter(shader) or []:
        texture = getattr(parameter, "Data", None)
        name = _texture_name(texture)
        if name:
            names.add(name)
    return names


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-path", type=Path, required=True)
    parser.add_argument("--resource-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    logging.disable(logging.CRITICAL)
    dll = DllManager(str(args.game_path.resolve()))
    if not getattr(dll, "initialized", False):
        raise RuntimeError("CodeWalker initialization failed")

    reports: list[dict[str, Any]] = []
    for path in sorted(args.resource_dir.resolve().rglob("*.ydr")):
        ydr = dll.YdrFile()
        ydr.Load(path.read_bytes())
        drawable = getattr(ydr, "Drawable", None)
        embedded = sorted({_texture_name(item) for item in _texture_items(drawable) if _texture_name(item)})
        lods: dict[str, Any] = {}
        referenced: set[str] = set()
        for lod in ("High", "Med", "Low", "Vlow"):
            submeshes = _extract_drawable_lod_submeshes(drawable, lod)
            if not submeshes:
                continue
            for submesh in submeshes:
                referenced.update(_shader_textures(submesh.get("shader")))
            positions = np.concatenate([item["positions"] for item in submeshes], axis=0)
            lods[lod.lower()] = {
                "submeshes": len(submeshes),
                "vertices": sum(len(item["positions"]) for item in submeshes),
                "triangles": sum(len(item["indices"]) // 3 for item in submeshes),
                "boundsMin": [round(float(value), 6) for value in positions.min(axis=0)],
                "boundsMax": [round(float(value), 6) for value in positions.max(axis=0)],
            }
        reports.append(
            {
                "file": path.relative_to(args.resource_dir.resolve()).as_posix(),
                "bytes": path.stat().st_size,
                "lods": lods,
                "embeddedTextures": embedded,
                "referencedTextures": sorted(referenced),
                "missingEmbeddedTextures": sorted(referenced.difference(embedded)),
            }
        )

    missing_names = sorted({name for item in reports for name in item["missingEmbeddedTextures"]})
    payload = {
        "schema": "webglgta-fivem-drawable-audit-v1",
        "resource": str(args.resource_dir.resolve()),
        "drawables": reports,
        "textures": [
            {
                "name": name,
                "hash": str(int(joaat(name, lower=True)) & 0xFFFFFFFF),
                "requestedRel": f"models_textures/{int(joaat(name, lower=True)) & 0xFFFFFFFF}_{name}.png",
                "reason": "missing_from_resource",
            }
            for name in missing_names
        ],
        "summary": {
            "drawableCount": len(reports),
            "drawableBytes": sum(item["bytes"] for item in reports),
            "highVertices": sum(item["lods"].get("high", {}).get("vertices", 0) for item in reports),
            "highTriangles": sum(item["lods"].get("high", {}).get("triangles", 0) for item in reports),
            "embeddedTextureCount": len({name for item in reports for name in item["embeddedTextures"]}),
            "missingEmbeddedTextureCount": len(missing_names),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload["summary"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

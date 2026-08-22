#!/usr/bin/env python3
from __future__ import annotations

import json
import logging
import os
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import numpy as np

from export_drawables_for_chunk import _extract_drawable_lod_submeshes
from export_runtime_ped_skinning import (
    _as_u32,
    _dict_get_drawable,
    _load_ydd,
    _load_ydd_from_entry,
    _load_yft_skeleton,
    _load_ytd_from_entry,
    _ped_component_ydd_entries,
    _ped_component_ytd_entries,
)
from gta5_modules.dll_manager import DllManager
from gta5_modules.hash_utils import joaat as _joaat
from gta5_modules.script_paths import auto_assets_dir


def _iter_dict_keys(d: Any) -> list[Any]:
    try:
        return list(getattr(d, "Keys", None) or [])
    except Exception:
        pass
    try:
        return list(d.keys())
    except Exception:
        return []


def _bone_names(skeleton: Any) -> list[str]:
    try:
        bones = list(getattr(getattr(skeleton, "Bones", None), "Items", []) or [])
    except Exception:
        return []
    return [str(getattr(b, "Name", "") or "") for b in bones]


def _component_entry_by_name(gfc: Any, ped_hash: int, name: str) -> tuple[int, Any]:
    entries = _ped_component_ydd_entries(gfc, ped_hash)
    h = int(_joaat(name, lower=True)) & 0xFFFFFFFF
    return h, entries.get(h)


def _manifest_submesh(assets_dir: Path, mesh_hash: int, file_name: str) -> dict[str, Any] | None:
    shard = (int(mesh_hash) & 0xFFFFFFFF) & 0xFF
    p = assets_dir / "models" / "manifest_shards" / f"{shard:02x}.json"
    if not p.exists():
        return None
    j = json.loads(p.read_text(encoding="utf-8"))
    mesh = (j.get("meshes") or {}).get(str(int(mesh_hash) & 0xFFFFFFFF))
    for lod in (mesh.get("lods") or {}).values():
        for sm in lod.get("submeshes") or []:
            if sm.get("file") == file_name:
                return sm
    return None


def main() -> None:
    logging.getLogger("gta5_modules.dll_manager").setLevel(logging.WARNING)
    assets_dir = auto_assets_dir("")
    runtime = json.loads((assets_dir / "runtime_character.json").read_text(encoding="utf-8"))
    model_name = str(runtime.get("modelName") or "mp_m_freemode_01")
    model_hash = int(runtime.get("modelHash") or _joaat(model_name, lower=True)) & 0xFFFFFFFF
    names = [str(c.get("drawableName") or c.get("assetName") or "") for c in runtime.get("components") or []]
    targets = [n for n in names if n in {"hand_000_u", "uppr_000_r", "lowr_000_r", "feet_000_u"}]

    game_path = (os.getenv("gta_location") or os.getenv("gta5_path") or "").strip('"').strip("'")
    if not game_path:
        raise SystemExit("Missing gta_location/gta5_path")
    dm = DllManager(game_path)
    if not dm.initialized:
        raise SystemExit("Failed to initialize DllManager")
    if not dm.init_game_file_cache(load_vehicles=False, load_peds=True, load_audio=False, selected_dlc="all"):
        raise SystemExit("Failed to init GameFileCache")
    gfc = dm.get_game_file_cache()

    ydd_cls = getattr(dm, "YddFile", None)
    ytd_cls = getattr(dm, "YtdFile", None)
    fallback_ydd = _load_ydd(gfc, model_hash, 1200)
    yft_skeleton = _load_yft_skeleton(gfc, model_hash, 1200)
    yft_names = _bone_names(yft_skeleton)
    texture_entries = _ped_component_ytd_entries(gfc, model_hash)

    for name in targets:
        h, entry = _component_entry_by_name(gfc, model_hash, name)
        ydd = _load_ydd_from_entry(gfc, ydd_cls, entry, h, 1200)
        if ydd is None:
            ydd = fallback_ydd
        drawable = _dict_get_drawable(ydd, h) if ydd is not None else None
        if drawable is None:
            print(f"\n{name} {h}: missing drawable")
            continue

        dskel = getattr(drawable, "Skeleton", None)
        dnames = _bone_names(dskel)
        print(f"\n{name} {h}")
        print(" drawableSkeletonBones:", len(dnames), "yftSkeletonBones:", len(yft_names))
        if dnames:
            print(" drawableSkeletonFirst:", dnames[:12])
        try:
            component = next(
                (
                    c for c in (runtime.get("components") or [])
                    if str(c.get("drawableName") or c.get("assetName") or "") == name
                ),
                {},
            )
            texture_name = str((component or {}).get("textureName") or "").strip()
            texture_hash = int(_joaat(texture_name, lower=True)) & 0xFFFFFFFF if texture_name else 0
            ytd = _load_ytd_from_entry(gfc, ytd_cls, texture_entries.get(texture_hash), 1200)
            textures = list(getattr(getattr(ytd, "TextureDict", None), "Textures", None).data_items or []) if ytd is not None else []
            print(
                " componentYtdTextures:",
                {"selected": texture_name, "selectedHash": texture_hash, "hasEntry": texture_hash in texture_entries},
                [
                    {
                        "name": str(getattr(t, "Name", "") or ""),
                        "hash": int(_joaat(str(getattr(t, "Name", "") or ""), lower=True)) & 0xFFFFFFFF,
                        "width": int(getattr(t, "Width", 0) or 0),
                        "height": int(getattr(t, "Height", 0) or 0),
                        "format": str(getattr(t, "Format", "") or ""),
                    }
                    for t in textures[:12]
                ],
            )
        except Exception as e:
            print(" componentYtdTextures: unavailable", e)

        subs = _extract_drawable_lod_submeshes(drawable, "High")
        for si, sub in enumerate(subs):
            bone_ids = list(sub.get("boneIds") or [])
            bw = sub.get("blendWeights")
            bi = sub.get("blendIndices")
            pos = sub.get("positions")
            vcount = int(getattr(pos, "shape", [0])[0] or 0)
            try:
                models = getattr(getattr(drawable, "DrawableModels", None), "High", None) or []
                geom = getattr(models[si], "Geometries", [None])[0] if si < len(models) else None
                vdata = getattr(geom, "VertexData", None)
                vdecl = getattr(vdata, "Info", None)
                flags = int(getattr(vdecl, "Flags", 0) or 0)
                decl = []
                for sem in (0, 1, 2, 4, 5, 6, 7, 8, 14):
                    if ((flags >> sem) & 1) == 0:
                        continue
                    decl.append(f"{sem}@{vdecl.GetComponentOffset(sem)}:{vdecl.GetComponentType(sem)}")
                print("  decl:", " ".join(decl), "stride=", getattr(vdata, "VertexStride", None))
            except Exception as e:
                print("  decl: unavailable", e)
            if isinstance(pos, np.ndarray) and pos.size:
                mn = np.min(pos, axis=0)
                mx = np.max(pos, axis=0)
                print("  posMinMax:", [round(float(x), 4) for x in mn], [round(float(x), 4) for x in mx])
            print(f" submesh {si}: verts={vcount} boneIdsLen={len(bone_ids)} first35={bone_ids[:35]}")
            if not isinstance(bw, np.ndarray) or not isinstance(bi, np.ndarray):
                continue
            nonzero_indices = bi[bw > 0]
            all_indices = bi.reshape(-1)
            if nonzero_indices.size:
                print(
                    "  blendIndexRangeWeighted:",
                    int(np.min(nonzero_indices)),
                    int(np.max(nonzero_indices)),
                    "allMax:",
                    int(np.max(all_indices)) if all_indices.size else 0,
                    "weighted255:",
                    int(np.count_nonzero(nonzero_indices == 255)),
                )
            weighted = Counter()
            verts = defaultdict(int)
            for weights, indices in zip(bw, bi):
                for w, slot in zip(weights, indices):
                    if int(w) <= 0:
                        continue
                    slot_i = int(slot)
                    weighted[slot_i] += int(w)
                    verts[slot_i] += 1
            print("  topSlots:")
            for slot, total in weighted.most_common(16):
                global_id = bone_ids[slot] if 0 <= slot < len(bone_ids) else None
                yft_name = yft_names[global_id] if global_id is not None and global_id < len(yft_names) else None
                d_name = dnames[global_id] if global_id is not None and global_id < len(dnames) else None
                print(f"   slot={slot:3d} weight={total:6d} verts={verts[slot]:4d} global={global_id!s:>3} yft={yft_name} drawable={d_name}")
            sm = _manifest_submesh(assets_dir, h, f"{h}_high_{si}.bin")
            if sm:
                print("  manifestBoneIdsMatch:", list(sm.get("boneIds") or []) == bone_ids)


if __name__ == "__main__":
    main()

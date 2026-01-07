"""
Extract missing model textures by decoding shader texture objects from Drawables, without requiring YTD lookup.

This is designed to fix the class of missing textures where:
- a material references a texture name (hash present in manifest/dump),
- but CodeWalker can't locate a containing YTD (TryGetTextureDictForTexture fails),
- and global YTD scan can't find it either.

In those cases, the texture may still be reachable via shader texture objects on the drawable itself.

Input:
- `tools/out/missing_textures_remaining.json` (or any same-format file):
  [
    { "requestedRel": "models_textures/<hash>_<slug>.png", "useCount": <int>, "refs": [{ "archetype_hash": "<u32>", ...}, ...] },
    ...
  ]

Output:
- Writes extracted PNGs into:
  - assets/models_textures/ (default), OR
  - assets/packs/<dlcname>/models_textures/ when --split-by-dlc and the archetype's YTYP path indicates a dlcpack
  - assets/packs/<force-pack>/models_textures/ when --force-pack is set.

Usage:
  python3 webgl-gta/webgl_viewer/tools/extract_missing_textures_from_drawables.py \
    --gta-path /data/webglgta/gta5 \
    --assets-dir webgl-gta/webgl_viewer/assets \
    --selected-dlc all \
    --also-scan-dlc patchday27ng \
    --missing webgl-gta/webgl_viewer/tools/out/missing_textures_remaining.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, Optional, Set, Tuple


_MODEL_TEX_RE = re.compile(r"^models_textures/(?P<hash>\d+)(?:_(?P<slug>[^/]+))?\.png$", re.IGNORECASE)


def _infer_dlc_from_entry_path(p: str) -> str:
    # Wrapper preserved for backwards-compat within this script.
    from gta5_modules.dlc_paths import infer_dlc_pack_from_entry_path as _infer_dlc_pack_from_entry_path
    return _infer_dlc_pack_from_entry_path(p)


def _safe_u32(x: Any) -> Optional[int]:
    try:
        if x is None:
            return None
        if isinstance(x, int):
            return int(x) & 0xFFFFFFFF
        s = str(x).strip()
        if not s:
            return None
        return int(s, 10) & 0xFFFFFFFF
    except Exception:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gta-path", required=True)
    ap.add_argument("--assets-dir", required=True)
    ap.add_argument("--missing", required=True)
    ap.add_argument("--selected-dlc", default="all")
    ap.add_argument(
        "--also-scan-dlc",
        action="append",
        default=["patchday27ng"],
        help="Additional DLC levels to scan when an archetype can't be resolved (default: patchday27ng). Can be provided multiple times.",
    )
    ap.add_argument("--split-by-dlc", action="store_true")
    ap.add_argument("--pack-root-prefix", default="packs")
    ap.add_argument("--force-pack", default="")
    ap.add_argument("--max-archetypes", type=int, default=0, help="Limit archetypes processed (0 = all)")
    ap.add_argument("--drawable-spins", type=int, default=600, help="Max ContentThreadProc spins while waiting for a drawable to load")
    args = ap.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

    from gta5_modules.dll_manager import DllManager  # noqa
    from gta5_modules.codewalker_archetypes import get_archetype_best_effort  # noqa
    from gta5_modules.cw_loaders import try_get_drawable as _try_get_drawable  # noqa

    # Reuse the robust texture decode/export helper from the main exporter.
    from export_drawables_for_chunk import _export_texture_png  # type: ignore

    missing_rows = json.loads(Path(args.missing).read_text(encoding="utf-8", errors="ignore"))
    if not isinstance(missing_rows, list):
        raise SystemExit("--missing must be a JSON array")

    # Build desired texture hash set + slug map.
    need: Set[int] = set()
    slug_by_hash: Dict[int, str] = {}
    arch_hashes: Set[int] = set()
    for r in missing_rows:
        if not isinstance(r, dict):
            continue
        rel = str(r.get("requestedRel") or "").strip()
        m = _MODEL_TEX_RE.match(rel)
        if not m:
            continue
        h = int(m.group("hash")) & 0xFFFFFFFF
        need.add(h)
        slug_by_hash[h] = str(m.group("slug") or "")
        refs = r.get("refs") if isinstance(r.get("refs"), list) else []
        for ref in refs:
            if not isinstance(ref, dict):
                continue
            ah = _safe_u32(ref.get("archetype_hash"))
            if ah is not None:
                arch_hashes.add(int(ah))

    assets_dir = Path(args.assets_dir)
    base_tex_dir = assets_dir / "models_textures"
    packs_root = assets_dir / str(args.pack_root_prefix or "packs").strip().strip("/").strip("\\")
    force_pack = str(args.force_pack or "").strip().lower()
    split_by_dlc = bool(args.split_by_dlc)
    extra_levels = [str(x or "").strip() for x in (args.also_scan_dlc or []) if str(x or "").strip()]

    dm = DllManager(str(args.gta_path))
    if not getattr(dm, "initialized", False):
        raise SystemExit("DllManager failed to init")
    dm.init_game_file_cache(selected_dlc=str(args.selected_dlc), load_vehicles=False, load_peds=False, load_audio=False)
    gfc = dm.get_game_file_cache()
    if gfc is None or not getattr(gfc, "IsInited", False):
        raise SystemExit("GameFileCache not inited")

    max_arch = int(args.max_archetypes or 0)
    spins_max = int(args.drawable_spins or 600)

    processed = 0
    extracted = 0

    def _pick_out_dir_for_arch(arch) -> Path:
        if force_pack:
            return packs_root / force_pack / "models_textures"
        if not split_by_dlc:
            return base_tex_dir
        try:
            ytyp = getattr(arch, "Ytyp", None)
            ent = getattr(ytyp, "RpfFileEntry", None) if ytyp is not None else None
            p = str(getattr(ent, "Path", "") or "") if ent is not None else ""
        except Exception:
            p = ""
        dlc = _infer_dlc_from_entry_path(p)
        if dlc:
            return packs_root / dlc / "models_textures"
        return base_tex_dir

    # Iterate archetypes; for each, load drawable and export any shader textures that match the need-set.
    for ah in sorted(list(arch_hashes)):
        if max_arch and processed >= max_arch:
            break
        if not need:
            break
        processed += 1

        arch = get_archetype_best_effort(
            gfc,
            int(ah) & 0xFFFFFFFF,
            dll_manager=dm,
            also_scan_dlc_levels=extra_levels,
        )
        if arch is None:
            continue

        drawable = _try_get_drawable(gfc, arch, spins=int(spins_max or 0))
        if drawable is None:
            continue

        out_dir = _pick_out_dir_for_arch(arch)
        out_dir.mkdir(parents=True, exist_ok=True)

        # Traverse LOD submeshes via existing helper for correctness.
        try:
            from export_drawables_for_chunk import _extract_drawable_lod_submeshes  # type: ignore
        except Exception:
            _extract_drawable_lod_submeshes = None

        lods = ("High", "Med", "Low", "VLow")
        for lod in lods:
            if not need:
                break
            subs = []
            try:
                if _extract_drawable_lod_submeshes is not None:
                    subs = _extract_drawable_lod_submeshes(drawable, lod) or []
            except Exception:
                subs = []
            if not subs:
                continue

            for sub in subs:
                if not need:
                    break
                shader = sub.get("shader") if isinstance(sub, dict) else None
                if shader is None:
                    continue

                # Iterate shader params, collect texture objects.
                try:
                    from export_drawables_for_chunk import _shader_param_iter  # type: ignore
                except Exception:
                    _shader_param_iter = None
                if _shader_param_iter is None:
                    continue

                for _hv, p in _shader_param_iter(shader) or []:
                    try:
                        if int(getattr(p, "DataType", 255)) != 0:
                            continue
                        tex_obj = getattr(p, "Data", None)
                        nm = str(getattr(tex_obj, "Name", "")).strip() if tex_obj is not None else ""
                        if not nm:
                            continue
                        # Hash is derived from name; if it matches the missing set, export.
                        try:
                            from export_drawables_for_chunk import joaat  # type: ignore
                        except Exception:
                            joaat = None
                        if joaat is None:
                            continue
                        h = int(joaat(nm)) & 0xFFFFFFFF
                        if h not in need:
                            continue

                        # Export using shader texture object fallback; textures dict can be empty.
                        rel, wrote = _export_texture_png(
                            {},
                            nm,
                            out_dir,
                            td_hash=None,
                            shader_tex_obj=tex_obj,
                            dll_manager=dm,
                        )
                        if rel:
                            need.discard(h)
                            extracted += 1 if wrote else 0
                    except Exception:
                        continue

    print(f"done: processed_archetypes={processed} extracted_new={extracted} remaining={len(need)}")
    if need:
        print("remaining hashes (first 30):", sorted(list(need))[:30])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



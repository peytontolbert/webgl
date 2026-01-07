#!/usr/bin/env python3
"""
Export diffuse textures for meshes already present in assets/models/manifest.json.

This is the fastest way to make textures show up without re-exporting geometry.

Usage:
  python webgl/export_textures_for_manifest.py --game-path "X:\\GTA5" --assets-dir webgl/webgl_viewer/assets --max 2000
"""

import argparse
import json
import os
import re
import traceback
from pathlib import Path
from typing import Optional

from gta5_modules.dll_manager import DllManager
from gta5_modules.rpf_reader import RpfReader
from gta5_modules.script_paths import auto_assets_dir
from gta5_modules.hash_utils import as_u32_int as _as_u32_int
from gta5_modules.codewalker_archetypes import get_archetype_best_effort
from gta5_modules.cw_loaders import try_get_drawable as _try_get_drawable


def _as_u32(s: str) -> Optional[int]:
    # Wrapper kept for backwards-compat within this script.
    return _as_u32_int(s)


def _ensure_entry_material(entry: dict) -> dict:
    if not isinstance(entry, dict):
        return {}
    mat0 = entry.get("material")
    if not isinstance(mat0, dict):
        mat0 = {}
        entry["material"] = mat0
    return mat0


def _entry_has_any_map(entry: dict, key: str) -> bool:
    if not isinstance(entry, dict):
        return False
    mat = entry.get("material")
    if isinstance(mat, dict) and mat.get(key):
        return True
    lods = entry.get("lods")
    if isinstance(lods, dict):
        for lod_meta in lods.values():
            if not isinstance(lod_meta, dict):
                continue
            subs = lod_meta.get("submeshes")
            if not isinstance(subs, list):
                continue
            for sm in subs:
                if not isinstance(sm, dict):
                    continue
                smm = sm.get("material")
                if isinstance(smm, dict) and smm.get(key):
                    return True
    return False


def _entry_has_any_diffuse(entry: dict) -> bool:
    return _entry_has_any_map(entry, "diffuse")


def _normalize_rel_asset_path(rel: str) -> str:
    """
    Normalize a manifest-relative-ish texture path to something under assets_dir.
    Examples:
      "models_textures/123.png" -> "models_textures/123.png"
      "assets/models_textures/123.png" -> "models_textures/123.png"
      "/assets/models_textures/123.png" -> "models_textures/123.png"
    """
    r = str(rel or "").strip().replace("\\", "/")
    r = r.lstrip("/")
    if r.lower().startswith("assets/"):
        r = r[len("assets/") :]
    return r


def _material_map_file_exists(assets_dir: Path, rel: str) -> bool:
    """
    Returns True if the referenced file exists on disk under assets_dir.
    Only meant for exported/runtime asset paths (not URLs).
    """
    r = _normalize_rel_asset_path(rel)
    if not r:
        return False
    try:
        p = assets_dir / r
        return p.exists() and p.is_file()
    except Exception:
        return False


def _entry_has_any_map_file(assets_dir: Path, entry: dict, key: str) -> bool:
    """
    Like _entry_has_any_map, but requires that the referenced file exists.
    This is critical because many manifests already contain 'diffuse' paths, but the files
    may not have been exported/synced yet.
    """
    if not isinstance(entry, dict):
        return False
    mat = entry.get("material")
    if isinstance(mat, dict):
        v = mat.get(key)
        if isinstance(v, str) and v.strip() and _material_map_file_exists(assets_dir, v):
            return True
    lods = entry.get("lods")
    if isinstance(lods, dict):
        for lod_meta in lods.values():
            if not isinstance(lod_meta, dict):
                continue
            subs = lod_meta.get("submeshes")
            if not isinstance(subs, list):
                continue
            for sm in subs:
                if not isinstance(sm, dict):
                    continue
                smm = sm.get("material")
                if isinstance(smm, dict):
                    v = smm.get(key)
                    if isinstance(v, str) and v.strip() and _material_map_file_exists(assets_dir, v):
                        return True
    return False


_MODELS_TEX_RE = re.compile(r"^models_textures/(?P<hash>\d+)(?:_(?P<slug>[^/]+))?\.png$", re.IGNORECASE)


def _maybe_name_from_models_textures_rel(rel: str) -> str | None:
    """
    Best-effort: infer a texture *name* from a models_textures/<hash>_<slug>.png rel.
    Returns the slug portion (usually identical to the real GTA texture name, modulo casing).
    """
    s = str(rel or "").strip().replace("\\", "/")
    s = s.lstrip("/")
    if s.lower().startswith("assets/"):
        s = s[len("assets/") :]
    m = _MODELS_TEX_RE.match(s)
    if not m:
        return None
    slug = str(m.group("slug") or "").strip()
    return slug or None


def _iter_entry_material_dicts(entry: dict):
    """
    Iterate material dicts found at entry-level and per-submesh for all LODs.
    """
    if not isinstance(entry, dict):
        return []
    mats = []
    m0 = entry.get("material")
    if isinstance(m0, dict):
        mats.append(m0)
    lods = entry.get("lods")
    if isinstance(lods, dict):
        for lod_meta in lods.values():
            if not isinstance(lod_meta, dict):
                continue
            subs = lod_meta.get("submeshes")
            if not isinstance(subs, list):
                continue
            for sm in subs:
                if isinstance(sm, dict) and isinstance(sm.get("material"), dict):
                    mats.append(sm.get("material"))
    return mats


def _collect_texture_names_from_entry(entry: dict, want_keys: list[str]) -> set[str]:
    """
    Collect texture *names* to export for an entry without requiring a Drawable.
    Sources:
      - explicit <key>Name fields (diffuseName/etc)
      - slug inferred from explicit <key> rel path (models_textures/<hash>_<slug>.png)
      - shaderParams.texturesByHash string values (CodeWalker-style names)
    """
    out: set[str] = set()
    mats = _iter_entry_material_dicts(entry)
    for mat in mats:
        if not isinstance(mat, dict):
            continue

        for k in want_keys:
            kn = f"{k}Name"
            v = mat.get(kn)
            if isinstance(v, str) and v.strip():
                out.add(v.strip())
            rel = mat.get(k)
            if isinstance(rel, str) and rel.strip():
                nm = _maybe_name_from_models_textures_rel(rel)
                if nm:
                    out.add(nm)

        sp = mat.get("shaderParams")
        tex_by_hash = sp.get("texturesByHash") if isinstance(sp, dict) else None
        if isinstance(tex_by_hash, dict):
            for v in tex_by_hash.values():
                if not isinstance(v, str):
                    continue
                s = v.strip()
                if not s:
                    continue
                if ("/" in s) or ("\\" in s) or (".png" in s.lower()) or (".dds" in s.lower()) or (".ktx2" in s.lower()):
                    continue
                out.add(s)

    return out

def _promote_first_submesh_material_to_entry_level(entry: dict) -> bool:
    """
    If v4 per-submesh materials exist, copy the first found submesh material fields
    (diffuse/normal/spec + uv0ScaleOffset/scalars) up to entry["material"].

    This keeps v3/back-compat paths (and viewer fallbacks) looking reasonable.
    """
    if not isinstance(entry, dict):
        return False
    lods = entry.get("lods")
    if not isinstance(lods, dict):
        return False
    first_mat = None
    for lod_meta in lods.values():
        if not isinstance(lod_meta, dict):
            continue
        subs = lod_meta.get("submeshes")
        if not isinstance(subs, list) or not subs:
            continue
        for sm in subs:
            if not isinstance(sm, dict):
                continue
            m = sm.get("material")
            if isinstance(m, dict) and m:
                first_mat = m
                break
        if first_mat:
            break
    if not isinstance(first_mat, dict) or not first_mat:
        return False

    mat0 = _ensure_entry_material(entry)
    changed = False
    for k in ("diffuse", "normal", "spec", "uv0ScaleOffset", "bumpiness", "specularIntensity", "specularPower"):
        if k in first_mat and mat0.get(k) != first_mat.get(k):
            mat0[k] = first_mat.get(k)
            changed = True
    return changed


#
# NOTE: `_entry_has_any_diffuse` used to be duplicated in this file as a "back-compat alias".
# Keep a single definition to avoid confusion.


def _load_shard_index(models_dir: Path) -> Optional[dict]:
    idx_path = models_dir / "manifest_index.json"
    if not idx_path.exists():
        return None
    try:
        idx = json.loads(idx_path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return None
    if not isinstance(idx, dict) or idx.get("schema") != "webglgta-manifest-index-v1":
        return None
    return idx


def _shard_path_for_hash(models_dir: Path, idx: dict, h_u32: int) -> Path:
    bits = int(idx.get("shard_bits") or 8)
    bits = max(4, min(12, bits))
    mask = (1 << bits) - 1
    shard_id = (int(h_u32) & 0xFFFFFFFF) & mask
    hex_digits = (bits + 3) // 4
    shard_hex = format(shard_id, "x").zfill(hex_digits)
    shard_dir = str(idx.get("shard_dir") or "manifest_shards")
    shard_ext = str(idx.get("shard_file_ext") or ".json")
    return models_dir / shard_dir / f"{shard_hex}{shard_ext}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-path", default=os.getenv("gta_location", ""), help="GTA5 install folder (or set gta_location)")
    ap.add_argument("--assets-dir", default="", help="webgl_viewer/assets folder (auto if omitted)")
    ap.add_argument(
        "--selected-dlc",
        default="all",
        help="CodeWalker DLC level. Use 'all' for full DLC overlays (except patchday27ng unless explicitly selected).",
    )
    ap.add_argument("--split-by-dlc", action="store_true", help="Write exported textures into assets/packs/<dlcname>/models_textures when possible.")
    ap.add_argument("--pack-root-prefix", default="packs", help="Pack root dir under assets/ (default: packs).")
    ap.add_argument("--force-pack", default="", help="Force writing all exported textures into a single pack id.")
    ap.add_argument("--max", type=int, default=0, help="Limit number of textures exported (0 = all)")
    ap.add_argument(
        "--only-from-dump",
        default="",
        help=(
            "Optional: restrict processing to archetypes referenced by a debug dump JSON "
            "(e.g. tools/debug_textures_near_coords.py --out ...). "
            "This is a targeted 'fix textures near X' mode."
        ),
    )
    ap.add_argument(
        "--only-missing",
        action="store_true",
        help="Only export when selected material maps are missing (see --only-missing-maps).",
    )
    ap.add_argument(
        "--only-missing-files",
        action="store_true",
        help="When used with --only-missing, treat a material map as missing if its referenced file does not exist on disk under --assets-dir.",
    )
    ap.add_argument(
        "--only-missing-maps",
        default="diffuse",
        help="Comma-separated material keys to treat as required when --only-missing is set (default: diffuse). "
             "Example: diffuse,normal,spec",
    )
    ap.add_argument("--ytd-spins", type=int, default=2000, help="Max ContentThreadProc spins while waiting for a YTD to load")
    ap.add_argument("--drawable-spins", type=int, default=600, help="Max ContentThreadProc spins while waiting for a Drawable to load")
    ap.add_argument("--export-ktx2", action="store_true", help="Also write .ktx2 copies for exported textures (requires toktx; writes *Ktx2 fields in materials)")
    ap.add_argument("--toktx", default="toktx", help="Path to toktx executable (KTX-Software). Used when --export-ktx2 is set.")
    ap.add_argument("--max-items-per-loop", type=int, default=200, help="GameFileCache.MaxItemsPerLoop (higher can load faster but may hitch)")
    ap.add_argument(
        "--dump-shader-params",
        action="store_true",
        help="Debug: print shader parameter hashes/types/texture names for the first few drawables processed",
    )
    ap.add_argument("--dump-shader-params-count", type=int, default=5, help="How many drawables to dump when --dump-shader-params is set")
    ap.add_argument("--dump-shader-params-limit", type=int, default=250, help="Max shader params to print per drawable")
    ap.add_argument("--debug-ytd", action="store_true", help="Print debug info about first few loaded YTDs/texture dicts")
    ap.add_argument("--debug-ytd-count", type=int, default=3, help="How many YTDs to debug when --debug-ytd is set")
    ap.add_argument("--dump-skip-samples", action="store_true", help="Print a sample of mesh hashes for each non-zero skip reason")
    ap.add_argument("--skip-samples", type=int, default=25, help="Max samples to print per skip reason")
    args = ap.parse_args()

    game_path = (args.game_path or "").strip('"').strip("'")
    if not game_path:
        raise SystemExit("Missing --game-path (or gta_location env var)")

    assets_dir = auto_assets_dir(args.assets_dir)

    manifest_path = assets_dir / "models" / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit(f"Missing {manifest_path}")

    mm = json.loads(manifest_path.read_text(encoding="utf-8", errors="ignore"))
    meshes = (mm.get("meshes") or {}) if isinstance(mm, dict) else {}
    if not isinstance(meshes, dict) or not meshes:
        raise SystemExit("Manifest has no meshes.")

    tex_dir_base = assets_dir / "models_textures"
    tex_dir_base.mkdir(parents=True, exist_ok=True)
    ktx2_dir_base = assets_dir / "models_textures_ktx2"
    if args.export_ktx2:
        ktx2_dir_base.mkdir(parents=True, exist_ok=True)

    # Optional sharded-manifest support: if present, we should update the shard files too,
    # because the WebGL viewer prefers loading shards via manifest_index.json.
    models_dir = assets_dir / "models"
    shard_idx = _load_shard_index(models_dir)
    shard_payloads = {}  # Path -> dict payload (loaded lazily)

    dm = DllManager(game_path)
    if not dm.initialized:
        raise SystemExit("Failed to initialize DllManager")
    if not dm.init_game_file_cache(selected_dlc=str(args.selected_dlc or "").strip() or None):
        raise SystemExit("Failed to init GameFileCache (required for textures)")
    # NOTE: Texture decode can happen either via CodeWalker texture.GetPixels(0) or via DDSIO.GetPixels(tex,0).
    # RpfReader.get_ytd_textures handles both paths, so do not hard-fail here.
    gfc = dm.get_game_file_cache()
    try:
        gfc.MaxItemsPerLoop = int(args.max_items_per_loop or 200)
    except Exception:
        pass

    rpf_reader = RpfReader(str(game_path), dm)

    packs_root = assets_dir / str(args.pack_root_prefix or "packs").strip().strip("/").strip("\\")
    force_pack = str(args.force_pack or "").strip().lower()
    split_by_dlc = bool(args.split_by_dlc)

    def _infer_dlc_name_from_entry_path(p: str) -> str:
        s = str(p or "").strip().lower().replace("/", "\\")
        m = re.search(r"\\dlcpacks\\([^\\]+)\\", s)
        return str(m.group(1) or "").strip().lower() if m else ""

    # Reuse CodeWalker-aware material export helpers from the main drawable exporter.
    # This script is specifically for "fast texture/material fixups" without re-exporting geometry.
    from export_drawables_for_chunk import _update_existing_manifest_materials_for_drawable, _export_texture_png  # type: ignore

    keys = list(meshes.keys())

    # Optional targeting: restrict to archetypes referenced by a debug dump.
    # This keeps the workflow fast when you're iterating on a specific coordinate.
    dump_path = str(args.only_from_dump or "").strip()
    if dump_path:
        try:
            dump_obj = json.loads(Path(dump_path).read_text(encoding="utf-8", errors="ignore"))
        except Exception:
            dump_obj = None
        wanted_hashes: set[str] = set()
        if isinstance(dump_obj, dict):
            rows = dump_obj.get("textures")
            if isinstance(rows, list):
                for r in rows:
                    if not isinstance(r, dict):
                        continue
                    # Only consider missing rows; we want to fix the gaps.
                    if str(r.get("reason") or "") == "ok":
                        continue
                    refs = r.get("refs")
                    if not isinstance(refs, list):
                        continue
                    for ref in refs:
                        if not isinstance(ref, dict):
                            continue
                        ah = ref.get("archetype_hash")
                        if ah is None:
                            continue
                        s = str(ah).strip()
                        if s:
                            wanted_hashes.add(s)
        if wanted_hashes:
            keys = [k for k in keys if str(k) in wanted_hashes]
            print(f"[target] --only-from-dump={dump_path} -> archetypes={len(wanted_hashes)} manifestKeysSelected={len(keys)}")
        else:
            print(f"[target] --only-from-dump={dump_path} -> no archetype refs found; processing full manifest ({len(keys)} keys)")

    maxn = int(args.max or 0)
    if maxn > 0:
        keys = keys[:maxn]

    entries_updated = 0
    textures_written = 0
    skipped = 0
    skip_reasons = {
        "bad_hash": 0,
        "only_missing_already_has_required_maps": 0,
        "no_archetype": 0,
        "no_drawable": 0,
        "no_texture_dict": 0,
        "bad_texture_dict_hash": 0,
        "no_ytd": 0,
        "ytd_not_loaded": 0,
        "no_textures_in_ytd": 0,
        "exception": 0,
    }
    first_exception = None  # (type, message, traceback)
    exception_counts = {}  # "Type: message" -> count
    debug_left = int(args.debug_ytd_count or 0) if args.debug_ytd else 0
    debug_empty_dumped = False
    dump_shader_left = int(args.dump_shader_params_count or 0) if args.dump_shader_params else 0
    skip_samples = {}  # reason -> list[dict]
    max_skip_samples = max(1, int(args.skip_samples or 25))

    def _iter_shader_params(shader):
        """
        Yield (hash_u32, dataTypeInt, paramObj) for a shader's parameter list.
        dataType values come from CodeWalker:
          0 = Texture, 1 = Vector4, >1 = array-ish.
        """
        if shader is None:
            return
        plist = getattr(shader, "ParametersList", None)
        if plist is None:
            return
        hashes = getattr(plist, "Hashes", None)
        params = getattr(plist, "Parameters", None)
        if hashes is None or params is None:
            return
        count = int(getattr(plist, "Count", 0) or 0)
        if count <= 0:
            try:
                count = len(params)
            except Exception:
                count = 0
        for ii in range(count):
            try:
                hv = int(hashes[ii]) & 0xFFFFFFFF
            except Exception:
                continue
            try:
                p = params[ii]
            except Exception:
                continue
            try:
                dt = int(getattr(p, "DataType", 255))
            except Exception:
                dt = 255
            yield hv, dt, p

    def _dump_drawable_shader_params(mesh_hash_u32: int, drawable_obj):
        nonlocal dump_shader_left
        if dump_shader_left <= 0:
            return
        dump_shader_left -= 1
        try:
            lim = int(args.dump_shader_params_limit or 250)
        except Exception:
            lim = 250
        lim = max(10, min(2000, lim))

        print(f"[shader-dump] mesh_hash={int(mesh_hash_u32) & 0xFFFFFFFF}")
        printed = 0
        try:
            models_block = getattr(drawable_obj, "DrawableModels", None)
            arr = getattr(models_block, "High", None) if models_block is not None else None
            models = list(arr) if arr is not None else []
        except Exception:
            models = []
        for mi, m in enumerate(models):
            gs = getattr(m, "Geometries", None)
            if gs is None:
                continue
            for gi, g in enumerate(list(gs)):
                shader = getattr(g, "Shader", None)
                if shader is None:
                    continue
                for hv, dt, p in _iter_shader_params(shader) or []:
                    if printed >= lim:
                        print(f"[shader-dump] ... truncated (limit={lim})")
                        return
                    tex_name = None
                    if dt == 0:
                        try:
                            tex = getattr(p, "Data", None)
                            tex_name = str(getattr(tex, "Name", "")).strip() if tex is not None else None
                        except Exception:
                            tex_name = None
                    # Keep it mostly machine-readable: hv, dtype, texName?
                    if tex_name:
                        print(f"[shader-dump] model={mi} geom={gi} hv={hv} dt={dt} tex={tex_name}")
                    else:
                        print(f"[shader-dump] model={mi} geom={gi} hv={hv} dt={dt}")
                    printed += 1
        if printed == 0:
            print("[shader-dump] (no shader params found)")

    def _sample(reason: str, **payload):
        if not args.dump_skip_samples:
            return
        lst = skip_samples.get(reason)
        if lst is None:
            lst = []
            skip_samples[reason] = lst
        if len(lst) >= max_skip_samples:
            return
        payload2 = {"mesh_hash": hs}
        payload2.update(payload)
        lst.append(payload2)
    for i, hs in enumerate(keys):
        h = _as_u32(hs)
        if h is None:
            skip_reasons["bad_hash"] += 1
            _sample("bad_hash")
            skipped += 1
            continue
        entry = meshes.get(hs) or {}
        # Optional fast path: skip entries that already have the requested material maps.
        # This used to mean "diffuse only", but missing normal/spec is a common failure mode.
        want_keys = []
        try:
            want_keys = [k.strip() for k in str(args.only_missing_maps or "").split(",") if k.strip()]
        except Exception:
            want_keys = []
        if not want_keys:
            want_keys = ["diffuse"]

        have_all = True
        if not isinstance(entry, dict):
            have_all = False
        else:
            for k in want_keys:
                if args.only_missing_files:
                    if not _entry_has_any_map_file(assets_dir, entry, k):
                        have_all = False
                        break
                else:
                    if not _entry_has_any_map(entry, k):
                        have_all = False
                        break

        if args.only_missing and have_all:
            skip_reasons["only_missing_already_has_required_maps"] += 1
            _sample(
                "only_missing_already_has_required_maps",
                want=",".join(want_keys),
                mode=("file-exists" if args.only_missing_files else "field-present"),
            )
            skipped += 1
            continue

        arch = get_archetype_best_effort(gfc, int(h) & 0xFFFFFFFF, dll_manager=dm)
        if arch is None:
            skip_reasons["no_archetype"] += 1
            _sample("no_archetype", archetype=None)
            skipped += 1
            continue

        try:
            # Load the Drawable too so we can read per-geometry shader params (uv tiling + correct sampler picks).
            max_spins_d = int(args.drawable_spins or 600)
            if max_spins_d < 0:
                max_spins_d = 0
            drawable = _try_get_drawable(gfc, arch, spins=max_spins_d)
            if drawable is None:
                # Don't early-exit: we can still export textures directly from the YTD using
                # manifest-provided texture names/paths (fallback path).
                pass
            else:
                if dump_shader_left > 0:
                    _dump_drawable_shader_params(h, drawable)

            tdh = getattr(arch, "TextureDict", None)
            td_hash = None
            if tdh is not None:
                # Be defensive: different CodeWalker builds expose different types here.
                # Prefer a .Hash property, otherwise try casting.
                hv = None
                try:
                    hv = getattr(tdh, "Hash", None)
                except Exception:
                    hv = None
                if hv is None:
                    try:
                        hv = int(tdh)
                    except Exception:
                        hv = None
                try:
                    td_hash = (int(hv) & 0xFFFFFFFF) if hv is not None else None
                except Exception:
                    td_hash = None
                    skip_reasons["bad_texture_dict_hash"] += 1
                    _sample("bad_texture_dict_hash", texture_dict_raw=str(tdh))
                    skipped += 1
                    continue
            if not td_hash or td_hash == 0:
                skip_reasons["no_texture_dict"] += 1
                _sample("no_texture_dict", texture_dict_hash=td_hash)
                skipped += 1
                continue

            # CodeWalker parity: apply HD-TXD mapping first (from `_manifest.ymf` HDTxdAssetBindings).
            # This can change which YTD contains textures for a given archetype/asset.
            td_hash_hd = None
            try:
                td_hash_hd = int(gfc.TryGetHDTextureHash(int(td_hash) & 0xFFFFFFFF)) & 0xFFFFFFFF
            except Exception:
                td_hash_hd = int(td_hash) & 0xFFFFFFFF
            # Prefer HD-mapped hash when it differs.
            td_hash_candidates = []
            if td_hash_hd and td_hash_hd != (int(td_hash) & 0xFFFFFFFF):
                td_hash_candidates.append(td_hash_hd)
            td_hash_candidates.append(int(td_hash) & 0xFFFFFFFF)

            # Primary: treat TextureDict as a YTD shortname hash (common case), trying HD first.
            ytd = None
            for cand in td_hash_candidates:
                if ytd is not None:
                    break
                try:
                    ytd = gfc.GetYtd(int(cand) & 0xFFFFFFFF)
                except Exception:
                    ytd = None

            # CodeWalker has additional indirection helpers for cases where a hash is a *texture* name
            # (not the ytd shortname) or when a texture dict is inherited from a parent.
            if ytd is None:
                for cand in td_hash_candidates:
                    if ytd is not None:
                        break
                    try:
                        # If td_hash is actually a texture name hash, resolve it to the owning YTD.
                        ytd = gfc.TryGetTextureDictForTexture(int(cand) & 0xFFFFFFFF)
                    except Exception:
                        ytd = None
            if ytd is None:
                for cand in td_hash_candidates:
                    if ytd is not None:
                        break
                    try:
                        # Try parent texture dict chain (rare but exists for some assets).
                        ph = gfc.TryGetParentYtdHash(int(cand) & 0xFFFFFFFF)
                        if ph and int(ph) != 0:
                            ytd = gfc.GetYtd(int(ph) & 0xFFFFFFFF)
                    except Exception:
                        pass
            spins = 0
            max_spins = int(args.ytd_spins or 2000)
            if max_spins < 0:
                max_spins = 0
            while (ytd is not None) and (not getattr(ytd, "Loaded", True)) and spins < max_spins:
                gfc.ContentThreadProc()
                spins += 1
            if ytd is None or not getattr(ytd, "Loaded", True):
                if ytd is None:
                    skip_reasons["no_ytd"] += 1
                    _sample("no_ytd", texture_dict_hash=td_hash)
                else:
                    skip_reasons["ytd_not_loaded"] += 1
                    _sample("ytd_not_loaded", texture_dict_hash=td_hash, spins=spins)
                skipped += 1
                continue

            # Pick texture output dirs (base vs pack) based on the source YTD.
            tex_dir = tex_dir_base
            ktx2_dir = ktx2_dir_base
            if force_pack:
                tex_dir = packs_root / force_pack / "models_textures"
                ktx2_dir = packs_root / force_pack / "models_textures_ktx2"
            elif split_by_dlc:
                try:
                    ent = getattr(ytd, "RpfFileEntry", None)
                    ep = str(getattr(ent, "Path", "") or "") if ent is not None else ""
                except Exception:
                    ep = ""
                dlc = _infer_dlc_name_from_entry_path(ep)
                if dlc:
                    tex_dir = packs_root / dlc / "models_textures"
                    ktx2_dir = packs_root / dlc / "models_textures_ktx2"

            if debug_left > 0:
                debug_left -= 1
                try:
                    td = getattr(ytd, "TextureDict", None)
                    td_has = td is not None
                    tlist = getattr(td, "Textures", None) if td_has else None
                    dct = getattr(td, "Dict", None) if td_has else None
                    # Attempt to count textures without forcing pixel decode.
                    tcount = None
                    try:
                        di = getattr(tlist, "data_items", None)
                        if di is not None:
                            tcount = len(di)
                    except Exception:
                        tcount = None
                    if tcount is None:
                        try:
                            vals = getattr(dct, "Values", None)
                            if vals is not None:
                                tcount = len(list(vals))
                        except Exception:
                            tcount = None
                    print(
                        f"[debug] ytd Loaded={getattr(ytd,'Loaded',None)} "
                        f"TextureDict={td_has} "
                        f"Textures.data_items_len={tcount}"
                    )
                except Exception:
                    pass

            textures = rpf_reader.get_ytd_textures(ytd)
            if not textures:
                if not debug_empty_dumped:
                    debug_empty_dumped = True
                    try:
                        td = getattr(ytd, "TextureDict", None)
                        tlist = getattr(td, "Textures", None) if td is not None else None
                        thashes = getattr(td, "TextureNameHashes", None) if td is not None else None
                        di = getattr(tlist, "data_items", None) if tlist is not None else None
                        dhi = getattr(thashes, "data_items", None) if thashes is not None else None
                        d = getattr(td, "Dict", None) if td is not None else None
                        dv = getattr(d, "Values", None) if d is not None else None
                        try:
                            dict_count = len(list(dv)) if dv is not None else None
                        except Exception:
                            dict_count = None

                        print("[debug-empty] First YTD returned 0 decoded textures.")
                        print(f"[debug-empty] ytd.Loaded={getattr(ytd,'Loaded',None)} td_hash={td_hash}")
                        print(
                            f"[debug-empty] TextureDict present={td is not None} "
                            f"Textures.data_items_len={(len(di) if di is not None else None)} "
                            f"TextureNameHashes.data_items_len={(len(dhi) if dhi is not None else None)} "
                            f"Dict.Values_len={dict_count}"
                        )

                        # Try probing the first texture entry and DDSIO.
                        if di is not None and len(di) > 0:
                            tex0 = di[0]
                            print(
                                f"[debug-empty] tex0 name={getattr(tex0,'Name',None)} "
                                f"w={getattr(tex0,'Width',None)} h={getattr(tex0,'Height',None)} "
                                f"stride={getattr(tex0,'Stride',None)} fmt={getattr(getattr(tex0,'Format',None),'ToString',lambda: getattr(tex0,'Format',None))()}"
                            )
                            # DDSIO probe
                            ddsio = getattr(dm, "DDSIO", None)
                            print(f"[debug-empty] dm.DDSIO type={type(ddsio).__name__} has_GetPixels={hasattr(ddsio,'GetPixels')}")
                            try:
                                if ddsio is not None and hasattr(ddsio, "GetPixels"):
                                    px = ddsio.GetPixels(tex0, 0)
                                    blen = len(bytes(px)) if px is not None else 0
                                    print(f"[debug-empty] DDSIO.GetPixels(tex0,0) bytes_len={blen}")
                            except Exception as e:
                                print(f"[debug-empty] DDSIO.GetPixels threw: {type(e).__name__}: {e}")
                    except Exception:
                        pass
                skip_reasons["no_textures_in_ytd"] += 1
                _sample("no_textures_in_ytd", texture_dict_hash=td_hash)
                skipped += 1
                continue
            # Update manifest materials and export textures (diffuse/normal/spec + params) using shader-aware picks.
            if not isinstance(entry, dict):
                entry = {}
                meshes[hs] = entry

            wrote_now = 0
            if drawable is not None:
                wrote_now = _update_existing_manifest_materials_for_drawable(
                    entry=entry,
                    drawable=drawable,
                    textures=textures,
                    td_hash=int(td_hash) & 0xFFFFFFFF,
                    tex_dir=tex_dir,
                    dll_manager=dm,
                    export_ktx2=bool(args.export_ktx2),
                    ktx2_dir=ktx2_dir,
                    toktx_exe=str(args.toktx or "toktx"),
                )
            else:
                # Fallback export: no drawable available, but we have a decoded YTD textures dict.
                # Export by NAME using manifest hints (diffuseName/etc, shaderParams.texturesByHash, and slug inferred from paths).
                names = _collect_texture_names_from_entry(entry, want_keys)
                if not names:
                    skip_reasons["no_drawable"] += 1
                    _sample("no_drawable", spins=spins_d, note="fallback had no names")
                    skipped += 1
                    continue

                exported_now = 0
                for nm in sorted(names):
                    _relp, wrote = _export_texture_png(textures, nm, tex_dir, td_hash=int(td_hash) & 0xFFFFFFFF, dll_manager=dm)
                    if wrote:
                        exported_now += 1
                wrote_now = exported_now
                if wrote_now == 0:
                    # Nothing new written; likely already exported by other entries sharing this YTD.
                    skip_reasons["no_drawable"] += 1
                    _sample("no_drawable", spins=spins_d, note="fallback wrote 0 new (already present)")
                    skipped += 1
                    continue
            # NOTE:
            # `_update_existing_manifest_materials_for_drawable(...)` returns the number of *new PNG files written*.
            # That can legitimately be 0 even when it updated manifest material params (or when textures already existed).
            # Treat this as success as long as we decoded a non-empty textures dict.
            try:
                wn = int(wrote_now or 0)
            except Exception:
                wn = 0
            if wn > 0:
                textures_written += wn

            _promote_first_submesh_material_to_entry_level(entry)

            # If sharded manifests exist, update the correct shard entry too.
            if shard_idx is not None:
                sp = _shard_path_for_hash(models_dir, shard_idx, h)
                try:
                    payload = shard_payloads.get(sp)
                    if payload is None:
                        if sp.exists():
                            payload = json.loads(sp.read_text(encoding="utf-8", errors="ignore"))
                        else:
                            payload = {}
                        shard_payloads[sp] = payload
                    if isinstance(payload, dict):
                        pmeshes = payload.get("meshes")
                        if not isinstance(pmeshes, dict):
                            pmeshes = {}
                            payload["meshes"] = pmeshes
                        pentry = pmeshes.get(hs)
                        if not isinstance(pentry, dict):
                            pentry = {}
                            pmeshes[hs] = pentry
                        _update_existing_manifest_materials_for_drawable(
                            entry=pentry,
                            drawable=drawable,
                            textures=textures,
                            td_hash=int(td_hash) & 0xFFFFFFFF,
                            tex_dir=tex_dir,
                            dll_manager=dm,
                            export_ktx2=bool(args.export_ktx2),
                            ktx2_dir=ktx2_dir,
                            toktx_exe=str(args.toktx or "toktx"),
                        )
                        _promote_first_submesh_material_to_entry_level(pentry)
                except Exception:
                    # Don't fail the whole run because a shard couldn't be updated.
                    pass
            entries_updated += 1
        except Exception as e:
            skip_reasons["exception"] += 1
            _sample("exception", texture_dict_hash=locals().get("td_hash", None), error=f"{type(e).__name__}: {e}")
            skipped += 1
            # Capture the first traceback + a summary of exception types/messages.
            try:
                et = type(e).__name__
                msg = str(e)
                key = f"{et}: {msg}"
                exception_counts[key] = int(exception_counts.get(key, 0)) + 1
                if first_exception is None:
                    first_exception = (et, msg, traceback.format_exc())
            except Exception:
                pass

        if (i + 1) % 250 == 0:
            print(f"[{i+1}/{len(keys)}] entries_updated={entries_updated} textures_written={textures_written} skipped={skipped}")

    # Write manifest back
    mm["meshes"] = meshes
    manifest_path.write_text(json.dumps(mm, indent=2), encoding="utf-8")

    # Write updated shards back (if any were touched/loaded).
    if shard_payloads:
        wrote = 0
        for sp, payload in shard_payloads.items():
            try:
                if not isinstance(payload, dict):
                    continue
                sp.parent.mkdir(parents=True, exist_ok=True)
                sp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
                wrote += 1
            except Exception:
                continue
        print(f"Updated shard files: {wrote}")

    # Print a quick breakdown to make "everything skipped" diagnosable.
    try:
        print("Skip reasons:")
        for k in sorted(skip_reasons.keys()):
            v = int(skip_reasons.get(k, 0) or 0)
            if v:
                print(f"  - {k}: {v}")
    except Exception:
        pass

    # Print some concrete examples for each skip bucket so it's actionable.
    if args.dump_skip_samples and skip_samples:
        try:
            print("Skip samples:")
            for reason in sorted(skip_samples.keys()):
                rows = skip_samples.get(reason) or []
                if not rows:
                    continue
                print(f"  - {reason}:")
                for row in rows:
                    print(f"    - {row}")
        except Exception:
            pass

    # Print exception detail (first traceback + most common messages).
    if first_exception is not None:
        try:
            et, msg, tb = first_exception
            print("First exception:")
            print(f"  {et}: {msg}")
            print(tb)
        except Exception:
            pass
    try:
        if exception_counts:
            print("Top exceptions:")
            top = sorted(exception_counts.items(), key=lambda kv: kv[1], reverse=True)[:10]
            for k, v in top:
                print(f"  - {k} -> {v}")
    except Exception:
        pass

    print(f"Done. entries_updated={entries_updated} textures_written={textures_written} skipped={skipped} -> {manifest_path}")


if __name__ == "__main__":
    main()



"""
Extract missing model textures from GTA5 YTDs using CodeWalker/GameFileCache lookup.

Input: a JSON produced by `debug_textures_near_coords.py` (schema: webglgta-texture-coords-dump-v1)
Output: PNG files written into `webgl_viewer/assets/models_textures/` using the viewer's canonical naming:
  - hash-only: <hash>.png
  - hash+slug (optional): <hash>_<slug>.png  (slug is taken from the requestedRel when available)

Why this exists:
  The WebGL viewer can only avoid placeholders if referenced textures exist under assets/models_textures/.
  Many materials reference textures by *name* through shader params; CodeWalker resolves those names to a
  YTD via a global texture→YTD lookup. We use the same mechanism here.

Usage:
  python webgl-gta/webgl_viewer/tools/extract_missing_textures_from_ytd_dump.py \
    --gta-path /data/webglgta/gta5 \
    --dump webgl-gta/webgl_viewer/tools/out/tex_dump_at_point.json \
    --limit 500 \
    --write-hash-only \
    --write-hash-slug \
    --regen-index
"""

from __future__ import annotations

import argparse
import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional, Tuple

from PIL import Image

import sys

# Allow running as a script without installing the repo as a package.
# We add the repo root (`webgl-gta/`) to sys.path so `gta5_modules` is importable.
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from gta5_modules.dll_manager import DllManager
from gta5_modules.hash_utils import coerce_u32 as _coerce_u32
from gta5_modules.codewalker_archetypes import get_archetype_best_effort
from gta5_modules.cw_loaders import ensure_loaded as _ensure_loaded_shared
from gta5_modules.dlc_paths import infer_dlc_pack_from_entry_path as _infer_dlc_pack_from_entry_path
from gta5_modules.dlc_paths import get_gamefile_entry_path_or_namelower as _get_gamefile_entry_path_or_namelower


_MODEL_TEX_RE = re.compile(r"^models_textures/(?P<hash>\d+)(?:_(?P<slug>[^/]+))?\.png$", re.IGNORECASE)

def _infer_dlc_name_from_entry_path(p: str) -> str:
    # Wrapper preserved for backwards-compat within this script.
    return _infer_dlc_pack_from_entry_path(p)


@dataclass(frozen=True)
class WantedTex:
    tex_hash: int
    requested_rel: str
    slug: str
    use_count: int
    sample_archetype_hash: int


def _load_dump(p: Path) -> dict:
    return json.loads(p.read_text(encoding="utf-8", errors="ignore"))


def _iter_missing_textures_from_dump(dump: dict) -> Dict[int, WantedTex]:
    """
    Return dict[texhash] -> WantedTex. Dedupes by hash and keeps the highest-useCount row.
    """
    out: Dict[int, WantedTex] = {}
    # Support passing a `missing_textures_remaining.json` array directly (tools/out/*.json).
    if isinstance(dump, list):
        rows = dump
    else:
        rows = dump.get("textures")
    # Support alternate input schema produced by probe_model_textures_like_viewer.py:
    #   { schema: "webglgta-missing-model-texture-hashes-v1", missing: [{ hash, refCount, sample }, ...] }
    if not isinstance(rows, list) and isinstance(dump, dict):
        missing = dump.get("missing")
        if isinstance(missing, list):
            rows = []
            for r in missing:
                if not isinstance(r, dict):
                    continue
                hs = str(r.get("hash") or "").strip()
                if not hs.isdigit():
                    continue
                h = int(hs, 10) & 0xFFFFFFFF
                use = int(r.get("refCount") or 0)
                sample = str(r.get("sample") or "").strip().replace("\\", "/")
                # sample is typically "assets/models_textures/<hash>_<slug>.png"
                sample_rel = sample
                if sample_rel.lower().startswith("assets/"):
                    sample_rel = sample_rel[len("assets/") :]
                # Ensure it matches our models_textures regex so we can recover slug.
                m = _MODEL_TEX_RE.match(sample_rel)
                slug = str(m.group("slug") or "") if m else ""
                requested_rel = f"models_textures/{h}_{slug}.png" if slug else f"models_textures/{h}.png"
                rows.append({"requestedRel": requested_rel, "useCount": use, "refs": []})
        else:
            return out
    for r in rows:
        if not isinstance(r, dict):
            continue
        reason = str(r.get("reason") or "")
        # In probe-derived rows, 'reason' is absent; treat as missing.
        if reason == "ok":
            continue
        rel = str(r.get("requestedRel") or "").strip()
        m = _MODEL_TEX_RE.match(rel)
        if not m:
            continue
        h = int(m.group("hash")) & 0xFFFFFFFF
        slug = str(m.group("slug") or "")
        use = int(r.get("useCount") or 0)
        # Pick a representative archetype that references this texture.
        sample_arch = 0
        try:
            refs = r.get("refs")
            if isinstance(refs, list) and refs:
                a0 = refs[0].get("archetype_hash") if isinstance(refs[0], dict) else None
                if a0 is not None:
                    sample_arch = int(str(a0), 10) & 0xFFFFFFFF
        except Exception:
            sample_arch = 0
        prev = out.get(h)
        if prev is None or use > prev.use_count:
            out[h] = WantedTex(tex_hash=h, requested_rel=rel, slug=slug, use_count=use, sample_archetype_hash=sample_arch)
    return out


def _ensure_loaded(gfc, gf, max_loops: int = 50) -> bool:
    """
    Ensure a CodeWalker GameFile is loaded by pumping ContentThreadProc.
    """
    # Wrapper preserved for script-local callers.
    return bool(_ensure_loaded_shared(gfc, gf, max_loops=int(max_loops or 0)))


def _pixels_to_image_rgba(pixels: bytes, width: int, height: int) -> Image.Image:
    """
    Convert CodeWalker DDSIO.GetPixels output into a PIL Image.

    DDSIO.GetPixels typically returns a tightly packed pixel buffer in RGB or RGBA.
    """
    if not pixels:
        raise ValueError("empty pixels")
    n = len(pixels)
    exp_rgba = width * height * 4
    exp_rgb = width * height * 3
    if n == exp_rgba:
        return Image.frombytes("RGBA", (width, height), pixels)
    if n == exp_rgb:
        img = Image.frombytes("RGB", (width, height), pixels)
        return img.convert("RGBA")
    # Best-effort: if buffer is larger, try truncating to expected RGBA.
    if n > exp_rgba:
        return Image.frombytes("RGBA", (width, height), pixels[:exp_rgba])
    raise ValueError(f"unexpected pixel buffer size={n} (expected {exp_rgb} or {exp_rgba})")


def _try_get_pixels_bytes(dm: DllManager, tex) -> bytes | None:
    """
    Best-effort: attempt to decode a CodeWalker Texture to a packed RGB/RGBA buffer.
    Returns None if decode isn't available (eg Gen9 BC7 TODO in CodeWalker.Core DDSIO.GetPixels).
    """
    if tex is None:
        return None
    # Prefer DDSIO.GetPixels(tex,0) when available (more reliable across pythonnet projections).
    try:
        ddsio = getattr(dm, "DDSIO", None)
        if ddsio is not None and hasattr(ddsio, "GetPixels"):
            px = ddsio.GetPixels(tex, 0)
            if px:
                b = bytes(px)
                if b:
                    return b
    except Exception:
        pass
    # Fallback: texture-native GetPixels.
    try:
        if hasattr(tex, "GetPixels"):
            px = tex.GetPixels(0)
            if px:
                b = bytes(px)
                if b:
                    return b
    except Exception:
        pass
    return None


def _try_get_dds_bytes(dm: DllManager, tex) -> bytes | None:
    """
    Best-effort: return a DDS container for a CodeWalker Texture.
    This is our fastest Gen9 fallback because browsers can upload BC7/BC6H directly via extensions.
    """
    if tex is None:
        return None
    try:
        ddsio = getattr(dm, "DDSIO", None)
        if ddsio is not None and hasattr(ddsio, "GetDDSFile"):
            dds = ddsio.GetDDSFile(tex)
            if dds:
                b = bytes(dds)
                if b:
                    return b
    except Exception:
        pass
    return None


def _write_texture_asset(dm: DllManager, tex, out_path_png: Path, out_path_dds: Path) -> tuple[bool, str]:
    """
    Write a texture to disk as PNG when possible, else fall back to DDS.
    Returns (ok, written_ext) where written_ext is 'png' or 'dds'.
    """
    # PNG path (existing behavior)
    try:
        px = _try_get_pixels_bytes(dm, tex)
        if px:
            w = int(getattr(tex, "Width", 0) or 0)
            h = int(getattr(tex, "Height", 0) or 0)
            if w > 0 and h > 0:
                img = _pixels_to_image_rgba(px, w, h)
                out_path_png.parent.mkdir(parents=True, exist_ok=True)
                img.save(out_path_png)
                return True, "png"
    except Exception:
        pass

    # DDS fallback (Gen9 BC7/BC6H, etc)
    try:
        dds = _try_get_dds_bytes(dm, tex)
        if dds:
            out_path_dds.parent.mkdir(parents=True, exist_ok=True)
            out_path_dds.write_bytes(dds)
            return True, "dds"
    except Exception:
        pass

    return False, ""


def _regen_models_textures_index(models_textures_dir: Path) -> None:
    """
    Regenerate assets/models_textures/index.json (same schema as setup_assets.py).
    """
    re_hash_only = re.compile(r"^(?P<hash>\d+)\.(png|dds)$", re.IGNORECASE)
    re_hash_slug = re.compile(r"^(?P<hash>\d+)_(?P<slug>[^/]+)\.(png|dds)$", re.IGNORECASE)
    by_hash: Dict[str, dict] = {}

    for p in sorted(list(models_textures_dir.glob("*.png")) + list(models_textures_dir.glob("*.dds"))):
        name = p.name
        m1 = re_hash_only.match(name)
        m2 = re_hash_slug.match(name) if not m1 else None
        if not (m1 or m2):
            continue
        h = (m1 or m2).group("hash")
        ent = by_hash.get(h)
        if ent is None:
            ent = {"hash": str(h), "hashOnly": False, "preferredFile": None, "files": []}
            by_hash[h] = ent
        ent["files"].append(name)
        if m1:
            if name.lower().endswith(".png"):
                ent["hashOnly"] = True

    for h, ent in by_hash.items():
        files = list(ent.get("files") or [])
        files.sort()
        ho = f"{h}.png"
        ent["preferredFile"] = ho if ho in files else (files[0] if files else None)

    out = {
        "schema": "webglgta-models-textures-index-v1",
        "generatedAtUnix": int(time.time()),
        "byHash": by_hash,
    }
    out_path = models_textures_dir / "index.json"
    tmp_path = models_textures_dir / "index.json.tmp"
    tmp_path.write_text(json.dumps(out, indent=2, sort_keys=True), encoding="utf-8")
    tmp_path.replace(out_path)

def _u32_from_metahash(mh) -> int:
    """
    Convert CodeWalker MetaHash (or a plain int) into a u32.
    """
    # Wrapper kept for legacy callers in this script.
    # Preserve semantics: return 0 on failure; treat strings as decimal-only.
    return int(_coerce_u32(mh, allow_hex=False, default=0)) & 0xFFFFFFFF


def _try_lookup_texture_in_texture_dict(tex_dict, texhash_u32: int):
    """Best-effort TextureDictionary.Lookup(hash) wrapper for pythonnet objects."""
    if tex_dict is None:
        return None
    try:
        return tex_dict.Lookup(int(texhash_u32) & 0xFFFFFFFF)
    except Exception:
        return None


def _try_find_texture_in_drawable(gfc, arche, texhash_u32: int):
    """
    Try to find a texture via the drawable's embedded texture dictionaries:
      - drawable.TextureDictionary
      - drawable.ShaderGroup.TextureDictionary
    This mirrors CodeWalker paths in Drawable.cs where shadergroup dictionaries can override.
    """
    if gfc is None or arche is None:
        return None
    drawable = None
    try:
        drawable = gfc.TryGetDrawable(arche)
    except Exception:
        drawable = None
    if drawable is None:
        return None
    # Ensure drawable is loaded by pumping content thread a bit.
    try:
        _ensure_loaded(gfc, drawable, max_loops=160)
    except Exception:
        pass
    # 1) ShaderGroup.TextureDictionary
    try:
        sg = getattr(drawable, "ShaderGroup", None)
        td = getattr(sg, "TextureDictionary", None) if sg is not None else None
        tex = _try_lookup_texture_in_texture_dict(td, texhash_u32)
        if tex is not None:
            return tex
    except Exception:
        pass
    # 2) Drawable.TextureDictionary
    try:
        td2 = getattr(drawable, "TextureDictionary", None)
        tex2 = _try_lookup_texture_in_texture_dict(td2, texhash_u32)
        if tex2 is not None:
            return tex2
    except Exception:
        pass
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gta-path", required=True, help="Path to GTA5 root (contains RPFs / gta5.exe symlink workaround).")
    ap.add_argument("--dump", required=True, help="Path to tex_dump_at_point.json from debug_textures_near_coords.py")
    ap.add_argument("--assets-dir", default="", help="Viewer assets dir (defaults to webgl_viewer/assets next to this script).")
    ap.add_argument(
        "--enable-dlc",
        default=True,
        action=getattr(argparse, "BooleanOptionalAction", "store_true"),
        help="Enable DLC/update overlays in CodeWalker (default: true). Use --no-enable-dlc for base-game-only.",
    )
    ap.add_argument(
        "--selected-dlc",
        default="all",
        help="CodeWalker DLC level (default: all). Example: patchday27ng. Ignored when --no-enable-dlc is set.",
    )
    ap.add_argument("--split-by-dlc", action="store_true", help="Write textures into assets/packs/<dlcname>/models_textures when possible.")
    ap.add_argument("--pack-root-prefix", default="packs", help="Pack root dir under assets/ (default: packs).")
    ap.add_argument("--force-pack", default="", help="Force writing all outputs into a single pack id (e.g. patchday27ng).")
    ap.add_argument("--limit", type=int, default=500, help="Max unique texture hashes to attempt.")
    ap.add_argument("--write-hash-only", action="store_true", help="Write <hash>.png")
    ap.add_argument("--write-hash-slug", action="store_true", help="Write <hash>_<slug>.png when slug is known from requestedRel")
    ap.add_argument("--regen-index", action="store_true", help="Regenerate assets/models_textures/index.json after extraction.")
    args = ap.parse_args()

    dump_path = Path(args.dump)
    if not dump_path.exists():
        raise SystemExit(f"Missing dump: {dump_path}")

    viewer_root = Path(__file__).resolve().parents[1]
    assets_dir = Path(args.assets_dir) if args.assets_dir else (viewer_root / "assets")
    models_textures_dir = assets_dir / "models_textures"
    models_textures_dir.mkdir(parents=True, exist_ok=True)
    packs_root = assets_dir / str(args.pack_root_prefix or "packs").strip().strip("/").strip("\\")
    force_pack = str(args.force_pack or "").strip().lower()
    split_by_dlc = bool(args.split_by_dlc)

    dump = _load_dump(dump_path)
    wanted = list(_iter_missing_textures_from_dump(dump).values())
    wanted.sort(key=lambda w: (-w.use_count, w.tex_hash))
    wanted = wanted[: max(0, int(args.limit))]

    if not wanted:
        print("No missing model textures found in dump.")
        return 0

    # Initialize CodeWalker access.
    dm = DllManager(str(args.gta_path))
    if not getattr(dm, "initialized", False):
        raise SystemExit("DllManager failed to initialize (DLL load / keys / RPF index). Check logs above.")
    sel = str(args.selected_dlc or "").strip()
    if not bool(args.enable_dlc):
        sel = ""
    ok = dm.init_game_file_cache(load_vehicles=False, load_peds=False, load_audio=False, selected_dlc=(sel if sel else None))
    if not ok:
        raise SystemExit("Failed to init GameFileCache; cannot locate textures in YTDs.")
    # IMPORTANT:
    # Use the underlying CodeWalker.GameFiles.GameFileCache instance. Some older helper wrappers
    # don't expose the full dictionaries (like YtdDict) consistently.
    gfc = dm.get_game_file_cache()
    if gfc is None or not getattr(gfc, "IsInited", False):
        raise SystemExit("GameFileCache not inited.")

    # Build a lightweight index of available YTD filenames for last-resort lookup by name tokens.
    # This is much cheaper than scanning RPFs, and often enough to find interior packs like "*comedy*".
    ytd_name_index = []
    try:
        ytd_dict = getattr(gfc, "YtdDict", None)
        if ytd_dict is not None:
            try:
                it = ytd_dict.GetEnumerator()
                while it.MoveNext():
                    kv = it.Current
                    k = int(getattr(kv, "Key")) & 0xFFFFFFFF
                    e = getattr(kv, "Value", None)
                    nm = ""
                    try:
                        nm = str(getattr(e, "NameLower", "") or "").lower()
                    except Exception:
                        nm = ""
                    if not nm:
                        try:
                            nm = str(getattr(e, "Name", "") or "").lower()
                        except Exception:
                            nm = ""
                    if nm:
                        ytd_name_index.append((k, nm))
            except Exception:
                # Fallback: try iterating keys/values if enumerator isn't exposed.
                vals = getattr(ytd_dict, "Values", None)
                if vals is not None:
                    for e in vals:
                        try:
                            k = int(getattr(e, "ShortNameHash")) & 0xFFFFFFFF
                        except Exception:
                            continue
                        try:
                            nm = str(getattr(e, "NameLower", "") or "").lower()
                        except Exception:
                            nm = ""
                        if not nm:
                            try:
                                nm = str(getattr(e, "Name", "") or "").lower()
                            except Exception:
                                nm = ""
                        if nm:
                            ytd_name_index.append((k, nm))
    except Exception:
        ytd_name_index = []

    def _tokenize_slug(slug: str):
        s = str(slug or "").strip().lower()
        if not s:
            return []
        parts = [p for p in re.split(r"[^a-z0-9]+", s) if p]
        # Drop very common/noisy tokens.
        drop = {
            "a", "b", "c", "d", "e", "n", "s", "lod",
            "v", "im", "os", "km", "tl", "rsn", "dc", "prop",
            "01", "02", "03", "04", "05", "06", "07", "08", "09",
        }
        toks = [p for p in parts if (p not in drop and len(p) >= 4)]
        toks.sort(key=lambda x: (-len(x), x))
        return toks[:6]

    # Extract loop.
    extracted = 0
    not_found = 0
    failed = 0

    def _pick_write_dir(entry_path: str) -> Path:
        if force_pack:
            d = packs_root / force_pack / "models_textures"
            d.mkdir(parents=True, exist_ok=True)
            return d
        if split_by_dlc:
            dlc = _infer_dlc_name_from_entry_path(entry_path)
            if dlc:
                d = packs_root / dlc / "models_textures"
                d.mkdir(parents=True, exist_ok=True)
                return d
        return models_textures_dir

    for w in wanted:
        h = int(w.tex_hash) & 0xFFFFFFFF
        # Skip if already present.
        hash_only_png = models_textures_dir / f"{h}.png"
        hash_only_dds = models_textures_dir / f"{h}.dds"
        slug_png = models_textures_dir / f"{h}_{w.slug}.png" if w.slug else None
        slug_dds = models_textures_dir / f"{h}_{w.slug}.dds" if w.slug else None
        if hash_only_png.exists() or hash_only_dds.exists() or (slug_png and slug_png.exists()) or (slug_dds and slug_dds.exists()):
            continue

        try:
            # Correct (CodeWalker/game-like) resolution:
            # - get the referencing archetype
            # - use archetype.TextureDict (TXD/YTD hash) as the owning dictionary
            # - look up texture hash in that YTD, then chase parent TXDs if needed
            arch_hash = int(w.sample_archetype_hash) & 0xFFFFFFFF
            arche = get_archetype_best_effort(gfc, int(arch_hash) & 0xFFFFFFFF, dll_manager=dm) if arch_hash != 0 else None

            txdhash = 0
            if arche is not None:
                try:
                    txdhash = _u32_from_metahash(getattr(arche, "TextureDict", None))
                except Exception:
                    txdhash = 0

            ytd = None
            # CodeWalker parity: apply HD-TXD mapping first, then try base.
            # (`TryGetHDTextureHash` is populated from `_manifest.ymf` HDTxdAssetBindings.)
            if txdhash != 0:
                try:
                    hd = int(gfc.TryGetHDTextureHash(int(txdhash) & 0xFFFFFFFF)) & 0xFFFFFFFF
                except Exception:
                    hd = int(txdhash) & 0xFFFFFFFF
                for cand in [hd, int(txdhash) & 0xFFFFFFFF]:
                    if not cand:
                        continue
                    if ytd is not None:
                        break
                    try:
                        ytd = gfc.GetYtd(int(cand) & 0xFFFFFFFF)
                    except Exception:
                        ytd = None

            # Fallback: global texture->YTD lookup (only covers some resident globals in CodeWalker).
            ytd_entry_path = ""
            if ytd is None:
                try:
                    ytd = gfc.TryGetTextureDictForTexture(h)
                except Exception:
                    ytd = None

            if ytd is None:
                # If no owning YTD is found, the drawable may still embed the texture dictionary.
                if arche is not None:
                    tex = _try_find_texture_in_drawable(gfc, arche, h)
                    if tex is not None:
                        # Decode and write below (shared path).
                        pass
                    else:
                        # Last resort: try to find the YTD by filename tokens derived from the texture name slug.
                        # Example: tl_v_comedy_stool -> v_21_v_comedy_txd.ytd contains "comedy".
                        tex = None
                        toks = _tokenize_slug(w.slug)
                        if toks and ytd_name_index:
                            # Find candidate YTDs by best token match.
                            scored = []
                            for (yh, nm) in ytd_name_index:
                                score = 0
                                for t in toks:
                                    if t in nm:
                                        score += len(t)
                                if score > 0:
                                    scored.append((score, yh))
                            scored.sort(key=lambda x: (-x[0], int(x[1])))
                            # Try the best matches first.
                            for _score, yh in scored[:120]:
                                try:
                                    y0 = gfc.GetYtd(int(yh) & 0xFFFFFFFF)
                                except Exception:
                                    y0 = None
                                if y0 is None:
                                    continue
                                if not _ensure_loaded(gfc, y0, max_loops=80):
                                    continue
                                td0 = getattr(y0, "TextureDict", None)
                                tex = _try_lookup_texture_in_texture_dict(td0, h)
                                if tex is not None:
                                    break
                        if tex is None:
                            not_found += 1
                            continue
                else:
                    not_found += 1
                    continue
            else:
                tex = None

            if ytd is not None:
                if not _ensure_loaded(gfc, ytd, max_loops=160):
                    failed += 1
                    continue

                td = getattr(ytd, "TextureDict", None)
                if td is None:
                    failed += 1
                    continue

                try:
                    ytd_entry_path = str(_get_gamefile_entry_path_or_namelower(ytd) or "")
                except Exception:
                    ytd_entry_path = ""

                tex = td.Lookup(h)
                if tex is None:
                    try:
                        # Use archetype txd if known; else use current ytd key hash.
                        if txdhash == 0:
                            txdhash = _u32_from_metahash(getattr(getattr(ytd, "Key", None), "Hash", 0))
                        if txdhash != 0:
                            # Prefer HD-mapped TXD for parent lookup when available.
                            try:
                                txdhash = int(gfc.TryGetHDTextureHash(int(txdhash) & 0xFFFFFFFF)) & 0xFFFFFFFF
                            except Exception:
                                txdhash = int(txdhash) & 0xFFFFFFFF
                            tex = gfc.TryFindTextureInParent(h, txdhash)
                    except Exception:
                        tex = None
                if tex is None and arche is not None:
                    # Some drawables carry embedded texture dictionaries that the archetype TXD doesn't contain.
                    tex = _try_find_texture_in_drawable(gfc, arche, h)
                if tex is None:
                    not_found += 1
                    continue

            # Write outputs (PNG when decodable, else DDS fallback for Gen9 BC7/BC6H).
            write_dir = _pick_write_dir(ytd_entry_path)
            if args.write_hash_only:
                ok, _ext = _write_texture_asset(dm, tex, write_dir / f"{h}.png", write_dir / f"{h}.dds")
                if not ok:
                    failed += 1
                    continue
            if args.write_hash_slug and w.slug:
                ok, _ext = _write_texture_asset(dm, tex, write_dir / f"{h}_{w.slug}.png", write_dir / f"{h}_{w.slug}.dds")
                if not ok:
                    failed += 1
                    continue
            extracted += 1

        except Exception:
            failed += 1
            continue

    if args.regen_index:
        # Regenerate base index (pack indices are generated by setup_assets.py when asset_packs.json exists).
        _regen_models_textures_index(models_textures_dir)

    print(
        f"Done. wanted={len(wanted)} extracted={extracted} not_found={not_found} failed={failed} "
        f"out={models_textures_dir}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



"""
Global YTD scan to eliminate remaining missing textures (offline repair).

This is the "last resort" when heuristics (archetype TXD, drawable dictionaries, filename token search)
still can't find some textures. It scans ALL YTDs known to CodeWalker (via GameFileCache.YtdDict),
and extracts only the textures we still need (from a dump).

Input: tex dump JSON from `debug_textures_near_coords.py`
Output: writes missing textures into `webgl_viewer/assets/models_textures/` and regenerates index.json.

Usage:
  python webgl-gta/webgl_viewer/tools/extract_missing_textures_global_scan.py \\
    --gta-path /data/webglgta/gta5 \\
    --selected-dlc patchday27ng \\
    --dump webgl-gta/webgl_viewer/tools/out/tex_dump_at_point_after_ytd_extract4.json \\
    --out-dir webgl-gta/webgl_viewer/assets/models_textures \\
    --max-ytd 0
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Dict, Optional, Set, Tuple

from PIL import Image

# Import repo modules without installation
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from gta5_modules.dll_manager import DllManager
from gta5_modules.cw_loaders import ensure_loaded as _ensure_loaded_shared
from gta5_modules.dlc_paths import infer_dlc_pack_from_entry_path as _infer_dlc_pack_from_entry_path
from gta5_modules.dlc_paths import get_gamefile_entry_path_and_dlc as _get_gamefile_entry_path_and_dlc


_MODEL_TEX_RE = re.compile(r"^models_textures/(?P<hash>\d+)(?:_(?P<slug>[^/]+))?\.png$", re.IGNORECASE)


def _infer_dlc_name_from_rpf_entry_path(p: str) -> str:
    """
    Best-effort infer DLC pack name from a CodeWalker RpfEntry.Path / NameLower.

    Typical patterns:
      - update\\x64\\dlcpacks\\mptuner\\dlc.rpf\\...
      - update/x64/dlcpacks/mptuner/dlc.rpf/...
    """
    # Wrapper preserved for backwards-compat within this script.
    return _infer_dlc_pack_from_entry_path(p)


def _pixels_to_image_rgba(pixels: bytes, width: int, height: int) -> Image.Image:
    n = len(pixels or b"")
    exp_rgba = width * height * 4
    exp_rgb = width * height * 3
    if n == exp_rgba:
        return Image.frombytes("RGBA", (width, height), pixels)
    if n == exp_rgb:
        return Image.frombytes("RGB", (width, height), pixels).convert("RGBA")
    if n > exp_rgba:
        return Image.frombytes("RGBA", (width, height), pixels[:exp_rgba])
    raise ValueError(f"unexpected pixel buffer size={n} (expected {exp_rgb} or {exp_rgba})")


def _regen_models_textures_index(models_textures_dir: Path) -> None:
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
            # Legacy meaning: "hash-only PNG exists".
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


def _try_get_dds_bytes(ddsio, tex) -> bytes | None:
    if ddsio is None or tex is None:
        return None
    try:
        if hasattr(ddsio, "GetDDSFile"):
            dds = ddsio.GetDDSFile(tex)
            if dds:
                b = bytes(dds)
                return b if b else None
    except Exception:
        return None
    return None


def _ensure_loaded(gfc, gf, max_loops: int = 200) -> bool:
    # Wrapper preserved for script-local callers.
    return bool(_ensure_loaded_shared(gfc, gf, max_loops=int(max_loops or 0)))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gta-path", required=True)
    ap.add_argument(
        "--selected-dlc",
        default="all",
        help=(
            "CodeWalker DLC level. Use 'all' to load all dlcs in dlclist.xml (note: CodeWalker intentionally skips "
            "patchday27ng unless explicitly selected)."
        ),
    )
    ap.add_argument(
        "--also-scan-dlc",
        action="append",
        default=["patchday27ng"],
        help=(
            "Optional additional DLC levels to scan after the first pass (for CodeWalker special-cases like patchday27ng). "
            "Can be provided multiple times."
        ),
    )
    ap.add_argument("--dump", required=True)
    ap.add_argument(
        "--out-dir",
        default="",
        help=(
            "Default output dir. If --split-by-dlc is enabled, this is used as fallback when DLC name can't be inferred. "
            "Defaults to webgl_viewer/assets/models_textures next to this script."
        ),
    )
    ap.add_argument("--assets-dir", default="", help="Viewer assets dir (defaults to webgl_viewer/assets next to this script).")
    ap.add_argument("--split-by-dlc", action="store_true", help="Write textures into assets/packs/<dlcname>/models_textures when possible.")
    ap.add_argument("--pack-root-prefix", default="packs", help="Pack root dir under assets/ (default: packs).")
    ap.add_argument("--force-pack", default="", help="Force writing all outputs into a single pack id (e.g. patchday27ng).")
    ap.add_argument(
        "--texture-index",
        default="",
        help=(
            "Optional JSON index produced by build_texture_hash_index.py. "
            "If provided, we will load only the YTDs that contain the missing hashes (targeted), "
            "falling back to scanning remaining hashes if any are absent from the index."
        ),
    )
    ap.add_argument("--max-ytd", type=int, default=0, help="0 = no cap; otherwise stop after scanning N ytds")
    ap.add_argument("--ytd-load-loops", type=int, default=400, help="Max ContentThreadProc loops per YTD load attempt.")
    ap.add_argument("--ytd-load-retries", type=int, default=2, help="Retries per YTD if it doesn't load quickly.")
    ap.add_argument("--regen-index", action="store_true", default=True)
    args = ap.parse_args()

    dump = json.loads(Path(args.dump).read_text(encoding="utf-8", errors="ignore"))
    # Accept multiple input schemas:
    # 1) debug_textures_near_coords.py dump: { textures: [ { requestedRel, reason, ... }, ... ] }
    # 2) build_missing_textures_remaining_from_manifests.py output: [ { requestedRel, useCount, refs }, ... ]
    # 3) probe_model_textures_like_viewer.py output: { missing: [ { hash, refCount, sample }, ... ] }
    if isinstance(dump, list):
        rows = dump
    else:
        rows = dump.get("textures")
        if not isinstance(rows, list):
            missing = dump.get("missing") if isinstance(dump, dict) else None
            if isinstance(missing, list):
                rows = []
                for r in missing:
                    if not isinstance(r, dict):
                        continue
                    hs = str(r.get("hash") or "").strip()
                    if not hs.isdigit():
                        continue
                    h = int(hs, 10) & 0xFFFFFFFF
                    sample = str(r.get("sample") or "").strip().replace("\\", "/")
                    sample_rel = sample
                    if sample_rel.lower().startswith("assets/"):
                        sample_rel = sample_rel[len("assets/") :]
                    m = _MODEL_TEX_RE.match(sample_rel)
                    slug = str(m.group("slug") or "") if m else ""
                    requested_rel = f"models_textures/{h}_{slug}.png" if slug else f"models_textures/{h}.png"
                    rows.append({"requestedRel": requested_rel, "reason": "missing"})
            else:
                raise SystemExit("dump has no textures[] and is not a supported missing-textures format")

    wanted: Dict[int, str] = {}  # texhash -> slug (best-effort)
    for r in rows:
        if not isinstance(r, dict):
            continue
        if str(r.get("reason") or "") == "ok":
            continue
        rel = str(r.get("requestedRel") or "").strip()
        m = _MODEL_TEX_RE.match(rel)
        if not m:
            continue
        h = int(m.group("hash")) & 0xFFFFFFFF
        slug = str(m.group("slug") or "")
        wanted[h] = slug

    if not wanted:
        print("No missing textures in dump.")
        return 0

    viewer_root = Path(__file__).resolve().parents[1]
    assets_dir = Path(args.assets_dir) if args.assets_dir else (viewer_root / "assets")
    out_dir = Path(args.out_dir) if args.out_dir else (assets_dir / "models_textures")
    out_dir.mkdir(parents=True, exist_ok=True)
    packs_root = assets_dir / str(args.pack_root_prefix or "packs").strip().strip("/").strip("\\")
    force_pack = str(args.force_pack or "").strip().lower()
    split_by_dlc = bool(args.split_by_dlc)

    dm = DllManager(str(args.gta_path))
    if not getattr(dm, "initialized", False):
        raise SystemExit("DllManager failed to init.")

    def _resolve_selected_dlc(s: str) -> str:
        t = str(s or "").strip()
        if not t:
            return ""
        tl = t.lower()
        if tl in ("all", "*", "__all__", "latest"):
            # Important: CodeWalker breaks its DLC load loop when dlcname == SelectedDlc.
            # If we set SelectedDlc to a value that will never match, CodeWalker will load all DLCs
            # listed in dlclist.xml (except patchday27ng, which CodeWalker skips unless explicitly selected).
            return "__all__"
        return t

    sel0 = _resolve_selected_dlc(str(args.selected_dlc))
    dm.init_game_file_cache(selected_dlc=sel0, load_vehicles=False, load_peds=False, load_audio=False)
    gfc = dm.get_game_cache()
    if gfc is None or not getattr(gfc, "IsInited", False):
        raise SystemExit("GameFileCache not inited.")

    # Speed up loading: allow more work per ContentThreadProc call.
    try:
        gfc.MaxItemsPerLoop = 25
    except Exception:
        pass

    def _set_dlc_level(level: str) -> None:
        lvl = _resolve_selected_dlc(level)
        # Fast path: switch without full Init() rerun.
        try:
            if hasattr(gfc, "SetDlcLevel"):
                gfc.SetDlcLevel(str(lvl), True)
                return
        except Exception:
            pass
        # Fallback: re-init cache (slow).
        dm.init_game_file_cache(selected_dlc=str(lvl), load_vehicles=False, load_peds=False, load_audio=False)

    def _get_ytd_dict():
        yd = getattr(gfc, "YtdDict", None)
        if yd is None:
            raise SystemExit("GameFileCache.YtdDict not available")
        return yd

    ddsio = getattr(dm, "DDSIO", None)
    if ddsio is None or not hasattr(ddsio, "GetPixels"):
        raise SystemExit("DllManager.DDSIO missing GetPixels")

    need: Set[int] = set(wanted.keys())
    scanned = 0
    extracted = 0
    failed = 0
    ytd_load_failed = 0

    # Optional targeted mode: use a prebuilt hash->ytd mapping to avoid scanning all YTDs.
    # This turns the common case into: O(#missing hashes + #ytds containing them).
    tex_index = {}
    if args.texture_index:
        try:
            p = Path(str(args.texture_index))
            if p.exists():
                obj = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
                if isinstance(obj, dict) and isinstance(obj.get("entries"), dict):
                    tex_index = obj.get("entries") or {}
        except Exception:
            tex_index = {}

    def _extract_from_ytd(ytd, td, found_hashes: list[int], *, dlc_hint: str = "") -> Tuple[int, int]:
        nonlocal extracted, failed
        local_extracted = 0
        local_failed = 0
        dlc_hint_norm = str(dlc_hint or "").strip().lower()
        for texhash in found_hashes:
            try:
                tex = td.Lookup(int(texhash) & 0xFFFFFFFF)
                if tex is None:
                    need.discard(texhash)
                    continue
                pixels = ddsio.GetPixels(tex, 0)
                img = None
                if pixels:
                    img = _pixels_to_image_rgba(bytes(pixels), int(getattr(tex, "Width")), int(getattr(tex, "Height")))

                # Prefer DLC hint from the texture-index in targeted mode (more reliable than ytd.RpfFileEntry on some bindings).
                if force_pack:
                    write_dir = packs_root / force_pack / "models_textures"
                    write_dir.mkdir(parents=True, exist_ok=True)
                elif split_by_dlc and dlc_hint_norm:
                    write_dir = packs_root / dlc_hint_norm / "models_textures"
                    write_dir.mkdir(parents=True, exist_ok=True)
                else:
                    write_dir = _pick_out_dir_for_ytd(ytd)

                # Write both hash-only and hash+slug if slug known.
                # Prefer PNG when decodable; else write DDS fallback (Gen9 BC7/BC6H, etc).
                if img is not None:
                    out_hash = write_dir / f"{texhash}.png"
                    if not out_hash.exists():
                        img.save(out_hash)
                    slug = wanted.get(texhash, "")
                    if slug:
                        out_slug = write_dir / f"{texhash}_{slug}.png"
                        if not out_slug.exists():
                            img.save(out_slug)
                else:
                    dds = _try_get_dds_bytes(ddsio, tex)
                    if not dds:
                        local_failed += 1
                        failed += 1
                        need.discard(texhash)
                        continue
                    out_hash = write_dir / f"{texhash}.dds"
                    if not out_hash.exists():
                        out_hash.write_bytes(dds)
                    slug = wanted.get(texhash, "")
                    if slug:
                        out_slug = write_dir / f"{texhash}_{slug}.dds"
                        if not out_slug.exists():
                            out_slug.write_bytes(dds)
                local_extracted += 1
                extracted += 1
            except Exception:
                local_failed += 1
                failed += 1
            finally:
                need.discard(texhash)
        return local_extracted, local_failed

    def _targeted_pass_from_index(label: str) -> Tuple[int, int, int]:
        """
        Use the texture index to load only referenced YTDs.
        Returns: (ytd_loaded, extracted, failed)
        """
        nonlocal scanned, ytd_load_failed
        if not tex_index or not need:
            return 0, 0, 0

        # Group missing hashes by ytdHash; keep a DLC hint per YTD if present.
        by_ytd: Dict[int, list[int]] = {}
        dlc_by_ytd: Dict[int, str] = {}
        for h in list(need):
            ent = tex_index.get(str(int(h) & 0xFFFFFFFF))
            if not isinstance(ent, dict):
                continue
            try:
                ytd_hash = int(ent.get("ytdHashU32")) & 0xFFFFFFFF
            except Exception:
                continue
            by_ytd.setdefault(ytd_hash, []).append(int(h) & 0xFFFFFFFF)
            try:
                dlc = str(ent.get("dlc") or "").strip().lower()
                if dlc and ytd_hash not in dlc_by_ytd:
                    dlc_by_ytd[ytd_hash] = dlc
            except Exception:
                pass

        ytd_loaded = 0
        local_ex = 0
        local_fail = 0
        for ytd_hash, hashes in by_ytd.items():
            if not need:
                break
            try:
                ytd = gfc.GetYtd(int(ytd_hash) & 0xFFFFFFFF)
            except Exception:
                continue
            if ytd is None:
                continue
            try:
                lf = getattr(gfc, "LoadFile", None)
                if callable(lf):
                    lf(ytd)
            except Exception:
                pass
            ok = False
            for _ in range(max(1, int(args.ytd_load_retries))):
                if _ensure_loaded(gfc, ytd, max_loops=int(args.ytd_load_loops)):
                    ok = True
                    break
            if not ok:
                ytd_load_failed += 1
                continue
            ytd_loaded += 1
            scanned += 1  # treat as "touched"
            td = getattr(ytd, "TextureDict", None)
            if td is None:
                continue
            exi, fai = _extract_from_ytd(
                ytd,
                td,
                hashes,
                dlc_hint=str(dlc_by_ytd.get(int(ytd_hash) & 0xFFFFFFFF, "")),
            )
            local_ex += exi
            local_fail += fai

        if label:
            print(
                f"pass={label} mode=texture_index ytdLoaded={ytd_loaded} extracted={local_ex} failed={local_fail} "
                f"remaining={len(need)}"
            )
        return ytd_loaded, local_ex, local_fail

    def _pick_out_dir_for_ytd(ytd) -> Path:
        if force_pack:
            d = packs_root / force_pack / "models_textures"
            d.mkdir(parents=True, exist_ok=True)
            return d
        if split_by_dlc:
            try:
                _ep, dlc = _get_gamefile_entry_path_and_dlc(ytd)
                if dlc:
                    d = packs_root / dlc / "models_textures"
                    d.mkdir(parents=True, exist_ok=True)
                    return d
            except Exception:
                pass
        return out_dir

    def _scan_one_pass(label: str) -> Tuple[int, int, int]:
        nonlocal scanned, extracted, failed, ytd_load_failed
        ytd_dict = _get_ytd_dict()
        # IMPORTANT: iterating KeyValuePair via GetEnumerator().Current can crash pythonnet on some builds
        # due to string conversion issues (illegal byte sequences) coming from some entry metadata.
        # We only need the keys, so iterate Keys to avoid pulling Value objects into Python.
        keys = getattr(ytd_dict, "Keys", None)
        it = keys.GetEnumerator() if keys is not None else ytd_dict.Keys.GetEnumerator()
        local_scanned = 0
        local_extracted = 0
        local_failed = 0
        while it.MoveNext():
            try:
                k = it.Current
                ytd_hash = int(k) & 0xFFFFFFFF
            except Exception:
                continue
            if args.max_ytd and local_scanned >= int(args.max_ytd):
                break
            local_scanned += 1
            scanned += 1

            # If we already found everything, stop.
            if not need:
                break

            try:
                ytd = gfc.GetYtd(ytd_hash)
            except Exception:
                continue
            if ytd is None:
                continue
            # Encourage direct load if the API exists (helps when the content queue is long).
            # Some pythonnet bindings can surface LoadFile as a non-bound method; treat failures as non-fatal.
            try:
                lf = getattr(gfc, "LoadFile", None)
                if callable(lf):
                    lf(ytd)
            except Exception:
                pass
            ok = False
            for _ in range(max(1, int(args.ytd_load_retries))):
                if _ensure_loaded(gfc, ytd, max_loops=int(args.ytd_load_loops)):
                    ok = True
                    break
            if not ok:
                ytd_load_failed += 1
                continue

            td = getattr(ytd, "TextureDict", None)
            if td is None:
                continue
            # Use TextureNameHashes list as a fast membership filter when available,
            # but fall back to direct Lookup for the remaining-needed set when it's missing/empty.
            try:
                nh = getattr(td, "TextureNameHashes", None)
                items = getattr(nh, "data_items", None) if nh is not None else None
            except Exception:
                items = None
            found_here = []
            if items:
                for hh in items:
                    try:
                        u = int(hh) & 0xFFFFFFFF
                    except Exception:
                        continue
                    if u in need:
                        found_here.append(u)
                # Some YTDs appear to have incomplete TextureNameHashes lists on some builds.
                # If nothing matched, do a small direct-lookup sample against the remaining-needed set.
                if not found_here and need:
                    sample_n = 48
                    for u in list(need)[:sample_n]:
                        try:
                            tex = td.Lookup(int(u) & 0xFFFFFFFF)
                        except Exception:
                            tex = None
                        if tex is not None:
                            found_here.append(int(u) & 0xFFFFFFFF)
            else:
                # Fallback path: try direct lookup for remaining-needed hashes.
                # This is slower but the remaining set is small and it catches YTDs where TextureNameHashes isn't populated.
                for u in list(need):
                    try:
                        tex = td.Lookup(int(u) & 0xFFFFFFFF)
                    except Exception:
                        tex = None
                    if tex is not None:
                        found_here.append(int(u) & 0xFFFFFFFF)
            if not found_here:
                continue

            for texhash in found_here:
                try:
                    tex = td.Lookup(int(texhash) & 0xFFFFFFFF)
                    if tex is None:
                        need.discard(texhash)
                        continue
                    pixels = ddsio.GetPixels(tex, 0)
                    img = None
                    if pixels:
                        img = _pixels_to_image_rgba(bytes(pixels), int(getattr(tex, "Width")), int(getattr(tex, "Height")))

                    write_dir = _pick_out_dir_for_ytd(ytd)

                    # Write both hash-only and hash+slug if slug known.
                    if img is not None:
                        out_hash = write_dir / f"{texhash}.png"
                        if not out_hash.exists():
                            img.save(out_hash)
                        slug = wanted.get(texhash, "")
                        if slug:
                            out_slug = write_dir / f"{texhash}_{slug}.png"
                            if not out_slug.exists():
                                img.save(out_slug)
                    else:
                        dds = _try_get_dds_bytes(ddsio, tex)
                        if not dds:
                            local_failed += 1
                            failed += 1
                            need.discard(texhash)
                            continue
                        out_hash = write_dir / f"{texhash}.dds"
                        if not out_hash.exists():
                            out_hash.write_bytes(dds)
                        slug = wanted.get(texhash, "")
                        if slug:
                            out_slug = write_dir / f"{texhash}_{slug}.dds"
                            if not out_slug.exists():
                                out_slug.write_bytes(dds)
                    local_extracted += 1
                    extracted += 1
                except Exception:
                    local_failed += 1
                    failed += 1
                finally:
                    need.discard(texhash)
        if label:
            print(
                f"pass={label} scannedYtd={local_scanned} extracted={local_extracted} failed={local_failed} "
                f"ytdLoadFailed={ytd_load_failed} remaining={len(need)}"
            )
        return local_scanned, local_extracted, local_failed

    # Pass 1: targeted via index (if provided), then scan remainder.
    _targeted_pass_from_index(str(args.selected_dlc or ""))
    _scan_one_pass(str(args.selected_dlc or ""))

    # Optional extra passes (useful for CodeWalker DLC special cases like patchday27ng).
    for extra in list(args.also_scan_dlc or []):
        if not need:
            break
        try:
            _set_dlc_level(str(extra))
        except Exception:
            pass
        _targeted_pass_from_index(str(extra))
        _scan_one_pass(str(extra))

    if args.regen_index:
        _regen_models_textures_index(out_dir)

    print(f"scan done: scannedYtd={scanned} extracted={extracted} failed={failed} remaining={len(need)} out={out_dir}")
    if need:
        # Print a few remaining hashes for follow-up.
        rem = sorted(list(need))[:30]
        print("remaining hashes (first 30):", rem)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



"""
Build a persistent "texture hash -> containing YTD" index using CodeWalker.

Why:
- When you only know a texture hash (joaat), there is no way to know which YTD contains it
  without either scanning all YTDs or having an index.
- `extract_missing_textures_global_scan.py` is the brute-force "scan all YTDs" last resort.
- This tool builds a JSON index once, so future runs can be targeted: load only the YTDs that
  actually contain the missing hashes.

Output schema (v1):
{
  "schema": "webglgta-texture-hash-index-v1",
  "generatedAtUnix": 1234567890,
  "gtaPath": "/abs/path",
  "selectedDlc": "all",
  "alsoScanDlc": ["patchday27ng"],
  "entries": {
    "<texHashU32>": {
      "ytdHashU32": 123,
      "ytdEntryPath": "update\\x64\\dlcpacks\\...\\foo.ytd",
      "dlc": "mptuner"
    },
    ...
  }
}
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Dict, Optional, Set, Any, Iterable, Tuple

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
    # Wrapper preserved for backwards-compat within this script.
    return _infer_dlc_pack_from_entry_path(p)


def _ensure_loaded(gfc, gf, max_loops: int = 600) -> bool:
    # Wrapper preserved for script-local callers.
    return bool(_ensure_loaded_shared(gfc, gf, max_loops=int(max_loops or 0)))


def _load_existing_texture_hashes_from_assets(assets_dir: Path) -> Set[int]:
    """
    Load exported texture hashes already present in assets/models_textures/index.json and pack indices.
    This is much faster than checking the filesystem for each hash individually.
    """
    out: Set[int] = set()

    def _add_index(p: Path) -> None:
        if not p.exists():
            return
        try:
            obj = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
        except Exception:
            return
        by_hash = obj.get("byHash") if isinstance(obj, dict) else None
        if not isinstance(by_hash, dict):
            return
        for k in by_hash.keys():
            try:
                out.add(int(str(k), 10) & 0xFFFFFFFF)
            except Exception:
                continue

    # Base
    _add_index(assets_dir / "models_textures" / "index.json")

    # Packs (best-effort): read asset_packs.json and add any pack indices that exist.
    try:
        packs_cfg = assets_dir / "asset_packs.json"
        if packs_cfg.exists():
            cfg = json.loads(packs_cfg.read_text(encoding="utf-8", errors="ignore"))
            packs = cfg.get("packs") if isinstance(cfg, dict) else None
            if isinstance(packs, list):
                for p in packs:
                    if not isinstance(p, dict):
                        continue
                    pid = str(p.get("id") or "").strip()
                    if not pid:
                        continue
                    _add_index(assets_dir / "packs" / pid / "models_textures" / "index.json")
    except Exception:
        pass

    return out


def _iter_missing_rows(obj: Any) -> Iterable[Tuple[int, str]]:
    """
    Yield (hash_u32, slug) from supported "missing texture" schemas:
    - debug dump: {textures:[{requestedRel, reason,...},...]}
    - build_missing_textures_remaining_from_manifests.py: [{requestedRel,useCount,refs},...]
    - probe missing: {missing:[{hash, refCount, sample},...]}
    """
    if isinstance(obj, list):
        rows = obj
    elif isinstance(obj, dict):
        rows = obj.get("textures")
        if not isinstance(rows, list):
            missing = obj.get("missing")
            if isinstance(missing, list):
                for r in missing:
                    if not isinstance(r, dict):
                        continue
                    hs = str(r.get("hash") or "").strip()
                    if not hs.isdigit():
                        continue
                    h = int(hs, 10) & 0xFFFFFFFF
                    sample = str(r.get("sample") or "").strip().replace("\\", "/")
                    sample_rel = sample[len("assets/") :] if sample.lower().startswith("assets/") else sample
                    m = _MODEL_TEX_RE.match(sample_rel)
                    slug = str(m.group("slug") or "") if m else ""
                    yield h, slug
                return
            return
    else:
        return

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
        yield h, slug


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gta-path", required=True)
    ap.add_argument("--selected-dlc", default="all")
    ap.add_argument(
        "--also-scan-dlc",
        action="append",
        default=["patchday27ng"],
        help="Additional DLC levels to scan after the main pass (default: patchday27ng). Can be provided multiple times.",
    )
    ap.add_argument("--out", required=True, help="Output JSON path")
    ap.add_argument(
        "--need",
        default="",
        help="Optional: JSON file describing missing textures; if provided we only index those hashes and stop early when complete.",
    )
    ap.add_argument(
        "--assets-dir",
        default="",
        help="Optional: viewer assets dir; when provided with --need, skip hashes already present in assets/models_textures (and pack indices).",
    )
    ap.add_argument("--max-ytd", type=int, default=0, help="0 = no cap; otherwise stop after N YTDs")
    ap.add_argument("--ytd-load-loops", type=int, default=600, help="Max ContentThreadProc loops per YTD load attempt")
    ap.add_argument("--max-items-per-loop", type=int, default=50, help="GameFileCache.MaxItemsPerLoop")
    ap.add_argument(
        "--checkpoint-every",
        type=int,
        default=250,
        help="Write a partial index to disk every N scanned YTDs (helps survive Mono/native crashes).",
    )
    args = ap.parse_args()

    gta_path = str(args.gta_path)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    dm = DllManager(gta_path)
    if not getattr(dm, "initialized", False):
        raise SystemExit("DllManager failed to init.")

    # Match our other tools: "all" means load all DLCs by using a sentinel SelectedDlc that never matches.
    sel = str(args.selected_dlc or "").strip()
    if sel.lower() in ("all", "*", "__all__", "latest"):
        sel = "__all__"

    dm.init_game_file_cache(selected_dlc=sel, load_vehicles=False, load_peds=False, load_audio=False)
    gfc = dm.get_game_cache()
    if gfc is None or not getattr(gfc, "IsInited", False):
        raise SystemExit("GameFileCache not inited.")

    try:
        gfc.MaxItemsPerLoop = int(args.max_items_per_loop or 50)
    except Exception:
        pass

    def _set_dlc_level(level: str) -> None:
        lvl = str(level or "").strip()
        if lvl.lower() in ("all", "*", "__all__", "latest"):
            lvl = "__all__"
        try:
            if hasattr(gfc, "SetDlcLevel"):
                gfc.SetDlcLevel(str(lvl), True)
                return
        except Exception:
            pass
        dm.init_game_file_cache(selected_dlc=str(lvl), load_vehicles=False, load_peds=False, load_audio=False)

    need_hashes: Optional[Set[int]] = None
    wanted_slug: Dict[int, str] = {}
    skipped_existing = 0
    if args.need:
        p = Path(str(args.need))
        if not p.exists():
            raise SystemExit(f"--need not found: {p}")
        obj = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
        need_hashes = set()
        for h, slug in _iter_missing_rows(obj):
            need_hashes.add(int(h) & 0xFFFFFFFF)
            if slug:
                wanted_slug[int(h) & 0xFFFFFFFF] = str(slug)
        if args.assets_dir and need_hashes:
            existing = _load_existing_texture_hashes_from_assets(Path(str(args.assets_dir)))
            before = len(need_hashes)
            need_hashes = {h for h in need_hashes if h not in existing}
            skipped_existing = max(0, before - len(need_hashes))
        print(f"[texture-index] need_hashes={len(need_hashes)} skipped_existing={skipped_existing}")

    def _get_ytd_hash_u32(ytd) -> int:
        """
        Best-effort stable YTD identifier for indexing:
        - Prefer ytd.Key.Hash when available
        - Fall back to ytd.ShortNameHash when Key is missing (pythonnet variations)
        """
        try:
            key = getattr(ytd, "Key", None)
            h = getattr(key, "Hash", None) if key is not None else None
            if h is not None:
                return int(h) & 0xFFFFFFFF
        except Exception:
            pass
        try:
            h2 = getattr(ytd, "ShortNameHash", None)
            if h2 is not None:
                return int(h2) & 0xFFFFFFFF
        except Exception:
            pass
        return 0

    def _get_ytd_entry_path_and_dlc(ytd) -> Tuple[str, str]:
        # Wrapper preserved for script-local callers.
        try:
            ep, dlc = _get_gamefile_entry_path_and_dlc(ytd)
            return str(ep or ""), str(dlc or "")
        except Exception:
            return "", ""

    # Fast path: if we were given a missing list, try CodeWalker's global texture lookup table
    # instead of scanning every YTD. This is *much* faster and more reliable when
    # TextureNameHashes isn't populated in pythonnet.
    if need_hashes is not None and need_hashes:
        entries_fast: Dict[str, dict] = {}
        found_fast = 0
        try:
            lookup = getattr(gfc, "TryGetTextureDictForTexture", None)
        except Exception:
            lookup = None
        if callable(lookup):
            for h in list(need_hashes):
                try:
                    ytd = lookup(int(h) & 0xFFFFFFFF)
                except Exception:
                    ytd = None
                if ytd is None:
                    continue
                ytd_hash = _get_ytd_hash_u32(ytd)
                ep, dlc = _get_ytd_entry_path_and_dlc(ytd)
                if not ytd_hash and not ep:
                    continue
                key = str(int(h) & 0xFFFFFFFF)
                entries_fast[key] = {
                    "ytdHashU32": int(ytd_hash),
                    "ytdEntryPath": ep,
                    "dlc": dlc,
                    "pass": "TryGetTextureDictForTexture",
                }
                found_fast += 1
                need_hashes.discard(int(h) & 0xFFFFFFFF)
            print(
                f"[texture-index] fast_lookup found={found_fast} remaining_after_fast={len(need_hashes)}"
            )
        else:
            print("[texture-index] fast_lookup unavailable (no TryGetTextureDictForTexture on GameFileCache)")

    def _build_one_pass(label: str, entries: Dict[str, dict]) -> int:
        ytd_dict = getattr(gfc, "YtdDict", None)
        if ytd_dict is None:
            raise SystemExit("GameFileCache.YtdDict not available")
        keys = getattr(ytd_dict, "Keys", None)
        it = keys.GetEnumerator() if keys is not None else ytd_dict.Keys.GetEnumerator()
        scanned = 0
        while it.MoveNext():
            if need_hashes is not None and not need_hashes:
                break
            try:
                k = it.Current
                ytd_hash = int(k) & 0xFFFFFFFF
            except Exception:
                continue
            if args.max_ytd and scanned >= int(args.max_ytd):
                break
            scanned += 1
            # Periodic checkpoint (best-effort; protects long scans from native crashes).
            try:
                ce = int(args.checkpoint_every or 0)
            except Exception:
                ce = 0
            if ce > 0 and (scanned % ce) == 0:
                try:
                    payload_ck = {
                        "schema": "webglgta-texture-hash-index-v1",
                        "generatedAtUnix": int(time.time()),
                        "gtaPath": str(Path(gta_path).resolve()),
                        "selectedDlc": str(args.selected_dlc),
                        "alsoScanDlc": list(args.also_scan_dlc or []),
                        "ytdScannedFirstPass": None,
                        "needFile": str(args.need or ""),
                        "assetsDir": str(args.assets_dir or ""),
                        "skippedExisting": int(skipped_existing),
                        "remainingNeedAfterBuild": (len(need_hashes) if isinstance(need_hashes, set) else None),
                        "entries": entries,
                        "checkpoint": {"pass": str(label or ""), "scannedYtd": int(scanned)},
                    }
                    tmp = out_path.with_suffix(out_path.suffix + ".partial.tmp")
                    dst = out_path.with_suffix(out_path.suffix + ".partial.json")
                    tmp.write_text(json.dumps(payload_ck, indent=2, sort_keys=False), encoding="utf-8")
                    tmp.replace(dst)
                    print(f"[texture-index] checkpoint: {dst} entries={len(entries)} pass={label} scanned={scanned}")
                except Exception:
                    pass
            try:
                ytd = gfc.GetYtd(ytd_hash)
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
            if not _ensure_loaded(gfc, ytd, max_loops=int(args.ytd_load_loops or 600)):
                continue

            td = getattr(ytd, "TextureDict", None)
            if td is None:
                continue

            # Prefer TextureNameHashes list, but fall back to direct Lookup when missing.
            try:
                nh = getattr(td, "TextureNameHashes", None)
                items = getattr(nh, "data_items", None) if nh is not None else None
            except Exception:
                items = None

            ep, dlc = _get_ytd_entry_path_and_dlc(ytd)

            found_here: Set[int] = set()
            if items:
                for hh in items:
                    try:
                        texhash = int(hh) & 0xFFFFFFFF
                    except Exception:
                        continue
                    if need_hashes is not None and texhash not in need_hashes:
                        continue
                    found_here.add(texhash)
            elif need_hashes is not None and need_hashes:
                # Fallback: check direct membership for remaining-needed hashes.
                for u in list(need_hashes):
                    try:
                        tex = td.Lookup(int(u) & 0xFFFFFFFF)
                    except Exception:
                        tex = None
                    if tex is not None:
                        found_here.add(int(u) & 0xFFFFFFFF)

            if not found_here:
                continue

            for texhash in found_here:
                key = str(int(texhash) & 0xFFFFFFFF)
                if key in entries:
                    continue
                entries[key] = {
                    "ytdHashU32": int(ytd_hash),
                    "ytdEntryPath": ep,
                    "dlc": dlc,
                    "pass": str(label or ""),
                }
                if need_hashes is not None:
                    need_hashes.discard(int(texhash) & 0xFFFFFFFF)
        return scanned

    entries: Dict[str, dict] = {}
    # Seed entries with anything we found via the fast lookup.
    if need_hashes is not None:
        try:
            # entries_fast is only defined in that branch; use locals() to avoid type complaints.
            ef = locals().get("entries_fast")
            if isinstance(ef, dict) and ef:
                entries.update(ef)
        except Exception:
            pass
    scanned0 = _build_one_pass(str(args.selected_dlc or ""), entries)
    for extra in list(args.also_scan_dlc or []):
        try:
            _set_dlc_level(str(extra))
        except Exception:
            pass
        _build_one_pass(str(extra), entries)

    payload = {
        "schema": "webglgta-texture-hash-index-v1",
        "generatedAtUnix": int(time.time()),
        "gtaPath": str(Path(gta_path).resolve()),
        "selectedDlc": str(args.selected_dlc),
        "alsoScanDlc": list(args.also_scan_dlc or []),
        "ytdScannedFirstPass": int(scanned0),
        "needFile": str(args.need or ""),
        "assetsDir": str(args.assets_dir or ""),
        "skippedExisting": int(skipped_existing),
        "remainingNeedAfterBuild": (len(need_hashes) if isinstance(need_hashes, set) else None),
        "entries": entries,
    }
    out_path.write_text(json.dumps(payload, indent=2, sort_keys=False), encoding="utf-8")
    print(f"[texture-index] wrote {out_path} entries={len(entries)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



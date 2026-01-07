"""
Extract missing model textures from particle YPT texture dictionaries (offline repair).

Why this exists:
- CodeWalker can load textures from sources other than YTDs, including:
  - embedded drawable shader texture objects (handled by extract_missing_textures_from_drawables.py)
  - particle effect texture dictionaries stored inside .ypt resources:
      ParticleEffectsList.TextureDictionary
- A global YTD scan will never find these hashes if they are only present in YPT texture dicts.

Input:
- Any of the "missing textures" JSON shapes we already use elsewhere:
  1) debug_textures_near_coords.py dump: { textures: [ { requestedRel, reason, ... }, ... ] }
  2) missing-only list: [ { requestedRel, useCount, refs }, ... ]
  3) probe_model_textures_like_viewer.py output: { missing: [ { hash, sample }, ... ] }

Output:
- Writes extracted PNGs into:
  - assets/models_textures/ (default), OR
  - assets/packs/<dlcname>/models_textures when --split-by-dlc and the YPT entry path indicates a dlcpack.
- Optionally regenerates assets/models_textures/index.json (or pack-local index when writing into packs).

Usage:
  python3 webgl-gta/webgl_viewer/tools/extract_missing_textures_from_particles.py \
    --gta-path /data/webglgta/gta5 \
    --assets-dir /data/webglgta/webgl-gta/webgl_viewer/assets \
    --selected-dlc all \
    --also-scan-dlc patchday27ng \
    --missing webgl-gta/webgl_viewer/tools/out/missing_textures_remaining.json \
    --regen-index
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Dict, Iterable, Optional, Set, Tuple

from PIL import Image


_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from gta5_modules.dll_manager import DllManager  # noqa: E402


_MODEL_TEX_RE = re.compile(r"^models_textures/(?P<hash>\d+)(?:_(?P<slug>[^/]+))?\.png$", re.IGNORECASE)


def _infer_dlc_name_from_path(p: str) -> str:
    s = str(p or "").strip().lower().replace("/", "\\")
    m = re.search(r"\\dlcpacks\\([^\\]+)\\", s)
    return str(m.group(1) or "").strip().lower() if m else ""


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


def _try_get_dds_bytes(dm: DllManager, tex) -> bytes | None:
    if tex is None:
        return None
    try:
        ddsio = getattr(dm, "DDSIO", None)
        if ddsio is not None and hasattr(ddsio, "GetDDSFile"):
            dds = ddsio.GetDDSFile(tex)
            if dds:
                b = bytes(dds)
                return b if b else None
    except Exception:
        return None
    return None


def _ensure_loaded(gfc, gf, max_loops: int = 200) -> bool:
    if gf is None:
        return False
    try:
        if getattr(gf, "Loaded", False):
            return True
    except Exception:
        pass
    for _ in range(max_loops):
        try:
            gfc.ContentThreadProc()
        except Exception:
            break
        try:
            if getattr(gf, "Loaded", False):
                return True
        except Exception:
            pass
    return False


def _parse_missing_input(path: Path) -> Tuple[Set[int], Dict[int, str]]:
    """
    Return (need_hashes, slug_by_hash).
    """
    dump = json.loads(path.read_text(encoding="utf-8", errors="ignore"))

    if isinstance(dump, list):
        rows = dump
    else:
        rows = dump.get("textures") if isinstance(dump, dict) else None
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
                raise SystemExit("unsupported missing input schema")

    need: Set[int] = set()
    slug_by_hash: Dict[int, str] = {}
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
        need.add(h)
        slug = str(m.group("slug") or "").strip()
        if slug:
            slug_by_hash[h] = slug
    return need, slug_by_hash


def _write_png_rgba(img_rgba, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    im = Image.fromarray(img_rgba, mode="RGBA")
    im.save(out_path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gta-path", required=True)
    ap.add_argument("--assets-dir", required=True)
    ap.add_argument("--missing", required=True, help="Missing-textures JSON (dump or missing-only list).")
    ap.add_argument("--selected-dlc", default="all")
    ap.add_argument(
        "--also-scan-dlc",
        action="append",
        default=["patchday27ng"],
        help="Additional DLC levels to scan when a particle dict isn't found (default: patchday27ng). Can be provided multiple times.",
    )
    ap.add_argument("--split-by-dlc", action="store_true")
    ap.add_argument("--pack-root-prefix", default="packs")
    ap.add_argument("--force-pack", default="")
    ap.add_argument("--max-ypt", type=int, default=0, help="0 = no cap; otherwise stop after scanning N ypt files")
    ap.add_argument("--ypt-load-loops", type=int, default=250, help="Max ContentThreadProc loops per YPT load attempt.")
    ap.add_argument("--ypt-load-retries", type=int, default=2, help="Retries per YPT if it doesn't load quickly.")
    ap.add_argument("--regen-index", action="store_true", default=False)
    args = ap.parse_args()

    need, slug_by_hash = _parse_missing_input(Path(args.missing))
    if not need:
        print("No missing model-texture hashes found in input; nothing to do.")
        return 0

    assets_dir = Path(args.assets_dir)
    base_tex_dir = assets_dir / "models_textures"
    packs_root = assets_dir / str(args.pack_root_prefix or "packs").strip().strip("/").strip("\\")
    force_pack = str(args.force_pack or "").strip().lower()
    split_by_dlc = bool(args.split_by_dlc)
    extra_levels = [str(x or "").strip() for x in (args.also_scan_dlc or []) if str(x or "").strip()]

    # Init CodeWalker.
    dm = DllManager(str(args.gta_path))
    if not getattr(dm, "initialized", False):
        raise SystemExit("DllManager failed to init")
    ok = dm.init_game_file_cache(selected_dlc=str(args.selected_dlc), load_vehicles=False, load_peds=False, load_audio=False)
    if not ok:
        raise SystemExit("Failed to init GameFileCache")
    gfc = dm.get_game_file_cache()
    if gfc is None or not getattr(gfc, "IsInited", False):
        raise SystemExit("GameFileCache not inited")

    # Pull CodeWalker's authoritative RpfMan (with DLC overlays).
    rpfman = getattr(gfc, "RpfMan", None) or getattr(dm, "get_rpf_manager", lambda: None)()
    if rpfman is None:
        raise SystemExit("No RpfMan available")

    # Import decoder helper from the main exporter (matches what we do for drawables).
    from export_drawables_for_chunk import _decode_texture_object_to_img_rgba  # type: ignore

    def pick_out_dir(entry_path: str) -> Path:
        if force_pack:
            return packs_root / force_pack / "models_textures"
        if not split_by_dlc:
            return base_tex_dir
        dlc = _infer_dlc_name_from_path(entry_path)
        if dlc:
            return packs_root / dlc / "models_textures"
        return base_tex_dir

    extracted = 0
    scanned = 0
    per_dir_touched: Set[Path] = set()

    # Iterate RPFS like CodeWalker.TestYpts().
    all_rpfs = getattr(gfc, "AllRpfs", None)
    if all_rpfs is None:
        raise SystemExit("GameFileCache.AllRpfs not available; cannot scan YPTs")

    # Late-bind YptFile type so pythonnet has the assembly loaded via DllManager.
    try:
        from CodeWalker.GameFiles import YptFile  # type: ignore
    except Exception as e:
        raise SystemExit(f"Failed to import CodeWalker.GameFiles.YptFile: {e}")

    for rpf in all_rpfs:
        try:
            entries = getattr(rpf, "AllEntries", None)
        except Exception:
            entries = None
        if entries is None:
            continue
        for entry in entries:
            if not need:
                break
            if args.max_ypt and scanned >= int(args.max_ypt):
                break
            try:
                nl = str(getattr(entry, "NameLower", "") or "")
            except Exception:
                nl = ""
            if not nl.endswith(".ypt"):
                continue
            scanned += 1

            # Load YPT (with retries + ContentThreadProc spins).
            ypt = None
            for _ in range(max(1, int(args.ypt_load_retries))):
                try:
                    ypt = rpfman.GetFile[YptFile](entry)
                except Exception:
                    ypt = None
                if _ensure_loaded(gfc, ypt, max_loops=int(args.ypt_load_loops)):
                    break
            if ypt is None:
                continue

            try:
                ptfx = getattr(ypt, "PtfxList", None)
                texdict = getattr(ptfx, "TextureDictionary", None) if ptfx is not None else None
                d = getattr(texdict, "Dict", None) if texdict is not None else None
            except Exception:
                d = None
            if d is None:
                continue

            try:
                entry_path = str(getattr(entry, "Path", "") or "")
            except Exception:
                entry_path = ""
            out_dir = pick_out_dir(entry_path)
            per_dir_touched.add(out_dir)

            # Dict enumerates textures by hash; values are Texture objects.
            try:
                it = d.GetEnumerator()
                while it.MoveNext() and need:
                    kv = it.Current
                    tex = getattr(kv, "Value", None)
                    if tex is None:
                        continue
                    try:
                        h = int(getattr(tex, "NameHash")) & 0xFFFFFFFF
                    except Exception:
                        continue
                    if h not in need:
                        continue

                    # Decode and write.
                    img, _fmt = _decode_texture_object_to_img_rgba(dm, tex)
                    if img is not None:
                        try:
                            img_rgba = img.astype("uint8")
                        except Exception:
                            img_rgba = img
                        # Always write hash-only. Optionally write hash+slug if we have it from the missing list.
                        _write_png_rgba(img_rgba, out_dir / f"{h}.png")
                        slug = str(slug_by_hash.get(h) or "").strip()
                        if slug:
                            _write_png_rgba(img_rgba, out_dir / f"{h}_{slug}.png")
                    else:
                        # Gen9 fallback: write DDS container when pixels aren't decodable (eg BC7 TODO in DDSIO.GetPixels).
                        dds = _try_get_dds_bytes(dm, tex)
                        if not dds:
                            continue
                        (out_dir / f"{h}.dds").write_bytes(dds)
                        slug = str(slug_by_hash.get(h) or "").strip()
                        if slug:
                            (out_dir / f"{h}_{slug}.dds").write_bytes(dds)

                    extracted += 1
                    need.discard(h)
            except Exception:
                # Fallback: try iterating Values if enumerator isn't exposed.
                try:
                    vals = getattr(d, "Values", None)
                except Exception:
                    vals = None
                if vals is not None:
                    for tex in vals:
                        if not need:
                            break
                        if tex is None:
                            continue
                        try:
                            h = int(getattr(tex, "NameHash")) & 0xFFFFFFFF
                        except Exception:
                            continue
                        if h not in need:
                            continue
                        img, _fmt = _decode_texture_object_to_img_rgba(dm, tex)
                        if img is not None:
                            try:
                                img_rgba = img.astype("uint8")
                            except Exception:
                                img_rgba = img
                            _write_png_rgba(img_rgba, out_dir / f"{h}.png")
                            slug = str(slug_by_hash.get(h) or "").strip()
                            if slug:
                                _write_png_rgba(img_rgba, out_dir / f"{h}_{slug}.png")
                        else:
                            dds = _try_get_dds_bytes(dm, tex)
                            if not dds:
                                continue
                            (out_dir / f"{h}.dds").write_bytes(dds)
                            slug = str(slug_by_hash.get(h) or "").strip()
                            if slug:
                                (out_dir / f"{h}_{slug}.dds").write_bytes(dds)
                        extracted += 1
                        need.discard(h)

    # Regen index for any dirs we wrote into.
    if args.regen_index:
        for d in sorted(per_dir_touched):
            try:
                _regen_models_textures_index(d)
            except Exception as e:
                print(f"[warn] failed to regen index in {d}: {e}")

    print(f"scanned_ypt={scanned} extracted={extracted} remaining={len(need)}")
    if need:
        # Print a small sample for next-stage debugging.
        sample = list(sorted(need))[:20]
        print(f"remaining_sample={sample}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



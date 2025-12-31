#!/usr/bin/env python3
"""
Decode GTA V texture dictionaries (.ytd / .gtxd) to PNGs on Linux using CodeWalker.Core (via pythonnet).

Why:
- `run_pipeline_linux.py` can extract raw `.ytd/.gtxd` bytes, but the WebGL viewer consumes decoded images.
- CodeWalker.Core already contains DDS decoding helpers (DDSIO.GetPixels), so we leverage that.

Outputs (under --output-dir, default: output):
- output/textures/png/**/<texture_name>.png
- output/textures/textures_index.json  (manifest for debugging/provenance)
"""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

import dotenv
from PIL import Image

from gta5_modules.dll_manager import DllManager


_SAFE_PATH_RE = re.compile(r"[^a-zA-Z0-9._/\\-]+")


def _norm_archive_path(p: str) -> str:
    return p.replace("\\", "/")


def _safe_relpath(p: str) -> str:
    """
    Convert an RPF internal path into a safe relative filesystem path.
    Keeps '/' so directory structure is preserved.
    """
    p = _norm_archive_path(p).lstrip("/")
    p = _SAFE_PATH_RE.sub("_", p)
    p = p.replace("..", "_")
    return p


def _iter_texture_dict_paths(rpf_manager: Any, *, include_gtxd: bool) -> List[str]:
    exts: Set[str] = {".ytd"}
    if include_gtxd:
        exts.add(".gtxd")

    paths: List[str] = []
    for rpf in getattr(rpf_manager, "AllRpfs", []) or []:
        entries = getattr(rpf, "AllEntries", None)
        if not entries:
            continue
        for entry in entries:
            try:
                name = getattr(entry, "Name", "")
                if not isinstance(name, str):
                    continue
                n = name.lower()
                if any(n.endswith(ext) for ext in exts):
                    paths.append(str(getattr(entry, "Path", "")))
            except Exception:
                continue

    paths = [p for p in paths if p]
    paths.sort()
    return paths


def _ensure_png_rgba_from_pixels(pixels: bytes, width: int, height: int) -> Image.Image:
    """
    DDSIO.GetPixels returns raw bytes already decompressed to 32bpp for most formats in CodeWalker.
    We treat it as RGBA. If it isn't, this will throw, which we catch at call sites.
    """
    img = Image.frombytes("RGBA", (width, height), pixels)
    return img


def _decode_ytd_like_to_pngs(
    *,
    dll_manager: DllManager,
    texdict_path: str,
    texdict_bytes: Optional[bytes],
    out_root: Path,
    overwrite: bool,
    max_textures_per_dict: int,
    contains_texture: str,
) -> Dict[str, Any]:
    """
    Load a YTD/GTXD with CodeWalker.Core, decode textures to PNGs, write to disk.
    Returns a small manifest entry for this texture dict.
    """
    # Load the YTD/GTXD either from the RPF index (texdict_path) or directly from bytes.
    ytd = None
    if texdict_bytes is not None:
        ytd = dll_manager.YtdFile()
        ytd.Load(texdict_bytes)  # direct load from raw, compressed ytd bytes
    else:
        rpf_manager = dll_manager.get_rpf_manager()
        entry = rpf_manager.GetEntry(texdict_path)
        if not entry:
            raise RuntimeError(f"Entry not found: {texdict_path}")
        # Note: CodeWalker.GameFiles.YtdFile can often load GTXD too (resource format is similar),
        # but some will fail; caller handles exceptions.
        ytd = rpf_manager.GetFile[dll_manager.YtdFile](entry)
        if not ytd:
            raise RuntimeError(f"Failed to load as YtdFile: {texdict_path}")

    texdict = getattr(ytd, "TextureDict", None)
    textures_arr = getattr(texdict, "Textures", None) if texdict is not None else None
    data_items = getattr(textures_arr, "data_items", None) if textures_arr is not None else None
    if not data_items:
        return {
            "path": texdict_path,
            "ok": True,
            "decoded": 0,
            "skipped": 0,
            "error": None,
        }

    out_dir = out_root / _safe_relpath(texdict_path)
    out_dir.mkdir(parents=True, exist_ok=True)

    decoded = 0
    skipped = 0
    tex_entries: List[Dict[str, Any]] = []
    contains_lc = (contains_texture or "").lower().strip()

    for idx, tex in enumerate(list(data_items)):
        if max_textures_per_dict and idx >= max_textures_per_dict:
            break

        try:
            tex_name = str(getattr(tex, "Name", "") or "")
            if contains_lc and (contains_lc not in tex_name.lower()):
                skipped += 1
                continue
            width = int(getattr(tex, "Width", 0) or 0)
            height = int(getattr(tex, "Height", 0) or 0)
            fmt = str(getattr(getattr(tex, "Format", None), "ToString", lambda: getattr(tex, "Format", ""))())

            if not tex_name or width <= 0 or height <= 0:
                skipped += 1
                continue

            # Decode base mip
            pixels_net = dll_manager.DDSIO.GetPixels(tex, 0)
            if not pixels_net:
                skipped += 1
                continue

            pixels = bytes(pixels_net)
            img = _ensure_png_rgba_from_pixels(pixels, width, height)

            # Some names include path separators; sanitize.
            safe_name = _SAFE_PATH_RE.sub("_", tex_name)
            if safe_name.lower().endswith(".png"):
                out_png = out_dir / safe_name
            else:
                out_png = out_dir / f"{safe_name}.png"

            if out_png.exists() and not overwrite:
                skipped += 1
            else:
                img.save(out_png)
                decoded += 1

            tex_entries.append(
                {
                    "name": tex_name,
                    "width": width,
                    "height": height,
                    "format": fmt,
                    "png": str(out_png),
                }
            )
        except Exception:
            skipped += 1
            continue

    return {
        "path": texdict_path,
        "ok": True,
        "decoded": decoded,
        "skipped": skipped,
        "outDir": str(out_dir),
        "textures": tex_entries[:200],  # keep manifest small
        "error": None,
    }


def main() -> int:
    dotenv.load_dotenv()
    dotenv.load_dotenv(dotenv_path=Path(__file__).resolve().parent / "env.local", override=False)

    ap = argparse.ArgumentParser(description="Decode GTA V YTD/GTXD texture dictionaries to PNG (Linux, CodeWalker.Core).")
    ap.add_argument("--game-path", default=os.getenv("gta_location") or os.getenv("gta5_path"), help="Path to GTA V root")
    ap.add_argument("--output-dir", default="output", help="Output root (default: output)")
    ap.add_argument("--include-gtxd", action="store_true", help="Also decode .gtxd files (can be slower / may have failures).")
    ap.add_argument("--filter", default="", help="Only process texture dicts whose path contains this substring (case-insensitive).")
    ap.add_argument(
        "--contains-texture",
        default="",
        help="Only decode textures whose internal texture name contains this substring (case-insensitive). Useful when you know a PNG name but not which .ytd it lives in.",
    )
    ap.add_argument("--max-files", type=int, default=0, help="Limit number of texture dicts (0 = no limit).")
    ap.add_argument("--max-textures-per-dict", type=int, default=0, help="Limit textures decoded per dict (0 = no limit).")
    ap.add_argument("--stop-after", type=int, default=0, help="Stop after decoding N PNGs total (0 = no limit).")
    ap.add_argument("--overwrite", action="store_true", help="Overwrite existing PNGs.")
    ap.add_argument(
        "--raw-dir",
        default="",
        help="If set, decode from already-extracted files under this directory (e.g. output/textures/raw). Avoids scanning the whole GTA install.",
    )
    args = ap.parse_args()

    if not args.game_path:
        print("ERROR: missing --game-path (or gta_location/gta5_path in environment).")
        return 2

    game_path = Path(args.game_path).expanduser()
    out_root = Path(args.output_dir).expanduser()

    dll_manager = DllManager(str(game_path))
    if not dll_manager.initialized:
        print("ERROR: DllManager failed to initialize (CodeWalker.Core not available?)")
        return 1

    raw_dir = Path(args.raw_dir).expanduser() if args.raw_dir else None
    tex_paths: List[str] = []
    raw_files: List[Path] = []

    if raw_dir is not None:
        if not raw_dir.exists():
            print(f"ERROR: --raw-dir does not exist: {raw_dir}")
            return 2
        exts = [".ytd"] + ([".gtxd"] if args.include_gtxd else [])
        raw_files = [p for p in sorted(raw_dir.rglob("*")) if p.is_file() and p.suffix.lower() in exts]
        if args.filter:
            f = args.filter.lower()
            raw_files = [p for p in raw_files if f in str(p).lower()]
        if args.max_files and args.max_files > 0:
            raw_files = raw_files[: args.max_files]
        if not raw_files:
            print("ERROR: found 0 texture dictionaries under --raw-dir after filtering.")
            return 1
    else:
        rpf_manager = dll_manager.get_rpf_manager()
        tex_paths = _iter_texture_dict_paths(rpf_manager, include_gtxd=bool(args.include_gtxd))

        if args.filter:
            f = args.filter.lower()
            tex_paths = [p for p in tex_paths if f in p.lower()]

        if args.max_files and args.max_files > 0:
            tex_paths = tex_paths[: args.max_files]

        if not tex_paths:
            print("ERROR: found 0 texture dictionaries (.ytd/.gtxd) via CodeWalker RpfManager index.")
            return 1

    png_root = out_root / "textures" / "png"
    png_root.mkdir(parents=True, exist_ok=True)

    manifest: Dict[str, Any] = {
        "gamePath": str(game_path),
        "outputDir": str(out_root),
        "pngRoot": str(png_root),
        "includeGtxd": bool(args.include_gtxd),
        "filter": args.filter,
        "maxFiles": int(args.max_files),
        "maxTexturesPerDict": int(args.max_textures_per_dict),
        "overwrite": bool(args.overwrite),
        "rawDir": str(raw_dir) if raw_dir is not None else None,
        "processed": [],
    }

    ok = 0
    failed = 0
    total_decoded = 0

    # Process either raw files or RPF-indexed paths.
    to_process_count = len(raw_files) if raw_dir is not None else len(tex_paths)
    if raw_dir is not None:
        for fp in raw_files:
            try:
                data = fp.read_bytes()
                entry = _decode_ytd_like_to_pngs(
                    dll_manager=dll_manager,
                    texdict_path=str(fp),
                    texdict_bytes=data,
                    out_root=png_root,
                    overwrite=bool(args.overwrite),
                    max_textures_per_dict=int(args.max_textures_per_dict),
                    contains_texture=str(args.contains_texture or ""),
                )
                manifest["processed"].append(entry)
                ok += 1
                total_decoded += int(entry.get("decoded", 0) or 0)
                if args.stop_after and args.stop_after > 0 and total_decoded >= args.stop_after:
                    break
            except Exception as e:
                failed += 1
                manifest["processed"].append({"path": str(fp), "ok": False, "decoded": 0, "skipped": 0, "error": str(e)})
    else:
        for p in tex_paths:
            try:
                entry = _decode_ytd_like_to_pngs(
                    dll_manager=dll_manager,
                    texdict_path=p,
                    texdict_bytes=None,
                    out_root=png_root,
                    overwrite=bool(args.overwrite),
                    max_textures_per_dict=int(args.max_textures_per_dict),
                    contains_texture=str(args.contains_texture or ""),
                )
                manifest["processed"].append(entry)
                ok += 1
                total_decoded += int(entry.get("decoded", 0) or 0)
                if args.stop_after and args.stop_after > 0 and total_decoded >= args.stop_after:
                    break
            except Exception as e:
                failed += 1
                manifest["processed"].append({"path": p, "ok": False, "decoded": 0, "skipped": 0, "error": str(e)})

    manifest["counts"] = {"dicts": int(to_process_count), "ok": ok, "failed": failed, "decodedPng": total_decoded}

    manifest_path = out_root / "textures" / "textures_index.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print("Wrote:")
    print(f"  {png_root}  (decoded PNGs)")
    print(f"  {manifest_path}  (manifest)")
    print(f"Decoded PNGs: {total_decoded} (dicts ok: {ok}, failed: {failed})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



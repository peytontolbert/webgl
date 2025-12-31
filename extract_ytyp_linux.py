#!/usr/bin/env python3
"""
Task 3 (YTYP) pipeline:
- Bulk extract all .ytyp from GTA V RPFs on Linux using CodeWalker.Core (via pythonnet)
- Export YTYP -> archetypes JSON for downstream resolution (YMAP -> archetype -> drawable)

Outputs (under --output-dir, default: output):
- output/ytyp/raw/**.ytyp
- output/ytyp/archetypes/**.json  (exported directly via CodeWalker.Core)

Important note:
- Many YTYPs live inside *nested* RPFS (e.g. update.rpf\\dlc_patch\\...\\something.rpf\\...\\file.ytyp).
  The simple CLI `extract --rpf <top-level.rpf> --glob "**\\*.ytyp"` does not reliably recurse into nested RPFS.
  This script therefore uses CodeWalker.Core's `RpfManager` index (like `extract_ymaps.py`) to find and extract YTYPs.
"""

from __future__ import annotations

import argparse
import os
import re
from pathlib import Path
from typing import Any, List, Optional

import dotenv

from gta5_modules.dll_manager import DllManager


_SAFE_PATH_RE = re.compile(r"[^a-zA-Z0-9._/\\-]+")


def _norm_archive_path(p: str) -> str:
    # CodeWalker paths are Windows-style; normalize for stable on-disk layout.
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

def _iter_ytyp_paths(rpf_manager: Any) -> List[str]:
    paths: List[str] = []
    for rpf in getattr(rpf_manager, "AllRpfs", []) or []:
        entries = getattr(rpf, "AllEntries", None)
        if not entries:
            continue
        for entry in entries:
            try:
                name = getattr(entry, "Name", "")
                if isinstance(name, str) and name.lower().endswith(".ytyp"):
                    paths.append(str(getattr(entry, "Path", "")))
            except Exception:
                continue
    paths = [p for p in paths if p]
    paths.sort()
    return paths


def _export_raw_ytyp(*, rpf_manager: Any, ytyp_path: str, raw_root: Path) -> Optional[Path]:
    data = rpf_manager.GetFileData(ytyp_path)
    if not data:
        return None
    out_path = raw_root / _safe_relpath(ytyp_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(bytes(data))
    return out_path

def _meta_hash_to_dto(h: Any) -> dict:
    # MetaHash stringifies to a name when known (or hash_xxxxx).
    name = str(h)
    hv = int(getattr(h, "Hash", 0)) if h is not None else 0
    hx = str(getattr(h, "Hex", "")) if h is not None else ""
    return {"name": name, "hash": hv, "hex": hx}


def _vec3_to_dto(v: Any) -> dict:
    return {
        "x": float(getattr(v, "X", 0.0)),
        "y": float(getattr(v, "Y", 0.0)),
        "z": float(getattr(v, "Z", 0.0)),
    }


def _export_ytyp_archetypes_json(*, rpf_manager: Any, ytyp_path: str, json_root: Path) -> Optional[Path]:
    # Import here so pythonnet has CodeWalker.Core loaded via DllManager first.
    from CodeWalker.GameFiles import YtypFile  # type: ignore

    entry = rpf_manager.GetEntry(ytyp_path)
    if not entry:
        return None

    ytyp = rpf_manager.GetFile[YtypFile](entry)
    if not ytyp:
        return None

    archetypes = []
    all_arch = getattr(ytyp, "AllArchetypes", None)
    if all_arch is not None:
        for a in all_arch:
            if a is None:
                continue
            bd = getattr(a, "_BaseArchetypeDef", None)
            if bd is None:
                continue
            archetypes.append(
                {
                    "name": _meta_hash_to_dto(getattr(bd, "name", 0)),
                    "assetName": _meta_hash_to_dto(getattr(bd, "assetName", 0)),
                    "drawableDict": _meta_hash_to_dto(getattr(bd, "drawableDictionary", 0)),
                    "textureDict": _meta_hash_to_dto(getattr(bd, "textureDictionary", 0)),
                    "clipDict": _meta_hash_to_dto(getattr(bd, "clipDictionary", 0)),
                    "lodDist": float(getattr(bd, "lodDist", 0.0)),
                    "flags": int(getattr(bd, "flags", 0)),
                    "bbMin": _vec3_to_dto(getattr(bd, "bbMin", None)),
                    "bbMax": _vec3_to_dto(getattr(bd, "bbMax", None)),
                }
            )

    dto = {
        "source": _norm_archive_path(ytyp_path),
        "ytypPath": ytyp_path,
        "name": _meta_hash_to_dto(getattr(getattr(ytyp, "CMapTypes", None), "name", 0)),
        "archetypes": archetypes,
    }

    out_path = json_root / (_safe_relpath(ytyp_path) + ".json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    import json as _json

    out_path.write_text(_json.dumps(dto, indent=2), encoding="utf-8")
    return out_path


def main() -> int:
    dotenv.load_dotenv()
    dotenv.load_dotenv(dotenv_path=Path(__file__).resolve().parent / "env.local", override=False)

    parser = argparse.ArgumentParser(description="Extract GTA V YTYP files and export archetypes JSON (Linux).")
    parser.add_argument("--game-path", default=os.getenv("gta_location") or os.getenv("gta5_path"), help="Path to GTA V root")
    parser.add_argument("--output-dir", default="output", help="Output root (default: output)")
    parser.add_argument("--max-files", type=int, default=0, help="Limit number of YTYPs to extract (0 = no limit)")
    parser.add_argument("--filter", default="", help="Only process YTYPs whose path contains this substring (case-insensitive)")
    parser.add_argument("--no-raw", action="store_true", help="Skip writing output/ytyp/raw/**.ytyp")
    parser.add_argument("--no-json", action="store_true", help="Skip writing output/ytyp/archetypes/**.json")
    args = parser.parse_args()

    if not args.game_path:
        print("ERROR: missing --game-path (or gta_location/gta5_path in environment).")
        return 2

    repo_root = Path(__file__).resolve().parent
    game_path = Path(args.game_path).expanduser()
    out_root = Path(args.output_dir).expanduser()

    raw_root = out_root / "ytyp" / "raw"
    json_root = out_root / "ytyp" / "archetypes"
    raw_root.mkdir(parents=True, exist_ok=True)
    json_root.mkdir(parents=True, exist_ok=True)

    dll_manager = DllManager(str(game_path))
    if not dll_manager.initialized:
        print("ERROR: DllManager failed to initialize (CodeWalker.Core not available?)")
        return 1

    rpf_manager = dll_manager.get_rpf_manager()
    ytyp_paths = _iter_ytyp_paths(rpf_manager)
    if args.filter:
        f = args.filter.lower()
        ytyp_paths = [p for p in ytyp_paths if f in p.lower()]
    if args.max_files and args.max_files > 0:
        ytyp_paths = ytyp_paths[: args.max_files]

    if not ytyp_paths:
        print("ERROR: found 0 .ytyp files via CodeWalker RpfManager index.")
        return 1

    extracted_raw = 0
    exported_json = 0
    for ytyp_path in ytyp_paths:
        if not args.no_raw:
            outp = _export_raw_ytyp(rpf_manager=rpf_manager, ytyp_path=ytyp_path, raw_root=raw_root)
            if outp:
                extracted_raw += 1
        if not args.no_json:
            try:
                outj = _export_ytyp_archetypes_json(rpf_manager=rpf_manager, ytyp_path=ytyp_path, json_root=json_root)
                if outj:
                    exported_json += 1
            except Exception as e:
                # Keep going; some YTYPs may fail to parse depending on format/version.
                print(f"Warning: failed to export JSON for {ytyp_path}: {e}")

    if not args.no_raw:
        print(f"Extracted {extracted_raw} raw .ytyp files into {raw_root}")
    if not args.no_json:
        print(f"Exported {exported_json} YTYP archetypes JSON files into {json_root}")

    print("Wrote:")
    print(f"  {raw_root}")
    print(f"  {json_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



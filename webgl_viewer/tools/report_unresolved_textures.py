"""
Report unresolved textures from a debug dump, using CodeWalker lookups.

This does NOT try to brute-force scan all YTDs (which can be expensive and can crash pythonnet on some builds).
Instead it answers the question: "Given my current GTA install, can CodeWalker locate a YTD for this texture hash?"

Output is a JSON array (one row per missing texture) with:
  - requestedRel, useCount
  - texHash (u32)
  - cwFoundYtdEntryName (or null)
  - note (likely cause)

Usage:
  python3 webgl-gta/webgl_viewer/tools/report_unresolved_textures.py \
    --gta-path /data/webglgta/gta5 \
    --selected-dlc patchday27ng \
    --dump webgl-gta/webgl_viewer/tools/out/tex_dump_at_point_after_global_scan2.json \
    --out webgl-gta/webgl_viewer/tools/out/unresolved_textures_report.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

_MODEL_TEX_RE = re.compile(r"^models_textures/(?P<hash>\d+)(?:_(?P<slug>[^/]+))?\.png$", re.IGNORECASE)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gta-path", required=True)
    ap.add_argument(
        "--selected-dlc",
        default="all",
        help="CodeWalker DLC level. Use 'all' to load all DLCs (except patchday27ng unless explicitly selected).",
    )
    ap.add_argument(
        "--also-scan-dlc",
        action="append",
        default=[],
        help="Optional additional DLC levels to try (useful for CodeWalker special cases like patchday27ng).",
    )
    ap.add_argument("--dump", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

    from gta5_modules.dll_manager import DllManager  # noqa

    dump = json.loads(Path(args.dump).read_text(encoding="utf-8", errors="ignore"))
    rows = dump.get("textures")
    if not isinstance(rows, list):
        raise SystemExit("dump has no textures[]")

    missing = []
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
        missing.append(
            {
                "requestedRel": rel,
                "useCount": int(r.get("useCount") or 0),
                "texHash": int(h),
                "slug": str(m.group("slug") or ""),
            }
        )

    missing.sort(key=lambda x: (-int(x["useCount"]), str(x["requestedRel"])))

    dm = DllManager(str(args.gta_path))
    if not getattr(dm, "initialized", False):
        raise SystemExit("DllManager failed to init")
    # IMPORTANT:
    # Use the real CodeWalker GameFileCache instance from DllManager. Some older helper methods
    # return a wrapper that does not expose the full texture dictionary lookup behavior.
    dm.init_game_file_cache(selected_dlc=str(args.selected_dlc), load_vehicles=False, load_peds=False, load_audio=False)
    gfc = dm.get_game_file_cache()
    if gfc is None or not getattr(gfc, "IsInited", False):
        raise SystemExit("GameFileCache not inited")

    def _infer_dlc_from_entry_path(p: str) -> str:
        s = str(p or "").strip().lower().replace("/", "\\")
        m = re.search(r"\\dlcpacks\\([^\\]+)\\", s)
        return str(m.group(1) or "").strip().lower() if m else ""

    out_rows: List[Dict[str, Any]] = []
    for r in missing:
        h = int(r["texHash"]) & 0xFFFFFFFF
        ytd = None
        entry_name: Optional[str] = None
        entry_path: Optional[str] = None
        inferred_dlc: Optional[str] = None

        def _try_lookup_once() -> None:
            nonlocal ytd, entry_name, entry_path, inferred_dlc
            ytd = None
            try:
                ytd = gfc.TryGetTextureDictForTexture(h)
            except Exception:
                ytd = None
            if ytd is None:
                return
            try:
                entry = getattr(ytd, "RpfFileEntry", None)
                entry_name = str(getattr(entry, "Name", None)) if entry is not None else None
                entry_path = str(getattr(entry, "Path", None)) if entry is not None else None
                inferred_dlc = _infer_dlc_from_entry_path(entry_path or "")
            except Exception:
                entry_name = entry_name

        _try_lookup_once()
        if ytd is None:
            # Optional extra DLC levels (eg patchday27ng) without re-running full scan scripts.
            for extra in list(args.also_scan_dlc or []):
                try:
                    if hasattr(gfc, "SetDlcLevel"):
                        gfc.SetDlcLevel(str(extra), True)
                except Exception:
                    pass
                _try_lookup_once()
                if ytd is not None:
                    break

        note = None
        if entry_name:
            note = "found_in_game"
        else:
            # Most common: the referenced texture simply isn't present in this GTA install / DLC set.
            note = "not_found_in_cw_texture_lookup (likely missing DLC/content or bad reference)"

        out_rows.append(
            {
                "requestedRel": r["requestedRel"],
                "useCount": r["useCount"],
                "texHash": r["texHash"],
                "slug": r["slug"],
                "cwFoundYtdEntryName": entry_name,
                "cwFoundYtdEntryPath": entry_path,
                "cwInferredDlc": inferred_dlc,
                "note": note,
            }
        )

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out_rows, indent=2), encoding="utf-8")
    print(f"wrote {args.out} rows={len(out_rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



"""
Generate `webgl_viewer/assets/ymap_gates.json` from CodeWalker manifests (YMF MapDataGroups).

Why:
  GTA has "togglable" ymaps controlled by MapDataGroups with:
    - HoursOnOff bitmask (24 bits)
    - WeatherTypes allowlist
  CodeWalker uses this to decide whether a ymap is available at a given hour/weather.

This tool extracts that data via Python.NET + CodeWalker.Core (same approach as other tools here),
and writes a small lookup table keyed by ymap short-name hash (joaat(baseName)).

Usage:
  python3 webgl-gta/webgl_viewer/tools/write_ymap_gates_from_codewalker.py \
    --gta-path /data/webglgta/gta5 \
    --selected-dlc all \
    --write
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


def _dotnet_list_to_py_list(x: Any) -> List[Any]:
    if x is None:
        return []
    try:
        return list(x)
    except Exception:
        pass
    try:
        n = int(getattr(x, "Count"))
    except Exception:
        n = 0
    out: List[Any] = []
    for i in range(max(0, n)):
        try:
            out.append(x[i])
        except Exception:
            continue
    return out


def _to_u32(x: Any) -> Optional[int]:
    if x is None:
        return None
    # MetaHash-like structs often expose `.Hash`.
    try:
        if hasattr(x, "Hash"):
            v = int(getattr(x, "Hash"))
            return v & 0xFFFFFFFF
    except Exception:
        pass
    # Raw numeric
    try:
        v = int(x)
        return v & 0xFFFFFFFF
    except Exception:
        pass
    # pythonnet sometimes represents UInt32 values that don't fit in Int32 in a way that
    # makes int(x) raise. Fall back to parsing the string form.
    try:
        s = str(x).strip()
        if not s:
            return None
        v = int(s, 10)
        return v & 0xFFFFFFFF
    except Exception:
        return None


def _safe_u32(x: Any, default: int = 0) -> int:
    v = _to_u32(x)
    return int(v) if v is not None else int(default)


def _extract_map_data_groups(manifest: Any) -> List[Any]:
    # CodeWalker YmfFile exposes MapDataGroups. Defensive: name varies across versions.
    for attr in ("MapDataGroups", "mapDataGroups", "MapDataGroup", "mapDataGroup"):
        try:
            v = getattr(manifest, attr, None)
            if v is not None:
                return _dotnet_list_to_py_list(v)
        except Exception:
            continue
    return []


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gta-path", required=True)
    ap.add_argument("--selected-dlc", default="all")
    ap.add_argument("--assets-dir", default="", help="defaults to webgl_viewer/assets next to this script")
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

    from gta5_modules.dll_manager import DllManager  # noqa

    viewer_root = Path(__file__).resolve().parents[1]
    assets_dir = Path(args.assets_dir) if args.assets_dir else (viewer_root / "assets")

    dm = DllManager(str(args.gta_path))
    if not getattr(dm, "initialized", False):
        raise SystemExit("DllManager failed to initialize.")

    ok = dm.init_game_file_cache(
        selected_dlc=str(args.selected_dlc),
        load_vehicles=False,
        load_peds=False,
        load_audio=False,
    )
    if not ok:
        raise SystemExit("Failed to init GameFileCache.")
    gfc = dm.get_game_cache()
    if gfc is None or not getattr(gfc, "IsInited", False):
        raise SystemExit("GameFileCache not inited.")

    manifests = _dotnet_list_to_py_list(getattr(gfc, "AllManifests", None))
    if not manifests:
        raise SystemExit("GameFileCache.AllManifests is empty; ensure DLC is enabled and dlclist.xml is readable.")

    by_ymap_hash: Dict[str, Dict[str, Any]] = {}
    groups_total = 0
    groups_with_gates = 0

    for mf in manifests:
        for g in _extract_map_data_groups(mf):
            groups_total += 1
            try:
                name_hash = _safe_u32(getattr(g, "Name", None), 0)
                hours = _safe_u32(getattr(g, "HoursOnOff", None), 0)
                weather_types = _dotnet_list_to_py_list(getattr(g, "WeatherTypes", None))
                wlist = [str(_safe_u32(w, 0)) for w in weather_types if _safe_u32(w, 0) != 0]
            except Exception:
                continue

            if name_hash == 0:
                continue
            # Keep only groups that actually gate (hours mask or weather list).
            if (hours == 0) and (not wlist):
                continue

            groups_with_gates += 1
            by_ymap_hash[str(name_hash)] = {
                "hoursOnOff": int(hours),
                "weatherTypes": wlist,
            }

    out = {
        "schema": "webglgta-ymap-gates-v1",
        "generatedAtUnix": int(time.time()),
        "selectedDlc": str(args.selected_dlc),
        "groupsTotal": groups_total,
        "groupsWithGates": groups_with_gates,
        "byYmapHash": by_ymap_hash,
    }

    if not args.write:
        print(json.dumps(out, indent=2, sort_keys=True))
        return 0

    assets_dir.mkdir(parents=True, exist_ok=True)
    dst = assets_dir / "ymap_gates.json"
    tmp = assets_dir / "ymap_gates.json.tmp"
    tmp.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(dst)
    print(f"Wrote {dst} ({len(by_ymap_hash)} gated ymaps)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



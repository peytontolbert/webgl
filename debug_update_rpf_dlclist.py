#!/usr/bin/env python3
"""
Isolate "update.rpf not found" / DLC list init issues on Linux.

This script does two things:
1) Prints filesystem existence for the common Linux compatibility link names:
   - <gta_root>/update/update.rpf         (real file)
   - <gta_root>/update\\update.rpf        (literal backslash filename symlink)
   - <gta_root>/update.rpf               (root-level symlink some CodeWalker paths probe)
2) Uses CodeWalker (via pythonnet) to probe dlclist.xml entry resolution with several
   path variants and prints which one(s) resolve.

Usage:
  python debug_update_rpf_dlclist.py --game-path /data/webglgta/gta5
  GTA_PATH=/data/webglgta/gta5 python debug_update_rpf_dlclist.py

Optional (slow, reproduces GameFileCache.Init DLC scanning/logging):
  python debug_update_rpf_dlclist.py --init-game-file-cache
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path


def _p(label: str, v: object) -> None:
    print(f"{label}: {v}")


def _exists(p: Path) -> str:
    try:
        if p.is_symlink():
            try:
                return f"symlink -> {os.readlink(p)} (exists={p.exists()})"
            except OSError:
                return "symlink (readlink failed)"
        return "exists" if p.exists() else "MISSING"
    except Exception as e:
        return f"ERROR: {e}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--game-path",
        default=os.environ.get("GTA_PATH", "/data/webglgta/gta5"),
        help="GTA V install root (folder containing common.rpf, update/, GTA5.exe)",
    )
    ap.add_argument(
        "--init-game-file-cache",
        action="store_true",
        help="Also run GameFileCache.Init() (slow) to reproduce DLC list init path.",
    )
    args = ap.parse_args()

    gta_root = Path(args.game_path)
    _p("game_path", gta_root)
    _p("platform", sys.platform)

    # 1) OS-level checks
    _p("fs: common.rpf", _exists(gta_root / "common.rpf"))
    _p("fs: update/update.rpf", _exists(gta_root / "update" / "update.rpf"))
    _p(r"fs: update\update.rpf", _exists(gta_root / r"update\update.rpf"))
    _p("fs: update.rpf", _exists(gta_root / "update.rpf"))
    _p(r"fs: \gta5.exe", _exists(gta_root / r"\gta5.exe"))

    # 2) CodeWalker probing
    t0 = time.time()
    try:
        from gta5_modules.dll_manager import DllManager  # type: ignore
    except Exception as e:
        _p("import_error", e)
        print("Hint: run from repo root:  python debug_update_rpf_dlclist.py", file=sys.stderr)
        return 2

    dm = DllManager(str(gta_root))

    rpfman = dm.get_rpf_manager()
    _p("codewalker: rpf_manager", "OK" if rpfman is not None else "MISSING")

    # dlclist.xml location inside update.rpf
    inner = r"common\data\dlclist.xml"

    candidates: list[str] = [
        # Common CodeWalker internal forms
        rf"update\update.rpf\{inner}",
        rf"update.rpf\{inner}",
        # Linux mixed physical-path + internal backslashes (seen in this repo's logs)
        f"{str(gta_root).rstrip('/')}/update/update.rpf\\{inner}",
        # Full physical prefix variant
        f"{str(gta_root).rstrip('/')}/update\\update.rpf\\{inner}",
        f"{str(gta_root).rstrip('/')}/update.rpf\\{inner}",
    ]

    print("\n== CodeWalker GetEntry probes ==")
    for s in candidates:
        try:
            ent = rpfman.GetEntry(s) if rpfman is not None else None
        except Exception as e:
            ent = None
            _p(f"GetEntry({s})", f"EXCEPTION: {e}")
            continue
        if ent is None:
            _p(f"GetEntry({s})", "None")
        else:
            # Print minimal properties that exist across builds
            try:
                _p(f"GetEntry({s})", f"OK name={getattr(ent, 'Name', '?')} path={getattr(ent, 'Path', '?')}")
            except Exception:
                _p(f"GetEntry({s})", "OK (entry object)")

    _p("elapsed_s", round(time.time() - t0, 2))

    if args.init_game_file_cache:
        print("\n== GameFileCache.Init (slow) ==")
        t1 = time.time()
        ok = dm.init_game_file_cache(load_vehicles=False, load_peds=False, load_audio=False)
        _p("init_game_file_cache", ok)
        _p("elapsed_s", round(time.time() - t1, 2))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())



"""
CodeWalker cache smoke test (Python.NET).

Goal: prove whether CodeWalker can load the main map cache:
  - update\\update.rpf\\common\\data\\gta5_cache_y.dat
  - update\\update2.rpf\\common\\data\\gta5_cache_y.dat
  - common.rpf\\data\\gta5_cache_y.dat

This uses the *typed* generic loader:
  GameFileCache.RpfMan.GetFile[CacheDatFile](path)

If this fails, CodeWalker will not have complete map/texture lookup behavior, and many downstream
export scripts will look like "textures don't exist" even when they do.

Usage:
  python3 webgl-gta/webgl_viewer/tools/codewalker_cache_smoketest.py --gta-path /data/webglgta/gta5 --selected-dlc all
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gta-path", required=True)
    ap.add_argument("--selected-dlc", default="all")
    args = ap.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

    from gta5_modules.dll_manager import DllManager  # noqa

    dm = DllManager(str(args.gta_path))
    if not getattr(dm, "initialized", False):
        raise SystemExit("DllManager failed to initialize (DLL load / keys / RPF index).")

    print("DllManager gen9:", getattr(dm, "_gtagen9", None))

    ok = dm.init_game_file_cache(selected_dlc=str(args.selected_dlc), load_vehicles=False, load_peds=False, load_audio=False)
    print("init_game_file_cache:", ok)
    gfc = dm.get_game_cache()
    if gfc is None:
        raise SystemExit("GameFileCache is None")

    rpfman = getattr(gfc, "RpfMan", None)
    if rpfman is None:
        raise SystemExit("GameFileCache.RpfMan is None")

    CacheDatFile = getattr(dm, "CacheDatFile", None)
    if CacheDatFile is None:
        raise SystemExit("DllManager.CacheDatFile is missing; update gta5_modules/dll_manager.py imports.")

    # IMPORTANT: CodeWalker virtual paths use single backslashes in strings.
    # In Python literals, write those paths using raw strings with single '\' separators.
    paths = [
        r"update\update.rpf\common\data\gta5_cache_y.dat",
        r"update\update2.rpf\common\data\gta5_cache_y.dat",
        r"common.rpf\data\gta5_cache_y.dat",
    ]

    loaded_any = False
    for p in paths:
        try:
            f = rpfman.GetFile[CacheDatFile](p)
            ok = f is not None
            loaded_any = loaded_any or ok
            print(p, "->", "OK" if ok else "NULL")
        except Exception as e:
            print(p, "-> EXC", type(e).__name__, str(e))

    if not loaded_any:
        print("\nRESULT: FAILED to load gta5_cache_y.dat from any known path.")
        print("This usually means one of:")
        print("- wrong GTA root passed to --gta-path")
        print("- missing/trimmed update.rpf/common.rpf content")
        print("- Gen9 flag mismatch (try setting env GTA5_GEN9=1 or GTA5_GEN9=0)")
        return 2

    print("\nRESULT: OK (at least one cache file loaded).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



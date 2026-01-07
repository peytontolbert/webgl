"""
Targeted CodeWalker RPF read smoketest (Linux/pythonnet).

Purpose:
  Print the exact failure mode when CodeWalker can't read files that we *can see* in EntryDict keys.

This avoids the heavy GameFileCache.Init() map/archetype scan by using the DllManager's standalone
RpfManager instance (dm.rpf_manager), which already scanned RPFS and built EntryDict.

It checks:
  - Whether EntryDict contains a key for the path (string-level)
  - Whether GetEntry(path) returns a value (marshalling-level)
  - Whether GetFileData(path) returns bytes (extraction-level)
  - Whether GetFileUTF8Text(path) returns text (UTF8 decode-level)

Usage:
  python3 webgl-gta/webgl_viewer/tools/codewalker_rpf_read_smoketest.py --gta-path /data/webglgta/gta5
  GTA5_GEN9=0 python3 ... (force gen8)
"""

from __future__ import annotations

import argparse
import binascii
import sys
from pathlib import Path


def _hex_head(b: bytes, n: int = 16) -> str:
    if not b:
        return ""
    return binascii.hexlify(b[:n]).decode("ascii")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gta-path", required=True)
    args = ap.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

    from gta5_modules.dll_manager import DllManager  # noqa

    dm = DllManager(str(args.gta_path))
    if not getattr(dm, "initialized", False):
        raise SystemExit("DllManager failed to initialize.")

    rm = getattr(dm, "rpf_manager", None)
    if rm is None:
        raise SystemExit("DllManager.rpf_manager is None (RpfManager init failed).")

    print("DllManager gen9:", getattr(dm, "_gtagen9", None))
    print("RpfManager.IsInited:", getattr(rm, "IsInited", None))

    ed = getattr(rm, "EntryDict", None)
    keys = getattr(ed, "Keys", None) if ed is not None else None

    def _canon(path: str) -> str:
        # CodeWalker EntryDict keys are lowercase and use single backslashes.
        pl = str(path).lower().replace("/", "\\")
        # Collapse any accidental double-backslashes from Python literals / escaping.
        while "\\\\" in pl:
            pl = pl.replace("\\\\", "\\")
        return pl

    def has_key(path: str) -> str:
        if keys is None:
            return "unknown(no EntryDict)"
        pl = _canon(path)
        try:
            # Some IDictionary impls have ContainsKey
            if hasattr(ed, "ContainsKey"):
                return "yes" if bool(ed.ContainsKey(pl)) else "no"
        except Exception as e:
            return f"exc({type(e).__name__}: {e})"
        # fallback: scan keys (slow, but only used for a handful of paths)
        try:
            it = keys.GetEnumerator()
            while it.MoveNext():
                k = str(it.Current)
                if k.lower() == pl:
                    return "yes"
            return "no"
        except Exception as e:
            return f"exc({type(e).__name__}: {e})"

    def try_get_entry(path: str) -> str:
        try:
            e = rm.GetEntry(_canon(path))
            if e is None:
                return "None"
            # Don't touch too many properties; pythonnet can crash on some reflected types.
            try:
                return f"type={type(e).__name__}"
            except Exception:
                return "non-null (type unknown)"
        except Exception as ex:
            return f"EXC({type(ex).__name__}: {ex})"

    def try_get_data(path: str) -> str:
        try:
            b = rm.GetFileData(_canon(path))
            if b is None:
                return "None"
            bb = bytes(b)
            return f"len={len(bb)} head={_hex_head(bb)}"
        except Exception as ex:
            return f"EXC({type(ex).__name__}: {ex})"

    def try_get_text(path: str) -> str:
        try:
            t = rm.GetFileUTF8Text(_canon(path))
            if t is None:
                return "None"
            s = str(t)
            head = s[:80].replace("\n", "\\n").replace("\r", "\\r")
            return f"len={len(s)} head={head!r}"
        except Exception as ex:
            return f"EXC({type(ex).__name__}: {ex})"

    paths = [
        r"update\update.rpf\common\data\dlclist.xml",
        r"common.rpf\data\dlclist.xml",
        r"update\update.rpf\common\data\gta5_cache_y.dat",
        r"update\update2.rpf\common\data\gta5_cache_y.dat",
        r"common.rpf\data\gta5_cache_y.dat",
    ]

    for p in paths:
        print("\nPATH:", p)
        print("  EntryDict has key:", has_key(p))
        print("  GetEntry:", try_get_entry(p))
        print("  GetFileData:", try_get_data(p))
        if p.lower().endswith(".xml"):
            print("  GetFileUTF8Text:", try_get_text(p))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())



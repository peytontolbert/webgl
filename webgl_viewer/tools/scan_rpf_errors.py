#!/usr/bin/env python3
"""
Scan a single .rpf with CodeWalker and surface any scan-time errors with context.

This is useful when export logs show things like:
  "System.Exception: Error in RPF7 file entry."

Usage (from repo root):
  python webgl-gta/webgl_viewer/tools/scan_rpf_errors.py --game-path /data/webglgta/gta5 --rpf /data/webglgta/gta5/update/update.rpf
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-path", required=True, help="GTA root folder (data-only install is OK)")
    ap.add_argument("--rpf", required=True, help="Path to an .rpf file to scan")
    ap.add_argument("--max-errors", type=int, default=50, help="Max error lines to print (default: 50)")
    ap.add_argument("--max-status", type=int, default=10, help="Max status lines to print (default: 10)")
    args = ap.parse_args()

    game_path = str(args.game_path)
    rpf_path = Path(str(args.rpf))
    if not rpf_path.exists():
        raise SystemExit(f"Missing RPF: {rpf_path}")

    # Ensure repo root is importable regardless of CWD
    repo_root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(repo_root))

    # Import CodeWalker via the repo's wrapper (loads DLL + keys + Linux symlink compat)
    from gta5_modules.dll_manager import DllManager  # type: ignore

    dm = DllManager(game_path)
    if not getattr(dm, "initialized", False):
        raise SystemExit("DllManager not initialized (CodeWalker DLL load failed)")

    # CodeWalker .NET Action delegate
    from System import Action  # type: ignore

    errors: list[str] = []
    statuses: list[str] = []

    def _status(msg: str):
        if len(statuses) < int(args.max_status):
            statuses.append(str(msg or ""))

    def _error(msg: str):
        m = str(msg or "")
        if len(errors) < int(args.max_errors):
            errors.append(m)

    # Instantiate a CodeWalker RpfFile and scan it.
    # This uses the same underlying parser that produced the log error.
    try:
        rpf = dm.RpfFile(str(rpf_path), rpf_path.name)
    except Exception as e:
        raise SystemExit(f"Failed to construct RpfFile: {type(e).__name__}: {e}")

    try:
        rpf.ScanStructure(Action[str](_status), Action[str](_error))
    except Exception as e:
        # Some CodeWalker builds throw directly; still report collected error lines.
        errors.append(f"(exception) {type(e).__name__}: {e}")

    print("[scan_rpf_errors] rpf:", str(rpf_path))
    print("[scan_rpf_errors] size_bytes:", rpf_path.stat().st_size)
    print("[scan_rpf_errors] statuses_shown:", len(statuses))
    for s in statuses:
        print("  [status]", s)

    # CodeWalker keeps a LastException field sometimes
    try:
        le = getattr(rpf, "LastException", None)
        if le is not None:
            print("\n[scan_rpf_errors] RpfFile.LastException:")
            print(str(le))
    except Exception:
        pass

    print("\n[scan_rpf_errors] errors_shown:", len(errors))
    for e in errors:
        print("  [error]", e)

    if errors:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



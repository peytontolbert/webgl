#!/usr/bin/env python
"""
Build a lightweight index of GTA V compiled script entries visible through CodeWalker.

This does not decompile or execute YSC bytecode. It records which script archives and
important compiled scripts are present, so the browser spawn resolver can report the
real local source layer without paying the RPF scan cost on every boot.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

from resolve_gta_spawn import REPO_ROOT, game_paths_from_env, read_dotenv


KNOWN_SCRIPT_NAMES = [
    "startup.ysc",
    "main_persistent.ysc",
    "player_controller.ysc",
    "player_controller_b.ysc",
    "respawn_controller.ysc",
    "selector.ysc",
    "freemode.ysc",
    "freemode_init.ysc",
]


def _entry_path(entry: Any) -> str:
    return str(getattr(entry, "Path", "") or getattr(entry, "NameLower", "") or getattr(entry, "Name", "") or "")


def _entry_size(entry: Any) -> int:
    try:
        return int(getattr(entry, "FileSize", 0) or 0)
    except Exception:
        return 0


def _row(entry: Any) -> dict[str, Any]:
    return {
        "path": _entry_path(entry),
        "name": str(getattr(entry, "Name", "") or Path(_entry_path(entry)).name),
        "size": _entry_size(entry),
    }


def build_index(game_path: Path, limit: int = 120) -> dict[str, Any]:
    # CodeWalker scan logging is very noisy; keep stdout clean JSON.
    logging.getLogger().setLevel(logging.CRITICAL)
    logging.getLogger("gta5_modules.dll_manager").setLevel(logging.CRITICAL)
    logging.getLogger("gta5_modules.rpf_reader").setLevel(logging.CRITICAL)

    from gta5_modules.dll_manager import DllManager

    started = time.time()
    dm = DllManager(str(game_path))
    rpfman = dm.get_rpf_manager() if getattr(dm, "initialized", False) else None
    entries = getattr(rpfman, "EntryDict", None) if rpfman else None

    vals: list[Any] = []
    if entries:
        try:
            vals = list(entries.Values)
        except Exception:
            vals = []

    ysc_entries: list[Any] = []
    script_archives: list[Any] = []
    known: list[dict[str, Any]] = []
    known_set = set(KNOWN_SCRIPT_NAMES)

    for ent in vals:
        path = _entry_path(ent)
        low = path.lower()
        name = str(getattr(ent, "Name", "") or "").lower()
        if low.endswith(".ysc"):
            ysc_entries.append(ent)
            if name in known_set:
                known.append(_row(ent))
        if low.endswith(".rpf") and ("\\script\\" in low or "/script/" in low or "script_" in low):
            script_archives.append(ent)

    known.sort(key=lambda r: (str(r.get("name", "")), str(r.get("path", ""))))
    script_archives.sort(key=lambda e: _entry_path(e).lower())
    ysc_entries.sort(key=lambda e: _entry_path(e).lower())

    return {
        "ok": True,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "durationMs": int((time.time() - started) * 1000),
        "gamePath": str(game_path),
        "codewalker": {
            "initialized": bool(getattr(dm, "initialized", False)),
            "gtagen9": bool(getattr(dm, "_gtagen9", False)),
        },
        "entryCount": len(vals),
        "yscCount": len(ysc_entries),
        "scriptArchiveCount": len(script_archives),
        "knownScripts": known[:limit],
        "scriptArchives": [_row(e) for e in script_archives[:limit]],
        "sampleYsc": [_row(e) for e in ysc_entries[:limit]],
        "note": "YSC bytecode is indexed only; decompilation/runtime interpretation is not implemented.",
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-path", default="")
    ap.add_argument("--assets-dir", default=str(REPO_ROOT / "webgl_viewer" / "assets"))
    ap.add_argument("--out", default="")
    ap.add_argument("--limit", type=int, default=120)
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    env = {**read_dotenv(REPO_ROOT / ".env"), **os.environ}
    if args.game_path:
        game_path = Path(args.game_path).expanduser().resolve()
    else:
        paths = [p for p in game_paths_from_env(env) if p.exists() and p.is_dir()]
        if not paths:
            raise SystemExit("No GTA path found. Set gta5_path/gta_location in .env or pass --game-path.")
        game_path = paths[0]

    data = build_index(game_path, max(1, int(args.limit)))

    out = Path(args.out).expanduser() if args.out else Path(args.assets_dir) / "runtime_script_index.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, indent=2 if args.pretty else None), encoding="utf-8")
    print(json.dumps({"ok": True, "out": str(out.resolve()), "yscCount": data["yscCount"], "durationMs": data["durationMs"]}))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Match unresolved drawable texture hashes against loose FiveM YTD resources."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from gta5_modules.dll_manager import DllManager
from gta5_modules.hash_utils import joaat
from webgl_viewer.tools.import_fivem_mlo_demo import _texture_items


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-path", type=Path, required=True)
    parser.add_argument("--need", type=Path, required=True)
    parser.add_argument("--resource-dir", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    need_data = _load_json(args.need.resolve())
    wanted = {str(row.get("hash")): str(row.get("name") or "") for row in need_data.get("textures", [])}
    if not wanted:
        raise RuntimeError("Need report contains no texture hashes")

    logging.disable(logging.CRITICAL)
    dll = DllManager(str(args.game_path.resolve()))
    if not getattr(dll, "initialized", False):
        raise RuntimeError("CodeWalker initialization failed")

    matches: dict[str, list[dict[str, Any]]] = {}
    dictionaries: list[dict[str, Any]] = []
    for resource in [path.resolve() for path in args.resource_dir]:
        for path in sorted(resource.rglob("*.ytd")):
            ytd = dll.YtdFile()
            ytd.Load(path.read_bytes())
            names = sorted({str(getattr(item, "Name", "") or "").strip() for item in _texture_items(ytd)})
            names = [name for name in names if name]
            matched = []
            for name in names:
                hash_id = str(int(joaat(name, lower=True)) & 0xFFFFFFFF)
                if hash_id not in wanted:
                    continue
                record = {
                    "wantedName": wanted[hash_id],
                    "actualName": name,
                    "resource": str(resource),
                    "ytd": path.relative_to(resource).as_posix(),
                }
                matches.setdefault(hash_id, []).append(record)
                matched.append(hash_id)
            dictionaries.append({
                "resource": str(resource),
                "ytd": path.relative_to(resource).as_posix(),
                "bytes": path.stat().st_size,
                "textureCount": len(names),
                "matchedHashes": sorted(matched, key=int),
            })

    unresolved = sorted(set(wanted).difference(matches), key=int)
    report = {
        "schema": "webglgta-fivem-texture-dependency-audit-v1",
        "wantedHashCount": len(wanted),
        "matchedHashCount": len(matches),
        "unresolvedHashCount": len(unresolved),
        "matches": matches,
        "unresolved": [{"hash": hash_id, "name": wanted[hash_id]} for hash_id in unresolved],
        "dictionaries": dictionaries,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("wantedHashCount", "matchedHashCount", "unresolvedHashCount")}, indent=2))
    return 0 if not unresolved else 2


if __name__ == "__main__":
    raise SystemExit(main())

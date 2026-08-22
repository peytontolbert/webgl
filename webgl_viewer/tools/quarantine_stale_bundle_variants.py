#!/usr/bin/env python3
"""Keep one bundle entry and its transitive JavaScript dependencies."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import shutil


JS_REF = re.compile(r"(?P<file>[A-Za-z_][A-Za-z0-9_.-]*-[A-Za-z0-9_-]+\.js)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("quarantine", type=Path)
    parser.add_argument("--entry", default="main-live.js")
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    bundle = args.bundle.resolve()
    quarantine = args.quarantine.resolve()
    if quarantine == bundle or bundle in quarantine.parents:
        parser.error("quarantine must be outside the bundle directory")
    entry = bundle / args.entry
    if not entry.is_file():
        parser.error(f"entry is missing: {entry}")

    active: set[Path] = set()
    queue = [entry]
    missing: list[str] = []
    while queue:
        source = queue.pop()
        if source in active:
            continue
        active.add(source)
        text = source.read_text(encoding="utf-8")
        for match in JS_REF.finditer(text):
            dependency = bundle / match.group("file")
            if dependency.is_file():
                if dependency not in active:
                    queue.append(dependency)
            else:
                missing.append(match.group("file"))
    for source in list(active):
        sidecar = Path(f"{source}.br")
        if sidecar.is_file():
            active.add(sidecar)

    candidates = sorted(path for path in bundle.iterdir() if path.is_file())
    stale = [path for path in candidates if path not in active]
    stale_bytes = sum(path.stat().st_size for path in stale)
    moved = 0
    if args.write and not missing:
        quarantine.mkdir(parents=True, exist_ok=True)
        for source in stale:
            destination = quarantine / source.name
            if destination.exists():
                raise FileExistsError(f"quarantine destination exists: {destination}")
            shutil.move(str(source), str(destination))
            moved += 1

    report = {
        "schema": "webglgta-stale-bundle-quarantine-v1",
        "bundle": str(bundle), "entry": args.entry, "write": args.write,
        "active": sorted(path.name for path in active), "missingDependencies": sorted(set(missing)),
        "stale": [path.name for path in stale], "staleBytes": stale_bytes,
        "moved": moved,
    }
    encoded = json.dumps(report, indent=2, sort_keys=True)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)
    return 1 if missing else 0


if __name__ == "__main__":
    raise SystemExit(main())

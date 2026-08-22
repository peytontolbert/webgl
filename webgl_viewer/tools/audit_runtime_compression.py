#!/usr/bin/env python3
"""Audit storage and HTTP-sidecar compression coverage for a runtime asset tree.

This is intentionally metadata-only: it uses directory entries and file sizes,
never reads large payloads into memory.  The report distinguishes formats that
benefit from transport compression from media/container formats that are already
compressed internally.
"""

from __future__ import annotations

import argparse
import json
import os
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


TRANSPORT_COMPRESSIBLE = {
    ".bin", ".css", ".csv", ".glsl", ".html", ".js", ".json",
    ".ncv", ".nrb", ".svg", ".txt", ".wasm", ".xml",
}
INTERNALLY_COMPRESSED = {
    ".7z", ".avif", ".br", ".flac", ".gif", ".gz", ".jpeg", ".jpg",
    ".ktx2", ".m4a", ".mp3", ".mp4", ".ogg", ".png", ".tgz", ".webm",
    ".webp", ".zip",
}
BACKUP_MARKERS = (".before-", ".pre-", ".bak", ".backup", ".old", ".orig", ".tmp")


def family(relative: str) -> str:
    parts = relative.replace("\\", "/").split("/")
    if parts[0] == "assets" and len(parts) > 2:
        return f"assets/{parts[1]}"
    return parts[0] if len(parts) > 1 else "[root]"


def scan(root: Path, *, verify_json: bool = False) -> dict[str, Any]:
    rows: dict[str, os.stat_result] = {}
    for directory, _dirs, names in os.walk(root):
        base = Path(directory)
        for name in names:
            path = base / name
            try:
                stat = path.stat()
            except OSError:
                continue
            if stat.st_size < 0 or not path.is_file():
                continue
            rows[path.relative_to(root).as_posix()] = stat

    by_family: dict[str, Counter[str]] = defaultdict(Counter)
    by_extension: dict[str, Counter[str]] = defaultdict(Counter)
    family_extensions: dict[str, dict[str, Counter[str]]] = defaultdict(lambda: defaultdict(Counter))
    missing_sidecars: list[dict[str, Any]] = []
    stale_sidecars: list[dict[str, Any]] = []
    ineffective_sidecars: list[dict[str, Any]] = []
    backups: list[dict[str, Any]] = []
    zero_files: list[str] = []
    hardlink_groups: dict[tuple[int, int], list[str]] = defaultdict(list)
    physical_keys: set[tuple[int, int]] = set()

    for relative, stat in rows.items():
        lower = relative.lower()
        suffix = Path(lower).suffix or "[none]"
        group = family(relative)
        by_family[group]["files"] += 1
        by_family[group]["logicalBytes"] += stat.st_size
        by_extension[suffix]["files"] += 1
        by_extension[suffix]["bytes"] += stat.st_size
        family_extensions[group][suffix]["files"] += 1
        family_extensions[group][suffix]["bytes"] += stat.st_size
        inode_key = (int(stat.st_dev), int(stat.st_ino))
        physical_keys.add(inode_key)
        if stat.st_nlink > 1:
            hardlink_groups[inode_key].append(relative)
        if stat.st_size == 0:
            zero_files.append(relative)
        if any(marker in lower for marker in BACKUP_MARKERS):
            backups.append({"path": relative, "bytes": stat.st_size})

        if suffix not in TRANSPORT_COMPRESSIBLE or lower.endswith(".br"):
            continue
        if stat.st_size < 16_384:
            by_family[group]["belowThresholdFiles"] += 1
            by_family[group]["belowThresholdBytes"] += stat.st_size
            continue
        by_family[group]["eligibleFiles"] += 1
        by_family[group]["eligibleBytes"] += stat.st_size
        sidecar_relative = f"{relative}.br"
        sidecar = rows.get(sidecar_relative)
        if sidecar is None:
            by_family[group]["missingSidecarFiles"] += 1
            by_family[group]["missingSidecarBytes"] += stat.st_size
            missing_sidecars.append({"path": relative, "bytes": stat.st_size, "family": group})
            continue
        if sidecar.st_mtime_ns < stat.st_mtime_ns:
            by_family[group]["staleSidecarFiles"] += 1
            by_family[group]["staleSidecarBytes"] += stat.st_size
            stale_sidecars.append({"path": relative, "bytes": stat.st_size, "sidecarBytes": sidecar.st_size, "family": group})
            continue
        if sidecar.st_size >= stat.st_size:
            by_family[group]["ineffectiveSidecarFiles"] += 1
            ineffective_sidecars.append({"path": relative, "bytes": stat.st_size, "sidecarBytes": sidecar.st_size, "family": group})
            continue
        by_family[group]["coveredFiles"] += 1
        by_family[group]["coveredSourceBytes"] += stat.st_size
        by_family[group]["coveredTransferBytes"] += sidecar.st_size

    physical_bytes = 0
    seen_physical: set[tuple[int, int]] = set()
    for stat in rows.values():
        key = (int(stat.st_dev), int(stat.st_ino))
        if key in seen_physical:
            continue
        seen_physical.add(key)
        physical_bytes += stat.st_size

    family_report: dict[str, Any] = {}
    for name, counts in sorted(by_family.items()):
        eligible = counts["eligibleFiles"]
        covered = counts["coveredFiles"]
        source_bytes = counts["coveredSourceBytes"]
        transfer_bytes = counts["coveredTransferBytes"]
        family_report[name] = {
            **dict(counts),
            "sidecarCoverage": round(covered / eligible, 6) if eligible else 1.0,
            "coveredReduction": round(1 - transfer_bytes / source_bytes, 6) if source_bytes else 0.0,
        }

    logical_bytes = sum(stat.st_size for stat in rows.values())
    eligible_files = sum(row["eligibleFiles"] for row in by_family.values())
    covered_files = sum(row["coveredFiles"] for row in by_family.values())
    json_files = 0
    json_parse_errors: list[dict[str, str]] = []
    if verify_json:
        for relative in sorted(rows):
            lower = relative.lower()
            if not lower.endswith(".json") or any(marker in lower for marker in BACKUP_MARKERS):
                continue
            json_files += 1
            try:
                with (root / relative).open("r", encoding="utf-8") as stream:
                    json.load(stream)
            except Exception as error:
                json_parse_errors.append({"path": relative, "error": str(error)})

    report = {
        "schema": "webglgta-runtime-compression-audit-v1",
        "root": str(root),
        "files": len(rows),
        "logicalBytes": logical_bytes,
        "physicalBytes": physical_bytes,
        "hardlinkSavedBytes": logical_bytes - physical_bytes,
        "eligibleFiles": eligible_files,
        "coveredFiles": covered_files,
        "sidecarCoverage": round(covered_files / eligible_files, 6) if eligible_files else 1.0,
        "missingSidecarFiles": len(missing_sidecars),
        "staleSidecarFiles": len(stale_sidecars),
        "ineffectiveSidecarFiles": len(ineffective_sidecars),
        "internallyCompressedFiles": sum(v["files"] for k, v in by_extension.items() if k in INTERNALLY_COMPRESSED),
        "zeroByteFiles": len(zero_files),
        "backupFiles": len(backups),
        "jsonVerification": {
            "enabled": verify_json,
            "files": json_files,
            "parseErrors": json_parse_errors,
        },
        "families": family_report,
        "extensions": {key: dict(value) for key, value in sorted(by_extension.items())},
        "familyExtensions": {
            group: {extension: dict(counts) for extension, counts in sorted(extensions.items())}
            for group, extensions in sorted(family_extensions.items())
        },
        "largestMissingSidecars": sorted(missing_sidecars, key=lambda row: row["bytes"], reverse=True)[:100],
        "largestStaleSidecars": sorted(stale_sidecars, key=lambda row: row["bytes"], reverse=True)[:100],
        "ineffectiveSidecars": sorted(ineffective_sidecars, key=lambda row: row["bytes"], reverse=True)[:100],
        "zeroByteSamples": sorted(zero_files)[:100],
        "backupPayloads": sorted(backups, key=lambda row: row["bytes"], reverse=True)[:100],
        "hardlinkGroups": [
            {"paths": sorted(paths), "linksSeen": len(paths), "bytesEach": rows[paths[0]].st_size}
            for paths in hardlink_groups.values() if len(paths) > 1
        ][:100],
    }
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--verify-json", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    if not root.is_dir():
        parser.error(f"asset root does not exist: {root}")
    report = scan(root, verify_json=args.verify_json)
    encoded = json.dumps(report, indent=2)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)
    return 1 if report["jsonVerification"]["parseErrors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())

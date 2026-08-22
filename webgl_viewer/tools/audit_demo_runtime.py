#!/usr/bin/env python3
"""Run the canonical top-down release, compression, MLO, and track audits."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


def run_json(command: list[str]) -> tuple[dict[str, Any], int]:
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    if not result.stdout.strip():
        return {"ok": False, "command": command, "error": result.stderr.strip() or "no JSON output"}, result.returncode or 1
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        return {"ok": False, "command": command, "error": str(error), "stdout": result.stdout[-2000:], "stderr": result.stderr[-2000:]}, 1
    return payload, result.returncode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist-root", type=Path, required=True, help="Directory containing assets/, bundled/, and index.html")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    dist = args.dist_root.resolve()
    assets = dist / "assets"
    tools = Path(__file__).resolve().parent
    descriptor_path = assets / "demo/spawn_district.json"
    if not descriptor_path.is_file():
        parser.error(f"missing district descriptor: {descriptor_path}")
    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
    manifest = assets / str(descriptor.get("manifestFile") or "demo/spawn_district_models_bootstrap_v1.json")
    entities = assets / str(descriptor.get("instanceFile") or "demo/spawn_district_entities_mlo.bin")

    checks: dict[str, Any] = {}
    exit_codes: dict[str, int] = {}
    commands = {
        "releaseClosure": [sys.executable, str(tools / "validate_demo_release.py"), str(assets)],
        "compression": [sys.executable, str(tools / "audit_runtime_compression.py"), str(dist), "--verify-json"],
        "mlo": [
            "node", str(tools / "audit_mlo_coverage.mjs"),
            "--descriptor", str(descriptor_path), "--entities", str(entities), "--manifest", str(manifest),
            "--interiors", str(assets / "interiors"), "--interactables", str(assets / "demo/interactables.json"),
            "--asset-root", str(assets),
        ],
        "trackBalanced": [
            sys.executable, str(tools / "audit_track_lod_texture_coverage.py"),
            str(assets / "tracks/nordschleife/scene/scene.json"), "--web-root", str(dist),
        ],
        "trackFull": [
            sys.executable, str(tools / "audit_track_lod_texture_coverage.py"),
            str(assets / "tracks/nordschleife/scene_full_v3/scene.json"), "--web-root", str(dist),
        ],
    }
    for name, command in commands.items():
        checks[name], exit_codes[name] = run_json(command)

    ok = all(code == 0 for code in exit_codes.values()) and all(
        check.get("ok", True) is not False for check in checks.values()
    )
    report = {
        "schema": "webglgta-demo-topdown-audit-v1",
        "ok": ok,
        "distRoot": str(dist),
        "exitCodes": exit_codes,
        "summary": {
            "entityCountsConsistent": checks["releaseClosure"].get("entityCountsConsistent"),
            "referencedFiles": checks["releaseClosure"].get("referencedFiles"),
            "missingReferences": len(checks["releaseClosure"].get("missingReferences") or {}),
            "invalidPackRanges": len(checks["releaseClosure"].get("invalidPackRanges") or []),
            "compressionCoverage": checks["compression"].get("sidecarCoverage"),
            "jsonParseErrors": len((checks["compression"].get("jsonVerification") or {}).get("parseErrors") or []),
            "mloCoverage": checks["mlo"].get("ok"),
            "balancedTrackCoverage": checks["trackBalanced"].get("ok"),
            "fullTrackCoverage": checks["trackFull"].get("ok"),
        },
        "checks": checks,
    }
    encoded = json.dumps(report, indent=2)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

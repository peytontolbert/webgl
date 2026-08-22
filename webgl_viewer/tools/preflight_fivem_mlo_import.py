#!/usr/bin/env python3
"""Validate a host before importing a loose FiveM MLO for the browser demo."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
REQUIRED_RESOURCE_TYPES = (".ymap", ".ytyp", ".ydr", ".ytd", ".ybn")
REQUIRED_CODEWALKER_FILES = (
    "CodeWalker.Core.dll",
    "SharpDX.dll",
    "SharpDX.Direct3D11.dll",
    "SharpDX.DXGI.dll",
    "SharpDX.Mathematics.dll",
)


def _command_version(command: str, *args: str) -> str | None:
    path = shutil.which(command)
    if not path:
        return None
    result = subprocess.run((path, *args), capture_output=True, text=True, check=False)
    output = (result.stdout or result.stderr).strip().splitlines()
    return output[0] if output else path


def _writable_target(path: Path) -> bool:
    current = path.resolve()
    while not current.exists() and current != current.parent:
        current = current.parent
    return current.is_dir() and os.access(current, os.W_OK)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resource-dir", type=Path, required=True)
    parser.add_argument("--game-path", type=Path, default=None)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "work" / "mlo-import")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    resource_dir = args.resource_dir.resolve()
    game_path = args.game_path.resolve() if args.game_path else None
    compiled_cw = ROOT / "compiled_cw"
    cli_dll = ROOT / "CodeWalker.Cli" / "bin" / "Release" / "net8.0" / "CodeWalker.Cli.dll"
    counts = {
        suffix: len(list(resource_dir.rglob(f"*{suffix}"))) if resource_dir.is_dir() else 0
        for suffix in REQUIRED_RESOURCE_TYPES
    }
    ytd_files = sorted(resource_dir.rglob("*.ytd")) if resource_dir.is_dir() else []
    empty_ytds = [
        {"path": path.relative_to(resource_dir).as_posix(), "bytes": path.stat().st_size}
        for path in ytd_files
        if path.stat().st_size <= 128
    ]

    errors: list[str] = []
    warnings: list[str] = []
    if not resource_dir.is_dir():
        errors.append(f"resource directory does not exist: {resource_dir}")
    for suffix in (".ymap", ".ytyp", ".ydr"):
        if counts[suffix] == 0:
            errors.append(f"resource has no {suffix} files")
    if counts[".ytd"] == 0:
        warnings.append("resource has no YTD texture dictionaries")
    elif len(empty_ytds) == counts[".ytd"]:
        warnings.append("all YTD texture dictionaries are empty placeholders")
    if counts[".ybn"] == 0:
        warnings.append("resource has no YBN collision")

    missing_codewalker = [name for name in REQUIRED_CODEWALKER_FILES if not (compiled_cw / name).is_file()]
    if missing_codewalker:
        errors.append("missing CodeWalker assemblies: " + ", ".join(missing_codewalker))
    if not cli_dll.is_file():
        errors.append(f"missing metadata exporter: {cli_dll}")
    for module in ("numpy", "PIL", "pythonnet"):
        if importlib.util.find_spec(module) is None:
            errors.append(f"missing Python module: {module}")
    if not _writable_target(args.output_dir):
        errors.append(f"output directory is not writable: {args.output_dir.resolve()}")

    gta = {"configured": game_path is not None, "path": str(game_path) if game_path else None}
    if game_path is None:
        errors.append("base GTA path is not configured; pass --game-path")
    elif not game_path.is_dir():
        errors.append(f"base GTA path does not exist: {game_path}")
    else:
        executables = [path.name for path in game_path.iterdir() if path.is_file() and path.name.lower().startswith("gta5") and path.suffix.lower() == ".exe"]
        gta.update({
            "executables": executables,
            "commonRpf": (game_path / "common.rpf").is_file(),
            "updateRpf": (game_path / "update" / "update.rpf").is_file(),
        })
        if not executables:
            errors.append("base GTA path has no GTA5 executable for CodeWalker keys")
        if not gta["commonRpf"] or not gta["updateRpf"]:
            errors.append("base GTA path is missing common.rpf or update/update.rpf")

    report = {
        "ready": not errors,
        "root": str(ROOT),
        "resourceDir": str(resource_dir),
        "resourceFiles": counts,
        "emptyTextureDictionaries": empty_ytds,
        "outputDir": str(args.output_dir.resolve()),
        "python": sys.version.split()[0],
        "dotnet": _command_version("dotnet", "--version"),
        "mono": _command_version("mono", "--version"),
        "metadataExporter": str(cli_dll),
        "gta": gta,
        "errors": errors,
        "warnings": warnings,
    }
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("MLO importer preflight: " + ("READY" if report["ready"] else "BLOCKED"))
        print(json.dumps(report, indent=2))
    return 0 if report["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Build a validated file list for the demo district's uncompressed textures."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

from PIL import Image


TEXTURE_REF_RE = re.compile(r"^models_textures/(?P<name>[^/]+)$", re.IGNORECASE)
TEXTURE_HASH_RE = re.compile(r"^(?P<hash>\d+)(?:_[^.]+)?\.[A-Za-z0-9]+$")
CONSOLE_REF_RE = re.compile(r"assets/models_textures/(?P<name>[A-Za-z0-9_.-]+)")


def walk_refs(value: Any, output: set[str]) -> None:
    if isinstance(value, dict):
        for child in value.values():
            walk_refs(child, output)
    elif isinstance(value, list):
        for child in value:
            walk_refs(child, output)
    elif isinstance(value, str) and TEXTURE_REF_RE.match(value):
        output.add(value)


def valid_image(path: Path) -> bool:
    if not path.is_file() or path.stat().st_size == 0:
        return False
    try:
        with Image.open(path) as image:
            image.verify()
        return True
    except Exception:
        return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--viewer-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
    )
    parser.add_argument("--console-log", type=Path)
    parser.add_argument("--file-list", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()

    root = args.viewer_root.resolve()
    assets = root / "assets"
    texture_dir = assets / "models_textures"
    manifest_path = assets / "demo" / "spawn_district_models.json"
    index_path = texture_dir / "index.json"

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    index = json.loads(index_path.read_text(encoding="utf-8"))
    by_hash = index.get("byHash", {})

    refs: set[str] = set()
    walk_refs(manifest, refs)
    console_names: set[str] = set()
    if args.console_log:
        text = args.console_log.read_text(encoding="utf-8", errors="ignore")
        console_names.update(match.group("name") for match in CONSOLE_REF_RE.finditer(text))

    selected: set[Path] = set()
    unresolved: list[str] = []
    invalid: list[str] = []

    for relative in sorted(refs):
        name = TEXTURE_REF_RE.match(relative).group("name")
        direct = texture_dir / name
        candidates = [direct]
        hash_match = TEXTURE_HASH_RE.match(name)
        if hash_match:
            entry = by_hash.get(hash_match.group("hash"), {})
            for indexed_name in entry.get("files", []):
                candidates.append(texture_dir / indexed_name)

        valid_candidates = {candidate for candidate in candidates if valid_image(candidate)}
        if not valid_candidates:
            unresolved.append(relative)
            if direct.exists():
                invalid.append(relative)
            continue
        selected.update(valid_candidates)

    missing_console: list[str] = []
    for name in sorted(console_names):
        path = texture_dir / name
        if valid_image(path):
            selected.add(path)
        else:
            missing_console.append(name)

    relative_files = sorted(path.relative_to(root).as_posix() for path in selected)
    relative_files.append(index_path.relative_to(root).as_posix())
    args.file_list.parent.mkdir(parents=True, exist_ok=True)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.file_list.write_text("\n".join(relative_files) + "\n", encoding="utf-8")

    report = {
        "schema": "webglgta-demo-source-texture-bundle-v1",
        "manifestReferences": len(refs),
        "consoleReferences": len(console_names),
        "selectedTextures": len(selected),
        "selectedBytes": sum(path.stat().st_size for path in selected),
        "unresolvedManifestReferences": unresolved,
        "invalidManifestReferences": invalid,
        "missingConsoleTextures": missing_console,
    }
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 1 if missing_console else 0


if __name__ == "__main__":
    raise SystemExit(main())

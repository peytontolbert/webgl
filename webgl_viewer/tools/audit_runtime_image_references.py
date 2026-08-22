#!/usr/bin/env python3
"""Audit legacy raster references across every JSON file in a served asset tree.

Unlike the demo dependency-closure validator, this intentionally scans all JSON
manifests and indexes. Runtime subsystems such as custom vehicles, clothing and
inventory load some of those files by convention, so they cannot be discovered
reliably by walking only the world descriptor.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import re
from typing import Any, Iterator


LEGACY_IMAGE_RE = re.compile(r"(?i)\.(?:png|jpe?g)(?:\?[^#]*)?(?:#.*)?$")
WEBP_RE = re.compile(r"(?i)\.(?:png|jpe?g)(?=(?:\?[^#]*)?(?:#.*)?$)")


def iter_strings(value: Any, json_path: str = "$") -> Iterator[tuple[str, str, str]]:
    if isinstance(value, dict):
        for key, child in value.items():
            path = f"{json_path}.{key}"
            if isinstance(child, str):
                yield str(key), child, path
            else:
                yield from iter_strings(child, path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            path = f"{json_path}[{index}]"
            if isinstance(child, str):
                yield "", child, path
            else:
                yield from iter_strings(child, path)


def clean_reference(value: str) -> str:
    clean = value.replace("\\", "/").strip()
    clean = clean.split("#", 1)[0].split("?", 1)[0]
    clean = clean.removeprefix("/").removeprefix("assets/")
    return clean


def resolve_reference(assets_root: Path, manifest: Path, value: str) -> Path:
    clean = clean_reference(value)
    # Asset references used by the renderer are rooted at the assets mount.
    # Plain filenames in UI catalogs are conventionally local to their index.
    if "/" in clean:
        return assets_root / clean
    return manifest.parent / clean


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("assets", type=Path, help="Served assets directory")
    parser.add_argument("--report", type=Path, default=None)
    parser.add_argument("--samples", type=int, default=100)
    args = parser.parse_args()

    root = args.assets.resolve()
    manifests = sorted(path for path in root.rglob("*.json") if path.is_file())
    parse_errors: list[dict[str, str]] = []
    occurrences: list[dict[str, Any]] = []
    by_reference: dict[str, dict[str, Any]] = {}
    roles: dict[str, set[str]] = defaultdict(set)

    for manifest in manifests:
        rel_manifest = manifest.relative_to(root).as_posix()
        try:
            payload = json.loads(manifest.read_text(encoding="utf-8"))
        except Exception as error:
            parse_errors.append({"manifest": rel_manifest, "error": str(error)})
            continue
        for key, value, json_path in iter_strings(payload):
            if not LEGACY_IMAGE_RE.search(value):
                continue
            clean = clean_reference(value)
            source = resolve_reference(root, manifest, value)
            target_value = WEBP_RE.sub(".webp", value)
            target = resolve_reference(root, manifest, target_value)
            entry = {
                "manifest": rel_manifest,
                "jsonPath": json_path,
                "key": key,
                "reference": value,
                "cleanReference": clean,
                "source": source.relative_to(root).as_posix() if source.is_relative_to(root) else str(source),
                "sourceExists": source.is_file(),
                "webp": target.relative_to(root).as_posix() if target.is_relative_to(root) else str(target),
                "webpExists": target.is_file(),
            }
            occurrences.append(entry)
            roles[clean].add(key.lower())
            summary = by_reference.setdefault(clean, {
                "reference": clean,
                "source": entry["source"],
                "sourceExists": entry["sourceExists"],
                "webp": entry["webp"],
                "webpExists": entry["webpExists"],
                "occurrences": 0,
                "manifests": set(),
            })
            summary["occurrences"] += 1
            summary["manifests"].add(rel_manifest)

    references = []
    for clean, entry in sorted(by_reference.items()):
        references.append({
            **entry,
            "manifests": sorted(entry["manifests"]),
            "roles": sorted(roles[clean]),
        })

    report = {
        "schema": "webglgta-runtime-image-reference-audit-v1",
        "assetsRoot": str(root),
        "jsonFiles": len(manifests),
        "jsonParseErrors": parse_errors,
        "legacyOccurrences": len(occurrences),
        "legacyUniqueReferences": len(references),
        "legacyUniqueByExtension": dict(sorted(Counter(Path(row["reference"]).suffix.lower() for row in references).items())),
        "sourceMissing": sum(not row["sourceExists"] for row in references),
        "webpAlreadyExists": sum(row["webpExists"] for row in references),
        "webpNeedsEncoding": sum(row["sourceExists"] and not row["webpExists"] for row in references),
        "unresolvable": [row for row in references if not row["sourceExists"] and not row["webpExists"]],
        "references": references,
        "occurrenceSamples": occurrences[: max(0, args.samples)],
    }
    encoded = json.dumps(report, indent=2, sort_keys=True)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)
    return 1 if parse_errors or report["unresolvable"] else 0


if __name__ == "__main__":
    raise SystemExit(main())

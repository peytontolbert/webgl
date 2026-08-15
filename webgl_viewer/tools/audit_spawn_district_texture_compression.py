#!/usr/bin/env python3
"""Validate the compressed spawn-district texture pack against its source manifest."""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageStat


COLOR_KEYS = {"diffuse", "foliagediffuse", "diffuse2", "emissive", "env", "tintpalette"}


def collect_pairs(source: Any, compressed: Any, pairs: list[tuple[str, str, str]], key: str = "") -> None:
    if isinstance(source, dict) and isinstance(compressed, dict):
        for child_key, child in source.items():
            if child_key in compressed:
                collect_pairs(child, compressed[child_key], pairs, str(child_key).lower())
        return
    if isinstance(source, list) and isinstance(compressed, list):
        for left, right in zip(source, compressed):
            collect_pairs(left, right, pairs, key)
        return
    if isinstance(source, str) and source.startswith("models_textures/"):
        pairs.append((source, str(compressed), key))


def image_metrics(expected: Image.Image, actual: Image.Image) -> dict[str, Any]:
    diff = ImageChops.difference(expected, actual)
    stat = ImageStat.Stat(diff)
    count = max(1, expected.width * expected.height)
    rms = [math.sqrt(value / count) for value in stat.sum2]
    extrema = diff.getextrema()
    return {
        "rmse": [round(value, 3) for value in rms],
        "maxError": [int(value[1]) for value in extrema],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    root = Path(__file__).resolve().parents[1]
    parser.add_argument("--assets-dir", type=Path, default=root / "assets")
    parser.add_argument("--report", type=Path, default=root / "assets" / "demo" / "texture_compression_audit.json")
    args = parser.parse_args()

    assets = args.assets_dir.resolve()
    source_manifest = json.loads((assets / "demo" / "spawn_district_models.json").read_text(encoding="utf-8"))
    compressed_manifest = json.loads((assets / "demo" / "spawn_district_models_compressed_v2.json").read_text(encoding="utf-8"))
    pairs: list[tuple[str, str, str]] = []
    collect_pairs(source_manifest, compressed_manifest, pairs)

    roles_by_source: dict[str, set[str]] = defaultdict(set)
    target_by_source: dict[str, set[str]] = defaultdict(set)
    for source, target, role in pairs:
        roles_by_source[source].add(role)
        target_by_source[source].add(target)

    structural_errors: list[dict[str, Any]] = []
    quality_warnings: list[dict[str, Any]] = []
    metrics_by_role: dict[str, list[float]] = defaultdict(list)
    decoded = 0
    alpha_exact = 0
    missing_source = 0
    unchanged_missing = 0

    for source_relative, roles in sorted(roles_by_source.items()):
        targets = target_by_source[source_relative]
        source_path = assets / source_relative
        if not source_path.is_file():
            missing_source += 1
            if targets == {source_relative}:
                unchanged_missing += 1
            else:
                structural_errors.append({"source": source_relative, "error": "missing source was rewritten"})
            continue
        if len(targets) != 1:
            structural_errors.append({"source": source_relative, "error": "inconsistent target mapping", "targets": sorted(targets)})
            continue
        target_relative = next(iter(targets))
        if not target_relative.startswith("demo/models_textures"):
            structural_errors.append({"source": source_relative, "error": "available source was not rewritten", "target": target_relative})
            continue
        target_path = assets / target_relative
        if not target_path.is_file():
            structural_errors.append({"source": source_relative, "error": "compressed target missing", "target": target_relative})
            continue

        try:
            with Image.open(source_path) as opened:
                source_image = opened.convert("RGBA")
            with Image.open(target_path) as opened:
                target_image = opened.convert("RGBA")
                target_format = opened.format
        except Exception as error:
            structural_errors.append({"source": source_relative, "target": target_relative, "error": f"decode failed: {error}"})
            continue

        cap = 512 if roles & COLOR_KEYS else 256
        expected = source_image
        if max(expected.size) > cap:
            scale = cap / max(expected.size)
            expected = expected.resize(
                (max(1, round(expected.width * scale)), max(1, round(expected.height * scale))),
                Image.Resampling.LANCZOS,
            )
        if target_format != "WEBP" or target_image.size != expected.size:
            structural_errors.append({
                "source": source_relative,
                "target": target_relative,
                "error": "format or dimensions differ",
                "expectedSize": expected.size,
                "actualSize": target_image.size,
                "format": target_format,
            })
            continue

        decoded += 1
        metrics = image_metrics(expected, target_image)
        alpha_error = metrics["maxError"][3]
        if alpha_error == 0:
            alpha_exact += 1
        else:
            structural_errors.append({
                "source": source_relative,
                "target": target_relative,
                "error": "alpha channel changed",
                "alphaMaxError": alpha_error,
                "roles": sorted(roles),
            })
        rgb_rmse = sum(metrics["rmse"][:3]) / 3
        for role in roles:
            metrics_by_role[role].append(rgb_rmse)
        if not roles & COLOR_KEYS and (rgb_rmse > 2.0 or max(metrics["maxError"][:3]) > 16):
            quality_warnings.append({
                "source": source_relative,
                "target": target_relative,
                "roles": sorted(roles),
                **metrics,
            })

    report = {
        "schema": "webglgta-demo-texture-compression-audit-v1",
        "referenceOccurrences": len(pairs),
        "uniqueSources": len(roles_by_source),
        "roles": dict(sorted(Counter(role for _, _, role in pairs).items())),
        "decodedTargets": decoded,
        "alphaExactTargets": alpha_exact,
        "missingSources": missing_source,
        "unchangedMissingReferences": unchanged_missing,
        "structuralErrorCount": len(structural_errors),
        "dataQualityWarningCount": len(quality_warnings),
        "averageRgbRmseByRole": {
            role: round(sum(values) / len(values), 3) for role, values in sorted(metrics_by_role.items()) if values
        },
        "structuralErrors": structural_errors[:100],
        "dataQualityWarnings": sorted(quality_warnings, key=lambda row: max(row["maxError"][:3]), reverse=True)[:100],
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key not in {"structuralErrors", "dataQualityWarnings"}}, indent=2))
    return 1 if structural_errors else 0


if __name__ == "__main__":
    raise SystemExit(main())

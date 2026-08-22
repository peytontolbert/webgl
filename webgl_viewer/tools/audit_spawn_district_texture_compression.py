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

from compress_spawn_district_textures import build_texture_source_index, resolve_texture_source


COLOR_KEYS = {"diffuse", "foliagediffuse", "diffuse2", "emissive", "env"}


def collect_pairs(source: Any, compressed: Any, pairs: list[tuple[str, str | None, str]], key: str = "") -> None:
    if isinstance(source, dict) and isinstance(compressed, dict):
        for child_key, child in source.items():
            collect_pairs(child, compressed.get(child_key), pairs, str(child_key).lower())
        return
    if isinstance(source, list) and isinstance(compressed, list):
        for left, right in zip(source, compressed):
            collect_pairs(left, right, pairs, key)
        return
    if isinstance(source, str) and source.startswith("models_textures/"):
        pairs.append((source, compressed if isinstance(compressed, str) else None, key))


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
    parser.add_argument(
        "--source-assets-dir",
        type=Path,
        action="append",
        default=[],
        help="Additional read-only texture roots. Repeatable.",
    )
    parser.add_argument("--demo-dir", type=Path, default=None)
    parser.add_argument("--report", type=Path, default=None)
    parser.add_argument("--source-manifest", default="spawn_district_models_mlo.json")
    args = parser.parse_args()

    assets = args.assets_dir.resolve()
    source_roots = [assets, *(path.resolve() for path in args.source_assets_dir)]
    demo_dir = args.demo_dir.resolve() if args.demo_dir else assets / "demo"
    source_path = Path(args.source_manifest)
    if not source_path.is_absolute():
        source_path = demo_dir / source_path.name
    source_manifest = json.loads(source_path.read_text(encoding="utf-8"))
    compressed_manifest = json.loads((demo_dir / "spawn_district_models_compressed_v2.json").read_text(encoding="utf-8"))
    pairs: list[tuple[str, str | None, str]] = []
    collect_pairs(source_manifest, compressed_manifest, pairs)
    texture_index: dict[str, Any] = {}
    by_file: dict[str, Path] = {}
    by_slug: dict[str, list[Path]] = {}
    for source_root in source_roots:
        try:
            source_index = json.loads((source_root / "models_textures" / "index.json").read_text(encoding="utf-8")).get("byHash", {})
            for key, value in source_index.items():
                texture_index.setdefault(key, value)
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            pass
        source_by_file, source_by_slug = build_texture_source_index(source_root)
        for key, value in source_by_file.items():
            by_file.setdefault(key, value)
        for key, values in source_by_slug.items():
            by_slug.setdefault(key, []).extend(values)

    roles_by_source: dict[str, set[str]] = defaultdict(set)
    target_by_source: dict[str, set[str | None]] = defaultdict(set)
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
    dropped_unresolved = 0
    aliased_sources_validated = 0
    neutralized_invalid_data_sources = 0
    generated_diagnostics_validated = 0
    for source_relative, roles in sorted(roles_by_source.items()):
        targets = target_by_source[source_relative]
        source_path = resolve_texture_source(source_roots, source_relative, texture_index, by_file, by_slug)
        if source_path is None:
            missing_source += 1
            if targets == {None}:
                dropped_unresolved += 1
            elif targets == {source_relative}:
                unchanged_missing += 1
            elif len(targets) == 1:
                target_relative = next(iter(targets))
                target_path = assets / str(target_relative or "")
                try:
                    with Image.open(target_path) as opened:
                        if opened.format != "WEBP":
                            raise ValueError(f"unexpected diagnostic format {opened.format}")
                        opened.verify()
                    generated_diagnostics_validated += 1
                except Exception as error:
                    structural_errors.append({
                        "source": source_relative,
                        "target": target_relative,
                        "error": f"generated diagnostic missing or invalid: {error}",
                    })
            else:
                structural_errors.append({"source": source_relative, "error": "missing source was rewritten"})
            continue
        if source_path != assets / source_relative:
            aliased_sources_validated += 1
        if len(targets) != 1:
            structural_errors.append({"source": source_relative, "error": "inconsistent target mapping", "targets": sorted(targets)})
            continue
        target_relative = next(iter(targets))
        if target_relative is None:
            structural_errors.append({"source": source_relative, "error": "available source texture slot was dropped"})
            continue
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
        except Exception as error:
            try:
                with Image.open(target_path) as opened:
                    target_image = opened.convert("RGBA")
                    target_format = opened.format
                if not roles & COLOR_KEYS and target_format == "WEBP" and target_image.size == (1, 1):
                    neutralized_invalid_data_sources += 1
                    decoded += 1
                    alpha_exact += 1
                    continue
            except Exception:
                pass
            structural_errors.append({"source": source_relative, "target": target_relative, "error": f"source decode failed: {error}"})
            continue
        try:
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
        "droppedUnresolvedSources": dropped_unresolved,
        "aliasedSourcesValidated": aliased_sources_validated,
        "neutralizedInvalidDataSources": neutralized_invalid_data_sources,
        "generatedDiagnosticsValidated": generated_diagnostics_validated,
        "structuralErrorCount": len(structural_errors),
        "dataQualityWarningCount": len(quality_warnings),
        "averageRgbRmseByRole": {
            role: round(sum(values) / len(values), 3) for role, values in sorted(metrics_by_role.items()) if values
        },
        "structuralErrors": structural_errors[:100],
        "dataQualityWarnings": sorted(quality_warnings, key=lambda row: max(row["maxError"][:3]), reverse=True)[:100],
    }
    report_path = args.report.resolve() if args.report else demo_dir / "texture_compression_audit.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key not in {"structuralErrors", "dataQualityWarnings"}}, indent=2))
    return 1 if structural_errors else 0


if __name__ == "__main__":
    raise SystemExit(main())

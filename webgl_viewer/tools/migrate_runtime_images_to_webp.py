#!/usr/bin/env python3
"""Losslessly migrate served legacy raster files to WebP and rewrite JSON owners.

The command is dry-run by default. With ``--write`` it encodes every PNG/JPEG
under the asset root, verifies decoded pixel equality, rewrites JSON references,
and only then moves the originals to a recovery directory. Undecodable legacy
payloads are replaced with explicit, role-aware diagnostic WebPs so the browser
never repeatedly fetches bytes it cannot decode.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import Counter, defaultdict
import io
import json
from pathlib import Path
import re
import shutil
from typing import Any, Iterator

from PIL import Image, ImageChops, ImageStat


LEGACY_SUFFIXES = {".png", ".jpg", ".jpeg"}
LEGACY_IMAGE_RE = re.compile(r"(?i)\.(?:png|jpe?g)(?=(?:\?[^#]*)?(?:#.*)?$)")
TEXT_SUFFIXES = {".css", ".html", ".js", ".mjs"}
NORMAL_HASHES = {"1186448975", "2327911600", "1073714531", "1422769919", "2745359528", "2975430677", "2417505683"}
DATA_HASHES = NORMAL_HASHES | {
    "1619499462", "2134197289", "3393362404", "1041827691", "50748941",
    "1212577329", "1705051233", "1008099585", "4049987115", "4152773162",
    "4131954791", "2878898974", "1530343050", "2124031998", "3579349756",
    "4132715990", "3820652825", "1117905904", "1899494261", "1214194352",
    "3266349336", "1422769919", "2745359528", "2975430677", "2417505683",
}
NORMAL_KEYS = {"normal", "terrainnormal1", "terrainnormal2", "terrainnormal3", "terrainnormal4"}
COLOR_KEYS = {"diffuse", "diffuse2", "foliagediffuse", "emissive", "env", "image"}


def iter_strings(value: Any, parent_key: str = "") -> Iterator[tuple[str, str]]:
    if isinstance(value, dict):
        for key, child in value.items():
            if isinstance(child, str):
                yield str(key), child
            else:
                yield from iter_strings(child, str(key))
    elif isinstance(value, list):
        for child in value:
            if isinstance(child, str):
                yield parent_key, child
            else:
                yield from iter_strings(child, parent_key)


def clean_reference(value: str) -> str:
    clean = value.replace("\\", "/").strip().split("#", 1)[0].split("?", 1)[0]
    return clean.removeprefix("/").removeprefix("assets/")


def resolve_reference(root: Path, manifest: Path, value: str) -> Path:
    clean = clean_reference(value)
    clean = clean.removeprefix("nexus-ext/").removeprefix("nexus_extensions/")
    return root / clean if "/" in clean else manifest.parent / clean


def target_value(value: str) -> str:
    return LEGACY_IMAGE_RE.sub(".webp", value)


def diagnostic_kind(relative: str, roles: set[str]) -> str:
    role_set = {role.lower() for role in roles}
    name = Path(relative).stem.lower()
    if role_set & NORMAL_KEYS or role_set & NORMAL_HASHES or re.search(r"(?:^|_)(?:n|nm|normal)(?:_|$)", name):
        return "normal"
    if (role_set - COLOR_KEYS) or role_set & DATA_HASHES or re.search(r"(?:^|_)(?:s|spec|mask|height|ao)(?:_|$)", name):
        return "data"
    return "color"


def diagnostic_image(kind: str) -> Image.Image:
    if kind == "normal":
        return Image.new("RGBA", (1, 1), (128, 128, 255, 255))
    if kind == "data":
        return Image.new("RGBA", (1, 1), (0, 0, 0, 255))
    image = Image.new("RGBA", (8, 8), (255, 0, 255, 255))
    pixels = image.load()
    for y in range(8):
        for x in range(8):
            if (x // 2 + y // 2) % 2:
                pixels[x, y] = (20, 20, 20, 255)
    return image


def encode_one(job: tuple[Path, Path, str, int | None]) -> dict[str, Any]:
    source, target, kind, color_quality = job
    try:
        with Image.open(source) as opened:
            opened.load()
            source_format = opened.format
            source_mode = opened.mode
            source_image = opened.convert("RGBA")
        output = io.BytesIO()
        lossy_color = kind == "color" and color_quality is not None
        if lossy_color:
            source_image.save(output, format="WEBP", quality=color_quality, method=6, exact=True)
        else:
            source_image.save(output, format="WEBP", lossless=True, method=4, exact=True)
        payload = output.getvalue()
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + ".tmp")
        temporary.write_bytes(payload)
        with Image.open(temporary) as verified:
            verified.load()
            decoded = verified.convert("RGBA")
            target_format = verified.format
        difference = ImageChops.difference(source_image, decoded)
        alpha_changed = difference.getchannel("A").getbbox() is not None
        rgb_rmse = sum(ImageStat.Stat(difference).rms[:3]) / 3
        if target_format != "WEBP" or decoded.size != source_image.size:
            temporary.unlink(missing_ok=True)
            raise ValueError("WebP format/dimension verification failed")
        # Tiny, high-contrast UI icons can exceed the color-error budget even
        # at high quality. Fall back to lossless for those individual files;
        # never turn a valid source into a diagnostic merely because a lossy
        # candidate was not accurate enough.
        if lossy_color and (alpha_changed or rgb_rmse > 12):
            output = io.BytesIO()
            source_image.save(output, format="WEBP", lossless=True, method=4, exact=True)
            payload = output.getvalue()
            temporary.write_bytes(payload)
            with Image.open(temporary) as verified:
                verified.load()
                decoded = verified.convert("RGBA")
                target_format = verified.format
            difference = ImageChops.difference(source_image, decoded)
            rgb_rmse = sum(ImageStat.Stat(difference).rms[:3]) / 3
            lossy_color = False
        if target_format != "WEBP" or decoded.size != source_image.size or difference.getbbox() is not None and not lossy_color:
            temporary.unlink(missing_ok=True)
            raise ValueError("WebP pixel/alpha verification failed")
        temporary.replace(target)
        return {
            "source": str(source), "target": str(target), "sourceFormat": source_format,
            "sourceMode": source_mode, "width": source_image.width, "height": source_image.height,
            "sourceBytes": source.stat().st_size, "webpBytes": len(payload), "diagnostic": False,
            "lossless": not lossy_color, "rgbRmse": round(rgb_rmse, 4),
        }
    except Exception as error:
        image = diagnostic_image(kind)
        output = io.BytesIO()
        image.save(output, format="WEBP", lossless=True, method=6, exact=True)
        payload = output.getvalue()
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + ".tmp")
        temporary.write_bytes(payload)
        with Image.open(temporary) as verified:
            verified.verify()
            if verified.format != "WEBP":
                raise ValueError("diagnostic WebP verification failed")
        temporary.replace(target)
        return {
            "source": str(source), "target": str(target), "sourceBytes": source.stat().st_size,
            "webpBytes": len(payload), "diagnostic": True, "diagnosticKind": kind,
            "sourceDecodeError": str(error),
        }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("assets", type=Path)
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--lossy-color-quality", type=int, default=None, help="Encode color-only images at this WebP quality (1-100); data/normal images stay lossless")
    parser.add_argument("--quarantine", type=Path, default=None)
    parser.add_argument("--report", type=Path, default=None)
    args = parser.parse_args()
    root = args.assets.resolve()
    sources = sorted(path for path in root.rglob("*") if path.is_file() and path.suffix.lower() in LEGACY_SUFFIXES)
    targets = {source: source.with_suffix(".webp") for source in sources}
    if len(set(targets.values())) != len(targets):
        raise SystemExit("target filename collision detected")

    roles: dict[Path, set[str]] = defaultdict(set)
    json_replacements: dict[Path, dict[str, str]] = defaultdict(dict)
    parse_errors: list[dict[str, str]] = []
    manifests = sorted(path for path in root.rglob("*.json") if path.is_file())
    for manifest in manifests:
        try:
            payload = json.loads(manifest.read_text(encoding="utf-8"))
        except Exception as error:
            parse_errors.append({"manifest": manifest.relative_to(root).as_posix(), "error": str(error)})
            continue
        for key, value in iter_strings(payload):
            if not LEGACY_IMAGE_RE.search(value):
                continue
            source = resolve_reference(root, manifest, value).resolve()
            if source not in targets:
                continue
            roles[source].add(key.lower())
            json_replacements[manifest][value] = target_value(value)

    report: dict[str, Any] = {
        "schema": "webglgta-runtime-image-migration-v1",
        "assetsRoot": str(root), "write": args.write, "legacyFiles": len(sources),
        "legacyBytes": sum(path.stat().st_size for path in sources),
        "jsonFiles": len(manifests), "jsonFilesToRewrite": len(json_replacements),
        "jsonReferenceMappings": sum(len(value) for value in json_replacements.values()),
        "parseErrors": parse_errors,
    }

    text_replacements: dict[Path, dict[str, str]] = defaultdict(dict)
    text_files = sorted(path for path in root.rglob("*") if path.is_file() and path.suffix.lower() in TEXT_SUFFIXES)
    for text_file in text_files:
        text = text_file.read_text(encoding="utf-8", errors="ignore")
        if "/nexus-ext/" in text:
            text_replacements[text_file]["/nexus-ext/"] = "/nexus_extensions/"
        for source, target in targets.items():
            relative = source.relative_to(root).as_posix()
            replacement = target.relative_to(root).as_posix()
            candidates = {
                relative: replacement,
                f"/nexus-ext/{relative}": f"/nexus_extensions/{replacement}",
                f"/nexus_extensions/{relative}": f"/nexus_extensions/{replacement}",
            }
            for before, after in candidates.items():
                if before in text:
                    text_replacements[text_file][before] = after
    report.update({
        "textFiles": len(text_files),
        "textFilesToRewrite": len(text_replacements),
        "textReferenceMappings": sum(len(value) for value in text_replacements.values()),
    })
    if not args.write:
        encoded = json.dumps(report, indent=2, sort_keys=True)
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(encoded + "\n", encoding="utf-8")
        print(encoded)
        return 1 if parse_errors else 0
    if parse_errors:
        raise SystemExit("refusing migration while JSON parse errors exist")

    color_quality = None if args.lossy_color_quality is None else max(1, min(100, args.lossy_color_quality))
    jobs = [(source, targets[source], diagnostic_kind(source.relative_to(root).as_posix(), roles[source]), color_quality) for source in sources]
    results: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        futures = [executor.submit(encode_one, job) for job in jobs]
        for future in as_completed(futures):
            results.append(future.result())

    rewritten = 0
    for manifest, replacements in json_replacements.items():
        text = manifest.read_text(encoding="utf-8")
        for before, after in replacements.items():
            encoded_before = json.dumps(before, ensure_ascii=False)[1:-1]
            encoded_after = json.dumps(after, ensure_ascii=False)[1:-1]
            text = text.replace(encoded_before, encoded_after)
        json.loads(text)
        temporary = manifest.with_name(manifest.name + ".tmp")
        temporary.write_text(text, encoding="utf-8")
        temporary.replace(manifest)
        rewritten += 1

    rewritten_text = 0
    for text_file, replacements in text_replacements.items():
        text = text_file.read_text(encoding="utf-8")
        for before, after in replacements.items():
            text = text.replace(before, after)
        temporary = text_file.with_name(text_file.name + ".tmp")
        temporary.write_text(text, encoding="utf-8")
        temporary.replace(text_file)
        rewritten_text += 1

    quarantine = args.quarantine.resolve() if args.quarantine else None
    moved = 0
    if quarantine:
        if quarantine == root or root in quarantine.parents:
            raise SystemExit("quarantine must be outside the served assets root")
        for source in sources:
            destination = quarantine / source.relative_to(root)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), str(destination))
            moved += 1

    results.sort(key=lambda row: row["source"])
    report.update({
        "encodedFiles": len(results), "webpBytes": sum(row["webpBytes"] for row in results),
        "savedBytesBeforeQuarantine": report["legacyBytes"] - sum(row["webpBytes"] for row in results),
        "diagnosticFiles": sum(row["diagnostic"] for row in results),
        "diagnosticKinds": dict(sorted(Counter(row.get("diagnosticKind") for row in results if row["diagnostic"]).items())),
        "rewrittenJsonFiles": rewritten, "rewrittenTextFiles": rewritten_text,
        "quarantinedOriginals": moved, "files": results,
    })
    encoded = json.dumps(report, indent=2, sort_keys=True)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(encoded + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "files"}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

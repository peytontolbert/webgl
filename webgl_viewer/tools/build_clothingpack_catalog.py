#!/usr/bin/env python3
"""Build a browser selection catalog from clothingpack5m YDD/YTD filenames."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


COMPONENT_PATTERN = r"p_(?:head|eyes|ears|lwrist)|head|berd|hair|uppr|lowr|hand|feet|teef|accs|task|decl|jbib"
DRAWABLE_RE = re.compile(
    rf"^(?P<dir>.+/)?(?:(?P<prefix>[^/]+)\^)?(?P<component>{COMPONENT_PATTERN})_(?P<drawable>\d+)(?:_[ur])?(?:_\d+)?\.ydd$",
    re.IGNORECASE,
)
TEXTURE_RE = re.compile(
    rf"^(?P<dir>.+/)?(?:(?P<prefix>[^/]+)\^)?(?P<component>{COMPONENT_PATTERN})_diff_(?P<drawable>\d+)_(?P<texture>[a-z]+)(?:_[^.]+)?\.ytd$",
    re.IGNORECASE,
)

COMPONENT_IDS = {
    "head": 0, "berd": 1, "hair": 2, "uppr": 3, "lowr": 4,
    "hand": 5, "feet": 6, "teef": 7, "accs": 8, "task": 9,
    "decl": 10, "jbib": 11,
    "p_head": 0, "p_eyes": 1, "p_ears": 2, "p_lwrist": 6,
}


def sex_from_prefix(prefix: str) -> str:
    value = prefix.lower()
    if value.startswith("mp_f_") or "female" in value:
        return "female"
    if value.startswith("mp_m_") or "male" in value:
        return "male"
    return "unisex"


def texture_index(token: str) -> int:
    result = 0
    for char in token.lower():
        result = result * 26 + (ord(char) - ord("a") + 1)
    return max(0, result - 1)


def source_key(match: re.Match) -> str:
    return (match.group("prefix") or match.group("dir") or "loose").strip("/").lower()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--contracts",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "assets" / "fivem_appearance_contracts.json",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "assets" / "clothingpack5m_catalog.json",
    )
    args = parser.parse_args()
    source = json.loads(args.contracts.read_text(encoding="utf-8"))
    files = source.get("clothingpack5m", {}).get("files", [])
    textures: dict[tuple[str, str, int], list[dict]] = {}
    for row in files:
        match = TEXTURE_RE.match(str(row.get("path", "")))
        if not match:
            continue
        key = (source_key(match), match.group("component").lower(), int(match.group("drawable")))
        textures.setdefault(key, []).append({
            "index": texture_index(match.group("texture")),
            "token": match.group("texture").lower(),
            "path": row["path"],
            "bytes": int(row.get("bytes", 0)),
        })

    items = []
    for row in files:
        match = DRAWABLE_RE.match(str(row.get("path", "")))
        if not match:
            continue
        prefix = match.group("prefix") or (match.group("dir") or "loose").strip("/")
        component = match.group("component").lower()
        drawable = int(match.group("drawable"))
        key = (source_key(match), component, drawable)
        variants = sorted(textures.get(key, []), key=lambda value: (value["index"], value["path"]))
        collection = "base" if prefix.lower() in {"mp_m_freemode_01", "mp_f_freemode_01"} else prefix
        sex = sex_from_prefix(prefix)
        items.append({
            "id": f"clothingpack5m:{sex}:{collection}:{component}:{drawable}",
            "sex": sex,
            "collection": collection,
            "component": component,
            "componentId": COMPONENT_IDS.get(component),
            "isProp": component.startswith("p_"),
            "drawable": drawable,
            "label": f"{component.upper()} {drawable:03d}",
            "drawablePath": row["path"],
            "drawableBytes": int(row.get("bytes", 0)),
            "textures": variants,
            "renderStatus": "requires_conversion",
        })

    items.sort(key=lambda value: (value["sex"], value["component"], value["collection"], value["drawable"]))
    payload = {
        "schema": "webglgta-clothingpack5m-catalog-v1",
        "source": source.get("source", {}),
        "generatedFrom": str(args.contracts.name),
        "summary": {
            "items": len(items),
            "textures": sum(len(item["textures"]) for item in items),
            "bytes": sum(item["drawableBytes"] + sum(tex["bytes"] for tex in item["textures"]) for item in items),
            "unmatchedYdd": int(source.get("summary", {}).get("clothingYdd", 0)) - len(items),
        },
        "items": items,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(json.dumps(payload["summary"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Build a recovery dump for texture references left unresolved by compression."""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


TEXTURE_PREFIXES = ("models_textures/", "mlo_textures/")
TEXTURE_SLOT_KEYS = {
    "diffuse", "foliagediffuse", "diffuse2", "emissive", "env", "normal",
    "spec", "detail", "height", "tintpalette", "ao", "alphamask", "dirt",
    "damage", "damagespec", "damagemask", "puddlemask", "terraincolor1",
    "terraincolor2", "terraincolor3", "terraincolor4", "terrainnormal1",
    "terrainnormal2", "terrainnormal3", "terrainnormal4", "waterflow",
    "waterfoam", "tint",
}


def collect(
    source: Any,
    compressed: Any,
    counts: Counter[str],
    refs: dict[str, list[dict[str, Any]]],
    context: dict[str, Any] | None = None,
) -> None:
    context = context or {}
    if isinstance(source, dict) and isinstance(compressed, dict):
        for key, value in source.items():
            child_context = (
                {**context, "role": str(key).lower()}
                if str(key).lower() in TEXTURE_SLOT_KEYS
                else context
            )
            if key in {"models", "meshes"} and isinstance(value, dict):
                for archetype_hash, model in value.items():
                    collect(
                        model,
                        compressed.get(key, {}).get(archetype_hash),
                        counts,
                        refs,
                        {"archetype_hash": str(archetype_hash)},
                    )
                continue
            if key == "lods" and isinstance(value, dict):
                for lod, payload in value.items():
                    collect(
                        payload,
                        compressed.get(key, {}).get(lod),
                        counts,
                        refs,
                        {**context, "lod": str(lod)},
                    )
                continue
            if key == "submeshes" and isinstance(value, list):
                compressed_items = compressed.get(key, [])
                for index, payload in enumerate(value):
                    collect(
                        payload,
                        compressed_items[index] if index < len(compressed_items) else None,
                        counts,
                        refs,
                        {**context, "submesh_index": index},
                    )
                continue
            collect(value, compressed.get(key), counts, refs, child_context)
        return
    if isinstance(source, list) and isinstance(compressed, list):
        for left, right in zip(source, compressed):
            collect(left, right, counts, refs, context)
        return
    if (
        isinstance(source, str)
        and source.replace("\\", "/").startswith(TEXTURE_PREFIXES)
        and compressed == source
    ):
        relative = source.replace("\\", "/")
        counts[relative] += 1
        if context.get("archetype_hash") and len(refs[relative]) < 32:
            refs[relative].append(dict(context))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--compressed", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    source = json.loads(args.source.read_text(encoding="utf-8"))
    compressed = json.loads(args.compressed.read_text(encoding="utf-8"))
    counts: Counter[str] = Counter()
    refs: dict[str, list[dict[str, Any]]] = defaultdict(list)
    collect(source, compressed, counts, refs)
    rows = [
        {"requestedRel": relative, "useCount": count, "refs": refs[relative]}
        for relative, count in counts.most_common()
    ]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(rows, indent=2), encoding="utf-8")
    print(json.dumps({
        "unresolvedUnique": len(rows),
        "unresolvedOccurrences": sum(counts.values()),
        "output": str(args.out),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

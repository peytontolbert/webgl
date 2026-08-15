#!/usr/bin/env python3
"""Build the one-time default-texture conversion selection for clothingpack5m."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    root = Path(__file__).resolve().parents[1]
    parser.add_argument("--catalog", type=Path, default=root / "assets" / "clothingpack5m_catalog.json")
    parser.add_argument("--output", type=Path, default=root / "data" / "clothing_preview_batch.json")
    args = parser.parse_args()

    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    selected = []
    for item in catalog.get("items", []):
        textures = item.get("textures") or []
        if not textures:
            continue
        texture = textures[0]
        selected.append({
            "id": item["id"],
            "sex": item["sex"],
            "collection": item["collection"],
            "component": item["component"],
            "componentId": item["componentId"],
            "isProp": item["isProp"],
            "drawable": item["drawable"],
            "texture": texture["index"],
            "drawablePath": item["drawablePath"],
            "texturePath": texture["path"],
        })

    payload = {
        "schema": "webglgta-clothingpack5m-selection-v1",
        "exportedAt": datetime.now(timezone.utc).isoformat(),
        "collection": "clothingpack5m",
        "items": selected,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(json.dumps({"items": len(selected), "output": str(args.output)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

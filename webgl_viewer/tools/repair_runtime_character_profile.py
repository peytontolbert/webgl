#!/usr/bin/env python3
"""Repair a runtime character profile whose render metadata was truncated."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


RENDER_MARKER = b'  "render": {'


def load_salvageable_profile(path: Path) -> dict:
    raw = path.read_bytes()
    try:
        return json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        prefix, marker, _ = raw.partition(RENDER_MARKER)
        if not marker:
            raise ValueError(f"{path} is invalid and has no render section to rebuild")

        prefix = prefix.rstrip()
        if prefix.endswith(b","):
            prefix = prefix[:-1]
        return json.loads(prefix + b"\n}")


def build_render_metadata(profile: dict) -> dict:
    model_hash = profile.get("modelHash")
    model_names = [
        component["assetName"]
        for component in profile.get("components", [])
        if component.get("assetName")
    ]
    if not model_hash or not model_names:
        raise ValueError("profile must contain modelHash and component assetName values")

    return {
        "mode": "freemode_components",
        "modelNames": model_names,
        "fallbackModelName": profile.get("fallbackModelName", "a_m_y_skater_01"),
        "meshComposition": "skinned_drawable_components",
        "skinning": True,
        "exactness": (
            "saved_fivem_appearance_components; freemode drawables use exported GTA "
            "blend weights/indices"
        ),
        "skeleton": f"peds/{model_hash}_skeleton.json",
        "animations": f"peds/{model_hash}_animations.json",
        "animationSource": "CodeWalker YCD sampled skinTransforms3x4 on ped YFT skeleton",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    profile = load_salvageable_profile(args.input)
    profile["render"] = build_render_metadata(profile)
    encoded = json.dumps(profile, indent=2, ensure_ascii=True) + "\n"
    args.output.write_text(encoded, encoding="utf-8")

    json.loads(args.output.read_text(encoding="utf-8"))
    print(
        f"repaired {args.output}: model={profile.get('modelName')} "
        f"components={len(profile.get('components', []))} bytes={len(encoded)}"
    )


if __name__ == "__main__":
    main()

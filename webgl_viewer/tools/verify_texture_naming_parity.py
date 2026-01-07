#!/usr/bin/env python3
"""
Quick deterministic checks that Python tooling matches viewer runtime texture rel normalization
and candidate ordering semantics (see webgl_viewer/js/texture_path_resolver.js).

This is intentionally lightweight: no network, no CodeWalker, no assets required.
"""

from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from gta5_modules.texture_naming import iter_texture_candidate_rels_like_viewer, normalize_asset_rel


def _assert_eq(got, exp, msg: str) -> None:
    if got != exp:
        raise AssertionError(f"{msg}\n  got={got}\n  exp={exp}")


def main() -> int:
    # 1) normalize_asset_rel mirrors JS normalization rules.
    _assert_eq(normalize_asset_rel("assets/model_textures/123.png"), "models_textures/123.png", "normalize legacy prefix")
    _assert_eq(normalize_asset_rel("/assets/models_texture/123.png"), "models_textures/123.png", "normalize legacy prefix + leading slash")

    # 2) Hash+slug input + pack preference ordering mirrors JS:
    #    - if pack index says hash-only is missing, try preferredFile first, then hash-only, then slugged input.
    rel = "assets/models_textures/123_abc.png"
    pack_entries = [("packs/patchday27ng", {"preferredFile": "123.dds", "hashOnly": False})]
    base_ent = {"preferredFile": "123.dds", "hashOnly": False}
    got = iter_texture_candidate_rels_like_viewer(rel, base_index_entry=base_ent, pack_entries=pack_entries)[:5]
    exp = [
        "packs/patchday27ng/models_textures/123.dds",
        "packs/patchday27ng/models_textures/123.png",
        "packs/patchday27ng/models_textures/123_abc.png",
        "models_textures/123.dds",
        "models_textures/123.png",
    ]
    _assert_eq(got, exp, "pack + base candidate ordering for hash+slug")

    # 3) No-slug input prefers preferredFile before hash-only when hashOnly is known false.
    rel2 = "models_textures/123.png"
    got2 = iter_texture_candidate_rels_like_viewer(rel2, base_index_entry={"preferredFile": "123.dds", "hashOnly": False})[:2]
    exp2 = ["models_textures/123.dds", "models_textures/123.png"]
    _assert_eq(got2, exp2, "base preferredFile before hash-only when hashOnly==False")

    print("OK: texture naming parity checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



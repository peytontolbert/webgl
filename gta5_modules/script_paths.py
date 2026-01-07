"""
Shared path helpers for repo scripts.

We keep this separate from entity-specific logic so other scripts (textures, manifests, etc.)
can share the same conventions without importing entity coverage code.
"""

from __future__ import annotations

from pathlib import Path


def auto_assets_dir(explicit_assets_dir: str) -> Path:
    """
    Resolve viewer assets directory.

    Convention used throughout this repo:
    - explicit --assets-dir wins
    - else <repo>/webgl_viewer/assets next to the repo root
    - else cwd/webgl_viewer/assets
    """
    if explicit_assets_dir:
        return Path(explicit_assets_dir).resolve()
    # This module lives in gta5_modules/, so repo root is one level up.
    repo_root = Path(__file__).resolve().parent.parent
    p = repo_root / "webgl_viewer" / "assets"
    if p.exists():
        return p
    return (Path.cwd() / "webgl_viewer" / "assets").resolve()



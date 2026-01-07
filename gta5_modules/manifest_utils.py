"""
Shared models manifest helpers.

Keep behavior stable across scripts:
- manifest.json is expected to be a dict with {"version": int, "meshes": dict}
- callers often want to *repair* missing fields without throwing
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Tuple


def load_or_init_models_manifest(models_dir: Path, *, min_version: int = 4) -> Tuple[Path, Dict[str, Any]]:
    """
    Load assets/models/manifest.json if it exists; otherwise return an initialized manifest.
    Ensures:
    - manifest is a dict
    - manifest["meshes"] is a dict
    - manifest["version"] is >= min_version (when present / parseable)
    """
    manifest_path = models_dir / "manifest.json"
    manifest: Dict[str, Any] = {"version": int(min_version), "meshes": {}}

    if manifest_path.exists():
        try:
            existing = json.loads(manifest_path.read_text(encoding="utf-8", errors="ignore"))
            if isinstance(existing, dict) and isinstance(existing.get("meshes"), dict):
                manifest = existing  # type: ignore[assignment]
                try:
                    v = int(manifest.get("version") or 0)
                except Exception:
                    v = 0
                manifest["version"] = max(int(min_version), int(v))
        except Exception:
            pass

    if not isinstance(manifest, dict):
        manifest = {"version": int(min_version), "meshes": {}}
    if not isinstance(manifest.get("meshes"), dict):
        manifest["meshes"] = {}
    if "version" not in manifest:
        manifest["version"] = int(min_version)
    else:
        try:
            manifest["version"] = max(int(min_version), int(manifest.get("version") or 0))
        except Exception:
            manifest["version"] = int(min_version)

    return manifest_path, manifest



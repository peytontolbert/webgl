"""
Shared CodeWalker archetype resolution helpers.

Why this exists:
- CodeWalker.GameFileCache builds an archetype dictionary by scanning YTYP files.
- Some YTYP files may fail Meta/PSO parsing in certain builds/environments and are skipped, producing warnings like:
    "<path>.ytyp: ytyp file was not in meta format."
- When that happens, `GameFileCache.GetArchetype(hash)` will return null even though the archetype exists.

This module provides a best-effort resolver that preserves existing behavior but adds a fallback path.
"""

from __future__ import annotations

from typing import Iterable, Optional, Any


def get_archetype_best_effort(
    gfc: Any,
    archetype_hash_u32: int,
    *,
    dll_manager: Optional[Any] = None,
    also_scan_dlc_levels: Optional[Iterable[str]] = None,
) -> Any:
    """
    Resolve an Archetype for a model hash.

    Order:
    1) gfc.GetArchetype(hash)
    2) (optional) switch DLC levels and retry (also_scan_dlc_levels)
    3) (optional) dll_manager non-meta YTYP fallback map
    """
    h = int(archetype_hash_u32) & 0xFFFFFFFF

    arch = None
    try:
        arch = gfc.GetArchetype(int(h) & 0xFFFFFFFF)
    except Exception:
        arch = None
    if arch is not None:
        return arch

    # Optional extra DLC scans (CodeWalker special-cases like patchday27ng).
    levels = [str(x or "").strip() for x in (also_scan_dlc_levels or []) if str(x or "").strip()]
    if levels and hasattr(gfc, "SetDlcLevel"):
        for lvl in levels:
            try:
                gfc.SetDlcLevel(str(lvl), True)
            except Exception:
                pass
            try:
                arch = gfc.GetArchetype(int(h) & 0xFFFFFFFF)
            except Exception:
                arch = None
            if arch is not None:
                return arch

    # Non-meta YTYP fallback (best-effort).
    if dll_manager is not None and hasattr(dll_manager, "get_nonmeta_ytyp_fallback_archetype"):
        try:
            arch2 = dll_manager.get_nonmeta_ytyp_fallback_archetype(int(h) & 0xFFFFFFFF)
            if arch2 is not None:
                return arch2
        except Exception:
            pass

    return None



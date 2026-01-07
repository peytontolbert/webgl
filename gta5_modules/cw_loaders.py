"""
Shared CodeWalker loading helpers (pythonnet).

Goal: centralize the common "pump ContentThreadProc until loaded" patterns
without changing behavior. Scripts should wrap these helpers with their existing
function names and pass the same spin/max-loop limits they used before.
"""

from __future__ import annotations

from typing import Any, Optional


def pump_content(gfc: Any, loops: int = 1) -> None:
    """
    Best-effort call to `GameFileCache.ContentThreadProc()` N times.
    """
    n = max(0, int(loops or 0))
    for _ in range(n):
        try:
            gfc.ContentThreadProc()
        except Exception:
            break


def ensure_loaded(gfc: Any, gf: Any, *, max_loops: int = 600) -> bool:
    """
    Best-effort ensure a CodeWalker GameFile is loaded by pumping the content thread.
    Mirrors the pattern used across repo scripts.
    """
    if gf is None:
        return False
    try:
        if bool(getattr(gf, "Loaded", False)):
            return True
    except Exception:
        pass
    for _ in range(max(0, int(max_loops or 0))):
        try:
            gfc.ContentThreadProc()
        except Exception:
            break
        try:
            if bool(getattr(gf, "Loaded", False)):
                return True
        except Exception:
            pass
    return False


def try_get_drawable(gfc: Any, arch: Any, *, spins: int = 400) -> Any:
    """
    Try to resolve a drawable for an archetype by pumping ContentThreadProc.
    Returns the drawable or None.
    """
    if gfc is None or arch is None:
        return None
    try:
        drawable = gfc.TryGetDrawable(arch)
    except Exception:
        drawable = None
    s = 0
    max_s = max(0, int(spins or 0))
    while drawable is None and s < max_s:
        try:
            gfc.ContentThreadProc()
        except Exception:
            break
        try:
            drawable = gfc.TryGetDrawable(arch)
        except Exception:
            drawable = None
        s += 1
    return drawable


def try_get_ytd(gfc: Any, txd_hash_u32: int, *, spins: int = 400) -> Any:
    """
    Try to load a YTD by hash and pump until Loaded (mirrors existing scripts).
    Returns the YtdFile or None.
    """
    if gfc is None:
        return None
    h = int(txd_hash_u32) & 0xFFFFFFFF
    if not h:
        return None
    try:
        ytd = gfc.GetYtd(int(h))
    except Exception:
        ytd = None
    if ytd is None:
        return None
    # Some CodeWalker builds load lazily; pumping is usually enough.
    s = 0
    max_s = max(0, int(spins or 0))
    while (ytd is not None) and (not getattr(ytd, "Loaded", True)) and s < max_s:
        try:
            gfc.ContentThreadProc()
        except Exception:
            break
        s += 1
    return ytd if (ytd is not None and getattr(ytd, "Loaded", True)) else None


def try_loadfile(gfc: Any, gf: Any) -> None:
    """
    Best-effort call gfc.LoadFile(gf) if available. Some scripts use this to nudge loading.
    """
    if gfc is None or gf is None:
        return
    try:
        lf = getattr(gfc, "LoadFile", None)
    except Exception:
        lf = None
    if callable(lf):
        try:
            lf(gf)
        except Exception:
            return



"""
Shared hash / u32 parsing helpers used by repo scripts.

Design goals:
- Keep behavior stable: callers choose whether to lowercase before hashing.
- Avoid pulling in heavy dependencies.
"""

from __future__ import annotations

from typing import Any, Optional


def as_u32_int(x: Any) -> Optional[int]:
    """
    Parse a value as a signed/unsigned integer string and return uint32 (0..2^32-1).
    Returns None if parsing fails.
    """
    try:
        s = str(x).strip()
        if not s:
            return None
        if not s.lstrip("-").isdigit():
            return None
        return int(s, 10) & 0xFFFFFFFF
    except Exception:
        return None


def as_u32_str(x: Any) -> Optional[str]:
    """
    Like as_u32_int, but returns the uint32 as a decimal string.
    """
    v = as_u32_int(x)
    return str(v) if v is not None else None


def try_coerce_u32(x: Any, *, allow_hex: bool = True) -> Optional[int]:
    """
    Best-effort conversion to unsigned 32-bit int.

    This is intended for pythonnet objects coming from CodeWalker (MetaHash/JenkHash/etc),
    which often expose numeric values via `.Hash` and sometimes don't support `int(obj)`
    even though C# defines implicit conversions.

    Behavior:
    - None -> None
    - int -> masked
    - str -> parsed (decimal by default; if allow_hex=True supports "0x..." etc via int(s, 0))
    - objects -> try attributes Hash/hash/Value/value, then int(x), then int(str(x), base)
    - returns None if all parsing attempts fail
    """
    if x is None:
        return None

    # Fast paths
    if isinstance(x, int):
        return x & 0xFFFFFFFF

    if isinstance(x, str):
        s = x.strip()
        if not s:
            return None
        try:
            if allow_hex:
                return int(s, 0) & 0xFFFFFFFF
            # strict-ish decimal string
            if not s.lstrip("-").isdigit():
                return None
            return int(s, 10) & 0xFFFFFFFF
        except Exception:
            return None

    # pythonnet/.NET wrapper objects (MetaHash, JenkHash, etc.)
    for attr in ("Hash", "hash", "Value", "value"):
        try:
            v = getattr(x, attr)
        except Exception:
            v = None
        if v is None:
            continue
        out = try_coerce_u32(v, allow_hex=allow_hex)
        if out is not None:
            return out

    # Try coercions as last resort
    try:
        return int(x) & 0xFFFFFFFF
    except Exception:
        pass
    try:
        s2 = str(x).strip()
        if not s2:
            return None
        base = 0 if allow_hex else 10
        return int(s2, base) & 0xFFFFFFFF
    except Exception:
        return None


def coerce_u32(x: Any, *, allow_hex: bool = True, default: int = 0) -> int:
    """
    Like try_coerce_u32, but returns an int (defaulting to `default`).
    """
    v = try_coerce_u32(x, allow_hex=allow_hex)
    return int(default) & 0xFFFFFFFF if v is None else (int(v) & 0xFFFFFFFF)


def joaat(s: str, *, lower: bool = False) -> int:
    """
    GTA "joaat" hash (Jenkins one-at-a-time).

    Note: different places in the repo historically differ on whether they lower-case first.
    To preserve behavior, callers must opt in via lower=True.
    """
    t = str(s or "")
    if lower:
        t = t.lower()
    h = 0
    for ch in t:
        h = (h + ord(ch)) & 0xFFFFFFFF
        h = (h + ((h << 10) & 0xFFFFFFFF)) & 0xFFFFFFFF
        h ^= (h >> 6)
    h = (h + ((h << 3) & 0xFFFFFFFF)) & 0xFFFFFFFF
    h ^= (h >> 11)
    h = (h + ((h << 15) & 0xFFFFFFFF)) & 0xFFFFFFFF
    return h & 0xFFFFFFFF



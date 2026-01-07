"""
Shared archetype hash normalization helpers.

Several scripts need to turn an entity row into a uint32 archetype hash string for joins/reports.
This module centralizes that logic so reports stay consistent.
"""

from __future__ import annotations

from typing import Optional

from .hash_utils import as_u32_str, joaat


def normalize_archetype_to_hash_str(obj: dict) -> Optional[str]:
    """
    Normalize a streamed entity JSON object to a uint32 hash string.

    Rules (preserve legacy behavior across scripts):
    - Prefer explicit `archetype_hash` if present (already numeric u32 string/int).
    - Else use `archetype` if it's numeric.
    - Else if `archetype` is a name string, hash it (do NOT lowercase by default; match legacy scripts).
    - Treat empty/"UNKNOWN" as missing.
    """
    if not isinstance(obj, dict):
        return None

    # Prefer explicit archetype_hash if present.
    h = as_u32_str(obj.get("archetype_hash"))
    if h:
        return h

    arch = obj.get("archetype")
    h = as_u32_str(arch)
    if h:
        return h

    s = str(arch or "").strip()
    if not s or s.upper() == "UNKNOWN":
        return None
    return str(int(joaat(s, lower=False)) & 0xFFFFFFFF)



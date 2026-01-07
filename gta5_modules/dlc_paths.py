"""
Shared helpers for inferring DLC pack names from CodeWalker RPF entry paths.

Keep behavior stable: many scripts have their own tiny variants of this logic.
We centralize the superset and keep script-local wrappers to avoid breaking callers.
"""

from __future__ import annotations

import re
from typing import Any, Optional, Tuple


_RE_DLC_FROM_PATH = re.compile(r"\\dlcpacks\\([^\\]+)\\", re.IGNORECASE)


def normalize_rpf_path_like_codewalker(p: str) -> str:
    """
    Normalize a path string to the common form used by CodeWalker RpfEntry.Path / NameLower comparisons:
    - strip whitespace
    - lowercase
    - normalize separators to backslashes
    """
    return str(p or "").strip().lower().replace("/", "\\")


def infer_dlc_pack_from_entry_path(path_or_name: str) -> str:
    """
    Infer the dlcpack name from an RPF entry path / NameLower.
    Returns '' when it can't be inferred (base game or unknown).
    """
    s = normalize_rpf_path_like_codewalker(path_or_name)
    if not s:
        return ""
    m = _RE_DLC_FROM_PATH.search(s)
    return str(m.group(1) or "").strip().lower() if m else ""


def get_rpf_entry_path_or_namelower(entry: Any) -> str:
    """
    Best-effort extract a string path from a CodeWalker RpfFileEntry-like object.
    Preference order:
    1) entry.Path
    2) entry.NameLower
    3) entry.Name
    """
    if entry is None:
        return ""
    for attr in ("Path", "NameLower", "Name", "path", "nameLower", "name"):
        try:
            v = getattr(entry, attr, None)
        except Exception:
            v = None
        if v:
            try:
                return str(v)
            except Exception:
                continue
    return ""


def get_gamefile_entry_path_or_namelower(gamefile: Any) -> str:
    """
    Best-effort extract the RpfFileEntry.Path/NameLower/Name from a CodeWalker GameFile (YtdFile, YdrFile, YtypFile, etc).
    Returns '' if not available.
    """
    if gamefile is None:
        return ""
    ent = None
    try:
        ent = getattr(gamefile, "RpfFileEntry", None)
    except Exception:
        ent = None
    return get_rpf_entry_path_or_namelower(ent)


def get_gamefile_entry_path_and_dlc(gamefile: Any) -> Tuple[str, str]:
    """
    Return (entry_path, dlcpack) for a CodeWalker GameFile.
    """
    ep = get_gamefile_entry_path_or_namelower(gamefile)
    dlc = infer_dlc_pack_from_entry_path(ep)
    return ep, dlc


def infer_dlc_pack_from_ytyp(arch_or_ytyp: Any) -> Tuple[str, str]:
    """
    Best-effort infer DLC pack name from an Archetype (arch.Ytyp.RpfFileEntry.Path) or a YtypFile.
    Returns (dlc, entry_path_str).
    """
    ytyp = None
    try:
        # arch.Ytyp
        ytyp = getattr(arch_or_ytyp, "Ytyp", None)
    except Exception:
        ytyp = None
    if ytyp is None:
        ytyp = arch_or_ytyp
    ent = None
    try:
        ent = getattr(ytyp, "RpfFileEntry", None) if ytyp is not None else None
    except Exception:
        ent = None
    ep = get_rpf_entry_path_or_namelower(ent)
    return infer_dlc_pack_from_entry_path(ep), ep



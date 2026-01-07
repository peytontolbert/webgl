"""
Provenance + parity helpers for offline export.

Goals:
- Build a lightweight "VFS snapshot index" of resolved paths -> source RPF layer/entry
- Record per-input hashes for the files we actually use during export
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Iterable, Optional, Set, Tuple

from .dll_manager import canonicalize_cw_path

def sha1_hex(data: bytes) -> str:
    h = hashlib.sha1()
    h.update(data or b"")
    return h.hexdigest()


def norm_gta_path(p: str) -> str:
    return (str(p or "").replace("/", "\\").replace("\\\\", "\\").strip().lower())


def _layer_from_rpf_path(rpf_path: str) -> str:
    p = norm_gta_path(rpf_path)
    if p.startswith("mods\\"):
        return "mods"
    if p.startswith("update\\"):
        # includes update.rpf and update dlcpacks overlays
        return "update"
    if "\\dlcpacks\\" in p or p.startswith("dlcpacks\\"):
        return "dlc"
    return "base"


def entry_source_info(entry: Any) -> dict:
    """
    Best-effort extraction of the "where did this file come from" metadata.
    """
    try:
        epath = str(getattr(entry, "Path", "") or "")
    except Exception:
        epath = ""
    try:
        ename = str(getattr(entry, "Name", "") or "")
    except Exception:
        ename = ""
    try:
        f = getattr(entry, "File", None)
        rpf_path = str(getattr(f, "Path", "") or "") if f is not None else ""
        rpf_name = str(getattr(f, "Name", "") or "") if f is not None else ""
    except Exception:
        rpf_path = ""
        rpf_name = ""

    return {
        "source_rpf": rpf_path or None,
        "source_rpf_name": rpf_name or None,
        "source_layer": _layer_from_rpf_path(rpf_path),
        "source_path": norm_gta_path(epath) or None,
        "name": ename or None,
    }


def iter_entry_dict(rpf_manager: Any) -> Iterable[Tuple[str, Any]]:
    """
    Iterate CodeWalker RpfManager.EntryDict (pythonnet Dictionary).
    Returns (path, entry) pairs.
    """
    d = getattr(rpf_manager, "EntryDict", None)
    if d is None:
        return []

    def _gen():
        for kv in d:
            try:
                k = str(getattr(kv, "Key", None) or kv.Key)
            except Exception:
                k = ""
            try:
                v = getattr(kv, "Value", None) or kv.Value
            except Exception:
                v = None
            if not k or v is None:
                continue
            yield (k, v)

    return _gen()


def write_vfs_snapshot_index(
    *,
    rpf_manager: Any,
    out_path: Path,
    include_exts: Optional[Set[str]] = None,
    max_entries: int = 50000,
    hash_first_n: int = 0,
) -> dict:
    """
    Write a JSONL snapshot of resolved VFS entries.

    "Resolved" here means: whatever is present in the chosen RpfManager.EntryDict.
    For correctness, this should be the DLC-aware RpfManager coming from GameFileCache.RpfMan.
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    exts = {e.lower() for e in include_exts} if include_exts else None

    wrote = 0
    hashed = 0
    with out_path.open("w", encoding="utf-8") as f:
        for k, entry in iter_entry_dict(rpf_manager):
            if wrote >= int(max_entries):
                break
            pathl = norm_gta_path(k)
            if exts is not None:
                dot = pathl.rfind(".")
                ext = pathl[dot:] if dot >= 0 else ""
                if ext not in exts:
                    continue

            rec = entry_source_info(entry)
            # Augment with basic entry fields when present.
            try:
                rec["file_offset"] = int(getattr(entry, "FileOffset", 0))
                rec["file_size"] = int(getattr(entry, "FileSize", 0))
            except Exception:
                pass

            if hash_first_n > 0 and hashed < int(hash_first_n):
                try:
                    # GetFileData returns decompressed bytes; this is the "logical file" content.
                    data = rpf_manager.GetFileData(canonicalize_cw_path(pathl, keep_forward_slashes=True))
                    b = bytes(data) if data else b""
                    rec["source_size"] = int(len(b))
                    rec["source_sha1"] = sha1_hex(b)
                    hashed += 1
                except Exception:
                    rec["source_sha1"] = None
            f.write(json.dumps(rec) + "\n")
            wrote += 1

    return {"wrote": wrote, "hashed": hashed, "path": str(out_path)}


def write_resolved_dict_index(
    *,
    game_file_cache: Any,
    out_path: Path,
    dict_names: Optional[list[str]] = None,
    max_entries_per_dict: int = 200000,
) -> dict:
    """
    Write a JSONL index of CodeWalker GameFileCache resolved dictionaries.

    This is generally the best signal for “what is active” because these dicts are built
    from ActiveMapRpfFiles and DLC patch logic (vs scanning all RPFS).
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    names = dict_names or ["YmapDict", "YtdDict", "YdrDict", "YddDict", "YftDict", "YbnDict", "YnvDict"]

    wrote = 0
    with out_path.open("w", encoding="utf-8") as f:
        for dn in names:
            d = getattr(game_file_cache, dn, None)
            if d is None:
                continue
            n = 0
            for kv in d:
                if n >= int(max_entries_per_dict):
                    break
                try:
                    k = int(getattr(kv, "Key", None) or kv.Key) & 0xFFFFFFFF
                except Exception:
                    k = 0
                try:
                    entry = getattr(kv, "Value", None) or kv.Value
                except Exception:
                    entry = None
                if entry is None:
                    continue

                rec = entry_source_info(entry)
                rec.update({
                    "resolved_from_dict": dn,
                    "resolved_key_u32": int(k),
                })
                f.write(json.dumps(rec) + "\n")
                wrote += 1
                n += 1

    return {"wrote": wrote, "path": str(out_path), "dicts": names}



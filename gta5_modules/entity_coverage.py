"""
Shared primitives for entity/YMAP/chunk coverage checks.

Goal: keep all "coverage" scripts consistent and DRY.

This module is intentionally lightweight (no heavy imports like pythonnet) so it can be reused
in fast integrity check scripts.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Optional, Tuple

from .script_paths import auto_assets_dir as _auto_assets_dir


def auto_assets_dir(explicit_assets_dir: str) -> Path:
    """
    Resolve viewer assets directory.
    Mirrors the common convention across scripts:
    - explicit --assets-dir wins
    - else <repo>/webgl_viewer/assets next to the script repo root
    - else cwd/webgl_viewer/assets
    """
    # Backwards-compatible wrapper: delegate to shared script_paths.
    return _auto_assets_dir(explicit_assets_dir)


def load_entities_index(assets_dir: Path) -> dict:
    p = assets_dir / "entities_index.json"
    if not p.exists():
        raise SystemExit(f"Missing {p} (run extraction/export first)")
    return json.loads(p.read_text(encoding="utf-8", errors="ignore"))


def iter_chunk_rows(idx: dict) -> List[Tuple[str, str, int]]:
    """
    Return sorted chunk rows: (chunk_key, file_name, expected_count).
    """
    chunks = list((idx.get("chunks") or {}).items())
    chunks.sort(key=lambda kv: str(kv[0]))
    out: List[Tuple[str, str, int]] = []
    for key, meta in chunks:
        m = meta or {}
        file0 = str(m.get("file") or f"{key}.jsonl")
        exp = int(m.get("count") or 0)
        out.append((str(key), file0, exp))
    return out


def count_nonempty_lines(path: Path) -> int:
    n = 0
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            if line.strip():
                n += 1
    return n


def iter_jsonl_objects(path: Path) -> Iterator[dict]:
    """
    Yield parsed JSON objects from a jsonl file, skipping blank lines and parse errors.
    """
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            s = line.strip()
            if not s:
                continue
            try:
                obj = json.loads(s)
            except Exception:
                continue
            if isinstance(obj, dict):
                yield obj


def iter_entity_objects(chunks_dir: Path, *, chunk_files: Optional[Iterable[str]] = None) -> Iterator[Tuple[str, dict]]:
    """
    Yield (filename, entity_obj) across entity chunk jsonl files.
    """
    files: List[Path] = []
    if chunk_files is None:
        files = sorted([p for p in chunks_dir.glob("*.jsonl") if p.is_file()], key=lambda p: p.name)
    else:
        for fn in chunk_files:
            p = chunks_dir / str(fn)
            if p.is_file():
                files.append(p)
        files.sort(key=lambda p: p.name)
    for p in files:
        for obj in iter_jsonl_objects(p):
            yield (p.name, obj)


def norm_ymap_path_like_codewalker(s: str) -> str:
    """
    Normalize ymap path strings down to a CodeWalker-ish key:
      'x64r.rpf\\levels\\gta5\\...' (lowercased)

    Our exports often embed an absolute prefix:
      '/data/.../gta5/x64r.rpf\\levels\\...'
    """
    t = str(s or "").strip().lower()
    if not t:
        return ""
    t = t.replace("/", "\\")
    j = t.rfind(".rpf\\")
    if j >= 0:
        i = t.rfind("\\", 0, j)
        if i >= 0:
            return t[i + 1 :]
    return t


def cw_active_ymap_count_all_plus_patchday27ng(gfc) -> Tuple[int, dict]:
    """
    Compute CodeWalker "include everything" YMAP key count:
    - baseline: gfc.YmapDict for current SelectedDlc (usually "__all__")
    - plus: keys from patchday27ng YmapDict that aren't already present

    This mirrors the exporter behavior (best-effort, avoid double-counting overrides).
    """
    meta: dict = {"patchday27ng": {"available": False, "total": 0, "added": 0, "restore_failed": False}}
    ymapdict = getattr(gfc, "YmapDict", None)
    if ymapdict is None:
        return 0, meta

    keys: set[int] = set()
    try:
        for kv in ymapdict:
            try:
                k = getattr(kv, "Key", None) or kv.Key
                keys.add(int(k) & 0xFFFFFFFF)
            except Exception:
                continue
    except Exception:
        pass

    base_count = len(keys)

    try:
        if hasattr(gfc, "SetDlcLevel"):
            meta["patchday27ng"]["available"] = True
            try:
                orig_sel = str(getattr(gfc, "SelectedDlc", "") or "")
            except Exception:
                orig_sel = ""
            try:
                orig_enable = bool(getattr(gfc, "EnableDlc", True))
            except Exception:
                orig_enable = True
            try:
                if bool(gfc.SetDlcLevel("patchday27ng", True)):
                    d27 = getattr(gfc, "YmapDict", None)
                    if d27 is not None:
                        try:
                            meta["patchday27ng"]["total"] = int(getattr(d27, "Count", 0) or 0)
                        except Exception:
                            meta["patchday27ng"]["total"] = 0
                        for kv in d27:
                            try:
                                k = getattr(kv, "Key", None) or kv.Key
                                ku32 = int(k) & 0xFFFFFFFF
                            except Exception:
                                continue
                            if ku32 not in keys:
                                keys.add(ku32)
                                meta["patchday27ng"]["added"] = int(meta["patchday27ng"]["added"]) + 1
            finally:
                try:
                    gfc.SetDlcLevel(orig_sel, bool(orig_enable))
                except Exception:
                    meta["patchday27ng"]["restore_failed"] = True
    except Exception:
        pass

    return base_count + int(meta["patchday27ng"]["added"]), meta



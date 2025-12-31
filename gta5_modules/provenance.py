from __future__ import annotations

import hashlib
import json
import os
import platform
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Literal, Optional, Tuple


HashMode = Literal["none", "fast", "full"]


def _sha256_bytes(data: bytes) -> str:
    h = hashlib.sha256()
    h.update(data)
    return h.hexdigest()


def sha256_file_full(path: Path, *, chunk_size: int = 8 * 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def sha256_file_fast(path: Path, *, head_bytes: int = 4 * 1024 * 1024, tail_bytes: int = 4 * 1024 * 1024) -> str:
    """
    Fast-ish fingerprint:
    sha256( size || mtime_ns || head || tail )

    This is not cryptographically equivalent to hashing the whole file,
    but is typically "good enough" to detect changes in large archives quickly.
    """
    st = path.stat()
    size = st.st_size
    mtime_ns = int(st.st_mtime_ns)

    with path.open("rb") as f:
        head = f.read(head_bytes)
        if size > tail_bytes:
            f.seek(max(0, size - tail_bytes))
        tail = f.read(tail_bytes)

    payload = b"".join(
        [
            str(size).encode("utf-8"),
            b"\n",
            str(mtime_ns).encode("utf-8"),
            b"\n",
            head,
            b"\n",
            tail,
        ]
    )
    return _sha256_bytes(payload)


def file_fingerprint(path: Path, *, mode: HashMode) -> Optional[str]:
    if mode == "none":
        return None
    if mode == "fast":
        return sha256_file_fast(path)
    if mode == "full":
        return sha256_file_full(path)
    raise ValueError(f"Unknown hash mode: {mode}")


def run_cmd_capture(cmd: List[str], *, cwd: Optional[Path] = None) -> Tuple[int, str]:
    try:
        p = subprocess.run(cmd, cwd=str(cwd) if cwd else None, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        return int(p.returncode), (p.stdout or "").strip()
    except Exception as e:
        return 1, f"{type(e).__name__}: {e}"


def git_info(repo_root: Path) -> Dict[str, Any]:
    code, head = run_cmd_capture(["git", "rev-parse", "HEAD"], cwd=repo_root)
    head = head if code == 0 else None
    code2, status = run_cmd_capture(["git", "status", "--porcelain"], cwd=repo_root)
    dirty = (code2 == 0 and bool(status.strip()))
    return {
        "head": head,
        "dirty": bool(dirty),
    }


def tool_versions(repo_root: Path) -> Dict[str, Any]:
    dotnet_rc, dotnet_ver = run_cmd_capture(["dotnet", "--version"], cwd=repo_root)
    return {
        "python": sys.version.replace("\n", " "),
        "dotnet": dotnet_ver if dotnet_rc == 0 else None,
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "python_implementation": platform.python_implementation(),
        },
    }


def summarize_tree_bytes(root: Path) -> Dict[str, int]:
    """
    Returns bytes by top-level folder under `root` (relative to root).
    Also includes "." for files directly under root.
    """
    out: Dict[str, int] = {}
    if not root.exists():
        return out

    for p in root.rglob("*"):
        if not p.is_file():
            continue
        try:
            rel = p.relative_to(root)
        except Exception:
            continue
        top = rel.parts[0] if len(rel.parts) > 1 else "."
        out[top] = int(out.get(top, 0) + p.stat().st_size)
    return out


def count_by_suffix(root: Path, *, suffixes: Iterable[str]) -> Dict[str, int]:
    suffixes_lc = [s.lower() for s in suffixes]
    counts = {s: 0 for s in suffixes_lc}
    if not root.exists():
        return counts
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        suf = p.suffix.lower()
        if suf in counts:
            counts[suf] += 1
    return counts


def build_inputs_manifest(
    *,
    repo_root: Path,
    game_root: Path,
    rpfs: List[Path],
    run_id: str,
    started_at_unix: float,
    hash_mode: HashMode = "fast",
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    items: List[Dict[str, Any]] = []
    for p in rpfs:
        try:
            st = p.stat()
        except FileNotFoundError:
            continue
        rel = None
        try:
            rel = str(p.relative_to(game_root))
        except Exception:
            rel = str(p)
        items.append(
            {
                "path": rel,
                "abs_path": str(p),
                "size": int(st.st_size),
                "mtime_ns": int(st.st_mtime_ns),
                "hash": file_fingerprint(p, mode=hash_mode),
                "hash_mode": hash_mode,
            }
        )

    return {
        "schema": "webgl-gta.inputs.v1",
        "run_id": run_id,
        "started_at_unix": started_at_unix,
        "started_at_iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started_at_unix)),
        "repo": {"root": str(repo_root), **git_info(repo_root)},
        "tools": tool_versions(repo_root),
        "game_root": {"abs_path": str(game_root)},
        "rpfs": items,
        "extra": extra or {},
    }


def build_outputs_manifest(
    *,
    output_root: Path,
    run_id: str,
    started_at_unix: float,
    finished_at_unix: float,
    hash_mode: HashMode = "fast",
) -> Dict[str, Any]:
    files: List[Dict[str, Any]] = []
    if output_root.exists():
        for p in sorted(output_root.rglob("*")):
            if not p.is_file():
                continue
            rel = str(p.relative_to(output_root))
            st = p.stat()
            files.append(
                {
                    "path": rel,
                    "size": int(st.st_size),
                    "mtime_ns": int(st.st_mtime_ns),
                    "hash": file_fingerprint(p, mode=hash_mode),
                    "hash_mode": hash_mode,
                }
            )

    counts = count_by_suffix(output_root, suffixes=[".ymap", ".ytyp", ".ybn", ".ydr", ".ydd", ".yft", ".ytd", ".gtxd", ".png", ".json", ".obj", ".glb"])
    bytes_by_top = summarize_tree_bytes(output_root)

    return {
        "schema": "webgl-gta.outputs.v1",
        "run_id": run_id,
        "started_at_unix": started_at_unix,
        "finished_at_unix": finished_at_unix,
        "started_at_iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started_at_unix)),
        "finished_at_iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(finished_at_unix)),
        "counts_by_suffix": counts,
        "bytes_by_top_level": bytes_by_top,
        "files": files,
    }


def write_json(path: Path, data: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")



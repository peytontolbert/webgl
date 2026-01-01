"""
Scan exported model texture files and report "invalid format" causes.

Common failure modes in the WebGL viewer:
- A .png URL that actually returns HTML (SPA fallback / missing asset)
- A .png file that is actually DDS/KTX2 bytes
- Truncated/corrupt PNGs (signature present but missing IHDR, etc.)

This tool:
- Scans assets/models/models_textures/* (default)
- Optionally loads assets/models/manifest.json and validates referenced texture paths

Usage (from repo root):
  python webgl/webgl_viewer/tools/scan_model_textures.py
  python webgl/webgl_viewer/tools/scan_model_textures.py --root webgl/webgl_viewer --manifest webgl/webgl_viewer/assets/models/manifest.json
"""

from __future__ import annotations

import argparse
import json
import os
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional


PNG_SIG = b"\x89PNG\r\n\x1a\n"


@dataclass(frozen=True)
class FileSig:
    kind: str
    detail: str


def _read_head(p: Path, n: int = 64) -> bytes:
    try:
        with p.open("rb") as f:
            return f.read(n)
    except Exception:
        return b""


def _strip_leading_ws(b: bytes) -> bytes:
    i = 0
    while i < len(b) and b[i] in (9, 10, 13, 32):  # \t \n \r space
        i += 1
    return b[i:]


def sniff_bytes(head: bytes) -> FileSig:
    if not head:
        return FileSig("unreadable_or_empty", "no bytes read")

    b = _strip_leading_ws(head)
    if not b:
        return FileSig("empty_or_whitespace", "only whitespace")

    # HTML (very common on static hosts with SPA fallback)
    if b.startswith(b"<"):
        return FileSig("html", "starts with '<'")

    # DDS
    if b.startswith(b"DDS "):
        return FileSig("dds", "DDS magic")

    # KTX2 signature: «KTX 20»\r\n\x1a\n
    if len(b) >= 12 and b[:12] == b"\xABKTX 20\xBB\r\n\x1A\n":
        return FileSig("ktx2", "KTX2 magic")

    # PNG
    if b.startswith(PNG_SIG):
        # minimal sanity: must contain IHDR chunk header soon after signature
        # PNG format: 8-byte sig, then 4-byte length + 4-byte type ("IHDR")
        if len(b) < 16:
            return FileSig("png_truncated", "signature present but too short for IHDR header")
        ihdr_type = b[12:16]
        if ihdr_type != b"IHDR":
            return FileSig("png_suspicious", f"signature ok but first chunk type={ihdr_type!r} (expected b'IHDR')")
        return FileSig("png", "signature ok (IHDR present)")

    # JPEG
    if len(b) >= 3 and b[0:3] == b"\xFF\xD8\xFF":
        return FileSig("jpeg", "SOI header")

    # GIF
    if b.startswith(b"GIF87a") or b.startswith(b"GIF89a"):
        return FileSig("gif", "GIF header")

    # BMP
    if len(b) >= 2 and b[0:2] == b"BM":
        return FileSig("bmp", "BM header")

    # WebP (RIFF....WEBP)
    if len(b) >= 12 and b[0:4] == b"RIFF" and b[8:12] == b"WEBP":
        return FileSig("webp", "RIFF WEBP header")

    return FileSig("unknown", f"head={b[:16].hex(' ')}")


def iter_files(root: Path, rel_dir: Path) -> Iterable[Path]:
    d = root / rel_dir
    if not d.exists():
        return []
    out = []
    for p in d.rglob("*"):
        if p.is_file():
            out.append(p)
    return out


def load_manifest_texture_paths(manifest_path: Path) -> list[str]:
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return []
    meshes = (data.get("meshes") if isinstance(data, dict) else None) or {}
    if not isinstance(meshes, dict):
        return []

    paths: list[str] = []
    for _hash, entry in meshes.items():
        if not isinstance(entry, dict):
            continue
        # v4 may store material at entry level and/or per-submesh
        mats = []
        if isinstance(entry.get("material"), dict):
            mats.append(entry.get("material"))
        lods = entry.get("lods")
        if isinstance(lods, dict):
            for _lodName, lodMeta in lods.items():
                if not isinstance(lodMeta, dict):
                    continue
                # v4 path: submeshes
                subs = lodMeta.get("submeshes")
                if isinstance(subs, list):
                    for sm in subs:
                        if isinstance(sm, dict) and isinstance(sm.get("material"), dict):
                            mats.append(sm.get("material"))
                # v3 style doesn't store materials here (entry.material already handled)
        for mat in mats:
            for k in ("diffuse", "normal", "spec"):
                v = mat.get(k)
                if isinstance(v, str) and v:
                    paths.append(v)
    # de-dupe while preserving order
    seen = set()
    out = []
    for p in paths:
        if p in seen:
            continue
        seen.add(p)
        out.append(p)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="webgl/webgl_viewer", help="Viewer root containing assets/ (default: webgl/webgl_viewer)")
    ap.add_argument("--dir", default="assets/models/models_textures", help="Relative directory to scan (default: assets/models/models_textures)")
    ap.add_argument("--manifest", default="webgl/webgl_viewer/assets/models/manifest.json", help="Path to models manifest.json (optional)")
    ap.add_argument("--max-print", type=int, default=30, help="Max entries to print per problem type")
    args = ap.parse_args()

    root = Path(args.root)
    rel_dir = Path(args.dir)
    manifest_path = Path(args.manifest)

    files = list(iter_files(root, rel_dir))
    print(f"[scan] root={root} dir={rel_dir} files={len(files)}")

    counts = Counter()
    problems: dict[str, list[tuple[str, int, str]]] = defaultdict(list)  # kind -> [(relpath, size, detail)]

    for p in files:
        head = _read_head(p, 64)
        sig = sniff_bytes(head)
        counts[sig.kind] += 1
        if sig.kind not in ("png", "jpeg", "webp", "gif", "bmp"):
            try:
                rel = p.relative_to(root).as_posix()
            except Exception:
                rel = str(p)
            try:
                size = p.stat().st_size
            except Exception:
                size = -1
            problems[sig.kind].append((rel, size, sig.detail))

    print("\n[summary] file signature counts:")
    for k, v in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
        print(f"  {k:18s}  {v}")

    # Print problem samples
    if problems:
        print("\n[samples] non-standard / problematic files:")
        for kind in sorted(problems.keys()):
            arr = problems[kind]
            print(f"\n  - {kind}: {len(arr)}")
            for rel, size, detail in arr[: max(0, int(args.max_print))]:
                print(f"    {rel}  size={size}  {detail}")

    # Manifest parity checks
    if manifest_path.exists():
        tex_paths = load_manifest_texture_paths(manifest_path)
        print(f"\n[manifest] {manifest_path} textures referenced={len(tex_paths)}")

        missing = []
        bad_ext = []
        bad_sig = []
        for rel in tex_paths:
            rel_norm = rel.replace("\\", "/")
            full = root / "assets" / rel_norm if not rel_norm.startswith("assets/") else root / rel_norm
            if not full.exists():
                missing.append(rel_norm)
                continue
            ext = full.suffix.lower()
            if ext not in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"):
                bad_ext.append(rel_norm)
            sig = sniff_bytes(_read_head(full, 64))
            if sig.kind not in ("png", "jpeg", "webp", "gif", "bmp"):
                bad_sig.append((rel_norm, sig.kind, sig.detail))

        if missing:
            print(f"[manifest] missing files: {len(missing)} (first {min(len(missing), args.max_print)})")
            for p in missing[: args.max_print]:
                print(f"  MISSING {p}")
        if bad_ext:
            print(f"[manifest] non-browser extensions: {len(bad_ext)} (first {min(len(bad_ext), args.max_print)})")
            for p in bad_ext[: args.max_print]:
                print(f"  EXT {p}")
        if bad_sig:
            print(f"[manifest] referenced files with non-image signatures: {len(bad_sig)} (first {min(len(bad_sig), args.max_print)})")
            for rel_norm, kind, detail in bad_sig[: args.max_print]:
                print(f"  SIG {rel_norm}  kind={kind}  {detail}")

    else:
        print(f"\n[manifest] skipped (not found): {manifest_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())



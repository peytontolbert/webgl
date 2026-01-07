#!/usr/bin/env python3
"""
verify_assets.py

Lightweight offline verifier for /webgl_viewer/assets.

Goals:
- Catch missing/corrupt files early (especially mesh bins).
- Validate the huge models manifest (assets/models/manifest.json) without loading it into RAM.

This does NOT require WebGL, a browser, or Node.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set, Tuple


PNG_SIG = b"\x89PNG\r\n\x1a\n"
KTX2_SIG = b"\xabKTX 20\xbb\r\n\x1a\n"


def _read_sig(p: Path, n: int = 16) -> bytes:
    with p.open("rb") as f:
        return f.read(n)


def _is_png(p: Path) -> bool:
    return _read_sig(p, 8) == PNG_SIG


def _is_jpeg(p: Path) -> bool:
    sig = _read_sig(p, 3)
    return len(sig) == 3 and sig[0] == 0xFF and sig[1] == 0xD8 and sig[2] == 0xFF


def _is_webp(p: Path) -> bool:
    sig = _read_sig(p, 12)
    return len(sig) == 12 and sig[0:4] == b"RIFF" and sig[8:12] == b"WEBP"


def _is_ktx2(p: Path) -> bool:
    return _read_sig(p, 12) == KTX2_SIG


@dataclass
class MeshBinHeader:
    magic: str
    version: int
    vertex_count: int
    index_count: int
    flags: int


def _u32_le(b: bytes) -> int:
    return int.from_bytes(b, "little", signed=False)


def parse_mesh_bin_header(p: Path) -> MeshBinHeader:
    with p.open("rb") as f:
        hdr = f.read(20)
    if len(hdr) != 20:
        raise ValueError("truncated header")
    magic = hdr[0:4].decode("ascii", errors="replace")
    version = _u32_le(hdr[4:8])
    vertex_count = _u32_le(hdr[8:12])
    index_count = _u32_le(hdr[12:16])
    flags = _u32_le(hdr[16:20])
    return MeshBinHeader(magic=magic, version=version, vertex_count=vertex_count, index_count=index_count, flags=flags)


def mesh_bin_expected_size_bytes(h: MeshBinHeader) -> int:
    # Mirrors `ModelManager._parseAndUploadMesh` in js/model_manager.js.
    if h.version not in (1, 2, 3, 4, 5, 6, 7):
        raise ValueError(f"unsupported version {h.version}")
    header_bytes = 20
    pos_bytes = h.vertex_count * 3 * 4
    has_normals = h.version >= 2 and (h.flags & 1) == 1
    nrm_bytes = (h.vertex_count * 3 * 4) if has_normals else 0
    has_uvs = h.version >= 3 and (h.flags & 2) == 2
    uv_bytes = (h.vertex_count * 2 * 4) if has_uvs else 0
    has_uv1 = h.version >= 6 and (h.flags & 16) == 16
    uv1_bytes = (h.vertex_count * 2 * 4) if has_uv1 else 0
    has_uv2 = h.version >= 7 and (h.flags & 32) == 32
    uv2_bytes = (h.vertex_count * 2 * 4) if has_uv2 else 0
    has_tangents = h.version >= 4 and (h.flags & 4) == 4
    tan_bytes = (h.vertex_count * 4 * 4) if has_tangents else 0
    has_color0 = h.version >= 5 and (h.flags & 8) == 8
    col0_bytes = (h.vertex_count * 4) if has_color0 else 0
    has_color1 = h.version >= 7 and (h.flags & 64) == 64
    col1_bytes = (h.vertex_count * 4) if has_color1 else 0
    idx_bytes = h.index_count * 4
    return header_bytes + pos_bytes + nrm_bytes + uv_bytes + uv1_bytes + uv2_bytes + tan_bytes + col0_bytes + col1_bytes + idx_bytes


def verify_mesh_bin(p: Path, *, deep_indices: bool = False) -> Tuple[bool, str]:
    try:
        st = p.stat()
    except FileNotFoundError:
        return False, "missing"
    if st.st_size < 20:
        return False, f"too small ({st.st_size} bytes)"
    try:
        h = parse_mesh_bin_header(p)
    except Exception as e:
        return False, f"bad header: {e}"
    if h.magic != "MSH0":
        return False, f"bad magic {h.magic!r}"
    if h.version not in (1, 2, 3, 4, 5, 6, 7):
        return False, f"bad version {h.version}"
    try:
        need = mesh_bin_expected_size_bytes(h)
    except Exception as e:
        return False, f"size calc failed: {e}"
    if need > st.st_size:
        return False, f"truncated: need {need} bytes, have {st.st_size}"

    # Cheap index sanity: sample a handful of indices to ensure they don't exceed vertexCount.
    # (Full scan is optional; can be very slow on huge meshes.)
    try:
        # Compute index buffer offset.
        header_bytes = 20
        pos_bytes = h.vertex_count * 3 * 4
        has_normals = h.version >= 2 and (h.flags & 1) == 1
        nrm_bytes = (h.vertex_count * 3 * 4) if has_normals else 0
        has_uvs = h.version >= 3 and (h.flags & 2) == 2
        uv_bytes = (h.vertex_count * 2 * 4) if has_uvs else 0
        has_uv1 = h.version >= 6 and (h.flags & 16) == 16
        uv1_bytes = (h.vertex_count * 2 * 4) if has_uv1 else 0
        has_uv2 = h.version >= 7 and (h.flags & 32) == 32
        uv2_bytes = (h.vertex_count * 2 * 4) if has_uv2 else 0
        has_tangents = h.version >= 4 and (h.flags & 4) == 4
        tan_bytes = (h.vertex_count * 4 * 4) if has_tangents else 0
        has_color0 = h.version >= 5 and (h.flags & 8) == 8
        col0_bytes = (h.vertex_count * 4) if has_color0 else 0
        has_color1 = h.version >= 7 and (h.flags & 64) == 64
        col1_bytes = (h.vertex_count * 4) if has_color1 else 0
        idx_off = header_bytes + pos_bytes + nrm_bytes + uv_bytes + uv1_bytes + uv2_bytes + tan_bytes + col0_bytes + col1_bytes

        sample = 1024
        with p.open("rb") as f:
            # head sample
            f.seek(idx_off, os.SEEK_SET)
            head = f.read(min(h.index_count, sample) * 4)
            # tail sample
            if h.index_count > sample:
                f.seek(idx_off + (h.index_count - sample) * 4, os.SEEK_SET)
                tail = f.read(sample * 4)
            else:
                tail = b""
        def iter_u32(buf: bytes) -> Iterable[int]:
            for i in range(0, len(buf) - (len(buf) % 4), 4):
                yield _u32_le(buf[i:i+4])
        for ix in list(iter_u32(head)) + list(iter_u32(tail)):
            if ix >= h.vertex_count and h.vertex_count != 0:
                return False, f"index out of range: {ix} >= {h.vertex_count}"

        if deep_indices:
            # Full scan (still streaming).
            with p.open("rb") as f:
                f.seek(idx_off, os.SEEK_SET)
                left = h.index_count
                chunk_u32 = 1_000_000
                while left > 0:
                    n = min(left, chunk_u32)
                    buf = f.read(n * 4)
                    if len(buf) != n * 4:
                        return False, "truncated while reading indices"
                    for ix in iter_u32(buf):
                        if ix >= h.vertex_count and h.vertex_count != 0:
                            return False, f"index out of range: {ix} >= {h.vertex_count}"
                    left -= n
    except Exception as e:
        return False, f"index check failed: {e}"

    return True, f"ok v{h.version} verts={h.vertex_count} idx={h.index_count} flags=0x{h.flags:x}"


def _walk_files(root: Path) -> Iterable[Path]:
    for dp, _dns, fns in os.walk(root):
        dpp = Path(dp)
        for fn in fns:
            yield dpp / fn


def _load_small_json(p: Path, *, max_mb: float = 50.0) -> Tuple[bool, str]:
    try:
        st = p.stat()
    except FileNotFoundError:
        return False, "missing"
    if st.st_size > int(max_mb * 1024 * 1024):
        return True, f"skipped (too large: {st.st_size/1024/1024:.1f}MB)"
    try:
        with p.open("r", encoding="utf-8") as f:
            json.load(f)
        return True, "ok"
    except Exception as e:
        return False, f"json parse failed: {e}"


_RE_MANIFEST_BIN_FILE = re.compile(r'"file"\s*:\s*"([^"]+?\.bin)"')
_RE_MANIFEST_ASSET_PATH = re.compile(r'"([^"]+?\.(?:png|ktx2|jpg|jpeg|webp))"')


def _load_asset_packs(asset_packs_json: Path) -> List[str]:
    """
    Load pack rootRel entries (relative to assets/) similar to TexturePathResolver:
    - only enabled packs
    - higher priority first
    Returns list like ["packs/patchday2ng", "packs/mp2025_01", ...]
    """
    try:
        data = json.loads(asset_packs_json.read_text("utf-8"))
    except Exception:
        return []
    packs0 = data.get("packs") if isinstance(data, dict) else (data if isinstance(data, list) else None)
    if not isinstance(packs0, list):
        return []
    packs = []
    for p in packs0:
        if not isinstance(p, dict):
            continue
        enabled = True if p.get("enabled") is None else bool(p.get("enabled"))
        if not enabled:
            continue
        pid = str(p.get("id") or "").strip()
        if not pid:
            continue
        root_rel = str(p.get("rootRel") or p.get("root") or "").strip()
        if not root_rel:
            root_rel = f"packs/{pid}"
        root_rel = root_rel.lstrip("/").rstrip("/")
        prio = p.get("priority")
        try:
            prio_f = float(prio)
        except Exception:
            prio_f = 0.0
        packs.append((prio_f, pid, root_rel))
    packs.sort(key=lambda t: (-t[0], t[1]))
    return [r for _prio, _pid, r in packs]


class PackAwareAssetLocator:
    """
    Minimal filesystem mirror of TexturePathResolver behavior for *existence* checks.
    """

    def __init__(self, viewer_root: Path):
        self.viewer_root = viewer_root
        self.assets_root = viewer_root / "assets"
        self._pack_root_rels: List[str] = []
        self._pack_root_paths: List[Path] = []
        self._init_packs()

    def _init_packs(self) -> None:
        roots: List[str] = []
        ap = self.assets_root / "asset_packs.json"
        if ap.exists():
            roots.extend(_load_asset_packs(ap))
        # Also include any on-disk pack folders that aren't in the JSON (defensive).
        packs_dir = self.assets_root / "packs"
        if packs_dir.exists():
            try:
                for p in packs_dir.iterdir():
                    if not p.is_dir():
                        continue
                    rel = f"packs/{p.name}"
                    if rel not in roots:
                        roots.append(rel)
            except Exception:
                pass
        self._pack_root_rels = roots
        self._pack_root_paths = [self.assets_root / r for r in roots]

    def exists_rel(self, rel: str) -> bool:
        r = str(rel or "").strip().lstrip("/")
        if not r:
            return False
        # normalize leading "assets/"
        if r.lower().startswith("assets/"):
            r = r[7:]
        p = self.assets_root / r
        try:
            return p.exists() and p.is_file() and p.stat().st_size > 0
        except Exception:
            return False

    def exists_in_any_pack(self, rel: str) -> bool:
        r = str(rel or "").strip().lstrip("/")
        if not r:
            return False
        if r.lower().startswith("assets/"):
            r = r[7:]
        # Only meaningful for pack-relative roots (we test packRoot/ + r).
        for root in self._pack_root_paths:
            p = root / r
            try:
                if p.exists() and p.is_file() and p.stat().st_size > 0:
                    return True
            except Exception:
                continue
        return False

    def exists_model_texture_ref(self, rel: str) -> bool:
        """
        Existence check for model textures referenced as:
        - models_textures/<hash>...(.png/.jpg/.webp/.ktx2)
        - models_textures_ktx2/<hash>...(.ktx2)
        Viewer can serve these from either the base assets root or an asset pack root.
        """
        r0 = str(rel or "").strip()
        if not r0:
            return False
        r = r0.lstrip("/").replace("\\", "/")
        if r.lower().startswith("assets/"):
            r = r[7:]
        # Normalize aliases like the resolver does.
        r = re.sub(r"^(model_texture|model_textures|models_texture)/", "models_textures/", r, flags=re.IGNORECASE)

        # Direct existence (base).
        if self.exists_rel(r):
            return True

        # Pack existence (same rel under packs/<id>/...).
        if self.exists_in_any_pack(r):
            return True

        return False


def scan_huge_manifest_for_refs(
    manifest_path: Path,
    *,
    kind: str,
    on_ref,
    chunk_bytes: int = 1 << 20,
) -> Tuple[int, int]:
    """
    Stream-scan a huge JSON file for references without parsing the whole document.

    Returns: (total_refs_seen, unique_refs_seen)
    """
    if kind not in ("bin", "asset"):
        raise ValueError("kind must be 'bin' or 'asset'")
    rx = _RE_MANIFEST_BIN_FILE if kind == "bin" else _RE_MANIFEST_ASSET_PATH

    seen: Set[str] = set()
    total = 0
    tail = ""
    with manifest_path.open("r", encoding="utf-8", errors="ignore") as f:
        while True:
            chunk = f.read(chunk_bytes)
            if not chunk:
                break
            buf = tail + chunk
            for m in rx.finditer(buf):
                ref = m.group(1)
                total += 1
                if ref in seen:
                    continue
                seen.add(ref)
                on_ref(ref)
            tail = buf[-256:] if len(buf) > 256 else buf
    return total, len(seen)


def main(argv: Optional[Iterable[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Verify /webgl_viewer/assets are present and parseable.")
    ap.add_argument(
        "--viewer-root",
        default=str(Path(__file__).resolve().parents[1]),
        help="Path to webgl_viewer (defaults to the repo copy this script lives in).",
    )
    ap.add_argument(
        "--check-filesystem",
        action="store_true",
        help="Walk assets/ and sanity-check file headers (png/jpg/webp/ktx2) and small JSON parse.",
    )
    ap.add_argument(
        "--check-model-manifest",
        action="store_true",
        help="Scan assets/models/manifest.json and verify all referenced .bin mesh files exist and have valid headers.",
    )
    ap.add_argument(
        "--check-model-manifest-assets",
        action="store_true",
        help="Also scan assets/models/manifest.json for referenced image paths (.png/.ktx2/.jpg/.webp) and verify they exist.",
    )
    ap.add_argument(
        "--deep-indices",
        action="store_true",
        help="Fully scan all mesh indices for out-of-range values (slow).",
    )
    ap.add_argument(
        "--max-errors",
        type=int,
        default=50,
        help="Stop after this many errors (default 50). Use 0 for unlimited.",
    )
    args = ap.parse_args(list(argv) if argv is not None else None)

    viewer_root = Path(args.viewer_root).resolve()
    assets_root = viewer_root / "assets"
    models_root = assets_root / "models"
    models_manifest = models_root / "manifest.json"
    locator = PackAwareAssetLocator(viewer_root)

    if not assets_root.exists():
        print(f"ERROR: assets root missing: {assets_root}", file=sys.stderr)
        return 2

    errors = 0
    def bump(msg: str) -> None:
        nonlocal errors
        errors += 1
        print(f"ERROR: {msg}")

    def should_stop() -> bool:
        return args.max_errors > 0 and errors >= args.max_errors

    print(f"viewer_root={viewer_root}")
    print(f"assets_root={assets_root}")

    # Core files that should exist for the viewer to work.
    core = [
        assets_root / "entities_index.json",
        assets_root / "terrain_info.json",
        assets_root / "heightmap_u16.bin",
        assets_root / "heightmap_u16.json",
        assets_root / "shader_param_names.json",
        assets_root / "asset_packs.json",
        models_manifest,
    ]
    for p in core:
        if not p.exists():
            bump(f"missing core asset: {p}")
            if should_stop():
                return 1

    if args.check_filesystem:
        print("\nScanning filesystem assets (headers + small JSON)...")
        for p in _walk_files(assets_root):
            if should_stop():
                break
            # Skip gigantic models manifest (handled separately).
            if p == models_manifest:
                continue

            suf = p.suffix.lower()
            try:
                if p.stat().st_size == 0:
                    bump(f"{p.relative_to(viewer_root)}: empty file")
                    continue
            except FileNotFoundError:
                bump(f"{p.relative_to(viewer_root)}: missing")
                continue
            if suf == ".json":
                ok, msg = _load_small_json(p, max_mb=50.0)
                if not ok:
                    bump(f"{p.relative_to(viewer_root)}: {msg}")
            elif suf == ".png":
                try:
                    if not _is_png(p):
                        bump(f"{p.relative_to(viewer_root)}: bad PNG signature")
                except Exception as e:
                    bump(f"{p.relative_to(viewer_root)}: png read failed: {e}")
            elif suf in (".jpg", ".jpeg"):
                try:
                    if not _is_jpeg(p):
                        bump(f"{p.relative_to(viewer_root)}: bad JPEG signature")
                except Exception as e:
                    bump(f"{p.relative_to(viewer_root)}: jpeg read failed: {e}")
            elif suf == ".webp":
                try:
                    if not _is_webp(p):
                        bump(f"{p.relative_to(viewer_root)}: bad WEBP signature")
                except Exception as e:
                    bump(f"{p.relative_to(viewer_root)}: webp read failed: {e}")
            elif suf == ".ktx2":
                try:
                    if not _is_ktx2(p):
                        bump(f"{p.relative_to(viewer_root)}: bad KTX2 signature")
                except Exception as e:
                    bump(f"{p.relative_to(viewer_root)}: ktx2 read failed: {e}")
            elif suf == ".bin" and p.parent.name == "models":
                ok, msg = verify_mesh_bin(p, deep_indices=args.deep_indices)
                if not ok:
                    bump(f"{p.relative_to(viewer_root)}: {msg}")

        print(f"filesystem scan complete. errors={errors}")

    if args.check_model_manifest or args.check_model_manifest_assets:
        if not models_manifest.exists():
            bump(f"missing models manifest: {models_manifest}")
            return 1

        # Cache results so repeated refs don't cost re-reads.
        mesh_ok: Dict[str, bool] = {}

        def on_bin_ref(ref: str) -> None:
            nonlocal errors
            if should_stop():
                return
            # Manifest stores file names relative to assets/models/
            rel = ref.replace("\\", "/").lstrip("/")
            p = models_root / rel
            key = str(p)
            if key in mesh_ok:
                return
            ok, msg = verify_mesh_bin(p, deep_indices=args.deep_indices)
            mesh_ok[key] = ok
            if not ok:
                bump(f"models/manifest.json -> models/{rel}: {msg}")

        def on_asset_ref(ref: str) -> None:
            if should_stop():
                return
            rel = ref.replace("\\", "/").lstrip("/")
            # Use pack-aware resolution for model textures, since the viewer can serve them
            # from `assets/models_textures/...` OR `assets/packs/<pack>/models_textures/...`.
            if locator.exists_model_texture_ref(rel):
                return
            # Fallback: plain existence check at assets/<rel>
            if not locator.exists_rel(rel):
                bump(f"models/manifest.json -> {rel}: missing")

        if args.check_model_manifest:
            print("\nScanning models/manifest.json for .bin references (streaming)...")
            total, uniq = scan_huge_manifest_for_refs(models_manifest, kind="bin", on_ref=on_bin_ref)
            print(f"manifest scan done: total_bin_refs={total} unique_bin_files={uniq} errors={errors}")

        if args.check_model_manifest_assets:
            print("\nScanning models/manifest.json for image path references (streaming)...")
            total, uniq = scan_huge_manifest_for_refs(models_manifest, kind="asset", on_ref=on_asset_ref)
            print(f"manifest scan done: total_asset_refs={total} unique_asset_paths={uniq} errors={errors}")

    if errors == 0:
        print("\nOK: no errors found.")
        return 0
    print(f"\nDONE: errors={errors}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())



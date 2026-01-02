"""
Probe model textures "like the renderer would" (offline).

This script answers:
- Which texture paths are referenced by the exported model manifests (including sharded manifests)?
- Do those files exist under webgl/webgl_viewer/assets/ (and optionally dist/assets/)?
- Do the bytes look like real browser-decodable images (PNG/JPEG/WebP/GIF/BMP), or common failure modes
  like HTML (SPA fallback), DDS, KTX2 mislabeled, or unknown/truncated?
- Do we have hash+slug files without hash-only aliases (a common mismatch when the runtime wants <hash>.png)?

Usage (from repo root):
  python webgl/webgl_viewer/tools/probe_model_textures_like_viewer.py
  python webgl/webgl_viewer/tools/probe_model_textures_like_viewer.py --check-dist
  python webgl/webgl_viewer/tools/probe_model_textures_like_viewer.py --max-shards 8 --max-meshes 5000
"""

from __future__ import annotations

import argparse
import json
import os
import re
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
    if b.startswith(b"<"):
        return FileSig("html", "starts with '<' (SPA fallback / wrong file)")
    if b.startswith(b"DDS "):
        return FileSig("dds", "DDS magic")
    if len(b) >= 12 and b[:12] == b"\xABKTX 20\xBB\r\n\x1A\n":
        return FileSig("ktx2", "KTX2 magic")
    if b.startswith(PNG_SIG):
        if len(b) < 16:
            return FileSig("png_truncated", "signature present but too short for IHDR header")
        ihdr_type = b[12:16]
        if ihdr_type != b"IHDR":
            return FileSig("png_suspicious", f"signature ok but first chunk type={ihdr_type!r} (expected b'IHDR')")
        return FileSig("png", "signature ok (IHDR present)")
    if len(b) >= 3 and b[0:3] == b"\xFF\xD8\xFF":
        return FileSig("jpeg", "SOI header")
    if b.startswith(b"GIF87a") or b.startswith(b"GIF89a"):
        return FileSig("gif", "GIF header")
    if len(b) >= 2 and b[0:2] == b"BM":
        return FileSig("bmp", "BM header")
    if len(b) >= 12 and b[0:4] == b"RIFF" and b[8:12] == b"WEBP":
        return FileSig("webp", "RIFF WEBP header")
    return FileSig("unknown", f"head={b[:16].hex(' ')}")


def joaat(input_str: str) -> int:
    """GTA joaat hash; matches webgl_viewer/js/joaat.js."""
    s = str(input_str or "").lower()
    h = 0
    for ch in s:
        h = (h + ord(ch)) & 0xFFFFFFFF
        h = (h + ((h << 10) & 0xFFFFFFFF)) & 0xFFFFFFFF
        h ^= (h >> 6)
    h = (h + ((h << 3) & 0xFFFFFFFF)) & 0xFFFFFFFF
    h ^= (h >> 11)
    h = (h + ((h << 15) & 0xFFFFFFFF)) & 0xFFFFFFFF
    return h & 0xFFFFFFFF


_EXT_RE = re.compile(r"\.(png|ktx2|jpg|jpeg|webp|dds|gif|bmp)$", re.IGNORECASE)


def _looks_like_path_or_file(s: str) -> bool:
    t = str(s or "").strip()
    if not t:
        return False
    if "/" in t or "\\" in t:
        return True
    if _EXT_RE.search(t):
        return True
    return False


def _texture_rel_from_shader_param_value(v: str) -> Optional[str]:
    """
    Mirrors the viewer-side intention:
    - if v looks like a path or file, treat as manifest-relative and strip leading "assets/"
    - else treat as a texture name and map to models_textures/<joaat(name)>.png
    """
    s0 = str(v or "").strip()
    if not s0:
        return None
    s = s0.replace("\\", "/")
    if _looks_like_path_or_file(s):
        return re.sub(r"^assets/", "", s, flags=re.IGNORECASE)
    h = joaat(s0)
    return f"models_textures/{int(h) & 0xFFFFFFFF}.png"


def _iter_material_dicts(mesh_entry: dict) -> Iterable[dict]:
    if not isinstance(mesh_entry, dict):
        return []
    mats = []
    m0 = mesh_entry.get("material")
    if isinstance(m0, dict):
        mats.append(m0)
    lods = mesh_entry.get("lods")
    if isinstance(lods, dict):
        for _lod_name, lod_meta in lods.items():
            if not isinstance(lod_meta, dict):
                continue
            subs = lod_meta.get("submeshes")
            if not isinstance(subs, list):
                continue
            for sm in subs:
                if isinstance(sm, dict) and isinstance(sm.get("material"), dict):
                    mats.append(sm.get("material"))
    return mats


def _extract_texture_rels_from_material(mat: dict) -> set[str]:
    out: set[str] = set()
    if not isinstance(mat, dict):
        return out

    # Explicit paths the renderer can resolve directly.
    explicit_keys = (
        "diffuse",
        "diffuse2",
        "normal",
        "spec",
        "emissive",
        "detail",
        "ao",
        "alphaMask",
        "diffuseKtx2",
        "diffuse2Ktx2",
        "normalKtx2",
        "specKtx2",
        "emissiveKtx2",
        "detailKtx2",
        "aoKtx2",
        "alphaMaskKtx2",
    )
    for k in explicit_keys:
        v = mat.get(k)
        if isinstance(v, str) and v.strip():
            out.add(v.strip().replace("\\", "/"))

    # ShaderParams fallback (when explicit keys are absent).
    sp = mat.get("shaderParams")
    tex_by_hash = sp.get("texturesByHash") if isinstance(sp, dict) else None
    if isinstance(tex_by_hash, dict):
        # Mirrors ModelManager._normalizeMaterialFromShaderParamsInPlace slot mapping.
        slots = [
            ("diffuse", ["4059966321", "3576369631", "2946270081"]),
            ("diffuse2", ["181641832"]),
            ("normal", ["1186448975", "1073714531", "1422769919", "2745359528", "2975430677"]),
            ("spec", ["1619499462"]),
            ("detail", ["3393362404"]),
            ("ao", ["1212577329"]),
            ("alphaMask", ["1705051233"]),
        ]
        for key, hashes in slots:
            # Only fill if the explicit material key wasn't present.
            if isinstance(mat.get(key), str) and str(mat.get(key)).strip():
                continue
            for hs in hashes:
                v = tex_by_hash.get(hs) or tex_by_hash.get(int(hs))  # exporter may store keys as ints
                if not isinstance(v, str) or not v.strip():
                    continue
                rel = _texture_rel_from_shader_param_value(v)
                if rel:
                    out.add(rel)
                break

    # Normalize: strip leading "/"
    out2 = set()
    for rel in out:
        r = str(rel or "").strip().replace("\\", "/")
        r = re.sub(r"^/+", "", r)
        out2.add(r)
    return out2


def _resolve_to_assets_url_path(rel: str) -> str:
    """
    Mirrors InstancedModelRenderer._resolveAssetUrl:
      if rel starts with "assets/" keep it, else prefix "assets/".
    Returns a path-like string (no scheme/host) suitable for mapping to disk under viewer root.
    """
    r0 = str(rel or "").strip().replace("\\", "/")
    r = re.sub(r"^/+", "", r0)
    if r.lower().startswith("assets/"):
        return r
    return f"assets/{r}"


def _iter_shard_files(models_dir: Path) -> list[Path]:
    shard_dir = models_dir / "manifest_shards"
    if not shard_dir.exists():
        return []
    out = [p for p in shard_dir.glob("*.json") if p.is_file()]
    out.sort(key=lambda p: p.name)
    return out


def _load_json(path: Path) -> Optional[dict]:
    try:
        # Avoid huge memory spikes on very large files by limiting read size only if needed.
        text = path.read_text(encoding="utf-8", errors="ignore")
        obj = json.loads(text)
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="webgl/webgl_viewer", help="Viewer root containing assets/ (default: webgl/webgl_viewer)")
    ap.add_argument("--max-shards", type=int, default=0, help="Limit number of shard files to scan (0 = all)")
    ap.add_argument("--max-meshes", type=int, default=0, help="Limit number of mesh entries to scan across all shards (0 = all)")
    ap.add_argument("--check-dist", action="store_true", help="Also verify files exist in dist/assets when dist/ exists")
    ap.add_argument("--max-print", type=int, default=40, help="Max entries to print per category")
    args = ap.parse_args()

    viewer_root = Path(args.root)
    assets_root = viewer_root / "assets"
    dist_assets_root = viewer_root / "dist" / "assets"
    check_dist = bool(args.check_dist) and dist_assets_root.exists()

    models_dir = assets_root / "models"
    shard_files = _iter_shard_files(models_dir)
    if not shard_files:
        print("[probe] No sharded manifest found at assets/models/manifest_shards/*.json")
        print("        Falling back to assets/models/manifest.json if present.")
        mono = models_dir / "manifest.json"
        shard_files = [mono] if mono.exists() else []
    if not shard_files:
        raise SystemExit("[probe] No model manifest found under assets/models/")

    if args.max_shards and args.max_shards > 0:
        shard_files = shard_files[: int(args.max_shards)]

    print(f"[probe] viewer_root={viewer_root}")
    print(f"[probe] assets_root={assets_root}")
    print(f"[probe] models_manifests={len(shard_files)} (shards={bool((models_dir/'manifest_shards').exists())})")
    print(f"[probe] check_dist={check_dist} dist_assets_root={dist_assets_root if check_dist else '(skipped)'}")

    # Collect referenced rel paths from manifests.
    referenced: set[str] = set()
    meshes_scanned = 0
    bad_shards = 0
    for sf in shard_files:
        payload = _load_json(sf)
        if not payload:
            bad_shards += 1
            continue
        meshes = payload.get("meshes")
        if not isinstance(meshes, dict):
            continue
        for _h, entry in meshes.items():
            if not isinstance(entry, dict):
                continue
            for mat in _iter_material_dicts(entry):
                referenced |= _extract_texture_rels_from_material(mat)
            meshes_scanned += 1
            if args.max_meshes and args.max_meshes > 0 and meshes_scanned >= int(args.max_meshes):
                break
        if args.max_meshes and args.max_meshes > 0 and meshes_scanned >= int(args.max_meshes):
            break

    print(f"[probe] meshes_scanned={meshes_scanned} bad_manifest_files={bad_shards}")
    print(f"[probe] unique_texture_rels={len(referenced)}")

    # Validate each referenced texture against assets (and dist).
    sig_counts = Counter()
    missing_assets: list[str] = []
    missing_dist: list[str] = []
    bad_sig: dict[str, list[str]] = defaultdict(list)  # kind -> [rel...]

    for rel in sorted(referenced):
        url_path = _resolve_to_assets_url_path(rel)  # "assets/..."
        disk_assets = viewer_root / url_path
        if not disk_assets.exists():
            missing_assets.append(url_path)
            continue
        sig = sniff_bytes(_read_head(disk_assets, 64))
        sig_counts[sig.kind] += 1
        if sig.kind not in ("png", "jpeg", "webp", "gif", "bmp", "ktx2"):
            bad_sig[sig.kind].append(url_path)
        if check_dist:
            disk_dist = dist_assets_root / Path(url_path).relative_to("assets")
            if not disk_dist.exists():
                missing_dist.append(str(disk_dist.relative_to(viewer_root)).replace("\\", "/"))

    print("\n[probe] signature counts (referenced files that exist in assets/):")
    for k, v in sorted(sig_counts.items(), key=lambda kv: (-kv[1], kv[0])):
        print(f"  {k:18s}  {v}")

    if missing_assets:
        print(f"\n[probe] MISSING in assets/: {len(missing_assets)} (first {min(len(missing_assets), args.max_print)})")
        for x in missing_assets[: int(args.max_print)]:
            print("  -", x)

    if check_dist and missing_dist:
        print(f"\n[probe] MISSING in dist/assets/: {len(missing_dist)} (first {min(len(missing_dist), args.max_print)})")
        for x in missing_dist[: int(args.max_print)]:
            print("  -", x)

    if bad_sig:
        print("\n[probe] non-image / suspicious signatures (first N per kind):")
        for kind in sorted(bad_sig.keys()):
            arr = bad_sig[kind]
            print(f"  - {kind}: {len(arr)}")
            for x in arr[: int(args.max_print)]:
                print("    -", x)

    # Alias check: hash+slug without hash-only.
    # This is a common mismatch when the runtime expects models_textures/<hash>.png.
    tex_dir = assets_root / "models_textures"
    alias_missing = 0
    alias_samples = []
    if tex_dir.exists():
        pat = re.compile(r"^(?P<h>\d+)_.*\.png$", re.IGNORECASE)
        try:
            for ent in os.scandir(tex_dir):
                if not ent.is_file():
                    continue
                m = pat.match(ent.name)
                if not m:
                    continue
                h = m.group("h")
                hash_only = tex_dir / f"{h}.png"
                if not hash_only.exists():
                    alias_missing += 1
                    if len(alias_samples) < int(args.max_print):
                        alias_samples.append(f"assets/models_textures/{ent.name}  (missing alias {h}.png)")
        except Exception:
            pass

    print(f"\n[probe] hash+slug PNGs missing hash-only alias: {alias_missing}")
    if alias_samples:
        for s in alias_samples:
            print("  -", s)

    print("\n[probe] done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



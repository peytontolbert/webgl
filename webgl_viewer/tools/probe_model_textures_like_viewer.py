"""
Probe model textures "like the renderer would" (offline).

This script answers:
- Which texture paths are referenced by the exported model manifests (including sharded manifests)?
- Do those files exist under webgl/webgl_viewer/assets/ (and optionally dist/assets/)?
- Do the bytes look like real browser-decodable images (PNG/JPEG/WebP/GIF/BMP), or common failure modes
  like HTML (SPA fallback), DDS, KTX2 mislabeled, or unknown/truncated?
- If a manifest references a model texture filename variant that isn't on disk, will the runtime still
  be able to resolve it (hash-only vs hash+slug) via candidate fallback and/or `assets/models_textures/index.json`?

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
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from gta5_modules.hash_utils import joaat as _joaat
from gta5_modules.texture_naming import (
    looks_like_path_or_file as _looks_like_path_or_file_shared,
    slugify_texture_name as _slugify_texture_name_shared,
    texture_rel_from_shader_param_value as _texture_rel_from_shader_param_value_shared,
)


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
    return int(_joaat(input_str, lower=True)) & 0xFFFFFFFF


_EXT_RE = re.compile(r"\.(png|ktx2|jpg|jpeg|webp|dds|gif|bmp)$", re.IGNORECASE)


def _looks_like_path_or_file(s: str) -> bool:
    return bool(_looks_like_path_or_file_shared(s))


def _slugify_texture_name(name: str) -> str:
    return str(_slugify_texture_name_shared(name))


def _texture_rel_from_shader_param_value(v: str) -> Optional[str]:
    """
    Mirrors the viewer-side behavior (see ModelManager._textureRelFromShaderParamValue):
    - if v looks like a path or file, treat as manifest-relative and strip leading "assets/"
    - else treat as a texture name and map to models_textures/<joaat(name)>_<slug>.png (preferring hash+slug)
    """
    return _texture_rel_from_shader_param_value_shared(v)


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


_MODEL_TEX_RE = re.compile(
    r"^models_textures/(?P<hash>\d+)(?:_(?P<slug>[^/]+))?\.(?P<ext>png|ktx2|jpg|jpeg|webp)$",
    re.IGNORECASE,
)


def _load_models_textures_index(viewer_root: Path) -> Optional[dict]:
    """
    Loads assets/models_textures/index.json if present.

    Expected schema (v1):
      {"schema": "...", "byHash": {"<hash>": {"preferredFile": "...", "hashOnly": bool, ...}}}
    """
    p = viewer_root / "assets" / "models_textures" / "index.json"
    if not p.exists():
        return None
    try:
        obj = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
        if isinstance(obj, dict) and isinstance(obj.get("byHash"), dict):
            return obj.get("byHash")
        if isinstance(obj, dict):
            # Allow older/simple schema where file is directly a byHash mapping.
            return obj
    except Exception:
        return None
    return None


def _model_texture_candidate_asset_paths(rel: str, idx_by_hash: Optional[dict]) -> list[str]:
    """
    Given a manifest-relative rel like "models_textures/<hash>[_slug].png",
    return asset-relative candidate paths ("assets/models_textures/...") in the same order
    the runtime would prefer, with optional index assistance.
    """
    r0 = str(rel or "").strip().replace("\\", "/")
    r = re.sub(r"^/+", "", r0)
    r = re.sub(r"^assets/", "", r, flags=re.IGNORECASE)

    m = _MODEL_TEX_RE.match(r)
    if not m:
        return [f"assets/{r}"] if r else []

    h = str(m.group("hash"))
    slug = m.group("slug") or ""
    ext = (m.group("ext") or "png").lower()

    # Index is for exported PNG model textures today; still allow non-png via direct checks.
    hash_only = f"assets/models_textures/{h}.{ext}"
    original = f"assets/{r}"

    candidates: list[str] = []
    preferred_fallback: Optional[str] = None

    ent = None
    if idx_by_hash and isinstance(idx_by_hash, dict):
        ent = idx_by_hash.get(h) or idx_by_hash.get(str(int(h)))  # tolerate numeric-string mismatch

    if slug:
        # If manifest already has slug, runtime probes hash-only first, then the original slugged path.
        candidates.append(hash_only)
    else:
        # If manifest gives hash-only, index may point to a slug-only preferred file.
        if ent and isinstance(ent, dict) and ext == "png":
            pref = str(ent.get("preferredFile") or "").strip()
            if pref:
                pref_path = f"assets/models_textures/{pref}"
                has_hash_only = ent.get("hashOnly")
                if has_hash_only is False:
                    candidates.append(pref_path)
                else:
                    preferred_fallback = pref_path if pref_path != hash_only else None

        candidates.append(hash_only)
        if preferred_fallback:
            candidates.append(preferred_fallback)

    candidates.append(original)

    # Uniq
    out = []
    seen = set()
    for c in candidates:
        if c in seen:
            continue
        seen.add(c)
        out.append(c)
    return out


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
    ap.add_argument("--write-missing-json", default="", help="Optional: write a JSON report of missing model texture hashes (index-gated) to this path")
    ap.add_argument(
        "--write-missing-with-refs-json",
        default="",
        help="Optional: write a JSON array of missing model textures including archetype refs (compatible with extract_missing_textures_from_drawables.py)",
    )
    ap.add_argument("--max-refs-per-texture", type=int, default=100, help="Max archetype refs stored per missing texture (0 = unlimited)")
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

    idx_by_hash = _load_models_textures_index(viewer_root)
    print(f"[probe] models_textures_index={'loaded' if idx_by_hash else 'missing'} entries={(len(idx_by_hash) if idx_by_hash else 0)}")

    # Collect referenced rel paths from manifests (counted), plus rel->archetype mapping for targeted repair.
    referenced_counts: Counter[str] = Counter()
    rel_to_archetypes: dict[str, set[str]] = defaultdict(set)  # rel -> {archetype_hash_str}
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
                # Count each referenced rel; this better reflects runtime pressure and lets us rank top offenders.
                for rel in _extract_texture_rels_from_material(mat):
                    referenced_counts[rel] += 1
                    rel_to_archetypes[rel].add(str(_h))
            meshes_scanned += 1
            if args.max_meshes and args.max_meshes > 0 and meshes_scanned >= int(args.max_meshes):
                break
        if args.max_meshes and args.max_meshes > 0 and meshes_scanned >= int(args.max_meshes):
            break

    print(f"[probe] meshes_scanned={meshes_scanned} bad_manifest_files={bad_shards}")
    print(f"[probe] unique_texture_rels={len(referenced_counts)} total_texture_refs={sum(referenced_counts.values())}")

    # Validate each referenced texture against assets (and dist).
    sig_counts = Counter()
    missing_assets: list[str] = []
    missing_dist: list[str] = []
    bad_sig: dict[str, list[str]] = defaultdict(list)  # kind -> [rel...]
    missing_model_tex_hashes = Counter()  # hash -> reference-count (referenced but absent from index)
    missing_model_tex_hash_samples: dict[str, str] = {}  # hash -> sample rel (for debugging)
    missing_model_textures_with_refs: dict[str, dict] = {}  # hash_str -> {requestedRel,useCount,refs:[{archetype_hash}]}

    for rel in sorted(referenced_counts.keys()):
        rel_ref_count = int(referenced_counts.get(rel, 0) or 0)
        rel_norm = str(rel or "").strip().replace("\\", "/")
        rel_norm = re.sub(r"^/+", "", rel_norm)
        rel_norm = re.sub(r"^assets/", "", rel_norm, flags=re.IGNORECASE)

        # For model textures, validate using runtime-like candidate probing (and optionally index gating),
        # so we don't report false "missing" when only the filename variant differs.
        m = _MODEL_TEX_RE.match(rel_norm)
        if m:
            h = str(m.group("hash"))
            if idx_by_hash is not None and isinstance(idx_by_hash, dict) and (idx_by_hash.get(h) is None and idx_by_hash.get(str(int(h))) is None):
                missing_model_tex_hashes[h] += max(1, rel_ref_count)
                if h not in missing_model_tex_hash_samples:
                    missing_model_tex_hash_samples[h] = f"assets/{rel_norm}"
                # Still fall through to disk check, but this is a strong "not exported" signal.

            candidates = _model_texture_candidate_asset_paths(rel_norm, idx_by_hash)
            chosen = None
            for c in candidates:
                p = viewer_root / c
                if p.exists():
                    chosen = c
                    break
            if not chosen:
                # Report the originally referenced path for readability.
                missing_assets.append(_resolve_to_assets_url_path(rel_norm))

                # Also collect a repair-friendly record with archetype refs.
                hh = str(m.group("hash"))
                slug = str(m.group("slug") or "").strip()
                requested_rel = f"models_textures/{hh}_{slug}.png" if slug else f"models_textures/{hh}.png"
                row = missing_model_textures_with_refs.get(hh)
                if row is None:
                    row = {"requestedRel": requested_rel, "useCount": 0, "refs": []}
                    missing_model_textures_with_refs[hh] = row
                row["useCount"] = int(row.get("useCount", 0) or 0) + max(1, rel_ref_count)

                refs_set = rel_to_archetypes.get(rel) or set()
                if refs_set:
                    existing = row.get("refs")
                    if not isinstance(existing, list):
                        existing = []
                    have = {
                        str(x.get("archetype_hash"))
                        for x in existing
                        if isinstance(x, dict) and x.get("archetype_hash") is not None
                    }
                    max_refs = int(args.max_refs_per_texture or 0)
                    for a in sorted(list(refs_set)):
                        if max_refs and len(have) >= max_refs:
                            break
                        if a in have:
                            continue
                        existing.append({"archetype_hash": a})
                        have.add(a)
                    row["refs"] = existing
                continue
            disk_assets = viewer_root / chosen
            url_path = chosen
        else:
            url_path = _resolve_to_assets_url_path(rel_norm)  # "assets/..."
            disk_assets = viewer_root / url_path
            if not disk_assets.exists():
                missing_assets.append(url_path)
                continue

        sig = sniff_bytes(_read_head(disk_assets, 64))
        sig_counts[sig.kind] += 1
        if sig.kind not in ("png", "jpeg", "webp", "gif", "bmp", "ktx2"):
            bad_sig[sig.kind].append(url_path)
        if check_dist:
            # For model textures, accept any candidate existing in dist too.
            if m:
                ok = False
                for c in candidates:
                    disk_dist = dist_assets_root / Path(c).relative_to("assets")
                    if disk_dist.exists():
                        ok = True
                        break
                if not ok:
                    # Report original reference for readability.
                    missing_dist.append(str((dist_assets_root / Path(_resolve_to_assets_url_path(rel_norm)).relative_to("assets")).relative_to(viewer_root)).replace("\\", "/"))
            else:
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

    # Export hygiene check (optional):
    # hash+slug without hash-only alias. This is NOT strictly required when:
    # - manifests reference slug files, or
    # - runtime uses `assets/models_textures/index.json` to resolve hash-only requests to slug-only files.
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

    if missing_model_tex_hashes:
        total_refs = int(sum(missing_model_tex_hashes.values()))
        unique = len(missing_model_tex_hashes)
        print(f"\n[probe] MISSING FROM EXPORTED SET (hash not in models_textures/index.json): unique_hashes={unique} total_references={total_refs}")
        for h, n in missing_model_tex_hashes.most_common(int(args.max_print)):
            samp = missing_model_tex_hash_samples.get(h) or ""
            if samp:
                print(f"  - {h}: referenced {n}x  sample={samp}")
            else:
                print(f"  - {h}: referenced {n}x")

        if args.write_missing_json:
            try:
                out_path = Path(args.write_missing_json)
                out_path.parent.mkdir(parents=True, exist_ok=True)
                payload = {
                    "schema": "webglgta-missing-model-texture-hashes-v1",
                    "viewer_root": str(viewer_root).replace("\\", "/"),
                    "models_textures_index_entries": (len(idx_by_hash) if isinstance(idx_by_hash, dict) else 0),
                    "unique_missing_hashes": unique,
                    "total_missing_references": total_refs,
                    "missing": [
                        {
                            "hash": str(h),
                            "refCount": int(n),
                            "sample": str(missing_model_tex_hash_samples.get(str(h), "")),
                        }
                        for h, n in missing_model_tex_hashes.most_common()
                    ],
                }
                out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
                print(f"\n[probe] wrote missing-hashes report: {str(out_path)}")
            except Exception as e:
                print(f"\n[probe] FAILED to write --write-missing-json: {e}")

    if args.write_missing_with_refs_json:
        try:
            out_path2 = Path(args.write_missing_with_refs_json)
            out_path2.parent.mkdir(parents=True, exist_ok=True)
            out_rows = list(missing_model_textures_with_refs.values())
            out_rows.sort(key=lambda r: int(r.get("useCount", 0) or 0), reverse=True)
            out_path2.write_text(json.dumps(out_rows, indent=2), encoding="utf-8")
            print(f"\n[probe] wrote missing-with-refs report: {str(out_path2)} (rows={len(out_rows)})")
        except Exception as e:
            print(f"\n[probe] FAILED to write --write-missing-with-refs-json: {e}")

    print(f"\n[probe] hash+slug PNGs missing hash-only alias: {alias_missing}  (index={'present' if idx_by_hash else 'missing'})")
    if alias_samples:
        for s in alias_samples:
            print("  -", s)

    print("\n[probe] done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



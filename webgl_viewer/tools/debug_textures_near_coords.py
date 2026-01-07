"""
Offline "texture frame dump" around a coordinate, similar to the viewer's debug dumps.

Goal:
  Given a world coordinate (viewer-space or data-space), find nearby streamed entities,
  map them to exported drawables (models manifest shards), and report which textures would
  resolve to real files vs placeholders.

This answers: "why am I seeing placeholders here?" without needing the browser.

Usage examples (repo-root):
  python webgl-gta/webgl_viewer/tools/debug_textures_near_coords.py --viewer 557.516 0.025 157.106 --radius 250
  python webgl-gta/webgl_viewer/tools/debug_textures_near_coords.py --data -557.516 157.106 0.025 --radius 250
  python webgl-gta/webgl_viewer/tools/debug_textures_near_coords.py --data4 -557.5164 157.1056 0.0251 0 --radius 250 --out dump.json

Notes:
  - "viewer -> data" mapping in this repo is:
      data.x = -viewer.x
      data.y =  viewer.z
      data.z =  viewer.y
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

# Allow running as a script without installing the repo as a package.
# Add repo root (`webgl-gta/`) to sys.path so `gta5_modules` is importable.
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from gta5_modules.hash_utils import joaat as _joaat
from gta5_modules.texture_naming import (
    looks_like_path_or_file as _looks_like_path_or_file_shared,
    slugify_texture_name as _slugify_texture_name_shared,
    texture_rel_from_shader_param_value as _texture_rel_from_shader_param_value_shared,
)

def joaat(input_str: str) -> int:
    """GTA joaat hash; matches webgl_viewer/js/joaat.js."""
    return int(_joaat(input_str, lower=True)) & 0xFFFFFFFF


_EXT_RE = re.compile(r"\.(png|ktx2|jpg|jpeg|webp|dds|gif|bmp)$", re.IGNORECASE)


def _looks_like_path_or_file(s: str) -> bool:
    # Wrapper kept for backwards compatibility.
    return bool(_looks_like_path_or_file_shared(s))


def _slugify_texture_name(name: str) -> str:
    return str(_slugify_texture_name_shared(name))


def _texture_rel_from_shader_param_value(v: str) -> Optional[str]:
    """
    Mirrors viewer-side ModelManager._textureRelFromShaderParamValue:
      - if v looks like a path or file, treat as manifest-relative and strip leading "assets/"
      - else treat as a texture name and map to models_textures/<joaat(name)>_<slug>.png (preferring hash+slug)
    """
    return _texture_rel_from_shader_param_value_shared(v)


def _extract_texture_rels_from_material(mat: dict) -> List[str]:
    out: List[str] = []
    if not isinstance(mat, dict):
        return out

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
            out.append(v.strip().replace("\\", "/"))

    sp = mat.get("shaderParams")
    tex_by_hash = sp.get("texturesByHash") if isinstance(sp, dict) else None
    if isinstance(tex_by_hash, dict):
        # Keep this in sync with probe_model_textures_like_viewer.py / viewer slot mapping.
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
            if isinstance(mat.get(key), str) and str(mat.get(key)).strip():
                continue
            for hs in hashes:
                vv = tex_by_hash.get(hs) or tex_by_hash.get(int(hs))
                if not isinstance(vv, str) or not vv.strip():
                    continue
                rel = _texture_rel_from_shader_param_value(vv)
                if rel:
                    out.append(rel)
                break

    # Normalize
    uniq: List[str] = []
    seen = set()
    for rel in out:
        r = str(rel or "").strip().replace("\\", "/")
        r = re.sub(r"^/+", "", r)
        if not r:
            continue
        if r in seen:
            continue
        seen.add(r)
        uniq.append(r)
    return uniq


_MODEL_TEX_RE = re.compile(
    r"^models_textures/(?P<hash>\d+)(?:_(?P<slug>[^/]+))?\.(?P<ext>png|ktx2|jpg|jpeg|webp)$",
    re.IGNORECASE,
)


def _load_models_textures_index(viewer_assets_dir: Path) -> Optional[dict]:
    p = viewer_assets_dir / "models_textures" / "index.json"
    if not p.exists():
        return None
    try:
        obj = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
        if isinstance(obj, dict) and isinstance(obj.get("byHash"), dict):
            return obj.get("byHash")
        if isinstance(obj, dict):
            return obj
    except Exception:
        return None
    return None


def _load_asset_packs(viewer_assets_dir: Path) -> List[dict]:
    """
    Load optional asset pack config (base + DLC overlays).

    Expected file:
      assets/asset_packs.json

    Schema (v1-ish, best-effort):
      { "schema": "...", "packs": [ { "id": "...", "rootRel": "packs/<id>", "priority": 10, "enabled": true }, ... ] }
    """
    p = viewer_assets_dir / "asset_packs.json"
    if not p.exists():
        return []
    try:
        obj = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return []
    packs = obj.get("packs") if isinstance(obj, dict) else None
    if not isinstance(packs, list):
        return []
    out = []
    for ent in packs:
        if not isinstance(ent, dict):
            continue
        if ent.get("enabled") is False:
            continue
        pid = str(ent.get("id") or "").strip()
        if not pid:
            continue
        root_rel = str(ent.get("rootRel") or ent.get("root") or "").strip()
        if not root_rel:
            root_rel = f"packs/{pid}"
        root_rel = root_rel.strip().lstrip("/").rstrip("/")
        pr = ent.get("priority")
        try:
            prf = float(pr)
        except Exception:
            prf = 0.0
        out.append({"id": pid, "rootRel": root_rel, "priority": prf})
    out.sort(key=lambda x: (-float(x.get("priority") or 0.0), str(x.get("id") or "")))
    return out


def _load_models_textures_index_at(viewer_assets_dir: Path, root_rel: str) -> Optional[dict]:
    rr = str(root_rel or "").strip().lstrip("/").rstrip("/")
    p = (viewer_assets_dir / rr / "models_textures" / "index.json") if rr else (viewer_assets_dir / "models_textures" / "index.json")
    if not p.exists():
        return None
    try:
        obj = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
        if isinstance(obj, dict) and isinstance(obj.get("byHash"), dict):
            return obj.get("byHash")
        if isinstance(obj, dict):
            return obj
    except Exception:
        return None
    return None


def _resolve_asset_path(viewer_assets_dir: Path, rel: str) -> Path:
    r = str(rel or "").strip().replace("\\", "/")
    r = re.sub(r"^/+", "", r)
    if r.lower().startswith("assets/"):
        r = r[7:]
    return viewer_assets_dir / r


@dataclass(frozen=True)
class ResolveResult:
    requested_rel: str
    candidates_rel: Tuple[str, ...]
    resolved_rel: Optional[str]
    reason: str  # ok | missing_file | missing_from_index | index_stale


def _candidate_rels_for_texture_rel(rel: str, idx_by_hash: Optional[dict]) -> List[str]:
    r = str(rel or "").strip().replace("\\", "/")
    r = re.sub(r"^/+", "", r)
    r = re.sub(r"^assets/", "", r, flags=re.IGNORECASE)
    r = re.sub(r"^(model_texture|model_textures|models_texture)/", "models_textures/", r, flags=re.IGNORECASE)

    m = _MODEL_TEX_RE.match(r)
    if not m:
        return [r]

    h = str(m.group("hash") or "")
    ext = "." + str(m.group("ext") or "png")
    hash_only = f"models_textures/{h}{ext}"
    candidates: List[str] = []

    # The runtime tries hash-only first when given hash+slug input.
    if r != hash_only:
        candidates.append(hash_only)
        candidates.append(r)
        return candidates

    # No slug in input: use index preferredFile as a fallback (if present).
    ent = idx_by_hash.get(h) if (idx_by_hash and isinstance(idx_by_hash, dict)) else None
    preferred = str(ent.get("preferredFile") or "") if isinstance(ent, dict) else ""
    if preferred:
        candidates.append(hash_only)
        pref_rel = f"models_textures/{preferred}"
        if pref_rel != hash_only:
            candidates.append(pref_rel)
        return candidates

    return [hash_only]


def resolve_texture_rel(viewer_assets_dir: Path, rel: str, idx_by_hash: Optional[dict]) -> ResolveResult:
    r = str(rel or "").strip().replace("\\", "/")
    r = re.sub(r"^/+", "", r)
    r = re.sub(r"^assets/", "", r, flags=re.IGNORECASE)
    r = re.sub(r"^(model_texture|model_textures|models_texture)/", "models_textures/", r, flags=re.IGNORECASE)

    m = _MODEL_TEX_RE.match(r)
    if m:
        h = str(m.group("hash") or "")
        packs = _load_asset_packs(viewer_assets_dir)
        pack_indices = []
        for p in packs:
            idxp = _load_models_textures_index_at(viewer_assets_dir, str(p.get("rootRel") or ""))
            if idxp is not None:
                pack_indices.append((str(p.get("rootRel") or "").strip().strip("/"), idxp))

        # If we have ANY indices (base or pack), treat "missing_from_index" as:
        # hash is absent from all indices.
        has_any_index = (idx_by_hash is not None and isinstance(idx_by_hash, dict)) or bool(pack_indices)
        if has_any_index:
            present_any = False
            try:
                if idx_by_hash is not None and isinstance(idx_by_hash, dict) and (h in idx_by_hash):
                    present_any = True
            except Exception:
                pass
            if not present_any:
                for _root_rel, idxp in pack_indices:
                    try:
                        if isinstance(idxp, dict) and (h in idxp):
                            present_any = True
                            break
                    except Exception:
                        continue

            if not present_any:
                # Detect stale index: file exists in ANY candidate location.
                all_candidates = []
                # pack candidates (highest priority first)
                for p in packs:
                    root_rel = str(p.get("rootRel") or "").strip().strip("/")
                    pref = f"{root_rel}/" if root_rel else ""
                    for c in _candidate_rels_for_texture_rel(r, idx_by_hash=None):
                        all_candidates.append(pref + c)
                # base candidates
                all_candidates.extend(_candidate_rels_for_texture_rel(r, idx_by_hash=None))
                for c in all_candidates:
                    if _resolve_asset_path(viewer_assets_dir, c).exists():
                        return ResolveResult(
                            requested_rel=r,
                            candidates_rel=tuple(all_candidates),
                            resolved_rel=c,
                            reason="index_stale",
                        )
                return ResolveResult(
                    requested_rel=r,
                    candidates_rel=tuple(all_candidates),
                    resolved_rel=None,
                    reason="missing_from_index",
                )

    # Candidate order: packs first (highest priority), then base.
    packs = _load_asset_packs(viewer_assets_dir)
    candidates: List[str] = []
    for p in packs:
        root_rel = str(p.get("rootRel") or "").strip().strip("/")
        pref = f"{root_rel}/" if root_rel else ""
        # Use the pack's index for reverse hash-only -> preferredFile when possible.
        idxp = _load_models_textures_index_at(viewer_assets_dir, root_rel)
        for c in _candidate_rels_for_texture_rel(r, idxp):
            candidates.append(pref + c)
    # base candidates last
    candidates.extend(_candidate_rels_for_texture_rel(r, idx_by_hash))

    # De-dupe while preserving order
    seen = set()
    uniq = []
    for c in candidates:
        if c in seen:
            continue
        seen.add(c)
        uniq.append(c)

    for c in uniq:
        if _resolve_asset_path(viewer_assets_dir, c).exists():
            return ResolveResult(requested_rel=r, candidates_rel=tuple(uniq), resolved_rel=c, reason="ok")
    return ResolveResult(requested_rel=r, candidates_rel=tuple(uniq), resolved_rel=None, reason="missing_file")


def viewer_to_data(vx: float, vy: float, vz: float) -> Tuple[float, float, float]:
    # Matches the mapping you posted.
    return (-vx, vz, vy)


def iter_chunk_keys_for_data_pos(x: float, y: float, chunk_size: float, radius_m: float) -> List[str]:
    cx = math.floor(x / chunk_size)
    cy = math.floor(y / chunk_size)
    r_chunks = int(math.ceil(max(0.0, radius_m) / chunk_size))
    keys: List[str] = []
    for dy in range(-r_chunks, r_chunks + 1):
        for dx in range(-r_chunks, r_chunks + 1):
            keys.append(f"{cx + dx}_{cy + dy}")
    return keys


def iter_entities_in_chunks(
    viewer_assets_dir: Path,
    entities_index: dict,
    chunk_keys: Iterable[str],
    center_data: Tuple[float, float, float],
    radius_m: float,
    max_entities: int,
) -> Iterable[dict]:
    chunks = entities_index.get("chunks") if isinstance(entities_index, dict) else None
    chunks_dir = str(entities_index.get("chunks_dir") or "entities_chunks") if isinstance(entities_index, dict) else "entities_chunks"
    if not isinstance(chunks, dict):
        return []

    cx, cy, cz = center_data
    r2 = float(radius_m) * float(radius_m)
    yielded = 0
    for key in chunk_keys:
        meta = chunks.get(key)
        if not isinstance(meta, dict):
            continue
        file = str(meta.get("file") or "").strip()
        if not file:
            continue
        p = viewer_assets_dir / chunks_dir / file
        if not p.exists():
            continue
        try:
            with p.open("r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue
                    pos = obj.get("position") if isinstance(obj, dict) else None
                    if not (isinstance(pos, list) and len(pos) >= 3):
                        continue
                    dx = float(pos[0]) - cx
                    dy = float(pos[1]) - cy
                    dz = float(pos[2]) - cz
                    if (dx * dx + dy * dy + dz * dz) > r2:
                        continue
                    yield obj
                    yielded += 1
                    if yielded >= max_entities:
                        return
        except Exception:
            continue


def shard_path_for_mesh_hash(viewer_assets_dir: Path, manifest_index: dict, mesh_hash_u32: int) -> Path:
    shard_bits = int(manifest_index.get("shard_bits") or 8)
    shard_dir = str(manifest_index.get("shard_dir") or "manifest_shards")
    ext = str(manifest_index.get("shard_file_ext") or ".json")
    sid = int(mesh_hash_u32) & ((1 << shard_bits) - 1)
    # Filenames are hex like "0c.json"
    return viewer_assets_dir / "models" / shard_dir / f"{sid:02x}{ext}"


def extract_material_dicts_from_mesh_entry(entry: dict) -> Iterable[Tuple[str, dict]]:
    if not isinstance(entry, dict):
        return []
    mats: List[Tuple[str, dict]] = []
    m0 = entry.get("material")
    if isinstance(m0, dict):
        mats.append(("entry.material", m0))
    lods = entry.get("lods")
    if isinstance(lods, dict):
        for lod_name, lod_meta in lods.items():
            if not isinstance(lod_meta, dict):
                continue
            subs = lod_meta.get("submeshes")
            if not isinstance(subs, list):
                continue
            for i, sm in enumerate(subs):
                if not isinstance(sm, dict):
                    continue
                mat = sm.get("material")
                if isinstance(mat, dict):
                    mats.append((f"lods.{lod_name}.submeshes[{i}].material", mat))
    return mats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--viewer", nargs=3, type=float, metavar=("X", "Y", "Z"), help="viewer-space vec3")
    ap.add_argument("--data", nargs=3, type=float, metavar=("X", "Y", "Z"), help="data-space vec3")
    ap.add_argument("--data4", nargs=4, type=float, metavar=("X", "Y", "Z", "W"), help="data-space vec4 (w ignored)")
    ap.add_argument("--radius", type=float, default=250.0, help="radius in data-space units (meters-ish)")
    ap.add_argument("--max-entities", type=int, default=8000, help="cap entities scanned")
    ap.add_argument("--max-archetypes", type=int, default=3000, help="cap unique archetypes analyzed")
    ap.add_argument("--out", type=str, default="", help="optional output path (json)")
    args = ap.parse_args()

    if not args.viewer and not args.data and not args.data4:
        ap.error("Provide one of: --viewer, --data, --data4")

    if args.viewer:
        vx, vy, vz = args.viewer
        dx, dy, dz = viewer_to_data(vx, vy, vz)
        src = {"space": "viewer", "viewer": [vx, vy, vz], "data": [dx, dy, dz]}
    elif args.data:
        dx, dy, dz = args.data
        src = {"space": "data", "data": [dx, dy, dz]}
    else:
        dx, dy, dz, _dw = args.data4
        src = {"space": "data4", "data": [dx, dy, dz], "data4": [dx, dy, dz, _dw]}

    radius = float(args.radius)
    max_entities = int(args.max_entities)
    max_archetypes = int(args.max_archetypes)

    viewer_root = Path(__file__).resolve().parents[1]
    assets_dir = viewer_root / "assets"

    ent_index_path = assets_dir / "entities_index.json"
    man_index_path = assets_dir / "models" / "manifest_index.json"
    if not ent_index_path.exists():
        raise SystemExit(f"Missing {ent_index_path}")
    if not man_index_path.exists():
        raise SystemExit(f"Missing {man_index_path}")

    entities_index = json.loads(ent_index_path.read_text(encoding="utf-8", errors="ignore"))
    manifest_index = json.loads(man_index_path.read_text(encoding="utf-8", errors="ignore"))
    chunk_size = float(entities_index.get("chunk_size") or 512.0)
    idx_by_hash = _load_models_textures_index(assets_dir)

    chunk_keys = iter_chunk_keys_for_data_pos(dx, dy, chunk_size, radius)
    # Only keep keys that exist in the index.
    existing_keys = []
    chunks_dict = entities_index.get("chunks") if isinstance(entities_index, dict) else None
    if isinstance(chunks_dict, dict):
        for k in chunk_keys:
            if k in chunks_dict:
                existing_keys.append(k)

    # Scan entities, count archetypes near the point.
    arch_counts = Counter()
    ent_count = 0
    for e in iter_entities_in_chunks(assets_dir, entities_index, existing_keys, (dx, dy, dz), radius, max_entities):
        ent_count += 1
        ah = e.get("archetype_hash") or e.get("archetype") or None
        if ah is None:
            continue
        try:
            arch_counts[int(str(ah), 10) & 0xFFFFFFFF] += 1
        except Exception:
            continue

    # Select top archetypes by usage count (helps avoid huge runs).
    arch_items = arch_counts.most_common(max_archetypes)
    unique_arch = len(arch_items)

    # For each archetype hash, load its shard and extract texture refs.
    missing_mesh_entries = 0
    textures_by_rel = Counter()
    missing_textures_by_reason = Counter()
    texture_refs: Dict[str, List[dict]] = defaultdict(list)  # rel -> list of refs

    shard_cache: Dict[Path, dict] = {}
    for arch_u32, count in arch_items:
        shard_p = shard_path_for_mesh_hash(assets_dir, manifest_index, arch_u32)
        shard_obj = shard_cache.get(shard_p)
        if shard_obj is None:
            try:
                shard_obj = json.loads(shard_p.read_text(encoding="utf-8", errors="ignore"))
            except Exception:
                shard_obj = {}
            shard_cache[shard_p] = shard_obj

        meshes = shard_obj.get("meshes") if isinstance(shard_obj, dict) else None
        entry = meshes.get(str(arch_u32)) if isinstance(meshes, dict) else None
        if not isinstance(entry, dict):
            missing_mesh_entries += 1
            continue

        for mat_path, mat in extract_material_dicts_from_mesh_entry(entry):
            rels = _extract_texture_rels_from_material(mat)
            for rel in rels:
                textures_by_rel[rel] += count
                if len(texture_refs[rel]) < 8:
                    texture_refs[rel].append(
                        {
                            "archetype_hash": str(arch_u32),
                            "archetype_count": int(count),
                            "shard": shard_p.name,
                            "materialPath": mat_path,
                        }
                    )

    # Resolve textures to actual disk files (viewer-style candidate logic).
    resolved = []
    for rel, use_count in textures_by_rel.items():
        rr = resolve_texture_rel(assets_dir, rel, idx_by_hash)
        if rr.reason != "ok":
            missing_textures_by_reason[rr.reason] += use_count
        resolved.append(
            {
                "requestedRel": rr.requested_rel,
                "useCount": int(use_count),
                "reason": rr.reason,
                "resolvedRel": rr.resolved_rel,
                "candidatesRel": list(rr.candidates_rel),
                "refs": texture_refs.get(rel, [])[:],
            }
        )

    resolved.sort(key=lambda r: (-int(r.get("useCount") or 0), str(r.get("requestedRel") or "")))

    out = {
        "schema": "webglgta-texture-coords-dump-v1",
        "source": src,
        "radius": radius,
        "chunkSize": chunk_size,
        "chunkKeysScanned": existing_keys,
        "counts": {
            "entitiesScanned": ent_count,
            "uniqueArchetypes": unique_arch,
            "missingMeshEntries": missing_mesh_entries,
            "uniqueTextureRefs": len(resolved),
        },
        "missingByReasonUseCount": dict(missing_textures_by_reason),
        "textures": resolved[:5000],  # keep bounded
    }

    s = json.dumps(out, indent=2, sort_keys=False)
    if args.out:
        out_path = Path(args.out)
        out_path.write_text(s, encoding="utf-8")
        print(f"Wrote {out_path} ({out_path.stat().st_size} bytes)")
    else:
        print(s)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



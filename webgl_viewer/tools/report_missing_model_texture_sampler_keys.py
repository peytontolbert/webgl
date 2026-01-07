"""
Report which shader-param *sampler keys* (ShaderParamNames hashes) are producing missing model-texture requests.

Why:
  Runtime warnings like:
    "texture hash not present in loaded indices ... 187392030 {rel: 'models_textures/187392030_nxg_..._h.png'}"
  can be caused by *any* entry in `material.shaderParams.texturesByHash` (not just the handful of explicit slots
  we render with). This tool tells you exactly:
    - which sampler hash / param name referenced the missing texture
    - which archetype(s) referenced it
    - which texture name/hash it maps to

Output:
  JSON with two top-level arrays:
    - bySamplerKey: grouped by samplerHash (shader param hash)
    - byTextureHash: grouped by missing texture hash
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from gta5_modules.hash_utils import joaat as _joaat
from gta5_modules.texture_naming import (
    looks_like_path_or_file as _looks_like_path_or_file_shared,
    slugify_texture_name as _slugify_texture_name_shared,
    texture_rel_from_shader_param_value as _texture_rel_from_shader_param_value_shared,
)

_EXT_RE = re.compile(r"\.(png|ktx2|jpg|jpeg|webp|dds|gif|bmp)$", re.IGNORECASE)
_MODEL_TEX_RE = re.compile(
    r"^models_textures/(?P<hash>\d+)(?:_(?P<slug>[^/]+))?\.(?P<ext>png|ktx2|jpg|jpeg|webp)$",
    re.IGNORECASE,
)


def _looks_like_path_or_file(s: str) -> bool:
    return bool(_looks_like_path_or_file_shared(s))


def joaat(input_str: str) -> int:
    """GTA joaat hash; matches webgl_viewer/js/joaat.js."""
    return int(_joaat(input_str, lower=True)) & 0xFFFFFFFF


def _slugify_texture_name(name: str) -> str:
    return str(_slugify_texture_name_shared(name))


def _texture_rel_from_shader_param_value(v: str) -> Optional[str]:
    """
    Mirrors viewer-side ModelManager._textureRelFromShaderParamValue:
      - if v looks like a path or file, treat as manifest-relative and strip leading "assets/"
      - else treat as a texture name and map to models_textures/<joaat(name)>_<slug>.png (preferring hash+slug)
    """
    return _texture_rel_from_shader_param_value_shared(v)


def _iter_manifest_shards(models_dir: Path, max_shards: int) -> List[Path]:
    shards_dir = models_dir / "manifest_shards"
    if not shards_dir.exists():
        return []
    files = sorted([p for p in shards_dir.glob("*.json") if p.is_file()])
    if max_shards and max_shards > 0:
        files = files[: int(max_shards)]
    return files


def _iter_material_dicts(mesh_entry: dict) -> Iterable[Tuple[str, Optional[int], dict]]:
    if not isinstance(mesh_entry, dict):
        return []
    out: List[Tuple[str, Optional[int], dict]] = []
    m0 = mesh_entry.get("material")
    if isinstance(m0, dict):
        out.append(("entry", None, m0))
    lods = mesh_entry.get("lods")
    if isinstance(lods, dict):
        for lod_key, lod_meta in lods.items():
            if not isinstance(lod_meta, dict):
                continue
            subs = lod_meta.get("submeshes")
            if not isinstance(subs, list):
                continue
            for si, sm in enumerate(subs):
                if isinstance(sm, dict) and isinstance(sm.get("material"), dict):
                    out.append((str(lod_key), int(si), sm.get("material")))
    return out


def _load_index_by_hash(p: Path) -> Dict[str, Any]:
    if not p.exists():
        return {}
    try:
        obj = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return {}
    if isinstance(obj, dict) and isinstance(obj.get("byHash"), dict):
        return obj.get("byHash") or {}
    if isinstance(obj, dict):
        return obj
    return {}


def _load_asset_packs(assets_dir: Path) -> List[dict]:
    p = assets_dir / "asset_packs.json"
    if not p.exists():
        return []
    try:
        obj = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return []
    packs = obj.get("packs") if isinstance(obj, dict) else None
    return packs if isinstance(packs, list) else []


def _load_shader_param_names(assets_dir: Path) -> Dict[str, str]:
    p = assets_dir / "shader_param_names.json"
    if not p.exists():
        return {}
    try:
        obj = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return {}
    by_hash = obj.get("byHash") if isinstance(obj, dict) else None
    if isinstance(by_hash, dict):
        return {str(k): str(v) for k, v in by_hash.items()}
    return {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, help="Viewer root containing assets/ (e.g. .../webgl_viewer)")
    ap.add_argument("--max-shards", type=int, default=0, help="Limit shard files scanned (0=all)")
    ap.add_argument("--max-meshes", type=int, default=0, help="Limit mesh entries scanned (0=all)")
    ap.add_argument("--max-samples", type=int, default=30, help="Max sample refs stored per group")
    ap.add_argument("--out", required=True, help="Path to write report JSON")
    args = ap.parse_args()

    viewer_root = Path(str(args.root)).resolve()
    assets_dir = viewer_root / "assets"
    models_dir = assets_dir / "models"
    if not assets_dir.exists():
        raise SystemExit(f"Missing assets dir: {assets_dir}")

    param_names = _load_shader_param_names(assets_dir)

    idx_base_png = _load_index_by_hash(assets_dir / "models_textures" / "index.json")
    idx_base_ktx2 = _load_index_by_hash(assets_dir / "models_textures_ktx2" / "index.json")
    packs = _load_asset_packs(assets_dir)
    idx_packs_png: List[Tuple[str, dict]] = []
    idx_packs_ktx2: List[Tuple[str, dict]] = []
    for p in packs:
        rr = str(p.get("rootRel") or "").strip().lstrip("/").rstrip("/")
        if not rr:
            continue
        idxp_png = _load_index_by_hash(assets_dir / rr / "models_textures" / "index.json")
        if idxp_png:
            idx_packs_png.append((rr, idxp_png))
        idxp_ktx2 = _load_index_by_hash(assets_dir / rr / "models_textures_ktx2" / "index.json")
        if idxp_ktx2:
            idx_packs_ktx2.append((rr, idxp_ktx2))

    def _is_hash_exported(h: str, ext: str) -> bool:
        e = str(ext or "").lower()
        if e == "ktx2":
            if h in idx_base_ktx2:
                return True
            return any(h in idxp for _rr, idxp in idx_packs_ktx2)
        if h in idx_base_png:
            return True
        return any(h in idxp for _rr, idxp in idx_packs_png)

    # Groups
    by_sampler: Dict[str, dict] = {}
    by_tex: Dict[str, dict] = {}

    def _add_sample(ent: dict, sample: dict) -> None:
        samples = ent.get("samples")
        if not isinstance(samples, list):
            samples = []
            ent["samples"] = samples
        if len(samples) >= int(args.max_samples or 30):
            return
        samples.append(sample)

    shards = _iter_manifest_shards(models_dir, int(args.max_shards or 0))
    if not shards:
        raise SystemExit(f"No manifest shards found under {models_dir}")

    meshes_scanned = 0
    for sf in shards:
        payload = json.loads(sf.read_text(encoding="utf-8", errors="ignore"))
        meshes = (payload.get("meshes") or {}) if isinstance(payload, dict) else {}
        if not isinstance(meshes, dict):
            continue
        for mesh_hash_str, entry in meshes.items():
            if args.max_meshes and int(args.max_meshes) > 0 and meshes_scanned >= int(args.max_meshes):
                break
            if not isinstance(entry, dict):
                continue
            mh = str(mesh_hash_str).strip()
            if not mh or not mh.lstrip("-").isdigit():
                continue
            mh_u32 = str(int(mh, 10) & 0xFFFFFFFF)
            meshes_scanned += 1

            for lod_key, sub_i, mat in _iter_material_dicts(entry):
                if not isinstance(mat, dict):
                    continue
                sp = mat.get("shaderParams")
                tex_by_hash = sp.get("texturesByHash") if isinstance(sp, dict) else None
                if not isinstance(tex_by_hash, dict):
                    continue

                for sampler_hash, vv in tex_by_hash.items():
                    if not isinstance(vv, str) or not vv.strip():
                        continue
                    rel = _texture_rel_from_shader_param_value(vv)
                    if not rel:
                        continue
                    m = _MODEL_TEX_RE.match(rel)
                    if not m:
                        continue
                    tex_h = str(m.group("hash") or "").strip()
                    ext = str(m.group("ext") or "").strip().lower()
                    if not tex_h:
                        continue
                    if _is_hash_exported(tex_h, ext):
                        continue

                    sh = str(sampler_hash).strip()
                    sh_u32 = str(int(sh, 10) & 0xFFFFFFFF) if sh.lstrip("-").isdigit() else sh
                    pname = param_names.get(sh_u32, "")

                    # By sampler key
                    se = by_sampler.get(sh_u32)
                    if se is None:
                        se = {
                            "samplerHash": sh_u32,
                            "samplerName": pname,
                            "missingUseCount": 0,
                            "missingTextureHashes": set(),
                            "samples": [],
                        }
                        by_sampler[sh_u32] = se
                    se["missingUseCount"] = int(se.get("missingUseCount") or 0) + 1
                    se.get("missingTextureHashes").add(tex_h)
                    _add_sample(
                        se,
                        {
                            "requestedRel": rel,
                            "textureHash": tex_h,
                            "textureNameOrPath": vv,
                            "archetype_hash": mh_u32,
                            "lod": lod_key,
                            "submesh_index": sub_i,
                            "shaderName": mat.get("shaderName"),
                            "shaderFamily": mat.get("shaderFamily"),
                        },
                    )

                    # By texture hash
                    te = by_tex.get(tex_h)
                    if te is None:
                        te = {
                            "textureHash": tex_h,
                            "missingUseCount": 0,
                            "samplerHashes": set(),
                            "samples": [],
                        }
                        by_tex[tex_h] = te
                    te["missingUseCount"] = int(te.get("missingUseCount") or 0) + 1
                    te.get("samplerHashes").add(sh_u32)
                    _add_sample(
                        te,
                        {
                            "requestedRel": rel,
                            "samplerHash": sh_u32,
                            "samplerName": pname,
                            "textureNameOrPath": vv,
                            "archetype_hash": mh_u32,
                            "lod": lod_key,
                            "submesh_index": sub_i,
                            "shaderName": mat.get("shaderName"),
                            "shaderFamily": mat.get("shaderFamily"),
                        },
                    )

        if args.max_meshes and int(args.max_meshes) > 0 and meshes_scanned >= int(args.max_meshes):
            break

    # Normalize sets to lists
    by_sampler_rows = list(by_sampler.values())
    for r in by_sampler_rows:
        r["missingTextureCount"] = int(len(r.get("missingTextureHashes") or []))
        if "missingTextureHashes" in r:
            r["missingTextureHashes"] = sorted(list(r["missingTextureHashes"]))
    by_sampler_rows.sort(key=lambda x: (-int(x.get("missingUseCount") or 0), str(x.get("samplerHash") or "")))

    by_tex_rows = list(by_tex.values())
    for r in by_tex_rows:
        if "samplerHashes" in r:
            r["samplerHashes"] = sorted(list(r["samplerHashes"]))
    by_tex_rows.sort(key=lambda x: (-int(x.get("missingUseCount") or 0), str(x.get("textureHash") or "")))

    out = {
        "schema": "webglgta-missing-model-texture-sampler-keys-v1",
        "generatedAtUnix": int(time.time()),
        "viewerRoot": str(viewer_root),
        "meshesScanned": int(meshes_scanned),
        "baseIndexCounts": {"models_textures": len(idx_base_png), "models_textures_ktx2": len(idx_base_ktx2)},
        "packIndexCounts": {"models_textures": len(idx_packs_png), "models_textures_ktx2": len(idx_packs_ktx2)},
        "bySamplerKey": by_sampler_rows,
        "byTextureHash": by_tex_rows,
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(
        f"wrote {out_path} samplerKeys={len(by_sampler_rows)} missingTextures={len(by_tex_rows)} "
        f"meshesScanned={meshes_scanned}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



"""
Build `missing_textures_remaining.json` (with archetype refs) by scanning exported model manifests.

Why:
  Some repair tools (eg `extract_missing_textures_from_drawables.py`, `report_missing_textures_sources.py`)
  expect the "missing textures" list to include *which archetypes referenced each texture*.

  The offline probe `probe_model_textures_like_viewer.py` intentionally produces a compact "missing hashes"
  report without refs (fast, small). This tool bridges that gap.

Output format (JSON array):
  [
    {
      "requestedRel": "models_textures/<hash>_<slug>.png",
      "useCount": <int>,
      "refs": [ { "archetype_hash": "<u32>" }, ... ]
    },
    ...
  ]

Notes:
  - "archetype_hash" here is simply the mesh hash key in the model manifest (the drawable/archetype id).
  - We treat a texture as "already exported" if its hash exists in assets/models_textures/index.json OR
    in any pack index `assets/<packRootRel>/models_textures/index.json` (as the runtime does).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

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


def _iter_material_dicts(mesh_entry: dict) -> Iterable[Tuple[str, Optional[int], dict]]:
    """
    Yield (lodKey, submeshIndexOrNone, materialDict) for entry-level and per-submesh materials.
    """
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


_MODEL_TEX_RE = re.compile(
    r"^models_textures/(?P<hash>\d+)(?:_(?P<slug>[^/]+))?\.(?P<ext>png|ktx2|jpg|jpeg|webp)$",
    re.IGNORECASE,
)


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
        "height",
        "diffuseKtx2",
        "diffuse2Ktx2",
        "normalKtx2",
        "specKtx2",
        "emissiveKtx2",
        "detailKtx2",
        "aoKtx2",
        "alphaMaskKtx2",
        "heightKtx2",
    )
    for k in explicit_keys:
        v = mat.get(k)
        if isinstance(v, str) and v.strip():
            out.append(v.strip().replace("\\", "/"))

    sp = mat.get("shaderParams")
    tex_by_hash = sp.get("texturesByHash") if isinstance(sp, dict) else None
    if isinstance(tex_by_hash, dict):
        slots = [
            ("diffuse", ["4059966321", "3576369631", "2946270081"]),
            ("diffuse2", ["181641832"]),
            ("normal", ["1186448975", "1073714531", "1422769919", "2745359528", "2975430677"]),
            ("spec", ["1619499462"]),
            ("detail", ["3393362404"]),
            ("ao", ["1212577329"]),
            ("alphaMask", ["1705051233"]),
            # Height / heightmap (parallax / terrain / nxg materials).
            # CodeWalker ShaderParams.cs:
            # - HeightMapSampler=1008099585
            # - heightSampler=4049987115
            # - heightMapSamplerLayer0..3=781078585/2570495372/2346748640/2242969217
            ("height", ["1008099585", "4049987115", "781078585", "2570495372", "2346748640", "2242969217"]),
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

        # Generic sweep: include any shader-param texture refs we don't have explicit mappings for.
        # This catches e.g. `cs3_*` / watermesh / palette / other samplers that appear only via
        # `shaderParams.texturesByHash` and would otherwise never be extracted by the repair pipeline.
        for _hs, vv in tex_by_hash.items():
            if not isinstance(vv, str) or not vv.strip():
                continue
            rel = _texture_rel_from_shader_param_value(vv)
            if rel:
                out.append(rel)

    # Normalize + unique
    uniq: List[str] = []
    seen = set()
    for rel in out:
        r = str(rel or "").strip().replace("\\", "/")
        r = re.sub(r"^/+", "", r)
        r = re.sub(r"^assets/", "", r, flags=re.IGNORECASE)
        if not r:
            continue
        if r in seen:
            continue
        seen.add(r)
        uniq.append(r)
    return uniq


def _load_index_by_hash(p: Path) -> Optional[dict]:
    if not p.exists():
        return None
    try:
        obj = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return None
    if isinstance(obj, dict) and isinstance(obj.get("byHash"), dict):
        return obj.get("byHash")
    if isinstance(obj, dict):
        return obj
    return None


def _load_asset_packs(assets_dir: Path) -> List[dict]:
    p = assets_dir / "asset_packs.json"
    if not p.exists():
        return []
    try:
        obj = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return []
    packs0 = obj.get("packs") if isinstance(obj, dict) else None
    if not isinstance(packs0, list):
        return []
    packs = []
    for ent in packs0:
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
        try:
            pr = float(ent.get("priority"))
        except Exception:
            pr = 0.0
        packs.append({"id": pid, "rootRel": root_rel, "priority": pr})
    packs.sort(key=lambda x: (-float(x.get("priority") or 0.0), str(x.get("id") or "")))
    return packs


def _iter_manifest_shards(models_dir: Path, *, max_shards: int = 0) -> List[Path]:
    idx_path = models_dir / "manifest_index.json"
    shard_dir = models_dir / "manifest_shards"
    if idx_path.exists() and shard_dir.exists():
        shards = sorted(shard_dir.glob("*.json"))
        if max_shards and max_shards > 0:
            shards = shards[: int(max_shards)]
        return shards
    # fallback to monolithic
    mf = models_dir / "manifest.json"
    if mf.exists():
        return [mf]
    return []


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="webgl/webgl_viewer", help="Viewer root containing assets/ (default: webgl/webgl_viewer)")
    ap.add_argument("--max-shards", type=int, default=0, help="Limit number of shard files to scan (0 = all)")
    ap.add_argument("--max-meshes", type=int, default=0, help="Limit number of mesh entries scanned (0 = all)")
    ap.add_argument("--max-textures", type=int, default=0, help="Limit unique missing textures written (0 = all)")
    ap.add_argument("--max-refs-per-texture", type=int, default=25, help="Cap refs stored per texture hash")
    ap.add_argument("--out", required=True, help="Path to write missing_textures_remaining.json")
    args = ap.parse_args()

    viewer_root = Path(str(args.root)).resolve()
    assets_dir = viewer_root / "assets"
    models_dir = assets_dir / "models"
    if not assets_dir.exists():
        raise SystemExit(f"Missing assets dir: {assets_dir}")

    idx_base_png = _load_index_by_hash(assets_dir / "models_textures" / "index.json") or {}
    idx_base_ktx2 = _load_index_by_hash(assets_dir / "models_textures_ktx2" / "index.json") or {}
    packs = _load_asset_packs(assets_dir)
    idx_packs_png: List[Tuple[str, dict]] = []
    idx_packs_ktx2: List[Tuple[str, dict]] = []
    for p in packs:
        rr = str(p.get("rootRel") or "").strip().lstrip("/").rstrip("/")
        if not rr:
            continue
        idxp_png = _load_index_by_hash(assets_dir / rr / "models_textures" / "index.json")
        if isinstance(idxp_png, dict):
            idx_packs_png.append((rr, idxp_png))
        idxp_ktx2 = _load_index_by_hash(assets_dir / rr / "models_textures_ktx2" / "index.json")
        if isinstance(idxp_ktx2, dict):
            idx_packs_ktx2.append((rr, idxp_ktx2))

    def _is_hash_exported(h: str, ext: str) -> bool:
        """
        Treat a hash as exported if present in the corresponding base or pack index.
        - For `.ktx2`, check `models_textures_ktx2/index.json`.
        - Otherwise (png/jpg/webp/...), check `models_textures/index.json` (our canonical pipeline output).
        """
        e = str(ext or "").lower()
        if e == "ktx2":
            if h in idx_base_ktx2:
                return True
            for _rr, idxp in idx_packs_ktx2:
                if h in idxp:
                    return True
            return False
        if h in idx_base_png:
            return True
        for _rr, idxp in idx_packs_png:
            if h in idxp:
                return True
        return False

    shards = _iter_manifest_shards(models_dir, max_shards=int(args.max_shards or 0))
    if not shards:
        raise SystemExit(f"No model manifests found under {models_dir}")

    missing_by_hash: Dict[str, dict] = {}
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
            # mesh_hash_str is the archetype hash key
            mh = str(mesh_hash_str).strip()
            if not mh or not mh.lstrip("-").isdigit():
                continue
            mh_u32 = str(int(mh, 10) & 0xFFFFFFFF)
            meshes_scanned += 1

            for lod_key, sub_i, mat in _iter_material_dicts(entry):
                for rel in _extract_texture_rels_from_material(mat):
                    m = _MODEL_TEX_RE.match(rel)
                    if not m:
                        continue
                    h = str(m.group("hash") or "").strip()
                    ext = str(m.group("ext") or "").strip().lower()
                    if not h:
                        continue
                    if _is_hash_exported(h, ext):
                        continue

                    ent = missing_by_hash.get(h)
                    if ent is None:
                        slug = str(m.group("slug") or "")
                        req = f"models_textures/{h}_{slug}.png" if slug else f"models_textures/{h}.png"
                        ent = {"requestedRel": req, "useCount": 0, "refs": [], "_refs_set": set()}
                        missing_by_hash[h] = ent
                    ent["useCount"] = int(ent.get("useCount") or 0) + 1
                    # Add a representative ref (cap per texture)
                    rs = ent.get("_refs_set")
                    if isinstance(rs, set) and len(rs) < int(args.max_refs_per_texture or 25):
                        if mh_u32 not in rs:
                            rs.add(mh_u32)
                            ent["refs"].append({"archetype_hash": mh_u32, "lod": lod_key, "submesh_index": sub_i})

        if args.max_meshes and int(args.max_meshes) > 0 and meshes_scanned >= int(args.max_meshes):
            break

    rows = list(missing_by_hash.values())
    # Strip private helper field
    for r in rows:
        if "_refs_set" in r:
            try:
                del r["_refs_set"]
            except Exception:
                pass
    rows.sort(key=lambda x: (-int(x.get("useCount") or 0), str(x.get("requestedRel") or "")))
    if args.max_textures and int(args.max_textures) > 0:
        rows = rows[: int(args.max_textures)]

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
    print(
        f"wrote {out_path} textures={len(rows)} meshes_scanned={meshes_scanned} "
        f"base_index_png={len(idx_base_png)} base_index_ktx2={len(idx_base_ktx2)} "
        f"packs_png={len(idx_packs_png)} packs_ktx2={len(idx_packs_ktx2)} time={int(time.time())}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



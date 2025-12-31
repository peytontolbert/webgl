#!/usr/bin/env python3
"""
Export drawable meshes for a given streamed entity chunk.

Goal:
- Given a chunk key like "0_0", scan the chunk's entities jsonl and collect unique archetype hashes.
- Use CodeWalker.GameFileCache to resolve Archetype -> Drawable and export a simple mesh cache
  that the WebGL viewer can load.

Output (into webgl/webgl_viewer/assets/models):
- manifest.json: { version, meshes: { "<hash>": { "file": "<hash>.bin", "indexCount": N, "vertexCount": M } } }
- <hash>.bin: custom binary with positions + indices

This is intentionally an MVP:
- Positions only (normals omitted; viewer can compute flat shading).
- High LOD only (first available).
"""

import argparse
import json
import os
import struct
from pathlib import Path
import time

import numpy as np
from PIL import Image

from gta5_modules.dll_manager import DllManager
from gta5_modules.rpf_reader import RpfReader


MESH_MAGIC = b"MSH0"
MESH_VERSION = 3
FLAG_HAS_NORMALS = 1
FLAG_HAS_UVS = 2

# Shader param hashes from CodeWalker.Core (ShaderParamNames enum).
_SP_G_TEXCOORD_SCALE_OFFSET0 = 3099617970  # gTexCoordScaleOffset0

# Preferred diffuse-ish shader texture parameters (hashes from ShaderParamNames).
_SP_DIFFUSE_PREFERRED = [
    4059966321,  # DiffuseSampler
    1732587965,  # DiffuseNoBorderTexSampler
    1399472831,  # baseTextureSampler
    2669264211,  # BaseSampler
    934209648,   # ColorTexture
]


def _read_chunk_entities(chunk_path: Path):
    entities = []
    if not chunk_path.exists():
        return entities
    with open(chunk_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entities.append(json.loads(line))
            except Exception:
                continue
    return entities


def _as_uint32(x) -> int:
    # Accept stringified hashes or ints
    if isinstance(x, str):
        x = x.strip()
        # some exports may contain "UNKNOWN" or non-numeric; ignore
        if not x or not (x.lstrip("-").isdigit()):
            raise ValueError("not numeric")
        x = int(x)
    x = int(x)
    return x & 0xFFFFFFFF


def _entry_has_any_diffuse(entry) -> bool:
    """
    Manifest v4 stores diffuse per-submesh: entry.lods.<lod>.submeshes[i].material.diffuse.
    Older manifests may store it at entry.material.diffuse.
    """
    try:
        if isinstance(entry, dict) and isinstance(entry.get("material"), dict) and entry["material"].get("diffuse"):
            return True
        lods = entry.get("lods") if isinstance(entry, dict) else None
        if not isinstance(lods, dict):
            return False
        for lod_meta in lods.values():
            if not isinstance(lod_meta, dict):
                continue
            subs = lod_meta.get("submeshes")
            if not isinstance(subs, list):
                continue
            for sm in subs:
                if not isinstance(sm, dict):
                    continue
                mat = sm.get("material")
                if isinstance(mat, dict) and mat.get("diffuse"):
                    return True
    except Exception:
        return False
    return False


def _extract_first_drawable_geometry(drawable) -> tuple[np.ndarray, np.ndarray] | None:
    raise RuntimeError("legacy helper removed; use _extract_drawable_lods(...)")


def _iter_drawable_models_for_lod(drawable, lod: str):
    models_block = getattr(drawable, "DrawableModels", None)
    if models_block is None:
        return []
    arr = getattr(models_block, lod, None)
    if arr is None:
        return []
    return list(arr)


def _extract_geometry_positions_indices(geom) -> tuple[np.ndarray, np.ndarray] | None:
    vdata = getattr(geom, "VertexData", None)
    ibuf = getattr(geom, "IndexBuffer", None)
    if vdata is None or ibuf is None:
        return None
    vb = np.frombuffer(bytes(vdata.VertexBytes), dtype=np.uint8)
    stride = int(vdata.VertexStride)
    vcount = int(vdata.VertexCount)
    if vcount <= 0 or stride <= 0:
        return None
    # Position is at offset 0 in CodeWalker drawables.
    pos = np.frombuffer(vb[: vcount * stride], dtype=np.float32).reshape(-1, stride // 4)[:, 0:3].astype(np.float32)
    indices = np.array(list(ibuf.Indices), dtype=np.uint32)
    if indices.size == 0:
        return None
    return pos, indices


def _compute_vertex_normals(positions: np.ndarray, indices: np.ndarray) -> np.ndarray:
    positions = np.asarray(positions, dtype=np.float32)
    indices = np.asarray(indices, dtype=np.uint32)
    n = np.zeros_like(positions, dtype=np.float32)
    tris = indices.reshape(-1, 3)
    v0 = positions[tris[:, 0]]
    v1 = positions[tris[:, 1]]
    v2 = positions[tris[:, 2]]
    e1 = v1 - v0
    e2 = v2 - v0
    fn = np.cross(e1, e2)
    # accumulate
    np.add.at(n, tris[:, 0], fn)
    np.add.at(n, tris[:, 1], fn)
    np.add.at(n, tris[:, 2], fn)
    # normalize
    lens = np.linalg.norm(n, axis=1)
    lens[lens == 0] = 1.0
    n = (n.T / lens).T.astype(np.float32)
    return n


def _try_get_vertex_decl(vdata):
    """
    Best-effort access to CodeWalker VertexDeclaration for this vertex buffer.
    In CodeWalker, this is usually at vdata.Info (legacy declaration).
    """
    try:
        return getattr(vdata, "Info", None)
    except Exception:
        return None


def _has_component(vdecl, idx: int) -> bool:
    try:
        flags = int(getattr(vdecl, "Flags", 0))
        return ((flags >> int(idx)) & 1) == 1
    except Exception:
        return False


def _component_type_name(vdecl, idx: int) -> str:
    try:
        ct = vdecl.GetComponentType(int(idx))
        return str(ct)
    except Exception:
        return ""


def _component_offset(vdecl, idx: int) -> int:
    try:
        return int(vdecl.GetComponentOffset(int(idx)))
    except Exception:
        return 0


def _extract_geometry_positions_indices_uv0(geom) -> tuple[np.ndarray, np.ndarray, np.ndarray | None] | None:
    """
    Extract positions + indices + UV0 from a CodeWalker drawable geometry.

    Why: the WebGL viewer expects model-space vertices with their real UVs so that
    exported diffuse textures actually map correctly. The previous exporter used planar UVs
    which can never match real GTA materials.
    """
    vdata = getattr(geom, "VertexData", None)
    ibuf = getattr(geom, "IndexBuffer", None)
    if vdata is None or ibuf is None:
        return None

    try:
        vb = memoryview(bytes(vdata.VertexBytes))
    except Exception:
        return None

    stride = int(getattr(vdata, "VertexStride", 0) or 0)
    vcount = int(getattr(vdata, "VertexCount", 0) or 0)
    if vcount <= 0 or stride <= 0:
        return None

    vdecl = _try_get_vertex_decl(vdata)

    # Position is semantic index 0 (Position) in CodeWalker legacy declarations.
    pos_off = _component_offset(vdecl, 0) if vdecl else 0
    # Vectorize extraction using numpy buffer strides.
    try:
        pos = np.ndarray((vcount, 3), dtype=np.float32, buffer=vb, offset=pos_off, strides=(stride, 4)).copy()
    except Exception:
        return None

    indices = np.array(list(ibuf.Indices), dtype=np.uint32)
    if indices.size == 0:
        return None

    # UV0 is semantic index 6 (TexCoord0) in CodeWalker legacy declarations.
    uv = None
    if vdecl and _has_component(vdecl, 6):
        uv_off = _component_offset(vdecl, 6)
        tname = _component_type_name(vdecl, 6)
        try:
            if "Float2" in tname:
                uv = np.ndarray((vcount, 2), dtype=np.float32, buffer=vb, offset=uv_off, strides=(stride, 4)).copy()
            elif "Half2" in tname:
                uv = np.ndarray((vcount, 2), dtype=np.float16, buffer=vb, offset=uv_off, strides=(stride, 2)).astype(np.float32).copy()
        except Exception:
            uv = None

    return pos.astype(np.float32), indices.astype(np.uint32), (uv.astype(np.float32) if uv is not None else None)


def _compute_planar_uvs_xy01(positions: np.ndarray) -> np.ndarray:
    """Generate simple UVs from XY bounds: u,v in [0..1]."""
    p = np.asarray(positions, dtype=np.float32)
    minx = float(np.min(p[:, 0])) if p.size else 0.0
    maxx = float(np.max(p[:, 0])) if p.size else 1.0
    miny = float(np.min(p[:, 1])) if p.size else 0.0
    maxy = float(np.max(p[:, 1])) if p.size else 1.0
    dx = max(1e-6, maxx - minx)
    dy = max(1e-6, maxy - miny)
    u = (p[:, 0] - minx) / dx
    v = (p[:, 1] - miny) / dy
    return np.stack([u, v], axis=1).astype(np.float32)


def _merge_geometries(geoms) -> tuple[np.ndarray, np.ndarray, np.ndarray | None] | None:
    all_pos = []
    all_idx = []
    all_uv0 = []
    vbase = 0
    any_uv_missing = False
    for geom in geoms:
        res = _extract_geometry_positions_indices_uv0(geom)
        if res is None:
            continue
        pos, idx, uv0 = res
        if pos.size == 0 or idx.size == 0:
            continue
        all_pos.append(pos)
        all_idx.append(idx + vbase)
        if uv0 is None:
            any_uv_missing = True
        else:
            all_uv0.append(uv0)
        vbase += pos.shape[0]
    if not all_pos or not all_idx:
        return None
    positions = np.vstack(all_pos).astype(np.float32)
    indices = np.concatenate(all_idx).astype(np.uint32)
    if any_uv_missing:
        return positions, indices, None
    if all_uv0 and len(all_uv0) == len(all_pos):
        uv0 = np.vstack(all_uv0).astype(np.float32)
        return positions, indices, uv0
    return positions, indices, None


def _extract_drawable_lods(drawable) -> dict:
    """
    Returns dict like:
    {
      "lods": { "High": (pos, idx, nrm), "Med": ..., ... },
      "lodDistances": { "High": float, "Med": float, "Low": float, "VLow": float }
    }
    """
    if drawable is None:
        return {"lods": {}, "lodDistances": {}}

    lod_distances = {}
    for k in ("High", "Med", "Low", "VLow"):
        # CodeWalker Drawable uses LodDistHigh/Med/Low/Vlow
        prop = "LodDist" + ("Vlow" if k == "VLow" else k)
        try:
            lod_distances[k] = float(getattr(drawable, prop))
        except Exception:
            pass

    lods_out = {}
    for lod in ("High", "Med", "Low", "VLow"):
        models = _iter_drawable_models_for_lod(drawable, lod)
        geoms = []
        for m in models:
            gs = getattr(m, "Geometries", None)
            if gs is None:
                continue
            for g in gs:
                geoms.append(g)
        merged = _merge_geometries(geoms)
        if merged is None:
            continue
        pos, idx, uv0 = merged
        nrm = _compute_vertex_normals(pos, idx)
        lods_out[lod] = (pos, idx, nrm, uv0)
    return {"lods": lods_out, "lodDistances": lod_distances}


def _write_mesh_bin(
    out_path: Path,
    positions: np.ndarray,
    indices: np.ndarray,
    normals: np.ndarray | None,
    uvs: np.ndarray | None,
):
    out_path.parent.mkdir(parents=True, exist_ok=True)
    positions = np.asarray(positions, dtype=np.float32)
    indices = np.asarray(indices, dtype=np.uint32)
    flags = 0
    if normals is not None:
        normals = np.asarray(normals, dtype=np.float32)
        if normals.shape != positions.shape:
            raise ValueError("normals shape mismatch")
        flags |= FLAG_HAS_NORMALS
    if uvs is not None:
        uvs = np.asarray(uvs, dtype=np.float32)
        if uvs.shape[0] != positions.shape[0] or uvs.shape[1] != 2:
            raise ValueError("uvs shape mismatch")
        flags |= FLAG_HAS_UVS

    header = struct.pack(
        "<4sIIII",
        MESH_MAGIC,
        MESH_VERSION,
        int(positions.shape[0]),
        int(indices.shape[0]),
        int(flags),
    )

    with open(out_path, "wb") as f:
        f.write(header)
        f.write(positions.tobytes(order="C"))
        if flags & FLAG_HAS_NORMALS:
            f.write(normals.tobytes(order="C"))
        if flags & FLAG_HAS_UVS:
            f.write(uvs.tobytes(order="C"))
        f.write(indices.tobytes(order="C"))


def _pick_diffuse_texture_name(textures: dict) -> str | None:
    """
    Choose a likely diffuse texture from {name: (img_arr, fmt)}.
    Heuristic: prefer largest non-normal/non-mask texture.
    """
    candidates = []
    for name, (img, _fmt) in textures.items():
        n = (name or "").lower()
        if any(k in n for k in ("_n", "normal", "nrm", "nm_", "spec", "srm", "mask", "lookup")):
            continue
        if img is None:
            continue
        h, w = int(img.shape[0]), int(img.shape[1])
        candidates.append((w * h, name))
    if not candidates:
        return None
    candidates.sort(reverse=True)
    return candidates[0][1]


def _vec4_to_list(v) -> list[float] | None:
    try:
        x = float(getattr(v, "X"))
        y = float(getattr(v, "Y"))
        z = float(getattr(v, "Z"))
        w = float(getattr(v, "W"))
        return [x, y, z, w]
    except Exception:
        return None


def _iter_drawable_geometries(drawable, lod: str = "High"):
    try:
        models = _iter_drawable_models_for_lod(drawable, lod)
    except Exception:
        models = []
    for m in models or []:
        geoms = getattr(m, "Geometries", None)
        if geoms is None:
            continue
        for g in geoms:
            if g is not None:
                yield g


def _shader_param_iter(shader):
    """
    Yield (hash_u32, param) for a shader's parameter list.
    param.DataType:
      0 = Texture (TextureBase)
      1 = Vector (Vector4)
      >1 = Array (Vector4[])
    """
    if shader is None:
        return
    plist = getattr(shader, "ParametersList", None)
    if plist is None:
        return
    hashes = getattr(plist, "Hashes", None)
    params = getattr(plist, "Parameters", None)
    if hashes is None or params is None:
        return
    count = int(getattr(plist, "Count", 0) or 0)
    if count <= 0:
        try:
            count = len(params)
        except Exception:
            count = 0
    for i in range(count):
        try:
            hv = int(hashes[i]) & 0xFFFFFFFF
        except Exception:
            continue
        try:
            p = params[i]
        except Exception:
            continue
        yield hv, p


def _extract_uv0_scale_offset_from_shader(shader) -> list[float] | None:
    for hv, p in _shader_param_iter(shader) or []:
        if hv != _SP_G_TEXCOORD_SCALE_OFFSET0:
            continue
        try:
            if int(getattr(p, "DataType", 255)) != 1:
                continue
            v = getattr(p, "Data", None)
            out = _vec4_to_list(v)
            if out:
                return out
        except Exception:
            continue
    return None


def _pick_diffuse_texture_name_from_shader(textures: dict, shader) -> str | None:
    """
    Pick a diffuse texture name by following shader texture params, preferring common diffuse sampler params.
    Falls back to heuristic if nothing matches.
    """
    if not isinstance(textures, dict) or not textures:
        return None

    tex_by_lower = {str(k).lower(): str(k) for k in textures.keys()}
    pref_rank = {h: i for i, h in enumerate(_SP_DIFFUSE_PREFERRED)}
    candidates = []
    for hv, p in _shader_param_iter(shader) or []:
        try:
            if int(getattr(p, "DataType", 255)) != 0:
                continue
            tex = getattr(p, "Data", None)
            nm = str(getattr(tex, "Name", "")).strip()
            if not nm:
                continue
            low = nm.lower()
            if any(k in low for k in ("_n", "normal", "nrm", "nm_", "spec", "srm", "mask", "lookup")):
                continue
            key = tex_by_lower.get(low)
            if not key:
                continue
            rank = pref_rank.get(int(hv) & 0xFFFFFFFF, 999)
            candidates.append((rank, key))
        except Exception:
            continue

    if candidates:
        candidates.sort(key=lambda x: x[0])
        return candidates[0][1]

    return _pick_diffuse_texture_name(textures)


def _extract_uv0_scale_offset_from_drawable(drawable) -> list[float] | None:
    """
    Best-effort: read ShaderParamNames.gTexCoordScaleOffset0 (vec4) from any geometry shader.
    This is a major missing piece for correct GTA tiling/offset.
    """
    for g in _iter_drawable_geometries(drawable, "High"):
        try:
            sh = getattr(g, "Shader", None)
            plist = getattr(sh, "ParametersList", None)
            if plist is None:
                continue
            hashes = getattr(plist, "Hashes", None)
            params = getattr(plist, "Parameters", None)
            if hashes is None or params is None:
                continue
            count = int(getattr(plist, "Count", 0) or 0)
            if count <= 0:
                # Fallback: try len(params) if Count isn't exposed by pythonnet
                try:
                    count = len(params)
                except Exception:
                    count = 0
            for i in range(count):
                try:
                    hv = int(hashes[i]) & 0xFFFFFFFF
                except Exception:
                    continue
                if hv != _SP_G_TEXCOORD_SCALE_OFFSET0:
                    continue
                p = params[i]
                if int(getattr(p, "DataType", 255)) != 1:
                    continue
                v = getattr(p, "Data", None)
                out = _vec4_to_list(v)
                if out:
                    return out
        except Exception:
            continue
    return None


def _pick_diffuse_texture_name_from_drawable(textures: dict, drawable) -> str | None:
    """
    Prefer the shader-specified texture parameter name when possible.
    Fallback to heuristic if we can't resolve it.
    """
    try:
        if not isinstance(textures, dict) or not textures:
            return None
        # Lowercase lookup for robustness.
        tex_by_lower = {str(k).lower(): str(k) for k in textures.keys()}

        pref_rank = {h: i for i, h in enumerate(_SP_DIFFUSE_PREFERRED)}

        candidates = []
        for g in _iter_drawable_geometries(drawable, "High"):
            sh = getattr(g, "Shader", None)
            plist = getattr(sh, "ParametersList", None)
            if plist is None:
                continue
            hashes = getattr(plist, "Hashes", None)
            params = getattr(plist, "Parameters", None)
            if hashes is None or params is None:
                continue
            count = int(getattr(plist, "Count", 0) or 0)
            if count <= 0:
                try:
                    count = len(params)
                except Exception:
                    count = 0
            for i in range(count):
                p = params[i]
                if int(getattr(p, "DataType", 255)) != 0:
                    continue
                tex = getattr(p, "Data", None)
                nm = str(getattr(tex, "Name", "")).strip()
                if not nm:
                    continue
                low = nm.lower()
                if any(k in low for k in ("_n", "normal", "nrm", "nm_", "spec", "srm", "mask", "lookup")):
                    continue
                key = tex_by_lower.get(low)
                if not key:
                    continue
                try:
                    hv = int(hashes[i]) & 0xFFFFFFFF
                except Exception:
                    hv = 0
                rank = pref_rank.get(hv, 999)
                candidates.append((rank, key))

        if candidates:
            candidates.sort(key=lambda x: x[0])
            return candidates[0][1]
    except Exception:
        pass

    # fallback
    return _pick_diffuse_texture_name(textures)


def _safe_tex_name(s: str) -> str:
    """
    Sanitize a GTA texture name into a filesystem-safe token.
    Keep it stable so reruns reuse the same output file names.
    """
    out = []
    for ch in (s or ""):
        if ch.isalnum() or ch in ("_", "-", "."):
            out.append(ch)
        else:
            out.append("_")
    t = "".join(out).strip("_")
    return t[:96] if t else "tex"


def _extract_drawable_lod_submeshes(drawable, lod: str) -> list[dict]:
    """
    Return list of submesh dicts:
      { positions, indices, normals, uv0, shader }
    One entry per geometry.
    """
    out = []
    for g in _iter_drawable_geometries(drawable, lod):
        res = _extract_geometry_positions_indices_uv0(g)
        if res is None:
            continue
        pos, idx, uv0 = res
        if pos.size == 0 or idx.size == 0:
            continue
        nrm = _compute_vertex_normals(pos, idx)
        out.append(
            {
                "positions": pos,
                "indices": idx,
                "normals": nrm,
                "uv0": uv0,
                "shader": getattr(g, "Shader", None),
            }
        )
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-path", default=os.getenv("gta_location", ""), help="GTA5 install folder (or set gta_location)")
    ap.add_argument("--assets-dir", default="", help="WebGL viewer assets directory (auto if omitted)")
    ap.add_argument("--chunk", default="0_0", help='Chunk key like "0_0"')
    ap.add_argument("--max-archetypes", type=int, default=0, help="Limit archetypes exported (0 = no limit)")
    ap.add_argument("--skip-existing", action="store_true", help="Skip archetypes already present in assets/models/manifest.json")
    ap.add_argument("--force", action="store_true", help="Force re-export mesh bins even if present in manifest (useful after exporter changes)")
    ap.add_argument("--export-textures", action="store_true", help="Export one diffuse texture per archetype (slow)")
    ap.add_argument("--write-report", action="store_true", help="Write a JSON report of export outcomes into assets/models")
    args = ap.parse_args()

    game_path = (args.game_path or "").strip('"').strip("'")
    if not game_path:
        raise SystemExit("Missing --game-path (or gta_location env var)")

    # Auto-detect assets dir so running from either repo root or ./webgl works.
    if args.assets_dir:
        assets_dir = Path(args.assets_dir)
    else:
        # This script lives in ./webgl
        assets_dir = Path(__file__).parent / "webgl_viewer" / "assets"
        if not assets_dir.exists():
            # If run from repo root and script path is different than expected, fallback:
            alt = Path.cwd() / "webgl_viewer" / "assets"
            if alt.exists():
                assets_dir = alt
    chunk_path = assets_dir / "entities_chunks" / f"{args.chunk}.jsonl"
    ents = _read_chunk_entities(chunk_path)
    if not ents:
        raise SystemExit(
            f"No entities found for chunk {args.chunk} at {chunk_path}\n"
            f"Tip: verify your assets dir. I resolved it to: {assets_dir}"
        )

    # Collect unique archetype hashes
    hashes = []
    seen = set()
    for e in ents:
        a = e.get("archetype")
        if a is None:
            continue
        try:
            h = _as_uint32(a)
        except Exception:
            continue
        if h in seen:
            continue
        seen.add(h)
        hashes.append(h)

    if args.max_archetypes and args.max_archetypes > 0:
        hashes = hashes[: args.max_archetypes]
    print(f"Chunk {args.chunk}: {len(seen)} unique archetypes, exporting {len(hashes)} (max_archetypes={args.max_archetypes})")

    dm = DllManager(game_path)
    if not dm.initialized:
        raise SystemExit("Failed to initialize DllManager")

    # DllManager API differs across branches:
    # - This repo's linux-focused DllManager builds GameFileCache during __init__ and exposes it as get_game_cache().
    # - Some older branches expose init_game_file_cache()/get_game_file_cache().
    if hasattr(dm, "init_game_file_cache"):
        try:
            if not dm.init_game_file_cache():
                raise SystemExit("Failed to init GameFileCache (required for drawables)")
        except Exception as e:
            raise SystemExit(f"Failed to init GameFileCache: {e}")

    gfc = None
    if hasattr(dm, "get_game_file_cache"):
        try:
            gfc = dm.get_game_file_cache()
        except Exception:
            gfc = None
    if gfc is None and hasattr(dm, "get_game_cache"):
        try:
            gfc = dm.get_game_cache()
        except Exception:
            gfc = None
    if gfc is None:
        # Last-resort: direct attribute
        gfc = getattr(dm, "game_file_cache", None)

    if gfc is None:
        raise SystemExit("GameFileCache not available on DllManager (required for drawables)")
    try:
        gfc.MaxItemsPerLoop = 50
    except Exception:
        pass

    models_dir = assets_dir / "models"
    manifest_path = models_dir / "manifest.json"
    # Merge into existing manifest if present so repeated runs only add missing meshes.
    # Version 4: supports per-LOD submeshes with per-submesh material.
    manifest = {"version": 4, "meshes": {}}
    if manifest_path.exists():
        try:
            existing = json.loads(manifest_path.read_text(encoding="utf-8"))
            if isinstance(existing, dict) and isinstance(existing.get("meshes"), dict):
                manifest = existing
                if "version" not in manifest:
                    manifest["version"] = 4
        except Exception:
            pass
    already = set((manifest.get("meshes") or {}).keys())

    # Optional texture exporting
    tex_dir = assets_dir / "models_textures"
    rpf_reader = RpfReader(str(game_path), dm) if args.export_textures else None

    skipped_existing = 0
    requested = 0
    exported_now = 0
    textures_exported_now = 0
    no_archetype = 0
    no_drawable = 0
    no_lods = 0
    errors = 0
    failures_sample = []  # [{hash, reason}...]
    for h in hashes:
        requested += 1
        hs = str(h & 0xFFFFFFFF)
        existing_entry = (manifest.get("meshes") or {}).get(hs) if isinstance(manifest.get("meshes"), dict) else None
        have_mesh_already = bool(existing_entry and isinstance(existing_entry, dict) and (existing_entry.get("lods") or {}))
        have_diffuse_already = _entry_has_any_diffuse(existing_entry) if isinstance(existing_entry, dict) else False

        # If we're only missing textures, allow "--skip-existing" to still process texture export.
        if args.skip_existing and (not args.force) and hs in already and (not args.export_textures or have_diffuse_already):
            skipped_existing += 1
            continue
        try:
            arch = gfc.GetArchetype(h)
        except Exception:
            arch = None
        if arch is None:
            no_archetype += 1
            if len(failures_sample) < 200:
                failures_sample.append({"hash": hs, "reason": "no_archetype"})
            continue

        # Trigger drawable load and pump the content loader.
        drawable = gfc.TryGetDrawable(arch)
        spins = 0
        while drawable is None and spins < 400:
            # Progress load queue
            gfc.ContentThreadProc()
            drawable = gfc.TryGetDrawable(arch)
            spins += 1

        if drawable is None:
            no_drawable += 1
            if len(failures_sample) < 200:
                failures_sample.append({"hash": hs, "reason": "no_drawable"})
            continue

        # If mesh already exists and we only want textures/metadata, skip geometry work.
        entry = existing_entry if (have_mesh_already and isinstance(existing_entry, dict)) else {"lods": {}, "lodDistances": {}, "material": {}}
        if not isinstance(entry, dict):
            entry = {"lods": {}, "lodDistances": {}, "material": {}}

        # Read texdict + textures once per archetype (used for per-submesh texture selection).
        td_hash = None
        textures = None
        if args.export_textures and rpf_reader:
            try:
                tdh = getattr(arch, "TextureDict", None)
                if tdh is not None:
                    # NOTE: `arch.TextureDict` is often a CodeWalker `MetaHash`.
                    # Don't use `getattr(tdh, "Hash", int(tdh))` because Python eagerly evaluates
                    # the default arg (and `int(MetaHash)` throws). Fetch Hash explicitly.
                    try:
                        td_hash = int(getattr(tdh, "Hash")) & 0xFFFFFFFF
                    except Exception:
                        td_hash = int(tdh) & 0xFFFFFFFF
            except Exception:
                td_hash = None
            try:
                if td_hash and td_hash != 0:
                    ytd = gfc.GetYtd(td_hash)
                    spins = 0
                    while (ytd is not None) and (not getattr(ytd, "Loaded", True)) and spins < 400:
                        gfc.ContentThreadProc()
                        spins += 1
                    if ytd is not None and getattr(ytd, "Loaded", True):
                        textures = rpf_reader.get_ytd_textures(ytd)
            except Exception:
                textures = None

        if (not have_mesh_already) or bool(args.force):
            # Export per-geometry submeshes per LOD (this is required for multi-material correctness).
            lod_distances = {}
            for k in ("High", "Med", "Low", "VLow"):
                prop = "LodDist" + ("Vlow" if k == "VLow" else k)
                try:
                    lod_distances[k] = float(getattr(drawable, prop))
                except Exception:
                    pass
            entry["lodDistances"] = lod_distances
            if "lods" not in entry or not isinstance(entry.get("lods"), dict):
                entry["lods"] = {}
            if "material" not in entry or not isinstance(entry.get("material"), dict):
                entry["material"] = {}

        if (not have_mesh_already) or bool(args.force):
            try:
                # Build submeshes per LOD.
                for lod in ("High", "Med", "Low", "VLow"):
                    lod_key = lod.lower()
                    subs = _extract_drawable_lod_submeshes(drawable, lod)
                    if not subs:
                        continue
                    sub_entries = []
                    for si, sub in enumerate(subs):
                        positions = sub["positions"]
                        indices = sub["indices"]
                        normals = sub["normals"]
                        uv0 = sub.get("uv0")
                        shader = sub.get("shader")

                        uvs = uv0 if (uv0 is not None and getattr(uv0, "size", 0)) else _compute_planar_uvs_xy01(positions)

                        out_bin = models_dir / f"{h}_{lod_key}_{si}.bin"
                        _write_mesh_bin(out_bin, positions, indices, normals, uvs)

                        mat = {}
                        # UV scale/offset per submesh (shader param).
                        uvso = _extract_uv0_scale_offset_from_shader(shader)
                        if uvso and len(uvso) >= 4:
                            mat["uv0ScaleOffset"] = [float(uvso[0]), float(uvso[1]), float(uvso[2]), float(uvso[3])]

                        # Diffuse texture per submesh.
                        if textures and isinstance(textures, dict) and td_hash:
                            pick = _pick_diffuse_texture_name_from_shader(textures, shader)
                            if pick and pick in textures:
                                img, _fmt = textures[pick]
                                try:
                                    if img is not None:
                                        if img.shape[2] == 3:
                                            rgba = np.concatenate(
                                                [img, 255 * np.ones((img.shape[0], img.shape[1], 1), dtype=np.uint8)], axis=2
                                            )
                                        else:
                                            rgba = img
                                        tex_dir.mkdir(parents=True, exist_ok=True)
                                        safe = _safe_tex_name(pick)
                                        out_tex = tex_dir / f"{td_hash}_{safe}.png"
                                        if not out_tex.exists():
                                            Image.fromarray(rgba, mode="RGBA").save(out_tex)
                                            textures_exported_now += 1
                                        mat["diffuse"] = f"models_textures/{td_hash}_{safe}.png"
                                        mat["diffuseName"] = str(pick)
                                except Exception:
                                    pass

                        sub_entries.append(
                            {
                                "file": f"{h}_{lod_key}_{si}.bin",
                                "vertexCount": int(positions.shape[0]),
                                "indexCount": int(indices.shape[0]),
                                "hasNormals": True,
                                "hasUvs": True,
                                "material": mat,
                            }
                        )

                    if sub_entries:
                        entry["lods"][lod_key] = {"submeshes": sub_entries}

                if not entry.get("lods"):
                    no_lods += 1
                    if len(failures_sample) < 200:
                        failures_sample.append({"hash": hs, "reason": "no_lods"})
                    continue

                manifest["meshes"][hs] = entry
                already.add(hs)
                if not have_mesh_already:
                    exported_now += 1
            except Exception:
                errors += 1
                if len(failures_sample) < 200:
                    failures_sample.append({"hash": hs, "reason": "exception_writing"})
        else:
            # Texture-only update (or other metadata update). If meshes already exist, we still want to
            # export diffuse PNGs + add material.diffuse references.
            if args.export_textures and textures and isinstance(textures, dict) and td_hash:
                try:
                    for lod in ("High", "Med", "Low", "VLow"):
                        lod_key = lod.lower()
                        lods_dict = entry.get("lods") if isinstance(entry, dict) else None
                        lod_meta = lods_dict.get(lod_key) if isinstance(lods_dict, dict) else None
                        if not isinstance(lod_meta, dict):
                            continue
                        submeshes = lod_meta.get("submeshes")
                        if not isinstance(submeshes, list) or not submeshes:
                            continue

                        subs = _extract_drawable_lod_submeshes(drawable, lod)
                        if not subs:
                            continue

                        for si, sub in enumerate(subs):
                            if si >= len(submeshes):
                                break
                            sm = submeshes[si]
                            if not isinstance(sm, dict):
                                continue
                            mat = sm.get("material")
                            if not isinstance(mat, dict):
                                mat = {}
                                sm["material"] = mat
                            if mat.get("diffuse"):
                                continue

                            shader = sub.get("shader")
                            pick = _pick_diffuse_texture_name_from_shader(textures, shader)
                            if not pick or pick not in textures:
                                continue
                            img, _fmt = textures[pick]
                            if img is None:
                                continue

                            try:
                                if img.shape[2] == 3:
                                    rgba = np.concatenate(
                                        [img, 255 * np.ones((img.shape[0], img.shape[1], 1), dtype=np.uint8)], axis=2
                                    )
                                else:
                                    rgba = img
                                tex_dir.mkdir(parents=True, exist_ok=True)
                                safe = _safe_tex_name(pick)
                                out_tex = tex_dir / f"{td_hash}_{safe}.png"
                                if not out_tex.exists():
                                    Image.fromarray(rgba, mode="RGBA").save(out_tex)
                                    textures_exported_now += 1
                                mat["diffuse"] = f"models_textures/{td_hash}_{safe}.png"
                                mat["diffuseName"] = str(pick)
                            except Exception:
                                pass
                except Exception:
                    pass

            manifest["meshes"][hs] = entry

    models_dir.mkdir(parents=True, exist_ok=True)
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    if args.skip_existing:
        print(
            f"Wrote {len(manifest['meshes'])} meshes to {models_dir} "
            f"(requested={requested} exported_now={exported_now} textures_exported_now={textures_exported_now} skipped_existing={skipped_existing} "
            f"no_archetype={no_archetype} no_drawable={no_drawable} no_lods={no_lods} errors={errors})"
        )
    else:
        print(
            f"Wrote {len(manifest['meshes'])} meshes to {models_dir} "
            f"(requested={requested} exported_now={exported_now} textures_exported_now={textures_exported_now} "
            f"no_archetype={no_archetype} no_drawable={no_drawable} no_lods={no_lods} errors={errors})"
        )

    if args.write_report:
        try:
            report = {
                "version": 1,
                "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "chunk": str(args.chunk),
                "assetsDir": str(assets_dir),
                "modelsDir": str(models_dir),
                "requested": requested,
                "exportedNow": exported_now,
                "texturesExportedNow": textures_exported_now,
                "skippedExisting": skipped_existing,
                "noArchetype": no_archetype,
                "noDrawable": no_drawable,
                "noLods": no_lods,
                "errors": errors,
                "failuresSample": failures_sample,
            }
            rp = models_dir / f"export_report_chunk_{str(args.chunk).replace('/', '_')}_{int(time.time())}.json"
            rp.write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(f"Wrote export report: {rp}")
        except Exception:
            pass


if __name__ == "__main__":
    main()



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
import re
import struct
from pathlib import Path
import time
import math
import shutil
import subprocess

import numpy as np
from PIL import Image

from gta5_modules.dll_manager import DllManager
from gta5_modules.rpf_reader import RpfReader


MESH_MAGIC = b"MSH0"
MESH_VERSION = 7
FLAG_HAS_NORMALS = 1
FLAG_HAS_UVS = 2
FLAG_HAS_TANGENTS = 4
FLAG_HAS_COLOR0 = 8
FLAG_HAS_UV1 = 16
FLAG_HAS_UV2 = 32
FLAG_HAS_COLOR1 = 64

# Shader param hashes from CodeWalker.Core (ShaderParamNames enum).
_SP_G_TEXCOORD_SCALE_OFFSET0 = 3099617970  # gTexCoordScaleOffset0
_SP_GLOBAL_ANIM_UV0 = 3617324062  # globalAnimUV0 (CodeWalker ShaderParamNames)
_SP_GLOBAL_ANIM_UV1 = 3126116752  # globalAnimUV1 (CodeWalker ShaderParamNames)

# Preferred diffuse-ish shader texture parameters (hashes from ShaderParamNames).
_SP_DIFFUSE_PREFERRED = [
    4059966321,  # DiffuseSampler
    1732587965,  # DiffuseNoBorderTexSampler
    1399472831,  # baseTextureSampler
    2669264211,  # BaseSampler
    934209648,   # ColorTexture
]

# Preferred normal-map-ish shader texture parameters (hashes from CodeWalker.Core ShaderParamNames enum).
_SP_NORMAL_PREFERRED = [
    1186448975,  # BumpSampler
    2327911600,  # normalSampler
    2903840997,  # DetailNormalSampler (fallback)
]

# Preferred spec-map-ish shader texture parameters (hashes from CodeWalker.Core ShaderParamNames enum).
_SP_SPEC_PREFERRED = [
    1619499462,  # SpecSampler
    2134197289,  # AnisoNoiseSpecSampler (fallback)
]

# Scalar-ish shader params (vec4.x) we can use for rough GTA-like shading (hashes from ShaderParamNames).
_SP_BUMPINESS = 4134611841  # bumpiness
_SP_SPEC_INTENSITY_PREFERRED = [
    247886295,   # gSpecularIntensity
    4095226703,  # specularIntensityMult
    2841625909,  # SpecularIntensity
]
_SP_SPEC_POWER_PREFERRED = [
    3204977572,  # gSpecularExponent
    2272544384,  # specularFalloffMult
    2313518026,  # SpecularPower
]
_SP_SPEC_MAP_INT_MASK = 4279333149  # specMapIntMask (float3 in CodeWalker BasicPS)
_SP_ALPHA_SCALE = 931055822         # AlphaScale
_SP_HARD_ALPHA_BLEND = 3913511942   # HardAlphaBlend
_SP_ALPHA_TEST_VALUE = 3310830370   # alphaTestValue
_SP_DIFFUSE2 = 181641832            # DiffuseSampler2
_SP_DETAIL_MAP_SAMPLER = 1041827691 # DetailMapSampler
_SP_DETAIL_SAMPLER = 3393362404     # DetailSampler
_SP_DETAIL_SETTINGS = 3038654095    # detailSettings
_SP_OCCLUSION_SAMPLER = 50748941    # occlusionSampler


def _shader_family_from_shader(shader) -> str:
    """
    Best-effort shader family classification.
    This is intentionally keyword-based (since CodeWalker exposes only hashes + filenames here).

    Families are used by the viewer to pick a render pipeline/shader program.
    """
    name = _shader_name_str(shader).lower()
    # Decals / projected decals / alpha-mask decals
    if any(k in name for k in ("decal", "texturealphamask", "alphamaskdecal", "decalmask")):
        return "decal"
    # Glass / windows / translucent reflective materials
    if any(k in name for k in ("glass", "window", "windscreen", "windshield")):
        return "glass"
    # Environment / reflections (generic bucket; viewer may treat as reflective)
    if any(k in name for k in ("env", "environment", "reflection", "reflect")):
        return "env"
    # Parallax / height mapping
    if any(k in name for k in ("parallax", "heightmap", "pom")):
        return "parallax"
    # Wetness / puddles / damage style (generic bucket)
    if any(k in name for k in ("wet", "puddle", "water", "rain", "damage", "mud")):
        return "wetness"
    return "basic"


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


def joaat(input_str: str) -> int:
    """
    GTA "joaat" (Jenkins one-at-a-time) hash.
    Must match the viewer's implementation (see webgl_viewer/js/joaat.js).
    """
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


def _slugify_texture_name(name: str) -> str:
    """
    Match viewer-side slugification (see ModelManager._slugifyTextureName):
      - lowercase
      - replace non [a-z0-9] with '_'
      - trim leading/trailing underscores
    """
    s = str(name or "").strip().lower()
    if not s:
        return ""
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = re.sub(r"^_+", "", s)
    s = re.sub(r"_+$", "", s)
    return s


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


def _compute_vertex_tangents(positions: np.ndarray, uvs: np.ndarray, indices: np.ndarray, normals: np.ndarray) -> np.ndarray:
    """
    Compute per-vertex tangents (vec4) for tangent-space normal mapping.
    Tangent.w encodes handedness so bitangent can be reconstructed as cross(N, T.xyz) * T.w.
    """
    positions = np.asarray(positions, dtype=np.float32)
    uvs = np.asarray(uvs, dtype=np.float32)
    indices = np.asarray(indices, dtype=np.uint32)
    normals = np.asarray(normals, dtype=np.float32)

    vcount = int(positions.shape[0])
    if vcount <= 0:
        return np.zeros((0, 4), dtype=np.float32)
    if uvs.shape[0] != vcount or uvs.shape[1] != 2:
        raise ValueError("uvs shape mismatch for tangents")
    if normals.shape != positions.shape:
        raise ValueError("normals shape mismatch for tangents")

    if indices.size % 3 != 0:
        indices = indices[: (indices.size // 3) * 3]
    if indices.size == 0:
        out0 = np.zeros((vcount, 4), dtype=np.float32)
        out0[:, 0] = 1.0
        out0[:, 3] = 1.0
        return out0

    tan1 = np.zeros((vcount, 3), dtype=np.float32)
    tan2 = np.zeros((vcount, 3), dtype=np.float32)

    tris = indices.reshape(-1, 3)
    p0 = positions[tris[:, 0]]
    p1 = positions[tris[:, 1]]
    p2 = positions[tris[:, 2]]

    w0 = uvs[tris[:, 0]]
    w1 = uvs[tris[:, 1]]
    w2 = uvs[tris[:, 2]]

    x1 = p1 - p0
    x2 = p2 - p0
    s1 = w1[:, 0] - w0[:, 0]
    s2 = w2[:, 0] - w0[:, 0]
    t1 = w1[:, 1] - w0[:, 1]
    t2 = w2[:, 1] - w0[:, 1]

    r = (s1 * t2 - s2 * t1)
    eps = 1e-20
    valid = np.abs(r) > eps
    if np.any(valid):
        rv = np.zeros_like(r, dtype=np.float32)
        rv[valid] = (1.0 / r[valid]).astype(np.float32)

        sdir = (x1 * t2[:, None] - x2 * t1[:, None]) * rv[:, None]
        tdir = (x2 * s1[:, None] - x1 * s2[:, None]) * rv[:, None]

        np.add.at(tan1, tris[:, 0], sdir)
        np.add.at(tan1, tris[:, 1], sdir)
        np.add.at(tan1, tris[:, 2], sdir)
        np.add.at(tan2, tris[:, 0], tdir)
        np.add.at(tan2, tris[:, 1], tdir)
        np.add.at(tan2, tris[:, 2], tdir)

    # Orthonormalize: t = normalize(tan1 - n*dot(n,tan1))
    n = normals
    t = tan1
    ndott = np.sum(n * t, axis=1, keepdims=True)
    t = t - n * ndott
    tl = np.linalg.norm(t, axis=1)
    tl_safe = np.where(tl > 0.0, tl, 1.0).astype(np.float32)
    t = (t / tl_safe[:, None]).astype(np.float32)

    # Fallback for degenerate tangents: choose a stable perpendicular vector.
    deg = tl <= 1e-8
    if np.any(deg):
        ref = np.zeros_like(t, dtype=np.float32)
        ref[:, 0] = 1.0
        use_y = np.abs(n[:, 0]) > 0.9
        ref[use_y, 0] = 0.0
        ref[use_y, 1] = 1.0
        tf = np.cross(ref, n)
        tfl = np.linalg.norm(tf, axis=1)
        tfl_safe = np.where(tfl > 0.0, tfl, 1.0).astype(np.float32)
        tf = (tf / tfl_safe[:, None]).astype(np.float32)
        t[deg] = tf[deg]

    # Handedness: w = sign(dot(cross(n,t), tan2))
    c = np.cross(n, t)
    w = np.sum(c * tan2, axis=1)
    w = np.where(w < 0.0, -1.0, 1.0).astype(np.float32)

    out = np.zeros((vcount, 4), dtype=np.float32)
    out[:, 0:3] = t
    out[:, 3] = w
    return out


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


def _extract_geometry_positions_indices_uv0_uv1_color0(
    geom,
) -> tuple[np.ndarray, np.ndarray, np.ndarray | None, np.ndarray | None, np.ndarray | None] | None:
    """
    Extract positions + indices + UV0 (+ Color0 when present) from a CodeWalker drawable geometry.

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

    # UV1 is semantic index 7 (TexCoord1) in CodeWalker legacy declarations.
    uv1 = None
    if vdecl and _has_component(vdecl, 7):
        uv1_off = _component_offset(vdecl, 7)
        tname1 = _component_type_name(vdecl, 7)
        try:
            if "Float2" in tname1:
                uv1 = np.ndarray((vcount, 2), dtype=np.float32, buffer=vb, offset=uv1_off, strides=(stride, 4)).copy()
            elif "Half2" in tname1:
                uv1 = np.ndarray((vcount, 2), dtype=np.float16, buffer=vb, offset=uv1_off, strides=(stride, 2)).astype(np.float32).copy()
        except Exception:
            uv1 = None

    # Color0 is semantic index 4; Color1 is semantic index 5.
    col0 = None
    col1 = None
    if vdecl:
        # Colour0
        if _has_component(vdecl, 4):
            c_off = _component_offset(vdecl, 4)
            ct = _component_type_name(vdecl, 4)
            try:
                if "UByte4" in ct or "Byte4" in ct or "Colour" in ct:
                    col0 = np.ndarray((vcount, 4), dtype=np.uint8, buffer=vb, offset=c_off, strides=(stride, 1)).copy()
            except Exception:
                col0 = None
        # Colour1
        if _has_component(vdecl, 5):
            c1_off = _component_offset(vdecl, 5)
            ct1 = _component_type_name(vdecl, 5)
            try:
                if "UByte4" in ct1 or "Byte4" in ct1 or "Colour" in ct1:
                    col1 = np.ndarray((vcount, 4), dtype=np.uint8, buffer=vb, offset=c1_off, strides=(stride, 1)).copy()
            except Exception:
                col1 = None
    # Fallback: if Colour0 missing but Colour1 exists, use it as Colour0 (common enough).
    if col0 is None and col1 is not None:
        col0 = col1

    # UV2 is semantic index 8.
    uv2 = None
    if vdecl and _has_component(vdecl, 8):
        uv2_off = _component_offset(vdecl, 8)
        tname2 = _component_type_name(vdecl, 8)
        try:
            if "Float2" in tname2:
                uv2 = np.ndarray((vcount, 2), dtype=np.float32, buffer=vb, offset=uv2_off, strides=(stride, 4)).copy()
            elif "Half2" in tname2:
                uv2 = np.ndarray((vcount, 2), dtype=np.float16, buffer=vb, offset=uv2_off, strides=(stride, 2)).astype(np.float32).copy()
        except Exception:
            uv2 = None

    return (
        pos.astype(np.float32),
        indices.astype(np.uint32),
        (uv.astype(np.float32) if uv is not None else None),
        (uv1.astype(np.float32) if uv1 is not None else None),
        (uv2.astype(np.float32) if uv2 is not None else None),
        (col0.astype(np.uint8) if col0 is not None else None),
        (col1.astype(np.uint8) if col1 is not None else None),
    )


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


def _merge_geometries(
    geoms,
) -> tuple[np.ndarray, np.ndarray, np.ndarray | None, np.ndarray | None, np.ndarray | None, np.ndarray | None, np.ndarray | None] | None:
    all_pos = []
    all_idx = []
    all_uv0 = []
    all_uv1 = []
    all_uv2 = []
    all_col0 = []
    all_col1 = []
    vbase = 0
    any_uv_missing = False
    any_uv1_missing = False
    any_uv2_missing = False
    any_col_missing = False
    any_col1_missing = False
    for geom in geoms:
        res = _extract_geometry_positions_indices_uv0_uv1_color0(geom)
        if res is None:
            continue
        pos, idx, uv0, uv1, uv2, col0, col1 = res
        if pos.size == 0 or idx.size == 0:
            continue
        all_pos.append(pos)
        all_idx.append(idx + vbase)
        if uv0 is None:
            any_uv_missing = True
        else:
            all_uv0.append(uv0)
        if uv1 is None:
            any_uv1_missing = True
        else:
            all_uv1.append(uv1)
        if uv2 is None:
            any_uv2_missing = True
        else:
            all_uv2.append(uv2)
        if col0 is None:
            any_col_missing = True
        else:
            all_col0.append(col0)
        if col1 is None:
            any_col1_missing = True
        else:
            all_col1.append(col1)
        vbase += pos.shape[0]
    if not all_pos or not all_idx:
        return None
    positions = np.vstack(all_pos).astype(np.float32)
    indices = np.concatenate(all_idx).astype(np.uint32)
    uv0 = None
    uv1 = None
    uv2 = None
    col0 = None
    col1 = None
    if (not any_uv_missing) and all_uv0 and len(all_uv0) == len(all_pos):
        uv0 = np.vstack(all_uv0).astype(np.float32)
    if (not any_uv1_missing) and all_uv1 and len(all_uv1) == len(all_pos):
        uv1 = np.vstack(all_uv1).astype(np.float32)
    if (not any_uv2_missing) and all_uv2 and len(all_uv2) == len(all_pos):
        uv2 = np.vstack(all_uv2).astype(np.float32)
    if (not any_col_missing) and all_col0 and len(all_col0) == len(all_pos):
        col0 = np.vstack(all_col0).astype(np.uint8)
    if (not any_col1_missing) and all_col1 and len(all_col1) == len(all_pos):
        col1 = np.vstack(all_col1).astype(np.uint8)
    return positions, indices, uv0, uv1, uv2, col0, col1


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
        pos, idx, uv0, _uv1, _uv2, _col0, _col1 = merged
        nrm = _compute_vertex_normals(pos, idx)
        lods_out[lod] = (pos, idx, nrm, uv0)
    return {"lods": lods_out, "lodDistances": lod_distances}


def _write_mesh_bin(
    out_path: Path,
    positions: np.ndarray,
    indices: np.ndarray,
    normals: np.ndarray | None,
    uvs: np.ndarray | None,
    tangents: np.ndarray | None = None,
    color0: np.ndarray | None = None,
    uvs1: np.ndarray | None = None,
    uvs2: np.ndarray | None = None,
    color1: np.ndarray | None = None,
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
    if uvs1 is not None:
        uvs1 = np.asarray(uvs1, dtype=np.float32)
        if uvs1.shape[0] != positions.shape[0] or uvs1.shape[1] != 2:
            raise ValueError("uvs1 shape mismatch")
        flags |= FLAG_HAS_UV1
    if uvs2 is not None:
        uvs2 = np.asarray(uvs2, dtype=np.float32)
        if uvs2.shape[0] != positions.shape[0] or uvs2.shape[1] != 2:
            raise ValueError("uvs2 shape mismatch")
        flags |= FLAG_HAS_UV2
    if tangents is not None:
        tangents = np.asarray(tangents, dtype=np.float32)
        if tangents.shape[0] != positions.shape[0] or tangents.shape[1] != 4:
            raise ValueError("tangents shape mismatch")
        flags |= FLAG_HAS_TANGENTS
    if color0 is not None:
        color0 = np.asarray(color0, dtype=np.uint8)
        if color0.shape[0] != positions.shape[0] or color0.shape[1] != 4:
            raise ValueError("color0 shape mismatch")
        flags |= FLAG_HAS_COLOR0
    if color1 is not None:
        color1 = np.asarray(color1, dtype=np.uint8)
        if color1.shape[0] != positions.shape[0] or color1.shape[1] != 4:
            raise ValueError("color1 shape mismatch")
        flags |= FLAG_HAS_COLOR1

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
        if flags & FLAG_HAS_UV1:
            f.write(uvs1.tobytes(order="C"))
        if flags & FLAG_HAS_UV2:
            f.write(uvs2.tobytes(order="C"))
        if flags & FLAG_HAS_TANGENTS:
            f.write(tangents.tobytes(order="C"))
        if flags & FLAG_HAS_COLOR0:
            f.write(color0.tobytes(order="C"))
        if flags & FLAG_HAS_COLOR1:
            f.write(color1.tobytes(order="C"))
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


def _extract_vec4_from_shader(shader, hv_u32: int) -> list[float] | None:
    want = int(hv_u32) & 0xFFFFFFFF
    for hv, p in _shader_param_iter(shader) or []:
        try:
            if (int(hv) & 0xFFFFFFFF) != want:
                continue
            if int(getattr(p, "DataType", 255)) != 1:
                continue
            v = getattr(p, "Data", None)
            out = _vec4_to_list(v)
            if out:
                return out
        except Exception:
            continue
    return None


def _shader_name_str(shader) -> str:
    """
    Best-effort: return something like "normal_spec_cutout.sps" or "normal_spec_cutout".
    Useful for coarse feature detection (alpha/cutout/doubleSided).
    """
    if shader is None:
        return ""
    parts = []
    for attr in ("FileName", "Name"):
        try:
            v = getattr(shader, attr, None)
        except Exception:
            v = None
        if v is None:
            continue
        try:
            s = str(v).strip()
        except Exception:
            s = ""
        if s and s not in parts:
            parts.append(s)
    return " ".join(parts)


def _material_flags_from_shader(shader) -> dict:
    """
    Coarse mapping from CodeWalker shader name to viewer material flags.
    This intentionally errs on the conservative side.
    """
    name = _shader_name_str(shader).lower()
    shader_family = _shader_family_from_shader(shader)
    alpha_mode = "opaque"
    if "cutout" in name or "fence" in name:
        alpha_mode = "cutout"
    elif ("alpha" in name) or ("glass" in name) or ("screendoor" in name):
        alpha_mode = "blend"
    double_sided = any(k in name for k in ("leaves", "grass", "foliage", "fence"))
    return {
        "shaderName": name[:128] if name else "",
        "shaderFamily": shader_family,
        "alphaMode": alpha_mode,
        "doubleSided": bool(double_sided),
    }


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


def _pick_diffuse_texture_name_from_shader_with_hash(textures: dict, shader) -> tuple[str | None, int | None]:
    """
    Like _pick_diffuse_texture_name_from_shader, but also returns the shader param hash (u32) that selected it.
    Returns (name, hash_u32) where hash_u32 can be None when we fell back to heuristic selection.
    """
    if not isinstance(textures, dict) or not textures:
        return None, None

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
            hv_u32 = int(hv) & 0xFFFFFFFF
            rank = pref_rank.get(hv_u32, 999)
            candidates.append((rank, hv_u32, key))
        except Exception:
            continue

    if candidates:
        candidates.sort(key=lambda x: x[0])
        return candidates[0][2], candidates[0][1]

    # Heuristic fallback (no reliable param hash).
    return _pick_diffuse_texture_name(textures), None


def _pick_texture_name_from_shader(textures: dict, shader, preferred_hashes: list[int], require_keywords: tuple[str, ...] | None = None) -> str | None:
    """
    Pick a texture name by following shader texture params, preferring certain param hashes.
    Optionally require keyword(s) to appear in the texture name.
    """
    if not isinstance(textures, dict) or not textures:
        return None

    pref_rank = {int(h) & 0xFFFFFFFF: i for i, h in enumerate(preferred_hashes or [])}

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
            if require_keywords and not any(k in low for k in require_keywords):
                continue
            rank = pref_rank.get(int(hv) & 0xFFFFFFFF, 999)
            candidates.append((rank, nm))
        except Exception:
            continue

    if candidates:
        candidates.sort(key=lambda x: x[0])
        return candidates[0][1]
    return None


def _pick_texture_name_from_shader_with_hash(
    textures: dict,
    shader,
    preferred_hashes: list[int],
    require_keywords: tuple[str, ...] | None = None,
) -> tuple[str | None, int | None]:
    """
    Like _pick_texture_name_from_shader, but also returns the shader param hash (u32) that selected it.
    Returns (name, hash_u32) where hash_u32 can be None if no selection was possible.
    """
    if not isinstance(textures, dict) or not textures:
        return None, None

    pref_rank = {int(h) & 0xFFFFFFFF: i for i, h in enumerate(preferred_hashes or [])}

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
            if require_keywords and not any(k in low for k in require_keywords):
                continue
            hv_u32 = int(hv) & 0xFFFFFFFF
            rank = pref_rank.get(hv_u32, 999)
            candidates.append((rank, hv_u32, nm))
        except Exception:
            continue

    if candidates:
        candidates.sort(key=lambda x: x[0])
        return candidates[0][2], candidates[0][1]
    return None, None


def _format_name_for_texture(textures: dict, tex_name: str) -> str | None:
    """
    Return the CodeWalker texture format name string for a given texture (e.g. 'D3DFMT_ATI2', 'D3DFMT_DXT5').
    This comes from gta5_modules.rpf_reader.get_ytd_textures() -> (img, format_name).
    """
    try:
        if not tex_name or not isinstance(textures, dict) or tex_name not in textures:
            return None
        _img, fmt = textures.get(tex_name, (None, None))
        s = str(fmt or "").strip()
        return s or None
    except Exception:
        return None


def _normal_decode_flags_from_codewalker_format(tex_name: str, fmt_name: str | None) -> dict:
    """
    Emit viewer normal decode flags based on CodeWalker format.
    - BC5 (ATI2): XY in RG, Z reconstructed => swizzle='rg', reconstructZ=1
    - DXT5 normal maps often use DXT5nm packing: X in A, Y in G => swizzle='ag', reconstructZ=1
      (Heuristic gated by texture name keywords.)
    - Otherwise: assume standard RGB normal => swizzle='rg', reconstructZ=0
    """
    low = str(tex_name or "").lower()
    fmt = str(fmt_name or "").upper()

    if "ATI2" in fmt or "BC5" in fmt:
        return {"normalSwizzle": "rg", "normalReconstructZ": 1}

    # DXT5nm heuristic: name suggests normal and format is DXT5/BC3.
    if ("DXT5" in fmt or "BC3" in fmt) and any(k in low for k in ("_n", "normal", "nrm", "nm_", "bump")):
        return {"normalSwizzle": "ag", "normalReconstructZ": 1}

    return {"normalSwizzle": "rg", "normalReconstructZ": 0}

def _pick_texture_by_keywords(textures: dict, include_keywords: tuple[str, ...], exclude_keywords: tuple[str, ...] | None = None) -> str | None:
    """
    Heuristic fallback: choose largest texture matching include_keywords (and not matching exclude_keywords).
    """
    if not isinstance(textures, dict) or not textures:
        return None
    candidates = []
    for name, (img, _fmt) in textures.items():
        low = str(name or "").lower()
        if include_keywords and not any(k in low for k in include_keywords):
            continue
        if exclude_keywords and any(k in low for k in exclude_keywords):
            continue
        if img is None:
            continue
        try:
            h, w = int(img.shape[0]), int(img.shape[1])
        except Exception:
            continue
        candidates.append((w * h, str(name)))
    if not candidates:
        return None
    candidates.sort(reverse=True)
    return candidates[0][1]


def _extract_scalar_x_from_shader(shader, preferred_hashes: list[int]) -> float | None:
    """
    Return vec4.x for the first matching shader param hash in preferred_hashes.
    """
    want = {int(h) & 0xFFFFFFFF for h in (preferred_hashes or [])}
    if not want:
        return None
    for hv, p in _shader_param_iter(shader) or []:
        try:
            if (int(hv) & 0xFFFFFFFF) not in want:
                continue
            if int(getattr(p, "DataType", 255)) != 1:
                continue
            v = getattr(p, "Data", None)
            x = float(getattr(v, "X"))
            if math.isfinite(x):
                return float(x)
        except Exception:
            continue
    return None


def _extract_shader_params(shader, max_textures: int = 32, max_vectors: int = 64) -> dict | None:
    """
    Export a compact raw parameter set keyed by hash:
      - texturesByHash: { "<u32>": "<textureName>" }
      - vectorsByHash:  { "<u32>": [x,y,z,w] }

    This is the "data gap" escape hatch: even if we don't yet implement a shader family,
    the viewer (or future tooling) can still reconstruct behavior from the original param set.
    """
    if shader is None:
        return None
    textures_by_hash: dict[str, str] = {}
    vectors_by_hash: dict[str, list[float]] = {}
    tex_n = 0
    vec_n = 0
    for hv, p in _shader_param_iter(shader) or []:
        if tex_n >= int(max_textures) and vec_n >= int(max_vectors):
            break
        try:
            dt = int(getattr(p, "DataType", 255))
        except Exception:
            dt = 255
        key = str(int(hv) & 0xFFFFFFFF)
        if dt == 0:
            if tex_n >= int(max_textures):
                continue
            try:
                tex = getattr(p, "Data", None)
                nm = str(getattr(tex, "Name", "")).strip()
            except Exception:
                nm = ""
            if nm:
                textures_by_hash[key] = nm
                tex_n += 1
        elif dt == 1:
            if vec_n >= int(max_vectors):
                continue
            v = None
            try:
                v = getattr(p, "Data", None)
            except Exception:
                v = None
            out = _vec4_to_list(v)
            if out:
                vectors_by_hash[key] = [float(out[0]), float(out[1]), float(out[2]), float(out[3])]
                vec_n += 1
    if not textures_by_hash and not vectors_by_hash:
        return None
    return {
        "texturesByHash": textures_by_hash,
        "vectorsByHash": vectors_by_hash,
    }


def _decode_texture_object_to_img_rgba(dll_manager: DllManager | None, tex_obj) -> tuple[np.ndarray | None, str | None]:
    """
    Decode a CodeWalker texture object into an RGBA uint8 image (H,W,4) + format_name.
    This is used as a fallback when a shader references a texture that isn't present in the
    currently loaded YTD dict returned by get_ytd_textures(...).
    """
    if tex_obj is None:
        return None, None

    # Best-effort format string
    fmt_obj = getattr(tex_obj, "Format", None)
    format_name = fmt_obj.ToString() if fmt_obj and hasattr(fmt_obj, "ToString") else (str(fmt_obj) if fmt_obj is not None else None)

    width = int(getattr(tex_obj, "Width", 0) or 0)
    height = int(getattr(tex_obj, "Height", 0) or 0)
    if width <= 0 or height <= 0:
        return None, format_name

    pixels = None
    # Prefer DDSIO if available (matches CodeWalker UI path).
    try:
        ddsio = getattr(dll_manager, "DDSIO", None) if dll_manager is not None else None
        if ddsio is not None and hasattr(ddsio, "GetPixels"):
            pixels = ddsio.GetPixels(tex_obj, 0)
    except Exception:
        pixels = None
    if not pixels:
        try:
            if hasattr(tex_obj, "GetPixels"):
                pixels = tex_obj.GetPixels(0)
        except Exception:
            pixels = None
    if not pixels:
        return None, format_name

    arr = np.frombuffer(bytes(pixels), dtype=np.uint8)

    img = None
    # packed RGBA
    if arr.size == width * height * 4:
        img = arr.reshape(height, width, 4)
    # packed RGB
    elif arr.size == width * height * 3:
        img = arr.reshape(height, width, 3)
    else:
        # Try stride interpretation
        stride = int(getattr(tex_obj, "Stride", 0) or 0)
        if stride > 0 and (arr.size == stride * height):
            if (stride % 4) == 0:
                row_px = stride // 4
                if row_px >= width:
                    img = arr.reshape(height, row_px, 4)[:, :width, :]
            elif (stride % 3) == 0:
                row_px = stride // 3
                if row_px >= width:
                    img = arr.reshape(height, row_px, 3)[:, :width, :]
        if img is None and height > 0 and (arr.size % height) == 0:
            row_stride = arr.size // height
            if (row_stride % 4) == 0:
                row_px = row_stride // 4
                if row_px >= width:
                    img = arr.reshape(height, row_px, 4)[:, :width, :]
            elif (row_stride % 3) == 0:
                row_px = row_stride // 3
                if row_px >= width:
                    img = arr.reshape(height, row_px, 3)[:, :width, :]

    if img is None:
        return None, format_name

    # DDSIO output is typically BGRA; convert to RGBA.
    try:
        if img.shape[2] == 4:
            img = img[:, :, [2, 1, 0, 3]]
        elif img.shape[2] == 3:
            img = img[:, :, [2, 1, 0]]
    except Exception:
        pass

    # Ensure RGBA
    if img.shape[2] == 3:
        img = np.concatenate([img, 255 * np.ones((img.shape[0], img.shape[1], 1), dtype=np.uint8)], axis=2)

    return img.astype(np.uint8), format_name


def _export_texture_png(
    textures: dict,
    tex_name: str,
    tex_dir: Path,
    *,
    td_hash: int | None = None,
    shader_tex_obj=None,
    dll_manager: DllManager | None = None,
) -> tuple[str | None, bool]:
    """
    Write a texture to assets/models_textures and return (relativePath, wroteNewFile).
    """
    if not tex_name or not isinstance(textures, dict):
        return None, False

    # Prefer already-decoded textures (from YTD dict).
    img, fmt = textures.get(tex_name, (None, None)) if tex_name in textures else (None, None)

    # Fallback: decode directly from the shader's texture object (covers cross-dict references).
    if img is None and shader_tex_obj is not None:
        img2, fmt2 = _decode_texture_object_to_img_rgba(dll_manager, shader_tex_obj)
        if img2 is not None:
            img = img2
            fmt = fmt2
            textures[tex_name] = (img, fmt)  # cache for later format queries

    if img is None:
        return None, False
    try:
        tex_dir.mkdir(parents=True, exist_ok=True)
        h = joaat(tex_name)
        slug = _slugify_texture_name(tex_name)
        if not slug:
            slug = _safe_tex_name(tex_name).lower()  # last-ditch, stable token

        # Historically some pipelines used hash+slug filenames. The viewer hot path prefers hash-only.
        # We therefore:
        # - write the slugged file (for debugging / human readability)
        # - ensure the hash-only alias exists
        # - return the hash-only relative path so manifests don't depend on slug presence
        h_u32 = int(h) & 0xFFFFFFFF
        out_slug = tex_dir / f"{h_u32}_{slug}.png"
        out_hash = tex_dir / f"{h_u32}.png"

        wrote = False
        if not out_slug.exists():
            Image.fromarray(img, mode="RGBA").save(out_slug)
            wrote = True

        # Ensure the hash-only alias exists (prefer hardlink to avoid duplicated disk usage).
        if not out_hash.exists():
            try:
                import os
                os.link(out_slug, out_hash)
            except Exception:
                try:
                    shutil.copy2(out_slug, out_hash)
                except Exception:
                    # If we can't create the alias, still return the slug path as a fallback.
                    return f"models_textures/{h_u32}_{slug}.png", wrote

        return f"models_textures/{h_u32}.png", wrote
    except Exception:
        return None, False


def _which(exe: str) -> str | None:
    try:
        return shutil.which(exe)
    except Exception:
        return None


def _try_export_texture_ktx2_from_png(
    png_rel: str,
    tex_dir: Path,
    ktx2_dir: Path,
    *,
    toktx_exe: str = "toktx",
    srgb: bool = False,
) -> str | None:
    """
    Best-effort: convert an already-exported PNG under tex_dir into a KTX2 file under ktx2_dir.
    Requires external `toktx` (KTX-Software). If missing or conversion fails, returns None.

    NOTE: Viewer-side KTX2 support currently only handles *uncompressed RGBA8* KTX2 (no supercompression/Basis).
    This chooses vkFormat RGBA8 UNORM/SRGB accordingly.
    """
    try:
        if not png_rel or not isinstance(png_rel, str):
            return None
        if not png_rel.startswith("models_textures/") or not png_rel.endswith(".png"):
            return None
        exe = _which(toktx_exe) or (toktx_exe if os.path.exists(toktx_exe) else None)
        if not exe:
            return None

        in_png = tex_dir.parent / png_rel  # assets_dir / models_textures/...
        if not in_png.exists():
            return None

        ktx2_dir.mkdir(parents=True, exist_ok=True)
        out_name = Path(png_rel).name.replace(".png", ".ktx2")
        out_path = ktx2_dir / out_name
        if out_path.exists():
            return f"{ktx2_dir.name}/{out_name}"

        # Default to producing a simple, widely-loadable KTX2 (no Basis/UASTC) for now:
        # - use explicit RGBA8 UNORM/SRGB vkFormat
        # - avoid supercompression
        fmt = "R8G8B8A8_SRGB" if srgb else "R8G8B8A8_UNORM"

        cmd = [
            exe,
            "--t2",
            "--format",
            fmt,
            "--encode",
            "none",
            str(out_path),
            str(in_png),
        ]
        try:
            cp = subprocess.run(cmd, capture_output=True, text=True)
        except Exception:
            return None
        if cp.returncode != 0:
            return None
        if not out_path.exists():
            return None
        return f"{ktx2_dir.name}/{out_name}"
    except Exception:
        return None


def _ensure_submesh_material(entry: dict, lod_key: str, si: int) -> dict | None:
    """
    Ensure entry['lods'][lod_key]['submeshes'][si]['material'] exists and return it.
    Returns None if structure doesn't exist / index out of range.
    """
    try:
        lods = entry.get("lods") or {}
        lod_meta = lods.get(lod_key) or {}
        subs = lod_meta.get("submeshes") or []
        if not isinstance(subs, list):
            return None
        if si < 0 or si >= len(subs):
            return None
        sm = subs[si]
        if not isinstance(sm, dict):
            return None
        if "material" not in sm or not isinstance(sm.get("material"), dict):
            sm["material"] = {}
        return sm["material"]
    except Exception:
        return None


def _update_existing_manifest_materials_for_drawable(
    entry: dict,
    drawable,
    textures: dict | None,
    td_hash: int | None,
    tex_dir: Path,
    *,
    dll_manager: DllManager | None = None,
    export_ktx2: bool = False,
    ktx2_dir: Path | None = None,
    toktx_exe: str = "toktx",
) -> int:
    """
    Texture-only/material-only update pass:
    - Does NOT write mesh bins.
    - Updates per-submesh material dicts in the manifest (uv0ScaleOffset, diffuse/normal/spec, scalars).
    Returns textures_exported_now increment.
    """
    if not isinstance(entry, dict) or drawable is None:
        return 0
    if not textures or not isinstance(textures, dict) or not td_hash:
        return 0

    wrote = 0
    for lod in ("High", "Med", "Low", "VLow"):
        lod_key = lod.lower()
        # Only touch LODs that already exist in the manifest (keeps this fast/safe).
        try:
            if not (isinstance(entry.get("lods"), dict) and lod_key in (entry.get("lods") or {})):
                continue
        except Exception:
            continue

        subs = _extract_drawable_lod_submeshes(drawable, lod)
        if not subs:
            continue

        # Update existing manifest submeshes by index.
        for si, sub in enumerate(subs):
            shader = sub.get("shader")
            mat = _ensure_submesh_material(entry, lod_key, si)
            if mat is None:
                break

            # Collect shader-referenced texture objects by (lowercased) name.
            # This allows exporting textures that aren't present in the current YTD dict.
            shader_tex_objs = {}
            try:
                for _hv, p in _shader_param_iter(shader) or []:
                    try:
                        if int(getattr(p, "DataType", 255)) != 0:
                            continue
                        tex_obj = getattr(p, "Data", None)
                        nm = str(getattr(tex_obj, "Name", "")).strip() if tex_obj is not None else ""
                        if nm:
                            shader_tex_objs[nm.lower()] = tex_obj
                    except Exception:
                        continue
            except Exception:
                shader_tex_objs = {}

            # Coarse flags from shader name (alpha mode, double sided).
            try:
                mat.update(_material_flags_from_shader(shader))
            except Exception:
                pass

            # Export compact raw shader params for future shader-family support.
            # Keep this small to avoid exploding manifest sizes.
            try:
                sp = _extract_shader_params(shader, max_textures=24, max_vectors=48)
                if sp:
                    mat["shaderParams"] = sp
            except Exception:
                pass

            # UV scale/offset
            uvso = _extract_uv0_scale_offset_from_shader(shader)
            if uvso and len(uvso) >= 4:
                mat["uv0ScaleOffset"] = [float(uvso[0]), float(uvso[1]), float(uvso[2]), float(uvso[3])]

            # Global UV animation affine transform (CodeWalker BasicVS GlobalUVAnim):
            #   uvw = float3(uv, 1)
            #   u = dot(globalAnimUV0.xyz, uvw)
            #   v = dot(globalAnimUV1.xyz, uvw)
            g0 = _extract_vec4_from_shader(shader, _SP_GLOBAL_ANIM_UV0)
            g1 = _extract_vec4_from_shader(shader, _SP_GLOBAL_ANIM_UV1)
            if g0 and len(g0) >= 3:
                mat["globalAnimUV0"] = [float(g0[0]), float(g0[1]), float(g0[2])]
            if g1 and len(g1) >= 3:
                mat["globalAnimUV1"] = [float(g1[0]), float(g1[1]), float(g1[2])]

            # Scalars
            bumpiness = _extract_scalar_x_from_shader(shader, [_SP_BUMPINESS])
            if bumpiness is not None:
                mat["bumpiness"] = float(bumpiness)
            spec_int = _extract_scalar_x_from_shader(shader, _SP_SPEC_INTENSITY_PREFERRED)
            if spec_int is not None:
                mat["specularIntensity"] = float(spec_int)
            spec_pow = _extract_scalar_x_from_shader(shader, _SP_SPEC_POWER_PREFERRED)
            if spec_pow is not None:
                mat["specularPower"] = float(spec_pow)
            # Alpha params (used by cutout/blend-ish shaders)
            a_scale = _extract_scalar_x_from_shader(shader, [_SP_ALPHA_SCALE])
            if a_scale is not None:
                mat["alphaScale"] = float(a_scale)
            a_cut = _extract_scalar_x_from_shader(shader, [_SP_ALPHA_TEST_VALUE])
            if a_cut is not None:
                mat["alphaCutoff"] = float(a_cut)
            hab = _extract_scalar_x_from_shader(shader, [_SP_HARD_ALPHA_BLEND])
            if hab is not None:
                mat["hardAlphaBlend"] = float(hab)

            # Spec map channel weighting (specMapIntMask)
            v4 = _extract_vec4_from_shader(shader, _SP_SPEC_MAP_INT_MASK)
            if v4 and len(v4) >= 3:
                mat["specMaskWeights"] = [float(v4[0]), float(v4[1]), float(v4[2])]

            # Diffuse
            pick_d, pick_d_hv = _pick_diffuse_texture_name_from_shader_with_hash(textures, shader)
            if pick_d:
                rel_d, wrote_d = _export_texture_png(
                    textures,
                    pick_d,
                    tex_dir,
                    td_hash=td_hash,
                    shader_tex_obj=shader_tex_objs.get(str(pick_d).lower()),
                    dll_manager=dll_manager,
                )
                if wrote_d:
                    wrote += 1
                if rel_d:
                    mat["diffuse"] = rel_d
                    mat["diffuseName"] = str(pick_d)
                    if pick_d_hv is not None:
                        mat["diffuseParamHash"] = int(pick_d_hv) & 0xFFFFFFFF
                    if export_ktx2 and ktx2_dir:
                        rel_k2 = _try_export_texture_ktx2_from_png(rel_d, tex_dir, ktx2_dir, toktx_exe=toktx_exe, srgb=True)
                        if rel_k2:
                            mat["diffuseKtx2"] = rel_k2

            # Diffuse2 (layer blend) - BasicPS uses Colourmap2 sampled on Texcoord1 and blended by its alpha.
            pick_d2, pick_d2_hv = _pick_texture_name_from_shader_with_hash(textures, shader, [_SP_DIFFUSE2], require_keywords=None)
            if not pick_d2:
                pick_d2 = _pick_texture_by_keywords(textures, include_keywords=("diffuse2", "diffusetex2", "diffusetexture2", "_d2", "_2"))
            if pick_d2:
                rel_d2, wrote_d2 = _export_texture_png(
                    textures,
                    pick_d2,
                    tex_dir,
                    td_hash=td_hash,
                    shader_tex_obj=shader_tex_objs.get(str(pick_d2).lower()),
                    dll_manager=dll_manager,
                )
                if wrote_d2:
                    wrote += 1
                if rel_d2:
                    mat["diffuse2"] = rel_d2
                    mat["diffuse2Name"] = str(pick_d2)
                    mat["diffuse2Uv"] = "uv1"
                    if pick_d2_hv is not None:
                        mat["diffuse2ParamHash"] = int(pick_d2_hv) & 0xFFFFFFFF
                    if export_ktx2 and ktx2_dir:
                        rel_k2 = _try_export_texture_ktx2_from_png(rel_d2, tex_dir, ktx2_dir, toktx_exe=toktx_exe, srgb=True)
                        if rel_k2:
                            mat["diffuse2Ktx2"] = rel_k2

            # Normal
            pick_n, pick_n_hv = _pick_texture_name_from_shader_with_hash(textures, shader, _SP_NORMAL_PREFERRED, require_keywords=("normal", "bump", "_n", "nrm", "nm_"))
            if not pick_n:
                pick_n, pick_n_hv = _pick_texture_name_from_shader_with_hash(textures, shader, _SP_NORMAL_PREFERRED, require_keywords=None)
            if not pick_n:
                pick_n = _pick_texture_by_keywords(textures, include_keywords=("_n", "normal", "nrm", "nm_", "bump"))
                pick_n_hv = None
            if pick_n:
                rel_n, wrote_n = _export_texture_png(
                    textures,
                    pick_n,
                    tex_dir,
                    td_hash=td_hash,
                    shader_tex_obj=shader_tex_objs.get(str(pick_n).lower()),
                    dll_manager=dll_manager,
                )
                if wrote_n:
                    wrote += 1
                if rel_n:
                    mat["normal"] = rel_n
                    mat["normalName"] = str(pick_n)
                    if pick_n_hv is not None:
                        mat["normalParamHash"] = int(pick_n_hv) & 0xFFFFFFFF
                    # Emit normal decode flags from CodeWalker texture format (ground truth).
                    fmt = _format_name_for_texture(textures, pick_n)
                    if fmt:
                        mat["normalFormat"] = str(fmt)
                    mat.update(_normal_decode_flags_from_codewalker_format(pick_n, fmt))
                    if export_ktx2 and ktx2_dir:
                        rel_k2 = _try_export_texture_ktx2_from_png(rel_n, tex_dir, ktx2_dir, toktx_exe=toktx_exe, srgb=False)
                        if rel_k2:
                            mat["normalKtx2"] = rel_k2

            # Detail map (commonly a detail normal) + detailSettings
            pick_det, pick_det_hv = _pick_texture_name_from_shader_with_hash(textures, shader, [_SP_DETAIL_MAP_SAMPLER, _SP_DETAIL_SAMPLER], require_keywords=("detail",))
            if not pick_det:
                pick_det, pick_det_hv = _pick_texture_name_from_shader_with_hash(textures, shader, [_SP_DETAIL_MAP_SAMPLER, _SP_DETAIL_SAMPLER], require_keywords=None)
            if not pick_det:
                pick_det = _pick_texture_by_keywords(textures, include_keywords=("detail",))
                pick_det_hv = None
            if pick_det:
                rel_det, wrote_det = _export_texture_png(
                    textures,
                    pick_det,
                    tex_dir,
                    td_hash=td_hash,
                    shader_tex_obj=shader_tex_objs.get(str(pick_det).lower()),
                    dll_manager=dll_manager,
                )
                if wrote_det:
                    wrote += 1
                if rel_det:
                    mat["detail"] = rel_det
                    mat["detailName"] = str(pick_det)
                    if pick_det_hv is not None:
                        mat["detailParamHash"] = int(pick_det_hv) & 0xFFFFFFFF
                    if export_ktx2 and ktx2_dir:
                        rel_k2 = _try_export_texture_ktx2_from_png(rel_det, tex_dir, ktx2_dir, toktx_exe=toktx_exe, srgb=False)
                        if rel_k2:
                            mat["detailKtx2"] = rel_k2
                    # detailSettings is a vec4 in BasicPS; z,w are UV scale, y is intensity.
                    ds = _extract_vec4_from_shader(shader, _SP_DETAIL_SETTINGS)
                    if ds and len(ds) >= 4:
                        mat["detailSettings"] = [float(ds[0]), float(ds[1]), float(ds[2]), float(ds[3])]

            # AO / occlusion (common across many GTA shaders)
            pick_ao, pick_ao_hv = _pick_texture_name_from_shader_with_hash(textures, shader, [_SP_OCCLUSION_SAMPLER], require_keywords=("ao", "occl"))
            if not pick_ao:
                pick_ao, pick_ao_hv = _pick_texture_name_from_shader_with_hash(textures, shader, [_SP_OCCLUSION_SAMPLER], require_keywords=None)
            if not pick_ao:
                pick_ao = _pick_texture_by_keywords(textures, include_keywords=("ao", "occl", "occ"))
                pick_ao_hv = None
            if pick_ao:
                rel_ao, wrote_ao = _export_texture_png(
                    textures,
                    pick_ao,
                    tex_dir,
                    td_hash=td_hash,
                    shader_tex_obj=shader_tex_objs.get(str(pick_ao).lower()),
                    dll_manager=dll_manager,
                )
                if wrote_ao:
                    wrote += 1
                if rel_ao:
                    mat["ao"] = rel_ao
                    mat["aoName"] = str(pick_ao)
                    if pick_ao_hv is not None:
                        mat["aoParamHash"] = int(pick_ao_hv) & 0xFFFFFFFF
                    if export_ktx2 and ktx2_dir:
                        rel_k2 = _try_export_texture_ktx2_from_png(rel_ao, tex_dir, ktx2_dir, toktx_exe=toktx_exe, srgb=False)
                        if rel_k2:
                            mat["aoKtx2"] = rel_k2
                    if "aoStrength" not in mat:
                        mat["aoStrength"] = 1.0

            # Spec
            pick_s, pick_s_hv = _pick_texture_name_from_shader_with_hash(textures, shader, _SP_SPEC_PREFERRED, require_keywords=("spec", "srm"))
            if not pick_s:
                pick_s, pick_s_hv = _pick_texture_name_from_shader_with_hash(textures, shader, _SP_SPEC_PREFERRED, require_keywords=None)
            if not pick_s:
                pick_s = _pick_texture_by_keywords(textures, include_keywords=("spec", "srm"))
                pick_s_hv = None
            if pick_s:
                rel_s, wrote_s = _export_texture_png(
                    textures,
                    pick_s,
                    tex_dir,
                    td_hash=td_hash,
                    shader_tex_obj=shader_tex_objs.get(str(pick_s).lower()),
                    dll_manager=dll_manager,
                )
                if wrote_s:
                    wrote += 1
                if rel_s:
                    mat["spec"] = rel_s
                    mat["specName"] = str(pick_s)
                    if pick_s_hv is not None:
                        mat["specParamHash"] = int(pick_s_hv) & 0xFFFFFFFF
                    if export_ktx2 and ktx2_dir:
                        rel_k2 = _try_export_texture_ktx2_from_png(rel_s, tex_dir, ktx2_dir, toktx_exe=toktx_exe, srgb=False)
                        if rel_k2:
                            mat["specKtx2"] = rel_k2

            # Emissive (best-effort by keyword; many GTA assets use glow/illum/em textures)
            pick_e = _pick_texture_name_from_shader(
                textures,
                shader,
                preferred_hashes=[],
                require_keywords=("emiss", "glow", "illum", "light", "_em", "_l"),
            )
            if not pick_e:
                pick_e = _pick_texture_by_keywords(textures, include_keywords=("emiss", "glow", "illum", "_em", "light"))
            if pick_e:
                rel_e, wrote_e = _export_texture_png(
                    textures,
                    pick_e,
                    tex_dir,
                    td_hash=td_hash,
                    shader_tex_obj=shader_tex_objs.get(str(pick_e).lower()),
                    dll_manager=dll_manager,
                )
                if wrote_e:
                    wrote += 1
                if rel_e:
                    mat["emissive"] = rel_e
                    mat["emissiveName"] = str(pick_e)
                    if export_ktx2 and ktx2_dir:
                        rel_k2 = _try_export_texture_ktx2_from_png(rel_e, tex_dir, ktx2_dir, toktx_exe=toktx_exe, srgb=True)
                        if rel_k2:
                            mat["emissiveKtx2"] = rel_k2
                    # Viewer default; can be overridden later if we discover a scalar param for it.
                    if "emissiveIntensity" not in mat:
                        mat["emissiveIntensity"] = 1.0

            # Decal-ish alpha mask (best-effort; only attempt when shader family looks like decal)
            try:
                if str(mat.get("shaderFamily") or "").lower() == "decal":
                    pick_am = _pick_texture_by_keywords(
                        textures,
                        include_keywords=("alphamask", "alpha_mask", "opacity", "mask"),
                        exclude_keywords=("normal", "spec", "srm", "ao", "occl"),
                    )
                    if pick_am:
                        rel_am, wrote_am = _export_texture_png(
                            textures,
                            pick_am,
                            tex_dir,
                            td_hash=td_hash,
                            shader_tex_obj=shader_tex_objs.get(str(pick_am).lower()),
                            dll_manager=dll_manager,
                        )
                        if wrote_am:
                            wrote += 1
                        if rel_am:
                            mat["alphaMask"] = rel_am
                            mat["alphaMaskName"] = str(pick_am)
                            if export_ktx2 and ktx2_dir:
                                rel_k2 = _try_export_texture_ktx2_from_png(rel_am, tex_dir, ktx2_dir, toktx_exe=toktx_exe, srgb=False)
                                if rel_k2:
                                    mat["alphaMaskKtx2"] = rel_k2
                            # Viewer defaults; can be overridden later.
                            mat.setdefault("decalDepthBias", 1.0)
                            mat.setdefault("decalSlopeScale", 1.0)
                            mat.setdefault("decalBlendMode", "normal")
            except Exception:
                pass

    return wrote


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
        res = _extract_geometry_positions_indices_uv0_uv1_color0(g)
        if res is None:
            continue
        pos, idx, uv0, uv1, uv2, col0, col1 = res
        if pos.size == 0 or idx.size == 0:
            continue
        nrm = _compute_vertex_normals(pos, idx)
        out.append(
            {
                "positions": pos,
                "indices": idx,
                "normals": nrm,
                "uv0": uv0,
                "uv1": uv1,
                "uv2": uv2,
                "color0": col0,
                "color1": col1,
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
    ap.add_argument(
        "--export-textures",
        action="store_true",
        help=(
            "Export model textures referenced by shaders into assets/models_textures/. "
            "Writes both <hash>_<slug>.png (debug) and <hash>.png (runtime hot path), "
            "and stores manifest paths as models_textures/<hash>.png."
        ),
    )
    ap.add_argument("--export-ktx2", action="store_true", help="Also write .ktx2 copies for exported textures (requires toktx; writes *Ktx2 fields in materials)")
    ap.add_argument("--toktx", default="toktx", help="Path to toktx executable (KTX-Software). Used when --export-ktx2 is set.")
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

    if not dm.init_game_file_cache():
        raise SystemExit("Failed to init GameFileCache (required for drawables)")

    gfc = dm.get_game_file_cache()
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
                # Always bump schema version forward (viewer supports both, but exporter features rely on v4).
                try:
                    v = int(manifest.get("version") or 0)
                except Exception:
                    v = 0
                manifest["version"] = max(4, v)
        except Exception:
            pass
    already = set((manifest.get("meshes") or {}).keys())

    # Optional texture exporting
    tex_dir = assets_dir / "models_textures"
    ktx2_dir = assets_dir / "models_textures_ktx2"
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
        have_diffuse_already = bool(isinstance(existing_entry, dict) and isinstance(existing_entry.get("material"), dict) and existing_entry["material"].get("diffuse"))

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
                    td_hash = int(getattr(tdh, "Hash", int(tdh))) & 0xFFFFFFFF
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
                        col0 = sub.get("color0")
                        uv1 = sub.get("uv1")
                        uv2 = sub.get("uv2")
                        col1 = sub.get("color1")
                        shader = sub.get("shader")

                        uvs = uv0 if (uv0 is not None and getattr(uv0, "size", 0)) else _compute_planar_uvs_xy01(positions)
                        uvs1 = uv1 if (uv1 is not None and getattr(uv1, "size", 0)) else uvs
                        uvs2 = uv2 if (uv2 is not None and getattr(uv2, "size", 0)) else uvs

                        out_bin = models_dir / f"{h}_{lod_key}_{si}.bin"
                        tangents = None
                        try:
                            tangents = _compute_vertex_tangents(positions, uvs, indices, normals)
                        except Exception:
                            tangents = None
                        _write_mesh_bin(out_bin, positions, indices, normals, uvs, tangents, color0=col0, uvs1=uvs1, uvs2=uvs2, color1=col1)

                        mat = {}
                        # Coarse flags from shader name (alpha mode, double sided).
                        try:
                            mat.update(_material_flags_from_shader(shader))
                        except Exception:
                            pass

                        # Export compact raw shader params for future shader-family support.
                        try:
                            sp = _extract_shader_params(shader, max_textures=24, max_vectors=48)
                            if sp:
                                mat["shaderParams"] = sp
                        except Exception:
                            pass
                        # UV scale/offset per submesh (shader param).
                        uvso = _extract_uv0_scale_offset_from_shader(shader)
                        if uvso and len(uvso) >= 4:
                            mat["uv0ScaleOffset"] = [float(uvso[0]), float(uvso[1]), float(uvso[2]), float(uvso[3])]

                        g0 = _extract_vec4_from_shader(shader, _SP_GLOBAL_ANIM_UV0)
                        g1 = _extract_vec4_from_shader(shader, _SP_GLOBAL_ANIM_UV1)
                        if g0 and len(g0) >= 3:
                            mat["globalAnimUV0"] = [float(g0[0]), float(g0[1]), float(g0[2])]
                        if g1 and len(g1) >= 3:
                            mat["globalAnimUV1"] = [float(g1[0]), float(g1[1]), float(g1[2])]

                        # Scalar params (best-effort).
                        bumpiness = _extract_scalar_x_from_shader(shader, [_SP_BUMPINESS])
                        if bumpiness is not None:
                            mat["bumpiness"] = float(bumpiness)
                        spec_int = _extract_scalar_x_from_shader(shader, _SP_SPEC_INTENSITY_PREFERRED)
                        if spec_int is not None:
                            mat["specularIntensity"] = float(spec_int)
                        spec_pow = _extract_scalar_x_from_shader(shader, _SP_SPEC_POWER_PREFERRED)
                        if spec_pow is not None:
                            mat["specularPower"] = float(spec_pow)
                        a_scale = _extract_scalar_x_from_shader(shader, [_SP_ALPHA_SCALE])
                        if a_scale is not None:
                            mat["alphaScale"] = float(a_scale)
                        a_cut = _extract_scalar_x_from_shader(shader, [_SP_ALPHA_TEST_VALUE])
                        if a_cut is not None:
                            mat["alphaCutoff"] = float(a_cut)
                        hab = _extract_scalar_x_from_shader(shader, [_SP_HARD_ALPHA_BLEND])
                        if hab is not None:
                            mat["hardAlphaBlend"] = float(hab)
                        v4 = _extract_vec4_from_shader(shader, _SP_SPEC_MAP_INT_MASK)
                        if v4 and len(v4) >= 3:
                            mat["specMaskWeights"] = [float(v4[0]), float(v4[1]), float(v4[2])]

                        # Textures per submesh.
                        if textures and isinstance(textures, dict) and td_hash:
                            # Collect shader-referenced texture objects by (lowercased) name.
                            # This allows exporting textures that aren't present in the current YTD dict
                            # returned by get_ytd_textures(...).
                            shader_tex_objs = {}
                            try:
                                for _hv, p in _shader_param_iter(shader) or []:
                                    try:
                                        if int(getattr(p, "DataType", 255)) != 0:
                                            continue
                                        tex_obj = getattr(p, "Data", None)
                                        nm = str(getattr(tex_obj, "Name", "")).strip() if tex_obj is not None else ""
                                        if nm:
                                            shader_tex_objs[nm.lower()] = tex_obj
                                    except Exception:
                                        continue
                            except Exception:
                                shader_tex_objs = {}

                            # Diffuse
                            pick_d, pick_d_hv = _pick_diffuse_texture_name_from_shader_with_hash(textures, shader)
                            rel_d, wrote_d = _export_texture_png(
                                textures,
                                pick_d,
                                tex_dir,
                                td_hash=td_hash,
                                shader_tex_obj=shader_tex_objs.get(str(pick_d).lower()) if pick_d else None,
                                dll_manager=dm,
                            ) if pick_d else (None, False)
                            if wrote_d:
                                textures_exported_now += 1
                            if rel_d:
                                mat["diffuse"] = rel_d
                                mat["diffuseName"] = str(pick_d)
                                if pick_d_hv is not None:
                                    mat["diffuseParamHash"] = int(pick_d_hv) & 0xFFFFFFFF

                            # Diffuse2
                            pick_d2, pick_d2_hv = _pick_texture_name_from_shader_with_hash(textures, shader, [_SP_DIFFUSE2], require_keywords=None)
                            if not pick_d2:
                                pick_d2 = _pick_texture_by_keywords(textures, include_keywords=("diffuse2", "diffusetex2", "diffusetexture2", "_d2", "_2"))
                                pick_d2_hv = None
                            rel_d2, wrote_d2 = _export_texture_png(
                                textures,
                                pick_d2,
                                tex_dir,
                                td_hash=td_hash,
                                shader_tex_obj=shader_tex_objs.get(str(pick_d2).lower()) if pick_d2 else None,
                                dll_manager=dm,
                            ) if pick_d2 else (None, False)
                            if wrote_d2:
                                textures_exported_now += 1
                            if rel_d2:
                                mat["diffuse2"] = rel_d2
                                mat["diffuse2Name"] = str(pick_d2)
                                mat["diffuse2Uv"] = "uv1"
                                if pick_d2_hv is not None:
                                    mat["diffuse2ParamHash"] = int(pick_d2_hv) & 0xFFFFFFFF

                            # Normal
                            pick_n, pick_n_hv = _pick_texture_name_from_shader_with_hash(textures, shader, _SP_NORMAL_PREFERRED, require_keywords=("normal", "bump", "_n", "nrm", "nm_"))
                            if not pick_n:
                                pick_n, pick_n_hv = _pick_texture_name_from_shader_with_hash(textures, shader, _SP_NORMAL_PREFERRED, require_keywords=None)
                            if not pick_n:
                                pick_n = _pick_texture_by_keywords(textures, include_keywords=("_n", "normal", "nrm", "nm_", "bump"))
                                pick_n_hv = None
                            rel_n, wrote_n = _export_texture_png(
                                textures,
                                pick_n,
                                tex_dir,
                                td_hash=td_hash,
                                shader_tex_obj=shader_tex_objs.get(str(pick_n).lower()) if pick_n else None,
                                dll_manager=dm,
                            ) if pick_n else (None, False)
                            if wrote_n:
                                textures_exported_now += 1
                            if rel_n:
                                mat["normal"] = rel_n
                                mat["normalName"] = str(pick_n)
                                if pick_n_hv is not None:
                                    mat["normalParamHash"] = int(pick_n_hv) & 0xFFFFFFFF
                                fmt = _format_name_for_texture(textures, pick_n)
                                if fmt:
                                    mat["normalFormat"] = str(fmt)
                                mat.update(_normal_decode_flags_from_codewalker_format(pick_n, fmt))

                            # Detail
                            pick_det, pick_det_hv = _pick_texture_name_from_shader_with_hash(textures, shader, [_SP_DETAIL_MAP_SAMPLER, _SP_DETAIL_SAMPLER], require_keywords=("detail",))
                            if not pick_det:
                                pick_det, pick_det_hv = _pick_texture_name_from_shader_with_hash(textures, shader, [_SP_DETAIL_MAP_SAMPLER, _SP_DETAIL_SAMPLER], require_keywords=None)
                            if not pick_det:
                                pick_det = _pick_texture_by_keywords(textures, include_keywords=("detail",))
                                pick_det_hv = None
                            rel_det, wrote_det = _export_texture_png(
                                textures,
                                pick_det,
                                tex_dir,
                                td_hash=td_hash,
                                shader_tex_obj=shader_tex_objs.get(str(pick_det).lower()) if pick_det else None,
                                dll_manager=dm,
                            ) if pick_det else (None, False)
                            if wrote_det:
                                textures_exported_now += 1
                            if rel_det:
                                mat["detail"] = rel_det
                                mat["detailName"] = str(pick_det)
                                if pick_det_hv is not None:
                                    mat["detailParamHash"] = int(pick_det_hv) & 0xFFFFFFFF
                                ds = _extract_vec4_from_shader(shader, _SP_DETAIL_SETTINGS)
                                if ds and len(ds) >= 4:
                                    mat["detailSettings"] = [float(ds[0]), float(ds[1]), float(ds[2]), float(ds[3])]

                            # AO / occlusion
                            pick_ao, pick_ao_hv = _pick_texture_name_from_shader_with_hash(textures, shader, [_SP_OCCLUSION_SAMPLER], require_keywords=("ao", "occl"))
                            if not pick_ao:
                                pick_ao, pick_ao_hv = _pick_texture_name_from_shader_with_hash(textures, shader, [_SP_OCCLUSION_SAMPLER], require_keywords=None)
                            if not pick_ao:
                                pick_ao = _pick_texture_by_keywords(textures, include_keywords=("ao", "occl", "occ"))
                                pick_ao_hv = None
                            rel_ao, wrote_ao = _export_texture_png(
                                textures,
                                pick_ao,
                                tex_dir,
                                td_hash=td_hash,
                                shader_tex_obj=shader_tex_objs.get(str(pick_ao).lower()) if pick_ao else None,
                                dll_manager=dm,
                            ) if pick_ao else (None, False)
                            if wrote_ao:
                                textures_exported_now += 1
                            if rel_ao:
                                mat["ao"] = rel_ao
                                mat["aoName"] = str(pick_ao)
                                if pick_ao_hv is not None:
                                    mat["aoParamHash"] = int(pick_ao_hv) & 0xFFFFFFFF
                                if "aoStrength" not in mat:
                                    mat["aoStrength"] = 1.0

                            # Spec
                            pick_s, pick_s_hv = _pick_texture_name_from_shader_with_hash(textures, shader, _SP_SPEC_PREFERRED, require_keywords=("spec", "srm"))
                            if not pick_s:
                                pick_s, pick_s_hv = _pick_texture_name_from_shader_with_hash(textures, shader, _SP_SPEC_PREFERRED, require_keywords=None)
                            if not pick_s:
                                pick_s = _pick_texture_by_keywords(textures, include_keywords=("spec", "srm"))
                                pick_s_hv = None
                            rel_s, wrote_s = _export_texture_png(
                                textures,
                                pick_s,
                                tex_dir,
                                td_hash=td_hash,
                                shader_tex_obj=shader_tex_objs.get(str(pick_s).lower()) if pick_s else None,
                                dll_manager=dm,
                            ) if pick_s else (None, False)
                            if wrote_s:
                                textures_exported_now += 1
                            if rel_s:
                                mat["spec"] = rel_s
                                mat["specName"] = str(pick_s)
                                if pick_s_hv is not None:
                                    mat["specParamHash"] = int(pick_s_hv) & 0xFFFFFFFF

                            # Emissive
                            pick_e = _pick_texture_name_from_shader(
                                textures,
                                shader,
                                preferred_hashes=[],
                                require_keywords=("emiss", "glow", "illum", "light", "_em", "_l"),
                            )
                            if not pick_e:
                                pick_e = _pick_texture_by_keywords(textures, include_keywords=("emiss", "glow", "illum", "_em", "light"))
                            rel_e, wrote_e = _export_texture_png(
                                textures,
                                pick_e,
                                tex_dir,
                                td_hash=td_hash,
                                shader_tex_obj=shader_tex_objs.get(str(pick_e).lower()) if pick_e else None,
                                dll_manager=dm,
                            ) if pick_e else (None, False)
                            if wrote_e:
                                textures_exported_now += 1
                            if rel_e:
                                mat["emissive"] = rel_e
                                mat["emissiveName"] = str(pick_e)
                                if "emissiveIntensity" not in mat:
                                    mat["emissiveIntensity"] = 1.0

                            # Decal-ish alpha mask (best-effort; only attempt when shader family looks like decal)
                            try:
                                if str(mat.get("shaderFamily") or "").lower() == "decal":
                                    pick_am = _pick_texture_by_keywords(
                                        textures,
                                        include_keywords=("alphamask", "alpha_mask", "opacity", "mask"),
                                        exclude_keywords=("normal", "spec", "srm", "ao", "occl"),
                                    )
                                    rel_am, wrote_am = _export_texture_png(
                                        textures,
                                        pick_am,
                                        tex_dir,
                                        td_hash=td_hash,
                                        shader_tex_obj=shader_tex_objs.get(str(pick_am).lower()) if pick_am else None,
                                        dll_manager=dm,
                                    ) if pick_am else (None, False)
                                    if wrote_am:
                                        textures_exported_now += 1
                                    if rel_am:
                                        mat["alphaMask"] = rel_am
                                        mat["alphaMaskName"] = str(pick_am)
                                        mat.setdefault("decalDepthBias", 1.0)
                                        mat.setdefault("decalSlopeScale", 1.0)
                                        mat.setdefault("decalBlendMode", "normal")
                            except Exception:
                                pass

                        sub_entries.append(
                            {
                                "file": f"{h}_{lod_key}_{si}.bin",
                                "vertexCount": int(positions.shape[0]),
                                "indexCount": int(indices.shape[0]),
                                "hasNormals": True,
                                "hasUvs": True,
                                "hasTangents": bool(tangents is not None),
                                "hasColor0": bool(col0 is not None),
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
            # Texture-only update (or other metadata update)
            if args.export_textures and textures and td_hash:
                try:
                    textures_exported_now += _update_existing_manifest_materials_for_drawable(
                        entry=entry,
                        drawable=drawable,
                        textures=textures,
                        td_hash=td_hash,
                        tex_dir=tex_dir,
                        export_ktx2=bool(args.export_ktx2),
                        ktx2_dir=ktx2_dir,
                        toktx_exe=str(args.toktx or "toktx"),
                    )
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



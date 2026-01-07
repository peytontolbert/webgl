#!/usr/bin/env python3
"""
Upgrade existing WebGLGTA mesh bins to include per-vertex tangents for normal mapping.

Why:
- You may already have tens of thousands of exported *.bin meshes (MSH0 v3).
- Re-exporting from GTA just to add tangents is expensive.
- Tangents can be computed purely from the exported position/normal/uv data.

This script:
- Scans assets/models/*.bin
- For each MSH0 bin with normals + uvs and version < 4, writes a v4 bin with tangents appended.

Usage:
  python webgl/upgrade_mesh_bins_tangents.py --assets-dir webgl/webgl_viewer/assets
"""

import argparse
import struct
from pathlib import Path

import numpy as np

from gta5_modules.script_paths import auto_assets_dir

MESH_MAGIC = b"MSH0"
FLAG_HAS_NORMALS = 1
FLAG_HAS_UVS = 2
FLAG_HAS_TANGENTS = 4


def _compute_vertex_tangents(positions: np.ndarray, uvs: np.ndarray, indices: np.ndarray, normals: np.ndarray) -> np.ndarray:
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

    n = normals
    t = tan1
    ndott = np.sum(n * t, axis=1, keepdims=True)
    t = t - n * ndott
    tl = np.linalg.norm(t, axis=1)
    tl_safe = np.where(tl > 0.0, tl, 1.0).astype(np.float32)
    t = (t / tl_safe[:, None]).astype(np.float32)

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

    c = np.cross(n, t)
    w = np.sum(c * tan2, axis=1)
    w = np.where(w < 0.0, -1.0, 1.0).astype(np.float32)

    out = np.zeros((vcount, 4), dtype=np.float32)
    out[:, 0:3] = t
    out[:, 3] = w
    return out


def _upgrade_one(path: Path) -> tuple[bool, str]:
    b = path.read_bytes()
    if len(b) < 20:
        return False, "truncated"
    magic = b[0:4]
    if magic != MESH_MAGIC:
        return False, "bad_magic"
    version, vcount, icount, flags = struct.unpack_from("<IIII", b, 4)
    if vcount <= 0 or icount <= 0:
        return False, "empty"

    has_normals = version >= 2 and (flags & FLAG_HAS_NORMALS) == FLAG_HAS_NORMALS
    has_uvs = version >= 3 and (flags & FLAG_HAS_UVS) == FLAG_HAS_UVS
    has_tangents = version >= 4 and (flags & FLAG_HAS_TANGENTS) == FLAG_HAS_TANGENTS
    if has_tangents and version >= 4:
        return False, "already_v4"
    if not (has_normals and has_uvs):
        return False, "missing_nrm_or_uv"

    header = 20
    pos_bytes = vcount * 3 * 4
    nrm_bytes = vcount * 3 * 4
    uv_bytes = vcount * 2 * 4
    # v3 layout: pos, nrm, uv, idx
    idx_off = header + pos_bytes + nrm_bytes + uv_bytes
    idx_bytes = icount * 4
    if idx_off + idx_bytes > len(b):
        return False, "truncated_payload"

    positions = np.frombuffer(b, dtype=np.float32, count=vcount * 3, offset=header).reshape((-1, 3)).copy()
    normals = np.frombuffer(b, dtype=np.float32, count=vcount * 3, offset=header + pos_bytes).reshape((-1, 3)).copy()
    uvs = np.frombuffer(b, dtype=np.float32, count=vcount * 2, offset=header + pos_bytes + nrm_bytes).reshape((-1, 2)).copy()
    indices = np.frombuffer(b, dtype=np.uint32, count=icount, offset=idx_off).copy()

    tangents = _compute_vertex_tangents(positions, uvs, indices, normals).astype(np.float32)

    new_flags = int(flags) | FLAG_HAS_TANGENTS
    out = bytearray()
    out += struct.pack("<4sIIII", MESH_MAGIC, 4, int(vcount), int(icount), int(new_flags))
    out += positions.astype(np.float32).tobytes(order="C")
    out += normals.astype(np.float32).tobytes(order="C")
    out += uvs.astype(np.float32).tobytes(order="C")
    out += tangents.astype(np.float32).tobytes(order="C")
    out += indices.astype(np.uint32).tobytes(order="C")

    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(out)
    tmp.replace(path)
    return True, "upgraded"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--assets-dir", default="", help="webgl_viewer/assets folder (auto if omitted)")
    ap.add_argument("--max", type=int, default=0, help="Limit number of bins processed (0 = all)")
    args = ap.parse_args()

    assets_dir = auto_assets_dir(args.assets_dir)

    models_dir = assets_dir / "models"
    if not models_dir.exists():
        raise SystemExit(f"Missing {models_dir}")

    bins = sorted(models_dir.glob("*.bin"))
    if args.max and int(args.max) > 0:
        bins = bins[: int(args.max)]

    upgraded = 0
    skipped = 0
    for i, p in enumerate(bins):
        try:
            did, reason = _upgrade_one(p)
            if did:
                upgraded += 1
            else:
                skipped += 1
        except Exception:
            skipped += 1

        if (i + 1) % 2000 == 0:
            print(f"[{i+1}/{len(bins)}] upgraded={upgraded} skipped={skipped}")

    print(f"Done. upgraded={upgraded} skipped={skipped} in {models_dir}")


if __name__ == "__main__":
    main()



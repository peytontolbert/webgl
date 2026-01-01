import shutil
import json
from pathlib import Path
import re
import struct
from typing import Optional

# Optional (best-effort) deps for generating a viewer blend mask from height/normal images.
try:
    import numpy as np  # type: ignore
except Exception:
    np = None
try:
    from PIL import Image  # type: ignore
except Exception:
    Image = None
import argparse
import time
from array import array

# CLI-tunable globals (defaults keep current behavior)
_SHOULD_BUILD_ENTITY_BINS = False
_MAX_BINS_CHUNKS = 0
_SHOULD_BUILD_ENTITY_INST_BINS = False
_MAX_INST_BINS_CHUNKS = 0
_SHOULD_BUILD_CHUNK_SHARD_INDEX = False
_MAX_CHUNK_SHARD_INDEX_CHUNKS = 0

def setup_assets():
    """Set up assets for the WebGL viewer"""
    viewer_dir = Path(__file__).parent.resolve()
    webgl_dir = viewer_dir.parent.resolve()
    output_dir = webgl_dir / 'output'

    # Create legacy assets directory (this is where all exporters/scripts expect to write).
    assets_dir = viewer_dir / 'assets'
    assets_dir.mkdir(parents=True, exist_ok=True)
    
    # Copy terrain.obj if it exists
    terrain_obj = output_dir / 'terrain.obj'
    if terrain_obj.exists():
        shutil.copy2(terrain_obj, assets_dir / 'terrain.obj')
        print("Copied terrain.obj")
    else:
        print("Warning: terrain.obj not found")
    
    # Copy terrain_info.json if it exists
    terrain_info = output_dir / 'terrain_info.json'
    if terrain_info.exists():
        # Patch the OUTPUT terrain_info.json too (not just the assets copy) so it doesn't stay at num_textures=0
        # when output/textures contains real exported PNGs.
        _patch_terrain_info_with_detected_textures(terrain_info, output_dir / 'textures')
        shutil.copy2(terrain_info, assets_dir / 'terrain_info.json')
        print("Copied terrain_info.json")
    else:
        print("Warning: terrain_info.json not found")
    
    # Copy heightmap.png if it exists
    # Prefer collision-derived heightmap if available (looks much more like “game ground”).
    heightmap_collision = output_dir / 'heightmap_collision.png'
    heightmap = output_dir / 'heightmap.png'
    if heightmap_collision.exists():
        shutil.copy2(heightmap_collision, assets_dir / 'heightmap.png')
        print("Copied heightmap_collision.png -> assets/heightmap.png")
    elif heightmap.exists():
        shutil.copy2(heightmap, assets_dir / 'heightmap.png')
        print("Copied heightmap.png")
    else:
        print("Warning: heightmap.png not found")

    # Copy normalmap/lod visualization if they exist (useful for viewer shading/debug)
    normalmap = output_dir / 'normalmap.png'
    if normalmap.exists():
        shutil.copy2(normalmap, assets_dir / 'normalmap.png')
        print("Copied normalmap.png")

    lod_levels = output_dir / 'lod_levels.png'
    if lod_levels.exists():
        shutil.copy2(lod_levels, assets_dir / 'lod_levels.png')
        print("Copied lod_levels.png")

    # Optional: copy entities/buildings outputs for debugging/inspection
    entities_obj = output_dir / 'entities.obj'
    if entities_obj.exists():
        shutil.copy2(entities_obj, assets_dir / 'entities.obj')
        print("Copied entities.obj")

    buildings_obj = output_dir / 'buildings.obj'
    if buildings_obj.exists():
        shutil.copy2(buildings_obj, assets_dir / 'buildings.obj')
        print("Copied buildings.obj")

    building_info = output_dir / 'building_info.json'
    if building_info.exists():
        shutil.copy2(building_info, assets_dir / 'building_info.json')
        print("Copied building_info.json")

    # Client-like entity streaming assets
    entities_index = output_dir / 'entities_index.json'
    if entities_index.exists():
        shutil.copy2(entities_index, assets_dir / 'entities_index.json')
        print("Copied entities_index.json")

    chunks_src = output_dir / 'entities_chunks'
    if chunks_src.exists():
        chunks_dst = assets_dir / 'entities_chunks'
        chunks_dst.mkdir(exist_ok=True)
        # Copy chunk files (jsonl)
        for chunk_file in chunks_src.glob('*.jsonl'):
            shutil.copy2(chunk_file, chunks_dst / chunk_file.name)
        print("Copied entities_chunks/*.jsonl")

        # Optional: build fast binary position chunks for dot rendering
        # (keeps JSONL for model streaming / archetype data).
        if _SHOULD_BUILD_ENTITY_BINS:
            try:
                _build_entity_position_bins(assets_dir, max_chunks=_MAX_BINS_CHUNKS)
            except Exception as e:
                print(f"Warning: failed to build entity position bins: {e}")

        # Optional: build binary instance chunks for drawable streaming (archetype + transform).
        if _SHOULD_BUILD_ENTITY_INST_BINS:
            try:
                _build_entity_instance_bins(assets_dir, max_chunks=_MAX_INST_BINS_CHUNKS)
            except Exception as e:
                print(f"Warning: failed to build entity instance bins: {e}")
    
    # Copy textures from output/textures directory
    textures_dir = output_dir / 'textures'
    if textures_dir.exists():
        # Create textures directory in assets
        assets_textures_dir = assets_dir / 'textures'
        assets_textures_dir.mkdir(exist_ok=True)
        
        # Copy all texture files
        for texture_file in textures_dir.glob('*.png'):
            shutil.copy2(texture_file, assets_textures_dir / texture_file.name)
            print(f"Copied texture: {texture_file.name}")
    else:
        print("Warning: textures directory not found")

    # If terrain_info.json indicates no textures, try to auto-link terrain textures from the copied PNGs.
    _patch_terrain_info_with_detected_textures(assets_dir / 'terrain_info.json', assets_dir / 'textures')

    # Best-effort: if we don't have a real terrain blend mask, generate one from height/normal maps so
    # the WebGL viewer can do true 4-layer splat blending (still heuristic, but much better than 1-texture).
    _ensure_terrain_blend_mask_from_height_slope(assets_dir)
    
    # Create a manifest file for the viewer
    manifest = {
        'version': '1.0',
        'terrain': {
            'obj_file': 'terrain.obj',
            'info_file': 'terrain_info.json',
            'heightmap_file': 'heightmap.png',
            'textures_dir': 'textures'
        }
    }
    
    with open(assets_dir / 'manifest.json', 'w') as f:
        json.dump(manifest, f, indent=2)

    # Build / repair models manifest if model bins exist.
    _ensure_models_manifest(assets_dir / 'models')
    # Generate a sharded manifest (manifest_index.json + manifest_shards/*.json) for faster web startup.
    _ensure_models_manifest_shards(assets_dir / 'models')

    # Optional: build a small chunk->model-manifest-shards index to enable faster runtime prefetching.
    # This is separate from entities_index.json (which only maps chunk keys to filenames/counts).
    if _SHOULD_BUILD_CHUNK_SHARD_INDEX:
        try:
            _build_entities_chunk_shard_index(assets_dir, max_chunks=_MAX_CHUNK_SHARD_INDEX_CHUNKS)
        except Exception as e:
            print(f"Warning: failed to build entities_chunk_shards.json: {e}")
    
    print("\nAsset setup complete!")
    print(f"Assets directory: {assets_dir.absolute()}")

def _build_entity_position_bins(assets_dir: Path, max_chunks: int = 0):
    """
    Build positions-only binary chunks for fast client loading:
      assets/entities_chunks_bin/<chunk>.bin

    Format:
      - 4 bytes: b'ENT0'
      - u32 little-endian: pointCount
      - pointCount * 3 float32 little-endian: x,y,z

    The viewer will prefer these for dot rendering, and fall back to JSONL if missing.
    """
    idx_path = assets_dir / "entities_index.json"
    chunks_dir = assets_dir / "entities_chunks"
    if not idx_path.exists() or not chunks_dir.exists():
        return

    idx = json.loads(idx_path.read_text(encoding="utf-8", errors="ignore"))
    chunks = list((idx.get("chunks") or {}).items())
    chunks.sort(key=lambda kv: kv[0])
    if max_chunks and max_chunks > 0:
        chunks = chunks[: int(max_chunks)]

    out_dir = assets_dir / "entities_chunks_bin"
    out_dir.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    built = 0
    skipped = 0
    total_points = 0
    for i, (key, meta) in enumerate(chunks):
        file0 = (meta or {}).get("file") or f"{key}.jsonl"
        src = chunks_dir / file0
        if not src.exists():
            continue
        out = out_dir / (Path(file0).stem + ".bin")
        # Skip if already built and newer than source
        try:
            if out.exists() and out.stat().st_mtime >= src.stat().st_mtime:
                skipped += 1
                continue
        except Exception:
            pass

        pts = array("f")
        # Read line-by-line to keep memory stable.
        with open(src, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                pos = obj.get("position")
                if not pos or len(pos) < 3:
                    continue
                try:
                    x = float(pos[0])
                    y = float(pos[1])
                    z = float(pos[2])
                except Exception:
                    continue
                pts.append(x)
                pts.append(y)
                pts.append(z)

        count = len(pts) // 3
        if count <= 0:
            # Still write an empty bin so the client can fast-path without retrying JSONL.
            with open(out, "wb") as fo:
                fo.write(b"ENT0")
                fo.write(struct.pack("<I", 0))
            built += 1
            continue

        # Ensure little-endian float32 on disk.
        if pts.itemsize != 4:
            raise RuntimeError("Unexpected float array itemsize")
        if struct.pack("=I", 1) == struct.pack(">I", 1):
            pts.byteswap()

        with open(out, "wb") as fo:
            fo.write(b"ENT0")
            fo.write(struct.pack("<I", int(count)))
            pts.tofile(fo)

        built += 1
        total_points += count
        if (i + 1) % 25 == 0:
            print(f"[bins] {i+1}/{len(chunks)} built={built} skipped={skipped} points={total_points}")

    dt = max(0.001, time.time() - t0)
    print(f"Built entity position bins: {built} (skipped={skipped}), points={total_points}, seconds={dt:.1f}")


def _build_entity_instance_bins(assets_dir: Path, max_chunks: int = 0):
    """
    Build archetype+transform binary chunks for fast drawable streaming:
      assets/entities_chunks_inst/<chunk>.bin

    Format (ENT1):
      - 4 bytes: b'ENT1'
      - u32 little-endian: recordCount
      - recordCount records of:
          <I3f4f3f> = archetypeHash(u32), pos(xyz), quat(xyzw), scale(xyz)
    """
    idx_path = assets_dir / "entities_index.json"
    chunks_dir = assets_dir / "entities_chunks"
    if not idx_path.exists() or not chunks_dir.exists():
        return

    idx = json.loads(idx_path.read_text(encoding="utf-8", errors="ignore"))
    chunks = list((idx.get("chunks") or {}).items())
    chunks.sort(key=lambda kv: kv[0])
    if max_chunks and max_chunks > 0:
        chunks = chunks[: int(max_chunks)]

    out_dir = assets_dir / "entities_chunks_inst"
    out_dir.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    built = 0
    skipped = 0
    total_records = 0

    for i, (_key, meta) in enumerate(chunks):
        file0 = (meta or {}).get("file")
        if not file0:
            continue
        src = chunks_dir / file0
        if not src.exists():
            continue
        out = out_dir / (Path(file0).stem + ".bin")
        try:
            if out.exists() and out.stat().st_mtime >= src.stat().st_mtime:
                skipped += 1
                continue
        except Exception:
            pass

        count = 0
        buf = bytearray()
        with open(out, "wb") as fo:
            fo.write(b"ENT1")
            fo.write(struct.pack("<I", 0))  # placeholder count

            with open(src, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue

                    arch = obj.get("archetype")
                    if arch is None:
                        continue
                    # Accept either numeric hashes or model/archetype names (joaat).
                    try:
                        h = _normalize_archetype_to_u32(arch)
                    except Exception:
                        continue

                    pos = obj.get("position") or (0.0, 0.0, 0.0)
                    if not pos or len(pos) < 3:
                        continue
                    try:
                        x = float(pos[0])
                        y = float(pos[1])
                        z = float(pos[2])
                    except Exception:
                        continue

                    q = obj.get("rotation_quat") or (0.0, 0.0, 0.0, 1.0)
                    if not q or len(q) < 4:
                        q = (0.0, 0.0, 0.0, 1.0)
                    try:
                        qx = float(q[0])
                        qy = float(q[1])
                        qz = float(q[2])
                        qw = float(q[3])
                    except Exception:
                        qx, qy, qz, qw = 0.0, 0.0, 0.0, 1.0

                    sc = obj.get("scale") or (1.0, 1.0, 1.0)
                    if not sc or len(sc) < 3:
                        sc = (1.0, 1.0, 1.0)
                    try:
                        sx = float(sc[0])
                        sy = float(sc[1])
                        sz = float(sc[2])
                    except Exception:
                        sx, sy, sz = 1.0, 1.0, 1.0

                    buf += struct.pack("<I3f4f3f", int(h), x, y, z, qx, qy, qz, qw, sx, sy, sz)
                    count += 1
                    if len(buf) >= 4 * 1024 * 1024:
                        fo.write(buf)
                        buf.clear()

            if buf:
                fo.write(buf)

            # patch count
            fo.seek(4)
            fo.write(struct.pack("<I", int(count)))

        built += 1
        total_records += count
        if (i + 1) % 25 == 0:
            print(f"[inst] {i+1}/{len(chunks)} built={built} skipped={skipped} records={total_records}")

    dt = max(0.001, time.time() - t0)
    print(f"Built entity instance bins: {built} (skipped={skipped}), records={total_records}, seconds={dt:.1f}")


def _joaat_py(input0) -> int:
    """
    GTA "joaat" (Jenkins one-at-a-time) hash.
    Mirrors webgl_viewer/js/joaat.js.
    Returns unsigned 32-bit int.
    """
    s = str(input0 or "").lower()
    h = 0
    for ch in s:
        h = (h + ord(ch)) & 0xFFFFFFFF
        h = (h + ((h << 10) & 0xFFFFFFFF)) & 0xFFFFFFFF
        h ^= (h >> 6)
        h &= 0xFFFFFFFF
    h = (h + ((h << 3) & 0xFFFFFFFF)) & 0xFFFFFFFF
    h ^= (h >> 11)
    h &= 0xFFFFFFFF
    h = (h + ((h << 15) & 0xFFFFFFFF)) & 0xFFFFFFFF
    return h & 0xFFFFFFFF


def _normalize_archetype_to_u32(arch) -> int:
    """
    Normalize archetype identifier into unsigned 32-bit integer:
    - numeric => u32
    - other string => joaat(name)
    """
    if arch is None:
        raise ValueError("null archetype")
    s = str(arch).strip()
    if not s:
        raise ValueError("empty archetype")
    if s.lstrip("-").isdigit():
        return int(s, 10) & 0xFFFFFFFF
    return _joaat_py(s)


def _build_entities_chunk_shard_index(assets_dir: Path, max_chunks: int = 0):
    """
    Build a compact mapping of entity chunk -> model manifest shard IDs.

    Output:
      assets/entities_chunk_shards.json

    Why:
      The viewer uses a sharded models manifest (manifest_index.json + manifest_shards/*.json) and needs
      to know which shards to prefetch for nearby chunks *before* it parses the chunk JSONL/ENT1.

    Format:
      {
        "schema": "webglgta-entities-chunk-shards-v1",
        "chunk_size": <float>,
        "shard_bits": <int>,
        "chunks": { "<cx>_<cy>": [ <shardId:int>, ... ], ... }
      }

    Notes:
      - Prefers scanning ENT1 instance bins in assets/entities_chunks_inst/*.bin (fast) when present.
      - Falls back to parsing assets/entities_chunks/*.jsonl otherwise.
    """
    idx_path = assets_dir / "entities_index.json"
    chunks_dir = assets_dir / "entities_chunks"
    if not idx_path.exists() or not chunks_dir.exists():
        return

    # Require a sharded models manifest index so we know shard_bits.
    models_dir = assets_dir / "models"
    manifest_index_path = models_dir / "manifest_index.json"
    if not manifest_index_path.exists():
        print("Skipping chunk shard index: no assets/models/manifest_index.json (models manifest not sharded).")
        return
    try:
        m_idx = json.loads(manifest_index_path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return
    if not isinstance(m_idx, dict) or m_idx.get("schema") != "webglgta-manifest-index-v1":
        print("Skipping chunk shard index: unexpected models manifest_index schema.")
        return

    shard_bits = int(m_idx.get("shard_bits") or 0)
    shard_bits = max(4, min(12, shard_bits))
    mask = (1 << shard_bits) - 1

    idx = json.loads(idx_path.read_text(encoding="utf-8", errors="ignore"))
    chunk_size = float(idx.get("chunk_size") or 512.0)
    chunks = list((idx.get("chunks") or {}).items())
    chunks.sort(key=lambda kv: kv[0])
    if max_chunks and max_chunks > 0:
        chunks = chunks[: int(max_chunks)]

    inst_dir = assets_dir / "entities_chunks_inst"
    prefer_ent1 = inst_dir.exists()

    out_chunks = {}
    t0 = time.time()
    built = 0

    for i, (key, meta) in enumerate(chunks):
        file0 = (meta or {}).get("file")
        if not file0:
            continue

        shard_ids = set()

        # Prefer ENT1 (fast): each record begins with archetypeHash(u32)
        used_ent1 = False
        if prefer_ent1:
            bin_path = inst_dir / (Path(file0).stem + ".bin")
            if bin_path.exists():
                try:
                    with open(bin_path, "rb") as f:
                        head = f.read(8)
                        if len(head) == 8 and head[:4] == b"ENT1":
                            count = struct.unpack("<I", head[4:8])[0]
                            stride = 44
                            # Stream records to avoid loading huge files into memory.
                            # Read in blocks aligned to stride.
                            remaining = int(count) * stride
                            bufsize = 1024 * 1024
                            carry = b""
                            while remaining > 0:
                                take = min(bufsize, remaining)
                                data = f.read(take)
                                if not data:
                                    break
                                remaining -= len(data)
                                data = carry + data
                                nrec = len(data) // stride
                                end = nrec * stride
                                mv = memoryview(data)
                                for r in range(nrec):
                                    off = r * stride
                                    h = struct.unpack_from("<I", mv, off)[0]
                                    shard_ids.add(int(h) & mask)
                                carry = bytes(mv[end:])
                            used_ent1 = True
                except Exception:
                    used_ent1 = False

        if not used_ent1:
            # Fallback JSONL parse
            src = chunks_dir / file0
            if not src.exists():
                continue
            with open(src, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue
                    arch = obj.get("archetype")
                    if arch is None:
                        continue
                    try:
                        h = _normalize_archetype_to_u32(arch)
                    except Exception:
                        continue
                    shard_ids.add(int(h) & mask)

        out_chunks[str(key)] = sorted(int(x) for x in shard_ids)
        built += 1
        if (i + 1) % 50 == 0:
            print(f"[chunk_shards] {i+1}/{len(chunks)} built={built}")

    payload = {
        "schema": "webglgta-entities-chunk-shards-v1",
        "chunk_size": float(chunk_size),
        "shard_bits": int(shard_bits),
        "source": "entities_chunks_inst" if prefer_ent1 else "entities_chunks",
        "chunks": out_chunks,
    }
    out_path = assets_dir / "entities_chunk_shards.json"
    out_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    dt = max(0.001, time.time() - t0)
    print(f"Built {out_path.name}: chunks={len(out_chunks)} shard_bits={shard_bits} seconds={dt:.1f}")

def _patch_terrain_info_with_detected_textures(terrain_info_path: Path, textures_dir: Path):
    """
    Pragmatic fix-up for the viewer: if `terrain_info.json` has `num_textures=0`, but we *do* have
    a pile of exported `*_diffuse.png` textures, pick representative grass/rock/dirt/sand/snow pairs
    and write them back into `assets/terrain_info.json` so the viewer can bind real textures.
    """
    try:
        if not terrain_info_path.exists() or not textures_dir.exists():
            return

        try:
            info = json.loads(terrain_info_path.read_text(encoding='utf-8'))
        except Exception:
            return

        texture_info = info.get('texture_info')
        if not isinstance(texture_info, dict):
            texture_info = {}
            info['texture_info'] = texture_info

        num_textures = int(info.get('num_textures') or 0)
        layers = texture_info.get('layers')
        if num_textures > 0 or (isinstance(layers, list) and len(layers) > 0):
            return

        diffuse_files = list(textures_dir.glob('*_diffuse.png'))
        if not diffuse_files:
            return

        bases = set()
        for p in diffuse_files:
            n = p.name
            if n.lower().endswith('_diffuse.png'):
                bases.add(n[:-len('_diffuse.png')])

        def has_normal(base: str) -> bool:
            return (textures_dir / f'{base}_normal.png').exists()

        def pick_base(keywords):
            candidates = []
            for b in bases:
                bl = b.lower()
                if any(k in bl for k in keywords):
                    if 'mask' in bl or 'alpha' in bl or 'decal' in bl or 'gradient' in bl:
                        continue
                    score = 0
                    for k in keywords:
                        if k in bl:
                            score += 10
                    score -= min(200, len(bl))
                    if has_normal(b):
                        score += 5
                    candidates.append((score, b))
            if not candidates:
                return None
            candidates.sort(reverse=True)
            return candidates[0][1]

        picks = {
            'grass': pick_base(['grass', 'meadow', 'lush', 'scrub']),
            'rock': pick_base(['rock', 'cliff', 'stone', 'canyon']),
            'dirt': pick_base(['dirt', 'mud', 'earth', 'soil', 'track']),
            'sand': pick_base(['sand', 'beach', 'desert']),
            'snow': pick_base(['snow', 'ice']),
        }

        used = set()
        ordered = []
        for k in ['grass', 'rock', 'dirt', 'sand', 'snow']:
            b = picks.get(k)
            if not b or b in used:
                continue
            used.add(b)
            ordered.append((k, b))

        if not ordered:
            return

        for (_k, base) in ordered:
            texture_info[base] = {'format': 'png', 'has_normal': bool(has_normal(base)), 'source': 'setup_assets_autofill'}

        texture_info['terrain_types'] = {
            kind: {'name': base, 'has_normal': bool(has_normal(base))}
            for (kind, base) in ordered
        }
        texture_info['layers'] = [{'name': base, 'has_normal': bool(has_normal(base))} for (_k, base) in ordered[:4]]
        info['num_textures'] = len([k for k in texture_info.keys() if k not in ('layers', 'blend_mask', 'terrain_types')])

        terrain_info_path.write_text(json.dumps(info, indent=2), encoding='utf-8')
        print(f"Patched terrain_info.json with detected textures (num_textures={info['num_textures']})")
    except Exception:
        # Don't fail asset setup if this patching step fails.
        return

def _ensure_terrain_blend_mask_from_height_slope(assets_dir: Path):
    """
    Create `assets/textures/terrain_blend_mask.png` if missing, using heightmap + normalmap heuristics.
    This enables the viewer's 4-layer blending shader even when the extractor didn't export a real mask.

    Channel convention (matches viewer): R=layer1, G=layer2, B=layer3, A=layer4.
    """
    try:
        if np is None or Image is None:
            return
        tex_dir = assets_dir / 'textures'
        tex_dir.mkdir(exist_ok=True)
        out_path = tex_dir / 'terrain_blend_mask.png'
        if out_path.exists():
            return

        heightmap_path = assets_dir / 'heightmap.png'
        if not heightmap_path.exists():
            return

        # Heightmap is expected to be single-channel (or RGB with identical channels).
        hm = Image.open(heightmap_path).convert('L')
        h = np.asarray(hm, dtype=np.float32) / 255.0  # 0..1

        # Optional slope from normalmap (if present); else approximate from gradients.
        slope = None
        normalmap_path = assets_dir / 'normalmap.png'
        if normalmap_path.exists():
            nm = Image.open(normalmap_path).convert('RGB')
            n = (np.asarray(nm, dtype=np.float32) / 255.0) * 2.0 - 1.0
            # normalmap in viewer is stored in RGB; treat B as "up-ish" component in Z-up space.
            nz = np.clip(np.abs(n[..., 2]), 0.0, 1.0)
            slope = np.clip(1.0 - nz, 0.0, 1.0)

        if slope is None:
            gy, gx = np.gradient(h)
            slope = np.clip(np.sqrt(gx * gx + gy * gy) * 4.0, 0.0, 1.0)

        # Heuristic weights for 4 layers (R,G,B,A) = (grass, rock, dirt, sand)
        sand = np.clip((0.18 - h) / 0.18, 0.0, 1.0)
        sand = sand * sand

        rock = np.clip((slope - 0.25) / 0.55, 0.0, 1.0)
        rock = rock * rock
        rock = np.clip(rock + 0.35 * np.clip((h - 0.75) / 0.25, 0.0, 1.0), 0.0, 1.0)

        grass = np.clip((h - 0.08) / 0.55, 0.0, 1.0) * np.clip((0.35 - slope) / 0.35, 0.0, 1.0)
        grass = np.clip(grass, 0.0, 1.0)

        dirt = np.clip(1.0 - (grass + rock + sand), 0.0, 1.0)

        sumw = grass + rock + dirt + sand
        sumw[sumw < 1e-6] = 1.0
        w = np.stack([grass, rock, dirt, sand], axis=2) / sumw[..., None]
        rgba = np.clip(np.round(w * 255.0), 0, 255).astype(np.uint8)

        Image.fromarray(rgba, mode='RGBA').save(out_path)
        print("Generated terrain_blend_mask.png (height/slope heuristic)")

        # Advertise it in terrain_info.json so the viewer loads it.
        ti_path = assets_dir / 'terrain_info.json'
        if ti_path.exists():
            try:
                info = json.loads(ti_path.read_text(encoding='utf-8'))
                texture_info = info.get('texture_info')
                if not isinstance(texture_info, dict):
                    texture_info = {}
                    info['texture_info'] = texture_info
                texture_info['blend_mask'] = True
                ti_path.write_text(json.dumps(info, indent=2), encoding='utf-8')
            except Exception:
                pass
    except Exception:
        return

def _ensure_models_manifest(models_dir: Path):
    """
    Ensure `assets/models/manifest.json` exists and contains entries for the exported `*.bin` meshes.

    The WebGL viewer requires this manifest to know which archetype hashes have meshes and which
    lod files to load. If it's empty, you'll only see point entities ("yellow dots").
    """
    if not models_dir.exists() or not models_dir.is_dir():
        return

    manifest_path = models_dir / 'manifest.json'
    existing = None
    if manifest_path.exists():
        try:
            existing = json.loads(manifest_path.read_text(encoding='utf-8'))
        except Exception:
            existing = None

    def _looks_like_degenerate_autogen(m: dict) -> bool:
        """
        Detect the common failure mode: setup_assets generated a manifest from *_high.bin only and
        filled lodDistances with 9998 everywhere, which disables distance-based LOD switching.
        If we detect that, we patch-in sane defaults without clobbering real exporter distances.
        """
        try:
            meshes0 = m.get('meshes') if isinstance(m, dict) else None
            if not isinstance(meshes0, dict) or not meshes0:
                return False
            # Sample up to N entries
            keys = list(meshes0.keys())[:200]
            if not keys:
                return False
            deg = 0
            for k in keys:
                e = meshes0.get(k) or {}
                lods = e.get('lods') or {}
                ld = e.get('lodDistances') or {}
                # "only high" plus "all distances ~9998"
                only_high = (isinstance(lods, dict) and len(lods) == 1 and ('high' in lods))
                try:
                    vals = [float(ld.get('High', 0.0)), float(ld.get('Med', 0.0)), float(ld.get('Low', 0.0)), float(ld.get('VLow', 0.0))]
                except Exception:
                    vals = [0.0, 0.0, 0.0, 0.0]
                all_9998 = all(v >= 9990.0 for v in vals)
                if only_high and all_9998:
                    deg += 1
            return deg >= max(3, int(0.25 * len(keys)))
        except Exception:
            return False

    def _default_lod_distances(vertex_count: Optional[int] = None) -> dict:
        """
        Reasonable viewer defaults in GTA/data-space units.
        We bias slightly larger for bigger meshes so they don't snap too early.
        """
        vc = int(vertex_count) if isinstance(vertex_count, int) else 0
        # scale factor in [0..1] from vertex count
        s = 0.0
        try:
            if vc > 0:
                s = min(1.0, max(0.0, (vc ** 0.5) / 200.0))
        except Exception:
            s = 0.0
        hi = 90.0 + 60.0 * s
        med = 220.0 + 160.0 * s
        low = 520.0 + 420.0 * s
        vlow = 1200.0 + 900.0 * s
        return {'High': float(hi), 'Med': float(med), 'Low': float(low), 'VLow': float(vlow)}

    # If manifest already has meshes, keep it unless it looks like the degenerate auto-generated one.
    if isinstance(existing, dict) and isinstance(existing.get('meshes'), dict) and len(existing.get('meshes')) > 0:
        if not _looks_like_degenerate_autogen(existing):
            return
        # Patch distances in-place (do NOT regenerate lods/files).
        try:
            patched = 0
            for _h, e in (existing.get('meshes') or {}).items():
                if not isinstance(e, dict):
                    continue
                ld = e.get('lodDistances')
                lods = e.get('lods') or {}
                # Only patch entries that still have the 9998 defaults.
                try:
                    vals = [float((ld or {}).get('High', 0.0)), float((ld or {}).get('Med', 0.0)), float((ld or {}).get('Low', 0.0)), float((ld or {}).get('VLow', 0.0))]
                except Exception:
                    vals = [0.0, 0.0, 0.0, 0.0]
                if ld and all(v >= 9990.0 for v in vals):
                    # Use vertexCount from whatever LOD we have.
                    vc = None
                    try:
                        any_lod = next(iter(lods.values())) if isinstance(lods, dict) and lods else None
                        vc = int(any_lod.get('vertexCount')) if isinstance(any_lod, dict) and any_lod.get('vertexCount') is not None else None
                    except Exception:
                        vc = None
                    e['lodDistances'] = _default_lod_distances(vc)
                    patched += 1
            manifest_path.write_text(json.dumps(existing, indent=2), encoding='utf-8')
            print(f"Patched models manifest LOD distances for {patched} meshes: {manifest_path}")
        except Exception:
            return
        return

    bins = list(models_dir.glob('*.bin'))
    if not bins:
        return

    pat = re.compile(r'^(?P<hash>\d+)_(?P<lod>[a-zA-Z0-9]+)\.bin$')

    def _norm_lod(lod: str) -> Optional[str]:
        lod_s = (lod or '').strip().lower()
        if not lod_s:
            return None
        # Common aliases
        if lod_s in ('hi', 'high', 'lod0'):
            return 'high'
        if lod_s in ('med', 'mid', 'medium', 'lod1'):
            return 'med'
        if lod_s in ('low', 'lod2'):
            return 'low'
        if lod_s in ('vlow', 'vl', 'verylow', 'very_low', 'lod3'):
            return 'vlow'
        # Already normalized?
        if lod_s in ('high', 'med', 'low', 'vlow'):
            return lod_s
        return lod_s

    meshes = {}
    for p in bins:
        m = pat.match(p.name)
        if not m:
            continue
        h = m.group('hash')
        lod = _norm_lod(m.group('lod'))
        if not lod:
            continue

        try:
            with open(p, 'rb') as f:
                header = f.read(20)
            if len(header) < 20:
                continue
            magic = header[0:4].decode('ascii', errors='ignore')
            if magic != 'MSH0':
                continue
            version, vertex_count, index_count, flags = struct.unpack('<IIII', header[4:20])
        except Exception:
            continue

        entry = meshes.get(h)
        if not entry:
            entry = {
                'lods': {},
                # Reasonable defaults; real exporter writes actual Drawable LodDist* values.
                'lodDistances': _default_lod_distances(int(vertex_count) if isinstance(vertex_count, int) else None),
                'material': {},
            }
            meshes[h] = entry

        entry['lods'][lod] = {
            'file': p.name,
            'vertexCount': int(vertex_count),
            'indexCount': int(index_count),
            'hasNormals': bool(version >= 2 and (flags & 1) == 1),
            'hasUvs': bool(version >= 3 and (flags & 2) == 2),
            'hasTangents': bool(version >= 4 and (flags & 4) == 4),
        }

    out = {
        'version': 4,
        'meshes': meshes,
    }
    manifest_path.write_text(json.dumps(out, indent=2), encoding='utf-8')
    print(f"Generated models manifest with {len(meshes)} meshes: {manifest_path}")


def _ensure_models_manifest_shards(models_dir: Path, shard_bits: int = 8) -> None:
    """
    Generate a sharded manifest for the WebGL viewer:

      assets/models/manifest_index.json
      assets/models/manifest_shards/<xx>.json   (for shard_bits=8 => 256 files, xx in 00..ff)

    Why:
    - `assets/models/manifest.json` can be tens+ of MB. Even with a Worker, parsing/allocating it is heavy.
    - At runtime we only need metadata for archetypes near the player; the viewer can fetch shards on-demand.

    Sharding scheme:
    - Hash keys in the manifest are decimal strings for unsigned 32-bit joaat hashes.
    - We shard by the LOW `shard_bits` of that u32 (uniform-ish distribution).
    """
    if not models_dir.exists() or not models_dir.is_dir():
        return

    manifest_path = models_dir / "manifest.json"
    if not manifest_path.exists():
        return

    shard_bits_i = int(shard_bits)
    if shard_bits_i < 4 or shard_bits_i > 12:
        # keep shard count sane: 16..4096
        shard_bits_i = 8
    shard_count = 1 << shard_bits_i
    mask = shard_count - 1

    shard_dir = models_dir / "manifest_shards"
    index_path = models_dir / "manifest_index.json"

    try:
        src_mtime_ns = manifest_path.stat().st_mtime_ns
    except Exception:
        src_mtime_ns = 0

    # If index exists and matches source mtime, assume shards are up-to-date.
    if index_path.exists():
        try:
            idx_existing = json.loads(index_path.read_text(encoding="utf-8", errors="ignore"))
            if (
                isinstance(idx_existing, dict)
                and idx_existing.get("schema") == "webglgta-manifest-index-v1"
                and int(idx_existing.get("source_mtime_ns") or 0) == int(src_mtime_ns)
                and int(idx_existing.get("shard_bits") or 0) == int(shard_bits_i)
            ):
                return
        except Exception:
            pass

    # Load the monolithic manifest.
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return

    meshes = (manifest.get("meshes") if isinstance(manifest, dict) else None) or {}
    if not isinstance(meshes, dict) or not meshes:
        return

    # Build shards in-memory (dict per shard).
    shards = [{} for _ in range(shard_count)]
    bad_keys = 0
    for k, v in meshes.items():
        try:
            # Keys are decimal strings.
            n = int(str(k))
            sid = (n & mask)
            shards[sid][str(k)] = v
        except Exception:
            bad_keys += 1
            continue

    shard_dir.mkdir(parents=True, exist_ok=True)

    # Write shards (compact JSON).
    wrote = 0
    for sid in range(shard_count):
        if not shards[sid]:
            continue
        name = format(sid, "x").rjust((shard_bits_i + 3) // 4, "0") + ".json"
        out_path = shard_dir / name
        payload = {
            "schema": "webglgta-manifest-shard-v1",
            "manifest_version": manifest.get("version", 1),
            "shard_bits": shard_bits_i,
            "shard_id": sid,
            "meshes": shards[sid],
        }
        out_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        wrote += 1

    idx = {
        "schema": "webglgta-manifest-index-v1",
        "source": "manifest.json",
        "source_mtime_ns": int(src_mtime_ns),
        "manifest_version": manifest.get("version", 1),
        "mesh_count": int(len(meshes)),
        "bad_keys": int(bad_keys),
        "shard_bits": int(shard_bits_i),
        "shard_count": int(shard_count),
        "shard_dir": "manifest_shards",
        # the viewer computes shard file as <hex(shard_id) padded>.json
        "shard_file_ext": ".json",
        "shard_key": "u32_low_bits",
    }
    index_path.write_text(json.dumps(idx, indent=2), encoding="utf-8")
    print(f"Generated sharded models manifest: {index_path} (shards_written={wrote}/{shard_count})")

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument("--build-entity-bins", action="store_true", help="Build assets/entities_chunks_bin/*.bin (positions-only) for faster dot streaming")
    ap.add_argument("--max-bins-chunks", type=int, default=0, help="Limit number of chunks converted to bins (0 = all)")
    ap.add_argument("--build-entity-inst-bins", action="store_true", help="Build assets/entities_chunks_inst/*.bin (archetype+transform) for faster model streaming")
    ap.add_argument("--max-inst-bins-chunks", type=int, default=0, help="Limit number of chunks converted to inst bins (0 = all)")
    ap.add_argument("--build-chunk-shard-index", action="store_true", help="Build assets/entities_chunk_shards.json (chunk -> models manifest shard IDs) for faster model-meta prefetch")
    ap.add_argument("--max-chunk-shard-index-chunks", type=int, default=0, help="Limit number of chunks scanned for entities_chunk_shards.json (0 = all)")
    args = ap.parse_args()

    # module-global flag used inside setup_assets() without changing call sites
    _SHOULD_BUILD_ENTITY_BINS = bool(args.build_entity_bins)
    _MAX_BINS_CHUNKS = int(args.max_bins_chunks or 0)
    _SHOULD_BUILD_ENTITY_INST_BINS = bool(args.build_entity_inst_bins)
    _MAX_INST_BINS_CHUNKS = int(args.max_inst_bins_chunks or 0)
    _SHOULD_BUILD_CHUNK_SHARD_INDEX = bool(args.build_chunk_shard_index)
    _MAX_CHUNK_SHARD_INDEX_CHUNKS = int(args.max_chunk_shard_index_chunks or 0)
    setup_assets()
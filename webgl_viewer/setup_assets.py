import os
import shutil
import json
from pathlib import Path
import struct
import subprocess
import sys
from typing import Optional, Tuple, List, Dict, Any
import time
import tempfile

def _try_symlink(src: Path, dst: Path) -> bool:
    try:
        if dst.exists() or dst.is_symlink():
            if dst.is_dir() and not dst.is_symlink():
                shutil.rmtree(dst)
            else:
                dst.unlink()
        dst.symlink_to(src, target_is_directory=src.is_dir())
        return True
    except Exception:
        return False


def _build_ymap_index_web(repo_root: Path, assets_dir: Path) -> dict:
    """
    Build a web-friendly YMAP index for streaming entity placement JSONs in the viewer.
    Reads:  output/ymap/ymap_index.json (absolute paths, verbose)
    Writes: assets/ymap/index.json      (relative file names + extents)
    """
    ymap_index = repo_root / "output" / "ymap" / "ymap_index.json"
    if not ymap_index.exists():
        print("Note: output/ymap/ymap_index.json not found (skipping ymap index)")
        return {}

    data = json.loads(ymap_index.read_text(encoding="utf-8"))
    ymaps = data.get("ymaps", []) or []

    out = {
        "version": 1,
        "source": {
            "ymap_index": str(ymap_index),
        },
        "entities_dir": "ymap/entities",
        "numYmaps": int(data.get("numYmaps", len(ymaps))),
        "ymaps": [],
    }

    for item in ymaps:
        entities_path = Path(str(item.get("entitiesPath") or ""))
        fname = entities_path.name if entities_path.name else ""
        if not fname:
            continue

        md = item.get("mapData") or {}
        emin = md.get("entitiesExtentsMin") or md.get("streamingExtentsMin") or None
        emax = md.get("entitiesExtentsMax") or md.get("streamingExtentsMax") or None
        if not emin or not emax or len(emin) < 3 or len(emax) < 3:
            continue

        counts = item.get("counts") or {}
        out["ymaps"].append(
            {
                "file": fname,
                "min": [float(emin[0]), float(emin[1]), float(emin[2])],
                "max": [float(emax[0]), float(emax[1]), float(emax[2])],
                "entityCount": int(counts.get("CEntityDefs", 0)),
            }
        )

    out_dir = assets_dir / "ymap"
    out_dir.mkdir(exist_ok=True)
    (out_dir / "index.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"Copied/Generated ymap index: {(out_dir / 'index.json').name}")
    return {
        "dir": "ymap",
        "index": "ymap/index.json",
        "entities_dir": "ymap/entities",
        "numYmaps": int(len(out["ymaps"])),
    }


def _write_proxy_box_mesh_bin(out_path: Path) -> None:
    """
    Write a simple cube mesh in the legacy WebGL mesh-bin format expected by `webgl_viewer_old/js/model_manager.js`:
      Header: 4s 'MSH0', u32 version, u32 vertexCount, u32 indexCount, u32 flags
      Data: positions (f32*3*V), normals (f32*3*V if flags&1), uvs (f32*2*V if flags&2), indices (u32*I)

    We emit version=3, flags=3 (normals + uvs).
    """
    # 24-vertex cube (each face has unique verts, so normals/uvs are correct).
    # Face order: +Z, -Z, +X, -X, +Y, -Y
    faces = [
        # normal, 4 corners (x,y,z), uvs for each corner
        ((0, 0, 1),  [(-0.5, -0.5,  0.5), ( 0.5, -0.5,  0.5), ( 0.5,  0.5,  0.5), (-0.5,  0.5,  0.5)], [(0,0),(1,0),(1,1),(0,1)]),
        ((0, 0,-1),  [( 0.5, -0.5, -0.5), (-0.5, -0.5, -0.5), (-0.5,  0.5, -0.5), ( 0.5,  0.5, -0.5)], [(0,0),(1,0),(1,1),(0,1)]),
        ((1, 0, 0),  [( 0.5, -0.5,  0.5), ( 0.5, -0.5, -0.5), ( 0.5,  0.5, -0.5), ( 0.5,  0.5,  0.5)], [(0,0),(1,0),(1,1),(0,1)]),
        ((-1,0, 0),  [(-0.5, -0.5, -0.5), (-0.5, -0.5,  0.5), (-0.5,  0.5,  0.5), (-0.5,  0.5, -0.5)], [(0,0),(1,0),(1,1),(0,1)]),
        ((0, 1, 0),  [(-0.5,  0.5,  0.5), ( 0.5,  0.5,  0.5), ( 0.5,  0.5, -0.5), (-0.5,  0.5, -0.5)], [(0,0),(1,0),(1,1),(0,1)]),
        ((0,-1, 0),  [(-0.5, -0.5, -0.5), ( 0.5, -0.5, -0.5), ( 0.5, -0.5,  0.5), (-0.5, -0.5,  0.5)], [(0,0),(1,0),(1,1),(0,1)]),
    ]

    positions = []
    normals = []
    uvs = []
    indices = []

    vtx = 0
    for nrm, corners, tex in faces:
        for i in range(4):
            positions.extend(corners[i])
            normals.extend(nrm)
            uvs.extend(tex[i])
        # Two triangles: (0,1,2) (0,2,3) in local face quad
        indices.extend([vtx + 0, vtx + 1, vtx + 2, vtx + 0, vtx + 2, vtx + 3])
        vtx += 4

    vertex_count = vtx
    index_count = len(indices)
    version = 3
    flags = 1 | 2  # normals + uvs

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(struct.pack("<4sIIII", b"MSH0", version, vertex_count, index_count, flags))
        f.write(struct.pack("<%sf" % (len(positions)), *positions))
        f.write(struct.pack("<%sf" % (len(normals)), *normals))
        f.write(struct.pack("<%sf" % (len(uvs)), *uvs))
        f.write(struct.pack("<%sI" % (len(indices)), *indices))


def _parse_listed_count(stderr_text: str) -> Optional[int]:
    # CodeWalker.Cli prints this to stderr:
    #   "Listed <N> entries from <name>"
    import re
    m = re.search(r"Listed\s+(\d+)\s+entries\s+from\s+", stderr_text or "")
    if not m:
        return None
    try:
        return int(m.group(1))
    except ValueError:
        return None


def _find_first_entry_path_for_basename(*, cw_cli: Path, game_root: Path, basename: str, ext: str = ".ydr", max_rpfs: int = 2000) -> Optional[Tuple[str, str]]:
    """
    Find the first CodeWalker entry path matching **\\<basename><ext> across RPFS under game_root.
    Returns (entry_path, rpf_path) if found.

    This is intentionally scoped to a SMALL number of meshes (slow otherwise).
    """
    target = f"{basename}{ext}".lower()
    glob = rf"**\{basename}{ext}"

    # Scanning every RPF is extremely slow. Prefer a small "core" set (matches run_pipeline_linux.py scope=core).
    candidates: List[Path] = []
    candidates.append(game_root / "common.rpf")
    candidates.append(game_root / "update" / "update.rpf")
    candidates.extend(sorted(game_root.glob("x64*.rpf")))
    dlcpacks = game_root / "update" / "x64" / "dlcpacks"
    if dlcpacks.exists():
        candidates.extend([p for p in sorted(dlcpacks.rglob("*.rpf")) if p.is_file()])
    rpfs = [p for p in candidates if p.exists() and p.is_file()]

    if not rpfs:
        rpfs = [p for p in sorted(game_root.rglob("*.rpf")) if p.is_file()]
    if max_rpfs and max_rpfs > 0:
        rpfs = rpfs[:max_rpfs]

    for idx, rpf in enumerate(rpfs, start=1):
        cp = subprocess.run(
            [str(cw_cli), "list", "--game", str(game_root), "--rpf", str(rpf), "--glob", glob],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        if cp.returncode != 0:
            continue
        n = _parse_listed_count(cp.stderr)
        if not n:
            continue
        # stdout contains matching entry paths (one per line)
        for line in (cp.stdout or "").splitlines():
            s = (line or "").strip()
            if not s:
                continue
            if s.lower().endswith(target):
                return (s, str(rpf))
    return None


class _LocalFileReader:
    """
    Minimal adapter that matches the subset of `RpfReader` used by `YdrHandler`:
    - get_file_data(path) -> bytes

    Here, `path` is a local filesystem path.
    """

    def get_file_data(self, file_path: str) -> Optional[bytes]:
        try:
            p = Path(file_path)
            if not p.exists() or not p.is_file():
                return None
            return p.read_bytes()
        except Exception:
            return None


def _write_mesh_bin_from_ydr_file(*, ydr_path: Path, out_bin: Path) -> bool:
    """
    Use our Python YDR parser to read a YDR from disk (raw extracted) and write a single combined mesh bin.
    Best-effort: flattens all meshes into one buffer.
    """
    try:
        repo_root = Path(__file__).resolve().parent.parent
        if str(repo_root) not in sys.path:
            sys.path.insert(0, str(repo_root))

        from gta5_modules.ydr_handler import YdrHandler

        handler = YdrHandler(_LocalFileReader())
        ok = handler.load_ydr(str(ydr_path))
        if not ok:
            print(f"Warning: failed to parse YDR: {ydr_path.name}")
            return False

        # Flatten all meshes into one V/I list. (Good enough for instanced rendering.)
        positions: List[float] = []
        normals: List[float] = []
        uvs: List[float] = []
        indices: List[int] = []
        vtx_off = 0

        for mesh in handler.meshes:
            if not getattr(mesh, "vertices", None) or not getattr(mesh, "indices", None):
                continue
            vs = mesh.vertices
            ns = getattr(mesh, "normals", None) or []
            ts = getattr(mesh, "uvs", None) or []
            # vertices/normals are sequences of tuples/lists
            for i, v in enumerate(vs):
                positions.extend([float(v[0]), float(v[1]), float(v[2])])
                if i < len(ns):
                    n = ns[i]
                    normals.extend([float(n[0]), float(n[1]), float(n[2])])
                else:
                    normals.extend([0.0, 0.0, 1.0])
                if i < len(ts):
                    t = ts[i]
                    uvs.extend([float(t[0]), float(t[1])])
                else:
                    uvs.extend([0.0, 0.0])

            for idx in mesh.indices:
                indices.append(int(idx) + vtx_off)
            vtx_off += int(getattr(mesh, "num_vertices", len(vs)))

        if not positions or not indices:
            print(f"Warning: no mesh data extracted from {ydr_path.name}")
            return False

        vertex_count = int(len(positions) // 3)
        index_count = int(len(indices))
        version = 3
        flags = 1 | 2  # normals + uvs

        out_bin.parent.mkdir(parents=True, exist_ok=True)
        with open(out_bin, "wb") as f:
            f.write(struct.pack("<4sIIII", b"MSH0", version, vertex_count, index_count, flags))
            f.write(struct.pack("<%sf" % (len(positions)), *positions))
            f.write(struct.pack("<%sf" % (len(normals)), *normals))
            f.write(struct.pack("<%sf" % (len(uvs)), *uvs))
            f.write(struct.pack("<%sI" % (len(indices)), *indices))

        return True
    except Exception as e:
        print(f"Warning: exception exporting YDR mesh: {e}")
        return False


def _index_raw_models(*, raw_root: Path, exts: Tuple[str, ...], max_files: int = 0, time_budget_sec: float = 20.0) -> Dict[str, Path]:
    """
    Build a basename->path index for raw extracted model files.
    - Key is lowercase basename without extension (e.g. "prop_box_wood03a")
    """
    started = time.time()
    out: Dict[str, Path] = {}
    if not raw_root.exists():
        return out

    n = 0
    for ext in exts:
        for p in raw_root.rglob(f"*{ext}"):
            if time_budget_sec and (time.time() - started) > time_budget_sec:
                return out
            if not p.is_file():
                continue
            key = p.stem.lower()
            if key and key not in out:
                out[key] = p
                n += 1
                if max_files and n >= max_files:
                    return out
    return out


def _try_export_ydr_mesh_from_game_cache(*, game_root: Path, archetype_hash: int, out_bin: Path) -> bool:
    """
    Fast path: use CodeWalker.Core GameFileCache's YdrDict to locate the entry by hash, fetch bytes via RpfManager,
    and convert to MSH0. This avoids scanning RPFS.
    """
    try:
        repo_root = Path(__file__).resolve().parent.parent
        if str(repo_root) not in sys.path:
            sys.path.insert(0, str(repo_root))

        from gta5_modules.dll_manager import DllManager

        dll = DllManager(str(game_root))
        if not dll.initialized:
            return False

        cache = dll.get_game_cache()
        rpf = dll.get_rpf_manager()
        if cache is None or rpf is None:
            return False

        h = int(archetype_hash) & 0xFFFFFFFF

        entry = None
        try:
            # C# Dictionary<uint, RpfFileEntry>
            d = cache.YdrDict
            if d is not None and d.ContainsKey(h):
                entry = d[h]
        except Exception:
            entry = None

        if entry is None or not getattr(entry, "Path", None):
            return False

        data = rpf.GetFileData(entry.Path)
        if not data:
            return False

        # Write to a temp file and reuse the existing YdrHandler code path (expects local path).
        with tempfile.NamedTemporaryFile(prefix="webglgta_", suffix=".ydr", delete=True) as tf:
            tf.write(bytes(data))
            tf.flush()
            return _write_mesh_bin_from_ydr_file(ydr_path=Path(tf.name), out_bin=out_bin)

    except Exception:
        return False


def setup_assets():
    """Set up assets for the WebGL viewer"""
    # Create assets directory if it doesn't exist (inside this viewer package)
    assets_dir = Path(__file__).resolve().parent / 'assets'
    assets_dir.mkdir(parents=True, exist_ok=True)
    
    # Copy terrain.obj if it exists
    repo_root = Path(__file__).resolve().parent.parent
    terrain_obj = repo_root / 'output' / 'terrain.obj'
    if terrain_obj.exists():
        shutil.copy2(terrain_obj, assets_dir / 'terrain.obj')
        print("Copied terrain.obj")
    else:
        print("Warning: terrain.obj not found")
    
    # Copy terrain_info.json if it exists
    terrain_info = repo_root / 'output' / 'terrain_info.json'
    if terrain_info.exists():
        shutil.copy2(terrain_info, assets_dir / 'terrain_info.json')
        print("Copied terrain_info.json")
    else:
        print("Warning: terrain_info.json not found")
    
    # Copy heightmap.png if it exists
    heightmap = repo_root / 'output' / 'heightmap.png'
    if heightmap.exists():
        shutil.copy2(heightmap, assets_dir / 'heightmap.png')
        print("Copied heightmap.png")
    else:
        print("Warning: heightmap.png not found")
    
    # Copy textures from output/textures directory
    textures_dir = repo_root / 'output' / 'textures'
    if textures_dir.exists():
        # Create textures directory in assets
        assets_textures_dir = assets_dir / 'textures'
        assets_textures_dir.mkdir(exist_ok=True)
        
        # Copy all decoded texture PNGs (flattened into assets/textures/).
        # Supports both legacy `output/textures/*.png` and future `output/textures/png/**/*.png` layouts.
        pngs = list(textures_dir.rglob('*.png'))
        if not pngs:
            print("Warning: no decoded texture PNGs found under output/textures/")

        seen_names = set()
        for texture_file in pngs:
            dest = assets_textures_dir / texture_file.name
            if texture_file.name in seen_names and dest.exists():
                print(f"Warning: duplicate texture filename encountered, skipping: {texture_file.name}")
                continue

            shutil.copy2(texture_file, dest)
            seen_names.add(texture_file.name)
            print(f"Copied texture: {texture_file.name}")
    else:
        print("Warning: textures directory not found")

    # Copy worldmap outputs (optional)
    worldmap_dir = repo_root / 'output' / 'worldmap'
    if worldmap_dir.exists():
        assets_worldmap_dir = assets_dir / 'worldmap'
        assets_worldmap_dir.mkdir(exist_ok=True)
        for png in worldmap_dir.rglob('*.png'):
            shutil.copy2(png, assets_worldmap_dir / png.name)
            print(f"Copied worldmap: {png.name}")
    else:
        print("Note: output/worldmap not found (skipping worldmap assets)")

    # Copy meta/provenance outputs (recommended)
    meta_dir = repo_root / 'output' / 'meta'
    meta_manifest = {}
    if meta_dir.exists():
        assets_meta_dir = assets_dir / 'meta'
        assets_meta_dir.mkdir(exist_ok=True)
        for j in sorted(meta_dir.rglob('*.json')):
            shutil.copy2(j, assets_meta_dir / j.name)
            print(f"Copied meta: {j.name}")
        meta_manifest["dir"] = "meta"
        meta_manifest["files"] = [p.name for p in sorted(meta_dir.rglob("*.json"))]
    else:
        print("Note: output/meta not found (skipping meta manifests)")

    # Copy collision outputs (raw YBN and/or parsed JSON/meshes) if present
    collision_out_dir = repo_root / 'output' / 'collision'
    collision_manifest = {}

    if collision_out_dir.exists():
        assets_collision_dir = assets_dir / 'collision'
        assets_collision_dir.mkdir(exist_ok=True)

        raw_dir = collision_out_dir / 'raw'
        if raw_dir.exists():
            assets_raw_dir = assets_collision_dir / 'raw'
            if assets_raw_dir.exists():
                shutil.rmtree(assets_raw_dir)
            shutil.copytree(raw_dir, assets_raw_dir)
            print("Copied collision raw YBNs")
            collision_manifest['raw_dir'] = 'collision/raw'

        parsed_dir = collision_out_dir / 'parsed'
        if parsed_dir.exists():
            assets_parsed_dir = assets_collision_dir / 'parsed'
            if assets_parsed_dir.exists():
                shutil.rmtree(assets_parsed_dir)
            shutil.copytree(parsed_dir, assets_parsed_dir)
            print("Copied collision parsed outputs")
            collision_manifest['parsed_dir'] = 'collision/parsed'
    else:
        print("Note: output/collision not found (skipping collision assets)")

    # Copy/link YMAP entity placement outputs (recommended for "models/placements" visualization)
    ymap_manifest = {}
    ymap_entities_dir = repo_root / "output" / "ymap" / "entities"
    if ymap_entities_dir.exists():
        assets_ymap_entities_dir = assets_dir / "ymap" / "entities"
        assets_ymap_entities_dir.parent.mkdir(exist_ok=True)

        # Prefer a symlink (fast + avoids duplicating 20k files). Fall back to copying if symlinks fail.
        if _try_symlink(ymap_entities_dir, assets_ymap_entities_dir):
            print("Linked ymap entities directory")
        else:
            # Copy tree (can be slow).
            if assets_ymap_entities_dir.exists():
                shutil.rmtree(assets_ymap_entities_dir)
            shutil.copytree(ymap_entities_dir, assets_ymap_entities_dir)
            print("Copied ymap entities directory")

        # Build a compact index for the viewer
        ymap_manifest = _build_ymap_index_web(repo_root, assets_dir)
    else:
        print("Note: output/ymap/entities not found (skipping ymap entities)")

    # Optional: generate + copy chunked entity streaming index (client-like streaming).
    # This is required to use export_drawables_for_chunk.py / export_drawables_all_chunks.py.
    entities_stream_manifest = {}
    try:
        entities_out = repo_root / "output" / "entities_streaming"
        index_out = entities_out / "entities_index.json"
        chunks_out = entities_out / "entities_chunks"

        # Build if missing.
        if ymap_entities_dir.exists() and (not index_out.exists() or not chunks_out.exists()):
            print("Building entities_streaming index (this may take a while the first time)...")
            script = repo_root / "scripts" / "build_entities_streaming_index.py"
            if script.exists():
                subprocess.run(
                    [
                        sys.executable,
                        str(script),
                        "--ymap-entities-dir",
                        str(ymap_entities_dir),
                        "--outdir",
                        str(entities_out),
                        "--chunk-size",
                        "512",
                    ],
                    check=False,
                )

        if index_out.exists() and chunks_out.exists():
            # Link/copy into viewer assets
            assets_entities_index = assets_dir / "entities_index.json"
            assets_entities_chunks = assets_dir / "entities_chunks"

            # index is a file; prefer copy
            shutil.copy2(index_out, assets_entities_index)
            # chunks are many files; prefer symlink
            if not _try_symlink(chunks_out, assets_entities_chunks):
                if assets_entities_chunks.exists():
                    shutil.rmtree(assets_entities_chunks)
                shutil.copytree(chunks_out, assets_entities_chunks)

            entities_stream_manifest = {
                "index": "entities_index.json",
                "chunks_dir": "entities_chunks",
            }
            print("Synced entities_index.json + entities_chunks/ into viewer assets")
    except Exception as e:
        print(f"Note: failed to build/sync entities_streaming index: {e}")

    # Create a minimal "models" bundle so the viewer has a real mesh binary to load (proxy cube).
    # This is NOT GTA YDR/YDD extraction yet; it's a bridge so we can render instanced meshes today.
    models_manifest: Dict[str, Any] = {}
    models_dir = assets_dir / "models"
    models_dir.mkdir(exist_ok=True)
    box_bin = models_dir / "box_v3.bin"
    try:
        _write_proxy_box_mesh_bin(box_bin)
        # Seed manifest with a fallback cube (hash "0").
        models_manifest = {
            "version": 1,
            "note": "Models bundle. Some entries may be proxy meshes; real GTA meshes are best-effort.",
            "meshes": {
                "0": {"lods": {"high": {"file": box_bin.name}}}
            },
        }

        # Try to export a small set of *real* meshes:
        # - Prefer raw-extracted files (fast, deterministic)
        # - Otherwise, use CodeWalker.Core GameFileCache lookup (still fast, avoids scanning RPFS)
        # This is the only "proper" fast path; scanning RPFS is too slow and name mapping is not 1:1.
        sample_ymap = repo_root / "output" / "ymap" / "entities" / "airfield.json"
        raw_models_root = repo_root / "output" / "models" / "raw"

        # Build quick indexes (bounded).
        ydr_index: Dict[str, Path] = {}
        ydd_index: Dict[str, Path] = {}
        if raw_models_root.exists():
            ydr_index = _index_raw_models(raw_root=raw_models_root, exts=(".ydr",), max_files=15000, time_budget_sec=8.0)
            ydd_index = _index_raw_models(raw_root=raw_models_root, exts=(".ydd",), max_files=15000, time_budget_sec=8.0)

        game_root = (repo_root / "gtav")

        if not sample_ymap.exists():
            print("Note: skipping real mesh export (missing sample ymap entities)")
        else:
            j = json.loads(sample_ymap.read_text(encoding="utf-8"))
            ents = j.get("entities") or []
            picked = []
            seen = set()
            for e in ents:
                name = str(e.get("archetypeName") or "").strip()
                h = e.get("archetypeHash")
                if not name or h is None:
                    continue
                lname = name.lower()
                if lname.startswith("proc_") or "grass" in lname:
                    continue
                if lname in seen:
                    continue
                seen.add(lname)
                picked.append((name, int(h)))
                if len(picked) >= 6:
                    break

            if picked:
                print(f"Attempting to export up to {len(picked)} real meshes from raw extraction (airfield.json sample)...")

            exported = 0
            t0 = time.time()
            export_budget_sec = 20.0

            for (name, h) in picked:
                if export_budget_sec and (time.time() - t0) > export_budget_sec:
                    print("  - stopping real mesh export (time budget reached)")
                    break
                if exported >= 12:
                    break

                lname = name.lower()

                # 1) Raw extracted YDR path (fastest)
                ydr_path = ydr_index.get(lname) if ydr_index else None
                if ydr_path and ydr_path.exists():
                    out_bin = models_dir / f"{h}_high.bin"
                    ok_mesh = _write_mesh_bin_from_ydr_file(ydr_path=ydr_path, out_bin=out_bin)
                    if ok_mesh:
                        models_manifest["meshes"][str(h)] = {"lods": {"high": {"file": out_bin.name}}}
                        exported += 1
                        print(f"  - OK (YDR): {name} -> {out_bin.name}")
                    else:
                        print(f"  - FAIL (YDR parse): {name} ({ydr_path.name})")
                    continue

                # YDD-aware: many props are in drawable dictionaries. We detect this and report it clearly.
                ydd_path = ydd_index.get(lname)
                if ydd_path:
                    print(f"  - FOUND (YDD): {name} ({ydd_path.name}) - YDD mesh extraction not implemented yet")
                    continue

                # 2) Fast CodeWalker.Core lookup by hash (no scanning)
                if game_root.exists():
                    out_bin = models_dir / f"{h}_high.bin"
                    ok_cache = _try_export_ydr_mesh_from_game_cache(game_root=game_root, archetype_hash=h, out_bin=out_bin)
                    if ok_cache:
                        models_manifest["meshes"][str(h)] = {"lods": {"high": {"file": out_bin.name}}}
                        exported += 1
                        print(f"  - OK (cache): {name} -> {out_bin.name}")
                        continue

                print(f"  - missing: {name} (no raw .ydr/.ydd and no cache hit)")

            models_manifest["export"] = {
                "sample_source": str(sample_ymap),
                "exported_real_ydr_meshes": int(exported),
                "time_budget_sec": float(export_budget_sec),
                "notes": [
                    "Real meshes only exported from output/models/raw/** (fast path).",
                    "Fallback export can use CodeWalker.Core GameFileCache YdrDict lookup by archetype hash (no RPF scanning).",
                    "Many world props are in .ydd dictionaries; YDD mesh extraction is not implemented yet.",
                ],
            }

        (models_dir / "manifest.json").write_text(json.dumps(models_manifest, indent=2), encoding="utf-8")
        print("Wrote models manifest (assets/models/manifest.json)")
    except Exception as e:
        print(f"Warning: failed to write proxy models mesh bundle: {e}")
    
    # Create a manifest file for the viewer
    manifest = {
        'version': '1.0',
        'terrain': {
            'obj_file': 'terrain.obj',
            'info_file': 'terrain_info.json',
            'heightmap_file': 'heightmap.png',
            'textures_dir': 'textures'
        },
        'collision': collision_manifest,
        'worldmap': {
            'dir': 'worldmap'
        },
        'meta': meta_manifest,
        'ymap': ymap_manifest,
        'models': {
            'dir': 'models',
            'manifest': 'models/manifest.json' if models_manifest else None,
        },
        'entities_streaming': entities_stream_manifest,
    }
    
    with open(assets_dir / 'manifest.json', 'w') as f:
        json.dump(manifest, f, indent=2)
    
    print("\nAsset setup complete!")
    print(f"Assets directory: {assets_dir.absolute()}")

if __name__ == '__main__':
    setup_assets() 
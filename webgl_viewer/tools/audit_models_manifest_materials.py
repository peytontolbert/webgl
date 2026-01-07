#!/usr/bin/env python3
"""
Audit material completeness in the WebGL viewer's sharded model manifests.

This is designed to answer questions like:
- How many submeshes have `material: {}`?
- How many materials are missing `diffuse`?
- How many materials are missing `shaderParams` (texturesByHash/vectorsByHash)?
- Which mesh hashes are *entirely* missing material data?

Optional: map sample mesh hashes back to `assets/entities_chunks/*.jsonl` to show archetype names/YMAPs.
"""

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path


def _load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return None


def _iter_shards(models_dir: Path):
    shard_dir = models_dir / "manifest_shards"
    if shard_dir.exists():
        for p in sorted(shard_dir.glob("*.json")):
            if p.is_file():
                yield p
        return
    mp = models_dir / "manifest.json"
    if mp.exists():
        yield mp


def _iter_submesh_materials(entry: dict):
    """
    Yield tuples (where, mat_dict).
    where is 'entry' or 'submesh:<lod>:<i>'.
    """
    if not isinstance(entry, dict):
        return
    m0 = entry.get("material")
    if isinstance(m0, dict):
        yield ("entry", m0)
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
                m = sm.get("material")
                if isinstance(m, dict):
                    yield (f"submesh:{lod_name}:{i}", m)


def _has_shaderparams(mat: dict) -> bool:
    sp = mat.get("shaderParams")
    if not isinstance(sp, dict):
        return False
    tb = sp.get("texturesByHash")
    vb = sp.get("vectorsByHash")
    return isinstance(tb, dict) or isinstance(vb, dict)


def _scan_entities_for_mesh_hashes(assets_dir: Path, want_hashes: set[str], max_hits_per_hash: int, max_lines: int):
    """
    Best-effort mapping of mesh hash -> list of (name, ymap) occurrences.
    Scans jsonl line-by-line to keep memory stable.
    """
    out: dict[str, list[dict]] = defaultdict(list)
    chunks_dir = assets_dir / "entities_chunks"
    if not chunks_dir.exists():
        return out
    total_lines = 0
    for p in sorted(chunks_dir.glob("*.jsonl")):
        if not p.is_file():
            continue
        try:
            with open(p, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    if max_lines and total_lines >= max_lines:
                        return out
                    total_lines += 1
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        e = json.loads(line)
                    except Exception:
                        continue
                    ah = e.get("archetype_hash") or e.get("archetype")
                    if ah is None:
                        continue
                    hs = str(ah).strip()
                    if hs not in want_hashes:
                        continue
                    if len(out[hs]) >= max_hits_per_hash:
                        continue
                    out[hs].append(
                        {
                            "name": e.get("name"),
                            "archetype_raw": e.get("archetype_raw"),
                            "ymap": e.get("ymap"),
                            "chunk": p.name,
                        }
                    )
        except Exception:
            continue
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--assets-dir",
        default="/data/webglgta/webgl-gta/webgl_viewer/assets",
        help="Path to webgl_viewer/assets",
    )
    ap.add_argument("--max-print", type=int, default=25, help="Max sample meshes to print per category")
    ap.add_argument("--scan-entities", action="store_true", help="Map sample mesh hashes back to entities_chunks/*.jsonl")
    ap.add_argument("--entity-max-hits", type=int, default=4, help="Max entity hits to print per mesh hash when scanning entities")
    ap.add_argument("--entity-max-lines", type=int, default=0, help="Max jsonl lines to scan across all chunks (0 = all)")
    args = ap.parse_args()

    assets_dir = Path(args.assets_dir)
    models_dir = assets_dir / "models"

    shard_files = list(_iter_shards(models_dir))
    if not shard_files:
        raise SystemExit(f"No model manifest found under: {models_dir}")

    # Counters (split entry-level vs submesh-level; viewer primarily uses submesh materials).
    entry_total = 0
    entry_empty = 0
    entry_missing_diffuse = 0
    entry_missing_shaderparams = 0

    sub_total = 0
    sub_empty = 0
    sub_missing_diffuse = 0
    sub_missing_shaderparams = 0

    meshes_total = 0
    meshes_any_submesh_empty = 0
    meshes_all_submesh_empty = 0

    sample_any_submesh_empty: list[str] = []
    sample_all_submesh_empty: list[str] = []

    for sf in shard_files:
        payload = _load_json(sf)
        if not isinstance(payload, dict):
            continue
        meshes = payload.get("meshes")
        if not isinstance(meshes, dict):
            continue
        for hs, entry in meshes.items():
            if not isinstance(entry, dict):
                continue
            meshes_total += 1
            any_submesh = False
            any_submesh_empty = False
            any_submesh_nonempty = False

            for where, mat in _iter_submesh_materials(entry):
                base = where.split(":", 1)[0]
                if base == "entry":
                    entry_total += 1
                    if not mat:
                        entry_empty += 1
                        continue
                    if not (isinstance(mat.get("diffuse"), str) and mat.get("diffuse").strip()):
                        entry_missing_diffuse += 1
                    if not _has_shaderparams(mat):
                        entry_missing_shaderparams += 1
                    continue

                # submesh material
                any_submesh = True
                sub_total += 1
                if not mat:
                    sub_empty += 1
                    any_submesh_empty = True
                    continue
                any_submesh_nonempty = True
                if not (isinstance(mat.get("diffuse"), str) and mat.get("diffuse").strip()):
                    sub_missing_diffuse += 1
                if not _has_shaderparams(mat):
                    sub_missing_shaderparams += 1

            if any_submesh_empty:
                meshes_any_submesh_empty += 1
                if len(sample_any_submesh_empty) < int(args.max_print):
                    sample_any_submesh_empty.append(str(hs))
            if any_submesh and (not any_submesh_nonempty) and any_submesh_empty:
                meshes_all_submesh_empty += 1
                if len(sample_all_submesh_empty) < int(args.max_print):
                    sample_all_submesh_empty.append(str(hs))

    print(f"[audit] assets_dir={assets_dir}")
    print(f"[audit] shard_files={len(shard_files)}")
    print(f"[audit] meshes_total={meshes_total}")
    print(f"[audit] meshes_any_submesh_material_empty={meshes_any_submesh_empty}")
    print(f"[audit] meshes_all_submesh_materials_empty={meshes_all_submesh_empty}")

    print("\n[audit] entry-level materials (entry.material):")
    print(f"  total={entry_total}")
    print(f"  empty={{}}={entry_empty} ({(entry_empty/entry_total*100 if entry_total else 0):.1f}%)")
    print(f"  missing_diffuse={entry_missing_diffuse} ({(entry_missing_diffuse/entry_total*100 if entry_total else 0):.1f}%)")
    print(f"  missing_shaderParams={entry_missing_shaderparams} ({(entry_missing_shaderparams/entry_total*100 if entry_total else 0):.1f}%)")

    print("\n[audit] submesh materials (lods[].submeshes[].material):")
    print(f"  total={sub_total}")
    print(f"  empty={{}}={sub_empty} ({(sub_empty/sub_total*100 if sub_total else 0):.1f}%)")
    print(f"  missing_diffuse={sub_missing_diffuse} ({(sub_missing_diffuse/sub_total*100 if sub_total else 0):.1f}%)")
    print(f"  missing_shaderParams={sub_missing_shaderparams} ({(sub_missing_shaderparams/sub_total*100 if sub_total else 0):.1f}%)")

    if sample_any_submesh_empty:
        print(f"\n[audit] sample meshes with SOME empty *submesh* materials (first {len(sample_any_submesh_empty)}):")
        for hs in sample_any_submesh_empty:
            print("  -", hs)
    if sample_all_submesh_empty:
        print(f"\n[audit] sample meshes with ALL *submesh* materials empty (first {len(sample_all_submesh_empty)}):")
        for hs in sample_all_submesh_empty:
            print("  -", hs)

    if args.scan_entities and (sample_any_submesh_empty or sample_all_submesh_empty):
        sample = set(sample_any_submesh_empty) | set(sample_all_submesh_empty)
        mapping = _scan_entities_for_mesh_hashes(
            assets_dir=assets_dir,
            want_hashes=sample,
            max_hits_per_hash=int(args.entity_max_hits),
            max_lines=int(args.entity_max_lines or 0),
        )
        if mapping:
            print("\n[audit] entity references for sample hashes:")
            for hs in sorted(sample):
                rows = mapping.get(hs) or []
                if not rows:
                    continue
                print(f"  - {hs}:")
                for r in rows:
                    print(f"    - name={r.get('name')} archetype_raw={r.get('archetype_raw')} chunk={r.get('chunk')}")
                    if r.get("ymap"):
                        print(f"      ymap={r.get('ymap')}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())



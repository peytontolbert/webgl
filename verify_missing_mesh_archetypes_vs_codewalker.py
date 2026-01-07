#!/usr/bin/env python3
"""
Verify / collect missing mesh archetypes, with optional parity checks against CodeWalker.

Why this exists:
- `report_missing_meshes.py` is a good quick check, but it treats every streamed entity equally.
- In CodeWalker/GTA, interior entity sets (MLO EntitySets) are *gated*:
  only "defaultEntitySets" (indices) are visible by default unless forced.
- This script can compute "baseline missing meshes" (what CodeWalker would show by default),
  and optionally compare our exported archetype references vs CodeWalker enumeration.

Outputs:
- prints a summary + top missing archetypes by placement count
- optionally writes a JSON list compatible with `export_drawables_from_list.py`
"""

from __future__ import annotations

import argparse
import json
import logging
import time
from collections import Counter
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Set, Tuple

from gta5_modules.archetype_utils import normalize_archetype_to_hash_str
from gta5_modules.entity_coverage import auto_assets_dir, iter_entity_objects, load_entities_index
from gta5_modules.hash_utils import as_u32_str


def _load_exported_mesh_hashes(assets_dir: Path) -> Set[str]:
    """
    Return set of exported mesh archetype hash strings (u32 decimal) from models manifest.

    Prefer sharded manifest via `manifest_index.json` + shards, because `manifest.json` can be large.
    """
    models_dir = assets_dir / "models"
    idx_path = models_dir / "manifest_index.json"
    if idx_path.exists():
        try:
            idx = json.loads(idx_path.read_text(encoding="utf-8", errors="ignore"))
        except Exception:
            idx = None
        if isinstance(idx, dict) and idx.get("schema") == "webglgta-manifest-index-v1":
            shard_dir = models_dir / str(idx.get("shard_dir") or "manifest_shards")
            shard_ext = str(idx.get("shard_file_ext") or ".json")
            shard_count = int(idx.get("shard_count") or 0)
            shard_count = max(0, min(4096, shard_count))
            out: Set[str] = set()
            for sid in range(shard_count):
                fn = f"{sid:02x}{shard_ext}"
                p = shard_dir / fn
                if not p.exists():
                    continue
                try:
                    obj = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
                except Exception:
                    continue
                meshes = (obj.get("meshes") or {}) if isinstance(obj, dict) else {}
                if isinstance(meshes, dict):
                    out.update([str(k) for k in meshes.keys()])
            return out

    # Fallback: monolithic manifest.json.
    p = models_dir / "manifest.json"
    if p.exists():
        try:
            mm = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
        except Exception:
            mm = None
        meshes = (mm.get("meshes") or {}) if isinstance(mm, dict) else {}
        if isinstance(meshes, dict):
            return set([str(k) for k in meshes.keys()])

    return set()


def _load_interiors_entity_set_hash_to_index(assets_dir: Path, mlo_arch_hash_u32: str) -> Dict[int, int]:
    """
    Read assets/interiors/<mloArchetypeHash>.json (written by building_system.py) and return:
      set_hash_u32 -> set_index
    """
    out: Dict[int, int] = {}
    interiors_dir = assets_dir / "interiors"
    p = interiors_dir / f"{mlo_arch_hash_u32}.json"
    if not p.exists():
        return out
    try:
        obj = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return out
    sets0 = obj.get("entity_sets") if isinstance(obj, dict) else None
    if not isinstance(sets0, list):
        return out
    for s in sets0:
        if not isinstance(s, dict):
            continue
        try:
            idx = int(s.get("index") or 0)
        except Exception:
            continue
        try:
            h = int(str(s.get("hash") or "0"), 10) & 0xFFFFFFFF
        except Exception:
            continue
        if h:
            out[int(h)] = int(idx)
    return out


def _iter_referenced_archetypes_from_export(
    assets_dir: Path,
    *,
    include_mlo_containers: bool,
    include_all_mlo_entity_sets: bool,
    use_interiors_defs_for_defaults: bool,
) -> Tuple[Counter, Dict[str, Counter], Dict[str, Any]]:
    """
    Iterate exported entity chunks and count referenced archetype hashes, with CodeWalker-like MLO defaults.
    Returns: (counts_by_hash, name_samples_by_hash, meta)
    """
    chunks_dir = assets_dir / "entities_chunks"
    if not chunks_dir.exists():
        raise SystemExit(f"Missing entities_chunks dir: {chunks_dir}")

    # Build a map of MLO instances (parentGuid -> {mloArchHash, defaultSetIndices[]}).
    # We use this to interpret set visibility using interiors defs + defaultEntitySets indices.
    mlo_instances: Dict[int, dict] = {}
    total_rows = 0
    for _fn, ent in iter_entity_objects(chunks_dir):
        total_rows += 1
        if not isinstance(ent, dict):
            continue
        if not bool(ent.get("is_mlo_instance")):
            continue
        guid = int(str(ent.get("guid") or "0"), 10) & 0xFFFFFFFF if str(ent.get("guid") or "").strip().isdigit() else 0
        if not guid:
            continue
        # MLO container archetype hash (u32 string)
        mlo_arch = as_u32_str(ent.get("archetype_hash") or ent.get("archetype"))
        if not mlo_arch:
            continue
        des = ent.get("mlo_default_entity_sets")
        default_set_indices: list[int] = []
        if isinstance(des, list):
            for x in des:
                try:
                    default_set_indices.append(int(x) & 0xFFFFFFFF)
                except Exception:
                    continue
        mlo_instances[guid] = {"mlo_arch": mlo_arch, "default_set_indices": default_set_indices}

    # Cache for mloArchHash -> (setHash->setIndex)
    set_index_cache: Dict[str, Dict[int, int]] = {}

    counts: Counter = Counter()
    name_samples: Dict[str, Counter] = {}

    total_entities = 0
    skipped_mlo_containers = 0
    skipped_nondefault_set_children = 0
    unknown_set_defaults = 0
    included_set_children = 0
    included_base_children = 0

    for _fn, ent in iter_entity_objects(chunks_dir):
        if not isinstance(ent, dict):
            continue
        total_entities += 1

        # Exclude MLO "container" instances by default (no renderable drawable; children are the meshes).
        if (not include_mlo_containers) and bool(ent.get("is_mlo_instance")):
            skipped_mlo_containers += 1
            continue

        h = normalize_archetype_to_hash_str(ent)
        if not h:
            continue

        nm = str(ent.get("archetype_raw") or ent.get("name") or "").strip()

        mlo_parent_guid = as_u32_str(ent.get("mlo_parent_guid")) or "0"
        set_hash_str = as_u32_str(ent.get("mlo_entity_set_hash")) or "0"
        has_mlo_parent = int(mlo_parent_guid) != 0
        set_hash_u32 = int(set_hash_str) & 0xFFFFFFFF

        if has_mlo_parent and set_hash_u32 != 0:
            # Entity-set child: include only default-visible sets unless requested.
            if include_all_mlo_entity_sets:
                included_set_children += 1
            else:
                include_child = False
                if use_interiors_defs_for_defaults:
                    inst = mlo_instances.get(int(mlo_parent_guid) & 0xFFFFFFFF)
                    if inst:
                        mlo_arch = str(inst.get("mlo_arch") or "")
                        default_idxs = set(int(x) & 0xFFFFFFFF for x in (inst.get("default_set_indices") or []))
                        if mlo_arch:
                            mp = set_index_cache.get(mlo_arch)
                            if mp is None:
                                mp = _load_interiors_entity_set_hash_to_index(assets_dir, mlo_arch)
                                set_index_cache[mlo_arch] = mp
                            set_idx = mp.get(int(set_hash_u32) & 0xFFFFFFFF)
                            if set_idx is not None:
                                include_child = int(set_idx) in default_idxs
                            else:
                                unknown_set_defaults += 1
                                # Can't resolve set index; conservative behavior: include it (so we don't undercount).
                                include_child = True
                    else:
                        unknown_set_defaults += 1
                        include_child = True
                else:
                    # No def mapping: cannot interpret defaultEntitySets indices; conservative include.
                    unknown_set_defaults += 1
                    include_child = True

                if not include_child:
                    skipped_nondefault_set_children += 1
                    continue
                included_set_children += 1

        if has_mlo_parent and set_hash_u32 == 0:
            included_base_children += 1

        counts[h] += 1
        if nm:
            c = name_samples.get(h)
            if c is None:
                c = Counter()
                name_samples[h] = c
            c[nm] += 1

    meta = {
        "export_scan_total_rows": int(total_rows),
        "export_scan_total_entities": int(total_entities),
        "export_mlo_instances": int(len(mlo_instances)),
        "skipped_mlo_containers": int(skipped_mlo_containers),
        "skipped_nondefault_set_children": int(skipped_nondefault_set_children),
        "unknown_set_defaults": int(unknown_set_defaults),
        "included_set_children": int(included_set_children),
        "included_base_children": int(included_base_children),
        "include_mlo_containers": bool(include_mlo_containers),
        "include_all_mlo_entity_sets": bool(include_all_mlo_entity_sets),
        "use_interiors_defs_for_defaults": bool(use_interiors_defs_for_defaults),
    }
    return counts, name_samples, meta


def _ensure_loaded(gfc, gf, max_loops: int = 500) -> bool:
    if gf is None:
        return False
    # Some CodeWalker file types (notably YmapFile via pythonnet) can have their parsed fields
    # populated even while `Loaded == false`. Treat them as loaded when core data is present.
    try:
        ae = getattr(gf, "AllEntities", None)
        if ae is not None:
            return True
    except Exception:
        pass
    try:
        cmd = getattr(gf, "CMapData", None)
        if cmd is not None:
            return True
    except Exception:
        pass
    try:
        if getattr(gf, "Loaded", False):
            return True
    except Exception:
        pass
    for _ in range(max_loops):
        try:
            gfc.ContentThreadProc()
        except Exception:
            break
        try:
            if getattr(gf, "Loaded", False):
                return True
        except Exception:
            pass
    return False


def _iter_referenced_archetypes_from_codewalker(
    *,
    game_path: str,
    selected_dlc: str,
    also_scan_dlc: list[str],
    limit_ymaps: int,
    include_all_entity_sets: bool,
    include_mlo_containers: bool,
) -> Tuple[Counter, Dict[str, Counter], Dict[str, Any]]:
    """
    Enumerate archetype hashes referenced by CodeWalker YMAPs (including MLO interior entities).
    """
    from gta5_modules.dll_manager import DllManager

    dm = DllManager(str(game_path))
    if not getattr(dm, "initialized", False):
        raise SystemExit("DllManager failed to init")
    if not dm.init_game_file_cache(selected_dlc=str(selected_dlc or "__all__")):
        raise SystemExit("Failed to init CodeWalker GameFileCache")
    gfc = dm.get_game_file_cache()
    if gfc is None or not getattr(gfc, "IsInited", False):
        raise SystemExit("GameFileCache not inited")

    ymapdict = getattr(gfc, "YmapDict", None)
    if ymapdict is None:
        raise SystemExit("GameFileCache.YmapDict not available")

    counts: Counter = Counter()
    name_samples: Dict[str, Counter] = {}

    ymaps_scanned = 0
    ymaps_loaded = 0
    ymaps_failed = 0
    dlc_passes = []
    mlo_containers = 0
    mlo_children = 0
    mlo_set_children = 0
    mlo_set_skipped = 0

    start = time.time()

    def _metahash_to_u32(mh) -> int:
        """
        Convert CodeWalker MetaHash (or an int) into a uint32.
        In pythonnet, CEntityDef.archetypeName is typically a MetaHash object with `.Hash` (uint).
        """
        if mh is None:
            return 0
        try:
            hv = getattr(mh, "Hash", None)
            if hv is not None:
                return int(hv) & 0xFFFFFFFF
        except Exception:
            pass
        try:
            return int(mh) & 0xFFFFFFFF
        except Exception:
            return 0

    def _scan_current_ymapdict(pass_label: str) -> None:
        nonlocal ymaps_scanned, ymaps_loaded, ymaps_failed
        nonlocal mlo_containers, mlo_children, mlo_set_children, mlo_set_skipped
        ymapdict0 = getattr(gfc, "YmapDict", None)
        if ymapdict0 is None:
            return
        try:
            dlc_passes.append({"label": str(pass_label), "ymapdict_count": int(getattr(ymapdict0, "Count", 0) or 0)})
        except Exception:
            dlc_passes.append({"label": str(pass_label), "ymapdict_count": 0})

        for kv in ymapdict0:
            if limit_ymaps and ymaps_scanned >= int(limit_ymaps):
                break
            try:
                entry = getattr(kv, "Value", None) or kv.Value
            except Exception:
                entry = None
            if entry is None:
                continue
            ymaps_scanned += 1
            try:
                ymap = dm.get_ymap_file(entry)
            except Exception:
                ymap = None
            if ymap is None:
                ymaps_failed += 1
                continue

            # IMPORTANT: CodeWalker GameFiles often require an explicit LoadFile() enqueue,
            # then pumping ContentThreadProc() until loaded/parsed.
            try:
                lf = getattr(gfc, "LoadFile", None)
                if callable(lf):
                    lf(ymap)
            except Exception:
                pass

            if not _ensure_loaded(gfc, ymap, max_loops=800):
                ymaps_failed += 1
                continue
            ymaps_loaded += 1

            # Ensure archetypes are resolved (also initializes MLO instance entity archetypes).
            try:
                if hasattr(ymap, "InitYmapEntityArchetypes"):
                    ymap.InitYmapEntityArchetypes(gfc)
            except Exception:
                pass

            ents = getattr(ymap, "AllEntities", None) or []
            for ent in ents:
                if ent is None:
                    continue
                try:
                    ced = getattr(ent, "_CEntityDef", None)
                    arch = getattr(ced, "archetypeName", None) if ced is not None else None
                    h = _metahash_to_u32(arch)
                except Exception:
                    h = 0
                if not h:
                    continue

                try:
                    is_mlo = bool(getattr(ent, "IsMlo", False))
                except Exception:
                    is_mlo = False

                if is_mlo:
                    mlo_containers += 1
                    if include_mlo_containers:
                        counts[str(h)] += 1
                    # Children (base)
                    try:
                        mi = getattr(ent, "MloInstance", None)
                    except Exception:
                        mi = None
                    if mi is not None:
                        ch = getattr(mi, "Entities", None)
                        if ch is not None:
                            for c in ch:
                                try:
                                    ced2 = getattr(c, "_CEntityDef", None)
                                    a2 = getattr(ced2, "archetypeName", None) if ced2 is not None else None
                                    hh = _metahash_to_u32(a2)
                                except Exception:
                                    hh = 0
                                if hh:
                                    counts[str(hh)] += 1
                                    mlo_children += 1
                        sets = getattr(mi, "EntitySets", None)
                        if sets is not None:
                            for s in sets:
                                if s is None:
                                    continue
                                # CodeWalker renders entity sets only when VisibleOrForced (default sets are marked Visible).
                                try:
                                    visible = bool(getattr(s, "VisibleOrForced", False))
                                except Exception:
                                    try:
                                        visible = bool(getattr(s, "Visible", False))
                                    except Exception:
                                        visible = False
                                if (not include_all_entity_sets) and (not visible):
                                    mlo_set_skipped += 1
                                    continue
                                ents2 = getattr(s, "Entities", None)
                                if ents2 is None:
                                    continue
                                for c in list(ents2):
                                    try:
                                        ced2 = getattr(c, "_CEntityDef", None)
                                        a2 = getattr(ced2, "archetypeName", None) if ced2 is not None else None
                                        hh = _metahash_to_u32(a2)
                                    except Exception:
                                        hh = 0
                                    if hh:
                                        counts[str(hh)] += 1
                                        mlo_set_children += 1
                    continue

                # Non-MLO entity: include directly.
                counts[str(h)] += 1

            if ymaps_scanned % 250 == 0:
                dt = time.time() - start
                print(f"[cw] scanned={ymaps_scanned} loaded={ymaps_loaded} failed={ymaps_failed} dt={dt:.1f}s")

    # Pass 1: current SelectedDlc.
    _scan_current_ymapdict(str(selected_dlc or "__all__"))

    # Optional additional DLC passes (best-effort).
    for lvl in list(also_scan_dlc or []):
        if limit_ymaps and ymaps_scanned >= int(limit_ymaps):
            break
        s = str(lvl or "").strip()
        if not s:
            continue
        try:
            setlvl = getattr(gfc, "SetDlcLevel", None)
        except Exception:
            setlvl = None
        if callable(setlvl):
            try:
                setlvl(str(s), True)
            except Exception:
                continue
            _scan_current_ymapdict(str(s))

    meta = {
        "ymaps_scanned": int(ymaps_scanned),
        "ymaps_loaded": int(ymaps_loaded),
        "ymaps_failed": int(ymaps_failed),
        "dlc_passes": dlc_passes,
        "include_all_entity_sets": bool(include_all_entity_sets),
        "include_mlo_containers": bool(include_mlo_containers),
        "mlo_containers_seen": int(mlo_containers),
        "mlo_children_included": int(mlo_children),
        "mlo_set_children_included": int(mlo_set_children),
        "mlo_set_children_skipped": int(mlo_set_skipped),
    }
    return counts, name_samples, meta


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--assets-dir", default="", help="webgl_viewer/assets folder (auto if omitted)")
    ap.add_argument("--top", type=int, default=50, help="Show top N missing archetypes by occurrence")
    ap.add_argument("--min-count", type=int, default=1, help="Only include archetypes seen at least N times")
    ap.add_argument("--write-json", default="", help="Write missing archetypes JSON (for export_drawables_from_list.py)")

    # Export-side filters
    ap.add_argument("--include-mlo-containers", action="store_true", help="Include MLO container instances in missing-mesh scan (usually not desired).")
    ap.add_argument("--include-all-mlo-entity-sets", action="store_true", help="Include non-default MLO entity-set children (debug/coverage mode).")
    ap.add_argument("--no-use-interiors-defs", action="store_true", help="Do not use assets/interiors/<mlo>.json to resolve default entity-set indices.")

    # Optional CodeWalker parity check
    ap.add_argument("--game-path", default="", help="If set, compare against CodeWalker YMAP enumeration (slow).")
    ap.add_argument("--selected-dlc", default="__all__", help="CodeWalker SelectedDlc for parity check (default: __all__).")
    ap.add_argument("--also-scan-dlc", action="append", default=["patchday27ng"], help="Optional additional DLC levels to scan and union (default: patchday27ng). Can be repeated.")
    ap.add_argument("--limit-ymaps", type=int, default=0, help="Limit YMAPs scanned in CodeWalker parity check (0 = all).")
    ap.add_argument("--cw-include-all-entity-sets", action="store_true", help="In CW parity scan, include ALL MLO entity sets (ignores VisibleOrForced).")
    ap.add_argument("--cw-include-mlo-containers", action="store_true", help="In CW parity scan, include MLO container instances as renderables.")

    args = ap.parse_args()

    assets_dir = auto_assets_dir(args.assets_dir)
    # Validate entities index/chunks exist.
    _ = load_entities_index(assets_dir)

    exported_meshes = _load_exported_mesh_hashes(assets_dir)

    # Export-referenced archetypes (with default entity-set gating).
    counts_ref, name_samples_ref, meta_ref = _iter_referenced_archetypes_from_export(
        assets_dir,
        include_mlo_containers=bool(args.include_mlo_containers),
        include_all_mlo_entity_sets=bool(args.include_all_mlo_entity_sets),
        use_interiors_defs_for_defaults=(not bool(args.no_use_interiors_defs)),
    )

    # Missing meshes: referenced - exported.
    missing_counts = Counter()
    for h, n in counts_ref.items():
        if str(h) not in exported_meshes:
            missing_counts[str(h)] = int(n)

    print("=== Missing mesh archetypes (export-side) ===")
    print(f"assets_dir: {assets_dir}")
    print(f"exported mesh archetypes: {len(exported_meshes)}")
    print(f"referenced archetypes (filtered): {len(counts_ref)}")
    print(f"missing archetypes (filtered): {len(missing_counts)}")
    print(f"filters: include_mlo_containers={meta_ref.get('include_mlo_containers')} include_all_mlo_entity_sets={meta_ref.get('include_all_mlo_entity_sets')} use_interiors_defs_for_defaults={meta_ref.get('use_interiors_defs_for_defaults')}")
    print(f"export scan: skipped_mlo_containers={meta_ref.get('skipped_mlo_containers')} skipped_nondefault_set_children={meta_ref.get('skipped_nondefault_set_children')} unknown_set_defaults={meta_ref.get('unknown_set_defaults')}")
    print("")

    topn = max(0, int(args.top or 0))
    min_count = max(1, int(args.min_count or 1))
    rows = [(h, int(n)) for (h, n) in missing_counts.items() if int(n) >= min_count]
    rows.sort(key=lambda kv: kv[1], reverse=True)
    for h, n in rows[:topn]:
        sample = ""
        if h in name_samples_ref:
            best = [k for k, _v in name_samples_ref[h].most_common(2)]
            if best:
                sample = f" | names: {', '.join(best)}"
        print(f"{h}: {n}{sample}")

    if args.write_json:
        out_path = Path(args.write_json)
        payload = {
            "version": 1,
            "note": "Missing archetype hashes (uint32 strings) not present in assets/models manifest set",
            "assetsDir": str(assets_dir),
            "minCount": min_count,
            "filters": meta_ref,
            "missingTop": [{"hash": h, "count": int(n)} for (h, n) in rows],
        }
        out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(f"\nWrote missing list JSON: {out_path}")

    # Optional parity: compare referenced archetypes vs CodeWalker enumeration.
    game_path = str(args.game_path or "").strip()
    if game_path:
        print("\n=== CodeWalker parity check (referenced archetypes) ===")
        # Reduce CodeWalker init noise; verifier output should be readable.
        logging.getLogger("gta5_modules.dll_manager").setLevel(logging.WARNING)
        cw_counts, _cw_names, cw_meta = _iter_referenced_archetypes_from_codewalker(
            game_path=game_path,
            selected_dlc=str(args.selected_dlc or "__all__"),
            also_scan_dlc=[str(x or "").strip() for x in (args.also_scan_dlc or []) if str(x or "").strip()],
            limit_ymaps=int(args.limit_ymaps or 0),
            include_all_entity_sets=bool(args.cw_include_all_entity_sets),
            include_mlo_containers=bool(args.cw_include_mlo_containers),
        )

        ref_set = set(str(k) for k in counts_ref.keys())
        cw_set = set(str(k) for k in cw_counts.keys())

        only_export = sorted([h for h in ref_set if h not in cw_set])
        only_cw = sorted([h for h in cw_set if h not in ref_set])

        print(f"cw ymaps_scanned={cw_meta.get('ymaps_scanned')} loaded={cw_meta.get('ymaps_loaded')} failed={cw_meta.get('ymaps_failed')}")
        print(f"cw referenced archetypes: {len(cw_set)}")
        print(f"export referenced archetypes (filtered): {len(ref_set)}")
        print(f"in export only (not in CW set): {len(only_export)}")
        print(f"in CW only (not in export set): {len(only_cw)}")

        # Print a small sample of deltas
        if only_cw:
            print("cw-only samples (first 25):")
            for h in only_cw[:25]:
                print(f"  - {h}")
        if only_export:
            print("export-only samples (first 25):")
            for h in only_export[:25]:
                print(f"  - {h}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())



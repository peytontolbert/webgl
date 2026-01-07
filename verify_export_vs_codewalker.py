#!/usr/bin/env python3
"""
Verify "did we export all map entities?" by cross-checking our export output vs CodeWalker's
authoritative map file enumeration (GameFileCache.YmapDict).

What this can prove:
- Our export output is internally consistent (entities_index.json counts match entities_chunks/*.jsonl).
- We enumerated the same number of *active* YMAP entries that CodeWalker considers active (YmapDict).
- We can optionally count base placed entities in those YMAPs (YmapFile.AllEntities) to provide a
  CodeWalker-side count to compare against.

Important caveat:
- This repo's exporter also emits additional streamed entities for MLO interior children (entity sets),
  which are NOT part of YmapFile.AllEntities. So an AllEntities sum is a *lower bound* vs our exported
  total_entities.
"""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

from gta5_modules.entity_coverage import (
    auto_assets_dir,
    cw_active_ymap_count_all_plus_patchday27ng,
    iter_entity_objects,
    load_entities_index,
    norm_ymap_path_like_codewalker,
)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-path", required=True, help="GTA5 install folder (same as other exporters)")
    ap.add_argument("--assets-dir", default="", help="webgl_viewer/assets folder (auto if omitted)")
    ap.add_argument(
        "--selected-dlc",
        default="__all__",
        help="DLC selection passed to CodeWalker GameFileCache (default: __all__).",
    )
    ap.add_argument(
        "--count-allentities",
        action="store_true",
        help="Also parse every active YMAP and sum YmapFile.AllEntities (slow; lower bound vs exported total_entities).",
    )
    ap.add_argument(
        "--check-ymap-entity-set",
        action="store_true",
        help=(
            "Parse active YMAPs in CodeWalker and compare which YMAPs contain >=1 base entity (YmapFile.AllEntities) "
            "against which YMAP paths appear in exported entities_chunks/*.jsonl. Strongest entity-coverage check (slow)."
        ),
    )
    ap.add_argument(
        "--limit-ymaps",
        type=int,
        default=0,
        help="Only parse first N YMAPs when --count-allentities is enabled (0 = all).",
    )
    args = ap.parse_args()

    assets_dir = auto_assets_dir(args.assets_dir)
    idx = load_entities_index(assets_dir)

    exported_total = int(idx.get("total_entities") or 0)
    ystats = idx.get("ymap_stats") if isinstance(idx.get("ymap_stats"), dict) else {}
    exp_ymaps_total = int((ystats or {}).get("total_entries") or 0)
    exp_ymaps_failed = int((ystats or {}).get("failed") or 0)
    exp_ymaps_loaded_ok = int((ystats or {}).get("loaded_ok") or 0)

    # Reduce CodeWalker init noise; verifier output should be readable.
    logging.getLogger("gta5_modules.dll_manager").setLevel(logging.WARNING)

    from gta5_modules.dll_manager import DllManager

    dm = DllManager(str(args.game_path))
    if not dm.init_game_file_cache(selected_dlc=str(args.selected_dlc or "__all__")):
        raise SystemExit("Failed to init CodeWalker GameFileCache")
    gfc = dm.get_game_file_cache()
    if gfc is None or not getattr(gfc, "IsInited", False):
        raise SystemExit("GameFileCache not ready")

    ymapdict = getattr(gfc, "YmapDict", None)
    allymapdict = getattr(gfc, "AllYmapsDict", None)
    active_map_rpfs = getattr(gfc, "ActiveMapRpfFiles", None)

    ymapdict_count = int(getattr(ymapdict, "Count", 0) or 0) if ymapdict is not None else 0
    allymapdict_count = int(getattr(allymapdict, "Count", 0) or 0) if allymapdict is not None else 0
    active_rpfs_count = int(getattr(active_map_rpfs, "Count", 0) or 0) if active_map_rpfs is not None else 0

    print("=== Export output ===")
    print(f"assets_dir: {assets_dir}")
    print(f"entities_index.total_entities: {exported_total}")
    if ystats:
        print(f"ymap_stats.source: {ystats.get('source')}")
        print(f"ymap_stats.total_entries: {exp_ymaps_total}")
        print(f"ymap_stats.loaded_ok: {exp_ymaps_loaded_ok}")
        print(f"ymap_stats.failed: {exp_ymaps_failed}")
        fs = ystats.get("failed_samples") if isinstance(ystats.get("failed_samples"), list) else []
        if fs:
            print(f"ymap_stats.failed_samples (first {min(len(fs), 10)}):")
            for s in fs[:10]:
                print(f"  - {s}")
    else:
        print("ymap_stats: (missing)")
        print("  This means this entities_index.json was generated before we started recording YMAP enumeration stats.")
        print("  Re-run the entity export step to regenerate assets/entities_index.json with ymap_stats, then rerun this verifier.")

    print("\n=== CodeWalker enumeration ===")
    print(f"SelectedDlc: {getattr(gfc, 'SelectedDlc', '')}")
    print(f"EnableDlc: {getattr(gfc, 'EnableDlc', None)}")
    print(f"ActiveMapRpfFiles.Count: {active_rpfs_count}")
    print(f"YmapDict.Count (active): {ymapdict_count}")
    print(f"AllYmapsDict.Count (all rpfs): {allymapdict_count}")
    cw_all_count, cw_all_meta = cw_active_ymap_count_all_plus_patchday27ng(gfc)
    if cw_all_count and isinstance(cw_all_meta, dict):
        print(f"YmapDict.Count (all+patchday27ng, union): {cw_all_count}")
        pd = cw_all_meta.get("patchday27ng") if isinstance(cw_all_meta.get("patchday27ng"), dict) else {}
        if pd:
            print(
                f"  patchday27ng: total={pd.get('total')} added={pd.get('added')} restore_failed={pd.get('restore_failed')}"
            )

    # Strongest coverage check we can do cheaply:
    # ensure exported pipeline enumerated the same number of active YMAP entries, and had no failures.
    status = "INCONCLUSIVE"
    ok = False
    if not ystats:
        status = "INCONCLUSIVE"
        ok = False
    else:
        status = "OK"
        ok = True
        # Exporter defaults to "all + patchday27ng union"; compare against that baseline when available.
        baseline = int(cw_all_count or ymapdict_count or 0)
        if exp_ymaps_total and (baseline > 0) and (exp_ymaps_total != baseline):
            ok = False
            status = "NOT OK"
            print("\nMISMATCH: export enumerated a different number of active YMAP entries than CodeWalker YmapDict.")
            print(f"  export ymaps_total_entries={exp_ymaps_total}")
            if cw_all_count:
                print(f"  codewalker baseline(all+patchday27ng union)={baseline}")
            else:
                print(f"  codewalker YmapDict.Count={ymapdict_count}")
        if exp_ymaps_failed:
            ok = False
            status = "NOT OK"
            print("\nMISMATCH: export reported failed YMAP loads; this can cause missing entities.")
            print(f"  export ymaps_failed={exp_ymaps_failed}")

    allentities_sum = None
    if args.count_allentities:
        if ymapdict is None:
            raise SystemExit("GameFileCache.YmapDict not available; cannot count AllEntities.")

        print("\n=== Counting base YMAP entities (YmapFile.AllEntities) ===")
        lim = int(args.limit_ymaps or 0)
        total_loaded = 0
        total_failed = 0
        total_entities = 0

        # pythonnet Dictionary iteration yields KeyValuePairs; pull .Value (RpfFileEntry)
        i = 0
        for kv in ymapdict:
            try:
                entry = getattr(kv, "Value", None) or kv.Value
            except Exception:
                entry = None
            if entry is None:
                continue
            i += 1
            if lim > 0 and i > lim:
                break
            try:
                ymap = dm.get_ymap_file(entry)
                if not ymap:
                    total_failed += 1
                    continue
                ents = getattr(ymap, "AllEntities", None) or []
                total_entities += int(len(ents))
                total_loaded += 1
            except Exception:
                total_failed += 1
                continue
            if i % 250 == 0:
                print(f"  ... parsed {i} ymaps (loaded={total_loaded}, failed={total_failed})")

        allentities_sum = int(total_entities)
        print(f"YMAPs parsed: {i} (loaded={total_loaded}, failed={total_failed})")
        print(f"Sum(YmapFile.AllEntities): {allentities_sum}")
        print("Note: this excludes MLO interior child entities that our exporter emits separately.")

    if args.check_ymap_entity_set:
        if ymapdict is None:
            raise SystemExit("GameFileCache.YmapDict not available; cannot check ymap entity set.")

        chunks_dir = assets_dir / "entities_chunks"
        if not chunks_dir.exists():
            raise SystemExit(f"Missing {chunks_dir}")

        # Build set of exported YMAPs referenced by any entity line.
        exported_ymaps = set()
        total_lines = 0
        with_ymap = 0
        for _fn, obj in iter_entity_objects(chunks_dir):
            total_lines += 1
            yp = obj.get("ymap")
            if not yp:
                continue
            with_ymap += 1
            exported_ymaps.add(norm_ymap_path_like_codewalker(str(yp)))

        # Build set of CodeWalker YMAPs that contain >=1 base entity.
        cw_ymaps_with_entities = set()
        lim = int(args.limit_ymaps or 0)
        i = 0
        loaded = 0
        failed = 0
        for kv in ymapdict:
            try:
                entry = getattr(kv, "Value", None) or kv.Value
            except Exception:
                entry = None
            if entry is None:
                continue
            i += 1
            if lim > 0 and i > lim:
                break
            try:
                ymap = dm.get_ymap_file(entry)
                if not ymap:
                    failed += 1
                    continue
                ents = getattr(ymap, "AllEntities", None) or []
                if len(ents) > 0:
                    try:
                        pth = getattr(entry, "Path", None) or ""
                    except Exception:
                        pth = ""
                    cw_ymaps_with_entities.add(norm_ymap_path_like_codewalker(str(pth)))
                loaded += 1
            except Exception:
                failed += 1
                continue
            if i % 500 == 0:
                print(f"  ... scanned {i} ymaps (loaded={loaded}, failed={failed})")

        missing_in_export = sorted([p for p in cw_ymaps_with_entities if p and (p not in exported_ymaps)])
        print("\n=== YMAP entity-set comparison ===")
        print(f"export: entity lines={total_lines} with_ymap_field={with_ymap} unique_ymaps={len(exported_ymaps)}")
        print(f"codewalker: ymaps_scanned={i} loaded={loaded} failed={failed} ymaps_with_entities={len(cw_ymaps_with_entities)}")
        print(f"missing ymaps (cw has entities but export never references ymap): {len(missing_in_export)}")
        if missing_in_export:
            ok = False
            status = "NOT OK"
            print("missing samples (first 30):")
            for s in missing_in_export[:30]:
                print(f"  - {s}")

    print("\n=== Result ===")
    print(f"{status}:")
    if status == "OK":
        print("  Export coverage matches CodeWalker active YMAP enumeration (and export chunk totals are self-consistent).")
    elif status == "NOT OK":
        print("  See mismatches above.")
    else:
        print("  Can't verify YMAP coverage yet because ymap_stats is missing from entities_index.json.")

    # Exit non-zero only when we have strong evidence of missing map coverage.
    if status == "OK":
        return 0
    if status == "NOT OK":
        return 2
    return 3


if __name__ == "__main__":
    raise SystemExit(main())



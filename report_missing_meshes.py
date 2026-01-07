#!/usr/bin/env python3
"""
Report which streamed entity archetypes do NOT have exported mesh bins.

This helps answer "why does the map look incomplete?" quickly:
- entities_index.json + entities_chunks/*.jsonl tell you what archetypes exist in the world
- assets/models/manifest.json tells you what archetypes have renderable mesh bins

Usage:
  python webgl/report_missing_meshes.py --assets-dir webgl/webgl_viewer/assets --top 50
"""

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Optional

from gta5_modules.archetype_utils import normalize_archetype_to_hash_str
from gta5_modules.entity_coverage import load_entities_index
from gta5_modules.script_paths import auto_assets_dir

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--assets-dir", default="", help="webgl_viewer/assets folder (auto if omitted)")
    ap.add_argument("--top", type=int, default=50, help="Show top N missing archetypes by occurrence")
    ap.add_argument("--roads-only", action="store_true", help="Only include entities whose Name contains road-ish keywords")
    ap.add_argument(
        "--include-mlo-instances",
        action="store_true",
        help="Include MLO 'container' instances (is_mlo_instance=true). These often have no drawable and are not meant to be rendered as meshes.",
    )
    ap.add_argument("--write-json", default="", help="Write missing archetypes list JSON to this path (for export_drawables_from_list.py)")
    ap.add_argument("--min-count", type=int, default=1, help="Only include archetypes seen at least N times (default=1)")
    args = ap.parse_args()

    assets_dir = auto_assets_dir(args.assets_dir)

    idx_path = assets_dir / "entities_index.json"
    chunks_dir = assets_dir / "entities_chunks"
    models_manifest_path = assets_dir / "models" / "manifest.json"
    if not idx_path.exists():
        raise SystemExit(f"Missing {idx_path} (run extraction + setup_assets.py)")
    if not chunks_dir.exists():
        raise SystemExit(f"Missing {chunks_dir} (run extraction + setup_assets.py)")
    if not models_manifest_path.exists():
        print(f"Warning: missing {models_manifest_path} (no meshes exported yet)")
        exported = set()
    else:
        mm = json.loads(models_manifest_path.read_text(encoding="utf-8"))
        exported = set((mm.get("meshes") or {}).keys())

    idx = load_entities_index(assets_dir)
    chunks = (idx.get("chunks") or {}).keys()

    want_roads = bool(args.roads_only)
    road_words = ("road", "street", "st", "rd", "hwy", "highway", "ave", "avenue", "blvd", "bridge", "freeway")

    total_entities = 0
    total_with_arch = 0
    counts = Counter()
    name_samples: dict[str, Counter] = {}

    include_mlo_instances = bool(args.include_mlo_instances)

    for key in chunks:
        p = chunks_dir / f"{key}.jsonl"
        if not p.exists():
            continue
        for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
            if not line:
                continue
            total_entities += 1
            try:
                obj = json.loads(line)
            except Exception:
                continue

            # MLO "container" instances generally do not have a renderable drawable; their *children* are the meshes.
            # Excluding them keeps the report actionable for "what geometry is missing?".
            if (not include_mlo_instances) and bool(obj.get("is_mlo_instance")):
                continue

            nm = str(obj.get("name") or "")
            if want_roads:
                low = nm.lower()
                if not any(w in low for w in road_words):
                    continue

            arch = obj.get("archetype")
            h = normalize_archetype_to_hash_str(obj)
            if not h:
                continue
            total_with_arch += 1
            if h in exported:
                continue
            counts[h] += 1
            if nm:
                c = name_samples.get(h)
                if c is None:
                    c = Counter()
                    name_samples[h] = c
                c[nm] += 1

    missing_unique = len(counts)
    print(f"Entities scanned: {total_entities}")
    print(f"Entities with numeric archetype: {total_with_arch}")
    print(f"Exported mesh archetypes: {len(exported)}")
    print(f"Missing mesh archetypes: {missing_unique}")
    print("")

    topn = max(0, int(args.top))
    min_count = max(1, int(args.min_count or 1))

    filtered = [(h, n) for (h, n) in counts.items() if int(n) >= min_count]
    filtered.sort(key=lambda kv: kv[1], reverse=True)

    for h, n in filtered[:topn]:
        sample = ""
        if h in name_samples:
            # show up to 2 representative names
            best = [k for k, _v in name_samples[h].most_common(2)]
            if best:
                sample = f" | names: {', '.join(best)}"
        print(f"{h}: {n}{sample}")

    if args.write_json:
        out_path = Path(args.write_json)
        payload = {
            "version": 1,
            "note": "Missing archetype hashes (uint32 strings) not present in assets/models/manifest.json",
            "assetsDir": str(assets_dir),
            "minCount": min_count,
            "missingTop": [{"hash": h, "count": int(n)} for (h, n) in filtered],
        }
        out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(f"\nWrote missing list JSON: {out_path}")


if __name__ == "__main__":
    main()



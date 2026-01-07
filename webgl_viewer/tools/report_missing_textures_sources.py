"""
Report missing model textures and attribute them to source DLC packs (or base game) by
resolving the referencing archetypes to their YTYP source paths via CodeWalker.

Why this exists:
- Some missing textures are truly absent from the GTA install (trimmed install / missing DLC).
- Others come from mod content not mounted in CodeWalker.
- The fastest way to decide which is which is: "which DLC pack do the referencing archetypes come from?"

Input:
- A JSON array in the format written by `tools/out/missing_textures_remaining.json`:
  [
    { "requestedRel": "...", "useCount": <int>, "refs": [{ "archetype_hash": "<u32>", ... }, ...] },
    ...
  ]

Output:
- JSON with:
  - rows: per missing texture, with per-archetype resolved ytyp path + inferred DLC
  - summaryByDlc: aggregate counts by inferred DLC

Usage:
  python3 webgl-gta/webgl_viewer/tools/report_missing_textures_sources.py \
    --gta-path /data/webglgta/gta5 \
    --selected-dlc all \
    --also-scan-dlc patchday27ng \
    --missing webgl-gta/webgl_viewer/tools/out/missing_textures_remaining.json \
    --out webgl-gta/webgl_viewer/tools/out/missing_textures_sources_report.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


_MODEL_TEX_RE = re.compile(r"^models_textures/(?P<hash>\d+)(?:_(?P<slug>[^/]+))?\.png$", re.IGNORECASE)


def _infer_dlc_from_entry_path(p: str) -> str:
    s = str(p or "").strip().lower().replace("/", "\\")
    m = re.search(r"\\dlcpacks\\([^\\]+)\\", s)
    return str(m.group(1) or "").strip().lower() if m else ""


def _safe_u32(x: Any) -> Optional[int]:
    try:
        if x is None:
            return None
        if isinstance(x, int):
            return int(x) & 0xFFFFFFFF
        s = str(x).strip()
        if not s:
            return None
        return int(s, 10) & 0xFFFFFFFF
    except Exception:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gta-path", required=True)
    ap.add_argument(
        "--selected-dlc",
        default="all",
        help="CodeWalker DLC level. Use 'all' to load all DLCs (except patchday27ng unless explicitly selected).",
    )
    ap.add_argument(
        "--also-scan-dlc",
        action="append",
        default=[],
        help="Optional additional DLC levels to try (useful for CodeWalker special cases like patchday27ng).",
    )
    ap.add_argument("--missing", required=True, help="Path to missing_textures_remaining.json")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

    from gta5_modules.dll_manager import DllManager  # noqa
    from gta5_modules.codewalker_archetypes import get_archetype_best_effort  # noqa

    missing_rows = json.loads(Path(args.missing).read_text(encoding="utf-8", errors="ignore"))
    if not isinstance(missing_rows, list):
        raise SystemExit("--missing must be a JSON array")

    dm = DllManager(str(args.gta_path))
    if not getattr(dm, "initialized", False):
        raise SystemExit("DllManager failed to init")
    dm.init_game_file_cache(selected_dlc=str(args.selected_dlc), load_vehicles=False, load_peds=False, load_audio=False)
    gfc = dm.get_game_file_cache()
    if gfc is None or not getattr(gfc, "IsInited", False):
        raise SystemExit("GameFileCache not inited")

    # Optional extra DLC passes (eg patchday27ng).
    extra_levels = [str(x or "").strip() for x in (args.also_scan_dlc or []) if str(x or "").strip()]

    out_rows: List[Dict[str, Any]] = []
    dlc_summary: Dict[str, Dict[str, int]] = defaultdict(lambda: {"textureCount": 0, "totalUseCount": 0})

    for r in missing_rows:
        if not isinstance(r, dict):
            continue
        requested_rel = str(r.get("requestedRel") or "").strip()
        m = _MODEL_TEX_RE.match(requested_rel)
        if not m:
            continue
        tex_hash = int(m.group("hash")) & 0xFFFFFFFF
        use_count = int(r.get("useCount") or 0)
        refs = r.get("refs") if isinstance(r.get("refs"), list) else []

        # Resolve unique archetype hashes.
        seen_arch: set[int] = set()
        arch_infos: List[Dict[str, Any]] = []
        inferred_dlcs: Dict[str, int] = defaultdict(int)

        for ref in refs:
            if not isinstance(ref, dict):
                continue
            ah = _safe_u32(ref.get("archetype_hash"))
            if ah is None:
                continue
            if ah in seen_arch:
                continue
            seen_arch.add(ah)

            arch = get_archetype_best_effort(
                gfc,
                int(ah) & 0xFFFFFFFF,
                dll_manager=dm,
                also_scan_dlc_levels=extra_levels,
            )

            arch_name = None
            ytyp_entry_path = None
            inferred_dlc = None
            try:
                arch_name = str(getattr(arch, "Name", None)) if arch is not None else None
            except Exception:
                arch_name = None

            try:
                ytyp = getattr(arch, "Ytyp", None) if arch is not None else None
                ent = getattr(ytyp, "RpfFileEntry", None) if ytyp is not None else None
                ytyp_entry_path = str(getattr(ent, "Path", None)) if ent is not None else None
            except Exception:
                ytyp_entry_path = None

            if ytyp_entry_path:
                inferred_dlc = _infer_dlc_from_entry_path(ytyp_entry_path) or ""
                # Treat "no dlcpacks segment" as base game rather than unknown.
                if inferred_dlc == "":
                    inferred_dlc = "base"
                inferred_dlcs[inferred_dlc] += 1

            arch_infos.append(
                {
                    "archetypeHash": int(ah),
                    "archetypeName": arch_name,
                    "ytypEntryPath": ytyp_entry_path,
                    "inferredDlc": inferred_dlc,
                }
            )

        # Choose top inferred DLC (by count); empty means "unknown/base".
        top_dlc = ""
        top_cnt = 0
        for dlc, cnt in sorted(inferred_dlcs.items(), key=lambda kv: (-kv[1], kv[0])):
            top_dlc, top_cnt = dlc, int(cnt)
            break

        out_rows.append(
            {
                "requestedRel": requested_rel,
                "texHash": int(tex_hash),
                "slug": str(m.group("slug") or ""),
                "useCount": use_count,
                "refArchetypeCount": len(seen_arch),
                "topInferredDlc": top_dlc or None,
                "topInferredDlcRefCount": int(top_cnt),
                "archetypes": arch_infos,
            }
        )

        key = top_dlc or "unknown"
        dlc_summary[key]["textureCount"] += 1
        dlc_summary[key]["totalUseCount"] += int(use_count)

    # Sort output rows by importance.
    out_rows.sort(key=lambda x: (-int(x.get("useCount") or 0), str(x.get("requestedRel") or "")))
    summary_sorted = dict(sorted(dlc_summary.items(), key=lambda kv: (-kv[1]["textureCount"], kv[0])))

    payload = {
        "schema": "webglgta-missing-textures-sources-report-v1",
        "selectedDlc": str(args.selected_dlc),
        "alsoScanDlc": list(extra_levels),
        "missingInput": str(args.missing),
        "summaryByDlc": summary_sorted,
        "rows": out_rows,
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"wrote {out_path} rows={len(out_rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



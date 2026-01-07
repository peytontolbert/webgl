"""
Generate / verify WebGL viewer asset packs against CodeWalker DLC list.

Why:
  CodeWalker discovers DLC packs from dlclist.xml (update\\update.rpf\\common\\data\\dlclist.xml).
  The WebGL viewer does not mount RPFS; it only serves exported assets under /assets.

  To mimic "base + DLC overlay" behavior, the viewer supports optional `assets/asset_packs.json`
  which lists pack roots (e.g. assets/packs/<dlcname>/...) and a priority order.

This tool:
  - Initializes CodeWalker GameFileCache (via Python.NET) and reads `GameFileCache.DlcNameList`.
  - Compares it to `webgl_viewer/assets/asset_packs.json` if present.
  - Optionally writes a packs file that includes *all* DLCs CodeWalker knows about.

Usage:
  python3 webgl-gta/webgl_viewer/tools/write_asset_packs_from_codewalker.py \
    --gta-path /data/webglgta/gta5 \
    --write
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import List, Optional, Set, Tuple

# Import repo modules without installation
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from gta5_modules.dll_manager import DllManager


def _dotnet_list_to_str_list(x) -> List[str]:
    out: List[str] = []
    if x is None:
        return out
    try:
        # pythonnet IList<string> is often iterable...
        for v in x:
            s = str(v or "").strip()
            if s:
                out.append(s)
        if out:
            return out
    except Exception:
        pass
    # ...but on some builds, iteration doesn't work; fall back to Count + indexer.
    try:
        n = int(getattr(x, "Count"))
    except Exception:
        n = 0
    if n <= 0:
        return out
    for i in range(n):
        try:
            v = x[i]
        except Exception:
            continue
        s = str(v or "").strip()
        if s:
            out.append(s)
    return out


def _parse_dlclist_xml_text(xml_text: str) -> List[str]:
    """
    Parse dlclist.xml content and return dlc pack names (lowercase), e.g.:
      dlcpacks:/mpbeach/  -> mpbeach
      dlcpacks:\\mptuner\\ -> mptuner
    """
    t = str(xml_text or "").strip()
    if not t:
        return []
    try:
        root = ET.fromstring(t)
    except Exception:
        return []

    out: List[str] = []
    # CodeWalker dlclist.xml format:
    # <SMandatoryPacksData><Paths><Item>dlcpacks:/mpbeach/</Item> ... </Paths></SMandatoryPacksData>
    for el in root.iter():
        if el.tag.lower().endswith("item"):
            v = (el.text or "").strip()
            if not v:
                continue
            s = v.strip().lower().replace("\\", "/")
            if "dlcpacks:" not in s:
                continue
            # Remove prefix up to dlcpacks:
            s = s.split("dlcpacks:", 1)[1]
            s = s.strip().lstrip("/").lstrip(":").lstrip("/")
            # first segment is dlc name
            seg = s.split("/", 1)[0].strip()
            if seg:
                out.append(seg)
    # de-dupe preserving order
    seen: Set[str] = set()
    uniq: List[str] = []
    for s in out:
        if s in seen:
            continue
        seen.add(s)
        uniq.append(s)
    return uniq


def _fmt_bool(x) -> str:
    try:
        return "true" if bool(x) else "false"
    except Exception:
        return "?"


def _try_get_count(x) -> int:
    if x is None:
        return 0
    try:
        return int(getattr(x, "Count"))
    except Exception:
        try:
            return int(len(x))  # type: ignore[arg-type]
        except Exception:
            return 0


def _load_existing_packs(assets_dir: Path) -> Tuple[Optional[dict], List[dict]]:
    p = assets_dir / "asset_packs.json"
    if not p.exists():
        return None, []
    try:
        obj = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return None, []
    packs = obj.get("packs") if isinstance(obj, dict) else None
    if not isinstance(packs, list):
        return obj if isinstance(obj, dict) else None, []
    out: List[dict] = []
    for ent in packs:
        if isinstance(ent, dict):
            out.append(ent)
    return obj if isinstance(obj, dict) else None, out


def _write_packs(assets_dir: Path, dlc_names: List[str], pack_root_prefix: str, base_priority: int) -> Path:
    packs = []
    # Highest priority = last DLC in list (typically newest). We make it monotonic increasing.
    for i, name in enumerate(dlc_names):
        pr = int(base_priority) + i
        packs.append(
            {
                "id": name,
                "rootRel": f"{pack_root_prefix.rstrip('/')}/{name}",
                "priority": pr,
                "enabled": True,
            }
        )
    out = {
        "schema": "webglgta-asset-packs-v1",
        "generatedAtUnix": int(time.time()),
        "packs": packs,
    }
    assets_dir.mkdir(parents=True, exist_ok=True)
    tmp = assets_dir / "asset_packs.json.tmp"
    dst = assets_dir / "asset_packs.json"
    tmp.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(dst)
    return dst


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gta-path", required=True)
    ap.add_argument("--assets-dir", default="", help="defaults to webgl_viewer/assets next to this script")
    ap.add_argument("--pack-root-prefix", default="packs", help="pack root within assets/ (default: packs)")
    ap.add_argument("--base-priority", type=int, default=1000, help="priority for first DLC; later DLCs increase")
    ap.add_argument("--write", action="store_true", help="write assets/asset_packs.json containing all CodeWalker DLCs")
    ap.add_argument("--include-update", action="store_true", help="also include a pseudo-pack id 'update' (optional)")
    args = ap.parse_args()

    viewer_root = Path(__file__).resolve().parents[1]
    assets_dir = Path(args.assets_dir) if args.assets_dir else (viewer_root / "assets")

    dm = DllManager(str(args.gta_path))
    if not getattr(dm, "initialized", False):
        raise SystemExit("DllManager failed to init.")

    # DLC list is built during GameFileCache.Init when EnableDlc is true.
    # Use 'all' sentinel to ensure DLC is enabled.
    ok = dm.init_game_file_cache(selected_dlc="all", load_vehicles=False, load_peds=False, load_audio=False)
    if not ok:
        raise SystemExit("Failed to init GameFileCache.")
    gfc = dm.get_game_cache()
    if gfc is None or not getattr(gfc, "IsInited", False):
        raise SystemExit("GameFileCache not inited.")

    # Diagnostics: DLC state + ability to read dlclist.xml.
    try:
        print("GameFileCache.EnableDlc:", _fmt_bool(getattr(gfc, "EnableDlc", None)))
        print("GameFileCache.SelectedDlc:", str(getattr(gfc, "SelectedDlc", "") or ""))
    except Exception:
        pass
    try:
        rpfman = getattr(gfc, "RpfMan", None)
        if rpfman is not None and hasattr(rpfman, "GetFileXml"):
            # This is the canonical CodeWalker DLC list path.
            dlc_xml = rpfman.GetFileXml("update\\update.rpf\\common\\data\\dlclist.xml")
            print("RpfMan.GetFileXml(dlclist.xml):", "ok" if dlc_xml is not None else "NULL")
            if dlc_xml is not None:
                try:
                    de = getattr(dlc_xml, "DocumentElement", None)
                    den = str(getattr(de, "Name", "") or "") if de is not None else ""
                    print("dlclist.xml root:", den or "(null)")
                except Exception:
                    pass
                try:
                    # Prefer XPath to count items, but this can fail on some pythonnet builds.
                    nodes = dlc_xml.SelectNodes("//Item")
                    n = _try_get_count(nodes)
                    print("dlclist.xml //Item count:", n)
                    # Show first few inner texts
                    shown = 0
                    if nodes is not None:
                        for node in nodes:
                            try:
                                t = str(getattr(node, "InnerText", "") or "").strip()
                            except Exception:
                                t = ""
                            if t:
                                print("  Item:", t)
                                shown += 1
                            if shown >= 8:
                                break
                except Exception:
                    pass
    except Exception:
        pass
    try:
        print("DlcPaths count:", _try_get_count(getattr(gfc, "DlcPaths", None)))
        print("DlcSetupFiles count:", _try_get_count(getattr(gfc, "DlcSetupFiles", None)))
        print("DlcRpfs count:", _try_get_count(getattr(gfc, "DlcRpfs", None)))
        print("DlcActiveRpfs count:", _try_get_count(getattr(gfc, "DlcActiveRpfs", None)))
    except Exception:
        pass

    dlc_names = _dotnet_list_to_str_list(getattr(gfc, "DlcNameList", None))
    dlc_names = [s.lower().strip() for s in dlc_names if str(s or "").strip()]

    # On some Linux/pythonnet builds, DlcNameList can come back empty even when dlclist.xml is readable.
    # Fall back to parsing dlclist.xml ourselves via GetFileUTF8Text (pure-Python XML parsing).
    if not dlc_names:
        try:
            if rpfman is not None and hasattr(rpfman, "GetFileUTF8Text"):
                txt = rpfman.GetFileUTF8Text(r"update\update.rpf\common\data\dlclist.xml")
                dlc_names = _parse_dlclist_xml_text(str(txt or ""))
        except Exception:
            dlc_names = []
    # De-dupe while preserving order.
    seen: Set[str] = set()
    uniq: List[str] = []
    for s in dlc_names:
        if s in seen:
            continue
        seen.add(s)
        uniq.append(s)
    dlc_names = uniq

    if args.include_update and "update" not in dlc_names:
        dlc_names = ["update"] + dlc_names

    existing_obj, existing_packs = _load_existing_packs(assets_dir)
    existing_ids = {str(p.get("id") or "").strip().lower() for p in existing_packs if isinstance(p, dict)}
    missing_in_packs = [d for d in dlc_names if d not in existing_ids]
    extra_in_packs = sorted([x for x in existing_ids if x and x not in set(dlc_names)])

    print(f"CodeWalker DLCs: {len(dlc_names)}")
    if dlc_names:
        print("  first:", dlc_names[0], "last:", dlc_names[-1])
    if existing_obj is None:
        print(f"Viewer asset_packs.json: (missing) at {assets_dir / 'asset_packs.json'}")
    else:
        print(f"Viewer asset_packs.json: packs={len(existing_packs)} at {assets_dir / 'asset_packs.json'}")
    print(f"Missing in viewer packs: {len(missing_in_packs)}")
    if missing_in_packs:
        print("  sample:", missing_in_packs[:25])
    print(f"Extra in viewer packs (not in CodeWalker list): {len(extra_in_packs)}")
    if extra_in_packs:
        print("  sample:", extra_in_packs[:25])

    if args.write:
        dst = _write_packs(
            assets_dir=assets_dir,
            dlc_names=dlc_names,
            pack_root_prefix=str(args.pack_root_prefix or "packs"),
            base_priority=int(args.base_priority),
        )
        print(f"Wrote {dst} with {len(dlc_names)} packs.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())



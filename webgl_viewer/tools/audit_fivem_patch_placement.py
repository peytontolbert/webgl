#!/usr/bin/env python3
"""Resolve loose FiveM YTYP archetypes against active GTA YMAP placements."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from gta5_modules.dll_manager import DllManager


def _u32(value: Any) -> int:
    try:
        return int(value) & 0xFFFFFFFF
    except (TypeError, ValueError):
        return 0


def _vec(value: Any, fields: tuple[str, ...]) -> list[float]:
    return [float(getattr(value, field, 0.0) or 0.0) for field in fields]


def _entry_path(entry: Any) -> str:
    return str(getattr(entry, "Path", "") or getattr(entry, "Name", "") or "")


def _load_ymap(dll: DllManager, entry: Any) -> Any:
    try:
        return dll.rpf_manager.GetFile[dll.YmapFile](entry)
    except Exception:
        return None


def _load_ytyp(dll: DllManager, entry: Any) -> Any:
    try:
        return dll.rpf_manager.GetFile[dll.YtypFile](entry)
    except Exception:
        return None


def _extract_entry(entry: Any, target: Path) -> int:
    owner = getattr(entry, "File", None)
    payload = owner.ExtractFile(entry) if owner is not None else None
    if payload is None:
        raise RuntimeError(f"Could not extract {_entry_path(entry)}")
    data = bytes(payload)
    target.write_bytes(data)
    return len(data)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-path", type=Path, required=True)
    parser.add_argument("--resource-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--extract-ymap-dir", type=Path, required=True)
    args = parser.parse_args()

    resource_dir = args.resource_dir.resolve()
    output = args.output.resolve()
    extract_dir = args.extract_ymap_dir.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    extract_dir.mkdir(parents=True, exist_ok=True)

    logging.disable(logging.CRITICAL)
    dll = DllManager(str(args.game_path.resolve()))
    if not getattr(dll, "initialized", False):
        raise RuntimeError("CodeWalker initialization failed")

    archetypes: list[dict[str, Any]] = []
    hashes: set[int] = set()
    for path in sorted(resource_dir.rglob("*.ytyp")):
        ytyp = dll.YtypFile()
        ytyp.Load(path.read_bytes())
        for archetype in list(getattr(ytyp, "AllArchetypes", None) or []):
            base = getattr(archetype, "BaseArchetypeDef", None)
            name_hash = _u32(getattr(getattr(base, "name", None), "Hash", 0))
            asset_hash = _u32(getattr(getattr(base, "assetName", None), "Hash", 0))
            if not name_hash:
                name_hash = asset_hash
            if not name_hash:
                continue
            hashes.add(name_hash)
            archetypes.append({
                "sourceYtyp": str(path.relative_to(resource_dir)).replace("\\", "/"),
                "nameHash": str(name_hash),
                "assetHash": str(asset_hash),
                "type": type(archetype).__name__,
                "isMlo": type(archetype).__name__ == "MloArchetype",
                "textureDictionaryHash": str(_u32(getattr(getattr(base, "textureDictionary", None), "Hash", 0))),
                "bbMin": _vec(getattr(base, "bbMin", None), ("X", "Y", "Z")),
                "bbMax": _vec(getattr(base, "bbMax", None), ("X", "Y", "Z")),
            })

    if not hashes:
        raise RuntimeError("The resource YTYP files contain no archetypes")
    if not dll.init_game_file_cache():
        raise RuntimeError("GTA GameFileCache initialization failed")
    cache = dll.get_game_file_cache()
    if cache is None:
        raise RuntimeError("GTA GameFileCache is unavailable")

    ymap_dict = getattr(cache, "YmapDict", None)
    if ymap_dict is None:
        raise RuntimeError("GTA GameFileCache has no active YMAP dictionary")

    matches: list[dict[str, Any]] = []
    extracted: dict[str, dict[str, Any]] = {}
    scanned = 0
    for pair in ymap_dict:
        entry = getattr(pair, "Value", None)
        if entry is None:
            continue
        scanned += 1
        ymap = _load_ymap(dll, entry)
        if ymap is None:
            continue
        entity_matches = []
        for entity in list(getattr(ymap, "AllEntities", None) or []):
            definition = getattr(entity, "_CEntityDef", None)
            archetype_hash = _u32(getattr(getattr(definition, "archetypeName", None), "Hash", 0))
            if archetype_hash not in hashes:
                continue
            entity_matches.append({
                "index": int(getattr(entity, "Index", -1)),
                "archetypeHash": str(archetype_hash),
                "position": _vec(getattr(entity, "Position", None), ("X", "Y", "Z")),
                "rotation": _vec(getattr(definition, "rotation", None), ("X", "Y", "Z", "W")),
                "isMloInstance": bool(getattr(entity, "IsMlo", False)),
                "guid": _u32(getattr(definition, "guid", 0)),
            })
        if not entity_matches:
            continue
        source = _entry_path(entry)
        name = str(getattr(entry, "Name", "") or Path(source).name or f"matched_{len(extracted)}.ymap")
        key = source.lower() or name.lower()
        if key not in extracted:
            target = extract_dir / name
            if target.exists():
                target = extract_dir / f"{len(extracted):03d}_{name}"
            extracted[key] = {
                "source": source,
                "file": str(target),
                "bytes": _extract_entry(entry, target),
            }
        matches.append({"sourceYmap": source, "entities": entity_matches})

    mlo_child_matches: list[dict[str, Any]] = []
    ytyp_scanned = 0
    ytyp_dict = getattr(cache, "YtypDict", None)
    if ytyp_dict is not None:
        for pair in ytyp_dict:
            entry = getattr(pair, "Value", None)
            if entry is None:
                continue
            ytyp_scanned += 1
            ytyp = _load_ytyp(dll, entry)
            if ytyp is None:
                continue
            for archetype in list(getattr(ytyp, "AllArchetypes", None) or []):
                if type(archetype).__name__ != "MloArchetype":
                    continue
                definition = getattr(archetype, "BaseArchetypeDef", None)
                root_hash = _u32(getattr(getattr(definition, "name", None), "Hash", 0))
                children = []
                for index, child in enumerate(list(getattr(archetype, "entities", None) or [])):
                    child_definition = getattr(child, "_Data", None)
                    child_hash = _u32(getattr(getattr(child_definition, "archetypeName", None), "Hash", 0))
                    if child_hash in hashes:
                        children.append({"index": index, "archetypeHash": str(child_hash)})
                if children:
                    mlo_child_matches.append({
                        "sourceYtyp": _entry_path(entry),
                        "mloArchetypeHash": str(root_hash),
                        "children": children,
                    })

    report = {
        "schema": "webglgta-fivem-patch-placement-audit-v1",
        "resourceDir": str(resource_dir),
        "gamePath": str(args.game_path.resolve()),
        "archetypes": archetypes,
        "archetypeCount": len(archetypes),
        "mloArchetypeCount": sum(bool(item["isMlo"]) for item in archetypes),
        "activeYmapsScanned": scanned,
        "matchedYmapCount": len(extracted),
        "matchedEntityCount": sum(len(item["entities"]) for item in matches),
        "activeYtypsScanned": ytyp_scanned,
        "matchedMloArchetypeCount": len(mlo_child_matches),
        "matchedMloChildCount": sum(len(item["children"]) for item in mlo_child_matches),
        "matches": matches,
        "mloChildMatches": mlo_child_matches,
        "extractedYmaps": list(extracted.values()),
    }
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in (
        "archetypeCount", "mloArchetypeCount", "activeYmapsScanned", "matchedYmapCount", "matchedEntityCount",
        "activeYtypsScanned", "matchedMloArchetypeCount", "matchedMloChildCount"
    )}, indent=2))
    return 0 if matches or mlo_child_matches else 2


if __name__ == "__main__":
    raise SystemExit(main())

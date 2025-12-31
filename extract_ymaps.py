#!/usr/bin/env python3
"""
Bulk YMAP extraction + parsing using the bundled CodeWalker.Core (via pythonnet).

Outputs (under --output-dir):
- output/ymap/raw/**               Raw .ymap files extracted from RPFs (path-preserving)
- output/ymap/entities/*.json      Per-YMAP entity data (CEntityDefs + optional extras)
- output/ymap/ymap_index.json      Manifest (paths, output files, counts)

This is the implementation for checklist section:
  docs/extraction_pipeline_checklist.md -> "2) YMAPs (world placements / entities)"
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

import dotenv

from gta5_modules.dll_manager import DllManager
from gta5_modules.hash import jenkins_hash


_SAFE_PATH_RE = re.compile(r"[^a-zA-Z0-9._/\-]+")


def _norm_archive_path(p: str) -> str:
    # CodeWalker paths are Windows-style.
    return p.replace("\\", "/")


def _safe_relpath(p: str) -> str:
    """
    Convert an RPF internal path into a safe relative filesystem path.
    Keeps '/' so directory structure is preserved.
    """
    p = _norm_archive_path(p).lstrip("/")
    p = _SAFE_PATH_RE.sub("_", p)
    # Avoid accidental absolute paths or parent traversal.
    p = p.replace("..", "_")
    return p


def _vector3_to_list(v: Any) -> List[float]:
    return [float(getattr(v, "X", 0.0)), float(getattr(v, "Y", 0.0)), float(getattr(v, "Z", 0.0))]


def _vector3_like_to_list(v: Any) -> List[float]:
    """
    Best-effort conversion for CodeWalker structs that sometimes expose ToVector3().
    """
    if v is None:
        return [0.0, 0.0, 0.0]
    try:
        tv3 = getattr(v, "ToVector3", None)
        if callable(tv3):
            return _vector3_to_list(tv3())
    except Exception:
        pass
    return _vector3_to_list(v)


def _array_of_ushorts3_to_list(v: Any) -> List[int]:
    """
    CodeWalker often uses ArrayOfUshorts3 with fields u0/u1/u2, but pythonnet exposure varies.
    """
    if v is None:
        return [0, 0, 0]
    for a, b, c in (("u0", "u1", "u2"), ("X", "Y", "Z")):
        try:
            return [int(getattr(v, a, 0)), int(getattr(v, b, 0)), int(getattr(v, c, 0))]
        except Exception:
            continue
    return [0, 0, 0]


def _vector4_to_quat_wxyz(v: Any) -> List[float]:
    """
    CodeWalker stores rotation as Vector4 (x,y,z,w). For consistency with our Python
    quaternion math (and docs), export as [w,x,y,z].
    """
    x = float(getattr(v, "X", 0.0))
    y = float(getattr(v, "Y", 0.0))
    z = float(getattr(v, "Z", 0.0))
    w = float(getattr(v, "W", 1.0))
    return [w, x, y, z]


def _quat_normalize_wxyz(q: List[float]) -> List[float]:
    w, x, y, z = q
    n2 = (w * w) + (x * x) + (y * y) + (z * z)
    if n2 <= 0.0:
        return [1.0, 0.0, 0.0, 0.0]
    inv = 1.0 / math.sqrt(n2)
    return [w * inv, x * inv, y * inv, z * inv]


def _quat_rotate_vec3_wxyz(q: List[float], v: List[float]) -> List[float]:
    """
    Rotate vector v by quaternion q (wxyz).
    Uses v' = q * (0,v) * conj(q).
    """
    w, x, y, z = q
    vx, vy, vz = v

    # q * (0,v)
    rw = -(x * vx + y * vy + z * vz)
    rx = (w * vx) + (y * vz) - (z * vy)
    ry = (w * vy) + (z * vx) - (x * vz)
    rz = (w * vz) + (x * vy) - (y * vx)

    # (q*(0,v)) * conj(q)
    # conj(q) = (w, -x, -y, -z)
    ox = (rx * w) + (rw * -x) + (ry * -z) - (rz * -y)
    oy = (ry * w) + (rw * -y) + (rz * -x) - (rx * -z)
    oz = (rz * w) + (rw * -z) + (rx * -y) - (ry * -x)
    return [ox, oy, oz]


def _quat_to_heading_deg_wxyz(q: List[float]) -> float:
    """
    Convert quaternion (wxyz) to GTA/FiveM heading degrees.

    GTA convention: heading is yaw around +Z, with 0 deg facing +Y (north) and 90 deg facing +X (east).
    We compute the world forward vector by rotating local +Y and then heading = atan2(fwd.x, fwd.y).
    """
    qn = _quat_normalize_wxyz(q)
    fwd = _quat_rotate_vec3_wxyz(qn, [0.0, 1.0, 0.0])  # local forward is +Y
    fx, fy, _fz = fwd
    hdg = math.degrees(math.atan2(fx, fy))
    return (hdg + 360.0) % 360.0


def _try_get_mapdata(ymap: Any) -> Any:
    md = getattr(ymap, "_CMapData", None)
    if md is None:
        md = getattr(ymap, "CMapData", None)
    return md


def _mapdata_to_dto(md: Any) -> Dict[str, Any]:
    if md is None:
        return {}
    return {
        "nameHash": int(_meta_hash_to_uint(getattr(md, "name", 0))),
        "parentHash": int(_meta_hash_to_uint(getattr(md, "parent", 0))),
        "flags": int(getattr(md, "flags", 0)),
        "contentFlags": int(getattr(md, "contentFlags", 0)),
        "streamingExtentsMin": _vector3_to_list(getattr(md, "streamingExtentsMin", None)),
        "streamingExtentsMax": _vector3_to_list(getattr(md, "streamingExtentsMax", None)),
        "entitiesExtentsMin": _vector3_to_list(getattr(md, "entitiesExtentsMin", None)),
        "entitiesExtentsMax": _vector3_to_list(getattr(md, "entitiesExtentsMax", None)),
    }


def _meta_hash_to_uint(h: Any) -> int:
    # MetaHash has implicit conversion to uint in CodeWalker; pythonnet usually supports int().
    try:
        return int(h)
    except Exception:
        # Fallback: try Hash property
        try:
            return int(getattr(h, "Hash", 0))
        except Exception:
            return 0


def _unique_entity_json_name(ymap_path: str, used: Set[str]) -> str:
    """
    Prefer <ymap_stem>.json, but avoid collisions by suffixing a stable hash.
    """
    stem = Path(_norm_archive_path(ymap_path)).name
    if stem.lower().endswith(".ymap"):
        stem = stem[:-5]
    candidate = f"{stem}.json"
    if candidate not in used:
        used.add(candidate)
        return candidate
    suffix = f"{jenkins_hash(_norm_archive_path(ymap_path)) & 0xFFFFFFFF:08x}"
    candidate2 = f"{stem}__{suffix}.json"
    used.add(candidate2)
    return candidate2


def _iter_ymap_paths(rpf_manager: Any) -> List[str]:
    paths: List[str] = []
    for rpf in getattr(rpf_manager, "AllRpfs", []) or []:
        entries = getattr(rpf, "AllEntries", None)
        if not entries:
            continue
        for entry in entries:
            try:
                name = getattr(entry, "Name", "")
                if isinstance(name, str) and name.lower().endswith(".ymap"):
                    paths.append(str(getattr(entry, "Path", "")))
            except Exception:
                continue
    # Stable order helps verify repeatability.
    paths = [p for p in paths if p]
    paths.sort()
    return paths


def _export_raw_ymap(*, rpf_manager: Any, ymap_path: str, raw_root: Path) -> Optional[Path]:
    data = rpf_manager.GetFileData(ymap_path)
    if not data:
        return None
    out_path = raw_root / _safe_relpath(ymap_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(bytes(data))
    return out_path


def _export_entities_json(
    *,
    dll_manager: DllManager,
    ymap_path: str,
    out_path: Path,
    spawn_archetypes: Set[str],
    include_grass_instances: bool,
    include_lod_lights: bool,
) -> Dict[str, Any]:
    ymap = dll_manager.get_ymap_file(ymap_path)
    if not ymap:
        raise RuntimeError(f"Failed to load YMAP: {ymap_path}")

    # Map header data (streaming extents etc.)
    md = _try_get_mapdata(ymap)
    mapdata_dto = _mapdata_to_dto(md)

    # Core entity list
    entities: List[Dict[str, Any]] = []
    spawnpoints: List[Dict[str, Any]] = []
    cdefs = getattr(ymap, "CEntityDefs", None)
    if cdefs is not None:
        for i, cdef in enumerate(cdefs):
            archetype_name = str(getattr(cdef, "archetypeName", ""))
            archetype_hash = _meta_hash_to_uint(getattr(cdef, "archetypeName", 0))
            rot_wxyz = _vector4_to_quat_wxyz(getattr(cdef, "rotation", None))
            ent = {
                "index": int(i),
                "archetypeName": archetype_name,
                "archetypeHash": int(archetype_hash),
                "guid": int(getattr(cdef, "guid", 0)),
                "position": _vector3_to_list(getattr(cdef, "position", None)),
                "rotation": rot_wxyz,
                "scale": [float(getattr(cdef, "scaleXY", 1.0)), float(getattr(cdef, "scaleXY", 1.0)), float(getattr(cdef, "scaleZ", 1.0))],
                "flags": int(getattr(cdef, "flags", 0)),
                "lodDist": float(getattr(cdef, "lodDist", 0.0)),
                "parentIndex": int(getattr(cdef, "parentIndex", -1)),
                # Optional but very useful for streaming/LOD parity with CW.
                "childLodDist": float(getattr(cdef, "childLodDist", 0.0)),
                "lodLevel": str(getattr(getattr(cdef, "lodLevel", None), "ToString", lambda: getattr(cdef, "lodLevel", 0))()),
                "numChildren": int(getattr(cdef, "numChildren", 0)),
                "priorityLevel": str(getattr(getattr(cdef, "priorityLevel", None), "ToString", lambda: getattr(cdef, "priorityLevel", 0))()),
            }
            entities.append(ent)

            # Optional player spawn marker extraction:
            # treat certain archetypeName values as spawn markers.
            if spawn_archetypes and (archetype_name in spawn_archetypes):
                pos = ent["position"]
                spawnpoints.append(
                    {
                        "x": float(pos[0]),
                        "y": float(pos[1]),
                        "z": float(pos[2]),
                        "heading": float(_quat_to_heading_deg_wxyz(rot_wxyz)),
                        "ymap": ymap_path,
                        "entityIndex": int(i),
                        "archetypeName": archetype_name,
                        "archetypeHash": int(archetype_hash),
                        "guid": int(ent["guid"]),
                    }
                )

    # Optional extras
    mlo_instances: List[Dict[str, Any]] = []
    mlos = getattr(ymap, "CMloInstanceDefs", None)
    if mlos is not None:
        for i, mlo in enumerate(mlos):
            cdef = getattr(mlo, "CEntityDef", None)
            if cdef is None:
                continue
            archetype_name = str(getattr(cdef, "archetypeName", ""))
            archetype_hash = _meta_hash_to_uint(getattr(cdef, "archetypeName", 0))

            # defaultEntitySets is an Array_uint; pythonnet may or may not iterate it directly.
            des = getattr(mlo, "defaultEntitySets", None)
            des_count = int(getattr(des, "Count1", 0)) if des is not None else 0

            mlo_instances.append(
                {
                    "index": int(i),
                    "groupId": int(getattr(mlo, "groupId", 0)),
                    "floorId": int(getattr(mlo, "floorId", 0)),
                    "defaultEntitySetsCount": des_count,
                    "numExitPortals": int(getattr(mlo, "numExitPortals", 0)),
                    "mloFlags": int(getattr(mlo, "MLOInstflags", 0)),
                    "entity": {
                        "archetypeName": archetype_name,
                        "archetypeHash": int(archetype_hash),
                        "guid": int(getattr(cdef, "guid", 0)),
                        "position": _vector3_to_list(getattr(cdef, "position", None)),
                        "rotation": _vector4_to_quat_wxyz(getattr(cdef, "rotation", None)),
                        "scale": [
                            float(getattr(cdef, "scaleXY", 1.0)),
                            float(getattr(cdef, "scaleXY", 1.0)),
                            float(getattr(cdef, "scaleZ", 1.0)),
                        ],
                        "flags": int(getattr(cdef, "flags", 0)),
                        "lodDist": float(getattr(cdef, "lodDist", 0.0)),
                        "parentIndex": int(getattr(cdef, "parentIndex", -1)),
                    },
                }
            )

    car_gens: List[Dict[str, Any]] = []
    cargens = getattr(ymap, "CCarGens", None)
    if cargens is not None:
        for i, cg in enumerate(cargens):
            car_model = getattr(cg, "carModel", 0)
            pop_group = getattr(cg, "popGroup", 0)
            car_gens.append(
                {
                    "index": int(i),
                    "position": _vector3_to_list(getattr(cg, "position", None)),
                    "orientX": float(getattr(cg, "orientX", 0.0)),
                    "orientY": float(getattr(cg, "orientY", 0.0)),
                    "perpendicularLength": float(getattr(cg, "perpendicularLength", 0.0)),
                    "carModelName": str(car_model),
                    "carModelHash": int(_meta_hash_to_uint(car_model)),
                    "popGroupName": str(pop_group),
                    "popGroupHash": int(_meta_hash_to_uint(pop_group)),
                    "flags": int(getattr(cg, "flags", 0)),
                    "livery": int(getattr(cg, "livery", 0)),
                }
            )

    occluders: List[Dict[str, Any]] = []
    box_occ = getattr(ymap, "CBoxOccluders", None)
    if box_occ is not None:
        for i, bo in enumerate(box_occ):
            occluders.append(
                {
                    "type": "BoxOccluder",
                    "index": int(i),
                    "iCenterX": int(getattr(bo, "iCenterX", 0)),
                    "iCenterY": int(getattr(bo, "iCenterY", 0)),
                    "iCenterZ": int(getattr(bo, "iCenterZ", 0)),
                    "iCosZ": int(getattr(bo, "iCosZ", 0)),
                    "iSinZ": int(getattr(bo, "iSinZ", 0)),
                    "iLength": int(getattr(bo, "iLength", 0)),
                    "iWidth": int(getattr(bo, "iWidth", 0)),
                    "iHeight": int(getattr(bo, "iHeight", 0)),
                }
            )

    occ_models = getattr(ymap, "COccludeModels", None)
    if occ_models is not None:
        for i, om in enumerate(occ_models):
            occluders.append(
                {
                    "type": "OccludeModel",
                    "index": int(i),
                    "bmin": _vector3_to_list(getattr(om, "bmin", None)),
                    "bmax": _vector3_to_list(getattr(om, "bmax", None)),
                    "numTris": int(getattr(om, "numTris", 0)),
                    "numVertsInBytes": int(getattr(om, "numVertsInBytes", 0)),
                    "dataSize": int(getattr(om, "dataSize", 0)),
                    "flags": int(getattr(om, "flags", 0)),
                }
            )

    # Timecycle modifiers (not renderable, but part of what CodeWalker considers world data)
    timecycle_modifiers: List[Dict[str, Any]] = []
    tcms = getattr(ymap, "CTimeCycleModifiers", None)
    if tcms is not None:
        for i, tcm in enumerate(tcms):
            nm = getattr(tcm, "name", 0)
            timecycle_modifiers.append(
                {
                    "index": int(i),
                    "name": str(nm),
                    "nameHash": int(_meta_hash_to_uint(nm)),
                    "minExtents": _vector3_to_list(getattr(tcm, "minExtents", None)),
                    "maxExtents": _vector3_to_list(getattr(tcm, "maxExtents", None)),
                    "percentage": float(getattr(tcm, "percentage", 0.0)),
                    "range": float(getattr(tcm, "range", 0.0)),
                    "startHour": int(getattr(tcm, "startHour", 0)),
                    "endHour": int(getattr(tcm, "endHour", 0)),
                }
            )

    # Instanced grass batches (these can contain *many* instances).
    grass_batches: List[Dict[str, Any]] = []
    gbatches = getattr(ymap, "GrassInstanceBatches", None)
    if gbatches is not None:
        # Matches CodeWalker constant in YmapGrassInstanceBatch.
        batch_vert_multiplier = 0.00001525878
        for i, gb in enumerate(gbatches):
            batch = getattr(gb, "Batch", None)
            arche = getattr(batch, "archetypeName", 0) if batch is not None else 0
            aabb_min = _vector3_to_list(getattr(gb, "AABBMin", None))
            aabb_max = _vector3_to_list(getattr(gb, "AABBMax", None))
            inst_count = int(len(getattr(gb, "Instances", []) or []))
            out_batch: Dict[str, Any] = {
                "index": int(i),
                "archetypeName": str(arche),
                "archetypeHash": int(_meta_hash_to_uint(arche)),
                "instanceCount": int(inst_count),
                "position": _vector3_to_list(getattr(gb, "Position", None)),
                "radius": float(getattr(gb, "Radius", 0.0)),
                "aabbMin": aabb_min,
                "aabbMax": aabb_max,
                "lodDist": int(getattr(batch, "lodDist", 0)) if batch is not None else 0,
            }

            if include_grass_instances:
                # Expand to per-instance positions (can be extremely large).
                instances_out: List[Dict[str, Any]] = []
                insts = getattr(gb, "Instances", None)
                if insts is not None:
                    size = [aabb_max[0] - aabb_min[0], aabb_max[1] - aabb_min[1], aabb_max[2] - aabb_min[2]]
                    for j, inst in enumerate(insts):
                        us = getattr(inst, "Position", None)
                        u = _array_of_ushorts3_to_list(us)
                        # worldPos = min + size * (ushortVec * multiplier)
                        wx = aabb_min[0] + (size[0] * (float(u[0]) * batch_vert_multiplier))
                        wy = aabb_min[1] + (size[1] * (float(u[1]) * batch_vert_multiplier))
                        wz = aabb_min[2] + (size[2] * (float(u[2]) * batch_vert_multiplier))
                        instances_out.append({"index": int(j), "position": [wx, wy, wz]})
                out_batch["instances"] = instances_out

            grass_batches.append(out_batch)

    # LOD lights: not strictly "entities", but part of the YMAP world content.
    # Note: CodeWalker combines LODLights + DistantLODLights across parent/child ymaps;
    # we export raw arrays per YMAP to avoid requiring parent linkage here.
    lod_lights: List[Dict[str, Any]] = []
    distant_lod_lights: List[Dict[str, Any]] = []
    if include_lod_lights:
        dll = getattr(ymap, "DistantLODLights", None)
        if dll is not None:
            cols = getattr(dll, "colours", None)
            poss = getattr(dll, "positions", None)
            if poss is not None:
                n = int(len(poss))
                for i in range(n):
                    pos = poss[i]
                    col = int(cols[i]) if cols is not None and i < len(cols) else 0
                    distant_lod_lights.append({"index": int(i), "position": _vector3_like_to_list(pos), "colourBGRA": col})

        ll = getattr(ymap, "LODLights", None)
        if ll is not None:
            direction = getattr(ll, "direction", None)
            falloff = getattr(ll, "falloff", None)
            falloff_exp = getattr(ll, "falloffExponent", None)
            tsf = getattr(ll, "timeAndStateFlags", None)
            hsh = getattr(ll, "hash", None)
            inner = getattr(ll, "coneInnerAngle", None)
            outer = getattr(ll, "coneOuterAngleOrCapExt", None)
            corona = getattr(ll, "coronaIntensity", None)
            n = 0
            for arr in (direction, falloff, falloff_exp, tsf, hsh, inner, outer, corona):
                if arr is not None:
                    try:
                        n = max(n, int(len(arr)))
                    except Exception:
                        pass
            for i in range(n):
                lod_lights.append(
                    {
                        "index": int(i),
                        "direction": _vector3_like_to_list(direction[i]) if direction is not None and i < len(direction) else [0.0, 0.0, 0.0],
                        "falloff": float(falloff[i]) if falloff is not None and i < len(falloff) else 0.0,
                        "falloffExponent": float(falloff_exp[i]) if falloff_exp is not None and i < len(falloff_exp) else 0.0,
                        "timeAndStateFlags": int(tsf[i]) if tsf is not None and i < len(tsf) else 0,
                        "hash": int(hsh[i]) if hsh is not None and i < len(hsh) else 0,
                        "coneInnerAngle": int(inner[i]) if inner is not None and i < len(inner) else 0,
                        "coneOuterAngleOrCapExt": int(outer[i]) if outer is not None and i < len(outer) else 0,
                        "coronaIntensity": int(corona[i]) if corona is not None and i < len(corona) else 0,
                    }
                )

    result: Dict[str, Any] = {
        "ymap": ymap_path,
        "name": str(getattr(ymap, "Name", "")),
        "rotationOrder": "wxyz",
        "mapData": mapdata_dto,
        "counts": {
            "CEntityDefs": int(len(cdefs)) if cdefs is not None else 0,
            "CMloInstanceDefs": int(len(mlos)) if mlos is not None else 0,
            "CCarGens": int(len(cargens)) if cargens is not None else 0,
            "CBoxOccluders": int(len(box_occ)) if box_occ is not None else 0,
            "COccludeModels": int(len(occ_models)) if occ_models is not None else 0,
            "CTimeCycleModifiers": int(len(tcms)) if tcms is not None else 0,
            "GrassInstanceBatches": int(len(gbatches)) if gbatches is not None else 0,
            "GrassInstances": int(sum(int(b.get("instanceCount", 0)) for b in grass_batches)) if grass_batches else 0,
            "LODLights": int(len(lod_lights)) if lod_lights else 0,
            "DistantLODLights": int(len(distant_lod_lights)) if distant_lod_lights else 0,
        },
        "entities": entities,
        "mloInstances": mlo_instances,
        "carGens": car_gens,
        "occluders": occluders,
        "timeCycleModifiers": timecycle_modifiers,
        "grassInstanceBatches": grass_batches,
        "lodLights": lod_lights,
        "distantLodLights": distant_lod_lights,
        "playerSpawnMarkers": spawnpoints,
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def main() -> int:
    dotenv.load_dotenv()
    dotenv.load_dotenv(dotenv_path=Path(__file__).resolve().parent / "env.local", override=False)

    parser = argparse.ArgumentParser(description="Bulk extract + parse GTA V .ymap files (via CodeWalker.Core).")
    parser.add_argument("--game-path", default=os.getenv("gta_location") or os.getenv("gta5_path"), help="Path to GTA V install root")
    parser.add_argument("--output-dir", default="output", help="Output directory (default: output)")
    parser.add_argument("--no-raw", action="store_true", help="Skip writing output/ymap/raw/**")
    parser.add_argument("--no-entities", action="store_true", help="Skip writing output/ymap/entities/*.json")
    parser.add_argument(
        "--spawn-archetype",
        action="append",
        default=[],
        help="If set, treat entities with this exact archetypeName as player spawn markers and export a consolidated spawn list (repeatable).",
    )
    parser.add_argument(
        "--spawn-out",
        default="output/ymap/player_spawnpoints.json",
        help="Output path for consolidated player spawnpoints JSON (only written when --spawn-archetype is used).",
    )
    parser.add_argument("--max-files", type=int, default=0, help="Limit number of YMAPs to process (0 = no limit)")
    parser.add_argument("--filter", default="", help="Only process YMAPs whose path contains this substring (case-insensitive)")
    parser.add_argument(
        "--include-grass-instances",
        action="store_true",
        help="Include per-instance decoded grass positions in JSON (VERY large; off by default).",
    )
    parser.add_argument(
        "--include-lod-lights",
        action="store_true",
        help="Include LOD light arrays in JSON (not needed for model/texture extraction; off by default).",
    )
    args = parser.parse_args()

    if not args.game_path:
        print("ERROR: missing --game-path (or gta_location/gta5_path in environment).")
        return 2

    game_path = Path(args.game_path).expanduser()
    if not game_path.exists():
        print(f"ERROR: game path does not exist: {game_path}")
        return 2

    out_root = Path(args.output_dir)
    raw_root = out_root / "ymap" / "raw"
    ent_root = out_root / "ymap" / "entities"
    manifest_path = out_root / "ymap" / "ymap_index.json"

    dll_manager = DllManager(str(game_path))
    if not dll_manager.initialized:
        print("ERROR: DllManager failed to initialize (CodeWalker.Core not available?)")
        return 1

    rpf_manager = dll_manager.get_rpf_manager()
    ymap_paths = _iter_ymap_paths(rpf_manager)
    if args.filter:
        f = args.filter.lower()
        ymap_paths = [p for p in ymap_paths if f in p.lower()]

    if args.max_files and args.max_files > 0:
        ymap_paths = ymap_paths[: args.max_files]

    if not ymap_paths:
        print("ERROR: found 0 .ymap files via CodeWalker RpfManager index.")
        return 1

    used_entity_filenames: Set[str] = set()
    spawn_archetypes: Set[str] = set([s for s in (args.spawn_archetype or []) if s])
    spawnpoints_all: List[Dict[str, Any]] = []
    manifest: Dict[str, Any] = {
        "gamePath": str(game_path),
        "numYmaps": int(len(ymap_paths)),
        "outputs": {
            "rawRoot": str(raw_root),
            "entitiesRoot": str(ent_root),
        },
        "ymaps": [],
    }

    for ymap_path in ymap_paths:
        item: Dict[str, Any] = {"ymap": ymap_path}

        raw_out = None
        if not args.no_raw:
            raw_out = _export_raw_ymap(rpf_manager=rpf_manager, ymap_path=ymap_path, raw_root=raw_root)
            item["rawPath"] = str(raw_out) if raw_out else None

        ent_out = None
        if not args.no_entities:
            json_name = _unique_entity_json_name(ymap_path, used_entity_filenames)
            ent_out = ent_root / json_name
            try:
                data = _export_entities_json(
                    dll_manager=dll_manager,
                    ymap_path=ymap_path,
                    out_path=ent_out,
                    spawn_archetypes=spawn_archetypes,
                    include_grass_instances=bool(args.include_grass_instances),
                    include_lod_lights=bool(args.include_lod_lights),
                )
                item["entitiesPath"] = str(ent_out)
                item["counts"] = data.get("counts", {})
                item["mapData"] = data.get("mapData", {})

                if spawn_archetypes:
                    sp = data.get("playerSpawnMarkers", []) or []
                    if isinstance(sp, list) and sp:
                        spawnpoints_all.extend(sp)
            except Exception as e:
                item["entitiesPath"] = str(ent_out)
                item["error"] = str(e)

        manifest["ymaps"].append(item)

    if spawn_archetypes:
        spawn_out_path = Path(args.spawn_out)
        spawn_out_path.parent.mkdir(parents=True, exist_ok=True)
        spawn_out_path.write_text(
            json.dumps(
                {
                    "gamePath": str(game_path),
                    "spawnArchetypes": sorted(list(spawn_archetypes)),
                    "count": int(len(spawnpoints_all)),
                    "spawnpoints": spawnpoints_all,
                },
                indent=2,
            ),
            encoding="utf-8",
        )

    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print("Wrote:")
    if not args.no_raw:
        print(f"  {raw_root}  (raw .ymap)")
    if not args.no_entities:
        print(f"  {ent_root}  (per-ymap JSON)")
    if spawn_archetypes:
        print(f"  {args.spawn_out}  (player spawnpoints)")
    print(f"  {manifest_path}  (manifest)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



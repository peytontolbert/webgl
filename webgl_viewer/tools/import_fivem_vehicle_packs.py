#!/usr/bin/env python3
"""Convert loose FiveM add-on vehicles into lazy browser vehicle manifests."""

from __future__ import annotations

import argparse
import copy
import hashlib
import io
import json
import logging
import re
import sys
import traceback
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from gta5_modules.dll_manager import DllManager
from gta5_modules.hash_utils import joaat
from export_drawables_for_chunk import (
    _SP_NORMAL_PREFERRED, _SP_SPEC_PREFERRED, _compute_planar_uvs_xy01,
    _extract_drawable_lod_submeshes, _extract_shader_params,
    _extract_uv_scale_offset_from_shader, _material_flags_from_shader,
    _pick_diffuse_texture_name_from_shader_with_hash, _pick_texture_name_from_shader_with_hash,
    _decode_texture_object_to_img_rgba, _shader_param_iter,
)
from export_fivem_weapon_drawable import _bounds_for_submesh, _load_raw_resource
from webgl_viewer.tools.export_clothingpack5m_selection import write_capped_textures, write_quantized_mesh

WHEEL_TAGS = (27922, 26418, 27902, 26398)
DRIVER_SEAT_TAG = 20012
META_NAMES = (
    "vehicles.meta", "handling.meta", "carvariations.meta", "carcols.meta",
    "vehiclelayouts.meta", "dlctext.meta", "shop_vehicle.meta",
)


def u32_name(value: str) -> int:
    return int(joaat(value, lower=True)) & 0xFFFFFFFF


def clean_number(value: Any, fallback: float = 0.0) -> float:
    try:
        result = float(value)
        return result if result == result and abs(result) != float("inf") else fallback
    except (TypeError, ValueError):
        return fallback


def node_to_data(node: ET.Element) -> Any:
    """Preserve XML attributes, text, order-insensitive children, and repeated tags."""
    children = list(node)
    text = (node.text or "").strip()
    if not children and not node.attrib:
        return text
    out: dict[str, Any] = {f"@{key}": value for key, value in node.attrib.items()}
    if text:
        out["#text"] = text
    for child in children:
        value = node_to_data(child)
        if child.tag in out:
            if not isinstance(out[child.tag], list):
                out[child.tag] = [out[child.tag]]
            out[child.tag].append(value)
        else:
            out[child.tag] = value
    return out


def read_xml(path: Path) -> tuple[str, Any]:
    raw = path.read_text(encoding="utf-8-sig", errors="replace")
    root = ET.fromstring(raw)
    return root.tag, node_to_data(root)


def tolerant_xml_root(path: Path) -> ET.Element:
    raw = path.read_text(encoding="utf-8-sig", errors="replace")
    try:
        return ET.fromstring(raw)
    except ET.ParseError:
        cleaned = re.sub(r"<!--[\s\S]*?-->", "", raw)
        match = re.search(r"<(?!\?)(?!\!)([A-Za-z_][\w:.-]*)\b", cleaned)
        if not match:
            raise
        tag = match.group(1)
        end = cleaned.find(f"</{tag}>", match.end())
        if end < 0:
            raise
        return ET.fromstring(cleaned[match.start():end + len(tag) + 3])


def xml_items(path: Path, route: tuple[str, ...]) -> list[ET.Element]:
    root = tolerant_xml_root(path)
    current = [root]
    for part in route:
        current = [child for node in current for child in node.findall(part)]
    return current


def child_text(node: ET.Element | None, name: str, fallback: str = "") -> str:
    child = node.find(name) if node is not None else None
    return str(child.text or "").strip() if child is not None else fallback


def child_value(node: ET.Element | None, name: str, fallback: float = 0.0) -> float:
    child = node.find(name) if node is not None else None
    return clean_number(child.attrib.get("value") if child is not None else None, fallback)


def child_vector(node: ET.Element | None, name: str) -> list[float] | None:
    child = node.find(name) if node is not None else None
    if child is None:
        return None
    values = [clean_number(child.attrib.get(axis), float("nan")) for axis in ("x", "y", "z")]
    return values if all(value == value and abs(value) != float("inf") for value in values) else None


def compact_handling(handling_node: ET.Element | None) -> dict[str, Any]:
    """Keep the physics fields the browser can simulate without shipping raw XML."""
    return {
        "mass": child_value(handling_node, "fMass", 1500),
        "dragCoeff": child_value(handling_node, "fInitialDragCoeff", 8.0),
        "percentSubmerged": child_value(handling_node, "fPercentSubmerged", 85),
        "centerOfMass": child_vector(handling_node, "vecCentreOfMassOffset") or [0.0, 0.0, 0.0],
        "inertiaMultiplier": child_vector(handling_node, "vecInertiaMultiplier") or [1.0, 1.0, 1.0],
        "driveBiasFront": child_value(handling_node, "fDriveBiasFront", 0.5),
        "driveBiasBack": child_value(handling_node, "fDriveBiasBack", 0.0),
        "gears": int(child_value(handling_node, "nInitialDriveGears", 5)),
        "driveForce": child_value(handling_node, "fInitialDriveForce", 0.3),
        "driveInertia": child_value(handling_node, "fDriveInertia", 1.0),
        "clutchChangeRateUpShift": child_value(handling_node, "fClutchChangeRateScaleUpShift", 3.0),
        "clutchChangeRateDownShift": child_value(handling_node, "fClutchChangeRateScaleDownShift", 3.0),
        "maxFlatVelocity": child_value(handling_node, "fInitialDriveMaxFlatVel", 160),
        "brakeForce": child_value(handling_node, "fBrakeForce", 0.8),
        "brakeBiasFront": child_value(handling_node, "fBrakeBiasFront", 0.5),
        "handBrakeForce": child_value(handling_node, "fHandBrakeForce", 0.7),
        "steeringLock": child_value(handling_node, "fSteeringLock", 35),
        "tractionMax": child_value(handling_node, "fTractionCurveMax", 2.3),
        "tractionMin": child_value(handling_node, "fTractionCurveMin", 2.0),
        "tractionLateral": child_value(handling_node, "fTractionCurveLateral", 22.5),
        "tractionSpringDeltaMax": child_value(handling_node, "fTractionSpringDeltaMax", 0.15),
        "lowSpeedTractionLossMult": child_value(handling_node, "fLowSpeedTractionLossMult", 1.0),
        "camberStiffness": child_value(handling_node, "fCamberStiffnesss", 0.0),
        "tractionBiasFront": child_value(handling_node, "fTractionBiasFront", 0.5),
        "tractionLossMult": child_value(handling_node, "fTractionLossMult", 1.0),
        "suspensionForce": child_value(handling_node, "fSuspensionForce", 2.0),
        "suspensionCompDamp": child_value(handling_node, "fSuspensionCompDamp", 1.0),
        "suspensionReboundDamp": child_value(handling_node, "fSuspensionReboundDamp", 1.5),
        "suspensionUpperLimit": child_value(handling_node, "fSuspensionUpperLimit", 0.1),
        "suspensionLowerLimit": child_value(handling_node, "fSuspensionLowerLimit", -0.1),
        "suspensionRaise": child_value(handling_node, "fSuspensionRaise", 0.0),
        "suspensionBiasFront": child_value(handling_node, "fSuspensionBiasFront", 0.5),
        "antiRollBarForce": child_value(handling_node, "fAntiRollBarForce", 0.7),
        "antiRollBarBiasFront": child_value(handling_node, "fAntiRollBarBiasFront", 0.5),
        "rollCentreHeightFront": child_value(handling_node, "fRollCentreHeightFront", 0.35),
        "rollCentreHeightRear": child_value(handling_node, "fRollCentreHeightRear", 0.35),
        "collisionDamageMult": child_value(handling_node, "fCollisionDamageMult", 1.0),
        "weaponDamageMult": child_value(handling_node, "fWeaponDamageMult", 1.0),
        "deformationDamageMult": child_value(handling_node, "fDeformationDamageMult", 1.0),
        "engineDamageMult": child_value(handling_node, "fEngineDamageMult", 1.0),
        "petrolTankVolume": child_value(handling_node, "fPetrolTankVolume", 65),
        "oilVolume": child_value(handling_node, "fOilVolume", 5),
        "downforceModifier": child_value(handling_node, "fDownforceModifier", 0.0),
    }


def compact_vehicle_mechanics(vehicle_node: ET.Element | None) -> dict[str, Any]:
    return {
        "camera": {
            "povOffset": child_vector(vehicle_node, "PovCameraOffset") or [0.0, 0.0, 0.6],
            "povRollCageAdjustment": child_value(vehicle_node, "PovCameraVerticalAdjustmentForRollCage", 0.0),
            "followCamera": child_text(vehicle_node, "cameraName"),
            "aimCamera": child_text(vehicle_node, "aimCameraName"),
            "bonnetCamera": child_text(vehicle_node, "bonnetCameraName"),
        },
        "damage": {
            "bodyHealth": child_value(vehicle_node, "defaultBodyHealth", 1000),
            "mapScale": child_value(vehicle_node, "damageMapScale", 0.5),
            "offsetScale": child_value(vehicle_node, "damageOffsetScale", 0.5),
            "weaponForceMult": child_value(vehicle_node, "weaponForceMult", 1.0),
        },
        "wheel": {
            "scale": child_value(vehicle_node, "wheelScale", 0.35),
            "rearScale": child_value(vehicle_node, "wheelScaleRear", child_value(vehicle_node, "wheelScale", 0.35)),
            "type": child_text(vehicle_node, "wheelType"),
        },
        "steerWheelMult": child_value(vehicle_node, "steerWheelMult", 1.0),
        "vehicleFlags": child_text(vehicle_node, "flags"),
        "vehicleClass": child_text(vehicle_node, "vehicleClass"),
        "vehicleType": child_text(vehicle_node, "type"),
        "layout": child_text(vehicle_node, "layout"),
    }


def find_casefold(directory: Path, name: str) -> Path | None:
    wanted = name.casefold()
    return next((path for path in directory.iterdir() if path.is_file() and path.name.casefold() == wanted), None)


def vector3(value: Any) -> list[float] | None:
    if value is None:
        return None
    try:
        return [float(value.X), float(value.Y), float(value.Z)]
    except Exception:
        return None


def skeleton_points(drawable: Any) -> tuple[dict[int, list[float]], dict[int, str]]:
    points: dict[int, list[float]] = {}
    names: dict[int, str] = {}
    bones = getattr(getattr(getattr(drawable, "Skeleton", None), "Bones", None), "Items", None) or []
    for bone in bones:
        tag = int(getattr(bone, "Tag", 0) or 0)
        point = vector3(getattr(bone, "Translation", None))
        if point is None:
            matrix = getattr(bone, "AnimTransform", None)
            try:
                point = [float(matrix.M41), float(matrix.M42), float(matrix.M43)]
            except Exception:
                point = None
        if point is not None:
            points[tag] = point
            names[tag] = str(getattr(bone, "Name", "") or "")
    return points, names


def wheel_drawables(fragment: Any, points: dict[int, list[float]]) -> list[tuple[Any, list[float], int]]:
    lod = getattr(getattr(fragment, "PhysicsLODGroup", None), "PhysicsLOD1", None)
    children = getattr(getattr(lod, "Children", None), "data_items", None) or []
    by_tag: dict[int, Any] = {}
    front = rear = None
    for child in children:
        tag = int(getattr(child, "BoneTag", 0) or 0)
        drawable = getattr(child, "Drawable1", None)
        if drawable is None or not (getattr(drawable, "AllModels", None) or []):
            continue
        by_tag[tag] = drawable
        if tag in WHEEL_TAGS[:2]:
            front = front or drawable
        elif tag in WHEEL_TAGS[2:]:
            rear = rear or drawable
    front = front or rear
    rear = rear or front
    result = []
    for tag in WHEEL_TAGS:
        drawable = by_tag.get(tag) or (front if tag in WHEEL_TAGS[:2] else rear)
        if drawable is not None and tag in points:
            result.append((drawable, points[tag], tag))
    return result


def repair_texture_paths(material: dict[str, Any], textures: dict[str, tuple[Any, Any, str]], assets: Path) -> None:
    by_hash = {str(u32_name(name)): value[2] for name, value in textures.items()}
    params = material.get("shaderParams")
    refs = params.get("texturesByHash") if isinstance(params, dict) else None
    if not isinstance(refs, dict):
        return
    repaired = {}
    for param_hash, rel in refs.items():
        stem = Path(str(rel)).stem
        replacement = by_hash.get(stem)
        if replacement:
            repaired[param_hash] = replacement
        elif (assets / str(rel)).is_file():
            repaired[param_hash] = rel
    params["texturesByHash"] = repaired


def vehicle_material_for_shader(shader: Any, textures: dict[str, tuple[Any, Any, str]]) -> dict[str, Any]:
    picker_textures = {name: (value[0], value[1]) for name, value in textures.items()}
    material: dict[str, Any] = {}
    material.update(_material_flags_from_shader(shader))
    params = _extract_shader_params(shader, max_textures=32, max_vectors=64)
    if params:
        material["shaderParams"] = params
    for uv_index in range(3):
        uvso = _extract_uv_scale_offset_from_shader(shader, uv_index)
        if uvso and len(uvso) >= 4:
            material[f"uv{uv_index}ScaleOffset"] = [float(value) for value in uvso[:4]]

    diffuse_name, diffuse_param = _pick_diffuse_texture_name_from_shader_with_hash(picker_textures, shader)
    normal_name, normal_param = _pick_texture_name_from_shader_with_hash(
        picker_textures, shader, _SP_NORMAL_PREFERRED, require_keywords=("normal", "bump", "_n", "nrm")
    )
    spec_name, spec_param = _pick_texture_name_from_shader_with_hash(
        picker_textures, shader, _SP_SPEC_PREFERRED, require_keywords=("spec", "srm")
    )
    for kind, name, param in (("diffuse", diffuse_name, diffuse_param), ("normal", normal_name, normal_param), ("spec", spec_name, spec_param)):
        if name and name in textures:
            material[kind] = textures[name][2]
            material[f"{kind}Name"] = name
            if param is not None:
                material[f"{kind}ParamHash"] = int(param) & 0xFFFFFFFF
    return material


def fallback_vehicle_material(material: dict[str, Any], wheel_tag: int | None, wheel_submesh: int) -> None:
    shader = str(material.get("shaderName") or "").lower()
    if material.get("diffuse") or not shader:
        return
    if wheel_tag is not None or "tire" in shader:
        is_rim = wheel_submesh > 0 and "tire" in shader
        material["baseColor"] = [0.17, 0.18, 0.19] if is_rim else [0.018, 0.019, 0.02]
        material["specularIntensity"] = 0.72 if is_rim else 0.08
        material["vehicleWheelPart"] = "rim" if is_rim else "tire"
    elif "paint" in shader:
        material["baseColor"] = [0.42, 0.025, 0.018]
    elif "glass" in shader:
        material["baseColor"] = [0.08, 0.12, 0.15]
    elif "light" in shader:
        material["baseColor"] = [0.72, 0.18, 0.08]
    elif "interior" in shader or "dash" in shader:
        material["baseColor"] = [0.09, 0.09, 0.085]
    else:
        material["baseColor"] = [0.2, 0.2, 0.19]


def write_embedded_textures(dm: DllManager, fragment: Any, texture_dir: Path, max_size: int) -> dict[str, tuple[Any, Any, str]]:
    from PIL import Image

    texture_dir.mkdir(parents=True, exist_ok=True)
    drawables = [getattr(fragment, "Drawable", None)]
    lod = getattr(getattr(fragment, "PhysicsLODGroup", None), "PhysicsLOD1", None)
    for child in getattr(getattr(lod, "Children", None), "data_items", None) or []:
        drawables.append(getattr(child, "Drawable1", None))
    out: dict[str, tuple[Any, Any, str]] = {}
    for drawable in drawables:
        group = getattr(drawable, "ShaderGroup", None) or getattr(getattr(drawable, "OwnerDrawable", None), "ShaderGroup", None)
        for shader in getattr(getattr(group, "Shaders", None), "data_items", None) or []:
            for _param_hash, param in _shader_param_iter(shader) or []:
                if int(getattr(param, "DataType", 255)) != 0:
                    continue
                texture = getattr(param, "Data", None)
                name = str(getattr(texture, "Name", "") or "").strip()
                if not name or name in out:
                    continue
                image, fmt = _decode_texture_object_to_img_rgba(dm, texture)
                if image is None:
                    continue
                pil = Image.fromarray(image, mode="RGBA")
                cap = 256 if any(token in name.lower() for token in ("normal", "bump", "_n", "nrm", "spec")) else max_size
                if max(pil.size) > cap:
                    scale = cap / max(pil.size)
                    pil = pil.resize((max(1, round(pil.width * scale)), max(1, round(pil.height * scale))), Image.Resampling.LANCZOS)
                encoded = io.BytesIO()
                pil.save(encoded, format="WEBP", quality=82, method=6, exact=True)
                payload = encoded.getvalue()
                content_id = int.from_bytes(hashlib.sha256(payload).digest()[:4], "little")
                target = texture_dir / f"{content_id}.webp"
                if not target.exists():
                    target.write_bytes(payload)
                out[name] = (image, fmt, f"models_textures/{content_id}.webp")
    return out


def export_geometry(
    drawable: Any, fragment: Any, model_dir: Path, relative_dir: str,
    textures: dict[str, tuple[Any, Any, str]], assets: Path,
) -> tuple[dict[str, Any], dict[int, list[float]], list[float] | None]:
    points, _names = skeleton_points(drawable)
    wheels = wheel_drawables(fragment, points)
    entry: dict[str, Any] = {"lods": {}, "lodDistances": {}, "material": {}}
    all_min = [float("inf")] * 3
    all_max = [float("-inf")] * 3
    for lod_name in ("High", "Med", "Low", "VLow"):
        specs = [(drawable, None, None)]
        if lod_name == "High":
            specs.extend(wheels)
        rows = []
        for part, translation, wheel_tag in specs:
            try:
                group = getattr(part, "ShaderGroup", None) or getattr(getattr(part, "OwnerDrawable", None), "ShaderGroup", None)
                if group is not None:
                    part.AssignGeometryShaders(group)
            except Exception:
                group = None
            for part_index, submesh in enumerate(_extract_drawable_lod_submeshes(part, lod_name)):
                positions = submesh["positions"].copy()
                if translation is not None:
                    positions[:, 0] += translation[0]
                    positions[:, 1] += translation[1]
                    positions[:, 2] += translation[2]
                uv0 = submesh.get("uv0")
                uvs = uv0 if uv0 is not None and getattr(uv0, "size", 0) else _compute_planar_uvs_xy01(positions)
                filename = write_quantized_mesh(
                    model_dir, positions, submesh["indices"], submesh.get("normals"), uvs,
                    submesh.get("tangents"), submesh.get("color0"), submesh.get("uv1"),
                    submesh.get("uv2"), submesh.get("color1"), submesh.get("blendWeights"),
                    submesh.get("blendIndices"),
                )
                material = vehicle_material_for_shader(submesh.get("shader"), textures) if submesh.get("shader") is not None else {}
                repair_texture_paths(material, textures, assets)
                fallback_vehicle_material(material, wheel_tag, part_index)
                bounds = _bounds_for_submesh(positions)
                if lod_name == "High":
                    for axis in range(3):
                        all_min[axis] = min(all_min[axis], bounds["bounds"]["min"][axis])
                        all_max[axis] = max(all_max[axis], bounds["bounds"]["max"][axis])
                rows.append({
                    "file": f"{relative_dir}/{filename}",
                    "vertexCount": int(positions.shape[0]), "indexCount": int(submesh["indices"].shape[0]),
                    "hasNormals": submesh.get("normals") is not None, "hasUvs": True,
                    "hasTangents": submesh.get("tangents") is not None,
                    "hasColor0": submesh.get("color0") is not None, "hasColor1": submesh.get("color1") is not None,
                    "fragmentBoneTag": wheel_tag,
                    "fragmentPivot": list(translation) if translation is not None else None,
                    "material": material, **bounds,
                })
        if rows:
            entry["lods"][lod_name.lower()] = {"submeshes": rows}
    if all_min[0] != float("inf"):
        center = [(all_min[i] + all_max[i]) * 0.5 for i in range(3)]
        entry["bounds"] = {"min": all_min, "max": all_max, "center": center}
        entry["radius"] = max(sum((corner[i] - center[i]) ** 2 for i in range(3)) ** 0.5
                              for corner in (all_min, all_max))
    return entry, points, points.get(DRIVER_SEAT_TAG)


def wheel_contact_geometry(mesh: dict[str, Any], points: dict[int, list[float]], wheel_scale: float, wheel_scale_rear: float) -> tuple[dict[str, float], float]:
    """Derive the visible contact plane from exported wheel fragment bounds.

    `wheelScale` is physics metadata and is frequently stale in addon resources.
    The browser renders the fragment geometry, so its outer Z extent is the
    authoritative radius for keeping a rendered tire on the ground.
    """
    fallback = {
        tag: max(0.15, wheel_scale_rear if tag in WHEEL_TAGS[2:] else wheel_scale)
        for tag in WHEEL_TAGS
    }
    radii = dict(fallback)
    for row in ((mesh.get("lods") or {}).get("high") or {}).get("submeshes") or []:
        tag = row.get("fragmentBoneTag")
        if tag not in radii or tag not in points:
            continue
        bounds = row.get("bounds") or {}
        low = vector3(bounds.get("min"))
        high = vector3(bounds.get("max"))
        if low is None or high is None:
            continue
        pivot_z = points[tag][2]
        radii[tag] = max(radii[tag], abs(low[2] - pivot_z), abs(high[2] - pivot_z))
    contact_offsets = [radii[tag] - points[tag][2] for tag in radii if tag in points]
    # Match GTA's existing "lowest wheel determines chassis height" behavior,
    # but use the geometry that is actually rendered in the browser.
    ground_offset = max(contact_offsets, default=max(wheel_scale, wheel_scale_rear))
    return ({str(tag): round(radius, 5) for tag, radius in radii.items()}, round(max(0.15, min(1.5, ground_offset)), 5))


def metadata_document(resource: Path) -> dict[str, Any]:
    files = []
    known = {name.casefold() for name in META_NAMES}
    candidates = [path for path in resource.iterdir() if path.is_file() and (path.suffix.lower() in (".meta", ".lua") or path.name == "__resource.lua")]
    for path in sorted(candidates, key=lambda item: item.name.casefold()):
        raw = path.read_bytes()
        record: dict[str, Any] = {
            "name": path.name, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
            "declaredType": path.name.casefold() if path.name.casefold() in known else "resource_auxiliary",
        }
        if path.suffix.lower() == ".meta":
            try:
                root, parsed = read_xml(path)
                record.update({"format": "xml", "root": root, "data": parsed})
            except ET.ParseError as error:
                record.update({"format": "xml_invalid", "error": str(error), "text": raw.decode("utf-8", errors="replace")})
        else:
            record.update({"format": "lua", "text": raw.decode("utf-8", errors="replace")})
        files.append(record)
    stream = resource / "stream"
    streamed = []
    for path in sorted(stream.glob("*"), key=lambda item: item.name.casefold()):
        if not path.is_file():
            continue
        streamed.append({"name": path.name, "type": path.suffix.lower().lstrip("."), "bytes": path.stat().st_size})
    return {"schema": "webglgta-fivem-vehicle-metadata-v1", "resource": resource.name, "files": files, "stream": streamed}


def vehicle_rows(resource: Path) -> list[tuple[ET.Element, ET.Element | None]]:
    vehicles_path = find_casefold(resource, "vehicles.meta")
    handling_path = find_casefold(resource, "handling.meta")
    if not vehicles_path:
        return []
    handling_by_name = {}
    if handling_path:
        for item in xml_items(handling_path, ("HandlingData", "Item")):
            handling_by_name[child_text(item, "handlingName").casefold()] = item
    return [(item, handling_by_name.get(child_text(item, "handlingId").casefold()))
            for item in xml_items(vehicles_path, ("InitDatas", "Item"))]


def convert_resource(dm: DllManager, yft_class: Any, resource: Path, assets: Path, texture_size: int) -> list[dict[str, Any]]:
    output = []
    stream = resource / "stream"
    metadata = metadata_document(resource)
    metadata_dir = assets / "custom_vehicles" / "metadata"
    metadata_dir.mkdir(parents=True, exist_ok=True)
    metadata_path = metadata_dir / f"{resource.name}.json"
    metadata_path.write_text(json.dumps(metadata, separators=(",", ":")), encoding="utf-8")
    for vehicle_node, handling_node in vehicle_rows(resource):
        model = child_text(vehicle_node, "modelName").lower()
        txd = child_text(vehicle_node, "txdName", model).lower()
        yft_path = find_casefold(stream, f"{model}.yft")
        ytd_path = find_casefold(stream, f"{txd}.ytd")
        source_stem = model
        if not yft_path:
            base_yfts = [path for path in stream.glob("*.yft") if not path.stem.lower().endswith("_hi")]
            paired = [(path, find_casefold(stream, f"{path.stem}.ytd")) for path in base_yfts]
            paired = [(left, right) for left, right in paired if right is not None]
            if len(paired) == 1:
                yft_path, ytd_path = paired[0]
                source_stem = yft_path.stem.lower()
        if not yft_path:
            output.append({"model": model, "error": "base YFT missing", "resource": resource.name})
            continue
        yft = _load_raw_resource(dm, yft_class, yft_path)
        fragment = getattr(yft, "Fragment", None)
        drawable = getattr(fragment, "Drawable", None)
        if drawable is None:
            output.append({"model": model, "error": "fragment drawable missing", "resource": resource.name})
            continue
        if ytd_path:
            ytd = _load_raw_resource(dm, dm.YtdFile, ytd_path)
            textures = write_capped_textures(dm, ytd, assets / "models_textures", max_size=texture_size)
        else:
            textures = write_embedded_textures(dm, fragment, assets / "models_textures", texture_size)
        model_hash = str(u32_name(model))
        # Geometry lives below assets/models so it shares the normal MSH9
        # loader/cache. ModelManager prefixes ordinary manifest file references
        # with assets/models, so references themselves must be relative to that
        # directory rather than relative to assets/custom_vehicles.
        relative_dir = f"custom_vehicles/{model}"
        model_dir = assets / "models" / relative_dir
        model_dir.mkdir(parents=True, exist_ok=True)
        mesh, points, driver_seat = export_geometry(drawable, fragment, model_dir, relative_dir, textures, assets)
        if not mesh.get("lods"):
            output.append({"model": model, "error": "no geometry extracted", "resource": resource.name})
            continue
        wheel_scale = child_value(vehicle_node, "wheelScale", 0.35)
        wheel_scale_rear = child_value(vehicle_node, "wheelScaleRear", wheel_scale)
        wheel_points = {str(tag): points[tag] for tag in WHEEL_TAGS if tag in points}
        wheel_radii, ground_offset = wheel_contact_geometry(mesh, points, wheel_scale, wheel_scale_rear)
        bounds = mesh.get("bounds") or {}
        width = max(1.5, clean_number((bounds.get("max") or [1])[0]) - clean_number((bounds.get("min") or [-1])[0]))
        handling = compact_handling(handling_node)
        mechanics = compact_vehicle_mechanics(vehicle_node)
        make = child_text(vehicle_node, "vehicleMakeName")
        game_name = child_text(vehicle_node, "gameName", model)
        display = re.sub(r"\s+", " ", resource.name.replace("_", " ").replace("-", " ")).strip()
        definition = {
            "model": model, "hash": model_hash, "name": display, "make": make,
            "gameName": game_name, "resource": resource.name,
            "sourceAssetStem": source_stem,
            "manifest": f"custom_vehicles/{model}.json",
            "metadata": f"custom_vehicles/metadata/{resource.name}.json",
            "groundOffset": ground_offset,
            "wheelRadius": round(sum(wheel_radii.values()) / max(1, len(wheel_radii)), 5),
            "wheelRadii": wheel_radii,
            "wheelPivots": wheel_points, "driverSeat": driver_seat or [-0.35, 0.0, 0.08],
            "collisionRadius": round(max(0.8, min(2.0, width * 0.48)), 4),
            "handling": handling,
            **mechanics,
            "audioNameHash": child_text(vehicle_node, "audioNameHash"),
            "textureCount": len(textures),
            "renderStatus": "complete" if textures else "geometry_only_missing_ytd",
        }
        manifest = {
            "schema": "webglgta-custom-vehicle-v1", "vehicle": definition,
            "meshes": {model_hash: mesh},
        }
        manifest_path = assets / "custom_vehicles" / f"{model}.json"
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
        output.append(definition)
    return output


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--game-path", required=True)
    parser.add_argument("--resources", type=Path, required=True, help="Local copy of FiveM resources/[Autos]")
    parser.add_argument("--assets-dir", type=Path, default=ROOT / "webgl_viewer" / "assets")
    parser.add_argument("--resource", action="append", default=[], help="Only convert this resource folder; repeatable")
    parser.add_argument("--texture-size", type=int, default=512)
    parser.add_argument("--worker-index", type=int, default=0, help="Zero-based deterministic resource partition")
    parser.add_argument("--worker-count", type=int, default=1)
    parser.add_argument("--catalog-only", action="store_true", help="Rebuild the catalog from converted manifests")
    args = parser.parse_args()
    logging.disable(logging.INFO)
    resources = args.resources.resolve()
    assets = args.assets_dir.resolve()
    if args.catalog_only:
        converted = []
        audit_failures = []
        mesh_paths: set[Path] = set()
        texture_paths: set[Path] = set()
        for path in sorted((assets / "custom_vehicles").glob("*.json")):
            if path.name == "catalog.json":
                continue
            try:
                manifest = json.loads(path.read_text(encoding="utf-8"))
                vehicle = manifest.get("vehicle")
                if isinstance(vehicle, dict) and vehicle.get("model"):
                    vehicle.setdefault("renderStatus", "complete" if int(vehicle.get("textureCount") or 0) > 0 else "geometry_only_missing_ytd")
                    converted.append(vehicle)
                    for entry in (manifest.get("meshes") or {}).values():
                        for lod in (entry.get("lods") or {}).values():
                            for submesh in lod.get("submeshes") or []:
                                mesh_path = assets / "models" / str(submesh.get("file") or "")
                                mesh_paths.add(mesh_path)
                                if not mesh_path.is_file():
                                    audit_failures.append({"vehicle": vehicle["model"], "missingMesh": str(mesh_path)})
                                material = submesh.get("material") or {}
                                refs = [material.get(key) for key in ("diffuse", "normal", "spec", "detail", "emissive")]
                                refs.extend(((material.get("shaderParams") or {}).get("texturesByHash") or {}).values())
                                for rel in refs:
                                    if not isinstance(rel, str) or not rel.startswith("models_textures/"):
                                        continue
                                    texture_path = assets / rel
                                    texture_paths.add(texture_path)
                                    if not texture_path.is_file():
                                        audit_failures.append({"vehicle": vehicle["model"], "missingTexture": rel})
            except Exception:
                continue
        converted.sort(key=lambda row: (str(row.get("name") or "").casefold(), str(row.get("model") or "")))
        default = next((row["model"] for row in converted if row["model"] == "cgt"), converted[0]["model"] if converted else "")
        catalog = {
            "schema": "webglgta-custom-vehicle-catalog-v1", "defaultVehicle": default,
            "vehicles": converted, "failures": audit_failures,
            "stats": {
                "converted": len(converted), "failed": len(audit_failures),
                "geometryOnly": sum(row.get("renderStatus") != "complete" for row in converted),
                "meshFiles": len(mesh_paths), "meshBytes": sum(path.stat().st_size for path in mesh_paths if path.is_file()),
                "textureFiles": len(texture_paths), "textureBytes": sum(path.stat().st_size for path in texture_paths if path.is_file()),
            },
        }
        target = assets / "custom_vehicles" / "catalog.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(catalog, separators=(",", ":")), encoding="utf-8")
        print(json.dumps(catalog["stats"], indent=2))
        return 0 if converted and not audit_failures else 1
    selected = {name.casefold() for name in args.resource}
    worker_count = max(1, int(args.worker_count))
    worker_index = max(0, min(worker_count - 1, int(args.worker_index)))
    dm = DllManager(str(Path(args.game_path).resolve()))
    if not dm.initialized:
        raise RuntimeError("CodeWalker initialization failed")
    from CodeWalker.GameFiles import YftFile

    converted: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    all_resources = sorted((path for path in resources.iterdir() if path.is_dir()), key=lambda path: path.name.casefold())
    for resource_index, resource in enumerate(all_resources):
        if selected and resource.name.casefold() not in selected:
            continue
        if not selected and resource_index % worker_count != worker_index:
            continue
        print(f"[vehicle-import] {resource.name}", flush=True)
        try:
            rows = convert_resource(dm, YftFile, resource, assets, max(128, min(2048, args.texture_size)))
            for row in rows:
                (failures if row.get("error") else converted).append(row)
        except Exception as error:
            failures.append({"resource": resource.name, "error": f"{type(error).__name__}: {error}"})
            print(f"[vehicle-import] FAILED {resource.name}: {error}", flush=True)
            traceback.print_exc()
    converted.sort(key=lambda row: (row["name"].casefold(), row["model"]))
    default = next((row["model"] for row in converted if row["model"] == "cgt"), converted[0]["model"] if converted else "")
    catalog = {
        "schema": "webglgta-custom-vehicle-catalog-v1", "defaultVehicle": default,
        "vehicles": converted, "failures": failures,
        "stats": {"converted": len(converted), "failed": len(failures)},
    }
    target = assets / "custom_vehicles" / "catalog.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(catalog, separators=(",", ":")), encoding="utf-8")
    print(json.dumps(catalog["stats"], indent=2))
    return 1 if not converted else 0


if __name__ == "__main__":
    raise SystemExit(main())

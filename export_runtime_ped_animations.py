#!/usr/bin/env python3
"""
Export sampled GTA YCD ped animation skinning palettes for the runtime character.

The browser renderer already consumes row-major float3x4 bone palettes for skinned
freemode components. This exporter uses CodeWalker to evaluate real GTA YCD clips
against the ped skeleton, then writes sampled skin transforms directly in that
same palette format.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
from pathlib import Path
from typing import Any

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent / ".env")
except Exception:
    pass

from gta5_modules.dll_manager import DllManager
from gta5_modules.hash_utils import joaat as _joaat
from gta5_modules.hash_utils import try_coerce_u32 as _try_coerce_u32
from gta5_modules.script_paths import auto_assets_dir

from export_runtime_ped_skinning import (  # type: ignore
    _dict_get_drawable,
    _load_ydd,
    _load_ydd_from_entry,
    _load_yft_skeleton,
    _matrix3_to_rows,
    _ped_component_ydd_entries,
)


logger = logging.getLogger(__name__)
logging.getLogger("gta5_modules.dll_manager").setLevel(logging.WARNING)


def _as_u32(value: Any) -> int | None:
    v = _try_coerce_u32(value, allow_hex=True)
    if v is not None:
        return int(v) & 0xFFFFFFFF
    try:
        hv = getattr(value, "Hash", None)
        if hv is not None:
            return int(hv) & 0xFFFFFFFF
    except Exception:
        pass
    try:
        return int(value) & 0xFFFFFFFF
    except Exception:
        return None


def _iter_resource_array(arr: Any) -> list[Any]:
    if arr is None:
        return []
    try:
        data_items = getattr(arr, "data_items", None)
        if data_items is not None:
            return list(data_items)
    except Exception:
        pass
    try:
        return list(arr)
    except Exception:
        pass
    for count_name in ("Count", "Length"):
        try:
            count = int(getattr(arr, count_name))
            return [arr[i] for i in range(count)]
        except Exception:
            pass
    return []


def _iter_dict_keys(d: Any) -> list[Any]:
    if d is None:
        return []
    try:
        ks = getattr(d, "Keys", None)
        if ks is not None:
            return list(ks)
    except Exception:
        pass
    try:
        return list(d.keys())
    except Exception:
        pass
    try:
        return list(d)
    except Exception:
        return []


def _wait_loaded(gfc: Any, obj: Any, spins: int) -> Any:
    for _ in range(max(0, int(spins or 0))):
        try:
            if obj is None or bool(getattr(obj, "Loaded", True)):
                break
        except Exception:
            break
        try:
            gfc.ContentThreadProc()
        except Exception:
            break
    return obj


def _q(v: Any) -> float:
    try:
        f = float(v)
    except Exception:
        return 0.0
    if not math.isfinite(f) or abs(f) < 0.00000005:
        return 0.0
    return round(f, 7)


def _identity_rows3x4() -> list[float]:
    return [
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
    ]


def _invert_affine_rows3x4(rows: list[float]) -> list[float] | None:
    """Invert a row-major affine 3x4 matrix without adding a NumPy dependency."""
    if len(rows) < 12:
        return None
    a, b, c, tx, d, e, f, ty, g, h, i, tz = (float(v) for v in rows[:12])
    det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
    if not math.isfinite(det) or abs(det) < 1e-10:
        return None
    inv_det = 1.0 / det
    r00 = (e * i - f * h) * inv_det
    r01 = (c * h - b * i) * inv_det
    r02 = (b * f - c * e) * inv_det
    r10 = (f * g - d * i) * inv_det
    r11 = (a * i - c * g) * inv_det
    r12 = (c * d - a * f) * inv_det
    r20 = (d * h - e * g) * inv_det
    r21 = (b * g - a * h) * inv_det
    r22 = (a * e - b * d) * inv_det
    return [
        r00, r01, r02, -(r00 * tx + r01 * ty + r02 * tz),
        r10, r11, r12, -(r10 * tx + r11 * ty + r12 * tz),
        r20, r21, r22, -(r20 * tx + r21 * ty + r22 * tz),
    ]


def _multiply_affine_rows3x4(left: list[float], right: list[float]) -> list[float]:
    """Return `left * right` for row-major affine 3x4 matrices."""
    out = [0.0] * 12
    for r in range(3):
        base = r * 4
        for c in range(3):
            out[base + c] = sum(left[base + k] * right[k * 4 + c] for k in range(3))
        out[base + 3] = sum(left[base + k] * right[k * 4 + 3] for k in range(3)) + left[base + 3]
    return out


def _remove_root_motion(rows_flat: list[float], root_index: int = 0) -> list[float]:
    """Express a sampled palette relative to its animated root.

    GTA clip evaluation includes the root's coordinate-frame transform in every
    bone palette. The browser already supplies the ped's world transform, so
    retaining it rotates the whole rig and makes the gait appear to waddle.
    """
    bone_count = len(rows_flat) // 12
    if root_index < 0 or root_index >= bone_count:
        return rows_flat
    root = rows_flat[root_index * 12:(root_index + 1) * 12]
    inverse_root = _invert_affine_rows3x4(root)
    if inverse_root is None:
        return rows_flat

    out: list[float] = []
    for bone_index in range(bone_count):
        bone = rows_flat[bone_index * 12:(bone_index + 1) * 12]
        if len(bone) < 12:
            out.extend(_identity_rows3x4())
            continue
        if bone_index == root_index:
            out.extend(_identity_rows3x4())
        else:
            out.extend(_q(v) for v in _multiply_affine_rows3x4(inverse_root, bone))
    return out


def _clip_type_name(clip: Any) -> str:
    try:
        return str(getattr(clip, "Type", "") or "")
    except Exception:
        return type(clip).__name__


def _clip_duration(clip: Any) -> float:
    for attr in ("Duration", "EndTime"):
        try:
            v = float(getattr(clip, attr))
            if math.isfinite(v) and v > 0:
                return v
        except Exception:
            pass
    try:
        anim = getattr(clip, "Animation", None)
        v = float(getattr(anim, "Duration"))
        if math.isfinite(v) and v > 0:
            return v
    except Exception:
        pass
    return 1.0


def _load_ycd(gfc: Any, name: str, spins: int) -> Any:
    h = int(_joaat(name, lower=True)) & 0xFFFFFFFF
    try:
        ycd = gfc.GetYcd(h)
    except Exception:
        ycd = None
    ycd = _wait_loaded(gfc, ycd, spins)
    if ycd is None or not getattr(ycd, "Loaded", True):
        return None
    try:
        ycd.InitDictionaries()
    except Exception:
        pass
    return ycd


def _find_clip(ycd: Any, clip_name: str) -> Any:
    target = str(clip_name or "").strip().lower()
    if not target:
        return None
    cmap = getattr(ycd, "ClipMap", None)
    if cmap is None:
        return None

    target_hash = int(_joaat(target, lower=True)) & 0xFFFFFFFF
    for key in _iter_dict_keys(cmap):
        key_hash = _as_u32(key)
        try:
            entry = cmap[key]
        except Exception:
            entry = None
        clip = getattr(entry, "Clip", None)
        short = str(getattr(clip, "ShortName", "") or "").strip().lower()
        name = str(getattr(clip, "Name", "") or "").strip().lower()
        if key_hash == target_hash or str(key).strip().lower() == target or short == target or name.endswith(f"/{target}.clip"):
            return clip
    return None


def _get_ped_init(gfc: Any, model_hash: int) -> Any:
    d = getattr(gfc, "PedsInitDict", None)
    for k in _iter_dict_keys(d):
        if _as_u32(k) == (int(model_hash) & 0xFFFFFFFF):
            try:
                return d[k]
            except Exception:
                return None
    return None


def _string_attr(obj: Any, attr: str) -> str:
    try:
        v = getattr(obj, attr)
    except Exception:
        return ""
    s = str(v or "").strip()
    if s.startswith("hash_"):
        return ""
    return s


def _candidate_clip_dicts(gfc: Any, model_name: str, model_hash: int, explicit: list[str]) -> list[str]:
    out: list[str] = []
    for item in explicit:
        s = str(item or "").strip()
        if s and s not in out:
            out.append(s)

    init = _get_ped_init(gfc, model_hash)
    for attr in ("ClipDictionaryName", "MovementClipSet"):
        s = _string_attr(init, attr)
        if s and s not in out:
            out.append(s)

    lower = str(model_name or "").lower()
    if lower.startswith("mp_m_") or "_m_" in lower:
        defaults = ("move_m@casual@a", "move_m@multiplayer", "move_m@generic", "move_f@generic")
    elif lower.startswith("mp_f_") or "_f_" in lower:
        defaults = ("move_f@generic", "move_m@generic")
    else:
        defaults = ("move_m@generic", "move_f@generic")
    for item in defaults:
        if item not in out:
            out.append(item)
    return out


def _find_runtime_skeleton(gfc: Any, dm: Any, profile: dict[str, Any], model_hash: int, spins: int) -> Any:
    skeleton = _load_yft_skeleton(gfc, model_hash, spins)
    if skeleton is not None:
        return skeleton

    render = profile.get("render") or {}
    names = [
        str(x or "").strip()
        for x in (render.get("modelNames") or [])
        if str(x or "").strip()
    ]

    component_entries = _ped_component_ydd_entries(gfc, model_hash)
    ydd_cls = getattr(dm, "YddFile", None)
    fallback_ydd = None
    if not component_entries:
        fallback_ydd = _load_ydd(gfc, model_hash, spins)

    for name in names:
        h = int(_joaat(name, lower=True)) & 0xFFFFFFFF
        ydd = _load_ydd_from_entry(gfc, ydd_cls, component_entries.get(h), h, spins)
        if ydd is None:
            ydd = fallback_ydd
        drawable = _dict_get_drawable(ydd, h) if ydd is not None else None
        skeleton = getattr(drawable, "Skeleton", None) if drawable is not None else None
        if skeleton is not None:
            try:
                skeleton.ResetBoneTransforms()
            except Exception:
                pass
            return skeleton
    return None


def _apply_animation_layer(skeleton: Any, layer: Any, clip_time: float, vector3_cls: Any) -> tuple[int, int]:
    anim = getattr(layer, "Animation", None)
    if anim is None:
        return (0, 0)
    try:
        anim_time = float(layer.GetPlaybackTime(float(clip_time)))
    except Exception:
        anim_time = float(clip_time)
    try:
        frame = anim.GetFramePosition(anim_time)
    except Exception:
        return (0, 0)

    bone_ids = _iter_resource_array(getattr(anim, "BoneIds", None))
    applied = 0
    ignored = 0
    bones_map = getattr(skeleton, "BonesMap", None)
    for bone_i, bone_id in enumerate(bone_ids):
        try:
            tag = int(getattr(bone_id, "BoneId")) & 0xFFFF
            track = int(getattr(bone_id, "Track")) & 0xFF
        except Exception:
            ignored += 1
            continue
        try:
            bone = bones_map[tag]
        except Exception:
            bone = None
        if bone is None:
            ignored += 1
            continue

        try:
            if track == 0:
                v = anim.EvaluateVector4(frame, bone_i, True)
                bone.AnimTranslation = vector3_cls(float(v.X), float(v.Y), float(v.Z))
                applied += 1
            elif track == 1:
                bone.AnimRotation = anim.EvaluateQuaternion(frame, bone_i, True)
                applied += 1
            elif track == 2:
                v = anim.EvaluateVector4(frame, bone_i, True)
                bone.AnimScale = vector3_cls(float(v.X), float(v.Y), float(v.Z))
                applied += 1
            else:
                # Tracks 5/6 are root motion. The browser controller already moves
                # the ped in world space, so we keep these loops in-place.
                ignored += 1
        except Exception:
            ignored += 1
    return (applied, ignored)


def _iter_clip_layers(clip: Any) -> list[Any]:
    if type(clip).__name__ == "ClipAnimation":
        return [clip]
    return _iter_resource_array(getattr(clip, "Animations", None))


def _finalize_skeleton_rows(skeleton: Any) -> list[float]:
    bones_map = getattr(skeleton, "BonesMap", None)
    for dst_tag, src_tag in ((23639, 58271), (6442, 51826)):
        try:
            bones_map[dst_tag].AnimRotation = bones_map[src_tag].AnimRotation
        except Exception:
            pass

    try:
        bones_sorted = list(getattr(skeleton, "BonesSorted", None) or [])
    except Exception:
        bones_sorted = []
    if not bones_sorted:
        try:
            bones_sorted = list(getattr(getattr(skeleton, "Bones", None), "Items", []) or [])
        except Exception:
            bones_sorted = []

    for bone in bones_sorted:
        try:
            bone.UpdateAnimTransform()
            bone.UpdateSkinTransform()
        except Exception:
            pass
    try:
        skeleton.UpdateBoneTransforms()
    except Exception:
        pass

    rows_flat: list[float] = []
    for m in list(getattr(skeleton, "BoneTransforms", []) or []):
        rows = _matrix3_to_rows(m)
        if rows is None:
            rows_flat.extend([1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0])
        else:
            rows_flat.extend(_q(v) for v in rows)
    return rows_flat


def _evaluate_clip_stack_rows(
    skeleton: Any,
    stack: list[tuple[Any, float]],
    vector3_cls: Any,
) -> tuple[list[float], int, int]:
    """Evaluate full-body layers first, then masked/additive override layers.

    GTA's weapon animation dictionaries only write the `BothArms_filter` tracks.
    Evaluating those on a reset skeleton produces a bind-pose body. Applying the
    ordinary movement clip before the weapon clip mirrors the native layering
    order and gives the browser a complete skin palette.
    """
    try:
        skeleton.ResetBoneTransforms()
    except Exception:
        pass

    applied = 0
    ignored = 0
    for clip, clip_time in stack:
        for layer in _iter_clip_layers(clip):
            a, i = _apply_animation_layer(skeleton, layer, clip_time, vector3_cls)
            applied += a
            ignored += i
    return _finalize_skeleton_rows(skeleton), applied, ignored


def _evaluate_clip_rows(skeleton: Any, clip: Any, sample_time: float, vector3_cls: Any) -> tuple[list[float], int, int]:
    return _evaluate_clip_stack_rows(skeleton, [(clip, float(sample_time))], vector3_cls)


def _bone_metadata(skeleton: Any) -> list[dict[str, Any]]:
    bones = []
    try:
        raw = list(getattr(getattr(skeleton, "Bones", None), "Items", []) or [])
    except Exception:
        raw = []
    for i, b in enumerate(raw):
        try:
            index = int(getattr(b, "Index", i))
        except Exception:
            index = i
        try:
            tag = int(getattr(b, "Tag", 0)) & 0xFFFF
        except Exception:
            tag = 0
        bones.append({"index": index, "name": str(getattr(b, "Name", "") or ""), "tag": tag})
    return bones


def _export_clip(skeleton: Any, clip: Any, gait: str, source_ycd: str, fps: float, vector3_cls: Any) -> dict[str, Any]:
    duration = max(0.033333, _clip_duration(clip))
    frame_count = max(2, int(math.ceil(duration * max(1.0, fps))))
    frames: list[list[float]] = []
    applied_total = 0
    ignored_total = 0
    for frame_i in range(frame_count):
        t = (frame_i / frame_count) * duration
        rows, applied, ignored = _evaluate_clip_rows(skeleton, clip, t, vector3_cls)
        # Match the browser gameplay contract: the controller owns world
        # displacement/heading, while the YCD palette supplies local pose.
        frames.append(_remove_root_motion(rows))
        applied_total += applied
        ignored_total += ignored

    return {
        "sourceYcd": source_ycd,
        "sourceClip": str(getattr(clip, "ShortName", "") or gait),
        "sourceClipName": str(getattr(clip, "Name", "") or ""),
        "type": _clip_type_name(clip),
        "duration": _q(duration),
        "fps": _q(fps),
        "frameCount": frame_count,
        "skinTransformFormat": "row_major_float3x4_flat",
        "rootSpace": "relative_to_animated_root",
        "frames3x4": frames,
        "diagnostics": {
            "appliedTracksTotal": applied_total,
            "ignoredTracksTotal": ignored_total,
        },
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-path", default=(os.getenv("gta_location") or os.getenv("gta5_path") or ""), help="GTA5 install folder")
    ap.add_argument("--assets-dir", default="", help="webgl_viewer/assets folder (auto if omitted)")
    ap.add_argument("--runtime-character", default="", help="runtime_character.json path (defaults under assets dir)")
    ap.add_argument("--selected-dlc", default="all", help="CodeWalker DLC level")
    ap.add_argument("--spins", type=int, default=1600, help="ContentThreadProc spins while loading assets")
    ap.add_argument("--fps", type=float, default=30.0, help="Sampling rate for exported YCD clips")
    ap.add_argument("--clip-dictionary", action="append", default=[], help="Preferred YCD dictionary name; can be passed more than once")
    ap.add_argument("--clips", default="idle,walk,run,sprint", help="Comma-separated gait clip names to export")
    ap.add_argument("--merge-existing", action="store_true", help="Merge requested clips into the existing runtime animation JSON")
    args = ap.parse_args()

    game_path = (args.game_path or "").strip('"').strip("'")
    if not game_path:
        raise SystemExit("Missing --game-path (or gta_location/gta5_path env var)")

    assets_dir = auto_assets_dir(args.assets_dir)
    runtime_path = Path(args.runtime_character) if args.runtime_character else (assets_dir / "runtime_character.json")
    if not runtime_path.exists():
        raise SystemExit(f"Missing runtime character profile: {runtime_path}")

    profile = json.loads(runtime_path.read_text(encoding="utf-8"))
    model_name = str(profile.get("modelName") or "").strip()
    model_hash = int(profile.get("modelHash") or (_joaat(model_name, lower=True) if model_name else 0)) & 0xFFFFFFFF
    if not model_name or not model_hash:
        raise SystemExit("runtime_character.json does not include modelName/modelHash")

    dm = DllManager(game_path)
    if not dm.initialized:
        raise SystemExit("Failed to initialize DllManager")
    if not dm.init_game_file_cache(load_vehicles=False, load_peds=True, load_audio=False, selected_dlc=str(args.selected_dlc or "").strip() or None):
        raise SystemExit("Failed to init GameFileCache with peds enabled")
    gfc = dm.get_game_file_cache()

    skeleton = _find_runtime_skeleton(gfc, dm, profile, model_hash, args.spins)
    if skeleton is None:
        raise SystemExit(f"Could not find a CodeWalker skeleton for runtime ped {model_name} ({model_hash})")

    try:
        from SharpDX import Vector3  # type: ignore
    except Exception as e:
        raise SystemExit(f"Could not import SharpDX.Vector3: {e}") from e

    gait_names = [x.strip() for x in str(args.clips or "").split(",") if x.strip()]
    if not gait_names:
        raise SystemExit("No clips requested")

    ycd_names = _candidate_clip_dicts(gfc, model_name, model_hash, list(args.clip_dictionary or []))
    ycds: dict[str, Any] = {}
    selected: dict[str, tuple[str, Any]] = {}
    missing: list[str] = []
    for gait in gait_names:
        clip = None
        clip_ycd_name = ""
        for ycd_name in ycd_names:
            ycd = ycds.get(ycd_name)
            if ycd is None:
                ycd = _load_ycd(gfc, ycd_name, args.spins)
                if ycd is not None:
                    ycds[ycd_name] = ycd
            if ycd is None:
                continue
            clip = _find_clip(ycd, gait)
            if clip is not None:
                clip_ycd_name = ycd_name
                break
        if clip is None:
            missing.append(gait)
        else:
            selected[gait] = (clip_ycd_name, clip)

    if not selected:
        raise SystemExit(f"No requested clips found. Tried YCD dictionaries: {ycd_names}")

    bones = _bone_metadata(skeleton)
    bone_count = len(bones)
    clips: dict[str, Any] = {}
    for gait, (ycd_name, clip) in selected.items():
        logger.info("Exporting %s from %s", gait, ycd_name)
        clips[gait] = _export_clip(skeleton, clip, gait, ycd_name, float(args.fps), Vector3)
        frame_len = int(clips[gait]["frameCount"]) and len(clips[gait]["frames3x4"][0])
        expected = bone_count * 12
        if frame_len != expected:
            raise SystemExit(f"Clip {gait} frame length {frame_len} != expected {expected}")

    out_path = assets_dir / "peds" / f"{model_hash}_animations.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema": "webglgta-ped-ycd-animation-palettes-v1",
        "source": "CodeWalker YCD Animation evaluated through ped YFT Skeleton.UpdateSkinTransform",
        "modelName": model_name,
        "modelHash": model_hash,
        "boneCount": bone_count,
        "matrixStride": 12,
        "rootMotion": "tracks 5/6 are ignored; browser controller owns world displacement and heading",
        "candidateClipDictionaries": ycd_names,
        "missingClips": missing,
        "bones": bones,
        "clips": clips,
    }
    if args.merge_existing and out_path.exists():
        try:
            existing = json.loads(out_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            existing = None
        if isinstance(existing, dict) and int(existing.get("boneCount") or 0) == bone_count:
            merged_clips = dict(existing.get("clips") or {})
            merged_clips.update(clips)
            payload = {**existing, **payload, "clips": merged_clips}
            payload["missingClips"] = sorted(set(existing.get("missingClips") or []) | set(missing))
    out_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")

    render = profile.setdefault("render", {})
    render["animations"] = f"peds/{model_hash}_animations.json"
    render["animationSource"] = "CodeWalker YCD sampled skinTransforms3x4 on ped YFT skeleton"
    render["exactness"] = "component meshes use GTA blend weights/indices; movement clips use sampled GTA YCD bone palettes on the ped YFT skeleton"
    runtime_path.write_text(json.dumps(profile, indent=2), encoding="utf-8")

    print(
        "Done. "
        f"model={model_name}({model_hash}) bones={bone_count} "
        f"clips={{{', '.join(f'{k}:{v[0]}' for k, v in selected.items())}}} "
        f"missing={missing} out={out_path}"
    )


if __name__ == "__main__":
    main()

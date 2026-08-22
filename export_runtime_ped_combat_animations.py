#!/usr/bin/env python3
"""Append sampled GTA pistol combat clips to the browser ped animation palette."""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
from typing import Any

from gta5_modules.dll_manager import DllManager
from gta5_modules.hash_utils import joaat as _joaat
from gta5_modules.script_paths import auto_assets_dir

from export_runtime_ped_animations import (  # type: ignore
    _clip_duration,
    _evaluate_clip_stack_rows,
    _find_clip,
    _find_runtime_skeleton,
    _load_ycd,
    _remove_root_motion,
)


BASE_LOCOMOTION = {
    "idle": ("move_m@casual@a", "idle"),
    "walk": ("move_m@casual@a", "walk"),
    "run": ("move_m@multiplayer", "run"),
}

# label: (base gait, weapon dictionary, weapon clip, output duration source)
# The weapon clips are masked `BothArms_filter` layers. They must be evaluated
# after a complete body clip before SkinTransform matrices are serialized.
COMBAT_CLIPS = {
    "draw": ("idle", "weapons@pistol@", "holster_2_aim", "weapon"),
    "holster": ("idle", "weapons@pistol@", "aim_2_holster", "weapon"),
    "armed_idle": ("idle", "weapons@pistol@", "idle", "base"),
    "armed_walk": ("walk", "weapons@pistol@", "walk", "base"),
    "armed_run": ("run", "weapons@pistol@", "run", "base"),
    # Native pistol ADS first raises through the forward-medium transition,
    # then holds a static pose at rest or the matching loop while moving.
    "aim_enter_idle": ("idle", "weapons@pistol@", "idle_2_aim_fwd_med", "weapon"),
    "aim_enter_walk": ("walk", "weapons@pistol@", "idle_2_aim_fwd_med", "weapon"),
    "aim_enter_run": ("run", "weapons@pistol@", "idle_2_aim_fwd_med", "weapon"),
    # `aim_med_static` is authored in a different root space from the
    # third-person pistol transition. The server's BothArms-filtered ADS
    # motion remains continuous with `aim_med_loop`, including while idle.
    "aim_idle": ("idle", "weapons@pistol@", "aim_med_loop", "base"),
    "aim_walk": ("walk", "weapons@pistol@", "aim_med_loop", "base"),
    "aim_run": ("run", "weapons@pistol@", "aim_med_loop", "base"),
    # FiveM Glock's MotionClipSetHash is `weapons@pistol@combat_pistol`.
    "fire_idle": ("idle", "weapons@pistol@combat_pistol", "w_fire", "weapon"),
    "fire_walk": ("walk", "weapons@pistol@combat_pistol", "w_fire", "weapon"),
    "fire_run": ("run", "weapons@pistol@combat_pistol", "w_fire", "weapon"),
    "reload_idle": ("idle", "cover@weapon@reloads@pistol@pistol", "reload_low_left", "weapon"),
    "reload_walk": ("walk", "cover@weapon@reloads@pistol@pistol", "reload_low_left", "weapon"),
}

# `w_fire` is an upper-body recoil layer authored against the pistol ADS pose,
# not against ordinary locomotion.  Evaluate this intermediate layer before
# firing so the sampled first frame starts with hands already on the weapon.
FIRE_AIM_LAYERS = {
    "idle": ("weapons@pistol@", "aim_med_loop"),
    "walk": ("weapons@pistol@", "aim_med_loop"),
    "run": ("weapons@pistol@", "aim_med_loop"),
}


def _export_composite_combat_clip(
    skeleton: Any,
    label: str,
    base_name: str,
    base_ycd: str,
    base_clip: Any,
    weapon_ycd: str,
    weapon_clip: Any,
    duration_source: str,
    fps: float,
    vector3_cls: Any,
    pose_ycd: str = "",
    pose_clip: Any = None,
) -> dict[str, Any]:
    """Sample the native base locomotion plus masked weapon-layer result.

    ``BothArms_filter`` clips are not standalone poses.  They write a masked
    set of local arm transforms over a complete locomotion skeleton.  Serializing
    that evaluated stack gives WebGL the exact full-body palette GTA uses and
    prevents browser-side arm reconstruction from mixing incompatible spaces.
    """
    base_duration = max(0.033333, _clip_duration(base_clip))
    weapon_duration = max(0.033333, _clip_duration(weapon_clip))
    pose_duration = max(0.033333, _clip_duration(pose_clip)) if pose_clip is not None else 0.0
    duration = base_duration if duration_source == "base" else weapon_duration
    frame_count = max(2, int(math.ceil(duration * max(1.0, fps))))
    frames: list[list[float]] = []
    applied_total = 0
    ignored_total = 0
    static_weapon = duration_source == "base" and weapon_duration <= (1.0 / max(1.0, fps)) + 0.001
    for frame_i in range(frame_count):
        t = (frame_i / frame_count) * duration
        base_time = (t / duration) * base_duration if duration_source == "weapon" else t
        weapon_time = 0.0 if static_weapon else ((t / duration) * weapon_duration)
        # Pistol ADS uses its loop at every locomotion state. Keep idle at the
        # loop origin for a stable fire underlay; moving states advance it.
        pose_time = 0.0 if base_name == "idle" else ((t / duration) * pose_duration)
        stack = [(base_clip, base_time)]
        if pose_clip is not None:
            stack.append((pose_clip, pose_time))
        stack.append((weapon_clip, weapon_time))
        rows, applied, ignored = _evaluate_clip_stack_rows(
            skeleton,
            stack,
            vector3_cls,
        )
        frames.append(_remove_root_motion(rows))
        applied_total += applied
        ignored_total += ignored
    return {
        "sourceYcd": weapon_ycd,
        "sourceClip": str(getattr(weapon_clip, "ShortName", "") or label),
        "sourceClipName": str(getattr(weapon_clip, "Name", "") or ""),
        "baseYcd": base_ycd,
        "baseClip": str(getattr(base_clip, "ShortName", "") or base_name),
        "poseYcd": pose_ycd,
        "poseClip": str(getattr(pose_clip, "ShortName", "") or ""),
        "duration": round(duration, 7),
        "fps": round(fps, 7),
        "frameCount": frame_count,
        "skinTransformFormat": "row_major_float3x4_flat",
        "rootSpace": "relative_to_animated_root",
        "composite": True,
        "weaponLayer": False,
        # CodeWalker's sampled `w_fire` layer is pose-identity once evaluated
        # over ADS. The browser adds a constrained local-space recoil delta to
        # this valid GTA pose until a source clip exposes skeletal recoil keys.
        "requiresProceduralRecoil": label.startswith("fire_"),
        "layerFilter": "BothArms_filter",
        "frames3x4": frames,
        "diagnostics": {
            "evaluation": "base_locomotion_then_BothArms_filter",
            "baseDuration": round(base_duration, 7),
            "poseDuration": round(pose_duration, 7),
            "weaponDuration": round(weapon_duration, 7),
            "durationSource": duration_source,
            "appliedTracksTotal": applied_total,
            "ignoredTracksTotal": ignored_total,
        },
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-path", default=(os.getenv("gta_location") or os.getenv("gta5_path") or ""))
    ap.add_argument("--assets-dir", default="")
    ap.add_argument("--runtime-character", default="")
    ap.add_argument("--selected-dlc", default="all")
    ap.add_argument("--spins", type=int, default=1600)
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--output", default="", help="Output JSON path (defaults to peds/<modelHash>_combat_animations.json)")
    args = ap.parse_args()

    game_path = str(args.game_path or "").strip().strip('"').strip("'")
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
        raise SystemExit("runtime character profile is missing modelName/modelHash")

    dm = DllManager(game_path)
    if not dm.initialized:
        raise SystemExit("Failed to initialize CodeWalker DllManager")
    if not dm.init_game_file_cache(load_vehicles=False, load_peds=True, load_audio=False, selected_dlc=str(args.selected_dlc or "all")):
        raise SystemExit("Failed to initialize CodeWalker GameFileCache")
    gfc = dm.get_game_file_cache()
    skeleton = _find_runtime_skeleton(gfc, dm, profile, model_hash, args.spins)
    if skeleton is None:
        raise SystemExit(f"Could not resolve skeleton for {model_name}")
    try:
        from SharpDX import Vector3  # type: ignore
    except Exception as error:
        raise SystemExit(f"Could not import SharpDX.Vector3: {error}") from error

    base_path = assets_dir / "peds" / f"{model_hash}_animations.json"
    if not base_path.exists():
        raise SystemExit(f"Missing base animation palette: {base_path}")
    base_payload: dict[str, Any] = json.loads(base_path.read_text(encoding="utf-8"))
    out_path = Path(args.output).resolve() if args.output else (assets_dir / "peds" / f"{model_hash}_combat_animations.json")
    clips: dict[str, Any] = {}
    ycd_cache: dict[str, Any] = {}
    exported: dict[str, dict[str, str]] = {}
    base_clips: dict[str, tuple[str, Any]] = {}
    for base_name, (dictionary, source_clip) in BASE_LOCOMOTION.items():
        ycd = ycd_cache.get(dictionary)
        if ycd is None:
            ycd = _load_ycd(gfc, dictionary, args.spins)
            if ycd is None:
                raise SystemExit(f"Could not load locomotion YCD dictionary {dictionary}")
            ycd_cache[dictionary] = ycd
        clip = _find_clip(ycd, source_clip)
        if clip is None:
            raise SystemExit(f"Could not find locomotion clip {source_clip} in {dictionary}")
        base_clips[base_name] = (dictionary, clip)

    for label, (base_name, dictionary, source_clip, duration_source) in COMBAT_CLIPS.items():
        ycd = ycd_cache.get(dictionary)
        if ycd is None:
            ycd = _load_ycd(gfc, dictionary, args.spins)
            if ycd is None:
                raise SystemExit(f"Could not load YCD dictionary {dictionary}")
            ycd_cache[dictionary] = ycd
        clip = _find_clip(ycd, source_clip)
        if clip is None:
            raise SystemExit(f"Could not find {source_clip} in {dictionary}")
        base_dictionary, base_clip = base_clips[base_name]
        pose_dictionary = ""
        pose_clip = None
        if label.startswith("fire_"):
            pose_dictionary, pose_name = FIRE_AIM_LAYERS[base_name]
            pose_ycd = ycd_cache.get(pose_dictionary)
            if pose_ycd is None:
                pose_ycd = _load_ycd(gfc, pose_dictionary, args.spins)
                if pose_ycd is None:
                    raise SystemExit(f"Could not load pistol aim YCD dictionary {pose_dictionary}")
                ycd_cache[pose_dictionary] = pose_ycd
            pose_clip = _find_clip(pose_ycd, pose_name)
            if pose_clip is None:
                raise SystemExit(f"Could not find pistol aim clip {pose_name} in {pose_dictionary}")
        clips[label] = _export_composite_combat_clip(
            skeleton,
            label,
            base_name,
            base_dictionary,
            base_clip,
            dictionary,
            clip,
            duration_source,
            float(args.fps),
            Vector3,
            pose_dictionary,
            pose_clip,
        )
        exported[label] = {
            "dictionary": dictionary,
            "clip": source_clip,
            "baseDictionary": base_dictionary,
            "baseClip": str(getattr(base_clip, "ShortName", "") or base_name),
            "poseDictionary": pose_dictionary,
            "poseClip": str(getattr(pose_clip, "ShortName", "") or ""),
        }

    payload = {
        "schema": "webglgta-ped-ycd-combat-composite-palettes-v6",
        "source": "CodeWalker sampled GTA locomotion, pistol aim, and pistol BothArms_filter composite palettes",
        "modelName": model_name,
        "modelHash": model_hash,
        "boneCount": int(base_payload.get("boneCount") or 0),
        "matrixStride": 12,
        "rootMotion": "tracks 5/6 are ignored; browser controller owns world displacement and heading",
        "combatClips": exported,
        "clips": clips,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"Exported GTA pistol clips to {out_path}: {', '.join(exported)}")


if __name__ == "__main__":
    main()

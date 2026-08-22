#!/usr/bin/env python3
"""Export skeleton and GTA animation palettes for several ambient peds in one cache pass."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from gta5_modules.dll_manager import DllManager
from gta5_modules.hash_utils import joaat
from gta5_modules.script_paths import auto_assets_dir

from export_runtime_ped_animations import (
    _bone_metadata,
    _candidate_clip_dicts,
    _export_clip,
    _find_clip,
    _find_runtime_skeleton,
    _load_ycd,
)
from export_runtime_ped_combat_animations import (
    BASE_LOCOMOTION,
    COMBAT_CLIPS,
    FIRE_AIM_LAYERS,
    _export_composite_combat_clip,
)
from export_runtime_ped_melee_animations import MELEE_CLIPS
from export_runtime_ped_skinning import _export_skeleton_json


DEFAULT_MODELS = (
    "a_m_y_skater_01",
    "a_m_y_business_02",
    "a_f_y_business_02",
    "a_m_m_bevhills_02",
    "a_f_y_tourist_01",
)


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")


def load_clip(gfc: Any, cache: dict[str, Any], dictionary: str, name: str, spins: int) -> Any:
    ycd = cache.get(dictionary)
    if ycd is None:
        ycd = _load_ycd(gfc, dictionary, spins)
        if ycd is None:
            raise RuntimeError(f"Could not load YCD dictionary {dictionary}")
        cache[dictionary] = ycd
    clip = _find_clip(ycd, name)
    if clip is None:
        raise RuntimeError(f"Could not find {name} in {dictionary}")
    return clip


def export_model(
    gfc: Any,
    dm: Any,
    vector3: Any,
    assets_dir: Path,
    model_name: str,
    spins: int,
    fps: float,
    ycd_cache: dict[str, Any],
) -> None:
    model_hash = int(joaat(model_name, lower=True)) & 0xFFFFFFFF
    profile = {"modelName": model_name, "modelHash": model_hash, "render": {}}
    skeleton = _find_runtime_skeleton(gfc, dm, profile, model_hash, spins)
    if skeleton is None:
        raise RuntimeError(f"Could not resolve skeleton for {model_name} ({model_hash})")

    ped_dir = assets_dir / "peds"
    skeleton_path = ped_dir / f"{model_hash}_skeleton.json"
    if not _export_skeleton_json(
        [], skeleton_path, model_name, model_hash, skeleton=skeleton,
        source="CodeWalker YFT Fragment.Drawable.Skeleton",
    ):
        raise RuntimeError(f"Could not export skeleton for {model_name}")

    bones = _bone_metadata(skeleton)
    dictionaries = _candidate_clip_dicts(gfc, model_name, model_hash, [])
    base_clips: dict[str, Any] = {}
    missing: list[str] = []
    for gait in ("idle", "walk", "run", "sprint"):
        selected = None
        selected_dictionary = ""
        for dictionary in dictionaries:
            try:
                selected = load_clip(gfc, ycd_cache, dictionary, gait, spins)
                selected_dictionary = dictionary
                break
            except RuntimeError:
                continue
        if selected is None:
            missing.append(gait)
            continue
        base_clips[gait] = _export_clip(skeleton, selected, gait, selected_dictionary, fps, vector3)

    if not base_clips:
        raise RuntimeError(f"No locomotion clips found for {model_name}")
    base_payload = {
        "schema": "webglgta-ped-ycd-animation-palettes-v1",
        "source": "CodeWalker YCD Animation evaluated through ped YFT Skeleton.UpdateSkinTransform",
        "modelName": model_name,
        "modelHash": model_hash,
        "boneCount": len(bones),
        "matrixStride": 12,
        "rootMotion": "tracks 5/6 are ignored; browser controller owns world displacement and heading",
        "candidateClipDictionaries": dictionaries,
        "missingClips": missing,
        "bones": bones,
        "clips": base_clips,
    }
    write_json(ped_dir / f"{model_hash}_animations.json", base_payload)

    locomotion: dict[str, tuple[str, Any]] = {}
    for name, (dictionary, clip_name) in BASE_LOCOMOTION.items():
        locomotion[name] = (dictionary, load_clip(gfc, ycd_cache, dictionary, clip_name, spins))
    combat_clips: dict[str, Any] = {}
    combat_sources: dict[str, Any] = {}
    for label, (base_name, dictionary, clip_name, duration_source) in COMBAT_CLIPS.items():
        weapon_clip = load_clip(gfc, ycd_cache, dictionary, clip_name, spins)
        base_dictionary, base_clip = locomotion[base_name]
        pose_dictionary = ""
        pose_clip = None
        if label.startswith("fire_"):
            pose_dictionary, pose_name = FIRE_AIM_LAYERS[base_name]
            pose_clip = load_clip(gfc, ycd_cache, pose_dictionary, pose_name, spins)
        combat_clips[label] = _export_composite_combat_clip(
            skeleton, label, base_name, base_dictionary, base_clip, dictionary,
            weapon_clip, duration_source, fps, vector3, pose_dictionary, pose_clip,
        )
        combat_sources[label] = {
            "dictionary": dictionary,
            "clip": clip_name,
            "baseDictionary": base_dictionary,
            "baseClip": str(getattr(base_clip, "ShortName", "") or base_name),
            "poseDictionary": pose_dictionary,
            "poseClip": str(getattr(pose_clip, "ShortName", "") or ""),
        }
    write_json(ped_dir / f"{model_hash}_combat_animations.json", {
        "schema": "webglgta-ped-ycd-combat-composite-palettes-v6",
        "source": "CodeWalker sampled GTA locomotion, pistol aim, and pistol BothArms_filter composite palettes",
        "modelName": model_name,
        "modelHash": model_hash,
        "boneCount": len(bones),
        "matrixStride": 12,
        "rootMotion": "tracks 5/6 are ignored; browser controller owns world displacement and heading",
        "combatClips": combat_sources,
        "clips": combat_clips,
    })

    melee_clips: dict[str, Any] = {}
    melee_sources: dict[str, Any] = {}
    for label, (dictionary, clip_name) in MELEE_CLIPS.items():
        clip = load_clip(gfc, ycd_cache, dictionary, clip_name, spins)
        melee_clips[label] = _export_clip(skeleton, clip, label, dictionary, fps, vector3)
        melee_clips[label]["fullBody"] = True
        melee_sources[label] = {"dictionary": dictionary, "clip": clip_name}
    write_json(ped_dir / f"{model_hash}_melee_animations.json", {
        "schema": "webglgta-ped-ycd-melee-palettes-v1",
        "source": "CodeWalker sampled GTA V full-body YCD palettes",
        "modelName": model_name,
        "modelHash": model_hash,
        "boneCount": len(bones),
        "matrixStride": 12,
        "meleeClips": melee_sources,
        "clips": melee_clips,
    })
    print(f"Exported {model_name} ({model_hash}): {len(bones)} bones")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--game-path", default=(os.getenv("gta_location") or os.getenv("gta5_path") or ""))
    parser.add_argument("--assets-dir", default="")
    parser.add_argument("--models", default=",".join(DEFAULT_MODELS))
    parser.add_argument("--selected-dlc", default="all")
    parser.add_argument("--spins", type=int, default=1600)
    parser.add_argument("--fps", type=float, default=30.0)
    args = parser.parse_args()

    game_path = str(args.game_path or "").strip().strip('"').strip("'")
    if not game_path:
        raise SystemExit("Missing --game-path")
    models = [item.strip().lower() for item in str(args.models).split(",") if item.strip()]
    assets_dir = auto_assets_dir(args.assets_dir)
    dm = DllManager(game_path)
    if not dm.initialized:
        raise SystemExit("Failed to initialize CodeWalker DllManager")
    if not dm.init_game_file_cache(load_vehicles=False, load_peds=True, load_audio=False, selected_dlc=args.selected_dlc):
        raise SystemExit("Failed to initialize CodeWalker GameFileCache")
    gfc = dm.get_game_file_cache()
    try:
        from SharpDX import Vector3
    except Exception as error:
        raise SystemExit(f"Could not import SharpDX.Vector3: {error}") from error

    cache: dict[str, Any] = {}
    for model in models:
        export_model(gfc, dm, Vector3, assets_dir, model, args.spins, float(args.fps), cache)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Export full-body GTA unarmed combat, reaction, recovery, and death palettes."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from gta5_modules.dll_manager import DllManager
from gta5_modules.hash_utils import joaat as _joaat
from gta5_modules.script_paths import auto_assets_dir

from export_runtime_ped_animations import (
    _export_clip,
    _find_clip,
    _find_runtime_skeleton,
    _load_ycd,
)


# These are full-body clips from GTA V, not procedural browser poses.
MELEE_CLIPS = {
    "melee_intro": ("melee@unarmed@streamed_variations", "melee_intro_a"),
    "melee_punch_right": ("melee@unarmed@streamed_core", "short_0_punch"),
    "melee_punch_left": ("melee@unarmed@streamed_core", "heavy_punch_a"),
    "melee_kick": ("melee@unarmed@streamed_core", "kick_close_a"),
    "melee_npc_attack": ("melee@unarmed@streamed_core", "walking_punch"),
    "melee_hit_front": ("melee@unarmed@streamed_core", "non_melee_damage_front"),
    "melee_hit_left": ("melee@unarmed@streamed_core", "melee_damage_left"),
    "melee_hit_right": ("melee@unarmed@streamed_core", "melee_damage_right"),
    "melee_hit_back": ("melee@unarmed@streamed_core", "melee_damage_back"),
    "melee_knockdown": ("combat@damage@injured_pistol@to_writhe", "variation_a"),
    "melee_knockdown_kick": ("combat@damage@injured_pistol@to_writhe", "variation_d"),
    "melee_writhe": ("combat@damage@writheidle_a", "writhe_idle_a"),
    "melee_getup": ("get_up@directional@movement@from_knees@standard", "getup_r_0"),
    "melee_getup_injured": ("get_up@directional@movement@from_knees@injured", "getup_r_0"),
    "melee_death_a": ("dead", "dead_a"),
    "melee_death_b": ("dead", "dead_b"),
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--game-path", default=(os.getenv("gta_location") or os.getenv("gta5_path") or ""))
    parser.add_argument("--assets-dir", default="")
    parser.add_argument("--runtime-character", default="")
    parser.add_argument("--selected-dlc", default="all")
    parser.add_argument("--spins", type=int, default=1600)
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--output", default="")
    args = parser.parse_args()

    game_path = str(args.game_path or "").strip().strip('"').strip("'")
    if not game_path:
        raise SystemExit("Missing --game-path (or gta_location/gta5_path env var)")
    assets_dir = auto_assets_dir(args.assets_dir)
    runtime_path = Path(args.runtime_character) if args.runtime_character else assets_dir / "runtime_character.json"
    profile: dict[str, Any] = json.loads(runtime_path.read_text(encoding="utf-8"))
    model_name = str(profile.get("modelName") or "").strip()
    model_hash = int(profile.get("modelHash") or (_joaat(model_name, lower=True) if model_name else 0)) & 0xFFFFFFFF
    if not model_name or not model_hash:
        raise SystemExit("runtime character profile is missing modelName/modelHash")

    dm = DllManager(game_path)
    if not dm.initialized:
        raise SystemExit("Failed to initialize CodeWalker DllManager")
    if not dm.init_game_file_cache(load_vehicles=False, load_peds=True, load_audio=False, selected_dlc=args.selected_dlc):
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
    base_payload = json.loads(base_path.read_text(encoding="utf-8"))
    clips: dict[str, Any] = {}
    sources: dict[str, Any] = {}
    ycd_cache: dict[str, Any] = {}
    for label, (dictionary, source_clip) in MELEE_CLIPS.items():
        ycd = ycd_cache.get(dictionary)
        if ycd is None:
            ycd = _load_ycd(gfc, dictionary, args.spins)
            if ycd is None:
                raise SystemExit(f"Could not load YCD dictionary {dictionary}")
            ycd_cache[dictionary] = ycd
        clip = _find_clip(ycd, source_clip)
        if clip is None:
            raise SystemExit(f"Could not find {source_clip} in {dictionary}")
        clips[label] = _export_clip(skeleton, clip, label, dictionary, float(args.fps), Vector3)
        clips[label]["fullBody"] = True
        sources[label] = {"dictionary": dictionary, "clip": source_clip}

    output = Path(args.output).resolve() if args.output else assets_dir / "peds" / f"{model_hash}_melee_animations.json"
    payload = {
        "schema": "webglgta-ped-ycd-melee-palettes-v1",
        "source": "CodeWalker sampled GTA V full-body YCD palettes",
        "modelName": model_name,
        "modelHash": model_hash,
        "boneCount": int(base_payload.get("boneCount") or 0),
        "matrixStride": 12,
        "meleeClips": sources,
        "clips": clips,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"Exported {len(clips)} GTA melee clips to {output}")


if __name__ == "__main__":
    main()

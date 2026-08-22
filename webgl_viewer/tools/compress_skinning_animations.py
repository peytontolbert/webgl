#!/usr/bin/env python3
"""Pack exported ped skinning JSON into gzip-compressed float16 SKP1 archives."""

from __future__ import annotations

import argparse
import gzip
import json
import math
import struct
from pathlib import Path

MAGIC = b"SKP1"
VERSION = 1
HEADER_BYTES = 16


def finite_float(value: object) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return 0.0
    return result if math.isfinite(result) else 0.0


def clip_metadata(name: str, clip: dict, bone_count: int, value_offset: int) -> dict:
    frames = clip.get("frames3x4") or clip.get("frames") or []
    metadata = {
        "name": name,
        "sourceYcd": str(clip.get("sourceYcd") or ""),
        "sourceClip": str(clip.get("sourceClip") or clip.get("sourceClipName") or name),
        "composite": clip.get("composite") is True,
        "weaponLayer": clip.get("weaponLayer") is True,
        "requiresProceduralRecoil": clip.get("requiresProceduralRecoil") is True,
        "fullBody": clip.get("fullBody") is True,
        "duration": finite_float(clip.get("duration")),
        "fps": max(1.0, finite_float(clip.get("fps")) or 30.0),
        "frameCount": len(frames),
        "valueOffset": value_offset,
        "boneCount": bone_count,
    }
    root_motion = clip.get("rootMotion")
    if isinstance(root_motion, dict):
        frames = root_motion.get("frames")
        if isinstance(frames, list) and len(frames) >= 2:
            compact_frames = []
            for frame in frames:
                if not isinstance(frame, list) or len(frame) < 7:
                    compact_frames = []
                    break
                compact_frames.append([finite_float(value) for value in frame[:7]])
            if len(compact_frames) == len(frames):
                metadata["rootMotion"] = {
                    "space": str(root_motion.get("space") or "ped_local_z_up"),
                    "format": str(root_motion.get("format") or "position_xyz_rotation_xyzw"),
                    "frames": compact_frames,
                }
    return metadata


def pack_one(source: Path, destination: Path) -> tuple[int, int, int]:
    document = json.loads(source.read_text(encoding="utf-8"))
    bone_count = int(document.get("boneCount") or 0)
    if bone_count <= 0:
        raise ValueError(f"{source}: missing boneCount")
    expected = bone_count * 12
    clips_in = document.get("clips") or {}
    if not isinstance(clips_in, dict):
        raise ValueError(f"{source}: clips is not an object")

    clips = []
    values = bytearray()
    value_offset = 0
    for raw_name, raw_clip in clips_in.items():
        name = str(raw_name).strip().lower()
        clip = raw_clip if isinstance(raw_clip, dict) else {}
        frames = clip.get("frames3x4") or clip.get("frames") or []
        if not name or not isinstance(frames, list) or len(frames) < 2:
            continue
        for frame_index, frame in enumerate(frames):
            if not isinstance(frame, list) or len(frame) < expected:
                raise ValueError(f"{source}: {name} frame {frame_index} has an invalid matrix count")
            for value in frame[:expected]:
                values.extend(struct.pack("<e", finite_float(value)))
        clips.append(clip_metadata(name, clip, bone_count, value_offset))
        value_offset += len(frames) * expected
    if not clips:
        raise ValueError(f"{source}: no valid clips")

    metadata = json.dumps({
        "schema": "webglgta-float16-skinning-pack-v1",
        "sourceSchema": str(document.get("schema") or ""),
        "boneCount": bone_count,
        "matrixStride": 12,
        "encoding": "float16",
        "clips": clips,
    }, separators=(",", ":")).encode("utf-8")
    values_offset = HEADER_BYTES + len(metadata)
    if values_offset & 1:
        values_offset += 1
    header = MAGIC + struct.pack("<HHII", VERSION, HEADER_BYTES, len(metadata), values_offset)
    raw = header + metadata + (b"\0" * (values_offset - HEADER_BYTES - len(metadata))) + values
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as target:
        with gzip.GzipFile(filename="", mode="wb", fileobj=target, mtime=0) as output:
            output.write(raw)
    return len(raw), destination.stat().st_size, len(clips)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("sources", nargs="*", type=Path, help="Animation JSON files; defaults to assets/peds/*_animations.json")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    root = args.root.resolve()
    sources = args.sources or sorted((root / "assets" / "peds").glob("*_animations.json"))
    if not sources:
        raise SystemExit("No animation JSON files found")
    total_raw = total_gzip = total_clips = 0
    for candidate in sources:
        source = candidate if candidate.is_absolute() else (root / candidate)
        source = source.resolve()
        destination = source.with_suffix(".skp.gz")
        raw_bytes, gzip_bytes, clip_count = pack_one(source, destination)
        total_raw += raw_bytes
        total_gzip += gzip_bytes
        total_clips += clip_count
        print(f"{source.name}: clips={clip_count} skp={raw_bytes} gzip={gzip_bytes} -> {destination.name}")
    print(f"packed files={len(sources)} clips={total_clips} skp={total_raw} gzip={total_gzip}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Reconcile canonical retained TNM sectors with a spatial track manifest.

This intentionally audits files that never entered the manifest; descriptor
field coverage cannot detect those omissions.  Optional voxel overlap helps
distinguish a missing visual sector from a duplicate aggregate/collision shell.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import numpy as np

from import_track_into_demo_renderer import read_tnm


CANONICAL_TNM = re.compile(r"^([A-Za-z0-9_]+)\.tnm(?:\.gz)?$")


def voxel_keys(positions: np.ndarray, size: float) -> np.ndarray:
    q = np.floor(positions.astype(np.float64) / size).astype(np.int64)
    # Track coordinates fit comfortably in signed 21-bit lanes.
    bias = np.int64(1 << 20)
    mask = np.int64((1 << 21) - 1)
    return (((q[:, 0] + bias) & mask) << np.int64(42)) | (((q[:, 1] + bias) & mask) << np.int64(21)) | ((q[:, 2] + bias) & mask)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scene", type=Path, required=True)
    parser.add_argument("--inventory-dir", type=Path, required=True)
    parser.add_argument("--overlap-voxel", type=float, default=0.25)
    args = parser.parse_args()

    scene = json.loads(args.scene.read_text(encoding="utf-8"))
    declared = {str(model.get("source") or "") for model in scene.get("models") or []}
    retained: dict[str, Path] = {}
    for path in args.inventory_dir.iterdir():
        match = CANONICAL_TNM.match(path.name)
        if match:
            retained[f"{match.group(1)}.kn5"] = path

    existing_keys: list[np.ndarray] = []
    for model in scene.get("models") or []:
        decoded = read_tnm(args.scene.parent / str(model["file"]))
        used = np.unique(decoded["indices"])
        existing_keys.append(voxel_keys(decoded["positions"][used], args.overlap_voxel))
    occupied = np.unique(np.concatenate(existing_keys)) if existing_keys else np.empty(0, dtype=np.int64)

    omissions = []
    for source in sorted(set(retained) - declared):
        decoded = read_tnm(retained[source])
        indices = decoded["indices"]
        used = np.unique(indices) if len(indices) else np.empty(0, dtype=np.uint32)
        positions = decoded["positions"][used] if len(used) else np.empty((0, 3), dtype=np.float32)
        keys = voxel_keys(positions, args.overlap_voxel) if len(positions) else np.empty(0, dtype=np.int64)
        overlap = np.isin(keys, occupied, assume_unique=False) if len(keys) else np.empty(0, dtype=bool)
        omissions.append({
            "source": source,
            "file": str(retained[source]),
            "vertices": int(len(decoded["positions"])),
            "usedVertices": int(len(used)),
            "indices": int(len(indices)),
            "triangles": int(len(indices) // 3),
            "groups": int(decoded["group_count"]),
            "renderable": bool(len(indices) >= 3 and len(indices) % 3 == 0),
            "bounds": {
                "min": positions.min(axis=0).tolist() if len(positions) else None,
                "max": positions.max(axis=0).tolist() if len(positions) else None,
            },
            "vertexVoxelOverlapWithManifest": float(np.mean(overlap)) if len(overlap) else None,
            "materialRecoveryPossible": bool(decoded["group_count"] > 0),
        })

    print(json.dumps({
        "schema": "webglgta-track-source-inventory-audit-v1",
        "declaredSources": sorted(declared),
        "retainedSources": sorted(retained),
        "missingFromManifest": omissions,
        "voxelSize": args.overlap_voxel,
        "occupiedManifestVoxels": int(len(occupied)),
    }, indent=2))


if __name__ == "__main__":
    main()

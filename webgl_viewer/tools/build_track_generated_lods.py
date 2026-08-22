#!/usr/bin/env python3
"""Generate border-preserving medium/low LOD packs for a unified track descriptor."""

from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import json
import re
from pathlib import Path
from typing import Any

from build_mlo_generated_lods import simplify_mesh


REF = re.compile(r"^@demo-pack/([^#]+)#(\d+):(\d+)$")


def source_slice(web_root: Path, source_pack_dir: Path | None, reference: str, cache: dict[str, bytes]) -> bytes:
    match = REF.match(reference)
    if not match:
        raise ValueError(f"track submesh is not packed: {reference}")
    name, offset, length = match.group(1), int(match.group(2)), int(match.group(3))
    payload = cache.get(name)
    if payload is None:
        source = web_root / "assets" / "demo" / name
        if source_pack_dir is not None:
            staged = source_pack_dir / Path(name).name
            if staged.is_file():
                source = staged
        payload = source.read_bytes()
        cache[name] = payload
    if offset < 0 or length <= 0 or offset + length > len(payload):
        raise ValueError(f"slice outside source pack: {reference}")
    return payload[offset:offset + length]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("descriptor", type=Path)
    parser.add_argument("--web-root", type=Path, required=True)
    parser.add_argument("--source-pack-dir", type=Path, help="staged source pack directory overriding the served tree")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--tag", default="lod2")
    parser.add_argument("--medium-reduction", type=float, default=0.45)
    parser.add_argument("--low-reduction", type=float, default=0.70)
    parser.add_argument("--pack-bytes", type=int, default=16 * 1024 * 1024)
    args = parser.parse_args()

    descriptor = json.loads(args.descriptor.read_text(encoding="utf-8"))
    output = args.output.resolve()
    packs_dir = output / "packs"
    packs_dir.mkdir(parents=True, exist_ok=True)
    source_packs: dict[str, bytes] = {}
    generated_packs: list[bytearray] = []
    generated_members: list[list[tuple[dict[str, Any], int, int]]] = []
    lod_stats: dict[str, dict[str, int]] = {
        "high": {"submeshes": 0, "vertices": 0, "indices": 0, "bytes": 0},
        "med": {"submeshes": 0, "vertices": 0, "indices": 0, "bytes": 0},
        "low": {"submeshes": 0, "vertices": 0, "indices": 0, "bytes": 0},
    }

    total = sum(
        len(((mesh.get("lods") or {}).get("high") or {}).get("submeshes") or [])
        for mesh in (descriptor.get("meshes") or {}).values()
    )
    completed = 0
    for mesh in (descriptor.get("meshes") or {}).values():
        high = (mesh.get("lods") or {}).get("high")
        if not isinstance(high, dict) or not isinstance(high.get("submeshes"), list):
            raise ValueError("every track archetype must have a high LOD")
        generated: dict[str, dict[str, Any]] = {}
        for lod, reduction in (("med", args.medium_reduction), ("low", args.low_reduction)):
            submeshes: list[dict[str, Any]] = []
            for high_submesh in high["submeshes"]:
                raw = source_slice(args.web_root, args.source_pack_dir, str(high_submesh.get("file") or ""), source_packs)
                packed, vertices, indices = simplify_mesh(raw, reduction)
                if vertices < 3 or indices < 3 or indices % 3:
                    raise ValueError(f"simplifier produced invalid {lod} topology for {high_submesh.get('file')}")
                metadata = copy.deepcopy(high_submesh)
                metadata["vertexCount"] = int(vertices)
                metadata["indexCount"] = int(indices)
                if not generated_packs or len(generated_packs[-1]) + len(packed) > args.pack_bytes:
                    generated_packs.append(bytearray())
                    generated_members.append([])
                offset = len(generated_packs[-1])
                generated_packs[-1].extend(packed)
                generated_members[-1].append((metadata, offset, len(packed)))
                submeshes.append(metadata)
                lod_stats[lod]["submeshes"] += 1
                lod_stats[lod]["vertices"] += int(vertices)
                lod_stats[lod]["indices"] += int(indices)
                lod_stats[lod]["bytes"] += len(packed)
            generated[lod] = {
                "submeshes": submeshes,
                # Reuse conservative high bounds so simplification can never
                # make an LOD disappear early due to a tightened culling box.
                "bounds": copy.deepcopy(high.get("bounds") or mesh.get("bounds")),
                "radius": float(high.get("radius") or mesh.get("radius") or 0.0),
            }
        mesh.setdefault("lods", {}).update(generated)
        mesh["lodDistances"] = {"High": 420.0, "Med": 1100.0, "Low": 1800.0, "VLow": 1800.0}
        for high_submesh in high["submeshes"]:
            lod_stats["high"]["submeshes"] += 1
            lod_stats["high"]["vertices"] += int(high_submesh.get("vertexCount") or 0)
            lod_stats["high"]["indices"] += int(high_submesh.get("indexCount") or 0)
            match = REF.match(str(high_submesh.get("file") or ""))
            lod_stats["high"]["bytes"] += int(match.group(3)) if match else 0
        completed += len(high["submeshes"])
        if completed and (completed % 200 < len(high["submeshes"]) or completed == total):
            print(json.dumps({"progressSubmeshes": completed, "totalSubmeshes": total}), flush=True)

    revisions = descriptor.setdefault("meshPackRevisions", {})
    pack_names: list[str] = []
    for index, (payload, members) in enumerate(zip(generated_packs, generated_members)):
        filename = f"track_nordschleife_{args.tag}_lod_{index:03d}.meshpack"
        path = packs_dir / filename
        path.write_bytes(payload)
        path.with_name(path.name + ".gz").write_bytes(gzip.compress(bytes(payload), compresslevel=7, mtime=0))
        relative = f"tracks/nordschleife/packs/{filename}"
        revisions[relative] = hashlib.sha256(payload).hexdigest()[:16]
        pack_names.append(relative)
        for metadata, offset, length in members:
            metadata["file"] = f"@demo-pack/{relative}#{offset}:{length}"

    descriptor["generatedTrackLods"] = {
        "schema": "webglgta-track-generated-lods-v1",
        "method": "quadric-edge-collapse-preserve-partition-borders",
        "reductions": {"med": args.medium_reduction, "low": args.low_reduction},
        "lodDistances": {"high": 420, "med": 1100, "low": 1800},
        "packs": pack_names,
        "stats": lod_stats,
    }
    output.mkdir(parents=True, exist_ok=True)
    (output / "demo_renderer.json").write_text(json.dumps(descriptor, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"packs": len(pack_names), "lods": lod_stats}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

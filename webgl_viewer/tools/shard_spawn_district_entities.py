#!/usr/bin/env python3
"""Split the final demo ENT1 file into player-streamed spatial tiles."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
from pathlib import Path


def read_ent1(path: Path) -> tuple[int, list[bytes]]:
    data = path.read_bytes()
    if len(data) < 8 or data[:4] != b"ENT1":
        raise ValueError(f"{path} is not an ENT1 file")
    count = struct.unpack_from("<I", data, 4)[0]
    payload = len(data) - 8
    if count <= 0 or payload % count:
        raise ValueError(f"{path} has an invalid ENT1 payload")
    stride = payload // count
    if stride not in (44, 48, 64):
        raise ValueError(f"unsupported ENT1 stride: {stride}")
    return stride, [data[8 + i * stride:8 + (i + 1) * stride] for i in range(count)]


def shard(descriptor_path: Path, chunk_size: float) -> dict:
    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
    assets_dir = descriptor_path.parents[1]
    instance_rel = str(descriptor["instanceFile"]).replace("\\", "/")
    local_instance = descriptor_path.parent / Path(instance_rel).name
    instance_path = local_instance if local_instance.is_file() else assets_dir / instance_rel.removeprefix("assets/")
    stride, records = read_ent1(instance_path)

    buckets: dict[str, list[bytes]] = {}
    z_values: list[float] = []
    for record in records:
        x, y, z = struct.unpack_from("<3f", record, 4)
        key = f"{math.floor(x / chunk_size)}_{math.floor(y / chunk_size)}"
        buckets.setdefault(key, []).append(record)
        z_values.append(z)

    output_dir = descriptor_path.parent / "spawn_district_chunks"
    output_dir.mkdir(parents=True, exist_ok=True)
    expected = set()
    chunks = {}
    chunk_revision = hashlib.sha256()
    for key, tile_records in sorted(buckets.items()):
        filename = f"{key}.bin"
        expected.add(filename)
        path = output_dir / filename
        payload = b"ENT1" + struct.pack("<I", len(tile_records)) + b"".join(tile_records)
        with path.open("wb") as out:
            out.write(payload)
        chunk_revision.update(key.encode("ascii"))
        chunk_revision.update(payload)
        chunks[key] = {
            "count": len(tile_records),
            "file": filename,
            "binaryFile": f"demo/spawn_district_chunks/{filename}",
        }

    for stale in output_dir.glob("*.bin"):
        if stale.name not in expected:
            stale.unlink()

    bounds = descriptor.get("bounds") or {}
    index = {
        "version": 1,
        "schema": "webglgta-demo-entity-chunks-v1",
        "revision": chunk_revision.hexdigest()[:16],
        "chunk_size": chunk_size,
        "chunks_dir": "demo/spawn_district_chunks",
        "total_entities": len(records),
        "bounds": {
            "min_x": bounds.get("minX"), "min_y": bounds.get("minY"),
            "min_z": min(z_values), "max_x": bounds.get("maxX"),
            "max_y": bounds.get("maxY"), "max_z": max(z_values),
        },
        "chunks": chunks,
    }
    index_path = descriptor_path.parent / "spawn_district_entities_index.json"
    index_path.write_text(json.dumps(index, separators=(",", ":")) + "\n", encoding="utf-8")
    descriptor["instanceIndexFile"] = "demo/spawn_district_entities_index.json"
    descriptor["instanceChunkSize"] = chunk_size
    descriptor["instanceChunkCount"] = len(chunks)
    descriptor_path.write_text(json.dumps(descriptor, indent=2) + "\n", encoding="utf-8")
    return {"instances": len(records), "stride": stride, "chunks": len(chunks), "index": str(index_path)}


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--descriptor", type=Path, default=root / "assets/demo/spawn_district.json")
    parser.add_argument("--config", type=Path, default=root / "demo_world.json")
    parser.add_argument("--chunk-size", type=float, default=None)
    args = parser.parse_args()
    if args.chunk_size is None:
        config = json.loads(args.config.resolve().read_text(encoding="utf-8"))
        args.chunk_size = float((config.get("streaming") or {}).get("entityChunkSize", 256.0))
    if args.chunk_size <= 0:
        parser.error("--chunk-size must be positive")
    print(json.dumps(shard(args.descriptor.resolve(), args.chunk_size), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

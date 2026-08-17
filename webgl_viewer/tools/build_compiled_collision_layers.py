#!/usr/bin/env python3
"""Build the top-level manifest for a staged compiled collision deployment."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--ybn-manifest", type=Path, required=True)
    parser.add_argument("--asset-manifest", type=Path, required=True)
    parser.add_argument("--nurburgring-meta", type=Path, required=True)
    args = parser.parse_args()
    ybn = json.loads(args.ybn_manifest.read_text(encoding="utf-8"))
    assets = json.loads(args.asset_manifest.read_text(encoding="utf-8"))
    road = json.loads(args.nurburgring_meta.read_text(encoding="utf-8"))
    road_file = args.nurburgring_meta.parent / str(road.get("file") or "")
    if ybn.get("schema") != "webglgta-static-collision-v1" or assets.get("schema") != "webglgta-compiled-asset-colliders-v1":
        raise SystemExit("input manifests have unexpected schemas")
    if road.get("schema") != "webglgta-derived-road-v1" or not road_file.is_file():
        raise SystemExit("Nurburgring derived-road package is invalid")
    output = {
        "schema": "webglgta-compiled-collision-layers-v1",
        "base_layer": {
            "static_ybn": {"manifest": f"static_ybn/{args.ybn_manifest.name}", "source_sha256": ybn["source"]["sha256"], "chunk_count": ybn["chunk_count"]},
            "asset_colliders": {"manifest": f"asset_colliders/{args.asset_manifest.name}", "source_sha256": assets["source_sha256"], "chunk_count": len(assets["chunks"])},
        },
        "expansions": [{
            "id": "nordschleife",
            "role": "independent_derived_road_expansion",
            "metadata": "../../tracks/nordschleife/road.json",
            "binary": str(road["file"]),
            "binary_sha256": sha256(road_file),
            "conversion": "none",
            "note": "Existing NRB1 bytes are referenced unchanged; this expansion is not flattened into city collision.",
        }],
        "invariants": {
            "no_legacy_ybn_fallback": True,
            "dynamic_asset_records_remain_live": True,
            "source_geometry_is_not_modified": True,
        },
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"out": str(args.out), "static_chunks": ybn["chunk_count"], "asset_chunks": len(assets["chunks"]), "nurburgring_sha256": output["expansions"][0]["binary_sha256"]}, indent=2))


if __name__ == "__main__":
    main()

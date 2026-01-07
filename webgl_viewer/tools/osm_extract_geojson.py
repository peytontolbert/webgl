#!/usr/bin/env python3
"""
Extract a small bbox from an OSM .osm.pbf and export filtered layers to GeoJSON.

This is meant for *street-level* prototyping:
- keep outputs small
- run fast on a bbox
- no API keys

Requires:
- osmium-tool (CLI): apt-get install osmium-tool

Example:
  python tools/osm_extract_geojson.py \
    --in-pbf data/osm/virginia-latest.osm.pbf \
    --bbox -77.60,37.45,-77.35,37.60 \
    --outdir assets/datasets/osm_va_richmond
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile


def _osmium() -> str | None:
    return shutil.which("osmium")


def _run(cmd: list[str]) -> None:
    p = subprocess.run(cmd, check=False, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"Command failed ({p.returncode}): {' '.join(cmd)}\n{p.stdout}")


def _parse_bbox(s: str) -> str:
    parts = [p.strip() for p in str(s).split(",")]
    if len(parts) != 4:
        raise ValueError("bbox must be 'minLon,minLat,maxLon,maxLat'")
    min_lon = float(parts[0]); min_lat = float(parts[1]); max_lon = float(parts[2]); max_lat = float(parts[3])
    if max_lon <= min_lon or max_lat <= min_lat:
        raise ValueError("bbox max must be > min")
    # Preserve a clean numeric string for osmium.
    return f"{min_lon},{min_lat},{max_lon},{max_lat}"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in-pbf", required=True, help="Input .osm.pbf file")
    ap.add_argument("--bbox", required=True, help="BBox 'minLon,minLat,maxLon,maxLat'")
    ap.add_argument("--outdir", required=True, help="Output directory (under repo assets/ recommended)")
    ap.add_argument("--prefix", default="osm", help="Output filename prefix")
    args = ap.parse_args(argv)

    osmium = _osmium()
    if not osmium:
        print("Missing dependency: osmium-tool (osmium). Install it and retry.", file=sys.stderr)
        return 2

    in_pbf = args.in_pbf
    if not os.path.exists(in_pbf):
        print(f"Input not found: {in_pbf}", file=sys.stderr)
        return 2

    try:
        bbox = _parse_bbox(args.bbox)
    except Exception as e:
        print(f"Invalid --bbox: {e}", file=sys.stderr)
        return 2

    outdir = args.outdir
    os.makedirs(outdir, exist_ok=True)

    prefix = args.prefix.strip() or "osm"
    out_highways = os.path.join(outdir, f"{prefix}_highways.geojson")
    out_buildings = os.path.join(outdir, f"{prefix}_buildings.geojson")

    with tempfile.TemporaryDirectory(prefix="osmgeojson_") as td:
        sample_pbf = os.path.join(td, "sample.osm.pbf")
        highways_pbf = os.path.join(td, "highways.osm.pbf")
        buildings_pbf = os.path.join(td, "buildings.osm.pbf")

        # 1) Extract bbox
        _run([osmium, "extract", "-b", bbox, "--strategy", "complete_ways", "-o", sample_pbf, in_pbf])

        # 2) Filter layers
        _run([osmium, "tags-filter", "-o", highways_pbf, sample_pbf, "w/highway"])
        _run([osmium, "tags-filter", "-o", buildings_pbf, sample_pbf, "w/building"])

        # 3) Export to GeoJSON FeatureCollection
        # Note: `osmium export -f geojson` includes geometries for ways when possible.
        _run([osmium, "export", "-f", "geojson", "-o", out_highways, highways_pbf])
        _run([osmium, "export", "-f", "geojson", "-o", out_buildings, buildings_pbf])

    print("Wrote:")
    print(f"- {out_highways}")
    print(f"- {out_buildings}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))



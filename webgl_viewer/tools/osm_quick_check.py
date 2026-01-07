#!/usr/bin/env python3
"""
Quick sanity checks for an OpenStreetMap .osm.pbf extract.

This is *not* a full parser. It uses best-effort external tooling when available:
  - osmium-tool (preferred): https://osmcode.org/osmium-tool/

It always prints:
  - file path + on-disk size
  - whether `osmium` CLI is available

If `osmium` is available, it also prints:
  - fileinfo (incl. bounding box if present)

Optionally, you can request a light-weight tag scan *on a small bbox extract* (recommended),
because scanning an entire state is slow.

Examples:
  python tools/osm_quick_check.py --file data/osm/virginia-latest.osm.pbf

  # Extract a small bbox (lon/lat) and count highway/building ways there:
  python tools/osm_quick_check.py --file data/osm/virginia-latest.osm.pbf \\
    --sample-bbox "-77.6,37.4,-77.3,37.6" --counts
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile


def _fmt_bytes(n: int) -> str:
    kb = 1024
    mb = kb * 1024
    gb = mb * 1024
    if n >= gb:
        return f"{n / gb:.2f} GiB"
    if n >= mb:
        return f"{n / mb:.2f} MiB"
    if n >= kb:
        return f"{n / kb:.2f} KiB"
    return f"{n} B"


def _run(cmd: list[str], *, capture: bool = True) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, check=False, stdout=subprocess.PIPE if capture else None, stderr=subprocess.STDOUT, text=True)
        out = p.stdout or ""
        return int(p.returncode), out
    except FileNotFoundError:
        return 127, ""


def _osmium() -> str | None:
    return shutil.which("osmium")


def _parse_bbox(s: str) -> tuple[float, float, float, float]:
    parts = [p.strip() for p in str(s).split(",")]
    if len(parts) != 4:
        raise ValueError("bbox must be 'minLon,minLat,maxLon,maxLat'")
    min_lon = float(parts[0]); min_lat = float(parts[1]); max_lon = float(parts[2]); max_lat = float(parts[3])
    if max_lon <= min_lon or max_lat <= min_lat:
        raise ValueError("bbox max must be > min")
    return min_lon, min_lat, max_lon, max_lat


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True, help="Path to .osm.pbf extract")
    ap.add_argument("--sample-bbox", default="", help="Optional bbox 'minLon,minLat,maxLon,maxLat' for a small sample extract")
    ap.add_argument("--counts", action="store_true", help="If set, compute simple counts on the sample extract (requires osmium).")
    ap.add_argument("--json", action="store_true", help="Emit a JSON summary (best-effort).")
    args = ap.parse_args(argv)

    path = args.file
    if not os.path.exists(path):
        print(f"File not found: {path}", file=sys.stderr)
        return 2

    size = os.path.getsize(path)
    osmium = _osmium()

    summary: dict = {
        "file": os.path.abspath(path),
        "size_bytes": size,
        "size_human": _fmt_bytes(size),
        "osmium_available": bool(osmium),
        "osmium_path": osmium,
        "fileinfo": None,
        "sample": None,
    }

    if osmium:
        rc, out = _run([osmium, "fileinfo", "-e", path])
        summary["fileinfo"] = {"rc": rc, "output": out}

    if args.sample_bbox:
        if not osmium:
            print("Sample extract requested, but `osmium` is not installed. Install osmium-tool and retry.", file=sys.stderr)
            return 3

        try:
            min_lon, min_lat, max_lon, max_lat = _parse_bbox(args.sample_bbox)
        except Exception as e:
            print(f"Invalid --sample-bbox: {e}", file=sys.stderr)
            return 2

        with tempfile.TemporaryDirectory(prefix="osmsample_") as td:
            sample_pbf = os.path.join(td, "sample.osm.pbf")
            # osmium extract uses polygon/bbox; bbox is simplest.
            # Note: `--strategy complete_ways` keeps ways intact in the extract.
            bbox_str = f"{min_lon},{min_lat},{max_lon},{max_lat}"
            rc, out = _run([osmium, "extract", "-b", bbox_str, "--strategy", "complete_ways", "-o", sample_pbf, path])
            sample = {"bbox": bbox_str, "extract_rc": rc, "extract_output": out}

            if rc == 0 and args.counts:
                # Use `osmium tags-filter` to create tiny filtered extracts then `osmium fileinfo` to read counts.
                # This is still best-effort and depends on osmium output format.
                def count_filtered(label: str, filter_expr: str) -> dict:
                    out_pbf = os.path.join(td, f"filtered_{label}.osm.pbf")
                    rc1, out1 = _run([osmium, "tags-filter", "-o", out_pbf, sample_pbf, filter_expr])
                    rc2, out2 = _run([osmium, "fileinfo", "-e", out_pbf])
                    return {"filter": filter_expr, "tags_filter_rc": rc1, "tags_filter_output": out1, "fileinfo_rc": rc2, "fileinfo_output": out2}

                # Ways with highway tags approximate “street network exists”.
                # Ways with building tags approximate “building footprints exist”.
                sample["counts"] = {
                    "highway_ways": count_filtered("highway_ways", "w/highway"),
                    "building_ways": count_filtered("building_ways", "w/building"),
                }

            summary["sample"] = sample

    if args.json:
        print(json.dumps(summary, indent=2))
        return 0

    print(f"File: {summary['file']}")
    print(f"Size: {summary['size_human']} ({summary['size_bytes']} bytes)")
    print(f"osmium: {'yes' if osmium else 'no'}{f' ({osmium})' if osmium else ''}")
    if summary["fileinfo"]:
        print("\n=== osmium fileinfo -e ===")
        sys.stdout.write(summary["fileinfo"]["output"] or "")
        if summary["fileinfo"]["output"] and not summary["fileinfo"]["output"].endswith("\n"):
            sys.stdout.write("\n")

    if summary["sample"]:
        print("\n=== sample extract ===")
        print(f"bbox: {summary['sample']['bbox']}")
        if summary["sample"].get("extract_output"):
            sys.stdout.write(summary["sample"]["extract_output"])
            if not summary["sample"]["extract_output"].endswith("\n"):
                sys.stdout.write("\n")
        if args.counts and summary["sample"].get("counts"):
            print("\n=== sample counts (best-effort) ===")
            for k, v in summary["sample"]["counts"].items():
                print(f"\n-- {k} ({v.get('filter')}) --")
                out2 = v.get("fileinfo_output") or ""
                sys.stdout.write(out2)
                if out2 and not out2.endswith("\n"):
                    sys.stdout.write("\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))



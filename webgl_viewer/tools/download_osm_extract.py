#!/usr/bin/env python3
"""
Download an OpenStreetMap extract (.osm.pbf) safely.

Key goals:
- Show the remote file size BEFORE downloading.
- Require an explicit flag to start the download.
- Use only the Python standard library (no pip deps).

Default provider: Geofabrik (it hosts OpenStreetMap extracts; the data is still OSM).

Examples:
  # Show size only (no download)
  python tools/download_osm_extract.py --region virginia --info

  # Download to ./data/osm/ (explicit)
  python tools/download_osm_extract.py --region virginia --download --outdir data/osm

  # Use an explicit URL instead of region mapping
  python tools/download_osm_extract.py --url https://download.geofabrik.de/north-america/us/virginia-latest.osm.pbf --info
"""

from __future__ import annotations

import argparse
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


_DEFAULT_BASE = "https://download.geofabrik.de/north-america/us"

# Minimal starter mapping. Add more states as needed.
_REGION_TO_PATH = {
    # US state extracts under: https://download.geofabrik.de/north-america/us/
    "virginia": "virginia-latest.osm.pbf",
}


def _fmt_bytes(n: int | None) -> str:
    if not isinstance(n, int) or n < 0:
        return "unknown"
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


def _head(url: str, timeout_s: float = 20.0) -> tuple[int | None, str | None]:
    """
    Returns (content_length_bytes, final_url).
    """
    req = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        cl = resp.headers.get("Content-Length")
        try:
            n = int(cl) if cl is not None else None
        except ValueError:
            n = None
        return n, getattr(resp, "url", None)


def _download(url: str, out_path: str, timeout_s: float = 30.0, chunk_bytes: int = 1024 * 1024) -> None:
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    tmp_path = out_path + ".part"

    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=timeout_s) as resp, open(tmp_path, "wb") as f:
        total = resp.headers.get("Content-Length")
        try:
            total_n = int(total) if total is not None else None
        except ValueError:
            total_n = None

        done = 0
        t0 = time.time()
        last_print = 0.0
        while True:
            b = resp.read(chunk_bytes)
            if not b:
                break
            f.write(b)
            done += len(b)
            now = time.time()
            if now - last_print >= 0.5:
                dt = max(0.001, now - t0)
                mbps = (done / (1024 * 1024)) / dt
                if isinstance(total_n, int) and total_n > 0:
                    pct = (done / total_n) * 100.0
                    sys.stdout.write(f"\rDownloaded: {_fmt_bytes(done)} / {_fmt_bytes(total_n)} ({pct:.1f}%)  {mbps:.2f} MiB/s")
                else:
                    sys.stdout.write(f"\rDownloaded: {_fmt_bytes(done)}  {mbps:.2f} MiB/s")
                sys.stdout.flush()
                last_print = now

    sys.stdout.write("\n")
    sys.stdout.flush()
    os.replace(tmp_path, out_path)


def _infer_url(region: str, base: str) -> str:
    r = (region or "").strip().lower()
    if r not in _REGION_TO_PATH:
        known = ", ".join(sorted(_REGION_TO_PATH.keys()))
        raise SystemExit(f"Unknown region '{region}'. Known: {known}\n"
                         f"Tip: pass --url to use an explicit extract URL.")
    return urllib.parse.urljoin(base.rstrip("/") + "/", _REGION_TO_PATH[r])


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--region", default="", help="Region key (currently supports: virginia).")
    ap.add_argument("--base", default=_DEFAULT_BASE, help=f"Base URL for provider (default: {_DEFAULT_BASE})")
    ap.add_argument("--url", default="", help="Explicit .osm.pbf URL (overrides --region).")
    ap.add_argument("--outdir", default="data/osm", help="Output directory.")
    ap.add_argument("--filename", default="", help="Override output filename.")
    ap.add_argument("--info", action="store_true", help="Only print remote URL + size (no download).")
    ap.add_argument("--download", action="store_true", help="Perform the download (explicit).")
    args = ap.parse_args(argv)

    url = args.url.strip() if args.url.strip() else _infer_url(args.region, args.base)
    name = args.filename.strip() or os.path.basename(urllib.parse.urlparse(url).path) or "extract.osm.pbf"
    out_path = os.path.join(args.outdir, name)

    try:
        size, final_url = _head(url)
    except urllib.error.HTTPError as e:
        print(f"HEAD failed: {e.code} {e.reason}\nURL: {url}", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"HEAD failed: {e}\nURL: {url}", file=sys.stderr)
        return 2

    if final_url and final_url != url:
        url = final_url

    print(f"URL: {url}")
    print(f"Remote size: {_fmt_bytes(size)} ({size if isinstance(size, int) else 'n/a'} bytes)")
    print(f"Output path: {out_path}")

    if args.info and not args.download:
        print("Info-only; not downloading.")
        return 0

    if not args.download:
        print("Refusing to download without --download. (Use --info to preview size.)", file=sys.stderr)
        return 3

    print("Starting download...")
    try:
        _download(url, out_path)
    except Exception as e:
        print(f"Download failed: {e}", file=sys.stderr)
        return 4

    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))



#!/usr/bin/env python3
"""
Export GTA V compiled scripts (.ysc) using CodeWalker.Cli.

This is intended to answer: "find the client script files and export them".

It will:
- scan for .rpf files under a GTA root
- run CodeWalker.Cli `extract-ysc` per RPF (decrypt + decompress)
- write a manifest JSON of what was exported

Example:
  python3 scripts/export_client_scripts.py \
    --game /data/webglgta/webgl-gta/gtav \
    --outdir /data/webglgta/webgl-gta/output/client_scripts
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path


DEFAULT_GAME = Path("/data/webglgta/webgl-gta/gtav")
DEFAULT_CW_CLI = Path("/data/webglgta/webgl-gta/CodeWalker.Cli/bin/Release/net8.0/CodeWalker.Cli")


def _find_rpfs(root: Path, rpf_regex: str | None) -> list[Path]:
    rpfs = sorted(root.rglob("*.rpf"))
    if rpf_regex:
        rx = re.compile(rpf_regex, re.IGNORECASE)
        rpfs = [p for p in rpfs if rx.search(str(p))]
    return rpfs


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False)

def _parse_listed_count(stderr_text: str) -> int | None:
    # CodeWalker.Cli prints this to stderr:
    #   "Listed <N> entries from <name>"
    m = re.search(r"Listed\s+(\d+)\s+entries\s+from\s+", stderr_text or "")
    if not m:
        return None
    try:
        return int(m.group(1))
    except ValueError:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", type=Path, default=DEFAULT_GAME, help="GTA V root folder (must contain gta5.exe)")
    ap.add_argument("--outdir", type=Path, default=Path("/data/webglgta/webgl-gta/output/client_scripts"))
    ap.add_argument("--cw-cli", type=Path, default=DEFAULT_CW_CLI, help="Path to CodeWalker.Cli executable")
    ap.add_argument("--rpf-root", type=Path, default=None, help="Folder to scan for RPFS (defaults to --game)")
    ap.add_argument("--rpf-regex", type=str, default=None, help="Only process RPFs whose path matches this regex")
    ap.add_argument("--glob", type=str, default=r"**\*.ysc", help="Glob pattern (matches CodeWalker entry paths; uses backslashes)")
    ap.add_argument("--preserve-paths", type=str, default="true", help="true/false; preserve internal paths under outdir")
    ap.add_argument("--max-rpfs", type=int, default=0, help="0 = no limit; otherwise process at most N RPFS")
    ap.add_argument("--skip-empty", action="store_true", help="Skip RPFS that have 0 matches for --glob (recommended)")
    ap.add_argument("--dry-run", action="store_true", help="Only list what would be processed")
    args = ap.parse_args()

    game = args.game
    if not game.exists():
        print(f"Error: --game does not exist: {game}", file=sys.stderr)
        return 2

    rpf_root = args.rpf_root or game
    if not rpf_root.exists():
        print(f"Error: --rpf-root does not exist: {rpf_root}", file=sys.stderr)
        return 2

    cw_cli = args.cw_cli
    if not cw_cli.exists():
        print(f"Error: CodeWalker.Cli not found: {cw_cli}", file=sys.stderr)
        return 2

    outdir = args.outdir
    outdir.mkdir(parents=True, exist_ok=True)

    rpfs = _find_rpfs(rpf_root, args.rpf_regex)
    if args.max_rpfs and args.max_rpfs > 0:
        rpfs = rpfs[: args.max_rpfs]

    if not rpfs:
        print(f"No .rpf files found under: {rpf_root}", file=sys.stderr)
        return 1

    if args.dry_run:
        print(f"Would process {len(rpfs)} RPFS under {rpf_root}")
        for p in rpfs[:50]:
            print(str(p))
        if len(rpfs) > 50:
            print(f"... and {len(rpfs) - 50} more")
        return 0

    started = time.time()
    manifest: dict = {
        "game": str(game),
        "rpf_root": str(rpf_root),
        "outdir": str(outdir),
        "cw_cli": str(cw_cli),
        "glob": args.glob,
        "preserve_paths": args.preserve_paths,
        "rpf_regex": args.rpf_regex,
        "processed": [],
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }

    extracted_rpfs = 0
    for idx, rpf in enumerate(rpfs, start=1):
        rel = os.path.relpath(rpf, rpf_root)
        rel_safe = rel.replace(os.sep, "__").replace("/", "__").replace("\\", "__")
        rpf_out = outdir / rel_safe

        listed_count: int | None = None
        if args.skip_empty:
            # Probe: if there are no matches, don't create an output dir.
            list_cmd = [
                str(cw_cli),
                "list",
                "--game",
                str(game),
                "--rpf",
                str(rpf),
                "--glob",
                args.glob,
            ]
            lp = _run(list_cmd)
            listed_count = _parse_listed_count(lp.stderr)
            if listed_count == 0 and lp.returncode == 0:
                print(f"[{idx}/{len(rpfs)}] {rel}: 0 matches (skipped)")
                manifest["processed"].append(
                    {
                        "rpf": str(rpf),
                        "rpf_rel": rel,
                        "outdir": str(rpf_out),
                        "ok": True,
                        "skipped": True,
                        "listed_count": 0,
                        "returncode": 0,
                        "stdout_tail": "",
                        "stderr_tail": lp.stderr[-2000:],
                    }
                )
                continue

        cmd = [
            str(cw_cli),
            "extract-ysc",
            "--game",
            str(game),
            "--rpf",
            str(rpf),
            "--outdir",
            str(rpf_out),
            "--glob",
            args.glob,
            "--preserve-paths",
            args.preserve_paths,
        ]

        # Only create the output folder if we actually plan to extract.
        rpf_out.mkdir(parents=True, exist_ok=True)

        extra = ""
        if listed_count is not None:
            extra = f" ({listed_count} matches)"
        print(f"[{idx}/{len(rpfs)}] extracting {args.glob} from {rel}{extra} ...")
        cp = _run(cmd)
        ok = cp.returncode == 0
        manifest["processed"].append(
            {
                "rpf": str(rpf),
                "rpf_rel": rel,
                "outdir": str(rpf_out),
                "ok": ok,
                "skipped": False,
                "listed_count": listed_count,
                "returncode": cp.returncode,
                "stdout_tail": cp.stdout[-2000:],
                "stderr_tail": cp.stderr[-2000:],
            }
        )

        if ok:
            extracted_rpfs += 1
        else:
            # Keep going; a few RPFS may fail depending on keys / structure.
            print(f"  warning: failed (exit {cp.returncode}). see manifest for details.", file=sys.stderr)

    manifest["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    manifest["duration_sec"] = round(time.time() - started, 3)
    manifest["rpf_count"] = len(rpfs)
    manifest["rpf_ok"] = extracted_rpfs

    manifest_path = outdir / "export_client_scripts_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))

    print(f"Done. OK RPFS: {extracted_rpfs}/{len(rpfs)}")
    print(f"Manifest: {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



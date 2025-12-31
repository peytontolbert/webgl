#!/usr/bin/env python3
"""
One-command extraction pipeline (Linux).

Goal: make `docs/extraction_pipeline_checklist.md` runnable end-to-end and produce:
- `output/` dataset
- `output/meta/inputs.json` and `output/meta/outputs.json` (provenance/reproducibility)
- `webgl_viewer_old/assets/` synced (via setup_assets.py)

Notes:
- Some steps (notably texture decoding to PNG, model conversion to glTF) are not implemented yet.
  This runner will still extract raw assets (YTD/GTXD, YDR/YDD/YFT, YBN) so the dataset is complete
  at the "raw bytes" stage.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import time
from pathlib import Path
from typing import Iterable, List, Optional

import dotenv

from gta5_modules.provenance import build_inputs_manifest, build_outputs_manifest, write_json


def _repo_root() -> Path:
    return Path(__file__).resolve().parent


def _run(cmd: List[str], *, cwd: Optional[Path] = None, check: bool = True) -> int:
    p = subprocess.run(cmd, cwd=str(cwd) if cwd else None, check=False)
    if check and p.returncode != 0:
        raise subprocess.CalledProcessError(p.returncode, cmd)
    return int(p.returncode)


def _build_cli(repo_root: Path) -> Path:
    csproj = repo_root / "CodeWalker.Cli" / "CodeWalker.Cli.csproj"
    _run(["dotnet", "build", str(csproj), "-c", "Release", "-v", "minimal"])
    dll = repo_root / "CodeWalker.Cli" / "bin" / "Release" / "net8.0" / "CodeWalker.Cli.dll"
    if not dll.exists():
        raise FileNotFoundError(f"Expected CodeWalker.Cli at {dll}")
    return dll


def _iter_rpfs(game_root: Path, *, scope: str) -> List[Path]:
    """
    scope:
      - core: common.rpf + update/update.rpf + x64*.rpf at root
      - all:  all *.rpf under game root (including dlcpacks)
    """
    if scope not in ("core", "all"):
        raise ValueError(f"Unknown scope: {scope}")

    rpfs: List[Path] = []
    if scope == "core":
        candidates: List[Path] = []
        candidates.append(game_root / "common.rpf")
        candidates.append(game_root / "update" / "update.rpf")
        candidates.extend(sorted(game_root.glob("x64*.rpf")))
        rpfs = [p for p in candidates if p.exists() and p.is_file()]
        # DLC packs are big but important; include them in "core" since the checklist expects them.
        dlcpacks = game_root / "update" / "x64" / "dlcpacks"
        if dlcpacks.exists():
            rpfs.extend([p for p in sorted(dlcpacks.rglob("*.rpf")) if p.is_file()])
        return rpfs

    # all
    rpfs = [p for p in sorted(game_root.rglob("*.rpf")) if p.is_file()]
    return rpfs


def _extract_by_glob(
    *,
    cli: Path,
    game_root: Path,
    rpf_path: Path,
    glob: str,
    outdir: Path,
) -> None:
    outdir.mkdir(parents=True, exist_ok=True)
    _run(
        [
            "dotnet",
            str(cli),
            "extract",
            "--game",
            str(game_root),
            "--rpf",
            str(rpf_path),
            "--glob",
            glob,
            "--outdir",
            str(outdir),
            "--preserve-paths",
            "true",
        ]
    )


def main() -> int:
    dotenv.load_dotenv()
    dotenv.load_dotenv(dotenv_path=_repo_root() / "env.local", override=False)

    parser = argparse.ArgumentParser(description="Run the GTA V extraction pipeline on Linux.")
    parser.add_argument("--game-path", default=os.getenv("gta_location") or os.getenv("gta5_path"), help="Path to GTA V root")
    parser.add_argument("--output-dir", default="output", help="Output directory (default: output)")
    parser.add_argument("--scope", choices=["core", "all"], default="core", help="Which RPFs to scan/extract from")
    parser.add_argument("--input-hash-mode", choices=["none", "fast", "full"], default="fast", help="Hashing mode for input RPFS in inputs.json")
    parser.add_argument("--output-hash-mode", choices=["none", "fast", "full"], default="fast", help="Hashing mode for output files in outputs.json")
    parser.add_argument("--skip-raw", action="store_true", help="Skip raw extraction of models/collision/textures via CodeWalker.Cli")
    parser.add_argument(
        "--decode-textures-png",
        action="store_true",
        help="Decode .ytd/.gtxd to output/textures/png/** via CodeWalker.Core (can be very slow; recommended with --filter for iteration).",
    )
    parser.add_argument("--decode-textures-include-gtxd", action="store_true", help="Include .gtxd when decoding textures (slower; more failures).")
    parser.add_argument("--decode-textures-filter", default="", help="Substring filter for decoding texture dict paths (case-insensitive).")
    parser.add_argument("--decode-textures-contains", default="", help="Only decode textures whose internal name contains this substring (case-insensitive).")
    parser.add_argument("--decode-textures-max-files", type=int, default=0, help="Max YTD/GTXD files to decode (0 = no limit).")
    parser.add_argument("--decode-textures-stop-after", type=int, default=0, help="Stop decoding after N PNGs total (0 = no limit).")
    parser.add_argument(
        "--decode-textures-from-raw",
        action="store_true",
        help="Decode from output/textures/raw/** (requires raw extraction). Much faster than rescanning RPFS via CodeWalker index.",
    )
    parser.add_argument("--skip-ymaps", action="store_true", help="Skip YMAP extraction/parsing step")
    parser.add_argument("--skip-ytyp", action="store_true", help="Skip YTYP extraction/parsing step")
    parser.add_argument("--skip-worldmap", action="store_true", help="Skip worldmap extraction step")
    parser.add_argument("--skip-heightmap", action="store_true", help="Skip heightmap extraction step")
    parser.add_argument("--skip-sync-assets", action="store_true", help="Skip copying outputs into webgl_viewer_old/assets/")
    parser.add_argument("--continue-on-error", action="store_true", help="Do not abort the whole pipeline when a step fails; still write outputs manifest")
    args = parser.parse_args()

    if not args.game_path:
        raise SystemExit("Missing --game-path (or gta_location/gta5_path in env.local)")

    repo_root = _repo_root()
    game_root = Path(args.game_path).expanduser().resolve()
    output_root = Path(args.output_dir).expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)

    started = time.time()
    run_id = time.strftime("%Y%m%d-%H%M%S", time.gmtime(started))

    rpfs: List[Path] = []
    cli: Optional[Path] = None
    steps: List[dict] = []
    meta_dir = output_root / "meta"
    meta_dir.mkdir(parents=True, exist_ok=True)

    def _step(name: str, cmd: List[str]) -> int:
        rc = 0
        try:
            rc = _run(cmd, check=not args.continue_on_error)
        except subprocess.CalledProcessError as e:
            rc = int(e.returncode)
        steps.append({"name": name, "cmd": cmd, "returncode": rc})
        return rc

    try:
        # 0) Build CLI
        cli = _build_cli(repo_root)

        # Inputs manifest (RPF inventory)
        rpfs = _iter_rpfs(game_root, scope=args.scope)
        inputs = build_inputs_manifest(
            repo_root=repo_root,
            game_root=game_root,
            rpfs=rpfs,
            run_id=run_id,
            started_at_unix=started,
            hash_mode=args.input_hash_mode,  # validated by argparse
            extra={"scope": args.scope},
        )
        write_json(meta_dir / "inputs.json", inputs)

        # 1) Heightmap (Linux-friendly)
        if not args.skip_heightmap:
            _step(
                "heightmap",
                [
                    "python3",
                    str(repo_root / "extract_heightmap_linux.py"),
                    "--game-path",
                    str(game_root),
                    "--output-dir",
                    str(output_root),
                    "--size",
                    "256",
                ],
            )

        # 7) Worldmap (optional but useful)
        if not args.skip_worldmap:
            _step(
                "worldmap",
                [
                    "python3",
                    str(repo_root / "extract_worldmap.py"),
                    "--game-path",
                    str(game_root),
                    "--output-dir",
                    str(output_root),
                ],
            )

        # 3) YTYP (Linux)
        if not args.skip_ytyp:
            _step(
                "ytyp",
                [
                    "python3",
                    str(repo_root / "extract_ytyp_linux.py"),
                    "--game-path",
                    str(game_root),
                    "--output-dir",
                    str(output_root),
                ],
            )

        # 2) YMAP (PythonNET + CodeWalker.Core)
        if not args.skip_ymaps:
            _step(
                "ymaps",
                [
                    "python3",
                    str(repo_root / "extract_ymaps.py"),
                    "--game-path",
                    str(game_root),
                    "--output-dir",
                    str(output_root),
                ],
            )

        # 4/5/6) Raw assets (models/collision/textures) via CLI, per-RPF
        if not args.skip_raw and cli is not None:
            for rpf in rpfs:
                rpf_name = rpf.name
                steps.append({"name": "raw_rpf", "rpf": str(rpf)})
                # Collision
                _extract_by_glob(
                    cli=cli,
                    game_root=game_root,
                    rpf_path=rpf,
                    glob="**\\*.ybn",
                    outdir=output_root / "collision" / "raw" / rpf_name,
                )

                # Models
                _extract_by_glob(cli=cli, game_root=game_root, rpf_path=rpf, glob="**\\*.ydr", outdir=output_root / "models" / "raw" / "ydr" / rpf_name)
                _extract_by_glob(cli=cli, game_root=game_root, rpf_path=rpf, glob="**\\*.ydd", outdir=output_root / "models" / "raw" / "ydd" / rpf_name)
                _extract_by_glob(cli=cli, game_root=game_root, rpf_path=rpf, glob="**\\*.yft", outdir=output_root / "models" / "raw" / "yft" / rpf_name)

                # Textures (raw)
                _extract_by_glob(cli=cli, game_root=game_root, rpf_path=rpf, glob="**\\*.ytd", outdir=output_root / "textures" / "raw" / "ytd" / rpf_name)
                _extract_by_glob(cli=cli, game_root=game_root, rpf_path=rpf, glob="**\\*.gtxd", outdir=output_root / "textures" / "raw" / "gtxd" / rpf_name)

        # Optional: decode texture dicts to PNG (CodeWalker.Core DDSIO path)
        if args.decode_textures_png:
            cmd = [
                "python3",
                str(repo_root / "extract_textures_png_linux.py"),
                "--game-path",
                str(game_root),
                "--output-dir",
                str(output_root),
            ]
            if args.decode_textures_from_raw:
                cmd.extend(["--raw-dir", str(output_root / "textures" / "raw")])
            if args.decode_textures_include_gtxd:
                cmd.append("--include-gtxd")
            if args.decode_textures_filter:
                cmd.extend(["--filter", args.decode_textures_filter])
            if args.decode_textures_contains:
                cmd.extend(["--contains-texture", args.decode_textures_contains])
            if args.decode_textures_max_files and args.decode_textures_max_files > 0:
                cmd.extend(["--max-files", str(args.decode_textures_max_files)])
            if args.decode_textures_stop_after and args.decode_textures_stop_after > 0:
                cmd.extend(["--stop-after", str(args.decode_textures_stop_after)])
            _step("textures_png", cmd)

    finally:
        finished = time.time()
        write_json(meta_dir / "steps.json", {"run_id": run_id, "steps": steps})
        outputs = build_outputs_manifest(
            output_root=output_root,
            run_id=run_id,
            started_at_unix=started,
            finished_at_unix=finished,
            hash_mode=args.output_hash_mode,  # validated by argparse
        )
        write_json(meta_dir / "outputs.json", outputs)

        if not args.skip_sync_assets:
            _step("sync_assets", ["python3", str(repo_root / "webgl_viewer_old" / "setup_assets.py")])

    print("")
    print("Pipeline complete.")
    print(f"Run ID: {run_id}")
    print(f"Inputs manifest: {output_root / 'meta' / 'inputs.json'}")
    print(f"Outputs manifest: {output_root / 'meta' / 'outputs.json'}")
    print(f"Viewer assets: {repo_root / 'webgl_viewer_old' / 'assets'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



#!/usr/bin/env python3
"""
Windows-safe runtime asset re-export driver.

Typical Windows use:
  python reexport_runtime_assets.py --clean-output --clean-assets --max-chunks 1 --export-textures

Full export:
  python reexport_runtime_assets.py --clean-output --clean-assets --export-textures

The script deliberately avoids shell=True so Windows paths with spaces/backslashes are
passed as literal argv values.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

try:
    from dotenv import load_dotenv
except Exception:  # pragma: no cover - optional dependency at import time
    load_dotenv = None


def _load_env(repo_dir: Path) -> None:
    if load_dotenv is None:
        return
    try:
        load_dotenv(repo_dir / ".env")
    except Exception:
        pass


def _default_game_path() -> str:
    return os.getenv("gta_location") or os.getenv("gta5_path") or ""


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _safe_rmtree(target: Path, allowed_root: Path, dry_run: bool = False) -> None:
    target_resolved = target.resolve()
    root_resolved = allowed_root.resolve()
    if not _is_relative_to(target_resolved, root_resolved):
        raise SystemExit(f"Refusing to delete outside workspace: {target_resolved}")
    if target_resolved == root_resolved:
        raise SystemExit(f"Refusing to delete workspace root: {target_resolved}")
    if not target_resolved.exists():
        return
    print(f"{'Would remove' if dry_run else 'Removing'} directory: {target_resolved}")
    if not dry_run:
        shutil.rmtree(target_resolved)


def _safe_unlink(target: Path, allowed_root: Path, dry_run: bool = False) -> None:
    target_resolved = target.resolve()
    root_resolved = allowed_root.resolve()
    if not _is_relative_to(target_resolved, root_resolved):
        raise SystemExit(f"Refusing to delete outside workspace: {target_resolved}")
    if not target_resolved.exists():
        return
    print(f"{'Would remove' if dry_run else 'Removing'} file: {target_resolved}")
    if not dry_run:
        target_resolved.unlink()


def _run(cmd: list[str], cwd: Path, dry_run: bool = False) -> None:
    print("\n> " + subprocess.list2cmdline([str(x) for x in cmd]))
    print(f"  cwd={cwd}")
    if dry_run:
        return
    subprocess.run(cmd, cwd=str(cwd), check=True)


def _clean_viewer_assets(assets_dir: Path, workspace_root: Path, dry_run: bool = False) -> None:
    generated_dirs = [
        "entities_chunks",
        "entities_chunks_bin",
        "entities_chunks_inst",
        "interiors",
        "models",
        "models_textures",
        "models_textures_ktx2",
        "textures",
    ]
    generated_files = [
        "heightmap.png",
        "normalmap.png",
        "lod_levels.png",
        "terrain_info.json",
        "manifest.json",
        "entities_index.json",
        "entities_chunk_shards.json",
        "shader_param_names.json",
        "terrain.obj",
        "entities.obj",
        "buildings.obj",
        "building_info.json",
    ]
    assets_dir.mkdir(parents=True, exist_ok=True)
    for name in generated_dirs:
        _safe_rmtree(assets_dir / name, workspace_root, dry_run=dry_run)
    for name in generated_files:
        _safe_unlink(assets_dir / name, workspace_root, dry_run=dry_run)


def main() -> int:
    repo_dir = Path(__file__).resolve().parent
    _load_env(repo_dir)

    ap = argparse.ArgumentParser(description="Re-export WebGL GTA runtime assets with Windows-safe paths")
    ap.add_argument("--game-path", default=_default_game_path(), help="GTA5 install folder; defaults to gta_location/gta5_path from .env")
    ap.add_argument("--output-dir", default=str(repo_dir / "output"), help="Extraction output directory")
    ap.add_argument("--assets-dir", default=str(repo_dir / "webgl_viewer" / "assets"), help="Viewer runtime assets directory")
    ap.add_argument("--clean-output", action="store_true", help="Delete output-dir before extracting")
    ap.add_argument("--clean-assets", action="store_true", help="Delete generated viewer runtime assets before staging/exporting")
    ap.add_argument("--skip-terrain", action="store_true", help="Skip gta5_terrain_extractor.py")
    ap.add_argument("--skip-drawables", action="store_true", help="Skip streamed drawable mesh export")
    ap.add_argument("--max-chunks", type=int, default=0, help="Limit drawable chunks processed (0 = all)")
    ap.add_argument("--max-archetypes", type=int, default=0, help="Limit archetypes per chunk (0 = all)")
    ap.add_argument("--skip-existing", action="store_true", help="Skip drawable hashes already present in manifest")
    ap.add_argument("--force", action="store_true", help="Force drawable mesh re-export")
    ap.add_argument("--export-textures", action="store_true", help="Export diffuse/normal/spec textures while exporting drawables")
    ap.add_argument("--keep-going", action="store_true", help="Continue after a per-chunk drawable export failure")
    ap.add_argument("--include-debug-objs", action="store_true", help="Stage monolithic OBJ debug artifacts into viewer assets")
    ap.add_argument("--no-entity-bins", action="store_true", help="Do not build position-only entity bin chunks")
    ap.add_argument("--no-entity-inst-bins", action="store_true", help="Do not build drawable instance bin chunks")
    ap.add_argument("--no-chunk-shard-index", action="store_true", help="Do not build chunk-to-manifest-shards prefetch index")
    ap.add_argument("--skip-report", action="store_true", help="Skip final_export_report.py")
    ap.add_argument("--report-max-bins", type=int, default=200, help="Limit bins scanned by final_export_report.py (0 = all)")
    ap.add_argument("--report-max-shards", type=int, default=8, help="Limit manifest shards scanned by final_export_report.py (0 = all)")
    ap.add_argument("--sync-dist", action="store_true", help="Copy viewer assets into dist/assets after export")
    ap.add_argument("--dry-run", action="store_true", help="Print actions without running or deleting anything")
    args = ap.parse_args()

    game_path = str(args.game_path or "").strip().strip('"').strip("'")
    if not game_path:
        raise SystemExit("Missing --game-path and no gta_location/gta5_path found in .env")
    game_dir = Path(game_path)
    if not game_dir.exists():
        raise SystemExit(f"Game path does not exist: {game_dir}")

    output_dir = Path(args.output_dir).resolve()
    assets_dir = Path(args.assets_dir).resolve()
    viewer_dir = repo_dir / "webgl_viewer"
    py = sys.executable

    if args.clean_output:
        _safe_rmtree(output_dir, repo_dir, dry_run=bool(args.dry_run))
    if args.clean_assets:
        _clean_viewer_assets(assets_dir, repo_dir, dry_run=bool(args.dry_run))

    if not args.skip_terrain:
        _run(
            [
                py,
                str(repo_dir / "gta5_terrain_extractor.py"),
                "--game-path",
                str(game_dir),
                "--output-dir",
                str(output_dir),
            ],
            cwd=repo_dir,
            dry_run=bool(args.dry_run),
        )

    setup_cmd = [py, str(viewer_dir / "setup_assets.py")]
    if not args.no_entity_bins:
        setup_cmd.append("--build-entity-bins")
    if not args.no_entity_inst_bins:
        setup_cmd.append("--build-entity-inst-bins")
    if not args.no_chunk_shard_index:
        setup_cmd.append("--build-chunk-shard-index")
    if args.include_debug_objs:
        setup_cmd.append("--include-debug-objs")
    _run(setup_cmd, cwd=repo_dir, dry_run=bool(args.dry_run))

    if not args.skip_drawables:
        draw_cmd = [
            py,
            str(repo_dir / "export_drawables_all_chunks.py"),
            "--game-path",
            str(game_dir),
            "--assets-dir",
            str(assets_dir),
            "--max-chunks",
            str(int(args.max_chunks or 0)),
            "--max-archetypes",
            str(int(args.max_archetypes or 0)),
        ]
        if args.skip_existing:
            draw_cmd.append("--skip-existing")
        if args.force:
            draw_cmd.append("--force")
        if args.export_textures:
            draw_cmd.append("--export-textures")
        if args.keep_going:
            draw_cmd.append("--keep-going")
        _run(draw_cmd, cwd=repo_dir, dry_run=bool(args.dry_run))

        # Rebuild model manifest shards and fast bin/index sidecars after drawable export.
        _run(setup_cmd, cwd=repo_dir, dry_run=bool(args.dry_run))

    report = repo_dir / "final_export_report.py"
    if report.exists() and not args.skip_report:
        report_cmd = [
            py,
            str(report),
            "--assets-dir",
            str(assets_dir),
            "--max-bins",
            str(int(args.report_max_bins or 0)),
            "--max-shards",
            str(int(args.report_max_shards or 0)),
        ]
        _run(report_cmd, cwd=repo_dir, dry_run=bool(args.dry_run))

    if args.sync_dist:
        _run([py, str(viewer_dir / "sync_assets_to_dist.py"), "--prune"], cwd=repo_dir, dry_run=bool(args.dry_run))

    print("\nRe-export complete.")
    print(f"Output: {output_dir}")
    print(f"Assets: {assets_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

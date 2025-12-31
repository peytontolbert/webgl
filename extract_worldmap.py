#!/usr/bin/env python3
"""
Extract GTA V worldmap/minimap images for viewer/debug.

This script is Linux-friendly: it uses the bundled `CodeWalker.Cli` (dotnet) to
extract known PNG assets directly from RPF archives.

Outputs:
- output/worldmap/worldmap.png
- output/worldmap/worldmap_heist.png (if present; Cayo Perico / heist island)
"""

import argparse
import logging
import os
import subprocess
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

import dotenv


logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


dotenv.load_dotenv()
dotenv.load_dotenv(dotenv_path=Path(__file__).resolve().parent / "env.local", override=False)


def _build_codewalker_cli_if_present() -> Optional[Path]:
    cli_project = Path(__file__).resolve().parent / "CodeWalker.Cli" / "CodeWalker.Cli.csproj"
    if not cli_project.exists():
        return None

    build_cmd = ["dotnet", "build", str(cli_project), "-c", "Release", "-v", "minimal"]
    try:
        subprocess.run(build_cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        logger.warning(f"Failed to build CodeWalker.Cli: {e}")
        return None

    cli_dll = Path(__file__).resolve().parent / "CodeWalker.Cli" / "bin" / "Release" / "net8.0" / "CodeWalker.Cli.dll"
    if not cli_dll.exists():
        return None
    return cli_dll


def _try_extract_single_from_rpf(
    *,
    cli_dll: Path,
    game_path: Path,
    rpf_abs: Path,
    file_path: str,
    output_path: Path,
) -> bool:
    if not rpf_abs.exists():
        return False

    # `CodeWalker.Cli` accepts either full internal path including rpf name,
    # or the path relative to the RPF root. We pass relative-to-root here.
    cmd = [
        "dotnet",
        str(cli_dll),
        "extract",
        "--game",
        str(game_path),
        "--rpf",
        str(rpf_abs),
        "--file",
        file_path,
        "--output",
        str(output_path),
    ]

    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return output_path.exists() and output_path.stat().st_size > 0
    except Exception:
        return False


def _iter_rpfs_for_worldmap(game_path: Path) -> Iterable[Path]:
    # Core RPFS
    candidates: List[Path] = []
    candidates.append(game_path / "common.rpf")
    candidates.append(game_path / "update" / "update.rpf")
    candidates.extend(sorted(game_path.glob("x64*.rpf")))

    dlcpacks = game_path / "update" / "x64" / "dlcpacks"
    if dlcpacks.exists():
        candidates.extend(sorted(dlcpacks.rglob("*.rpf")))

    for p in candidates:
        if p.exists() and p.is_file():
            yield p


def _cli_list(cli_dll: Path, *, game_path: Path, rpf_path: Path, glob: str) -> List[str]:
    """
    Returns matching entry paths as printed by `CodeWalker.Cli list`.
    These paths are CodeWalker-style (backslashes) and often include the RPF name prefix.
    """
    cmd = [
        "dotnet",
        str(cli_dll),
        "list",
        "--game",
        str(game_path),
        "--rpf",
        str(rpf_path),
        "--glob",
        glob,
    ]
    try:
        p = subprocess.run(cmd, check=False, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        lines = [ln.strip() for ln in (p.stdout or "").splitlines() if ln.strip()]
        # Filter out potential status lines (they go to stdout in CLI scanning).
        lines = [ln for ln in lines if not ln.lower().startswith("status:")]
        return lines
    except Exception:
        return []


def extract_worldmap(*, game_path: Path, output_dir: Path) -> bool:
    cli_dll = _build_codewalker_cli_if_present()
    if not cli_dll:
        logger.error("CodeWalker.Cli not available; cannot extract worldmap from RPF.")
        logger.info("Expected `CodeWalker.Cli/CodeWalker.Cli.csproj` and a working `dotnet` install.")
        return False

    out_dir = output_dir / "worldmap"
    out_dir.mkdir(parents=True, exist_ok=True)

    # Discover candidates (avoid hardcoding per-build paths).
    # Worldmap PNGs are usually named `worldmap*.png`.
    glob = "**\\worldmap*.png"
    found: List[Tuple[Path, str]] = []
    for rpf in _iter_rpfs_for_worldmap(game_path):
        matches = _cli_list(cli_dll, game_path=game_path, rpf_path=rpf, glob=glob)
        for m in matches:
            found.append((rpf, m))

    if not found:
        logger.warning(f"No worldmap candidates found via CLI list (glob={glob}).")
        return False

    ok_any = False
    used_names = set()
    for rpf, entry_path in found:
        base = Path(entry_path.replace("\\", "/")).name
        # avoid collisions
        name = base
        if name in used_names:
            stem = Path(name).stem
            ext = Path(name).suffix
            name = f"{stem}__{rpf.name}{ext}"
        used_names.add(name)

        out_path = out_dir / name
        ok = _try_extract_single_from_rpf(
            cli_dll=cli_dll,
            game_path=game_path,
            rpf_abs=rpf,
            file_path=entry_path,
            output_path=out_path,
        )
        if ok:
            logger.info(f"Extracted {entry_path} from {rpf.name} -> {out_path}")
            ok_any = True

    if not ok_any:
        logger.warning("Found worldmap candidate entries but failed to extract them.")
    return ok_any


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract GTA V worldmap PNGs for the viewer.")
    parser.add_argument("--game-path", help="Path to GTA5 installation directory (root containing common.rpf)")
    parser.add_argument("--output-dir", default="output", help="Output directory (default: output)")
    parser.add_argument("--strict", action="store_true", help="Exit non-zero if no worldmap images could be extracted")
    args = parser.parse_args()

    game_path = Path(args.game_path or os.getenv("gta5_path") or os.getenv("gta_location") or "")
    if not str(game_path):
        logger.error("Missing GTA path. Provide --game-path or set gta5_path / gta_location.")
        return 2
    if not game_path.exists():
        logger.error(f"Game path does not exist: {game_path}")
        return 2

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    ok = extract_worldmap(game_path=game_path, output_dir=output_dir)
    if ok:
        return 0
    return 1 if args.strict else 0


if __name__ == "__main__":
    raise SystemExit(main())
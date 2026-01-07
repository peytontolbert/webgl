"""
One-shot repair: backfill missing model textures referenced by exported model manifests.

What it fixes:
- Missing texture files under:
  - `assets/models_textures/*.{png,dds,jpg,jpeg,webp}`
  - `assets/packs/<packId>/models_textures/*.{png,dds,jpg,jpeg,webp}`
  - optional: `assets/**/models_textures_ktx2/*.ktx2` (if your exporter emitted KTX2)

Key idea:
- Prefer PNG when pixels are available.
- Fall back to DDS when CodeWalker.Core cannot decode pixels (eg Gen9 BC7 TODO), since the viewer can upload
  BC1/3/4/5/6H/7 via WebGL extensions on supported GPUs.

Stages (fast → slow):
1) Build a missing-with-refs list from manifests (authoritative “what the viewer will request”).
2) Targeted YTD extraction (archetype TXD → parents → embedded drawable dicts → DDS fallback).
3) (Optional) Targeted global YTD scan via texture-hash index (last resort; can be slow).
4) Embedded drawable texture extraction (shader texture objects / embedded dicts).
5) Particle YPT texture dictionary extraction.
6) Final probe report: what’s still missing, written to output/.

Non-goals:
- This cannot conjure textures that do not exist in the installed GTA data.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import importlib.util
from pathlib import Path


def _run(cmd: list[str]) -> None:
    print("\n$ " + " ".join(cmd))
    subprocess.check_call(cmd)


def _run_soft(cmd: list[str], *, label: str) -> bool:
    """
    Run a command but treat failures as non-fatal.

    Rationale:
    - Some CodeWalker+pythonnet+Mono builds can segfault under heavy archive scanning.
    - We still want the repair pipeline to continue with other stages (drawable fallback / particles / probe),
      and preserve any partial artifacts already written to disk.
    """
    print("\n$ " + " ".join(cmd))
    try:
        subprocess.check_call(cmd)
        return True
    except subprocess.CalledProcessError as e:
        rc = int(getattr(e, "returncode", 1) or 1)
        print(f"[repair] WARN: stage '{label}' failed (rc={rc}). Continuing with remaining stages.")
        return False


def _count_missing_entries(p: Path) -> int:
    try:
        obj = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
        if isinstance(obj, list):
            return int(len(obj))
    except Exception:
        pass
    return -1


def _regen_models_textures_indices(assets_dir: Path) -> None:
    """
    Regenerate texture indices without relying on `setup_assets.py` fixed paths.
    (Supports custom --assets-dir.)
    """
    try:
        # Don't rely on `webgl_viewer` being an installed/importable Python package.
        # Load setup_assets.py directly from disk so this tool works when run as a script.
        repo_root = Path(__file__).resolve().parents[2]
        setup_path = repo_root / "webgl_viewer" / "setup_assets.py"
        spec = importlib.util.spec_from_file_location("webglgta_setup_assets", setup_path)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"Could not load setup_assets module spec from {setup_path}")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[attr-defined]
        # Call the index generator(s).
        getattr(mod, "_ensure_models_textures_index")(Path(assets_dir))
    except Exception as e:
        print(f"[repair] WARN: failed to regenerate models_textures indices: {type(e).__name__}: {e}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gta-path", required=True, help="GTA install root (used by CodeWalker-backed tools).")
    ap.add_argument(
        "--assets-dir",
        default="",
        help="Viewer assets dir (default: <repo>/webgl_viewer/assets).",
    )
    ap.add_argument("--selected-dlc", default="all")
    ap.add_argument("--also-scan-dlc", action="append", default=["patchday27ng"])
    ap.add_argument(
        "--split-by-dlc",
        default=True,
        action=getattr(argparse, "BooleanOptionalAction", "store_true"),
        help="When true, write textures into assets/packs/<dlcname>/models_textures when possible.",
    )
    ap.add_argument("--max-textures", type=int, default=8000)
    ap.add_argument("--max-refs-per-texture", type=int, default=200)
    ap.add_argument("--max-ytd", type=int, default=0)
    ap.add_argument("--drawable-spins", type=int, default=600)
    ap.add_argument("--max-archetypes", type=int, default=0)
    # Support both:
    # - --skip-global-scan
    # - --no-skip-global-scan
    # (mirrors argparse.BooleanOptionalAction behavior, but works on older Python too)
    ap.add_argument(
        "--skip-global-scan",
        dest="skip_global_scan",
        action="store_true",
        default=False,
        help="Skip extract_missing_textures_global_scan.py (slow last-resort).",
    )
    ap.add_argument(
        "--no-skip-global-scan",
        dest="skip_global_scan",
        action="store_false",
        help="Run extract_missing_textures_global_scan.py (slow last-resort).",
    )
    ap.add_argument("--skip-drawable-fallback", action="store_true")
    args = ap.parse_args()

    tools_dir = Path(__file__).resolve().parent
    # IMPORTANT:
    # This file lives at: <repo>/webgl_viewer/tools/repair_missing_model_textures.py
    # so __file__.parents[2] is the actual repo root (<repo>), while tools_dir.parents[2]
    # would climb one extra level and may point at a non-writable parent directory.
    repo_root = Path(__file__).resolve().parents[2]
    webgl_viewer_dir = repo_root / "webgl_viewer"

    assets_dir = Path(args.assets_dir).resolve() if args.assets_dir else (webgl_viewer_dir / "assets")
    assets_dir.mkdir(parents=True, exist_ok=True)

    out_dir = (repo_root / "output").resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    missing_json = out_dir / "missing_model_textures_from_manifest_with_refs.json"
    tex_index_json = out_dir / "texture_hash_index_missing_only.json"
    probe_missing_json = out_dir / "probe_missing_model_textures.json"
    probe_missing_with_refs_json = out_dir / "probe_missing_model_textures_with_refs.json"

    # 1) Build missing list from manifests (with refs).
    _run(
        [
            sys.executable,
            str(tools_dir / "build_missing_textures_remaining_from_manifests.py"),
            "--root",
            str(assets_dir.parent),
            "--max-textures",
            str(int(args.max_textures)),
            "--max-refs-per-texture",
            str(int(args.max_refs_per_texture)),
            "--out",
            str(missing_json),
        ]
    )
    print(f"[repair] missing entries (initial): {_count_missing_entries(missing_json)}")

    # 2) Targeted YTD extraction (fast path). Writes PNG when possible, DDS fallback otherwise.
    cmd2 = [
        sys.executable,
        str(tools_dir / "extract_missing_textures_from_ytd_dump.py"),
        "--gta-path",
        str(args.gta_path),
        "--dump",
        str(missing_json),
        "--assets-dir",
        str(assets_dir),
        "--selected-dlc",
        str(args.selected_dlc),
        "--limit",
        str(int(args.max_textures)),
        "--write-hash-only",
        "--write-hash-slug",
        "--regen-index",
    ]
    if bool(args.split_by_dlc):
        cmd2 += ["--split-by-dlc"]
    _run(cmd2)
    _regen_models_textures_indices(assets_dir)

    # 3) Recompute missing after targeted YTD extraction (bounds later stages).
    _run(
        [
            sys.executable,
            str(tools_dir / "build_missing_textures_remaining_from_manifests.py"),
            "--root",
            str(assets_dir.parent),
            "--max-textures",
            str(int(args.max_textures)),
            "--max-refs-per-texture",
            str(int(args.max_refs_per_texture)),
            "--out",
            str(missing_json),
        ]
    )
    print(f"[repair] missing entries (post-targeted-ytd): {_count_missing_entries(missing_json)}")

    # 4) Optional slow last-resort: build a targeted hash->YTD index + global scan.
    if not bool(args.skip_global_scan):
        cmd_i = [
            sys.executable,
            str(tools_dir / "build_texture_hash_index.py"),
            "--gta-path",
            str(args.gta_path),
            "--selected-dlc",
            str(args.selected_dlc),
            "--need",
            str(missing_json),
            "--assets-dir",
            str(assets_dir),
            "--out",
            str(tex_index_json),
        ]
        for lvl in list(args.also_scan_dlc or []):
            if lvl:
                cmd_i += ["--also-scan-dlc", str(lvl)]
        ok_index = _run_soft(cmd_i, label="build_texture_hash_index")

        cmd3 = [
            sys.executable,
            str(tools_dir / "extract_missing_textures_global_scan.py"),
            "--gta-path",
            str(args.gta_path),
            "--selected-dlc",
            str(args.selected_dlc),
            "--dump",
            str(missing_json),
            "--assets-dir",
            str(assets_dir),
            "--texture-index",
            str(tex_index_json),
            "--max-ytd",
            str(int(args.max_ytd)),
        ]
        for lvl in list(args.also_scan_dlc or []):
            if lvl:
                cmd3 += ["--also-scan-dlc", str(lvl)]
        if bool(args.split_by_dlc):
            cmd3 += ["--split-by-dlc"]
        if ok_index:
            ok_scan = _run_soft(cmd3, label="extract_missing_textures_global_scan")
            if ok_scan:
                _regen_models_textures_indices(assets_dir)
        else:
            print("[repair] WARN: skipping global scan because texture-hash index stage failed.")

        _run(
            [
                sys.executable,
                str(tools_dir / "build_missing_textures_remaining_from_manifests.py"),
                "--root",
                str(assets_dir.parent),
                "--max-textures",
                str(int(args.max_textures)),
                "--max-refs-per-texture",
                str(int(args.max_refs_per_texture)),
                "--out",
                str(missing_json),
            ]
        )
        print(f"[repair] missing entries (post-global-scan): {_count_missing_entries(missing_json)}")

    # 6) Drawable fallback (covers cases where YTD lookup/index doesn't find it).
    if not bool(args.skip_drawable_fallback):
        cmd6 = [
            sys.executable,
            str(tools_dir / "extract_missing_textures_from_drawables.py"),
            "--gta-path",
            str(args.gta_path),
            "--assets-dir",
            str(assets_dir),
            "--selected-dlc",
            str(args.selected_dlc),
            "--missing",
            str(missing_json),
            "--drawable-spins",
            str(int(args.drawable_spins)),
            "--max-archetypes",
            str(int(args.max_archetypes)),
        ]
        for lvl in list(args.also_scan_dlc or []):
            if lvl:
                cmd6 += ["--also-scan-dlc", str(lvl)]
        if bool(args.split_by_dlc):
            cmd6 += ["--split-by-dlc"]
        _run(cmd6)

        _regen_models_textures_indices(assets_dir)

    # 7) Recompute missing after drawable fallback (so subsequent steps target only what is truly still missing).
    _run(
        [
            sys.executable,
            str(tools_dir / "build_missing_textures_remaining_from_manifests.py"),
            "--root",
            str(assets_dir.parent),
            "--max-textures",
            str(int(args.max_textures)),
            "--max-refs-per-texture",
            str(int(args.max_refs_per_texture)),
            "--out",
            str(missing_json),
        ]
    )
    print(f"[repair] missing entries (post-drawables): {_count_missing_entries(missing_json)}")

    # 8) Particle YPT texture dictionaries (covers hashes that will never appear in YTD scan).
    cmd8 = [
        sys.executable,
        str(tools_dir / "extract_missing_textures_from_particles.py"),
        "--gta-path",
        str(args.gta_path),
        "--assets-dir",
        str(assets_dir),
        "--selected-dlc",
        str(args.selected_dlc),
        "--missing",
        str(missing_json),
        "--regen-index",
    ]
    for lvl in list(args.also_scan_dlc or []):
        if lvl:
            cmd8 += ["--also-scan-dlc", str(lvl)]
    if bool(args.split_by_dlc):
        cmd8 += ["--split-by-dlc"]
    _run(cmd8)

    _regen_models_textures_indices(assets_dir)

    # Final missing recompute (authoritative on-disk check via indices).
    _run(
        [
            sys.executable,
            str(tools_dir / "build_missing_textures_remaining_from_manifests.py"),
            "--root",
            str(assets_dir.parent),
            "--max-textures",
            str(int(args.max_textures)),
            "--max-refs-per-texture",
            str(int(args.max_refs_per_texture)),
            "--out",
            str(missing_json),
        ]
    )
    print(f"[repair] missing entries (final): {_count_missing_entries(missing_json)}")

    # Final probe report (viewer-like resolution + file sniffing).
    _run(
        [
            sys.executable,
            str(tools_dir / "probe_model_textures_like_viewer.py"),
            "--root",
            str(assets_dir.parent),
            "--write-missing-json",
            str(probe_missing_json),
            "--write-missing-with-refs-json",
            str(probe_missing_with_refs_json),
            "--max-print",
            "40",
        ]
    )

    print("\nDone.")
    print("- missing list:", str(missing_json))
    print("- texture index:", str(tex_index_json))
    print("- probe missing (hashes):", str(probe_missing_json))
    print("- probe missing (with refs):", str(probe_missing_with_refs_json))
    print("- assets:", str(assets_dir))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



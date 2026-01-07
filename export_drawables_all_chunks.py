#!/usr/bin/env python3
"""
Bulk export drawables for all streamed chunks.

This walks webgl_viewer/assets/entities_index.json -> entities_chunks/*.jsonl
and exports unique archetype meshes into webgl_viewer/assets/models.

It caches exported archetypes so each hash is exported once.
"""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

from gta5_modules.script_paths import auto_assets_dir

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-path", default=os.getenv("gta_location", ""), help="GTA5 install folder (or set gta_location)")
    ap.add_argument("--assets-dir", default="", help="WebGL viewer assets directory (auto if omitted)")
    ap.add_argument("--selected-dlc", default="all", help="Forwarded to export_drawables_for_chunk.py (CodeWalker DLC level).")
    ap.add_argument(
        "--no-patchday27ng",
        action="store_true",
        help=(
            "Skip the automatic patchday27ng pass. By default, this script runs patchday27ng after the main pass "
            "when --selected-dlc implies 'all', because CodeWalker skips patchday27ng unless explicitly selected."
        ),
    )
    ap.add_argument("--split-by-dlc", action="store_true", help="Forwarded to export_drawables_for_chunk.py (pack-aware texture output).")
    ap.add_argument("--pack-root-prefix", default="packs", help="Forwarded to export_drawables_for_chunk.py.")
    ap.add_argument("--force-pack", default="", help="Forwarded to export_drawables_for_chunk.py.")
    ap.add_argument("--base-pack", default="", help="Forwarded to export_drawables_for_chunk.py.")
    ap.add_argument("--max-chunks", type=int, default=0, help="Limit chunks processed (0 = all)")
    ap.add_argument("--max-archetypes", type=int, default=0, help="Limit archetypes per chunk (0 = no limit)")
    ap.add_argument("--skip-existing", action="store_true", help="Skip archetypes already present in assets/models/manifest.json")
    ap.add_argument("--force", action="store_true", help="Force re-export mesh bins even if present in manifest (useful after exporter changes)")
    ap.add_argument(
        "--export-textures",
        action="store_true",
        help=(
            "Also export a best-effort diffuse texture per archetype into assets/models_textures/<hash>.png "
            "and store the path in assets/models/manifest.json (slow, but enables textured models in the viewer)."
        ),
    )
    ap.add_argument("--export-ktx2", action="store_true", help="Forwarded to export_drawables_for_chunk.py.")
    ap.add_argument("--toktx", default="toktx", help="Forwarded to export_drawables_for_chunk.py.")
    ap.add_argument("--write-report", action="store_true", help="Forwarded to export_drawables_for_chunk.py.")
    args = ap.parse_args()

    game_path = (args.game_path or "").strip('"').strip("'")
    if not game_path:
        raise SystemExit("Missing --game-path (or gta_location env var)")

    assets_dir = auto_assets_dir(args.assets_dir)
    index_path = assets_dir / "entities_index.json"
    if not index_path.exists():
        raise SystemExit(f"Missing {index_path} (run extraction + setup_assets.py first)")

    index = json.loads(index_path.read_text(encoding="utf-8"))
    chunks = list((index.get("chunks") or {}).keys())
    chunks.sort()
    if args.max_chunks and args.max_chunks > 0:
        chunks = chunks[: args.max_chunks]

    # Run per-chunk exporter.
    # IMPORTANT: fail loudly if any chunk export fails.
    # (Silent failures cause "random" missing meshes/textures later in the viewer.)
    def _run_pass(selected_dlc: str) -> list[dict]:
        failures: list[dict] = []
        for i, key in enumerate(chunks):
            cmd = [
                sys.executable,
                str(Path(__file__).with_name("export_drawables_for_chunk.py")),
                "--game-path",
                game_path,
                "--assets-dir",
                str(assets_dir),
                # Chunk keys often start with '-' (e.g. "-1_-1"); use equals form so argparse
                # doesn't treat the value as a new flag.
                f"--chunk={key}",
            ]
            # Pass through max-archetypes (0 means "no limit" in the chunk exporter).
            cmd += ["--max-archetypes", str(int(args.max_archetypes or 0))]
            if args.skip_existing:
                cmd += ["--skip-existing"]
            if args.force:
                cmd += ["--force"]
            if args.export_textures:
                cmd += ["--export-textures"]
            if args.export_ktx2:
                cmd += ["--export-ktx2"]
            if str(args.toktx or "").strip():
                cmd += ["--toktx", str(args.toktx)]
            if args.write_report:
                cmd += ["--write-report"]
            # DLC / packs
            if str(selected_dlc or "").strip():
                cmd += ["--selected-dlc", str(selected_dlc)]
            if args.split_by_dlc:
                cmd += ["--split-by-dlc"]
            if str(args.pack_root_prefix or "").strip():
                cmd += ["--pack-root-prefix", str(args.pack_root_prefix)]
            if str(args.force_pack or "").strip():
                cmd += ["--force-pack", str(args.force_pack)]
            if str(args.base_pack or "").strip():
                cmd += ["--base-pack", str(args.base_pack)]

            print(f"[{i+1}/{len(chunks)}] exporting chunk {key} (selected_dlc={selected_dlc}) ...")
            cp = subprocess.run(cmd, check=False)
            if int(getattr(cp, "returncode", 0) or 0) != 0:
                failures.append({"chunk": key, "returncode": int(cp.returncode), "cmd": cmd})
        return failures

    failures = []
    main_sel = str(args.selected_dlc or "all")
    failures += _run_pass(main_sel)

    # CodeWalker special-case: patchday27ng is skipped unless explicitly selected.
    # To avoid silent under-export, automatically run a second pass unless the user opts out.
    if (not args.no_patchday27ng) and (main_sel.strip().lower() in ("all", "*", "__all__", "latest")):
        failures += _run_pass("patchday27ng")

    if failures:
        print("")
        print("ERROR: one or more chunk exports failed. This would leave missing meshes/textures downstream.")
        print(f"Failed chunks: {len(failures)} / {len(chunks)}")
        for f in failures[:15]:
            print(f"- chunk={f.get('chunk')} rc={f.get('returncode')}")
        if len(failures) > 15:
            print(f"... {len(failures) - 15} more")
        raise SystemExit(1)


if __name__ == "__main__":
    main()



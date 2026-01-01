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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-path", default=os.getenv("gta_location", ""), help="GTA5 install folder (or set gta_location)")
    ap.add_argument("--assets-dir", default="", help="WebGL viewer assets directory (auto if omitted)")
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
    args = ap.parse_args()

    game_path = (args.game_path or "").strip('"').strip("'")
    if not game_path:
        raise SystemExit("Missing --game-path (or gta_location env var)")

    if args.assets_dir:
        assets_dir = Path(args.assets_dir)
    else:
        assets_dir = Path(__file__).parent / "webgl_viewer" / "assets"
        if not assets_dir.exists():
            alt = Path.cwd() / "webgl_viewer" / "assets"
            if alt.exists():
                assets_dir = alt
    index_path = assets_dir / "entities_index.json"
    if not index_path.exists():
        raise SystemExit(f"Missing {index_path} (run extraction + setup_assets.py first)")

    index = json.loads(index_path.read_text(encoding="utf-8"))
    chunks = list((index.get("chunks") or {}).keys())
    chunks.sort()
    if args.max_chunks and args.max_chunks > 0:
        chunks = chunks[: args.max_chunks]

    # Run per-chunk exporter, which will overwrite manifest each time.
    # This is MVP; if you want, we can make a single-pass exporter to be faster.
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

        print(f"[{i+1}/{len(chunks)}] exporting chunk {key} ...")
        subprocess.run(cmd, check=False)


if __name__ == "__main__":
    main()



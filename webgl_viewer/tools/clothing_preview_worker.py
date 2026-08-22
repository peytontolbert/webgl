#!/usr/bin/env python3
"""Poll the demo selection queue, convert requested clothing, and deploy previews."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path


def run(command: list[str], cwd: Path, timeout: float = 300) -> None:
    if command and command[0] in {"ssh", "scp"}:
        command = [command[0], "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", *command[1:]]
    subprocess.run(command, cwd=str(cwd), check=True, timeout=timeout)


def write_status(path: Path, remote: str, remote_root: str, state: str, detail: str, items: int = 0) -> None:
    payload = {"state": state, "detail": detail, "items": items, "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    try:
        run(["scp", str(path), f"{remote}:{remote_root}/data/clothing_preview_status.json"], path.parent)
    except Exception:
        pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--remote", default="peyton@192.168.0.85")
    parser.add_argument("--fivem-root", default="/data/NexusAI/fivem_server")
    parser.add_argument("--demo-root", default="/data/NexusAI/webglgta-demo")
    parser.add_argument("--game-path", default=r"K:\steam\steamapps\common\Grand Theft Auto V")
    parser.add_argument("--interval", type=float, default=4.0)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    resource = root / "imports" / "clothingpack5m"
    data_dir = root / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    selection_path = data_dir / "clothing_selection.worker.json"
    status_path = data_dir / "clothing_preview_status.json"
    last_digest = ""
    write_status(status_path, args.remote, args.demo_root, "idle", "Waiting for a preview request")

    while True:
        try:
            run(["scp", f"{args.remote}:{args.demo_root}/data/clothing_selection.json", str(selection_path)], root)
            raw = selection_path.read_bytes()
            digest = hashlib.sha256(raw).hexdigest()
            if digest == last_digest:
                time.sleep(args.interval)
                continue
            selection = json.loads(raw)
            items = selection.get("items") or []
            if not items:
                last_digest = digest
                time.sleep(args.interval)
                continue
            write_status(status_path, args.remote, args.demo_root, "converting", "Downloading selected GTA clothing assets", len(items))
            for item in items:
                for key in ("drawablePath", "texturePath"):
                    relative = str(item.get(key) or "").replace("\\", "/").lstrip("/")
                    if not relative or ".." in Path(relative).parts:
                        raise ValueError(f"Invalid {key} for {item.get('id')}")
                    local = resource / relative
                    local.parent.mkdir(parents=True, exist_ok=True)
                    remote_source = f"{args.remote}:{args.fivem_root}/resources/[clothing]/clothingpack5m/{relative}"
                    run(["scp", remote_source, str(local)], root)

            write_status(status_path, args.remote, args.demo_root, "converting", "Building skinned WebGL meshes and textures", len(items))
            run([
                sys.executable, str(root / "tools" / "export_clothingpack5m_selection.py"),
                "--game-path", args.game_path, "--resource", str(resource), "--selection", str(selection_path),
            ], root, timeout=3600)
            manifest_path = root / "assets" / "custom_clothing" / "clothingpack5m.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            selected_hashes = {
                str(row.get("textureAssets", {}).get(str(item.get("texture", 0))) or row.get("hash") or "")
                for components in manifest.get("models", {}).values()
                for variants in components.values() for row in variants
                for item in items if row.get("itemId") == item.get("id")
            }
            selected_meshes = [manifest.get("meshes", {}).get(value) for value in selected_hashes if value]
            selected_meshes = [mesh for mesh in selected_meshes if mesh]
            texture_paths = sorted({
                value for mesh in selected_meshes
                for lod in mesh.get("lods", {}).values() for submesh in lod.get("submeshes", [])
                for value in [
                    submesh.get("material", {}).get("diffuse"), submesh.get("material", {}).get("normal"),
                    submesh.get("material", {}).get("spec"), submesh.get("material", {}).get("detail"),
                ] if isinstance(value, str) and (root / "assets" / value).is_file()
            })
            write_status(status_path, args.remote, args.demo_root, "deploying", "Publishing preview assets", len(items))
            run(["ssh", args.remote, f"mkdir -p '{args.demo_root}/dist-thin/assets/custom_clothing' '{args.demo_root}/dist-thin/assets/models/custom_clothing/clothingpack5m' '{args.demo_root}/dist-thin/assets/models_textures'"], root)
            run(["scp", str(manifest_path), f"{args.remote}:{args.demo_root}/dist-thin/assets/custom_clothing/"], root)
            mesh_files = sorted({
                str(root / "assets" / "models" / submesh["file"])
                for mesh in selected_meshes for lod in mesh.get("lods", {}).values()
                for submesh in lod.get("submeshes", []) if submesh.get("file")
            })
            if mesh_files:
                run(["scp", *mesh_files, f"{args.remote}:{args.demo_root}/dist-thin/assets/models/custom_clothing/clothingpack5m/"], root)
            if texture_paths:
                run(["scp", *[str(root / "assets" / value) for value in texture_paths], f"{args.remote}:{args.demo_root}/dist-thin/assets/models_textures/"], root)
            last_digest = digest
            write_status(status_path, args.remote, args.demo_root, "ready", f"{len(items)} preview item(s) ready", len(items))
        except Exception as error:
            write_status(status_path, args.remote, args.demo_root, "error", str(error)[:500])
            time.sleep(max(8.0, args.interval))
        time.sleep(args.interval)


if __name__ == "__main__":
    raise SystemExit(main())

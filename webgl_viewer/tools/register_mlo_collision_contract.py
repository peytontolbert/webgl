#!/usr/bin/env python3
"""Register existing MLO collision provenance in a demo descriptor.

Use after composing compiled MLO collision layers. New imports create the same
contract directly; this tool migrates packages created by the older pipeline.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--descriptor", type=Path, required=True)
    parser.add_argument("--collision-manifest", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, action="append", default=[])
    parser.add_argument(
        "--resource-root", action="append", nargs=3, metavar=("ID", "ROOT_HASH", "RESOURCE_DIR"), default=[],
        help="Register a resource whose exported MLO metadata is unavailable.",
    )
    args = parser.parse_args()

    descriptor = json.loads(args.descriptor.read_text(encoding="utf-8"))
    collision = json.loads(args.collision_manifest.read_text(encoding="utf-8"))
    compiled_names = set(str(value) for value in (collision.get("source_ybn_names") or []))
    transforms: dict[str, Any] = dict(collision.get("resource_ybn_transforms") or {})
    for overlay in collision.get("destination_overlays") or []:
        compiled_names.update(str(value) for value in (overlay.get("source_ybn_names") or []))
        transforms.update(overlay.get("resource_ybn_transforms") or {})

    resources: list[tuple[str, list[str], Path]] = []
    for metadata_path in args.metadata:
        metadata_path = metadata_path.resolve()
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        roots = sorted({str(int(root.get("archetypeHash")) & 0xFFFFFFFF) for root in metadata.get("roots") or []}, key=int)
        resources.append((metadata_path.parent.name.lower(), roots, metadata_path.parent))
    for resource_id, root_hash, resource_dir in args.resource_root:
        resources.append((resource_id.lower(), [str(int(root_hash) & 0xFFFFFFFF)], Path(resource_dir).resolve()))

    imports = []
    for resource_id, roots, resource_dir in resources:
        candidates = sorted(resource_dir.rglob("*.ybn"))
        sources = []
        excluded = []
        for path in candidates:
            expected = f"FiveM:{path.name}"
            if expected not in compiled_names:
                excluded.append({"file": path.name, "reason": "outside-demo-collision-closure-or-not-emitted"})
                continue
            transform = transforms.get(path.stem.lower())
            placement: dict[str, Any] = {"mode": "world"}
            if isinstance(transform, dict):
                placement = {
                    "mode": "root-local",
                    "translation": transform.get("translation"),
                    "rotation": transform.get("rotation"),
                }
            sources.append({"file": path.name, "expectedCompiledName": expected, "placement": placement})
        imports.append({
            "id": resource_id,
            "rootArchetypeHashes": roots,
            "sourceHasCollision": bool(sources),
            "sources": sources,
            "excludedSources": excluded,
        })

    runtime = dict(descriptor.get("mloRuntime") or {})
    runtime["collisionContractSchema"] = "webglgta-mlo-collision-import-v1"
    runtime["collisionImports"] = imports
    descriptor["mloRuntime"] = runtime
    args.descriptor.write_text(json.dumps(descriptor, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "imports": len(imports),
        "declaredRoots": sum(len(item["rootArchetypeHashes"]) for item in imports),
        "compiledSources": sum(len(item["sources"]) for item in imports),
        "excludedSources": sum(len(item["excludedSources"]) for item in imports),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

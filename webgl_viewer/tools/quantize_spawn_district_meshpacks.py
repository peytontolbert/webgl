#!/usr/bin/env python3
"""Quantize an existing spawn-district mesh pack without rebuilding entities."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from copy import deepcopy
from pathlib import Path
from typing import Any

from build_spawn_district_demo import _quantize_mesh_payload


PACK_RE = re.compile(r"^@demo-pack/(?P<name>[^#]+)#(?P<offset>\d+):(?P<length>\d+)$")


def _iter_file_holders(manifest: dict[str, Any]):
    for entry in (manifest.get("meshes") or {}).values():
        for lod in (entry.get("lods") or {}).values():
            if isinstance(lod, dict) and isinstance(lod.get("file"), str):
                yield lod, "file"
            for submesh in (lod.get("submeshes") or lod.get("meshes") or []):
                if isinstance(submesh, dict) and isinstance(submesh.get("file"), str):
                    yield submesh, "file"


def transform(source_demo: Path, output_demo: Path, target_bytes: int) -> dict[str, Any]:
    descriptor = json.loads((source_demo / "spawn_district.json").read_text(encoding="utf-8"))
    manifest_rel = str(descriptor.get("manifestFile") or "demo/spawn_district_models.json")
    manifest_name = Path(manifest_rel).name
    manifest = json.loads((source_demo / manifest_name).read_text(encoding="utf-8"))
    output_demo.mkdir(parents=True, exist_ok=True)

    refs: dict[str, tuple[str, int, int]] = {}
    for holder, key in _iter_file_holders(manifest):
        ref = holder[key]
        match = PACK_RE.match(ref)
        if match:
            refs[ref] = (match.group("name"), int(match.group("offset")), int(match.group("length")))

    packs: dict[str, bytes] = {}
    converted: list[tuple[str, bytes]] = []
    source_bytes = compact_bytes = quantized_count = fallback_count = 0
    for ref, (name, offset, length) in sorted(refs.items(), key=lambda item: (item[1][0], item[1][1])):
        pack = packs.setdefault(name, (source_demo / name).read_bytes())
        payload = pack[offset:offset + length]
        if len(payload) != length:
            raise ValueError(f"truncated packed range: {ref}")
        source_bytes += len(payload)
        compact, changed = _quantize_mesh_payload(payload)
        if changed:
            quantized_count += 1
        else:
            fallback_count += 1
        compact_bytes += len(compact)
        converted.append((ref, compact))

    replacements: dict[str, str] = {}
    output_packs: list[str] = []
    current: list[tuple[str, bytes]] = []
    current_size = 0

    def flush() -> None:
        nonlocal current, current_size
        if not current:
            return
        data = b"".join(payload for _ref, payload in current)
        digest = hashlib.sha256(data).hexdigest()[:16]
        name = f"spawn_district_meshpack_q10_{digest}.bin"
        (output_demo / name).write_bytes(data)
        offset = 0
        for old_ref, payload in current:
            replacements[old_ref] = f"@demo-pack/{name}#{offset}:{len(payload)}"
            offset += len(payload)
        output_packs.append(name)
        current = []
        current_size = 0

    for ref, payload in converted:
        if current and current_size + len(payload) > target_bytes:
            flush()
        current.append((ref, payload))
        current_size += len(payload)
    flush()

    rewritten_manifest = deepcopy(manifest)
    for holder, key in _iter_file_holders(rewritten_manifest):
        holder[key] = replacements.get(holder[key], holder[key])
    output_manifest_name = "spawn_district_models_quantized_v3.json"
    (output_demo / output_manifest_name).write_text(
        json.dumps(rewritten_manifest, separators=(",", ":")), encoding="utf-8"
    )

    rewritten_descriptor = deepcopy(descriptor)
    rewritten_descriptor["manifestFile"] = f"demo/{output_manifest_name}"
    rewritten_descriptor["meshPackCount"] = len(output_packs)
    rewritten_descriptor["meshPackBytes"] = compact_bytes
    rewritten_descriptor["meshPackSourceBytes"] = source_bytes
    rewritten_descriptor["meshPackQuantizedFileCount"] = quantized_count
    rewritten_descriptor["meshPackQuantizeFallbackCount"] = fallback_count
    (output_demo / "spawn_district.json").write_text(
        json.dumps(rewritten_descriptor, indent=2) + "\n", encoding="utf-8"
    )

    # Entity and point tiles are unchanged but staged beside the descriptor for atomic deployment.
    for name in ("spawn_district_entities.bin", "spawn_district_points.bin"):
        (output_demo / name).write_bytes((source_demo / name).read_bytes())

    result = {
        "sourceManifest": manifest_name,
        "outputManifest": output_manifest_name,
        "sourcePackCount": len(packs),
        "outputPackCount": len(output_packs),
        "meshCount": len(converted),
        "quantizedCount": quantized_count,
        "fallbackCount": fallback_count,
        "sourceBytes": source_bytes,
        "compactBytes": compact_bytes,
        "ratio": compact_bytes / source_bytes if source_bytes else 1.0,
    }
    (output_demo / "quantization_report.json").write_text(
        json.dumps(result, indent=2) + "\n", encoding="utf-8"
    )
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-demo-dir", type=Path, required=True)
    parser.add_argument("--output-demo-dir", type=Path, required=True)
    parser.add_argument("--mesh-pack-mb", type=float, default=2.0)
    args = parser.parse_args()
    result = transform(
        args.source_demo_dir.resolve(),
        args.output_demo_dir.resolve(),
        max(256 * 1024, int(max(0.25, args.mesh_pack_mb) * 1024 * 1024)),
    )
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

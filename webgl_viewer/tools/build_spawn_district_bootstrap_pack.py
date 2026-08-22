#!/usr/bin/env python3
"""Pack the spawn tile's mesh slices into one cold-start-friendly demo pack."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import struct
from copy import deepcopy
from pathlib import Path


PACK_REF = re.compile(r"^@demo-pack/([^#]+)#(\d+):(\d+)$")


def iter_file_holders(entry: dict):
    for lod in (entry.get("lods") or {}).values():
        if not isinstance(lod, dict):
            continue
        if isinstance(lod.get("file"), str):
            yield lod
        for submesh in lod.get("submeshes") or lod.get("meshes") or []:
            if isinstance(submesh, dict) and isinstance(submesh.get("file"), str):
                yield submesh


def chunk_hashes(path: Path) -> set[str]:
    data = path.read_bytes()
    if len(data) < 8 or data[:4] != b"ENT1":
        raise ValueError(f"{path} is not an ENT1 tile")
    count = struct.unpack_from("<I", data, 4)[0]
    if count <= 0 or (len(data) - 8) % count:
        raise ValueError(f"{path} has an invalid ENT1 record layout")
    stride = (len(data) - 8) // count
    if stride not in (44, 48, 64):
        raise ValueError(f"{path} has unsupported ENT1 stride {stride}")
    return {
        str(struct.unpack_from("<I", data, 8 + index * stride)[0])
        for index in range(count)
    }


def build(
    demo_dir: Path,
    chunk_name: str,
    manifest_name: str,
    output_manifest_name: str,
    output_pack_name: str,
    source_models_dirs: list[Path],
    source_demo_dirs: list[Path],
) -> dict:
    source_manifest_path = demo_dir / manifest_name
    manifest = json.loads(source_manifest_path.read_text(encoding="utf-8"))
    hashes = chunk_hashes(demo_dir / "spawn_district_chunks" / chunk_name)
    rewritten = deepcopy(manifest)

    # MLO imports are merged after the base world pack is built. Fold those
    # late loose meshes into small content-addressed packs so thin deployments
    # never fall back to assets/models and do not pay one request per submesh.
    loose_payloads: dict[str, bytes] = {}
    loose_sources: dict[str, str] = {}
    for entry in (rewritten.get("meshes") or {}).values():
        for holder in iter_file_holders(entry):
            ref = str(holder.get("file") or "")
            if ref and not PACK_REF.match(ref):
                if ref in loose_payloads:
                    continue
                candidates = [demo_dir.parent / "models" / ref]
                candidates.extend(source_dir / ref for source_dir in source_models_dirs)
                source = next((path for path in candidates if path.is_file()), None)
                if source is None:
                    raise FileNotFoundError(
                        f"unresolved loose model {ref}; searched: "
                        + ", ".join(str(path) for path in candidates)
                    )
                loose_payloads[ref] = source.read_bytes()
                loose_sources[str(source.parent)] = loose_sources.get(str(source.parent), 0) + 1

    loose_replacements: dict[str, str] = {}
    late_pack_names: list[str] = []
    pending: list[tuple[str, bytes]] = []
    pending_bytes = 0

    def flush_late_pack():
        nonlocal pending, pending_bytes
        if not pending:
            return
        data = b"".join(payload for _ref, payload in pending)
        digest = hashlib.sha256(data).hexdigest()[:16]
        name = f"spawn_district_late_meshpack_{digest}.bin"
        (demo_dir / name).write_bytes(data)
        offset = 0
        for old_ref, payload in pending:
            loose_replacements[old_ref] = f"@demo-pack/{name}#{offset}:{len(payload)}"
            offset += len(payload)
        late_pack_names.append(name)
        pending = []
        pending_bytes = 0

    for ref, payload in sorted(loose_payloads.items()):
        if pending and pending_bytes + len(payload) > 4 * 1024 * 1024:
            flush_late_pack()
        pending.append((ref, payload))
        pending_bytes += len(payload)
    flush_late_pack()

    for entry in (rewritten.get("meshes") or {}).values():
        for holder in iter_file_holders(entry):
            holder["file"] = loose_replacements.get(str(holder.get("file") or ""), holder.get("file"))

    refs: dict[str, tuple[str, int, int]] = {}
    for hash_id in sorted(hashes, key=int):
        entry = (rewritten.get("meshes") or {}).get(hash_id)
        if not isinstance(entry, dict):
            continue
        for holder in iter_file_holders(entry):
            ref = str(holder.get("file") or "")
            match = PACK_REF.match(ref)
            if match:
                refs.setdefault(ref, (match.group(1), int(match.group(2)), int(match.group(3))))

    source_packs: dict[str, bytes] = {}
    payloads: list[tuple[str, bytes]] = []
    for ref, (pack_name, offset, length) in sorted(refs.items(), key=lambda item: (item[1][0], item[1][1])):
        if pack_name not in source_packs:
            candidates = [demo_dir / pack_name]
            candidates.extend(source_dir / pack_name for source_dir in source_demo_dirs)
            source = next((path for path in candidates if path.is_file()), None)
            if source is None:
                raise FileNotFoundError(
                    f"unresolved mesh pack {pack_name}; searched: "
                    + ", ".join(str(path) for path in candidates)
                )
            source_packs[pack_name] = source.read_bytes()
        pack = source_packs[pack_name]
        payload = pack[offset:offset + length]
        if len(payload) != length:
            raise ValueError(f"truncated mesh slice {ref}")
        payloads.append((ref, payload))

    replacement: dict[str, str] = {}
    offset = 0
    with (demo_dir / output_pack_name).open("wb") as out:
        for ref, payload in payloads:
            out.write(payload)
            replacement[ref] = f"@demo-pack/{output_pack_name}#{offset}:{len(payload)}"
            offset += len(payload)

    rewritten.setdefault("meshPackRevisions", {})[output_pack_name] = hashlib.sha256(
        (demo_dir / output_pack_name).read_bytes()
    ).hexdigest()[:16]
    rewritten_count = 0
    for hash_id in hashes:
        entry = (rewritten.get("meshes") or {}).get(hash_id)
        if not isinstance(entry, dict):
            continue
        for holder in iter_file_holders(entry):
            old = str(holder.get("file") or "")
            new = replacement.get(old)
            if new:
                holder["file"] = new
                rewritten_count += 1

    (demo_dir / output_manifest_name).write_text(
        json.dumps(rewritten, separators=(",", ":")), encoding="utf-8"
    )
    descriptor_path = demo_dir / "spawn_district.json"
    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
    runtime_dir = Path(str(descriptor.get("manifestFile") or "demo/spawn_district_models.json")).parent
    runtime_manifest = (runtime_dir / output_manifest_name).as_posix()
    descriptor["manifestFile"] = runtime_manifest
    descriptor["sourceManifestFile"] = runtime_manifest
    config_path = demo_dir.parents[1] / "demo_world.json"
    if config_path.is_file():
        config = json.loads(config_path.read_text(encoding="utf-8"))
        descriptor["worldConfig"] = {
            "schema": str(config.get("schema") or "webglgta-demo-world-config-v1"),
            "file": "demo_world.json",
            "revision": hashlib.sha256(config_path.read_bytes()).hexdigest()[:16],
        }
    descriptor_path.write_text(json.dumps(descriptor, indent=2) + "\n", encoding="utf-8")
    return {
        "chunk": chunk_name,
        "entities": len(hashes),
        "meshSlices": len(payloads),
        "sourcePacks": len(source_packs),
        "lateLooseMeshCount": len(loose_payloads),
        "looseSourceDirectories": loose_sources,
        "latePackCount": len(late_pack_names),
        "latePackBytes": sum((demo_dir / name).stat().st_size for name in late_pack_names),
        "bootstrapPackBytes": offset,
        "rewrittenReferences": rewritten_count,
        "outputManifest": output_manifest_name,
        "outputPack": output_pack_name,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo-dir", type=Path, required=True)
    parser.add_argument("--chunk", default=None)
    parser.add_argument("--manifest", default="spawn_district_models_compressed_v2.json")
    parser.add_argument("--output-manifest", default="spawn_district_models_bootstrap_v1.json")
    parser.add_argument("--output-pack", default="spawn_district_bootstrap_0_-4_v1.bin")
    parser.add_argument(
        "--source-models-dir",
        type=Path,
        action="append",
        default=[],
        help="Additional models roots used to resolve late loose MLO meshes (repeatable).",
    )
    parser.add_argument(
        "--source-demo-dir",
        type=Path,
        action="append",
        default=[],
        help="Additional demo roots used to resolve inherited mesh packs (repeatable).",
    )
    args = parser.parse_args()
    demo_dir = args.demo_dir.resolve()
    if args.chunk is None:
        descriptor = json.loads((demo_dir / "spawn_district.json").read_text(encoding="utf-8"))
        spawn = descriptor.get("spawn") or {}
        chunk_size = float(descriptor.get("instanceChunkSize") or 256.0)
        args.chunk = f"{math.floor(float(spawn['x']) / chunk_size)}_{math.floor(float(spawn['y']) / chunk_size)}.bin"
    print(json.dumps(build(
        demo_dir,
        args.chunk,
        args.manifest,
        args.output_manifest,
        args.output_pack,
        [path.resolve() for path in args.source_models_dir],
        [path.resolve() for path in args.source_demo_dir],
    ), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

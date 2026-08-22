#!/usr/bin/env python3
"""Repack final MSH9 clothing meshes with delta-varint indices and update the manifest."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import struct
from pathlib import Path

from export_clothingpack5m_selection import encode_delta_indices


def repack(raw: bytes) -> tuple[bytes, bool]:
    magic, version, vertex_count, index_count, flags = struct.unpack_from("<4sIIII", raw)
    if magic != b"MSH0" or version != 9 or not (flags & 512) or (flags & 4096):
        return raw, False
    packed = True
    pos_bytes = vertex_count * 6
    has_normals = bool(flags & 1)
    tight_normals = bool(flags & 1024) and bool(flags & 2048)
    int8_normals = bool(flags & 1024)
    nrm_bytes = vertex_count * (3 if tight_normals else (4 if int8_normals else 6)) if has_normals else 0
    normal_offset = 20 + pos_bytes
    uv_offset = (normal_offset + nrm_bytes + 1) & ~1 if tight_normals else normal_offset + nrm_bytes
    cursor = uv_offset
    if flags & 2: cursor += vertex_count * 4
    if flags & 16: cursor += vertex_count * 4
    if flags & 32: cursor += vertex_count * 4
    if flags & 4: cursor += vertex_count * 4
    if flags & 8: cursor += vertex_count * 4
    if flags & 64: cursor += vertex_count * 4
    if flags & 128: cursor += vertex_count * 4
    if flags & 256: cursor += vertex_count * 4
    index_offset = (cursor + 3) & ~3
    expected_end = index_offset + index_count * 2
    if expected_end != len(raw):
        raise ValueError(f"unexpected MSH9 length: expected {expected_end}, got {len(raw)}")
    indices = struct.unpack_from(f"<{index_count}H", raw, index_offset)
    header = struct.pack("<4sIIII", magic, version, vertex_count, index_count, flags | 4096)
    return header + raw[20:index_offset] + encode_delta_indices(indices), True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets-dir", type=Path, default=Path(__file__).resolve().parents[1] / "assets")
    args = parser.parse_args()
    assets = args.assets_dir.resolve()
    manifest_path = assets / "custom_clothing" / "clothingpack5m.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    replacements: dict[str, str] = {}
    before = after = 0
    for entry in manifest.get("meshes", {}).values():
        for lod in entry.get("lods", {}).values():
            for submesh in lod.get("submeshes", []):
                relative = str(submesh.get("file") or "")
                if not relative.endswith(".msh9.gz"):
                    continue
                if relative not in replacements:
                    source = assets / "models" / relative
                    compressed = source.read_bytes()
                    raw = gzip.decompress(compressed)
                    packed, changed = repack(raw)
                    if changed:
                        payload = gzip.compress(packed, compresslevel=9, mtime=0)
                        name = f"{hashlib.sha256(packed).hexdigest()[:24]}.msh9.gz"
                        target = source.with_name(name)
                        if not target.exists():
                            target.write_bytes(payload)
                        replacements[relative] = str(Path(relative).with_name(name)).replace("\\", "/")
                        before += len(compressed)
                        after += len(payload)
                    else:
                        replacements[relative] = relative
                submesh["file"] = replacements[relative]
    manifest_path.write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"files": len(replacements), "beforeBytes": before, "afterBytes": after, "savedBytes": before - after}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

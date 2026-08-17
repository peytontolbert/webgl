#!/usr/bin/env python3
"""Verify a split asset-collider package reconstructs its source records."""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path


def canonical(record: object) -> str:
    return json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--compiled-dir", type=Path, required=True)
    args = parser.parse_args()
    source = json.loads(args.source.read_text(encoding="utf-8"))
    manifest = json.loads((args.compiled_dir / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema") != "webglgta-compiled-asset-colliders-v1": raise SystemExit("unexpected manifest schema")
    if manifest.get("source_sha256") != sha256(args.source): raise SystemExit("source hash mismatch")
    live = json.loads((args.compiled_dir / manifest["live_overlay"]).read_text(encoding="utf-8"))
    reconstructed = list(live.get("colliders") or [])
    for entry in manifest.get("chunks") or []:
        chunk = json.loads((args.compiled_dir / str(entry["file"])).read_text(encoding="utf-8"))
        records = chunk.get("colliders") or []
        if len(records) != int(entry["count"]): raise SystemExit(f"chunk count mismatch: {entry['file']}")
        reconstructed.extend(records)
    expected = list(source.get("colliders") or [])
    if Counter(map(canonical, expected)) != Counter(map(canonical, reconstructed)): raise SystemExit("source records do not reconstruct exactly")
    if source.get("ybnCollisionExclusions", []) != live.get("ybnCollisionExclusions", []): raise SystemExit("YBN exclusions changed")
    print(json.dumps({"valid": True, "source_records": len(expected), "static_records": manifest["immutable_record_count"], "live_records": len(live.get("colliders") or []), "chunks": len(manifest["chunks"])}, indent=2))


if __name__ == "__main__":
    main()

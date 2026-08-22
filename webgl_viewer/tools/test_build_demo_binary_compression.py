#!/usr/bin/env python3
"""Unit test for compressed-only runtime binary packaging."""

from __future__ import annotations

import gzip
import importlib.util
import tempfile
from pathlib import Path


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("build_demo_deployment", HERE / "build_demo_deployment.py")
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)


with tempfile.TemporaryDirectory() as directory:
    output = Path(directory)
    assets = output / "dist" / "assets"
    meshpack = assets / "demo" / "pack.bin"
    model = assets / "models" / "model.bin"
    collision = assets / "collision" / "ybn_spawn.bin"
    compiled_collision = assets / "collision" / "compiled" / "chunk.cwct"
    unrelated = assets / "demo" / "instances.bin"
    write(meshpack, b"MSH0" + b"mesh-data" * 4096)
    write(model, b"MSH9" + b"model-data" * 4096)
    write(collision, b"YBNC" + b"collision-data" * 4096)
    write(compiled_collision, b"CWCT" + b"compiled-collision-data" * 4096)
    write(unrelated, b"ENT1" + b"instance-data" * 128)

    report = MODULE.compress_runtime_binaries(output, keep_raw=False)

    assert report["files"] == 4
    assert report["savedBytes"] > 0
    for source in (meshpack, model, collision, compiled_collision):
        compressed = source.with_name(source.name + ".gz")
        assert not source.exists()
        with gzip.open(compressed, "rb") as handle:
            assert handle.read(4) in (b"MSH0", b"MSH9", b"YBNC", b"CWCT")
    assert unrelated.exists(), "only MSH0 demo packs should be transformed"

print("demo runtime binary compression contract passed")

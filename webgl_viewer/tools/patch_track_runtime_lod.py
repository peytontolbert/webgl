#!/usr/bin/env python3
"""Patch the deployed unified-track streamer to honor the selected model LOD."""

from __future__ import annotations

import argparse
import gzip
from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise ValueError(f"{label}: expected one match, found {count}")
    return source.replace(old, new, 1)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    args = parser.parse_args()
    path = args.bundle.resolve()
    source = path.read_text(encoding="utf-8")

    source = replace_once(
        source,
        "this._nordschleifeDemoStreamPromise=(async()=>{var p,g,b,y,x,v;const l=[];",
        "this._nordschleifeDemoStreamPromise=(async()=>{var p,g,b,y,x,v;"
        "const TrackLod=String(this.forcedModelLod||\"high\"),PreviousTrackLod=String(this._nordschleifeDemoActiveLod||\"high\");"
        "if(TrackLod!==PreviousTrackLod){for(const TrackHash of this._nordschleifeDemoActive)"
        "await this.instancedModelRenderer.setInstancesForArchetype(TrackHash,PreviousTrackLod,new Float32Array(0),null,{allowPlaceholderMesh:!1});"
        "this._nordschleifeDemoActive=new Set}this._nordschleifeDemoActiveLod=TrackLod;const l=[];",
        "track LOD transition",
    )
    source = replace_once(
        source,
        'g.call(p,_,"high",new Float32Array(0),null,{allowPlaceholderMesh:!1})',
        'g.call(p,_,TrackLod,new Float32Array(0),null,{allowPlaceholderMesh:!1})',
        "track LOD removal",
    )
    source = replace_once(
        source,
        'v.call(x,w,String((_==null?void 0:_.lod)||"high"),new Float32Array(_.matrix),M,',
        'v.call(x,w,TrackLod,new Float32Array(_.matrix),M,',
        "track LOD activation",
    )
    path.write_text(source, encoding="utf-8")
    path.with_name(path.name + ".gz").write_bytes(gzip.compress(source.encode("utf-8"), compresslevel=9, mtime=0))
    print(f"patched {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

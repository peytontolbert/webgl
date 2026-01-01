import argparse
import struct
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser(description="Inspect a .bin mesh header (MSH0) used by the WebGL viewer.")
    ap.add_argument("mesh", type=str, help="Path to a mesh bin (e.g. assets/models/<hash>_high_0.bin)")
    args = ap.parse_args()

    p = Path(args.mesh)
    if not p.exists():
        raise SystemExit(f"Missing mesh: {p}")

    data = p.read_bytes()
    if len(data) < 20:
        raise SystemExit("File too small for MSH0 header")

    magic = data[0:4].decode("ascii", errors="ignore")
    version, vcount, icount, flags = struct.unpack("<IIII", data[4:20])
    has_normals = version >= 2 and (flags & 1) == 1
    has_uvs = version >= 3 and (flags & 2) == 2
    has_tangents = version >= 4 and (flags & 4) == 4

    print("file:", str(p))
    print("bytes:", len(data))
    print("magic:", magic)
    print("version:", version)
    print("vertexCount:", vcount)
    print("indexCount:", icount)
    print("flags:", flags, f"(0x{flags:08x})")
    print("hasNormals:", has_normals)
    print("hasUvs:", has_uvs)
    print("hasTangents:", has_tangents)


if __name__ == "__main__":
    main()



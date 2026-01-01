import argparse
import json
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser(description="Inspect a WebGL viewer manifest shard for material/texture fields.")
    ap.add_argument("shard", type=str, help="Path to a manifest shard JSON (e.g. assets/models/manifest_shards/00.json)")
    ap.add_argument("--scan", type=int, default=20000, help="How many mesh entries to scan for material texture fields")
    ap.add_argument("--samples", type=int, default=10, help="How many sample entries to print when found")
    args = ap.parse_args()

    p = Path(args.shard)
    if not p.exists():
        raise SystemExit(f"Missing shard: {p}")

    data = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
    print("top_keys:", list(data.keys()))
    meshes = data.get("meshes") or {}
    if not isinstance(meshes, dict):
        raise SystemExit("Shard does not contain a 'meshes' object")
    print("mesh_count:", len(meshes))

    # Peek first entry structure.
    first_key = next(iter(meshes.keys()), None)
    if first_key is not None:
        e0 = meshes.get(first_key) or {}
        if isinstance(e0, dict):
            print("first_mesh_key:", first_key)
            print("first_entry_keys:", sorted(e0.keys()))
            lods = e0.get("lods") or {}
            if isinstance(lods, dict):
                print("first_lod_keys:", sorted(lods.keys()))
            mat = e0.get("material")
            if isinstance(mat, dict):
                print("first_material_keys:", sorted(mat.keys()))
            else:
                print("first_material:", mat)

    want = ("diffuse", "normal", "spec")
    scanned = 0
    found = 0
    sample_rows = []

    for k, e in meshes.items():
        if scanned >= int(args.scan):
            break
        scanned += 1
        if not isinstance(e, dict):
            continue
        mat = e.get("material")
        if isinstance(mat, dict) and any(w in mat for w in want):
            found += 1
            if len(sample_rows) < int(args.samples):
                sample_rows.append(
                    (str(k), str(mat.get("diffuse")), str(mat.get("normal")), str(mat.get("spec")))
                )

    print(f"scanned_entries: {scanned}")
    print(f"entries_with_any_of_{want}: {found}")
    if sample_rows:
        print("samples (hash, diffuse, normal, spec):")
        for r in sample_rows:
            print("  ", r)


if __name__ == "__main__":
    main()



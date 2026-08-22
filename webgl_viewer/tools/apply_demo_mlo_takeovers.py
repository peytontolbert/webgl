#!/usr/bin/env python3
"""Apply MLO world-instance takeover rules to an already imported demo."""

from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

from import_fivem_mlo_demo import _filter_mlo_takeover_records, _read_ent1_records, _upgrade_ent1_record


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--descriptor", type=Path, default=root / "assets/demo/spawn_district.json")
    parser.add_argument("--base-instances", type=Path, default=None, help="Pristine base ENT1 used to restore retained replacement entities.")
    parser.add_argument(
        "--root-hash",
        action="append",
        default=[],
        help="Apply takeover rules only for this MLO root hash (repeatable).",
    )
    args = parser.parse_args()

    descriptor_path = args.descriptor.resolve()
    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
    demo_dir = descriptor_path.parent
    instance_path = demo_dir / Path(str(descriptor.get("sourceInstanceFile") or descriptor["instanceFile"])).name
    records, stride = _read_ent1_records(instance_path)
    if stride != 64:
        raise ValueError(f"Expected an imported 64-byte MLO ENT1, got stride {stride}")

    base_count = int((descriptor.get("mloImport") or {}).get("mloSegmentStart") or 0)
    if not (0 < base_count < len(records)):
        base_count = next((index for index, record in enumerate(records) if struct.unpack_from("<I", record, 60)[0] & 3), 0)
    if base_count <= 0:
        raise ValueError("Could not locate the first MLO record after the base instance prefix")

    roots = []
    for record in records[base_count:]:
        flags = struct.unpack_from("<I", record, 60)[0]
        if flags & 1:
            archetype_hash, x, y, z = struct.unpack_from("<I3f", record, 0)
            roots.append({"archetypeHash": archetype_hash, "position": [x, y, z]})
    selected_root_hashes = {int(value) & 0xFFFFFFFF for value in args.root_hash}
    if selected_root_hashes:
        roots = [root for root in roots if int(root["archetypeHash"]) in selected_root_hashes]
    if not roots:
        raise ValueError("No matching MLO root records were found")

    base_path = args.base_instances.resolve() if args.base_instances else demo_dir / "spawn_district_entities.bin"
    base_records, base_stride = _read_ent1_records(base_path) if base_path.is_file() else (records[:base_count], stride)
    retained, stats = _filter_mlo_takeover_records(base_records, roots)
    output = [_upgrade_ent1_record(record, base_stride) for record in retained] + records[base_count:]
    temporary = instance_path.with_suffix(instance_path.suffix + ".tmp")
    with temporary.open("wb") as handle:
        handle.write(b"ENT1")
        handle.write(struct.pack("<I", len(output)))
        handle.writelines(output)
    temporary.replace(instance_path)

    mlo_stats = descriptor.setdefault("mloImport", {})
    mlo_stats.update(stats)
    mlo_stats["retainedBaseInstanceCount"] = len(retained)
    mlo_stats["totalInstanceCount"] = len(output)
    descriptor["instanceCount"] = len(output)
    descriptor_path.write_text(json.dumps(descriptor, indent=2) + "\n", encoding="utf-8")

    report_path = demo_dir / "spawn_district_mlo_import.json"
    if report_path.is_file():
        report = json.loads(report_path.read_text(encoding="utf-8"))
        report.setdefault("instances", {}).update(mlo_stats)
        report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print(json.dumps({"instanceFile": str(instance_path), "roots": len(roots), **stats, "totalInstanceCount": len(output)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

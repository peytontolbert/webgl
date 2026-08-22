#!/usr/bin/env python3
"""Read-only Halo 3 MCC cache inspector.

This is deliberately a small, dependency-free starting point for the Guardian
export pipeline.  It opens cache files directly and writes only JSON reports;
it never writes to MCC's install directory or attempts to execute game code.

It currently validates and records the MCC Halo 3 cache header, identifies the
scenario path, and reports known tag-class signatures found in the map.  The
next parser stage can use the generated report to implement the tag-index and
resource-reference records without a desktop application or engine runtime.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mmap
import struct
from collections import defaultdict
from pathlib import Path
from typing import BinaryIO


HEADER_SIZE = 0x800
HEADER_MAGIC = b"daeh"  # little-endian bytes for the Halo cache header marker
KNOWN_TAG_CLASSES = {
    b"rncs": "scenario",
    b"psbs": "scenario_structure_bsp",
    b"edom": "render_model",
    b"mtib": "bitmap",
    b"paew": "weapon",
    b"dpib": "biped",
    b"tmlh": "model",
    b"lloc": "collision_model",
    b"omph": "physics_model",
    b"enoz": "cache_file_resource_gestalt",
    b"yalp": "cache_file_resource_layout_table",
}

# These offsets are verified against Guardian's MCC Halo 3 header.  The table
# payloads are still deliberately opaque until each record layout has a
# version-specific validator; naming a section must not be confused with
# guessing the structure of every entry in it.
SECTION_LAYOUT = (
    # This pair is a declared offset/length span in this MCC build.  Its
    # consumer has not yet been decoded, so do not label it as tag data or as
    # a shared-map reference merely because its declared end exceeds this
    # cache file.
    ("declaredDataSpan", 0x10, 0x14, None),
    ("stringIdIndex", 0x24, None, 0x20),
    ("stringIdData", 0x2C, 0x28, None),
    ("fileTable", 0x34, 0x38, 0x30),
    ("fileTableIndex", 0x3C, None, 0x30),
    ("cacheIndex", 0x44, None, None),
)

# Guardian's MCC Halo 3 scenario layout is versioned. These offsets were
# validated against the installed Guardian cache (map version 13) and are kept
# in this Python reader so the WebGL pipeline does not depend on a separately
# compiled exporter for gameplay data.
MCC_H3_GUARDIAN = {
    "scenario_size": 0x780,
    "structure_bsps_block": 0x18,
    "player_starting_locations_block": 0x24C,
    "player_starting_location_size": 0x18,
    "virtual_base": 0x2E0,
    "section_offsets": 0x4CC,
    "section_table": 0x4DC,
    "metadata_section": 2,
}


def read_u32(data: mmap.mmap, offset: int) -> int:
    return struct.unpack_from("<I", data, offset)[0]


def c_string(data: mmap.mmap, offset: int, length: int) -> str:
    raw = data[offset : offset + length].split(b"\0", 1)[0]
    return raw.decode("ascii", errors="replace")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_tag_index(path: Path) -> dict[str, object]:
    """Load the pre-existing tag index produced by the asset pipeline."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("tags"), list):
        raise ValueError(f"{path} is not a Guardian tag-index JSON file")
    return payload


def resolve_mcc_h3_pointer(data: mmap.mmap, pointer: int) -> int:
    """Resolve MCC Halo 3's compact Gen3 metadata pointer to a map-file offset."""
    profile = MCC_H3_GUARDIAN
    section = profile["metadata_section"]
    virtual_base = struct.unpack_from("<Q", data, profile["virtual_base"])[0]
    section_offset = read_u32(data, profile["section_offsets"] + section * 4)
    section_address = read_u32(data, profile["section_table"] + section * 8)
    section_base = (section_address + section_offset) & 0xFFFFFFFF
    magic = virtual_base - section_base
    return (pointer << 2) - magic


def guardian_scenario_gameplay(data: mmap.mmap, tag_index: dict[str, object]) -> dict[str, object]:
    """Extract the scenario-owned Guardian player start and BSP references.

    This intentionally validates the block count, pointer, record size and
    values. A failed validation is safer than falling back to render geometry
    and placing the player outside the level.
    """
    tags = tag_index["tags"]
    scenario = next(
        (
            tag for tag in tags
            if tag.get("ClassCode") == "scnr"
            and tag.get("TagName") == "levels\\multi\\guardian\\guardian"
        ),
        None,
    )
    if not isinstance(scenario, dict):
        raise ValueError("Guardian scenario tag is absent from the supplied tag index")
    meta_offset = int(str(scenario["MetaOffset"]), 16)
    profile = MCC_H3_GUARDIAN
    if meta_offset < 0 or meta_offset + profile["scenario_size"] > len(data):
        raise ValueError("Guardian scenario metadata range is outside the map cache")

    def block_at(relative_offset: int) -> tuple[int, int]:
        count = read_u32(data, meta_offset + relative_offset)
        pointer = read_u32(data, meta_offset + relative_offset + 4)
        address = resolve_mcc_h3_pointer(data, pointer)
        if count == 0 or address < 0 or address >= len(data):
            raise ValueError(f"invalid scenario block at scnr+0x{relative_offset:X}")
        return count, address

    start_count, start_address = block_at(profile["player_starting_locations_block"])
    record_size = profile["player_starting_location_size"]
    if start_count > 16 or start_address + start_count * record_size > len(data):
        raise ValueError("Guardian player-starting-locations block is out of range")

    spawns: list[dict[str, object]] = []
    for index in range(start_count):
        offset = start_address + index * record_size
        x, y, z, yaw, pitch = struct.unpack_from("<5f", data, offset)
        insertion_point, unit_type = struct.unpack_from("<hh", data, offset + 20)
        if not all(map(lambda value: abs(value) < 10000.0, (x, y, z, yaw, pitch))):
            raise ValueError(f"non-finite or implausible player start at index {index}")
        if abs(yaw) > 6.4 or abs(pitch) > 6.4 or unit_type not in range(6):
            raise ValueError(f"invalid player-starting-location orientation/type at index {index}")
        spawns.append(
            {
                "position": [x, y, z],
                "yaw": yaw,
                "pitch": pitch,
                "insertionPoint": insertion_point,
                "unitType": unit_type,
            }
        )

    bsp_count, bsp_address = block_at(profile["structure_bsps_block"])
    return {
        "schema": "guardian-gameplay-v1",
        "readOnly": True,
        "scenario": scenario["TagName"],
        "coordinateSystem": "Halo 3 native: X forward, Y right, Z up",
        "source": {
            "tagIndex": str(tag_index.get("map", "")),
            "scenarioMetaOffset": f"0x{meta_offset:08X}",
            "playerStartingLocations": {
                "scenarioOffset": f"0x{profile['player_starting_locations_block']:X}",
                "recordSize": record_size,
                "count": start_count,
            },
        },
        "spawns": spawns,
        "collision": {
            "source": "scenario_structure_bsps",
            "scenarioOffset": f"0x{profile['structure_bsps_block']:X}",
            "count": bsp_count,
            "metadataAddress": f"0x{bsp_address:08X}",
            "status": "references extracted; collision triangle decoding remains a separate validated stage",
        },
        "player": {
            "radius": 0.34,
            "height": 1.7,
            "eyeHeight": 1.55,
            "stepHeight": 0.45,
            "gravity": 9.81,
            "jumpSpeed": 4.7,
            "walkSpeed": 3.7,
        },
    }


def scan_tag_classes(data: mmap.mmap) -> dict[str, dict[str, object]]:
    """Return bounded signature inventories for recognised on-disk tag classes.

    MCC's cache tables use little-endian four-character identifiers.  This is
    intentionally a signature inventory, not a claim that every occurrence is
    a complete tag record; later stages validate records against the tag index.
    """
    hits: dict[str, list[int]] = defaultdict(list)
    counts: dict[str, int] = defaultdict(int)
    for signature, label in KNOWN_TAG_CLASSES.items():
        offset = data.find(signature)
        while offset >= 0:
            counts[label] += 1
            if len(hits[label]) < 64:
                hits[label].append(offset)
            offset = data.find(signature, offset + 1)
    return {
        label: {
            "occurrenceCount": counts[label],
            "sampleOffsets": [f"0x{offset:08X}" for offset in offsets],
            "samplesTruncated": counts[label] > len(offsets),
        }
        for label, offsets in hits.items()
    }


def cache_sections(data: mmap.mmap) -> list[dict[str, object]]:
    sections: list[dict[str, object]] = []
    for name, pointer_word_offset, size_word_offset, count_word_offset in SECTION_LAYOUT:
        file_offset = read_u32(data, pointer_word_offset)
        if file_offset == 0:
            continue
        if file_offset >= len(data):
            continue
        declared_size = read_u32(data, size_word_offset) if size_word_offset else None
        declared_count = read_u32(data, count_word_offset) if count_word_offset else None
        preview_length = min(0x40, len(data) - file_offset)
        preview = data[file_offset : file_offset + preview_length]
        section: dict[str, object] = {
            "name": name,
            "headerPointerWordOffset": f"0x{pointer_word_offset:02X}",
            "fileOffset": f"0x{file_offset:08X}",
            "pageAligned": file_offset % 0x1000 == 0,
            "previewWords": [
                f"0x{struct.unpack_from('<I', preview, offset)[0]:08X}"
                for offset in range(0, len(preview) - (len(preview) % 4), 4)
            ],
        }
        if declared_size is not None:
            section["declaredSizeBytes"] = declared_size
            available_bytes = len(data) - file_offset
            section["availableBytesInThisCache"] = available_bytes
            section["declaredRangeInFile"] = declared_size <= available_bytes
            if declared_size > available_bytes:
                section["unavailableBytes"] = declared_size - available_bytes
        if declared_count is not None:
            section["declaredRecordCount"] = declared_count
        sections.append(section)
    return sections


def inspect_map(path: Path, include_signatures: bool) -> dict[str, object]:
    if not path.is_file():
        raise FileNotFoundError(path)

    with path.open("rb") as stream:
        with mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
            if len(data) < HEADER_SIZE:
                raise ValueError(f"{path} is smaller than a Halo cache header")
            if data[:4] != HEADER_MAGIC:
                raise ValueError(
                    f"{path} does not start with the expected Halo cache marker; "
                    f"found {data[:4]!r}"
                )

            # These offsets are observed directly from the MCC Halo 3 header.
            # Unnamed words remain raw values until the tag-index parser has a
            # version-specific structural validator.
            header_words = {
                f"0x{offset:02X}": read_u32(data, offset)
                for offset in range(0x04, 0x60, 4)
            }
            report: dict[str, object] = {
                "format": "halo3-mcc-cache-inspection-v1",
                "readOnly": True,
                "path": str(path),
                "sizeBytes": len(data),
                "sha256": sha256(path),
                "header": {
                    "marker": data[:4].decode("ascii"),
                    "version": read_u32(data, 0x04),
                    "build": c_string(data, 0xA0, 0x20),
                    "mapName": c_string(data, 0xC0, 0x20),
                    "scenarioPath": c_string(data, 0xE0, 0x100),
                    "rawWords": header_words,
                },
                "cacheSections": cache_sections(data),
                "nextStage": {
                    "tagIndex": "pending version-specific record validation",
                    "sharedResources": "pending tag-reference resolution",
                    "webglExport": "pending geometry/bitmap decoders",
                },
            }
            if include_signatures:
                report["tagClassSignatureInventory"] = scan_tag_classes(data)
            return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("map", type=Path, help="path to a Halo 3 MCC .map cache")
    parser.add_argument("--output", type=Path, required=True, help="JSON report path")
    parser.add_argument("--tag-index", type=Path, help="existing Guardian tag-index JSON; required with --gameplay-output")
    parser.add_argument("--gameplay-output", type=Path, help="write validated Guardian scenario gameplay data")
    parser.add_argument(
        "--include-signatures",
        action="store_true",
        help="scan for known tag-class signatures (slower, but still read-only)",
    )
    args = parser.parse_args()
    report = inspect_map(args.map, args.include_signatures)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {args.output}")
    if args.gameplay_output:
        if not args.tag_index:
            raise ValueError("--gameplay-output requires --tag-index")
        with args.map.open("rb") as stream:
            with mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
                gameplay = guardian_scenario_gameplay(data, read_tag_index(args.tag_index))
        args.gameplay_output.parent.mkdir(parents=True, exist_ok=True)
        args.gameplay_output.write_text(json.dumps(gameplay, indent=2) + "\n", encoding="utf-8")
        print(f"Wrote {args.gameplay_output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

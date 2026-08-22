#!/usr/bin/env python3
"""Build a compact, local-only visual proxy of a multi-KN5 Assetto track.

The output is intentionally a quantized, untextured scene representation for
this demo.  It is not a re-package of KN5 files or their textures: every model
is transformed into coarse vertex positions, material names become a small
generated palette, and the payload is gzip-compressed for streamed WebGL use.
The existing derived road remains the authoritative initial collision layer.
"""

from __future__ import annotations

import argparse
from array import array
import configparser
import gzip
import hashlib
import importlib.util
import json
import math
import os
import subprocess
import struct
import sys
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any


HEADER = struct.Struct("<4sIIII6f")
# Assetto track KN5 files can contain orange visualisation meshes for their
# internal physics/collision authoring. They are not scenery and the demo uses
# its separately compiled road collision layer instead.
NON_VISUAL_MATERIALS = frozenset({"physics"})
NON_VISUAL_NODE_PREFIXES = (
    "AC_START_",
    "AC_PIT_",
    "AC_TIME_",
    "AC_HOTLAP_START_",
)


def is_non_visual_node(name: str) -> bool:
    """Return whether an Assetto node is a gameplay locator, not scenery."""
    normalized = str(name or "").strip().upper()
    return normalized.startswith("AC_AUDIO") or normalized.startswith(NON_VISUAL_NODE_PREFIXES)


def _read_nodes_with_tangents(reader: Any, stream: Any, nodes: list[Any], parent_id: int) -> list[Any]:
    """KN5 node reader retaining the vertex tangent discarded by the OBJ tool.

    The local helper reader intentionally kept only attributes needed for OBJ
    export.  Assetto's `ksMultilayer_fresnel_nm` vertex shader, however,
    explicitly consumes `POSITION`, `NORMAL`, `TEXCOORD`, and `TANGENT`.
    Retain that final vector here so browser normal/detail-normal shading has
    the authored tangent frame instead of a screen-space approximation.
    """
    node = reader.Kn5Node()
    node.parent = parent_id
    node.type = reader._read_i32(stream)
    node.name = reader._read_string(stream, reader._read_i32(stream))
    children_count = reader._read_i32(stream)
    active = stream.read(1)
    node.active = bool(active and active[0])
    if node.type == 1:
        matrix = [[0.0] * 4 for _ in range(4)]
        for row in range(4):
            for column in range(4):
                matrix[row][column] = reader._read_f32(stream)
        node.tmatrix = matrix
    elif node.type in (2, 3):
        flags = stream.read(3)
        if len(flags) != 3:
            raise RuntimeError(f"KN5 mesh flags are truncated for {node.name}")
        node.cast_shadows = bool(flags[0])
        node.visible = bool(flags[1])
        node.transparent = bool(flags[2])
        if node.type == 3:
            for _ in range(reader._read_i32(stream)):
                reader._read_string(stream, reader._read_i32(stream))
                stream.read(64)
        node.vertex_count = reader._read_i32(stream)
        node.pos, node.nrm, node.uv0, node.tangent = [], [], [], []
        for _ in range(node.vertex_count):
            node.pos.extend(struct.unpack("<fff", stream.read(12)))
            node.nrm.extend(struct.unpack("<fff", stream.read(12)))
            u, v = struct.unpack("<ff", stream.read(8))
            node.uv0.extend((u, 1.0 - v))
            node.tangent.extend(struct.unpack("<fff", stream.read(12)))
            # Skinned vertices append bone indices/weights after tangent.
            if node.type == 3:
                stream.read(32)
        node.indices = reader._read_u16s(stream, reader._read_i32(stream))
        node.material_id = reader._read_i32(stream)
        if node.type == 2:
            tail = stream.read(29)
            if len(tail) != 29:
                raise RuntimeError(f"KN5 mesh tail is truncated for {node.name}")
            node.layer, node.lod_in, node.lod_out, sphere_x, sphere_y, sphere_z, node.sphere_radius, renderable = struct.unpack("<iffffffB", tail)
            node.bounding_sphere = [sphere_x, sphere_y, sphere_z, node.sphere_radius]
            node.renderable = bool(renderable)
        else:
            tail = stream.read(12)
            if len(tail) != 12:
                raise RuntimeError(f"KN5 skinned-mesh tail is truncated for {node.name}")
            node.layer, node.lod_in, node.lod_out = struct.unpack("<iff", tail)
            node.bounding_sphere = None
            node.renderable = True
    node.hmatrix = node.tmatrix if parent_id < 0 else reader._mat4_mul(node.tmatrix, nodes[parent_id].hmatrix)
    nodes.append(node)
    current_id = len(nodes) - 1
    for _ in range(children_count):
        _read_nodes_with_tangents(reader, stream, nodes, current_id)
    return nodes


def read_kn5_textured(reader: Any, path: Path) -> tuple[list[dict[str, Any]], list[Any], dict[str, bytes]]:
    """Read the KN5 data retained by the textured browser format.

    The older proxy reader deliberately skipped embedded images and material
    samples.  This reader keeps only the source data required by WebGL: the
    material samples and the original image bytes. Mesh normals and UVs are
    already retained by the shared KN5 node reader.
    """
    materials: list[dict[str, Any]] = []
    textures: dict[str, bytes] = {}
    with path.open("rb") as stream:
        header = stream.read(10)
        if len(header) != 10:
            raise RuntimeError(f"KN5 header is truncated: {path}")
        _magic, version = struct.unpack("<6sI", header)
        if version > 5:
            stream.read(4)
        texture_count = reader._read_i32(stream)
        for _ in range(texture_count):
            stream.read(4)
            name = reader._read_string(stream, reader._read_i32(stream)).replace("\\", "/")
            size = reader._read_i32(stream)
            payload = stream.read(max(0, size))
            if name and len(payload) == size:
                textures.setdefault(name.lower(), payload)
        material_count = reader._read_i32(stream)
        for _ in range(material_count):
            name = reader._read_string(stream, reader._read_i32(stream)) or "track"
            shader = reader._read_string(stream, reader._read_i32(stream))
            stream.read(2)
            if version > 4:
                stream.read(4)
            props: dict[str, float] = {}
            # KN5 material properties occupy ten floats.  The old importer
            # retained only the first and skipped the other nine as unknown.
            # That loses authored vector controls such as the two-axis detail
            # normal scale used by the Nordschleife multilayer road shader.
            property_vectors: dict[str, list[float]] = {}
            for _ in range(reader._read_i32(stream)):
                prop_name = reader._read_string(stream, reader._read_i32(stream))
                value = reader._read_f32(stream)
                tail = struct.unpack("<9f", stream.read(36))
                if prop_name:
                    props[prop_name] = value
                    property_vectors[prop_name] = [value, *tail]
            samples: dict[str, str] = {}
            for _ in range(reader._read_i32(stream)):
                sample = reader._read_string(stream, reader._read_i32(stream))
                stream.read(4)
                texture = reader._read_string(stream, reader._read_i32(stream)).replace("\\", "/")
                if sample and texture:
                    samples[sample] = texture
            materials.append({
                "name": name,
                "shader": shader,
                "props": props,
                "propertyVectors": property_vectors,
                "samples": samples,
            })
        nodes = _read_nodes_with_tangents(reader, stream, [], -1)
    return materials, nodes, textures


class TexturePack:
    """Deduplicate embedded DDS assets and encode browser-readable WebP files."""
    def __init__(self, output_dir: Path, *, quality: int, max_size: int):
        self.output_dir = output_dir / "textures"
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.quality = max(1, min(100, int(quality)))
        self.max_size = max(0, int(max_size))
        self._known: dict[str, str | None] = {}

    def add(self, source_name: str, payload: bytes) -> str | None:
        if not payload:
            return None
        digest = hashlib.sha256(payload).hexdigest()
        if digest in self._known:
            return self._known[digest]
        target = self.output_dir / f"{digest}.webp"
        relative = f"textures/{target.name}"
        if target.is_file() and target.stat().st_size > 0:
            self._known[digest] = relative
            return relative
        suffix = Path(source_name).suffix or ".dds"
        source = Path(tempfile.gettempdir()) / f"webglgta-ac-{digest}{suffix}"
        try:
            source.write_bytes(payload)
            command = ["ffmpeg", "-y", "-v", "error", "-i", str(source)]
            if self.max_size:
                command += ["-vf", f"scale='min({self.max_size},iw)':-2"]
            command += ["-c:v", "libwebp", "-q:v", str(self.quality), str(target)]
            completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
            if completed.returncode or not target.is_file() or target.stat().st_size == 0:
                self._known[digest] = None
                return None
            self._known[digest] = relative
            return relative
        finally:
            try:
                source.unlink(missing_ok=True)
            except OSError:
                pass


def load_parser(path: Path):
    spec = importlib.util.spec_from_file_location("ac_kn5_reader", path)
    if not spec or not spec.loader:
        raise RuntimeError(f"Cannot load KN5 parser: {path}")
    module = importlib.util.module_from_spec(spec)
    # Dataclasses resolves its module while decorators execute.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def static_model_entries(track_root: Path, layout: str) -> list[dict[str, tuple[float, float, float] | str]]:
    """Read static Assetto layout entries, preserving their authored transform."""
    ini = track_root / layout
    parser = configparser.ConfigParser(interpolation=None)
    parser.read(ini, encoding="utf-8-sig")
    entries: list[dict[str, tuple[float, float, float] | str]] = []

    def vector(section: str, key: str) -> tuple[float, float, float]:
        raw = parser.get(section, key, fallback="0,0,0")
        try:
            values = tuple(float(value.strip()) for value in raw.split(","))
            if len(values) == 3 and all(math.isfinite(value) for value in values):
                return values
        except ValueError:
            pass
        raise RuntimeError(f"Invalid {key} in {ini} [{section}]: {raw!r}")

    for section in parser.sections():
        if not section.upper().startswith("MODEL_"):
            continue
        name = parser.get(section, "FILE", fallback="").strip()
        if name.lower().endswith(".kn5") and (track_root / name).is_file():
            entries.append({"file": name, "position": vector(section, "POSITION"), "rotation": vector(section, "ROTATION")})
    if not entries:
        raise RuntimeError(f"No static KN5 entries found in {ini}")
    return entries


def static_models(track_root: Path, layout: str) -> list[str]:
    """Compatibility helper for callers that only need source file names."""
    return [str(entry["file"]) for entry in static_model_entries(track_root, layout)]


def read_kn5(reader: Any, path: Path) -> tuple[list[str], list[Any]]:
    materials: list[str] = []
    with path.open("rb") as stream:
        header = stream.read(10)
        if len(header) != 10:
            raise RuntimeError(f"KN5 header is truncated: {path}")
        _magic, version = struct.unpack("<6sI", header)
        if version > 5:
            stream.read(4)
        texture_count = reader._read_i32(stream)
        for _ in range(texture_count):
            stream.read(4)
            reader._read_string(stream, reader._read_i32(stream))
            size = reader._read_i32(stream)
            stream.seek(max(0, size), 1)
        material_count = reader._read_i32(stream)
        for _ in range(material_count):
            name = reader._read_string(stream, reader._read_i32(stream))
            reader._read_string(stream, reader._read_i32(stream))
            stream.read(2)
            if version > 4:
                stream.read(4)
            for _ in range(reader._read_i32(stream)):
                reader._read_string(stream, reader._read_i32(stream))
                stream.read(4 + 36)
            for _ in range(reader._read_i32(stream)):
                reader._read_string(stream, reader._read_i32(stream))
                stream.read(4)
                reader._read_string(stream, reader._read_i32(stream))
            materials.append(name or "track")
        nodes = reader._read_nodes(stream, [], -1)
    return materials, nodes


def palette(name: str) -> list[int]:
    key = name.lower()
    if any(token in key for token in ("grass", "tree", "bush", "leaf", "forest", "terrain", "ground")):
        return [64, 105, 55]
    if any(token in key for token in ("asph", "road", "tarmac", "pit", "rubber")):
        return [57, 61, 62]
    if any(token in key for token in ("kerb", "curb", "paint", "line")):
        return [190, 184, 166]
    if any(token in key for token in ("wall", "concrete", "building", "grand", "stand")):
        return [132, 126, 111]
    if any(token in key for token in ("fence", "rail", "barrier", "metal")):
        return [106, 112, 110]
    if any(token in key for token in ("sand", "dirt", "gravel")):
        return [142, 119, 76]
    return [104, 108, 96]


def quantize(value: float, minimum: float, span: float) -> int:
    return max(0, min(65535, round((value - minimum) / span * 65535.0)))


def compile_model(reader: Any, source: Path, output: Path, *, origin: tuple[float, float, float], placement: tuple[float, float, float], bounds_min: tuple[float, float, float], bounds_span: tuple[float, float, float], cell: float, texture_pack: TexturePack | None = None, model_position: tuple[float, float, float] = (0.0, 0.0, 0.0), model_rotation: tuple[float, float, float] = (0.0, 0.0, 0.0), position_format: str = "quantized16") -> dict[str, Any]:
    materials, nodes, embedded_textures = read_kn5_textured(reader, source)
    # Use packed typed arrays for the output side of the conversion.  A full
    # Nordschleife sector has millions of triangle references; Python integer
    # lists alone can otherwise exhaust memory before gzip ever runs.
    absolute_positions = position_format == "float32"
    if position_format not in {"quantized16", "float32"}:
        raise ValueError(f"Unsupported position format: {position_format}")
    positions = array("f" if absolute_positions else "H")
    normals = array("b")
    tangents = array("b")
    uvs = array("f")
    position_lookup: dict[tuple[Any, ...], int] = {}
    index_groups: dict[tuple[int, str, bool, float, float, int, bool], array] = defaultdict(lambda: array("I"))
    group_bounds: dict[tuple[int, str, bool, float, float, int, bool], dict[str, list[float]]] = defaultdict(
        lambda: {"min": [math.inf, math.inf, math.inf], "max": [-math.inf, -math.inf, -math.inf]}
    )
    group_nodes: dict[tuple[int, str, bool, float, float, int, bool], set[str]] = defaultdict(set)
    grid = 0.0 if absolute_positions else max(0.05, float(cell))
    model_bounds_min = [math.inf, math.inf, math.inf]
    model_bounds_max = [-math.inf, -math.inf, -math.inf]
    # MODEL_n transforms in Assetto layout INIs are part of the authored scene.
    # Apply the standard XYZ Euler rotation in AC coordinates after each KN5
    # node's local transform, then translate by POSITION.
    rx, ry, rz = (math.radians(value) for value in model_rotation)
    sin_x, cos_x = math.sin(rx), math.cos(rx)
    sin_y, cos_y = math.sin(ry), math.cos(ry)
    sin_z, cos_z = math.sin(rz), math.cos(rz)

    def rotate_model(x: float, y: float, z: float) -> tuple[float, float, float]:
        y, z = y * cos_x - z * sin_x, y * sin_x + z * cos_x
        x, z = x * cos_y + z * sin_y, -x * sin_y + z * cos_y
        x, y = x * cos_z - y * sin_z, x * sin_z + y * cos_z
        return x, y, z

    def model_transform(x: float, y: float, z: float) -> tuple[float, float, float]:
        x, y, z = rotate_model(x, y, z)
        return x + model_position[0], y + model_position[1], z + model_position[2]

    def index_for(node: Any, vertex_index: int, material_key: Any) -> int:
        x = float(node.pos[vertex_index * 3 + 0])
        y = float(node.pos[vertex_index * 3 + 1])
        z = float(node.pos[vertex_index * 3 + 2])
        x, y, z = reader._apply_mat_pos(node.hmatrix, x, y, z)
        x, y, z = model_transform(x, y, z)
        # Assetto coordinates are X/up/Z.  Place the full visual scene onto
        # the same data-space transform used by the derived AI road ribbon.
        dx = x - origin[0] + placement[0]
        dy = z - origin[2] + placement[1]
        dz = y - origin[1] + placement[2]
        for axis, value in enumerate((dx, dy, dz)):
            model_bounds_min[axis] = min(model_bounds_min[axis], value)
            model_bounds_max[axis] = max(model_bounds_max[axis], value)
            group_bounds[material_key]["min"][axis] = min(group_bounds[material_key]["min"][axis], value)
            group_bounds[material_key]["max"][axis] = max(group_bounds[material_key]["max"][axis], value)
        # A circuit-wide 16-bit position range is about 8–11 cm per step.
        # That is acceptable for compact scenery, but not for the narrow white
        # paint, kerbs, and cambers in the parity sector. Float sectors keep
        # authored positions and deliberately bypass grid clustering.
        if grid:
            dx = round(dx / grid) * grid
            dy = round(dy / grid) * grid
            dz = round(dz / grid) * grid
        packed = (dx, dy, dz) if absolute_positions else (
            quantize(dx, bounds_min[0], bounds_span[0]),
            quantize(dy, bounds_min[1], bounds_span[1]),
            quantize(dz, bounds_min[2], bounds_span[2]),
        )
        nx = float(node.nrm[vertex_index * 3 + 0])
        ny = float(node.nrm[vertex_index * 3 + 1])
        nz = float(node.nrm[vertex_index * 3 + 2])
        nx, ny, nz = reader._apply_mat_nrm(node.hmatrix, nx, ny, nz)
        nx, ny, nz = rotate_model(nx, ny, nz)
        # Assetto normal axes follow its X/up/Z coordinate convention.
        packed_normal = (
            max(-127, min(127, round(nx * 127))),
            max(-127, min(127, round(nz * 127))),
            max(-127, min(127, round(ny * 127))),
        )
        source_tangent = getattr(node, "tangent", None)
        if source_tangent and len(source_tangent) >= vertex_index * 3 + 3:
            tx = float(source_tangent[vertex_index * 3 + 0])
            ty = float(source_tangent[vertex_index * 3 + 1])
            tz = float(source_tangent[vertex_index * 3 + 2])
        else:
            tx, ty, tz = 0.0, 0.0, 0.0
        tx, ty, tz = reader._apply_mat_nrm(node.hmatrix, tx, ty, tz)
        tx, ty, tz = rotate_model(tx, ty, tz)
        packed_tangent = (
            max(-127, min(127, round(tx * 127))),
            max(-127, min(127, round(tz * 127))),
            max(-127, min(127, round(ty * 127))),
        )
        u = float(node.uv0[vertex_index * 2 + 0])
        v = float(node.uv0[vertex_index * 2 + 1])
        # Attributes are part of the key.  The old position-only proxy merged
        # UV seams and hard edges, which made an actual textured import
        # impossible.  Material ownership is deliberately *not* in this key:
        # index groups can safely share an identical vertex, avoiding a large
        # memory multiplier at every multi-material boundary.
        position_key = tuple(round(value, 5) for value in packed) if absolute_positions else packed
        lookup_key = (*position_key, *packed_normal, *packed_tangent, round(u * 65536), round(v * 65536))
        existing = position_lookup.get(lookup_key)
        if existing is not None:
            return existing
        idx = len(positions) // 3
        position_lookup[lookup_key] = idx
        positions.extend(packed)
        normals.extend(packed_normal)
        tangents.extend(packed_tangent)
        uvs.extend((u, v))
        return idx

    triangles_in = 0
    triangles_out = 0
    triangles_excluded_by_node = 0
    for node in nodes:
        if getattr(node, "type", None) not in (2, 3) or not getattr(node, "indices", None):
            continue
        node_triangles = len(node.indices) // 3
        triangles_in += node_triangles
        # AC_CREW and AC_POBJECT can contain visible meshes, but the start,
        # pit, timing and hotlap nodes are gameplay locator volumes. Their KN5
        # visible/renderable bits describe editor availability, not scenery.
        if is_non_visual_node(str(getattr(node, "name", ""))):
            triangles_excluded_by_node += node_triangles
            continue
        if not bool(getattr(node, "active", True)) or not bool(getattr(node, "visible", True)) or not bool(getattr(node, "renderable", True)):
            triangles_excluded_by_node += node_triangles
            continue
        material_id = int(getattr(node, "material_id", -1))
        material_data = materials[material_id] if 0 <= material_id < len(materials) else {"name": "track", "samples": {}}
        material = str(material_data.get("name") or "track")
        # Keep same-named materials from different material slots separate:
        # their diffuse sample can legitimately differ.
        lod_in = max(0.0, float(getattr(node, "lod_in", 0.0) or 0.0))
        lod_out = max(0.0, float(getattr(node, "lod_out", 0.0) or 0.0))
        material_key = (
            material_id,
            material,
            bool(getattr(node, "transparent", False)),
            round(lod_in, 4),
            round(lod_out, 4),
            int(getattr(node, "layer", 0) or 0),
            bool(getattr(node, "cast_shadows", True)),
        )
        bucket = index_groups[material_key]
        group_nodes[material_key].add(str(getattr(node, "name", "")))
        indices = node.indices
        for offset in range(0, len(indices) - 2, 3):
            a = index_for(node, int(indices[offset]), material_key)
            b = index_for(node, int(indices[offset + 1]), material_key)
            c = index_for(node, int(indices[offset + 2]), material_key)
            if a == b or b == c or a == c:
                continue
            bucket.extend((a, b, c))
            triangles_out += 1

    flat_indices = array("I")
    groups: list[dict[str, Any]] = []
    sample_channels = {
        "diffuse": "txDiffuse",
        "normal": "txNormal",
        "maps": "txMaps",
        "detail": "txDetail",
        "mask": "txMask",
        "detailNormal": "txDetailNM",
        "normalDetail": "txNormalDetail",
        "variation": "txVariation",
        "detailR": "txDetailR",
        "detailG": "txDetailG",
        "detailB": "txDetailB",
        "detailA": "txDetailA",
    }
    for material_key, values in sorted(index_groups.items(), key=lambda item: str(item[0]).lower()):
        if not values:
            continue
        material_id_raw, material, node_transparent, lod_in, lod_out, layer, cast_shadows = material_key
        material_data = materials[material_id_raw] if 0 <= material_id_raw < len(materials) else {"samples": {}}
        if material.strip().lower() in NON_VISUAL_MATERIALS:
            continue
        samples = material_data.get("samples", {})
        textures: dict[str, str] = {}
        if texture_pack:
            for channel, sample_name in sample_channels.items():
                source_name = str(samples.get(sample_name, "")).replace("\\", "/")
                texture = texture_pack.add(source_name, embedded_textures.get(source_name.lower(), b"")) if source_name else None
                if texture:
                    textures[channel] = texture
        shader = str(material_data.get("shader", ""))
        shader_key = shader.lower()
        # Assetto's alpha-test shaders should be depth-writing cutouts, whereas
        # its alpha materials need a separate blended pass in WebGL.
        alpha_mode = "cutout" if any(token in shader_key for token in ("at", "tree", "grass", "flags")) else ("blend" if node_transparent or "alpha" in shader_key else "opaque")
        props = {
            str(key).lower(): float(value)
            for key, value in dict(material_data.get("props", {})).items()
            if isinstance(value, (int, float)) and math.isfinite(float(value))
        }
        group = {
            "material": material,
            "shader": shader,
            "offset": len(flat_indices),
            "count": len(values),
            "color": palette(material),
            "alphaMode": alpha_mode,
            "properties": props,
            "propertyVectors": {
                str(key).lower(): [float(component) for component in value]
                for key, value in dict(material_data.get("propertyVectors", {})).items()
                if isinstance(value, (list, tuple)) and len(value) == 10
                and all(isinstance(component, (int, float)) and math.isfinite(float(component)) for component in value)
            },
            "nodeTransparent": node_transparent,
            "castShadows": cast_shadows,
            "layer": layer,
            "lodIn": lod_in,
            "lodOut": lod_out,
            "sourceNodes": sorted(name for name in group_nodes[material_key] if name),
            "bounds": {
                "min": [float(value) for value in group_bounds[material_key]["min"]],
                "max": [float(value) for value in group_bounds[material_key]["max"]],
            },
        }
        if textures:
            # "texture" is retained for readers of the first textured export;
            # "textures" carries all Assetto material channels.
            group["textures"] = textures
            if textures.get("diffuse"):
                group["texture"] = textures["diffuse"]
        groups.append(group)
        flat_indices.extend(values)

    payload = bytearray(HEADER.pack(b"TNM1", 4, len(positions) // 3, len(flat_indices), len(groups), *bounds_min, *bounds_span))
    payload.extend(positions.tobytes())
    payload.extend(normals.tobytes())
    payload.extend(tangents.tobytes())
    payload.extend(uvs.tobytes())
    payload.extend(flat_indices.tobytes())
    output.parent.mkdir(parents=True, exist_ok=True)
    gzip_path = output.with_suffix(output.suffix + ".gz")
    with gzip.open(gzip_path, "wb", compresslevel=9) as stream:
        stream.write(payload)
    return {
        "file": gzip_path.name,
        "source": source.name,
        "vertices": len(positions) // 3,
        "trianglesInput": triangles_in,
        "trianglesOutput": len(flat_indices) // 3,
        "trianglesGeometry": triangles_out,
        "trianglesExcludedByNodeFlags": triangles_excluded_by_node,
        "groups": groups,
        "bytes": gzip_path.stat().st_size,
        "binaryVersion": 4,
        "binaryIndexCount": len(flat_indices),
        "binaryGroupCount": len(groups),
        "compressedBytes": gzip_path.stat().st_size,
        "decodedBytes": len(payload),
        "bounds": {
            "min": [float(value) for value in model_bounds_min],
            "max": [float(value) for value in model_bounds_max],
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--track-root", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--layout", default="models_nordschleife.ini", help="Assetto layout INI to export (for example models_endurance.ini)")
    parser.add_argument("--kn5-parser", type=Path, default=Path(r"K:\WebGL_Tools\tools\assetto_corsa_kn5_to_obj.py"))
    parser.add_argument("--origin", default="-516.2700195,139.6994476,2351.2604980", help="AC X,up,Z at the road start")
    parser.add_argument("--placement", default="7000,-850,32", help="Demo X,Y,Z at the road start")
    parser.add_argument("--bounds-min", default="4300,-5900,-400")
    parser.add_argument("--bounds-span", default="7300,5600,1200")
    parser.add_argument("--cell", type=float, default=1.0, help="Visual clustering cell in metres")
    parser.add_argument("--position-format", choices=("quantized16", "float32"), default="quantized16", help="float32 preserves narrow painted geometry for parity sectors")
    parser.add_argument("--texture-quality", type=int, default=82, help="WebP quality for embedded material maps")
    parser.add_argument("--texture-max-size", type=int, default=2048, help="Maximum material-map edge in pixels (0 keeps source dimensions)")
    parser.add_argument("--only-sector", action="append", default=[], help="Compile only this KN5 from the selected layout (repeatable)")
    args = parser.parse_args()

    def vector(raw: str) -> tuple[float, float, float]:
        values = tuple(float(part.strip()) for part in raw.split(","))
        if len(values) != 3:
            raise ValueError("expected three comma-separated values")
        return values

    track_root = args.track_root.resolve()
    reader = load_parser(args.kn5_parser.resolve())
    origin, placement = vector(args.origin), vector(args.placement)
    bounds_min, bounds_span = vector(args.bounds_min), vector(args.bounds_span)
    if min(bounds_span) <= 0 or (args.position_format == "quantized16" and args.cell <= 0):
        parser.error("bounds span and quantized cell must be positive")
    texture_pack = TexturePack(args.out_dir, quality=args.texture_quality, max_size=args.texture_max_size)
    models: list[dict[str, Any]] = []
    layout = Path(args.layout).name
    if not layout.lower().startswith("models_") or not layout.lower().endswith(".ini"):
        parser.error("--layout must name a models_*.ini file")
    entries = static_model_entries(track_root, layout)
    requested_sectors = {Path(value).name.lower() for value in args.only_sector if str(value).strip()}
    if requested_sectors:
        entries = [entry for entry in entries if str(entry["file"]).lower() in requested_sectors]
        found = {str(entry["file"]).lower() for entry in entries}
        missing = sorted(requested_sectors - found)
        if missing:
            parser.error(f"requested sector(s) are not in {layout}: {', '.join(missing)}")
    for entry in entries:
        name = str(entry["file"])
        print(f"Compiling {name}", flush=True)
        model = compile_model(
            reader, track_root / name, args.out_dir / f"{Path(name).stem}.tnm",
            origin=origin, placement=placement, bounds_min=bounds_min,
            bounds_span=bounds_span, cell=args.cell, texture_pack=texture_pack,
            model_position=entry["position"], model_rotation=entry["rotation"], position_format=args.position_format,
        )
        # Empty dynamic/helper KN5s occur in the layout manifest.  Do not put
        # them in the streamed scene manifest: one empty sector must not make
        # the client discard the already-loaded static circuit sectors.
        if model["vertices"] >= 3 and model["trianglesOutput"] >= 1 and model["groups"]:
            models.append(model)
    # Put the principal circuit sector first.  The game loads scene sectors in
    # manifest order, and the small layout support meshes preceding this file
    # do not make the track legible at the spawn.  Prioritising it lets a
    # player who uses /track see the actual Nordschleife immediately while the
    # remaining grandstands, trees, and layout-specific details stream in.
    models.sort(key=lambda model: (0 if model["source"].lower() == "ks_nordschleife.kn5" else 1))

    manifest = {
        "schema": "webglgta-track-scene-v1",
        "id": "nordschleife-full-scene",
        "coordinateSystem": "demo-data-x-y-z-up",
        "compression": {"positions": "float32 authored" if args.position_format == "float32" else "uint16 affine quantized", "indices": "uint32", "transport": "gzip", "clusterCellM": 0 if args.position_format == "float32" else args.cell},
        "bounds": {"minX": bounds_min[0], "minY": bounds_min[1], "minZ": bounds_min[2], "maxX": bounds_min[0] + bounds_span[0], "maxY": bounds_min[1] + bounds_span[1], "maxZ": bounds_min[2] + bounds_span[2]},
        "models": models,
        "source": {"layout": layout, "modelCount": len(models), "attributes": ["position", "normal", "uv0"], "textures": "webp", "materialChannels": "Assetto samples"},
    }
    manifest_path = args.out_dir / "scene.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"manifest": str(manifest_path), "models": len(models), "bytes": sum(model["bytes"] for model in models), "triangles": sum(model["trianglesOutput"] for model in models)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""
Building System for GTA5
-----------------------
Handles building and structure data extraction and visualization.
"""

import logging
import numpy as np
from pathlib import Path
from typing import Dict, Optional, Any
from dataclasses import dataclass
import json
import math
from concurrent.futures import ThreadPoolExecutor
import shutil

from .dll_manager import DllManager
from .rpf_reader import RpfReader
from .ymap_handler import YmapHandler
from .terrain_system import TerrainSystem
from .hash import jenkins_hash

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@dataclass
class BuildingData:
    """Building data extracted from YMAP"""
    name: str
    model_name: str
    position: np.ndarray  # (x, y, z)
    rotation: np.ndarray  # (rx, ry, rz)
    scale: np.ndarray     # (sx, sy, sz)
    flags: int
    lod_dist: float
    archetype: Optional[str] = None
    room_key: Optional[int] = None
    entity_set: Optional[str] = None
    id: str = ""
    terrain_normal: Optional[np.ndarray] = None
    water_intersection: bool = False
    is_loaded: bool = False
    last_accessed: float = 0.0
    memory_size: int = 0

    def calculate_memory_size(self) -> int:
        """Calculate memory size of building data"""
        # TODO: Implement actual memory calculation
        return 0
        
    def unload(self) -> None:
        """Unload building data to free memory"""
        self.is_loaded = False
        self.memory_size = 0

@dataclass
class WaterData:
    """Water data extracted from watermap"""
    vertices: np.ndarray  # (N, 3) float32 array of positions
    indices: np.ndarray   # (M,) uint32 array of triangle indices
    bounds: Dict[str, float]  # min_x, min_y, min_z, max_x, max_y, max_z

class BuildingSystem:
    """Handles building and structure data extraction"""
    
    DEFAULT_WATERMAP_PATHS = [
        "common.rpf\\data\\levels\\gta5\\waterheight.dat"
    ]

    # "Client-like" streaming: write entities into spatial chunks for incremental loading.
    ENTITY_CHUNK_SIZE = 512.0  # world units (meters)
    MAX_OPEN_CHUNK_FILES = 64
    # If enabled, we only snap entities/buildings to the heightmap when their Z is already close to ground.
    # This prevents the coarse heightmap from "messing up" placement for bridges, roofs, interiors, etc.
    SNAP_TO_TERRAIN_MAX_DELTA_Z = 25.0
    
    def __init__(self, game_path: str, dll_manager: DllManager, terrain_system: TerrainSystem, output_dir: Optional[Path] = None):
        """
        Initialize building system
        
        Args:
            game_path: Path to GTA5 installation directory
            dll_manager: DllManager instance to use for CodeWalker resources
            terrain_system: TerrainSystem instance for terrain integration
        """
        self.game_path = Path(game_path)
        
        # Store DLL manager
        self.dll_manager = dll_manager
        if not self.dll_manager.initialized:
            raise RuntimeError("DLL manager not initialized")
        
        # Get shared instances
        self.rpf_manager = self.dll_manager.get_rpf_manager()
        self.game_cache = self.dll_manager.get_game_cache()
        
        # Initialize RPF reader for file operations
        self.rpf_reader = RpfReader(str(game_path), dll_manager)
        
        # Initialize YMAP handler
        self.ymap_handler = YmapHandler(self.rpf_manager)
        
        # Initialize building components
        self.buildings: Dict[str, BuildingData] = {}
        # Keep only "building-like" entities here so `buildings.obj` doesn't explode in size.
        # Full entity point cloud is exported separately to `entities.obj`.
        self.water: Optional[WaterData] = None
        self.output_dir: Optional[Path] = output_dir
        self.num_entities: int = 0
        self.entity_types: Dict[str, int] = {}
        
        # Building info
        self.building_info = {
            'num_buildings': 0,
            'num_structures': 0,
            'building_types': {},
            'water_info': {}
        }
        
        # Initialize terrain system
        self.terrain_system = terrain_system
        
        # Initialize thread pool
        self.executor = ThreadPoolExecutor(max_workers=4)

        # Parity/provenance (populated during extraction; sampled to keep size reasonable)
        self.parity_ymap_samples: list[dict] = []

    class _EntityChunkWriter:
        def __init__(self, chunks_dir: Path, chunk_size: float, max_open: int):
            self.chunks_dir = chunks_dir
            self.chunk_size = float(chunk_size)
            self.max_open = int(max_open)
            self.handles: Dict[str, Any] = {}
            self.lru: list[str] = []

            self.bounds = {
                "min_x": float("inf"),
                "min_y": float("inf"),
                "min_z": float("inf"),
                "max_x": float("-inf"),
                "max_y": float("-inf"),
                "max_z": float("-inf"),
            }
            self.chunk_counts: Dict[str, int] = {}

        def _touch(self, key: str) -> None:
            try:
                self.lru.remove(key)
            except ValueError:
                pass
            self.lru.append(key)

        def _evict_if_needed(self) -> None:
            while len(self.handles) > self.max_open and self.lru:
                old = self.lru.pop(0)
                h = self.handles.pop(old, None)
                try:
                    if h:
                        h.close()
                except Exception:
                    pass

        def _get_handle(self, key: str):
            h = self.handles.get(key)
            if h:
                self._touch(key)
                return h
            self.chunks_dir.mkdir(parents=True, exist_ok=True)
            path = self.chunks_dir / f"{key}.jsonl"
            # NOTE: we always open in append mode; callers should clear the chunks dir before a fresh extraction.
            h = open(path, "a", encoding="utf-8")
            self.handles[key] = h
            self._touch(key)
            self._evict_if_needed()
            return h

        def write(self, ent: Dict[str, Any]) -> None:
            pos = ent.get("position")
            if not pos or len(pos) < 3:
                return
            x, y, z = float(pos[0]), float(pos[1]), float(pos[2])

            # update bounds
            b = self.bounds
            b["min_x"] = min(b["min_x"], x)
            b["min_y"] = min(b["min_y"], y)
            b["min_z"] = min(b["min_z"], z)
            b["max_x"] = max(b["max_x"], x)
            b["max_y"] = max(b["max_y"], y)
            b["max_z"] = max(b["max_z"], z)

            cx = int(math.floor(x / self.chunk_size))
            cy = int(math.floor(y / self.chunk_size))
            key = f"{cx}_{cy}"
            self.chunk_counts[key] = self.chunk_counts.get(key, 0) + 1

            h = self._get_handle(key)
            h.write(json.dumps(ent) + "\n")

        def close(self) -> None:
            for h in list(self.handles.values()):
                try:
                    h.close()
                except Exception:
                    pass
            self.handles.clear()
            self.lru.clear()

    def _is_building_archetype(self, archetype: str) -> bool:
        """
        Best-effort heuristic to decide if an archetype should be treated as a "building".
        This keeps `buildings.obj` useful without trying to export millions of props.
        """
        if not archetype:
            return False
        a = archetype.lower()

        # Common excludes (small props / foliage / infrastructure clutter)
        excludes = [
            "tree", "bush", "grass", "plant",
            "rock", "stone",
            "fence", "rail", "barrier",
            "lamp", "light", "traffic", "sign", "pole",
            "bin", "trash", "barrel", "crate", "pallet",
            "cone", "bollard", "hydrant",
            "road", "curb", "kerb", "sidewalk", "sidewalk",
            "decal", "patch", "grime",
        ]
        if any(x in a for x in excludes):
            return False

        # Common includes (structures)
        includes = [
            "building", "bldg", "skyscraper", "tower",
            "apartment", "apt", "house", "home", "mansion",
            "hotel", "motel",
            "shop", "store", "market",
            "office", "warehouse", "factory", "hangar",
            "garage", "barn", "shed", "shack",
        ]
        if any(x in a for x in includes):
            return True

        # Prefix patterns that often indicate architecture in GTA naming
        if a.startswith(("v_", "hei_", "dt1_", "dt1_", "cs_", "ss1_", "ss2_", "po1_", "po2_")) and ("_int" not in a):
            # still might be props, but this catches a lot of real buildings; keep it conservative
            return ("bld" in a) or ("build" in a) or ("house" in a) or ("apt" in a) or ("tower" in a) or ("hotel" in a)

        return False
        
    def _quaternion_from_float_array(self, arr: np.ndarray) -> np.ndarray:
        """Convert float array to quaternion"""
        return arr

    def _quaternion_as_rotation_matrix(self, q: np.ndarray) -> np.ndarray:
        """Convert quaternion to rotation matrix using CodeWalker's optimized implementation"""
        w, x, y, z = q
        xx = x * x
        yy = y * y
        zz = z * z
        xy = x * y
        zw = z * w
        zx = z * x
        yw = y * w
        yz = y * z
        xw = x * w
        
        return np.array([
            [1.0 - 2.0 * (yy + zz), 2.0 * (xy + zw), 2.0 * (zx - yw), 0.0],
            [2.0 * (xy - zw), 1.0 - 2.0 * (zz + xx), 2.0 * (yz + xw), 0.0],
            [2.0 * (zx + yw), 2.0 * (yz - xw), 1.0 - 2.0 * (yy + xx), 0.0],
            [0.0, 0.0, 0.0, 1.0]
        ])

    def _quaternion_from_rotation_vector(self, rotation_vector: np.ndarray) -> np.ndarray:
        """Convert rotation vector to quaternion using CodeWalker's optimized implementation"""
        angle = np.linalg.norm(rotation_vector)
        if angle == 0:
            return np.array([1.0, 0.0, 0.0, 0.0])
        
        axis = rotation_vector / angle
        half_angle = angle / 2
        sin_half = math.sin(half_angle)
        cos_half = math.cos(half_angle)
        
        return np.array([
            cos_half,
            axis[0] * sin_half,
            axis[1] * sin_half,
            axis[2] * sin_half
        ])

    def _quaternion_multiply(self, q1: np.ndarray, q2: np.ndarray) -> np.ndarray:
        """Multiply two quaternions using CodeWalker's optimized implementation"""
        w1, x1, y1, z1 = q1
        w2, x2, y2, z2 = q2
        
        return np.array([
            w1*w2 - x1*x2 - y1*y2 - z1*z2,
            w1*x2 + x1*w2 + y1*z2 - z1*y2,
            w1*y2 - x1*z2 + y1*w2 + z1*x2,
            w1*z2 + x1*y2 - y1*x2 + z1*w2
        ])

    def _quaternion_multiply_vector(self, q: np.ndarray, v: np.ndarray) -> np.ndarray:
        """Multiply quaternion with vector using CodeWalker's optimized implementation"""
        w, x, y, z = q
        vx, vy, vz = v
        
        # Optimized vector-quaternion multiplication
        axx = x * 2.0
        ayy = y * 2.0
        azz = z * 2.0
        awxx = w * axx
        awyy = w * ayy
        awzz = w * azz
        axxx = x * axx
        axyy = x * ayy
        axzz = x * azz
        ayyy = y * ayy
        ayzz = y * azz
        azzz = z * azz
        
        return np.array([
            ((vx * ((1.0 - ayyy) - azzz)) + (vy * (axyy - awzz))) + (vz * (axzz + awyy)),
            ((vx * (axyy + awzz)) + (vy * ((1.0 - axxx) - azzz))) + (vz * (ayzz - awxx)),
            ((vx * (axzz - awyy)) + (vy * (ayzz + awxx))) + (vz * ((1.0 - axxx) - ayyy))
        ])

    def _quaternion_to_euler(self, q: np.ndarray) -> np.ndarray:
        """Convert quaternion to Euler angles using CodeWalker's implementation"""
        w, x, y, z = q
        xx = x * x
        yy = y * y
        zz = z * z
        ww = w * w
        ls = xx + yy + zz + ww
        st = x * w - y * z
        sv = ls * 0.499
        
        if st > sv:
            return np.array([90.0, math.degrees(math.atan2(y, x) * 2.0), 0.0])
        elif st < -sv:
            return np.array([-90.0, math.degrees(math.atan2(y, x) * -2.0), 0.0])
        else:
            return np.array([
                math.degrees(math.asin(2.0 * st)),
                math.degrees(math.atan2(2.0 * (y * w + x * z), 1.0 - 2.0 * (xx + yy))),
                math.degrees(math.atan2(2.0 * (x * y + z * w), 1.0 - 2.0 * (xx + zz)))
            ])

    def _euler_to_quaternion(self, euler: np.ndarray) -> np.ndarray:
        """Convert Euler angles to quaternion using CodeWalker's implementation"""
        x, y, z = np.radians(euler)
        return self._quaternion_from_rotation_vector(np.array([x, y, z]))

    def align_to_normal(self, rotation: np.ndarray, normal: np.ndarray) -> np.ndarray:
        """Align building rotation to terrain normal using optimized quaternion operations"""
        # Convert quaternion to rotation matrix
        q = self._quaternion_from_float_array(rotation)
        R = self._quaternion_as_rotation_matrix(q)
        
        # Get up vector from rotation matrix
        up = R[:, 2]
        
        # Calculate rotation to align with normal
        rotation_axis = np.cross(up, normal)
        rotation_axis = rotation_axis / np.linalg.norm(rotation_axis)
        
        # Calculate rotation angle
        cos_angle = np.dot(up, normal)
        angle = math.acos(np.clip(cos_angle, -1.0, 1.0))
        
        # Create rotation quaternion
        q_align = self._quaternion_from_rotation_vector(rotation_axis * angle)
        
        # Combine rotations using optimized multiplication
        q_new = self._quaternion_multiply(q_align, q)
        
        return q_new

    def extract_buildings(self) -> bool:
        """
        Extract all building and structure data
        
        Returns:
            bool: True if successful
        """
        try:
            entities_obj = None
            obj_vidx = 1
            chunk_writer = None
            interiors_dir: Optional[Path] = None
            exported_mlo_archetypes: set[int] = set()
            gfc = None  # CodeWalker.GameFiles.GameFileCache (pythonnet)
            gfc_ready = False

            if self.output_dir:
                self.output_dir.mkdir(parents=True, exist_ok=True)
                entities_obj = open(self.output_dir / "entities.obj", "w", encoding="utf-8")
                entities_obj.write("# Entities (point cloud)\n")
                # Chunked entity output for streaming in the WebGL viewer.
                # IMPORTANT: clear previous chunk outputs to avoid appending duplicates across runs.
                try:
                    chunks_dir = (self.output_dir / "entities_chunks")
                    if chunks_dir.exists():
                        shutil.rmtree(chunks_dir)
                except Exception:
                    pass
                chunk_writer = self._EntityChunkWriter(
                    chunks_dir=(self.output_dir / "entities_chunks"),
                    chunk_size=self.ENTITY_CHUNK_SIZE,
                    max_open=self.MAX_OPEN_CHUNK_FILES,
                )
                try:
                    interiors_dir = (self.output_dir / "interiors")
                    interiors_dir.mkdir(parents=True, exist_ok=True)
                except Exception:
                    interiors_dir = None

            # IMPORTANT for parity:
            # - Initialize GameFileCache up front so we can use its DLC-aware dictionaries
            #   instead of walking raw RPF entries (which is scan-order dependent and can pick
            #   the wrong override when duplicates exist).
            try:
                ok = self.dll_manager.init_game_file_cache()
                gfc = self.dll_manager.get_game_file_cache() if ok else None
                gfc_ready = bool(gfc is not None and getattr(gfc, "IsInited", False))
            except Exception:
                gfc = None
                gfc_ready = False

            # Prefer GameFileCache's resolved YMAP dictionary (already accounts for DLC overlays/patching).
            # Fall back to raw RpfManager enumeration only if cache init failed.
            ymap_entries = []
            if gfc_ready:
                # CRITICAL: prefer YmapDict (built from ActiveMapRpfFiles) to avoid “overlap”.
                # AllYmapsDict is built from *AllRpfs* and can include obsolete ymaps that should not be active.
                try:
                    d = getattr(gfc, "YmapDict", None) or getattr(gfc, "AllYmapsDict", None)
                    if d is not None:
                        for kv in d:
                            try:
                                entry = getattr(kv, "Value", None) or kv.Value
                            except Exception:
                                entry = None
                            if entry is not None:
                                ymap_entries.append(entry)
                except Exception:
                    ymap_entries = []

            if not ymap_entries:
                # Fallback (scan-order dependent; keep only as a safety net)
                ymap_seen = set()
                try:
                    for rpf in self.rpf_manager.AllRpfs:
                        if (not hasattr(rpf, 'AllEntries')) or (rpf.AllEntries is None):
                            continue
                        for entry in rpf.AllEntries:
                            try:
                                if not entry or not entry.Name:
                                    continue
                                if not str(entry.Name).lower().endswith('.ymap'):
                                    continue
                                p = str(entry.Path or '').lower()
                                if not p or p in ymap_seen:
                                    continue
                                ymap_seen.add(p)
                                ymap_entries.append(entry)
                            except Exception:
                                continue
                except Exception:
                    ymap_entries = []

            logger.info(f"Found {len(ymap_entries)} YMAP entries")

            # Keep a small sample for parity reporting (don’t store every YMAP).
            parity_samples_cap = 250

            for entry in ymap_entries:
                ymap_path = str(getattr(entry, "Path", "") or "")
                if not ymap_path:
                    continue
                logger.info(f"Processing YMAP: {ymap_path}")
                try:
                    # Load YMAP file using the resolved entry when possible (best parity).
                    ymap = self.dll_manager.get_ymap_file(entry if entry is not None else ymap_path)
                    if not ymap:
                        logger.warning(f"Failed to load YMAP: {ymap_path}")
                        continue

                    # Parity sample: record a hash + a few archetype hashes from the in-memory parse.
                    if len(self.parity_ymap_samples) < parity_samples_cap:
                        try:
                            rpfman = self.dll_manager.get_rpf_manager()
                            data = rpfman.GetFileData(ymap_path)
                            b = bytes(data) if data else b""
                            from .provenance_tools import entry_source_info, sha1_hex  # local import to avoid cycles
                            sample = {
                                "type": "ymap",
                                "ymap_path": ymap_path,
                                "source": entry_source_info(entry),
                                "source_size": int(len(b)),
                                "source_sha1": sha1_hex(b),
                                "entity_count": int(len(getattr(ymap, "AllEntities", []) or [])),
                                "archetype_hash_sample": [],
                            }
                            # Collect up to N archetype hashes from entities.
                            n = 0
                            for ent in (getattr(ymap, "AllEntities", None) or []):
                                if ent is None:
                                    continue
                                ced = getattr(ent, "_CEntityDef", None)
                                ah = getattr(ced, "archetypeName", None) if ced is not None else None
                                try:
                                    v = int(getattr(ah, "Hash", ah) if ah is not None else 0) & 0xFFFFFFFF
                                except Exception:
                                    v = 0
                                if v:
                                    sample["archetype_hash_sample"].append(int(v))
                                    n += 1
                                if n >= 64:
                                    break
                            self.parity_ymap_samples.append(sample)
                        except Exception:
                            # ignore sampling failures
                            pass
                        
                    # Process entities
                    if (not hasattr(ymap, 'AllEntities')) or (ymap.AllEntities is None):
                        continue
                        
                    for entity_index, entity in enumerate(ymap.AllEntities):
                        if entity is None:
                            continue
                        
                        try:
                            # CodeWalker does not always resolve a concrete Archetype object here.
                            # The reliable identity is the archetypeName hash stored on the underlying CEntityDef.
                            ced = getattr(entity, "_CEntityDef", None)
                            archetype_name = getattr(ced, "archetypeName", None) if ced is not None else None

                            def _as_u32(v) -> Optional[int]:
                                try:
                                    if v is None:
                                        return None
                                    # Common CodeWalker hash wrappers
                                    for attr in ("Hash", "hash", "Value", "value"):
                                        if hasattr(v, attr):
                                            v = getattr(v, attr)
                                    if isinstance(v, str):
                                        s = v.strip()
                                        if not s or not s.lstrip("-").isdigit():
                                            return None
                                        return int(s, 10) & 0xFFFFFFFF
                                    return int(v) & 0xFFFFFFFF
                                except Exception:
                                    return None

                            archetype_hash = _as_u32(archetype_name)
                            archetype_raw = str(archetype_name) if archetype_name is not None else "UNKNOWN"

                            # Position (world)
                            posv = getattr(entity, "Position", None)
                            if posv is None and ced is not None:
                                posv = getattr(ced, "position", None)
                            position = np.array([
                                float(getattr(posv, "X", 0.0)),
                                float(getattr(posv, "Y", 0.0)),
                                float(getattr(posv, "Z", 0.0)),
                            ], dtype=np.float32)

                            # Rotation: YmapEntityDef doesn't always expose Rotation directly; use CEntityDef.rotation (quaternion)
                            rotq = getattr(ced, "rotation", None) if ced is not None else None
                            rotation_quat = None
                            if rotq is not None:
                                rotation_quat = [
                                    float(getattr(rotq, "X", 0.0)),
                                    float(getattr(rotq, "Y", 0.0)),
                                    float(getattr(rotq, "Z", 0.0)),
                                    float(getattr(rotq, "W", 1.0)),
                                ]

                            # Scale
                            scv = getattr(entity, "Scale", None)
                            if scv is None and ced is not None:
                                # Some defs store scale as separate XY/Z fields
                                sxy = float(getattr(ced, "scaleXY", 1.0))
                                sz = float(getattr(ced, "scaleZ", 1.0))
                                scale = np.array([sxy, sxy, sz], dtype=np.float32)
                            else:
                                scale = np.array([
                                    float(getattr(scv, "X", 1.0)),
                                    float(getattr(scv, "Y", 1.0)),
                                    float(getattr(scv, "Z", 1.0)),
                                ], dtype=np.float32)

                            flags = int(getattr(entity, "Flags", getattr(ced, "flags", 0) if ced is not None else 0))
                            lod_dist = float(getattr(entity, "LodDist", getattr(ced, "lodDist", 0.0) if ced is not None else 0.0))
                            lod_level = getattr(ced, "lodLevel", None) if ced is not None else None
                            child_lod_dist = float(getattr(ced, "childLodDist", 0.0) if ced is not None else 0.0)
                            parent_index = int(getattr(ced, "parentIndex", -1) if ced is not None else -1)
                            num_children = int(getattr(ced, "numChildren", 0) if ced is not None else 0)

                            # MLO instance metadata (best-effort)
                            is_mlo_instance = bool(getattr(entity, "IsMlo", False))
                            guid_u32 = 0
                            try:
                                guid_u32 = int(getattr(ced, "guid", 0) if ced is not None else 0) & 0xFFFFFFFF
                            except Exception:
                                guid_u32 = 0

                            # Sample terrain at entity XY so the renderer can snap props/buildings to ground.
                            terrain_z, terrain_normal = self.terrain_system.sample_terrain_data(position)
                            dz = float(abs(float(position[2]) - float(terrain_z)))
                            used_ground = dz <= float(self.SNAP_TO_TERRAIN_MAX_DELTA_Z)

                            ent_data = {
                                "ymap": ymap_path,
                                # Stable per-ymap index (needed to reconstruct parent/child relationships from parent_index).
                                # Mirrors CodeWalker/YMAP semantics: parent_index points into ymap.AllEntities / CMapData.entities.
                                "ymap_entity_index": int(entity_index),
                                "name": getattr(entity, "Name", ""),
                                # Keep a stable numeric hash for downstream tooling/viewer exporters.
                                # (Older exports used "archetype" directly; prefer numeric when available.)
                                "archetype": str(archetype_hash) if archetype_hash is not None else archetype_raw,
                                "archetype_hash": str(archetype_hash) if archetype_hash is not None else None,
                                "archetype_raw": archetype_raw,
                                "position": [float(position[0]), float(position[1]), float(position[2])],
                                "rotation_quat": rotation_quat,
                                "scale": [float(scale[0]), float(scale[1]), float(scale[2])],
                                "flags": flags,
                                "lod_dist": lod_dist,
                                "child_lod_dist": float(child_lod_dist),
                                "parent_index": int(parent_index),
                                "num_children": int(num_children),
                                "lod_level": str(lod_level) if lod_level is not None else None,
                                "terrain_z": float(terrain_z),
                                "terrain_normal": terrain_normal.tolist() if terrain_normal is not None else None,
                                "terrain_snap_used": bool(used_ground),
                                "terrain_snap_delta_z": float(dz),
                                # Interior/MLO fields (safe defaults so viewer parsers don't explode)
                                "guid": str(int(guid_u32)),
                                "is_mlo_instance": bool(is_mlo_instance),
                                "mlo_parent_guid": "0",
                                "mlo_entity_set_name": None,
                                "mlo_entity_set_hash": "0",
                            }

                            self.num_entities += 1
                            ktype = str(archetype_hash) if archetype_hash is not None else archetype_raw
                            self.entity_types[ktype] = self.entity_types.get(ktype, 0) + 1

                            # Build a lightweight "building" list for buildings.obj / building_info.json
                            if self._is_building_archetype(archetype_raw):
                                bname = (getattr(entity, "Name", "") or "").strip()
                                if not bname:
                                    bname = f"{archetype_raw}_{self.num_entities}"

                                # Avoid runaway memory: keep only first N if something goes wrong with heuristics
                                if len(self.buildings) < 250_000:
                                    building = BuildingData(
                                        name=bname,
                                        model_name=archetype_raw,
                                        position=position.copy(),
                                        rotation=np.zeros(3, dtype=np.float32),
                                        scale=scale.copy(),
                                        flags=flags,
                                        lod_dist=lod_dist,
                                        archetype=archetype_raw,
                                    )
                                    # Snap Z only when close enough; otherwise keep original Z (bridges/interiors/etc).
                                    if used_ground:
                                        building.position[2] = float(terrain_z)
                                    building.terrain_normal = terrain_normal
                                    self.buildings[bname] = building
                                    self.building_info["building_types"][archetype_raw] = (
                                        self.building_info["building_types"].get(archetype_raw, 0) + 1
                                    )

                            if chunk_writer:
                                chunk_writer.write(ent_data)

                            if entities_obj:
                                # Point cloud vertex at original position (not snapped). Consumers can snap using terrain_z.
                                entities_obj.write(f"v {position[0]:.6f} {position[1]:.6f} {position[2]:.6f}\n")
                                entities_obj.write(f"p {obj_vidx}\n")
                                obj_vidx += 1

                            # ---- Interiors / MLO export (fail-open) ----
                            # If this entity is an MLO instance, export:
                            # - interiors/<mloArchetypeHash>.json: rooms/portals/entitySets for gating
                            # - additional streamed entities for interior children (tagged with mlo_parent_guid etc)
                            if is_mlo_instance and chunk_writer and (archetype_hash is not None) and (guid_u32 != 0):
                                try:
                                    # Initialize GameFileCache lazily: heavy operation, so only do it if we actually hit an MLO.
                                    if not gfc_ready:
                                        try:
                                            ok = self.dll_manager.init_game_file_cache()
                                            gfc = self.dll_manager.get_game_file_cache() if ok else None
                                        except Exception:
                                            gfc = None
                                        gfc_ready = bool(gfc is not None)

                                    if gfc is None:
                                        raise RuntimeError("GameFileCache unavailable; skipping interior export")

                                    # Resolve MLO archetype and materialize interior entities.
                                    try:
                                        mlo_arch = gfc.GetArchetype(int(archetype_hash) & 0xFFFFFFFF)
                                    except Exception:
                                        mlo_arch = None
                                    try:
                                        entity.SetArchetype(mlo_arch)
                                    except Exception:
                                        pass

                                    # Export MLO archetype definition once (rooms/portals/entity sets).
                                    if interiors_dir is not None and (int(archetype_hash) not in exported_mlo_archetypes):
                                        try:
                                            rooms_out = []
                                            portals_out = []
                                            sets_out = []

                                            rooms = getattr(mlo_arch, "rooms", None)
                                            if rooms is not None:
                                                for r in rooms:
                                                    if r is None:
                                                        continue
                                                    bbmin = getattr(r, "BBMin", None)
                                                    bbmax = getattr(r, "BBMax", None)
                                                    rdata = getattr(r, "_Data", None)
                                                    rooms_out.append({
                                                        "index": int(getattr(r, "Index", 0)),
                                                        "name": str(getattr(r, "RoomName", "")),
                                                        "bbMin": [float(getattr(bbmin, "X", 0.0)), float(getattr(bbmin, "Y", 0.0)), float(getattr(bbmin, "Z", 0.0))] if bbmin is not None else [0.0, 0.0, 0.0],
                                                        "bbMax": [float(getattr(bbmax, "X", 0.0)), float(getattr(bbmax, "Y", 0.0)), float(getattr(bbmax, "Z", 0.0))] if bbmax is not None else [0.0, 0.0, 0.0],
                                                        "flags": int(getattr(rdata, "flags", 0)) if rdata is not None else 0,
                                                        "floorId": int(getattr(rdata, "floorId", 0)) if rdata is not None else 0,
                                                    })

                                            portals = getattr(mlo_arch, "portals", None)
                                            if portals is not None:
                                                for p in portals:
                                                    if p is None:
                                                        continue
                                                    pdata = getattr(p, "_Data", None)
                                                    corners = []
                                                    cs = getattr(p, "Corners", None)
                                                    if cs is not None:
                                                        for c in cs:
                                                            if c is None:
                                                                continue
                                                            corners.append([float(getattr(c, "X", 0.0)), float(getattr(c, "Y", 0.0)), float(getattr(c, "Z", 0.0))])
                                                    portals_out.append({
                                                        "index": int(getattr(p, "Index", 0)),
                                                        "roomFrom": int(getattr(pdata, "roomFrom", 0)) if pdata is not None else 0,
                                                        "roomTo": int(getattr(pdata, "roomTo", 0)) if pdata is not None else 0,
                                                        "flags": int(getattr(pdata, "flags", 0)) if pdata is not None else 0,
                                                        "corners": corners,
                                                    })

                                            ent_sets = getattr(mlo_arch, "entitySets", None)
                                            if ent_sets is not None:
                                                for s in ent_sets:
                                                    if s is None:
                                                        continue
                                                    nm = str(getattr(s, "Name", "") or "")
                                                    sh = int(jenkins_hash(nm) & 0xFFFFFFFF)
                                                    ents0 = getattr(s, "Entities", None)
                                                    sets_out.append({
                                                        "index": int(getattr(s, "Index", 0)),
                                                        "name": nm,
                                                        "hash": str(sh),
                                                        "entitiesCount": int(len(ents0)) if ents0 is not None else 0,
                                                    })

                                            payload = {
                                                "schema": "webglgta-mlo-archetype-v1",
                                                "mlo_archetype_hash": str(int(archetype_hash) & 0xFFFFFFFF),
                                                "rooms": rooms_out,
                                                "portals": portals_out,
                                                "entity_sets": sets_out,
                                            }
                                            out_path = interiors_dir / f"{int(archetype_hash) & 0xFFFFFFFF}.json"
                                            out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
                                            exported_mlo_archetypes.add(int(archetype_hash))
                                        except Exception:
                                            # Def export failure shouldn't block streaming entities
                                            pass

                                    # Export interior child entities (base + entity sets).
                                    mlo_inst = getattr(entity, "MloInstance", None)
                                    if mlo_inst is None:
                                        continue

                                    def _emit_child(ch, *, set_name: Optional[str], set_hash_u32: int):
                                        nonlocal chunk_writer
                                        if ch is None or chunk_writer is None:
                                            return
                                        try:
                                            ced2 = getattr(ch, "_CEntityDef", None)
                                            arch2 = getattr(ced2, "archetypeName", None) if ced2 is not None else None
                                            arch2_u32 = _as_u32(arch2)
                                            pos2 = getattr(ch, "Position", None)
                                            ori2 = getattr(ch, "Orientation", None)  # world orientation
                                            sc2 = getattr(ch, "Scale", None)
                                            flags2 = int(getattr(ch, "Flags", getattr(ced2, "flags", 0) if ced2 is not None else 0))
                                            lod2 = float(getattr(ch, "LodDist", getattr(ced2, "lodDist", 0.0) if ced2 is not None else 0.0))
                                            child_lod2 = float(getattr(ced2, "childLodDist", 0.0) if ced2 is not None else 0.0)
                                            parent2 = int(getattr(ced2, "parentIndex", -1) if ced2 is not None else -1)
                                            numc2 = int(getattr(ced2, "numChildren", 0) if ced2 is not None else 0)
                                            lodlvl2 = getattr(ced2, "lodLevel", None) if ced2 is not None else None

                                            q2 = None
                                            if ori2 is not None:
                                                q2 = [
                                                    float(getattr(ori2, "X", 0.0)),
                                                    float(getattr(ori2, "Y", 0.0)),
                                                    float(getattr(ori2, "Z", 0.0)),
                                                    float(getattr(ori2, "W", 1.0)),
                                                ]

                                            ent2 = {
                                                "ymap": ymap_path,
                                                # Interior child entities don't have a stable index in the base ymap's AllEntities.
                                                # Keep the field for schema consistency; traversal should ignore -1.
                                                "ymap_entity_index": -1,
                                                "name": getattr(ch, "Name", ""),
                                                "archetype": str(arch2_u32) if arch2_u32 is not None else (str(arch2) if arch2 is not None else "UNKNOWN"),
                                                "archetype_hash": str(arch2_u32) if arch2_u32 is not None else None,
                                                "archetype_raw": str(arch2) if arch2 is not None else "UNKNOWN",
                                                "position": [float(getattr(pos2, "X", 0.0)), float(getattr(pos2, "Y", 0.0)), float(getattr(pos2, "Z", 0.0))] if pos2 is not None else [0.0, 0.0, 0.0],
                                                "rotation_quat": q2,
                                                "scale": [float(getattr(sc2, "X", 1.0)), float(getattr(sc2, "Y", 1.0)), float(getattr(sc2, "Z", 1.0))] if sc2 is not None else [1.0, 1.0, 1.0],
                                                "flags": flags2,
                                                "lod_dist": lod2,
                                                "child_lod_dist": float(child_lod2),
                                                "parent_index": int(parent2),
                                                "num_children": int(numc2),
                                                "lod_level": str(lodlvl2) if lodlvl2 is not None else None,
                                                "terrain_z": None,
                                                "terrain_normal": None,
                                                "terrain_snap_used": False,
                                                "terrain_snap_delta_z": None,
                                                "guid": "0",
                                                "is_mlo_instance": False,
                                                "mlo_parent_guid": str(int(guid_u32)),
                                                "mlo_entity_set_name": set_name,
                                                "mlo_entity_set_hash": str(int(set_hash_u32 & 0xFFFFFFFF)),
                                            }
                                            chunk_writer.write(ent2)
                                            self.num_entities += 1
                                        except Exception:
                                            return

                                    base_children = getattr(mlo_inst, "Entities", None)
                                    if base_children is not None:
                                        for ch in base_children:
                                            _emit_child(ch, set_name=None, set_hash_u32=0)

                                    inst_sets = getattr(mlo_inst, "EntitySets", None)
                                    if inst_sets is not None:
                                        for instset in inst_sets:
                                            if instset is None:
                                                continue
                                            set_obj = getattr(instset, "EntitySet", None)
                                            set_name = str(getattr(set_obj, "Name", "") or "")
                                            set_hash_u32 = int(jenkins_hash(set_name) & 0xFFFFFFFF) if set_name else 0
                                            ents2 = getattr(instset, "Entities", None)
                                            if ents2 is None:
                                                continue
                                            for ch in ents2:
                                                _emit_child(ch, set_name=set_name, set_hash_u32=set_hash_u32)

                                except Exception:
                                    # Never let interior export break the base world export.
                                    pass
                        except Exception as e:
                            logger.debug(f"Skipping entity export due to error: {e}")
                            continue
                                    
                except Exception as e:
                    logger.warning(f"Failed to process YMAP {ymap_path}: {e}")
                    continue
            
            # Load water data
            self._load_water_data()

            # Write streaming index for chunked entities
            if self.output_dir and chunk_writer:
                index = {
                    "version": 1,
                    "chunk_size": float(self.ENTITY_CHUNK_SIZE),
                    "chunks_dir": "entities_chunks",
                    "total_entities": int(self.num_entities),
                    "bounds": chunk_writer.bounds,
                    "chunks": {
                        k: {"count": int(v), "file": f"{k}.jsonl"}
                        for k, v in chunk_writer.chunk_counts.items()
                    },
                }
                with open(self.output_dir / "entities_index.json", "w", encoding="utf-8") as f:
                    json.dump(index, f, indent=2)
            
            # Update building info
            self.building_info['num_buildings'] = len(self.buildings)
            self.building_info['num_structures'] = sum(1 for b in self.buildings.values() 
                                                    if 'structure' in (b.archetype or '').lower())
            self.building_info['num_entities'] = int(self.num_entities)
            self.building_info['entity_types'] = self.entity_types
            
            # Log summary
            logger.info(f"Extracted {len(self.buildings)} buildings")
            logger.info(f"Building types: {self.building_info['building_types']}")
            
            return self.num_entities > 0
            
        except Exception as e:
            logger.error(f"Failed to extract buildings: {e}")
            logger.debug("Stack trace:", exc_info=True)
            return False
        finally:
            try:
                if entities_obj:
                    entities_obj.close()
                if chunk_writer:
                    chunk_writer.close()
            except Exception:
                pass
            
    def _process_building(self, entity: Any) -> Optional[BuildingData]:
        """
        Process a building entity from YMAP
        
        Args:
            entity: Entity object from CodeWalker YMAP
            
        Returns:
            BuildingData if successful, None otherwise
        """
        try:
            # Extract basic info
            name = getattr(entity, 'Name', '')
            model_name = getattr(entity, 'Archetype', '')
            
            # Extract position
            position = np.array([
                getattr(entity.Position, 'X', 0),
                getattr(entity.Position, 'Y', 0),
                getattr(entity.Position, 'Z', 0)
            ], dtype=np.float32)
            
            # Extract rotation
            rotation = np.array([
                getattr(entity.Rotation, 'X', 0),
                getattr(entity.Rotation, 'Y', 0),
                getattr(entity.Rotation, 'Z', 0)
            ], dtype=np.float32)
            
            # Extract scale
            scale = np.array([
                getattr(entity.Scale, 'X', 1),
                getattr(entity.Scale, 'Y', 1),
                getattr(entity.Scale, 'Z', 1)
            ], dtype=np.float32)
            
            # Extract flags and LOD distance
            flags = getattr(entity, 'Flags', 0)
            lod_dist = getattr(entity, 'LodDist', 100.0)
            
            # Extract additional info
            archetype = getattr(entity, 'Archetype', None)
            room_key = getattr(entity, 'RoomKey', None)
            entity_set = getattr(entity, 'EntitySet', None)
            
            # Create building object
            building = BuildingData(
                name=name,
                model_name=model_name,
                position=position,
                rotation=rotation,
                scale=scale,
                flags=flags,
                lod_dist=lod_dist,
                archetype=archetype,
                room_key=room_key,
                entity_set=entity_set
            )
            
            # Get terrain data at building position
            if self.terrain_system:
                # Sample terrain height and normal
                height, normal = self.terrain_system.sample_terrain_data(position)
                dz = float(abs(float(position[2]) - float(height)))
                if dz <= float(self.SNAP_TO_TERRAIN_MAX_DELTA_Z):
                    building.position[2] = float(height)
                building.terrain_normal = normal
                
                # Check for water intersection
                building.water_intersection = self.terrain_system.is_water(
                    position[0],
                    position[1]
                )
            
            return building
            
        except Exception as e:
            logger.error(f"Failed to process building entity: {e}")
            return None
            
    def _load_water_data(self):
        """Load water data from watermap files"""
        try:
            for path in self.DEFAULT_WATERMAP_PATHS:
                # Get watermap data through RPF reader
                data = self.rpf_reader.get_file_data(path)
                if not data:
                    logger.warning(f"Could not get watermap data: {path}")
                    continue
                    
                # Create watermap file object with DLL manager
                watermap_file = self.dll_manager.get_watermap_file(data)
                if not watermap_file:
                    logger.warning("Could not parse waterheight.dat (skipping water data).")
                    continue

                # Build a triangulated water surface mesh from the decompressed grid.
                water = self._watermap_to_waterdata(watermap_file)
                if water:
                    self.water = water
                    self.building_info['water_info'] = {
                        'loaded': True,
                        'source': path,
                        'num_vertices': int(water.vertices.shape[0]),
                        'num_triangles': int(water.indices.shape[0] // 3),
                        'bounds': water.bounds,
                    }
                    logger.info(
                        f"Extracted water mesh: {water.vertices.shape[0]} verts, {water.indices.shape[0]//3} tris"
                    )
                else:
                    self.building_info['water_info'] = {'loaded': True, 'source': path}
                    logger.info("Loaded waterheight.dat successfully (no mesh generated).")
                break  # Only process first watermap for now
                
        except Exception as e:
            logger.error(f"Failed to load water data: {e}")
            logger.debug("Stack trace:", exc_info=True)

    def _watermap_to_waterdata(self, wmf: Any) -> Optional[WaterData]:
        """
        Convert a CodeWalker `WatermapFile` into a simple triangulated surface mesh.

        Strategy:
        - Build a vertex for every grid cell.
        - Only emit faces for quads where all 4 corners have at least one water ref,
          to avoid spanning over non-water areas.
        """
        try:
            if not wmf:
                return None

            w = int(getattr(wmf, "Width", 0))
            h = int(getattr(wmf, "Height", 0))
            if w <= 1 or h <= 1:
                return None

            corner_x = float(getattr(wmf, "CornerX", 0.0))
            corner_y = float(getattr(wmf, "CornerY", 0.0))
            tile_x = float(getattr(wmf, "TileX", 0.0))
            tile_y = float(getattr(wmf, "TileY", 0.0))

            grid_refs = getattr(wmf, "GridWatermapRefs", None)
            if grid_refs is None:
                return None

            # Height + water-mask grids
            z = np.zeros((h, w), dtype=np.float32)
            has = np.zeros((h, w), dtype=np.bool_)

            def _ref_type_str(ref) -> str:
                t = getattr(ref, "Type", None)
                if t is None:
                    return ""
                return t.ToString() if hasattr(t, "ToString") else str(t)

            def _get_height_at(o: int) -> float:
                harr = grid_refs[o]
                if harr is None:
                    return 0.0
                # `harr` is an array; in pythonnet, len(...) should work
                if len(harr) == 0:
                    return 0.0
                h0 = harr[0]
                t = _ref_type_str(h0).lower()
                # River: use vector Z
                if "river" in t:
                    vec = getattr(h0, "Vector", None)
                    return float(getattr(vec, "Z", 0.0)) if vec is not None else 0.0
                # Lake/Pool: prefer item.Position.Z
                if ("lake" in t) or ("pool" in t):
                    item = getattr(h0, "Item", None)
                    if item is not None:
                        pos = getattr(item, "Position", None)
                        if pos is not None:
                            return float(getattr(pos, "Z", 0.0))
                vec = getattr(h0, "Vector", None)
                return float(getattr(vec, "Z", 0.0)) if vec is not None else 0.0

            # Fill grids
            for yi in range(h):
                row_off = yi * w
                for xi in range(w):
                    o = row_off + xi
                    harr = grid_refs[o]
                    if harr is not None and len(harr) > 0:
                        has[yi, xi] = True
                        z[yi, xi] = _get_height_at(o)

            # Build vertices (world XY from Corner + Tile; Y step is negative in CW).
            verts = np.zeros((w * h, 3), dtype=np.float32)
            for yi in range(h):
                wy = corner_y - tile_y * yi
                row_off = yi * w
                for xi in range(w):
                    wx = corner_x + tile_x * xi
                    verts[row_off + xi, 0] = wx
                    verts[row_off + xi, 1] = wy
                    verts[row_off + xi, 2] = z[yi, xi]

            # Faces
            inds = []
            for yi in range(h - 1):
                for xi in range(w - 1):
                    # quad corners (top-left style grid)
                    if not (has[yi, xi] and has[yi, xi + 1] and has[yi + 1, xi] and has[yi + 1, xi + 1]):
                        continue
                    v00 = yi * w + xi
                    v10 = yi * w + (xi + 1)
                    v01 = (yi + 1) * w + xi
                    v11 = (yi + 1) * w + (xi + 1)
                    inds.extend([v00, v10, v01])
                    inds.extend([v10, v11, v01])

            if not inds:
                return None

            ind_arr = np.array(inds, dtype=np.uint32)

            # Bounds over used vertices only
            used = np.unique(ind_arr)
            used_verts = verts[used]
            bounds = {
                "min_x": float(np.min(used_verts[:, 0])),
                "min_y": float(np.min(used_verts[:, 1])),
                "min_z": float(np.min(used_verts[:, 2])),
                "max_x": float(np.max(used_verts[:, 0])),
                "max_y": float(np.max(used_verts[:, 1])),
                "max_z": float(np.max(used_verts[:, 2])),
            }

            return WaterData(vertices=verts, indices=ind_arr, bounds=bounds)

        except Exception as e:
            logger.error(f"Failed to convert watermap to mesh: {e}")
            logger.debug("Stack trace:", exc_info=True)
            return None
            
    def get_building_data(self, name: str) -> Optional[BuildingData]:
        """
        Get building data by name
        
        Args:
            name: Building name
            
        Returns:
            BuildingData if found, None otherwise
        """
        return self.buildings.get(name)
        
    def get_water_data(self) -> Optional[WaterData]:
        """
        Get water data
        
        Returns:
            WaterData if available, None otherwise
        """
        return self.water
        
    def get_building_info(self) -> Dict:
        """Get building information dictionary"""
        return self.building_info
        
    def export_building_info(self, output_dir: Path):
        """Export building information to JSON file"""
        try:
            # Create output directory
            output_dir.mkdir(parents=True, exist_ok=True)
            
            # Get building info
            info = self.get_building_info()
            
            # Write to JSON file
            info_path = output_dir / 'building_info.json'
            with open(info_path, 'w') as f:
                json.dump(info, f, indent=2)
            
            logger.info(f"Exported building info to {info_path}")
            return True
            
        except Exception as e:
            logger.error(f"Error exporting building info: {e}")
            logger.debug("Stack trace:", exc_info=True)
            return False
            
    def export_obj(self, output_path: str):
        """Export buildings and water as OBJ file"""
        try:
            # Get the output directory
            output_dir = Path(output_path).parent
            entities_obj_path = output_dir / "entities.obj"
            
            # Write OBJ file
            with open(output_path, 'w') as f:
                if entities_obj_path.exists():
                    f.write("# Entities were exported to entities.obj (point cloud)\n")
                    f.write("# Copy/paste contents from entities.obj if your tool only accepts one OBJ.\n\n")

                # Write water mesh if available
                if self.water:
                    f.write("# Water mesh\n")
                    
                    # Write vertices
                    for v in self.water.vertices:
                        f.write(f"v {v[0]:.6f} {v[1]:.6f} {v[2]:.6f}\n")
                    
                    # Write faces
                    for i in range(0, len(self.water.indices), 3):
                        f.write(f"f {self.water.indices[i]+1} {self.water.indices[i+1]+1} {self.water.indices[i+2]+1}\n")
                    
                    f.write("\n")
                
                # Write buildings
                f.write("# Buildings\n")
                for building in self.buildings.values():
                    # Write building name as comment
                    f.write(f"\n# Building: {building.name}\n")
                    
                    # Write position as vertex
                    f.write(f"v {building.position[0]:.6f} {building.position[1]:.6f} {building.position[2]:.6f}\n")
                    
                    # Write rotation and scale as comment
                    f.write(f"# Rotation: {building.rotation[0]:.6f} {building.rotation[1]:.6f} {building.rotation[2]:.6f}\n")
                    f.write(f"# Scale: {building.scale[0]:.6f} {building.scale[1]:.6f} {building.scale[2]:.6f}\n")
                    f.write(f"# Archetype: {building.archetype}\n")
                    f.write(f"# Model: {building.model_name}\n")
                    f.write(f"# LOD Distance: {building.lod_dist}\n")
                    f.write("\n")
            
            logger.info(f"Exported OBJ file: {output_path}")
            return True
            
        except Exception as e:
            logger.error(f"Error exporting OBJ file: {e}")
            logger.debug("Stack trace:", exc_info=True)
            return False

    def process_building(self, building: Dict) -> Dict:
        """Process a building with enhanced terrain integration"""
        # Get building position and dimensions
        position = np.array(building['position'])
        dimensions = building.get('dimensions', np.zeros(3))
        
        # Sample terrain data at building corners
        corners = [
            position,
            position + np.array([dimensions[0], 0, 0]),
            position + np.array([0, dimensions[1], 0]),
            position + np.array([dimensions[0], dimensions[1], 0])
        ]
        
        heights = []
        normals = []
        water_flags = []
        
        for corner in corners:
            height, normal = self.terrain_system.sample_terrain_data(corner)
            heights.append(height)
            normals.append(normal)
            water_flags.append(self.terrain_system.is_water(corner[0], corner[1]))
        
        # Calculate building foundation
        foundation_height = min(heights)
        foundation_normal = np.mean(normals, axis=0)
        foundation_normal = foundation_normal / np.linalg.norm(foundation_normal)
        
        # Check if building intersects water
        has_water = any(water_flags)
        
        # Adjust building position and rotation based on terrain
        building['position'][2] = foundation_height
        building['rotation'] = self.align_to_normal(
            building['rotation'],
            foundation_normal
        )
        
        # Add terrain data to building info
        building['terrain_data'] = {
            'foundation_height': foundation_height,
            'foundation_normal': foundation_normal.tolist(),
            'corner_heights': heights,
            'corner_normals': [n.tolist() for n in normals],
            'water_intersection': has_water,
            'water_corners': water_flags
        }
        
        return building 
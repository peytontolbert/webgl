"""
Building System for GTA5
-----------------------
Handles building and structure data extraction and visualization.
"""

import os
import logging
import numpy as np
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Any
from dataclasses import dataclass, field
import json
import time
import struct
import math
from concurrent.futures import ThreadPoolExecutor

import clr
import System
from System.Numerics import Vector2, Vector3, Vector4

from .dll_manager import DllManager
from .rpf_reader import RpfReader
from .ymap_handler import YmapHandler, CMapData
from .meta import Meta, MetaType, MetaName
from .hash import jenkins_hash
from .terrain_system import TerrainSystem

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@dataclass
class BuildingData:
    """Building data extracted from YMAP"""
    name: str
    model_name: str
    position: np.ndarray  # (x, y, z)
    rotation: np.ndarray  # quaternion (w, x, y, z)
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
    
    def __init__(self, game_path: str, dll_manager: DllManager, terrain_system: TerrainSystem):
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
        self.water: Optional[WaterData] = None
        
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
        if normal is None:
            return rotation
        n = np.asarray(normal, dtype=np.float32)
        nn = float(np.linalg.norm(n))
        if nn == 0.0:
            return rotation
        n = n / nn

        # Convert quaternion to rotation matrix
        q = self._quaternion_from_float_array(rotation)
        R = self._quaternion_as_rotation_matrix(q)
        
        # Get up vector from rotation matrix
        up = R[:3, 2]
        
        # Calculate rotation to align with normal
        rotation_axis = np.cross(up, n)
        axis_len = float(np.linalg.norm(rotation_axis))
        if axis_len == 0.0:
            return rotation
        rotation_axis = rotation_axis / axis_len
        
        # Calculate rotation angle
        cos_angle = float(np.dot(up, n))
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
            # Load YMAP files using CodeWalker's RPF manager
            ymap_files = []
            for rpf in self.rpf_manager.AllRpfs:
                if not hasattr(rpf, 'AllEntries') or not rpf.AllEntries:
                    continue
                    
                for entry in rpf.AllEntries:
                    if entry.Name.lower().endswith('.ymap'):
                        ymap_files.append(entry.Path)
                        
            logger.info(f"Found {len(ymap_files)} YMAP files")
            
            for ymap_path in ymap_files:
                logger.info(f"Processing YMAP: {ymap_path}")
                try:
                    # Get YMAP file directly using path
                    ymap = self.dll_manager.get_ymap_file(ymap_path)
                    if not ymap:
                        logger.warning(f"Failed to load YMAP: {ymap_path}")
                        continue
                        
                    # Process entities
                    if not hasattr(ymap, 'AllEntities') or not ymap.AllEntities:
                        continue
                        
                    for entity in ymap.AllEntities:
                        if not entity:
                            continue
                            
                        # Get archetype safely
                        archetype = getattr(entity, 'Archetype', None)
                        if not archetype:
                            continue
                            
                        # Check if this is a building/structure
                        archetype_str = str(archetype).lower()
                        if any(x in archetype_str for x in ['building', 'house', 'apartment', 'skyscraper', 'bridge']):
                            building = self._process_building(entity)
                            if building:
                                self.buildings[building.name] = building
                                
                                # Update building type stats
                                building_type = building.archetype or 'unknown'
                                self.building_info['building_types'][building_type] = \
                                    self.building_info['building_types'].get(building_type, 0) + 1
                                    
                except Exception as e:
                    logger.warning(f"Failed to process YMAP {ymap_path}: {e}")
                    continue
            
            # Load water data
            self._load_water_data()
            
            # Update building info
            self.building_info['num_buildings'] = len(self.buildings)
            self.building_info['num_structures'] = sum(1 for b in self.buildings.values() 
                                                    if 'structure' in (b.archetype or '').lower())
            
            # Log summary
            logger.info(f"Extracted {len(self.buildings)} buildings")
            logger.info(f"Building types: {self.building_info['building_types']}")
            
            return len(self.buildings) > 0
            
        except Exception as e:
            logger.error(f"Failed to extract buildings: {e}")
            logger.debug("Stack trace:", exc_info=True)
            return False
            
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
            # CodeWalker entity rotation is a quaternion (typically XYZW). Store as (WXYZ)
            rotation = np.array([
                getattr(entity.Rotation, 'W', 1),
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
                building.position[2] = height
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
                
                # Extract vertices and indices
                vertices = []
                indices = []
                
                # Process watermap data
                for water_data in watermap_file.water_data:
                    # Add vertices
                    for vertex in water_data.vertices:
                        vertices.append([
                            vertex.x,
                            vertex.y,
                            vertex.z
                        ])
                    
                    # Add indices
                    for index in water_data.indices:
                        indices.append(index)
                
                # Convert to numpy arrays
                vertices = np.array(vertices, dtype=np.float32)
                indices = np.array(indices, dtype=np.uint32)
                
                # Calculate bounds
                bounds = {
                    'min_x': float(np.min(vertices[:, 0])),
                    'min_y': float(np.min(vertices[:, 1])),
                    'min_z': float(np.min(vertices[:, 2])),
                    'max_x': float(np.max(vertices[:, 0])),
                    'max_y': float(np.max(vertices[:, 1])),
                    'max_z': float(np.max(vertices[:, 2]))
                }
                
                # Create water data
                self.water = WaterData(
                    vertices=vertices,
                    indices=indices,
                    bounds=bounds
                )
                
                # Update water info
                self.building_info['water_info'] = {
                    'num_vertices': len(vertices),
                    'num_triangles': len(indices) // 3,
                    'bounds': bounds
                }
                
                logger.info(f"Loaded water data with {len(vertices)} vertices and {len(indices)//3} triangles")
                break  # Only process first watermap for now
                
        except Exception as e:
            logger.error(f"Failed to load water data: {e}")
            logger.debug("Stack trace:", exc_info=True)
            
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
            
            # Write OBJ file
            with open(output_path, 'w') as f:
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
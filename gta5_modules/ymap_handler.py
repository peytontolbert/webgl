"""
Enhanced YMAP Handler for GTA5
----------------------------
Handles YMAP file processing with improved entity handling and terrain integration.
"""

import logging
import numpy as np
from typing import Optional, List, Dict, Any, Tuple, Set
from dataclasses import dataclass, field
from pathlib import Path
from enum import Enum
import struct
import json
import math

from .meta import Meta, MetaType, MetaName
from .rpf_reader import RpfReader
from .hash import jenkins_hash
from .terrain_system import TerrainSystem

logger = logging.getLogger(__name__)

class EntityType(Enum):
    """Entity type enumeration"""
    DEFAULT = 0
    BUILDING = 1
    VEGETATION = 2
    PROP = 3
    VEHICLE = 4
    PED = 5
    ANIMAL = 6
    WEAPON = 7
    MLO = 8

@dataclass
class CMapData:
    """Enhanced map data structure"""
    name: int = 0
    parent: Optional[str] = None
    flags: int = 0
    content_flags: int = 0
    streaming_extents_min: np.ndarray = field(default_factory=lambda: np.zeros(3, dtype=np.float32))
    streaming_extents_max: np.ndarray = field(default_factory=lambda: np.zeros(3, dtype=np.float32))
    entities_extents_min: np.ndarray = field(default_factory=lambda: np.zeros(3, dtype=np.float32))
    entities_extents_max: np.ndarray = field(default_factory=lambda: np.zeros(3, dtype=np.float32))
    entities: List[Dict] = field(default_factory=list)
    containers: List[Dict] = field(default_factory=list)
    box_occluders: List[Dict] = field(default_factory=list)
    occlude_models: List[Dict] = field(default_factory=list)
    physics_dictionaries: List[str] = field(default_factory=list)
    instance_data: Dict = field(default_factory=dict)
    lod_lights: Optional[Dict] = None
    distant_lod_lights: Optional[Dict] = None
    asset_info: Dict = field(default_factory=dict)  # Track asset dependencies

@dataclass 
class CEntityDef:
    """Enhanced entity definition"""
    archetype_name: int = 0
    flags: int = 0
    guid: int = 0
    position: np.ndarray = field(default_factory=lambda: np.zeros(3, dtype=np.float32))
    rotation: np.ndarray = field(default_factory=lambda: np.zeros(4, dtype=np.float32))
    scale_xy: float = 1.0
    scale_z: float = 1.0
    parent_index: int = -1
    lod_dist: float = 0.0
    child_lod_dist: float = 0.0
    lod_level: int = 0
    num_children: int = 0
    priority_level: int = 0
    extensions: List[Dict] = field(default_factory=list)
    ambient_occlusion_multiplier: float = 1.0
    artificial_ambient_occlusion: float = 1.0
    tint_value: float = 1.0
    entity_type: EntityType = EntityType.DEFAULT
    terrain_normal: Optional[np.ndarray] = None
    collision_data: Optional[Dict] = None
    interior_data: Optional[Dict] = None
    asset_dependencies: Dict = field(default_factory=dict)  # Track required assets

@dataclass
class YmapCacheKey:
    """Cache key for YMAP files"""
    hash: int
    type: str = "YMAP"

    def __hash__(self):
        return self.hash

    def __eq__(self, other):
        return self.hash == other.hash and self.type == other.type

class YmapCache:
    """Simple cache for YMAP files"""
    def __init__(self, max_size: int = 1000):
        self.cache: Dict[YmapCacheKey, Any] = {}
        self.max_size = max_size

    def get(self, key: YmapCacheKey) -> Optional[Any]:
        return self.cache.get(key)

    def add(self, key: YmapCacheKey, value: Any) -> bool:
        if len(self.cache) >= self.max_size:
            return False
        self.cache[key] = value
        return True

class YmapHandler:
    """Enhanced YMAP handler with improved entity processing"""
    
    def __init__(self, rpf_manager: Any):
        """
        Initialize YMAP handler
        
        Args:
            rpf_manager: RpfManager instance from CodeWalker
        """
        self.rpf_manager = rpf_manager
        self.cache = {}
        self.load_queue = []
        self.loading_queue = []
        self.ymap_cache = {}
        
    def get_ymap(self, path: str) -> Optional[Any]:
        """Get a YMAP file, using cache if available"""
        try:
            # Generate hash from path
            ymap_hash = jenkins_hash(Path(path).stem)
            
            # Check cache first
            if ymap_hash in self.ymap_cache:
                return self.ymap_cache[ymap_hash]
                
            # Get the file entry first
            entry = self.rpf_manager.GetEntry(path)
            if not entry:
                logger.warning(f"YMAP file entry not found: {path}")
                return None
                
            # Load the YMAP file using the entry
            ymap_file = self.rpf_manager.GetFile[self.rpf_manager.YmapFile](entry)
            if not ymap_file:
                logger.warning(f"Failed to load YMAP file: {path}")
                return None
                
            # Add to cache
            self.ymap_cache[ymap_hash] = ymap_file
            
            return ymap_file
            
        except Exception as e:
            logger.error(f"Error getting YMAP {path}: {e}")
            return None
            
    def process_ymap(self, ymap_file: Any) -> Optional[Dict[str, Any]]:
        """
        Process a YMAP file and extract entity data
        
        Args:
            ymap_file: YMAP file object from CodeWalker
            
        Returns:
            Dictionary containing processed YMAP data
        """
        try:
            if not ymap_file or not hasattr(ymap_file, 'AllEntities'):
                logger.error("Invalid YMAP file")
                return None
                
            # Extract entity data
            entities = []
            for entity in ymap_file.AllEntities:
                if not entity:
                    continue
                    
                # Get entity properties safely using getattr with defaults
                entity_data = {
                    'name': getattr(entity, 'Name', ''),
                    'model': getattr(entity, 'Model', ''),
                    'position': [
                        getattr(entity, 'Position', {}).get('X', 0),
                        getattr(entity, 'Position', {}).get('Y', 0),
                        getattr(entity, 'Position', {}).get('Z', 0)
                    ],
                    'rotation': [
                        getattr(entity, 'Rotation', {}).get('X', 0),
                        getattr(entity, 'Rotation', {}).get('Y', 0),
                        getattr(entity, 'Rotation', {}).get('Z', 0)
                    ],
                    'scale': [
                        getattr(entity, 'Scale', {}).get('X', 1),
                        getattr(entity, 'Scale', {}).get('Y', 1),
                        getattr(entity, 'Scale', {}).get('Z', 1)
                    ],
                    'flags': getattr(entity, 'Flags', 0),
                    'lod_dist': getattr(entity, 'LodDist', 0),
                    'archetype': getattr(entity, 'Archetype', ''),
                    'room_key': getattr(entity, 'RoomKey', 0),
                    'entity_set': getattr(entity, 'EntitySet', '')
                }
                entities.append(entity_data)
                
            return {
                'name': getattr(ymap_file, 'Name', ''),
                'entities': entities,
                'num_entities': len(entities)
            }
            
        except Exception as e:
            logger.error(f"Error processing YMAP file: {e}")
            return None
            
    def update_loading_queue(self):
        """Update YMAP loading queue"""
        if not self.loading_queue:
            return
            
        # Process next item in queue
        path = self.loading_queue.pop(0)
        try:
            ymap_file = self.get_ymap(path)
            if ymap_file:
                processed_data = self.process_ymap(ymap_file)
                if processed_data:
                    self.cache[path] = processed_data
        except Exception as e:
            logger.error(f"Error processing queued YMAP {path}: {e}")

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
        """Align entity rotation to terrain normal using optimized quaternion operations"""
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
        
    def classify_entity(self, entity: CEntityDef) -> EntityType:
        """Classify entity based on archetype and flags"""
        archetype = self.get_archetype_name(entity.archetype_name)
        
        # Check for building types
        if any(x in archetype.lower() for x in ['building', 'house', 'apartment', 'skyscraper']):
            return EntityType.BUILDING
            
        # Check for vegetation
        if any(x in archetype.lower() for x in ['tree', 'grass', 'bush', 'plant']):
            return EntityType.VEGETATION
            
        # Check for props
        if any(x in archetype.lower() for x in ['prop', 'furniture', 'decoration']):
            return EntityType.PROP
            
        # Check for vehicles
        if any(x in archetype.lower() for x in ['car', 'bike', 'boat', 'plane']):
            return EntityType.VEHICLE
            
        # Check for MLO
        if 'mlo' in archetype.lower():
            return EntityType.MLO
            
        return EntityType.DEFAULT
        
    def process_entity(self, entity: CEntityDef) -> Dict:
        """Process a single entity with enhanced data"""
        # Classify entity type
        entity.entity_type = self.classify_entity(entity)
        
        # Get terrain data if available
        if self.terrain_system:
            # Sample terrain height and normal
            height, normal = self.sample_terrain_data(entity.position)
            entity.position[2] = height
            entity.terrain_normal = normal
            
            # Adjust rotation based on terrain normal
            if entity.terrain_normal is not None:
                entity.rotation = self.align_to_normal(
                    entity.rotation, 
                    entity.terrain_normal
                )
                
            # Check for water intersection
            if self.terrain_system.is_water(entity.position[0], entity.position[1]):
                entity.flags |= 0x1000  # Set water flag
        
        # Process extensions and collect asset dependencies
        extensions, asset_deps = self.process_extensions(entity.extensions)
        entity.asset_dependencies.update(asset_deps)
        
        # Create entity data with enhanced asset information
        entity_data = {
            'type': entity.entity_type,
            'archetype': self.get_archetype_name(entity.archetype_name),
            'position': entity.position.tolist(),
            'rotation': entity.rotation.tolist(),
            'scale': [entity.scale_xy, entity.scale_xy, entity.scale_z],
            'flags': entity.flags,
            'lod_dist': entity.lod_dist,
            'child_lod_dist': entity.child_lod_dist,
            'lod_level': entity.lod_level,
            'priority_level': entity.priority_level,
            'ambient_occlusion': entity.ambient_occlusion_multiplier,
            'artificial_ao': entity.artificial_ambient_occlusion,
            'tint': entity.tint_value,
            'extensions': extensions,
            'terrain_normal': entity.terrain_normal.tolist() if entity.terrain_normal is not None else None,
            'asset_dependencies': entity.asset_dependencies,
            'collision_data': entity.collision_data,
            'interior_data': entity.interior_data,
            'water_intersection': bool(entity.flags & 0x1000)
        }
        
        # Register assets
        self._register_assets(entity.asset_dependencies)
        
        return entity_data
        
    def sample_terrain_data(self, position: np.ndarray) -> Tuple[float, Optional[np.ndarray]]:
        """Sample terrain height and normal at given position"""
        if not self.terrain_system:
            return position[2], None
            
        # Convert world position to terrain grid coordinates
        grid_x = int((position[0] - self.terrain_system.bounds.min_x) / 
                     (self.terrain_system.bounds.max_x - self.terrain_system.bounds.min_x) * 
                     (self.terrain_system.width - 1))
        grid_y = int((position[1] - self.terrain_system.bounds.min_y) / 
                     (self.terrain_system.bounds.max_y - self.terrain_system.bounds.min_y) * 
                     (self.terrain_system.height - 1))
        
        # Sample height and normal from terrain
        height = self.terrain_system.get_height(grid_x, grid_y)
        normal = self.terrain_system.get_normal(grid_x, grid_y)
        
        return height, normal
        
    def process_extensions(self, extensions: List[Dict]) -> Tuple[Dict, Dict]:
        """Process entity extensions with enhanced data and asset tracking"""
        processed = {}
        asset_dependencies = {}
        
        for ext in extensions:
            ext_type = ext.get('type')
            ext_data = ext.get('data')
            
            if ext_type == 'CExtensionDefAnimGraph':
                anim_data, anim_assets = self.process_animation_extension(ext_data)
                processed['animation'] = anim_data
                asset_dependencies['animations'] = anim_assets
                
            elif ext_type == 'CExtensionDefLightEffect':
                light_data, light_assets = self.process_light_extension(ext_data)
                processed['light'] = light_data
                asset_dependencies['lights'] = light_assets
                
            elif ext_type == 'CExtensionDefParticleEffect':
                particle_data, particle_assets = self.process_particle_extension(ext_data)
                processed['particle'] = particle_data
                asset_dependencies['particles'] = particle_assets
                
            elif ext_type == 'CExtensionDefSkeleton':
                skeleton_data, skeleton_assets = self.process_skeleton_extension(ext_data)
                processed['skeleton'] = skeleton_data
                asset_dependencies['skeletons'] = skeleton_assets
                
            elif ext_type == 'CExtensionDefCloth':
                cloth_data, cloth_assets = self.process_cloth_extension(ext_data)
                processed['cloth'] = cloth_data
                asset_dependencies['cloths'] = cloth_assets
                
        return processed, asset_dependencies
        
    def process_animation_extension(self, data: bytes) -> Tuple[Dict, Dict]:
        """Process animation extension data with asset tracking"""
        try:
            # Parse animation data
            anim_data = {
                'type': 'animation',
                'data': {}
            }
            asset_deps = {
                'animations': [],
                'textures': [],
                'skeletons': []
            }
            
            # Read animation header
            header_size = struct.calcsize('<IIII')
            magic, version, num_sequences, data_size = struct.unpack('<IIII', data[:header_size])
            
            if magic != 0x414E494D:  # "ANIM"
                raise ValueError("Invalid animation data magic")
                
            # Process animation sequences
            offset = header_size
            for i in range(num_sequences):
                seq_header_size = struct.calcsize('<IIIIII')
                seq_hash, seq_flags, num_frames, frame_rate, num_bones, data_offset = struct.unpack(
                    '<IIIIII', data[offset:offset + seq_header_size]
                )
                
                # Extract sequence data
                seq_data = {
                    'hash': seq_hash,
                    'flags': seq_flags,
                    'num_frames': num_frames,
                    'frame_rate': frame_rate,
                    'num_bones': num_bones,
                    'frames': []
                }
                
                # Process frames
                frame_offset = offset + data_offset
                for frame in range(num_frames):
                    frame_data = self._process_animation_frame(
                        data[frame_offset:], num_bones
                    )
                    seq_data['frames'].append(frame_data)
                    frame_offset += frame_data['size']
                    
                anim_data['data'][f'sequence_{i}'] = seq_data
                asset_deps['animations'].append({
                    'hash': seq_hash,
                    'name': self.get_archetype_name(seq_hash)
                })
                
                offset += seq_header_size
                
            return anim_data, asset_deps
            
        except Exception as e:
            logger.error(f"Error processing animation extension: {e}")
            return {}, {}
            
    def process_light_extension(self, data: bytes) -> Tuple[Dict, Dict]:
        """Process light extension data with asset tracking"""
        try:
            # Parse light data
            light_data = {
                'type': 'light',
                'data': {}
            }
            asset_deps = {
                'textures': [],
                'shaders': []
            }
            
            # Read light header
            header_size = struct.calcsize('<IIIIII')
            magic, version, light_type, flags, num_textures, data_size = struct.unpack(
                '<IIIIII', data[:header_size]
            )
            
            if magic != 0x4C494748:  # "LIGH"
                raise ValueError("Invalid light data magic")
                
            # Process light properties
            light_data['data'] = {
                'type': light_type,
                'flags': flags,
                'properties': self._process_light_properties(data[header_size:])
            }
            
            # Process textures
            texture_offset = header_size + data_size
            for i in range(num_textures):
                tex_data = self._process_light_texture(data[texture_offset:])
                light_data['data'][f'texture_{i}'] = tex_data
                asset_deps['textures'].append({
                    'hash': tex_data['hash'],
                    'name': self.get_archetype_name(tex_data['hash'])
                })
                texture_offset += tex_data['size']
                
            return light_data, asset_deps
            
        except Exception as e:
            logger.error(f"Error processing light extension: {e}")
            return {}, {}
            
    def process_particle_extension(self, data: bytes) -> Tuple[Dict, Dict]:
        """Process particle extension data with asset tracking"""
        try:
            # Parse particle data
            particle_data = {
                'type': 'particle',
                'data': {}
            }
            asset_deps = {
                'textures': [],
                'shaders': [],
                'emitters': []
            }
            
            # Read particle header
            header_size = struct.calcsize('<IIIIII')
            magic, version, num_emitters, flags, num_textures, data_size = struct.unpack(
                '<IIIIII', data[:header_size]
            )
            
            if magic != 0x50415254:  # "PART"
                raise ValueError("Invalid particle data magic")
                
            # Process emitters
            emitter_offset = header_size
            for i in range(num_emitters):
                emitter_data = self._process_particle_emitter(data[emitter_offset:])
                particle_data['data'][f'emitter_{i}'] = emitter_data
                asset_deps['emitters'].append({
                    'hash': emitter_data['hash'],
                    'name': self.get_archetype_name(emitter_data['hash'])
                })
                emitter_offset += emitter_data['size']
                
            # Process textures
            texture_offset = emitter_offset
            for i in range(num_textures):
                tex_data = self._process_particle_texture(data[texture_offset:])
                particle_data['data'][f'texture_{i}'] = tex_data
                asset_deps['textures'].append({
                    'hash': tex_data['hash'],
                    'name': self.get_archetype_name(tex_data['hash'])
                })
                texture_offset += tex_data['size']
                
            return particle_data, asset_deps
            
        except Exception as e:
            logger.error(f"Error processing particle extension: {e}")
            return {}, {}
            
    def _process_animation_frame(self, data: bytes, num_bones: int) -> Dict:
        """Process a single animation frame"""
        frame_size = struct.calcsize('<I') + num_bones * struct.calcsize('<ffffffffffff')
        frame_data = struct.unpack('<I' + 'ffffffffffff' * num_bones, data[:frame_size])
        
        return {
            'size': frame_size,
            'time': frame_data[0],
            'transforms': [
                {
                    'position': frame_data[i*12+1:i*12+4],
                    'rotation': frame_data[i*12+4:i*12+8],
                    'scale': frame_data[i*12+8:i*12+11]
                }
                for i in range(num_bones)
            ]
        }
        
    def _process_light_properties(self, data: bytes) -> Dict:
        """Process light properties"""
        props_size = struct.calcsize('<ffffffffffff')
        props = struct.unpack('<ffffffffffff', data[:props_size])
        
        return {
            'position': props[0:3],
            'direction': props[3:6],
            'color': props[6:9],
            'intensity': props[9],
            'range': props[10],
            'falloff': props[11]
        }
        
    def _process_light_texture(self, data: bytes) -> Dict:
        """Process light texture data"""
        header_size = struct.calcsize('<IIII')
        hash_value, width, height, data_size = struct.unpack('<IIII', data[:header_size])
        
        return {
            'size': header_size + data_size,
            'hash': hash_value,
            'width': width,
            'height': height,
            'data': data[header_size:header_size + data_size]
        }
        
    def _process_particle_emitter(self, data: bytes) -> Dict:
        """Process particle emitter data"""
        header_size = struct.calcsize('<IIIIIIIIIIII')
        values = struct.unpack('<IIIIIIIIIIII', data[:header_size])
        
        return {
            'size': header_size + values[-1],
            'hash': values[0],
            'num_particles': values[1],
            'lifetime': values[2],
            'emission_rate': values[3],
            'speed': values[4],
            'spread': values[5],
            'gravity': values[6],
            'color_start': values[7],
            'color_end': values[8],
            'size_start': values[9],
            'size_end': values[10],
            'data': data[header_size:header_size + values[-1]]
        }
        
    def _process_particle_texture(self, data: bytes) -> Dict:
        """Process particle texture data"""
        header_size = struct.calcsize('<IIII')
        hash_value, width, height, data_size = struct.unpack('<IIII', data[:header_size])
        
        return {
            'size': header_size + data_size,
            'hash': hash_value,
            'width': width,
            'height': height,
            'data': data[header_size:header_size + data_size]
        }
        
    def _register_assets(self, asset_deps: Dict):
        """Register asset dependencies"""
        for asset_type, assets in asset_deps.items():
            if asset_type not in self.asset_registry:
                self.asset_registry[asset_type] = {}
                
            for asset in assets:
                asset_hash = asset['hash']
                if asset_hash not in self.asset_registry[asset_type]:
                    self.asset_registry[asset_type][asset_hash] = asset
                    
    def export_asset_info(self, output_dir: Path):
        """Export asset information to JSON"""
        try:
            asset_info = {
                'total_assets': sum(len(assets) for assets in self.asset_registry.values()),
                'asset_types': {}
            }
            
            for asset_type, assets in self.asset_registry.items():
                asset_info['asset_types'][asset_type] = {
                    'count': len(assets),
                    'assets': [
                        {
                            'hash': hash_value,
                            'name': asset['name']
                        }
                        for hash_value, asset in assets.items()
                    ]
                }
                
            # Write to JSON file
            output_file = output_dir / 'asset_info.json'
            with open(output_file, 'w') as f:
                json.dump(asset_info, f, indent=2)
                
            logger.info(f"Asset information exported to {output_file}")
            return True
            
        except Exception as e:
            logger.error(f"Error exporting asset information: {e}")
            return False
        
    def get_archetype_name(self, hash_value: int) -> str:
        """Get archetype name from hash"""
        # TODO: Implement hash to name lookup
        return f"archetype_{hash_value}"
        
    def get_entity_type(self, hash_value: int) -> EntityType:
        """Get entity type from hash"""
        return self.entity_types.get(hash_value, EntityType.DEFAULT)
        
    def load_ymap(self, path: str) -> bool:
        """Load YMAP file with enhanced processing"""
        try:
            # Load basic YMAP data
            if not super().load_ymap(path):
                return False
                
            # Process entities with enhanced data
            processed_entities = []
            for entity in self.entities:
                entity_data = self.process_entity(entity)
                processed_entities.append(entity_data)
                
            # Update YMAP data with processed entities
            self.map_data.entities = processed_entities
            
            # Process LOD lights
            self._load_lod_lights()
            
            # Process occluders
            self._load_occluders()
            
            return True
            
        except Exception as e:
            logger.error(f"Error loading YMAP {path}: {str(e)}")
            logger.debug("Stack trace:", exc_info=True)
            return False

    def find_terrain_ymaps(self) -> List[str]:
        """Find all terrain-related YMAP files"""
        terrain_ymaps = []
        
        # Common terrain YMAP patterns
        terrain_patterns = [
            "**/*grass*.ymap",
            "**/*terrain*.ymap",
            "**/*ground*.ymap",
            "**/cs*_*[0-9].ymap",  # Matches cs1_01, cs2_03 etc
            "**/cs*_roads*.ymap",
            "**/cs*_occl*.ymap"
        ]
        
        for pattern in terrain_patterns:
            try:
                ymaps = self.rpf_reader.find_files(pattern)
                if ymaps:
                    terrain_ymaps.extend(ymaps)
            except Exception as e:
                logger.warning(f"Error finding YMAPs with pattern {pattern}: {e}")
                
        return terrain_ymaps

    def get_ymap_by_hash(self, name_hash: int) -> Optional['YmapHandler']:
        """Get YMAP by name hash"""
        # Check cache first
        if name_hash in self.ymap_cache:
            return self.ymap_cache[name_hash]
            
        # Add to loading queue if not already queued
        if name_hash not in self.loading_queue:
            self.loading_queue.append(name_hash)
            
        return None
        
    def update_loading_queue(self):
        """Update YMAP loading queue"""
        if not self.loading_queue:
            return
            
        # Process next item in queue
        name_hash = self.loading_queue.pop(0)
        
        # Load YMAP
        ymap = YmapHandler(self.rpf_reader)
        # TODO: Implement actual loading from game files
        
        # Add to cache
        self.ymap_cache[name_hash] = ymap 
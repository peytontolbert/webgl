"""
YFT (Fragment Type) Handler Module

This module handles the processing of YFT files in GTA5, which contain fragment data
for breakable/destructible objects. This includes physics LOD groups, glass windows,
and cloth data.
"""

import logging
import numpy as np
from dataclasses import dataclass
from typing import List, Dict, Optional
import quaternion  # For quaternion operations

logger = logging.getLogger(__name__)

@dataclass
class PhysicsLOD:
    """Represents a physics LOD level for a fragment."""
    level: int
    distance: float
    mesh_indices: List[int]
    vertex_count: int
    index_count: int
    bounds: np.ndarray  # [min_x, min_y, min_z, max_x, max_y, max_z]
    flags: int

@dataclass
class GlassWindow:
    """Represents a glass window in a fragment."""
    position: np.ndarray  # [x, y, z]
    normal: np.ndarray    # [nx, ny, nz]
    width: float
    height: float
    thickness: float
    flags: int

@dataclass
class Fragment:
    """Represents a fragment type object."""
    name: str
    bounding_sphere_center: np.ndarray  # [x, y, z]
    bounding_sphere_radius: float
    drawable: Optional[object]  # Reference to associated drawable
    physics_lods: List[PhysicsLOD]
    glass_windows: List[GlassWindow]
    cloth_data: Optional[object]  # Reference to cloth data
    bone_transforms: Optional[List[np.ndarray]]  # List of 4x4 transformation matrices
    gravity_factor: float
    buoyancy_factor: float
    flags: int

class YftHandler:
    """Handles loading and processing of YFT files."""
    
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        
    def load_yft(self, file_path: str) -> Optional[Fragment]:
        """Load a YFT file and extract its contents.
        
        Args:
            file_path: Path to the YFT file
            
        Returns:
            Fragment object if successful, None otherwise
        """
        try:
            with open(file_path, 'rb') as f:
                data = f.read()
                
            # Read header
            magic = data[0:4].decode('ascii')
            if magic != 'YFT':
                self.logger.error(f"Invalid YFT file: {file_path}")
                return None
                
            version = int.from_bytes(data[4:8], 'little')
            
            # Read fragment data
            name_offset = int.from_bytes(data[8:16], 'little')
            name = data[name_offset:data.find(b'\0', name_offset)].decode('ascii')
            
            # Read bounding sphere
            center = np.frombuffer(data[16:28], dtype=np.float32)
            radius = np.frombuffer(data[28:32], dtype=np.float32)[0]
            
            # Read physics LODs
            num_lods = int.from_bytes(data[32:36], 'little')
            lods = []
            lod_offset = 36
            
            for _ in range(num_lods):
                level = int.from_bytes(data[lod_offset:lod_offset+4], 'little')
                distance = np.frombuffer(data[lod_offset+4:lod_offset+8], dtype=np.float32)[0]
                num_meshes = int.from_bytes(data[lod_offset+8:lod_offset+12], 'little')
                
                mesh_indices = []
                for _ in range(num_meshes):
                    mesh_indices.append(int.from_bytes(data[lod_offset+12:lod_offset+16], 'little'))
                    lod_offset += 4
                
                vertex_count = int.from_bytes(data[lod_offset:lod_offset+4], 'little')
                index_count = int.from_bytes(data[lod_offset+4:lod_offset+8], 'little')
                bounds = np.frombuffer(data[lod_offset+8:lod_offset+32], dtype=np.float32)
                flags = int.from_bytes(data[lod_offset+32:lod_offset+36], 'little')
                
                lod = PhysicsLOD(
                    level=level,
                    distance=distance,
                    mesh_indices=mesh_indices,
                    vertex_count=vertex_count,
                    index_count=index_count,
                    bounds=bounds,
                    flags=flags
                )
                lods.append(lod)
                lod_offset += 36
            
            # Read glass windows
            num_windows = int.from_bytes(data[lod_offset:lod_offset+4], 'little')
            windows = []
            window_offset = lod_offset + 4
            
            for _ in range(num_windows):
                position = np.frombuffer(data[window_offset:window_offset+12], dtype=np.float32)
                normal = np.frombuffer(data[window_offset+12:window_offset+24], dtype=np.float32)
                width = np.frombuffer(data[window_offset+24:window_offset+28], dtype=np.float32)[0]
                height = np.frombuffer(data[window_offset+28:window_offset+32], dtype=np.float32)[0]
                thickness = np.frombuffer(data[window_offset+32:window_offset+36], dtype=np.float32)[0]
                flags = int.from_bytes(data[window_offset+36:window_offset+40], 'little')
                
                window = GlassWindow(
                    position=position,
                    normal=normal,
                    width=width,
                    height=height,
                    thickness=thickness,
                    flags=flags
                )
                windows.append(window)
                window_offset += 40
            
            # Read physics parameters
            gravity_factor = np.frombuffer(data[window_offset:window_offset+4], dtype=np.float32)[0]
            buoyancy_factor = np.frombuffer(data[window_offset+4:window_offset+8], dtype=np.float32)[0]
            flags = int.from_bytes(data[window_offset+8:window_offset+12], 'little')
            
            # Read bone transforms if present
            bone_transforms = None
            if flags & 0x1:  # Has bone transforms
                num_bones = int.from_bytes(data[window_offset+12:window_offset+16], 'little')
                bone_transforms = []
                transform_offset = window_offset + 16
                
                for _ in range(num_bones):
                    transform = np.frombuffer(data[transform_offset:transform_offset+64], dtype=np.float32)
                    transform = transform.reshape(4, 4)
                    bone_transforms.append(transform)
                    transform_offset += 64
            
            return Fragment(
                name=name,
                bounding_sphere_center=center,
                bounding_sphere_radius=radius,
                drawable=None,  # Will be set by external code
                physics_lods=lods,
                glass_windows=windows,
                cloth_data=None,  # Will be set by external code
                bone_transforms=bone_transforms,
                gravity_factor=gravity_factor,
                buoyancy_factor=buoyancy_factor,
                flags=flags
            )
            
        except Exception as e:
            self.logger.error(f"Error loading YFT file {file_path}: {str(e)}")
            return None
            
    def export_model_info(self, fragment: Fragment, output_path: str) -> bool:
        """Export fragment information to JSON.
        
        Args:
            fragment: Fragment object to export
            output_path: Path to save the JSON file
            
        Returns:
            True if successful, False otherwise
        """
        try:
            import json
            
            info = {
                'name': fragment.name,
                'bounding_sphere': {
                    'center': fragment.bounding_sphere_center.tolist(),
                    'radius': fragment.bounding_sphere_radius
                },
                'physics_lods': [],
                'glass_windows': [],
                'physics_params': {
                    'gravity_factor': fragment.gravity_factor,
                    'buoyancy_factor': fragment.buoyancy_factor,
                    'flags': fragment.flags
                }
            }
            
            for lod in fragment.physics_lods:
                lod_info = {
                    'level': lod.level,
                    'distance': lod.distance,
                    'mesh_indices': lod.mesh_indices,
                    'vertex_count': lod.vertex_count,
                    'index_count': lod.index_count,
                    'bounds': lod.bounds.tolist(),
                    'flags': lod.flags
                }
                info['physics_lods'].append(lod_info)
            
            for window in fragment.glass_windows:
                window_info = {
                    'position': window.position.tolist(),
                    'normal': window.normal.tolist(),
                    'width': window.width,
                    'height': window.height,
                    'thickness': window.thickness,
                    'flags': window.flags
                }
                info['glass_windows'].append(window_info)
            
            if fragment.bone_transforms:
                info['bone_transforms'] = [transform.tolist() for transform in fragment.bone_transforms]
            
            with open(output_path, 'w') as f:
                json.dump(info, f, indent=2)
                
            return True
            
        except Exception as e:
            self.logger.error(f"Error exporting YFT info to {output_path}: {str(e)}")
            return False 
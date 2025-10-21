"""
YDD (Drawable Dictionary) Handler Module

This module handles the processing of YDD files in GTA5, which contain collections
of drawable objects. Each drawable object has associated geometry, materials, and textures.
"""

import logging
import numpy as np
from dataclasses import dataclass
from typing import List, Dict, Optional

logger = logging.getLogger(__name__)

@dataclass
class DrawableObject:
    """Represents a drawable object in the dictionary."""
    name_hash: int
    num_meshes: int
    num_bones: int
    flags: int
    bounds: np.ndarray  # [min_x, min_y, min_z, max_x, max_y, max_z]
    mesh_indices: List[int]
    bone_indices: List[int]
    name: Optional[str] = None

@dataclass
class DrawableDictionary:
    """Represents a collection of drawable objects."""
    version: int
    num_drawables: int
    drawables: List[DrawableObject]
    name_hashes: List[int]

class YddHandler:
    """Handles loading and processing of YDD files."""
    
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        
    def load_ydd(self, file_path: str) -> Optional[DrawableDictionary]:
        """Load a YDD file and extract its contents.
        
        Args:
            file_path: Path to the YDD file
            
        Returns:
            DrawableDictionary object if successful, None otherwise
        """
        try:
            with open(file_path, 'rb') as f:
                data = f.read()
                
            # Read header
            magic = data[0:4].decode('ascii')
            if magic != 'YDD':
                self.logger.error(f"Invalid YDD file: {file_path}")
                return None
                
            version = int.from_bytes(data[4:8], 'little')
            num_drawables = int.from_bytes(data[8:12], 'little')
            
            # Read drawable objects
            drawables = []
            name_hashes = []
            offset = 12
            
            for _ in range(num_drawables):
                name_hash = int.from_bytes(data[offset:offset+4], 'little')
                num_meshes = int.from_bytes(data[offset+4:offset+8], 'little')
                num_bones = int.from_bytes(data[offset+8:offset+12], 'little')
                flags = int.from_bytes(data[offset+12:offset+16], 'little')
                
                # Read bounds
                bounds = np.frombuffer(data[offset+16:offset+40], dtype=np.float32)
                
                # Read mesh and bone indices
                mesh_indices = []
                bone_indices = []
                
                for _ in range(num_meshes):
                    mesh_indices.append(int.from_bytes(data[offset+40:offset+44], 'little'))
                    offset += 4
                    
                for _ in range(num_bones):
                    bone_indices.append(int.from_bytes(data[offset:offset+4], 'little'))
                    offset += 4
                
                drawable = DrawableObject(
                    name_hash=name_hash,
                    num_meshes=num_meshes,
                    num_bones=num_bones,
                    flags=flags,
                    bounds=bounds,
                    mesh_indices=mesh_indices,
                    bone_indices=bone_indices
                )
                
                drawables.append(drawable)
                name_hashes.append(name_hash)
            
            return DrawableDictionary(
                version=version,
                num_drawables=num_drawables,
                drawables=drawables,
                name_hashes=name_hashes
            )
            
        except Exception as e:
            self.logger.error(f"Error loading YDD file {file_path}: {str(e)}")
            return None
            
    def export_model_info(self, ydd: DrawableDictionary, output_path: str) -> bool:
        """Export drawable dictionary information to JSON.
        
        Args:
            ydd: DrawableDictionary object to export
            output_path: Path to save the JSON file
            
        Returns:
            True if successful, False otherwise
        """
        try:
            import json
            
            info = {
                'version': ydd.version,
                'num_drawables': ydd.num_drawables,
                'drawables': []
            }
            
            for drawable in ydd.drawables:
                drawable_info = {
                    'name_hash': drawable.name_hash,
                    'name': drawable.name,
                    'num_meshes': drawable.num_meshes,
                    'num_bones': drawable.num_bones,
                    'flags': drawable.flags,
                    'bounds': drawable.bounds.tolist(),
                    'mesh_indices': drawable.mesh_indices,
                    'bone_indices': drawable.bone_indices
                }
                info['drawables'].append(drawable_info)
            
            with open(output_path, 'w') as f:
                json.dump(info, f, indent=2)
                
            return True
            
        except Exception as e:
            self.logger.error(f"Error exporting YDD info to {output_path}: {str(e)}")
            return False 
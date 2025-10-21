"""
Space Extractor Module for GTA5
-----------------------------
Interfaces with the DLL's Space class to extract spatial information.
"""

import logging
import numpy as np
from typing import Optional, List, Dict, Any, Tuple
from dataclasses import dataclass
from pathlib import Path

from .dll_manager import DllManager

logger = logging.getLogger(__name__)

@dataclass
class SpaceBounds:
    """Terrain bounds information from Space class"""
    min_x: float
    min_y: float
    min_z: float
    max_x: float
    max_y: float
    max_z: float

class SpaceExtractor:
    """Extracts spatial information using the DLL's Space class"""
    
    def __init__(self, dll_manager: DllManager):
        self.dll = dll_manager
        self.space_handle = None
        self.bounds: Optional[SpaceBounds] = None
        
    def initialize(self) -> bool:
        """Initialize the Space extractor"""
        try:
            # Get Space class instance from DLL
            self.space_handle = self.dll.get_space_instance()
            if not self.space_handle:
                logger.error("Failed to get Space instance from DLL")
                return False
                
            # Get terrain bounds
            bounds_data = self.dll.get_terrain_bounds(self.space_handle)
            if not bounds_data:
                logger.error("Failed to get terrain bounds from Space")
                return False
                
            # Parse bounds data
            self.bounds = SpaceBounds(
                min_x=bounds_data[0],
                min_y=bounds_data[1],
                min_z=bounds_data[2],
                max_x=bounds_data[3],
                max_y=bounds_data[4],
                max_z=bounds_data[5]
            )
            
            logger.info(f"Space initialized with bounds: {self.bounds}")
            return True
            
        except Exception as e:
            logger.error(f"Error initializing Space extractor: {e}")
            return False
            
    def get_terrain_height(self, x: float, y: float) -> Optional[float]:
        """Get terrain height at given coordinates using Space class"""
        try:
            if not self.space_handle:
                logger.error("Space not initialized")
                return None
                
            # Convert world coordinates to terrain grid coordinates
            grid_x = int((x - self.bounds.min_x) / 
                         (self.bounds.max_x - self.bounds.min_x) * 
                         (self.dll.get_terrain_width() - 1))
            grid_y = int((y - self.bounds.min_y) / 
                         (self.bounds.max_y - self.bounds.min_y) * 
                         (self.dll.get_terrain_height() - 1))
            
            # Get height from Space class
            height = self.dll.get_terrain_height(self.space_handle, grid_x, grid_y)
            return height
            
        except Exception as e:
            logger.error(f"Error getting terrain height: {e}")
            return None
            
    def get_terrain_normal(self, x: float, y: float) -> Optional[np.ndarray]:
        """Get terrain normal at given coordinates using Space class"""
        try:
            if not self.space_handle:
                logger.error("Space not initialized")
                return None
                
            # Convert world coordinates to terrain grid coordinates
            grid_x = int((x - self.bounds.min_x) / 
                         (self.bounds.max_x - self.bounds.min_x) * 
                         (self.dll.get_terrain_width() - 1))
            grid_y = int((y - self.bounds.min_y) / 
                         (self.bounds.max_y - self.bounds.min_y) * 
                         (self.dll.get_terrain_height() - 1))
            
            # Get normal from Space class
            normal_data = self.dll.get_terrain_normal(self.space_handle, grid_x, grid_y)
            if not normal_data:
                return None
                
            return np.array(normal_data, dtype=np.float32)
            
        except Exception as e:
            logger.error(f"Error getting terrain normal: {e}")
            return None
            
    def get_terrain_cell(self, x: float, y: float) -> Optional[Dict[str, Any]]:
        """Get terrain cell data at given coordinates using Space class"""
        try:
            if not self.space_handle:
                logger.error("Space not initialized")
                return None
                
            # Convert world coordinates to terrain grid coordinates
            grid_x = int((x - self.bounds.min_x) / 
                         (self.bounds.max_x - self.bounds.min_x) * 
                         (self.dll.get_terrain_width() - 1))
            grid_y = int((y - self.bounds.min_y) / 
                         (self.bounds.max_y - self.bounds.min_y) * 
                         (self.dll.get_terrain_height() - 1))
            
            # Get cell data from Space class
            cell_data = self.dll.get_terrain_cell(self.space_handle, grid_x, grid_y)
            if not cell_data:
                return None
                
            return {
                'height': cell_data[0],
                'normal': np.array(cell_data[1:4], dtype=np.float32),
                'texture_index': cell_data[4],
                'lod_level': cell_data[5],
                'flags': cell_data[6]
            }
            
        except Exception as e:
            logger.error(f"Error getting terrain cell: {e}")
            return None
            
    def get_terrain_lod_level(self, x: float, y: float) -> Optional[int]:
        """Get terrain LOD level at given coordinates using Space class"""
        try:
            if not self.space_handle:
                logger.error("Space not initialized")
                return None
                
            # Convert world coordinates to terrain grid coordinates
            grid_x = int((x - self.bounds.min_x) / 
                         (self.bounds.max_x - self.bounds.min_x) * 
                         (self.dll.get_terrain_width() - 1))
            grid_y = int((y - self.bounds.min_y) / 
                         (self.bounds.max_y - self.bounds.min_y) * 
                         (self.dll.get_terrain_height() - 1))
            
            # Get LOD level from Space class
            lod_level = self.dll.get_terrain_lod_level(self.space_handle, grid_x, grid_y)
            return lod_level
            
        except Exception as e:
            logger.error(f"Error getting terrain LOD level: {e}")
            return None
            
    def get_terrain_texture_index(self, x: float, y: float) -> Optional[int]:
        """Get terrain texture index at given coordinates using Space class"""
        try:
            if not self.space_handle:
                logger.error("Space not initialized")
                return None
                
            # Convert world coordinates to terrain grid coordinates
            grid_x = int((x - self.bounds.min_x) / 
                         (self.bounds.max_x - self.bounds.min_x) * 
                         (self.dll.get_terrain_width() - 1))
            grid_y = int((y - self.bounds.min_y) / 
                         (self.bounds.max_y - self.bounds.min_y) * 
                         (self.dll.get_terrain_height() - 1))
            
            # Get texture index from Space class
            texture_index = self.dll.get_terrain_texture_index(self.space_handle, grid_x, grid_y)
            return texture_index
            
        except Exception as e:
            logger.error(f"Error getting terrain texture index: {e}")
            return None
            
    def get_terrain_bounds(self) -> Optional[SpaceBounds]:
        """Get terrain bounds from Space class"""
        return self.bounds
        
    def cleanup(self):
        """Clean up Space resources"""
        if self.space_handle:
            self.dll.release_space_instance(self.space_handle)
            self.space_handle = None 
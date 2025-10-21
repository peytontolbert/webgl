"""
CodeWalker Terrain Module
-----------------------
Handles terrain extraction from GTA5 heightmap files.
"""

import os
import logging
import numpy as np
from typing import Optional, Tuple, Dict, Any

from .integration import initialize_codewalker, extract_terrain_heightmap

logger = logging.getLogger(__name__)

class TerrainExtractor:
    """Class for extracting terrain data from GTA5 heightmap files"""
    
    def __init__(self, source_dir: str, output_dir: str = "./compiled_cw"):
        """
        Initialize the terrain extractor.
        
        Args:
            source_dir: Directory containing CodeWalker source files
            output_dir: Directory to output compiled files
        """
        self.source_dir = source_dir
        self.output_dir = output_dir
        self.initialized = False
        
    def initialize(self, force: bool = False) -> Tuple[bool, Optional[str]]:
        """
        Initialize CodeWalker for terrain extraction.
        
        Args:
            force: If True, recompile even if DLL exists
            
        Returns:
            Tuple[bool, Optional[str]]: (Success status, Error message if any)
        """
        success, error = initialize_codewalker(self.source_dir, self.output_dir, force)
        if success:
            self.initialized = True
        return success, error
        
    def extract_heightmap(self, rpf_path: str, output_path: str) -> Tuple[bool, Optional[str]]:
        """
        Extract heightmap data from an RPF file.
        
        Args:
            rpf_path: Path to the RPF file containing heightmap data
            output_path: Path to save the extracted heightmap
            
        Returns:
            Tuple[bool, Optional[str]]: (Success status, Error message if any)
        """
        if not self.initialized:
            return False, "TerrainExtractor not initialized"
            
        return extract_terrain_heightmap(rpf_path, output_path)
        
    def process_heightmap(self, heightmap_path: str) -> Optional[Dict[str, Any]]:
        """
        Process a heightmap file and extract terrain information.
        
        Args:
            heightmap_path: Path to the heightmap file
            
        Returns:
            Optional[Dict[str, Any]]: Dictionary containing terrain data if successful
        """
        try:
            # Load heightmap data
            data = np.load(heightmap_path)
            
            # Extract terrain information
            terrain_info = {
                'dimensions': {
                    'width': data.shape[1],
                    'height': data.shape[0]
                },
                'elevation': {
                    'min': float(data.min()),
                    'max': float(data.max()),
                    'mean': float(data.mean())
                },
                'grid_spacing': {
                    'x': 1.0,  # Default grid spacing
                    'y': 1.0
                }
            }
            
            return terrain_info
            
        except Exception as e:
            logger.error(f"Error processing heightmap: {e}")
            return None
            
    def extract_terrain_mesh(self, heightmap_path: str, output_path: str) -> Tuple[bool, Optional[str]]:
        """
        Extract a 3D mesh from heightmap data.
        
        Args:
            heightmap_path: Path to the heightmap file
            output_path: Path to save the extracted mesh
            
        Returns:
            Tuple[bool, Optional[str]]: (Success status, Error message if any)
        """
        try:
            # Load heightmap data
            data = np.load(heightmap_path)
            
            # Create vertex and index arrays
            height, width = data.shape
            vertices = []
            indices = []
            
            # Generate vertices
            for y in range(height):
                for x in range(width):
                    vertices.extend([x, y, float(data[y, x])])
            
            # Generate indices for triangles
            for y in range(height - 1):
                for x in range(width - 1):
                    # First triangle
                    indices.extend([
                        y * width + x,
                        y * width + x + 1,
                        (y + 1) * width + x
                    ])
                    # Second triangle
                    indices.extend([
                        y * width + x + 1,
                        (y + 1) * width + x + 1,
                        (y + 1) * width + x
                    ])
            
            # Save mesh data
            mesh_data = {
                'vertices': np.array(vertices, dtype=np.float32),
                'indices': np.array(indices, dtype=np.uint32)
            }
            np.savez(output_path, **mesh_data)
            
            return True, None
            
        except Exception as e:
            return False, f"Error extracting terrain mesh: {e}"
            
    def calculate_terrain_statistics(self, heightmap_path: str) -> Optional[Dict[str, Any]]:
        """
        Calculate various statistics about the terrain.
        
        Args:
            heightmap_path: Path to the heightmap file
            
        Returns:
            Optional[Dict[str, Any]]: Dictionary containing terrain statistics
        """
        try:
            # Load heightmap data
            data = np.load(heightmap_path)
            
            # Calculate statistics
            stats = {
                'elevation': {
                    'min': float(data.min()),
                    'max': float(data.max()),
                    'mean': float(data.mean()),
                    'std': float(data.std())
                },
                'slope': {
                    'mean': 0.0,  # Placeholder
                    'max': 0.0    # Placeholder
                },
                'roughness': {
                    'mean': float(np.abs(np.diff(data)).mean()),
                    'std': float(np.abs(np.diff(data)).std())
                }
            }
            
            # Calculate slope statistics
            dy, dx = np.gradient(data)
            slope = np.sqrt(dx**2 + dy**2)
            stats['slope'] = {
                'mean': float(slope.mean()),
                'max': float(slope.max())
            }
            
            return stats
            
        except Exception as e:
            logger.error(f"Error calculating terrain statistics: {e}")
            return None 
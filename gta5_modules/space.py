"""
Space Management Module for GTA5 Terrain Extractor
-----------------------------------------------
Handles spatial organization and management of terrain and building data.
"""

import logging
import numpy as np
from typing import List, Dict, Tuple, Optional, Any
from dataclasses import dataclass, field
from enum import Enum

logger = logging.getLogger(__name__)

class SpaceNodeType(Enum):
    """Types of nodes in the spatial system"""
    TERRAIN = 0
    BUILDING = 1
    WATER = 2
    VEGETATION = 3
    ROAD = 4

@dataclass
class SpaceNode:
    """Base class for spatial nodes"""
    type: SpaceNodeType
    position: np.ndarray
    bounds_min: np.ndarray
    bounds_max: np.ndarray
    data: Dict = field(default_factory=dict)

@dataclass
class TerrainNode(SpaceNode):
    """Terrain-specific spatial node"""
    heightmap_data: np.ndarray
    normal_data: np.ndarray
    texture_data: Dict[str, np.ndarray]
    lod_levels: List[Dict] = field(default_factory=list)

@dataclass
class BuildingNode(SpaceNode):
    """Building-specific spatial node"""
    model_hash: int
    archetype: str
    rotation: np.ndarray
    scale: np.ndarray
    lod_distances: List[float] = field(default_factory=list)

class SpaceManager:
    """Manages spatial organization of terrain and building data"""
    
    def __init__(self):
        self.nodes: List[SpaceNode] = []
        self.bounds_min: np.ndarray = np.array([float('inf')] * 3)
        self.bounds_max: np.ndarray = np.array([float('-inf')] * 3)
        self.cell_size: float = 50.0  # Size of each spatial cell
        self.grid: Dict[Tuple[int, int], List[SpaceNode]] = {}
        
    def add_node(self, node: SpaceNode) -> bool:
        """Add a node to the spatial system"""
        try:
            # Update global bounds
            self.bounds_min = np.minimum(self.bounds_min, node.bounds_min)
            self.bounds_max = np.maximum(self.bounds_max, node.bounds_max)
            
            # Add to nodes list
            self.nodes.append(node)
            
            # Add to spatial grid
            grid_pos = self._get_grid_position(node.position)
            if grid_pos not in self.grid:
                self.grid[grid_pos] = []
            self.grid[grid_pos].append(node)
            
            return True
            
        except Exception as e:
            logger.error(f"Error adding node to space: {e}")
            return False
            
    def get_nodes_in_area(self, min_pos: np.ndarray, max_pos: np.ndarray, 
                         node_type: Optional[SpaceNodeType] = None) -> List[SpaceNode]:
        """Get nodes that overlap with the given area"""
        try:
            result = []
            min_grid = self._get_grid_position(min_pos)
            max_grid = self._get_grid_position(max_pos)
            
            # Check all grid cells that might contain nodes in the area
            for x in range(min_grid[0], max_grid[0] + 1):
                for y in range(min_grid[1], max_grid[1] + 1):
                    if (x, y) in self.grid:
                        for node in self.grid[(x, y)]:
                            # Filter by type if specified
                            if node_type is not None and node.type != node_type:
                                continue
                                
                            # Check if node overlaps with area
                            if (node.bounds_min[0] < max_pos[0] and 
                                node.bounds_max[0] > min_pos[0] and
                                node.bounds_min[1] < max_pos[1] and 
                                node.bounds_max[1] > min_pos[1]):
                                result.append(node)
                                
            return result
            
        except Exception as e:
            logger.error(f"Error getting nodes in area: {e}")
            return []
            
    def get_terrain_height(self, position: np.ndarray) -> Optional[float]:
        """Get terrain height at given position"""
        try:
            # Find terrain nodes in area
            search_radius = 1.0  # Small radius to find nearest terrain node
            min_pos = position - np.array([search_radius] * 3)
            max_pos = position + np.array([search_radius] * 3)
            
            terrain_nodes = self.get_nodes_in_area(min_pos, max_pos, SpaceNodeType.TERRAIN)
            if not terrain_nodes:
                return None
                
            # Find nearest terrain node
            nearest_node = min(terrain_nodes, 
                             key=lambda n: np.linalg.norm(n.position - position))
            
            # Convert world position to node-local coordinates
            local_pos = position - nearest_node.position
            local_pos = local_pos / (nearest_node.bounds_max - nearest_node.bounds_min)
            
            # Sample height from heightmap
            heightmap = nearest_node.heightmap_data
            x = int(local_pos[0] * (heightmap.shape[0] - 1))
            y = int(local_pos[1] * (heightmap.shape[1] - 1))
            
            return heightmap[y, x]
            
        except Exception as e:
            logger.error(f"Error getting terrain height: {e}")
            return None
            
    def get_terrain_normal(self, position: np.ndarray) -> Optional[np.ndarray]:
        """Get terrain normal at given position"""
        try:
            # Find terrain nodes in area
            search_radius = 1.0
            min_pos = position - np.array([search_radius] * 3)
            max_pos = position + np.array([search_radius] * 3)
            
            terrain_nodes = self.get_nodes_in_area(min_pos, max_pos, SpaceNodeType.TERRAIN)
            if not terrain_nodes:
                return None
                
            # Find nearest terrain node
            nearest_node = min(terrain_nodes, 
                             key=lambda n: np.linalg.norm(n.position - position))
            
            # Convert world position to node-local coordinates
            local_pos = position - nearest_node.position
            local_pos = local_pos / (nearest_node.bounds_max - nearest_node.bounds_min)
            
            # Sample normal from normal map
            normal_map = nearest_node.normal_data
            x = int(local_pos[0] * (normal_map.shape[0] - 1))
            y = int(local_pos[1] * (normal_map.shape[1] - 1))
            
            return normal_map[y, x]
            
        except Exception as e:
            logger.error(f"Error getting terrain normal: {e}")
            return None
            
    def _get_grid_position(self, position: np.ndarray) -> Tuple[int, int]:
        """Convert world position to grid cell position"""
        x = int((position[0] - self.bounds_min[0]) / self.cell_size)
        y = int((position[1] - self.bounds_min[1]) / self.cell_size)
        return (x, y)
        
    def get_statistics(self) -> Dict[str, Any]:
        """Get statistics about the spatial system"""
        stats = {
            'total_nodes': len(self.nodes),
            'node_types': {},
            'bounds': {
                'min': self.bounds_min.tolist(),
                'max': self.bounds_max.tolist()
            },
            'grid_cells': len(self.grid)
        }
        
        # Count nodes by type
        for node in self.nodes:
            type_name = node.type.name
            stats['node_types'][type_name] = stats['node_types'].get(type_name, 0) + 1
            
        return stats 
"""
Terrain Extractor for GTA5
------------------------
Extracts terrain data from GTA5 heightmap files.
"""

import os
import logging
import numpy as np
from pathlib import Path
from typing import Dict, List, Tuple, Optional

from .rpf import RpfManager, HeightmapData
from .ymap_handler import YmapHandler

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class TerrainNode:
    """Represents a terrain node with its own heightmap data"""
    def __init__(self):
        self.position_x: int = 0  # Position X (divided by 4 for world coords)
        self.position_y: int = 0  # Position Y (divided by 4 for world coords)
        self.min_z: float = 0     # Min Z (divided by 32 for world coords)
        self.max_z: float = 0     # Max Z (divided by 32 for world coords)
        self.heightmap_ptr: int = 0  # Pointer to heightmap data
        self.heightmap_dim_x: int = 0  # Heightmap X dimension
        self.heightmap_dim_y: int = 0  # Heightmap Y dimension
        self.heightmap_data: Optional[np.ndarray] = None

    def get_world_position(self) -> Tuple[float, float]:
        """Get world space position"""
        return (self.position_x / 4.0, self.position_y / 4.0)

    def get_world_heights(self) -> Tuple[float, float]:
        """Get world space heights"""
        return (self.min_z / 32.0, self.max_z / 32.0)

class TerrainSpace:
    """Manages terrain spatial organization"""
    def __init__(self):
        self.nodes: List[TerrainNode] = []
        self.bounds_min: Tuple[float, float, float] = (0, 0, 0)
        self.bounds_max: Tuple[float, float, float] = (0, 0, 0)
        self.cell_size: float = 50.0  # Size of each spatial cell

    def add_node(self, node: TerrainNode):
        """Add a node to the space system"""
        self.nodes.append(node)
        # Update bounds
        pos = node.get_world_position()
        heights = node.get_world_heights()
        self.bounds_min = (
            min(self.bounds_min[0], pos[0]),
            min(self.bounds_min[1], pos[1]),
            min(self.bounds_min[2], heights[0])
        )
        self.bounds_max = (
            max(self.bounds_max[0], pos[0] + node.heightmap_dim_x),
            max(self.bounds_max[1], pos[1] + node.heightmap_dim_y),
            max(self.bounds_max[2], heights[1])
        )

    def get_nodes_in_area(self, min_pos: Tuple[float, float], max_pos: Tuple[float, float]) -> List[TerrainNode]:
        """Get nodes that overlap with the given area"""
        result = []
        for node in self.nodes:
            pos = node.get_world_position()
            if (pos[0] < max_pos[0] and pos[0] + node.heightmap_dim_x > min_pos[0] and
                pos[1] < max_pos[1] and pos[1] + node.heightmap_dim_y > min_pos[1]):
                result.append(node)
        return result

class TerrainExtractor:
    """Class for extracting terrain data from GTA5 heightmap files"""
    
    def __init__(self, game_path: str, enable_dlc: bool = True):
        """
        Initialize terrain extractor
        
        Args:
            game_path (str): Path to GTA5 installation directory
            enable_dlc (bool): Whether to load DLC content
        """
        self.game_path = Path(game_path)
        self.enable_dlc = enable_dlc
        self.rpf_manager = RpfManager(game_path)
        self.ymap_handler = YmapHandler(self.rpf_manager)
        
        # Heightmap data
        self.heightmaps: Dict[str, HeightmapData] = {}
        
        # Texture data
        self.textures: Dict[str, np.ndarray] = {}  # Raw texture data
        self.material_data: Dict[str, Dict] = {}  # Texture parameters
        self.blend_data: Dict[str, np.ndarray] = {}  # Blend/mask textures
        
        # Node and space system
        self.terrain_space = TerrainSpace()
        self.terrain_nodes: Dict[str, TerrainNode] = {}
        
        # YMAP integration
        self.hd_ymaps: List[str] = []  # HD terrain YMAPs
        self.terrain_entities: List[Dict] = []  # Terrain-related entities
        
        # LOD data
        self.lod_data = {
            'lights': {},
            'distant_lights': {},
            'levels': {}
        }
        
        # Physics data
        self.physics_data = {}
        
        # Map data
        self.map_data = None
        self.entities = []
        
        # Info dictionary
        self.terrain_info = {
            'num_heightmaps': 0,
            'num_textures': 0,
            'dimensions': {},
            'texture_info': {},
            'bounds': {},
            'lod_info': {},
            'physics_info': {},
            'num_ymaps': 0,
            'num_nodes': 0
        }
    
    def extract_terrain(self) -> bool:
        """
        Extract terrain data from GTA5
        
        Returns:
            bool: True if extraction was successful
        """
        try:
            # Load heightmaps
            self._load_heightmaps()
            
            # Load terrain YMAPs
            self._load_terrain_ymaps()
            
            # Load textures and materials
            self._load_textures()
            self._extract_material_data()
            self._extract_blend_data()
            
            # Load LOD data
            self._extract_lod_data()
            
            # Load physics data
            self._extract_physics_data()
            
            # Load map data
            self._load_map_data()
            
            # Update terrain info
            self.terrain_info['num_heightmaps'] = len(self.heightmaps)
            self.terrain_info['num_textures'] = len(self.textures)
            self.terrain_info['num_ymaps'] = len(self.hd_ymaps)
            self.terrain_info['num_nodes'] = len(self.terrain_nodes)
            
            return len(self.heightmaps) > 0
            
        except Exception as e:
            logger.error(f"Failed to extract terrain: {e}")
            logger.debug("Stack trace:", exc_info=True)
            return False
    
    def _load_heightmaps(self):
        """Load heightmap data from GTA5"""
        try:
            # Get all heightmap paths
            heightmap_paths = [
                "common.rpf/data/levels/gta5/heightmap.dat",
                "update/update.rpf/common/data/levels/gta5/heightmap.dat",
                "update/update.rpf/common/data/levels/gta5/heightmapheistisland.dat"
            ]
            
            # Load each heightmap
            for path in heightmap_paths:
                try:
                    # Get heightmap data
                    heightmap = self.rpf_manager.get_heightmap(path)
                    if heightmap:
                        # Create terrain nodes from heightmap
                        self._create_terrain_nodes(heightmap, path)
                        
                        # Store heightmap data
                        self.heightmaps[path] = heightmap
                        logger.info(f"Loaded heightmap: {path} ({heightmap.width}x{heightmap.height})")
                        
                        # Store dimensions
                        self.terrain_info['dimensions'][path] = {
                            'width': heightmap.width,
                            'height': heightmap.height
                        }
                        
                        # Store bounds
                        self.terrain_info['bounds'][path] = {
                            'min': heightmap.bounds.min_z,
                            'max': heightmap.bounds.max_z
                        }
                    else:
                        logger.warning(f"Failed to load heightmap {path}")
                except Exception as e:
                    logger.warning(f"Failed to load heightmap {path}: {e}")
                    logger.debug("Stack trace:", exc_info=True)
            
            # Update terrain info
            self.terrain_info['num_heightmaps'] = len(self.heightmaps)
            self.terrain_info['num_nodes'] = len(self.terrain_nodes)
            
        except Exception as e:
            logger.error(f"Error loading heightmaps: {e}")
            logger.debug("Stack trace:", exc_info=True)
            raise
    
    def _load_terrain_ymaps(self):
        """Load terrain YMAPs from GTA5"""
        try:
            # Get all terrain-related YMAP paths
            ymap_paths = self.ymap_handler.find_terrain_ymaps()
            
            # Load each YMAP
            for path in ymap_paths:
                ymap = self.ymap_handler.load_ymap(path)
                if ymap:
                    # Check if this is an HD terrain YMAP
                    if ymap.get('content_flags', 0) & 1:  # HD terrain flag
                        self.hd_ymaps.append(path)
                        
                        # Get terrain entities
                        entities = ymap.get('entities', [])
                        for entity in entities:
                            if self._is_terrain_entity(entity):
                                self.terrain_entities.append(entity)
                                
                        # Get terrain extents
                        if 'map_data' in ymap:
                            extents_min = ymap['map_data'].entities_extents_min
                            extents_max = ymap['map_data'].entities_extents_max
                            # Update terrain space bounds
                            self.terrain_space.bounds_min = (
                                min(self.terrain_space.bounds_min[0], extents_min[0]),
                                min(self.terrain_space.bounds_min[1], extents_min[1]),
                                min(self.terrain_space.bounds_min[2], extents_min[2])
                            )
                            self.terrain_space.bounds_max = (
                                max(self.terrain_space.bounds_max[0], extents_max[0]),
                                max(self.terrain_space.bounds_max[1], extents_max[1]),
                                max(self.terrain_space.bounds_max[2], extents_max[2])
                            )
                            
            # Update terrain info
            self.terrain_info['num_ymaps'] = len(self.hd_ymaps)
            self.terrain_info['num_terrain_entities'] = len(self.terrain_entities)
            
        except Exception as e:
            logger.warning(f"Failed to load terrain YMAPs: {e}")
            logger.debug("Stack trace:", exc_info=True)
    
    def _is_terrain_entity(self, entity: Dict) -> bool:
        """Check if an entity is terrain-related"""
        # Check entity type and flags
        entity_type = entity.get('type', '')
        flags = entity.get('flags', 0)
        
        return (
            'terrain' in entity_type.lower() or
            'ground' in entity_type.lower() or
            (flags & 0x1)  # Terrain flag
        )

    def _create_terrain_nodes(self, heightmap: HeightmapData, path: str):
        """Create terrain nodes from heightmap data"""
        try:
            # Calculate number of nodes based on heightmap dimensions
            node_dim = 32  # Size of each node's heightmap
            nodes_x = (heightmap.width + node_dim - 1) // node_dim
            nodes_y = (heightmap.height + node_dim - 1) // node_dim
            
            # Create nodes
            for y in range(nodes_y):
                for x in range(nodes_x):
                    node = TerrainNode()
                    
                    # Set node position
                    node.position_x = x * node_dim * 4  # Convert to game coords
                    node.position_y = y * node_dim * 4
                    
                    # Calculate node dimensions
                    node.heightmap_dim_x = min(node_dim, heightmap.width - x * node_dim)
                    node.heightmap_dim_y = min(node_dim, heightmap.height - y * node_dim)
                    
                    # Extract heightmap data for this node
                    start_x = x * node_dim
                    start_y = y * node_dim
                    node.heightmap_data = heightmap.data[
                        start_y:start_y + node.heightmap_dim_y,
                        start_x:start_x + node.heightmap_dim_x
                    ]
                    
                    # Calculate node heights
                    if node.heightmap_data is not None:
                        node.min_z = int(np.min(node.heightmap_data) * 32)  # Convert to game coords
                        node.max_z = int(np.max(node.heightmap_data) * 32)
                    
                    # Add node to collections
                    node_key = f"{path}_{x}_{y}"
                    self.terrain_nodes[node_key] = node
                    self.terrain_space.add_node(node)
                    
        except Exception as e:
            logger.error(f"Error creating terrain nodes: {e}")
            logger.debug("Stack trace:", exc_info=True)

    def get_height_at_position(self, x: float, y: float) -> Optional[float]:
        """Get terrain height at world position"""
        try:
            # Find nodes that contain this position
            nodes = self.terrain_space.get_nodes_in_area((x, y), (x, y))
            if not nodes:
                return None
                
            # Get height from the first overlapping node
            node = nodes[0]
            node_pos = node.get_world_position()
            
            # Calculate local coordinates within node
            local_x = int((x - node_pos[0]) * node.heightmap_dim_x)
            local_y = int((y - node_pos[1]) * node.heightmap_dim_y)
            
            # Check bounds
            if (local_x < 0 or local_x >= node.heightmap_dim_x or
                local_y < 0 or local_y >= node.heightmap_dim_y or
                node.heightmap_data is None):
                return None
                
            # Get height value and convert to world coordinates
            height = node.heightmap_data[local_y, local_x]
            min_z, max_z = node.get_world_heights()
            return min_z + height * (max_z - min_z)
            
        except Exception as e:
            logger.error(f"Error getting height at position: {e}")
            return None
    
    def _load_textures(self):
        """Load terrain textures from GTA5 files"""
        try:
            # Define known terrain shader hashes and their texture parameters
            terrain_shaders = {
                3051127652: "terrain_cb_w_4lyr",
                646532852: "terrain_cb_w_4lyr_spec",
                295525123: "terrain_cb_w_4lyr_cm",
                417637541: "terrain_cb_w_4lyr_cm_tnt",
                3965214311: "terrain_cb_w_4lyr_cm_pxm_tnt",
                4186046662: "terrain_cb_w_4lyr_cm_pxm"
            }

            # Define texture parameter names used by terrain shaders
            terrain_params = {
                "DiffuseSampler": "diffuse",
                "TextureSampler_layer0": "layer0",
                "TextureSampler_layer1": "layer1",
                "TextureSampler_layer2": "layer2",
                "TextureSampler_layer3": "layer3",
                "BumpSampler": "bump",
                "BumpSampler_layer0": "bump0",
                "BumpSampler_layer1": "bump1",
                "BumpSampler_layer2": "bump2",
                "BumpSampler_layer3": "bump3",
                "lookupSampler": "blend_mask"
            }

            # First load texture relationships from gtxd.ymt
            logger.info("Loading texture relationships...")
            for rpf in self.rpf_manager.get_all_rpfs():
                if not hasattr(rpf, 'AllEntries') or not rpf.AllEntries:
                    continue

                for entry in rpf.AllEntries:
                    if entry.Name.lower() in ["gtxd.ymt", "gtxd.meta"]:
                        # Load texture relationships to find parent YTDs
                        gtxd = self.rpf_manager.get_file(entry.Path)
                        if gtxd and hasattr(gtxd, 'TxdRelationships'):
                            # Store relationships for later use
                            for rel in gtxd.TxdRelationships:
                                logger.info(f"Found texture relationship: {rel.parent} -> {rel.child}")

            # Now load terrain textures from appropriate YTDs
            logger.info("Loading terrain textures...")
            for rpf in self.rpf_manager.get_all_rpfs():
                if not hasattr(rpf, 'AllEntries') or not rpf.AllEntries:
                    continue

                for entry in rpf.AllEntries:
                    # Only look at YTD files that might contain terrain textures
                    if not entry.Name.lower().endswith('.ytd'):
                        continue

                    # Skip YTDs that clearly aren't terrain related
                    name_lower = entry.Name.lower()
                    if any(x in name_lower for x in ['interior', 'vehicle', 'weapon', 'prop', 'cutscene']):
                        continue

                    # Get YTD file
                    ytd = self.rpf_manager.read_ytd(entry.Path)
                    if not ytd:
                        continue

                    # Get textures from YTD file
                    textures = self.rpf_manager.find_textures(entry.Path)
                    if not textures:
                        continue

                    # Process each texture
                    for name, (texture_data, format_name) in textures.items():
                        # Check if texture name matches terrain parameters
                        is_terrain_tex = False
                        tex_type = None
                        for param, type_name in terrain_params.items():
                            if param.lower() in name.lower():
                                is_terrain_tex = True
                                tex_type = type_name
                                break

                        if not is_terrain_tex:
                            continue

                        # Store texture with parameter info
                        self.textures[name] = texture_data
                        self.terrain_info['texture_info'][name] = {
                            'type': tex_type,
                            'format': format_name,
                            'dimensions': texture_data.shape[:2] if len(texture_data.shape) >= 2 else None,
                            'shader_param': param
                        }
                        logger.info(f"Loaded terrain texture: {name} ({tex_type})")

            # Update terrain info
            self.terrain_info['num_textures'] = len(self.textures)
            logger.info(f"Loaded {len(self.textures)} terrain textures total")

        except Exception as e:
            logger.error(f"Error loading textures: {e}")
            logger.debug("Stack trace:", exc_info=True)
    
    def _extract_material_data(self):
        """Extract material properties and parameters"""
        try:
            # Get texture dictionaries
            texture_dicts = self.rpf_manager.find_files("*.ytd")
            for ytd_path in texture_dicts:
                if "terrain" in ytd_path.lower():
                    ytd = self.rpf_manager.read_ytd(ytd_path)
                    if ytd and ytd.textures:
                        for tex in ytd.textures:
                            # Extract texture parameters
                            self.material_data[tex.name] = {
                                'format': tex.format,
                                'width': tex.width,
                                'height': tex.height,
                                'mip_levels': tex.mip_levels,
                                'usage': tex.usage
                            }
        except Exception as e:
            logger.warning(f"Failed to extract material data: {e}")
    
    def _extract_blend_data(self):
        """Extract terrain blending information"""
        try:
            # Get terrain blend textures
            blend_patterns = [
                'terrain_*_blend.ytd',
                'terrain_*_mask.ytd'
            ]
            
            for pattern in blend_patterns:
                textures = self.rpf_manager.find_textures(pattern)
                for name, texture_data in textures.items():
                    if texture_data is not None:
                        self.blend_data[name] = texture_data
        except Exception as e:
            logger.warning(f"Failed to extract blend data: {e}")
    
    def _extract_lod_data(self):
        """Extract LOD (Level of Detail) information"""
        try:
            # Get LOD data from heightmaps
            for name, heightmap in self.heightmaps.items():
                height, width = heightmap.data.shape
                
                # Calculate LOD levels based on heightmap dimensions
                lod_levels = []
                current_width = width
                current_height = height
                
                while current_width > 32 and current_height > 32:
                    lod_levels.append({
                        'width': current_width,
                        'height': current_height,
                        'scale': width / current_width
                    })
                    current_width //= 2
                    current_height //= 2
                
                # Store LOD info for this heightmap
                self.lod_data['levels'][name] = {
                    'num_levels': len(lod_levels),
                    'levels': lod_levels
                }
            
            # Store overall LOD info
            self.terrain_info['lod_info'] = {
                'num_heightmaps': len(self.lod_data['levels'])
            }
            
        except Exception as e:
            logger.warning(f"Failed to extract LOD data: {e}")
    
    def _extract_physics_data(self):
        """Extract terrain physics information"""
        try:
            # Get physics data from heightmaps
            for name, heightmap in self.heightmaps.items():
                height, width = heightmap.data.shape
                
                # Calculate physics properties
                height_diff = heightmap.max_height - heightmap.min_height
                avg_height_diff = np.mean(height_diff)
                max_height_diff = np.max(height_diff)
                
                # Store physics info for this heightmap
                self.physics_data[name] = {
                    'dimensions': {
                        'width': width,
                        'height': height
                    },
                    'height_stats': {
                        'avg_diff': float(avg_height_diff),
                        'max_diff': float(max_height_diff)
                    }
                }
            
            # Store overall physics info
            self.terrain_info['physics_info'] = {
                'num_heightmaps': len(self.physics_data)
            }
            
        except Exception as e:
            logger.warning(f"Failed to extract physics data: {e}")
    
    def _load_map_data(self):
        """Load map data including buildings"""
        try:
            # Load YMAP files
            ymap_files = self.rpf_manager.find_files("*.ymap")
            for ymap_file in ymap_files:
                ymap = self.rpf_manager.read_ymap(ymap_file)
                if ymap and ymap.entities:
                    self.entities.extend(ymap.entities)
                    
            # Store map info
            self.terrain_info['map_info'] = {
                'num_entities': len(self.entities)
            }
        except Exception as e:
            logger.warning(f"Failed to load map data: {e}")
    
    def get_terrain_info(self) -> dict:
        """Get information about loaded terrain data"""
        return self.terrain_info
    
    def get_heightmap(self, name: str) -> Optional[HeightmapData]:
        """Get a specific heightmap by name"""
        return self.heightmaps.get(name)
    
    def get_texture(self, name: str) -> Optional[np.ndarray]:
        """Get a specific texture by name"""
        return self.textures.get(name)
    
    def get_material_data(self, name: str) -> Optional[dict]:
        """Get material data for a specific texture"""
        return self.material_data.get(name)
    
    def get_blend_data(self, name: str) -> Optional[np.ndarray]:
        """Get blend data for a specific texture"""
        return self.blend_data.get(name)
    
    def get_combined_mesh(self) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """Get combined mesh data for all heightmaps"""
        try:
            all_vertices = []
            all_faces = []
            all_texcoords = []
            all_colors = []
            vertex_offset = 0
            
            for name, heightmap in self.heightmaps.items():
                # Generate grid vertices
                x = np.linspace(0, heightmap.width-1, heightmap.width)
                y = np.linspace(0, heightmap.height-1, heightmap.height)
                xv, yv = np.meshgrid(x, y)
                
                # Create vertices
                vertices = np.stack([xv, heightmap.data, yv], axis=-1)
                vertices = vertices.reshape(-1, 3)
                
                # Create faces
                faces = []
                for i in range(heightmap.height-1):
                    for j in range(heightmap.width-1):
                        v0 = i * heightmap.width + j
                        v1 = v0 + 1
                        v2 = (i+1) * heightmap.width + j
                        v3 = v2 + 1
                        
                        # Add two triangles
                        faces.append([v0+vertex_offset, v2+vertex_offset, v1+vertex_offset])
                        faces.append([v1+vertex_offset, v2+vertex_offset, v3+vertex_offset])
                        
                # Create texture coordinates
                u = np.linspace(0, 1, heightmap.width)
                v = np.linspace(0, 1, heightmap.height)
                uv, vv = np.meshgrid(u, v)
                texcoords = np.stack([uv, vv], axis=-1)
                texcoords = texcoords.reshape(-1, 2)
                
                # Create colors (grayscale based on height)
                colors = np.zeros((vertices.shape[0], 3))
                height_norm = (heightmap.data.flatten() - heightmap.min_height) / (heightmap.max_height - heightmap.min_height)
                colors[:, :] = height_norm[:, np.newaxis]
                
                # Add to combined arrays
                all_vertices.append(vertices)
                all_faces.extend(faces)
                all_texcoords.append(texcoords)
                all_colors.append(colors)
                
                vertex_offset += vertices.shape[0]
                
            # Combine arrays
            vertices = np.vstack(all_vertices)
            faces = np.array(all_faces)
            texcoords = np.vstack(all_texcoords)
            colors = np.vstack(all_colors)
            
            return vertices, faces, texcoords, colors

        except Exception as e:
            logger.error(f"Error generating combined mesh: {str(e)}")
            return np.array([]), np.array([]), np.array([]), np.array([])
    
    def _calculate_normal(self, min_heights: np.ndarray, max_heights: np.ndarray, x: int, z: int, width: int, height: int) -> np.ndarray:
        """Calculate normal vector for a terrain point"""
        try:
            # Get neighboring heights
            left = max_heights[z, max(0, x-1)] if x > 0 else max_heights[z, x]
            right = max_heights[z, min(width-1, x+1)] if x < width-1 else max_heights[z, x]
            top = max_heights[max(0, z-1), x] if z > 0 else max_heights[z, x]
            bottom = max_heights[min(height-1, z+1), x] if z < height-1 else max_heights[z, x]
            
            # Calculate tangent vectors using float64 for higher precision
            dx = np.array([1.0, float(right) - float(left), 0.0], dtype=np.float64)
            dz = np.array([0.0, float(bottom) - float(top), 1.0], dtype=np.float64)
            
            # Calculate normal using cross product
            normal = np.cross(dx, dz)
            
            # Normalize the vector
            length = np.sqrt(np.sum(normal * normal))
            if length > 0:
                normal = normal / length
            
            return normal.astype(np.float32)
            
        except Exception as e:
            logger.error(f"Error calculating normal at ({x}, {z}): {e}")
            return np.array([0.0, 1.0, 0.0], dtype=np.float32)  # Default to up vector
    
    def _height_to_color(self, height_diff: float) -> np.ndarray:
        """Convert height difference to color for terrain detail"""
        # Normalize height difference to 0-1 range
        normalized = min(1.0, height_diff / 10.0)  # Assuming max height diff of 10 units
        
        # Create color gradient from green (low) to red (high)
        return np.array([
            1.0 - normalized,  # R
            normalized,       # G
            0.0,             # B
            1.0              # A
        ])
    
    def export_heightmap_images(self, output_dir: str):
        """Export heightmaps as images"""
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        
        for name, heightmap in self.heightmaps.items():
            try:
                # Normalize height data to 0-1 range
                height_data = heightmap.data
                height_norm = (height_data - heightmap.min_height) / (heightmap.max_height - heightmap.min_height)
                
                # Convert to grayscale image
                image = (height_norm * 255).astype(np.uint8)
                
                # Save image
                image_path = output_dir / f"{Path(name).stem}.png"
                import cv2
                cv2.imwrite(str(image_path), image)
                logger.info(f"Exported heightmap image: {image_path}")
                
            except Exception as e:
                logger.error(f"Error exporting heightmap {name}: {str(e)}")
    
    def export_textures(self, output_dir: str):
        """Export textures as images"""
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        
        for name, texture in self.textures.items():
            try:
                # Save texture
                texture_path = output_dir / f"{Path(name).stem}.png"
                import cv2
                cv2.imwrite(str(texture_path), texture)
                logger.info(f"Exported texture: {texture_path}")
                
            except Exception as e:
                logger.error(f"Error exporting texture {name}: {str(e)}")
    
    def export_obj(self, output_path: str):
        """Export terrain as OBJ file with materials"""
        try:
            vertices, faces, texcoords, colors = self.get_combined_mesh()
            
            # Create material file
            mtl_path = str(Path(output_path).with_suffix('.mtl'))
            with open(mtl_path, 'w') as f:
                f.write("# GTA5 Terrain Materials\n")
                
                # Write material definitions for each texture type and tile
                for name, tex_info in self.terrain_info['texture_info'].items():
                    tex_type = tex_info['type']
                    tile_x = tex_info['tile_x']
                    tile_y = tex_info['tile_y']
                    
                    # Create material name
                    mtl_name = f"{tex_type}_tile_{tile_x}_{tile_y}"
                    f.write(f"\nnewmtl {mtl_name}\n")
                    f.write("Ka 1.0 1.0 1.0\n")  # Ambient color
                    f.write("Kd 1.0 1.0 1.0\n")  # Diffuse color
                    f.write("Ks 0.0 0.0 0.0\n")  # Specular color
                    f.write("d 1.0\n")           # Opacity
                    f.write("illum 1\n")         # Illumination model
                    f.write(f"map_Kd textures/{name}.png\n")  # Diffuse texture
                    
                    # Add normal map if available
                    normal_name = f"{name}_n"
                    if normal_name in self.textures:
                        f.write(f"map_Bump textures/{normal_name}.png\n")
            
            # Write OBJ file
            with open(output_path, 'w') as f:
                f.write(f"mtllib {Path(mtl_path).name}\n\n")
                
                # Write vertices
                for v in vertices:
                    f.write(f"v {v[0]:.6f} {v[1]:.6f} {v[2]:.6f}\n")
                
                # Write texture coordinates
                for t in texcoords:
                    # Scale and offset UVs based on tile
                    u = t[0]
                    v = t[1]
                    f.write(f"vt {u:.6f} {v:.6f}\n")
                
                # Write normals
                for i in range(0, len(vertices), 3):
                    if i + 2 < len(vertices):
                        v1 = vertices[i]
                        v2 = vertices[i + 1]
                        v3 = vertices[i + 2]
                        # Calculate normal
                        u = v2 - v1
                        v = v3 - v1
                        normal = np.cross(u, v)
                        length = np.sqrt(np.sum(normal * normal))
                        if length > 0:
                            normal = normal / length
                        f.write(f"vn {normal[0]:.6f} {normal[1]:.6f} {normal[2]:.6f}\n")
                
                # Write faces with material groups
                current_tex = None
                for i, face in enumerate(faces):
                    # Determine which texture/tile to use based on face position
                    center = (vertices[face[0]] + vertices[face[1]] + vertices[face[2]]) / 3
                    tile_x = int(center[0] / 1000)  # Approximate tile size
                    tile_y = int(center[2] / 1000)  # Using Z as Y
                    
                    # Find matching texture for this tile
                    tex_name = None
                    for name, info in self.terrain_info['texture_info'].items():
                        if info['tile_x'] == tile_x and info['tile_y'] == tile_y:
                            tex_name = f"{info['type']}_tile_{tile_x}_{tile_y}"
                            break
                    
                    if tex_name != current_tex:
                        f.write(f"\nusemtl {tex_name}\n") if tex_name else None
                        current_tex = tex_name
                    
                    # Write face with vertex/texture/normal indices (1-based)
                    normal_idx = i // 3 + 1
                    f.write(f"f {face[0]+1}/{face[0]+1}/{normal_idx} {face[1]+1}/{face[1]+1}/{normal_idx} {face[2]+1}/{face[2]+1}/{normal_idx}\n")
            
            logger.info(f"Exported OBJ file with materials: {output_path}")
            
            # Export textures
            texture_dir = Path(output_path).parent / 'textures'
            texture_dir.mkdir(exist_ok=True)
            self.export_textures(str(texture_dir))
            
        except Exception as e:
            logger.error(f"Error exporting OBJ file: {str(e)}")
            logger.debug("Stack trace:", exc_info=True)
    
    def export_webgl_data(self, output_dir: str):
        """Export all data needed for WebGL rendering"""
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        
        # Export mesh data
        vertices, faces, texcoords, colors = self.get_combined_mesh()
        np.savez(output_dir / 'terrain_mesh.npz',
                 vertices=vertices,
                 faces=faces,
                 texcoords=texcoords,
                 colors=colors)
        
        # Export material data
        with open(output_dir / 'material_data.json', 'w') as f:
            import json
            json.dump(self.material_data, f, indent=2)
        
        # Export LOD data
        with open(output_dir / 'lod_data.json', 'w') as f:
            json.dump(self.lod_data, f, indent=2)
        
        # Export physics data
        with open(output_dir / 'physics_data.json', 'w') as f:
            json.dump(self.physics_data, f, indent=2)
        
        # Export textures
        texture_dir = output_dir / 'textures'
        texture_dir.mkdir(exist_ok=True)
        self.export_textures(str(texture_dir))
        
        # Export heightmaps
        heightmap_dir = output_dir / 'heightmaps'
        heightmap_dir.mkdir(exist_ok=True)
        self.export_heightmap_images(str(heightmap_dir))
        
        logger.info(f"Exported WebGL data to {output_dir}") 
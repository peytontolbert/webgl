"""
Terrain Mesh Manager for GTA5
---------------------------
Manages terrain meshes, textures, and materials.
"""

import logging
import numpy as np
from pathlib import Path
from typing import Dict, Any, Optional, Tuple, List
import struct
import json

logger = logging.getLogger(__name__)

class TerrainMeshManager:
    """Manages terrain mesh LODs and chunks"""
    def __init__(self):
        self.lod_levels = {}  # Dict of LOD level to mesh data
        self.chunks = {}  # Dict of chunk coordinates to mesh data
        self.active_chunks = set()  # Set of currently active chunk coordinates
        
    def create_lod_levels(self, heightmap: np.ndarray, max_lod: int = 4):
        """Create LOD levels from heightmap"""
        for lod in range(max_lod):
            # Calculate stride for this LOD level
            stride = 2 ** lod
            
            # Downsample heightmap
            lod_heightmap = heightmap[::stride, ::stride]
            
            # Generate mesh for this LOD
            vertices, indices = self.generate_mesh(lod_heightmap)
            
            self.lod_levels[lod] = {
                'heightmap': lod_heightmap,
                'vertices': vertices,
                'indices': indices
            }
            
    def chunk_terrain(self, chunk_size: int = 64):
        """Split terrain into manageable chunks"""
        for lod, data in self.lod_levels.items():
            heightmap = data['heightmap']
            height, width = heightmap.shape
            
            # Calculate chunks
            for z in range(0, height, chunk_size):
                for x in range(0, width, chunk_size):
                    chunk_heightmap = heightmap[
                        z:min(z+chunk_size, height),
                        x:min(x+chunk_size, width)
                    ]
                    
                    # Generate mesh for this chunk
                    vertices, indices = self.generate_mesh(chunk_heightmap)
                    
                    # Store chunk data
                    chunk_coord = (x//chunk_size, z//chunk_size, lod)
                    self.chunks[chunk_coord] = {
                        'heightmap': chunk_heightmap,
                        'vertices': vertices,
                        'indices': indices,
                        'bounds': self.calculate_bounds(vertices)
                    }
    
    def generate_mesh(self, heightmap: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
        """Generate mesh from heightmap"""
        height, width = heightmap.shape
        
        # Generate vertices
        x = np.arange(width)
        z = np.arange(height)
        X, Z = np.meshgrid(x, z)
        Y = heightmap
        
        vertices = np.stack([X, Y, Z], axis=-1).reshape(-1, 3)
        
        # Generate indices
        indices = []
        for i in range(height - 1):
            for j in range(width - 1):
                v0 = i * width + j
                v1 = v0 + 1
                v2 = (i + 1) * width + j
                v3 = v2 + 1
                
                # First triangle
                indices.extend([v0, v2, v1])
                # Second triangle
                indices.extend([v1, v2, v3])
        
        return vertices, np.array(indices)
    
    def calculate_bounds(self, vertices: np.ndarray) -> Dict[str, List[float]]:
        """Calculate bounding box for vertices"""
        min_bounds = vertices.min(axis=0)
        max_bounds = vertices.max(axis=0)
        return {
            'min': min_bounds.tolist(),
            'max': max_bounds.tolist()
        }
    
    def update_active_chunks(self, camera_pos: np.ndarray, view_distance: float):
        """Update active chunks based on camera position"""
        self.active_chunks.clear()
        
        for coord, chunk in self.chunks.items():
            chunk_center = np.mean(chunk['vertices'], axis=0)
            distance = np.linalg.norm(chunk_center - camera_pos)
            
            if distance <= view_distance:
                self.active_chunks.add(coord)

class TerrainTextureManager:
    """Manages terrain textures and blending"""
    def __init__(self):
        self.texture_arrays = {}  # Dict of texture type to texture array
        self.blend_maps = {}  # Dict of blend map name to data
        self.texture_parameters = {}  # Dict of texture name to parameters
        
    def create_texture_arrays(self, textures: Dict[str, np.ndarray]):
        """Create texture arrays for each type"""
        # Group textures by type
        texture_groups = {}
        for name, tex in textures.items():
            tex_type = self.get_texture_type(name)
            if tex_type not in texture_groups:
                texture_groups[tex_type] = []
            texture_groups[tex_type].append(tex)
            
        # Create texture arrays
        for tex_type, tex_list in texture_groups.items():
            # Stack textures into array
            tex_array = np.stack(tex_list, axis=0)
            self.texture_arrays[tex_type] = tex_array
            
    def create_blend_maps(self, heightmap: np.ndarray):
        """Create blend maps based on height and slope"""
        height, width = heightmap.shape
        
        # Calculate slopes
        dx = np.gradient(heightmap, axis=1)
        dy = np.gradient(heightmap, axis=0)
        slope = np.sqrt(dx**2 + dy**2)
        
        # Create blend maps
        self.blend_maps['height'] = self.normalize(heightmap)
        self.blend_maps['slope'] = self.normalize(slope)
    
    def get_texture_type(self, texture_name: str) -> str:
        """Get texture type from name"""
        if '_n.' in texture_name:
            return 'normal'
        elif '_detail.' in texture_name:
            return 'detail'
        elif '_mask.' in texture_name:
            return 'mask'
        else:
            return 'diffuse'
    
    def normalize(self, data: np.ndarray) -> np.ndarray:
        """Normalize data to 0-1 range"""
        min_val = data.min()
        max_val = data.max()
        return (data - min_val) / (max_val - min_val)

class TerrainMaterial:
    """Manages terrain material properties and parameters"""
    def __init__(self):
        self.layers = []  # List of material layers
        self.blend_modes = {}  # Dict of layer index to blend mode
        self.parameters = {}  # Dict of parameter name to value
        
    def add_layer(self, diffuse_map: str, normal_map: str = None, 
                  detail_map: str = None, blend_mode: str = 'height'):
        """Add a material layer"""
        layer = {
            'diffuse': diffuse_map,
            'normal': normal_map,
            'detail': detail_map
        }
        layer_index = len(self.layers)
        self.layers.append(layer)
        self.blend_modes[layer_index] = blend_mode
        
    def set_parameters(self, **kwargs):
        """Set material parameters"""
        self.parameters.update(kwargs)
    
    def export_json(self, output_path: str):
        """Export material data as JSON"""
        data = {
            'layers': self.layers,
            'blend_modes': self.blend_modes,
            'parameters': self.parameters
        }
        with open(output_path, 'w') as f:
            json.dump(data, f, indent=2)
    
    @classmethod
    def from_json(cls, input_path: str) -> 'TerrainMaterial':
        """Create material from JSON file"""
        with open(input_path) as f:
            data = json.load(f)
        
        material = cls()
        for layer in data['layers']:
            material.add_layer(
                layer['diffuse'],
                layer.get('normal'),
                layer.get('detail'),
                data['blend_modes'].get(str(len(material.layers)), 'height')
            )
        material.parameters = data['parameters']
        return material

class MeshManager:
    """Manages mesh generation and processing for terrain rendering"""
    
    def __init__(self):
        """Initialize mesh manager"""
        self.meshes: Dict[str, Any] = {}
        self.vertex_format = {
            'position': 3,  # x, y, z
            'normal': 3,    # nx, ny, nz
            'texcoord': 2,  # u, v
            'color': 4      # r, g, b, a
        }
    
    def generate_terrain_mesh(self, heightmap: np.ndarray, grid_size: float = 1.0) -> Dict[str, Any]:
        """
        Generate a terrain mesh from a heightmap
        
        Args:
            heightmap (np.ndarray): Heightmap data
            grid_size (float): Size of each grid cell
            
        Returns:
            Dict[str, Any]: Mesh data including vertices, indices, and attributes
        """
        try:
            rows, cols = heightmap.shape
            vertices = []
            indices = []
            texcoords = []
            
            # Generate vertices and texture coordinates
            for i in range(rows):
                for j in range(cols):
                    # Calculate vertex position
                    x = j * grid_size
                    y = heightmap[i, j]
                    z = i * grid_size
                    
                    # Calculate normal (using central differences)
                    if 0 < i < rows-1 and 0 < j < cols-1:
                        dx = (heightmap[i, j+1] - heightmap[i, j-1]) / (2 * grid_size)
                        dz = (heightmap[i+1, j] - heightmap[i-1, j]) / (2 * grid_size)
                        normal = np.array([-dx, 1.0, -dz])
                        normal = normal / np.linalg.norm(normal)
                    else:
                        normal = np.array([0.0, 1.0, 0.0])
                    
                    # Calculate texture coordinates
                    u = j / (cols - 1)
                    v = i / (rows - 1)
                    
                    # Add vertex data
                    vertices.extend([x, y, z])
                    vertices.extend(normal)
                    vertices.extend([u, v])
                    vertices.extend([1.0, 1.0, 1.0, 1.0])  # Default white color
                    
                    texcoords.extend([u, v])
            
            # Generate indices for triangles
            for i in range(rows-1):
                for j in range(cols-1):
                    # Calculate vertex indices
                    v0 = i * cols + j
                    v1 = v0 + 1
                    v2 = (i + 1) * cols + j
                    v3 = v2 + 1
                    
                    # Add triangles
                    indices.extend([v0, v1, v2])
                    indices.extend([v1, v3, v2])
            
            # Convert to numpy arrays
            vertices = np.array(vertices, dtype=np.float32)
            indices = np.array(indices, dtype=np.uint32)
            texcoords = np.array(texcoords, dtype=np.float32)
            
            # Create mesh data
            mesh_data = {
                'vertices': vertices,
                'indices': indices,
                'texcoords': texcoords,
                'vertex_count': len(vertices) // 12,  # 12 floats per vertex
                'index_count': len(indices),
                'format': self.vertex_format
            }
            
            logger.info(f"Generated terrain mesh: {mesh_data['vertex_count']} vertices, {mesh_data['index_count']} indices")
            return mesh_data
            
        except Exception as e:
            logger.error(f"Failed to generate terrain mesh: {e}")
            return None
    
    def export_mesh(self, mesh_data: Dict[str, Any], output_path: str):
        """
        Export mesh data to a binary file
        
        Args:
            mesh_data (Dict[str, Any]): Mesh data to export
            output_path (str): Path to save the mesh file
        """
        try:
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            
            with open(output_path, 'wb') as f:
                # Write header
                f.write(struct.pack('IIII', 
                    mesh_data['vertex_count'],
                    mesh_data['index_count'],
                    len(mesh_data['format']),
                    0  # Reserved
                ))
                
                # Write vertex format
                for attr, size in mesh_data['format'].items():
                    f.write(struct.pack('4sI', attr.encode('ascii'), size))
                
                # Write vertex data
                mesh_data['vertices'].tofile(f)
                
                # Write index data
                mesh_data['indices'].tofile(f)
                
                # Write texture coordinates
                mesh_data['texcoords'].tofile(f)
            
            logger.info(f"Exported mesh to: {output_path}")
            
        except Exception as e:
            logger.error(f"Failed to export mesh: {e}")
    
    def load_mesh(self, input_path: str) -> Optional[Dict[str, Any]]:
        """
        Load mesh data from a binary file
        
        Args:
            input_path (str): Path to the mesh file
            
        Returns:
            Optional[Dict[str, Any]]: Loaded mesh data if successful
        """
        try:
            input_path = Path(input_path)
            
            with open(input_path, 'rb') as f:
                # Read header
                vertex_count, index_count, format_count, _ = struct.unpack('IIII', f.read(16))
                
                # Read vertex format
                format_data = {}
                for _ in range(format_count):
                    attr = f.read(4).decode('ascii').strip('\x00')
                    size = struct.unpack('I', f.read(4))[0]
                    format_data[attr] = size
                
                # Read vertex data
                vertex_size = sum(format_data.values())
                vertices = np.fromfile(f, dtype=np.float32, count=vertex_count * vertex_size)
                
                # Read index data
                indices = np.fromfile(f, dtype=np.uint32, count=index_count)
                
                # Read texture coordinates
                texcoords = np.fromfile(f, dtype=np.float32, count=vertex_count * 2)
                
                # Create mesh data
                mesh_data = {
                    'vertices': vertices,
                    'indices': indices,
                    'texcoords': texcoords,
                    'vertex_count': vertex_count,
                    'index_count': index_count,
                    'format': format_data
                }
                
                logger.info(f"Loaded mesh from: {input_path}")
                return mesh_data
                
        except Exception as e:
            logger.error(f"Failed to load mesh: {e}")
            return None
    
    def get_mesh_info(self, mesh_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Get information about a mesh
        
        Args:
            mesh_data (Dict[str, Any]): Mesh data to analyze
            
        Returns:
            Dict[str, Any]: Dictionary containing mesh information
        """
        info = {
            "vertex_count": mesh_data['vertex_count'],
            "index_count": mesh_data['index_count'],
            "format": mesh_data['format'],
            "bounds": {
                "min": np.min(mesh_data['vertices'].reshape(-1, 12), axis=0)[:3],
                "max": np.max(mesh_data['vertices'].reshape(-1, 12), axis=0)[:3]
            }
        }
        return info 
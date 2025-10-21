"""
Enhanced YDR Handler for GTA5
----------------------------
Handles YDR (Drawable) file processing with improved model data handling and LOD support.
"""

import logging
import numpy as np
from typing import Optional, List, Dict, Any, Tuple
from dataclasses import dataclass, field
from pathlib import Path
import struct
import json

from .meta import Meta, MetaType, MetaName
from .rpf_reader import RpfReader
from .hash import jenkins_hash

logger = logging.getLogger(__name__)

@dataclass
class VertexFormat:
    """Vertex format flags"""
    POSITION = 0x01
    NORMAL = 0x02
    TANGENT = 0x04
    COLOR = 0x08
    UV0 = 0x10
    UV1 = 0x20
    BLEND_WEIGHTS = 0x40
    BLEND_INDICES = 0x80

@dataclass
class LODLevel:
    """LOD level data"""
    level: int = 0
    distance: float = 0.0
    mesh_indices: List[int] = field(default_factory=list)
    num_vertices: int = 0
    num_indices: int = 0
    bounds: List[float] = field(default_factory=lambda: [0.0] * 6)
    flags: int = 0

@dataclass
class DrawableObject:
    """Enhanced drawable object data with LOD support"""
    name_hash: int = 0
    num_meshes: int = 0
    num_bones: int = 0
    flags: int = 0
    bounds: List[float] = field(default_factory=lambda: [0.0] * 6)
    mesh_indices: List[int] = field(default_factory=list)
    bone_indices: List[int] = field(default_factory=list)
    materials: List[Dict] = field(default_factory=list)
    textures: List[Dict] = field(default_factory=list)
    lod_levels: List[LODLevel] = field(default_factory=list)
    lod_distances: List[float] = field(default_factory=list)
    lod_flags: int = 0

@dataclass
class Mesh:
    """Enhanced mesh data"""
    num_vertices: int = 0
    num_indices: int = 0
    material_index: int = 0
    flags: int = 0
    vertex_format: int = 0
    vertices: np.ndarray = field(default_factory=lambda: np.zeros((0, 3), dtype=np.float32))
    normals: np.ndarray = field(default_factory=lambda: np.zeros((0, 3), dtype=np.float32))
    uvs: np.ndarray = field(default_factory=lambda: np.zeros((0, 2), dtype=np.float32))
    colors: np.ndarray = field(default_factory=lambda: np.zeros((0, 4), dtype=np.uint8))
    indices: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.uint32))
    blend_weights: Optional[np.ndarray] = None
    blend_indices: Optional[np.ndarray] = None

@dataclass
class Material:
    """Enhanced material data"""
    name_hash: int = 0
    shader_hash: int = 0
    num_textures: int = 0
    flags: int = 0
    params: List[float] = field(default_factory=lambda: [0.0] * 16)
    texture_indices: List[int] = field(default_factory=list)
    shader_params: Dict = field(default_factory=dict)

@dataclass
class Texture:
    """Enhanced texture data"""
    name_hash: int = 0
    width: int = 0
    height: int = 0
    format: int = 0
    mip_levels: int = 0
    flags: int = 0
    data: bytes = b''

class YdrHandler:
    """Enhanced YDR handler with improved model processing"""
    
    def __init__(self, rpf_reader: RpfReader):
        self.rpf_reader = rpf_reader
        self.meta: Optional[Meta] = None
        self.drawables: List[DrawableObject] = []
        self.meshes: List[Mesh] = []
        self.materials: List[Material] = []
        self.textures: List[Texture] = []
        self.vertex_decls: Dict[int, Dict] = {}
        self.asset_registry: Dict[str, Dict] = {}
        
    def load_ydr(self, path: str) -> bool:
        """Load YDR file with enhanced processing"""
        try:
            # Read raw YDR data
            ydr_data = self.rpf_reader.read_file(path)
            if not ydr_data:
                return False
                
            # Parse metadata
            self.meta = Meta(ydr_data)
            
            # Read header
            header = self._read_header(ydr_data)
            if not header:
                return False
                
            # Process drawable objects
            offset = struct.calcsize('<IIIIIII')
            for _ in range(header['num_drawables']):
                drawable = self._read_drawable(ydr_data, offset)
                if drawable:
                    self.drawables.append(drawable)
                offset += struct.calcsize('<IIIIII') + len(drawable.mesh_indices) * 4
            
            # Process materials
            for _ in range(header['num_materials']):
                material = self._read_material(ydr_data, offset)
                if material:
                    self.materials.append(material)
                offset += struct.calcsize('<IIIII') + len(material.params) * 4
            
            # Process textures
            for _ in range(header['num_textures']):
                texture = self._read_texture(ydr_data, offset)
                if texture:
                    self.textures.append(texture)
                offset += struct.calcsize('<IIIIII') + len(texture.data)
            
            # Process meshes
            for drawable in self.drawables:
                for mesh_idx in drawable.mesh_indices:
                    mesh = self._read_mesh(ydr_data, offset)
                    if mesh:
                        self.meshes.append(mesh)
                    offset += self._calculate_mesh_size(mesh)
            
            return True
            
        except Exception as e:
            logger.error(f"Error loading YDR {path}: {e}")
            return False
            
    def _read_header(self, data: bytes) -> Optional[Dict]:
        """Read YDR header"""
        try:
            header_size = struct.calcsize('<IIIIIII')
            magic, version, flags, num_drawables, num_materials, num_textures, data_size = struct.unpack(
                '<IIIIIII', data[:header_size]
            )
            
            if magic != 0x52445259:  # "YDR"
                raise ValueError("Invalid YDR magic number")
                
            return {
                'magic': magic,
                'version': version,
                'flags': flags,
                'num_drawables': num_drawables,
                'num_materials': num_materials,
                'num_textures': num_textures,
                'data_size': data_size
            }
            
        except Exception as e:
            logger.error(f"Error reading YDR header: {e}")
            return None
            
    def _read_drawable(self, data: bytes, offset: int) -> Optional[DrawableObject]:
        """Read drawable object data with LOD support"""
        try:
            header_size = struct.calcsize('<IIIIIIII')
            name_hash, num_meshes, num_bones, flags, bounds_offset, mesh_indices_offset, lod_offset, lod_flags = struct.unpack(
                '<IIIIIIII', data[offset:offset + header_size]
            )
            
            # Read bounds
            bounds = struct.unpack('<ffffff', data[bounds_offset:bounds_offset + 24])
            
            # Read mesh indices
            mesh_indices = struct.unpack(f'<{num_meshes}I', 
                data[mesh_indices_offset:mesh_indices_offset + num_meshes * 4])
            
            # Read bone indices if present
            bone_indices = []
            if num_bones > 0:
                bone_indices_offset = mesh_indices_offset + num_meshes * 4
                bone_indices = struct.unpack(f'<{num_bones}I',
                    data[bone_indices_offset:bone_indices_offset + num_bones * 4])
            
            # Read LOD data if present
            lod_levels = []
            lod_distances = []
            if lod_offset > 0:
                lod_data = self._read_lod_data(data, lod_offset)
                if lod_data:
                    lod_levels = lod_data['levels']
                    lod_distances = lod_data['distances']
            
            return DrawableObject(
                name_hash=name_hash,
                num_meshes=num_meshes,
                num_bones=num_bones,
                flags=flags,
                bounds=bounds,
                mesh_indices=mesh_indices,
                bone_indices=bone_indices,
                lod_levels=lod_levels,
                lod_distances=lod_distances,
                lod_flags=lod_flags
            )
            
        except Exception as e:
            logger.error(f"Error reading drawable object: {e}")
            return None
            
    def _read_lod_data(self, data: bytes, offset: int) -> Optional[Dict]:
        """Read LOD data"""
        try:
            header_size = struct.calcsize('<II')
            num_levels, data_offset = struct.unpack('<II', data[offset:offset + header_size])
            
            lod_levels = []
            lod_distances = []
            
            # Read each LOD level
            level_offset = offset + data_offset
            for i in range(num_levels):
                level_size = struct.calcsize('<IIIIIIII')
                level, distance, mesh_idx, num_verts, num_indices, bounds_offset, flags, _ = struct.unpack(
                    '<IIIIIIII', data[level_offset:level_offset + level_size]
                )
                
                # Read bounds
                bounds = struct.unpack('<ffffff', data[bounds_offset:bounds_offset + 24])
                
                lod_level = LODLevel(
                    level=level,
                    distance=distance,
                    mesh_indices=[mesh_idx],
                    num_vertices=num_verts,
                    num_indices=num_indices,
                    bounds=bounds,
                    flags=flags
                )
                
                lod_levels.append(lod_level)
                lod_distances.append(distance)
                
                level_offset += level_size
            
            return {
                'levels': lod_levels,
                'distances': lod_distances
            }
            
        except Exception as e:
            logger.error(f"Error reading LOD data: {e}")
            return None
            
    def _read_material(self, data: bytes, offset: int) -> Optional[Material]:
        """Read material data"""
        try:
            header_size = struct.calcsize('<IIIII')
            name_hash, shader_hash, num_textures, flags, params_offset = struct.unpack(
                '<IIIII', data[offset:offset + header_size]
            )
            
            # Read shader parameters
            params = struct.unpack('<16f', data[params_offset:params_offset + 64])
            
            # Read texture indices
            texture_indices_offset = params_offset + 64
            texture_indices = struct.unpack(f'<{num_textures}I',
                data[texture_indices_offset:texture_indices_offset + num_textures * 4])
            
            # Process shader parameters
            shader_params = self._process_shader_params(params)
            
            return Material(
                name_hash=name_hash,
                shader_hash=shader_hash,
                num_textures=num_textures,
                flags=flags,
                params=params,
                texture_indices=texture_indices,
                shader_params=shader_params
            )
            
        except Exception as e:
            logger.error(f"Error reading material: {e}")
            return None
            
    def _read_texture(self, data: bytes, offset: int) -> Optional[Texture]:
        """Read texture data"""
        try:
            header_size = struct.calcsize('<IIIIII')
            name_hash, width, height, format, mip_levels, data_offset = struct.unpack(
                '<IIIIII', data[offset:offset + header_size]
            )
            
            # Read texture data
            texture_data = data[data_offset:data_offset + width * height * 4]
            
            return Texture(
                name_hash=name_hash,
                width=width,
                height=height,
                format=format,
                mip_levels=mip_levels,
                flags=0,  # TODO: Read flags
                data=texture_data
            )
            
        except Exception as e:
            logger.error(f"Error reading texture: {e}")
            return None
            
    def _read_mesh(self, data: bytes, offset: int) -> Optional[Mesh]:
        """Read mesh data"""
        try:
            header_size = struct.calcsize('<IIIII')
            num_vertices, num_indices, material_index, flags, vertex_format = struct.unpack(
                '<IIIII', data[offset:offset + header_size]
            )
            
            # Calculate vertex data size based on format
            vertex_size = self._calculate_vertex_size(vertex_format)
            vertex_data_size = num_vertices * vertex_size
            
            # Read vertex data
            vertex_data = data[offset + header_size:offset + header_size + vertex_data_size]
            
            # Process vertex data based on format
            vertices, normals, uvs, colors, blend_weights, blend_indices = self._process_vertex_data(
                vertex_data, vertex_format, num_vertices
            )
            
            # Read index data
            index_offset = offset + header_size + vertex_data_size
            indices = struct.unpack(f'<{num_indices}I',
                data[index_offset:index_offset + num_indices * 4])
            
            return Mesh(
                num_vertices=num_vertices,
                num_indices=num_indices,
                material_index=material_index,
                flags=flags,
                vertex_format=vertex_format,
                vertices=vertices,
                normals=normals,
                uvs=uvs,
                colors=colors,
                indices=indices,
                blend_weights=blend_weights,
                blend_indices=blend_indices
            )
            
        except Exception as e:
            logger.error(f"Error reading mesh: {e}")
            return None
            
    def _calculate_vertex_size(self, vertex_format: int) -> int:
        """Calculate vertex size based on format flags"""
        size = 0
        
        if vertex_format & VertexFormat.POSITION:
            size += 12  # 3 floats for x, y, z
            
        if vertex_format & VertexFormat.NORMAL:
            size += 12  # 3 floats for nx, ny, nz
            
        if vertex_format & VertexFormat.TANGENT:
            size += 12  # 3 floats for tx, ty, tz
            
        if vertex_format & VertexFormat.COLOR:
            size += 4  # 4 bytes for RGBA
            
        if vertex_format & VertexFormat.UV0:
            size += 8  # 2 floats for u, v
            
        if vertex_format & VertexFormat.UV1:
            size += 8  # 2 floats for u, v
            
        if vertex_format & VertexFormat.BLEND_WEIGHTS:
            size += 16  # 4 floats for weights
            
        if vertex_format & VertexFormat.BLEND_INDICES:
            size += 16  # 4 bytes for indices
            
        return size
        
    def _process_vertex_data(self, data: bytes, vertex_format: int, num_vertices: int) -> Tuple[np.ndarray, ...]:
        """Process vertex data based on format"""
        vertex_size = self._calculate_vertex_size(vertex_format)
        vertices = np.zeros((num_vertices, 3), dtype=np.float32)
        normals = np.zeros((num_vertices, 3), dtype=np.float32)
        uvs = np.zeros((num_vertices, 2), dtype=np.float32)
        colors = np.zeros((num_vertices, 4), dtype=np.uint8)
        blend_weights = None
        blend_indices = None
        
        offset = 0
        for i in range(num_vertices):
            if vertex_format & VertexFormat.POSITION:
                vertices[i] = struct.unpack('<fff', data[offset:offset + 12])
                offset += 12
                
            if vertex_format & VertexFormat.NORMAL:
                normals[i] = struct.unpack('<fff', data[offset:offset + 12])
                offset += 12
                
            if vertex_format & VertexFormat.TANGENT:
                offset += 12  # Skip tangent data
                
            if vertex_format & VertexFormat.COLOR:
                colors[i] = struct.unpack('<BBBB', data[offset:offset + 4])
                offset += 4
                
            if vertex_format & VertexFormat.UV0:
                uvs[i] = struct.unpack('<ff', data[offset:offset + 8])
                offset += 8
                
            if vertex_format & VertexFormat.UV1:
                offset += 8  # Skip second UV set
                
            if vertex_format & VertexFormat.BLEND_WEIGHTS:
                if blend_weights is None:
                    blend_weights = np.zeros((num_vertices, 4), dtype=np.float32)
                blend_weights[i] = struct.unpack('<ffff', data[offset:offset + 16])
                offset += 16
                
            if vertex_format & VertexFormat.BLEND_INDICES:
                if blend_indices is None:
                    blend_indices = np.zeros((num_vertices, 4), dtype=np.uint8)
                blend_indices[i] = struct.unpack('<BBBB', data[offset:offset + 4])
                offset += 4
                
        return vertices, normals, uvs, colors, blend_weights, blend_indices
        
    def _process_shader_params(self, params: List[float]) -> Dict:
        """Process shader parameters"""
        return {
            'diffuse': params[0:4],
            'specular': params[4:8],
            'emissive': params[8:12],
            'roughness': params[12],
            'metallic': params[13],
            'alpha': params[14],
            'normal_scale': params[15]
        }
        
    def _calculate_mesh_size(self, mesh: Mesh) -> int:
        """Calculate total mesh data size"""
        header_size = struct.calcsize('<IIIII')
        vertex_size = self._calculate_vertex_size(mesh.vertex_format)
        vertex_data_size = mesh.num_vertices * vertex_size
        index_data_size = mesh.num_indices * 4
        
        return header_size + vertex_data_size + index_data_size
        
    def export_obj(self, output_path: str):
        """Export model to OBJ format"""
        try:
            with open(output_path, 'w') as f:
                # Write vertices
                for mesh in self.meshes:
                    for v in mesh.vertices:
                        f.write(f'v {v[0]} {v[1]} {v[2]}\n')
                        
                # Write texture coordinates
                for mesh in self.meshes:
                    for vt in mesh.uvs:
                        f.write(f'vt {vt[0]} {vt[1]}\n')
                        
                # Write normals
                for mesh in self.meshes:
                    for vn in mesh.normals:
                        f.write(f'vn {vn[0]} {vn[1]} {vn[2]}\n')
                        
                # Write faces
                vertex_offset = 0
                for mesh in self.meshes:
                    for i in range(0, len(mesh.indices), 3):
                        idx = mesh.indices[i:i+3]
                        f.write(f'f {idx[0]+vertex_offset+1}/{idx[0]+vertex_offset+1}/{idx[0]+vertex_offset+1} '
                               f'{idx[1]+vertex_offset+1}/{idx[1]+vertex_offset+1}/{idx[1]+vertex_offset+1} '
                               f'{idx[2]+vertex_offset+1}/{idx[2]+vertex_offset+1}/{idx[2]+vertex_offset+1}\n')
                    vertex_offset += mesh.num_vertices
                    
        except Exception as e:
            logger.error(f"Error exporting OBJ file: {e}")
            
    def export_model_info(self, output_dir: Path):
        """Export model information to JSON with LOD data"""
        try:
            info = {
                'num_drawables': len(self.drawables),
                'num_meshes': len(self.meshes),
                'num_materials': len(self.materials),
                'num_textures': len(self.textures),
                'drawables': [],
                'materials': [],
                'textures': []
            }
            
            # Add drawable information with LOD data
            for drawable in self.drawables:
                drawable_info = {
                    'name_hash': drawable.name_hash,
                    'num_meshes': drawable.num_meshes,
                    'num_bones': drawable.num_bones,
                    'bounds': drawable.bounds,
                    'lod_levels': []
                }
                
                # Add LOD information
                for lod in drawable.lod_levels:
                    drawable_info['lod_levels'].append({
                        'level': lod.level,
                        'distance': lod.distance,
                        'num_vertices': lod.num_vertices,
                        'num_indices': lod.num_indices,
                        'bounds': lod.bounds,
                        'flags': lod.flags
                    })
                
                info['drawables'].append(drawable_info)
                
            # Add material information
            for material in self.materials:
                info['materials'].append({
                    'name_hash': material.name_hash,
                    'shader_hash': material.shader_hash,
                    'num_textures': material.num_textures,
                    'shader_params': material.shader_params
                })
                
            # Add texture information
            for texture in self.textures:
                info['textures'].append({
                    'name_hash': texture.name_hash,
                    'width': texture.width,
                    'height': texture.height,
                    'format': texture.format,
                    'mip_levels': texture.mip_levels
                })
                
            # Write to JSON file
            output_file = output_dir / 'model_info.json'
            with open(output_file, 'w') as f:
                json.dump(info, f, indent=2)
                
            logger.info(f"Model information exported to {output_file}")
            
        except Exception as e:
            logger.error(f"Error exporting model information: {e}") 
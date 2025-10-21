"""
YBN (Bounds) Handler Module

This module handles the processing of YBN files in GTA5, which contain collision
and physics bounds data. This includes vertex data, polygons, and material information.
"""

import logging
import numpy as np
from dataclasses import dataclass
from typing import List, Dict, Optional

logger = logging.getLogger(__name__)

@dataclass
class BoundVertex:
    """Represents a vertex in a bound geometry."""
    position: np.ndarray  # [x, y, z]
    color: Optional[np.ndarray] = None  # [r, g, b, a]

@dataclass
class BoundPolygon:
    """Represents a polygon in a bound geometry."""
    vertex_indices: List[int]  # Indices into vertex array
    material_index: int
    flags: int

@dataclass
class BoundMaterial:
    """Represents a material in a bound geometry."""
    name: str
    color: np.ndarray  # [r, g, b, a]
    flags: int

@dataclass
class BoundGeometry:
    """Represents a bound geometry object."""
    vertices: List[BoundVertex]
    polygons: List[BoundPolygon]
    materials: List[BoundMaterial]
    bounds: np.ndarray  # [min_x, min_y, min_z, max_x, max_y, max_z]
    flags: int

@dataclass
class BoundComposite:
    """Represents a composite bound object."""
    children: List[object]  # List of BoundGeometry or BoundComposite
    bounds: np.ndarray  # [min_x, min_y, min_z, max_x, max_y, max_z]
    flags: int

class YbnHandler:
    """Handles loading and processing of YBN files."""
    
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        
    def load_ybn(self, file_path: str) -> Optional[object]:
        """Load a YBN file and extract its contents.
        
        Args:
            file_path: Path to the YBN file
            
        Returns:
            BoundGeometry or BoundComposite object if successful, None otherwise
        """
        try:
            with open(file_path, 'rb') as f:
                data = f.read()
                
            # Read header
            magic = data[0:4].decode('ascii')
            if magic != 'YBN':
                self.logger.error(f"Invalid YBN file: {file_path}")
                return None
                
            version = int.from_bytes(data[4:8], 'little')
            bound_type = int.from_bytes(data[8:12], 'little')
            
            if bound_type == 0:  # Geometry
                return self._load_geometry(data[12:])
            elif bound_type == 1:  # Composite
                return self._load_composite(data[12:])
            else:
                self.logger.error(f"Unknown bound type: {bound_type}")
                return None
                
        except Exception as e:
            self.logger.error(f"Error loading YBN file {file_path}: {str(e)}")
            return None
            
    def _load_geometry(self, data: bytes) -> Optional[BoundGeometry]:
        """Load a bound geometry from data.
        
        Args:
            data: Raw data starting after header
            
        Returns:
            BoundGeometry object if successful, None otherwise
        """
        try:
            # Read vertex data
            num_vertices = int.from_bytes(data[0:4], 'little')
            vertices = []
            vertex_offset = 4
            
            for _ in range(num_vertices):
                position = np.frombuffer(data[vertex_offset:vertex_offset+12], dtype=np.float32)
                has_color = bool(int.from_bytes(data[vertex_offset+12:vertex_offset+16], 'little'))
                
                color = None
                if has_color:
                    color = np.frombuffer(data[vertex_offset+16:vertex_offset+20], dtype=np.uint8)
                
                vertex = BoundVertex(position=position, color=color)
                vertices.append(vertex)
                vertex_offset += 20 if has_color else 16
            
            # Read polygon data
            num_polygons = int.from_bytes(data[vertex_offset:vertex_offset+4], 'little')
            polygons = []
            polygon_offset = vertex_offset + 4
            
            for _ in range(num_polygons):
                num_indices = int.from_bytes(data[polygon_offset:polygon_offset+4], 'little')
                indices = []
                
                for _ in range(num_indices):
                    indices.append(int.from_bytes(data[polygon_offset+4:polygon_offset+8], 'little'))
                    polygon_offset += 4
                
                material_index = int.from_bytes(data[polygon_offset:polygon_offset+4], 'little')
                flags = int.from_bytes(data[polygon_offset+4:polygon_offset+8], 'little')
                
                polygon = BoundPolygon(
                    vertex_indices=indices,
                    material_index=material_index,
                    flags=flags
                )
                polygons.append(polygon)
                polygon_offset += 8
            
            # Read material data
            num_materials = int.from_bytes(data[polygon_offset:polygon_offset+4], 'little')
            materials = []
            material_offset = polygon_offset + 4
            
            for _ in range(num_materials):
                name_offset = int.from_bytes(data[material_offset:material_offset+8], 'little')
                name = data[name_offset:data.find(b'\0', name_offset)].decode('ascii')
                color = np.frombuffer(data[material_offset+8:material_offset+12], dtype=np.uint8)
                flags = int.from_bytes(data[material_offset+12:material_offset+16], 'little')
                
                material = BoundMaterial(name=name, color=color, flags=flags)
                materials.append(material)
                material_offset += 16
            
            # Read bounds
            bounds = np.frombuffer(data[material_offset:material_offset+24], dtype=np.float32)
            flags = int.from_bytes(data[material_offset+24:material_offset+28], 'little')
            
            return BoundGeometry(
                vertices=vertices,
                polygons=polygons,
                materials=materials,
                bounds=bounds,
                flags=flags
            )
            
        except Exception as e:
            self.logger.error(f"Error loading bound geometry: {str(e)}")
            return None
            
    def _load_composite(self, data: bytes) -> Optional[BoundComposite]:
        """Load a bound composite from data.
        
        Args:
            data: Raw data starting after header
            
        Returns:
            BoundComposite object if successful, None otherwise
        """
        try:
            # Read number of children
            num_children = int.from_bytes(data[0:4], 'little')
            children = []
            child_offset = 4
            
            for _ in range(num_children):
                child_type = int.from_bytes(data[child_offset:child_offset+4], 'little')
                child_data = data[child_offset+4:]
                
                if child_type == 0:
                    child = self._load_geometry(child_data)
                elif child_type == 1:
                    child = self._load_composite(child_data)
                else:
                    self.logger.error(f"Unknown child bound type: {child_type}")
                    continue
                    
                if child:
                    children.append(child)
                    child_offset += 4 + len(child_data)
            
            # Read bounds
            bounds = np.frombuffer(data[child_offset:child_offset+24], dtype=np.float32)
            flags = int.from_bytes(data[child_offset+24:child_offset+28], 'little')
            
            return BoundComposite(
                children=children,
                bounds=bounds,
                flags=flags
            )
            
        except Exception as e:
            self.logger.error(f"Error loading bound composite: {str(e)}")
            return None
            
    def export_model_info(self, bounds: object, output_path: str) -> bool:
        """Export bounds information to JSON.
        
        Args:
            bounds: BoundGeometry or BoundComposite object to export
            output_path: Path to save the JSON file
            
        Returns:
            True if successful, False otherwise
        """
        try:
            import json
            
            if isinstance(bounds, BoundGeometry):
                info = self._export_geometry_info(bounds)
            elif isinstance(bounds, BoundComposite):
                info = self._export_composite_info(bounds)
            else:
                self.logger.error("Unknown bounds type")
                return False
            
            with open(output_path, 'w') as f:
                json.dump(info, f, indent=2)
                
            return True
            
        except Exception as e:
            self.logger.error(f"Error exporting YBN info to {output_path}: {str(e)}")
            return False
            
    def _export_geometry_info(self, geometry: BoundGeometry) -> dict:
        """Export geometry information to JSON format."""
        info = {
            'type': 'geometry',
            'vertices': [],
            'polygons': [],
            'materials': [],
            'bounds': geometry.bounds.tolist(),
            'flags': geometry.flags
        }
        
        for vertex in geometry.vertices:
            vertex_info = {
                'position': vertex.position.tolist()
            }
            if vertex.color is not None:
                vertex_info['color'] = vertex.color.tolist()
            info['vertices'].append(vertex_info)
        
        for polygon in geometry.polygons:
            polygon_info = {
                'vertex_indices': polygon.vertex_indices,
                'material_index': polygon.material_index,
                'flags': polygon.flags
            }
            info['polygons'].append(polygon_info)
        
        for material in geometry.materials:
            material_info = {
                'name': material.name,
                'color': material.color.tolist(),
                'flags': material.flags
            }
            info['materials'].append(material_info)
        
        return info
        
    def _export_composite_info(self, composite: BoundComposite) -> dict:
        """Export composite information to JSON format."""
        info = {
            'type': 'composite',
            'children': [],
            'bounds': composite.bounds.tolist(),
            'flags': composite.flags
        }
        
        for child in composite.children:
            if isinstance(child, BoundGeometry):
                info['children'].append(self._export_geometry_info(child))
            elif isinstance(child, BoundComposite):
                info['children'].append(self._export_composite_info(child))
        
        return info 
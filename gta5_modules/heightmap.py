"""
GTA5 Heightmap File Handler
-------------------------
Handles reading and parsing GTA5 heightmap files.
"""

import os
import struct
import numpy as np
from dataclasses import dataclass
from typing import Optional, Tuple, List
import logging
from .dll_manager import DllManager

logger = logging.getLogger(__name__)

@dataclass
class CompHeader:
    """Compression header for heightmap data"""
    start: int  # Start index in row
    count: int  # Number of values in row
    data_offset: int  # Offset into data array

@dataclass
class Bounds:
    """Terrain bounds information"""
    min_x: float
    min_y: float
    min_z: float
    max_x: float
    max_y: float
    max_z: float
    
    @property
    def size(self) -> Tuple[float, float, float]:
        """Get the size of the terrain bounds"""
        return (
            self.max_x - self.min_x,
            self.max_y - self.min_y,
            self.max_z - self.min_z
        )
    
    @property
    def center(self) -> Tuple[float, float, float]:
        """Get the center point of the terrain bounds"""
        return (
            (self.min_x + self.max_x) / 2,
            (self.min_y + self.max_y) / 2,
            (self.min_z + self.max_z) / 2
        )

class HeightmapFile:
    """Handles reading and parsing GTA5 heightmap files"""
    
    def __init__(self, data: bytes, dll_manager: Optional[DllManager] = None):
        """
        Initialize heightmap file from raw data
        
        Args:
            data (bytes): Raw heightmap file data
            dll_manager: Optional DllManager instance to use for CodeWalker resources
        """
        self.width: int = 0
        self.height: int = 0
        self.bounds: Optional[Bounds] = None
        self.max_heights: Optional[np.ndarray] = None
        self.min_heights: Optional[np.ndarray] = None
        self.compressed: bool = False
        
        # Always try to use CodeWalker DLL first if available
        if dll_manager and dll_manager.initialized:
            try:
                self._parse_with_dll(data, dll_manager)
            except Exception as e:
                logger.warning(f"Failed to parse with DLL, falling back to Python implementation: {e}")
                self._parse_data(data)
        else:
            logger.warning("No DLL manager available, using Python implementation")
            self._parse_data(data)
    
    def _parse_with_dll(self, data: bytes, dll_manager: DllManager):
        """Parse the heightmap file data using CodeWalker DLL"""
        try:
            # Create CodeWalker HeightmapFile instance
            heightmap_file = dll_manager.HeightmapFile()
            
            # Load data into CodeWalker HeightmapFile
            heightmap_file.Load(data, None)  # No entry needed for direct data loading
            
            # Get dimensions
            self.width = heightmap_file.Width
            self.height = heightmap_file.Height
            
            # Get bounding box
            bb_min = heightmap_file.BBMin
            bb_max = heightmap_file.BBMax
            self.bounds = Bounds(
                min_x=bb_min.X,
                min_y=bb_min.Y,
                min_z=bb_min.Z,
                max_x=bb_max.X,
                max_y=bb_max.Y,
                max_z=bb_max.Z
            )
            
            # Get compression headers
            comp_headers = heightmap_file.CompHeaders
            self.compressed = len(comp_headers) > 0  # Set compressed flag based on headers
            
            # Get height data
            if hasattr(heightmap_file, 'MaxHeights') and hasattr(heightmap_file, 'MinHeights'):
                # Convert max_heights and min_heights to numpy arrays
                self.max_heights = np.zeros((self.height, self.width), dtype=np.uint8)
                self.min_heights = np.zeros((self.height, self.width), dtype=np.uint8)
                
                # Extract height data
                for y in range(self.height):
                    for x in range(self.width):
                        index = y * self.width + x
                        if index < len(heightmap_file.MaxHeights):
                            self.max_heights[y, x] = heightmap_file.MaxHeights[index]
                            self.min_heights[y, x] = heightmap_file.MinHeights[index]
            
            logger.info("Successfully parsed heightmap data using CodeWalker DLL")
            
        except Exception as e:
            logger.error(f"Failed to parse heightmap with DLL: {e}")
            # Fall back to Python implementation
            self._parse_data(data)
    
    def _parse_data(self, data: bytes) -> None:
        """Parse heightmap data from bytes"""
        try:
            # Check magic bytes and determine endianness
            if data[0:4] == b'HMAP':
                self.endianness = '>'  # Big-endian for HMAP
            elif data[0:4] == b'PMAH':
                self.endianness = '<'  # Little-endian for PMAH
            else:
                raise ValueError("Invalid heightmap magic bytes")
            
            logger.info(f"Heightmap magic: {data[0:4]}, Endianness: {self.endianness}")
            
            # Read header
            header_size = 44  # Base header size
            if len(data) < header_size:
                raise ValueError(f"File too small for header. Need {header_size} bytes but got {len(data)}")
            
            # Read version
            self.version = f"{data[4]}.{data[5]}"
            logger.info(f"Version: {self.version}")
            
            # Read compression flag - this is a uint32 value
            self.compressed = struct.unpack(f"{self.endianness}I", data[8:12])[0]
            logger.info(f"Compressed: {self.compressed}")
            
            # Read dimensions - these are uint16 values
            self.width = struct.unpack(f"{self.endianness}H", data[12:14])[0]
            self.height = struct.unpack(f"{self.endianness}H", data[14:16])[0]
            
            # Validate dimensions
            if self.width > 10000 or self.height > 10000:
                # Try swapping endianness if dimensions are too large
                self.endianness = '<' if self.endianness == '>' else '>'
                self.width = struct.unpack(f"{self.endianness}H", data[12:14])[0]
                self.height = struct.unpack(f"{self.endianness}H", data[14:16])[0]
            
            logger.info(f"Raw dimensions: width={self.width}, height={self.height}")
            
            # Read bounding box - these are float32 values
            self.bounds = Bounds(
                min_x=struct.unpack(f"{self.endianness}f", data[16:20])[0],
                min_y=struct.unpack(f"{self.endianness}f", data[20:24])[0],
                min_z=struct.unpack(f"{self.endianness}f", data[24:28])[0],
                max_x=struct.unpack(f"{self.endianness}f", data[28:32])[0],
                max_y=struct.unpack(f"{self.endianness}f", data[32:36])[0],
                max_z=struct.unpack(f"{self.endianness}f", data[36:40])[0]
            )
            logger.info(f"Bounding box: {self.bounds}")
            
            # Calculate header size including compression headers if needed
            header_size = 44  # Base header size
            
            # Read data length - this is a uint32 value
            self.data_len = struct.unpack(f"{self.endianness}I", data[40:44])[0]
            if self.data_len == 0:
                # If data length is 0, calculate it from file size
                self.data_len = len(data) - header_size  # Base header size
            logger.info(f"Data length: {self.data_len}")
            
            if self.compressed:
                header_size += self.height * 8  # Each compression header is 8 bytes
            logger.info(f"Header size: {header_size} bytes")
            
            # Validate file size
            if len(data) < header_size:
                raise ValueError(f"File too small for compression headers. Need {header_size} bytes but got {len(data)}")
            
            # Validate data length
            if self.data_len > len(data) - header_size:
                logger.warning(f"Data length {self.data_len} exceeds available data {len(data) - header_size}, adjusting...")
                self.data_len = len(data) - header_size
            
            # Read compression headers if needed
            self.comp_headers = []
            if self.compressed:
                offset = 44  # Start after base header
                for i in range(self.height):
                    header = CompHeader(
                        start=struct.unpack(f"{self.endianness}H", data[offset:offset+2])[0],
                        count=struct.unpack(f"{self.endianness}H", data[offset+2:offset+4])[0],
                        data_offset=struct.unpack(f"{self.endianness}I", data[offset+4:offset+8])[0]
                    )
                    self.comp_headers.append(header)
                    offset += 8
            
            # Read height data
            if self.compressed:
                # For compressed data, we need to read from the data section
                data_section = data[header_size:]
                
                # Allocate flat arrays like CodeWalker
                self.max_heights = np.zeros(self.width * self.height, dtype=np.uint8)
                self.min_heights = np.zeros(self.width * self.height, dtype=np.uint8)
                
                # Read max heights
                for y in range(self.height):
                    header = self.comp_headers[y]
                    for i in range(header.count):
                        x = header.start + i
                        if x < self.width:  # Ensure we don't write beyond array bounds
                            idx = y * self.width + x  # Match CodeWalker's flat array indexing
                            data_idx = header.data_offset + i
                            if data_idx < len(data_section):
                                self.max_heights[idx] = data_section[data_idx]
                
                # Read min heights
                h2off = len(data_section) // 2
                for y in range(self.height):
                    header = self.comp_headers[y]
                    for i in range(header.count):
                        x = header.start + i
                        if x < self.width:  # Ensure we don't write beyond array bounds
                            idx = y * self.width + x  # Match CodeWalker's flat array indexing
                            data_idx = h2off + header.data_offset + i
                            if data_idx < len(data_section):
                                self.min_heights[idx] = data_section[data_idx]
            else:
                # For uncompressed data, read directly from data section
                data_section = data[header_size:]
                self.max_heights = np.frombuffer(data_section[:self.data_len], dtype=np.uint8)
                self.min_heights = np.frombuffer(data_section[self.data_len:], dtype=np.uint8)
            
            logger.info("Successfully parsed heightmap data")
            
        except Exception as e:
            logger.error(f"Error parsing heightmap data: {e}")
            raise
    
    def get_height_at(self, x: float, y: float, use_max: bool = False) -> Optional[float]:
        """
        Get terrain height at a specific world coordinate
        
        Args:
            x (float): World X coordinate
            y (float): World Y coordinate
            use_max (bool): Whether to use max heights instead of min heights
            
        Returns:
            Optional[float]: Height at the given coordinate, or None if not found
        """
        if not self.bounds or self.max_heights is None:
            return None
            
        # Convert world coordinates to grid coordinates
        grid_x = int((x - self.bounds.min_x) / (self.bounds.max_x - self.bounds.min_x) * (self.width - 1))
        grid_y = int((y - self.bounds.min_y) / (self.bounds.max_y - self.bounds.min_y) * (self.height - 1))
        
        # Check bounds
        if grid_x < 0 or grid_x >= self.width or grid_y < 0 or grid_y >= self.height:
            return None
            
        # Get height value
        height = self.max_heights[grid_y, grid_x] if use_max else self.min_heights[grid_y, grid_x]
        
        # Scale height to world coordinates
        return self.bounds.min_z + (height / 255.0) * (self.bounds.max_z - self.bounds.min_z)
    
    def get_height_grid(self) -> np.ndarray:
        """
        Get the height grid as a numpy array
        
        Returns:
            np.ndarray: Height grid array
        """
        if self.max_heights is None:
            raise ValueError("Heightmap data not loaded")
            
        # Scale heights to world coordinates
        height_scale = (self.bounds.max_z - self.bounds.min_z) / 255.0
        return self.bounds.min_z + self.max_heights * height_scale
    
    def get_mesh_data(self) -> Tuple[np.ndarray, np.ndarray]:
        """
        Get terrain mesh data
        
        Returns:
            Tuple[np.ndarray, np.ndarray]: Vertices and indices arrays
        """
        if self.max_heights is None:
            raise ValueError("Heightmap data not loaded")
            
        # Create coordinate grids
        x = np.linspace(self.bounds.min_x, self.bounds.max_x, self.width)
        y = np.linspace(self.bounds.min_y, self.bounds.max_y, self.height)
        X, Y = np.meshgrid(x, y)
        
        # Scale height values to match the bounding box Z range
        height_scale = (self.bounds.max_z - self.bounds.min_z) / 255.0
        Z = self.bounds.min_z + self.max_heights * height_scale
        
        # Create vertices array
        vertices = np.column_stack((
            X.ravel(),
            Y.ravel(),
            Z.ravel()
        ))
        
        # Create indices array for triangles
        indices = []
        for i in range(self.height - 1):
            for j in range(self.width - 1):
                # First triangle
                indices.append([
                    i * self.width + j,
                    i * self.width + j + 1,
                    (i + 1) * self.width + j
                ])
                # Second triangle
                indices.append([
                    i * self.width + j + 1,
                    (i + 1) * self.width + j + 1,
                    (i + 1) * self.width + j
                ])
        
        return vertices, np.array(indices)
    
    def to_pgm(self) -> str:
        """
        Convert heightmap to PGM format string
        
        Returns:
            str: PGM format string representation of the heightmap
        """
        if self.max_heights is None:
            return ""
            
        lines = [f"P2\n{self.width} {self.height}\n255\n"]
        
        # Write height values (inverted vertically like CodeWalker)
        for y in range(self.height - 1, -1, -1):
            row = []
            for x in range(self.width):
                h = self.max_heights[y, x]
                row.append(str(h))
            lines.append(" ".join(row) + "\n")
            
        return "".join(lines)
    
    def save_pgm(self, output_path: str):
        """
        Save heightmap as PGM file
        
        Args:
            output_path (str): Path to save the PGM file
        """
        pgm_data = self.to_pgm()
        if pgm_data:
            with open(output_path, 'w') as f:
                f.write(pgm_data) 
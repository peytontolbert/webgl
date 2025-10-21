"""
Terrain Chunk Manager for GTA5
----------------------------
Handles terrain chunking and streaming for efficient memory usage.
"""

import logging
import numpy as np
from typing import Dict, List, Optional, Tuple, Any
from dataclasses import dataclass, field
from pathlib import Path
import struct
import json
import time
from concurrent.futures import ThreadPoolExecutor

logger = logging.getLogger(__name__)

@dataclass
class TerrainChunk:
    """Terrain chunk data structure"""
    id: str
    bounds: Dict[str, float]  # min_x, min_y, max_x, max_y
    height_data: Optional[np.ndarray] = None
    normal_data: Optional[np.ndarray] = None
    texture_data: Optional[np.ndarray] = None
    lod_level: int = 0
    is_loaded: bool = False
    last_accessed: float = 0.0
    memory_size: int = 0
    
    def calculate_memory_size(self) -> int:
        """Calculate memory size of chunk data"""
        size = 0
        
        if self.height_data is not None:
            size += self.height_data.nbytes
            
        if self.normal_data is not None:
            size += self.normal_data.nbytes
            
        if self.texture_data is not None:
            size += self.texture_data.nbytes
            
        return size
        
    def unload(self) -> None:
        """Unload chunk data to free memory"""
        self.height_data = None
        self.normal_data = None
        self.texture_data = None
        self.is_loaded = False
        self.memory_size = 0

class TerrainChunkManager:
    """Manages terrain chunks for efficient memory usage"""
    
    def __init__(self, chunk_size: int = 256, max_chunks: int = 100):
        self.chunk_size = chunk_size
        self.max_chunks = max_chunks
        self.chunks: Dict[str, TerrainChunk] = {}
        self.total_memory: int = 0
        self.executor = ThreadPoolExecutor(max_workers=4)
        
    def get_chunk(self, x: float, y: float) -> Optional[TerrainChunk]:
        """Get or create chunk at given coordinates"""
        try:
            # Calculate chunk coordinates
            chunk_x = int(x / self.chunk_size)
            chunk_y = int(y / self.chunk_size)
            chunk_id = f"{chunk_x}_{chunk_y}"
            
            # Check if chunk exists
            if chunk_id in self.chunks:
                chunk = self.chunks[chunk_id]
                chunk.last_accessed = time.time()
                return chunk
                
            # Create new chunk
            chunk = self._create_chunk(chunk_x, chunk_y)
            if chunk:
                self.chunks[chunk_id] = chunk
                self._manage_memory()
                return chunk
                
            return None
            
        except Exception as e:
            logger.error(f"Error getting chunk: {e}")
            return None
            
    def _create_chunk(self, chunk_x: int, chunk_y: int) -> Optional[TerrainChunk]:
        """Create a new terrain chunk"""
        try:
            # Calculate chunk bounds
            bounds = {
                'min_x': chunk_x * self.chunk_size,
                'min_y': chunk_y * self.chunk_size,
                'max_x': (chunk_x + 1) * self.chunk_size,
                'max_y': (chunk_y + 1) * self.chunk_size
            }
            
            # Create chunk
            chunk = TerrainChunk(
                id=f"{chunk_x}_{chunk_y}",
                bounds=bounds
            )
            
            # Load chunk data asynchronously
            self.executor.submit(self._load_chunk_data, chunk)
            
            return chunk
            
        except Exception as e:
            logger.error(f"Error creating chunk: {e}")
            return None
            
    def _load_chunk_data(self, chunk: TerrainChunk) -> None:
        """Load chunk data asynchronously"""
        try:
            # Load height data
            chunk.height_data = self._load_height_data(chunk)
            
            # Load normal data
            chunk.normal_data = self._load_normal_data(chunk)
            
            # Load texture data
            chunk.texture_data = self._load_texture_data(chunk)
            
            # Update chunk state
            chunk.is_loaded = True
            chunk.memory_size = chunk.calculate_memory_size()
            self.total_memory += chunk.memory_size
            
        except Exception as e:
            logger.error(f"Error loading chunk data: {e}")
            
    def _load_height_data(self, chunk: TerrainChunk) -> Optional[np.ndarray]:
        """Load height data for chunk"""
        try:
            # TODO: Implement actual height data loading from game files
            # For now, return dummy data
            return np.zeros((self.chunk_size, self.chunk_size), dtype=np.float32)
            
        except Exception as e:
            logger.error(f"Error loading height data: {e}")
            return None
            
    def _load_normal_data(self, chunk: TerrainChunk) -> Optional[np.ndarray]:
        """Load normal data for chunk"""
        try:
            # TODO: Implement actual normal data loading from game files
            # For now, return dummy data
            return np.zeros((self.chunk_size, self.chunk_size, 3), dtype=np.float32)
            
        except Exception as e:
            logger.error(f"Error loading normal data: {e}")
            return None
            
    def _load_texture_data(self, chunk: TerrainChunk) -> Optional[np.ndarray]:
        """Load texture data for chunk"""
        try:
            # TODO: Implement actual texture data loading from game files
            # For now, return dummy data
            return np.zeros((self.chunk_size, self.chunk_size, 4), dtype=np.uint8)
            
        except Exception as e:
            logger.error(f"Error loading texture data: {e}")
            return None
            
    def _manage_memory(self) -> None:
        """Manage memory usage by unloading least recently used chunks"""
        try:
            # Check if we need to free memory
            while self.total_memory > self.max_chunks * self.chunk_size * self.chunk_size * 4:
                # Find least recently used chunk
                lru_chunk = min(
                    self.chunks.values(),
                    key=lambda c: c.last_accessed
                )
                
                # Unload chunk
                self.total_memory -= lru_chunk.memory_size
                lru_chunk.unload()
                
        except Exception as e:
            logger.error(f"Error managing memory: {e}")
            
    def get_chunks_in_range(self, center_x: float, center_y: float, radius: float) -> List[TerrainChunk]:
        """Get all chunks within given range"""
        chunks = []
        
        try:
            # Calculate chunk range
            min_chunk_x = int((center_x - radius) / self.chunk_size)
            max_chunk_x = int((center_x + radius) / self.chunk_size)
            min_chunk_y = int((center_y - radius) / self.chunk_size)
            max_chunk_y = int((center_y + radius) / self.chunk_size)
            
            # Get chunks in range
            for x in range(min_chunk_x, max_chunk_x + 1):
                for y in range(min_chunk_y, max_chunk_y + 1):
                    chunk_id = f"{x}_{y}"
                    if chunk_id in self.chunks:
                        chunks.append(self.chunks[chunk_id])
                        
            return chunks
            
        except Exception as e:
            logger.error(f"Error getting chunks in range: {e}")
            return []
            
    def unload_all(self) -> None:
        """Unload all chunks"""
        try:
            for chunk in self.chunks.values():
                chunk.unload()
            self.chunks.clear()
            self.total_memory = 0
            
        except Exception as e:
            logger.error(f"Error unloading all chunks: {e}")
            
    def get_memory_usage(self) -> Dict[str, int]:
        """Get memory usage statistics"""
        return {
            'total_chunks': len(self.chunks),
            'loaded_chunks': sum(1 for c in self.chunks.values() if c.is_loaded),
            'total_memory': self.total_memory,
            'max_memory': self.max_chunks * self.chunk_size * self.chunk_size * 4
        } 
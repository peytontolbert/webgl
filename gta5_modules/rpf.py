"""
RPF Manager for GTA5
-------------------
Handle RPF file operations for GTA5.
"""

import os
import logging
import numpy as np
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any
from dataclasses import dataclass

from .rpf_reader import RpfReader
from .dll_manager import canonicalize_cw_path
from .meta import Meta
from .ddsio import DDSIO

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@dataclass
class Bounds:
    """Bounds data structure"""
    min_x: float
    min_y: float
    min_z: float
    max_x: float
    max_y: float
    max_z: float

@dataclass
class HeightmapData:
    """Heightmap data structure"""
    width: int
    height: int
    data: np.ndarray
    min_height: float
    max_height: float
    bounds: Bounds

    def get_height_grid(self) -> np.ndarray:
        """
        Get the height grid data
        
        Returns:
            np.ndarray: 2D array of height values
        """
        return self.data

class RpfManager:
    """Manager class for RPF file operations"""
    
    def __init__(self, game_path: str):
        """
        Initialize RPF manager
        
        Args:
            game_path (str): Path to GTA5 installation directory
        """
        self.game_path = Path(game_path)
        self.rpf_reader = RpfReader(game_path)
        self.heightmaps: Dict[str, HeightmapData] = {}
        self.textures: Dict[str, np.ndarray] = {}
        self._initialize()
    
    def _initialize(self):
        """Initialize the RPF manager"""
        logger.info("Initializing RPF reader...")
        if not self.rpf_reader.initialize():
            logger.error("Failed to initialize RPF reader")
            return False
            
        # Use the RpfReader's RpfManager directly
        logger.info(f"Loaded {len(self.rpf_reader.rpf_manager.BaseRpfs)} base RPFs, {len(self.rpf_reader.rpf_manager.DlcRpfs)} DLC RPFs")
        return True

    def get_all_rpfs(self):
        """Get all RPF files from the manager"""
        return self.rpf_reader.rpf_manager.AllRpfs

    def find_files(self, pattern: str) -> List[str]:
        """Find files matching pattern in RPF archives"""
        matches = []
        pattern = pattern.lower()
        
        try:
            for rpf in self.get_all_rpfs():
                if not hasattr(rpf, 'AllEntries') or not rpf.AllEntries:
                    continue
                    
                for entry in rpf.AllEntries:
                    if pattern.startswith('*.'):
                        ext = pattern[1:]
                        if entry.Name.lower().endswith(ext):
                            matches.append(entry.Path)
                    else:
                        if pattern in entry.Name.lower():
                            matches.append(entry.Path)
                            
            logger.info(f"Found {len(matches)} files matching pattern '{pattern}'")
            return matches
            
        except Exception as e:
            logger.error(f"Error finding files matching pattern '{pattern}': {e}")
            logger.debug("Stack trace:", exc_info=True)
            return []

    def get_file(self, path: str) -> Optional[bytes]:
        """Get file data from RPF archives"""
        try:
            return self.rpf_reader.rpf_manager.GetFileData(canonicalize_cw_path(path, keep_forward_slashes=True))
        except Exception as e:
            logger.error(f"Error getting file {path}: {e}")
            return None

    def find_ymap_files(self, pattern: str) -> List[str]:
        """
        Find YMAP files matching the given pattern
        
        Args:
            pattern (str): Pattern to match YMAP names against
            
        Returns:
            List[str]: List of matching YMAP paths
        """
        matching_files = []
        
        try:
            # Search through all RPFs
            for rpf in self.get_all_rpfs():
                if not hasattr(rpf, 'AllEntries') or not rpf.AllEntries:
                    continue
                    
                for entry in rpf.AllEntries:
                    # Skip non-YMAP files
                    if not entry.Name.lower().endswith('.ymap'):
                        continue
                        
                    # Check if entry matches pattern
                    if self._matches_pattern(entry.Name, pattern):
                        matching_files.append(entry.Path)
                    
        except Exception as e:
            logger.error(f"Error finding YMAP files: {e}")
            logger.debug("Stack trace:", exc_info=True)
            
        return matching_files

    def read_ymap(self, path: str) -> Optional[object]:
        """
        Read a YMAP file
        
        Args:
            path (str): Path to the YMAP file
            
        Returns:
            Optional[object]: YMAP file if found, None otherwise
        """
        try:
            # Try to get from game cache first
            ymap = self.rpf_reader.game_cache.GetYmap(canonicalize_cw_path(path, keep_forward_slashes=True))
            if ymap:
                logger.info(f"Loaded YMAP from cache: {path}")
                return ymap
                
            # If not in cache, try to load directly using RpfManager
            entry = self.rpf_reader.rpf_manager.GetEntry(canonicalize_cw_path(path, keep_forward_slashes=True))
            if entry:
                ymap = self.rpf_reader.rpf_manager.GetFile[self.rpf_reader.YmapFile](entry)
                if ymap:
                    logger.info(f"Loaded YMAP file: {path}")
                    return ymap
                    
            logger.warning(f"YMAP file not found: {path}")
            return None
            
        except Exception as e:
            logger.error(f"Error reading YMAP file {path}: {e}")
            return None

    def find_textures(self, pattern: str) -> Dict[str, Tuple[np.ndarray, str]]:
        """
        Find and load textures matching the given pattern
        
        Args:
            pattern (str): Pattern to match texture names against
            
        Returns:
            Dict[str, Tuple[np.ndarray, str]]: Dictionary of texture names to (pixel_data, format)
        """
        textures = {}
        
        try:
            # Search through all RPFs
            for rpf in self.get_all_rpfs():
                if not hasattr(rpf, 'AllEntries') or not rpf.AllEntries:
                    continue
                    
                # Skip non-texture related files
                rpf_path = str(rpf.Path).lower()
                if not any(tex_path in rpf_path for tex_path in ['textures', 'terrain']):
                    continue
                    
                for entry in rpf.AllEntries:
                    # Check if entry matches pattern and is a YTD file
                    if not entry.Name.lower().endswith('.ytd') or not self._matches_pattern(entry.Name, pattern):
                        continue
                        
                    # Load the YTD file
                    ytd_file = self.rpf_reader.get_ytd(entry.Path)  # Use full path instead of just name
                    if not ytd_file:
                        continue
                        
                    # Get textures from YTD file
                    ytd_textures = self.rpf_reader.get_ytd_textures(ytd_file)
                    if ytd_textures:
                        textures.update(ytd_textures)
                    
        except Exception as e:
            logger.error(f"Error finding textures: {e}")
            logger.debug("Stack trace:", exc_info=True)
            
        return textures

    def _matches_pattern(self, name: str, pattern: str) -> bool:
        """
        Check if a filename matches a pattern
        
        Args:
            name (str): Filename to check
            pattern (str): Pattern to match against
            
        Returns:
            bool: True if name matches pattern
        """
        try:
            import fnmatch
            return fnmatch.fnmatch(name.lower(), pattern.lower())
        except Exception as e:
            logger.error(f"Error matching pattern: {e}")
            return False
    
    def read_ytd(self, path: str) -> Optional[object]:
        """
        Read a YTD (texture dictionary) file
        
        Args:
            path (str): Path to the YTD file
            
        Returns:
            Optional[object]: YTD file if found, None otherwise
        """
        try:
            # Get the YTD file from RPF
            ytd_file = self.rpf_reader.get_ytd(path)
            if ytd_file:
                logger.info(f"Loaded YTD file: {path}")
                return ytd_file
            else:
                logger.warning(f"YTD file not found: {path}")
                return None
        except Exception as e:
            logger.error(f"Error reading YTD file {path}: {e}")
            return None
    
    def read_physics_dict(self, path: str) -> Optional[Dict]:
        """
        Read a physics dictionary file
        
        Args:
            path (str): Path to the physics dictionary file
            
        Returns:
            Optional[Dict]: Physics dictionary data if found, None otherwise
        """
        try:
            # Get the physics dictionary file from RPF
            phys_dict = self.rpf_reader.rpf_manager.GetFile[self.rpf_reader.PhysicsDictionaryFile](path)
            if phys_dict:
                logger.info(f"Loaded physics dictionary: {path}")
                return {
                    'name': phys_dict.Name,
                    'type': phys_dict.Type,
                    'data': phys_dict.Data
                }
            else:
                logger.warning(f"Physics dictionary not found: {path}")
                return None
        except Exception as e:
            logger.error(f"Error reading physics dictionary {path}: {e}")
            return None

    def _is_heightmap_file(self, path: str) -> bool:
        """Check if file is a heightmap"""
        # Heightmaps are typically .dat files in specific directories
        path_lower = path.lower()
        return (
            path_lower.endswith(".dat") and
            ("heightmap" in path_lower or
             "_hmap" in path_lower or
             "terrain" in path_lower)
        )

    def _is_terrain_texture(self, path: str) -> bool:
        """Check if file is a terrain texture"""
        # Terrain textures are typically .dds files in specific directories
        path_lower = path.lower()
        return (
            path_lower.endswith(".dds") and
            ("terrain" in path_lower or
             "_tex" in path_lower or
             "ground" in path_lower)
        )

    def _load_heightmap(self, path: str) -> Optional[HeightmapData]:
        """Load heightmap data from file"""
        try:
            # Get the heightmap using RpfManager's GetEntry and GetFile methods
            entry = self.rpf_reader.rpf_manager.GetEntry(path)
            if not entry:
                logger.warning(f"Could not find heightmap entry: {path}")
                return None
            
            # Get the heightmap data using CodeWalker's HeightmapFile
            heightmap_data = self.rpf_reader.get_heightmap(path)
            if not heightmap_data:
                logger.warning(f"Could not load heightmap data: {path}")
                return None
            
            min_heights, max_heights = heightmap_data
            
            # Convert to HeightmapData structure
            height, width = min_heights.shape
            # Use max_heights as the primary height data since it represents the surface
            height_data = max_heights.copy()
            
            # Calculate bounds
            min_z = float(np.min(min_heights))
            max_z = float(np.max(max_heights))
            
            # Create bounds - use width/height for x/y bounds
            bounds = Bounds(
                min_x=0.0,
                min_y=0.0,
                min_z=min_z,
                max_x=float(width),
                max_y=float(height),
                max_z=max_z
            )
            
            return HeightmapData(
                width=width,
                height=height,
                data=height_data,
                min_height=min_z,
                max_height=max_z,
                bounds=bounds
            )

        except Exception as e:
            logger.error(f"Error loading heightmap {path}: {str(e)}")
            logger.debug("Stack trace:", exc_info=True)
            return None

    def get_heightmap(self, path: str) -> Optional[HeightmapData]:
        """
        Get heightmap by path. If not already loaded, attempts to load it.
        
        Args:
            path (str): Path to the heightmap file
            
        Returns:
            Optional[HeightmapData]: Heightmap data if found and loaded successfully
        """
        # Check if already loaded
        if path in self.heightmaps:
            return self.heightmaps[path]
        
        # Try to load it
        heightmap = self._load_heightmap(path)
        if heightmap:
            self.heightmaps[path] = heightmap
        
        return heightmap

    def _load_texture(self, path: str) -> Optional[np.ndarray]:
        """Load texture data from file"""
        try:
            # Read raw texture data
            data = self.rpf_reader.read_file(path)
            if not data:
                return None

            # Initialize DDS reader
            dds_reader = DDSIO()
            
            # Load texture
            texture = dds_reader.load(data)
            if texture is None:
                return None

            return texture

        except Exception as e:
            logger.error(f"Error loading texture {path}: {str(e)}")
            return None

    def get_texture(self, path: str) -> Optional[np.ndarray]:
        """Get texture by path"""
        return self.textures.get(path)

    def get_heightmap_paths(self) -> List[str]:
        """Get list of loaded heightmap paths"""
        return list(self.heightmaps.keys())

    def get_texture_paths(self) -> List[str]:
        """Get list of loaded texture paths"""
        return list(self.textures.keys())
    
    def _convert_texture_data(self, pixels: bytes, texture: Any) -> Optional[np.ndarray]:
        """
        Convert texture data to numpy array based on texture format
        
        Args:
            pixels (bytes): Raw pixel data
            texture (Any): Texture object with format information
            
        Returns:
            Optional[np.ndarray]: Converted texture data as numpy array
        """
        try:
            # Get texture format
            format_name = texture.Format.ToString()
            
            # Convert based on format
            if format_name == 'DXT1':
                # DXT1 format (RGB)
                img_data = np.frombuffer(pixels, dtype=np.uint8)
                img_data = img_data.reshape(texture.Height, texture.Width, 3)
            elif format_name in ['DXT3', 'DXT5']:
                # DXT3/DXT5 format (RGBA)
                img_data = np.frombuffer(pixels, dtype=np.uint8)
                img_data = img_data.reshape(texture.Height, texture.Width, 4)
            elif format_name == 'A8R8G8B8':
                # A8R8G8B8 format
                img_data = np.frombuffer(pixels, dtype=np.uint32)
                img_data = img_data.reshape(texture.Height, texture.Width)
                # Convert to RGBA
                img_data = np.stack([
                    (img_data >> 16) & 0xFF,  # R
                    (img_data >> 8) & 0xFF,   # G
                    img_data & 0xFF,          # B
                    (img_data >> 24) & 0xFF   # A
                ], axis=-1)
            else:
                logger.warning(f"Unsupported texture format: {format_name}")
                return None
                
            return img_data
            
        except Exception as e:
            logger.error(f"Error converting texture data: {e}")
            return None

    def find_rpf_file(self, path: str, exact_path_only: bool = False) -> Optional[object]:
        """
        Find an RPF file by path
        
        Args:
            path (str): Path to the RPF file
            exact_path_only (bool): Whether to only match exact paths
            
        Returns:
            Optional[object]: RPF file if found, None otherwise
        """
        try:
            # Try to get from dictionary first
            rpf_file = self.rpf_reader.rpf_manager.FindRpfFile(path, exact_path_only)
            if rpf_file:
                return rpf_file
                
            # If not found and not exact path only, try searching by name
            if not exact_path_only:
                path_lower = path.lower()
                for rpf in self.get_all_rpfs():
                    if rpf.Name.lower() == path_lower or rpf.Path.lower() == path_lower:
                        return rpf
                        
            return None
            
        except Exception as e:
            logger.error(f"Error finding RPF file {path}: {e}")
            return None 
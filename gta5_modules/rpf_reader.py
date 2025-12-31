"""
RPF Reader for GTA5
------------------
Handles reading and extracting data from RPF files.
"""

import os
import logging
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Any
import numpy as np
from PIL import Image
import io

import clr
import System
from System.Numerics import Vector2, Vector3, Vector4

from .dll_manager import DllManager
from .heightmap import HeightmapFile

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class RpfReader:
    """Handles reading and extracting data from RPF files"""
    
    def __init__(self, game_path: str, dll_manager: DllManager):
        """
        Initialize RPF reader
        
        Args:
            game_path: Path to GTA5 installation directory
            dll_manager: DllManager instance to use for CodeWalker resources
        """
        self.game_path = Path(game_path)
        
        # Store DLL manager
        self.dll_manager = dll_manager
        if not self.dll_manager.initialized:
            raise RuntimeError("DLL manager not initialized")
        
        # Get shared instances
        self.rpf_manager = self.dll_manager.get_rpf_manager()
        self.game_cache = self.dll_manager.get_game_cache()
        
        # Initialize file type classes
        self.heightmap_file = self.dll_manager.HeightmapFile()
        self.ytd_file = self.dll_manager.YtdFile()
        
    def get_heightmap(self, path: str) -> Optional[Tuple[np.ndarray, np.ndarray]]:
        """
        Get heightmap data from RPF file
        
        Args:
            path: Path to heightmap file
            
        Returns:
            Tuple of (min_heights, max_heights) arrays if successful, None otherwise
        """
        try:
            logger.info(f"Attempting to load heightmap: {path}")
            
            # Get heightmap data through RPF manager
            entry = self.rpf_manager.GetEntry(path)
            if not entry:
                logger.warning(f"Could not find heightmap entry: {path}")
                return None
                
            logger.info(f"Found heightmap entry: {entry.Name}")
            
            data = self.rpf_manager.GetFileData(path)
            if not data:
                logger.warning(f"No data found for heightmap: {path}")
                return None
                
            logger.info(f"Got heightmap data: {len(data)} bytes")
            
            # Convert C# array to Python bytes
            data_bytes = bytes(data)
            
            # Create HeightmapFile instance and parse data
            heightmap = HeightmapFile(data_bytes, self.dll_manager)
            
            # Return the height arrays
            return heightmap.min_heights, heightmap.max_heights
            
        except Exception as e:
            logger.error(f"Failed to get heightmap {path}: {e}")
            logger.debug("Stack trace:", exc_info=True)
            return None
            
    def get_texture(self, path: str) -> Optional[Dict[str, np.ndarray]]:
        """
        Get texture data from RPF file
        
        Args:
            path: Path to texture file
            
        Returns:
            Dict of texture arrays if successful, None otherwise
        """
        try:
            # Get texture data through RPF manager
            entry = self.rpf_manager.GetEntry(path)
            if not entry:
                logger.warning(f"Could not find texture entry: {path}")
                return None
                
            data = self.rpf_manager.GetFileData(path)
            if not data:
                logger.warning(f"No data found for texture: {path}")
                return None
                
            # Load YTD file
            self.ytd_file.Load(data, entry)
            
            # Get texture data
            textures = {}
            
            # Process each texture in the YTD file
            for texture in self.ytd_file.TextureDict.Textures.data_items:
                try:
                    # Get texture data using DDSIO
                    pixels = self.dll_manager.DDSIO.GetPixels(texture, 0)  # Get base mip level
                    if not pixels:
                        continue
                        
                    # Convert to numpy array
                    width = texture.Width
                    height = texture.Height
                    img_data = np.frombuffer(bytes(pixels), dtype=np.uint8)
                    
                    # Reshape based on format
                    format_name = texture.Format.ToString()
                    if format_name in ['A8R8G8B8', 'D3DFMT_A8R8G8B8']:
                        img_data = img_data.reshape(height, width, 4)
                    elif format_name in ['DXT1', 'D3DFMT_DXT1']:
                        img_data = img_data.reshape(height, width, 3)
                    elif format_name in ['DXT3', 'DXT5', 'D3DFMT_DXT3', 'D3DFMT_DXT5']:
                        img_data = img_data.reshape(height, width, 4)
                    else:
                        logger.warning(f"Unsupported texture format: {format_name}")
                        continue
                    
                    # Check if this is a normal map
                    is_normal = texture.Name.lower().endswith('_n')
                    
                    # Store texture
                    if is_normal:
                        textures['normal'] = img_data
                    else:
                        textures['diffuse'] = img_data
                        
                except Exception as e:
                    logger.error(f"Error processing texture {texture.Name}: {e}")
                    continue
            
            return textures
            
        except Exception as e:
            logger.error(f"Failed to get texture {path}: {e}")
            return None

    def get_ytd_textures(self, ytd_file: Any) -> Dict[str, Tuple[np.ndarray, str]]:
        """
        Extract textures from an already-loaded CodeWalker YtdFile (or similar) into numpy arrays.

        Returns:
            Dict[name -> (image_uint8[h,w,c], format_string)]

        Notes:
        - `CodeWalker.Core`'s `DDSIO.GetPixels(texture, mip)` generally returns decompressed RGBA bytes.
        - This method is used by exporters (e.g. `export_drawables_for_chunk.py`) that already have a
          loaded YTD via `GameFileCache.GetYtd(hash)`.
        """
        out: Dict[str, Tuple[np.ndarray, str]] = {}
        try:
            texdict = getattr(ytd_file, "TextureDict", None)
            textures_arr = getattr(texdict, "Textures", None) if texdict is not None else None
            data_items = getattr(textures_arr, "data_items", None) if textures_arr is not None else None
            if not data_items:
                return out

            for tex in list(data_items):
                try:
                    name = str(getattr(tex, "Name", "") or "")
                    width = int(getattr(tex, "Width", 0) or 0)
                    height = int(getattr(tex, "Height", 0) or 0)
                    fmt = str(getattr(getattr(tex, "Format", None), "ToString", lambda: getattr(tex, "Format", ""))())
                    if not name or width <= 0 or height <= 0:
                        continue

                    pixels_net = self.dll_manager.DDSIO.GetPixels(tex, 0)
                    if not pixels_net:
                        continue
                    pixels = bytes(pixels_net)

                    # Best-effort reshape. Prefer RGBA if sizes match.
                    if len(pixels) == width * height * 4:
                        arr = np.frombuffer(pixels, dtype=np.uint8).reshape((height, width, 4))
                    elif len(pixels) == width * height * 3:
                        arr = np.frombuffer(pixels, dtype=np.uint8).reshape((height, width, 3))
                    else:
                        # Fallback: let PIL interpret as RGBA; if this fails we skip the texture.
                        img = Image.frombytes("RGBA", (width, height), pixels)
                        arr = np.asarray(img, dtype=np.uint8)

                    out[name] = (arr, fmt)
                except Exception:
                    continue

        except Exception as e:
            logger.error(f"Error extracting YTD textures: {e}")

        return out

    def get_file_data(self, file_path: str) -> Optional[bytes]:
        """
        Get raw file data from RPF archive
        
        Args:
            file_path: Path to file in RPF archive
            
        Returns:
            Raw file data if successful, None otherwise
        """
        try:
            # Find file entry
            entry = self._find_file_entry(file_path)
            if not entry:
                logger.warning(f"File not found: {file_path}")
                return None
                
            logger.info(f"Found file entry: {entry.Name}")
            logger.info(f"File size: {entry.FileSize}")
            logger.info(f"File offset: {entry.FileOffset}")
            
            # Read file data
            data_bytes = self._read_file_data(entry)
            if not data_bytes:
                return None
                
            # Check data size
            if len(data_bytes) != entry.FileSize:
                logger.warning(f"Data size mismatch. Expected {entry.FileSize}, got {len(data_bytes)}")
                # Trim data to expected size
                data_bytes = data_bytes[:entry.FileSize]
            
            return data_bytes
            
        except Exception as e:
            logger.error(f"Failed to get file data: {e}")
            logger.debug("Stack trace:", exc_info=True)
            return None

    def _find_file_entry(self, file_path: str) -> Optional[Any]:
        """
        Find file entry in RPF archives
        
        Args:
            file_path: Path to file in RPF archive
            
        Returns:
            RpfFileEntry if found, None otherwise
        """
        try:
            # Get file entry through RPF manager
            entry = self.rpf_manager.GetEntry(file_path)
            if not entry:
                logger.warning(f"Could not find file entry: {file_path}")
                return None
                
            return entry
            
        except Exception as e:
            logger.error(f"Error finding file entry: {e}")
            return None
            
    def _read_file_data(self, entry: Any) -> Optional[bytes]:
        """
        Read file data from RPF entry
        
        Args:
            entry: RpfFileEntry to read from
            
        Returns:
            Raw file data if successful, None otherwise
        """
        try:
            # Get file data through RPF manager
            data = self.rpf_manager.GetFileData(entry.Path)
            if not data:
                logger.warning(f"No data found for file: {entry.Path}")
                return None
                
            # Convert C# array to Python bytes
            data_bytes = bytes(data)
            logger.info(f"Extracted data size: {len(data_bytes)} bytes")
            
            return data_bytes
            
        except Exception as e:
            logger.error(f"Error reading file data: {e}")
            return None 
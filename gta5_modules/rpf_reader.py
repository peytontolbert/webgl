"""
RPF Reader for GTA5
------------------
Handles reading and extracting data from RPF files.
"""

import logging
from pathlib import Path
from typing import Dict, Tuple, Optional, Any
import numpy as np

from .dll_manager import DllManager, canonicalize_cw_path
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
            
            # Get heightmap data through RPF manager (try both relative + GTA-root-prefixed forms).
            entry = self._find_file_entry(path)
            if not entry:
                logger.warning(f"Could not find heightmap entry: {path}")
                return None
                
            logger.info(f"Found heightmap entry: {entry.Name}")
            
            # Prefer entry.Path once resolved (some CodeWalker builds store absolute-prefixed keys).
            data = self.rpf_manager.GetFileData(canonicalize_cw_path(getattr(entry, "Path", ""), keep_forward_slashes=True))
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
            # Get texture data through RPF manager (try both relative + GTA-root-prefixed forms).
            entry = self._find_file_entry(path)
            if not entry:
                logger.warning(f"Could not find texture entry: {path}")
                return None
                
            data = self.rpf_manager.GetFileData(canonicalize_cw_path(getattr(entry, "Path", ""), keep_forward_slashes=True))
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

    def get_ytd(self, path: str) -> Optional[Any]:
        """
        Load a YTD (texture dictionary) file and return the loaded CodeWalker YtdFile object.

        Note: the returned object is independent from this reader's internal `self.ytd_file`
        to avoid accidental mutation between calls.
        """
        try:
            entry = self._find_file_entry(path)
            if not entry:
                logger.warning(f"Could not find YTD entry: {path}")
                return None

            data = self.rpf_manager.GetFileData(canonicalize_cw_path(getattr(entry, "Path", ""), keep_forward_slashes=True))
            if not data:
                logger.warning(f"No data found for YTD: {path}")
                return None

            ytd_file = self.dll_manager.YtdFile()
            ytd_file.Load(data, entry)
            return ytd_file

        except Exception as e:
            logger.error(f"Failed to load YTD {path}: {e}")
            logger.debug("Stack trace:", exc_info=True)
            return None

    def get_ytd_textures(self, ytd_file: Any) -> Dict[str, Tuple[np.ndarray, str]]:
        """
        Extract all textures from a loaded CodeWalker YtdFile.

        Returns:
            Dict[name, (image_array, format_name)]
        """
        textures: Dict[str, Tuple[np.ndarray, str]] = {}
        try:
            if not ytd_file or not hasattr(ytd_file, "TextureDict") or not ytd_file.TextureDict:
                return textures

            # CodeWalker texture dicts have multiple representations depending on how they were loaded.
            # In CodeWalker itself, textures are typically accessed via TextureDict.Lookup(...) and/or
            # TextureDict.Dict (a dictionary keyed by hash). Some builds also expose TextureDict.Textures.
            #
            # We try the following in order:
            # 1) TextureDict.Textures (list-like; common in some pythonnet projections)
            # 2) TextureDict.Dict.Values (dictionary values; matches CodeWalker rendering path)
            items = None

            # 1) TextureDict.Textures
            tex_list = getattr(ytd_file.TextureDict, "Textures", None)
            if tex_list is not None:
                items = getattr(tex_list, "data_items", None)
                if not items:
                    try:
                        items = list(tex_list)
                    except Exception:
                        items = None

            # 2) TextureDict.Dict.Values / Dict iteration
            if not items:
                d = getattr(ytd_file.TextureDict, "Dict", None)
                if d is not None:
                    vals = getattr(d, "Values", None)
                    if vals is not None:
                        try:
                            items = list(vals)
                        except Exception:
                            items = None
                    if not items:
                        # Some dictionary projections iterate KeyValuePairs.
                        try:
                            kvs = list(d)
                            extracted = []
                            for kv in kvs:
                                try:
                                    v = getattr(kv, "Value", None)
                                    if v is not None:
                                        extracted.append(v)
                                except Exception:
                                    continue
                            items = extracted or None
                        except Exception:
                            items = None

            if not items:
                return textures

            for tex in items:
                if not tex:
                    continue
                try:
                    name = str(getattr(tex, "Name", "")).strip()
                    if not name:
                        continue

                    width = int(getattr(tex, "Width", 0))
                    height = int(getattr(tex, "Height", 0))
                    if width <= 0 or height <= 0:
                        continue

                    fmt_obj = getattr(tex, "Format", None)
                    format_name = fmt_obj.ToString() if fmt_obj and hasattr(fmt_obj, "ToString") else str(fmt_obj)

                    # Prefer CodeWalker's DDSIO.GetPixels(tex, mip) path.
                    # This matches CodeWalker.Forms.YtdForm and tends to work more reliably than tex.GetPixels(...)
                    # for textures loaded via GameFileCache.
                    pixels = None
                    try:
                        ddsio = getattr(self.dll_manager, "DDSIO", None)
                        if ddsio is not None and hasattr(ddsio, "GetPixels"):
                            pixels = ddsio.GetPixels(tex, 0)
                    except Exception:
                        pixels = None
                    # Fallback to texture-native GetPixels.
                    if not pixels:
                        try:
                            if hasattr(tex, "GetPixels"):
                                pixels = tex.GetPixels(0)
                        except Exception:
                            pixels = None
                    if not pixels:
                        continue

                    buf = bytes(pixels)
                    arr = np.frombuffer(buf, dtype=np.uint8)
                    # CodeWalker DDSIO.GetPixels(tex, mip) is used in YtdForm with a 32bpp ARGB bitmap.
                    # The returned buffer can be padded per-row (stride). Handle both packed and stride buffers.
                    img = None
                    # 4-channel packed
                    if arr.size == width * height * 4:
                        img = arr.reshape(height, width, 4)
                    # 3-channel packed
                    elif arr.size == width * height * 3:
                        img = arr.reshape(height, width, 3)
                    else:
                        # Try to interpret as stride buffer.
                        stride = int(getattr(tex, "Stride", 0) or 0)
                        # Prefer the texture's reported stride (bytes per row) when it matches.
                        if stride > 0 and (arr.size == stride * height):
                            if (stride % 4) == 0:
                                row_px = stride // 4
                                if row_px >= width:
                                    img = arr.reshape(height, row_px, 4)[:, :width, :]
                            elif (stride % 3) == 0:
                                row_px = stride // 3
                                if row_px >= width:
                                    img = arr.reshape(height, row_px, 3)[:, :width, :]
                        # Fallback: infer stride from buffer length.
                        if img is None and height > 0 and (arr.size % height) == 0:
                            row_stride = arr.size // height
                            if (row_stride % 4) == 0:
                                row_px = row_stride // 4
                                if row_px >= width:
                                    img = arr.reshape(height, row_px, 4)[:, :width, :]
                            elif (row_stride % 3) == 0:
                                row_px = row_stride // 3
                                if row_px >= width:
                                    img = arr.reshape(height, row_px, 3)[:, :width, :]

                    if img is None:
                        logger.debug(f"Skipping texture {name}: unexpected pixel count {arr.size} for {width}x{height}")
                        continue

                    # DDSIO output is typically BGRA (to match PixelFormat.Format32bppArgb).
                    # Convert to RGBA for the web viewer pipeline.
                    try:
                        if img.shape[2] == 4:
                            img = img[:, :, [2, 1, 0, 3]]
                        elif img.shape[2] == 3:
                            img = img[:, :, [2, 1, 0]]
                    except Exception:
                        pass

                    textures[name] = (img, format_name)
                except Exception as e:
                    logger.debug(f"Error extracting texture from YTD: {e}", exc_info=True)
                    continue

            return textures

        except Exception as e:
            logger.error(f"Failed to extract YTD textures: {e}")
            logger.debug("Stack trace:", exc_info=True)
            return textures

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
                # IMPORTANT:
                # For some RPF entries, `FileSize` may refer to compressed/on-disk size while
                # `RpfManager.GetFileData(...)` returns decompressed bytes. Trimming here can
                # corrupt the data and break downstream parsers (eg waterheight.dat).
                # Keep the full buffer and let higher-level code validate/parse it.
            
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
            s = str(file_path or "").strip()
            if not s:
                return None

            # CodeWalker path conventions:
            # - RPF-internal paths use backslashes: common.rpf\\data\\levels\\...
            # - On Linux, some CodeWalker builds store entry keys prefixed with the GTA root:
            #     /data/.../gta5/common.rpf\\data\\levels\\...
            # - For nested RPFS like update/update.rpf, CodeWalker often uses the *filesystem* path
            #   to the RPF (with POSIX slashes) followed by backslash-separated inner paths:
            #     /data/.../gta5/update/update.rpf\\common\\data\\...
            #
            # So try both forms.
            candidates = []
            candidates.append(s)
            game_root = str(self.game_path)
            if game_root:
                game_root = game_root.rstrip("/")

            def _prefix_game_root(rel: str) -> str:
                # Do NOT use Path join for rel, because rel contains backslashes that are meaningful
                # to CodeWalker (RPF internal paths) and should not be treated as OS separators.
                return f"{game_root}/{rel}" if game_root else rel

            # Prefix with the physical game dir (raw form).
            if game_root:
                candidates.append(_prefix_game_root(s))

            # Also try normalizing any forward slashes to backslashes for the RPF portion.
            # (Do NOT touch the physical prefix.)
            s2 = s.replace("/", "\\")
            if s2 != s:
                candidates.append(s2)
                if game_root:
                    candidates.append(_prefix_game_root(s2))

            # For paths that include an .rpf segment, also try a filesystem-normalized prefix up to the .rpf.
            # Example:
            #   "update\\update.rpf\\common\\data\\levels\\gta5\\heightmap.dat"
            # becomes:
            #   "<gta_root>/update/update.rpf\\common\\data\\levels\\gta5\\heightmap.dat"
            s_low = s.lower()
            marker = ".rpf\\"
            mi = s_low.find(marker)
            if mi >= 0 and game_root:
                prefix = s[: mi + 4]  # includes ".rpf"
                rest = s[mi + 4 :]    # begins with "\\..."
                fs_prefix = prefix.replace("\\", "/")
                candidates.append(f"{game_root}/{fs_prefix}{rest}")

            seen = set()
            for cand in candidates:
                if not cand or cand in seen:
                    continue
                seen.add(cand)
                try:
                    entry = self.rpf_manager.GetEntry(canonicalize_cw_path(cand, keep_forward_slashes=True))
                except Exception:
                    entry = None
                if entry:
                    return entry

            logger.warning(f"Could not find file entry: {file_path}")
            return None

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
            data = self.rpf_manager.GetFileData(canonicalize_cw_path(getattr(entry, "Path", ""), keep_forward_slashes=True))
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
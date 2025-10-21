"""
DLL Manager for GTA5
-------------------
Manages CodeWalker DLL integration and shared resources.
"""

import os
import logging
import time
import ctypes
from pathlib import Path
from typing import Optional, Tuple, Any, Dict, List, Union

# Initialize Python.NET
import clr
clr.AddReference("System")
clr.AddReference("System.Core")
clr.AddReference("System.Numerics")

import System
from System import Action
from System.IO import Directory, SearchOption
from System.Numerics import Vector2, Vector3, Vector4

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class DllManager:
    """Manages CodeWalker DLL integration and shared resources"""
    
    _instance = None
    _initialized = False
    
    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super(DllManager, cls).__new__(cls)
        return cls._instance
    
    def __init__(self, game_path: str):
        """
        Initialize DLL manager
        
        Args:
            game_path: Path to GTA5 installation directory
        """
        if self._initialized:
            return
            
        self.game_path = Path(game_path)
        self.initialized = False
        self.dll = None
        
        # CodeWalker types - will be set in initialize()
        # Core types
        self.RpfFile = None
        self.RpfFileEntry = None
        self.GameFileCache = None
        self.GTA5Keys = None
        self.RpfManager = None
        
        # File types
        self.HeightmapFile = None
        self.YtdFile = None
        self.YmapFile = None
        self.YdrFile = None
        self.GtxdFile = None
        
        # Utility types
        self.DDSIO = None
        
        # Initialize DLL
        if not self._load_dll():
            logger.error("Failed to load DLL")
            return
            
        # Initialize function signatures
        self._init_functions()
        
        # Initialize Space class
        self._init_space()
        
        self._initialized = True
        
    def _load_dll(self) -> bool:
        """Load the GTA5 DLL"""
        try:
            # Get the path to compiled_cw directory
            cw_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "compiled_cw")
            
            # Load SharpDX dependencies first
            clr.AddReference(os.path.join(cw_path, "SharpDX.dll"))
            clr.AddReference(os.path.join(cw_path, "SharpDX.Direct3D11.dll"))
            clr.AddReference(os.path.join(cw_path, "SharpDX.DXGI.dll"))
            clr.AddReference(os.path.join(cw_path, "SharpDX.Mathematics.dll"))
            
            # Now load CodeWalker.Core
            clr.AddReference(os.path.join(cw_path, "CodeWalker.Core.dll"))
            
            from CodeWalker.GameFiles import (
                RpfManager, HeightmapFile, GTA5Keys,
                RpfFile, RpfFileEntry, GameFileCache,
                YtdFile, YmapFile, YdrFile,
                WatermapFile, YnvFile, YndFile
            )
            from CodeWalker.World import (
                Heightmaps, Entity, Space, Water,
                Watermaps, Camera, Weather, Clouds
            )
            
            # Game file types
            self.RpfManager = RpfManager
            self.HeightmapFile = HeightmapFile
            self.Heightmaps = Heightmaps
            self.GTA5Keys = GTA5Keys
            self.RpfFile = RpfFile
            self.RpfFileEntry = RpfFileEntry
            self.GameFileCache = GameFileCache
            self.YtdFile = YtdFile
            self.YmapFile = YmapFile
            self.YdrFile = YdrFile
            self.WatermapFile = WatermapFile
            self.YnvFile = YnvFile
            self.YndFile = YndFile
            
            # World types
            self.Entity = Entity
            self.Space = Space
            self.Water = Water
            self.Watermaps = Watermaps
            self.Camera = Camera
            self.Weather = Weather
            self.Clouds = Clouds
            
            # Initialize components in correct order
            # 1. Initialize GTA5Keys first - this sets up all encryption keys
            self.GTA5Keys.LoadFromPath(str(self.game_path))
            
            # 2. Initialize GameFileCache with required parameters
            # - size: 2GB cache size (2 * 1024 * 1024 * 1024)
            # - cacheTime: 1 hour (3600 seconds)
            # - folder: GTA5 installation path
            # - gen9: False (not needed for our use case)
            # - dlc: empty string (no DLC)
            # - mods: False (no mods)
            # - excludeFolders: empty string (no excluded folders)
            self.game_file_cache = GameFileCache(
                2 * 1024 * 1024 * 1024,  # 2GB cache size
                3600,                     # 1 hour cache time
                str(self.game_path),      # GTA5 folder
                False,                    # gen9
                "",                       # dlc
                False,                    # mods
                ""                        # excludeFolders
            )
            
            # 3. Create callback functions for status updates and error logging
            def update_status(msg: str):
                logger.info(f"RpfManager: {msg}")
                
            def error_log(msg: str):
                logger.error(f"RpfManager: {msg}")
                
            # Convert callbacks to .NET Action delegates
            update_status_action = Action[str](update_status)
            error_log_action = Action[str](error_log)
            
            # 4. Create and initialize RpfManager in one step
            self.rpf_manager = RpfManager()
            self.rpf_manager.Init(
                str(self.game_path),  # folder path
                False,                # gen9 (not needed for our use case)
                update_status_action, # status callback
                error_log_action,     # error callback
                False,                # rootOnly (we want all directories)
                True                  # buildIndex (we need the index)
            )
            
            # 5. Set initialized flag
            self.initialized = True
            
            # 6. Load utility files
            if not self._load_utility_files():
                logger.warning("Failed to load some utility files")
            
            return True
            
        except Exception as e:
            logger.error(f"Error loading DLL: {e}")
            return False
            
    def _init_functions(self):
        """Initialize function signatures"""
        try:
            # No need to initialize function signatures for .NET assembly
            pass
            
        except Exception as e:
            logger.error(f"Error initializing function signatures: {e}")
            
    def _init_space(self):
        """Initialize Space class"""
        try:
            # Initialize Heightmaps
            self.space_instance = self.Heightmaps()
            if not self.space_instance:
                logger.error("Failed to initialize Heightmaps")
                return False
                
            return True
            
        except Exception as e:
            logger.error(f"Error initializing Heightmaps: {e}")
            return False
            
    def get_space_instance(self) -> Optional[Any]:
        """Get Heightmaps instance"""
        return self.space_instance
        
    def release_space_instance(self, handle: Any):
        """Release Heightmaps instance"""
        if handle:
            # Heightmaps doesn't have Dispose, just set to None
            self.space_instance = None
            
    def get_terrain_bounds(self, space_handle: Any) -> Optional[List[float]]:
        """Get terrain bounds from Heightmaps"""
        try:
            bounds = space_handle.GetBounds()
            return [bounds.Min.X, bounds.Min.Y, bounds.Min.Z,
                   bounds.Max.X, bounds.Max.Y, bounds.Max.Z]
            
        except Exception as e:
            logger.error(f"Error getting terrain bounds: {e}")
            return None
            
    def get_terrain_width(self) -> int:
        """Get terrain width"""
        return self.space_instance.Width
        
    def get_terrain_height(self) -> int:
        """Get terrain height"""
        return self.space_instance.Height
        
    def get_terrain_height_at(self, space_handle: Any, x: int, y: int) -> float:
        """Get terrain height at given coordinates"""
        return space_handle.GetHeight(x, y)
        
    def get_terrain_normal(self, space_handle: Any, x: int, y: int) -> Optional[List[float]]:
        """Get terrain normal at given coordinates"""
        try:
            normal = space_handle.GetNormal(x, y)
            return [normal.X, normal.Y, normal.Z]
            
        except Exception as e:
            logger.error(f"Error getting terrain normal: {e}")
            return None
            
    def get_terrain_cell(self, space_handle: Any, x: int, y: int) -> Optional[List[float]]:
        """Get terrain cell data at given coordinates"""
        try:
            cell = space_handle.GetCell(x, y)
            return [
                cell.Height,
                cell.Normal.X, cell.Normal.Y, cell.Normal.Z,
                cell.TextureIndex,
                cell.LodLevel,
                cell.Flags
            ]
            
        except Exception as e:
            logger.error(f"Error getting terrain cell: {e}")
            return None
            
    def get_terrain_lod_level(self, space_handle: Any, x: int, y: int) -> int:
        """Get terrain LOD level at given coordinates"""
        return space_handle.GetLodLevel(x, y)
        
    def get_terrain_texture_index(self, space_handle: Any, x: int, y: int) -> int:
        """Get terrain texture index at given coordinates"""
        return space_handle.GetTextureIndex(x, y)
        
    def get_rpf_manager(self) -> Any:
        """Get the RPF manager instance"""
        return self.rpf_manager
        
    def get_game_cache(self) -> Any:
        """Get the game file cache instance"""
        return self.game_file_cache
        
    def cleanup(self):
        """Clean up DLL resources"""
        try:
            if hasattr(self, 'space_instance') and self.space_instance:
                self.release_space_instance(self.space_instance)
            if self.dll:
                self.dll = None
            self.initialized = False
            DllManager._initialized = False
            logger.info("Cleaned up DLL resources")
        except Exception as e:
            logger.error(f"Error during cleanup: {e}")

    def get_ymap_file(self, path_or_data: Union[str, bytes]) -> Optional[Any]:
        """
        Create a YMAP file object from a path or data
        
        Args:
            path_or_data: Path to the YMAP file or raw YMAP data
            
        Returns:
            YMAP file object
        """
        try:
            if not self.YmapFile:
                logger.error("YmapFile type not initialized")
                return None
                
            if isinstance(path_or_data, str):
                # Get the file entry first
                entry = self.rpf_manager.GetEntry(path_or_data)
                if not entry:
                    logger.error(f"Failed to get YMAP file entry: {path_or_data}")
                    return None
                    
                # Load data into YMAP file using RpfManager's GetFile method
                ymap_file = self.rpf_manager.GetFile[self.YmapFile](entry)
                if not ymap_file:
                    logger.error(f"Failed to load YMAP file data: {path_or_data}")
                    return None
                    
                return ymap_file
            else:
                # Create YMAP file directly from data
                ymap_file = self.YmapFile()
                if not ymap_file.Load(path_or_data):
                    logger.error("Failed to load YMAP from data")
                    return None
                    
                return ymap_file
                
        except Exception as e:
            logger.error(f"Failed to create YMAP file object: {e}")
            return None
            
    def get_ymap_from_path(self, path: str) -> Optional[Any]:
        """
        Get a YMAP file from a path
        
        Args:
            path: Path to the YMAP file
            
        Returns:
            YMAP file object if successful, None otherwise
        """
        try:
            if not self.rpf_manager:
                logger.error("RpfManager not initialized")
                return None
                
            # Get the file entry
            entry = self.rpf_manager.GetEntry(path)
            if not entry:
                logger.warning(f"YMAP entry not found: {path}")
                return None
                
            # Get the YMAP file using RpfManager's GetFile method
            ymap_file = self.rpf_manager.GetFile[self.YmapFile](entry)
            if not ymap_file:
                logger.warning(f"Failed to load YMAP file: {path}")
                return None
                
            return ymap_file
            
        except Exception as e:
            logger.error(f"Error getting YMAP file from path {path}: {e}")
            return None
            
    def get_ymap_from_cache(self, hash_value: int) -> Optional[Any]:
        """
        Get a YMAP file from cache
        
        Args:
            hash_value: Hash of the YMAP file
            
        Returns:
            YMAP file object if successful, None otherwise
        """
        try:
            if not self.game_file_cache:
                logger.error("GameFileCache not initialized")
                return None
                
            # Get YMAP from cache
            ymap_file = self.game_file_cache.GetYmap(hash_value)
            if not ymap_file:
                logger.warning(f"YMAP not found in cache: {hash_value}")
                return None
                
            return ymap_file
            
        except Exception as e:
            logger.error(f"Error getting YMAP from cache: {e}")
            return None

    def _load_utility_files(self) -> bool:
        """Load and parse utility files from compiled_cw directory"""
        try:
            cw_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "compiled_cw")
            
            # Load strings.txt for shader names
            strings_path = os.path.join(cw_path, "strings.txt")
            if os.path.exists(strings_path):
                with open(strings_path, 'r', encoding='utf-8') as f:
                    self.shader_strings = [line.strip() for line in f if line.strip()]
                logger.info(f"Loaded {len(self.shader_strings)} shader strings")
            
            # Load magic.dat for file signatures
            magic_path = os.path.join(cw_path, "magic.dat")
            if os.path.exists(magic_path):
                with open(magic_path, 'rb') as f:
                    self.magic_data = f.read()
                logger.info(f"Loaded magic.dat ({len(self.magic_data)} bytes)")
            
            # Load shader conversion XML
            shader_xml_path = os.path.join(cw_path, "ShadersGen9Conversion.xml")
            if os.path.exists(shader_xml_path):
                import xml.etree.ElementTree as ET
                self.shader_tree = ET.parse(shader_xml_path)
                self.shader_root = self.shader_tree.getroot()
                logger.info("Loaded shader conversion XML")
            
            return True
            
        except Exception as e:
            logger.error(f"Error loading utility files: {e}")
            return False
            
    def get_shader_strings(self) -> List[str]:
        """Get list of shader strings"""
        return getattr(self, 'shader_strings', [])
        
    def get_magic_data(self) -> bytes:
        """Get magic.dat data"""
        return getattr(self, 'magic_data', b'')
        
    def get_shader_xml(self) -> Optional[Any]:
        """Get shader conversion XML root"""
        return getattr(self, 'shader_root', None)
        
    def get_shader_parameters(self, shader_name: str) -> Dict[str, Any]:
        """Get shader parameters from XML"""
        try:
            if not hasattr(self, 'shader_root'):
                return {}
                
            # Find shader in XML
            shader_elem = self.shader_root.find(f".//Shader[@Name='{shader_name}']")
            if shader_elem is None:
                return {}
                
            # Extract parameters
            params = {}
            for param in shader_elem.findall('Parameter'):
                name = param.get('Name')
                type = param.get('Type')
                value = param.get('Value')
                if name and type:
                    params[name] = {'type': type, 'value': value}
                    
            return params
            
        except Exception as e:
            logger.error(f"Error getting shader parameters: {e}")
            return {} 
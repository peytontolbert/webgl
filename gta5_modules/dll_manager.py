"""
DLL Manager for GTA5
-------------------
Manages CodeWalker DLL integration and shared resources.
"""

import os
import logging
from pathlib import Path
from typing import Optional, Any, Dict, List, Union

# Initialize Python.NET (robust against the conflicting PyPI `clr` package)
from .dotnet import clr
clr.AddReference("System")
clr.AddReference("System.Core")
clr.AddReference("System.Numerics")

from System import Action

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

        # Optional: full world/collision space (heavy). Initialized on-demand.
        self.world_space = None
        self.world_space_inited = False

        # Optional: water heightmap (waterheight.dat). Initialized on-demand.
        self._watermap_file = None  # WatermapFile instance
        self._watermap_inited = False
        
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

            # Utility helpers
            # DDSIO is used to decode CodeWalker texture objects into RGBA pixel buffers.
            # (RpfReader.get_ytd_textures depends on this.)
            try:
                try:
                    # CodeWalker.Core defines DDSIO under CodeWalker.Utils (see CodeWalker.Core/GameFiles/Utils/DDSIO.cs)
                    from CodeWalker.Utils import DDSIO as _DDSIO  # type: ignore
                except Exception:
                    _DDSIO = None
                self.DDSIO = _DDSIO
                # Some builds may expose DDSIO as an instantiable class; others as a static helper.
                if self.DDSIO is not None and not hasattr(self.DDSIO, "GetPixels"):
                    try:
                        self.DDSIO = self.DDSIO()
                    except Exception:
                        # Keep whatever we have; RpfReader will handle missing GetPixels gracefully.
                        pass
            except Exception:
                self.DDSIO = None
            
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
            # NOTE: GameFileCache.Init(...) is intentionally not called here because it can take time
            # and isn't required for terrain extraction. Call init_game_file_cache() when you need
            # archetypes/drawables (YDR/YDD/YFT) resolution.
            
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

    def init_game_file_cache(
        self,
        load_vehicles: bool = False,
        load_peds: bool = False,
        load_audio: bool = False,
        selected_dlc: Optional[str] = None,
        enable_mods: Optional[bool] = None,
    ) -> bool:
        """
        Initialize CodeWalker's GameFileCache.

        This is required for resolving archetype hashes into Archetype objects and then into drawables (YDR/YDD/YFT).
        It can take a while because it scans archives and builds indexes.
        """
        try:
            if not self.game_file_cache:
                logger.error("GameFileCache not created")
                return False

            # Apply DLC/mod selection BEFORE Init() so CodeWalker builds ActiveMapRpfFiles correctly.
            try:
                if selected_dlc is not None:
                    self.game_file_cache.SelectedDlc = str(selected_dlc)
                    # CodeWalker sets EnableDlc based on SelectedDlc in the constructor, but if we mutate it
                    # afterwards, update the flag too.
                    try:
                        self.game_file_cache.EnableDlc = bool(str(selected_dlc))
                    except Exception:
                        pass
            except Exception:
                pass
            try:
                if enable_mods is not None:
                    self.game_file_cache.EnableMods = bool(enable_mods)
            except Exception:
                pass

            # Configure for best archetype coverage
            try:
                self.game_file_cache.BuildExtendedJenkIndex = True
                self.game_file_cache.LoadArchetypes = True
                self.game_file_cache.LoadPeds = bool(load_peds)
                self.game_file_cache.LoadVehicles = bool(load_vehicles)
                self.game_file_cache.LoadAudio = bool(load_audio)
            except Exception:
                # Some builds may not expose all properties; ignore.
                pass

            def update_status(msg: str):
                logger.info(f"GameFileCache: {msg}")

            def error_log(msg: str):
                logger.error(f"GameFileCache: {msg}")

            update_status_action = Action[str](update_status)
            error_log_action = Action[str](error_log)

            self.game_file_cache.Init(update_status_action, error_log_action)

            # IMPORTANT: after GameFileCache.Init, CodeWalker has built its own RpfManager (`GameFileCache.RpfMan`)
            # with DLC overlay/patch logic and the dictionaries that `GameFileCache` depends on.
            # Prefer that instance as the authoritative VFS so other modules don't accidentally use a
            # different RpfManager with different override behavior / scan order.
            try:
                rpfman = getattr(self.game_file_cache, "RpfMan", None)
                if rpfman is not None:
                    self.rpf_manager = rpfman
            except Exception:
                # keep existing
                pass
            return True
        except Exception as e:
            logger.error(f"Error initializing GameFileCache: {e}")
            return False

    def get_game_file_cache(self):
        """Return the underlying CodeWalker.GameFiles.GameFileCache instance."""
        return self.game_file_cache
            
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

    def init_world_space(self) -> bool:
        """
        Initialize CodeWalker's full `CodeWalker.World.Space` (collision + map store).

        This is the closest thing to "game ground" we can query in CodeWalker:
        - YBN bounds (collision)
        - HD entity bounds (select)

        NOTE: this is expensive; it scans caches/manifests and builds spatial stores.
        """
        try:
            if self.world_space_inited and self.world_space is not None:
                return True
            if not self.game_file_cache:
                logger.error("GameFileCache not created")
                return False

            # GameFileCache.Init is required for Space.Init to have the cache dictionaries populated.
            if not getattr(self.game_file_cache, "IsInited", False):
                ok = self.init_game_file_cache()
                if not ok:
                    return False

            # Create Space and initialize it.

            def update_status(msg: str):
                logger.info(f"WorldSpace: {msg}")

            update_status_action = Action[str](update_status)
            sp = self.Space()
            sp.Init(self.game_file_cache, update_status_action)
            self.world_space = sp
            self.world_space_inited = True
            return True
        except Exception as e:
            logger.error(f"Failed to init world space: {e}")
            logger.debug("Stack trace:", exc_info=True)
            self.world_space = None
            self.world_space_inited = False
            return False

    def init_watermap(self) -> bool:
        """
        Initialize CodeWalker's water heightmap (waterheight.dat) via WatermapFile.

        This is separate from collision:
        - `Space.RayIntersect` does NOT intersect water surfaces.
        - GTA gameplay treats water as a special surface (swim, boats, etc.).

        We load the `WatermapFile` and use its decompressed `GridWatermapRefs` for sampling.
        """
        try:
            if self._watermap_inited and self._watermap_file is not None:
                return True
            if not self.game_file_cache:
                logger.error("GameFileCache not created")
                return False

            # Ensure caches are initialized so RpfMan is ready.
            if not getattr(self.game_file_cache, "IsInited", False):
                ok = self.init_game_file_cache()
                if not ok:
                    return False

            # Load waterheight.dat (same path CodeWalker.World.Watermaps uses).
            wmf = self.game_file_cache.RpfMan.GetFile[self.WatermapFile]("common.rpf\\data\\levels\\gta5\\waterheight.dat")
            if wmf is None:
                logger.error("Failed to load waterheight.dat (WatermapFile is None)")
                return False

            # Accessing GridWatermapRefs forces the decompressed grid to be available.
            # (WatermapFile decompresses during Load; this should already be populated.)
            self._watermap_file = wmf
            self._watermap_inited = True
            return True
        except Exception as e:
            logger.error(f"Failed to init watermap: {e}")
            logger.debug("Stack trace:", exc_info=True)
            self._watermap_file = None
            self._watermap_inited = False
            return False

    def get_water_height_at(self, x: float, y: float) -> Optional[float]:
        """
        Sample water surface height Z at (x,y) in GTA/data space using waterheight.dat.

        Returns:
          - float Z if the cell contains water
          - None if out of bounds or no water entry for that cell

        Notes:
          - This is a *surface* height, not collision.
          - Watermap grid coordinates use a top-left origin (CornerX, CornerY) with +X right and +Y down.
        """
        try:
            if not self._watermap_inited or self._watermap_file is None:
                ok = self.init_watermap()
                if not ok:
                    return None

            wmf = self._watermap_file
            # WatermapFile metadata
            cx = float(getattr(wmf, "CornerX", 0.0))
            cy = float(getattr(wmf, "CornerY", 0.0))
            tx = float(getattr(wmf, "TileX", 0.0))
            ty = float(getattr(wmf, "TileY", 0.0))
            w = int(getattr(wmf, "Width", 0))
            h = int(getattr(wmf, "Height", 0))
            if w <= 0 or h <= 0 or tx == 0.0 or ty == 0.0:
                return None

            # Convert world XY -> grid XY (top-left origin).
            # In CodeWalker.World.Watermaps, they compute:
            #   min = (CornerX, CornerY, 0)
            #   step = (TileX, -TileY, 1)
            # so increasing grid Y moves *down* in world Y (subtract TileY).
            gx = int((float(x) - cx) / tx)
            gy = int((cy - float(y)) / ty)
            if gx < 0 or gx >= w or gy < 0 or gy >= h:
                return None

            o = gy * w + gx
            refs = getattr(wmf, "GridWatermapRefs", None)
            if refs is None:
                return None
            harr = refs[o] if o >= 0 and o < len(refs) else None
            if harr is None or len(harr) == 0:
                return None

            h0 = harr[0]
            # WaterItemRef has: Type, Vector, Item, etc.
            wtype = getattr(h0, "Type", None)
            vec = getattr(h0, "Vector", None)
            item = getattr(h0, "Item", None)

            # Match CodeWalker.World.Watermaps.getHeight(...)
            # River: use ref vector Z; Lake/Pool: use item.Position.Z if available.
            try:
                # Enum values are in WatermapFile.WaterItemType; compare by name when possible.
                tname = str(wtype)
            except Exception:
                tname = ""

            if "River" in tname:
                return float(getattr(vec, "Z", 0.0)) if vec is not None else None
            if ("Lake" in tname) or ("Pool" in tname):
                if item is not None:
                    pos = getattr(item, "Position", None)
                    if pos is not None:
                        return float(getattr(pos, "Z", 0.0))
                # fallback
                return float(getattr(vec, "Z", 0.0)) if vec is not None else None

            return float(getattr(vec, "Z", 0.0)) if vec is not None else None
        except Exception as e:
            logger.error(f"get_water_height_at failed at ({x},{y}): {e}")
            return None

    def sphere_intersect(
        self,
        x: float,
        y: float,
        z: float,
        radius: float,
        layers: Optional[List[bool]] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Query CodeWalker's `Space.SphereIntersect` at a given sphere (data-space).

        This is closer to GTA-style "ped capsule touches ground" than a pure raycast,
        but note it's an *overlap* test, not a swept sphere/capsule cast.

        Args:
            x,y,z: sphere center
            radius: sphere radius (data units)
            layers: optional 3-bool layer filter for YBN bounds store items (default: [True, False, False])

        Returns:
            dict with keys: hit(bool), position(tuple|None), normal(tuple|None), test_complete(bool|None)
        """
        try:
            if not self.world_space_inited or self.world_space is None:
                ok = self.init_world_space()
                if not ok:
                    return None

            import SharpDX  # type: ignore
            import System  # type: ignore

            sph = SharpDX.BoundingSphere(SharpDX.Vector3(float(x), float(y), float(z)), float(radius))

            arr = None
            if layers is not None:
                # Space expects up to 3 bools (0..2)
                l0 = bool(layers[0]) if len(layers) > 0 else True
                l1 = bool(layers[1]) if len(layers) > 1 else False
                l2 = bool(layers[2]) if len(layers) > 2 else False
                arr = System.Array[System.Boolean]([l0, l1, l2])

            res = self.world_space.SphereIntersect(sph, arr)
            hit = bool(getattr(res, "Hit", False))
            if not hit:
                return {"hit": False}

            pos = getattr(res, "Position", None)
            nrm = getattr(res, "Normal", None)
            tc = getattr(res, "TestComplete", None)
            return {
                "hit": True,
                "position": (float(pos.X), float(pos.Y), float(pos.Z)) if pos is not None else None,
                "normal": (float(nrm.X), float(nrm.Y), float(nrm.Z)) if nrm is not None else None,
                "test_complete": bool(tc) if tc is not None else None,
            }
        except Exception as e:
            logger.error(f"sphere_intersect failed at ({x},{y},{z}) r={radius}: {e}")
            return None

    def raycast_down(
        self,
        x: float,
        y: float,
        z_start: float,
        max_dist: float = 20000.0,
        ybn_only: bool = True,
    ) -> Optional[Dict[str, Any]]:
        """
        Raycast downward in GTA/data-space and return the closest hit.

        Args:
            x,y,z_start: ray origin
            max_dist: max distance to test
            ybn_only: if True, ignore hits that are only from HD entity bounds (bridges/props)

        Returns:
            dict with keys: hit(bool), z(float), position(tuple), normal(tuple), hit_entity(bool)
        """
        try:
            if not self.world_space_inited or self.world_space is None:
                ok = self.init_world_space()
                if not ok:
                    return None

            # Use SharpDX structs (Space.cs is SharpDX-based).
            import SharpDX  # type: ignore

            origin = SharpDX.Vector3(float(x), float(y), float(z_start))
            direction = SharpDX.Vector3(0.0, 0.0, -1.0)
            ray = SharpDX.Ray(origin, direction)

            # Prefer exterior collision layer 0 only; layers array matches Space's BoundsStore layers.
            # NOTE: MapDataStore (HD ymaps/entities) is not filtered by this, so we post-filter by HitEntity.
            layers = None
            try:
                import System  # type: ignore

                arr = System.Array[System.Boolean]([True, False, False])
                layers = arr
            except Exception:
                layers = None

            res = self.world_space.RayIntersect(ray, float(max_dist), layers)
            hit = bool(getattr(res, "Hit", False))
            if not hit:
                return {"hit": False}

            # Optional: ignore entity-only hits so the heightfield represents "ground collision"
            hit_entity = getattr(res, "HitEntity", None) is not None
            hit_ybn = getattr(res, "HitYbn", None) is not None
            if ybn_only and hit_entity and (not hit_ybn):
                return {"hit": False}

            pos = getattr(res, "Position", None)
            nrm = getattr(res, "Normal", None)
            if pos is None:
                return {"hit": False}

            return {
                "hit": True,
                "z": float(pos.Z),
                "position": (float(pos.X), float(pos.Y), float(pos.Z)),
                "normal": (float(nrm.X), float(nrm.Y), float(nrm.Z)) if nrm is not None else None,
                "hit_entity": bool(hit_entity),
                "hit_ybn": bool(hit_ybn),
            }
        except Exception as e:
            logger.error(f"Raycast failed at ({x},{y}): {e}")
            return None
            
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
        # Prefer the GameFileCache's RpfMan when available: it is the one used to build
        # DLC overlay dictionaries and should have the most correct override behavior.
        try:
            gfc = self.game_file_cache
            if gfc is not None and getattr(gfc, "IsInited", False):
                rpfman = getattr(gfc, "RpfMan", None)
                if rpfman is not None:
                    return rpfman
        except Exception:
            pass
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

    def get_ymap_file(self, path_or_data: Union[str, bytes, Any]) -> Optional[Any]:
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

            # Accept a CodeWalker RpfFileEntry directly (best for parity: caller can use GameFileCache dicts).
            try:
                if not isinstance(path_or_data, (str, bytes)) and hasattr(path_or_data, "FileOffset") and hasattr(path_or_data, "Path"):
                    entry = path_or_data
                    rpfman = self.get_rpf_manager()
                    ymap_file = rpfman.GetFile[self.YmapFile](entry)
                    return ymap_file
            except Exception:
                # fall through
                pass
                
            if isinstance(path_or_data, str):
                # Normalize to CodeWalker-style paths (case-insensitive, backslashes).
                p = str(path_or_data).replace("/", "\\")
                # Get the file entry first
                rpfman = self.get_rpf_manager()
                entry = rpfman.GetEntry(p)
                if not entry:
                    logger.error(f"Failed to get YMAP file entry: {p}")
                    return None
                    
                # Load data into YMAP file using RpfManager's GetFile method
                ymap_file = rpfman.GetFile[self.YmapFile](entry)
                if not ymap_file:
                    logger.error(f"Failed to load YMAP file data: {p}")
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

    def get_watermap_file(self, data: bytes) -> Optional[Any]:
        """
        Create a WatermapFile object from raw waterheight.dat data.

        Args:
            data: Raw bytes of the watermap file.

        Returns:
            WatermapFile object if successful, None otherwise.
        """
        try:
            if not self.WatermapFile:
                logger.error("WatermapFile type not initialized")
                return None
            if not data:
                logger.error("No watermap data provided")
                return None

            wmf = self.WatermapFile()
            # Signature: Load(byte[] data, RpfFileEntry entry)
            wmf.Load(data, None)
            return wmf
        except Exception as e:
            logger.error(f"Failed to create WatermapFile object: {e}")
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
"""
Enhanced Terrain System for GTA5
-------------------------------
Handles terrain data extraction, processing, and visualization with improved features.
"""

import logging
import numpy as np
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Any, TYPE_CHECKING
from dataclasses import dataclass, field
import json

from .dll_manager import DllManager
from .rpf_reader import RpfReader
from .terrain_chunk_manager import TerrainChunkManager
from .space_extractor import SpaceExtractor
from gta5_modules.heightmap import HeightmapFile

if TYPE_CHECKING:
    from .ymap_handler import YmapHandler

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@dataclass
class TerrainBounds:
    """Terrain bounds data"""
    min_x: float = 0.0
    min_y: float = 0.0
    min_z: float = 0.0
    max_x: float = 0.0
    max_y: float = 0.0
    max_z: float = 0.0

@dataclass
class HeightmapData:
    """Enhanced heightmap data structure"""
    width: int = 0
    height: int = 0
    bounds: TerrainBounds = field(default_factory=TerrainBounds)
    max_heights: np.ndarray = field(default_factory=lambda: np.zeros((0, 0), dtype=np.uint8))
    min_heights: np.ndarray = field(default_factory=lambda: np.zeros((0, 0), dtype=np.uint8))
    data: Optional[np.ndarray] = None  # Primary height data (usually max_heights)
    compressed: bool = False
    water_mask: Optional[np.ndarray] = None
    slope_data: Optional[np.ndarray] = None
    height_stats: Dict[str, float] = field(default_factory=dict)

@dataclass
class TerrainTextureData:
    """Terrain texture data"""
    diffuse: Optional[np.ndarray]  # (H, W, C) array of diffuse texture
    normal: Optional[np.ndarray]   # (H, W, C) array of normal map
    format: str                    # Texture format
    name: str                      # Texture name

@dataclass
class TerrainGeometry:
    """Enhanced terrain geometry data"""
    vertices: np.ndarray = field(default_factory=lambda: np.zeros((0, 3), dtype=np.float32))
    normals: np.ndarray = field(default_factory=lambda: np.zeros((0, 3), dtype=np.float32))
    uvs: np.ndarray = field(default_factory=lambda: np.zeros((0, 2), dtype=np.float32))
    indices: np.ndarray = field(default_factory=lambda: np.zeros((0, 3), dtype=np.uint32))
    bounds: TerrainBounds = field(default_factory=TerrainBounds)
    lod_levels: List[Dict] = field(default_factory=list)
    water_geometry: Optional[Dict] = None

@dataclass
class CompHeader:
    """Compression header for heightmap data"""
    start: int  # Start index in row
    count: int  # Number of values in row
    data_offset: int  # Offset into data array

@dataclass
class EnhancedHeightmapData(HeightmapData):
    """Enhanced heightmap data with additional features"""
    height_stats: Dict[str, float] = field(default_factory=dict)  # min, max, mean, std
    slope_data: Optional[np.ndarray] = None  # (H, W) array of slope angles
    water_mask: Optional[np.ndarray] = None  # (H, W) boolean array for water areas
    vegetation_mask: Optional[np.ndarray] = None  # (H, W) boolean array for vegetation
    road_mask: Optional[np.ndarray] = None  # (H, W) boolean array for roads
    
    def calculate_slope(self) -> np.ndarray:
        """Calculate slope angles for each point using central differences"""
        if self.height_data is None:
            return None
            
        # Calculate gradients using central differences
        dy, dx = np.gradient(self.height_data)
        
        # Calculate slope angles
        slope = np.arctan(np.sqrt(dx*dx + dy*dy))
        
        return slope
        
    def generate_masks(self) -> Dict[str, np.ndarray]:
        """Generate various terrain masks"""
        masks = {}
        
        # Generate water mask based on height and slope
        if self.height_data is not None and self.slope_data is not None:
            water_mask = (self.height_data < 0.0) & (self.slope_data < 0.1)
            masks['water'] = water_mask
            
        # Generate vegetation mask based on height and slope
        if self.height_data is not None and self.slope_data is not None:
            vegetation_mask = (self.height_data > 0.0) & (self.height_data < 0.5) & (self.slope_data < 0.3)
            masks['vegetation'] = vegetation_mask
            
        # Generate road mask based on height and slope
        if self.height_data is not None and self.slope_data is not None:
            road_mask = (self.slope_data < 0.1) & (np.abs(self.height_data) < 0.1)
            masks['road'] = road_mask
            
        return masks

@dataclass
class EnhancedTerrainTextureData:
    """Enhanced texture data with additional features"""
    diffuse: Optional[np.ndarray] = None
    normal: Optional[np.ndarray] = None
    format: str = ""
    name: str = ""
    roughness: Optional[np.ndarray] = None  # Roughness map
    ao: Optional[np.ndarray] = None  # Ambient occlusion map
    displacement: Optional[np.ndarray] = None  # Displacement map
    blend_mask: Optional[np.ndarray] = None  # Blend mask for texture mixing
    
    def generate_maps(self) -> Dict[str, np.ndarray]:
        """Generate additional texture maps"""
        maps = {}
        
        # Generate roughness map from normal map
        if self.normal is not None:
            roughness = 1.0 - np.mean(self.normal, axis=2)
            maps['roughness'] = roughness
            
        # Generate ambient occlusion map
        if self.normal is not None:
            ao = np.mean(np.abs(self.normal), axis=2)
            maps['ao'] = ao
            
        # Generate displacement map from height data
        if self.diffuse is not None:
            displacement = np.mean(self.diffuse, axis=2)
            maps['displacement'] = displacement
            
        return maps

class EnhancedTerrainLODManager:
    """Enhanced LOD management system"""
    
    def __init__(self):
        self.lod_levels: Dict[int, Dict[str, Any]] = {}
        self.lod_distances = [0, 100, 200, 400, 800]
        self.lod_transition_distances = [50, 150, 300, 600]
    
    def generate_lod_levels(self, geometry: Dict[str, Any]) -> None:
        """Generate multiple LOD levels with smooth transitions"""
        try:
            # Generate base LOD (level 0)
            self.lod_levels[0] = geometry
            
            # Generate reduced LOD levels
            for i, distance in enumerate(self.lod_distances[1:], 1):
                reduction_factor = 2 ** i
                reduced_geometry = self._reduce_geometry(geometry, reduction_factor)
                self.lod_levels[i] = reduced_geometry
                
        except Exception as e:
            logger.error(f"Error generating LOD levels: {e}")
    
    def get_lod_level(self, camera_distance: float) -> Tuple[Dict[str, Any], float]:
        """Get appropriate LOD level and blend factor"""
        try:
            # Find appropriate LOD level
            level = 0
            for i, distance in enumerate(self.lod_distances):
                if camera_distance >= distance:
                    level = i
                    
            # Calculate blend factor for smooth transition
            if level < len(self.lod_transition_distances):
                next_distance = self.lod_distances[level + 1]
                blend_factor = (camera_distance - self.lod_distances[level]) / (next_distance - self.lod_distances[level])
            else:
                blend_factor = 0.0
                
            return self.lod_levels[level], blend_factor
            
        except Exception as e:
            logger.error(f"Error getting LOD level: {e}")
            return self.lod_levels[0], 0.0
    
    def _reduce_geometry(self, geometry: Dict[str, Any], factor: int) -> Dict[str, Any]:
        """Reduce geometry complexity by factor"""
        reduced = {}
        
        # Reduce vertices
        if 'vertices' in geometry:
            reduced['vertices'] = geometry['vertices'][::factor]
            
        # Reduce indices
        if 'indices' in geometry:
            reduced['indices'] = geometry['indices'][::factor]
            
        # Reduce normals
        if 'normals' in geometry:
            reduced['normals'] = geometry['normals'][::factor]
            
        # Reduce UVs
        if 'uvs' in geometry:
            reduced['uvs'] = geometry['uvs'][::factor]
            
        return reduced

class TerrainSystem:
    """Enhanced terrain system with improved features"""
    
    DEFAULT_HEIGHTMAP_PATHS = [
        "common.rpf\\data\\levels\\gta5\\heightmap.dat",
        "update\\update.rpf\\common\\data\\levels\\gta5\\heightmap.dat",
        "update\\update.rpf\\common\\data\\levels\\gta5\\heightmapheistisland.dat"
    ]
    
    # Terrain shader hashes and their names
    TERRAIN_SHADERS = {
        3051127652: "terrain_cb_w_4lyr",
        646532852: "terrain_cb_w_4lyr_spec",
        295525123: "terrain_cb_w_4lyr_cm",
        417637541: "terrain_cb_w_4lyr_cm_tnt",
        3965214311: "terrain_cb_w_4lyr_cm_pxm_tnt",
        4186046662: "terrain_cb_w_4lyr_cm_pxm"
    }
    
    # Texture parameter names used by terrain shaders
    TEXTURE_PARAMS = {
        "diffuse": "diffuseSampler",
        "normal": "normalSampler",
        "specular": "specularSampler",
        "detail": "detailSampler",
        "detail_normal": "detailNormalSampler",
        "detail_mask": "detailMaskSampler",
        "blend": "blendSampler",
        "blend_normal": "blendNormalSampler",
        "blend_mask": "blendMaskSampler"
    }
    
    def __init__(self, game_path: str, dll_manager: DllManager):
        """
        Initialize terrain system
        
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
        
        # Initialize RPF reader for file operations
        self.rpf_reader = RpfReader(str(game_path), dll_manager)
        
        # Initialize YMAP handler
        self.ymap_handler: Optional['YmapHandler'] = None
        
        # Initialize terrain components
        self.heightmaps: Dict[str, HeightmapData] = {}
        self.textures: Dict[str, TerrainTextureData] = {}
        self.geometry: Optional[TerrainGeometry] = None
        self.texture_data: Dict[str, Dict] = {}
        self.water_data: Optional[Dict] = None
        # Number of LOD geometry levels we *intend* to generate (0..N-1). This is about geometry
        # reduction, not a per-(x,y) cell map.
        self.num_lod_levels: int = 4
        self.chunk_size: int = 64
        self.terrain_nodes: Dict[str, Any] = {}
        
        # Initialize terrain info with all required fields
        self.terrain_info = {
            'num_heightmaps': 0,
            'num_textures': 0,
            'num_nodes': 0,
            'dimensions': {},
            'texture_info': {},
            'bounds': {},
            'lod_info': {},
            'water_info': {},
            'vegetation_info': {},
            'road_info': {},
            'asset_info': {}
        }
        
        self.lod_manager = EnhancedTerrainLODManager()
        self.chunk_manager = TerrainChunkManager()
        
        self.space = SpaceExtractor(dll_manager)
        self.bounds: Optional[TerrainBounds] = None
        self.width: int = 0
        self.height: int = 0
        self.heightmap_data: Optional[np.ndarray] = None
        self.normal_data: Optional[np.ndarray] = None
        self.texture_data: Dict[str, np.ndarray] = {}
        # PNGs to write into output/textures for the WebGL viewer (filename -> image array)
        self.export_textures: Dict[str, np.ndarray] = {}
        # Optional per-cell LOD map (VERY large if fully populated). Today we don't compute GTA's
        # real per-cell LODs; this is kept for future work and debug tooling.
        self.lod_cell_levels: List[Dict[str, Any]] = []
        self.initialized: bool = False

        # Parity/provenance
        self.parity_texture_sources: list[dict] = []
        
    def extract_terrain(self) -> bool:
        """Extract terrain data from game files"""
        try:
            # Initialize YMAP handler
            from .ymap_handler import YmapHandler
            self.ymap_handler = YmapHandler(self.rpf_manager)
            
            # Initialize terrain components
            if not self._init_terrain_components():
                return False
                
            # Extract heightmap data
            if not self._extract_heightmaps():
                return False
                
            # Extract texture data
            if not self._extract_textures():
                return False
                
            # Generate terrain geometry
            if not self._generate_terrain_geometry():
                return False
                
            # Process LOD levels
            self.lod_manager.generate_lod_levels(self.geometry.__dict__)
            
            # Extract water data
            if not self._extract_water_data():
                return False
                
            # Extract vegetation data
            if not self._extract_vegetation_data():
                return False
                
            # Extract road data
            if not self._extract_road_data():
                return False
                
            # Process asset dependencies
            if not self._process_asset_dependencies():
                return False
                
            # Update final terrain info
            lod_geoms = getattr(self.lod_manager, "lod_levels", None) or {}
            lod_levels_summary = []
            try:
                for lvl in sorted(lod_geoms.keys()):
                    g = lod_geoms.get(lvl) or {}
                    v = g.get("vertices")
                    idx = g.get("indices")
                    lod_levels_summary.append({
                        "level": int(lvl),
                        "vertex_count": int(len(v)) if v is not None else 0,
                        "index_count": int(len(idx)) if idx is not None else 0
                    })
            except Exception:
                lod_levels_summary = []

            self.terrain_info.update({
                'num_heightmaps': len(self.heightmaps),
                # IMPORTANT:
                # `_extract_textures()` currently populates `self.terrain_info["texture_info"]`
                # and sets `self.terrain_info["num_textures"]`, but does not necessarily populate
                # `self.textures`. Don't overwrite the computed value with 0 here.
                'num_textures': int(self.terrain_info.get('num_textures') or len(self.textures) or 0),
                'num_nodes': len(self.terrain_nodes),
                'dimensions': self.terrain_info['dimensions'],
                'bounds': self.terrain_info['bounds'],
                'lod_info': {
                    # Geometry LODs produced by `EnhancedTerrainLODManager` (what we actually generate today).
                    'num_levels': int(len(lod_geoms)),
                    'levels': lod_levels_summary
                }
            })
            
            self.initialized = True
            return True
            
        except Exception as e:
            logger.error(f"Error extracting terrain: {e}")
            logger.debug("Stack trace:", exc_info=True)
            return False
            
    def get_terrain_info(self) -> Dict[str, Any]:
        """Get terrain information"""
        if not self.initialized:
            # If not initialized, return basic info
            return {
                'num_heightmaps': len(self.heightmaps),
                'num_textures': len(self.textures),
                'num_nodes': len(self.terrain_nodes),
                'dimensions': self.terrain_info['dimensions'],
                'bounds': self.terrain_info['bounds'],
                'texture_info': self.terrain_info['texture_info']
            }
        
        # Return the full terrain info dictionary
        return self.terrain_info
        
    def get_height(self, x: int, y: int) -> Optional[float]:
        """Get terrain height at given coordinates"""
        if self.heightmap_data is None:
            return None
        x = max(0, min(self.width - 1, int(x)))
        y = max(0, min(self.height - 1, int(y)))
        return float(self.heightmap_data[y, x])
        
    def get_normal(self, x: int, y: int) -> Optional[np.ndarray]:
        """Get terrain normal at given coordinates"""
        if self.normal_data is None:
            return None
        x = max(0, min(self.width - 1, int(x)))
        y = max(0, min(self.height - 1, int(y)))
        return self.normal_data[y, x]
        
    def get_texture_index(self, x: int, y: int) -> Optional[int]:
        """Get texture index at given coordinates"""
        for tex_idx, tex_data in self.texture_data.items():
            if tex_data[y, x] == 1:
                return tex_idx
        return None
        
    def get_lod_level(self, x: int, y: int) -> Optional[int]:
        """Get LOD level at given coordinates"""
        # Prefer explicit per-cell map if present.
        try:
            for lod in self.lod_cell_levels:
                if (x, y) in (lod.get('cells') or []):
                    return int(lod.get('level') or 0)
        except Exception:
            pass

        # Fallback: a cheap heuristic based on distance-from-center. This is ONLY for debug/UI and
        # does not represent GTA's real terrain LOD selection.
        try:
            if self.width <= 0 or self.height <= 0:
                return None
            n = int(len(getattr(self.lod_manager, "lod_levels", {}) or {})) or int(self.num_lod_levels) or 1
            n = max(1, min(8, n))
            cx = (self.width - 1) * 0.5
            cy = (self.height - 1) * 0.5
            dx = float(x) - cx
            dy = float(y) - cy
            # Normalize by radius to a corner.
            r = (cx * cx + cy * cy) ** 0.5
            if r <= 1e-6:
                return 0
            d01 = min(1.0, (dx * dx + dy * dy) ** 0.5 / r)
            lvl = int(d01 * float(n))
            return max(0, min(n - 1, lvl))
        except Exception:
            return None
        
    def visualize_terrain(self, output_dir: Path):
        """Create terrain visualizations"""
        try:
            # Create output directory
            output_dir.mkdir(parents=True, exist_ok=True)
            
            # Save heightmap
            if self.heightmap_data is not None:
                heightmap_path = output_dir / 'heightmap.png'
                self._save_heightmap(heightmap_path)
                
            # Save normal map
            if self.normal_data is not None:
                normal_path = output_dir / 'normalmap.png'
                self._save_normalmap(normal_path)

            # Export extracted terrain textures for the viewer
            if getattr(self, "export_textures", None):
                # Ensure we always have a usable RGBA blend mask for the WebGL viewer.
                # This is a pragmatic fallback (height/slope-based), but it enables true 4-layer blending
                # in the WebGL shader when GTA's real terrain layer masks aren't available.
                self._ensure_viewer_blend_mask()
                textures_dir = output_dir / "textures"
                textures_dir.mkdir(parents=True, exist_ok=True)
                self._export_texture_images(textures_dir)
                
            # Save texture maps
            for tex_idx, tex_data in self.texture_data.items():
                tex_path = output_dir / f'texture_{tex_idx}.png'
                self._save_texturemap(tex_data, tex_path)
                
            # Save LOD visualization
            lod_path = output_dir / 'lod_levels.png'
            self._save_lod_visualization(lod_path)
            
        except Exception as e:
            logger.error(f"Error creating visualizations: {e}")

    def _ensure_viewer_blend_mask(self) -> None:
        """
        Ensure `export_textures["terrain_blend_mask.png"]` exists as an RGBA weight/splat map.

        Channel convention (matches WebGL `uLayer{1..4}Map` order):
        - R: grass-ish
        - G: rock-ish
        - B: dirt-ish
        - A: sand-ish

        This is NOT the real GTA terrain layer system; it's a deterministic fallback driven by
        height + slope so the viewer can do true multi-texture blending instead of single-texture mapping.
        """
        try:
            if self.heightmap_data is None:
                return
            if getattr(self, "export_textures", None) is None:
                self.export_textures = {}
            if "terrain_blend_mask.png" in (self.export_textures or {}):
                return

            h = np.asarray(self.heightmap_data, dtype=np.float32)
            if h.size == 0:
                return

            hmin = float(np.nanmin(h))
            hmax = float(np.nanmax(h))
            denom = max(1e-6, hmax - hmin)
            h01 = np.clip((h - hmin) / denom, 0.0, 1.0)

            # Slope in [0..1], where 0 is flat and 1 is very steep.
            slope = None
            if self.normal_data is not None:
                n = np.asarray(self.normal_data, dtype=np.float32)
                if n.ndim == 3 and n.shape[2] >= 3:
                    nz = np.clip(np.abs(n[..., 2]), 0.0, 1.0)
                    slope = np.clip(1.0 - nz, 0.0, 1.0)

            if slope is None:
                gy, gx = np.gradient(h01)
                slope = np.clip(np.sqrt(gx * gx + gy * gy) * 4.0, 0.0, 1.0)

            # Heuristic weights (smooth-ish, normalized below)
            sand = np.clip((0.18 - h01) / 0.18, 0.0, 1.0)
            sand = sand * sand

            rock = np.clip((slope - 0.25) / 0.55, 0.0, 1.0)
            rock = rock * rock
            rock = np.clip(rock + 0.35 * np.clip((h01 - 0.75) / 0.25, 0.0, 1.0), 0.0, 1.0)

            grass = np.clip((h01 - 0.08) / 0.55, 0.0, 1.0) * np.clip((0.35 - slope) / 0.35, 0.0, 1.0)
            grass = np.clip(grass, 0.0, 1.0)

            dirt = np.clip(1.0 - (grass + rock + sand), 0.0, 1.0)

            sumw = grass + rock + dirt + sand
            sumw[sumw < 1e-6] = 1.0

            # Order is (R,G,B,A) = (grass, rock, dirt, sand)
            w = np.stack([grass, rock, dirt, sand], axis=2) / sumw[..., None]
            rgba = np.clip(np.round(w * 255.0), 0, 255).astype(np.uint8)

            self.export_textures["terrain_blend_mask.png"] = rgba
        except Exception:
            return

    def _export_texture_images(self, textures_dir: Path) -> None:
        """Write extracted texture PNGs to output/textures for the WebGL viewer."""
        try:
            import cv2

            for filename, img in (self.export_textures or {}).items():
                if img is None:
                    continue
                out_path = textures_dir / filename
                arr = img
                # Convert RGBA -> BGRA for OpenCV, RGB -> BGR
                if len(arr.shape) == 3 and arr.shape[2] == 4:
                    bgr = cv2.cvtColor(arr, cv2.COLOR_RGBA2BGRA)
                    cv2.imwrite(str(out_path), bgr)
                elif len(arr.shape) == 3 and arr.shape[2] == 3:
                    bgr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
                    cv2.imwrite(str(out_path), bgr)
                else:
                    cv2.imwrite(str(out_path), arr)
        except Exception as e:
            logger.warning(f"Failed exporting textures: {e}")
            
    def export_obj(self, output_path: str):
        """Export terrain as OBJ file"""
        try:
            if self.heightmap_data is None or self.normal_data is None:
                logger.error("No terrain data to export")
                return False
                
            with open(output_path, 'w') as f:
                # Write vertices
                for y in range(self.height):
                    for x in range(self.width):
                        world_x = self.bounds.min_x + (x / (self.width - 1)) * (self.bounds.max_x - self.bounds.min_x)
                        world_y = self.bounds.min_y + (y / (self.height - 1)) * (self.bounds.max_y - self.bounds.min_y)
                        world_z = self.heightmap_data[y, x]
                        f.write(f"v {world_x} {world_y} {world_z}\n")
                        
                # Write normals
                for y in range(self.height):
                    for x in range(self.width):
                        normal = self.normal_data[y, x]
                        f.write(f"vn {normal[0]} {normal[1]} {normal[2]}\n")
                        
                # Write texture coordinates
                for y in range(self.height):
                    for x in range(self.width):
                        u = x / (self.width - 1)
                        v = y / (self.height - 1)
                        f.write(f"vt {u} {v}\n")
                        
                # Write faces
                for y in range(self.height - 1):
                    for x in range(self.width - 1):
                        v1 = y * self.width + x + 1
                        v2 = y * self.width + x + 2
                        v3 = (y + 1) * self.width + x + 1
                        v4 = (y + 1) * self.width + x + 2
                        
                        # First triangle
                        f.write(f"f {v1}/{v1}/{v1} {v2}/{v2}/{v2} {v3}/{v3}/{v3}\n")
                        # Second triangle
                        f.write(f"f {v2}/{v2}/{v2} {v4}/{v4}/{v4} {v3}/{v3}/{v3}\n")
                        
            logger.info(f"Exported terrain to {output_path}")
            return True
            
        except Exception as e:
            logger.error(f"Error exporting terrain: {e}")
            return False
            
    def export_terrain_info(self, output_dir: Path):
        """Export terrain information to JSON"""
        try:
            info = self.get_terrain_info()

            # Best-effort: if we didn't successfully locate terrain textures directly from game YTDs,
            # try to "link" terrain textures from already-exported PNGs in output/textures.
            # This makes the WebGL viewer usable even when terrain YTD discovery fails.
            self._autofill_texture_info_from_exported_pngs(info, output_dir)

            # If we have a viewer blend mask in output/textures, advertise it so the WebGL viewer loads it.
            try:
                tex_dir = Path(output_dir) / "textures"
                if (tex_dir / "terrain_blend_mask.png").exists():
                    ti = info.get("texture_info")
                    if not isinstance(ti, dict):
                        ti = {}
                        info["texture_info"] = ti
                    ti["blend_mask"] = True
            except Exception:
                pass
            
            # Add LOD information
            info['lod_levels'] = [
                {
                    'level': lod['level'],
                    'num_cells': len(lod['cells'])
                }
                for lod in self.lod_cell_levels
            ]
            
            # Add texture information
            info['textures'] = {
                str(tex_idx): {
                    'num_cells': np.sum(tex_data)
                }
                for tex_idx, tex_data in self.texture_data.items()
            }
            
            # Write to JSON file
            output_file = output_dir / 'terrain_info.json'
            with open(output_file, 'w') as f:
                json.dump(info, f, indent=2)
                
            logger.info(f"Exported terrain info to {output_file}")
            return True
            
        except Exception as e:
            logger.error(f"Error exporting terrain info: {e}")
            return False

    def _autofill_texture_info_from_exported_pngs(self, info: Dict[str, Any], output_dir: Path) -> None:
        """
        If `num_textures` is 0 (or texture_info is empty), attempt to select a small set of representative
        terrain textures from `output_dir/textures/*.png` and populate `info["texture_info"]` so the
        WebGL viewer can load real textures instead of placeholders.

        This does NOT guarantee correctness vs GTA's real terrain blending; it's a pragmatic fallback.
        """
        try:
            texture_info = info.get("texture_info")
            if not isinstance(texture_info, dict):
                texture_info = {}
                info["texture_info"] = texture_info

            existing_num = int(info.get("num_textures") or 0)
            existing_layers = texture_info.get("layers")
            has_any_layers = isinstance(existing_layers, list) and len(existing_layers) > 0

            # If we already have textures or layers, don't stomp them.
            if existing_num > 0 or has_any_layers:
                return

            tex_dir = Path(output_dir) / "textures"
            if not tex_dir.exists():
                return

            # Build a set of available bases from *_diffuse.png files.
            # We expect the exporter to name files like "<base>_diffuse.png" and "<base>_normal.png".
            diffuse_files = list(tex_dir.glob("*_diffuse.png"))
            if not diffuse_files:
                return

            bases = set()
            for p in diffuse_files:
                name = p.name
                if not name.lower().endswith("_diffuse.png"):
                    continue
                bases.add(name[:-len("_diffuse.png")])

            def has_normal(base: str) -> bool:
                return (tex_dir / f"{base}_normal.png").exists()

            def pick_base(kind: str, keywords: List[str]) -> Optional[str]:
                # Prefer shorter names (often "cleaner") and those that include more keywords.
                candidates = []
                for b in bases:
                    bl = b.lower()
                    if any(k in bl for k in keywords):
                        # Skip obvious non-surface textures
                        if "mask" in bl or "alpha" in bl or "decal" in bl or "gradient" in bl:
                            continue
                        score = 0
                        for k in keywords:
                            if k in bl:
                                score += 10
                        score -= min(200, len(bl))  # shorter is better
                        # Prefer ones that have normals when possible
                        if has_normal(b):
                            score += 5
                        candidates.append((score, b))
                if not candidates:
                    return None
                candidates.sort(reverse=True)
                return candidates[0][1]

            picks: Dict[str, str] = {}
            picks["grass"] = pick_base("grass", ["grass", "meadow", "lush", "scrub"])
            picks["rock"] = pick_base("rock", ["rock", "cliff", "stone", "canyon"])
            picks["dirt"] = pick_base("dirt", ["dirt", "mud", "earth", "soil", "track"])
            picks["sand"] = pick_base("sand", ["sand", "beach", "desert"])
            picks["snow"] = pick_base("snow", ["snow", "ice"])

            # Drop Nones and duplicates while preserving order.
            used = set()
            ordered: List[Tuple[str, str]] = []
            for k in ["grass", "rock", "dirt", "sand", "snow"]:
                b = picks.get(k)
                if not b or b in used:
                    continue
                used.add(b)
                ordered.append((k, b))

            if not ordered:
                return

            # Top-level entries the viewer already understands:
            # info.texture_info[base] = { has_normal: bool }
            for (_kind, base) in ordered:
                texture_info[base] = {
                    "format": "png",
                    "has_normal": bool(has_normal(base)),
                    "source": "autofill_from_exported_pngs",
                }

            # Provide an explicit mapping for the viewer terrain-type samplers.
            texture_info["terrain_types"] = {
                kind: {"name": base, "has_normal": bool(has_normal(base))}
                for (kind, base) in ordered
            }

            # Provide a small layer list (viewer uses up to 4).
            texture_info["layers"] = [{"name": base, "has_normal": bool(has_normal(base))} for (_k, base) in ordered[:4]]

            # Update num_textures to reflect how many real bases we linked.
            info["num_textures"] = len([k for k in texture_info.keys() if k not in ("layers", "blend_mask", "terrain_types")])
        except Exception as e:
            logger.debug(f"Failed to autofill texture_info from exported PNGs: {e}", exc_info=True)
            
    def _save_heightmap(self, path: Path):
        """Save heightmap as PNG"""
        try:
            import cv2
            
            # Normalize heightmap to 0-255 range
            heightmap = (self.heightmap_data - self.bounds.min_z) / (self.bounds.max_z - self.bounds.min_z)
            heightmap = (heightmap * 255).astype(np.uint8)

            # GTA's `heightmap.dat` is inherently coarse (often ~183x249 for the main map).
            # For the WebGL viewer, upscaling the raster greatly improves perceived quality
            # (smoother silhouettes / less “blocky” sampling) while keeping the same world bounds.
            try:
                h, w = int(heightmap.shape[0]), int(heightmap.shape[1])
                # If extremely small, upscale to a more view-friendly size.
                # Keep within a sane cap to avoid gigantic assets.
                if w > 0 and h > 0 and (w < 768 or h < 768):
                    scale = 4
                    out_w = min(2048, max(1024, w * scale))
                    out_h = min(2048, max(1024, h * scale))
                    # Preserve aspect ratio by fitting within (out_w,out_h).
                    sx = out_w / float(w)
                    sy = out_h / float(h)
                    s = min(sx, sy)
                    new_w = max(1, int(round(w * s)))
                    new_h = max(1, int(round(h * s)))
                    heightmap = cv2.resize(heightmap, (new_w, new_h), interpolation=cv2.INTER_CUBIC)
            except Exception:
                pass
            
            # Save as PNG
            cv2.imwrite(str(path), heightmap)
            
        except Exception as e:
            logger.error(f"Error saving heightmap: {e}")
            
    def _save_normalmap(self, path: Path):
        """Save normal map as PNG"""
        try:
            import cv2
            
            # Convert normals to RGB (0-255 range)
            normalmap = ((self.normal_data + 1) * 127.5).astype(np.uint8)
            
            # Save as PNG
            cv2.imwrite(str(path), normalmap)
            
        except Exception as e:
            logger.error(f"Error saving normal map: {e}")
            
    def _save_texturemap(self, tex_data: np.ndarray, path: Path):
        """Save texture map as PNG"""
        try:
            import cv2
            
            # Convert to 0-255 range
            texmap = (tex_data * 255).astype(np.uint8)
            
            # Save as PNG
            cv2.imwrite(str(path), texmap)
            
        except Exception as e:
            logger.error(f"Error saving texture map: {e}")
            
    def _save_lod_visualization(self, path: Path):
        """Save LOD level visualization as PNG"""
        try:
            import cv2
            
            # Create visualization array
            if self.width <= 0 or self.height <= 0:
                return

            lod_vis = np.zeros((self.height, self.width), dtype=np.uint8)

            # If we have a real per-cell LOD map, render that.
            has_cells = False
            try:
                for lod in self.lod_cell_levels:
                    cells = lod.get('cells') or []
                    if cells:
                        has_cells = True
                        break
            except Exception:
                has_cells = False

            if has_cells:
                for lod in self.lod_cell_levels:
                    level = int(lod.get('level') or 0)
                    for x, y in (lod.get('cells') or []):
                        if 0 <= int(x) < self.width and 0 <= int(y) < self.height:
                            lod_vis[int(y), int(x)] = max(0, min(255, level * 50))  # debug shades
            else:
                # Heuristic debug visualization: concentric "LOD bands" based on distance-from-center.
                # This avoids exporting a confusing all-black image when we don't have real per-cell LOD data.
                n = int(len(getattr(self.lod_manager, "lod_levels", {}) or {})) or int(self.num_lod_levels) or 1
                n = max(1, min(8, n))
                if n == 1:
                    # single level => leave black
                    pass
                else:
                    cx = (self.width - 1) * 0.5
                    cy = (self.height - 1) * 0.5
                    yy, xx = np.mgrid[0:self.height, 0:self.width]
                    dx = (xx.astype(np.float32) - float(cx))
                    dy = (yy.astype(np.float32) - float(cy))
                    r = (float(cx) * float(cx) + float(cy) * float(cy)) ** 0.5
                    if r > 1e-6:
                        d01 = np.clip(np.sqrt(dx * dx + dy * dy) / float(r), 0.0, 1.0)
                        lvl = np.minimum(n - 1, (d01 * float(n)).astype(np.int32))
                        step = int(round(255.0 / float(max(1, n - 1))))
                        lod_vis = (lvl.astype(np.uint8) * np.uint8(step)).astype(np.uint8)
                    
            # Save as PNG
            cv2.imwrite(str(path), lod_vis)
            
        except Exception as e:
            logger.error(f"Error saving LOD visualization: {e}")
            
    def _init_terrain_components(self) -> bool:
        """Initialize terrain components"""
        try:
            # Get space instance from DLL manager
            self.space_instance = self.dll_manager.get_space_instance()
            if not self.space_instance:
                logger.error("Failed to get space instance")
                return False
                
            # Load heightmap files
            heightmap_paths = [
                "common.rpf\\data\\levels\\gta5\\heightmap.dat",
                "update\\update.rpf\\common\\data\\levels\\gta5\\heightmap.dat",
                "update\\update.rpf\\common\\data\\levels\\gta5\\heightmapheistisland.dat"
            ]
            
            # Load each heightmap and update bounds
            for path in heightmap_paths:
                try:
                    data = self.rpf_reader.get_file_data(path)
                    if not data:
                        logger.warning(f"Failed to load heightmap bytes: {path}")
                        continue

                    # Parse via CodeWalker when possible to get real world-space bounds (BBMin/BBMax).
                    hm = HeightmapFile(data, self.dll_manager)
                    if hm.max_heights is None or hm.min_heights is None or hm.bounds is None:
                        logger.warning(f"Failed to parse heightmap: {path}")
                        continue

                    height, width = hm.max_heights.shape

                    # Convert quantized height bytes into world-space Z using bounds.
                    zmin = float(hm.bounds.min_z)
                    zmax = float(hm.bounds.max_z)
                    zrange = max(1e-6, (zmax - zmin))
                    height_world = zmin + (hm.max_heights.astype(np.float32) / 255.0) * zrange

                    heightmap = HeightmapData(
                        width=width,
                        height=height,
                        max_heights=hm.max_heights,
                        min_heights=hm.min_heights,
                        data=height_world,  # world-space height
                        bounds=TerrainBounds(
                            min_x=float(hm.bounds.min_x),
                            min_y=float(hm.bounds.min_y),
                            min_z=zmin,
                            max_x=float(hm.bounds.max_x),
                            max_y=float(hm.bounds.max_y),
                            max_z=zmax
                        )
                    )

                    self.heightmaps[path] = heightmap
                    logger.info(f"Loaded heightmap: {path} ({width}x{height})")
                except Exception as e:
                    logger.warning(f"Failed to load heightmap {path}: {e}")
                    logger.debug("Stack trace:", exc_info=True)
            
            # Update terrain info
            self.terrain_info['num_heightmaps'] = len(self.heightmaps)
            self.terrain_info['num_nodes'] = len(self.terrain_nodes)
            
            return True
            
        except Exception as e:
            logger.error(f"Failed to initialize terrain components: {e}")
            logger.debug("Stack trace:", exc_info=True)
            return False

    def _extract_heightmaps(self) -> bool:
        """Extract heightmap data from RPF files"""
        try:
            # Heightmaps are already loaded in _init_terrain_components
            # Just process them further here
            
            # Get the first heightmap's dimensions for the combined heightmap
            first_heightmap = next(iter(self.heightmaps.values()))
            self.width = first_heightmap.width
            self.height = first_heightmap.height
            
            # Initialize combined heightmap data
            self.heightmap_data = np.zeros((self.height, self.width), dtype=np.float32)
            self.normal_data = np.zeros((self.height, self.width, 3), dtype=np.float32)
            
            # Initialize global bounds
            min_x = float('inf')
            min_y = float('inf')
            min_z = float('inf')
            max_x = float('-inf')
            max_y = float('-inf')
            max_z = float('-inf')
            
            # Process each heightmap
            for path, heightmap in self.heightmaps.items():
                # Copy world-space height data
                h, w = heightmap.data.shape
                self.heightmap_data[:h, :w] = heightmap.data
                
                # Calculate normals using world-space spacing
                sx = (heightmap.bounds.max_x - heightmap.bounds.min_x) / max(1, (w - 1))
                sy = (heightmap.bounds.max_y - heightmap.bounds.min_y) / max(1, (h - 1))
                dy, dx = np.gradient(heightmap.data.astype(np.float32), sy, sx)
                z = np.ones_like(dx, dtype=np.float32)
                norm = np.sqrt(dx**2 + dy**2 + z**2) + 1e-8
                
                # Store normalized normal vectors
                self.normal_data[:h, :w, 0] = dx / norm
                self.normal_data[:h, :w, 1] = dy / norm
                self.normal_data[:h, :w, 2] = z / norm
                
                # Update terrain info
                self.terrain_info['dimensions'][path] = {
                    'width': w,
                    'height': h
                }
                
                # Update global bounds
                min_z = min(min_z, float(np.min(heightmap.data)))
                max_z = max(max_z, float(np.max(heightmap.data)))
                min_x = min(min_x, heightmap.bounds.min_x)
                max_x = max(max_x, heightmap.bounds.max_x)
                min_y = min(min_y, heightmap.bounds.min_y)
                max_y = max(max_y, heightmap.bounds.max_y)
                
                # Store individual heightmap bounds
                self.terrain_info['bounds'][path] = {
                    'min_x': float(heightmap.bounds.min_x),
                    'min_y': float(heightmap.bounds.min_y),
                    'min_z': float(heightmap.bounds.min_z),
                    'max_x': float(heightmap.bounds.max_x),
                    'max_y': float(heightmap.bounds.max_y),
                    'max_z': float(heightmap.bounds.max_z),
                }
            
            # Set global terrain bounds
            self.bounds = TerrainBounds(
                min_x=min_x,
                min_y=min_y,
                min_z=min_z,
                max_x=max_x,
                max_y=max_y,
                max_z=max_z
            )

            # Store global bounds in terrain info for consumers (eg WebGL viewer)
            self.terrain_info['global_bounds'] = {
                'min_x': float(self.bounds.min_x),
                'min_y': float(self.bounds.min_y),
                'min_z': float(self.bounds.min_z),
                'max_x': float(self.bounds.max_x),
                'max_y': float(self.bounds.max_y),
                'max_z': float(self.bounds.max_z),
            }
            
            return True
            
        except Exception as e:
            logger.error(f"Error extracting heightmaps: {e}")
            return False

    def world_to_grid(self, x: float, y: float) -> Tuple[int, int]:
        """Convert world XY to terrain grid indices."""
        if not self.bounds or self.width <= 1 or self.height <= 1:
            return 0, 0
        gx = int((x - self.bounds.min_x) / (self.bounds.max_x - self.bounds.min_x) * (self.width - 1))
        gy = int((y - self.bounds.min_y) / (self.bounds.max_y - self.bounds.min_y) * (self.height - 1))
        gx = max(0, min(self.width - 1, gx))
        gy = max(0, min(self.height - 1, gy))
        return gx, gy

    def _world_to_grid_f(self, x: float, y: float) -> Tuple[float, float]:
        """Convert world XY to *fractional* terrain grid coordinates for bilinear sampling."""
        if not self.bounds or self.width <= 1 or self.height <= 1:
            return 0.0, 0.0
        fx = (x - self.bounds.min_x) / (self.bounds.max_x - self.bounds.min_x) * (self.width - 1)
        fy = (y - self.bounds.min_y) / (self.bounds.max_y - self.bounds.min_y) * (self.height - 1)
        fx = float(max(0.0, min(float(self.width - 1), fx)))
        fy = float(max(0.0, min(float(self.height - 1), fy)))
        return fx, fy

    def _bilinear_height(self, fx: float, fy: float) -> Optional[float]:
        if self.heightmap_data is None or self.width <= 1 or self.height <= 1:
            return None
        x0 = int(np.floor(fx))
        y0 = int(np.floor(fy))
        x1 = min(self.width - 1, x0 + 1)
        y1 = min(self.height - 1, y0 + 1)
        tx = fx - x0
        ty = fy - y0

        h00 = float(self.heightmap_data[y0, x0])
        h10 = float(self.heightmap_data[y0, x1])
        h01 = float(self.heightmap_data[y1, x0])
        h11 = float(self.heightmap_data[y1, x1])

        h0 = h00 * (1.0 - tx) + h10 * tx
        h1 = h01 * (1.0 - tx) + h11 * tx
        return h0 * (1.0 - ty) + h1 * ty

    def _bilinear_normal(self, fx: float, fy: float) -> Optional[np.ndarray]:
        if self.normal_data is None or self.width <= 1 or self.height <= 1:
            return None
        x0 = int(np.floor(fx))
        y0 = int(np.floor(fy))
        x1 = min(self.width - 1, x0 + 1)
        y1 = min(self.height - 1, y0 + 1)
        tx = fx - x0
        ty = fy - y0

        n00 = self.normal_data[y0, x0].astype(np.float32, copy=False)
        n10 = self.normal_data[y0, x1].astype(np.float32, copy=False)
        n01 = self.normal_data[y1, x0].astype(np.float32, copy=False)
        n11 = self.normal_data[y1, x1].astype(np.float32, copy=False)

        n0 = n00 * (1.0 - tx) + n10 * tx
        n1 = n01 * (1.0 - tx) + n11 * tx
        n = n0 * (1.0 - ty) + n1 * ty
        ln = float(np.linalg.norm(n))
        if ln > 1e-8:
            n = n / ln
        return n

    def sample_terrain_data(self, position: np.ndarray) -> Tuple[float, Optional[np.ndarray]]:
        """Sample terrain height and normal at a world-space position."""
        fx, fy = self._world_to_grid_f(float(position[0]), float(position[1]))
        h = self._bilinear_height(fx, fy)
        n = self._bilinear_normal(fx, fy)
        return (h if h is not None else float(position[2])), n

    def is_water(self, x: float, y: float) -> bool:
        """Heuristic water test. Real water mesh is handled separately."""
        gx, gy = self.world_to_grid(float(x), float(y))
        h = self.get_height(gx, gy)
        return (h is not None) and (h < 0.0)

    def _extract_textures(self) -> bool:
        """Extract terrain texture data"""
        try:
            # Minimal, practical texture export for the current WebGL viewer:
            # - export a handful of known terrain textures (diffuse/normal)
            # - export a blend mask (fallback: reuse a height texture if available)
            #
            # This is a best-effort stopgap until we implement true GTA terrain material blending.
            self.export_textures = {}

            wanted = [
                # Viewer defaults (webgl_viewer/js/terrain_renderer.js)
                "cs_rsn_sl_agrdirttrack3",
                "cs_rsn_sl_agrgrass_02_dark",
                "og_coastgrass_01",
                "cs_rsn_sl_cstcliff_0003",
                "cs_islx_canyonrock_rough_01",
                "cs_rsn_sl_rockslime_01",
                "cs_rsn_sl_agrdirttrack1",
                "cs_islx_wetlandmud03b",
                "cs_rsn_sl_uwshell_0001",
            ]

            # Prefer DLC-aware resolution via GameFileCache.YtdDict when available.
            def resolve_ytd_entry_by_base(base_name: str):
                try:
                    gfc = self.dll_manager.get_game_file_cache()
                    if gfc is None or not getattr(gfc, "IsInited", False):
                        return None
                    from .hash import jenkins_hash
                    h = int(jenkins_hash(str(base_name))) & 0xFFFFFFFF
                    d = getattr(gfc, "YtdDict", None)
                    if d is None:
                        return None
                    # Dictionary<uint, RpfFileEntry>: try direct indexer first.
                    try:
                        return d[h]
                    except Exception:
                        pass
                    # Fallback: iterate KeyValuePairs.
                    for kv in d:
                        try:
                            k = int(getattr(kv, "Key", None) or kv.Key) & 0xFFFFFFFF
                            if k != h:
                                continue
                            return getattr(kv, "Value", None) or kv.Value
                        except Exception:
                            continue
                    return None
                except Exception:
                    return None

            def find_ytd_paths_by_name(ytd_filename: str) -> List[str]:
                # Back-compat fallback (scan-order dependent): keep only if we can’t use GameFileCache dicts.
                matches: List[str] = []
                all_rpfs = getattr(self.rpf_manager, "AllRpfs", None)
                if not all_rpfs:
                    return matches
                ytd_lower = ytd_filename.lower()
                for rpf in all_rpfs:
                    entries = getattr(rpf, "AllEntries", None)
                    if not entries:
                        continue
                    for entry in entries:
                        en = str(getattr(entry, "Name", "")).lower()
                        if en == ytd_lower:
                            matches.append(str(getattr(entry, "Path", "")))
                return matches

            def pick_texture(ytd_textures: Dict[str, Tuple[np.ndarray, str]], candidates: List[str]) -> Optional[Tuple[str, np.ndarray, str]]:
                lower_map = {k.lower(): k for k in ytd_textures.keys()}
                for c in candidates:
                    k = lower_map.get(c.lower())
                    if k:
                        img, fmt = ytd_textures[k]
                        return (k, img, fmt)
                for c in candidates:
                    cl = c.lower()
                    for k in ytd_textures.keys():
                        if cl in k.lower():
                            img, fmt = ytd_textures[k]
                            return (k, img, fmt)
                return None

            texture_info: Dict[str, Any] = {}

            for base in wanted:
                ytd_entry = resolve_ytd_entry_by_base(base)
                ytd_path = str(getattr(ytd_entry, "Path", "") or "") if ytd_entry is not None else ""
                if not ytd_path:
                    ytd_paths = find_ytd_paths_by_name(f"{base}.ytd")
                    if not ytd_paths:
                        continue
                    ytd_path = ytd_paths[0]

                ytd = self.rpf_reader.get_ytd(ytd_path)
                if not ytd:
                    continue

                # Parity/provenance: hash the source YTD once per base texture (best effort).
                try:
                    from .provenance_tools import sha1_hex
                    data = self.rpf_manager.GetFileData(ytd_path)
                    b = bytes(data) if data else b""
                    self.parity_texture_sources.append({
                        "type": "ytd",
                        "ytd_path": ytd_path,
                        "base": base,
                        "source_size": int(len(b)),
                        "source_sha1": sha1_hex(b),
                    })
                except Exception:
                    pass

                ytd_textures = self.rpf_reader.get_ytd_textures(ytd)
                if not ytd_textures:
                    continue

                diff_pick = pick_texture(ytd_textures, [f"{base}_diffuse", base, f"{base}_d"])
                if diff_pick:
                    _n, diff_img, _fmt = diff_pick
                    self.export_textures[f"{base}_diffuse.png"] = diff_img

                norm_pick = pick_texture(ytd_textures, [f"{base}_normal", f"{base}_n", f"{base}_bump", f"{base}_nm"])
                has_normal = False
                if norm_pick:
                    _n, n_img, _fmt = norm_pick
                    self.export_textures[f"{base}_normal.png"] = n_img
                    has_normal = True

                if diff_pick or norm_pick:
                    texture_info[base] = {
                        "format": diff_pick[2] if diff_pick else (norm_pick[2] if norm_pick else "unknown"),
                        "has_normal": bool(has_normal),
                    }

            # Blend mask: use a known height texture if we exported one; otherwise skip.
            blend_mask_available = False
            for fname in list(self.export_textures.keys()):
                stem = Path(fname).stem.lower()
                if stem.endswith("_height_diffuse") or ("height" in stem and "diffuse" in stem):
                    self.export_textures["terrain_blend_mask.png"] = self.export_textures[fname]
                    blend_mask_available = True
                    break

            # Viewer-friendly layer list (best effort)
            layers: List[Dict[str, Any]] = []
            for ln in [
                "cs_rsn_sl_agrgrass_02_dark",
                "cs_rsn_sl_cstcliff_0003",
                "cs_islx_canyonrock_rough_01",
                "cs_rsn_sl_rockslime_01",
            ]:
                if ln in texture_info:
                    layers.append({"name": ln, "has_normal": texture_info[ln].get("has_normal", False)})
            texture_info["layers"] = layers
            if blend_mask_available:
                texture_info["blend_mask"] = True

            self.terrain_info["texture_info"] = texture_info
            self.terrain_info["num_textures"] = len([k for k in texture_info.keys() if k not in ("layers", "blend_mask")])
            return True
            
        except Exception as e:
            logger.error(f"Error extracting textures: {e}")
            return False

    def _generate_terrain_geometry(self) -> bool:
        """Generate terrain geometry from heightmap data"""
        try:
            if self.heightmap_data is None:
                logger.error("No heightmap data available")
                return False
            
            # Create terrain geometry
            self.geometry = TerrainGeometry()
            
            # Generate vertices
            vertices = []
            normals = []
            uvs = []
            indices = []
            
            # Create vertex grid
            for y in range(self.height):
                for x in range(self.width):
                    # Vertex position
                    vx = x / (self.width - 1)
                    vy = y / (self.height - 1)
                    vz = self.heightmap_data[y, x]
                    vertices.append([vx, vy, vz])
                    
                    # Normal
                    normals.append(self.normal_data[y, x])
                    
                    # UV coordinates
                    uvs.append([vx, vy])
                    
            # Create triangles
            for y in range(self.height - 1):
                for x in range(self.width - 1):
                    v1 = y * self.width + x
                    v2 = v1 + 1
                    v3 = (y + 1) * self.width + x
                    v4 = v3 + 1
                    
                    # First triangle
                    indices.extend([v1, v2, v3])
                    # Second triangle
                    indices.extend([v2, v4, v3])
                    
            # Store geometry data
            self.geometry.vertices = np.array(vertices, dtype=np.float32)
            self.geometry.normals = np.array(normals, dtype=np.float32)
            self.geometry.uvs = np.array(uvs, dtype=np.float32)
            self.geometry.indices = np.array(indices, dtype=np.uint32)
            
            return True
            
        except Exception as e:
            logger.error(f"Error generating terrain geometry: {e}")
            return False

    def _extract_water_data(self) -> bool:
        """Extract water data"""
        try:
            # For now, just create placeholder water data
            # This should be implemented to load actual water data
            self.water_data = None
            return True
            
        except Exception as e:
            logger.error(f"Error extracting water data: {e}")
            return False

    def _extract_vegetation_data(self) -> bool:
        """Extract vegetation data"""
        try:
            # For now, just return True
            # This should be implemented to load actual vegetation data
            return True
            
        except Exception as e:
            logger.error(f"Error extracting vegetation data: {e}")
            return False

    def _extract_road_data(self) -> bool:
        """Extract road data"""
        try:
            # For now, just return True
            # This should be implemented to load actual road data
            return True
            
        except Exception as e:
            logger.error(f"Error extracting road data: {e}")
            return False

    def _process_asset_dependencies(self) -> bool:
        """Process asset dependencies"""
        try:
            # For now, just return True
            # This should be implemented to track asset dependencies
            return True
            
        except Exception as e:
            logger.error(f"Error processing asset dependencies: {e}")
            return False
        
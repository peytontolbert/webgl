#!/usr/bin/env python3
"""
GTA5 Terrain Extractor
---------------------
Extract and visualize terrain data from GTA5.
"""

import os
import sys
import logging
import time
import argparse
import dotenv
from pathlib import Path

from gta5_modules.terrain_system import TerrainSystem
from gta5_modules.building_system import BuildingSystem
from gta5_modules.dll_manager import DllManager

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Load environment variables
dotenv.load_dotenv()

def main():
    """Main function"""
    parser = argparse.ArgumentParser(description='Extract and visualize GTA5 terrain data')
    parser.add_argument('--game-path', help='Path to GTA5 installation directory')
    parser.add_argument('--output-dir', default='output', help='Output directory')
    parser.add_argument('--debug', action='store_true', help='Enable debug logging')
    args = parser.parse_args()
    
    # Set debug mode if requested
    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)
    
    start_time = time.time()
    
    # Get game path from environment variable or command line
    game_path = args.game_path or os.getenv('gta5_path')
    if not game_path:
        # Try to find GTA5 in common locations
        common_paths = [
            r"C:\Program Files\Epic Games\GTAV",
            r"C:\Program Files (x86)\Steam\steamapps\common\Grand Theft Auto V",
            r"D:\Program Files\Epic Games\GTAV",
            r"D:\Program Files (x86)\Steam\steamapps\common\Grand Theft Auto V"
        ]
        
        for path in common_paths:
            if Path(path).exists():
                game_path = path
                break
        
        if not game_path:
            logger.error("GTA5 installation directory not found")
            logger.info("Please specify the path using --game-path or set gta5_path in .env file")
            return False
    
    game_path = Path(game_path)
    if not game_path.exists():
        logger.error(f"Game path does not exist: {game_path}")
        return False
    
    logger.info(f"Using game path: {game_path}")
    
    # Create output directory
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    try:
        # Initialize DLL manager first
        dll_manager = DllManager(str(game_path))
        if not dll_manager.initialized:
            logger.error("Failed to initialize DLL manager")
            return False
            
        # Initialize terrain system with DLL manager
        terrain_system = TerrainSystem(str(game_path), dll_manager)
        
        # Extract terrain data
        logger.info("Extracting terrain data...")
        if not terrain_system.extract_terrain():
            logger.error("Failed to extract terrain data")
            return False
        
        # Get terrain info
        terrain_info = terrain_system.get_terrain_info()
        
        # Log heightmap info
        logger.info(f"Loaded {terrain_info['num_heightmaps']} heightmap(s)")
        for path, dims in terrain_info['dimensions'].items():
            logger.info(f"  - {path}: {dims['width']}x{dims['height']}")
        
        # Log texture info
        logger.info(f"Loaded {terrain_info['num_textures']} texture(s)")
        for name, tex_info in terrain_info.get('texture_info', {}).items():
            # `texture_info` can contain meta keys like `layers` (list) and `blend_mask` (bool)
            if not isinstance(tex_info, dict):
                continue
            fmt = tex_info.get('format', 'unknown')
            has_normal = bool(tex_info.get('has_normal', False))
            logger.info(f"  - {name}: {fmt}" + (" (with normal map)" if has_normal else ""))
        
        # Initialize building system with terrain system
        building_system = BuildingSystem(str(game_path), dll_manager, terrain_system, output_dir=output_dir)
        
        # Extract building data
        logger.info("Extracting building data...")
        if not building_system.extract_buildings():
            logger.warning("Building extraction returned no results (continuing with terrain-only output).")
        
        # Get building info
        building_info = building_system.get_building_info()
        
        # Log building info
        logger.info(f"Loaded {building_info['num_buildings']} buildings")
        logger.info(f"Loaded {building_info['num_structures']} structures")
        logger.info("Building types:")
        for btype, count in building_info['building_types'].items():
            logger.info(f"  - {btype}: {count}")
        
        # Log water info
        if building_info.get('water_info') and building_info['water_info'].get('num_vertices') is not None:
            water_info = building_info['water_info']
            logger.info("Water data:")
            logger.info(f"  - Vertices: {water_info['num_vertices']}")
            logger.info(f"  - Triangles: {water_info['num_triangles']}")
            logger.info(f"  - Bounds: {water_info['bounds']}")
        
        # Create visualizations
        logger.info("Creating visualizations...")
        terrain_system.visualize_terrain(output_dir)
        
        # Export 3D mesh
        logger.info("Exporting 3D mesh...")
        terrain_system.export_obj(str(output_dir / 'terrain.obj'))
        
        # Export building mesh
        logger.info("Exporting building mesh...")
        building_system.export_obj(str(output_dir / 'buildings.obj'))
        
        # Export terrain info
        logger.info("Exporting terrain info...")
        terrain_system.export_terrain_info(output_dir)
        
        # Export building info
        logger.info("Exporting building info...")
        building_system.export_building_info(output_dir)
        
        elapsed_time = time.time() - start_time
        logger.info(f"Terrain and building extraction completed in {elapsed_time:.2f} seconds")
        logger.info(f"Output files saved to {output_dir.absolute()}")
        
        return True
        
    except Exception as e:
        logger.error(f"An error occurred: {e}")
        if args.debug:
            import traceback
            logger.debug(traceback.format_exc())
        return False
        
    finally:
        # Cleanup
        if 'dll_manager' in locals():
            dll_manager.cleanup()

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)

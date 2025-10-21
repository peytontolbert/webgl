#!/usr/bin/env python3
"""
GTA 5 Terrain Extractor
-----------------------
This script extracts and visualizes terrain data from GTA 5 using CodeWalker.
"""

import os
import logging
import time
import dotenv
from pathlib import Path

# Import our modules
from codewalker_integration import CodeWalkerIntegration
from terrain_extraction import TerrainExtractor
from visualization import TerrainVisualizer, TerrainExporter

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Load environment variables
dotenv.load_dotenv()

def main():
    """Main function to extract and visualize GTA 5 terrain"""
    start_time = time.time()
    
    # Get game path from environment variables
    game_path = os.getenv('gta_location')
    if not game_path:
        logger.error("Game path not found in .env file")
        logger.error("Please set the gta_location environment variable")
        return False
    
    # Remove quotes if present
    game_path = game_path.strip('"\'')
    logger.info(f"Using game path: {game_path}")
    
    # Set output directory
    output_dir = Path("output")
    os.makedirs(output_dir, exist_ok=True)
    
    try:
        # Step 1: Initialize CodeWalker integration
        logger.info("Initializing CodeWalker integration...")
        codewalker = CodeWalkerIntegration(game_path)
        
        # Step 2: Extract terrain data
        logger.info("Extracting terrain data...")
        extractor = TerrainExtractor(codewalker)
        if not extractor.extract_terrain():
            logger.error("Failed to extract terrain data")
            return False
        
        # Get the extracted heightmaps
        heightmaps = extractor.get_terrain_data()
        logger.info(f"Successfully extracted {len(heightmaps)} heightmaps")
        
        # Step 3: Visualize terrain
        logger.info("Visualizing terrain...")
        visualizer = TerrainVisualizer(output_dir)
        visualizer.visualize_terrain(heightmaps)
        
        # Step 4: Export terrain data
        logger.info("Exporting terrain data...")
        exporter = TerrainExporter(output_dir)
        
        # Export as OBJ
        exporter.export_terrain_obj(heightmaps)
        
        # Export in all formats
        exporter.export_terrain_data(heightmaps)
        
        elapsed_time = time.time() - start_time
        logger.info(f"Terrain extraction completed in {elapsed_time:.2f} seconds")
        logger.info(f"Output files saved to {output_dir.absolute()}")
        
        return True
    except Exception as e:
        logger.error(f"An error occurred: {e}")
        import traceback
        logger.debug(traceback.format_exc())
        return False

if __name__ == "__main__":
    # Check if CodeWalker DLL is available, if not, compile it
    codewalker_dll = os.getenv('codewalker_dll')
    if not codewalker_dll or not Path(codewalker_dll).exists():
        logger.info("CodeWalker DLL not found, compiling...")
        try:
            import compile_codewalker
            codewalker_path = os.getenv('codewalker_map')
            if codewalker_path:
                codewalker_path = codewalker_path.strip('"\'')
                dll_path = compile_codewalker.compile_codewalker_files(codewalker_path)
                if dll_path:
                    logger.info(f"Successfully compiled CodeWalker DLL: {dll_path}")
                else:
                    logger.warning("Failed to compile CodeWalker DLL, will use fallback methods")
            else:
                logger.warning("CodeWalker path not found in .env file, will use fallback methods")
        except Exception as e:
            logger.warning(f"Error compiling CodeWalker DLL: {e}")
            logger.warning("Will use fallback methods")
    
    # Run the main function
    success = main()
    if not success:
        logger.error("Terrain extraction failed")
        exit(1)
    else:
        logger.info("Terrain extraction completed successfully")
        exit(0) 
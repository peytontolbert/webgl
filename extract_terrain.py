#!/usr/bin/env python3
"""
GTA5 Terrain Extractor
--------------------
Main script for extracting terrain data from GTA5 using CodeWalker.
"""

import os
import sys
import logging
import argparse
from pathlib import Path
from typing import Optional

from codewalker_modules.terrain import TerrainExtractor

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

def parse_args():
    """Parse command line arguments"""
    parser = argparse.ArgumentParser(
        description="Extract terrain data from GTA5 using CodeWalker"
    )
    
    parser.add_argument(
        "--source-dir",
        type=str,
        required=True,
        help="Directory containing CodeWalker source files"
    )
    
    parser.add_argument(
        "--output-dir",
        type=str,
        default="./output",
        help="Directory to output extracted terrain data"
    )
    
    parser.add_argument(
        "--rpf-path",
        type=str,
        required=True,
        help="Path to the RPF file containing heightmap data"
    )
    
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force recompilation of CodeWalker DLL"
    )
    
    parser.add_argument(
        "--stats",
        action="store_true",
        help="Calculate and output terrain statistics"
    )
    
    parser.add_argument(
        "--mesh",
        action="store_true",
        help="Extract terrain mesh data"
    )
    
    return parser.parse_args()

def main():
    """Main entry point"""
    try:
        # Parse command line arguments
        args = parse_args()
        
        # Create output directory
        os.makedirs(args.output_dir, exist_ok=True)
        
        # Initialize terrain extractor
        extractor = TerrainExtractor(args.source_dir)
        success, error = extractor.initialize(args.force)
        
        if not success:
            logger.error(f"Failed to initialize terrain extractor: {error}")
            return 1
            
        # Extract heightmap data
        heightmap_path = os.path.join(args.output_dir, "heightmap.npy")
        success, error = extractor.extract_heightmap(args.rpf_path, heightmap_path)
        
        if not success:
            logger.error(f"Failed to extract heightmap: {error}")
            return 1
            
        logger.info(f"Successfully extracted heightmap to {heightmap_path}")
        
        # Process heightmap
        terrain_info = extractor.process_heightmap(heightmap_path)
        if terrain_info:
            logger.info("Terrain information:")
            logger.info(f"  Dimensions: {terrain_info['dimensions']['width']}x{terrain_info['dimensions']['height']}")
            logger.info(f"  Elevation range: {terrain_info['elevation']['min']:.2f} to {terrain_info['elevation']['max']:.2f}")
            logger.info(f"  Mean elevation: {terrain_info['elevation']['mean']:.2f}")
        
        # Calculate statistics if requested
        if args.stats:
            stats = extractor.calculate_terrain_statistics(heightmap_path)
            if stats:
                logger.info("\nTerrain statistics:")
                logger.info(f"  Mean slope: {stats['slope']['mean']:.2f} degrees")
                logger.info(f"  Max slope: {stats['slope']['max']:.2f} degrees")
                logger.info(f"  Mean roughness: {stats['roughness']['mean']:.2f}")
                logger.info(f"  Roughness std: {stats['roughness']['std']:.2f}")
        
        # Extract mesh if requested
        if args.mesh:
            mesh_path = os.path.join(args.output_dir, "terrain_mesh.npz")
            success, error = extractor.extract_terrain_mesh(heightmap_path, mesh_path)
            
            if success:
                logger.info(f"\nSuccessfully extracted terrain mesh to {mesh_path}")
            else:
                logger.error(f"Failed to extract terrain mesh: {error}")
        
        return 0
        
    except Exception as e:
        logger.error(f"Error: {e}")
        return 1

if __name__ == "__main__":
    sys.exit(main()) 
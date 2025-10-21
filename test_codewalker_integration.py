#!/usr/bin/env python3
"""
Test CodeWalker Integration
--------------------------
This script tests the CodeWalker integration to ensure it's working correctly.
"""

import os
import sys
import logging
import time
import dotenv
from pathlib import Path

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Load environment variables
dotenv.load_dotenv()

def ensure_modules_exist():
    """Ensure all required modules exist"""
    required_modules = [
        'codewalker_modules/__init__.py',
        'codewalker_modules/compiler.py',
        'codewalker_modules/stubs.py',
        'codewalker_modules/integration.py'
    ]
    
    missing_modules = []
    for module in required_modules:
        if not Path(module).exists():
            missing_modules.append(module)
    
    if missing_modules:
        logger.error(f"Missing required module files: {', '.join(missing_modules)}")
        logger.error("Please ensure all module files are in the correct directories.")
        return False
    
    return True

def test_compiler():
    """Test the compiler module"""
    logger.info("Testing compiler module...")
    
    try:
        from codewalker_modules.compiler import compile_codewalker_files, verify_compiled_dll
        
        # Get CodeWalker path
        codewalker_path = os.getenv('codewalker_map')
        if not codewalker_path:
            logger.error("CodeWalker path not found in .env file")
            logger.info("Please enter the path to your CodeWalker source code:")
            codewalker_path = input().strip('"\'')
            if not codewalker_path:
                logger.error("No CodeWalker path provided")
                return False
            
            # Update .env file
            with open('.env', 'a') as f:
                f.write(f'\ncodewalker_map="{codewalker_path}"\n')
        else:
            codewalker_path = codewalker_path.strip('"\'')
        
        if not Path(codewalker_path).exists():
            logger.error(f"CodeWalker path does not exist: {codewalker_path}")
            return False
        
        # Check if CodeWalker source files exist
        if not Path(codewalker_path, "CodeWalker.Core").exists():
            logger.error(f"CodeWalker.Core directory not found in {codewalker_path}")
            logger.error("Please make sure you have downloaded the CodeWalker source code.")
            logger.info("You can download it from: https://github.com/dexyfex/CodeWalker")
            return False
        
        # Check if we already have a compiled DLL
        dll_path = os.getenv('codewalker_dll')
        if dll_path and Path(dll_path).exists():
            logger.info(f"Using existing CodeWalker DLL: {dll_path}")
            
            # Verify the DLL
            if verify_compiled_dll(dll_path):
                logger.info("Existing DLL verified successfully")
                return True
            else:
                logger.warning("Existing DLL verification failed, will recompile")
        
        # Compile the DLL
        logger.info("Compiling CodeWalker DLL...")
        dll_path = compile_codewalker_files(codewalker_path)
        if not dll_path:
            logger.error("Failed to compile CodeWalker DLL")
            return False
        
        # Verify the DLL
        if verify_compiled_dll(dll_path):
            logger.info("Compiled DLL verified successfully")
            
            # Update .env file with the DLL path
            with open('.env', 'a') as f:
                f.write(f'\ncodewalker_dll="{dll_path}"\n')
            
            return True
        else:
            logger.error("Compiled DLL verification failed")
            return False
    except Exception as e:
        logger.error(f"Error testing compiler module: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return False

def test_integration():
    """Test the integration module"""
    logger.info("Testing integration module...")
    
    try:
        from codewalker_modules.integration import CodeWalkerIntegration
        
        # Get game path
        game_path = os.getenv('gta_location')
        if not game_path:
            logger.error("Game path not found in .env file")
            logger.info("Please enter the path to your GTA 5 installation:")
            game_path = input().strip('"\'')
            if not game_path:
                logger.error("No game path provided")
                return False
            
            # Update .env file
            with open('.env', 'a') as f:
                f.write(f'\ngta_location="{game_path}"\n')
        else:
            game_path = game_path.strip('"\'')
        
        if not Path(game_path).exists():
            logger.error(f"Game path does not exist: {game_path}")
            return False
        
        # Initialize CodeWalker integration
        logger.info(f"Initializing CodeWalker integration with game path: {game_path}")
        codewalker = CodeWalkerIntegration(game_path)
        
        # Check if initialization was successful
        if not codewalker.rpf_manager:
            logger.error("Failed to initialize CodeWalker integration")
            return False
        
        logger.info("CodeWalker integration initialized successfully")
        
        # Find heightmap files
        logger.info("Finding heightmap files...")
        heightmap_files = codewalker.find_heightmap_files()
        
        if not heightmap_files or len(heightmap_files) == 0:
            logger.warning("No heightmap files found")
            return False
        
        logger.info(f"Found {len(heightmap_files)} heightmap files")
        
        # Test getting heightmap data
        logger.info("Testing heightmap data extraction...")
        for i, heightmap_file in enumerate(heightmap_files):
            logger.info(f"Processing heightmap file {i+1}/{len(heightmap_files)}")
            
            # Get heightmap data
            heightmap_data = codewalker.get_heightmap_data(heightmap_file)
            if not heightmap_data:
                logger.warning(f"Failed to extract data from heightmap file {i+1}")
                continue
            
            logger.info(f"Heightmap dimensions: {heightmap_data['width']}x{heightmap_data['height']}")
            logger.info(f"Bounding box: Min{heightmap_data['bb_min']}, Max{heightmap_data['bb_max']}")
            
            # Get terrain vertices
            logger.info("Getting terrain vertices...")
            vertices = codewalker.get_terrain_vertices(heightmap_file)
            if not vertices:
                logger.warning("Failed to get terrain vertices")
                continue
            
            logger.info(f"Generated {len(vertices)} terrain vertices")
            
            # Success!
            logger.info(f"Successfully processed heightmap file {i+1}")
            return True
        
        logger.warning("Failed to process any heightmap files")
        return False
    except Exception as e:
        logger.error(f"Error testing integration module: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return False

def main():
    """Main function to test CodeWalker integration"""
    start_time = time.time()
    
    # Test compiler module
    if not test_compiler():
        logger.error("Compiler module test failed")
        return False
    
    # Test integration module
    if not test_integration():
        logger.error("Integration module test failed")
        return False
    
    elapsed_time = time.time() - start_time
    logger.info(f"All tests completed successfully in {elapsed_time:.2f} seconds")
    return True

if __name__ == "__main__":
    # Ensure all required modules exist
    if not ensure_modules_exist():
        logger.error("Missing required modules. Please check the error messages above.")
        sys.exit(1)
    
    # Run the main function
    success = main()
    if not success:
        logger.error("Tests failed")
        sys.exit(1)
    else:
        logger.info("All tests passed")
        sys.exit(0) 
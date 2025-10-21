#!/usr/bin/env python3
"""
Test CodeWalker Modules
----------------------
This script tests the modular implementation of CodeWalker integration.
"""

import os
import sys
import logging
import dotenv
from pathlib import Path
import time

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
        'codewalker_modules/integration.py',
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
            return False
        
        codewalker_path = codewalker_path.strip('"\'')
        if not Path(codewalker_path).exists():
            logger.error(f"CodeWalker path does not exist: {codewalker_path}")
            return False
        
        # Check if we should compile
        should_compile = True
        dll_path = os.getenv('codewalker_dll')
        if dll_path and Path(dll_path).exists():
            logger.info(f"Found existing DLL at {dll_path}")
            should_compile = input("Recompile DLL? (y/n): ").lower() == 'y'
        
        if should_compile:
            # Compile CodeWalker files
            logger.info(f"Compiling CodeWalker files from {codewalker_path}...")
            dll_path = compile_codewalker_files(codewalker_path)
            if not dll_path:
                logger.error("Failed to compile CodeWalker files")
                return False
            
            # Update .env file with the DLL path
            with open('.env', 'a') as f:
                f.write(f'\ncodewalker_dll="{dll_path}"\n')
        
        # Verify the DLL
        logger.info(f"Verifying DLL at {dll_path}...")
        if not verify_compiled_dll(dll_path):
            logger.error("Failed to verify compiled DLL")
            return False
        
        logger.info("Compiler module test passed")
        return True
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
            return False
        
        game_path = game_path.strip('"\'')
        if not Path(game_path).exists():
            logger.error(f"Game path does not exist: {game_path}")
            return False
        
        # Initialize CodeWalker integration
        logger.info(f"Initializing CodeWalker integration with game path: {game_path}...")
        codewalker = CodeWalkerIntegration(game_path)
        
        # Find heightmap files
        logger.info("Finding heightmap files...")
        heightmap_files = codewalker.find_heightmap_files()
        
        if not heightmap_files:
            logger.warning("No heightmap files found")
            return False
        
        logger.info(f"Found {len(heightmap_files)} heightmap files")
        for i, hmf in enumerate(heightmap_files):
            logger.info(f"Heightmap {i+1}: {hmf.Name if hasattr(hmf, 'Name') else 'Unknown'}")
            logger.info(f"  Width: {hmf.Width}, Height: {hmf.Height}")
            if hasattr(hmf, 'BBMin') and hasattr(hmf, 'BBMax'):
                logger.info(f"  Bounds: {hmf.BBMin} to {hmf.BBMax}")
        
        logger.info("Integration module test passed")
        return True
    except Exception as e:
        logger.error(f"Error testing integration module: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return False

def main():
    """Main function to test CodeWalker modules"""
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
    logger.info(f"All tests completed in {elapsed_time:.2f} seconds")
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
"""
CodeWalker Integration Module
--------------------------
Handles integration with compiled CodeWalker DLL for terrain extraction.
"""

import os
import clr
import logging
import subprocess
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

def verify_compiled_dll(dll_path: str) -> bool:
    """
    Verify that a compiled DLL exists and is valid.
    
    Args:
        dll_path: Path to the DLL to verify
        
    Returns:
        bool: True if the DLL is valid, False otherwise
    """
    if not os.path.exists(dll_path):
        logger.error(f"DLL not found at {dll_path}")
        return False
    
    try:
        # Try to verify the DLL using dotnet ilverify
        result = subprocess.run(
            ["dotnet", "ilverify", dll_path],
            capture_output=True,
            text=True
        )
        
        if result.returncode != 0:
            logger.error(f"DLL verification failed:\n{result.stdout}\n{result.stderr}")
            return False
        
        logger.info("DLL verification successful")
        return True
        
    except Exception as e:
        logger.error(f"Error verifying DLL: {e}")
        return False

def load_codewalker_dll(dll_path: str) -> bool:
    """
    Load the CodeWalker DLL for terrain extraction.
    
    Args:
        dll_path: Path to the compiled CodeWalker DLL
        
    Returns:
        bool: True if DLL was loaded successfully, False otherwise
    """
    try:
        # Add DLL directory to path
        dll_dir = os.path.dirname(dll_path)
        if dll_dir not in os.environ["PATH"]:
            os.environ["PATH"] = f"{dll_dir};{os.environ['PATH']}"
        
        # Load the DLL
        clr.AddReference(dll_path)
        
        # Import required namespaces
        global Vector3, HeightmapFile, Heightmaps
        from CodeWalker.Core import Vector3
        from CodeWalker.Core.GameFiles.FileTypes import HeightmapFile
        from CodeWalker.Core.World import Heightmaps
        
        logger.info("Successfully loaded CodeWalker DLL")
        return True
        
    except Exception as e:
        logger.error(f"Failed to load CodeWalker DLL: {e}")
        return False

def initialize_codewalker(source_dir: str, output_dir: str = "./compiled_cw", force: bool = False) -> Tuple[bool, Optional[str]]:
    """
    Initialize CodeWalker for terrain extraction.
    
    Args:
        source_dir: Directory containing CodeWalker source files
        output_dir: Directory to output compiled files
        force: If True, recompile even if DLL exists
        
    Returns:
        Tuple[bool, Optional[str]]: (Success status, Error message if any)
    """
    try:
        # Import compiler module
        from .compiler import compile_codewalker_files
        
        # Compile the DLL if needed
        dll_path = compile_codewalker_files(source_dir, output_dir, force)
        if not dll_path:
            return False, "Failed to compile CodeWalker DLL"
            
        # Verify the DLL
        if not verify_compiled_dll(dll_path):
            return False, "Failed to verify compiled DLL"
            
        # Load the DLL
        if not load_codewalker_dll(dll_path):
            return False, "Failed to load CodeWalker DLL"
            
        # Initialize GTA5Keys
        try:
            from CodeWalker.GameFiles.Utils import GTA5Keys
            # Try to load keys from magic.dat in Resources
            resources_dir = os.path.join(source_dir, "CodeWalker.Core", "Resources")
            GTA5Keys.LoadFromPath(resources_dir)
            logger.info("Successfully loaded keys from magic.dat")
        except Exception as e:
            logger.error(f"Failed to load keys: {e}")
            return False, f"Failed to load keys: {e}"
            
        return True, None
        
    except Exception as e:
        return False, f"Error initializing CodeWalker: {e}"

def extract_terrain_heightmap(rpf_path: str, output_path: str) -> Tuple[bool, Optional[str]]:
    """
    Extract terrain heightmap from GTA5 RPF file.
    
    Args:
        rpf_path: Path to the RPF file containing heightmap data
        output_path: Path to save the extracted heightmap
        
    Returns:
        Tuple[bool, Optional[str]]: (Success status, Error message if any)
    """
    try:
        # Load the heightmap file
        heightmap = HeightmapFile()
        if not heightmap.Load(rpf_path):
            return False, "Failed to load heightmap file"
            
        # Extract heightmap data
        terrain_data = heightmap.GetTerrainData()
        if not terrain_data:
            return False, "Failed to extract terrain data"
            
        # Save heightmap to file
        terrain_data.Save(output_path)
        logger.info(f"Successfully extracted heightmap to {output_path}")
        
        return True, None
        
    except Exception as e:
        return False, f"Error extracting terrain heightmap: {e}" 
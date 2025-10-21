#!/usr/bin/env python3
"""
CodeWalker Compilation Script
---------------------------
Compiles CodeWalker.Core for terrain extraction.
"""

import logging
import sys
import os
import shutil
from pathlib import Path

from codewalker_modules.config_loader import CodeWalkerConfig
from codewalker_modules.project_config import get_minimal_config, ProjectConfig
from codewalker_modules.compiler import Compiler

# Configure variables
SCRIPT_DIR = Path(__file__).parent.absolute()  # Get the directory where this script is located
SOURCE_DIR = SCRIPT_DIR / "CodeWalker-master"  # Path to CodeWalker source directory
OUTPUT_DIR = SCRIPT_DIR / "compiled_cw"  # Output directory for compiled files
VERBOSE = True  # Enable verbose logging

# Configure project settings
PROJECT_CONFIG = {
    "target_framework": "net7.0-windows",
    "output_type": "Library",
    "enable_unsafe": True,
    "define_constants": ["WINDOWS", "RELEASE"],
    "system_references": [
        "System",
        "System.Core",
        "System.Data",
        "System.Drawing",
        "System.Numerics",
        "System.Runtime",
        "System.Runtime.Serialization",
        "System.Windows.Forms",
        "System.Xml",
        "System.Xml.Linq",
        "WindowsBase",
        "PresentationCore",
        "PresentationFramework",
        "System.Memory",
        "System.Buffers",
        "System.Runtime.CompilerServices.Unsafe",
        "System.Numerics.Vectors",
        "System.Collections",
        "System.Collections.Concurrent",
        "System.Threading",
        "System.Threading.Tasks",
        "System.IO.Compression",
        "System.IO.Compression.FileSystem",
        "System.ComponentModel",
        "System.ComponentModel.TypeConverter"
    ],
    "nuget_packages": {
        "Microsoft.CSharp": "4.7.0",
        "SharpDX": "4.2.0",
        "SharpDX.Mathematics": "4.2.0",
        "SharpDX.Direct3D11": "4.2.0",
        "SharpDX.DXGI": "4.2.0",
        "System.Drawing.Common": "6.0.0",
        "Microsoft.Win32.SystemEvents": "6.0.0",
        "System.Memory": "4.5.5",
        "System.Buffers": "4.5.1",
        "System.Runtime.CompilerServices.Unsafe": "6.0.0",
        "System.Numerics.Vectors": "4.5.0",
        "System.IO.Compression": "4.3.0"
    },
    "assembly_attributes": [
        'assembly: System.Runtime.CompilerServices.InternalsVisibleTo("CodeWalker.Core")',
        'assembly: System.Runtime.CompilerServices.InternalsVisibleTo("CodeWalker.World")',
        'assembly: System.Runtime.CompilerServices.InternalsVisibleTo("CodeWalker.GameFiles")'
    ]
}

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

def ensure_resources():
    """Ensure required resource files exist."""
    # Create empty magic.dat if it doesn't exist
    resources_dir = SOURCE_DIR / "CodeWalker.Core" / "Resources"
    magic_file = resources_dir / "magic.dat"
    
    # Print detailed path information
    logger.info(f"Script directory: {SCRIPT_DIR}")
    logger.info(f"Source directory: {SOURCE_DIR}")
    logger.info(f"Looking for magic.dat at: {magic_file.absolute()}")
    logger.info(f"Resources directory exists: {resources_dir.exists()}")
    logger.info(f"magic.dat exists: {magic_file.exists()}")
    
    if not magic_file.exists():
        logger.error(f"magic.dat not found at expected location: {magic_file.absolute()}")
        sys.exit(1)
    else:
        logger.info(f"Found magic.dat at: {magic_file.absolute()}")
        
    # Verify all required DLLs will be available
    required_dlls = [
        "SharpDX.dll",
        "SharpDX.Mathematics.dll",
        "SharpDX.Direct3D11.dll",
        "SharpDX.DXGI.dll",
        "System.Drawing.Common.dll",
        "Microsoft.Win32.SystemEvents.dll",
        "System.Memory.dll",
        "System.Buffers.dll",
        "System.Runtime.CompilerServices.Unsafe.dll",
        "System.Numerics.Vectors.dll",
        "System.IO.Compression.dll"
    ]
    
    # Create output directory if it doesn't exist
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    
    for dll in required_dlls:
        dll_path = OUTPUT_DIR / dll
        if not dll_path.exists():
            logger.warning(f"Required DLL will be copied during compilation: {dll}")
            
    # Ensure magic.dat is copied to output
    magic_output = OUTPUT_DIR / "magic.dat"
    if not magic_output.exists():
        logger.info("Copying magic.dat to output directory")
        try:
            magic_output.write_bytes(magic_file.read_bytes())
            logger.info(f"Successfully copied magic.dat to {magic_output}")
        except Exception as e:
            logger.error(f"Failed to copy magic.dat: {e}")
            sys.exit(1)

def main():
    """Main entry point for the script."""
    # Set verbose logging if requested
    if VERBOSE:
        logging.getLogger().setLevel(logging.DEBUG)
    
    try:
        logger.info("Starting compilation process...")
        
        # Ensure resources exist
        logger.info("Checking resources...")
        ensure_resources()
        logger.info("Resources check completed")
        
        # Load configuration
        logger.info("Loading CodeWalker configuration...")
        config = CodeWalkerConfig(SOURCE_DIR)
        logger.info("Verifying CodeWalker files...")
        if not config.verify_files():
            logger.error("Failed to verify CodeWalker files")
            sys.exit(1)
        logger.info("CodeWalker files verified successfully")
            
        # Create compiler
        logger.info("Creating compiler instance...")
        compiler = Compiler(config, OUTPUT_DIR / "CodeWalker.Core.dll")
        logger.info("Compiler instance created")
        
        # Create project configuration
        logger.info("Setting up project configuration...")
        project_config = ProjectConfig(**PROJECT_CONFIG)
        logger.info("Project configuration created")
        
        # Compile Core DLL
        logger.info("Starting compilation of CodeWalker.Core...")
        output_path = compiler.compile(project_config)
        if not output_path:
            logger.error("Compilation failed - no output path returned")
            sys.exit(1)
            
        logger.info("Compilation process completed successfully!")
            
    except Exception as e:
        logger.error(f"Compilation failed: {str(e)}")
        if VERBOSE:
            import traceback
            logger.debug("Full error traceback:")
            logger.debug(traceback.format_exc())
        sys.exit(1)
        
if __name__ == "__main__":
    main() 
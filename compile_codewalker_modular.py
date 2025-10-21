#!/usr/bin/env python3
"""
CodeWalker Compiler (Modular Version)
------------------------------------
This script compiles necessary CodeWalker source files into a usable .NET assembly.
It uses a modular approach for better maintainability.
"""

import os
import sys
import logging
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

def main():
    """Main function to compile CodeWalker files"""
    # Get CodeWalker path from environment variable
    codewalker_path = os.getenv('codewalker_map')
    if not codewalker_path:
        logger.error("Error: CodeWalker path not set in environment variables")
        logger.info("Please enter the path to your CodeWalker source code:")
        codewalker_path = input().strip('"\'')
        if not codewalker_path:
            logger.error("No CodeWalker path provided")
            sys.exit(1)
        
        # Update .env file
        with open('.env', 'a') as f:
            f.write(f'\ncodewalker_map="{codewalker_path}"\n')
    
    # Import our compiler module
    try:
        from codewalker_modules.compiler import compile_codewalker_files, verify_compiled_dll
    except ImportError:
        logger.error("Failed to import codewalker_modules. Make sure the modules are in the correct location.")
        sys.exit(1)
    
    # Compile CodeWalker files
    dll_path = compile_codewalker_files(codewalker_path)
    if dll_path:
        logger.info(f"You can now use the compiled DLL at: {dll_path}")
        
        # Update .env file with the DLL path
        with open('.env', 'a') as f:
            f.write(f'\ncodewalker_dll="{dll_path}"\n')
        
        # Verify the DLL
        verify_compiled_dll(dll_path)
    else:
        logger.error("Failed to compile CodeWalker DLL")
        sys.exit(1)

if __name__ == "__main__":
    main() 
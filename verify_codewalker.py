#!/usr/bin/env python
"""
Script to verify that Python.NET can load CodeWalker assemblies.
"""

import os
import sys
import dotenv
from pathlib import Path

# Load environment variables
dotenv.load_dotenv()

def check_pythonnet():
    """Check if Python.NET is installed"""
    try:
        import clr
        print("✓ Python.NET is installed")
        return True
    except ImportError:
        print("✗ Python.NET is not installed. Please install it with: pip install pythonnet")
        return False

def check_dotnet_framework():
    """Check if .NET Framework is installed"""
    try:
        import clr
        import System
        print(f"✓ .NET Framework is installed: {System.Environment.Version}")
        return True
    except Exception as e:
        print(f"✗ Error loading .NET Framework: {e}")
        return False

def check_codewalker_path():
    """Check if CodeWalker path is set in environment variables"""
    codewalker_path = os.getenv('codewalker_map')
    if codewalker_path:
        codewalker_path = Path(codewalker_path.strip('"\''))
        if codewalker_path.exists():
            print(f"✓ CodeWalker path exists: {codewalker_path}")
            return codewalker_path
        else:
            print(f"✗ CodeWalker path does not exist: {codewalker_path}")
            return None
    else:
        print("✗ CodeWalker path not found in environment variables")
        return None

def check_codewalker_dlls(codewalker_path):
    """Check if CodeWalker DLLs exist"""
    if not codewalker_path:
        return False
    
    required_dlls = [
        "CodeWalker.Core.dll",
        "CodeWalker.GameFiles.dll"
    ]
    
    all_exist = True
    for dll in required_dlls:
        dll_path = codewalker_path / dll
        if dll_path.exists():
            print(f"✓ Found {dll}")
        else:
            print(f"✗ Missing {dll}")
            all_exist = False
    
    return all_exist

def try_load_codewalker(codewalker_path):
    """Try to load CodeWalker assemblies"""
    if not codewalker_path:
        return False
    
    try:
        import clr
        
        # Add references to CodeWalker assemblies
        core_dll = str(codewalker_path / "CodeWalker.Core.dll")
        gamefiles_dll = str(codewalker_path / "CodeWalker.GameFiles.dll")
        
        print(f"Loading {core_dll}...")
        clr.AddReference(core_dll)
        
        print(f"Loading {gamefiles_dll}...")
        clr.AddReference(gamefiles_dll)
        
        # Try to import some classes
        from CodeWalker.GameFiles import RpfManager, HeightmapFile
        
        print("✓ Successfully loaded CodeWalker assemblies")
        return True
    except Exception as e:
        print(f"✗ Error loading CodeWalker assemblies: {e}")
        return False

def main():
    """Main function"""
    print("Verifying CodeWalker integration...")
    print("-" * 50)
    
    # Check if Python.NET is installed
    if not check_pythonnet():
        return False
    
    # Check if .NET Framework is installed
    if not check_dotnet_framework():
        return False
    
    # Check if CodeWalker path is set
    codewalker_path = check_codewalker_path()
    if not codewalker_path:
        return False
    
    # Check if CodeWalker DLLs exist
    if not check_codewalker_dlls(codewalker_path):
        return False
    
    # Try to load CodeWalker assemblies
    if not try_load_codewalker(codewalker_path):
        return False
    
    print("-" * 50)
    print("✓ CodeWalker integration verified successfully")
    return True

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1) 
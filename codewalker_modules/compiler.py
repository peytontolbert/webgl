"""
CodeWalker Compiler Module
-------------------------
Handles compilation of minimal CodeWalker files needed for GTA5 terrain extraction.
Uses a modular approach to handle different aspects of compilation.
"""

import os
import sys
import logging
import shutil
import tempfile
import subprocess
import re
from pathlib import Path
from typing import List, Optional

from .config_loader import CodeWalkerConfig
from .project_config import get_minimal_config, generate_project_xml, ProjectConfig
from .file_groups import get_minimal_groups

logger = logging.getLogger(__name__)

PROJECT_CONFIG = ProjectConfig(
    target_framework="net7.0-windows",
    output_type="Library",
    enable_unsafe=True,
    define_constants=["WINDOWS", "RELEASE"],
    nuget_packages={
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
    # For net7.0-windows (SDK-style), do not use legacy `<Reference Include="System" />` entries.
    system_references=[],
    assembly_attributes=[
        'assembly: System.Runtime.CompilerServices.InternalsVisibleTo("CodeWalker.Core")',
        'assembly: System.Runtime.CompilerServices.InternalsVisibleTo("CodeWalker.World")',
        'assembly: System.Runtime.CompilerServices.InternalsVisibleTo("CodeWalker.GameFiles")'
    ]
)

class FileGroup:
    """Represents a group of related source files"""
    def __init__(self, name: str, files: List[str], dependencies: List[str] = None):
        self.name = name
        self.files = files
        self.dependencies = dependencies or []

class CompilerConfig:
    """Configuration for the compiler"""
    def __init__(self):
        config = get_minimal_config()
        self.target_framework = config.target_framework
        self.output_type = config.output_type
        self.enable_unsafe = config.enable_unsafe
        self.define_constants = config.define_constants
        self.nuget_packages = config.nuget_packages
        self.system_references = config.system_references
        self.assembly_attributes = config.assembly_attributes

class Compiler:
    """Main compiler class that orchestrates the compilation process"""
    
    def __init__(self, config: CodeWalkerConfig, output_path: Path):
        """
        Initialize the compiler.
        
        Args:
            config: CodeWalker configuration
            output_path: Final output path for the compiled DLL
        """
        self.config = config
        self.output_path = output_path
        self.compiler_config = PROJECT_CONFIG
        
    def verify_environment(self) -> bool:
        """
        Verify that the environment is set up correctly.
        
        Returns:
            bool: True if environment is valid, False otherwise
        """
        # Check if dotnet is available
        try:
            subprocess.run(["dotnet", "--version"], capture_output=True, check=True)
        except (subprocess.CalledProcessError, FileNotFoundError):
            logger.error("dotnet SDK not found. Please install the .NET SDK")
            return False
            
        # Verify CodeWalker files
        if not self.config.verify_files():
            return False
            
        # Ensure output directory exists
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        
        return True
        
    def copy_source_files(self) -> None:
        """Copy source files to temp directory."""
        logger.info("Copying source files...")
        
        # Create CodeWalker.Core directory
        core_dir = self.temp_dir / "CodeWalker.Core"
        core_dir.mkdir(exist_ok=True)
        
        # Create subdirectories
        for subdir in ["GameFiles", "World", "Utils", "Resources", "Properties", "GameFiles/Utils", "GameFiles/Resources", "GameFiles/FileTypes", "GameFiles/MetaTypes"]:
            (core_dir / subdir).mkdir(exist_ok=True)
            
        # Get all required files from file groups
        file_groups = get_minimal_groups()
        all_files = set()
        
        # Add files from each group
        for group in file_groups.values():
            for file in group.files:
                all_files.add(file)
                
        # Copy all files
        for file in all_files:
            # Try to find the file in the source directory
            src = None
            possible_paths = [
                self.config.source_dir / "CodeWalker.Core" / file,
                self.config.source_dir / "CodeWalker.Core" / "GameFiles" / file,
                self.config.source_dir / "CodeWalker.Core" / "World" / file,
                self.config.source_dir / "CodeWalker.Core" / "Utils" / file,
                self.config.source_dir / "CodeWalker.Core" / "GameFiles" / "Utils" / file,
                self.config.source_dir / "CodeWalker.Core" / "GameFiles" / "Resources" / file,
                self.config.source_dir / "CodeWalker.Core" / "GameFiles" / "FileTypes" / file,
                self.config.source_dir / "CodeWalker.Core" / "GameFiles" / "MetaTypes" / file,
                self.config.source_dir / "CodeWalker.Core" / "Properties" / file
            ]
            
            for path in possible_paths:
                if path.exists():
                    src = path
                    break
                    
            if not src:
                logger.error(f"Could not find source file: {file}")
                logger.error("Searched in the following locations:")
                for path in possible_paths:
                    logger.error(f"  - {path}")
                raise FileNotFoundError(f"Source file not found: {file}")
                
            # Determine the correct destination path by preserving the original
            # relative path under CodeWalker.Core. This is critical for resources
            # (eg Properties/Resources.resx) and for keeping the folder structure
            # consistent with how CodeWalker expects to be built.
            core_root = self.config.source_dir / "CodeWalker.Core"
            try:
                rel = src.relative_to(core_root)
            except Exception:
                # Fallback: keep previous behavior if relative computation fails.
                rel = Path(file)
            dst = core_dir / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            
            try:
                shutil.copy2(src, dst)
                logger.debug(f"Copied {file} from {src} to {dst}")
            except Exception as e:
                logger.error(f"Failed to copy {file}: {e}")
                raise
                
        # Copy the entire Resources directory first
        resources_src = self.config.source_dir / "CodeWalker.Core" / "Resources"
        resources_dst = core_dir / "Resources"
        
        if resources_src.exists():
            logger.info(f"Copying Resources directory from {resources_src}")
            for item in resources_src.iterdir():
                if item.is_file():
                    shutil.copy2(item, resources_dst / item.name)
                    logger.debug(f"Copied resource file: {item.name}")
        else:
            logger.error(f"Resources directory not found at: {resources_src}")
            raise FileNotFoundError(f"Resources directory not found at: {resources_src}")
            
        # Copy magic.dat to the root Resources directory as well
        magic_src = resources_src / "magic.dat"
        magic_dst = self.temp_dir / "Resources" / "magic.dat"
        magic_dst.parent.mkdir(exist_ok=True)
        
        if magic_src.exists():
            shutil.copy2(magic_src, magic_dst)
            logger.debug("Copied magic.dat to root Resources directory")
        else:
            logger.error(f"magic.dat not found at: {magic_src}")
            raise FileNotFoundError(f"magic.dat not found at: {magic_src}")
                
        logger.info("Source files copied successfully")
            
    def create_project_file(self) -> None:
        """Create project file in temp directory."""
        logger.info("Creating project file...")
        
        project_xml = generate_project_xml(self.compiler_config)
        project_file = self.temp_dir / "CodeWalker.Core.csproj"
        
        try:
            with open(project_file, "w") as f:
                f.write(project_xml)
            logger.info(f"Project file created at: {project_file}")
        except Exception as e:
            logger.error(f"Failed to create project file: {e}")
            raise
            
    def compile(self, project_config: ProjectConfig) -> Optional[Path]:
        """
        Main compilation method.
        
        Args:
            project_config: Project configuration to use for compilation
            
        Returns:
            Optional[Path]: Path to compiled DLL if successful, None otherwise
        """
        logger.info("Starting compilation...")
        
        # Verify environment first
        if not self.verify_environment():
            return None
            
        # Create temp directory for compilation
        with tempfile.TemporaryDirectory(prefix="codewalker_") as temp:
            self.temp_dir = Path(temp)
            logger.info(f"Created temporary directory: {self.temp_dir}")
            
            try:
                # Copy source files
                self.copy_source_files()
                
                # Create project file
                self.create_project_file()
                
                # Run dotnet restore
                logger.info("Starting package restore with dotnet...")
                subprocess.run(
                    ["dotnet", "restore", str(self.temp_dir / "CodeWalker.Core.csproj")],
                    capture_output=True,
                    text=True,
                    check=True
                )
                logger.info("Package restore completed")
                
                # Run dotnet build
                logger.info("Starting compilation with dotnet...")
                build_result = subprocess.run(
                    ["dotnet", "build", str(self.temp_dir / "CodeWalker.Core.csproj"), "-c", "Release"],
                    capture_output=True,
                    text=True,
                    check=True
                )
                
                # Parse build output to find the DLL path
                output_lines = build_result.stdout.split('\n')
                dll_path = None
                for line in output_lines:
                    if "CodeWalker.Core ->" in line:
                        # Extract the path after the arrow
                        path_match = re.search(r'CodeWalker\.Core\s*->\s*(.*?CodeWalker\.Core\.dll)', line)
                        if path_match:
                            dll_path = Path(path_match.group(1))
                            break
                
                if not dll_path:
                    logger.error("Could not find DLL path in build output")
                    logger.error("Build output:")
                    logger.error(build_result.stdout)
                    return None
                    
                logger.info("Build completed successfully")
                logger.info(f"Compilation completed, output at: {dll_path}")
                
                # Verify the DLL exists
                if not dll_path.exists():
                    logger.error(f"Compiled DLL not found at: {dll_path}")
                    logger.error("Directory contents:")
                    for item in dll_path.parent.iterdir():
                        logger.error(f"  - {item}")
                    return None
                
                # Copy the DLL and its dependencies to the final location
                logger.info(f"Copying output to final location: {self.output_path}")
                
                # Copy all DLLs from the build output
                for file in dll_path.parent.glob("*.dll"):
                    final_file = self.output_path.parent / file.name
                    try:
                        shutil.copy2(file, final_file)
                        logger.info(f"Copied {file.name} to {final_file}")
                    except Exception as e:
                        logger.error(f"Failed to copy {file.name}: {e}")
                        return None
                
                # Copy runtime config if it exists
                runtime_config = dll_path.parent / "CodeWalker.Core.runtimeconfig.json"
                if runtime_config.exists():
                    final_config = self.output_path.parent / runtime_config.name
                    try:
                        shutil.copy2(runtime_config, final_config)
                        logger.info(f"Copied runtime config to {final_config}")
                    except Exception as e:
                        logger.error(f"Failed to copy runtime config: {e}")
                        return None
                
                # Copy the main DLL last
                try:
                    shutil.copy2(dll_path, self.output_path)
                    logger.info(f"Successfully copied main DLL to: {self.output_path}")
                except Exception as e:
                    logger.error(f"Failed to copy main DLL: {e}")
                    return None
                    
                return self.output_path
                
            except subprocess.CalledProcessError as e:
                logger.error(f"Build failed with error code {e.returncode}")
                logger.error("Build output:")
                logger.error(e.stdout)
                logger.error("Build errors:")
                logger.error(e.stderr)
                return None
            except Exception as e:
                logger.error(f"Compilation failed: {e}")
                logger.debug("Stack trace:", exc_info=True)
                return None

def compile_codewalker_files(source_dir: str, output_dir: str, force: bool = False) -> Optional[str]:
    """
    Compile minimal CodeWalker files needed for GTA5 terrain extraction.
    
    Args:
        source_dir: Path to CodeWalker source directory
        output_dir: Directory to output compiled files to
        force: Whether to force recompilation even if DLL exists
        
    Returns:
        Optional[str]: Path to compiled DLL if successful, None otherwise
    """
    try:
        compiler = Compiler(CodeWalkerConfig(source_dir), Path(output_dir) / "CodeWalker.Core.dll")
        result = compiler.compile(PROJECT_CONFIG)
        return str(result) if result else None
    except Exception as e:
        logger.error(f"Compilation failed: {e}")
        return None

def create_project_file(output_dir: str) -> str:
    """Create the minimal .NET project file for terrain extraction"""
    config = get_minimal_config()
    project_xml = generate_project_xml(config)
    
    project_file = os.path.join(output_dir, "CodeWalker.Minimal.csproj")
    with open(project_file, "w", encoding="utf-8") as f:
        f.write(project_xml)
    
    return project_file

def copy_source_files(source_dir: str, output_dir: str) -> None:
    """Copy only essential files required for terrain extraction"""
    file_groups = get_minimal_groups()
    
    # Create necessary subdirectories
    for group in file_groups:
        for file in group.files:
            target_dir = os.path.join(output_dir, os.path.dirname(file))
            os.makedirs(target_dir, exist_ok=True)
            
            source_file = os.path.join(source_dir, file)
            target_file = os.path.join(output_dir, file)
            
            if os.path.exists(source_file):
                shutil.copy2(source_file, target_file)
            else:
                print(f"Warning: Source file not found: {source_file}")

def verify_compiled_dll(dll_path):
    """
    Verify that the compiled DLL can be loaded and used
    
    Args:
        dll_path (str): Path to the compiled DLL
        
    Returns:
        bool: True if verification succeeded, False otherwise
    """
    logger.info(f"Verifying compiled DLL: {dll_path}")
    
    if not os.path.exists(dll_path):
        logger.error(f"DLL not found at {dll_path}")
        return False
    
    try:
        # Import clr module for .NET interop
        import clr
        
        # Add reference to the compiled DLL
        clr.AddReference(str(dll_path))
        
        # Try to import some classes
        from CodeWalker.GameFiles import HeightmapFile, RpfManager  # type: ignore
        
        # Try to import World.Heightmaps if available
        try:
            from CodeWalker.World import Heightmaps  # type: ignore
            _ = Heightmaps
            logger.info("Successfully imported Heightmaps class from World namespace")
        except ImportError:
            logger.warning("Could not import Heightmaps class from World namespace (this might be okay)")
        
        # Create a test instance
        rpf_manager = RpfManager()
        
        # Try to access some methods to ensure they're available
        try:
            # Check if critical methods exist
            init_method = getattr(rpf_manager, "Init", None)
            if init_method is None:
                logger.warning("RpfManager.Init method not found")
            
            # Try to create a HeightmapFile instance
            _heightmap_file = HeightmapFile()
            logger.info("Successfully created HeightmapFile instance")
        except Exception as e:
            logger.warning(f"Error testing DLL functionality: {e}")
            # This is not a critical error, so we continue
        
        logger.info("✓ Successfully loaded compiled DLL. HeightmapFile and RpfManager classes available.")
        return True
    except Exception as e:
        logger.error(f"Error verifying compiled DLL: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return False

def find_codewalker_path():
    """
    Find the CodeWalker source code path from environment variables or user input
    
    Returns:
        str: Path to the CodeWalker source code, or None if not found
    """
    import dotenv
    dotenv.load_dotenv()
    
    codewalker_path = os.getenv('codewalker_map')
    if codewalker_path and os.path.exists(codewalker_path):
        return codewalker_path
    
    # Try to find CodeWalker in common locations
    common_locations = [
        "./CodeWalker",
        "./CodeWalker-master",
        "../CodeWalker",
        "../CodeWalker-master",
    ]
    
    for location in common_locations:
        if os.path.exists(location):
            return os.path.abspath(location)
    
    logger.warning("CodeWalker path not found in environment variables or common locations")
    return None

if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="Compile minimal CodeWalker files for GTA5 terrain extraction")
    parser.add_argument("source_dir", help="Path to CodeWalker source directory")
    parser.add_argument("--output-dir", default="./compiled_cw", help="Directory to output compiled files to")
    parser.add_argument("--force", action="store_true", help="Force recompilation even if DLL exists")
    parser.add_argument("--verbose", action="store_true", help="Enable verbose logging")
    
    args = parser.parse_args()
    
    if args.verbose:
        logging.basicConfig(level=logging.DEBUG)
    else:
        logging.basicConfig(level=logging.INFO)
        
    result = compile_codewalker_files(args.source_dir, args.output_dir, args.force)
    if result:
        print(f"Successfully compiled DLL: {result}")
        sys.exit(0)
    else:
        print("Compilation failed")
        sys.exit(1) 
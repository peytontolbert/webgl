"""
CodeWalker Configuration Loader
-----------------------------
Handles loading and validation of CodeWalker source files.
"""

import os
import logging
from pathlib import Path
from typing import List, Dict, Optional, Set

logger = logging.getLogger(__name__)

class CodeWalkerConfig:
    """Configuration for CodeWalker compilation"""
    
    def __init__(self, source_dir: str):
        """
        Initialize configuration.
        
        Args:
            source_dir: Path to CodeWalker source directory
        """
        self.source_dir = Path(source_dir)
        self.core_dir = self.source_dir / "CodeWalker.Core"
        logger.info(f"Using CodeWalker.Core directory: {self.core_dir}")
        
    def get_all_files(self) -> List[str]:
        """
        Get all required source files.
        
        Returns:
            List[str]: List of file paths relative to CodeWalker.Core
        """
        files = []
        
        # Core source files
        core_files = [
            "Vector2.cs",
            "Vector3.cs",
            "Vector4.cs",
            "Quaternion.cs",
            "Matrix4x4.cs"
        ]
        for file in core_files:
            if (self.core_dir / file).exists():
                files.append(file)
        
        # Add all .cs files from GameFiles and subdirectories
        for root, _, filenames in os.walk(self.core_dir / "GameFiles"):
            for filename in filenames:
                if filename.endswith(".cs"):
                    rel_path = os.path.relpath(os.path.join(root, filename), self.core_dir)
                    files.append(rel_path.replace("\\", "/"))
                    
        # Add all .cs files from World and subdirectories
        for root, _, filenames in os.walk(self.core_dir / "World"):
            for filename in filenames:
                if filename.endswith(".cs"):
                    rel_path = os.path.relpath(os.path.join(root, filename), self.core_dir)
                    files.append(rel_path.replace("\\", "/"))
                    
        # Add all .cs files from Utils
        for root, _, filenames in os.walk(self.core_dir / "Utils"):
            for filename in filenames:
                if filename.endswith(".cs"):
                    rel_path = os.path.relpath(os.path.join(root, filename), self.core_dir)
                    files.append(rel_path.replace("\\", "/"))
        
        # Ensure critical files are included
        critical_files = {
            "GameFiles/FileTypes/HeightmapFile.cs",
            "GameFiles/RpfFile.cs",
            "GameFiles/RpfManager.cs",
            "GameFiles/Utils/GTAKeys.cs",
            "GameFiles/Utils/GTACrypto.cs",
            "World/Heightmaps.cs"
        }
        
        for file in critical_files:
            if (self.core_dir / file).exists() and file not in files:
                files.append(file)
                    
        # Add Resources
        for root, _, filenames in os.walk(self.core_dir / "Resources"):
            for filename in filenames:
                if filename.endswith(".resx") or filename.endswith(".resources"):
                    rel_path = os.path.relpath(os.path.join(root, filename), self.core_dir)
                    files.append(rel_path.replace("\\", "/"))
                    
        # Add Properties
        for root, _, filenames in os.walk(self.core_dir / "Properties"):
            for filename in filenames:
                if filename.endswith(".cs") or filename.endswith(".resx"):
                    rel_path = os.path.relpath(os.path.join(root, filename), self.core_dir)
                    files.append(rel_path.replace("\\", "/"))
                    
        # Add XML files
        for filename in ["ShadersGen9Conversion.xml"]:
            if (self.core_dir / filename).exists():
                files.append(filename)
                
        # Log included files for debugging
        logger.debug("Including the following files:")
        for file in sorted(files):
            logger.debug(f"  {file}")
                
        return sorted(files)
        
    def get_file_path(self, file: str) -> Path:
        """
        Get absolute path for a file.
        
        Args:
            file: Relative path from CodeWalker.Core
            
        Returns:
            Path: Absolute path to the file
        """
        return self.core_dir / file
        
    def verify_files(self) -> bool:
        """
        Verify that all required files exist.
        
        Returns:
            bool: True if all files exist, False otherwise
        """
        missing = []
        for file in self.get_all_files():
            if not self.get_file_path(file).exists():
                missing.append(file)
                
        if missing:
            logger.error("Missing required files:")
            for file in missing:
                logger.error(f"  {file}")
            return False
            
        logger.info("All required files found")
        return True 
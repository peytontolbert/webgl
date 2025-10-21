"""
GTA5 Modules
-----------
Modules for extracting and processing GTA5 terrain data.
"""

from .dll_manager import DllManager
from .rpf_reader import RpfReader
from .terrain_system import TerrainSystem
from .ymap_handler import YmapHandler

__version__ = "0.1.0"
__all__ = [
    "DllManager",
    "RpfReader",
    "TerrainSystem",
    "YmapHandler"
] 
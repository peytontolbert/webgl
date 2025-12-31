"""
GTA5 Modules
-----------
Modules for extracting and processing GTA5 terrain data.
"""

from typing import TYPE_CHECKING

# Keep this package import-safe on non-Windows platforms.
# Many modules rely on Python.NET (`clr`) + CodeWalker DLLs; importing those eagerly
# breaks simple utilities (and even `--help`) on Linux.

if TYPE_CHECKING:
    # Type-only imports (won't execute at runtime)
    from .dll_manager import DllManager  # noqa: F401
    from .rpf_reader import RpfReader  # noqa: F401
    from .terrain_system import TerrainSystem  # noqa: F401
    from .ymap_handler import YmapHandler  # noqa: F401

__version__ = "0.1.0"
__all__ = [
    # Intentionally empty: consumers should import concrete modules directly, e.g.
    # `from gta5_modules.heightmap import HeightmapFile`
] 
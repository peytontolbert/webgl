# Python-CodeWalker DLL Integration Guide

## Overview
This guide details how the Python extractor interfaces with the compiled CodeWalker DLL, explaining the architecture, initialization process, and best practices for handling data between Python and C#.

## Table of Contents
1. [Architecture](#architecture)
2. [DLL Integration](#dll-integration)
3. [Initialization Flow](#initialization-flow)
4. [Data Handling](#data-handling)
5. [Error Handling](#error-handling)
6. [Best Practices](#best-practices)
7. [Troubleshooting](#troubleshooting)

## Architecture

### Component Overview
```
Python Extractor                 CodeWalker DLL
+----------------+              +---------------+
| RpfReader     | <==========> | RpfManager    |
+----------------+              +---------------+
| GameFileCache | <==========> | GameFileCache |
+----------------+              +---------------+
| TerrainSystem | <==========> | TerrainSystem |
+----------------+              +---------------+
```

### Key Components
1. **RpfReader (Python)**
   - Manages RPF file operations through DLL
   - Handles file system interactions
   - Provides Python-friendly interfaces

2. **GameFileCache (Python)**
   - Caches game files in Python
   - Synchronizes with DLL cache
   - Manages memory efficiently

3. **TerrainSystem (Python)**
   - Extracts terrain data
   - Processes heightmaps and textures
   - Converts data to Python formats

## DLL Integration

### Loading the DLL
```python
import clr
import System
from pathlib import Path

def initialize_codewalker(dll_path: str):
    """Initialize CodeWalker DLL integration.
    
    Args:
        dll_path: Path to CodeWalker.Core.dll
    """
    try:
        # Add reference to the DLL
        clr.AddReference(str(Path(dll_path)))
        
        # Import required namespaces
        from CodeWalker.GameFiles import (
            RpfFile, RpfFileEntry, GameFileCache,
            GTA5Keys, RpfManager
        )
        return True
    except Exception as e:
        logger.error(f"Failed to initialize CodeWalker DLL: {e}")
        return False
```

### Key Interfaces
```python
class RpfReader:
    def __init__(self, game_path: str):
        """Initialize RPF reader with CodeWalker DLL.
        
        Args:
            game_path: Path to GTA5 installation
        """
        self.game_path = Path(game_path)
        self._initialize_dll()
        self._setup_rpf_manager()
        
    def _initialize_dll(self):
        # Initialize DLL components
        self.RpfFile = None  # Will hold RpfFile class
        self.RpfFileEntry = None  # Will hold RpfFileEntry class
        self.GameFileCache = None  # Will hold GameFileCache class
        
        # Load required types from DLL
        from CodeWalker.GameFiles import (
            RpfFile, RpfFileEntry, GameFileCache
        )
        self.RpfFile = RpfFile
        self.RpfFileEntry = RpfFileEntry
        self.GameFileCache = GameFileCache
```

## Initialization Flow

### Proper Initialization Sequence
1. Load DLL
2. Initialize RpfManager
3. Setup GameFileCache
4. Initialize file systems

```python
def initialize_systems(game_path: str):
    """Initialize all required systems in correct order.
    
    Args:
        game_path: Path to GTA5 installation
    """
    # 1. Initialize DLL
    if not initialize_codewalker("path/to/CodeWalker.Core.dll"):
        raise RuntimeError("Failed to initialize CodeWalker DLL")
        
    # 2. Initialize RpfManager
    rpf_manager = RpfManager()
    rpf_manager.Init(
        folder=game_path,
        gen9=True,  # For GTA5
        updateStatus=lambda msg: logger.info(msg),
        errorLog=lambda msg: logger.error(msg)
    )
    
    # 3. Setup GameFileCache
    game_cache = GameFileCache(
        size=2 * 1024 * 1024 * 1024,  # 2GB cache
        cacheTime=3600.0,  # 1 hour
        folder=game_path
    )
    game_cache.RpfMan = rpf_manager
    
    # 4. Initialize cache
    game_cache.Init(
        lambda msg: logger.info(msg),
        lambda msg: logger.error(msg)
    )
    
    return rpf_manager, game_cache
```

## Data Handling

### Converting Between C# and Python Types
```python
def convert_vector3(cs_vector) -> np.ndarray:
    """Convert C# Vector3 to numpy array."""
    return np.array([cs_vector.X, cs_vector.Y, cs_vector.Z])

def convert_quaternion(cs_quat) -> np.ndarray:
    """Convert C# Quaternion to numpy array."""
    return np.array([cs_quat.X, cs_quat.Y, cs_quat.Z, cs_quat.W])

def convert_to_cs_vector3(np_array) -> System.Numerics.Vector3:
    """Convert numpy array to C# Vector3."""
    return System.Numerics.Vector3(
        np_array[0], np_array[1], np_array[2]
    )
```

### Memory Management
```python
class ManagedResource:
    """Base class for managing DLL resources."""
    
    def __init__(self):
        self._handle = None
        
    def __enter__(self):
        return self
        
    def __exit__(self, exc_type, exc_val, exc_tb):
        self.cleanup()
        
    def cleanup(self):
        """Clean up DLL resources."""
        if self._handle:
            # Ensure proper disposal of DLL resources
            if hasattr(self._handle, 'Dispose'):
                self._handle.Dispose()
            self._handle = None
```

## Error Handling

### DLL Exception Handling
```python
class DllError(Exception):
    """Base exception for DLL-related errors."""
    pass

class DllInitializationError(DllError):
    """DLL initialization failed."""
    pass

class DllOperationError(DllError):
    """DLL operation failed."""
    pass

def handle_dll_operation(func):
    """Decorator for handling DLL operations."""
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except System.Exception as e:
            raise DllOperationError(f"DLL operation failed: {e}")
        except Exception as e:
            raise DllOperationError(f"Python operation failed: {e}")
    return wrapper
```

## Best Practices

### 1. Resource Management
- Always use context managers for DLL resources
- Implement proper cleanup methods
- Monitor memory usage

### 2. Error Handling
- Catch and convert C# exceptions
- Provide meaningful error messages
- Log DLL operations

### 3. Performance
- Minimize conversions between C# and Python
- Use bulk operations when possible
- Implement proper caching

### 4. Thread Safety
- Ensure thread-safe DLL operations
- Use proper synchronization
- Handle GIL considerations

## Troubleshooting

### Common Issues and Solutions

1. **DLL Not Found**
   - Ensure correct DLL path
   - Check DLL dependencies
   - Verify .NET runtime version

2. **Memory Issues**
   - Implement proper resource cleanup
   - Monitor memory usage
   - Use memory profiling tools

3. **Performance Issues**
   - Minimize type conversions
   - Use bulk operations
   - Implement caching

4. **Thread-Safety Issues**
   - Use proper synchronization
   - Handle GIL correctly
   - Monitor thread states 
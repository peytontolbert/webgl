# CodeWalker Documentation

## Overview
This documentation provides a comprehensive reference for CodeWalker's systems and their Python implementations.

## FiveM integration helpers

- [AI bot bridge (CLI control)](server/ai_bot_bridge.md): Control a real FiveM client from an external CLI/AI process via FXServer HTTP + client events.

## Core Systems
1. [Core Systems](core_systems.md)
   - YMAP System
   - Map Selection System
   - Entity System
   - Instance Systems
   - Light Systems
   - Occluder Systems

2. [RPF System](rpf_system.md)
   - RPF File Structure
   - RPF Manager
   - RPF Reader
   - Entry Types
   - Encryption Handling

3. [Terrain System](terrain_system.md)
   - Terrain Extractor
   - Heightmap System
   - Terrain Shader
   - Terrain Geometry
   - Terrain Texturing

4. [Python-CodeWalker Integration](python_codewalker_integration.md)
   - Architecture Overview
   - DLL Integration
   - Initialization Flow
   - Data Handling
   - Error Handling
   - Best Practices
   - Troubleshooting

## Implementation Guidelines

### Python Port Considerations
- Use dataclasses for structured data
- Implement proper type hints
- Follow Python naming conventions
- Maintain compatibility with CodeWalker's data structures
- Handle memory management appropriately

### Key Differences from C#
1. **Memory Management**
   - C#: Automatic garbage collection with deterministic disposal
   - Python: Reference counting with cycle detection

2. **Type System**
   - C#: Static typing with generics
   - Python: Dynamic typing with type hints

3. **Data Structures**
   - C#: Value types vs reference types
   - Python: Everything is an object

4. **Threading Model**
   - C#: Full multithreading support
   - Python: GIL considerations

### Best Practices
1. **Error Handling**
   ```python
   try:
       # Operation that might fail
       result = potentially_failing_operation()
   except SpecificException as e:
       logger.error(f"Operation failed: {e}")
       # Handle the error appropriately
   ```

2. **Resource Management**
   ```python
   class ResourceHandler:
       def __init__(self):
           self.resource = None
           
       def __enter__(self):
           self.acquire_resource()
           return self
           
       def __exit__(self, exc_type, exc_val, exc_tb):
           self.release_resource()
   ```

3. **Type Checking**
   ```python
   from typing import Optional, List, Dict, TypeVar, Generic
   
   T = TypeVar('T')
   
   class GenericHandler(Generic[T]):
       def __init__(self, value: T):
           self.value: T = value
   ```

## System Integration

### RPF Integration
```python
class RpfManager:
    def __init__(self, game_path: str):
        self.reader = RpfReader(game_path)
        self.cache = RpfCache()
        
    def load_file(self, path: str) -> Optional[bytes]:
        # Check cache first
        if self.cache.has(path):
            return self.cache.get(path)
            
        # Load from RPF
        data = self.reader.read_file(path)
        if data:
            self.cache.add(path, data)
        return data
```

### YMAP Integration
```python
class YmapHandler:
    def __init__(self, rpf_manager: RpfManager):
        self.rpf = rpf_manager
        self.loaded_ymaps: Dict[str, YmapFile] = {}
        
    def load_ymap(self, path: str) -> Optional[YmapFile]:
        if path in self.loaded_ymaps:
            return self.loaded_ymaps[path]
            
        data = self.rpf.load_file(path)
        if not data:
            return None
            
        ymap = YmapFile()
        ymap.load(data)
        self.loaded_ymaps[path] = ymap
        return ymap
```

### Terrain Integration
```python
class TerrainManager:
    def __init__(self, rpf_manager: RpfManager):
        self.rpf = rpf_manager
        self.heightmaps: Dict[str, HeightmapFile] = {}
        self.textures: Dict[str, TerrainTextureLayer] = {}
        
    def load_terrain(self, heightmap_path: str) -> Optional[TerrainData]:
        heightmap = self.load_heightmap(heightmap_path)
        if not heightmap:
            return None
            
        textures = self.load_terrain_textures(heightmap_path)
        return TerrainData(heightmap, textures)
```

## Performance Considerations

### Memory Management
- Use memory pools for frequently allocated objects
- Implement proper caching strategies
- Clean up resources when no longer needed

### Threading
- Use thread pools for parallel operations
- Implement proper synchronization
- Consider GIL limitations

### Caching
- Implement LRU caches for frequently accessed data
- Use weak references for disposable resources
- Monitor memory usage

## Error Handling

### Logging
```python
import logging

logger = logging.getLogger(__name__)

def handle_operation():
    try:
        # Operation
        pass
    except Exception as e:
        logger.error(f"Operation failed: {e}", exc_info=True)
        raise
```

### Error Types
```python
class CodeWalkerError(Exception):
    """Base exception for CodeWalker errors"""
    pass

class RpfError(CodeWalkerError):
    """RPF-related errors"""
    pass

class YmapError(CodeWalkerError):
    """YMAP-related errors"""
    pass
```

## Testing

### Unit Tests
```python
import unittest

class TestRpfManager(unittest.TestCase):
    def setUp(self):
        self.rpf = RpfManager("game_path")
        
    def test_load_file(self):
        data = self.rpf.load_file("test.rpf")
        self.assertIsNotNone(data)
```

### Integration Tests
```python
class TestTerrainSystem(unittest.TestCase):
    def setUp(self):
        self.rpf = RpfManager("game_path")
        self.terrain = TerrainManager(self.rpf)
        
    def test_terrain_loading(self):
        terrain = self.terrain.load_terrain("terrain.dat")
        self.assertIsNotNone(terrain)
        self.assertEqual(terrain.heightmap.width, 4096)
``` 
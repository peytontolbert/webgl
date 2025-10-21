# Terrain System Implementation Fixes

## Overview
The current terrain system implementation needs updates to better align with our documentation and ensure proper integration with CodeWalker DLL.

## Required Changes

### 1. DLL Integration
```python
from .dll_manager import DllManager  # Use the common DLL manager

class TerrainDllInterface:
    """Interface for terrain-related DLL functionality."""
    
    def __init__(self, dll_manager: DllManager):
        self.dll_manager = dll_manager
        self._initialize()
        
    def _initialize(self):
        """Initialize terrain-specific DLL types."""
        from CodeWalker.GameFiles import (
            HeightmapFile,
            TerrainShader,
            TerrainGeometry
        )
        self.HeightmapFile = HeightmapFile
        self.TerrainShader = TerrainShader
        self.TerrainGeometry = TerrainGeometry
```

### 2. Resource Management
```python
class TerrainResource(ManagedResource):
    """Base class for terrain resources."""
    
    def __init__(self, handle: Any):
        super().__init__()
        self._handle = handle
        
    def cleanup(self):
        if self._handle:
            if hasattr(self._handle, 'Dispose'):
                self._handle.Dispose()
            self._handle = None

class HeightmapResource(TerrainResource):
    """Managed heightmap resource."""
    
    def __init__(self, heightmap_file: 'HeightmapFile'):
        super().__init__(heightmap_file)
        self.width = heightmap_file.Width
        self.height = heightmap_file.Height
        self._data = None
        
    @property
    def data(self) -> np.ndarray:
        """Get heightmap data with lazy loading."""
        if self._data is None:
            self._data = self._load_data()
        return self._data
        
    def _load_data(self) -> np.ndarray:
        """Load heightmap data from DLL."""
        # Implementation here
```

### 3. Type Conversions
```python
class TerrainTypeConverter:
    """Handles conversions between C# and Python terrain types."""
    
    @staticmethod
    def convert_heightmap_data(heightmap: 'HeightmapFile') -> np.ndarray:
        """Convert C# heightmap data to numpy array."""
        width = heightmap.Width
        height = heightmap.Height
        data = np.zeros((height, width), dtype=np.float32)
        # Implementation here
        return data
    
    @staticmethod
    def convert_terrain_bounds(bounds: 'TerrainBounds') -> Dict[str, float]:
        """Convert C# terrain bounds to Python dict."""
        return {
            'min_x': bounds.MinX,
            'min_y': bounds.MinY,
            'min_z': bounds.MinZ,
            'max_x': bounds.MaxX,
            'max_y': bounds.MaxY,
            'max_z': bounds.MaxZ
        }
```

### 4. Updated TerrainExtractor Class
```python
class TerrainExtractor:
    """Extracts terrain data using CodeWalker DLL."""
    
    def __init__(self, game_path: str, enable_dlc: bool = True):
        self.game_path = Path(game_path)
        self.enable_dlc = enable_dlc
        
        # Initialize DLL components
        self.dll_manager = DllManager()
        self.terrain_dll = TerrainDllInterface(self.dll_manager)
        self.type_converter = TerrainTypeConverter()
        
        # Initialize managers
        self.rpf_manager = RpfManager(game_path)
        self.ymap_handler = YmapHandler(self.rpf_manager)
        
        # Initialize data structures
        self._initialize_data_structures()
        
    def _initialize_data_structures(self):
        """Initialize all data structures with proper typing."""
        self.heightmaps: Dict[str, HeightmapResource] = {}
        self.textures: Dict[str, TextureResource] = {}
        self.terrain_space = TerrainSpace()
        self.terrain_nodes: Dict[str, TerrainNode] = {}
        
    @handle_dll_operation
    def extract_terrain(self) -> bool:
        """Extract terrain data with proper error handling."""
        try:
            with self._create_extraction_context() as context:
                self._load_heightmaps(context)
                self._load_terrain_ymaps(context)
                self._load_textures(context)
                return True
        except TerrainExtractionError as e:
            logger.error(f"Terrain extraction failed: {e}")
            return False
```

### 5. Error Handling
```python
class TerrainError(DllError):
    """Base class for terrain-related errors."""
    pass

class TerrainExtractionError(TerrainError):
    """Terrain extraction failed."""
    pass

class HeightmapError(TerrainError):
    """Heightmap-related error."""
    pass

class TerrainTextureError(TerrainError):
    """Terrain texture-related error."""
    pass
```

### 6. Performance Optimizations
```python
class TerrainCache:
    """Cache for terrain data."""
    
    def __init__(self, max_size: int = 1024 * 1024 * 1024):  # 1GB default
        self.max_size = max_size
        self._cache: Dict[str, Any] = {}
        self._size = 0
        
    def add(self, key: str, data: Any):
        """Add data to cache with size tracking."""
        size = self._get_data_size(data)
        if self._size + size > self.max_size:
            self._evict()
        self._cache[key] = data
        self._size += size
        
    def _evict(self):
        """Evict items from cache using LRU strategy."""
        # Implementation here
```

## Implementation Notes

### 1. Resource Management
- Use context managers for all DLL resources
- Implement proper cleanup methods
- Track resource usage

### 2. Error Handling
- Use specific exception types
- Provide detailed error messages
- Implement proper logging
- Handle DLL exceptions

### 3. Performance
- Implement caching for heightmap and texture data
- Use memory-mapped files for large datasets
- Implement parallel processing where appropriate

### 4. Type Safety
- Use type hints consistently
- Validate data at boundaries
- Implement conversion utilities

## Testing Requirements

### 1. Unit Tests
```python
class TestTerrainExtractor(unittest.TestCase):
    def setUp(self):
        self.extractor = TerrainExtractor("game_path")
        
    def test_heightmap_loading(self):
        heightmap = self.extractor.get_heightmap("test.dat")
        self.assertIsNotNone(heightmap)
        self.assertEqual(heightmap.width, 4096)
        
    def test_resource_cleanup(self):
        with HeightmapResource(self.get_test_heightmap()) as res:
            self.assertIsNotNone(res._handle)
        self.assertIsNone(res._handle)
```

### 2. Integration Tests
```python
class TestTerrainIntegration(unittest.TestCase):
    def test_full_extraction(self):
        extractor = TerrainExtractor("game_path")
        self.assertTrue(extractor.extract_terrain())
        
    def test_ymap_integration(self):
        extractor = TerrainExtractor("game_path")
        ymaps = extractor.get_terrain_ymaps()
        self.assertGreater(len(ymaps), 0)
```

## Performance Benchmarks
```python
def benchmark_terrain_extraction():
    """Benchmark terrain extraction performance."""
    import time
    
    start = time.time()
    extractor = TerrainExtractor("game_path")
    extractor.extract_terrain()
    end = time.time()
    
    print(f"Terrain extraction took {end - start:.2f} seconds")
    print(f"Loaded {len(extractor.heightmaps)} heightmaps")
    print(f"Loaded {len(extractor.textures)} textures")
``` 
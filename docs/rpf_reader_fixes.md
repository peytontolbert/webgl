# RPF Reader Implementation Fixes

## Overview
The current RPF reader implementation needs several updates to align with our documented best practices and ensure proper integration with CodeWalker DLL.

## Required Changes

### 1. DLL Integration
```python
from pathlib import Path
import os
from typing import Optional

class DllManager:
    """Manages CodeWalker DLL integration."""
    
    @staticmethod
    def get_dll_path() -> Path:
        """Get CodeWalker DLL path with fallback options."""
        paths = [
            Path(__file__).parent.parent / "compiled_cw" / "CodeWalker.Core.dll",
            Path("CodeWalker.Core.dll"),
            Path(os.environ.get("CODEWALKER_PATH", "")) / "CodeWalker.Core.dll"
        ]
        for path in paths:
            if path.exists():
                return path
        raise FileNotFoundError("CodeWalker.Core.dll not found")
    
    @staticmethod
    def initialize_dll() -> bool:
        """Initialize CodeWalker DLL."""
        try:
            dll_path = DllManager.get_dll_path()
            clr.AddReference(str(dll_path))
            return True
        except Exception as e:
            logger.error(f"Failed to initialize DLL: {e}")
            return False
```

### 2. Resource Management
```python
class RpfResource(ManagedResource):
    """Base class for RPF resources."""
    
    def __init__(self, handle: Any):
        super().__init__()
        self._handle = handle
        
    def cleanup(self):
        """Clean up managed resources."""
        if self._handle:
            if hasattr(self._handle, 'Dispose'):
                self._handle.Dispose()
            self._handle = None

class RpfFile(RpfResource):
    """Managed RPF file resource."""
    
    def __init__(self, path: str, game_path: str):
        handle = CodeWalker.GameFiles.RpfFile(path, game_path)
        super().__init__(handle)
```

### 3. Error Handling
```python
class RpfError(DllError):
    """Base class for RPF-related errors."""
    pass

class RpfInitializationError(RpfError):
    """RPF initialization failed."""
    pass

class RpfOperationError(RpfError):
    """RPF operation failed."""
    pass

@handle_dll_operation
def load_rpf(self, path: str) -> bool:
    """Load an RPF file with proper error handling."""
    if not self.rpf_manager:
        raise RpfInitializationError("RPF manager not initialized")
    try:
        rpf_file = self.RpfFile(str(path), str(self.game_path))
        self.rpf_manager.AllRpfs.Add(rpf_file)
        return True
    except System.Exception as e:
        raise RpfOperationError(f"Failed to load RPF: {e}")
```

### 4. Type Conversions
```python
class RpfTypeConverter:
    """Handles conversions between C# and Python types."""
    
    @staticmethod
    def convert_rpf_entry(entry: 'RpfFileEntry') -> Dict[str, Any]:
        """Convert C# RPF entry to Python dictionary."""
        return {
            'name': entry.Name,
            'path': entry.Path,
            'size': entry.FileSize,
            'offset': entry.FileOffset,
            'is_encrypted': entry.IsEncrypted
        }
    
    @staticmethod
    def convert_rpf_list(entries: 'System.Collections.Generic.List[RpfFileEntry]') -> List[Dict[str, Any]]:
        """Convert C# RPF entry list to Python list."""
        return [RpfTypeConverter.convert_rpf_entry(e) for e in entries]
```

### 5. Updated RpfReader Class
```python
class RpfReader:
    """Reads RPF archives using CodeWalker DLL."""
    
    def __init__(self, game_path: str):
        self.game_path = Path(game_path)
        self.dll_manager = DllManager()
        self.type_converter = RpfTypeConverter()
        self._initialize()
    
    def _initialize(self):
        """Initialize with proper resource management."""
        if not self.dll_manager.initialize_dll():
            raise RpfInitializationError("Failed to initialize DLL")
            
        with RpfResource(self._create_rpf_manager()) as rpf_manager:
            self.rpf_manager = rpf_manager
            self._setup_game_cache()
    
    def _setup_game_cache(self):
        """Setup game cache with proper error handling."""
        try:
            self.game_cache = self.GameFileCache(
                size=2 * 1024 * 1024 * 1024,
                cacheTime=3600.0,
                folder=str(self.game_path),
                gen9=True
            )
            self.game_cache.RpfMan = self.rpf_manager
            self.game_cache.Init(
                lambda msg: logger.info(msg),
                lambda msg: logger.error(msg)
            )
        except Exception as e:
            raise RpfInitializationError(f"Failed to setup game cache: {e}")
```

## Implementation Notes

1. **Resource Cleanup**
- Always use context managers for resource management
- Implement proper Dispose patterns
- Handle cleanup in a deterministic manner

2. **Error Handling**
- Use specific exception types
- Provide detailed error messages
- Implement proper logging

3. **Type Safety**
- Use type hints consistently
- Implement conversion utilities
- Validate data at boundaries

4. **Performance**
- Implement caching where appropriate
- Use bulk operations
- Minimize type conversions

## Testing Requirements

1. **Unit Tests**
```python
class TestRpfReader(unittest.TestCase):
    def setUp(self):
        self.reader = RpfReader("game_path")
    
    def test_initialization(self):
        self.assertTrue(self.reader.initialized)
        self.assertIsNotNone(self.reader.rpf_manager)
    
    def test_resource_management(self):
        with RpfFile("test.rpf", "game_path") as rpf:
            self.assertIsNotNone(rpf._handle)
        self.assertIsNone(rpf._handle)  # Should be cleaned up
```

2. **Integration Tests**
```python
class TestRpfIntegration(unittest.TestCase):
    def test_dll_integration(self):
        self.assertTrue(DllManager.initialize_dll())
    
    def test_rpf_loading(self):
        reader = RpfReader("game_path")
        self.assertTrue(reader.load_rpf("test.rpf"))
``` 
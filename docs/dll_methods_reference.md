# CodeWalker DLL Methods Reference

## Overview
This document provides a comprehensive reference for all CodeWalker DLL methods used in our Python extractor.

## Table of Contents
1. [RpfManager Methods](#rpfmanager-methods)
2. [GameFileCache Methods](#gamefilecache-methods)
3. [HeightmapFile Methods](#heightmapfile-methods)
4. [YmapFile Methods](#ymapfile-methods)
5. [Texture Methods](#texture-methods)

## RpfManager Methods

### Initialization
```csharp
void Init(string folder, bool gen9, Action<string> updateStatus, Action<string> errorLog)
```
- `folder`: Path to GTA5 installation
- `gen9`: Set to true for GTA5
- `updateStatus`: Callback for status updates
- `errorLog`: Callback for error logging

### File Operations
```csharp
RpfFileEntry GetEntry(string path)
```
- Returns an entry from the RPF archive
- `path`: Relative path within RPF

```csharp
T GetFile<T>(string path)
```
- Gets a file of type T from the RPF archive
- `path`: Relative path within RPF
- `T`: Type of file to load (e.g., YmapFile, HeightmapFile)

## GameFileCache Methods

### Initialization
```csharp
void Init(Action<string> updateStatus, Action<string> errorLog)
```
- Initializes the game file cache
- `updateStatus`: Callback for status updates
- `errorLog`: Callback for error logging

### Cache Operations
```csharp
T GetFile<T>(MetaHash hash)
```
- Gets a file from cache by hash
- `hash`: Hash of the file to load
- `T`: Type of file to load

## HeightmapFile Methods

### Properties
```csharp
uint Width { get; }
uint Height { get; }
bool Compressed { get; }
Vector3 BBMin { get; }
Vector3 BBMax { get; }
```

### Data Access
```csharp
byte[] GetHeightData()
```
- Returns raw heightmap data

```csharp
float GetHeightAt(float x, float y)
```
- Gets interpolated height at coordinates
- `x`: X coordinate
- `y`: Y coordinate

## YmapFile Methods

### Properties
```csharp
YmapEntityDef[] AllEntities { get; }
YmapCarGen[] CarGenerators { get; }
```

### Entity Operations
```csharp
void EnsureChildYmaps(GameFileCache cache)
```
- Ensures all child YMAPs are loaded
- `cache`: Game file cache instance

## Texture Methods

### Texture Dictionary
```csharp
TextureDict Textures { get; }
```

### Texture Operations
```csharp
byte[] GetPixels(TextureBase texture, int mipLevel)
```
- Gets pixel data for a texture
- `texture`: Texture to get pixels from
- `mipLevel`: Mipmap level to retrieve

## Python Integration Examples

### Loading a Heightmap
```python
def load_heightmap(self, path: str) -> Optional[HeightmapFile]:
    """Load heightmap data from RPF file.
    
    Args:
        path: Path to heightmap file
        
    Returns:
        HeightmapFile object if successful, None otherwise
    """
    try:
        # Get heightmap data through RPF reader
        data = self.rpf_reader.get_file_data(path)
        if not data:
            logger.warning(f"Could not get heightmap data: {path}")
            return None
            
        # Create heightmap file object with DLL manager
        heightmap_file = HeightmapFile(data, self.dll_manager)
        
        return heightmap_file
        
    except Exception as e:
        logger.error(f"Failed to load heightmap {path}: {e}")
        return None
```

### Loading Textures
```python
def load_textures(self, path: str) -> Optional[Dict[str, TerrainTextureData]]:
    """Load terrain textures from YTD file.
    
    Args:
        path: Path to YTD file
        
    Returns:
        Dict of texture name to TerrainTextureData if successful
    """
    try:
        # Get YTD file through RPF manager
        ytd = self.rpf_manager.GetFile[self.dll_manager.YtdFile](path)
        if not ytd or not ytd.TextureDict or not ytd.TextureDict.Textures:
            logger.warning(f"No textures found in YTD: {path}")
            return None
        
        textures = {}
        for texture in ytd.TextureDict.Textures.data_items:
            # Get format and dimensions
            format_name = texture.Format.ToString()
            width = texture.Width
            height = texture.Height
            
            # Get pixel data
            pixels = self.dll_manager.DDSIO.GetPixels(texture, 0)
            if not pixels:
                continue
                
            # Process texture data
            img_data = self._process_texture_data(texture, format_name, width, height, pixels)
            if img_data is None:
                continue
                
            # Store texture
            textures[texture.Name] = TerrainTextureData(
                diffuse=None if is_normal else img_data,
                normal=img_data if is_normal else None,
                format=format_name,
                name=texture.Name
            )
            
        return textures
        
    except Exception as e:
        logger.error(f"Failed to load textures from {path}: {e}")
        return None
```

## Error Handling

### Common Exceptions
```csharp
System.IO.FileNotFoundException
System.ArgumentException
System.InvalidOperationException
```

### Python Error Handling
```python
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

1. **Resource Management**
   - Always use context managers for DLL resources
   - Implement proper cleanup methods
   - Monitor memory usage

2. **Error Handling**
   - Catch and convert C# exceptions
   - Provide meaningful error messages
   - Log DLL operations

3. **Performance**
   - Minimize conversions between C# and Python
   - Use bulk operations when possible
   - Implement proper caching

4. **Thread Safety**
   - Ensure thread-safe DLL operations
   - Use proper synchronization
   - Handle GIL considerations 
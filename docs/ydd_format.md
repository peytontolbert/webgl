# YDD Format Documentation

## Overview
YDD (Drawable Dictionary) files in GTA5 contain collections of drawable models and their associated data. This document details the format and the extraction process for WebGL rendering.

## File Structure

### 1. Header (C# Implementation)
```csharp
public struct YddHeader
{
    public uint Magic;        // "YDD" (0x444459)
    public uint Version;      // Usually 1
    public uint Flags;        // Various flags
    public uint NumDrawables; // Number of drawables
    public uint DataSize;     // Size of drawable data
}
```

### 2. Drawable Structure (C# Implementation)
```csharp
public struct Drawable
{
    public uint Hash;           // Hash of drawable name
    public uint Flags;          // Drawable flags
    public uint NumGeometries;  // Number of geometries
    public uint NumShaders;     // Number of shaders
    public uint NumTextures;    // Number of textures
    public uint NumVertexDecls; // Number of vertex declarations
    public uint DataOffset;     // Offset to drawable data
    public uint DataSize;       // Size of drawable data
}
```

## Python Extraction Implementation

### 1. Drawable Extractor
```python
class DrawableExtractor:
    def __init__(self, dll_manager):
        self.dll = dll_manager
        self.drawables = {}
        
    def extract_drawable(self, ydd_path: str) -> Dict:
        """Extract drawable data from YDD file"""
        try:
            # Load YDD file through DLL
            ydd_handle = self.dll.load_ydd(ydd_path)
            if not ydd_handle:
                raise ValueError(f"Failed to load YDD file: {ydd_path}")
                
            # Get header
            header = self.dll.get_ydd_header(ydd_handle)
            
            # Extract drawables
            drawables = []
            for i in range(header.NumDrawables):
                drawable = self.dll.get_ydd_drawable(ydd_handle, i)
                if drawable:
                    # Extract geometry data
                    geometries = self._extract_geometries(ydd_handle, drawable)
                    
                    # Extract shader data
                    shaders = self._extract_shaders(ydd_handle, drawable)
                    
                    # Extract texture data
                    textures = self._extract_textures(ydd_handle, drawable)
                    
                    # Extract vertex declarations
                    vertex_decls = self._extract_vertex_decls(ydd_handle, drawable)
                    
                    drawables.append({
                        'hash': drawable.Hash,
                        'geometries': geometries,
                        'shaders': shaders,
                        'textures': textures,
                        'vertex_decls': vertex_decls
                    })
            
            # Clean up
            self.dll.unload_ydd(ydd_handle)
            
            return {
                'header': header,
                'drawables': drawables
            }
            
        except Exception as e:
            logger.error(f"Error extracting drawable from {ydd_path}: {e}")
            return None
            
    def _extract_geometries(self, ydd_handle, drawable) -> List[Dict]:
        """Extract geometry data for a drawable"""
        geometries = []
        for i in range(drawable.NumGeometries):
            geometry = self.dll.get_ydd_geometry(ydd_handle, drawable.Hash, i)
            if geometry:
                # Extract vertex data
                vertices = self.dll.get_geometry_vertices(ydd_handle, geometry.Hash)
                
                # Extract index data
                indices = self.dll.get_geometry_indices(ydd_handle, geometry.Hash)
                
                geometries.append({
                    'hash': geometry.Hash,
                    'vertices': vertices,
                    'indices': indices,
                    'vertex_decl': geometry.VertexDeclHash
                })
        return geometries
        
    def _extract_shaders(self, ydd_handle, drawable) -> List[Dict]:
        """Extract shader data for a drawable"""
        shaders = []
        for i in range(drawable.NumShaders):
            shader = self.dll.get_ydd_shader(ydd_handle, drawable.Hash, i)
            if shader:
                # Extract shader source
                vertex_source = self.dll.get_shader_source(ydd_handle, shader.Hash, 'vertex')
                fragment_source = self.dll.get_shader_source(ydd_handle, shader.Hash, 'fragment')
                
                shaders.append({
                    'hash': shader.Hash,
                    'vertex_source': vertex_source,
                    'fragment_source': fragment_source
                })
        return shaders
        
    def _extract_textures(self, ydd_handle, drawable) -> List[Dict]:
        """Extract texture data for a drawable"""
        textures = []
        for i in range(drawable.NumTextures):
            texture = self.dll.get_ydd_texture(ydd_handle, drawable.Hash, i)
            if texture:
                # Extract texture data
                texture_data = self.dll.get_texture_data(ydd_handle, texture.Hash)
                
                textures.append({
                    'hash': texture.Hash,
                    'width': texture.Width,
                    'height': texture.Height,
                    'format': texture.Format,
                    'data': texture_data
                })
        return textures
```

### 2. WebGL Data Preparation
```python
class WebGLDataPreparator:
    def __init__(self):
        self.texture_manager = TextureManager()
        
    def prepare_drawable_data(self, drawable_data: Dict) -> Dict:
        """Prepare drawable data for WebGL rendering"""
        try:
            # Prepare geometries
            geometries = self._prepare_geometries(drawable_data['geometries'])
            
            # Prepare shaders
            shaders = self._prepare_shaders(drawable_data['shaders'])
            
            # Prepare textures
            textures = self._prepare_textures(drawable_data['textures'])
            
            return {
                'geometries': geometries,
                'shaders': shaders,
                'textures': textures
            }
            
        except Exception as e:
            logger.error(f"Error preparing drawable data: {e}")
            return None
            
    def _prepare_geometries(self, geometries: List[Dict]) -> List[Dict]:
        """Prepare geometry data for WebGL"""
        prepared = []
        for geometry in geometries:
            # Convert vertex data to Float32Array
            vertices = np.array(geometry['vertices'], dtype=np.float32)
            
            # Convert index data to Uint16Array
            indices = np.array(geometry['indices'], dtype=np.uint16)
            
            prepared.append({
                'vertices': vertices,
                'indices': indices,
                'vertex_decl': geometry['vertex_decl']
            })
        return prepared
        
    def _prepare_textures(self, textures: List[Dict]) -> List[Dict]:
        """Prepare texture data for WebGL"""
        prepared = []
        for texture in textures:
            # Convert texture data to RGBA format
            rgba_data = self.texture_manager.convert_to_rgba(
                texture['data'],
                texture['format']
            )
            
            prepared.append({
                'width': texture['width'],
                'height': texture['height'],
                'data': rgba_data
            })
        return prepared
```

## Usage Example

```python
# Initialize extractors
dll_manager = DllManager(game_path)
drawable_extractor = DrawableExtractor(dll_manager)
data_preparator = WebGLDataPreparator()

# Extract drawable data
ydd_path = "levels/gta5/vehicles.ydd"
drawable_data = drawable_extractor.extract_drawable(ydd_path)

if drawable_data:
    # Prepare data for WebGL
    webgl_data = data_preparator.prepare_drawable_data(drawable_data)
    
    # Export to JSON for WebGL viewer
    output_path = "assets/drawables/vehicles.json"
    with open(output_path, 'w') as f:
        json.dump(webgl_data, f)
```

## WebGL Integration Notes

1. Vertex Data Format:
- Position: 3 floats (x, y, z)
- Normal: 3 floats (nx, ny, nz)
- UV: 2 floats (u, v)
- Color: 4 floats (r, g, b, a)
- Tangent: 4 floats (tx, ty, tz, handedness)

2. Texture Formats:
- RGBA8: Standard RGBA texture
- DXT1: Compressed RGB texture
- DXT5: Compressed RGBA texture
- BC7: High-quality compressed texture

3. Shader Requirements:
- Vertex shader must handle all vertex attributes
- Fragment shader must support PBR materials
- Normal mapping and parallax mapping support
- Environment mapping support

4. Performance Considerations:
- Use vertex buffer objects (VBOs) for geometry
- Implement texture atlases for small textures
- Use compressed textures where possible
- Implement LOD system for complex models 
# Terrain System Documentation

## Overview
This document describes the terrain and heightmap system used in GTA5, including data structures, extraction methods, and rendering techniques.

## Table of Contents
1. [Heightmap File Format](#heightmap-file-format)
2. [Terrain Data Structures](#terrain-data-structures)
3. [Heightmap Processing](#heightmap-processing)
4. [Terrain Rendering](#terrain-rendering)
5. [Water Integration](#water-integration)
6. [Performance Optimization](#performance-optimization)
7. [Terrain Extraction and Visualization](#terrain-extraction-and-visualization)
8. [Integration with Building System](#integration-with-building-system)

## Heightmap File Format

### 1. File Header
```c
struct HeightmapHeader {
    uint32_t magic;           // 'HMAP' (0x484D4150)
    uint8_t version_major;    // Version 1
    uint8_t version_minor;    // Version 1
    uint16_t pad;            // Padding (0x0000)
    uint32_t compressed;     // Compression flag (1 for compressed)
    uint16_t width;          // Width in pixels (typically 1024)
    uint16_t height;         // Height in pixels (typically 1024)
    Vector3 bb_min;          // Bounding box minimum (world coordinates)
    Vector3 bb_max;          // Bounding box maximum (world coordinates)
    uint32_t length;         // Data length (including headers)
};
```

### 2. Compression Format
```c
struct CompHeader {
    uint16_t start;          // Starting position in row (0-based)
    uint16_t count;          // Number of values in row (non-zero values)
    int32_t data_offset;     // Offset to data in compressed buffer
};

// Compression details:
// 1. Each row is compressed independently
// 2. Only non-zero values are stored
// 3. Data is stored in two sections:
//    - First section: MaxHeights (length = dlen/2)
//    - Second section: MinHeights (length = dlen/2)
// 4. Row compression:
//    - Find first non-zero value (start)
//    - Find last non-zero value (end)
//    - Store values between start and end
// 5. Data offset calculation:
//    - For max heights: offset = data_offset + x
//    - For min heights: offset = (dlen/2) + data_offset + x
```

### 3. Data Organization
- Heightmap data is stored in two arrays:
  - `MaxHeights`: Maximum height values (width * height)
  - `MinHeights`: Minimum height values (width * height)
- Each value is a byte (0-255) representing height
- Data is compressed using a row-based compression scheme:
  - Each row has a compression header
  - Only non-zero values are stored
  - Data is stored in two sections: max heights followed by min heights
  - Offset calculation: `h2off = dlen / 2` (halfway point in compressed data)
- Height value interpretation:
  - 0: Lowest point in terrain
  - 255: Highest point in terrain
  - Values are scaled to world coordinates using: `world_height = bb_min.z + (height_value / 255.0) * (bb_max.z - bb_min.z)`

## Terrain Data Structures

### 1. Heightmap Data
```python
@dataclass
class HeightmapData:
    """Heightmap data extracted from GTA5 files"""
    width: int              # Width in pixels
    height: int             # Height in pixels
    bb_min: Vector3         # Bounding box minimum
    bb_max: Vector3         # Bounding box maximum
    max_heights: np.ndarray # Maximum height values (height, width)
    min_heights: np.ndarray # Minimum height values (height, width)
    compressed: bool        # Whether data is compressed
```

### 2. Terrain Geometry
```python
@dataclass
class TerrainGeometry:
    """Terrain geometry data"""
    vertices: np.ndarray    # Vertex positions (N, 3)
    normals: np.ndarray     # Vertex normals (N, 3)
    uvs: np.ndarray        # Texture coordinates (N, 2)
    indices: np.ndarray     # Triangle indices (M, 3)
    bounds: Dict[str, float] # Terrain bounds
```

## Heightmap Processing

### 1. Data Extraction
```python
def extract_heightmap_data(self, heightmap_file: HeightmapFile) -> HeightmapData:
    """Extract heightmap data from file.
    
    Args:
        heightmap_file: HeightmapFile object from CodeWalker
        
    Returns:
        HeightmapData object
    """
    # Get basic properties
    width = heightmap_file.Width
    height = heightmap_file.Height
    bb_min = heightmap_file.BBMin
    bb_max = heightmap_file.BBMax
    
    # Process height data
    if heightmap_file.Compressed > 0:
        # Handle compressed data
        max_heights = np.zeros((height, width), dtype=np.uint8)
        min_heights = np.zeros((height, width), dtype=np.uint8)
        
        for y in range(height):
            header = heightmap_file.CompHeaders[y]
            data_offset = header.DataOffset
            h2_offset = len(heightmap_file.MaxHeights) // 2
            
            # Process non-zero values in row
            for i in range(header.Count):
                x = header.Start + i
                # Get max height value
                max_heights[y, x] = heightmap_file.MaxHeights[data_offset + x]
                # Get min height value from second section
                min_heights[y, x] = heightmap_file.MaxHeights[h2_offset + data_offset + x]
                
                # Validate height values
                if max_heights[y, x] < min_heights[y, x] and max_heights[y, x] != 0:
                    logger.warning(f"Invalid height values at ({x}, {y}): max={max_heights[y, x]}, min={min_heights[y, x]}")
    else:
        # Handle uncompressed data (rare in GTA5)
        max_heights = np.array(heightmap_file.MaxHeights).reshape(height, width)
        min_heights = np.array(heightmap_file.MinHeights).reshape(height, width)
    
    return HeightmapData(
        width=width,
        height=height,
        bb_min=bb_min,
        bb_max=bb_max,
        max_heights=max_heights,
        min_heights=min_heights,
        compressed=heightmap_file.Compressed > 0
    )
```

### 2. Geometry Generation
```python
def create_terrain_geometry(self, heightmap: HeightmapData) -> TerrainGeometry:
    """Create terrain geometry from heightmap.
    
    Args:
        heightmap: HeightmapData object
        
    Returns:
        TerrainGeometry object
    """
    # Calculate step sizes
    size = (
        heightmap.bb_max.x - heightmap.bb_min.x,
        heightmap.bb_max.y - heightmap.bb_min.y,
        heightmap.bb_max.z - heightmap.bb_min.z
    )
    step = (
        size[0] / (heightmap.width - 1),
        size[1] / (heightmap.height - 1),
        size[2] / 255.0  # Height values are 0-255
    )
    
    # Generate vertices
    vertices = []
    normals = []
    uvs = []
    indices = []
    
    # Generate vertices for both min and max heights
    for y in range(heightmap.height):
        for x in range(heightmap.width):
            # Calculate base position
            pos_x = heightmap.bb_min.x + x * step[0]
            pos_y = heightmap.bb_min.y + y * step[1]
            
            # Add min height vertex
            pos_z = heightmap.bb_min.z + heightmap.min_heights[y, x] * step[2]
            vertices.append([pos_x, pos_y, pos_z])
            
            # Add max height vertex
            pos_z = heightmap.bb_min.z + heightmap.max_heights[y, x] * step[2]
            vertices.append([pos_x, pos_y, pos_z])
            
            # Add UV coordinates (normalized to [0,1])
            u = x / (heightmap.width - 1)
            v = y / (heightmap.height - 1)
            uvs.extend([[u, v], [u, v]])
            
            # Calculate normal using central differences
            if x > 0 and x < heightmap.width - 1 and y > 0 and y < heightmap.height - 1:
                # For min heights
                dx_min = (heightmap.min_heights[y, x + 1] - heightmap.min_heights[y, x - 1]) * step[2]
                dy_min = (heightmap.min_heights[y + 1, x] - heightmap.min_heights[y - 1, x]) * step[2]
                normal_min = np.array([-dx_min, -dy_min, 1.0])
                normal_min = normal_min / np.linalg.norm(normal_min)
                
                # For max heights
                dx_max = (heightmap.max_heights[y, x + 1] - heightmap.max_heights[y, x - 1]) * step[2]
                dy_max = (heightmap.max_heights[y + 1, x] - heightmap.max_heights[y - 1, x]) * step[2]
                normal_max = np.array([-dx_max, -dy_max, 1.0])
                normal_max = normal_max / np.linalg.norm(normal_max)
                
                normals.extend([normal_min, normal_max])
            else:
                # Use default normal for edges
                normals.extend([[0.0, 0.0, 1.0], [0.0, 0.0, 1.0]])
    
    # Generate indices for triangles
    for y in range(heightmap.height - 1):
        for x in range(heightmap.width - 1):
            # Calculate base indices (each vertex has min and max height versions)
            i0 = (y * heightmap.width + x) * 2
            i1 = i0 + 1
            i2 = ((y + 1) * heightmap.width + x) * 2
            i3 = i2 + 1
            
            # Add triangles for min heights (bottom surface)
            indices.extend([i0, i1, i2])
            indices.extend([i1, i3, i2])
            
            # Add triangles for max heights (top surface)
            indices.extend([i1, i0, i3])
            indices.extend([i0, i2, i3])
            
            # Add triangles for side faces if height difference is significant
            if abs(heightmap.max_heights[y, x] - heightmap.min_heights[y, x]) > 1:
                # Front face
                indices.extend([i0, i2, i1])
                indices.extend([i1, i2, i3])
                # Back face
                indices.extend([i0, i1, i2])
                indices.extend([i1, i3, i2])
                # Left face
                indices.extend([i0, i1, i2])
                indices.extend([i1, i3, i2])
                # Right face
                indices.extend([i0, i2, i1])
                indices.extend([i1, i2, i3])
    
    return TerrainGeometry(
        vertices=np.array(vertices, dtype=np.float32),
        normals=np.array(normals, dtype=np.float32),
        uvs=np.array(uvs, dtype=np.float32),
        indices=np.array(indices, dtype=np.uint32),
        bounds={
            'min_x': heightmap.bb_min.x,
            'min_y': heightmap.bb_min.y,
            'min_z': heightmap.bb_min.z,
            'max_x': heightmap.bb_max.x,
            'max_y': heightmap.bb_max.y,
            'max_z': heightmap.bb_max.z
        }
    )
```

## Terrain Rendering

### 1. Shader Structure
```glsl
// Vertex shader uniforms
uniform mat4 uViewProjectionMatrix;
uniform mat4 uModelMatrix;
uniform mat3 uNormalMatrix;
uniform vec3 uTerrainBounds;  // (min_x, min_y, min_z)
uniform vec3 uTerrainSize;    // (width, height, max_height)
uniform sampler2D uHeightmap;
uniform bool uHasHeightmap;
uniform bool uEnableTint;
uniform float uTintYVal;

// Fragment shader uniforms
uniform sampler2D uDiffuseMap;      // Base texture
uniform sampler2D uNormalMap;       // Normal map
uniform sampler2D uBlendMask;       // Layer blend mask
uniform sampler2D uLayer1Map;       // Layer 1 texture
uniform sampler2D uLayer2Map;       // Layer 2 texture
uniform sampler2D uLayer3Map;       // Layer 3 texture
uniform sampler2D uLayer4Map;       // Layer 4 texture
uniform sampler2D uLayer1NormalMap; // Layer 1 normal map
uniform sampler2D uLayer2NormalMap; // Layer 2 normal map
uniform sampler2D uLayer3NormalMap; // Layer 3 normal map
uniform sampler2D uLayer4NormalMap; // Layer 4 normal map
```

### 2. Vertex Types
The terrain system supports multiple vertex types:
- PNCCT: Position, Normal, Color, Color, Texcoord
- PNCCTT: Position, Normal, Color, Color, Texcoord, Texcoord
- PNCTTX: Position, Normal, Color, Texcoord, Texcoord, Color
- PNCTTTX_3: Position, Normal, Color, Texcoord, Texcoord, Texcoord (3)
- PNCCTX: Position, Normal, Color, Color, Texcoord, Color
- PNCCTTX: Position, Normal, Color, Color, Texcoord, Texcoord
- PNCCTTX_2: Position, Normal, Color, Color, Texcoord, Texcoord (2)
- PNCCTTTX: Position, Normal, Color, Color, Texcoord, Texcoord, Texcoord

### 3. Texture Layers
```typescript
interface TerrainTextureLayer {
    diffuse: THREE.Texture;    // Diffuse texture
    normal: THREE.Texture;     // Normal map
    blend: number;            // Blend factor
    scale: number;            // Texture scale
}

class TerrainTextureManager {
    private layers: TerrainTextureLayer[] = [];
    
    addLayer(layer: TerrainTextureLayer) {
        this.layers.push(layer);
    }
    
    updateBlendFactors(height: number, slope: number) {
        // Update blend factors based on height and slope
        for (const layer of this.layers) {
            layer.blend = this.calculateBlendFactor(layer, height, slope);
        }
    }
}
```

## Performance Optimization

### 1. LOD System
```typescript
interface TerrainLODLevel {
    vertices: Float32Array;
    indices: Uint32Array;
    distance: number;
    triangleCount: number;
}

class TerrainLODManager {
    private lodLevels: TerrainLODLevel[] = [];
    
    generateLODLevels(geometry: TerrainGeometry) {
        // Generate multiple LOD levels
        const distances = [0, 100, 200, 400, 800];
        for (const distance of distances) {
            const lod = this.generateLOD(geometry, distance);
            this.lodLevels.push(lod);
        }
    }
    
    getLODLevel(cameraDistance: number): TerrainLODLevel {
        // Find appropriate LOD level based on distance
        for (const level of this.lodLevels) {
            if (cameraDistance <= level.distance) {
                return level;
            }
        }
        return this.lodLevels[this.lodLevels.length - 1];
    }
}
```

### 2. Texture Management
- Use texture atlases for terrain layers
- Implement texture streaming for large terrains
- Use compressed texture formats (BC7 for normal maps)
- Implement texture mipmapping with anisotropic filtering

### 3. Memory Management
- Implement vertex buffer pooling
- Use index buffer compression
- Implement geometry instancing for repeated terrain features
- Use texture compression for heightmaps

## Water Integration

### 1. Water Data Structure
```python
@dataclass
class WaterData:
    """Water data for terrain"""
    vertices: np.ndarray    # Water vertex positions
    indices: np.ndarray     # Water triangle indices
    bounds: Dict[str, float] # Water bounds
    type: str              # Water type (river, lake, ocean)
    height: float          # Water height
    color: np.ndarray      # Water color (RGBA)
```

### 2. Water Shader
```glsl
// Water vertex shader
varying vec2 vUv;
varying vec3 vPosition;
varying vec3 vNormal;

void main() {
    vUv = uv;
    vPosition = position;
    vNormal = normal;
    
    // Apply wave animation
    float wave = sin(position.x * 0.1 + time) * 0.5;
    vec3 pos = position;
    pos.y += wave;
    
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}

// Water fragment shader
uniform sampler2D waterTexture;
uniform sampler2D normalMap;
uniform vec3 waterColor;
uniform float roughness;
uniform float metallic;

void main() {
    vec3 normal = normalize(vNormal);
    vec3 normalMap = texture2D(normalMap, vUv).rgb * 2.0 - 1.0;
    normal = normalize(normal + normalMap);
    
    vec3 viewDir = normalize(cameraPosition - vPosition);
    float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 5.0);
    
    vec3 color = mix(waterColor, vec3(1.0), fresnel);
    gl_FragColor = vec4(color, 1.0);
}
```

## Terrain Extraction and Visualization

### 1. Terrain System Class
```python
class TerrainSystem:
    """Main class for handling terrain extraction and processing"""
    
    def __init__(self, game_path: str, dll_manager: DllManager):
        self.game_path = game_path
        self.dll_manager = dll_manager
        self.heightmaps = []
        self.textures = {}
        self.terrain_info = {}
    
    def extract_terrain(self) -> bool:
        """Extract terrain data from GTA5 files.
        
        Returns:
            bool: True if extraction was successful
        """
        try:
            # Load main heightmap
            heightmap_path = "common.rpf\\data\\levels\\gta5\\heightmap.dat"
            if self.dll_manager.enable_dlc:
                heightmap_path = "update\\update.rpf\\common\\data\\levels\\gta5\\heightmap.dat"
            
            heightmap_file = self.dll_manager.get_file(heightmap_path)
            if not heightmap_file:
                logger.error("Failed to load heightmap file")
                return False
            
            # Extract heightmap data
            heightmap_data = self.extract_heightmap_data(heightmap_file)
            self.heightmaps.append(heightmap_data)
            
            # Load terrain textures
            self.load_terrain_textures()
            
            # Generate terrain info
            self.terrain_info = {
                'num_heightmaps': len(self.heightmaps),
                'dimensions': {
                    heightmap_path: {
                        'width': heightmap_data.width,
                        'height': heightmap_data.height
                    }
                },
                'num_textures': len(self.textures),
                'texture_info': self.get_texture_info()
            }
            
            return True
            
        except Exception as e:
            logger.error(f"Failed to extract terrain: {e}")
            return False
    
    def load_terrain_textures(self):
        """Load terrain textures from game files"""
        texture_paths = [
            "cs_rsn_sl_agrdirttrack3_diffuse.png",
            "cs_rsn_sl_agrdirttrack3_normal.png",
            "cs_rsn_sl_agrgrass_02_dark_diffuse.png",
            "og_coastgrass_01_normal.png",
            "cs_rsn_sl_cstcliff_0003_diffuse.png",
            "cs_rsn_sl_cstcliff_0003_normal.png"
        ]
        
        for path in texture_paths:
            texture = self.dll_manager.load_texture(path)
            if texture:
                self.textures[path] = texture
    
    def get_texture_info(self) -> Dict:
        """Get information about loaded textures"""
        info = {}
        for path, texture in self.textures.items():
            info[path] = {
                'format': texture.format,
                'has_normal': '_normal' in path.lower(),
                'width': texture.width,
                'height': texture.height
            }
        return info
```

### 2. Terrain Visualization
```python
def visualize_terrain(self, output_dir: Path):
    """Create visualizations of the terrain.
    
    Args:
        output_dir: Directory to save visualizations
    """
    try:
        # Create heightmap visualization
        for i, heightmap in enumerate(self.heightmaps):
            # Create heightmap image
            heightmap_img = np.zeros((heightmap.height, heightmap.width, 3), dtype=np.uint8)
            
            # Normalize heights to 0-255 range
            max_height = np.max(heightmap.max_heights)
            min_height = np.min(heightmap.min_heights)
            
            # Colorize based on height
            for y in range(heightmap.height):
                for x in range(heightmap.width):
                    height = heightmap.max_heights[y, x]
                    if height > 0:
                        # Use a height-based color gradient
                        color = self.get_height_color(height, min_height, max_height)
                        heightmap_img[y, x] = color
            
            # Save heightmap visualization
            output_path = output_dir / f'heightmap_{i}.png'
            cv2.imwrite(str(output_path), heightmap_img)
            
            # Create normal map visualization
            normal_map = self.generate_normal_map(heightmap)
            cv2.imwrite(str(output_dir / f'normalmap_{i}.png'), normal_map)
            
    except Exception as e:
        logger.error(f"Failed to create terrain visualizations: {e}")

def get_height_color(self, height: int, min_height: int, max_height: int) -> np.ndarray:
    """Get color based on height value.
    
    Args:
        height: Height value (0-255)
        min_height: Minimum height in terrain
        max_height: Maximum height in terrain
        
    Returns:
        RGB color array
    """
    # Normalize height to 0-1 range
    normalized = (height - min_height) / (max_height - min_height)
    
    # Color gradient from green (low) to brown (mid) to white (high)
    if normalized < 0.5:
        # Green to brown
        t = normalized * 2
        return np.array([128 * t, 255 * (1 - t), 0])
    else:
        # Brown to white
        t = (normalized - 0.5) * 2
        return np.array([128 + 127 * t, 128 + 127 * t, 0 + 255 * t])
```

## Integration with Building System

### 1. Building-Terrain Interaction
```python
class BuildingSystem:
    """System for handling buildings and their interaction with terrain"""
    
    def __init__(self, game_path: str, dll_manager: DllManager):
        self.game_path = game_path
        self.dll_manager = dll_manager
        self.buildings = []
        self.water_data = None
    
    def extract_buildings(self) -> bool:
        """Extract building data and integrate with terrain.
        
        Returns:
            bool: True if extraction was successful
        """
        try:
            # Load YMAP files
            ymap_files = self.dll_manager.get_ymap_files()
            
            for ymap_file in ymap_files:
                # Process each entity in YMAP
                for entity in ymap_file.entities:
                    if self.is_building_entity(entity):
                        building = self.process_building_entity(entity)
                        # Snap building to terrain
                        building.position.z = self.get_terrain_height(
                            building.position.x,
                            building.position.y
                        )
                        self.buildings.append(building)
            
            # Extract water data
            self.water_data = self.extract_water_data()
            
            return True
            
        except Exception as e:
            logger.error(f"Failed to extract buildings: {e}")
            return False
    
    def get_terrain_height(self, x: float, y: float) -> float:
        """Get terrain height at given coordinates.
        
        Args:
            x: World X coordinate
            y: World Y coordinate
            
        Returns:
            float: Terrain height
        """
        # Convert world coordinates to heightmap coordinates
        for heightmap in self.terrain_system.heightmaps:
            if (heightmap.bb_min.x <= x <= heightmap.bb_max.x and
                heightmap.bb_min.y <= y <= heightmap.bb_max.y):
                
                # Calculate grid position
                grid_x = int((x - heightmap.bb_min.x) / 
                           (heightmap.bb_max.x - heightmap.bb_min.x) * 
                           (heightmap.width - 1))
                grid_y = int((y - heightmap.bb_min.y) / 
                           (heightmap.bb_max.y - heightmap.bb_min.y) * 
                           (heightmap.height - 1))
                
                # Get height value
                return heightmap.max_heights[grid_y, grid_x]
        
        return 0.0  # Default height if outside terrain bounds
```

### 2. Water System Integration
```python
def extract_water_data(self) -> WaterData:
    """Extract water data and integrate with terrain.
    
    Returns:
        WaterData object
    """
    try:
        # Load watermap files
        watermap_files = self.dll_manager.get_watermap_files()
        
        vertices = []
        indices = []
        bounds = {'min_x': float('inf'), 'min_y': float('inf'), 'min_z': float('inf'),
                 'max_x': float('-inf'), 'max_y': float('-inf'), 'max_z': float('-inf')}
        
        for watermap in watermap_files:
            # Process water quads
            for quad in watermap.quads:
                # Add vertices
                for vertex in quad.vertices:
                    vertices.append(vertex)
                    # Update bounds
                    bounds['min_x'] = min(bounds['min_x'], vertex[0])
                    bounds['min_y'] = min(bounds['min_y'], vertex[1])
                    bounds['min_z'] = min(bounds['min_z'], vertex[2])
                    bounds['max_x'] = max(bounds['max_x'], vertex[0])
                    bounds['max_y'] = max(bounds['max_y'], vertex[1])
                    bounds['max_z'] = max(bounds['max_z'], vertex[2])
                
                # Add indices
                base_index = len(vertices) - 4
                indices.extend([
                    base_index, base_index + 1, base_index + 2,
                    base_index + 1, base_index + 3, base_index + 2
                ])
        
        return WaterData(
            vertices=np.array(vertices, dtype=np.float32),
            indices=np.array(indices, dtype=np.uint32),
            bounds=bounds,
            type=watermap.type,
            height=watermap.height,
            color=watermap.color
        )
        
    except Exception as e:
        logger.error(f"Failed to extract water data: {e}")
        return None
```

### 3. Export Functions
```python
def export_obj(self, output_path: str):
    """Export terrain and building data to OBJ format.
    
    Args:
        output_path: Path to save OBJ file
    """
    try:
        with open(output_path, 'w') as f:
            # Write terrain vertices
            for vertex in self.terrain_system.geometry.vertices:
                f.write(f"v {vertex[0]} {vertex[1]} {vertex[2]}\n")
            
            # Write terrain normals
            for normal in self.terrain_system.geometry.normals:
                f.write(f"vn {normal[0]} {normal[1]} {normal[2]}\n")
            
            # Write terrain UVs
            for uv in self.terrain_system.geometry.uvs:
                f.write(f"vt {uv[0]} {uv[1]}\n")
            
            # Write terrain faces
            for i in range(0, len(self.terrain_system.geometry.indices), 3):
                idx1 = self.terrain_system.geometry.indices[i] + 1
                idx2 = self.terrain_system.geometry.indices[i + 1] + 1
                idx3 = self.terrain_system.geometry.indices[i + 2] + 1
                f.write(f"f {idx1}/{idx1}/{idx1} {idx2}/{idx2}/{idx2} {idx3}/{idx3}/{idx3}\n")
            
            # Write building vertices
            for building in self.buildings:
                f.write(f"\n# Building: {building.type}\n")
                for vertex in building.vertices:
                    f.write(f"v {vertex[0]} {vertex[1]} {vertex[2]}\n")
                
                # Write building faces
                for i in range(0, len(building.indices), 3):
                    idx1 = building.indices[i] + len(self.terrain_system.geometry.vertices) + 1
                    idx2 = building.indices[i + 1] + len(self.terrain_system.geometry.vertices) + 1
                    idx3 = building.indices[i + 2] + len(self.terrain_system.geometry.vertices) + 1
                    f.write(f"f {idx1} {idx2} {idx3}\n")
            
            # Write water mesh if available
            if self.water_data:
                f.write("\n# Water mesh\n")
                for vertex in self.water_data.vertices:
                    f.write(f"v {vertex[0]} {vertex[1]} {vertex[2]}\n")
                
                for i in range(0, len(self.water_data.indices), 3):
                    idx1 = self.water_data.indices[i] + 1
                    idx2 = self.water_data.indices[i + 1] + 1
                    idx3 = self.water_data.indices[i + 2] + 1
                    f.write(f"f {idx1} {idx2} {idx3}\n")
        
    except Exception as e:
        logger.error(f"Failed to export OBJ file: {e}")
```

## Usage Example

```typescript
// Initialize terrain system
const terrainSystem = new TerrainSystem();
const textureManager = new TerrainTextureManager();
const lodManager = new TerrainLODManager();

// Load heightmap data
const heightmapData = await terrainSystem.loadHeightmap('heightmap.dat');

// Create terrain geometry
const geometry = terrainSystem.createTerrainGeometry(heightmapData);

// Generate LOD levels
lodManager.generateLODLevels(geometry);

// Add texture layers
textureManager.addLayer({
    diffuse: await loadTexture('grass_diffuse.png'),
    normal: await loadTexture('grass_normal.png'),
    blend: 0.0,
    scale: 1.0
});

// Animation loop
function animate(time: number) {
    // Update water
    waterSystem.update(time);
    
    // Update LOD based on camera distance
    const cameraDistance = camera.position.distanceTo(terrain.position);
    const currentLOD = lodManager.getLODLevel(cameraDistance);
    
    // Update texture blending
    textureManager.updateBlendFactors(
        camera.position.y,
        calculateSlope(camera.position)
    );
    
    // Render terrain
    renderer.render(scene, camera);
    
    requestAnimationFrame(animate);
}
``` 
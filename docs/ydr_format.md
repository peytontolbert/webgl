# YDR File Format Documentation

## Overview
This document describes the YDR (YDR Drawable Dictionary) file format used in GTA5 for storing 3D model data, including geometry, materials, and textures.

## Table of Contents
1. [File Structure](#file-structure)
2. [Geometry Data](#geometry-data)
3. [Material System](#material-system)
4. [Texture Handling](#texture-handling)
5. [Processing Pipeline](#processing-pipeline)

## File Structure

### 1. Header
```c
struct YDRHeader {
    uint32_t magic;           // "YDR" magic number
    uint32_t version;         // File version
    uint32_t flags;           // File flags
    uint32_t numDrawables;    // Number of drawable objects
    uint32_t numMaterials;    // Number of materials
    uint32_t numTextures;     // Number of textures
    uint32_t dataSize;        // Size of data section
};
```

### 2. Drawable Objects
```c
struct DrawableObject {
    uint32_t nameHash;        // Hash of object name
    uint32_t numMeshes;       // Number of meshes
    uint32_t numBones;        // Number of bones (if skinned)
    uint32_t flags;           // Object flags
    float bounds[6];          // Bounding box (min_x, min_y, min_z, max_x, max_y, max_z)
    uint32_t meshIndices[];   // Array of mesh indices
    uint32_t boneIndices[];   // Array of bone indices (if skinned)
};
```

## Geometry Data

### 1. Mesh Structure
```c
struct Mesh {
    uint32_t numVertices;     // Number of vertices
    uint32_t numIndices;      // Number of indices
    uint32_t materialIndex;   // Index of material
    uint32_t flags;           // Mesh flags
    uint32_t vertexFormat;    // Vertex format flags
    float vertices[];         // Vertex data
    uint32_t indices[];       // Index data
};
```

### 2. Vertex Format
```c
enum VertexFormat {
    POSITION = 0x01,          // Position (x, y, z)
    NORMAL = 0x02,            // Normal (x, y, z)
    TANGENT = 0x04,           // Tangent (x, y, z)
    COLOR = 0x08,             // Color (r, g, b, a)
    UV0 = 0x10,               // Primary UV (u, v)
    UV1 = 0x20,               // Secondary UV (u, v)
    BLEND_WEIGHTS = 0x40,     // Blend weights (w1, w2, w3, w4)
    BLEND_INDICES = 0x80      // Blend indices (i1, i2, i3, i4)
};
```

## Material System

### 1. Material Structure
```c
struct Material {
    uint32_t nameHash;        // Hash of material name
    uint32_t shaderHash;      // Hash of shader name
    uint32_t numTextures;     // Number of textures
    uint32_t flags;           // Material flags
    float params[16];         // Shader parameters
    uint32_t textureIndices[]; // Array of texture indices
};
```

### 2. Shader Parameters
```c
struct ShaderParams {
    float diffuse[4];         // Diffuse color (RGBA)
    float specular[4];        // Specular color (RGBA)
    float emissive[4];        // Emissive color (RGBA)
    float roughness;          // Material roughness
    float metallic;           // Material metallicness
    float alpha;              // Material alpha
    float normalScale;        // Normal map scale
    float envScale;           // Environment map scale
};
```

## Texture Handling

### 1. Texture Structure
```c
struct Texture {
    uint32_t nameHash;        // Hash of texture name
    uint32_t width;           // Texture width
    uint32_t height;          // Texture height
    uint32_t format;          // Texture format
    uint32_t mipLevels;       // Number of mip levels
    uint32_t flags;           // Texture flags
    uint8_t data[];           // Texture data
};
```

### 2. Texture Formats
```c
enum TextureFormat {
    DXT1 = 0x01,             // DXT1 compression
    DXT3 = 0x02,             // DXT3 compression
    DXT5 = 0x03,             // DXT5 compression
    RGBA8 = 0x04,            // RGBA8 uncompressed
    RGBA16 = 0x05,           // RGBA16 uncompressed
    RGBA32 = 0x06            // RGBA32 uncompressed
};
```

## Processing Pipeline

### 1. File Loading
```typescript
class YDRLoader {
    async loadYDRFile(path: string): Promise<YDRData> {
        // Read file header
        const header = await this.readHeader(path);
        
        // Validate header
        if (!this.validateHeader(header)) {
            throw new Error('Invalid YDR file');
        }
        
        // Read drawable objects
        const drawables = await this.readDrawables(path, header);
        
        // Read materials
        const materials = await this.readMaterials(path, header);
        
        // Read textures
        const textures = await this.readTextures(path, header);
        
        return {
            header,
            drawables,
            materials,
            textures
        };
    }
}
```

### 2. Mesh Processing
```typescript
class MeshProcessor {
    processMesh(mesh: Mesh, materials: Material[], textures: Texture[]): ProcessedMesh {
        // Process vertices
        const vertices = this.processVertices(mesh.vertices, mesh.vertexFormat);
        
        // Process indices
        const indices = this.processIndices(mesh.indices);
        
        // Process material
        const material = this.processMaterial(
            materials[mesh.materialIndex],
            textures
        );
        
        return {
            vertices,
            indices,
            material,
            bounds: this.calculateBounds(vertices)
        };
    }
    
    private processVertices(vertexData: Float32Array, format: VertexFormat): VertexData {
        const vertices: VertexData = {
            positions: [],
            normals: [],
            uvs: [],
            colors: [],
            tangents: []
        };
        
        let offset = 0;
        const stride = this.getVertexStride(format);
        
        for (let i = 0; i < vertexData.length; i += stride) {
            if (format & VertexFormat.POSITION) {
                vertices.positions.push(
                    vertexData[i + offset],
                    vertexData[i + offset + 1],
                    vertexData[i + offset + 2]
                );
                offset += 3;
            }
            
            if (format & VertexFormat.NORMAL) {
                vertices.normals.push(
                    vertexData[i + offset],
                    vertexData[i + offset + 1],
                    vertexData[i + offset + 2]
                );
                offset += 3;
            }
            
            // Process other vertex attributes...
        }
        
        return vertices;
    }
}
```

### 3. Material Processing
```typescript
class MaterialProcessor {
    processMaterial(material: Material, textures: Texture[]): ProcessedMaterial {
        // Process shader parameters
        const params = this.processShaderParams(material.params);
        
        // Process textures
        const processedTextures = material.textureIndices.map(index => {
            const texture = textures[index];
            return this.processTexture(texture);
        });
        
        return {
            name: this.hashToString(material.nameHash),
            shader: this.hashToString(material.shaderHash),
            params,
            textures: processedTextures
        };
    }
    
    private processTexture(texture: Texture): ProcessedTexture {
        // Decompress texture data if needed
        const decompressed = this.decompressTexture(texture);
        
        // Create WebGL texture
        const glTexture = this.createGLTexture(decompressed);
        
        return {
            name: this.hashToString(texture.nameHash),
            width: texture.width,
            height: texture.height,
            format: texture.format,
            glTexture
        };
    }
}
```

## Usage Example

```typescript
// Initialize processors
const ydrLoader = new YDRLoader();
const meshProcessor = new MeshProcessor();
const materialProcessor = new MaterialProcessor();

// Load and process YDR file
async function processYDRFile(path: string) {
    try {
        // Load YDR data
        const ydrData = await ydrLoader.loadYDRFile(path);
        
        // Process each drawable
        const processedDrawables = ydrData.drawables.map(drawable => {
            const processedMeshes = drawable.meshIndices.map(index => {
                const mesh = ydrData.meshes[index];
                return meshProcessor.processMesh(
                    mesh,
                    ydrData.materials,
                    ydrData.textures
                );
            });
            
            return {
                name: ydrLoader.hashToString(drawable.nameHash),
                meshes: processedMeshes,
                bounds: drawable.bounds
            };
        });
        
        return processedDrawables;
        
    } catch (error) {
        console.error('Failed to process YDR file:', error);
        throw error;
    }
} 
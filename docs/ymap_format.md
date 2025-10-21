# YMAP Format Documentation

## Overview
YMAP files in GTA5 contain map data including entities, instances, and world information. This document details the format and coordinate systems used, with specific focus on WebGL viewer integration.

## YMAP File Structure

### 1. Header
```c
struct YmapHeader {
    uint32_t magic;           // "YMAP" (0x50414D59)
    uint32_t version;         // Usually 1
    uint32_t flags;          // Various flags
    uint32_t nameHash;       // Hash of map name
    uint32_t parentHash;     // Hash of parent map name
    uint32_t contentFlags;   // Content type flags
    Vector3 streamingExtentsMin;  // Streaming bounds
    Vector3 streamingExtentsMax;
    Vector3 entitiesExtentsMin;   // Entity bounds
    Vector3 entitiesExtentsMax;
};
```

### 2. Entity Types
```c
enum EntityType {
    ENTITY_DEFAULT = 0,
    ENTITY_BUILDING = 1,
    ENTITY_VEGETATION = 2,
    ENTITY_PROP = 3,
    ENTITY_VEHICLE = 4,
    ENTITY_PED = 5,
    ENTITY_ANIMAL = 6,
    ENTITY_WEAPON = 7,
    ENTITY_MLO = 8
};
```

### 3. Entity Structure
```c
struct EntityDef {
    uint32_t archetypeHash;  // Hash of model name
    uint32_t flags;          // Entity flags
    uint32_t guid;           // Unique identifier
    Vector3 position;        // World position
    Vector4 rotation;        // Quaternion rotation
    float scaleXY;          // XY scale
    float scaleZ;           // Z scale
    int32_t parentIndex;    // Parent entity index
    float lodDist;          // LOD distance
    float childLodDist;     // Child LOD distance
    uint8_t lodLevel;       // LOD level
    uint32_t numChildren;   // Number of child entities
    uint8_t priorityLevel;  // Priority level
    EntityExtension* extensions;  // Optional extensions
    float ambientOcclusionMultiplier;  // AO multiplier
    float artificialAmbientOcclusion;  // Artificial AO value
    float tintValue;        // Entity tint value
};
```

## Coordinate Systems

### 1. World Coordinate System
- Origin: (0, 0, 0) at map center
- Axes:
  - X: East-West (positive = East)
  - Y: North-South (positive = North)
  - Z: Up-Down (positive = Up)
- Units: Meters
- Scale: 1 unit = 1 meter

### 2. Local Coordinate System
- Origin: Entity position
- Axes:
  - X: Entity's right
  - Y: Entity's forward
  - Z: Entity's up
- Rotation: Quaternion (w, x, y, z)
- Scale: Relative to world scale

### 3. Coordinate Transformations
```javascript
// WebGL coordinate system conversion
function convertToWebGLCoordinates(position, rotation) {
    // GTA5 to WebGL coordinate system conversion
    const webglPosition = {
        x: position.x,
        y: position.z,  // Swap Y and Z
        z: -position.y  // Invert Y
    };
    
    // Convert quaternion to match WebGL coordinate system
    const webglRotation = {
        w: rotation.w,
        x: rotation.x,
        y: rotation.z,  // Swap Y and Z
        z: -rotation.y  // Invert Y
    };
    
    return { position: webglPosition, rotation: webglRotation };
}
```

## Entity Processing

### 1. Entity Loading and Processing
```javascript
class EntityProcessor {
    constructor(terrainSystem) {
        this.terrainSystem = terrainSystem;
    }
    
    processEntity(entity) {
        // Get terrain data
        const terrainData = this.sampleTerrainData(entity.position);
        
        // Adjust position and rotation based on terrain
        const adjustedEntity = this.adjustEntityToTerrain(entity, terrainData);
        
        // Convert to WebGL coordinates
        const webglEntity = this.convertToWebGLCoordinates(adjustedEntity);
        
        // Process extensions
        const extensions = this.processExtensions(entity.extensions);
        
        return {
            type: this.classifyEntity(entity),
            position: webglEntity.position,
            rotation: webglEntity.rotation,
            scale: [entity.scaleXY, entity.scaleXY, entity.scaleZ],
            flags: entity.flags,
            lodDist: entity.lodDist,
            childLodDist: entity.childLodDist,
            lodLevel: entity.lodLevel,
            priorityLevel: entity.priorityLevel,
            ambientOcclusion: entity.ambientOcclusionMultiplier,
            artificialAO: entity.artificialAmbientOcclusion,
            tint: entity.tintValue,
            extensions: extensions,
            terrainNormal: terrainData.normal,
            assetDependencies: this.collectAssetDependencies(entity)
        };
    }
    
    sampleTerrainData(position) {
        // Convert world position to terrain grid coordinates
        const gridX = Math.floor((position.x - this.terrainSystem.bounds.minX) / 
                                (this.terrainSystem.bounds.maxX - this.terrainSystem.bounds.minX) * 
                                (this.terrainSystem.width - 1));
        const gridY = Math.floor((position.y - this.terrainSystem.bounds.minY) / 
                                (this.terrainSystem.bounds.maxY - this.terrainSystem.bounds.minY) * 
                                (this.terrainSystem.height - 1));
        
        return {
            height: this.terrainSystem.getHeight(gridX, gridY),
            normal: this.terrainSystem.getNormal(gridX, gridY)
        };
    }
    
    adjustEntityToTerrain(entity, terrainData) {
        // Adjust position to terrain height
        entity.position.z = terrainData.height;
        
        // Align rotation with terrain normal
        if (terrainData.normal) {
            entity.rotation = this.alignToNormal(entity.rotation, terrainData.normal);
        }
        
        return entity;
    }
}
```

### 2. Entity Classification
```javascript
classifyEntity(entity) {
    const archetype = this.getArchetypeName(entity.archetypeHash);
    
    // Check for building types
    if (archetype.toLowerCase().includes('building') || 
        archetype.toLowerCase().includes('house') || 
        archetype.toLowerCase().includes('apartment')) {
        return EntityType.BUILDING;
    }
    
    // Check for vegetation
    if (archetype.toLowerCase().includes('tree') || 
        archetype.toLowerCase().includes('grass') || 
        archetype.toLowerCase().includes('bush')) {
        return EntityType.VEGETATION;
    }
    
    // Check for props
    if (archetype.toLowerCase().includes('prop') || 
        archetype.toLowerCase().includes('furniture') || 
        archetype.toLowerCase().includes('decoration')) {
        return EntityType.PROP;
    }
    
    return EntityType.DEFAULT;
}
```

### 3. LOD Management
```javascript
class LODManager {
    constructor() {
        this.lodLevels = {
            HIGH: 0,
            MEDIUM: 1,
            LOW: 2
        };
    }
    
    getLODLevel(entity, cameraDistance) {
        if (cameraDistance <= entity.lodDist) {
            return this.lodLevels.HIGH;
        } else if (cameraDistance <= entity.childLodDist) {
            return this.lodLevels.MEDIUM;
        } else {
            return this.lodLevels.LOW;
        }
    }
    
    shouldRenderEntity(entity, cameraDistance) {
        const lodLevel = this.getLODLevel(entity, cameraDistance);
        return lodLevel !== this.lodLevels.LOW || entity.priorityLevel > 0;
    }
}
```

## WebGL Integration

### 1. Shader Uniforms
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
uniform sampler2D uDiffuseMap;      // t0
uniform sampler2D uNormalMap;       // t1
uniform sampler2D uBlendMask;       // t2
uniform sampler2D uLayer1Map;       // t3
uniform sampler2D uLayer2Map;       // t4
uniform sampler2D uGrassDiffuseMap; // t5
uniform sampler2D uRockDiffuseMap;  // t6
uniform sampler2D uDirtDiffuseMap;  // t7
uniform sampler2D uSandDiffuseMap;  // t8
uniform sampler2D uSnowDiffuseMap;  // t9
```

### 2. Entity Rendering
```javascript
class EntityRenderer {
    constructor(gl, shaderProgram) {
        this.gl = gl;
        this.program = shaderProgram;
        this.uniforms = this.getUniformLocations();
    }
    
    renderEntity(entity, viewProjectionMatrix) {
        // Update matrices
        const modelMatrix = this.calculateModelMatrix(entity);
        const normalMatrix = mat3.normalFromMat4(mat3.create(), modelMatrix);
        
        // Set uniforms
        this.gl.uniformMatrix4fv(this.uniforms.uViewProjectionMatrix, false, viewProjectionMatrix);
        this.gl.uniformMatrix4fv(this.uniforms.uModelMatrix, false, modelMatrix);
        this.gl.uniformMatrix3fv(this.uniforms.uNormalMatrix, false, normalMatrix);
        
        // Set entity-specific uniforms
        this.gl.uniform3fv(this.uniforms.uTerrainBounds, entity.terrainBounds);
        this.gl.uniform3fv(this.uniforms.uTerrainSize, entity.terrainSize);
        this.gl.uniform1i(this.uniforms.uHasHeightmap, entity.hasHeightmap ? 1 : 0);
        this.gl.uniform1i(this.uniforms.uEnableTint, entity.enableTint ? 1 : 0);
        this.gl.uniform1f(this.uniforms.uTintYVal, entity.tintValue);
        
        // Bind textures
        this.bindEntityTextures(entity);
        
        // Render mesh
        this.renderMesh(entity.mesh);
    }
}
```

## Usage Example

```javascript
// Initialize systems
const ymapHandler = new YmapHandler(rpfReader);
const terrainSystem = new TerrainSystem(gamePath, dllManager);
const entityProcessor = new EntityProcessor(terrainSystem);
const entityRenderer = new EntityRenderer(gl, shaderProgram);

// Load YMAP
const ymap = await ymapHandler.loadYmap("path/to/ymap.ymap");

// Process and render entities
for (const entity of ymap.entities) {
    // Process entity
    const processedEntity = entityProcessor.processEntity(entity);
    
    // Check LOD
    const cameraDistance = calculateDistance(processedEntity.position, cameraPos);
    if (lodManager.shouldRenderEntity(processedEntity, cameraDistance)) {
        // Render entity
        entityRenderer.renderEntity(processedEntity, viewProjectionMatrix);
    }
}
``` 
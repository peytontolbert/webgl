# WebGL Viewer Integration

## Overview
This document describes how to integrate the building system with the WebGL viewer, including loading building meshes, handling LOD, and rendering water.

## Table of Contents
1. [Building Mesh Loading](#building-mesh-loading)
2. [LOD System](#lod-system)
3. [Water Rendering](#water-rendering)
4. [Performance Optimization](#performance-optimization)

## Building Mesh Loading

### 1. Building Mesh Structure
```typescript
interface BuildingMesh {
    vertices: Float32Array;    // Vertex positions
    normals: Float32Array;     // Vertex normals
    uvs: Float32Array;         // Texture coordinates
    indices: Uint32Array;      // Triangle indices
    materials: Material[];     // Material definitions
    bounds: BoundingBox;       // Bounding box for culling
    lodLevels: LODLevel[];     // LOD mesh variations
}

interface Material {
    diffuse: string;          // Diffuse texture path
    normal: string;           // Normal map path
    specular: string;         // Specular map path
    roughness: number;        // Material roughness
    metallic: number;         // Material metallicness
}
```

### 2. Mesh Loading Process
```typescript
class BuildingLoader {
    async loadBuildingMesh(buildingData: BuildingData): Promise<BuildingMesh> {
        // Load YDR file
        const ydrData = await this.loadYDRFile(buildingData.archetype);
        
        // Process mesh data
        const mesh = this.processYDRData(ydrData);
        
        // Apply transformations
        this.applyTransformations(mesh, buildingData);
        
        // Generate LOD levels
        mesh.lodLevels = this.generateLODLevels(mesh);
        
        return mesh;
    }
    
    private applyTransformations(mesh: BuildingMesh, data: BuildingData) {
        // Apply position
        for (let i = 0; i < mesh.vertices.length; i += 3) {
            mesh.vertices[i] += data.position[0];
            mesh.vertices[i + 1] += data.position[1];
            mesh.vertices[i + 2] += data.position[2];
        }
        
        // Apply rotation
        const quat = new THREE.Quaternion(
            data.rotation[0],
            data.rotation[1],
            data.rotation[2],
            data.rotation[3]
        );
        this.applyQuaternion(mesh.vertices, quat);
        
        // Apply scale
        for (let i = 0; i < mesh.vertices.length; i += 3) {
            mesh.vertices[i] *= data.scale[0];
            mesh.vertices[i + 1] *= data.scale[1];
            mesh.vertices[i + 2] *= data.scale[2];
        }
    }
}
```

## LOD System

### 1. LOD Level Definition
```typescript
interface LODLevel {
    vertices: Float32Array;
    indices: Uint32Array;
    distance: number;      // Distance at which this LOD is used
    triangleCount: number; // Number of triangles in this LOD
}

class LODManager {
    private lodLevels: Map<string, LODLevel[]> = new Map();
    
    getLODLevel(buildingId: string, distance: number): LODLevel {
        const levels = this.lodLevels.get(buildingId);
        if (!levels) return null;
        
        // Find appropriate LOD level based on distance
        for (const level of levels) {
            if (distance <= level.distance) {
                return level;
            }
        }
        
        return levels[levels.length - 1]; // Return lowest quality LOD
    }
}
```

### 2. LOD Switching
```typescript
class BuildingRenderer {
    private lodManager: LODManager;
    
    updateLOD(camera: THREE.Camera) {
        for (const building of this.buildings) {
            const distance = camera.position.distanceTo(building.position);
            const lodLevel = this.lodManager.getLODLevel(
                building.id,
                distance
            );
            
            if (lodLevel) {
                this.updateBuildingMesh(building, lodLevel);
            }
        }
    }
}
```

## Water Rendering

### 1. Water Shader
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

varying vec2 vUv;
varying vec3 vPosition;
varying vec3 vNormal;

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

### 2. Water System
```typescript
class WaterSystem {
    private waterMesh: THREE.Mesh;
    private waterShader: THREE.ShaderMaterial;
    
    constructor() {
        this.initWaterMesh();
        this.initWaterShader();
    }
    
    private initWaterMesh() {
        // Create water mesh from water data
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(waterData.vertices, 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(waterData.normals, 3));
        geometry.setAttribute('uv', new THREE.BufferAttribute(waterData.uvs, 2));
        geometry.setIndex(new THREE.BufferAttribute(waterData.indices, 1));
        
        this.waterMesh = new THREE.Mesh(geometry, this.waterShader);
    }
    
    update(time: number) {
        // Update wave animation
        this.waterShader.uniforms.time.value = time;
    }
}
```

## Performance Optimization

### 1. Frustum Culling
```typescript
class BuildingManager {
    private frustum: THREE.Frustum;
    
    updateVisibility(camera: THREE.Camera) {
        this.frustum.setFromProjectionMatrix(
            new THREE.Matrix4().multiplyMatrices(
                camera.projectionMatrix,
                camera.matrixWorldInverse
            )
        );
        
        for (const building of this.buildings) {
            const visible = this.frustum.containsBox(building.bounds);
            building.mesh.visible = visible;
        }
    }
}
```

### 2. Instance Rendering
```typescript
class BuildingInstances {
    private instancedMesh: THREE.InstancedMesh;
    private instanceData: Float32Array;
    
    constructor(buildingMesh: BuildingMesh) {
        // Create instanced mesh
        this.instancedMesh = new THREE.InstancedMesh(
            buildingMesh.geometry,
            buildingMesh.material,
            MAX_INSTANCES
        );
        
        // Initialize instance data
        this.instanceData = new Float32Array(MAX_INSTANCES * 16);
    }
    
    updateInstances(buildings: Building[]) {
        for (let i = 0; i < buildings.length; i++) {
            const building = buildings[i];
            const matrix = new THREE.Matrix4();
            
            // Set position
            matrix.setPosition(building.position);
            
            // Set rotation
            const quat = new THREE.Quaternion().setFromEuler(building.rotation);
            matrix.setRotationFromQuaternion(quat);
            
            // Set scale
            matrix.scale(building.scale);
            
            // Update instance data
            matrix.toArray(this.instanceData, i * 16);
        }
        
        this.instancedMesh.geometry.setAttribute(
            'instanceMatrix',
            new THREE.InstancedBufferAttribute(this.instanceData, 16)
        );
    }
}
```

### 3. Texture Atlasing
```typescript
class TextureAtlas {
    private atlas: THREE.Texture;
    private textureMap: Map<string, {x: number, y: number, w: number, h: number}>;
    
    constructor() {
        this.atlas = new THREE.Texture();
        this.textureMap = new Map();
    }
    
    addTexture(texture: THREE.Texture): {x: number, y: number, w: number, h: number} {
        // Find space in atlas
        const space = this.findSpace(texture.image.width, texture.image.height);
        
        // Add texture to atlas
        this.addToAtlas(texture, space);
        
        return space;
    }
    
    getTextureCoordinates(textureId: string): {x: number, y: number, w: number, h: number} {
        return this.textureMap.get(textureId);
    }
}
```

## Usage Example

```typescript
// Initialize systems
const buildingLoader = new BuildingLoader();
const buildingManager = new BuildingManager();
const waterSystem = new WaterSystem();

// Load building data
const buildingData = await fetch('building_info.json').then(r => r.json());
for (const data of buildingData.buildings) {
    const mesh = await buildingLoader.loadBuildingMesh(data);
    buildingManager.addBuilding(mesh);
}

// Animation loop
function animate(time: number) {
    // Update water
    waterSystem.update(time);
    
    // Update building LODs
    buildingManager.updateLOD(camera);
    
    // Update visibility
    buildingManager.updateVisibility(camera);
    
    // Render scene
    renderer.render(scene, camera);
    
    requestAnimationFrame(animate);
} 
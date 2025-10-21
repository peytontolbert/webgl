// Import gl-matrix
import * as glMatrix from 'gl-matrix';
import { ShaderProgram } from './shader_program.js';
import { TextureManager } from './texture_manager.js';
import { TerrainMesh } from './terrain_mesh.js';

// Vertex shader
const vsSource = `#version 300 es
    in vec3 aPosition;
    in vec3 aNormal;
    in vec2 aTexcoord;
    in vec2 aTexcoord1;
    in vec2 aTexcoord2;
    in vec2 aColor0;
    
    uniform mat4 uViewProjectionMatrix;
    uniform mat4 uModelMatrix;
    uniform mat3 uNormalMatrix;
    uniform vec3 uTerrainBounds;  // (min_x, min_y, min_z)
    uniform vec3 uTerrainSize;    // (width, height, max_height)
    uniform sampler2D uHeightmap;
    uniform bool uHasHeightmap;
    uniform bool uEnableTint;
    uniform float uTintYVal;
    
    out vec3 vPosition;
    out vec3 vNormal;
    out vec2 vTexcoord0;
    out vec2 vTexcoord1;
    out vec2 vTexcoord2;
    out vec4 vColor0;
    
    void main() {
        // Convert position to world coordinates
        vec3 worldPos;
        if (uHasHeightmap) {
            // Calculate grid position (aPosition.xy is in [0, 1] range)
            vec2 gridPos = aPosition.xy;
            
            // Calculate world position using GTA5's coordinate system
            worldPos.x = uTerrainBounds.x + (gridPos.x / (uTerrainSize.x - 1.0)) * (uTerrainBounds.x + uTerrainSize.x);
            worldPos.y = uTerrainBounds.y + (gridPos.y / (uTerrainSize.y - 1.0)) * (uTerrainBounds.y + uTerrainSize.y);
            
            // Sample height from heightmap
            vec2 heightmapCoord = vec2(gridPos.x, 1.0 - gridPos.y);
            float height = texture(uHeightmap, heightmapCoord).r;
            
            // Scale height to match the terrain bounds
            float heightScale = uTerrainSize.z / 255.0;
            worldPos.z = uTerrainBounds.z + height * heightScale;
            
            // Calculate normal from heightmap
            vec2 texelSize = 1.0 / uTerrainSize.xy;
            float left = texture(uHeightmap, heightmapCoord - vec2(texelSize.x, 0.0)).r;
            float right = texture(uHeightmap, heightmapCoord + vec2(texelSize.x, 0.0)).r;
            float top = texture(uHeightmap, heightmapCoord - vec2(0.0, texelSize.y)).r;
            float bottom = texture(uHeightmap, heightmapCoord + vec2(0.0, texelSize.y)).r;
            
            // Calculate normal using central differences
            vec3 normal = normalize(vec3(
                (left - right) * heightScale,
                (top - bottom) * heightScale,
                1.0
            ));
            
            // Transform normal to world space
            vNormal = normalize(uNormalMatrix * normal);
        } else {
            worldPos = aPosition;
            vNormal = normalize(uNormalMatrix * aNormal);
        }
        
        // Transform position
        vec4 modelPos = uModelMatrix * vec4(worldPos, 1.0);
        gl_Position = uViewProjectionMatrix * modelPos;
        
        // Pass data to fragment shader
        vPosition = modelPos.xyz;
        vTexcoord0 = aTexcoord;
        vTexcoord1 = aTexcoord1;
        vTexcoord2 = aTexcoord2;
        vColor0 = vec4(aColor0, 1.0, 1.0);
    }
`;

// Fragment shader
const fsSource = `#version 300 es
    precision mediump float;
    
    in vec3 vPosition;
    in vec3 vNormal;
    in vec2 vTexcoord0;
    in vec2 vTexcoord1;
    in vec2 vTexcoord2;
    in vec4 vColor0;
    
    // Main textures (t0-t4)
    uniform sampler2D uDiffuseMap;      // t0
    uniform sampler2D uNormalMap;       // t1
    uniform sampler2D uBlendMask;       // t2
    uniform sampler2D uLayer1Map;       // t3
    uniform sampler2D uLayer2Map;       // t4
    
    // Terrain type textures (t5-t9)
    uniform sampler2D uGrassDiffuseMap; // t5
    uniform sampler2D uRockDiffuseMap;  // t6
    uniform sampler2D uDirtDiffuseMap;  // t7
    uniform sampler2D uSandDiffuseMap;  // t8
    uniform sampler2D uSnowDiffuseMap;  // t9
    
    // Normal maps for terrain types (t10-t14)
    uniform sampler2D uGrassNormalMap;  // t10
    uniform sampler2D uRockNormalMap;   // t11
    uniform sampler2D uDirtNormalMap;   // t12
    uniform sampler2D uSandNormalMap;   // t13
    uniform sampler2D uSnowNormalMap;   // t14
    
    uniform bool uHasNormalMap;
    uniform bool uHasGrassNormalMap;
    uniform bool uHasRockNormalMap;
    uniform bool uHasDirtNormalMap;
    uniform bool uHasSandNormalMap;
    uniform bool uHasSnowNormalMap;
    uniform bool uEnableTint;
    uniform float uTintYVal;
    uniform vec3 uLightDir;
    uniform vec3 uLightColor;
    uniform float uAmbientIntensity;
    uniform float uBumpiness;
    
    out vec4 fragColor;
    
    void main() {
        // Sample textures with proper wrapping
        vec4 diffuse = texture(uDiffuseMap, vTexcoord0);
        vec4 layer1 = texture(uLayer1Map, vTexcoord0);
        vec4 layer2 = texture(uLayer2Map, vTexcoord0);
        vec4 blendMask = texture(uBlendMask, vTexcoord1);
        
        // Sample terrain type textures
        vec4 grassTex = texture(uGrassDiffuseMap, vTexcoord0);
        vec4 rockTex = texture(uRockDiffuseMap, vTexcoord0);
        vec4 dirtTex = texture(uDirtDiffuseMap, vTexcoord0);
        vec4 sandTex = texture(uSandDiffuseMap, vTexcoord0);
        vec4 snowTex = texture(uSnowDiffuseMap, vTexcoord0);
        
        // Initialize final diffuse color
        vec4 finalDiffuse = diffuse;
        
        // Blend layers using mask (if available)
        if (blendMask.r > 0.0) finalDiffuse = mix(finalDiffuse, layer1, blendMask.r);
        if (blendMask.g > 0.0) finalDiffuse = mix(finalDiffuse, layer2, blendMask.g);
        
        // Blend terrain types based on height and slope
        float height = vPosition.y;
        float slope = 1.0 - abs(dot(vNormal, vec3(1.0, 0.0, 0.0)));
        
        // Height-based blending
        if (height > 0.8) {
            finalDiffuse = mix(finalDiffuse, snowTex, smoothstep(0.8, 1.0, height));
        } else if (height > 0.6) {
            finalDiffuse = mix(finalDiffuse, rockTex, smoothstep(0.6, 0.8, height));
        } else if (height > 0.4) {
            finalDiffuse = mix(finalDiffuse, dirtTex, smoothstep(0.4, 0.6, height));
        } else if (height > 0.2) {
            finalDiffuse = mix(finalDiffuse, grassTex, smoothstep(0.2, 0.4, height));
        } else {
            finalDiffuse = mix(finalDiffuse, sandTex, smoothstep(0.0, 0.2, height));
        }
        
        // Slope-based blending
        if (slope < 0.3) {
            finalDiffuse = mix(finalDiffuse, rockTex, smoothstep(0.3, 0.0, slope));
        }
        
        // Apply vertex colors if enabled
        if (uEnableTint) {
            finalDiffuse *= vColor0;
        }
        
        // Normal mapping
        vec3 normal = normalize(vNormal);
        if (uHasNormalMap) {
            vec3 normalMap = texture(uNormalMap, vTexcoord0).rgb * 2.0 - 1.0;
            normalMap *= uBumpiness;
            normal = normalize(normal + normalMap);
        }
        
        // Terrain type normal maps
        if (uHasGrassNormalMap && height > 0.2 && height < 0.4) {
            vec3 normalMap = texture(uGrassNormalMap, vTexcoord0).rgb * 2.0 - 1.0;
            normalMap *= uBumpiness;
            normal = normalize(normal + normalMap * smoothstep(0.2, 0.4, height));
        }
        if (uHasRockNormalMap && (height > 0.6 || slope < 0.3)) {
            vec3 normalMap = texture(uRockNormalMap, vTexcoord0).rgb * 2.0 - 1.0;
            normalMap *= uBumpiness;
            normal = normalize(normal + normalMap * (1.0 - smoothstep(0.6, 0.8, height) + smoothstep(0.3, 0.0, slope)));
        }
        if (uHasDirtNormalMap && height > 0.4 && height < 0.6) {
            vec3 normalMap = texture(uDirtNormalMap, vTexcoord0).rgb * 2.0 - 1.0;
            normalMap *= uBumpiness;
            normal = normalize(normal + normalMap * smoothstep(0.4, 0.6, height));
        }
        if (uHasSandNormalMap && height < 0.2) {
            vec3 normalMap = texture(uSandNormalMap, vTexcoord0).rgb * 2.0 - 1.0;
            normalMap *= uBumpiness;
            normal = normalize(normal + normalMap * (1.0 - smoothstep(0.0, 0.2, height)));
        }
        if (uHasSnowNormalMap && height > 0.8) {
            vec3 normalMap = texture(uSnowNormalMap, vTexcoord0).rgb * 2.0 - 1.0;
            normalMap *= uBumpiness;
            normal = normalize(normal + normalMap * smoothstep(0.8, 1.0, height));
        }
        
        // Calculate lighting
        float diff = max(dot(normal, uLightDir), 0.0);
        vec3 lighting = uAmbientIntensity * uLightColor + diff * uLightColor;
        
        // Final color with gamma correction
        vec3 finalColor = finalDiffuse.rgb * lighting;
        finalColor = pow(finalColor, vec3(1.0 / 2.2)); // Gamma correction
        
        // Ensure alpha is preserved
        fragColor = vec4(finalColor, finalDiffuse.a);
    }
`;

export class TerrainRenderer {
    constructor(gl) {
        this.gl = gl;
        this.program = new ShaderProgram(gl);
        this.textureManager = new TextureManager(gl);
        this.mesh = null;
        this.heightmap = null;
        this.terrainBounds = [0, 0, 0];
        this.terrainSize = [0, 0, 0];
        this.modelMatrix = glMatrix.mat4.create();
        this.normalMatrix = glMatrix.mat3.create();
        this.uniforms = null;
        
        // Initialize textures with proper organization
        this.textures = {
            // Main terrain textures
            diffuse: null,
            normal: null,
            
            // Layer textures (up to 4)
            layer1: null,
            layer2: null,
            layer3: null,
            layer4: null,
            
            // Layer normal maps
            normal1: null,
            normal2: null,
            normal3: null,
            normal4: null,
            
            // Blend mask
            blendMask: null,
            
            // Terrain type textures
            grass: {
                diffuse: null,
                normal: null
            },
            rock: {
                diffuse: null,
                normal: null
            },
            dirt: {
                diffuse: null,
                normal: null
            },
            sand: {
                diffuse: null,
                normal: null
            },
            snow: {
                diffuse: null,
                normal: null
            }
        };
        
        // Initialize model matrix to match GTA5's coordinate system
        glMatrix.mat4.rotateY(this.modelMatrix, this.modelMatrix, Math.PI);
        glMatrix.mat4.rotateX(this.modelMatrix, this.modelMatrix, Math.PI / 2);
        
        this.initShaders();
    }
    
    async initShaders() {
        try {
            await this.program.createProgram(vsSource, fsSource);
            
            // Set up uniforms
            this.uniforms = {
                // Scene uniforms
                uViewProjectionMatrix: this.gl.getUniformLocation(this.program.program, 'uViewProjectionMatrix'),
                uModelMatrix: this.gl.getUniformLocation(this.program.program, 'uModelMatrix'),
                uNormalMatrix: this.gl.getUniformLocation(this.program.program, 'uNormalMatrix'),
                uTerrainBounds: this.gl.getUniformLocation(this.program.program, 'uTerrainBounds'),
                uTerrainSize: this.gl.getUniformLocation(this.program.program, 'uTerrainSize'),
                uHeightmap: this.gl.getUniformLocation(this.program.program, 'uHeightmap'),
                uHasHeightmap: this.gl.getUniformLocation(this.program.program, 'uHasHeightmap'),
                
                // Entity uniforms
                uCamRel: this.gl.getUniformLocation(this.program.program, 'uCamRel'),
                uOrientation: this.gl.getUniformLocation(this.program.program, 'uOrientation'),
                uScale: this.gl.getUniformLocation(this.program.program, 'uScale'),
                uHasSkeleton: this.gl.getUniformLocation(this.program.program, 'uHasSkeleton'),
                uHasTransforms: this.gl.getUniformLocation(this.program.program, 'uHasTransforms'),
                uTintPaletteIndex: this.gl.getUniformLocation(this.program.program, 'uTintPaletteIndex'),
                
                // Model uniforms
                uTransform: this.gl.getUniformLocation(this.program.program, 'uTransform'),
                
                // Geometry uniforms
                uEnableTint: this.gl.getUniformLocation(this.program.program, 'uEnableTint'),
                uTintYVal: this.gl.getUniformLocation(this.program.program, 'uTintYVal'),
                
                // Scene uniforms (fragment)
                uEnableShadows: this.gl.getUniformLocation(this.program.program, 'uEnableShadows'),
                uRenderMode: this.gl.getUniformLocation(this.program.program, 'uRenderMode'),
                uRenderModeIndex: this.gl.getUniformLocation(this.program.program, 'uRenderModeIndex'),
                uRenderSamplerCoord: this.gl.getUniformLocation(this.program.program, 'uRenderSamplerCoord'),
                
                // Geometry uniforms (fragment)
                uEnableTexture0: this.gl.getUniformLocation(this.program.program, 'uEnableTexture0'),
                uEnableTexture1: this.gl.getUniformLocation(this.program.program, 'uEnableTexture1'),
                uEnableTexture2: this.gl.getUniformLocation(this.program.program, 'uEnableTexture2'),
                uEnableTexture3: this.gl.getUniformLocation(this.program.program, 'uEnableTexture3'),
                uEnableTexture4: this.gl.getUniformLocation(this.program.program, 'uEnableTexture4'),
                uEnableTextureMask: this.gl.getUniformLocation(this.program.program, 'uEnableTextureMask'),
                uEnableNormalMap: this.gl.getUniformLocation(this.program.program, 'uEnableNormalMap'),
                uEnableVertexColour: this.gl.getUniformLocation(this.program.program, 'uEnableVertexColour'),
                uBumpiness: this.gl.getUniformLocation(this.program.program, 'uBumpiness'),
                
                // Lighting uniforms
                uLightDir: this.gl.getUniformLocation(this.program.program, 'uLightDir'),
                uLightColor: this.gl.getUniformLocation(this.program.program, 'uLightColor'),
                uAmbientIntensity: this.gl.getUniformLocation(this.program.program, 'uAmbientIntensity'),
                
                // Texture uniforms
                uColourmap0: this.gl.getUniformLocation(this.program.program, 'uColourmap0'),
                uColourmap1: this.gl.getUniformLocation(this.program.program, 'uColourmap1'),
                uColourmap2: this.gl.getUniformLocation(this.program.program, 'uColourmap2'),
                uColourmap3: this.gl.getUniformLocation(this.program.program, 'uColourmap3'),
                uColourmap4: this.gl.getUniformLocation(this.program.program, 'uColourmap4'),
                uColourmask: this.gl.getUniformLocation(this.program.program, 'uColourmask'),
                uNormalmap0: this.gl.getUniformLocation(this.program.program, 'uNormalmap0'),
                uNormalmap1: this.gl.getUniformLocation(this.program.program, 'uNormalmap1'),
                uNormalmap2: this.gl.getUniformLocation(this.program.program, 'uNormalmap2'),
                uNormalmap3: this.gl.getUniformLocation(this.program.program, 'uNormalmap3'),
                uNormalmap4: this.gl.getUniformLocation(this.program.program, 'uNormalmap4')
            };
        } catch (error) {
            console.error('Failed to initialize shader program:', error);
        }
    }
    
    async loadTerrainMesh() {
        try {
            // Load heightmap data
            const heightmapResponse = await fetch('assets/heightmap.png');
            if (!heightmapResponse.ok) {
                console.warn('Heightmap texture not found, terrain will be rendered without heightmap');
                return false;
            }
            
            const heightmapBlob = await heightmapResponse.blob();
            const heightmapImage = await createImageBitmap(heightmapBlob);
            
            // Create heightmap texture
            this.heightmap = this.gl.createTexture();
            this.gl.bindTexture(this.gl.TEXTURE_2D, this.heightmap);
            
            // Set texture parameters for heightmap
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
            
            // Upload heightmap data
            this.gl.texImage2D(
                this.gl.TEXTURE_2D,
                0,                // mip level
                this.gl.R8,       // internal format (single channel for height)
                heightmapImage.width,      // width
                heightmapImage.height,     // height
                0,                // border
                this.gl.RED,      // format
                this.gl.UNSIGNED_BYTE, // type
                heightmapImage    // data
            );
            
            // Load terrain info
            const infoResponse = await fetch('assets/terrain_info.json');
            if (!infoResponse.ok) throw new Error('Failed to load terrain info');
            
            const info = await infoResponse.json();
            
            // Validate terrain info structure
            if (!info.dimensions || !info.bounds || Object.keys(info.dimensions).length === 0) {
                throw new Error('Invalid terrain info structure');
            }
            
            // Get the first heightmap's bounds and dimensions
            const firstHeightmapKey = Object.keys(info.dimensions)[0];
            const firstHeightmap = info.dimensions[firstHeightmapKey];
            const bounds = info.bounds[firstHeightmapKey];
            
            if (!bounds || !firstHeightmap) {
                throw new Error('Missing bounds or dimensions data');
            }
            
            // Set terrain bounds and size
            this.terrainBounds = [bounds.min_x, bounds.min_y, bounds.min_z];
            this.terrainSize = [
                firstHeightmap.width,
                firstHeightmap.height,
                bounds.max_z - bounds.min_z
            ];
            
            // Create mesh from heightmap data
            this.mesh = new TerrainMesh(this.gl, this.program);
            this.mesh.createFromHeightmap(
                heightmapImage.width,
                heightmapImage.height,
                bounds
            );
            
            // Load terrain textures using CodeWalker's texture organization
            // Main terrain textures (t0-t4)
            await this.loadTexture('diffuse', 'assets/textures/cs_rsn_sl_agrdirttrack3_diffuse.png');
            await this.loadTexture('normal', 'assets/textures/cs_rsn_sl_agrdirttrack3_normal.png');
            
            // Layer textures (t1-t4)
            await this.loadTexture('layer1', 'assets/textures/cs_rsn_sl_agrgrass_02_dark_diffuse.png');
            await this.loadTexture('normal1', 'assets/textures/og_coastgrass_01_normal.png');
            
            await this.loadTexture('layer2', 'assets/textures/cs_rsn_sl_cstcliff_0003_diffuse.png');
            await this.loadTexture('normal2', 'assets/textures/cs_rsn_sl_cstcliff_0003_normal.png');
            
            await this.loadTexture('layer3', 'assets/textures/cs_islx_canyonrock_rough_01_diffuse.png');
            await this.loadTexture('normal3', 'assets/textures/cs_islx_canyonrock_rough_01_height_diffuse.png');
            
            await this.loadTexture('layer4', 'assets/textures/cs_rsn_sl_rockslime_01_diffuse.png');
            await this.loadTexture('normal4', 'assets/textures/cs_rsn_sl_agrdirttrack1_normal.png');
            
            // Load blend mask (using a height texture as mask)
            await this.loadTexture('blendMask', 'assets/textures/cs_rsn_sl_cstcliff_0003_height_diffuse.png');
            
            // Load terrain type textures (t5-t9)
            await this.loadTexture('grass_diffuse', 'assets/textures/cs_rsn_sl_agrgrass_02_dark_diffuse.png');
            await this.loadTexture('grass_normal', 'assets/textures/og_coastgrass_01_normal.png');
            
            await this.loadTexture('rock_diffuse', 'assets/textures/cs_rsn_sl_cstcliff_0003_diffuse.png');
            await this.loadTexture('rock_normal', 'assets/textures/cs_rsn_sl_cstcliff_0003_normal.png');
            
            await this.loadTexture('dirt_diffuse', 'assets/textures/cs_rsn_sl_agrdirttrack3_diffuse.png');
            await this.loadTexture('dirt_normal', 'assets/textures/cs_rsn_sl_agrdirttrack3_normal.png');
            
            await this.loadTexture('sand_diffuse', 'assets/textures/cs_islx_wetlandmud03b_diffuse.png');
            await this.loadTexture('sand_normal', 'assets/textures/cs_rsn_sl_uwshell_0001_normal.png');
            
            await this.loadTexture('snow_diffuse', 'assets/textures/cs_rsn_sl_rockslime_01_diffuse.png');
            await this.loadTexture('snow_normal', 'assets/textures/cs_rsn_sl_agrdirttrack1_normal.png');
            
            console.log('Terrain mesh loaded successfully');
            return true;
            
        } catch (error) {
            console.error('Failed to load terrain mesh:', error);
            return false;
        }
    }
    
    async loadHeightmapTexture() {
        try {
            const response = await fetch('assets/heightmap.png');
            if (!response.ok) {
                console.warn('Heightmap texture not found, terrain will be rendered without heightmap');
                return false;
            }
            
            const blob = await response.blob();
            const image = await createImageBitmap(blob);
            
            // Create texture
            const texture = this.gl.createTexture();
            this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
            
            // Set texture parameters for heightmap
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
            
            // Upload heightmap data
            this.gl.texImage2D(
                this.gl.TEXTURE_2D,
                0,                // mip level
                this.gl.R8,       // internal format (single channel for height)
                image.width,      // width
                image.height,     // height
                0,                // border
                this.gl.RED,      // format
                this.gl.UNSIGNED_BYTE, // type
                image            // data
            );
            
            this.heightmap = texture;
            return true;
            
        } catch (error) {
            console.warn('Failed to load heightmap texture, terrain will be rendered without heightmap:', error);
            return false;
        }
    }
    
    parseOBJ(text) {
        const vertices = [];
        const normals = [];
        const texcoords = [];
        const indices = [];
        
        const lines = text.split('\n');
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length === 0) continue;
            
            switch (parts[0]) {
                case 'v':
                    vertices.push(
                        parseFloat(parts[1]),
                        parseFloat(parts[2]),
                        parseFloat(parts[3])
                    );
                    break;
                case 'vn':
                    normals.push(
                        parseFloat(parts[1]),
                        parseFloat(parts[2]),
                        parseFloat(parts[3])
                    );
                    break;
                case 'vt':
                    texcoords.push(
                        parseFloat(parts[1]),
                        parseFloat(parts[2])
                    );
                    break;
                case 'f':
                    const f1 = parts[1].split('/');
                    const f2 = parts[2].split('/');
                    const f3 = parts[3].split('/');
                    
                    indices.push(
                        parseInt(f1[0]) - 1,
                        parseInt(f2[0]) - 1,
                        parseInt(f3[0]) - 1
                    );
                    break;
            }
        }
        
        return { vertices, normals, texcoords, indices };
    }
    
    async loadTexture(type, path) {
        try {
            console.log(`Loading ${type} texture from ${path}...`);
            const response = await fetch(path);
            if (!response.ok) {
                console.warn(`Failed to load ${type} texture from ${path}: ${response.status} ${response.statusText}`);
                return false;
            }
            
            const blob = await response.blob();
            
            // Create a promise for image loading
            const imageLoadPromise = new Promise((resolve, reject) => {
                const image = new Image();
                
                // Set timeout for image loading
                const timeout = setTimeout(() => {
                    reject(new Error(`Timeout loading ${type} texture from ${path}`));
                }, 10000); // 10 second timeout
                
                image.onload = () => {
                    clearTimeout(timeout);
                    console.log(`${type} texture loaded:`, image.width, 'x', image.height);
                    resolve(image);
                };
                
                image.onerror = (error) => {
                    clearTimeout(timeout);
                    console.warn(`Failed to load ${type} texture from ${path}:`, error);
                    reject(error);
                };
                
                // Create object URL and set source
                const objectUrl = URL.createObjectURL(blob);
                image.src = objectUrl;
                
                // Clean up object URL after loading or error
                image.onload = () => {
                    clearTimeout(timeout);
                    URL.revokeObjectURL(objectUrl);
                    console.log(`${type} texture loaded:`, image.width, 'x', image.height);
                    resolve(image);
                };
                
                image.onerror = (error) => {
                    clearTimeout(timeout);
                    URL.revokeObjectURL(objectUrl);
                    console.warn(`Failed to load ${type} texture from ${path}:`, error);
                    reject(error);
                };
            });
            
            // Wait for image to load
            const image = await imageLoadPromise;
            
            // Create texture
            const texture = this.gl.createTexture();
            this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
            
            // Set texture parameters with anisotropic filtering
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR_MIPMAP_LINEAR);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.REPEAT);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.REPEAT);
            
            // Create a canvas to get the image data
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(image, 0, 0);
            
            // Get the image data
            const imageData = ctx.getImageData(0, 0, image.width, image.height);
            
            // Upload image data
            this.gl.texImage2D(
                this.gl.TEXTURE_2D,
                0,                // mip level
                this.gl.RGBA,     // internal format
                image.width,      // width
                image.height,     // height
                0,                // border
                this.gl.RGBA,     // format
                this.gl.UNSIGNED_BYTE, // type
                imageData.data    // data
            );
            
            // Generate mipmaps
            this.gl.generateMipmap(this.gl.TEXTURE_2D);
            
            // Store texture
            this.textures[type] = texture;
            
            return true;
            
        } catch (error) {
            console.warn(`Error loading ${type} texture from ${path}:`, error);
            return false;
        }
    }
    
    render(viewProjectionMatrix) {
        if (!this.mesh || !this.uniforms) return;
        
        this.program.use();
        
        // Update matrices
        glMatrix.mat3.normalFromMat4(this.normalMatrix, this.modelMatrix);
        
        // Set scene uniforms
        this.gl.uniformMatrix4fv(this.uniforms.uViewProjectionMatrix, false, viewProjectionMatrix);
        this.gl.uniformMatrix4fv(this.uniforms.uModelMatrix, false, this.modelMatrix);
        this.gl.uniformMatrix3fv(this.uniforms.uNormalMatrix, false, this.normalMatrix);
        this.gl.uniform3fv(this.uniforms.uTerrainBounds, this.terrainBounds);
        this.gl.uniform3fv(this.uniforms.uTerrainSize, this.terrainSize);
        
        // Set entity uniforms
        this.gl.uniform4f(this.uniforms.uCamRel, 0, 0, 0, 1);
        this.gl.uniform4f(this.uniforms.uOrientation, 0, 0, 0, 1);
        this.gl.uniform3f(this.uniforms.uScale, 1, 1, 1);
        this.gl.uniform1ui(this.uniforms.uHasSkeleton, 0);
        this.gl.uniform1ui(this.uniforms.uHasTransforms, 1);
        this.gl.uniform1ui(this.uniforms.uTintPaletteIndex, 0);
        
        // Set model uniforms
        this.gl.uniformMatrix4fv(this.uniforms.uTransform, false, this.modelMatrix);
        
        // Set geometry uniforms
        this.gl.uniform1ui(this.uniforms.uEnableTint, 0);
        this.gl.uniform1f(this.uniforms.uTintYVal, 0.0);
        
        // Set scene uniforms (fragment)
        this.gl.uniform1ui(this.uniforms.uEnableShadows, 0);
        this.gl.uniform1ui(this.uniforms.uRenderMode, 0);
        this.gl.uniform1ui(this.uniforms.uRenderModeIndex, 0);
        this.gl.uniform1ui(this.uniforms.uRenderSamplerCoord, 0);
        
        // Set geometry uniforms (fragment)
        this.gl.uniform1ui(this.uniforms.uEnableTexture0, 1);
        this.gl.uniform1ui(this.uniforms.uEnableTexture1, 1);
        this.gl.uniform1ui(this.uniforms.uEnableTexture2, 1);
        this.gl.uniform1ui(this.uniforms.uEnableTexture3, 1);
        this.gl.uniform1ui(this.uniforms.uEnableTexture4, 1);
        this.gl.uniform1ui(this.uniforms.uEnableTextureMask, 1);
        this.gl.uniform1ui(this.uniforms.uEnableNormalMap, 1);
        this.gl.uniform1ui(this.uniforms.uEnableVertexColour, 1);
        this.gl.uniform1f(this.uniforms.uBumpiness, 0.5);
        
        // Set lighting uniforms
        this.gl.uniform3fv(this.uniforms.uLightDir, [0.5, 0.8, 0.3]);
        this.gl.uniform3fv(this.uniforms.uLightColor, [1.0, 1.0, 1.0]);
        this.gl.uniform1f(this.uniforms.uAmbientIntensity, 0.7);
        
        // Bind textures
        if (this.heightmap) {
            this.gl.activeTexture(this.gl.TEXTURE0);
            this.gl.bindTexture(this.gl.TEXTURE_2D, this.heightmap);
            this.gl.uniform1i(this.uniforms.uHeightmap, 0);
            this.gl.uniform1i(this.uniforms.uHasHeightmap, 1);
        }
        
        // Bind main terrain textures
        if (this.textures.diffuse) {
            this.gl.activeTexture(this.gl.TEXTURE1);
            this.gl.bindTexture(this.gl.TEXTURE_2D, this.textures.diffuse);
            this.gl.uniform1i(this.uniforms.uColourmap0, 1);
        }
        
        if (this.textures.normal) {
            this.gl.activeTexture(this.gl.TEXTURE2);
            this.gl.bindTexture(this.gl.TEXTURE_2D, this.textures.normal);
            this.gl.uniform1i(this.uniforms.uNormalmap0, 2);
        }
        
        // Bind layer textures
        for (let i = 1; i <= 4; i++) {
            const layerTex = this.textures[`layer${i}`];
            const normalTex = this.textures[`normal${i}`];
            
            if (layerTex) {
                this.gl.activeTexture(this.gl.TEXTURE1 + i);
                this.gl.bindTexture(this.gl.TEXTURE_2D, layerTex);
                this.gl.uniform1i(this.uniforms[`uColourmap${i}`], 1 + i);
            }
            
            if (normalTex) {
                this.gl.activeTexture(this.gl.TEXTURE5 + i);
                this.gl.bindTexture(this.gl.TEXTURE_2D, normalTex);
                this.gl.uniform1i(this.uniforms[`uNormalmap${i}`], 5 + i);
            }
        }
        
        // Bind blend mask
        if (this.textures.blendMask) {
            this.gl.activeTexture(this.gl.TEXTURE9);
            this.gl.bindTexture(this.gl.TEXTURE_2D, this.textures.blendMask);
            this.gl.uniform1i(this.uniforms.uColourmask, 9);
        }
        
        // Bind terrain type textures
        const terrainTypes = ['grass', 'rock', 'dirt', 'sand', 'snow'];
        for (let i = 0; i < terrainTypes.length; i++) {
            const type = terrainTypes[i];
            const diffuseTex = this.textures[type].diffuse;
            const normalTex = this.textures[type].normal;
            
            if (diffuseTex) {
                this.gl.activeTexture(this.gl.TEXTURE10 + i);
                this.gl.bindTexture(this.gl.TEXTURE_2D, diffuseTex);
                this.gl.uniform1i(this.uniforms[`u${type}DiffuseMap`], 10 + i);
            }
            
            if (normalTex) {
                this.gl.activeTexture(this.gl.TEXTURE15 + i);
                this.gl.bindTexture(this.gl.TEXTURE_2D, normalTex);
                this.gl.uniform1i(this.uniforms[`u${type}NormalMap`], 15 + i);
            }
        }
        
        // Render mesh
        this.mesh.render();
    }
    
    dispose() {
        if (this.mesh) {
            this.mesh.dispose();
            this.mesh = null;
        }
        if (this.heightmap) {
            this.gl.deleteTexture(this.heightmap);
            this.heightmap = null;
        }
        // Dispose textures
        for (const texture of Object.values(this.textures)) {
            if (texture) {
                this.gl.deleteTexture(texture);
            }
        }
        this.textures = {
            diffuse: null,
            normal: null,
            layer1: null,
            layer2: null,
            layer3: null,
            layer4: null,
            blendMask: null,
            normal1: null,
            normal2: null,
            normal3: null,
            normal4: null
        };
        if (this.program) {
            this.program.dispose();
        }
    }
} 
import { glMatrix } from './glmatrix.js';
import { ShaderProgram } from './shader_program.js';
import { TextureManager } from './texture_manager.js';
import { TerrainMesh } from './terrain_mesh.js';
import { fetchBlob, fetchJSON } from './asset_fetcher.js';

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
    uniform vec3 uTerrainSize;    // (size_x, size_y, size_z) in world units
    uniform vec2 uTerrainGrid;    // (width, height) in samples
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
    out float vHeight01;
    
    void main() {
        // Convert position to world coordinates
        vec3 worldPos;
        if (uHasHeightmap) {
            // Calculate grid position (aPosition.xy is in [0, 1] range)
            vec2 gridPos = aPosition.xy;
            
            // Calculate world position using GTA5's coordinate system
            worldPos.x = uTerrainBounds.x + gridPos.x * uTerrainSize.x;
            worldPos.y = uTerrainBounds.y + gridPos.y * uTerrainSize.y;
            
            // Sample height from heightmap
            vec2 heightmapCoord = vec2(gridPos.x, 1.0 - gridPos.y);
            float height = texture(uHeightmap, heightmapCoord).r;
            vHeight01 = height;
            
            // Scale height to match the terrain bounds (height is already 0..1 from R8 texture)
            worldPos.z = uTerrainBounds.z + height * uTerrainSize.z;
            
            // Calculate normal from heightmap
            vec2 texelSize = 1.0 / max(uTerrainGrid, vec2(2.0, 2.0));
            float left = texture(uHeightmap, heightmapCoord - vec2(texelSize.x, 0.0)).r;
            float right = texture(uHeightmap, heightmapCoord + vec2(texelSize.x, 0.0)).r;
            float top = texture(uHeightmap, heightmapCoord - vec2(0.0, texelSize.y)).r;
            float bottom = texture(uHeightmap, heightmapCoord + vec2(0.0, texelSize.y)).r;
            
            // Calculate normal using central differences
            vec3 normal = normalize(vec3(
                (left - right) * uTerrainSize.z,
                (top - bottom) * uTerrainSize.z,
                1.0
            ));
            
            // Transform normal to world space
            vNormal = normalize(uNormalMatrix * normal);
        } else {
            worldPos = aPosition;
            vNormal = normalize(uNormalMatrix * aNormal);
            vHeight01 = 0.0;
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
    in float vHeight01;
    
    // True 4-layer splat blending:
    // - uBlendMask is a world-space (same UVs as heightmap) RGBA weight map.
    // - uLayer{1..4}Map are tiled material textures.
    uniform sampler2D uBlendMask;
    uniform sampler2D uLayer1Map;
    uniform sampler2D uLayer2Map;
    uniform sampler2D uLayer3Map;
    uniform sampler2D uLayer4Map;
    uniform bool uEnableTint;
    uniform float uTintYVal;
    uniform vec3 uLightDir;
    uniform vec3 uLightColor;
    uniform float uAmbientIntensity;
    uniform float uBumpiness;

    uniform vec3 uCameraPos;
    uniform bool uFogEnabled;
    uniform vec3 uFogColor;
    uniform float uFogStart;
    uniform float uFogEnd;
    
    out vec4 fragColor;

    // Color pipeline:
    // - If terrain layer textures are uploaded as sRGB, sampling returns linear.
    // - If not, set uDecodeSrgb so we decode manually.
    uniform bool uDecodeSrgb;

    vec3 decodeSrgb(vec3 c) {
        return pow(max(c, vec3(0.0)), vec3(2.2));
    }
    vec3 encodeSrgb(vec3 c) {
        return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2));
    }
    
    void main() {
        // vTexcoord0 is in "image space" (v increases downward). Heightmap sampling uses (u, 1-v),
        // so match that convention for the blend mask too.
        vec2 maskUv = vec2(vTexcoord0.x, 1.0 - vTexcoord0.y);
        vec4 w = texture(uBlendMask, maskUv);
        float sumW = w.r + w.g + w.b + w.a;
        if (sumW <= 1e-5) {
            w = vec4(1.0, 0.0, 0.0, 0.0);
        } else {
            w /= sumW;
        }

        // Tiled UVs for material layers.
        vec2 tileUv = vTexcoord1;
        vec4 c1 = texture(uLayer1Map, tileUv);
        vec4 c2 = texture(uLayer2Map, tileUv);
        vec4 c3 = texture(uLayer3Map, tileUv);
        vec4 c4 = texture(uLayer4Map, tileUv);
        if (uDecodeSrgb) {
            c1.rgb = decodeSrgb(c1.rgb);
            c2.rgb = decodeSrgb(c2.rgb);
            c3.rgb = decodeSrgb(c3.rgb);
            c4.rgb = decodeSrgb(c4.rgb);
        }

        vec4 finalDiffuse = (c1 * w.r) + (c2 * w.g) + (c3 * w.b) + (c4 * w.a);
        
        // Apply vertex colors if enabled
        if (uEnableTint) {
            finalDiffuse *= vColor0;
        }
        
        vec3 normal = normalize(vNormal);
        
        // Calculate lighting
        float diff = max(dot(normal, uLightDir), 0.0);
        vec3 lighting = uAmbientIntensity * uLightColor + diff * uLightColor;
        
        // Final color (linear lighting)
        vec3 finalColor = finalDiffuse.rgb * lighting;

        // Atmospheric fog (linear)
        if (uFogEnabled) {
            float dist = length(vPosition - uCameraPos);
            float fogF = smoothstep(uFogStart, uFogEnd, dist);
            finalColor = mix(finalColor, uFogColor, fogF);
        }

        // Gamma encode for display
        finalColor = encodeSrgb(finalColor);
        
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
        // CPU copy of heightmap pixels for sampling (optional)
        this.heightmapPixels = null; // { width, height, data: Uint8ClampedArray }
        this.terrainBounds = [0, 0, 0];
        this.terrainSize = [0, 0, 0];
        // Used by shaders for heightmap sampling/normal reconstruction; must match heightmap texture resolution.
        this.terrainGrid = [1, 1];
        // Geometry tessellation grid (can be higher than the heightmap resolution for smoother silhouettes).
        this.meshGrid = [1, 1];
        // Soft cap to avoid blowing up the vertex count on large maps.
        this.maxTerrainVertices = 220000;
        this.sceneBoundsView = { min: [0, 0, 0], max: [0, 0, 0] };
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

        // Ensure we always have sane fallbacks so zoomed-out view doesn't go "red"
        // (which happens when samplers default to texture unit 0 = heightmap).
        this._ensureTerrainTextureFallbacks();
        
        // Data-space (GTA) is Z-up. Viewer-space uses Y-up (camera.up = [0,1,0]).
        // Convert Z-up -> Y-up via -90° around X. The extra 180° Y-rotation keeps the map facing the expected direction.
        glMatrix.mat4.rotateY(this.modelMatrix, this.modelMatrix, Math.PI);
        glMatrix.mat4.rotateX(this.modelMatrix, this.modelMatrix, -Math.PI / 2);
        
        this.initShaders();
    }

    _ensureTerrainTextureFallbacks() {
        // Main terrain textures
        if (!this.textures.diffuse) this.textures.diffuse = this._createSolidTextureRGBA(this._defaultColorForTextureType('diffuse'));
        if (!this.textures.normal) this.textures.normal = this._createSolidTextureRGBA(this._defaultColorForTextureType('normal'));
        // Default mask chooses layer1.
        if (!this.textures.blendMask) this.textures.blendMask = this._createSolidTextureRGBA([255, 0, 0, 0]);
        if (!this.textures.layer1) this.textures.layer1 = this._createSolidTextureRGBA(this._defaultColorForTextureType('layer1'));
        if (!this.textures.layer2) this.textures.layer2 = this._createSolidTextureRGBA(this._defaultColorForTextureType('layer2'));
        if (!this.textures.layer3) this.textures.layer3 = this._createSolidTextureRGBA(this._defaultColorForTextureType('layer3'));
        if (!this.textures.layer4) this.textures.layer4 = this._createSolidTextureRGBA(this._defaultColorForTextureType('layer4'));

        // Terrain type textures + normals
        const types = ['grass', 'rock', 'dirt', 'sand', 'snow'];
        for (const t of types) {
            if (!this.textures[t]?.diffuse) this.textures[t].diffuse = this._createSolidTextureRGBA(this._defaultColorForTextureType(t));
            if (!this.textures[t]?.normal) this.textures[t].normal = this._createSolidTextureRGBA(this._defaultColorForTextureType('normal'));
        }
    }

    _defaultColorForTextureType(type) {
        // RGBA 0-255
        const t = (type || '').toLowerCase();
        if (t.includes('normal')) return [128, 128, 255, 255]; // flat normal
        if (t.includes('blend') || t.includes('mask') || t.includes('lookup')) return [128, 128, 128, 255];
        if (t.includes('grass')) return [60, 140, 60, 255];
        if (t.includes('rock')) return [110, 110, 110, 255];
        if (t.includes('dirt')) return [120, 90, 60, 255];
        if (t.includes('sand')) return [190, 180, 120, 255];
        if (t.includes('snow')) return [230, 230, 230, 255];
        return [200, 200, 200, 255];
    }

    _createSolidTextureRGBA(colorRGBA255) {
        const gl = this.gl;
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

        const data = new Uint8Array(colorRGBA255);
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            1,
            1,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            data
        );
        return texture;
    }

    _chooseMeshGrid(heightmapW, heightmapH) {
        const hw = Math.max(2, heightmapW | 0);
        const hh = Math.max(2, heightmapH | 0);
        const cap = Math.max(10000, this.maxTerrainVertices | 0);

        const isWebGL2 = (typeof WebGL2RenderingContext !== 'undefined') && (this.gl instanceof WebGL2RenderingContext);
        const maxVerts = isWebGL2 ? cap : Math.min(cap, 65000);

        const baseVerts = hw * hh;
        if (baseVerts <= 0) return [hw, hh];

        // Preserve aspect ratio while scaling vertex count towards maxVerts.
        const s = Math.sqrt(maxVerts / baseVerts);
        const scale = Math.max(1.0, s);
        let mw = Math.max(2, Math.round(hw * scale));
        let mh = Math.max(2, Math.round(hh * scale));

        // Final clamp for WebGL1 16-bit index safety.
        if (!isWebGL2) {
            while (mw * mh > 65000) {
                mw = Math.max(2, Math.floor(mw * 0.98));
                mh = Math.max(2, Math.floor(mh * 0.98));
            }
        }

        return [mw, mh];
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
                uTerrainGrid: this.gl.getUniformLocation(this.program.program, 'uTerrainGrid'),
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

                // Fog/atmosphere
                uCameraPos: this.gl.getUniformLocation(this.program.program, 'uCameraPos'),
                uFogEnabled: this.gl.getUniformLocation(this.program.program, 'uFogEnabled'),
                uFogColor: this.gl.getUniformLocation(this.program.program, 'uFogColor'),
                uFogStart: this.gl.getUniformLocation(this.program.program, 'uFogStart'),
                uFogEnd: this.gl.getUniformLocation(this.program.program, 'uFogEnd'),

                uDecodeSrgb: this.gl.getUniformLocation(this.program.program, 'uDecodeSrgb'),
                
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
                uNormalmap4: this.gl.getUniformLocation(this.program.program, 'uNormalmap4'),

                // Actual terrain samplers used by the current fsSource
                uDiffuseMap: this.gl.getUniformLocation(this.program.program, 'uDiffuseMap'),
                uNormalMap: this.gl.getUniformLocation(this.program.program, 'uNormalMap'),
                uBlendMask: this.gl.getUniformLocation(this.program.program, 'uBlendMask'),
                uLayer1Map: this.gl.getUniformLocation(this.program.program, 'uLayer1Map'),
                uLayer2Map: this.gl.getUniformLocation(this.program.program, 'uLayer2Map'),
                uLayer3Map: this.gl.getUniformLocation(this.program.program, 'uLayer3Map'),
                uLayer4Map: this.gl.getUniformLocation(this.program.program, 'uLayer4Map'),
                uGrassDiffuseMap: this.gl.getUniformLocation(this.program.program, 'uGrassDiffuseMap'),
                uRockDiffuseMap: this.gl.getUniformLocation(this.program.program, 'uRockDiffuseMap'),
                uDirtDiffuseMap: this.gl.getUniformLocation(this.program.program, 'uDirtDiffuseMap'),
                uSandDiffuseMap: this.gl.getUniformLocation(this.program.program, 'uSandDiffuseMap'),
                uSnowDiffuseMap: this.gl.getUniformLocation(this.program.program, 'uSnowDiffuseMap'),
                uGrassNormalMap: this.gl.getUniformLocation(this.program.program, 'uGrassNormalMap'),
                uRockNormalMap: this.gl.getUniformLocation(this.program.program, 'uRockNormalMap'),
                uDirtNormalMap: this.gl.getUniformLocation(this.program.program, 'uDirtNormalMap'),
                uSandNormalMap: this.gl.getUniformLocation(this.program.program, 'uSandNormalMap'),
                uSnowNormalMap: this.gl.getUniformLocation(this.program.program, 'uSnowNormalMap'),
                uHasNormalMap: this.gl.getUniformLocation(this.program.program, 'uHasNormalMap'),
                uHasGrassNormalMap: this.gl.getUniformLocation(this.program.program, 'uHasGrassNormalMap'),
                uHasRockNormalMap: this.gl.getUniformLocation(this.program.program, 'uHasRockNormalMap'),
                uHasDirtNormalMap: this.gl.getUniformLocation(this.program.program, 'uHasDirtNormalMap'),
                uHasSandNormalMap: this.gl.getUniformLocation(this.program.program, 'uHasSandNormalMap'),
                uHasSnowNormalMap: this.gl.getUniformLocation(this.program.program, 'uHasSnowNormalMap')
            };
        } catch (error) {
            console.error('Failed to initialize shader program:', error);
        }
    }
    
    async loadTerrainMesh() {
        try {
            // Load heightmap data
            let heightmapBlob;
            try {
                // HIGH priority: required for the first playable frame.
                heightmapBlob = await fetchBlob('assets/heightmap.png', { priority: 'high' });
            } catch {
                console.warn('Heightmap texture not found, terrain will be rendered without heightmap');
                return false;
            }
            const heightmapImage = await createImageBitmap(heightmapBlob);

            // Keep a CPU-side copy for height sampling (spawn ped on ground, etc.)
            try {
                const canvas = document.createElement('canvas');
                canvas.width = heightmapImage.width;
                canvas.height = heightmapImage.height;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (ctx) {
                    ctx.drawImage(heightmapImage, 0, 0);
                    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    this.heightmapPixels = { width: canvas.width, height: canvas.height, data: img.data };
                }
            } catch {
                // Ignore if browser disallows canvas readback or any error occurs.
                this.heightmapPixels = null;
            }
            
            // Create heightmap texture
            this.heightmap = this.gl.createTexture();
            this.gl.bindTexture(this.gl.TEXTURE_2D, this.heightmap);
            
            // Set texture parameters for heightmap
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
            
            // Upload heightmap data
            // For ImageBitmap sources, use the 6-arg overload.
            this.gl.texImage2D(
                this.gl.TEXTURE_2D,
                0,                // mip level
                this.gl.R8,       // internal format (single channel for height)
                this.gl.RED,      // format
                this.gl.UNSIGNED_BYTE, // type
                heightmapImage    // source
            );
            
            // Load terrain info
            // HIGH priority: required for the first playable frame.
            const info = await fetchJSON('assets/terrain_info.json', { priority: 'high' });
            
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
            
            // Set terrain bounds and size (world-space extents)
            this.terrainBounds = [bounds.min_x, bounds.min_y, bounds.min_z];
            this.terrainSize = [
                (bounds.max_x - bounds.min_x),
                (bounds.max_y - bounds.min_y),
                (bounds.max_z - bounds.min_z),
            ];
            // IMPORTANT: this must match the actual heightmap *texture* size used in the shader.
            // terrain_info.json dimensions may refer to the original extraction grid, which can differ from the
            // viewer's downsampled heightmap.png.
            this.terrainGrid = [heightmapImage.width, heightmapImage.height];
            this.meshGrid = this._chooseMeshGrid(heightmapImage.width, heightmapImage.height);

            // Precompute scene AABB in *viewer space* for the camera (transform 8 corners).
            const corners = [
                [bounds.min_x, bounds.min_y, bounds.min_z],
                [bounds.max_x, bounds.min_y, bounds.min_z],
                [bounds.min_x, bounds.max_y, bounds.min_z],
                [bounds.max_x, bounds.max_y, bounds.min_z],
                [bounds.min_x, bounds.min_y, bounds.max_z],
                [bounds.max_x, bounds.min_y, bounds.max_z],
                [bounds.min_x, bounds.max_y, bounds.max_z],
                [bounds.max_x, bounds.max_y, bounds.max_z],
            ];
            const vmin = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
            const vmax = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
            for (const c of corners) {
                const c4 = glMatrix.vec4.fromValues(c[0], c[1], c[2], 1.0);
                const out = glMatrix.vec4.create();
                glMatrix.vec4.transformMat4(out, c4, this.modelMatrix);
                vmin[0] = Math.min(vmin[0], out[0]);
                vmin[1] = Math.min(vmin[1], out[1]);
                vmin[2] = Math.min(vmin[2], out[2]);
                vmax[0] = Math.max(vmax[0], out[0]);
                vmax[1] = Math.max(vmax[1], out[1]);
                vmax[2] = Math.max(vmax[2], out[2]);
            }
            this.sceneBoundsView = { min: vmin, max: vmax };
            
            // Create mesh from heightmap data
            this.mesh = new TerrainMesh(this.gl, this.program);
            this.mesh.createFromHeightmap(
                this.meshGrid[0],
                this.meshGrid[1],
                bounds
            );
            
            console.log('Terrain mesh loaded successfully');
            return true;
            
        } catch (error) {
            console.error('Failed to load terrain mesh:', error);
            return false;
        }
    }

    /**
     * Sample terrain height in GTA/data space at (x, y).
     * Returns null if sampling isn't available yet.
     */
    getHeightAtXY(x, y) {
        if (!this.heightmapPixels || !this.heightmapPixels.data) return null;
        const [minX, minY, minZ] = this.terrainBounds || [0, 0, 0];
        const [sizeX, sizeY, sizeZ] = this.terrainSize || [0, 0, 0];
        if (!sizeX || !sizeY || !sizeZ) return null;

        // Map to UV in [0..1]
        let u = (x - minX) / sizeX;
        let v = (y - minY) / sizeY;
        u = Math.max(0, Math.min(1, u));
        v = Math.max(0, Math.min(1, v));

        // Shader samples at vec2(u, 1 - v)
        const w = this.heightmapPixels.width;
        const h = this.heightmapPixels.height;
        const px = Math.round(u * (w - 1));
        const py = Math.round((1.0 - v) * (h - 1));
        const idx = (py * w + px) * 4;
        const r = this.heightmapPixels.data[idx] ?? 0;
        const height01 = r / 255.0;
        return minZ + height01 * sizeZ;
    }
    
    async loadHeightmapTexture() {
        try {
            let blob;
            try {
                blob = await fetchBlob('assets/heightmap.png', { priority: 'high' });
            } catch {
                console.warn('Heightmap texture not found, terrain will be rendered without heightmap');
                return false;
            }
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
            // For ImageBitmap sources, use the 6-arg overload.
            this.gl.texImage2D(
                this.gl.TEXTURE_2D,
                0,                // mip level
                this.gl.R8,       // internal format (single channel for height)
                this.gl.RED,      // format
                this.gl.UNSIGNED_BYTE, // type
                image             // source
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
            let blob;
            try {
                // LOW priority: terrain textures are a quality upgrade, not a boot blocker.
                blob = await fetchBlob(path, { priority: 'low' });
            } catch {
                // Use a placeholder texture so rendering continues without spam.
                this._setTextureByKeyPath(type, this._createSolidTextureRGBA(this._defaultColorForTextureType(type)));
                return false;
            }

            // Decode without <img> to avoid noisy onerror Events.
            const imageBitmap = await createImageBitmap(blob);
            
            // Create texture
            const texture = this.gl.createTexture();
            this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
            
            // Set texture parameters with anisotropic filtering
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR_MIPMAP_LINEAR);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.REPEAT);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.REPEAT);
            
            // Upload image data with a defined color pipeline:
            // - Color layers: sRGB when supported
            // - Data textures (normals/blend/etc): linear
            const t = String(type || '').toLowerCase();
            const isColor = !(t.includes('normal') || t.includes('blend') || t.includes('mask') || t.includes('lookup') || t.includes('height'));

            const gl = this.gl;
            const isWebGL2 = (typeof WebGL2RenderingContext !== 'undefined') && (gl instanceof WebGL2RenderingContext);
            const extSrgb = (!isWebGL2) ? (gl.getExtension('EXT_sRGB') || gl.getExtension('WEBGL_sRGB')) : null;
            const canSrgb = isColor && (isWebGL2 || !!extSrgb);

            const prevCsc = (() => {
                try { return gl.getParameter(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL); } catch { return null; }
            })();
            try {
                if (prevCsc !== null && typeof gl.UNPACK_COLORSPACE_CONVERSION_WEBGL !== 'undefined') {
                    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
                }
            } catch { /* ignore */ }

            const internalFormat = (canSrgb && isWebGL2 && typeof gl.SRGB8_ALPHA8 === 'number')
                ? gl.SRGB8_ALPHA8
                : (canSrgb && extSrgb && typeof extSrgb.SRGB_ALPHA_EXT === 'number')
                    ? extSrgb.SRGB_ALPHA_EXT
                    : gl.RGBA;
            const format = (canSrgb && extSrgb && !isWebGL2) ? extSrgb.SRGB_ALPHA_EXT : gl.RGBA;

            gl.texImage2D(
                gl.TEXTURE_2D,
                0, // mip level
                internalFormat,
                format,
                gl.UNSIGNED_BYTE,
                imageBitmap
            );

            try {
                if (prevCsc !== null && typeof gl.UNPACK_COLORSPACE_CONVERSION_WEBGL !== 'undefined') {
                    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, prevCsc);
                }
            } catch { /* ignore */ }
            
            // Generate mipmaps
            this.gl.generateMipmap(this.gl.TEXTURE_2D);
            
            // Store texture
            this._setTextureByKeyPath(type, texture);
            
            return true;
            
        } catch (error) {
            // Placeholder fallback on any unexpected error.
            this._setTextureByKeyPath(type, this._createSolidTextureRGBA(this._defaultColorForTextureType(type)));
            return false;
        }
    }

    _setTextureByKeyPath(type, texture) {
        // Supports nested keys like "grass.diffuse" to populate this.textures.grass.diffuse.
        const key = String(type || '');
        if (!key) return;

        const parts = key.split('.').map(s => s.trim()).filter(Boolean);
        if (parts.length === 0) return;

        // If it's a simple key, keep old behavior.
        if (parts.length === 1) {
            this.textures[parts[0]] = texture;
            return;
        }

        // Walk/create containers.
        let obj = this.textures;
        for (let i = 0; i < parts.length - 1; i++) {
            const p = parts[i];
            if (!obj[p] || typeof obj[p] !== 'object') obj[p] = {};
            obj = obj[p];
        }
        obj[parts[parts.length - 1]] = texture;
    }
    
    render(viewProjectionMatrix, cameraPos = [0, 0, 0], fog = { enabled: false, color: [0.6, 0.7, 0.8], start: 1500, end: 9000 }) {
        if (!this.mesh || !this.uniforms) return;
        
        this.program.use();

        // Ensure we always have sane fallbacks so samplers never default to unit 0 (heightmap).
        this._ensureTerrainTextureFallbacks();
        
        // Update matrices
        glMatrix.mat3.normalFromMat4(this.normalMatrix, this.modelMatrix);
        
        // Set scene uniforms
        this.gl.uniformMatrix4fv(this.uniforms.uViewProjectionMatrix, false, viewProjectionMatrix);
        this.gl.uniformMatrix4fv(this.uniforms.uModelMatrix, false, this.modelMatrix);
        this.gl.uniformMatrix3fv(this.uniforms.uNormalMatrix, false, this.normalMatrix);
        this.gl.uniform3fv(this.uniforms.uTerrainBounds, this.terrainBounds);
        this.gl.uniform3fv(this.uniforms.uTerrainSize, this.terrainSize);
        if (this.uniforms.uTerrainGrid) {
            this.gl.uniform2fv(this.uniforms.uTerrainGrid, this.terrainGrid || [1, 1]);
        }
        
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

        // Fog uniforms
        this.gl.uniform3fv(this.uniforms.uCameraPos, cameraPos);
        this.gl.uniform1i(this.uniforms.uFogEnabled, fog?.enabled ? 1 : 0);
        this.gl.uniform3fv(this.uniforms.uFogColor, fog?.color || [0.6, 0.7, 0.8]);
        this.gl.uniform1f(this.uniforms.uFogStart, Number(fog?.start ?? 1500));
        this.gl.uniform1f(this.uniforms.uFogEnd, Number(fog?.end ?? 9000));

        // If we can't upload sRGB textures, decode in shader.
        try {
            const isWebGL2 = (typeof WebGL2RenderingContext !== 'undefined') && (this.gl instanceof WebGL2RenderingContext);
            const hasSrgb = isWebGL2 || !!(this.gl.getExtension('EXT_sRGB') || this.gl.getExtension('WEBGL_sRGB'));
            this.gl.uniform1i(this.uniforms.uDecodeSrgb, hasSrgb ? 0 : 1);
        } catch {
            this.gl.uniform1i(this.uniforms.uDecodeSrgb, 1);
        }
        
        // Bind heightmap (unit 0)
        if (this.heightmap) {
            this.gl.activeTexture(this.gl.TEXTURE0);
            this.gl.bindTexture(this.gl.TEXTURE_2D, this.heightmap);
            this.gl.uniform1i(this.uniforms.uHeightmap, 0);
            this.gl.uniform1i(this.uniforms.uHasHeightmap, 1);
        }

        // Bind terrain samplers so they don't implicitly sample the heightmap.
        // Keep units within 0..15 (WebGL2 guarantees at least 16 texture units).
        const gl = this.gl;
        const bind2D = (unit, tex, uniformLoc) => {
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            if (uniformLoc) gl.uniform1i(uniformLoc, unit);
        };

        // Keep texture units well under WebGL2's guaranteed minimum (16).
        // Unit 0 is reserved for heightmap.
        bind2D(1, this.textures.blendMask, this.uniforms.uBlendMask);
        bind2D(2, this.textures.layer1, this.uniforms.uLayer1Map);
        bind2D(3, this.textures.layer2, this.uniforms.uLayer2Map);
        bind2D(4, this.textures.layer3, this.uniforms.uLayer3Map);
        bind2D(5, this.textures.layer4, this.uniforms.uLayer4Map);
        
        // Render mesh
        // Depth-bias the terrain slightly so it doesn't z-fight with roads/buildings that sit near the ground.
        // This helps when using a coarse heightmap under detailed city meshes.
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(1.0, 1.0);
        this.mesh.render();
        gl.disable(gl.POLYGON_OFFSET_FILL);
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
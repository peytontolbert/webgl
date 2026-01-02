import { glMatrix } from './glmatrix.js';
import { ShaderProgram } from './shader_program.js';
import { TextureManager } from './texture_manager.js';
import { TerrainMesh } from './terrain_mesh.js';
import { fetchBlob, fetchJSON } from './asset_fetcher.js';

// Deferred terrain shaders (bundled by Vite as raw strings to avoid runtime fetch/404->HTML fallback).
import deferredTerrainVS from './shaders/terrain.vert?raw';
import deferredTerrainFS from './shaders/terrain.frag?raw';
import deferredCommonGLSL from './shaders/common.glsl?raw';
import deferredShadowGLSL from './shaders/shadowmap.glsl?raw';

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
        this.gbufferProgram = new ShaderProgram(gl);
        this.compositeProgram = new ShaderProgram(gl);
        this.shadowProgram = new ShaderProgram(gl);
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

        // Deferred / CodeWalker-like shader path (js/shaders/*). Best-effort: falls back to forward shaders.
        this.useDeferredTerrain = true;
        this._deferredReady = false;
        this._deferredUniforms = null;
        this._compositeUniforms = null;
        this._fsVao = null;
        this._gbuffer = { fbo: null, depth: null, w: 0, h: 0, texDiffuse: null, texNormal: null, texSpec: null, texIrr: null };

        // Shadow map resources (directional, single map for now).
        this.enableDeferredShadows = true;
        this._shadow = {
            size: 2048,
            fbo: null,
            depthTex: null,
            lightView: glMatrix.mat4.create(),
            lightProj: glMatrix.mat4.create(),
            // cached bounds in light-space for debugging
            _last: null,
            uniforms: null,
        };
        this._ubos = {
            scene: null,
            shadow: null,
            entity: null,
            model: null,
            geom: null,
        };
        // Dummy textures for required samplers (shadow map / tint palette etc.)
        this._dummyBlack = null;
        this._dummyWhite = null;
        
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

            // Try to init the CodeWalker-like shader path (js/shaders/*) after forward shaders are available.
            // If anything fails, we keep the forward path.
            try {
                await this._initDeferredShaders();
            } catch (e) {
                console.warn('Deferred terrain shader path unavailable; using forward terrain shaders.', e);
                this._deferredReady = false;
            }
        } catch (error) {
            console.error('Failed to initialize shader program:', error);
        }
    }

    _ensureDummyTextures() {
        if (!this._dummyBlack) this._dummyBlack = this._createSolidTextureRGBA([0, 0, 0, 255]);
        if (!this._dummyWhite) this._dummyWhite = this._createSolidTextureRGBA([255, 255, 255, 255]);
    }

    async _initDeferredShaders() {
        const gl = this.gl;
        const isWebGL2 = (typeof WebGL2RenderingContext !== 'undefined') && (gl instanceof WebGL2RenderingContext);
        if (!isWebGL2) return;
        if (!this.useDeferredTerrain) return;

        const vsRaw = String(deferredTerrainVS ?? '');
        const fsRaw = String(deferredTerrainFS ?? '');
        const common = String(deferredCommonGLSL ?? '');
        const shadowmap = String(deferredShadowGLSL ?? '');

        const includeMap = {
            'common.glsl': common,
            'shadowmap.glsl': shadowmap,
        };
        const includeLoader = (name) => includeMap[String(name || '').trim()] ?? null;

        const vs = await ShaderProgram.preprocessIncludes(vsRaw, includeLoader);
        const fs = await ShaderProgram.preprocessIncludes(fsRaw, includeLoader);

        const ok = await this.gbufferProgram.createProgram(vs, fs);
        if (!ok) throw new Error('gbufferProgram.createProgram failed');

        // Bind uniform blocks to fixed binding points (like constant buffer slots).
        const prog = this.gbufferProgram.program;
        const bindBlock = (blockName, bindingPoint) => {
            const idx = gl.getUniformBlockIndex(prog, blockName);
            if (idx === gl.INVALID_INDEX || idx === 0xFFFFFFFF) return false;
            gl.uniformBlockBinding(prog, idx, bindingPoint);
            return true;
        };
        bindBlock('SceneVars', 0);
        bindBlock('ShadowmapVars', 1);
        bindBlock('EntityVars', 2);
        bindBlock('ModelVars', 3);
        bindBlock('GeomVars', 4);

        // Allocate UBOs (std140). Sizes are fixed from the shader layouts.
        const makeUbo = (byteSize, bindingPoint) => {
            const b = gl.createBuffer();
            gl.bindBuffer(gl.UNIFORM_BUFFER, b);
            gl.bufferData(gl.UNIFORM_BUFFER, byteSize, gl.DYNAMIC_DRAW);
            gl.bindBufferBase(gl.UNIFORM_BUFFER, bindingPoint, b);
            return b;
        };
        this._ubos.scene = makeUbo(224, 0);   // SceneVars
        this._ubos.shadow = makeUbo(256, 1);  // ShadowmapVars (std140 padded)
        this._ubos.entity = makeUbo(80, 2);   // EntityVars
        this._ubos.model = makeUbo(64, 3);    // ModelVars
        this._ubos.geom = makeUbo(16, 4);     // GeomVars

        // Cache uniform locations for samplers/flags.
        const U = (n) => gl.getUniformLocation(prog, n);
        this._deferredUniforms = {
            uHeightmap: U('uHeightmap'),
            uHasHeightmap: U('uHasHeightmap'),
            uTintPalette: U('uTintPalette'),
            uShadowMap: U('uShadowMap'),

            uColorMap0: U('uColorMap0'),
            uColorMap1: U('uColorMap1'),
            uColorMap2: U('uColorMap2'),
            uColorMap3: U('uColorMap3'),
            uColorMap4: U('uColorMap4'),
            uBlendMask: U('uBlendMask'),
            uNormalMap0: U('uNormalMap0'),
            uNormalMap1: U('uNormalMap1'),
            uNormalMap2: U('uNormalMap2'),
            uNormalMap3: U('uNormalMap3'),
            uNormalMap4: U('uNormalMap4'),

            uEnableTexture0: U('uEnableTexture0'),
            uEnableTexture1: U('uEnableTexture1'),
            uEnableTexture2: U('uEnableTexture2'),
            uEnableTexture3: U('uEnableTexture3'),
            uEnableTexture4: U('uEnableTexture4'),
            uEnableTextureMask: U('uEnableTextureMask'),
            uEnableNormalMap: U('uEnableNormalMap'),
            uEnableVertexColour: U('uEnableVertexColour'),

            uSpecularIntensity: U('uSpecularIntensity'),
            uSpecularPower: U('uSpecularPower'),
        };

        // Composite program (fullscreen triangle). Diffuse * irradiance.
        const compVs = `#version 300 es
out vec2 vUv;
void main() {
    vec2 p;
    if (gl_VertexID == 0) p = vec2(-1.0, -1.0);
    else if (gl_VertexID == 1) p = vec2(3.0, -1.0);
    else p = vec2(-1.0, 3.0);
    vUv = p * 0.5 + 0.5;
    gl_Position = vec4(p, 0.0, 1.0);
}`;
        const compFs = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uDiffuseTex;
uniform sampler2D uIrradianceTex;
out vec4 fragColor;
void main() {
    vec4 d = texture(uDiffuseTex, vUv);
    vec4 irr = texture(uIrradianceTex, vUv);
    fragColor = vec4(d.rgb * irr.rgb, d.a);
}`;
        const ok2 = await this.compositeProgram.createProgram(compVs, compFs);
        if (!ok2) throw new Error('compositeProgram.createProgram failed');
        this._compositeUniforms = {
            uDiffuseTex: gl.getUniformLocation(this.compositeProgram.program, 'uDiffuseTex'),
            uIrradianceTex: gl.getUniformLocation(this.compositeProgram.program, 'uIrradianceTex'),
        };

        // Shadow depth program (renders terrain depth into a depth texture from light POV).
        // This is intentionally small/specialized; future parity work can generalize this into a shared shadow pass.
        const shVs = `#version 300 es
precision highp float;
in vec3 aPosition;

uniform mat4 uModelMatrix;
uniform mat4 uLightViewMatrix;
uniform mat4 uLightProjMatrix;
uniform vec3 uTerrainBounds;
uniform vec3 uTerrainSize;
uniform sampler2D uHeightmap;
uniform bool uHasHeightmap;

void main() {
    vec3 worldPos;
    if (uHasHeightmap) {
        vec2 gridPos = aPosition.xy;
        worldPos.x = uTerrainBounds.x + gridPos.x * uTerrainSize.x;
        worldPos.y = uTerrainBounds.y + gridPos.y * uTerrainSize.y;
        vec2 heightmapCoord = vec2(gridPos.x, 1.0 - gridPos.y);
        float height = texture(uHeightmap, heightmapCoord).r;
        worldPos.z = uTerrainBounds.z + height * uTerrainSize.z;
    } else {
        worldPos = aPosition;
    }
    vec4 p = uModelMatrix * vec4(worldPos, 1.0);
    gl_Position = uLightProjMatrix * uLightViewMatrix * p;
}`;
        const shFs = `#version 300 es
precision highp float;
void main() { }
`;
        const ok3 = await this.shadowProgram.createProgram(shVs, shFs);
        if (!ok3) throw new Error('shadowProgram.createProgram failed');
        this._shadow.uniforms = {
            uModelMatrix: gl.getUniformLocation(this.shadowProgram.program, 'uModelMatrix'),
            uLightViewMatrix: gl.getUniformLocation(this.shadowProgram.program, 'uLightViewMatrix'),
            uLightProjMatrix: gl.getUniformLocation(this.shadowProgram.program, 'uLightProjMatrix'),
            uTerrainBounds: gl.getUniformLocation(this.shadowProgram.program, 'uTerrainBounds'),
            uTerrainSize: gl.getUniformLocation(this.shadowProgram.program, 'uTerrainSize'),
            uHeightmap: gl.getUniformLocation(this.shadowProgram.program, 'uHeightmap'),
            uHasHeightmap: gl.getUniformLocation(this.shadowProgram.program, 'uHasHeightmap'),
        };

        // WebGL2 requires a VAO bound for drawArrays in core profile.
        this._fsVao = gl.createVertexArray();

        this._ensureDummyTextures();
        this._deferredReady = true;
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
            this.mesh = new TerrainMesh(this.gl);
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
        if (!this.mesh) return;

        // Prefer deferred shader path when available (WebGL2 only); fall back to forward shader path.
        if (this._deferredReady) {
            this._renderDeferred(viewProjectionMatrix);
            return;
        }

        if (!this.uniforms) return;
        
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
        this.mesh.render(this.program);
        gl.disable(gl.POLYGON_OFFSET_FILL);
    }

    _ensureGBuffer(w, h) {
        const gl = this.gl;
        const isWebGL2 = (typeof WebGL2RenderingContext !== 'undefined') && (gl instanceof WebGL2RenderingContext);
        if (!isWebGL2) return false;
        if (this._gbuffer.fbo && this._gbuffer.w === w && this._gbuffer.h === h) return true;

        // Dispose old
        const delTex = (t) => { try { if (t) gl.deleteTexture(t); } catch { /* ignore */ } };
        delTex(this._gbuffer.texDiffuse);
        delTex(this._gbuffer.texNormal);
        delTex(this._gbuffer.texSpec);
        delTex(this._gbuffer.texIrr);
        if (this._gbuffer.depth) { try { gl.deleteRenderbuffer(this._gbuffer.depth); } catch { /* ignore */ } }
        if (this._gbuffer.fbo) { try { gl.deleteFramebuffer(this._gbuffer.fbo); } catch { /* ignore */ } }

        const makeColorTex = () => {
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            return t;
        };

        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);

        const texDiffuse = makeColorTex();
        const texNormal = makeColorTex();
        const texSpec = makeColorTex();
        const texIrr = makeColorTex();
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texDiffuse, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texNormal, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, texSpec, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT3, gl.TEXTURE_2D, texIrr, 0);

        const depth = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);

        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3]);

        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            console.warn('G-buffer framebuffer incomplete:', status);
            try { gl.deleteFramebuffer(fbo); } catch { /* ignore */ }
            return false;
        }

        this._gbuffer = { fbo, depth, w, h, texDiffuse, texNormal, texSpec, texIrr };
        return true;
    }

    _ensureShadowMap(size) {
        const gl = this.gl;
        const isWebGL2 = (typeof WebGL2RenderingContext !== 'undefined') && (gl instanceof WebGL2RenderingContext);
        if (!isWebGL2) return false;
        const s = (size | 0) || 2048;
        if (this._shadow.fbo && this._shadow.depthTex && this._shadow.size === s) return true;

        try {
            if (this._shadow.depthTex) gl.deleteTexture(this._shadow.depthTex);
        } catch { /* ignore */ }
        try {
            if (this._shadow.fbo) gl.deleteFramebuffer(this._shadow.fbo);
        } catch { /* ignore */ }

        const depthTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, depthTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        // Depth texture (WebGL2 core).
        // Use DEPTH_COMPONENT16 for broad WebGL2 compatibility.
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT16, s, s, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT, null);
        gl.bindTexture(gl.TEXTURE_2D, null);

        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTex, 0);
        gl.drawBuffers([gl.NONE]);
        gl.readBuffer(gl.NONE);

        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            console.warn('Shadow framebuffer incomplete:', status);
            try { gl.deleteFramebuffer(fbo); } catch { /* ignore */ }
            try { gl.deleteTexture(depthTex); } catch { /* ignore */ }
            return false;
        }

        this._shadow.fbo = fbo;
        this._shadow.depthTex = depthTex;
        this._shadow.size = s;
        return true;
    }

    _computeDirectionalLightMatrices(lightDir) {
        // Build a tight ortho around the terrain AABB in *model space* (whatever modelMatrix encodes),
        // so the shadow map aligns with the same coordinate space used in the deferred shaders.
        const gl = this.gl;
        void gl; // keep linter quiet if gl isn't used in some environments

        const ld = glMatrix.vec3.create();
        glMatrix.vec3.set(ld, lightDir?.[0] ?? 0.5, lightDir?.[1] ?? 0.8, lightDir?.[2] ?? 0.3);
        glMatrix.vec3.normalize(ld, ld);

        const b = this.terrainBounds || [0, 0, 0];
        const s = this.terrainSize || [0, 0, 0];
        const minW = [b[0], b[1], b[2]];
        const maxW = [b[0] + s[0], b[1] + s[1], b[2] + s[2]];

        // 8 corners (world coords), then transform by modelMatrix into shader space.
        const corners = [
            [minW[0], minW[1], minW[2]], [maxW[0], minW[1], minW[2]],
            [minW[0], maxW[1], minW[2]], [maxW[0], maxW[1], minW[2]],
            [minW[0], minW[1], maxW[2]], [maxW[0], minW[1], maxW[2]],
            [minW[0], maxW[1], maxW[2]], [maxW[0], maxW[1], maxW[2]],
        ];
        const tmp4 = glMatrix.vec4.create();
        const pts = corners.map((c) => {
            glMatrix.vec4.set(tmp4, c[0], c[1], c[2], 1.0);
            glMatrix.vec4.transformMat4(tmp4, tmp4, this.modelMatrix);
            return [tmp4[0], tmp4[1], tmp4[2]];
        });

        // Center in shader/model space.
        const center = [0, 0, 0];
        for (const p of pts) { center[0] += p[0]; center[1] += p[1]; center[2] += p[2]; }
        center[0] /= pts.length; center[1] /= pts.length; center[2] /= pts.length;

        // Choose a stable up vector.
        const up = [0, 0, 1];
        const dotUp = Math.abs(ld[0] * up[0] + ld[1] * up[1] + ld[2] * up[2]);
        const up2 = (dotUp > 0.98) ? [0, 1, 0] : up;

        // Place eye back along light dir far enough to see the whole AABB.
        let radius = 1.0;
        for (const p of pts) {
            const dx = p[0] - center[0], dy = p[1] - center[1], dz = p[2] - center[2];
            radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz));
        }
        const dist = radius * 2.0 + 10.0;
        const eye = [center[0] - ld[0] * dist, center[1] - ld[1] * dist, center[2] - ld[2] * dist];

        glMatrix.mat4.lookAt(this._shadow.lightView, eye, center, up2);

        // Fit ortho bounds in light-view space.
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        const v4 = glMatrix.vec4.create();
        for (const p of pts) {
            glMatrix.vec4.set(v4, p[0], p[1], p[2], 1.0);
            glMatrix.vec4.transformMat4(v4, v4, this._shadow.lightView);
            minX = Math.min(minX, v4[0]); maxX = Math.max(maxX, v4[0]);
            minY = Math.min(minY, v4[1]); maxY = Math.max(maxY, v4[1]);
            minZ = Math.min(minZ, v4[2]); maxZ = Math.max(maxZ, v4[2]);
        }

        // Convert view-space z range (likely negative) into ortho near/far distances.
        const pad = radius * 0.05 + 5.0;
        const near = Math.max(0.1, -maxZ - pad);
        const far = Math.max(near + 1.0, -minZ + pad);
        glMatrix.mat4.ortho(this._shadow.lightProj, minX - pad, maxX + pad, minY - pad, maxY + pad, near, far);

        this._shadow._last = { minX, maxX, minY, maxY, minZ, maxZ, near, far, radius };
    }

    _renderShadowMap(lightDir) {
        const gl = this.gl;
        const isWebGL2 = (typeof WebGL2RenderingContext !== 'undefined') && (gl instanceof WebGL2RenderingContext);
        if (!isWebGL2) return false;
        if (!this.enableDeferredShadows) return false;
        if (!this.shadowProgram?.program || !this._shadow.uniforms) return false;
        if (!this.mesh) return false;
        if (!this._ensureShadowMap(this._shadow.size)) return false;

        // Compute matrices for this frame.
        this._computeDirectionalLightMatrices(lightDir);

        gl.bindFramebuffer(gl.FRAMEBUFFER, this._shadow.fbo);
        gl.viewport(0, 0, this._shadow.size, this._shadow.size);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.clearDepth(1.0);
        gl.clear(gl.DEPTH_BUFFER_BIT);

        // Render depth.
        this.shadowProgram.use();
        const U = this._shadow.uniforms;
        if (U.uModelMatrix) gl.uniformMatrix4fv(U.uModelMatrix, false, this.modelMatrix);
        if (U.uLightViewMatrix) gl.uniformMatrix4fv(U.uLightViewMatrix, false, this._shadow.lightView);
        if (U.uLightProjMatrix) gl.uniformMatrix4fv(U.uLightProjMatrix, false, this._shadow.lightProj);
        if (U.uTerrainBounds) gl.uniform3fv(U.uTerrainBounds, this.terrainBounds);
        if (U.uTerrainSize) gl.uniform3fv(U.uTerrainSize, this.terrainSize);

        // Heightmap on unit 0
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.heightmap || null);
        if (U.uHeightmap) gl.uniform1i(U.uHeightmap, 0);
        if (U.uHasHeightmap) gl.uniform1i(U.uHasHeightmap, this.heightmap ? 1 : 0);

        // Slight offset reduces shadow acne on the terrain.
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(2.0, 4.0);
        this.mesh.render(this.shadowProgram);
        gl.disable(gl.POLYGON_OFFSET_FILL);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return true;
    }

    _updateUbo(buffer, arrayBuffer) {
        const gl = this.gl;
        gl.bindBuffer(gl.UNIFORM_BUFFER, buffer);
        gl.bufferSubData(gl.UNIFORM_BUFFER, 0, arrayBuffer);
    }

    _renderDeferred(viewProjectionMatrix) {
        const gl = this.gl;
        const isWebGL2 = (typeof WebGL2RenderingContext !== 'undefined') && (gl instanceof WebGL2RenderingContext);
        if (!isWebGL2) return;
        if (!this._deferredReady || !this._deferredUniforms) return;

        const w = gl.drawingBufferWidth | 0;
        const h = gl.drawingBufferHeight | 0;
        if (!this._ensureGBuffer(w, h)) return;

        // Ensure we always have sane fallbacks so samplers never default to unit 0 (heightmap).
        this._ensureTerrainTextureFallbacks();
        this._ensureDummyTextures();

        // Optional shadow map update (before UBO upload so we can fill matrices + bind the real shadow texture).
        const lightDir = [0.5, 0.8, 0.3];
        const shadowOk = this._renderShadowMap(lightDir);

        // Update matrices
        glMatrix.mat3.normalFromMat4(this.normalMatrix, this.modelMatrix);

        // --- Update UBOs (std140) ---
        // SceneVars (224 bytes)
        {
            const buf = new ArrayBuffer(224);
            const f32 = new Float32Array(buf);
            // mat4 uViewProjectionMatrix
            f32.set(viewProjectionMatrix, 0);
            // mat4 uModelMatrix
            f32.set(this.modelMatrix, 16);
            // mat3 uNormalMatrix (std140: 3 vec4 columns = 12 floats)
            // Put 3x3 into 3 vec4s.
            f32[32] = this.normalMatrix[0];  f32[33] = this.normalMatrix[1];  f32[34] = this.normalMatrix[2];  f32[35] = 0;
            f32[36] = this.normalMatrix[3];  f32[37] = this.normalMatrix[4];  f32[38] = this.normalMatrix[5];  f32[39] = 0;
            f32[40] = this.normalMatrix[6];  f32[41] = this.normalMatrix[7];  f32[42] = this.normalMatrix[8];  f32[43] = 0;
            // vec3 uTerrainBounds (padded)
            f32[44] = this.terrainBounds[0] ?? 0;
            f32[45] = this.terrainBounds[1] ?? 0;
            f32[46] = this.terrainBounds[2] ?? 0;
            f32[47] = 0;
            // vec3 uTerrainSize (padded)
            f32[48] = this.terrainSize[0] ?? 0;
            f32[49] = this.terrainSize[1] ?? 0;
            f32[50] = this.terrainSize[2] ?? 0;
            f32[51] = 0;
            // float uTime (plus padding)
            f32[52] = (performance.now() * 0.001) || 0;
            this._updateUbo(this._ubos.scene, buf);
        }

        // ShadowmapVars (256 bytes) - fill light params; enable shadows if shadow map is available.
        {
            const buf = new ArrayBuffer(256);
            const dv = new DataView(buf);
            const setF = (byteOff, v) => dv.setFloat32(byteOff, Number(v) || 0, true);
            const setU = (byteOff, v) => dv.setUint32(byteOff, (Number(v) >>> 0), true);

            // vec3 uLightDir (16 bytes)
            const ld = lightDir;
            setF(0, ld[0]); setF(4, ld[1]); setF(8, ld[2]); setF(12, 0);
            // vec3 uLightColor (16 bytes)
            setF(16, 1.0); setF(20, 1.0); setF(24, 1.0); setF(28, 0);
            // float uAmbientIntensity at offset 32
            setF(32, 0.7);
            const f32 = new Float32Array(buf);
            // mat4 uLightViewMatrix at byte offset 48 (float idx 12)
            f32.set(shadowOk ? this._shadow.lightView : glMatrix.mat4.create(), 12);
            // mat4 uLightProjMatrix at byte offset 112 (float idx 28)
            f32.set(shadowOk ? this._shadow.lightProj : glMatrix.mat4.create(), 28);
            // cascade vec4s remain 0
            // shadow params
            setF(240, 0.0008); // bias
            setF(244, 1.0);   // strength
            setF(248, shadowOk ? 1.25 : 0.0);   // softness (texel radius)
            setU(252, shadowOk ? 1 : 0);        // uEnableShadows

            this._updateUbo(this._ubos.shadow, buf);
        }

        // EntityVars (80 bytes)
        {
            const buf = new ArrayBuffer(80);
            const dv = new DataView(buf);
            const setF = (o, v) => dv.setFloat32(o, Number(v) || 0, true);
            const setU = (o, v) => dv.setUint32(o, (Number(v) >>> 0), true);
            // uCamRel vec4 (terrain uses camera-space via uTransform; keep 0)
            setF(0, 0); setF(4, 0); setF(8, 0); setF(12, 0);
            // uOrientation vec4 (identity)
            setF(16, 0); setF(20, 0); setF(24, 0); setF(28, 1);
            // uHasSkeleton, uHasTransforms, uTintPaletteIndex, uPad1
            setU(32, 0);
            setU(36, 1);
            setU(40, 0);
            setU(44, 0);
            // uScale vec3 padded
            setF(48, 1); setF(52, 1); setF(56, 1); setF(60, 0);
            // uPad2
            setU(64, 0);
            this._updateUbo(this._ubos.entity, buf);
        }

        // ModelVars (64 bytes): uTransform = modelMatrix
        {
            const buf = new ArrayBuffer(64);
            new Float32Array(buf).set(this.modelMatrix, 0);
            this._updateUbo(this._ubos.model, buf);
        }

        // GeomVars (16 bytes)
        {
            const buf = new ArrayBuffer(16);
            const dv = new DataView(buf);
            dv.setUint32(0, 0, true);          // uEnableTint
            dv.setFloat32(4, 0.0, true);       // uTintYVal
            dv.setUint32(8, 0, true);
            dv.setUint32(12, 0, true);
            this._updateUbo(this._ubos.geom, buf);
        }

        // --- G-buffer pass ---
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._gbuffer.fbo);
        gl.viewport(0, 0, w, h);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        this.gbufferProgram.use();

        // Samplers: keep units within WebGL2 guaranteed minimum (16).
        const U = this._deferredUniforms;
        const bind2D = (unit, tex, loc) => {
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            if (loc) gl.uniform1i(loc, unit);
        };

        // Unit 0: heightmap
        bind2D(0, this.heightmap || this._dummyBlack, U.uHeightmap);
        if (U.uHasHeightmap) gl.uniform1i(U.uHasHeightmap, this.heightmap ? 1 : 0);

        // Unit 1: blend mask
        bind2D(1, this.textures.blendMask || this._dummyWhite, U.uBlendMask);

        // Units 2..5: color maps (layer1..4)
        bind2D(2, this.textures.layer1 || this._dummyWhite, U.uColorMap0);
        bind2D(3, this.textures.layer2 || this._dummyWhite, U.uColorMap1);
        bind2D(4, this.textures.layer3 || this._dummyWhite, U.uColorMap2);
        bind2D(5, this.textures.layer4 || this._dummyWhite, U.uColorMap3);
        // Optional fifth slot (unused)
        bind2D(6, this._dummyWhite, U.uColorMap4);

        // Normal maps (unused by default)
        bind2D(7, this._dummyWhite, U.uNormalMap0);
        bind2D(8, this._dummyWhite, U.uNormalMap1);
        bind2D(9, this._dummyWhite, U.uNormalMap2);
        bind2D(10, this._dummyWhite, U.uNormalMap3);
        bind2D(11, this._dummyWhite, U.uNormalMap4);

        // Tint palette required by includes; shadow map is real if available
        bind2D(12, this._dummyWhite, U.uTintPalette);
        bind2D(13, (shadowOk && this._shadow.depthTex) ? this._shadow.depthTex : this._dummyWhite, U.uShadowMap);

        // Flags
        if (U.uEnableTexture0) gl.uniform1i(U.uEnableTexture0, 1);
        if (U.uEnableTexture1) gl.uniform1i(U.uEnableTexture1, 1);
        if (U.uEnableTexture2) gl.uniform1i(U.uEnableTexture2, 1);
        if (U.uEnableTexture3) gl.uniform1i(U.uEnableTexture3, 1);
        if (U.uEnableTexture4) gl.uniform1i(U.uEnableTexture4, 0);
        if (U.uEnableTextureMask) gl.uniform1i(U.uEnableTextureMask, 1);
        if (U.uEnableNormalMap) gl.uniform1i(U.uEnableNormalMap, 0);
        if (U.uEnableVertexColour) gl.uniform1i(U.uEnableVertexColour, 0);
        if (U.uSpecularIntensity) gl.uniform1f(U.uSpecularIntensity, 0.15);
        if (U.uSpecularPower) gl.uniform1f(U.uSpecularPower, 16.0);

        // Depth-bias terrain slightly to reduce z-fighting.
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(1.0, 1.0);
        this.mesh.render(this.gbufferProgram);
        gl.disable(gl.POLYGON_OFFSET_FILL);

        // Copy terrain depth into default framebuffer so subsequent passes (models/buildings) can depth-test.
        try {
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._gbuffer.fbo);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
            gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
        } catch {
            // ignore
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        // --- Composite to screen ---
        gl.viewport(0, 0, w, h);
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(false);

        this.compositeProgram.use();
        gl.bindVertexArray(this._fsVao);
        bind2D(0, this._gbuffer.texDiffuse, this._compositeUniforms?.uDiffuseTex);
        bind2D(1, this._gbuffer.texIrr, this._compositeUniforms?.uIrradianceTex);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
        gl.depthMask(true);
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
        if (this.gbufferProgram) {
            this.gbufferProgram.dispose();
        }
        if (this.compositeProgram) {
            this.compositeProgram.dispose();
        }
        if (this.shadowProgram) {
            this.shadowProgram.dispose();
        }
        // Shadow map resources
        try { if (this._shadow?.depthTex) this.gl.deleteTexture(this._shadow.depthTex); } catch { /* ignore */ }
        try { if (this._shadow?.fbo) this.gl.deleteFramebuffer(this._shadow.fbo); } catch { /* ignore */ }
    }
} 
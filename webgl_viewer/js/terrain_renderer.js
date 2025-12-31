// Import gl-matrix
import * as glMatrix from 'gl-matrix';
import { ShaderProgram } from './shader_program.js';
import { TerrainMesh } from './terrain_mesh.js';

// Vertex shader: derive Z from heightmap (if present) and output a normalized height value for coloring.
const vsSource = `#version 300 es
    in vec3 aPosition;
    in vec3 aNormal;
    in vec2 aTexcoord;

    uniform mat4 uViewProjectionMatrix;
    uniform mat4 uModelMatrix;
    uniform mat3 uNormalMatrix;
    uniform vec3 uTerrainBounds;  // (min_x, min_y, min_z)
    uniform vec3 uTerrainSize;    // (size_x, size_y, size_z)
    uniform sampler2D uHeightmap;
    uniform bool uHasHeightmap;

    out vec3 vNormal;
    out vec2 vTexcoord;
    out float vHeight01;

    void main() {
        vec3 worldPos = aPosition;
        vec3 normalWs = normalize(uNormalMatrix * aNormal);
        float height01 = 0.0;

        if (uHasHeightmap) {
            float u = (aPosition.x - uTerrainBounds.x) / max(uTerrainSize.x, 0.0001);
            float v = (aPosition.y - uTerrainBounds.y) / max(uTerrainSize.y, 0.0001);
            vec2 uv = vec2(u, 1.0 - v); // flip Y for image space

            height01 = texture(uHeightmap, uv).r;
            // NOTE: sampling from an R8 texture returns a normalized value in [0..1],
            // so the correct world-space scale is the full Z extent (not /255).
            float heightScale = uTerrainSize.z;
            worldPos.z = uTerrainBounds.z + height01 * heightScale;

            // Approx normal from heightmap (central differences).
            ivec2 ts = textureSize(uHeightmap, 0);
            vec2 texel = 1.0 / vec2(float(ts.x), float(ts.y));
            float left01 = texture(uHeightmap, uv - vec2(texel.x, 0.0)).r;
            float right01 = texture(uHeightmap, uv + vec2(texel.x, 0.0)).r;
            float top01 = texture(uHeightmap, uv - vec2(0.0, texel.y)).r;
            float bottom01 = texture(uHeightmap, uv + vec2(0.0, texel.y)).r;

            float dx = uTerrainSize.x / max(float(ts.x - 1), 1.0);
            float dy = uTerrainSize.y / max(float(ts.y - 1), 1.0);
            float dhdx = ((left01 - right01) * heightScale) / max(dx, 0.0001);
            float dhdy = ((top01 - bottom01) * heightScale) / max(dy, 0.0001);
            vec3 n = normalize(vec3(dhdx, dhdy, 1.0));
            normalWs = normalize(uNormalMatrix * n);
        }

        vec4 modelPos = uModelMatrix * vec4(worldPos, 1.0);
        gl_Position = uViewProjectionMatrix * modelPos;

        vNormal = normalWs;
        vTexcoord = aTexcoord;
        vHeight01 = height01;
    }
`;

// Fragment shader: always produces a visible terrain using height-based coloring.
// Optionally modulates with a diffuse texture if one is provided.
const fsSource = `#version 300 es
    precision mediump float;

    in vec3 vNormal;
    in vec2 vTexcoord;
    in float vHeight01;

    uniform vec3 uLightDir;
    uniform vec3 uLightColor;
    uniform float uAmbientIntensity;

    uniform sampler2D uDiffuseMap;
    uniform bool uHasDiffuseMap;

    out vec4 fragColor;

    vec3 heightColor(float h) {
        // Simple palette: sand -> grass -> rock -> snow
        vec3 sand = vec3(0.76, 0.70, 0.50);
        vec3 grass = vec3(0.20, 0.45, 0.20);
        vec3 rock = vec3(0.45, 0.45, 0.48);
        vec3 snow = vec3(0.92, 0.92, 0.95);

        vec3 c = mix(sand, grass, smoothstep(0.05, 0.25, h));
        c = mix(c, rock, smoothstep(0.35, 0.65, h));
        c = mix(c, snow, smoothstep(0.78, 0.95, h));
        return c;
    }

    void main() {
        vec3 n = normalize(vNormal);
        float ndotl = max(dot(n, normalize(uLightDir)), 0.0);
        vec3 lighting = uAmbientIntensity * uLightColor + ndotl * uLightColor;

        vec3 base = heightColor(vHeight01);
        if (uHasDiffuseMap) {
            vec3 tex = texture(uDiffuseMap, vTexcoord).rgb;
            base *= tex;
        }

        vec3 color = base * lighting;
        color = pow(color, vec3(1.0 / 2.2)); // gamma
        fragColor = vec4(color, 1.0);
    }
`;

export class TerrainRenderer {
    constructor(gl) {
        this.gl = gl;
        this.program = new ShaderProgram(gl);
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
        
        // Initialize model matrix to match GTA5's coordinate system.
        // Important: GTA data is Z-up. Our camera uses Y-up, so we rotate around X by -90deg
        // so +Z becomes +Y (up), not -Y (which makes the world appear upside down).
        glMatrix.mat4.rotateY(this.modelMatrix, this.modelMatrix, Math.PI);
        glMatrix.mat4.rotateX(this.modelMatrix, this.modelMatrix, -Math.PI / 2);
        
        this.initShaders();
    }
    
    async initShaders() {
        try {
            const ok = await this.program.createProgram(vsSource, fsSource);
            if (!ok || !this.program.program) {
                throw new Error('Shader program creation failed (see earlier shader logs)');
            }
            
            // Set up uniforms
            this.uniforms = {
                uViewProjectionMatrix: this.gl.getUniformLocation(this.program.program, 'uViewProjectionMatrix'),
                uModelMatrix: this.gl.getUniformLocation(this.program.program, 'uModelMatrix'),
                uNormalMatrix: this.gl.getUniformLocation(this.program.program, 'uNormalMatrix'),
                uTerrainBounds: this.gl.getUniformLocation(this.program.program, 'uTerrainBounds'),
                uTerrainSize: this.gl.getUniformLocation(this.program.program, 'uTerrainSize'),
                uHeightmap: this.gl.getUniformLocation(this.program.program, 'uHeightmap'),
                uHasHeightmap: this.gl.getUniformLocation(this.program.program, 'uHasHeightmap'),
                uLightDir: this.gl.getUniformLocation(this.program.program, 'uLightDir'),
                uLightColor: this.gl.getUniformLocation(this.program.program, 'uLightColor'),
                uAmbientIntensity: this.gl.getUniformLocation(this.program.program, 'uAmbientIntensity'),

                // Optional diffuse texture
                uDiffuseMap: this.gl.getUniformLocation(this.program.program, 'uDiffuseMap'),
                uHasDiffuseMap: this.gl.getUniformLocation(this.program.program, 'uHasDiffuseMap')
            };
        } catch (error) {
            console.error('Failed to initialize shader program:', error);
        }
    }
    
    async loadTerrainMesh() {
        try {
            let heightmapImage = null;

            // Load heightmap data (optional)
            const heightmapResponse = await fetch('assets/heightmap.png');
            if (!heightmapResponse.ok) {
                console.warn('Heightmap texture not found, terrain will be rendered flat');
            } else {
                const heightmapBlob = await heightmapResponse.blob();
                heightmapImage = await createImageBitmap(heightmapBlob);

                // Create heightmap texture
                this.heightmap = this.gl.createTexture();
                this.gl.bindTexture(this.gl.TEXTURE_2D, this.heightmap);

                // Set texture parameters for heightmap
                this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
                this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
                this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
                this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);

                // Upload heightmap data (ImageBitmap overload)
                this.gl.texImage2D(
                    this.gl.TEXTURE_2D,
                    0,                // mip level
                    this.gl.R8,       // internal format (single channel)
                    this.gl.RED,      // format
                    this.gl.UNSIGNED_BYTE, // type
                    heightmapImage    // source
                );
            }
            
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
            
            // Set terrain bounds and world-space size (NOT grid resolution).
            // The shader derives UVs from world extents and uses textureSize(heightmap) for resolution.
            this.terrainBounds = [bounds.min_x, bounds.min_y, bounds.min_z];
            this.terrainSize = [
                (bounds.max_x - bounds.min_x),
                (bounds.max_y - bounds.min_y),
                (bounds.max_z - bounds.min_z)
            ];
            
            // Determine mesh resolution.
            // Prefer actual heightmap image resolution if present; otherwise fall back to terrain_info.json dimensions.
            const meshWidth = heightmapImage ? heightmapImage.width : firstHeightmap.width;
            const meshHeight = heightmapImage ? heightmapImage.height : firstHeightmap.height;

            // Create mesh (flat Z on CPU; height applied in shader if heightmap exists)
            this.mesh = new TerrainMesh(this.gl, this.program);
            this.mesh.createFromHeightmap(
                meshWidth,
                meshHeight,
                bounds
            );
            
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
            
            // Upload heightmap data (ImageBitmap overload)
            this.gl.texImage2D(
                this.gl.TEXTURE_2D,
                0,                // mip level
                this.gl.R8,       // internal format (single channel)
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
        
        // Set lighting uniforms
        this.gl.uniform3fv(this.uniforms.uLightDir, [0.4, 0.8, 0.35]);
        this.gl.uniform3fv(this.uniforms.uLightColor, [1.0, 1.0, 1.0]);
        this.gl.uniform1f(this.uniforms.uAmbientIntensity, 0.55);
        
        // Bind heightmap (optional)
        if (this.heightmap) {
            this.gl.activeTexture(this.gl.TEXTURE0);
            this.gl.bindTexture(this.gl.TEXTURE_2D, this.heightmap);
            this.gl.uniform1i(this.uniforms.uHeightmap, 0);
            this.gl.uniform1i(this.uniforms.uHasHeightmap, 1);
        } else {
            this.gl.uniform1i(this.uniforms.uHasHeightmap, 0);
        }
        
        // Bind diffuse (optional)
        if (this.textures.diffuse) {
            this.gl.activeTexture(this.gl.TEXTURE1);
            this.gl.bindTexture(this.gl.TEXTURE_2D, this.textures.diffuse);
            this.gl.uniform1i(this.uniforms.uDiffuseMap, 1);
            this.gl.uniform1i(this.uniforms.uHasDiffuseMap, 1);
        } else {
            this.gl.uniform1i(this.uniforms.uHasDiffuseMap, 0);
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
export class TextureManager {
    constructor(gl) {
        this.gl = gl;
        this.textures = new Map();
        this.textureUnits = new Map();
        this.nextTextureUnit = 0;
    }
    
    loadTexture(url, type = 'diffuse') {
        return new Promise((resolve, reject) => {
            const texture = this.gl.createTexture();
            this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
            
            // Set texture parameters
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.REPEAT);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.REPEAT);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR_MIPMAP_LINEAR);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
            
            // Load image
            const image = new Image();
            image.onload = () => {
                this.gl.texImage2D(
                    this.gl.TEXTURE_2D,
                    0,
                    this.gl.RGBA,
                    this.gl.RGBA,
                    this.gl.UNSIGNED_BYTE,
                    image
                );
                this.gl.generateMipmap(this.gl.TEXTURE_2D);
                
                // Store texture
                this.textures.set(type, texture);
                resolve(texture);
            };
            image.onerror = reject;
            image.src = url;
        });
    }
    
    bindTexture(type, unit) {
        const texture = this.textures.get(type);
        if (!texture) return;
        
        this.gl.activeTexture(this.gl.TEXTURE0 + unit);
        this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
    }
    
    bindTextures(shaderProgram) {
        // Bind diffuse map
        this.bindTexture('diffuse', 0);
        shaderProgram.setUniform('uDiffuseMap', 0);
        
        // Bind normal map
        this.bindTexture('normal', 1);
        shaderProgram.setUniform('uNormalMap', 1);
        
        // Bind detail map
        this.bindTexture('detail', 2);
        shaderProgram.setUniform('uDetailMap', 2);
    }
    
    loadTerrainTextures(baseUrl) {
        return Promise.all([
            this.loadTexture(`${baseUrl}/terrain_diffuse.png`, 'diffuse'),
            this.loadTexture(`${baseUrl}/terrain_normal.png`, 'normal'),
            this.loadTexture(`${baseUrl}/terrain_detail.png`, 'detail')
        ]);
    }
    
    async loadTexture(name, url, options = {}) {
        try {
            // Check if texture already exists
            if (this.textures.has(name)) {
                return this.textures.get(name);
            }
            
            // Create texture
            const texture = this.gl.createTexture();
            this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
            
            // Set texture parameters
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, options.wrapS || this.gl.REPEAT);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, options.wrapT || this.gl.REPEAT);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, options.minFilter || this.gl.LINEAR);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, options.magFilter || this.gl.LINEAR);
            
            // Load image
            const image = await this.loadImage(url);
            
            // Upload texture data
            this.gl.texImage2D(
                this.gl.TEXTURE_2D,
                0,
                options.internalFormat || this.gl.RGBA,
                image.width,
                image.height,
                0,
                options.format || this.gl.RGBA,
                options.type || this.gl.UNSIGNED_BYTE,
                image
            );
            
            // Generate mipmaps if requested
            if (options.generateMipmaps !== false) {
                this.gl.generateMipmap(this.gl.TEXTURE_2D);
            }
            
            // Store texture
            this.textures.set(name, texture);
            
            return texture;
            
        } catch (error) {
            console.error(`Error loading texture ${name}:`, error);
            throw error;
        }
    }
    
    loadImage(url) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = reject;
            image.src = url;
        });
    }
    
    dispose() {
        for (const texture of this.textures.values()) {
            this.gl.deleteTexture(texture);
        }
        this.textures.clear();
        this.textureUnits.clear();
        this.nextTextureUnit = 0;
    }
} 
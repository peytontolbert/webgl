export class ShaderProgram {
    constructor(gl) {
        this.gl = gl;
        this.program = null;
        this.attributes = {};
        this.uniforms = {};
    }
    
    async createProgram(vsSource, fsSource) {
        try {
            // Create vertex shader
            const vertexShader = this.gl.createShader(this.gl.VERTEX_SHADER);
            this.gl.shaderSource(vertexShader, vsSource);
            this.gl.compileShader(vertexShader);
            
            // Check vertex shader compilation
            if (!this.gl.getShaderParameter(vertexShader, this.gl.COMPILE_STATUS)) {
                throw new Error('Vertex shader compilation failed: ' + this.gl.getShaderInfoLog(vertexShader));
            }
            
            // Create fragment shader
            const fragmentShader = this.gl.createShader(this.gl.FRAGMENT_SHADER);
            this.gl.shaderSource(fragmentShader, fsSource);
            this.gl.compileShader(fragmentShader);
            
            // Check fragment shader compilation
            if (!this.gl.getShaderParameter(fragmentShader, this.gl.COMPILE_STATUS)) {
                throw new Error('Fragment shader compilation failed: ' + this.gl.getShaderInfoLog(fragmentShader));
            }
            
            // Create program and link shaders
            this.program = this.gl.createProgram();
            this.gl.attachShader(this.program, vertexShader);
            this.gl.attachShader(this.program, fragmentShader);
            
            // Bind attribute locations before linking
            this.gl.bindAttribLocation(this.program, 0, 'aPosition');
            this.gl.bindAttribLocation(this.program, 1, 'aNormal');
            this.gl.bindAttribLocation(this.program, 2, 'aTexcoord');
            
            this.gl.linkProgram(this.program);
            
            // Check program linking
            if (!this.gl.getProgramParameter(this.program, this.gl.LINK_STATUS)) {
                throw new Error('Program linking failed: ' + this.gl.getProgramInfoLog(this.program));
            }
            
            // Store attribute locations
            this.attributes = {
                aPosition: 0,
                aNormal: 1,
                aTexcoord: 2
            };
            
            // Clean up shaders
            this.gl.deleteShader(vertexShader);
            this.gl.deleteShader(fragmentShader);
            
            return true;
            
        } catch (error) {
            console.error('Failed to create shader program:', error);
            return false;
        }
    }
    
    getAttributeLocations() {
        // Get number of active attributes
        const numAttribs = this.gl.getProgramParameter(this.program, this.gl.ACTIVE_ATTRIBUTES);
        
        // Get each attribute location
        for (let i = 0; i < numAttribs; i++) {
            const info = this.gl.getActiveAttrib(this.program, i);
            if (info) {
                this.attributes[info.name] = this.gl.getAttribLocation(this.program, info.name);
            }
        }
    }
    
    getUniformLocation(name) {
        if (!this.uniforms[name]) {
            this.uniforms[name] = this.gl.getUniformLocation(this.program, name);
        }
        return this.uniforms[name];
    }
    
    setUniform(name, value) {
        const location = this.getUniformLocation(name);
        if (location === null) {
            console.warn(`Uniform ${name} not found in shader program`);
            return;
        }
        
        if (value instanceof Float32Array) {
            switch (value.length) {
                case 1:
                    this.gl.uniform1f(location, value[0]);
                    break;
                case 2:
                    this.gl.uniform2f(location, value[0], value[1]);
                    break;
                case 3:
                    this.gl.uniform3f(location, value[0], value[1], value[2]);
                    break;
                case 4:
                    this.gl.uniform4f(location, value[0], value[1], value[2], value[3]);
                    break;
                case 9:
                    this.gl.uniformMatrix3fv(location, false, value);
                    break;
                case 16:
                    this.gl.uniformMatrix4fv(location, false, value);
                    break;
                default:
                    console.warn(`Unsupported uniform array length: ${value.length}`);
            }
        } else {
            this.gl.uniform1i(location, value);
        }
    }
    
    use() {
        this.gl.useProgram(this.program);
    }
    
    dispose() {
        if (this.program) {
            this.gl.deleteProgram(this.program);
            this.program = null;
        }
    }
} 
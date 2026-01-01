export class TerrainMesh {
    constructor(gl, program) {
        this.gl = gl;
        this.program = program;
        this.vao = null;
        this.vertexBuffer = null;
        this.indexBuffer = null;
        this.vertexCount = 0;
        this.indexCount = 0;
        this.indexType = null; // gl.UNSIGNED_SHORT or gl.UNSIGNED_INT
        // 3(pos) + 3(normal) + 2(texcoord) + 2(texcoord1) + 2(texcoord2) + 2(color0) = 14 floats = 56 bytes
        this.vertexStride = 56;
    }

    createFromHeightmap(width, height, bounds) {
        // Generate vertices
        const vertices = [];
        const indices = [];
        const normals = [];
        const texcoords = [];
        const texcoords1 = [];
        const texcoords2 = [];
        const colors = [];

        // Create vertex data
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                // aPosition.xy is expected to be normalized [0..1] in the vertex shader.
                // The shader will expand it to world space using terrain bounds/extents.
                const u = x / (width - 1);
                const v = y / (height - 1);
                const posX = u;
                const posY = v;
                const posZ = 0.0; // Height will be set by shader

                // Add vertex
                vertices.push(posX, posY, posZ);

                // Add UV coordinates
                texcoords.push(u, v);
                texcoords1.push(u * 2, v * 2); // Second UV set for detail textures
                texcoords2.push(u * 4, v * 4); // Third UV set for macro textures

                // Add color (white for now, can be tinted by shader)
                colors.push(1.0, 1.0);
            }
        }

        // Generate indices and calculate normals
        for (let y = 0; y < height - 1; y++) {
            for (let x = 0; x < width - 1; x++) {
                // Get vertex indices
                const v0 = y * width + x;
                const v1 = v0 + 1;
                const v2 = (y + 1) * width + x;
                const v3 = v2 + 1;

                // First triangle
                indices.push(v0, v2, v1);

                // Second triangle
                indices.push(v1, v2, v3);
            }
        }

        // Calculate initial normals (will be updated by shader)
        for (let i = 0; i < vertices.length; i += 3) {
            normals.push(0, 0, 1);
        }

        // Create interleaved vertex buffer
        const vcount = vertices.length / 3;
        const vertexData = new Float32Array(vcount * 14);
        for (let i = 0; i < vcount; i++) {
            const base = i * 14;
            // Position (3)
            vertexData[base + 0] = vertices[i * 3 + 0];
            vertexData[base + 1] = vertices[i * 3 + 1];
            vertexData[base + 2] = vertices[i * 3 + 2];
            // Normal (3)
            vertexData[base + 3] = normals[i * 3 + 0];
            vertexData[base + 4] = normals[i * 3 + 1];
            vertexData[base + 5] = normals[i * 3 + 2];
            // Texcoord0 (2)
            vertexData[base + 6] = texcoords[i * 2 + 0];
            vertexData[base + 7] = texcoords[i * 2 + 1];
            // Texcoord1 (2)
            vertexData[base + 8] = texcoords1[i * 2 + 0];
            vertexData[base + 9] = texcoords1[i * 2 + 1];
            // Texcoord2 (2)
            vertexData[base + 10] = texcoords2[i * 2 + 0];
            vertexData[base + 11] = texcoords2[i * 2 + 1];
            // Color0 (2)
            vertexData[base + 12] = colors[i * 2 + 0];
            vertexData[base + 13] = colors[i * 2 + 1];
        }

        const gl = this.gl;
        const isWebGL2 = (typeof WebGL2RenderingContext !== 'undefined') && (gl instanceof WebGL2RenderingContext);

        // Create vertex buffer
        this.vertexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.STATIC_DRAW);

        // Create index buffer (use 32-bit indices when needed; requires WebGL2)
        const indexArray = (vcount > 65535)
            ? (() => {
                if (!isWebGL2) throw new Error(`TerrainMesh: ${vcount} vertices require WebGL2 (32-bit indices).`);
                this.indexType = gl.UNSIGNED_INT;
                return new Uint32Array(indices);
            })()
            : (() => {
                this.indexType = gl.UNSIGNED_SHORT;
                return new Uint16Array(indices);
            })();

        this.indexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexArray, gl.STATIC_DRAW);

        // Create and configure VAO so other renderers don't clobber attribute state.
        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);

        // Bind buffers while VAO is bound (captures bindings + attrib pointers)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);

        const bindAttrib = (name, size, offsetBytes) => {
            const loc = gl.getAttribLocation(this.program.program, name);
            if (loc === -1) return;
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, size, gl.FLOAT, false, this.vertexStride, offsetBytes);
        };

        bindAttrib('aPosition', 3, 0);
        bindAttrib('aNormal', 3, 12);
        bindAttrib('aTexcoord', 2, 24);
        bindAttrib('aTexcoord1', 2, 32);
        bindAttrib('aTexcoord2', 2, 40);
        bindAttrib('aColor0', 2, 48);

        gl.bindVertexArray(null);

        this.vertexCount = vcount;
        this.indexCount = indices.length;
    }

    render() {
        if (!this.vao || !this.indexBuffer || !this.indexType) return;
        const gl = this.gl;
        gl.bindVertexArray(this.vao);
        gl.drawElements(gl.TRIANGLES, this.indexCount, this.indexType, 0);
        gl.bindVertexArray(null);
    }

    dispose() {
        if (this.vao) {
            this.gl.deleteVertexArray(this.vao);
            this.vao = null;
        }
        if (this.vertexBuffer) {
            this.gl.deleteBuffer(this.vertexBuffer);
            this.vertexBuffer = null;
        }
        if (this.indexBuffer) {
            this.gl.deleteBuffer(this.indexBuffer);
            this.indexBuffer = null;
        }
    }
} 
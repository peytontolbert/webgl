export class TerrainMesh {
    constructor(gl, program) {
        this.gl = gl;
        this.program = program;
        this.vertexBuffer = null;
        this.indexBuffer = null;
        this.vertexCount = 0;
        this.indexCount = 0;
        this.vertexStride = 32; // 3(pos) + 3(normal) + 2(texcoord) + 2(texcoord1) + 2(texcoord2) + 2(color0)
    }

    createFromHeightmap(width, height, bounds) {
        // Calculate step sizes
        const size = [
            bounds.max_x - bounds.min_x,
            bounds.max_y - bounds.min_y,
            bounds.max_z - bounds.min_z
        ];
        const step = [
            size[0] / (width - 1),
            size[1] / (height - 1),
            size[2] / 255.0 // Height values are 0-255
        ];

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
                // Calculate position
                const posX = bounds.min_x + x * step[0];
                const posY = bounds.min_y + y * step[1];
                const posZ = bounds.min_z; // Height will be set by shader

                // Add vertex
                vertices.push(posX, posY, posZ);

                // Add UV coordinates
                const u = x / (width - 1);
                const v = y / (height - 1);
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
        const vertexData = new Float32Array(vertices.length * 8); // 8 components per vertex
        for (let i = 0; i < vertices.length / 3; i++) {
            const base = i * 8;
            // Position
            vertexData[base] = vertices[i * 3];
            vertexData[base + 1] = vertices[i * 3 + 1];
            vertexData[base + 2] = vertices[i * 3 + 2];
            // Normal
            vertexData[base + 3] = normals[i * 3];
            vertexData[base + 4] = normals[i * 3 + 1];
            vertexData[base + 5] = normals[i * 3 + 2];
            // Texcoord
            vertexData[base + 6] = texcoords[i * 2];
            vertexData[base + 7] = texcoords[i * 2 + 1];
        }

        // Create vertex buffer
        this.vertexBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.vertexBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, vertexData, this.gl.STATIC_DRAW);

        // Create index buffer
        this.indexBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
        this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), this.gl.STATIC_DRAW);

        // Set vertex attributes
        const positionLoc = this.gl.getAttribLocation(this.program.program, 'aPosition');
        const normalLoc = this.gl.getAttribLocation(this.program.program, 'aNormal');
        const texcoordLoc = this.gl.getAttribLocation(this.program.program, 'aTexcoord');
        const texcoord1Loc = this.gl.getAttribLocation(this.program.program, 'aTexcoord1');
        const texcoord2Loc = this.gl.getAttribLocation(this.program.program, 'aTexcoord2');
        const color0Loc = this.gl.getAttribLocation(this.program.program, 'aColor0');

        this.gl.enableVertexAttribArray(positionLoc);
        this.gl.enableVertexAttribArray(normalLoc);
        this.gl.enableVertexAttribArray(texcoordLoc);
        this.gl.enableVertexAttribArray(texcoord1Loc);
        this.gl.enableVertexAttribArray(texcoord2Loc);
        this.gl.enableVertexAttribArray(color0Loc);

        this.gl.vertexAttribPointer(positionLoc, 3, this.gl.FLOAT, false, this.vertexStride, 0);
        this.gl.vertexAttribPointer(normalLoc, 3, this.gl.FLOAT, false, this.vertexStride, 12);
        this.gl.vertexAttribPointer(texcoordLoc, 2, this.gl.FLOAT, false, this.vertexStride, 24);
        this.gl.vertexAttribPointer(texcoord1Loc, 2, this.gl.FLOAT, false, this.vertexStride, 32);
        this.gl.vertexAttribPointer(texcoord2Loc, 2, this.gl.FLOAT, false, this.vertexStride, 40);
        this.gl.vertexAttribPointer(color0Loc, 2, this.gl.FLOAT, false, this.vertexStride, 48);

        this.vertexCount = vertices.length / 3;
        this.indexCount = indices.length;
    }

    render() {
        if (!this.vertexBuffer || !this.indexBuffer) return;

        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.vertexBuffer);
        this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);

        this.gl.drawElements(this.gl.TRIANGLES, this.indexCount, this.gl.UNSIGNED_SHORT, 0);
    }

    dispose() {
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
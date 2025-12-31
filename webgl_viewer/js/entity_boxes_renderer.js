import { ShaderProgram } from './shader_program.js';

const vsSource = `#version 300 es
    layout(location = 0) in vec3 aPosition;
    layout(location = 1) in vec3 aNormal;

    // Instance attributes: mat4 split across 4 vec4 attribs.
    layout(location = 3) in vec4 iM0;
    layout(location = 4) in vec4 iM1;
    layout(location = 5) in vec4 iM2;
    layout(location = 6) in vec4 iM3;
    layout(location = 7) in vec3 iColor;

    uniform mat4 uViewProjectionMatrix;
    uniform mat4 uModelMatrix;

    out vec3 vColor;
    out vec3 vNormal;

    void main() {
        mat4 imat = mat4(iM0, iM1, iM2, iM3);
        vec4 worldPos = uModelMatrix * (imat * vec4(aPosition, 1.0));
        gl_Position = uViewProjectionMatrix * worldPos;

        // Normal in the same space as lighting (ignore non-uniform scaling; good enough for proxy meshes).
        vNormal = normalize((uModelMatrix * (imat * vec4(aNormal, 0.0))).xyz);
        vColor = iColor;
    }
`;

const fsSource = `#version 300 es
    precision mediump float;

    in vec3 vColor;
    in vec3 vNormal;

    uniform vec3 uLightDir;
    uniform float uAmbient;

    out vec4 fragColor;

    void main() {
        vec3 n = normalize(vNormal);
        float ndotl = max(dot(n, normalize(uLightDir)), 0.0);
        float lit = clamp(uAmbient + ndotl * (1.0 - uAmbient), 0.0, 1.0);
        vec3 color = vColor * lit;
        fragColor = vec4(color, 1.0);
    }
`;

function _createUnitCube() {
    // A simple cube from -0.5..+0.5 in each axis (12 triangles, 36 verts).
    // We keep it non-indexed to keep the code tiny.
    const p = [
        // +Z
        -0.5, -0.5,  0.5,   0.5, -0.5,  0.5,   0.5,  0.5,  0.5,
        -0.5, -0.5,  0.5,   0.5,  0.5,  0.5,  -0.5,  0.5,  0.5,
        // -Z
        -0.5, -0.5, -0.5,  -0.5,  0.5, -0.5,   0.5,  0.5, -0.5,
        -0.5, -0.5, -0.5,   0.5,  0.5, -0.5,   0.5, -0.5, -0.5,
        // +X
         0.5, -0.5, -0.5,   0.5,  0.5, -0.5,   0.5,  0.5,  0.5,
         0.5, -0.5, -0.5,   0.5,  0.5,  0.5,   0.5, -0.5,  0.5,
        // -X
        -0.5, -0.5, -0.5,  -0.5, -0.5,  0.5,  -0.5,  0.5,  0.5,
        -0.5, -0.5, -0.5,  -0.5,  0.5,  0.5,  -0.5,  0.5, -0.5,
        // +Y
        -0.5,  0.5, -0.5,  -0.5,  0.5,  0.5,   0.5,  0.5,  0.5,
        -0.5,  0.5, -0.5,   0.5,  0.5,  0.5,   0.5,  0.5, -0.5,
        // -Y
        -0.5, -0.5, -0.5,   0.5, -0.5, -0.5,   0.5, -0.5,  0.5,
        -0.5, -0.5, -0.5,   0.5, -0.5,  0.5,  -0.5, -0.5,  0.5,
    ];
    return new Float32Array(p);
}

export class EntityBoxesRenderer {
    constructor(gl) {
        this.gl = gl;
        this.program = new ShaderProgram(gl);
        this.uniforms = null;
        this._ready = false;

        this._cubeVao = null;
        this._cubeVbo = null;
        this._cubeNbo = null;
        this._cubeIbo = null;
        this._cubeVertexCount = 0;
        this._cubeIndexCount = 0;
        this._cubeIndexed = false;

        // key -> { vao, instanceVbo, instanceCount }
        this._chunks = new Map();
    }

    async init() {
        const ok = await this.program.createProgram(vsSource, fsSource);
        if (!ok || !this.program.program) return false;

        this.uniforms = {
            uViewProjectionMatrix: this.gl.getUniformLocation(this.program.program, 'uViewProjectionMatrix'),
            uModelMatrix: this.gl.getUniformLocation(this.program.program, 'uModelMatrix'),
            uLightDir: this.gl.getUniformLocation(this.program.program, 'uLightDir'),
            uAmbient: this.gl.getUniformLocation(this.program.program, 'uAmbient'),
        };

        // Static cube geometry: try loading proxy mesh bin from assets (real "meshes").
        // Falls back to a baked-in cube if the file isn't present.
        await this._initBaseMesh();

        this._ready = true;
        return true;
    }

    async _initBaseMesh() {
        const gl = this.gl;

        // Try loading proxy bin written by setup_assets.py
        try {
            const resp = await fetch('assets/models/box_v3.bin');
            if (resp.ok) {
                const buf = await resp.arrayBuffer();
                if (this._parseAndUploadMsh0(buf)) {
                    console.log('EntityBoxesRenderer: using assets/models/box_v3.bin');
                    return;
                }
            }
        } catch {
            // ignore
        }

        // Fallback: baked-in cube with approximate normals (vertex positions).
        const cube = _createUnitCube();
        this._cubeVertexCount = Math.floor(cube.length / 3);
        this._cubeIndexed = false;

        // Normals: approximate from position
        const normals = new Float32Array(cube.length);
        for (let i = 0; i < cube.length; i += 3) {
            const x = cube[i], y = cube[i + 1], z = cube[i + 2];
            const inv = 1.0 / Math.max(1e-6, Math.sqrt(x * x + y * y + z * z));
            normals[i] = x * inv;
            normals[i + 1] = y * inv;
            normals[i + 2] = z * inv;
        }

        this._cubeVao = gl.createVertexArray();
        gl.bindVertexArray(this._cubeVao);

        this._cubeVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this._cubeVbo);
        gl.bufferData(gl.ARRAY_BUFFER, cube, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

        this._cubeNbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this._cubeNbo);
        gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

        gl.bindVertexArray(null);
    }

    _parseAndUploadMsh0(arrayBuffer) {
        const gl = this.gl;
        const dv = new DataView(arrayBuffer);
        if (dv.byteLength < 20) return false;
        const magic =
            String.fromCharCode(dv.getUint8(0)) +
            String.fromCharCode(dv.getUint8(1)) +
            String.fromCharCode(dv.getUint8(2)) +
            String.fromCharCode(dv.getUint8(3));
        const version = dv.getUint32(4, true);
        const vertexCount = dv.getUint32(8, true);
        const indexCount = dv.getUint32(12, true);
        const flags = dv.getUint32(16, true);
        if (magic !== 'MSH0' || (version !== 1 && version !== 2 && version !== 3)) return false;
        const hasNormals = version >= 2 && (flags & 1) === 1;
        const hasUvs = version >= 3 && (flags & 2) === 2;
        if (!hasNormals) return false; // our shader expects normals

        const headerBytes = 20;
        const posBytes = vertexCount * 3 * 4;
        const nrmBytes = hasNormals ? vertexCount * 3 * 4 : 0;
        const uvBytes = hasUvs ? vertexCount * 2 * 4 : 0;
        const idxBytes = indexCount * 4;
        if (headerBytes + posBytes + nrmBytes + uvBytes + idxBytes > arrayBuffer.byteLength) return false;

        const positions = new Float32Array(arrayBuffer, headerBytes, vertexCount * 3);
        const normals = new Float32Array(arrayBuffer, headerBytes + posBytes, vertexCount * 3);
        const indices = new Uint32Array(arrayBuffer, headerBytes + posBytes + nrmBytes + uvBytes, indexCount);

        this._cubeVertexCount = vertexCount;
        this._cubeIndexCount = indexCount;
        this._cubeIndexed = true;

        this._cubeVao = gl.createVertexArray();
        gl.bindVertexArray(this._cubeVao);

        this._cubeVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this._cubeVbo);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

        this._cubeNbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this._cubeNbo);
        gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

        this._cubeIbo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._cubeIbo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

        gl.bindVertexArray(null);
        return true;
    }

    setChunk(key, instanceFloat32Array, instanceCount) {
        if (!this._ready) return;
        const gl = this.gl;

        const prev = this._chunks.get(key);
        if (prev) {
            gl.deleteBuffer(prev.instanceVbo);
            gl.deleteVertexArray(prev.vao);
            this._chunks.delete(key);
        }

        const count = Number(instanceCount) || 0;
        if (count <= 0) return;

        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);

        // Bind cube vertex buffer (attribute 0).
        gl.bindBuffer(gl.ARRAY_BUFFER, this._cubeVbo);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

        // Bind normals (attribute 1).
        if (this._cubeNbo) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this._cubeNbo);
            gl.enableVertexAttribArray(1);
            gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
        }

        // Bind indices if using indexed base mesh.
        if (this._cubeIndexed && this._cubeIbo) {
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._cubeIbo);
        }

        // Instance data: 19 floats per instance = mat4 (16) + color (3)
        const instanceStride = 19 * 4;
        const instanceVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, instanceVbo);
        gl.bufferData(gl.ARRAY_BUFFER, instanceFloat32Array, gl.DYNAMIC_DRAW);

        // mat4 columns
        for (let i = 0; i < 4; i++) {
            const loc = 3 + i;
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, instanceStride, i * 16);
            gl.vertexAttribDivisor(loc, 1);
        }
        // color
        gl.enableVertexAttribArray(7);
        gl.vertexAttribPointer(7, 3, gl.FLOAT, false, instanceStride, 16 * 4);
        gl.vertexAttribDivisor(7, 1);

        gl.bindVertexArray(null);

        this._chunks.set(key, { vao, instanceVbo, instanceCount: count });
    }

    deleteChunk(key) {
        const gl = this.gl;
        const cur = this._chunks.get(key);
        if (!cur) return;
        gl.deleteBuffer(cur.instanceVbo);
        gl.deleteVertexArray(cur.vao);
        this._chunks.delete(key);
    }

    clear() {
        for (const key of this._chunks.keys()) this.deleteChunk(key);
    }

    render(viewProjectionMatrix, modelMatrix) {
        if (!this._ready || this._chunks.size === 0) return;
        const gl = this.gl;

        this.program.use();
        gl.uniformMatrix4fv(this.uniforms.uViewProjectionMatrix, false, viewProjectionMatrix);
        gl.uniformMatrix4fv(this.uniforms.uModelMatrix, false, modelMatrix);
        gl.uniform3fv(this.uniforms.uLightDir, [0.35, 0.85, 0.35]);
        gl.uniform1f(this.uniforms.uAmbient, 0.55);

        gl.enable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);

        for (const { vao, instanceCount } of this._chunks.values()) {
            gl.bindVertexArray(vao);
            if (this._cubeIndexed && this._cubeIndexCount > 0) {
                gl.drawElementsInstanced(gl.TRIANGLES, this._cubeIndexCount, gl.UNSIGNED_INT, 0, instanceCount);
            } else {
                gl.drawArraysInstanced(gl.TRIANGLES, 0, this._cubeVertexCount, instanceCount);
            }
        }
        gl.bindVertexArray(null);
    }
}



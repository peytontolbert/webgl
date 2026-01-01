import { glMatrix } from './glmatrix.js';
import { ShaderProgram } from './shader_program.js';

const vsSource = `#version 300 es
in vec3 aPosition;

uniform mat4 uViewProjectionMatrix;
uniform mat4 uModelMatrix;

// Point size in pixels (tuned for map scale)
uniform float uPointSize;

void main() {
    vec4 modelPos = uModelMatrix * vec4(aPosition, 1.0);
    gl_Position = uViewProjectionMatrix * modelPos;
    gl_PointSize = uPointSize;
}
`;

const fsSource = `#version 300 es
precision mediump float;
out vec4 fragColor;

void main() {
    // Simple solid point
    fragColor = vec4(1.0, 0.8, 0.2, 1.0);
}
`;

export class EntityRenderer {
    constructor(gl) {
        this.gl = gl;
        this.program = new ShaderProgram(gl);
        this.uniforms = null;

        // Match TerrainRenderer's model matrix transforms
        this.modelMatrix = glMatrix.mat4.create();
        glMatrix.mat4.rotateY(this.modelMatrix, this.modelMatrix, Math.PI);
        glMatrix.mat4.rotateX(this.modelMatrix, this.modelMatrix, -Math.PI / 2);

        /** @type {Map<string, {buffer: WebGLBuffer, count: number}>} */
        this.chunkBuffers = new Map();
        this.ready = false;
    }

    async init() {
        await this.program.createProgram(vsSource, fsSource);
        this.uniforms = {
            uViewProjectionMatrix: this.gl.getUniformLocation(this.program.program, 'uViewProjectionMatrix'),
            uModelMatrix: this.gl.getUniformLocation(this.program.program, 'uModelMatrix'),
            uPointSize: this.gl.getUniformLocation(this.program.program, 'uPointSize'),
        };
        this.posLoc = this.gl.getAttribLocation(this.program.program, 'aPosition');
        this.ready = true;
    }

    setChunk(key, positionsFloat32) {
        if (!this.ready) return;
        if (!positionsFloat32 || positionsFloat32.length === 0) return;

        const gl = this.gl;
        let entry = this.chunkBuffers.get(key);
        if (!entry) {
            entry = { buffer: gl.createBuffer(), vao: gl.createVertexArray(), count: 0 };
            this.chunkBuffers.set(key, entry);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, positionsFloat32, gl.STATIC_DRAW);
        entry.count = positionsFloat32.length / 3;

        // Configure VAO for this chunk so it can't clobber terrain attributes.
        gl.bindVertexArray(entry.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
        if (this.posLoc !== -1) {
            gl.enableVertexAttribArray(this.posLoc);
            gl.vertexAttribPointer(this.posLoc, 3, gl.FLOAT, false, 0, 0);
        }
        gl.bindVertexArray(null);
    }

    deleteChunk(key) {
        const entry = this.chunkBuffers.get(key);
        if (!entry) return;
        try {
            this.gl.deleteBuffer(entry.buffer);
            if (entry.vao) this.gl.deleteVertexArray(entry.vao);
        } catch {
            // ignore
        }
        this.chunkBuffers.delete(key);
    }

    render(viewProjectionMatrix, pointSize = 2.0) {
        if (!this.ready) return;

        const gl = this.gl;
        gl.useProgram(this.program.program);

        gl.uniformMatrix4fv(this.uniforms.uViewProjectionMatrix, false, viewProjectionMatrix);
        gl.uniformMatrix4fv(this.uniforms.uModelMatrix, false, this.modelMatrix);
        gl.uniform1f(this.uniforms.uPointSize, pointSize);

        // Enable alpha blending (helps dense points)
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        for (const [_key, entry] of this.chunkBuffers.entries()) {
            if (!entry || entry.count <= 0) continue;
            gl.bindVertexArray(entry.vao);
            gl.drawArrays(gl.POINTS, 0, entry.count);
        }
        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);
    }
}



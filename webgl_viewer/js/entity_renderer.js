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
        // Preserve GL state (VAOs are global state in WebGL2 and can easily clobber other renderers).
        const prevVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
        const prevArrayBuf = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
        let entry = this.chunkBuffers.get(key);
        if (!entry) {
            entry = { buffer: gl.createBuffer(), vao: gl.createVertexArray(), count: 0 };
            this.chunkBuffers.set(key, entry);
        }
        try {
            gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
            gl.bufferData(gl.ARRAY_BUFFER, positionsFloat32, gl.STATIC_DRAW);
            entry.count = positionsFloat32.length / 3;

            // Configure VAO for this chunk so it can't clobber other renderers' attributes.
            gl.bindVertexArray(entry.vao);
            gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
            if (this.posLoc !== -1) {
                gl.enableVertexAttribArray(this.posLoc);
                gl.vertexAttribPointer(this.posLoc, 3, gl.FLOAT, false, 0, 0);
            }
        } catch (e) {
            console.warn(`EntityRenderer.setChunk failed for ${String(key)}:`, e);
            try { this.deleteChunk(key); } catch { /* ignore */ }
        } finally {
            // Restore previous bindings.
            try { gl.bindVertexArray(prevVao); } catch { /* ignore */ }
            try { gl.bindBuffer(gl.ARRAY_BUFFER, prevArrayBuf); } catch { /* ignore */ }
        }
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
        // Preserve/restore global GL state to avoid "mysterious broken frame" bugs.
        const prevProg = gl.getParameter(gl.CURRENT_PROGRAM);
        const prevVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
        const blendWas = gl.isEnabled(gl.BLEND);
        const prevBlendSrcRGB = gl.getParameter(gl.BLEND_SRC_RGB);
        const prevBlendDstRGB = gl.getParameter(gl.BLEND_DST_RGB);
        const prevBlendSrcA = gl.getParameter(gl.BLEND_SRC_ALPHA);
        const prevBlendDstA = gl.getParameter(gl.BLEND_DST_ALPHA);
        const prevBlendEqRGB = gl.getParameter(gl.BLEND_EQUATION_RGB);
        const prevBlendEqA = gl.getParameter(gl.BLEND_EQUATION_ALPHA);

        gl.useProgram(this.program.program);

        gl.uniformMatrix4fv(this.uniforms.uViewProjectionMatrix, false, viewProjectionMatrix);
        gl.uniformMatrix4fv(this.uniforms.uModelMatrix, false, this.modelMatrix);
        gl.uniform1f(this.uniforms.uPointSize, pointSize);

        // Enable alpha blending (helps dense points)
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        try {
            for (const [_key, entry] of this.chunkBuffers.entries()) {
                if (!entry || entry.count <= 0) continue;
                gl.bindVertexArray(entry.vao);
                gl.drawArrays(gl.POINTS, 0, entry.count);
            }
        } finally {
            // Restore previous state.
            try { gl.bindVertexArray(prevVao); } catch { /* ignore */ }
            try {
                gl.blendEquationSeparate(prevBlendEqRGB, prevBlendEqA);
                gl.blendFuncSeparate(prevBlendSrcRGB, prevBlendDstRGB, prevBlendSrcA, prevBlendDstA);
            } catch { /* ignore */ }
            try { if (!blendWas) gl.disable(gl.BLEND); else gl.enable(gl.BLEND); } catch { /* ignore */ }
            try { gl.useProgram(prevProg); } catch { /* ignore */ }
        }
    }
}



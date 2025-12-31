import * as glMatrix from 'gl-matrix';
import { ShaderProgram } from './shader_program.js';

const vsSource = `#version 300 es
    layout(location = 0) in vec3 aPosition;

    uniform mat4 uViewProjectionMatrix;
    uniform mat4 uModelMatrix;
    uniform float uPointSize;

    void main() {
        gl_Position = uViewProjectionMatrix * (uModelMatrix * vec4(aPosition, 1.0));
        gl_PointSize = uPointSize;
    }
`;

const fsSource = `#version 300 es
    precision mediump float;

    uniform vec4 uColor;
    out vec4 fragColor;

    void main() {
        // Soft circular point
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(p, p);
        if (r2 > 1.0) discard;
        float a = smoothstep(1.0, 0.6, r2);
        fragColor = vec4(uColor.rgb, uColor.a * a);
    }
`;

export class EntityPointsRenderer {
    constructor(gl) {
        this.gl = gl;
        this.program = new ShaderProgram(gl);
        this.uniforms = null;

        // key -> { vao, vbo, count }
        this._chunks = new Map();
        this._ready = false;
    }

    async init() {
        const ok = await this.program.createProgram(vsSource, fsSource);
        if (!ok || !this.program.program) return false;
        this.uniforms = {
            uViewProjectionMatrix: this.gl.getUniformLocation(this.program.program, 'uViewProjectionMatrix'),
            uModelMatrix: this.gl.getUniformLocation(this.program.program, 'uModelMatrix'),
            uPointSize: this.gl.getUniformLocation(this.program.program, 'uPointSize'),
            uColor: this.gl.getUniformLocation(this.program.program, 'uColor'),
        };
        this._ready = true;
        return true;
    }

    setChunk(key, positionsFloat32Array) {
        if (!this._ready) return;
        const gl = this.gl;
        const old = this._chunks.get(key);
        if (old) {
            gl.deleteBuffer(old.vbo);
            gl.deleteVertexArray(old.vao);
            this._chunks.delete(key);
        }

        const positions = positionsFloat32Array instanceof Float32Array
            ? positionsFloat32Array
            : new Float32Array(positionsFloat32Array || []);

        const count = Math.floor(positions.length / 3);
        if (count <= 0) return;

        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);

        const vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

        gl.bindVertexArray(null);

        this._chunks.set(key, { vao, vbo, count });
    }

    deleteChunk(key) {
        const gl = this.gl;
        const cur = this._chunks.get(key);
        if (!cur) return;
        gl.deleteBuffer(cur.vbo);
        gl.deleteVertexArray(cur.vao);
        this._chunks.delete(key);
    }

    clear() {
        for (const key of this._chunks.keys()) this.deleteChunk(key);
    }

    render(viewProjectionMatrix, modelMatrix, { pointSize = 2.5, color = [1.0, 0.6, 0.2, 1.0] } = {}) {
        if (!this._ready || this._chunks.size === 0) return;
        const gl = this.gl;

        this.program.use();
        gl.uniformMatrix4fv(this.uniforms.uViewProjectionMatrix, false, viewProjectionMatrix);
        gl.uniformMatrix4fv(this.uniforms.uModelMatrix, false, modelMatrix);
        gl.uniform1f(this.uniforms.uPointSize, Number(pointSize) || 2.5);
        gl.uniform4fv(this.uniforms.uColor, color);

        // Render points on top; depth test on, but don't write depth (prevents point “carving”).
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        for (const { vao, count } of this._chunks.values()) {
            gl.bindVertexArray(vao);
            gl.drawArrays(gl.POINTS, 0, count);
        }
        gl.bindVertexArray(null);

        gl.depthMask(true);
        gl.disable(gl.BLEND);
    }
}



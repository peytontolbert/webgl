import { glMatrix } from './glmatrix.js';
import { ShaderProgram } from './shader_program.js';

const vsSource = `#version 300 es
in vec3 aPosition;

uniform mat4 uViewProjectionMatrix;
uniform mat4 uModelMatrix;

void main() {
    gl_Position = uViewProjectionMatrix * (uModelMatrix * vec4(aPosition, 1.0));
}
`;

const fsSource = `#version 300 es
precision mediump float;
out vec4 fragColor;

uniform vec4 uColor;

void main() {
    fragColor = uColor;
}
`;

/**
 * Minimal line renderer for GeoJSON-derived polylines/outlines.
 * Uses GL_LINES; note that lineWidth is not reliable in WebGL, so this is debug-grade.
 */
export class GeoJsonLineRenderer {
    constructor(gl) {
        this.gl = gl;
        this.program = new ShaderProgram(gl);
        this.uniforms = null;
        this.ready = false;

        this.modelMatrix = glMatrix.mat4.create();
        glMatrix.mat4.identity(this.modelMatrix);

        this._buffer = null;
        this._vao = null;
        this._count = 0; // vertex count (pairs form segments)
    }

    async init() {
        await this.program.createProgram(vsSource, fsSource);
        const gl = this.gl;
        this.uniforms = {
            uViewProjectionMatrix: gl.getUniformLocation(this.program.program, 'uViewProjectionMatrix'),
            uModelMatrix: gl.getUniformLocation(this.program.program, 'uModelMatrix'),
            uColor: gl.getUniformLocation(this.program.program, 'uColor'),
        };
        this.posLoc = gl.getAttribLocation(this.program.program, 'aPosition');

        this._buffer = gl.createBuffer();
        this._vao = gl.createVertexArray();
        gl.bindVertexArray(this._vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
        if (this.posLoc !== -1) {
            gl.enableVertexAttribArray(this.posLoc);
            gl.vertexAttribPointer(this.posLoc, 3, gl.FLOAT, false, 0, 0);
        }
        gl.bindVertexArray(null);

        this.ready = true;
    }

    clear() {
        this._count = 0;
    }

    /**
     * @param {Float32Array} positionsFloat32 local-space XYZ positions in segment-pair order:
     *   [x0,y0,z0, x1,y1,z1,  x2,y2,z2, x3,y3,z3, ...] where (0->1) and (2->3) are segments.
     */
    setSegments(positionsFloat32) {
        if (!this.ready) return;
        const gl = this.gl;
        const arr = positionsFloat32 instanceof Float32Array ? positionsFloat32 : new Float32Array(positionsFloat32 || []);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
        gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
        this._count = Math.floor(arr.length / 3);
    }

    render(viewProjectionMatrix, { color = [0.15, 1.0, 0.65, 0.95] } = {}) {
        if (!this.ready || this._count <= 0) return;
        const gl = this.gl;

        gl.useProgram(this.program.program);
        gl.uniformMatrix4fv(this.uniforms.uViewProjectionMatrix, false, viewProjectionMatrix);
        gl.uniformMatrix4fv(this.uniforms.uModelMatrix, false, this.modelMatrix);
        gl.uniform4f(this.uniforms.uColor, color[0] ?? 1, color[1] ?? 1, color[2] ?? 1, color[3] ?? 1);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        gl.bindVertexArray(this._vao);
        gl.drawArrays(gl.LINES, 0, this._count);
        gl.bindVertexArray(null);

        gl.disable(gl.BLEND);
    }
}



import { glMatrix } from './glmatrix.js';
import { ShaderProgram } from './shader_program.js';

const vsSource = `#version 300 es
in vec3 aPosition;

uniform mat4 uViewProjectionMatrix;
uniform mat4 uModelMatrix;
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

uniform vec4 uColor;

void main() {
    // Solid points; keep it simple for overlays.
    fragColor = uColor;
}
`;

export class ExternalDatasetRenderer {
    constructor(gl) {
        this.gl = gl;
        this.program = new ShaderProgram(gl);
        this.uniforms = null;
        this.ready = false;

        // Match TerrainRenderer / EntityRenderer transforms (data-space -> viewer-space).
        this.modelMatrix = glMatrix.mat4.create();
        glMatrix.mat4.rotateY(this.modelMatrix, this.modelMatrix, Math.PI);
        glMatrix.mat4.rotateX(this.modelMatrix, this.modelMatrix, -Math.PI / 2);

        this._buffer = null;
        this._vao = null;
        this._count = 0;
    }

    async init() {
        await this.program.createProgram(vsSource, fsSource);
        const gl = this.gl;
        this.uniforms = {
            uViewProjectionMatrix: gl.getUniformLocation(this.program.program, 'uViewProjectionMatrix'),
            uModelMatrix: gl.getUniformLocation(this.program.program, 'uModelMatrix'),
            uPointSize: gl.getUniformLocation(this.program.program, 'uPointSize'),
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
     * @param {Float32Array} positionsFloat32 data-space XYZ triplets
     */
    setPoints(positionsFloat32) {
        if (!this.ready) return;
        const gl = this.gl;
        const arr = positionsFloat32 instanceof Float32Array ? positionsFloat32 : new Float32Array(positionsFloat32 || []);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
        gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
        this._count = Math.floor(arr.length / 3);
    }

    /**
     * @param {Float32Array} viewProjectionMatrix
     * @param {object} opts
     * @param {number} opts.pointSize
     * @param {number[]} opts.color RGBA
     */
    render(viewProjectionMatrix, { pointSize = 6.0, color = [0.95, 0.35, 0.95, 0.95] } = {}) {
        if (!this.ready || this._count <= 0) return;
        const gl = this.gl;

        gl.useProgram(this.program.program);
        gl.uniformMatrix4fv(this.uniforms.uViewProjectionMatrix, false, viewProjectionMatrix);
        gl.uniformMatrix4fv(this.uniforms.uModelMatrix, false, this.modelMatrix);
        gl.uniform1f(this.uniforms.uPointSize, pointSize);
        gl.uniform4f(this.uniforms.uColor, color[0] ?? 1, color[1] ?? 0, color[2] ?? 1, color[3] ?? 1);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        gl.bindVertexArray(this._vao);
        gl.drawArrays(gl.POINTS, 0, this._count);
        gl.bindVertexArray(null);

        gl.disable(gl.BLEND);
    }
}



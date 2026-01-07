import { glMatrix } from './glmatrix.js';
import { ShaderProgram } from './shader_program.js';

const vsSource = `#version 300 es
in vec3 aPosition;
in vec3 aNormal;

uniform mat4 uViewProjectionMatrix;
uniform mat4 uModelMatrix;

out vec3 vNormal;
out vec3 vWorldPos;

void main() {
    vec4 wp = uModelMatrix * vec4(aPosition, 1.0);
    vWorldPos = wp.xyz;
    // For our use (identity model matrix in Earth mode), this is fine.
    vNormal = mat3(uModelMatrix) * aNormal;
    gl_Position = uViewProjectionMatrix * wp;
}
`;

const fsSource = `#version 300 es
precision mediump float;
out vec4 fragColor;

in vec3 vNormal;
in vec3 vWorldPos;

uniform vec4 uColor;
uniform vec3 uLightDir; // world-space direction, should be normalized

void main() {
    vec3 N = normalize(vNormal);
    vec3 L = normalize(uLightDir);
    float ndl = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0);
    float ambient = 0.25;
    float lit = ambient + (1.0 - ambient) * ndl;
    fragColor = vec4(uColor.rgb * lit, uColor.a);
}
`;

export class SimpleMeshRenderer {
    constructor(gl) {
        this.gl = gl;
        this.program = new ShaderProgram(gl);
        this.uniforms = null;
        this.ready = false;

        this.modelMatrix = glMatrix.mat4.create();
        glMatrix.mat4.identity(this.modelMatrix);

        this._vao = null;
        this._pos = null;
        this._nrm = null;
        this._count = 0; // vertex count
    }

    async init() {
        await this.program.createProgram(vsSource, fsSource);
        const gl = this.gl;
        this.uniforms = {
            uViewProjectionMatrix: gl.getUniformLocation(this.program.program, 'uViewProjectionMatrix'),
            uModelMatrix: gl.getUniformLocation(this.program.program, 'uModelMatrix'),
            uColor: gl.getUniformLocation(this.program.program, 'uColor'),
            uLightDir: gl.getUniformLocation(this.program.program, 'uLightDir'),
        };
        this.posLoc = gl.getAttribLocation(this.program.program, 'aPosition');
        this.nrmLoc = gl.getAttribLocation(this.program.program, 'aNormal');

        this._vao = gl.createVertexArray();
        this._pos = gl.createBuffer();
        this._nrm = gl.createBuffer();

        gl.bindVertexArray(this._vao);
        if (this.posLoc !== -1) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this._pos);
            gl.enableVertexAttribArray(this.posLoc);
            gl.vertexAttribPointer(this.posLoc, 3, gl.FLOAT, false, 0, 0);
        }
        if (this.nrmLoc !== -1) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this._nrm);
            gl.enableVertexAttribArray(this.nrmLoc);
            gl.vertexAttribPointer(this.nrmLoc, 3, gl.FLOAT, false, 0, 0);
        }
        gl.bindVertexArray(null);

        this.ready = true;
    }

    clear() {
        this._count = 0;
    }

    setMesh({ positions, normals }) {
        if (!this.ready) return;
        const gl = this.gl;
        const pos = positions instanceof Float32Array ? positions : new Float32Array(positions || []);
        const nrm = normals instanceof Float32Array ? normals : new Float32Array(normals || []);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._pos);
        gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._nrm);
        gl.bufferData(gl.ARRAY_BUFFER, nrm, gl.STATIC_DRAW);
        this._count = Math.floor(pos.length / 3);
    }

    render(viewProjectionMatrix, { color = [0.8, 0.8, 0.8, 1.0], lightDir = [0.35, 0.85, 0.25], cull = true } = {}) {
        if (!this.ready || this._count <= 0) return;
        const gl = this.gl;
        gl.useProgram(this.program.program);
        gl.uniformMatrix4fv(this.uniforms.uViewProjectionMatrix, false, viewProjectionMatrix);
        gl.uniformMatrix4fv(this.uniforms.uModelMatrix, false, this.modelMatrix);
        gl.uniform4f(this.uniforms.uColor, color[0] ?? 1, color[1] ?? 1, color[2] ?? 1, color[3] ?? 1);
        gl.uniform3f(this.uniforms.uLightDir, lightDir[0] ?? 0.3, lightDir[1] ?? 0.9, lightDir[2] ?? 0.2);

        gl.enable(gl.DEPTH_TEST);
        if (cull) {
            gl.enable(gl.CULL_FACE);
            gl.cullFace(gl.BACK);
        } else {
            gl.disable(gl.CULL_FACE);
        }

        gl.bindVertexArray(this._vao);
        gl.drawArrays(gl.TRIANGLES, 0, this._count);
        gl.bindVertexArray(null);

        gl.disable(gl.CULL_FACE);
    }
}



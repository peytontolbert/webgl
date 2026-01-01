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
    // Circular point
    vec2 uv = gl_PointCoord.xy * 2.0 - 1.0;
    float r2 = dot(uv, uv);
    if (r2 > 1.0) discard;

    fragColor = uColor;
}
`;

export class PedRenderer {
    constructor(gl) {
        this.gl = gl;
        this.program = new ShaderProgram(gl);
        this.uniforms = null;

        // Match TerrainRenderer's model matrix transforms (data-space -> viewer-space)
        this.modelMatrix = glMatrix.mat4.create();
        glMatrix.mat4.rotateY(this.modelMatrix, this.modelMatrix, Math.PI);
        glMatrix.mat4.rotateX(this.modelMatrix, this.modelMatrix, -Math.PI / 2);

        this.ready = false;
        this.buffer = null;
        this.vao = null;
        this.count = 0;
    }

    async init() {
        await this.program.createProgram(vsSource, fsSource);
        this.uniforms = {
            uViewProjectionMatrix: this.gl.getUniformLocation(this.program.program, 'uViewProjectionMatrix'),
            uModelMatrix: this.gl.getUniformLocation(this.program.program, 'uModelMatrix'),
            uPointSize: this.gl.getUniformLocation(this.program.program, 'uPointSize'),
            uColor: this.gl.getUniformLocation(this.program.program, 'uColor'),
        };

        this.posLoc = this.gl.getAttribLocation(this.program.program, 'aPosition');
        this.buffer = this.gl.createBuffer();
        this.vao = this.gl.createVertexArray();

        this.gl.bindVertexArray(this.vao);
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
        if (this.posLoc !== -1) {
            this.gl.enableVertexAttribArray(this.posLoc);
            this.gl.vertexAttribPointer(this.posLoc, 3, this.gl.FLOAT, false, 0, 0);
        }
        this.gl.bindVertexArray(null);

        this.ready = true;
    }

    /**
     * @param {Array<[number, number, number]>} positions
     */
    setPositions(positions) {
        if (!this.ready) return;
        const gl = this.gl;
        const flat = [];
        for (const p of positions || []) {
            if (!p || p.length < 3) continue;
            flat.push(p[0], p[1], p[2]);
        }
        this.count = flat.length / 3;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(flat), gl.DYNAMIC_DRAW);
    }

    render(viewProjectionMatrix, pointSize = 10.0, color = [0.15, 0.8, 1.0, 1.0]) {
        if (!this.ready || !this.vao || this.count <= 0) return;

        const gl = this.gl;
        gl.useProgram(this.program.program);

        gl.uniformMatrix4fv(this.uniforms.uViewProjectionMatrix, false, viewProjectionMatrix);
        gl.uniformMatrix4fv(this.uniforms.uModelMatrix, false, this.modelMatrix);
        gl.uniform1f(this.uniforms.uPointSize, pointSize);
        gl.uniform4fv(this.uniforms.uColor, color);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        gl.bindVertexArray(this.vao);
        gl.drawArrays(gl.POINTS, 0, this.count);
        gl.bindVertexArray(null);

        gl.disable(gl.BLEND);
    }
}



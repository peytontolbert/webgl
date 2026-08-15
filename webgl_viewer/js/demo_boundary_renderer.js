import { glMatrix } from './glmatrix.js';
import { ShaderProgram } from './shader_program.js';

const vsSource = `#version 300 es
in vec3 aPosition;
in float aAlong;

uniform mat4 uViewProjectionMatrix;
uniform mat4 uModelMatrix;

out float vDataZ;
out float vAlong;

void main() {
    vDataZ = aPosition.z;
    vAlong = aAlong;
    gl_Position = uViewProjectionMatrix * (uModelMatrix * vec4(aPosition, 1.0));
}
`;

const fsSource = `#version 300 es
precision mediump float;

in float vDataZ;
in float vAlong;
out vec4 fragColor;

uniform vec4 uColor;

void main() {
    float horizontalRail = step(0.82, fract(vDataZ * 0.52));
    float verticalPost = step(0.88, fract(vAlong * 0.10));
    float grid = max(horizontalRail, verticalPost);
    float pulse = 0.86 + 0.14 * sin(vDataZ * 2.2);
    fragColor = vec4(uColor.rgb * mix(pulse, 1.35, grid), mix(uColor.a, 0.72, grid));
}
`;

export class DemoBoundaryRenderer {
    constructor(gl) {
        this.gl = gl;
        this.program = new ShaderProgram(gl);
        this.modelMatrix = glMatrix.mat4.create();
        this.ready = false;
        this._vao = null;
        this._positionBuffer = null;
        this._alongBuffer = null;
        this._vertexCount = 0;
    }

    async init(modelMatrix = null) {
        await this.program.createProgram(vsSource, fsSource);
        const gl = this.gl;
        if (modelMatrix) glMatrix.mat4.copy(this.modelMatrix, modelMatrix);
        this.uniforms = {
            viewProjection: gl.getUniformLocation(this.program.program, 'uViewProjectionMatrix'),
            model: gl.getUniformLocation(this.program.program, 'uModelMatrix'),
            color: gl.getUniformLocation(this.program.program, 'uColor'),
        };
        const positionLoc = gl.getAttribLocation(this.program.program, 'aPosition');
        const alongLoc = gl.getAttribLocation(this.program.program, 'aAlong');
        this._vao = gl.createVertexArray();
        this._positionBuffer = gl.createBuffer();
        this._alongBuffer = gl.createBuffer();
        gl.bindVertexArray(this._vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._positionBuffer);
        gl.enableVertexAttribArray(positionLoc);
        gl.vertexAttribPointer(positionLoc, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._alongBuffer);
        gl.enableVertexAttribArray(alongLoc);
        gl.vertexAttribPointer(alongLoc, 1, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        this.ready = true;
    }

    setBounds(bounds, groundAt, { spacing = 3.0, height = 7.0 } = {}) {
        if (!this.ready || !bounds) return false;
        const corners = [
            [bounds.minX, bounds.minY],
            [bounds.maxX, bounds.minY],
            [bounds.maxX, bounds.maxY],
            [bounds.minX, bounds.maxY],
            [bounds.minX, bounds.minY],
        ];
        const positions = [];
        const alongValues = [];
        let perimeterDistance = 0.0;
        let fallbackZ = 30.0;

        const pushVertex = (x, y, z, along) => {
            positions.push(x, y, z);
            alongValues.push(along);
        };
        for (let side = 0; side < 4; side++) {
            const start = corners[side];
            const end = corners[side + 1];
            const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
            const steps = Math.max(1, Math.ceil(length / Math.max(1.0, spacing)));
            for (let i = 0; i < steps; i++) {
                const t0 = i / steps;
                const t1 = (i + 1) / steps;
                const x0 = start[0] + (end[0] - start[0]) * t0;
                const y0 = start[1] + (end[1] - start[1]) * t0;
                const x1 = start[0] + (end[0] - start[0]) * t1;
                const y1 = start[1] + (end[1] - start[1]) * t1;
                const sampledZ0 = Number(groundAt?.(x0, y0));
                const z0 = Number.isFinite(sampledZ0) ? sampledZ0 : fallbackZ;
                if (Number.isFinite(sampledZ0)) fallbackZ = sampledZ0;
                const sampledZ1 = Number(groundAt?.(x1, y1));
                const z1 = Number.isFinite(sampledZ1) ? sampledZ1 : z0;
                if (Number.isFinite(sampledZ1)) fallbackZ = sampledZ1;
                const a0 = perimeterDistance + length * t0;
                const a1 = perimeterDistance + length * t1;
                const bottom0 = z0 - 0.15;
                const bottom1 = z1 - 0.15;
                pushVertex(x0, y0, bottom0, a0);
                pushVertex(x1, y1, bottom1, a1);
                pushVertex(x1, y1, z1 + height, a1);
                pushVertex(x0, y0, bottom0, a0);
                pushVertex(x1, y1, z1 + height, a1);
                pushVertex(x0, y0, z0 + height, a0);
            }
            perimeterDistance += length;
        }

        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this._positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._alongBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(alongValues), gl.STATIC_DRAW);
        this._vertexCount = positions.length / 3;
        return this._vertexCount > 0;
    }

    clear() {
        this._vertexCount = 0;
    }

    render(viewProjectionMatrix, { fastStateRestore = false } = {}) {
        if (!this.ready || this._vertexCount <= 0) return;
        const gl = this.gl;
        const blendWasEnabled = fastStateRestore ? false : gl.isEnabled(gl.BLEND);
        const cullWasEnabled = fastStateRestore ? false : gl.isEnabled(gl.CULL_FACE);
        const depthMaskWas = fastStateRestore ? true : gl.getParameter(gl.DEPTH_WRITEMASK);
        gl.useProgram(this.program.program);
        gl.uniformMatrix4fv(this.uniforms.viewProjection, false, viewProjectionMatrix);
        gl.uniformMatrix4fv(this.uniforms.model, false, this.modelMatrix);
        gl.uniform4f(this.uniforms.color, 0.05, 0.88, 1.0, 0.19);
        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        gl.disable(gl.CULL_FACE);
        gl.bindVertexArray(this._vao);
        gl.drawArrays(gl.TRIANGLES, 0, this._vertexCount);
        gl.bindVertexArray(null);
        gl.depthMask(depthMaskWas);
        if (!blendWasEnabled) gl.disable(gl.BLEND);
        if (cullWasEnabled) gl.enable(gl.CULL_FACE);
    }
}

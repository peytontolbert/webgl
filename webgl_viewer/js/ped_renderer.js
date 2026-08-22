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
        this._singlePosition = new Float32Array(3);

        this.characterBuffer = null;
        this.characterVao = null;
        this.characterLineCount = 0;
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
        this.gl.bufferData(this.gl.ARRAY_BUFFER, this._singlePosition.byteLength, this.gl.DYNAMIC_DRAW);
        if (this.posLoc !== -1) {
            this.gl.enableVertexAttribArray(this.posLoc);
            this.gl.vertexAttribPointer(this.posLoc, 3, this.gl.FLOAT, false, 0, 0);
        }
        this.gl.bindVertexArray(null);

        this.characterBuffer = this.gl.createBuffer();
        this.characterVao = this.gl.createVertexArray();
        this.gl.bindVertexArray(this.characterVao);
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.characterBuffer);
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

    setPosition(position) {
        if (!this.ready || !position || position.length < 3) return;
        this._singlePosition[0] = Number(position[0]) || 0.0;
        this._singlePosition[1] = Number(position[1]) || 0.0;
        this._singlePosition[2] = Number(position[2]) || 0.0;
        this.count = 1;
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
        this.gl.bufferSubData(this.gl.ARRAY_BUFFER, 0, this._singlePosition);
    }

    _pushLine(flat, a, b) {
        flat.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }

    _buildCharacterLines(posData, headingRad, eyeHeightData, animation = null) {
        const p = posData || [0, 0, 0];
        const x = Number(p[0]) || 0;
        const y = Number(p[1]) || 0;
        const zEye = Number(p[2]) || 0;
        const eye = Number.isFinite(Number(eyeHeightData)) ? Math.max(0.2, Number(eyeHeightData)) : 1.2;
        const move01 = Math.max(0.0, Math.min(1.0, Number(animation?.move01) || 0.0));
        const phase = Number.isFinite(Number(animation?.phase)) ? Number(animation.phase) : 0.0;
        const gait = String(animation?.gait || 'idle');
        const strideScale = gait === 'sprint' ? 1.25 : (gait === 'walk' ? 0.68 : 1.0);
        const swing = Math.sin(phase) * 0.26 * move01 * strideScale;
        const armSwing = -Math.sin(phase) * 0.20 * move01 * strideScale;
        const liftL = Math.max(0.0, Math.sin(phase)) * 0.12 * move01;
        const liftR = Math.max(0.0, -Math.sin(phase)) * 0.12 * move01;
        const bob = Math.abs(Math.sin(phase * 2.0)) * 0.035 * move01;
        const feetZ = zEye - eye + bob;

        const h = Number.isFinite(Number(headingRad)) ? Number(headingRad) : 0.0;
        const fx = Math.cos(h);
        const fy = Math.sin(h);
        const rx = -fy;
        const ry = fx;

        const at = (side, forward, z) => [
            x + rx * side + fx * forward,
            y + ry * side + fy * forward,
            feetZ + z,
        ];

        const head = at(0.0, 0.0, 1.68);
        const neck = at(0.0, 0.0, 1.42);
        const chest = at(0.0, 0.0, 1.15);
        const pelvis = at(0.0, 0.0, 0.78);
        const shoulderL = at(-0.34, 0.0, 1.27);
        const shoulderR = at(0.34, 0.0, 1.27);
        const handL = at(-0.54, -0.06 + armSwing, 0.78);
        const handR = at(0.54, -0.06 - armSwing, 0.78);
        const footL = at(-0.22, 0.10 + swing, liftL);
        const footR = at(0.22, 0.10 - swing, liftR);

        const flat = [];
        this._pushLine(flat, neck, chest);
        this._pushLine(flat, chest, pelvis);
        this._pushLine(flat, shoulderL, shoulderR);
        this._pushLine(flat, shoulderL, handL);
        this._pushLine(flat, shoulderR, handR);
        this._pushLine(flat, pelvis, footL);
        this._pushLine(flat, pelvis, footR);

        // Head ring, drawn in the horizontal plane so it reads at street-level scale.
        const r = 0.18;
        const segs = 12;
        let prev = null;
        for (let i = 0; i <= segs; i++) {
            const a = (i / segs) * Math.PI * 2.0;
            const side = Math.cos(a) * r;
            const forward = Math.sin(a) * r;
            const cur = [head[0] + rx * side + fx * forward, head[1] + ry * side + fy * forward, head[2]];
            if (prev) this._pushLine(flat, prev, cur);
            prev = cur;
        }

        // Short heading tick so walking direction is readable in wireframe mode.
        this._pushLine(flat, chest, at(0.0, 0.46, 1.15));
        return flat;
    }

    renderCharacter(viewProjectionMatrix, posData, headingRad = 0.0, {
        eyeHeightData = 1.2,
        pointSize = 0.0,
        color = [0.1, 0.95, 1.0, 1.0],
        animation = null,
    } = {}) {
        if (!this.ready || !this.characterVao || !this.characterBuffer || !posData) return;

        const gl = this.gl;
        const flat = this._buildCharacterLines(posData, headingRad, eyeHeightData, animation);
        this.characterLineCount = flat.length / 3;
        if (this.characterLineCount <= 0) return;

        gl.bindBuffer(gl.ARRAY_BUFFER, this.characterBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(flat), gl.DYNAMIC_DRAW);

        gl.useProgram(this.program.program);
        gl.uniformMatrix4fv(this.uniforms.uViewProjectionMatrix, false, viewProjectionMatrix);
        gl.uniformMatrix4fv(this.uniforms.uModelMatrix, false, this.modelMatrix);
        gl.uniform1f(this.uniforms.uPointSize, pointSize);
        gl.uniform4fv(this.uniforms.uColor, color);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        try { gl.lineWidth(2.0); } catch { /* ignore */ }

        gl.bindVertexArray(this.characterVao);
        gl.drawArrays(gl.LINES, 0, this.characterLineCount);
        gl.bindVertexArray(null);

        gl.disable(gl.BLEND);
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



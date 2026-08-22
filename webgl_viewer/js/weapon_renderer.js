import { glMatrix } from './glmatrix.js';

const VERTEX_SHADER = `#version 300 es
in vec3 aPosition;
uniform mat4 uViewProjection;
uniform mat4 uModel;
void main() {
    gl_Position = uViewProjection * uModel * vec4(aPosition, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main() {
    outColor = uColor;
}`;

function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader) || 'Unknown shader error';
        gl.deleteShader(shader);
        throw new Error(message);
    }
    return shader;
}

function normalize(v) {
    const len = Math.hypot(v[0], v[1], v[2]) || 1.0;
    return [v[0] / len, v[1] / len, v[2] / len];
}

function subtract(a, b) {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function addScaled(origin, direction, scale) {
    return [
        origin[0] + direction[0] * scale,
        origin[1] + direction[1] * scale,
        origin[2] + direction[2] * scale,
    ];
}

export class WeaponRenderer {
    constructor(gl) {
        this.gl = gl;
        this.ready = false;
        this.program = null;
        this.positionBuffer = null;
        this.triangleIndexBuffer = null;
        this.lineIndexBuffer = null;
        this.triangleCount = 0;
        this.lineCount = 0;
        this.locations = null;
        this._model = glMatrix.mat4.create();
        try { this._init(); } catch (error) { console.warn('Weapon renderer unavailable:', error); }
    }

    _init() {
        const gl = this.gl;
        if (!gl) return;
        const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
        const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const message = gl.getProgramInfoLog(program) || 'Unknown program link error';
            gl.deleteProgram(program);
            throw new Error(message);
        }

        const positions = new Float32Array([
            -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
            -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
        ]);
        const triangles = new Uint16Array([
            0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
            0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2,
            2, 6, 7, 2, 7, 3, 4, 0, 3, 4, 3, 7,
        ]);
        const lines = new Uint16Array([
            0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6,
            6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7,
        ]);
        this.positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
        this.triangleIndexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.triangleIndexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, triangles, gl.STATIC_DRAW);
        this.lineIndexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.lineIndexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, lines, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

        this.program = program;
        this.locations = {
            position: gl.getAttribLocation(program, 'aPosition'),
            viewProjection: gl.getUniformLocation(program, 'uViewProjection'),
            model: gl.getUniformLocation(program, 'uModel'),
            color: gl.getUniformLocation(program, 'uColor'),
        };
        this.triangleCount = triangles.length;
        this.lineCount = lines.length;
        this.ready = true;
    }

    render(app, viewProjection, { wireframe = false, drawFallbackModel = true } = {}) {
        if (!this.ready || !app?.weaponController || !app?.ped) return;
        const state = app.weaponController.getRenderState();
        const pose = app.weaponController.getWeaponPoseData();
        if (!state?.visible || !pose) return;
        const basis = this._viewerBasis(app, pose);
        if (!basis) return;

        const gl = this.gl;
        const prevBlend = gl.isEnabled(gl.BLEND);
        const prevCull = gl.isEnabled(gl.CULL_FACE);
        const prevDepthMask = gl.getParameter(gl.DEPTH_WRITEMASK);
        try {
            gl.useProgram(this.program);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
            gl.enableVertexAttribArray(this.locations.position);
            gl.vertexAttribPointer(this.locations.position, 3, gl.FLOAT, false, 0, 0);
            gl.uniformMatrix4fv(this.locations.viewProjection, false, viewProjection);
            gl.disable(gl.CULL_FACE);
            gl.depthMask(true);

            const steel = wireframe ? [0.82, 1.0, 0.90, 1.0] : [0.10, 0.12, 0.14, 1.0];
            const polymer = wireframe ? steel : [0.055, 0.065, 0.075, 1.0];
            const switchColor = wireframe ? [0.98, 0.75, 0.3, 1.0] : [0.32, 0.36, 0.34, 1.0];
            const kick = Math.max(0.0, Math.min(1.0, Number(state.recoilKick) || 0.0));
            const visualForward = Array.isArray(pose.visualDirection) ? pose.visualDirection : pose.direction;

            if (drawFallbackModel) {
                this._drawBox(viewProjection, basis, addScaled(pose.hand, visualForward, 0.13 - kick * 0.035), [0.11, 0.10, 0.32], steel, wireframe);
                this._drawBox(viewProjection, basis, addScaled(pose.hand, visualForward, 0.08 - kick * 0.025), [0.13, 0.12, 0.27], polymer, wireframe);
                this._drawBox(viewProjection, basis, addScaled(addScaled(pose.hand, visualForward, -0.06), basis.upData, -0.17), [0.10, 0.26, 0.12], polymer, wireframe);
                this._drawBox(viewProjection, basis, addScaled(pose.hand, visualForward, 0.30 - kick * 0.035), [0.055, 0.055, 0.15], steel, wireframe);
            }
            if (state.automatic) {
                this._drawBox(viewProjection, basis, addScaled(addScaled(pose.hand, pose.direction, -0.08), basis.rightData, -0.075), [0.04, 0.06, 0.075], switchColor, wireframe);
            }

            if (state.shotPulse > 0.0) {
                const muzzle = app.weaponController._muzzleDataPosition(pose.direction);
                this._drawBox(viewProjection, basis, muzzle, [0.10, 0.10, 0.10], [1.0, 0.72, 0.2, 1.0], false);
            }
            if (state.tracer) this._drawTracer(app, state.tracer, wireframe);
        } finally {
            try { gl.disableVertexAttribArray(this.locations.position); } catch { /* ignore */ }
            try { gl.bindBuffer(gl.ARRAY_BUFFER, null); } catch { /* ignore */ }
            try { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null); } catch { /* ignore */ }
            try { if (prevCull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE); } catch { /* ignore */ }
            try { gl.depthMask(!!prevDepthMask); } catch { /* ignore */ }
            try { if (prevBlend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND); } catch { /* ignore */ }
        }
    }

    renderNpcEffects(app, viewProjection, { wireframe = false } = {}) {
        const effects = app?.npcSystem?.shotEffects || [];
        if (!this.ready || !effects.length) return;
        const gl = this.gl;
        const prevBlend = gl.isEnabled(gl.BLEND);
        const prevCull = gl.isEnabled(gl.CULL_FACE);
        const prevDepthMask = gl.getParameter(gl.DEPTH_WRITEMASK);
        try {
            gl.useProgram(this.program);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
            gl.enableVertexAttribArray(this.locations.position);
            gl.vertexAttribPointer(this.locations.position, 3, gl.FLOAT, false, 0, 0);
            gl.uniformMatrix4fv(this.locations.viewProjection, false, viewProjection);
            gl.disable(gl.CULL_FACE);
            gl.depthMask(true);
            for (const effect of effects) {
                if (!Array.isArray(effect?.startData) || !Array.isArray(effect?.endData)) continue;
                this._drawTracer(app, effect, wireframe);
                const direction = normalize(subtract(effect.endData, effect.startData));
                const right = normalize([-direction[1], direction[0], 0.0]);
                const basis = this._viewerBasis(app, {
                    hand: effect.startData,
                    direction,
                    right,
                    visualUp: [0.0, 0.0, 1.0],
                });
                if (basis) this._drawBox(viewProjection, basis, effect.startData, [0.095, 0.095, 0.13], [1.0, 0.72, 0.2, 1.0], false);
            }
        } finally {
            try { gl.disableVertexAttribArray(this.locations.position); } catch { /* ignore */ }
            try { gl.bindBuffer(gl.ARRAY_BUFFER, null); } catch { /* ignore */ }
            try { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null); } catch { /* ignore */ }
            try { if (prevCull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE); } catch { /* ignore */ }
            try { gl.depthMask(!!prevDepthMask); } catch { /* ignore */ }
            try { if (prevBlend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND); } catch { /* ignore */ }
        }
    }

    _viewerBasis(app, pose) {
        const base = app._dataToViewer(pose.hand);
        const forwardData = Array.isArray(pose.visualDirection) ? pose.visualDirection : pose.direction;
        const rightData = Array.isArray(pose.visualRight) ? pose.visualRight : pose.right;
        const upData = Array.isArray(pose.visualUp) ? pose.visualUp : [0.0, 0.0, 1.0];
        const forwardPoint = app._dataToViewer(addScaled(pose.hand, forwardData, 1.0));
        const rightPoint = app._dataToViewer(addScaled(pose.hand, rightData, 1.0));
        const upPoint = app._dataToViewer(addScaled(pose.hand, upData, 1.0));
        return {
            origin: base,
            handData: pose.hand,
            forward: normalize(subtract(forwardPoint, base)),
            right: normalize(subtract(rightPoint, base)),
            up: normalize(subtract(upPoint, base)),
            forwardData,
            rightData,
            upData,
        };
    }

    _drawBox(viewProjection, basis, centerData, dimensions, color, wireframe) {
        // The basis came from one data-space hand origin. Rebase the part through its local offsets.
        const dx = centerData[0] - basis.handData[0];
        const dy = centerData[1] - basis.handData[1];
        const dz = centerData[2] - basis.handData[2];
        const origin = [
            basis.origin[0] + basis.right[0] * (dx * basis.rightData[0] + dy * basis.rightData[1]) + basis.forward[0] * (dx * basis.forwardData[0] + dy * basis.forwardData[1]) + basis.up[0] * dz,
            basis.origin[1] + basis.right[1] * (dx * basis.rightData[0] + dy * basis.rightData[1]) + basis.forward[1] * (dx * basis.forwardData[0] + dy * basis.forwardData[1]) + basis.up[1] * dz,
            basis.origin[2] + basis.right[2] * (dx * basis.rightData[0] + dy * basis.rightData[1]) + basis.forward[2] * (dx * basis.forwardData[0] + dy * basis.forwardData[1]) + basis.up[2] * dz,
        ];
        const x = basis.right.map((v) => v * dimensions[0]);
        const y = basis.up.map((v) => v * dimensions[1]);
        const z = basis.forward.map((v) => v * dimensions[2]);
        glMatrix.mat4.set(this._model,
            x[0], x[1], x[2], 0,
            y[0], y[1], y[2], 0,
            z[0], z[1], z[2], 0,
            origin[0], origin[1], origin[2], 1,
        );
        const gl = this.gl;
        gl.uniformMatrix4fv(this.locations.model, false, this._model);
        gl.uniform4fv(this.locations.color, color);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wireframe ? this.lineIndexBuffer : this.triangleIndexBuffer);
        gl.drawElements(wireframe ? gl.LINES : gl.TRIANGLES, wireframe ? this.lineCount : this.triangleCount, gl.UNSIGNED_SHORT, 0);
    }

    _drawTracer(app, tracer, wireframe) {
        const start = app._dataToViewer(tracer.startData);
        const end = app._dataToViewer(tracer.endData);
        const forward = subtract(end, start);
        const length = Math.hypot(forward[0], forward[1], forward[2]);
        if (length <= 1e-4) return;
        const direction = normalize(forward);
        const up = Math.abs(direction[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        const right = normalize([
            direction[1] * up[2] - direction[2] * up[1],
            direction[2] * up[0] - direction[0] * up[2],
            direction[0] * up[1] - direction[1] * up[0],
        ]);
        const vertical = normalize([
            right[1] * direction[2] - right[2] * direction[1],
            right[2] * direction[0] - right[0] * direction[2],
            right[0] * direction[1] - right[1] * direction[0],
        ]);
        const mid = [(start[0] + end[0]) * 0.5, (start[1] + end[1]) * 0.5, (start[2] + end[2]) * 0.5];
        const x = right.map((v) => v * 0.012);
        const y = vertical.map((v) => v * 0.012);
        const z = direction.map((v) => v * length);
        glMatrix.mat4.set(this._model,
            x[0], x[1], x[2], 0,
            y[0], y[1], y[2], 0,
            z[0], z[1], z[2], 0,
            mid[0], mid[1], mid[2], 1,
        );
        const gl = this.gl;
        gl.uniformMatrix4fv(this.locations.model, false, this._model);
        gl.uniform4fv(this.locations.color, wireframe ? [1.0, 0.84, 0.34, 1.0] : [1.0, 0.55, 0.12, 1.0]);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wireframe ? this.lineIndexBuffer : this.triangleIndexBuffer);
        gl.drawElements(wireframe ? gl.LINES : gl.TRIANGLES, wireframe ? this.lineCount : this.triangleCount, gl.UNSIGNED_SHORT, 0);
    }

    destroy() {
        const gl = this.gl;
        try { if (this.positionBuffer) gl.deleteBuffer(this.positionBuffer); } catch { /* ignore */ }
        try { if (this.triangleIndexBuffer) gl.deleteBuffer(this.triangleIndexBuffer); } catch { /* ignore */ }
        try { if (this.lineIndexBuffer) gl.deleteBuffer(this.lineIndexBuffer); } catch { /* ignore */ }
        try { if (this.program) gl.deleteProgram(this.program); } catch { /* ignore */ }
        this.ready = false;
    }
}

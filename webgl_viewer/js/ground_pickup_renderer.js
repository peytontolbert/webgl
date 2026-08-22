import { glMatrix } from './glmatrix.js';
import { ShaderProgram } from './shader_program.js';

const vsSource = `#version 300 es
in vec2 aPosition;

uniform mat4 uViewProjectionMatrix;
uniform mat4 uModelMatrix;
uniform vec3 uCenterData;
uniform vec3 uCameraRight;
uniform vec3 uCameraUp;
uniform float uSize;

out vec2 vUv;

void main() {
    vec3 centerView = (uModelMatrix * vec4(uCenterData, 1.0)).xyz;
    vec3 offset = (uCameraRight * aPosition.x + uCameraUp * aPosition.y) * uSize;
    gl_Position = uViewProjectionMatrix * vec4(centerView + offset, 1.0);
    vUv = aPosition * 0.5 + 0.5;
}
`;

const fsSource = `#version 300 es
precision mediump float;

in vec2 vUv;
out vec4 fragColor;

uniform vec3 uColor;
uniform float uType;
uniform float uPulse;
uniform bool uOutputSrgb;

vec3 linearToSrgb(vec3 value) {
    vec3 low = value * 12.92;
    vec3 high = 1.055 * pow(max(value, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
    return mix(high, low, lessThanEqual(value, vec3(0.0031308)));
}

void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float alpha = 0.0;
    float detail = 0.0;

    if (uType < 0.5) {
        float torsoHalf = mix(0.39, 0.56, clamp((0.42 - p.y) / 1.15, 0.0, 1.0));
        float torso = step(-0.73, p.y) * step(p.y, 0.42) * step(abs(p.x), torsoHalf);
        float shoulders = step(0.08, p.y) * step(p.y, 0.58) * step(abs(p.x), 0.73);
        float neck = step(0.30, p.y) * step(abs(p.x), 0.22);
        alpha = max(torso, shoulders) * (1.0 - neck);
        detail = step(abs(p.x), 0.035) * step(-0.58, p.y) * step(p.y, 0.24);
        detail = max(detail, step(abs(p.y + 0.10), 0.035) * step(abs(p.x), 0.42));
    } else if (uType < 1.5) {
        alpha = step(abs(p.x), 0.70) * step(abs(p.y), 0.52);
        float stripe = step(abs(fract((p.x + 0.62) * 3.1) - 0.5), 0.18);
        detail = stripe * step(-0.28, p.y) * step(p.y, 0.34) * alpha;
    } else if (uType < 2.5) {
        alpha = step(abs(p.x), 0.75) * step(abs(p.y), 0.43);
        float band = step(abs(p.x), 0.18) * alpha;
        float center = 1.0 - smoothstep(0.13, 0.19, length(p * vec2(1.0, 1.5)));
        detail = max(band, center) * alpha;
    } else {
        // A compact leaf/stem marker is used while the authoritative GTA prop
        // streams. It also keeps unknown harvest pickups visible on low memory
        // clients where their full drawable was evicted.
        float stem = step(abs(p.x + 0.03), 0.055) * step(-0.78, p.y) * step(p.y, 0.55);
        float leafA = 1.0 - smoothstep(0.18, 0.42, length((p - vec2(-0.26, 0.12)) * vec2(1.0, 1.65)));
        float leafB = 1.0 - smoothstep(0.18, 0.42, length((p - vec2(0.25, -0.12)) * vec2(1.0, 1.65)));
        alpha = max(stem, max(leafA, leafB));
        detail = stem * 0.75;
    }

    float halo = (1.0 - smoothstep(0.58, 0.96, length(p))) * (1.0 - alpha) * 0.22;
    if (alpha + halo < 0.015) discard;
    vec3 color = mix(uColor * 0.34, uColor, alpha);
    color = mix(color, vec3(0.92, 0.98, 1.0), detail * 0.72);
    color *= 0.88 + uPulse * 0.22;
    if (uOutputSrgb) color = linearToSrgb(color);
    fragColor = vec4(color, max(alpha * 0.94, halo));
}
`;

const TYPE_INDEX = Object.freeze({ armor: 0, ammo: 1, cash: 2, coca_leaves: 3 });
const TYPE_COLOR = Object.freeze({ armor: [0.08, 0.52, 1.0], ammo: [1.0, 0.56, 0.06], cash: [0.12, 0.82, 0.28], coca_leaves: [0.23, 0.88, 0.18] });

function pickupVisualType(value) {
    const type = String(value || '').trim().toLowerCase();
    if (Object.hasOwn(TYPE_INDEX, type)) return type;
    if (/(?:coca|coke|drug|herb|plant|harvest)/.test(type)) return 'coca_leaves';
    return 'cash';
}

export class GroundPickupRenderer {
    constructor(gl) {
        this.gl = gl;
        this.program = new ShaderProgram(gl);
        this.modelMatrix = glMatrix.mat4.create();
        this.ready = false;
        this.vao = null;
        this.buffer = null;
        this.lastStatus = { available: 0, rendered: 0, skippedDistance: 0 };
    }

    async init(modelMatrix = null) {
        await this.program.createProgram(vsSource, fsSource);
        if (modelMatrix) glMatrix.mat4.copy(this.modelMatrix, modelMatrix);
        const gl = this.gl;
        this.uniforms = {
            viewProjection: gl.getUniformLocation(this.program.program, 'uViewProjectionMatrix'),
            model: gl.getUniformLocation(this.program.program, 'uModelMatrix'),
            centerData: gl.getUniformLocation(this.program.program, 'uCenterData'),
            cameraRight: gl.getUniformLocation(this.program.program, 'uCameraRight'),
            cameraUp: gl.getUniformLocation(this.program.program, 'uCameraUp'),
            size: gl.getUniformLocation(this.program.program, 'uSize'),
            color: gl.getUniformLocation(this.program.program, 'uColor'),
            type: gl.getUniformLocation(this.program.program, 'uType'),
            pulse: gl.getUniformLocation(this.program.program, 'uPulse'),
            outputSrgb: gl.getUniformLocation(this.program.program, 'uOutputSrgb'),
        };
        const positionLoc = gl.getAttribLocation(this.program.program, 'aPosition');
        this.vao = gl.createVertexArray();
        this.buffer = gl.createBuffer();
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(positionLoc);
        gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        this.ready = true;
    }

    render(viewProjectionMatrix, camera, pickups, { outputSrgb = true, maxDistance = 180.0, timeSeconds = 0.0 } = {}) {
        if (!this.ready || !camera || !Array.isArray(pickups)) return;
        const available = pickups.filter((pickup) => pickup?.available !== false);
        const cameraData = camera.positionData || null;
        const forward = camera.direction || [0, 0, -1];
        const worldUp = camera.up || [0, 1, 0];
        const right = glMatrix.vec3.create();
        glMatrix.vec3.cross(right, forward, worldUp);
        if (glMatrix.vec3.length(right) < 1e-5) glMatrix.vec3.set(right, 1, 0, 0);
        else glMatrix.vec3.normalize(right, right);
        const up = glMatrix.vec3.create();
        glMatrix.vec3.cross(up, right, forward);
        glMatrix.vec3.normalize(up, up);

        const gl = this.gl;
        const blendWasEnabled = gl.isEnabled(gl.BLEND);
        const cullWasEnabled = gl.isEnabled(gl.CULL_FACE);
        const depthMaskWas = gl.getParameter(gl.DEPTH_WRITEMASK);
        gl.useProgram(this.program.program);
        gl.uniformMatrix4fv(this.uniforms.viewProjection, false, viewProjectionMatrix);
        gl.uniformMatrix4fv(this.uniforms.model, false, this.modelMatrix);
        gl.uniform3fv(this.uniforms.cameraRight, right);
        gl.uniform3fv(this.uniforms.cameraUp, up);
        gl.uniform1i(this.uniforms.outputSrgb, outputSrgb ? 1 : 0);
        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        gl.disable(gl.CULL_FACE);
        gl.bindVertexArray(this.vao);

        let rendered = 0;
        let skippedDistance = 0;
        for (const pickup of available) {
            const x = Number(pickup.x);
            const y = Number(pickup.y);
            const z = Number(pickup.feetZ);
            if (![x, y, z].every(Number.isFinite)) continue;
            if (cameraData && Math.hypot(x - cameraData[0], y - cameraData[1], z - cameraData[2]) > maxDistance) {
                skippedDistance++;
                continue;
            }
            const typeName = pickupVisualType(pickup.type);
            const phase = (timeSeconds * 2.2) + rendered * 1.7;
            const bob = Math.sin(phase) * 0.055;
            gl.uniform3f(this.uniforms.centerData, x, y, z + 0.68 + bob);
            gl.uniform1f(this.uniforms.size, 0.52 + Math.sin(phase) * 0.018);
            gl.uniform3fv(this.uniforms.color, TYPE_COLOR[typeName]);
            gl.uniform1f(this.uniforms.type, TYPE_INDEX[typeName]);
            gl.uniform1f(this.uniforms.pulse, 0.5 + Math.sin(phase) * 0.5);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            rendered++;
        }

        gl.bindVertexArray(null);
        gl.depthMask(depthMaskWas);
        if (!blendWasEnabled) gl.disable(gl.BLEND);
        if (cullWasEnabled) gl.enable(gl.CULL_FACE);
        this.lastStatus = { available: available.length, rendered, skippedDistance };
    }

    destroy() {
        if (this.vao) this.gl.deleteVertexArray(this.vao);
        if (this.buffer) this.gl.deleteBuffer(this.buffer);
        this.program.dispose();
        this.vao = null;
        this.buffer = null;
        this.ready = false;
    }
}

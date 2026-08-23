import { glMatrix } from './glmatrix.js';

function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader) || 'mirror shader compile failed';
        gl.deleteShader(shader);
        throw new Error(message);
    }
    return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
    const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const message = gl.getProgramInfoLog(program) || 'mirror program link failed';
        gl.deleteProgram(program);
        throw new Error(message);
    }
    return program;
}

function transformPoint(matrix, point) {
    const input = glMatrix.vec4.fromValues(Number(point[0]), Number(point[1]), Number(point[2]), 1);
    const output = glMatrix.vec4.create();
    glMatrix.vec4.transformMat4(output, input, matrix);
    return [output[0], output[1], output[2]];
}

function portalPlane(corners, cameraPosition) {
    if (!Array.isArray(corners) || corners.length < 3) return null;
    const a = corners[0]; const b = corners[1]; const c = corners[2];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let normal = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const length = Math.hypot(...normal);
    if (length < 1e-6) return null;
    normal = normal.map((value) => value / length);
    let distance = -(normal[0] * a[0] + normal[1] * a[1] + normal[2] * a[2]);
    if (normal[0] * cameraPosition[0] + normal[1] * cameraPosition[1] + normal[2] * cameraPosition[2] + distance < 0) {
        normal = normal.map((value) => -value);
        distance = -distance;
    }
    return [normal[0], normal[1], normal[2], distance];
}

function reflectionMatrix(plane) {
    const [x, y, z, d] = plane;
    const out = glMatrix.mat4.create();
    out[0] = 1 - 2 * x * x; out[4] = -2 * x * y; out[8] = -2 * x * z; out[12] = -2 * d * x;
    out[1] = -2 * y * x; out[5] = 1 - 2 * y * y; out[9] = -2 * y * z; out[13] = -2 * d * y;
    out[2] = -2 * z * x; out[6] = -2 * z * y; out[10] = 1 - 2 * z * z; out[14] = -2 * d * z;
    return out;
}

function reflectedPoint(point, plane) {
    const distance = plane[0] * point[0] + plane[1] * point[1] + plane[2] * point[2] + plane[3];
    return [
        point[0] - 2 * distance * plane[0],
        point[1] - 2 * distance * plane[1],
        point[2] - 2 * distance * plane[2],
    ];
}

function obliqueProjection(projection, reflectedView, planeWorld) {
    const output = glMatrix.mat4.clone(projection);
    const inverseView = glMatrix.mat4.create();
    if (!glMatrix.mat4.invert(inverseView, reflectedView)) return output;
    glMatrix.mat4.transpose(inverseView, inverseView);
    const cameraPlane = glMatrix.vec4.create();
    glMatrix.vec4.transformMat4(cameraPlane, planeWorld, inverseView);
    const planeLength = Math.hypot(cameraPlane[0], cameraPlane[1], cameraPlane[2]);
    if (planeLength < 1e-6) return output;
    for (let i = 0; i < 4; i++) cameraPlane[i] /= planeLength;
    // The reflected camera is behind the plane. Orient the oblique near plane
    // toward it so geometry behind the physical mirror is rejected.
    if (cameraPlane[3] > 0) for (let i = 0; i < 4; i++) cameraPlane[i] = -cameraPlane[i];
    const sign = (value) => value >= 0 ? 1 : -1;
    const q = [
        (sign(cameraPlane[0]) + output[8]) / output[0],
        (sign(cameraPlane[1]) + output[9]) / output[5],
        -1,
        (1 + output[10]) / output[14],
    ];
    const denominator = cameraPlane[0] * q[0] + cameraPlane[1] * q[1] + cameraPlane[2] * q[2] + cameraPlane[3] * q[3];
    if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-6) return output;
    const scale = 2 / denominator;
    output[2] = cameraPlane[0] * scale;
    output[6] = cameraPlane[1] * scale;
    output[10] = cameraPlane[2] * scale + 1;
    output[14] = cameraPlane[3] * scale;
    return output;
}

export function buildMloMirrorCamera({ portal, camera, dataToViewMatrix }) {
    const corners = (portal?.cornersData || []).map((point) => transformPoint(dataToViewMatrix, point));
    const plane = portalPlane(corners, camera?.position || [0, 0, 0]);
    if (!plane) return null;
    const reflection = reflectionMatrix(plane);
    const reflectedView = glMatrix.mat4.create();
    glMatrix.mat4.multiply(reflectedView, camera.viewMatrix, reflection);
    const clipPlane = glMatrix.vec4.fromValues(plane[0], plane[1], plane[2], plane[3] - 0.025);
    const projection = obliqueProjection(camera.projectionMatrix, reflectedView, clipPlane);
    const viewProjection = glMatrix.mat4.create();
    glMatrix.mat4.multiply(viewProjection, projection, reflectedView);
    return {
        corners,
        plane,
        reflectedPosition: reflectedPoint(camera.position, plane),
        viewProjection,
    };
}

export class MloMirrorRenderer {
    constructor(gl) {
        this.gl = gl;
        this.ready = false;
        this.size = 0;
        this.framebuffer = null;
        this.texture = null;
        this.depth = null;
        this.vertexBuffer = null;
        this.vertexArray = null;
        this.program = null;
        this.uniforms = null;
        this.state = null;
        this.stats = { active: false, reflectionFrames: 0, surfaceFrames: 0, size: 0, lastError: null };
    }

    init() {
        if (this.ready) return true;
        const gl = this.gl;
        if (typeof gl?.createVertexArray !== 'function' || typeof gl?.bindVertexArray !== 'function') {
            this.stats.lastError = 'Planar mirrors require WebGL2 vertex arrays';
            return false;
        }
        this.program = createProgram(gl, `#version 300 es
            precision highp float;
            layout(location=0) in vec3 aPosition;
            uniform mat4 uViewProjection;
            uniform mat4 uReflectionViewProjection;
            out vec4 vReflectionClip;
            void main() {
                vec4 world = vec4(aPosition, 1.0);
                gl_Position = uViewProjection * world;
                vReflectionClip = uReflectionViewProjection * world;
            }
        `, `#version 300 es
            precision highp float;
            uniform sampler2D uReflection;
            in vec4 vReflectionClip;
            out vec4 outColor;
            void main() {
                vec2 uv = vReflectionClip.xy / max(1e-5, vReflectionClip.w) * 0.5 + 0.5;
                if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
                vec3 reflected = texture(uReflection, uv).rgb;
                outColor = vec4(reflected * 0.94 + vec3(0.015, 0.02, 0.025), 1.0);
            }
        `);
        this.vertexBuffer = gl.createBuffer();
        this.vertexArray = gl.createVertexArray();
        gl.bindVertexArray(this.vertexArray);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
        gl.bindVertexArray(null);
        this.uniforms = {
            viewProjection: gl.getUniformLocation(this.program, 'uViewProjection'),
            reflectionViewProjection: gl.getUniformLocation(this.program, 'uReflectionViewProjection'),
            reflection: gl.getUniformLocation(this.program, 'uReflection'),
        };
        this.ready = true;
        return true;
    }

    _ensureTarget(size) {
        const gl = this.gl;
        const targetSize = Math.max(256, Math.min(1024, Math.floor(Number(size) || 512)));
        if (this.framebuffer && this.size === targetSize) return true;
        if (this.texture) gl.deleteTexture(this.texture);
        if (this.depth) gl.deleteRenderbuffer(this.depth);
        if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
        this.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, targetSize, targetSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        this.depth = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, targetSize, targetSize);
        this.framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
        const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        this.size = complete ? targetSize : 0;
        this.stats.size = this.size;
        if (!complete) this.stats.lastError = `Mirror framebuffer incomplete (${gl.checkFramebufferStatus(gl.FRAMEBUFFER)})`;
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return complete;
    }

    renderReflection({ portal, camera, dataToViewMatrix, size = 512, drawScene, clearColor = [0.02, 0.025, 0.035], restoreFramebuffer = null, restoreWidth = 1, restoreHeight = 1 }) {
        if (!portal || !camera || typeof drawScene !== 'function') { this.state = null; return false; }
        if (!this.init() || !this._ensureTarget(size)) return false;
        const state = buildMloMirrorCamera({ portal, camera, dataToViewMatrix });
        if (!state) return false;
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
        gl.viewport(0, 0, this.size, this.size);
        gl.clearColor(Number(clearColor[0]) || 0, Number(clearColor[1]) || 0, Number(clearColor[2]) || 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        // Reflection reverses winding. Preserve culling efficiency by reversing
        // the front face for the reflected scene instead of disabling culling.
        const cullEnabled = gl.isEnabled(gl.CULL_FACE);
        gl.frontFace(gl.CW);
        try {
            drawScene(state.viewProjection, state.reflectedPosition, this.framebuffer, this.size);
        } finally {
            gl.frontFace(gl.CCW);
            if (cullEnabled) gl.enable(gl.CULL_FACE);
            else gl.disable(gl.CULL_FACE);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, restoreFramebuffer);
        gl.viewport(0, 0, restoreWidth, restoreHeight);
        this.state = state;
        this.stats.active = true;
        this.stats.reflectionFrames++;
        this.stats.lastError = null;
        return true;
    }

    renderSurface(viewProjection, { restoreFramebuffer = null, restoreWidth = 1, restoreHeight = 1 } = {}) {
        const state = this.state;
        if (!this.ready || !state?.corners?.length || !this.texture) return false;
        const gl = this.gl;
        const corners = state.corners;
        const values = [];
        for (let index = 1; index + 1 < corners.length; index++) {
            for (const point of [corners[0], corners[index], corners[index + 1]]) values.push(...point);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, restoreFramebuffer);
        gl.viewport(0, 0, restoreWidth, restoreHeight);
        gl.useProgram(this.program);
        gl.bindVertexArray(this.vertexArray);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(values), gl.DYNAMIC_DRAW);
        gl.uniformMatrix4fv(this.uniforms.viewProjection, false, viewProjection);
        gl.uniformMatrix4fv(this.uniforms.reflectionViewProjection, false, state.viewProjection);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.uniform1i(this.uniforms.reflection, 0);
        gl.enable(gl.DEPTH_TEST);
        const previousDepthMask = gl.getParameter(gl.DEPTH_WRITEMASK);
        const blendEnabled = gl.isEnabled(gl.BLEND);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        const cullEnabled = gl.isEnabled(gl.CULL_FACE);
        if (cullEnabled) gl.disable(gl.CULL_FACE);
        gl.drawArrays(gl.TRIANGLES, 0, values.length / 3);
        gl.bindVertexArray(null);
        if (cullEnabled) gl.enable(gl.CULL_FACE);
        if (blendEnabled) gl.enable(gl.BLEND);
        else gl.disable(gl.BLEND);
        gl.depthMask(previousDepthMask);
        this.stats.surfaceFrames++;
        return true;
    }

    destroy() {
        const gl = this.gl;
        if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer);
        if (this.vertexArray) gl.deleteVertexArray(this.vertexArray);
        if (this.texture) gl.deleteTexture(this.texture);
        if (this.depth) gl.deleteRenderbuffer(this.depth);
        if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
        if (this.program) gl.deleteProgram(this.program);
        this.ready = false;
        this.state = null;
        this.stats.active = false;
    }
}

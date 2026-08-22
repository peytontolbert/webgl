import { glMatrix } from './glmatrix.js';
import { ShaderProgram } from './shader_program.js';

const vertexSource = `#version 300 es
in vec3 aPosition;
uniform mat4 uViewProjectionMatrix;
uniform mat4 uModelMatrix;
out float vHeight;
void main() {
    vHeight = aPosition.z;
    gl_Position = uViewProjectionMatrix * uModelMatrix * vec4(aPosition, 1.0);
}`;

const fragmentSource = `#version 300 es
precision mediump float;
in float vHeight;
out vec4 fragColor;
void main() {
    float variation = 0.035 * sin(vHeight * 0.17);
    fragColor = vec4(vec3(0.105 + variation, 0.12 + variation, 0.125 + variation), 1.0);
}`;

function decodeRoad(buffer) {
    if (buffer.byteLength < 44) throw new Error('Derived road binary is truncated');
    const view = new DataView(buffer);
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    const version = view.getUint32(4, true);
    const vertexCount = view.getUint32(8, true);
    const segmentCount = view.getUint32(12, true);
    if (magic !== 'NRB1' || version !== 1 || vertexCount < 4 || vertexCount !== (segmentCount + 1) * 2) throw new Error('Derived road binary header is invalid');
    const minimum = [view.getFloat32(20, true), view.getFloat32(24, true), view.getFloat32(28, true)];
    const span = [view.getFloat32(32, true), view.getFloat32(36, true), view.getFloat32(40, true)];
    if (![...minimum, ...span].every(Number.isFinite) || span.some((value) => value <= 0)) throw new Error('Derived road quantization bounds are invalid');
    const expected = 44 + vertexCount * 3 * Uint16Array.BYTES_PER_ELEMENT;
    if (buffer.byteLength < expected) throw new Error('Derived road position buffer is truncated');
    const packed = new Uint16Array(buffer, 44, vertexCount * 3);
    const positions = new Float32Array(vertexCount * 3);
    for (let i = 0; i < positions.length; i++) positions[i] = minimum[i % 3] + (packed[i] / 65535.0) * span[i % 3];
    return { positions, vertexCount, segmentCount };
}

export class TrackRoadRenderer {
    constructor(gl) {
        this.gl = gl;
        this.program = new ShaderProgram(gl);
        this.modelMatrix = glMatrix.mat4.create();
        this.ready = false;
        this.vertexCount = 0;
        this.metadata = null;
        this._vao = null;
        this._positionBuffer = null;
    }

    async init(modelMatrix = null) {
        await this.program.createProgram(vertexSource, fragmentSource);
        if (modelMatrix) glMatrix.mat4.copy(this.modelMatrix, modelMatrix);
        const gl = this.gl;
        this.uniforms = {
            viewProjection: gl.getUniformLocation(this.program.program, 'uViewProjectionMatrix'),
            model: gl.getUniformLocation(this.program.program, 'uModelMatrix'),
        };
        const position = gl.getAttribLocation(this.program.program, 'aPosition');
        this._vao = gl.createVertexArray();
        this._positionBuffer = gl.createBuffer();
        gl.bindVertexArray(this._vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._positionBuffer);
        gl.enableVertexAttribArray(position);
        gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        this.ready = true;
    }

    async load(metaUrl = 'assets/tracks/nordschleife/road.json') {
        const response = await fetch(metaUrl, { cache: 'no-store' });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`Derived road metadata request failed (${response.status})`);
        const metadata = await response.json();
        if (metadata?.schema !== 'webglgta-derived-road-v1' || !metadata?.file) throw new Error('Derived road metadata is invalid');
        const binaryUrl = new URL(String(metadata.file), new URL(metaUrl, window.location.href));
        const binaryResponse = await fetch(binaryUrl, { cache: 'no-store' });
        if (!binaryResponse.ok) throw new Error(`Derived road binary request failed (${binaryResponse.status})`);
        const decoded = decodeRoad(await binaryResponse.arrayBuffer());
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this._positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, decoded.positions, gl.STATIC_DRAW);
        this.vertexCount = decoded.vertexCount;
        this.metadata = metadata;
        return metadata;
    }

    render(viewProjectionMatrix, { fastStateRestore = false } = {}) {
        if (!this.ready || this.vertexCount < 4) return;
        const gl = this.gl;
        const cullWasEnabled = fastStateRestore ? false : gl.isEnabled(gl.CULL_FACE);
        gl.useProgram(this.program.program);
        gl.uniformMatrix4fv(this.uniforms.viewProjection, false, viewProjectionMatrix);
        gl.uniformMatrix4fv(this.uniforms.model, false, this.modelMatrix);
        gl.enable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        gl.bindVertexArray(this._vao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, this.vertexCount);
        gl.bindVertexArray(null);
        if (cullWasEnabled) gl.enable(gl.CULL_FACE);
    }
}

import { ShaderProgram } from './shader_program.js';

const vsSource = `#version 300 es
    layout(location = 0) in vec3 aPosition;
    layout(location = 1) in vec3 aNormal;

    layout(location = 3) in vec4 iM0;
    layout(location = 4) in vec4 iM1;
    layout(location = 5) in vec4 iM2;
    layout(location = 6) in vec4 iM3;

    uniform mat4 uViewProjectionMatrix;
    uniform mat4 uModelMatrix;
    uniform vec3 uColor;

    out vec3 vColor;
    out vec3 vNormal;

    void main() {
        mat4 imat = mat4(iM0, iM1, iM2, iM3);
        vec4 worldPos = uModelMatrix * (imat * vec4(aPosition, 1.0));
        gl_Position = uViewProjectionMatrix * worldPos;
        vNormal = normalize((uModelMatrix * (imat * vec4(aNormal, 0.0))).xyz);
        vColor = uColor;
    }
`;

const fsSource = `#version 300 es
    precision mediump float;

    in vec3 vColor;
    in vec3 vNormal;

    uniform vec3 uLightDir;
    uniform float uAmbient;

    out vec4 fragColor;

    void main() {
        vec3 n = normalize(vNormal);
        float ndotl = max(dot(n, normalize(uLightDir)), 0.0);
        float lit = clamp(uAmbient + ndotl * (1.0 - uAmbient), 0.0, 1.0);
        fragColor = vec4(vColor * lit, 1.0);
    }
`;

export class InstancedModelsRenderer {
    constructor(gl, modelManager) {
        this.gl = gl;
        this.modelManager = modelManager;
        this.program = new ShaderProgram(gl);
        this.uniforms = null;

        // chunkKey -> Map(hash -> { mats: Float32Array, count: number, color:[r,g,b] })
        this.chunks = new Map();
        // hash -> { instanceVbo, instanceCount, color:[r,g,b] }
        this.instances = new Map();
        this._ready = false;
    }

    async init() {
        const ok = await this.program.createProgram(vsSource, fsSource);
        if (!ok || !this.program.program) return false;
        this.uniforms = {
            uViewProjectionMatrix: this.gl.getUniformLocation(this.program.program, 'uViewProjectionMatrix'),
            uModelMatrix: this.gl.getUniformLocation(this.program.program, 'uModelMatrix'),
            uColor: this.gl.getUniformLocation(this.program.program, 'uColor'),
            uLightDir: this.gl.getUniformLocation(this.program.program, 'uLightDir'),
            uAmbient: this.gl.getUniformLocation(this.program.program, 'uAmbient'),
        };
        this._ready = true;
        return true;
    }

    setChunk(chunkKey, byHash) {
        if (!this._ready) return;
        const key = String(chunkKey ?? '').trim();
        if (!key) return;
        const prev = this.chunks.get(key);
        this.chunks.set(key, byHash || new Map());
        // Rebuild any affected hashes
        const affected = new Set();
        if (prev) for (const h of prev.keys()) affected.add(h);
        if (byHash) for (const h of byHash.keys()) affected.add(h);
        for (const h of affected) this._rebuildHash(h);
    }

    deleteChunk(chunkKey) {
        const key = String(chunkKey ?? '').trim();
        if (!key) return;
        const prev = this.chunks.get(key);
        if (!prev) return;
        this.chunks.delete(key);
        for (const h of prev.keys()) this._rebuildHash(h);
    }

    _rebuildHash(hash) {
        const gl = this.gl;
        const h = String(hash ?? '').trim();
        if (!h) return;

        // Gather contributions from all chunks
        let totalInstances = 0;
        let color = null;
        for (const m of this.chunks.values()) {
            const ent = m?.get?.(h);
            if (!ent) continue;
            totalInstances += Number(ent.count) || 0;
            if (!color && ent.color) color = ent.color;
        }

        // Delete existing
        const prev = this.instances.get(h);
        if (prev) {
            gl.deleteBuffer(prev.instanceVbo);
            this.instances.delete(h);
        }
        if (totalInstances <= 0) return;

        // Allocate combined mats
        const combined = new Float32Array(totalInstances * 16);
        let off = 0;
        for (const m of this.chunks.values()) {
            const ent = m?.get?.(h);
            if (!ent) continue;
            const mats = ent.mats;
            const cnt = Number(ent.count) || 0;
            if (!mats || cnt <= 0) continue;
            combined.set(mats.subarray(0, cnt * 16), off);
            off += cnt * 16;
        }

        const instanceVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, instanceVbo);
        gl.bufferData(gl.ARRAY_BUFFER, combined, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        this.instances.set(h, {
            instanceVbo,
            instanceCount: totalInstances,
            color: color || [0.8, 0.8, 0.8],
        });
    }

    clear() {
        const gl = this.gl;
        this.chunks.clear();
        for (const v of this.instances.values()) {
            gl.deleteBuffer(v.instanceVbo);
        }
        this.instances.clear();
    }

    async renderAll(viewProjectionMatrix, modelMatrix) {
        if (!this._ready || this.instances.size === 0) return;
        const gl = this.gl;

        this.program.use();
        gl.uniformMatrix4fv(this.uniforms.uViewProjectionMatrix, false, viewProjectionMatrix);
        gl.uniformMatrix4fv(this.uniforms.uModelMatrix, false, modelMatrix);
        gl.uniform3fv(this.uniforms.uLightDir, [0.35, 0.85, 0.35]);
        gl.uniform1f(this.uniforms.uAmbient, 0.55);

        gl.enable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);

        for (const [hash, inst] of this.instances.entries()) {
            gl.uniform3fv(this.uniforms.uColor, inst.color);
            const group = await this.modelManager.loadMeshGroup(hash, 'high');
            if (!group) continue;

            for (const g of group) {
                const mesh = g?.mesh;
                if (!mesh) continue;

                gl.bindVertexArray(mesh.vao);
                gl.bindBuffer(gl.ARRAY_BUFFER, inst.instanceVbo);

                const instanceStride = 16 * 4;
                for (let i = 0; i < 4; i++) {
                    const loc = 3 + i;
                    gl.enableVertexAttribArray(loc);
                    gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, instanceStride, i * 16);
                    gl.vertexAttribDivisor(loc, 1);
                }

                gl.drawElementsInstanced(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_INT, 0, inst.instanceCount);
                gl.bindVertexArray(null);
            }
        }
    }
}



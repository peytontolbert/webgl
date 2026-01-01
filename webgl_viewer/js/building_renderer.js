import { glMatrix } from './glmatrix.js';
import { ShaderProgram } from './shader_program.js';
import { fetchText } from './asset_fetcher.js';

const vsSource = `#version 300 es
in vec3 aPosition;
in vec3 aNormal;

uniform mat4 uViewProjectionMatrix;
uniform mat4 uModelMatrix;
uniform mat3 uNormalMatrix;

out vec3 vNormal;
out float vDataZ;
out vec3 vWorldPos;

void main() {
    vec4 modelPos = uModelMatrix * vec4(aPosition, 1.0);
    gl_Position = uViewProjectionMatrix * modelPos;
    vNormal = normalize(uNormalMatrix * aNormal);
    vDataZ = aPosition.z;
    vWorldPos = modelPos.xyz;
}
`;

const fsSource = `#version 300 es
precision mediump float;

in vec3 vNormal;
in float vDataZ;
in vec3 vWorldPos;
out vec4 fragColor;

uniform vec3 uLightDir;
uniform vec3 uColor;
uniform float uAmbient;

// Two-pass render:
// - uWaterPass = 0: render non-water (opaque), discard water fragments
// - uWaterPass = 1: render water only (alpha), discard non-water fragments
uniform int uWaterPass;
uniform float uWaterAlpha;
uniform float uWaterEps;

uniform vec3 uCameraPos;
uniform bool uFogEnabled;
uniform vec3 uFogColor;
uniform float uFogStart;
uniform float uFogEnd;

void main() {
    vec3 n = normalize(vNormal);
    float diff = max(dot(n, normalize(uLightDir)), 0.0);

    // Heuristic: the exported "water mesh" is a big planar grid at data-space Z=0.
    // Treat vertices near Z=0 as water. This avoids needing separate OBJ materials/groups.
    bool isWater = abs(vDataZ) <= uWaterEps;

    if (uWaterPass == 0) {
        if (isWater) discard;
        vec3 c = uColor * (uAmbient + diff * (1.0 - uAmbient));
        if (uFogEnabled) {
            float dist = length(vWorldPos - uCameraPos);
            float fogF = smoothstep(uFogStart, uFogEnd, dist);
            c = mix(c, uFogColor, fogF);
        }
        fragColor = vec4(c, 1.0);
        return;
    }

    // Water pass
    if (!isWater) discard;
    // Simple blue tint + lighting (kept subtle so it doesn't dominate the scene).
    vec3 waterBase = vec3(0.12, 0.28, 0.42);
    vec3 c = waterBase * (uAmbient + diff * (1.0 - uAmbient));
    if (uFogEnabled) {
        float dist = length(vWorldPos - uCameraPos);
        float fogF = smoothstep(uFogStart, uFogEnd, dist);
        c = mix(c, uFogColor, fogF);
    }
    fragColor = vec4(c, clamp(uWaterAlpha, 0.0, 1.0));
}
`;

function clampUpdateAABB(min, max, x, y, z) {
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
}

export class BuildingRenderer {
    constructor(gl) {
        this.gl = gl;
        this.program = new ShaderProgram(gl);
        this.uniforms = null;

        // Match TerrainRenderer's model matrix transforms (data-space -> viewer-space)
        this.modelMatrix = glMatrix.mat4.create();
        glMatrix.mat4.rotateY(this.modelMatrix, this.modelMatrix, Math.PI);
        glMatrix.mat4.rotateX(this.modelMatrix, this.modelMatrix, -Math.PI / 2);
        this.normalMatrix = glMatrix.mat3.create();

        this.ready = false;
        this.vao = null;
        this.posBuffer = null;
        this.nrmBuffer = null;
        this.idxBuffer = null;
        this.indexCount = 0;

        this.boundsData = { min: [0, 0, 0], max: [0, 0, 0] };
        this.boundsView = { min: [0, 0, 0], max: [0, 0, 0] };
    }

    async init() {
        await this.program.createProgram(vsSource, fsSource);
        this.uniforms = {
            uViewProjectionMatrix: this.gl.getUniformLocation(this.program.program, 'uViewProjectionMatrix'),
            uModelMatrix: this.gl.getUniformLocation(this.program.program, 'uModelMatrix'),
            uNormalMatrix: this.gl.getUniformLocation(this.program.program, 'uNormalMatrix'),
            uLightDir: this.gl.getUniformLocation(this.program.program, 'uLightDir'),
            uColor: this.gl.getUniformLocation(this.program.program, 'uColor'),
            uAmbient: this.gl.getUniformLocation(this.program.program, 'uAmbient'),
            uWaterPass: this.gl.getUniformLocation(this.program.program, 'uWaterPass'),
            uWaterAlpha: this.gl.getUniformLocation(this.program.program, 'uWaterAlpha'),
            uWaterEps: this.gl.getUniformLocation(this.program.program, 'uWaterEps'),

            uCameraPos: this.gl.getUniformLocation(this.program.program, 'uCameraPos'),
            uFogEnabled: this.gl.getUniformLocation(this.program.program, 'uFogEnabled'),
            uFogColor: this.gl.getUniformLocation(this.program.program, 'uFogColor'),
            uFogStart: this.gl.getUniformLocation(this.program.program, 'uFogStart'),
            uFogEnd: this.gl.getUniformLocation(this.program.program, 'uFogEnd'),
        };

        this.vao = this.gl.createVertexArray();
        this.posBuffer = this.gl.createBuffer();
        this.nrmBuffer = this.gl.createBuffer();
        this.idxBuffer = this.gl.createBuffer();

        this.ready = true;
    }

    async loadOBJ(path = 'assets/buildings.obj') {
        if (!this.ready) return false;
        let text;
        try {
            // LOW priority: buildings are optional; don't starve chunk/manifest/mesh loads.
            text = await fetchText(path, { priority: 'low' });
        } catch {
            console.warn(`BuildingRenderer: missing ${path}`);
            return false;
        }
        // Note: buildings.obj may include a "# Buildings" section with metadata/points after the mesh.
        // Our parser stops at that marker to keep bounds + triangle parsing correct, so no warning needed.
        const parsed = this._parseOBJTriangles(text);
        if (!parsed || parsed.indices.length === 0) {
            console.warn('BuildingRenderer: no triangles parsed');
            return false;
        }

        // Upload buffers
        const gl = this.gl;
        gl.bindVertexArray(this.vao);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, parsed.positions, gl.STATIC_DRAW);
        const posLoc = gl.getAttribLocation(this.program.program, 'aPosition');
        if (posLoc !== -1) {
            gl.enableVertexAttribArray(posLoc);
            gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0);
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, this.nrmBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, parsed.normals, gl.STATIC_DRAW);
        const nrmLoc = gl.getAttribLocation(this.program.program, 'aNormal');
        if (nrmLoc !== -1) {
            gl.enableVertexAttribArray(nrmLoc);
            gl.vertexAttribPointer(nrmLoc, 3, gl.FLOAT, false, 0, 0);
        }

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, parsed.indices, gl.STATIC_DRAW);

        gl.bindVertexArray(null);

        this.indexCount = parsed.indices.length;
        this.boundsData = parsed.boundsData;
        this.boundsView = this._computeViewBoundsFromDataBounds(this.boundsData);

        console.log(`BuildingRenderer: loaded ${this.indexCount / 3} triangles`);
        return true;
    }

    _computeViewBoundsFromDataBounds(boundsData) {
        const corners = [
            [boundsData.min[0], boundsData.min[1], boundsData.min[2]],
            [boundsData.max[0], boundsData.min[1], boundsData.min[2]],
            [boundsData.min[0], boundsData.max[1], boundsData.min[2]],
            [boundsData.max[0], boundsData.max[1], boundsData.min[2]],
            [boundsData.min[0], boundsData.min[1], boundsData.max[2]],
            [boundsData.max[0], boundsData.min[1], boundsData.max[2]],
            [boundsData.min[0], boundsData.max[1], boundsData.max[2]],
            [boundsData.max[0], boundsData.max[1], boundsData.max[2]],
        ];
        const vmin = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
        const vmax = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
        for (const c of corners) {
            const c4 = glMatrix.vec4.fromValues(c[0], c[1], c[2], 1.0);
            const out = glMatrix.vec4.create();
            glMatrix.vec4.transformMat4(out, c4, this.modelMatrix);
            clampUpdateAABB(vmin, vmax, out[0], out[1], out[2]);
        }
        return { min: vmin, max: vmax };
    }

    _parseOBJTriangles(text) {
        // Minimal OBJ parser: v + f only. Triangulates polygons and computes smooth vertex normals.
        const verts = []; // array of [x,y,z]
        const idx = []; // triangle indices into verts

        const vmin = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
        const vmax = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];

        // NOTE: our `buildings.obj` is a combined file:
        // - water mesh first (with faces)
        // - then a "# Buildings" section that contains mostly per-building metadata + points (no faces)
        // If we keep parsing vertices after "# Buildings", our bounds get blown up and the water mesh
        // looks "wrong" relative to terrain. So stop parsing at the marker.
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const raw = lines[i];
            const lineTrimmed = raw.trim();
            if (lineTrimmed.startsWith('# Buildings')) break;

            const line = lineTrimmed;
            if (!line || line[0] === '#') continue;
            const parts = line.split(/\s+/);
            if (parts[0] === 'v' && parts.length >= 4) {
                const x = Number(parts[1]);
                const y = Number(parts[2]);
                const z = Number(parts[3]);
                if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
                    verts.push([x, y, z]);
                    clampUpdateAABB(vmin, vmax, x, y, z);
                }
                continue;
            }
            if (parts[0] === 'f' && parts.length >= 4) {
                // Face entries like: "a", "a/b", "a/b/c", "a//c"
                const face = [];
                for (let k = 1; k < parts.length; k++) {
                    const token = parts[k];
                    if (!token) continue;
                    const a = token.split('/')[0];
                    if (!a) continue;
                    let vi = parseInt(a, 10);
                    if (!Number.isFinite(vi) || Number.isNaN(vi)) continue;
                    // OBJ is 1-based; negative indices are relative to end.
                    if (vi < 0) vi = verts.length + vi + 1;
                    vi = vi - 1;
                    if (vi < 0 || vi >= verts.length) continue;
                    face.push(vi);
                }
                // Triangulate fan: (0,i,i+1)
                for (let t = 1; t + 1 < face.length; t++) {
                    idx.push(face[0], face[t], face[t + 1]);
                }
            }
        }

        const vcount = verts.length;
        const positions = new Float32Array(vcount * 3);
        for (let i = 0; i < vcount; i++) {
            const v = verts[i];
            positions[i * 3 + 0] = v[0];
            positions[i * 3 + 1] = v[1];
            positions[i * 3 + 2] = v[2];
        }

        // Compute smooth normals by accumulating face normals.
        const normals = new Float32Array(vcount * 3);
        for (let i = 0; i < idx.length; i += 3) {
            const i0 = idx[i + 0];
            const i1 = idx[i + 1];
            const i2 = idx[i + 2];
            const ax = positions[i0 * 3 + 0], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
            const bx = positions[i1 * 3 + 0], by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
            const cx = positions[i2 * 3 + 0], cy = positions[i2 * 3 + 1], cz = positions[i2 * 3 + 2];
            const abx = bx - ax, aby = by - ay, abz = bz - az;
            const acx = cx - ax, acy = cy - ay, acz = cz - az;
            const nx = (aby * acz) - (abz * acy);
            const ny = (abz * acx) - (abx * acz);
            const nz = (abx * acy) - (aby * acx);
            normals[i0 * 3 + 0] += nx; normals[i0 * 3 + 1] += ny; normals[i0 * 3 + 2] += nz;
            normals[i1 * 3 + 0] += nx; normals[i1 * 3 + 1] += ny; normals[i1 * 3 + 2] += nz;
            normals[i2 * 3 + 0] += nx; normals[i2 * 3 + 1] += ny; normals[i2 * 3 + 2] += nz;
        }
        for (let i = 0; i < vcount; i++) {
            const x = normals[i * 3 + 0];
            const y = normals[i * 3 + 1];
            const z = normals[i * 3 + 2];
            const len = Math.sqrt(x * x + y * y + z * z) || 1.0;
            normals[i * 3 + 0] = x / len;
            normals[i * 3 + 1] = y / len;
            normals[i * 3 + 2] = z / len;
        }

        const indices = new Uint32Array(idx);
        return {
            positions,
            normals,
            indices,
            boundsData: { min: vmin, max: vmax },
        };
    }

    render(viewProjectionMatrix, enabled = true, { showWater = true, waterAlpha = 0.35, waterEps = 0.05, fog = null, cameraPos = [0, 0, 0] } = {}) {
        if (!enabled || !this.ready || !this.vao || this.indexCount <= 0) return;
        const gl = this.gl;
        gl.useProgram(this.program.program);

        glMatrix.mat3.normalFromMat4(this.normalMatrix, this.modelMatrix);

        gl.uniformMatrix4fv(this.uniforms.uViewProjectionMatrix, false, viewProjectionMatrix);
        gl.uniformMatrix4fv(this.uniforms.uModelMatrix, false, this.modelMatrix);
        gl.uniformMatrix3fv(this.uniforms.uNormalMatrix, false, this.normalMatrix);
        gl.uniform3fv(this.uniforms.uLightDir, [0.4, 0.8, 0.2]);
        gl.uniform3fv(this.uniforms.uColor, [0.72, 0.72, 0.75]);
        gl.uniform1f(this.uniforms.uAmbient, 0.65);
        gl.uniform1f(this.uniforms.uWaterAlpha, waterAlpha);
        gl.uniform1f(this.uniforms.uWaterEps, waterEps);

        const fogEnabled = !!fog?.enabled;
        gl.uniform3fv(this.uniforms.uCameraPos, cameraPos);
        gl.uniform1i(this.uniforms.uFogEnabled, fogEnabled ? 1 : 0);
        gl.uniform3fv(this.uniforms.uFogColor, fog?.color || [0.6, 0.7, 0.8]);
        gl.uniform1f(this.uniforms.uFogStart, Number(fog?.start ?? 1500));
        gl.uniform1f(this.uniforms.uFogEnd, Number(fog?.end ?? 9000));

        gl.enable(gl.DEPTH_TEST);

        gl.bindVertexArray(this.vao);

        // Pass 0: non-water opaque (writes depth).
        gl.disable(gl.BLEND);
        gl.depthMask(true);
        gl.uniform1i(this.uniforms.uWaterPass, 0);
        gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);

        // Pass 1: water translucent (does NOT write depth so it doesn't "cover" entities/models).
        if (showWater) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.depthMask(false);
            gl.uniform1i(this.uniforms.uWaterPass, 1);
            gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
            gl.depthMask(true);
            gl.disable(gl.BLEND);
        }

        gl.bindVertexArray(null);
    }
}



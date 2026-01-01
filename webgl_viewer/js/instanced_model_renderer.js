import { glMatrix } from './glmatrix.js';
import { ShaderProgram } from './shader_program.js';

const vsSource = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aTexcoord;
layout(location=3) in vec4 aTangent;
layout(location=8) in vec4 aColor0;
layout(location=9) in vec2 aTexcoord1;

// mat4 takes 4 attribute slots; we bind at locations 4..7
layout(location=4) in vec4 aI0;
layout(location=5) in vec4 aI1;
layout(location=6) in vec4 aI2;
layout(location=7) in vec4 aI3;

// Optional per-instance tint palette index (0..255). Present when instance stride is 17 floats.
layout(location=12) in float aTintIndex;

uniform mat4 uViewProjectionMatrix;
uniform mat4 uModelMatrix;
uniform vec4 uUv0ScaleOffset; // (scaleU, scaleV, offsetU, offsetV)
uniform vec3 uGlobalAnimUV0;  // dot(globalAnimUV0, vec3(uv,1))
uniform vec3 uGlobalAnimUV1;  // dot(globalAnimUV1, vec3(uv,1))

out vec3 vWorldPos;
out vec3 vN;
out vec4 vT;
out vec2 vUv;
out vec2 vUv1;
out vec4 vColor0;
flat out float vTintIndex;

void main() {
    mat4 inst = mat4(aI0, aI1, aI2, aI3);
    vec4 dataPos = inst * vec4(aPosition, 1.0);
    vec4 worldPos = uModelMatrix * dataPos;
    vWorldPos = worldPos.xyz;
    // Correct normal/tangent transform includes the instance transform too.
    // Use inverse-transpose for non-uniform scaling.
    mat3 nmat = transpose(inverse(mat3(uModelMatrix * inst)));
    vN = normalize(nmat * aNormal);
    vec3 tw = normalize(nmat * aTangent.xyz);
    vT = vec4(tw, aTangent.w);
    // Match CodeWalker BasicVS GlobalUVAnim() then apply per-material scale/offset (GTA-style).
    vec3 uvw = vec3(aTexcoord, 1.0);
    vec2 uvA = vec2(dot(uGlobalAnimUV0, uvw), dot(uGlobalAnimUV1, uvw));
    vUv = uvA * uUv0ScaleOffset.xy + uUv0ScaleOffset.zw;
    vUv1 = aTexcoord1;
    vColor0 = aColor0;
    vTintIndex = aTintIndex;
    gl_Position = uViewProjectionMatrix * worldPos;
}
`;

const fsSource = `#version 300 es
precision mediump float;
in vec3 vWorldPos;
in vec3 vN;
in vec4 vT;
in vec2 vUv;
in vec2 vUv1;
in vec4 vColor0;
flat in float vTintIndex;
out vec4 fragColor;

uniform vec3 uColor;
uniform vec3 uLightDir;
uniform float uAmbient;
uniform bool uHasDiffuse;
uniform sampler2D uDiffuse;
uniform bool uHasDiffuse2;
uniform sampler2D uDiffuse2;
uniform bool uDiffuse2UseUv1;

uniform bool uHasNormal;
uniform sampler2D uNormal;
uniform float uNormalScale;
uniform bool uHasDetail;
uniform sampler2D uDetail;
uniform vec4 uDetailSettings; // x,y,z,w (BasicPS uses y as intensity, zw as UV scale)

uniform bool uHasSpec;
uniform sampler2D uSpec;
uniform float uSpecularIntensity;
uniform float uSpecularPower;
uniform vec3 uSpecMaskWeights; // dot(spec.rgb, weights)

uniform bool uHasEmissive;
uniform sampler2D uEmissive;
uniform float uEmissiveIntensity;

uniform bool uHasAO;
uniform sampler2D uAO;
uniform float uAOStrength;

// Tiny tint palette (optional). Index 0 should be white/no-tint.
uniform bool uEnableTintPalette;
uniform sampler2D uTintPalette;

// Color pipeline:
// - When textures are uploaded as sRGB (preferred), sampling returns linear and uDecodeSrgb should be false.
// - When sRGB textures aren't supported, we upload as RGBA and must decode manually in shader.
uniform bool uDecodeSrgb;

// Normal map decode:
// uNormalEncoding: 0=RG (default), 1=AG (common for packed normals)
// uNormalReconstructZ: if true, reconstruct Z from XY (BC5-style) instead of using sampled B.
uniform int uNormalEncoding;
uniform bool uNormalReconstructZ;

// Shader family selector:
// 0 = basic (BasicPS-like), 1 = decal, 2 = glass/reflect (approx)
uniform int uShaderFamily;

// Decal support (minimal):
uniform bool uHasAlphaMask;
uniform sampler2D uAlphaMask;

// Glass/reflect support (approx; no probes/cubemaps yet):
uniform float uReflectionIntensity;
uniform float uFresnelPower;
uniform vec3 uEnvColor;

// Alpha control:
// uAlphaMode: 0=opaque, 1=cutout, 2=blend
uniform int uAlphaMode;
uniform float uAlphaCutoff;
uniform float uAlphaScale;
uniform float uHardAlphaBlend; // if >0.5 and alphaMode==blend, discard low alpha and keep depth writes

uniform vec3 uCameraPos;
uniform bool uFogEnabled;
uniform vec3 uFogColor;
uniform float uFogStart;
uniform float uFogEnd;

vec3 decodeSrgb(vec3 c) {
    // Approx sRGB -> linear (good enough for now).
    return pow(max(c, vec3(0.0)), vec3(2.2));
}
vec3 encodeSrgb(vec3 c) {
    // Linear -> sRGB for display.
    return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2));
}

void main() {
    vec3 N = normalize(vN);
    vec3 T = normalize(vT.xyz);
    vec3 B = normalize(cross(N, T) * vT.w);

    // --- Decal path (minimal) ---
    if (uShaderFamily == 1) {
        vec3 base = uColor;
        float outA = 1.0;
        if (uHasDiffuse) {
            vec4 d = texture(uDiffuse, vUv);
            vec3 drgb = uDecodeSrgb ? decodeSrgb(d.rgb) : d.rgb;
            base *= drgb;
            outA = d.a;
        }
        if (uHasAlphaMask) {
            float m = texture(uAlphaMask, vUv).r;
            outA *= m;
        }
        base *= clamp(vColor0.rgb, 0.0, 1.0);
        if (uEnableTintPalette) {
            float idx = clamp(vTintIndex, 0.0, 255.0);
            vec2 tuv = vec2((idx + 0.5) / 256.0, 0.5);
            base *= texture(uTintPalette, tuv).rgb;
        }
        outA = clamp(outA * max(0.0, uAlphaScale), 0.0, 1.0);
        if (uFogEnabled) {
            float dist = length(vWorldPos - uCameraPos);
            float fogF = smoothstep(uFogStart, uFogEnd, dist);
            base = mix(base, uFogColor, fogF);
        }
        fragColor = vec4(encodeSrgb(base), outA);
        return;
    }

    // --- Glass/reflect path (approx) ---
    if (uShaderFamily == 2) {
        vec3 base = uColor;
        float outA = 0.25;
        if (uHasDiffuse) {
            vec4 d = texture(uDiffuse, vUv);
            vec3 drgb = uDecodeSrgb ? decodeSrgb(d.rgb) : d.rgb;
            base *= drgb;
            outA = d.a;
        }
        base *= clamp(vColor0.rgb, 0.0, 1.0);
        if (uEnableTintPalette) {
            float idx = clamp(vTintIndex, 0.0, 255.0);
            vec2 tuv = vec2((idx + 0.5) / 256.0, 0.5);
            base *= texture(uTintPalette, tuv).rgb;
        }
        vec3 V = normalize(uCameraPos - vWorldPos);
        float ndv = clamp(dot(normalize(N), V), 0.0, 1.0);
        float fres = pow(1.0 - ndv, max(0.5, uFresnelPower));
        vec3 c = mix(base, uEnvColor, clamp(fres * max(0.0, uReflectionIntensity), 0.0, 1.0));
        outA = clamp(outA * max(0.0, uAlphaScale), 0.0, 1.0);
        if (uFogEnabled) {
            float dist = length(vWorldPos - uCameraPos);
            float fogF = smoothstep(uFogStart, uFogEnd, dist);
            c = mix(c, uFogColor, fogF);
        }
        fragColor = vec4(encodeSrgb(c), outA);
        return;
    }

    // Tangent-space normal map (CodeWalker BasicPS-style).
    // Key differences vs a generic normal-map path:
    // - Uses XY only (reconstructs Z by default)
    // - Detail normal is sampled twice and blended in *before* (XY*2-1), weighted by specmap alpha (sv.w)
    if (uHasNormal) {
        vec4 ntex = texture(uNormal, vUv);
        // Normal map stores XY in 0..1
        vec2 nmv = (uNormalEncoding == 1) ? ntex.ag : ntex.rg;

        // Specmap alpha is used as a weight for detail normal contribution in CodeWalker.
        vec4 sv = uHasSpec ? texture(uSpec, vUv) : vec4(0.1);

        if (uHasDetail) {
            vec2 uv0 = vUv * max(vec2(0.0), uDetailSettings.zw);
            vec2 uv1 = uv0 * 3.17;
            vec2 d0 = texture(uDetail, uv0).xy - vec2(0.5);
            vec2 d1 = texture(uDetail, uv1).xy - vec2(0.5);
            vec2 det = (d0 + d1) * max(0.0, uDetailSettings.y);
            nmv = det * sv.a + nmv;
        }

        // Convert to -1..1
        vec2 nxy = nmv * 2.0 - 1.0;
        float bump = max(uNormalScale, 0.001);
        vec2 bxy = nxy * bump;

        // Reconstruct Z from the *unscaled* XY (matches CodeWalker NormalMap()).
        float z = (uNormalReconstructZ)
            ? sqrt(abs(1.0 - dot(nxy, nxy)))
            : (ntex.b * 2.0 - 1.0);

        vec3 nts = vec3(bxy, z);
        N = normalize(T * nts.x + B * nts.y + N * nts.z);
    }

    vec3 L = normalize(uLightDir);
    float diff = max(dot(N, L), 0.0);
    vec3 base = uColor;
    float outA = 1.0;
    if (uHasDiffuse) {
        vec4 d = texture(uDiffuse, vUv);
        vec3 drgb = uDecodeSrgb ? decodeSrgb(d.rgb) : d.rgb;
        base *= drgb;
        outA = clamp(d.a * max(0.0, uAlphaScale), 0.0, 1.0);
    }
    // Diffuse2 layer (CodeWalker BasicPS: c = c2.a*c2 + (1-c2.a)*c, sampled on Texcoord1)
    if (uHasDiffuse2) {
        vec2 uvD2 = uDiffuse2UseUv1 ? vUv1 : vUv;
        vec4 d2 = texture(uDiffuse2, uvD2);
        vec3 d2rgb = uDecodeSrgb ? decodeSrgb(d2.rgb) : d2.rgb;
        float a2 = clamp(d2.a, 0.0, 1.0);
        vec3 d2col = uColor * d2rgb;
        base = mix(base, d2col, a2);
        outA = mix(outA, clamp(d2.a * max(0.0, uAlphaScale), 0.0, 1.0), a2);
    }
    // Vertex color modulation (defaulted to white when absent).
    base *= clamp(vColor0.rgb, 0.0, 1.0);
    if (uEnableTintPalette) {
        float idx = clamp(vTintIndex, 0.0, 255.0);
        vec2 tuv = vec2((idx + 0.5) / 256.0, 0.5);
        base *= texture(uTintPalette, tuv).rgb;
    }

    // AO (multiply base)
    if (uHasAO) {
        float ao = texture(uAO, vUv).r;
        float k = clamp(uAOStrength, 0.0, 2.0);
        base *= mix(vec3(1.0), vec3(ao), k);
    }

    // Alpha behaviour (closer to CodeWalker BasicPS for non-decals):
    // - Non-decal path discards low alpha (<~0.33) even in "opaque" mode, then forces alpha=1.
    // - Cutout uses uAlphaCutoff then forces alpha=1.
    if (uAlphaMode == 0) {
        if (uHasDiffuse && outA <= 0.33) discard;
        outA = 1.0;
    } else if (uAlphaMode == 1) {
        if (outA < uAlphaCutoff) discard;
        outA = 1.0;
    } else if (uAlphaMode == 2) {
        // "Hard alpha blend": treat very low alpha as cutout to avoid excessive sorting artifacts.
        if (uHardAlphaBlend > 0.5 && outA < uAlphaCutoff) discard;
    }

    vec3 c = base * (uAmbient + diff * (1.0 - uAmbient));

    // Specular (CodeWalker BasicPS-style):
    // incident = normalize(CamRelPos). In our space, use camera->point vector.
    // refl = reflect(incident, norm)
    // specp = max(exp(saturate(dot(refl, LightDir))*10)-1, 0)
    // spec += LightDirColour * 0.00006 * specp * sv.x * specularIntensityMult
    vec4 sv = uHasSpec ? texture(uSpec, vUv) : vec4(0.1);
    sv.rg *= sv.rg; // CodeWalker squares sv.xy before using sv.x
    vec3 incident = normalize(vWorldPos - uCameraPos);
    vec3 refl = normalize(reflect(incident, N));
    float specb = clamp(dot(refl, L), 0.0, 1.0);
    float specp = max(exp(specb * 10.0) - 1.0, 0.0);
    float spk = (0.06 * specp * sv.r * max(0.0, uSpecularIntensity)); // 0.06 ~= (0.00006 * HDR-ish scale)
    c += vec3(spk);

    // Emissive (additive)
    if (uHasEmissive) {
        vec3 e0 = texture(uEmissive, vUv).rgb;
        vec3 e = uDecodeSrgb ? decodeSrgb(e0) : e0;
        c += e * max(0.0, uEmissiveIntensity);
    }

    if (uFogEnabled) {
        float dist = length(vWorldPos - uCameraPos);
        float fogF = smoothstep(uFogStart, uFogEnd, dist);
        c = mix(c, uFogColor, fogF);
    }

    fragColor = vec4(encodeSrgb(c), outA);
}
`;

export class InstancedModelRenderer {
    constructor(gl, modelManager, textureStreamer) {
        this.gl = gl;
        this.modelManager = modelManager;
        this.textureStreamer = textureStreamer;
        this.program = new ShaderProgram(gl);
        this.tintPaletteTex = null;

        // Match TerrainRenderer's model matrix transforms (data-space -> viewer-space)
        this.modelMatrix = glMatrix.mat4.create();
        glMatrix.mat4.rotateY(this.modelMatrix, this.modelMatrix, Math.PI);
        glMatrix.mat4.rotateX(this.modelMatrix, this.modelMatrix, -Math.PI / 2);

        this.ready = false;
        this.uniforms = null;

        // key(hash:lod) -> { hash, lod, minDist, instanceBuffer, instanceCount, submeshes: Map<file, {file, material, mesh, vao}> }
        this.instances = new Map();

        // Cross-archetype instancing buckets:
        // key(bucketId) -> { bucketId, lod, file, material, minDist, instanceBuffer, instanceCount, mesh, vao }
        // Where bucketId is a stable key like `${lod}:${file}:${materialSig}`
        this.buckets = new Map();

        // Mesh-load throttling: prevents the browser/network stack from exploding when we
        // suddenly discover thousands of archetypes/submeshes in nearby chunks.
        this.maxMeshLoadsInFlight = 6;
        this._meshLoadsInFlight = 0;
        this._meshLoadQueue = []; // Array<{ entryKey, file }>
        this._meshLoadPending = new Set(); // key(entryKey:file)

        // Debug stats (used by Perf HUD / console).
        this._occlusionStats = { tested: 0, culled: 0 };
        this._renderStats = {
            drawCalls: 0,
            triangles: 0,
            instances: 0,
            bucketDraws: 0,
            submeshDraws: 0,
            drawItems: 0,
            // Texture diagnostics (helps answer "why are textures not showing?")
            diffuseWanted: 0,
            diffusePlaceholder: 0,
            diffuseReal: 0,
            drawItemsMissingUv: 0,
        };
    }

    /**
     * Resolve an exported asset-relative path (e.g. "models_textures/123.png" or "assets/models_textures/123.png")
     * into a URL that works whether the viewer is hosted at:
     * - / (Vite dev / root hosting)
     * - /some/subdir/ (static hosting under a subpath)
     */
    _resolveAssetUrl(rel) {
        const r0 = String(rel || '').trim();
        if (!r0) return null;
        const r = r0.replace(/^\/+/, '');
        const path = r.startsWith('assets/') ? r : `assets/${r}`;
        try {
            return new URL(path, document.baseURI).toString();
        } catch {
            // Best-effort fallback.
            return path;
        }
    }

    getRenderStats() {
        return { ...(this._renderStats || {}) };
    }

    _computeInstanceBoundsFromMatrices(matricesFloat32) {
        try {
            const a = matricesFloat32;
            if (!a || a.length < 16) return null;
            const stride = ((a.length % 17) === 0) ? 17 : 16;
            const minT = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
            const maxT = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
            let maxScale = 1.0;
            for (let i = 0; i + 15 < a.length; i += stride) {
                const tx = a[i + 12];
                const ty = a[i + 13];
                const tz = a[i + 14];
                if (tx < minT[0]) minT[0] = tx;
                if (ty < minT[1]) minT[1] = ty;
                if (tz < minT[2]) minT[2] = tz;
                if (tx > maxT[0]) maxT[0] = tx;
                if (ty > maxT[1]) maxT[1] = ty;
                if (tz > maxT[2]) maxT[2] = tz;

                // Max basis column length (approx scale).
                const sx = Math.hypot(a[i + 0], a[i + 1], a[i + 2]);
                const sy = Math.hypot(a[i + 4], a[i + 5], a[i + 6]);
                const sz = Math.hypot(a[i + 8], a[i + 9], a[i + 10]);
                const s = Math.max(sx || 0, sy || 0, sz || 0);
                if (Number.isFinite(s) && s > maxScale) maxScale = s;
            }
            if (!Number.isFinite(minT[0])) return null;
            return { minT, maxT, maxScale };
        } catch {
            return null;
        }
    }

    _createDefaultTintPaletteTexture() {
        // 256x1 RGBA palette. Index 0 = white/no tint.
        const gl = this.gl;
        try {
            const w = 256;
            const h = 1;
            const data = new Uint8Array(w * h * 4);
            const set = (i, r, g, b, a = 255) => {
                const o = i * 4;
                data[o + 0] = r;
                data[o + 1] = g;
                data[o + 2] = b;
                data[o + 3] = a;
            };
            set(0, 255, 255, 255, 255);

            const hsvToRgb = (hh, ss, vv) => {
                const h6 = (((hh % 1) + 1) % 1) * 6;
                const c = vv * ss;
                const x = c * (1 - Math.abs((h6 % 2) - 1));
                const m = vv - c;
                let r = 0, g = 0, b = 0;
                if (h6 < 1) { r = c; g = x; b = 0; }
                else if (h6 < 2) { r = x; g = c; b = 0; }
                else if (h6 < 3) { r = 0; g = c; b = x; }
                else if (h6 < 4) { r = 0; g = x; b = c; }
                else if (h6 < 5) { r = x; g = 0; b = c; }
                else { r = c; g = 0; b = x; }
                return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
            };
            for (let i = 1; i < 256; i++) {
                const [r, g, b] = hsvToRgb(i / 255, 0.65, 1.0);
                set(i, r, g, b, 255);
            }

            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
            gl.bindTexture(gl.TEXTURE_2D, null);
            return tex;
        } catch {
            return null;
        }
    }

    async init() {
        await this.program.createProgram(vsSource, fsSource);
        this.uniforms = {
            uViewProjectionMatrix: this.gl.getUniformLocation(this.program.program, 'uViewProjectionMatrix'),
            uModelMatrix: this.gl.getUniformLocation(this.program.program, 'uModelMatrix'),
            uUv0ScaleOffset: this.gl.getUniformLocation(this.program.program, 'uUv0ScaleOffset'),
            uGlobalAnimUV0: this.gl.getUniformLocation(this.program.program, 'uGlobalAnimUV0'),
            uGlobalAnimUV1: this.gl.getUniformLocation(this.program.program, 'uGlobalAnimUV1'),
            uColor: this.gl.getUniformLocation(this.program.program, 'uColor'),
            uLightDir: this.gl.getUniformLocation(this.program.program, 'uLightDir'),
            uAmbient: this.gl.getUniformLocation(this.program.program, 'uAmbient'),
            uHasDiffuse: this.gl.getUniformLocation(this.program.program, 'uHasDiffuse'),
            uDiffuse: this.gl.getUniformLocation(this.program.program, 'uDiffuse'),
            uHasDiffuse2: this.gl.getUniformLocation(this.program.program, 'uHasDiffuse2'),
            uDiffuse2: this.gl.getUniformLocation(this.program.program, 'uDiffuse2'),
            uDiffuse2UseUv1: this.gl.getUniformLocation(this.program.program, 'uDiffuse2UseUv1'),

            uHasNormal: this.gl.getUniformLocation(this.program.program, 'uHasNormal'),
            uNormal: this.gl.getUniformLocation(this.program.program, 'uNormal'),
            uNormalScale: this.gl.getUniformLocation(this.program.program, 'uNormalScale'),
            uHasDetail: this.gl.getUniformLocation(this.program.program, 'uHasDetail'),
            uDetail: this.gl.getUniformLocation(this.program.program, 'uDetail'),
            uDetailSettings: this.gl.getUniformLocation(this.program.program, 'uDetailSettings'),

            uHasSpec: this.gl.getUniformLocation(this.program.program, 'uHasSpec'),
            uSpec: this.gl.getUniformLocation(this.program.program, 'uSpec'),
            uSpecularIntensity: this.gl.getUniformLocation(this.program.program, 'uSpecularIntensity'),
            uSpecularPower: this.gl.getUniformLocation(this.program.program, 'uSpecularPower'),
            uSpecMaskWeights: this.gl.getUniformLocation(this.program.program, 'uSpecMaskWeights'),

            uHasEmissive: this.gl.getUniformLocation(this.program.program, 'uHasEmissive'),
            uEmissive: this.gl.getUniformLocation(this.program.program, 'uEmissive'),
            uEmissiveIntensity: this.gl.getUniformLocation(this.program.program, 'uEmissiveIntensity'),

            uHasAO: this.gl.getUniformLocation(this.program.program, 'uHasAO'),
            uAO: this.gl.getUniformLocation(this.program.program, 'uAO'),
            uAOStrength: this.gl.getUniformLocation(this.program.program, 'uAOStrength'),

            uEnableTintPalette: this.gl.getUniformLocation(this.program.program, 'uEnableTintPalette'),
            uTintPalette: this.gl.getUniformLocation(this.program.program, 'uTintPalette'),

            uDecodeSrgb: this.gl.getUniformLocation(this.program.program, 'uDecodeSrgb'),
            uNormalEncoding: this.gl.getUniformLocation(this.program.program, 'uNormalEncoding'),
            uNormalReconstructZ: this.gl.getUniformLocation(this.program.program, 'uNormalReconstructZ'),

            uShaderFamily: this.gl.getUniformLocation(this.program.program, 'uShaderFamily'),
            uHasAlphaMask: this.gl.getUniformLocation(this.program.program, 'uHasAlphaMask'),
            uAlphaMask: this.gl.getUniformLocation(this.program.program, 'uAlphaMask'),
            uReflectionIntensity: this.gl.getUniformLocation(this.program.program, 'uReflectionIntensity'),
            uFresnelPower: this.gl.getUniformLocation(this.program.program, 'uFresnelPower'),
            uEnvColor: this.gl.getUniformLocation(this.program.program, 'uEnvColor'),

            uAlphaMode: this.gl.getUniformLocation(this.program.program, 'uAlphaMode'),
            uAlphaCutoff: this.gl.getUniformLocation(this.program.program, 'uAlphaCutoff'),
            uAlphaScale: this.gl.getUniformLocation(this.program.program, 'uAlphaScale'),
            uHardAlphaBlend: this.gl.getUniformLocation(this.program.program, 'uHardAlphaBlend'),

            uCameraPos: this.gl.getUniformLocation(this.program.program, 'uCameraPos'),
            uFogEnabled: this.gl.getUniformLocation(this.program.program, 'uFogEnabled'),
            uFogColor: this.gl.getUniformLocation(this.program.program, 'uFogColor'),
            uFogStart: this.gl.getUniformLocation(this.program.program, 'uFogStart'),
            uFogEnd: this.gl.getUniformLocation(this.program.program, 'uFogEnd'),
        };
        this.tintPaletteTex = this._createDefaultTintPaletteTexture();
        this.ready = true;
    }

    async setInstancesForArchetype(hash, lod, matricesFloat32, minDist = null) {
        const h = String(hash);
        const l = String(lod || 'high').toLowerCase();
        if (!this.ready) return;
        if (!matricesFloat32 || matricesFloat32.length === 0) {
            const key = `${h}:${l}`;
            const old = this.instances.get(key);
            if (old) {
                try { this.gl.deleteBuffer(old.instanceBuffer); } catch { /* ignore */ }
                try {
                    for (const sm of old.submeshes?.values?.() || []) {
                        if (sm?.vao) this.gl.deleteVertexArray(sm.vao);
                    }
                } catch { /* ignore */ }
            }
            this.instances.delete(key);
            return;
        }

        const gl = this.gl;
        const key = `${h}:${l}`;
        let entry = this.instances.get(key);
        if (!entry) {
            entry = {
                hash: h,
                lod: l,
                minDist: null,
                instanceBuffer: gl.createBuffer(),
                instanceCount: 0,
                submeshes: new Map(), // file -> {file, material, mesh, vao}
            };
            this.instances.set(key, entry);
        }

        {
            const d = Number(minDist);
            if (Number.isFinite(d)) entry.minDist = d;
        }

        const stride = ((matricesFloat32.length % 17) === 0) ? 17 : 16;
        // If stride changed (e.g. tint enabled/disabled), drop VAOs so they rebuild with correct attrib pointers.
        if (entry.instanceStrideFloats && entry.instanceStrideFloats !== stride) {
            try {
                for (const sm of entry.submeshes?.values?.() || []) {
                    if (sm?.vao) gl.deleteVertexArray(sm.vao);
                    if (sm) sm.vao = null;
                }
            } catch { /* ignore */ }
        }
        entry.instanceStrideFloats = stride;
        entry.instanceCount = Math.floor(matricesFloat32.length / stride);
        gl.bindBuffer(gl.ARRAY_BUFFER, entry.instanceBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, matricesFloat32, gl.DYNAMIC_DRAW);

        // Cache conservative instance translation bounds + max scale (data space) for occlusion.
        entry._instBounds = this._computeInstanceBoundsFromMatrices(matricesFloat32);

        // Update submesh list from manifest (v4) or fallback (v3).
        const subs = this.modelManager?.getLodSubmeshes?.(h, l) || [];
        const wanted = new Set();

        // If an archetype isn't in the manifest, `subs` is empty.
        // In that case we can optionally render a placeholder cube to make "missing exports" obvious.
        if ((!subs || subs.length === 0) && (this.modelManager?.enablePlaceholderMeshes ?? false)) {
            const phKey = '__placeholder__';
            wanted.add(phKey);
            // Ensure ONLY the placeholder submesh remains.
            for (const file of Array.from(entry.submeshes.keys())) {
                if (file !== phKey) {
                    const sm = entry.submeshes.get(file);
                    try { if (sm?.vao) gl.deleteVertexArray(sm.vao); } catch { /* ignore */ }
                    entry.submeshes.delete(file);
                }
            }
            if (!entry.submeshes.has(phKey)) {
                entry.submeshes.set(phKey, { file: phKey, material: null, mesh: this.modelManager?._placeholderMesh ?? null, vao: null });
            } else {
                const sm = entry.submeshes.get(phKey);
                if (sm) sm.mesh = this.modelManager?._placeholderMesh ?? sm.mesh;
            }
            // No mesh loads needed for placeholder.
        } else {
            for (const sm of subs) {
                const file = String(sm?.file || '');
                if (!file) continue;
                wanted.add(file);
                if (!entry.submeshes.has(file)) {
                    entry.submeshes.set(file, { file, material: sm?.material ?? null, mesh: null, vao: null });
                } else {
                    // keep material up to date if manifest changed
                    const e = entry.submeshes.get(file);
                    if (e) e.material = sm?.material ?? e.material;
                }
            }

            // Drop stale submeshes
            for (const file of Array.from(entry.submeshes.keys())) {
                if (!wanted.has(file)) {
                    const sm = entry.submeshes.get(file);
                    try { if (sm?.vao) gl.deleteVertexArray(sm.vao); } catch { /* ignore */ }
                    entry.submeshes.delete(file);
                }
            }

            // Ensure submesh meshes will be loaded (throttled).
            for (const file of wanted) this._enqueueMeshLoad(key, file);
        }
    }

    /**
     * Fast-path update for an existing archetype+lod instance buffer.
     * This avoids re-walking the manifest + submesh list every frame.
     *
     * Returns true if the instance buffer was updated, false if the entry doesn't exist yet.
     */
    updateInstanceMatricesForArchetype(hash, lod, matricesFloat32, minDist = null) {
        const h = String(hash);
        const l = String(lod || 'high').toLowerCase();
        if (!this.ready) return false;
        if (!matricesFloat32 || matricesFloat32.length === 0) return false;

        const key = `${h}:${l}`;
        const entry = this.instances.get(key);
        if (!entry) return false;

        {
            const d = Number(minDist);
            if (Number.isFinite(d)) entry.minDist = d;
        }

        const gl = this.gl;
        const stride = ((matricesFloat32.length % 17) === 0) ? 17 : 16;
        if (entry.instanceStrideFloats && entry.instanceStrideFloats !== stride) {
            // Force VAO rebuilds (stride affects instanced attrib layout).
            try {
                for (const sm of entry.submeshes?.values?.() || []) {
                    if (sm?.vao) gl.deleteVertexArray(sm.vao);
                    if (sm) sm.vao = null;
                }
            } catch { /* ignore */ }
        }
        entry.instanceStrideFloats = stride;
        entry.instanceCount = Math.floor(matricesFloat32.length / stride);
        gl.bindBuffer(gl.ARRAY_BUFFER, entry.instanceBuffer);

        // If buffer sizes match, prefer bufferSubData to avoid realloc; otherwise fallback to bufferData.
        try {
            const curBytes = gl.getBufferParameter(gl.ARRAY_BUFFER, gl.BUFFER_SIZE) || 0;
            const nextBytes = matricesFloat32.byteLength || (matricesFloat32.length * 4);
            if (Number(curBytes) === Number(nextBytes)) {
                gl.bufferSubData(gl.ARRAY_BUFFER, 0, matricesFloat32);
            } else {
                gl.bufferData(gl.ARRAY_BUFFER, matricesFloat32, gl.DYNAMIC_DRAW);
            }
        } catch {
            // Safe fallback if getBufferParameter isn't supported/throws.
            gl.bufferData(gl.ARRAY_BUFFER, matricesFloat32, gl.DYNAMIC_DRAW);
        }

        entry._instBounds = this._computeInstanceBoundsFromMatrices(matricesFloat32);
        return true;
    }

    async setInstancesForBucket(bucketId, lod, file, material, matricesFloat32, minDist = null) {
        const id = String(bucketId || '');
        const l = String(lod || 'high').toLowerCase();
        const f = String(file || '').trim();
        if (!this.ready) return;

        if (!id || !f) return;

        if (!matricesFloat32 || matricesFloat32.length === 0) {
            const old = this.buckets.get(id);
            if (old) {
                try { this.gl.deleteBuffer(old.instanceBuffer); } catch { /* ignore */ }
                try { if (old?.vao) this.gl.deleteVertexArray(old.vao); } catch { /* ignore */ }
            }
            this.buckets.delete(id);
            return;
        }

        const gl = this.gl;
        let entry = this.buckets.get(id);
        if (!entry) {
            entry = {
                bucketId: id,
                lod: l,
                file: f,
                material: material ?? null,
                minDist: null,
                instanceBuffer: gl.createBuffer(),
                instanceCount: 0,
                mesh: null,
                vao: null,
            };
            this.buckets.set(id, entry);
        } else {
            entry.lod = l;
            entry.file = f;
            entry.material = material ?? entry.material;
        }

        {
            const d = Number(minDist);
            if (Number.isFinite(d)) entry.minDist = d;
        }

        const stride = ((matricesFloat32.length % 17) === 0) ? 17 : 16;
        if (entry.instanceStrideFloats && entry.instanceStrideFloats !== stride) {
            try { if (entry.vao) gl.deleteVertexArray(entry.vao); } catch { /* ignore */ }
            entry.vao = null;
        }
        entry.instanceStrideFloats = stride;
        entry.instanceCount = Math.floor(matricesFloat32.length / stride);
        gl.bindBuffer(gl.ARRAY_BUFFER, entry.instanceBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, matricesFloat32, gl.DYNAMIC_DRAW);

        // Cache conservative instance translation bounds + max scale (data space) for occlusion.
        entry._instBounds = this._computeInstanceBoundsFromMatrices(matricesFloat32);

        // Ensure mesh will be loaded (throttled).
        this._enqueueMeshLoad(id, f);
    }

    _enqueueMeshLoad(entryKey, file) {
        const ek = String(entryKey || '');
        const f = String(file || '');
        if (!ek || !f) return;
        const pendKey = `${ek}:${f}`;

        // Archetype instance path
        const entry = this.instances.get(ek);
        if (entry) {
            const sm = entry.submeshes?.get?.(f);
            if (!sm) return;
            if (sm.mesh && !this.modelManager?.isMeshDisposed?.(sm.mesh)) return;
        } else {
            // Bucket path
            const b = this.buckets.get(ek);
            if (!b) return;
            if (b.mesh && !this.modelManager?.isMeshDisposed?.(b.mesh)) return;
        }

        if (this._meshLoadPending.has(pendKey)) return;
        this._meshLoadPending.add(pendKey);
        this._meshLoadQueue.push({ entryKey: ek, file: f });
    }

    _pumpMeshLoads() {
        if (!this.modelManager) return;
        while (this._meshLoadsInFlight < this.maxMeshLoadsInFlight && this._meshLoadQueue.length > 0) {
            const job = this._meshLoadQueue.shift();
            if (!job) break;
            const { entryKey, file } = job;
            const pendKey = `${entryKey}:${file}`;
            const entry = this.instances.get(entryKey);
            const sm = entry?.submeshes?.get?.(file);
            const bucket = this.buckets.get(entryKey);
            if (entry) {
                if (!sm || (sm.mesh && !this.modelManager?.isMeshDisposed?.(sm.mesh))) {
                    this._meshLoadPending.delete(pendKey);
                    continue;
                }
            } else {
                if (!bucket || (bucket.mesh && !this.modelManager?.isMeshDisposed?.(bucket.mesh))) {
                    this._meshLoadPending.delete(pendKey);
                    continue;
                }
            }

            this._meshLoadsInFlight++;
            (async () => {
                try {
                    const mesh = await this.modelManager.loadMeshFile(file);
                    if (!mesh) return;

                    // Assign mesh + build VAO for whichever kind of entry is present.
                    const e = this.instances.get(entryKey);
                    const sm2 = e?.submeshes?.get?.(file);
                    const b = this.buckets.get(entryKey);

                    if (e && sm2) {
                        sm2.mesh = mesh;
                        // Build a per-submesh VAO that includes instancing attributes.
                        try {
                            const gl = this.gl;
                            const vao = gl.createVertexArray();
                            gl.bindVertexArray(vao);

                            gl.bindBuffer(gl.ARRAY_BUFFER, mesh.posBuffer);
                            gl.enableVertexAttribArray(0);
                            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

                            if (mesh.nrmBuffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.nrmBuffer);
                                gl.enableVertexAttribArray(1);
                                gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
                            }

                            if (mesh.uvBuffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uvBuffer);
                                gl.enableVertexAttribArray(2);
                                gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
                            }
                            // aTexcoord1: location 9 (fallback to uv0 if absent)
                            if (mesh.uv1Buffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uv1Buffer);
                                gl.enableVertexAttribArray(9);
                                gl.vertexAttribPointer(9, 2, gl.FLOAT, false, 0, 0);
                            } else if (mesh.uvBuffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uvBuffer);
                                gl.enableVertexAttribArray(9);
                                gl.vertexAttribPointer(9, 2, gl.FLOAT, false, 0, 0);
                            } else {
                                try {
                                    gl.disableVertexAttribArray(9);
                                    gl.vertexAttrib2f(9, 0.0, 0.0);
                                } catch { /* ignore */ }
                            }

                            if (mesh.tanBuffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.tanBuffer);
                                gl.enableVertexAttribArray(3);
                                gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 0, 0);
                            }

                            if (mesh.col0Buffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.col0Buffer);
                                gl.enableVertexAttribArray(8);
                                gl.vertexAttribPointer(8, 4, gl.UNSIGNED_BYTE, true, 0, 0);
                            } else {
                                try {
                                    gl.disableVertexAttribArray(8);
                                    gl.vertexAttrib4f(8, 1.0, 1.0, 1.0, 1.0);
                                } catch { /* ignore */ }
                            }

                            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.idxBuffer);

                            gl.bindBuffer(gl.ARRAY_BUFFER, e.instanceBuffer);
                            const strideFloats = Number(e.instanceStrideFloats ?? 16);
                            const bytesPerMat = Math.max(16, strideFloats) * 4;
                            const bytesPerVec4 = 4 * 4;
                            for (let i = 0; i < 4; i++) {
                                const loc = 4 + i;
                                gl.enableVertexAttribArray(loc);
                                gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, bytesPerMat, i * bytesPerVec4);
                                gl.vertexAttribDivisor(loc, 1);
                            }
                            // Optional tint index at location 12.
                            if (strideFloats >= 17) {
                                gl.enableVertexAttribArray(12);
                                gl.vertexAttribPointer(12, 1, gl.FLOAT, false, bytesPerMat, 16 * 4);
                                gl.vertexAttribDivisor(12, 1);
                            } else {
                                try {
                                    gl.disableVertexAttribArray(12);
                                    gl.vertexAttrib1f(12, 0.0);
                                } catch { /* ignore */ }
                            }

                            gl.bindVertexArray(null);
                            sm2.vao = vao;
                        } catch {
                            sm2.vao = null;
                        }
                    } else if (b) {
                        b.mesh = mesh;
                        try {
                            const gl = this.gl;
                            const vao = gl.createVertexArray();
                            gl.bindVertexArray(vao);

                            gl.bindBuffer(gl.ARRAY_BUFFER, mesh.posBuffer);
                            gl.enableVertexAttribArray(0);
                            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

                            if (mesh.nrmBuffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.nrmBuffer);
                                gl.enableVertexAttribArray(1);
                                gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
                            }

                            if (mesh.uvBuffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uvBuffer);
                                gl.enableVertexAttribArray(2);
                                gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
                            }
                            // aTexcoord1: location 9 (fallback to uv0 if absent)
                            if (mesh.uv1Buffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uv1Buffer);
                                gl.enableVertexAttribArray(9);
                                gl.vertexAttribPointer(9, 2, gl.FLOAT, false, 0, 0);
                            } else if (mesh.uvBuffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uvBuffer);
                                gl.enableVertexAttribArray(9);
                                gl.vertexAttribPointer(9, 2, gl.FLOAT, false, 0, 0);
                            } else {
                                try {
                                    gl.disableVertexAttribArray(9);
                                    gl.vertexAttrib2f(9, 0.0, 0.0);
                                } catch { /* ignore */ }
                            }

                            if (mesh.tanBuffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.tanBuffer);
                                gl.enableVertexAttribArray(3);
                                gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 0, 0);
                            }

                            if (mesh.col0Buffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.col0Buffer);
                                gl.enableVertexAttribArray(8);
                                gl.vertexAttribPointer(8, 4, gl.UNSIGNED_BYTE, true, 0, 0);
                            } else {
                                try {
                                    gl.disableVertexAttribArray(8);
                                    gl.vertexAttrib4f(8, 1.0, 1.0, 1.0, 1.0);
                                } catch { /* ignore */ }
                            }

                            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.idxBuffer);

                            gl.bindBuffer(gl.ARRAY_BUFFER, b.instanceBuffer);
                            const strideFloats = Number(b.instanceStrideFloats ?? 16);
                            const bytesPerMat = Math.max(16, strideFloats) * 4;
                            const bytesPerVec4 = 4 * 4;
                            for (let i = 0; i < 4; i++) {
                                const loc = 4 + i;
                                gl.enableVertexAttribArray(loc);
                                gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, bytesPerMat, i * bytesPerVec4);
                                gl.vertexAttribDivisor(loc, 1);
                            }
                            if (strideFloats >= 17) {
                                gl.enableVertexAttribArray(12);
                                gl.vertexAttribPointer(12, 1, gl.FLOAT, false, bytesPerMat, 16 * 4);
                                gl.vertexAttribDivisor(12, 1);
                            } else {
                                try {
                                    gl.disableVertexAttribArray(12);
                                    gl.vertexAttrib1f(12, 0.0);
                                } catch { /* ignore */ }
                            }

                            gl.bindVertexArray(null);
                            b.vao = vao;
                        } catch {
                            b.vao = null;
                        }
                    }
                } finally {
                    this._meshLoadsInFlight--;
                    this._meshLoadPending.delete(pendKey);
                }
            })();
        }
    }

    /**
     * Let App drive mesh loading during a non-rendering loading phase.
     * (Render() also calls this, but we want to warm the cache before first frame.)
     */
    pumpMeshLoadsOnce() {
        this._pumpMeshLoads();
    }

    getMeshLoadStats() {
        return {
            inFlight: this._meshLoadsInFlight,
            queued: this._meshLoadQueue.length,
            pending: this._meshLoadPending.size,
            maxInFlight: this.maxMeshLoadsInFlight,
        };
    }

    /**
     * Best-effort: scan currently-instanced submeshes and prefetch diffuse textures.
     * This is capped to avoid doing huge work on boot.
     */
    prefetchDiffuseTextures(limit = 256) {
        if (!this.textureStreamer) return 0;
        const cap = Number.isFinite(limit) ? Math.max(0, Math.min(4096, Math.floor(limit))) : 256;
        let n = 0;
        const toUrl = (rel) => this._resolveAssetUrl(rel);

        // IMPORTANT:
        // - When cross-archetype instancing is enabled, most geometry is rendered via `buckets`.
        // - When it's disabled, geometry is rendered via per-archetype `instances`.
        // Prefetch must scan BOTH, otherwise you can see lots of meshes but 0 texture requests.

        // 1) Buckets (cross-archetype instancing path)
        for (const b of this.buckets.values()) {
            if (!b) continue;
            const mat = b.material || null;
            const diffuseRel = mat?.diffuse;
            if (!diffuseRel) continue;
            const url = toUrl(diffuseRel);
            if (url) this.textureStreamer.touch(url, { distance: 0, kind: 'diffuse', priority: 'low' });
            n++;
            if (n >= cap) return n;
        }

        // 2) Instances (per-archetype path)
        for (const entry of this.instances.values()) {
            if (!entry || entry.instanceCount <= 0) continue;
            for (const sm of entry.submeshes?.values?.() || []) {
                if (!sm) continue;
                const mat = sm.material || null;
                const diffuseRel = mat?.diffuse;
                if (diffuseRel) {
                    const url = toUrl(diffuseRel);
                    if (url) this.textureStreamer.touch(url, { distance: 0, kind: 'diffuse', priority: 'low' });
                    n++;
                    if (n >= cap) return n;
                }
            }
        }
        return n;
    }

    render(viewProjectionMatrix, enabled = true, cameraPos = [0, 0, 0], fog = { enabled: false, color: [0.6, 0.7, 0.8], start: 1500, end: 9000 }) {
        if (!enabled || !this.ready) return;
        const gl = this.gl;
        gl.useProgram(this.program.program);

        // Keep mesh loads flowing but bounded.
        this._pumpMeshLoads();

        const occlusion = fog?.occlusion || null;
        const viewportWidth = Number(fog?.viewportWidth ?? 0);
        const viewportHeight = Number(fog?.viewportHeight ?? 0);
        this._occlusionStats.tested = 0;
        this._occlusionStats.culled = 0;

        const shouldDrawByOcclusion = (instBounds, radiusSafe) => {
            if (!occlusion || typeof occlusion.isVisibleSphere !== 'function') return true;
            if (!instBounds) return true;
            if (!(viewportWidth > 2 && viewportHeight > 2)) return true;
            const r0 = Number(radiusSafe);
            if (!Number.isFinite(r0) || r0 <= 0) return true;

            const minT = instBounds.minT;
            const maxT = instBounds.maxT;
            const cx = (minT[0] + maxT[0]) * 0.5;
            const cy = (minT[1] + maxT[1]) * 0.5;
            const cz = (minT[2] + maxT[2]) * 0.5;
            const ex = (maxT[0] - minT[0]) * 0.5;
            const ey = (maxT[1] - minT[1]) * 0.5;
            const ez = (maxT[2] - minT[2]) * 0.5;

            // Spread radius from the translation AABB (covers all instances).
            const spread = Math.sqrt(ex * ex + ey * ey + ez * ez);
            const r = spread + r0 * (Number(instBounds.maxScale ?? 1) || 1);

            // Data -> viewer space (modelMatrix is rotation only).
            const v4 = glMatrix.vec4.fromValues(cx, cy, cz, 1.0);
            const out = glMatrix.vec4.create();
            glMatrix.vec4.transformMat4(out, v4, this.modelMatrix);

            this._occlusionStats.tested++;
            const vis = occlusion.isVisibleSphere({
                center: [out[0], out[1], out[2]],
                radius: r,
                viewProjectionMatrix,
                viewportWidth,
                viewportHeight,
            });
            if (!vis) this._occlusionStats.culled++;
            return !!vis;
        };

        gl.uniformMatrix4fv(this.uniforms.uViewProjectionMatrix, false, viewProjectionMatrix);
        gl.uniformMatrix4fv(this.uniforms.uModelMatrix, false, this.modelMatrix);
        gl.uniform3fv(this.uniforms.uColor, [0.85, 0.85, 0.9]);
        gl.uniform3fv(this.uniforms.uLightDir, [0.4, 0.85, 0.2]);
        gl.uniform1f(this.uniforms.uAmbient, 0.6);
        // Default UV scale/offset if not present in manifest.
        gl.uniform4fv(this.uniforms.uUv0ScaleOffset, [1.0, 1.0, 0.0, 0.0]);
        // Default CodeWalker GlobalUVAnim (identity).
        gl.uniform3fv(this.uniforms.uGlobalAnimUV0, [1.0, 0.0, 0.0]);
        gl.uniform3fv(this.uniforms.uGlobalAnimUV1, [0.0, 1.0, 0.0]);

        // Defaults for optional maps.
        gl.uniform1i(this.uniforms.uHasNormal, 0);
        gl.uniform1f(this.uniforms.uNormalScale, 1.0);
        gl.uniform1i(this.uniforms.uHasSpec, 0);
        gl.uniform1f(this.uniforms.uSpecularIntensity, 0.25);
        gl.uniform1f(this.uniforms.uSpecularPower, 24.0);
        gl.uniform3fv(this.uniforms.uSpecMaskWeights, [1.0, 0.0, 0.0]);
        gl.uniform1i(this.uniforms.uHasEmissive, 0);
        gl.uniform1f(this.uniforms.uEmissiveIntensity, 1.0);
        gl.uniform1i(this.uniforms.uAlphaMode, 0);
        gl.uniform1f(this.uniforms.uAlphaCutoff, 0.33);
        gl.uniform1f(this.uniforms.uAlphaScale, 1.0);
        gl.uniform1f(this.uniforms.uHardAlphaBlend, 0.0);
        gl.uniform1i(this.uniforms.uHasDiffuse2, 0);
        gl.uniform1i(this.uniforms.uHasDetail, 0);
        gl.uniform4fv(this.uniforms.uDetailSettings, [0.0, 0.0, 1.0, 1.0]);
        gl.uniform1i(this.uniforms.uHasAO, 0);
        gl.uniform1f(this.uniforms.uAOStrength, 1.0);
        // Defaults; updated per-frame/per-draw as needed.
        gl.uniform1i(this.uniforms.uDecodeSrgb, 0);
        gl.uniform1i(this.uniforms.uNormalEncoding, 0);
        gl.uniform1i(this.uniforms.uNormalReconstructZ, 1);
        gl.uniform1i(this.uniforms.uShaderFamily, 0);
        gl.uniform1i(this.uniforms.uHasAlphaMask, 0);
        gl.uniform1f(this.uniforms.uReflectionIntensity, 0.6);
        gl.uniform1f(this.uniforms.uFresnelPower, 5.0);
        gl.uniform3fv(this.uniforms.uEnvColor, fog?.color || [0.6, 0.7, 0.8]);

        gl.uniform3fv(this.uniforms.uCameraPos, cameraPos);
        gl.uniform1i(this.uniforms.uFogEnabled, fog?.enabled ? 1 : 0);
        gl.uniform3fv(this.uniforms.uFogColor, fog?.color || [0.6, 0.7, 0.8]);
        gl.uniform1f(this.uniforms.uFogStart, Number(fog?.start ?? 1500));
        gl.uniform1f(this.uniforms.uFogEnd, Number(fog?.end ?? 9000));

        gl.enable(gl.DEPTH_TEST);

        // ---- RenderBucket + distance sorting (CodeWalker-ish layering) ----
        // We render in multiple passes so decals/glass/alpha blend correctly:
        //   OPAQUE -> CUTOUT -> DECAL -> ALPHA (back-to-front) -> ADDITIVE
        const BUCKET = {
            OPAQUE: 0,
            CUTOUT: 1,
            DECAL: 2,
            ALPHA: 3,
            ADDITIVE: 4,
        };

        const classifyBucket = (shaderName, alphaModeInt, shaderFamily = null) => {
            const s = String(shaderName || '').toLowerCase();
            const fam = String(shaderFamily || '').toLowerCase();
            if (fam === 'decal') return BUCKET.DECAL;
            if (fam === 'glass' || fam === 'env') return BUCKET.ALPHA;
            if (s.includes('decal')) return BUCKET.DECAL;
            if (s.includes('glass')) return BUCKET.ALPHA;
            if (s.includes('additive') || s.includes('emissiveadd') || s.includes('add_') || s.includes('_add')) return BUCKET.ADDITIVE;
            if (alphaModeInt === 2) return BUCKET.ALPHA;
            if (alphaModeInt === 1) return BUCKET.CUTOUT;
            return BUCKET.OPAQUE;
        };

        const computeSortDist = (instBounds) => {
            if (!instBounds || !instBounds.minT || !instBounds.maxT) return null;
            try {
                const minT = instBounds.minT;
                const maxT = instBounds.maxT;
                const cx = (minT[0] + maxT[0]) * 0.5;
                const cy = (minT[1] + maxT[1]) * 0.5;
                const cz = (minT[2] + maxT[2]) * 0.5;
                // Data -> viewer space (modelMatrix is rotation only).
                const v4 = glMatrix.vec4.fromValues(cx, cy, cz, 1.0);
                const out = glMatrix.vec4.create();
                glMatrix.vec4.transformMat4(out, v4, this.modelMatrix);
                const dx = out[0] - (cameraPos?.[0] ?? 0);
                const dy = out[1] - (cameraPos?.[1] ?? 0);
                const dz = out[2] - (cameraPos?.[2] ?? 0);
                return Math.sqrt(dx * dx + dy * dy + dz * dz);
            } catch {
                return null;
            }
        };

        // ---- A5: Render-pass state sorting + binding cache ----
        /** @type {Array<any>} */
        const drawItems = [];
        let seq = 0;

        const makeUvso = (uvso) => {
            if (uvso && Array.isArray(uvso) && uvso.length >= 4) {
                const sx = Number(uvso[0]), sy = Number(uvso[1]), ox = Number(uvso[2]), oy = Number(uvso[3]);
                if (Number.isFinite(sx) && Number.isFinite(sy) && Number.isFinite(ox) && Number.isFinite(oy)) return [sx, sy, ox, oy];
            }
            return [1.0, 1.0, 0.0, 0.0];
        };

        const materialSigFor = (entryMat, subMat) => {
            try {
                if (this.modelManager?.getEffectiveMaterialAndSignature) {
                    return this.modelManager.getEffectiveMaterialAndSignature(entryMat ?? null, subMat ?? null).sig;
                }
            } catch { /* ignore */ }
            // Fallback: best-effort stable-ish key.
            const eff = { ...(entryMat || {}), ...(subMat || {}) };
            return JSON.stringify({ diffuse: eff.diffuse ?? null, normal: eff.normal ?? null, spec: eff.spec ?? null, uv0ScaleOffset: eff.uv0ScaleOffset ?? null, bumpiness: eff.bumpiness ?? null, specularIntensity: eff.specularIntensity ?? null, specularPower: eff.specularPower ?? null });
        };

        // Prefer KTX2 variants when present; fall back to PNG paths.
        // Viewer can always load PNG; KTX2 support is best-effort.
        const preferKtx2 = true;
        const pickTex = (mat, keyBase) => {
            const m = (mat && typeof mat === 'object') ? mat : {};
            const k2 = `${keyBase}Ktx2`;
            const v2 = preferKtx2 ? (m[k2] ?? null) : null;
            const v1 = m[keyBase] ?? null;
            return (typeof v2 === 'string' && v2) ? v2 : ((typeof v1 === 'string' && v1) ? v1 : null);
        };

        const computeRadiusSafe = (mesh) => {
            const c = mesh?.bounds?.center;
            const off = (c && c.length >= 3) ? Math.sqrt((c[0] || 0) ** 2 + (c[1] || 0) ** 2 + (c[2] || 0) ** 2) : 0;
            return (Number(mesh?.radius ?? 0) || 0) + off;
        };

        // Gather bucket draw items.
        for (const [_id, b] of this.buckets.entries()) {
            if (!b || b.instanceCount <= 0 || !b.mesh) continue;
            const dist = Number.isFinite(Number(b.minDist)) ? Number(b.minDist) : 0;

            if (this.modelManager?.isMeshDisposed?.(b.mesh)) {
                try { if (b.vao) gl.deleteVertexArray(b.vao); } catch { /* ignore */ }
                b.vao = null;
                b.mesh = null;
                this._enqueueMeshLoad(b.bucketId, b.file);
                continue;
            }
            this.modelManager?.touchMesh?.(b.mesh);

            const radiusSafe = computeRadiusSafe(b.mesh);
            if (!shouldDrawByOcclusion(b._instBounds, radiusSafe)) continue;

            const mat = b.material || null;
            const shaderFamily = String(mat?.shaderFamily || '').toLowerCase();
            const alphaModeStr = String(mat?.alphaMode || 'opaque').toLowerCase();
            let alphaModeInt = (alphaModeStr === 'cutout') ? 1 : ((alphaModeStr === 'blend') ? 2 : 0);
            // Family overrides: decals/glass are effectively blended in our current pipeline.
            if (shaderFamily === 'decal' || shaderFamily === 'glass' || shaderFamily === 'env') alphaModeInt = 2;
            const shaderName = String(mat?.shaderName || '');
            drawItems.push({
                kind: 'bucket',
                seq: seq++,
                materialSig: materialSigFor(null, mat),
                meshKey: String(b.file || ''),
                meshHasTangents: !!(b.mesh?.tanBuffer),
                dist,
                instanceStrideFloats: Number(b.instanceStrideFloats ?? 16),
                sortDist: computeSortDist(b._instBounds),
                shaderName,
                shaderFamily,
                shaderFamilyInt: (shaderFamily === 'decal') ? 1 : ((shaderFamily === 'glass' || shaderFamily === 'env') ? 2 : 0),
                renderBucket: classifyBucket(shaderName, alphaModeInt, shaderFamily),
                instBounds: b._instBounds || null,
                uvso: makeUvso(mat?.uv0ScaleOffset),
                globalAnimUV0: (Array.isArray(mat?.globalAnimUV0) && mat.globalAnimUV0.length >= 3) ? mat.globalAnimUV0 : [1.0, 0.0, 0.0],
                globalAnimUV1: (Array.isArray(mat?.globalAnimUV1) && mat.globalAnimUV1.length >= 3) ? mat.globalAnimUV1 : [0.0, 1.0, 0.0],
                diffuseRel: pickTex(mat, 'diffuse'),
                diffuse2Rel: pickTex(mat, 'diffuse2'),
                diffuse2Uv: mat?.diffuse2Uv ?? null,
                normalRel: pickTex(mat, 'normal'),
                normalEncoding: (String(mat?.normalSwizzle || 'rg').toLowerCase() === 'ag') ? 1 : 0,
                normalReconstructZ: (mat?.normalReconstructZ === undefined || mat?.normalReconstructZ === null) ? 1 : Number(mat?.normalReconstructZ),
                detailRel: pickTex(mat, 'detail'),
                specRel: pickTex(mat, 'spec'),
                emissiveRel: pickTex(mat, 'emissive'),
                aoRel: pickTex(mat, 'ao'),
                aoStrength: Number(mat?.aoStrength ?? 1.0),
                alphaMaskRel: pickTex(mat, 'alphaMask'),
                decalDepthBias: Number(mat?.decalDepthBias ?? 1.0),
                decalSlopeScale: Number(mat?.decalSlopeScale ?? 1.0),
                reflectionIntensity: Number(mat?.reflectionIntensity ?? 0.6),
                fresnelPower: Number(mat?.fresnelPower ?? 5.0),
                hardAlphaBlend: Number(mat?.hardAlphaBlend ?? 0.0),
                alphaModeInt,
                alphaCutoff: Number(mat?.alphaCutoff ?? 0.33),
                alphaScale: Number(mat?.alphaScale ?? 1.0),
                doubleSided: !!mat?.doubleSided,
                specMaskWeights: Array.isArray(mat?.specMaskWeights) ? mat.specMaskWeights : null,
                detailSettings: Array.isArray(mat?.detailSettings) ? mat.detailSettings : null,
                bumpiness: Number((mat?.bumpiness) ?? 1.0),
                specIntensity: Number((mat?.specularIntensity) ?? 0.25),
                specPower: Number((mat?.specularPower) ?? 24.0),
                emissiveIntensity: Number((mat?.emissiveIntensity) ?? 1.0),
                vao: b.vao || null,
                mesh: b.mesh,
                instanceBuffer: b.instanceBuffer,
                instanceCount: b.instanceCount,
                entryInstanceBuffer: null,
            });
        }

        // Gather archetype-submesh draw items.
        for (const [_hash, entry] of this.instances.entries()) {
            if (!entry || entry.instanceCount <= 0) continue;
            const dist = Number.isFinite(Number(entry.minDist)) ? Number(entry.minDist) : 0;

            let fallbackMat = null;
            try {
                const h0 = this.modelManager?.normalizeId?.(entry.hash) ?? String(entry.hash || '');
                fallbackMat = this.modelManager?.manifest?.meshes?.[h0]?.material ?? null;
            } catch {
                fallbackMat = null;
            }

            let maxRadiusSafe = 0.0;
            for (const sm0 of entry.submeshes?.values?.() || []) {
                const m0 = sm0?.mesh;
                if (!m0) continue;
                const r0 = computeRadiusSafe(m0);
                if (r0 > maxRadiusSafe) maxRadiusSafe = r0;
            }
            if (maxRadiusSafe > 0 && !shouldDrawByOcclusion(entry._instBounds, maxRadiusSafe)) continue;

            for (const sm of entry.submeshes?.values?.() || []) {
                if (!sm || !sm.mesh) continue;
                if (this.modelManager?.isMeshDisposed?.(sm.mesh)) {
                    try { if (sm.vao) gl.deleteVertexArray(sm.vao); } catch { /* ignore */ }
                    sm.vao = null;
                    sm.mesh = null;
                    this._enqueueMeshLoad(`${entry.hash}:${entry.lod}`, sm.file);
                    continue;
                }
                this.modelManager?.touchMesh?.(sm.mesh);

                const subMat = sm.material || null;
                const eff = { ...(fallbackMat || {}), ...(subMat || {}) };
                const shaderFamily = String(eff?.shaderFamily || '').toLowerCase();
                const alphaModeStr = String(eff?.alphaMode || 'opaque').toLowerCase();
                let alphaModeInt = (alphaModeStr === 'cutout') ? 1 : ((alphaModeStr === 'blend') ? 2 : 0);
                if (shaderFamily === 'decal' || shaderFamily === 'glass' || shaderFamily === 'env') alphaModeInt = 2;
                const shaderName = String(eff?.shaderName || '');

                drawItems.push({
                    kind: 'submesh',
                    seq: seq++,
                    materialSig: materialSigFor(fallbackMat, subMat),
                    meshKey: String(sm.file || ''),
                    meshHasTangents: !!(sm.mesh?.tanBuffer),
                    dist,
                    instanceStrideFloats: Number(entry.instanceStrideFloats ?? 16),
                    sortDist: computeSortDist(entry._instBounds),
                    shaderName,
                    shaderFamily,
                    shaderFamilyInt: (shaderFamily === 'decal') ? 1 : ((shaderFamily === 'glass' || shaderFamily === 'env') ? 2 : 0),
                    renderBucket: classifyBucket(shaderName, alphaModeInt, shaderFamily),
                    instBounds: entry._instBounds || null,
                    uvso: makeUvso(eff?.uv0ScaleOffset),
                    globalAnimUV0: (Array.isArray(eff?.globalAnimUV0) && eff.globalAnimUV0.length >= 3) ? eff.globalAnimUV0 : [1.0, 0.0, 0.0],
                    globalAnimUV1: (Array.isArray(eff?.globalAnimUV1) && eff.globalAnimUV1.length >= 3) ? eff.globalAnimUV1 : [0.0, 1.0, 0.0],
                    diffuseRel: pickTex(eff, 'diffuse'),
                    diffuse2Rel: pickTex(eff, 'diffuse2'),
                    diffuse2Uv: eff?.diffuse2Uv ?? null,
                    normalRel: pickTex(eff, 'normal'),
                    normalEncoding: (String(eff?.normalSwizzle || 'rg').toLowerCase() === 'ag') ? 1 : 0,
                    normalReconstructZ: (eff?.normalReconstructZ === undefined || eff?.normalReconstructZ === null) ? 1 : Number(eff?.normalReconstructZ),
                    detailRel: pickTex(eff, 'detail'),
                    specRel: pickTex(eff, 'spec'),
                    emissiveRel: pickTex(eff, 'emissive'),
                    aoRel: pickTex(eff, 'ao'),
                    aoStrength: Number(eff?.aoStrength ?? 1.0),
                    alphaMaskRel: pickTex(eff, 'alphaMask'),
                    decalDepthBias: Number(eff?.decalDepthBias ?? 1.0),
                    decalSlopeScale: Number(eff?.decalSlopeScale ?? 1.0),
                    reflectionIntensity: Number(eff?.reflectionIntensity ?? 0.6),
                    fresnelPower: Number(eff?.fresnelPower ?? 5.0),
                    hardAlphaBlend: Number(eff?.hardAlphaBlend ?? 0.0),
                    alphaModeInt,
                    alphaCutoff: Number(eff?.alphaCutoff ?? 0.33),
                    alphaScale: Number(eff?.alphaScale ?? 1.0),
                    doubleSided: !!eff?.doubleSided,
                    specMaskWeights: Array.isArray(eff?.specMaskWeights) ? eff.specMaskWeights : null,
                    detailSettings: Array.isArray(eff?.detailSettings) ? eff.detailSettings : null,
                    bumpiness: Number(eff?.bumpiness ?? 1.0),
                    specIntensity: Number(eff?.specularIntensity ?? 0.25),
                    specPower: Number(eff?.specularPower ?? 24.0),
                    emissiveIntensity: Number(eff?.emissiveIntensity ?? 1.0),
                    vao: sm.vao || null,
                    mesh: sm.mesh,
                    instanceBuffer: entry.instanceBuffer,
                    instanceCount: entry.instanceCount,
                });
            }
        }

        // Stable-ish sort: material signature first, then tangents presence, then mesh key, then sequence.
        drawItems.sort((a, b) => {
            if (a.materialSig !== b.materialSig) return (a.materialSig < b.materialSig) ? -1 : 1;
            const ta = a.meshHasTangents ? 1 : 0;
            const tb = b.meshHasTangents ? 1 : 0;
            if (ta !== tb) return ta - tb;
            if (a.meshKey !== b.meshKey) return (a.meshKey < b.meshKey) ? -1 : 1;
            return a.seq - b.seq;
        });

        // Render stats for Perf HUD (lightweight counters).
        this._renderStats.drawCalls = 0;
        this._renderStats.triangles = 0;
        this._renderStats.instances = 0;
        this._renderStats.bucketDraws = 0;
        this._renderStats.submeshDraws = 0;
        this._renderStats.drawItems = drawItems.length;
        this._renderStats.diffuseWanted = 0;
        this._renderStats.diffusePlaceholder = 0;
        this._renderStats.diffuseReal = 0;
        this._renderStats.drawItemsMissingUv = 0;

        // Bind cache to reduce redundant GL calls.
        const state = {
            vao: null,
            uvso: null,
            uvAnim0: null,
            uvAnim1: null,
            hasDiffuse: null,
            hasDiffuse2: null,
            diffuse2UseUv1: null,
            hasNormal: null,
            hasDetail: null,
            hasSpec: null,
            hasEmissive: null,
            shaderFamily: null,
            hasAlphaMask: null,
            alphaMode: null,
            alphaCutoff: null,
            alphaScale: null,
            hardAlphaBlend: null,
            blendEnabled: null,
            depthMask: null,
            decodeSrgb: null,
            normalEncoding: null,
            normalReconstructZ: null,
            specMaskWeights: null,
            doubleSided: null,
            normalScale: null,
            detailSettings: null,
            specIntensity: null,
            specPower: null,
            emissiveIntensity: null,
            reflectionIntensity: null,
            fresnelPower: null,
            envColor: null,
            tex0: null,
            tex0b: null,
            tex1: null,
            tex2: null,
            tex3: null,
            texDetail: null,
            texAO: null,
            texAlphaMask: null,
            activeUnit: -1,
            polyOffset: null,
        };

        const setUvsoCached = (uvso4) => {
            const v = uvso4 || [1.0, 1.0, 0.0, 0.0];
            const p = state.uvso;
            if (p && p[0] === v[0] && p[1] === v[1] && p[2] === v[2] && p[3] === v[3]) return;
            gl.uniform4fv(this.uniforms.uUv0ScaleOffset, v);
            state.uvso = [v[0], v[1], v[2], v[3]];
        };
        const setUvAnimCached = (a0, a1) => {
            // Each is vec3 (ax, ay, a1) used as dot(a, vec3(uv,1)).
            const v0 = Array.isArray(a0) && a0.length >= 3 ? a0 : [1.0, 0.0, 0.0];
            const v1 = Array.isArray(a1) && a1.length >= 3 ? a1 : [0.0, 1.0, 0.0];
            const p0 = state.uvAnim0;
            const p1 = state.uvAnim1;
            if (
                p0 && p1 &&
                p0[0] === v0[0] && p0[1] === v0[1] && p0[2] === v0[2] &&
                p1[0] === v1[0] && p1[1] === v1[1] && p1[2] === v1[2]
            ) return;
            gl.uniform3fv(this.uniforms.uGlobalAnimUV0, [Number(v0[0]) || 0, Number(v0[1]) || 0, Number(v0[2]) || 0]);
            gl.uniform3fv(this.uniforms.uGlobalAnimUV1, [Number(v1[0]) || 0, Number(v1[1]) || 0, Number(v1[2]) || 0]);
            state.uvAnim0 = [v0[0], v0[1], v0[2]];
            state.uvAnim1 = [v1[0], v1[1], v1[2]];
        };

        const toAssetUrl = (rel) => this._resolveAssetUrl(rel);

        const set1iCached = (loc, next, key) => {
            if (state[key] === next) return;
            gl.uniform1i(loc, next);
            state[key] = next;
        };
        const set1fCached = (loc, next, key, fallback) => {
            const v = Number.isFinite(Number(next)) ? Number(next) : fallback;
            if (state[key] === v) return;
            gl.uniform1f(loc, v);
            state[key] = v;
        };
        const set3fCached = (loc, arr3, key, fallbackArr) => {
            const a = Array.isArray(arr3) && arr3.length >= 3 ? arr3 : fallbackArr;
            const v0 = Number(a[0]), v1 = Number(a[1]), v2 = Number(a[2]);
            const f0 = Number.isFinite(v0) ? v0 : fallbackArr[0];
            const f1 = Number.isFinite(v1) ? v1 : fallbackArr[1];
            const f2 = Number.isFinite(v2) ? v2 : fallbackArr[2];
            const prev = state[key];
            if (prev && prev[0] === f0 && prev[1] === f1 && prev[2] === f2) return;
            gl.uniform3fv(loc, [f0, f1, f2]);
            state[key] = [f0, f1, f2];
        };
        const setAlphaModeCached = (modeInt, cutoff, scale) => {
            const m = Number.isFinite(Number(modeInt)) ? Number(modeInt) : 0;
            if (state.alphaMode !== m) {
                gl.uniform1i(this.uniforms.uAlphaMode, m);
                state.alphaMode = m;
            }
            set1fCached(this.uniforms.uAlphaCutoff, cutoff, 'alphaCutoff', 0.33);
            set1fCached(this.uniforms.uAlphaScale, scale, 'alphaScale', 1.0);
        };
        const setCullCached = (doubleSided) => {
            const ds = !!doubleSided;
            if (state.doubleSided === ds) return;
            state.doubleSided = ds;
            if (ds) {
                gl.disable(gl.CULL_FACE);
            } else {
                gl.enable(gl.CULL_FACE);
                gl.cullFace(gl.BACK);
            }
        };

        const setDecodeSrgbCached = (decodeSrgb) => {
            const v = !!decodeSrgb;
            if (state.decodeSrgb === v) return;
            gl.uniform1i(this.uniforms.uDecodeSrgb, v ? 1 : 0);
            state.decodeSrgb = v;
        };

        const setNormalDecodeCached = (encodingInt, reconstructZ) => {
            const e = Number.isFinite(Number(encodingInt)) ? Number(encodingInt) : 0;
            const rz = (Number.isFinite(Number(reconstructZ)) ? Number(reconstructZ) : 1) > 0.5;
            if (state.normalEncoding !== e) {
                gl.uniform1i(this.uniforms.uNormalEncoding, e);
                state.normalEncoding = e;
            }
            if (state.normalReconstructZ !== rz) {
                gl.uniform1i(this.uniforms.uNormalReconstructZ, rz ? 1 : 0);
                state.normalReconstructZ = rz;
            }
        };
        const setBlendForAlphaMode = (modeInt, hardAlphaBlend) => {
            const m = Number.isFinite(Number(modeInt)) ? Number(modeInt) : 0;
            const hab = Number.isFinite(Number(hardAlphaBlend)) ? Number(hardAlphaBlend) : 0.0;
            const habOn = hab > 0.5;

            // For blend mode, enable blending.
            // For opaque/cutout, disable blending + enable depth writes.
            if (m === 2) {
                if (!state.blendEnabled) {
                    gl.enable(gl.BLEND);
                    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
                    state.blendEnabled = true;
                }
                // Hard alpha blend keeps depth writes enabled to reduce sorting artifacts.
                if (state.depthMask !== habOn) {
                    gl.depthMask(habOn);
                    state.depthMask = habOn;
                }
            } else {
                if (state.blendEnabled !== false) {
                    gl.disable(gl.BLEND);
                    state.blendEnabled = false;
                }
                if (state.depthMask !== true) {
                    gl.depthMask(true);
                    state.depthMask = true;
                }
            }
        };

        const bindTexCached = (unit, tex, stateKey) => {
            if (state[stateKey] === tex) return;
            if (state.activeUnit !== unit) {
                gl.activeTexture(gl.TEXTURE0 + unit);
                state.activeUnit = unit;
            }
            gl.bindTexture(gl.TEXTURE_2D, tex);
            state[stateKey] = tex;
        };

        // Sampler uniforms are constant.
        gl.uniform1i(this.uniforms.uDiffuse, 0);
        gl.uniform1i(this.uniforms.uDiffuse2, 4);
        gl.uniform1i(this.uniforms.uNormal, 1);
        gl.uniform1i(this.uniforms.uDetail, 5);
        gl.uniform1i(this.uniforms.uSpec, 2);
        gl.uniform1i(this.uniforms.uEmissive, 3);
        gl.uniform1i(this.uniforms.uAO, 6);
        gl.uniform1i(this.uniforms.uAlphaMask, 7);
        gl.uniform1i(this.uniforms.uTintPalette, 8);
        gl.uniform1i(this.uniforms.uDecodeSrgb, 0);
        gl.uniform1i(this.uniforms.uNormalEncoding, 0);
        gl.uniform1i(this.uniforms.uNormalReconstructZ, 1);

        // Bind tiny tint palette once per frame (unit 8).
        try {
            gl.activeTexture(gl.TEXTURE0 + 8);
            gl.bindTexture(gl.TEXTURE_2D, this.tintPaletteTex);
        } catch { /* ignore */ }
        try {
            gl.uniform1i(this.uniforms.uEnableTintPalette, this.tintPaletteTex ? 1 : 0);
        } catch { /* ignore */ }

        for (const it of drawItems) {
            const mesh = it.mesh;
            if (!mesh) continue;

            this._renderStats.drawCalls++;
            const inst = Number(it.instanceCount) || 0;
            this._renderStats.instances += inst;
            const idx = Number(mesh.indexCount) || 0;
            this._renderStats.triangles += Math.floor((idx / 3) * inst);
            if (it.kind === 'bucket') this._renderStats.bucketDraws++;
            else this._renderStats.submeshDraws++;

            setUvsoCached(it.uvso);
            setUvAnimCached(it.globalAnimUV0, it.globalAnimUV1);

            // Color pipeline: if the streamer can't upload sRGB textures, decode in shader.
            const needDecode = !(this.textureStreamer?.supportsSrgbTextures?.() === true);
            setDecodeSrgbCached(needDecode);

            // Normal decode defaults to reconstruct Z; override via material if present.
            setNormalDecodeCached(it.normalEncoding ?? 0, it.normalReconstructZ ?? 1);

            // Cull + alpha mode render state.
            setCullCached(!!it.doubleSided);
            // Decal: enable polygon offset + treat as blended. Glass: treat as blended.
            if (it.shaderFamilyInt === 1) {
                const slope = Number(it.decalSlopeScale ?? 1.0);
                const bias = Number(it.decalDepthBias ?? 1.0);
                const p = [Number.isFinite(slope) ? slope : 1.0, Number.isFinite(bias) ? bias : 1.0];
                if (!state.polyOffset || state.polyOffset[0] !== p[0] || state.polyOffset[1] !== p[1]) {
                    gl.enable(gl.POLYGON_OFFSET_FILL);
                    gl.polygonOffset(p[0], p[1]);
                    state.polyOffset = p;
                }
                // Blend ON, depthMask OFF for decals.
                if (state.blendEnabled !== true) {
                    gl.enable(gl.BLEND);
                    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
                    state.blendEnabled = true;
                }
                if (state.depthMask !== false) {
                    gl.depthMask(false);
                    state.depthMask = false;
                }
            } else {
                if (state.polyOffset !== null) {
                    gl.disable(gl.POLYGON_OFFSET_FILL);
                    state.polyOffset = null;
                }
                // For glass/alpha blend we still use existing alpha handling.
                setBlendForAlphaMode(it.alphaModeInt, it.hardAlphaBlend);
            }
            setAlphaModeCached(it.alphaModeInt, it.alphaCutoff, it.alphaScale);
            set1fCached(this.uniforms.uHardAlphaBlend, it.hardAlphaBlend, 'hardAlphaBlend', 0.0);

            // Shader family switch + family-specific uniforms.
            if (state.shaderFamily !== it.shaderFamilyInt) {
                gl.uniform1i(this.uniforms.uShaderFamily, it.shaderFamilyInt | 0);
                state.shaderFamily = it.shaderFamilyInt | 0;
            }
            // Env color defaults to fog color (no probes yet).
            const env = fog?.color || [0.6, 0.7, 0.8];
            if (!state.envColor || state.envColor[0] !== env[0] || state.envColor[1] !== env[1] || state.envColor[2] !== env[2]) {
                gl.uniform3fv(this.uniforms.uEnvColor, env);
                state.envColor = [env[0], env[1], env[2]];
            }
            if (state.reflectionIntensity !== it.reflectionIntensity) {
                gl.uniform1f(this.uniforms.uReflectionIntensity, Number.isFinite(it.reflectionIntensity) ? it.reflectionIntensity : 0.6);
                state.reflectionIntensity = it.reflectionIntensity;
            }
            if (state.fresnelPower !== it.fresnelPower) {
                gl.uniform1f(this.uniforms.uFresnelPower, Number.isFinite(it.fresnelPower) ? it.fresnelPower : 5.0);
                state.fresnelPower = it.fresnelPower;
            }

            // If a mesh has no UVs, diffuse will sample a constant texel (often looks "untextured").
            if (!mesh.uvBuffer) this._renderStats.drawItemsMissingUv++;

            // Diffuse
            if (it.diffuseRel && this.textureStreamer) {
                const url = toAssetUrl(it.diffuseRel);
                if (url) this.textureStreamer.touch(url, { distance: it.dist, kind: 'diffuse' });
                const tex = url ? this.textureStreamer.get(url, { distance: it.dist, kind: 'diffuse' }) : this.textureStreamer.placeholder;
                bindTexCached(0, tex, 'tex0');
                set1iCached(this.uniforms.uHasDiffuse, 1, 'hasDiffuse');
                this._renderStats.diffuseWanted++;
                if (tex === this.textureStreamer.placeholder) this._renderStats.diffusePlaceholder++;
                else this._renderStats.diffuseReal++;
            } else {
                set1iCached(this.uniforms.uHasDiffuse, 0, 'hasDiffuse');
            }

            // Alpha mask (decal)
            if (it.alphaMaskRel && this.textureStreamer) {
                const url = toAssetUrl(it.alphaMaskRel);
                if (url) this.textureStreamer.touch(url, { distance: it.dist, kind: 'alphaMask' });
                const tex = url ? this.textureStreamer.get(url, { distance: it.dist, kind: 'alphaMask' }) : this.textureStreamer.placeholder;
                bindTexCached(7, tex, 'texAlphaMask');
                set1iCached(this.uniforms.uHasAlphaMask, 1, 'hasAlphaMask');
            } else {
                set1iCached(this.uniforms.uHasAlphaMask, 0, 'hasAlphaMask');
            }

            // Diffuse2
            if (it.diffuse2Rel && this.textureStreamer) {
                const url = toAssetUrl(it.diffuse2Rel);
                if (url) this.textureStreamer.touch(url, { distance: it.dist, kind: 'diffuse2' });
                const tex = url ? this.textureStreamer.get(url, { distance: it.dist, kind: 'diffuse2' }) : this.textureStreamer.placeholder;
                bindTexCached(4, tex, 'tex0b');
                set1iCached(this.uniforms.uHasDiffuse2, 1, 'hasDiffuse2');
                // Default to UV1 unless explicitly requested otherwise.
                const useUv1 = (String(it.diffuse2Uv || 'uv1').toLowerCase() !== 'uv0');
                if (state.diffuse2UseUv1 !== useUv1) {
                    gl.uniform1i(this.uniforms.uDiffuse2UseUv1, useUv1 ? 1 : 0);
                    state.diffuse2UseUv1 = useUv1;
                }
            } else {
                set1iCached(this.uniforms.uHasDiffuse2, 0, 'hasDiffuse2');
                if (state.diffuse2UseUv1 !== true) {
                    gl.uniform1i(this.uniforms.uDiffuse2UseUv1, 1);
                    state.diffuse2UseUv1 = true;
                }
            }

            // Normal/spec require tangents on the mesh to shade correctly.
            const hasTangents = !!it.meshHasTangents;

            if (hasTangents && it.normalRel && this.textureStreamer) {
                const url = toAssetUrl(it.normalRel);
                if (url) this.textureStreamer.touch(url, { distance: it.dist, kind: 'normal' });
                const tex = url ? this.textureStreamer.get(url, { distance: it.dist, kind: 'normal' }) : this.textureStreamer.placeholder;
                bindTexCached(1, tex, 'tex1');
                set1iCached(this.uniforms.uHasNormal, 1, 'hasNormal');
                set1fCached(this.uniforms.uNormalScale, it.bumpiness, 'normalScale', 1.0);
            } else {
                set1iCached(this.uniforms.uHasNormal, 0, 'hasNormal');
                set1fCached(this.uniforms.uNormalScale, 1.0, 'normalScale', 1.0);
            }

            // Detail (only meaningful if we have tangents + normal path)
            if (hasTangents && it.detailRel && this.textureStreamer) {
                const url = toAssetUrl(it.detailRel);
                if (url) this.textureStreamer.touch(url, { distance: it.dist, kind: 'detail' });
                const tex = url ? this.textureStreamer.get(url, { distance: it.dist, kind: 'detail' }) : this.textureStreamer.placeholder;
                bindTexCached(5, tex, 'texDetail');
                set1iCached(this.uniforms.uHasDetail, 1, 'hasDetail');
                // detailSettings: [x,y,z,w]
                const ds = Array.isArray(it.detailSettings) && it.detailSettings.length >= 4 ? it.detailSettings : [0.0, 0.0, 1.0, 1.0];
                const prev = state.detailSettings;
                const a0 = Number(ds[0]), a1 = Number(ds[1]), a2 = Number(ds[2]), a3 = Number(ds[3]);
                const v = [
                    Number.isFinite(a0) ? a0 : 0.0,
                    Number.isFinite(a1) ? a1 : 0.0,
                    Number.isFinite(a2) ? a2 : 1.0,
                    Number.isFinite(a3) ? a3 : 1.0,
                ];
                if (!(prev && prev[0] === v[0] && prev[1] === v[1] && prev[2] === v[2] && prev[3] === v[3])) {
                    gl.uniform4fv(this.uniforms.uDetailSettings, v);
                    state.detailSettings = v;
                }
            } else {
                set1iCached(this.uniforms.uHasDetail, 0, 'hasDetail');
                if (!state.detailSettings || state.detailSettings[0] !== 0.0 || state.detailSettings[1] !== 0.0 || state.detailSettings[2] !== 1.0 || state.detailSettings[3] !== 1.0) {
                    gl.uniform4fv(this.uniforms.uDetailSettings, [0.0, 0.0, 1.0, 1.0]);
                    state.detailSettings = [0.0, 0.0, 1.0, 1.0];
                }
            }

            if (hasTangents && it.specRel && this.textureStreamer) {
                const url = toAssetUrl(it.specRel);
                if (url) this.textureStreamer.touch(url, { distance: it.dist, kind: 'spec' });
                const tex = url ? this.textureStreamer.get(url, { distance: it.dist, kind: 'spec' }) : this.textureStreamer.placeholder;
                bindTexCached(2, tex, 'tex2');
                set1iCached(this.uniforms.uHasSpec, 1, 'hasSpec');
            } else {
                set1iCached(this.uniforms.uHasSpec, 0, 'hasSpec');
            }
            set1fCached(this.uniforms.uSpecularIntensity, it.specIntensity, 'specIntensity', 0.25);
            set1fCached(this.uniforms.uSpecularPower, it.specPower, 'specPower', 24.0);
            set3fCached(this.uniforms.uSpecMaskWeights, it.specMaskWeights, 'specMaskWeights', [1.0, 0.0, 0.0]);

            // Emissive (doesn't require tangents)
            if (it.emissiveRel && this.textureStreamer) {
                const url = toAssetUrl(it.emissiveRel);
                if (url) this.textureStreamer.touch(url, { distance: it.dist, kind: 'emissive' });
                const tex = url ? this.textureStreamer.get(url, { distance: it.dist, kind: 'emissive' }) : this.textureStreamer.placeholder;
                bindTexCached(3, tex, 'tex3');
                set1iCached(this.uniforms.uHasEmissive, 1, 'hasEmissive');
                set1fCached(this.uniforms.uEmissiveIntensity, it.emissiveIntensity, 'emissiveIntensity', 1.0);
            } else {
                set1iCached(this.uniforms.uHasEmissive, 0, 'hasEmissive');
                set1fCached(this.uniforms.uEmissiveIntensity, 1.0, 'emissiveIntensity', 1.0);
            }

            // AO / occlusion
            if (it.aoRel && this.textureStreamer) {
                const url = toAssetUrl(it.aoRel);
                if (url) this.textureStreamer.touch(url, { distance: it.dist, kind: 'ao' });
                const tex = url ? this.textureStreamer.get(url, { distance: it.dist, kind: 'ao' }) : this.textureStreamer.placeholder;
                bindTexCached(6, tex, 'texAO');
                set1iCached(this.uniforms.uHasAO, 1, 'hasAO');
                set1fCached(this.uniforms.uAOStrength, it.aoStrength, 'aoStrength', 1.0);
            } else {
                set1iCached(this.uniforms.uHasAO, 0, 'hasAO');
                set1fCached(this.uniforms.uAOStrength, 1.0, 'aoStrength', 1.0);
            }

            // VAO bind + slow-path instancing attr binding.
            if (it.vao) {
                if (state.vao !== it.vao) {
                    gl.bindVertexArray(it.vao);
                    state.vao = it.vao;
                }
            } else {
                // Slow path: bind mesh VAO and instance attrs (mutates VAO state; used only when per-entry VAO wasn't built yet).
                if (state.vao !== mesh.vao) {
                    gl.bindVertexArray(mesh.vao);
                    state.vao = mesh.vao;
                }
                gl.bindBuffer(gl.ARRAY_BUFFER, it.instanceBuffer);
                const strideFloats = Number(it.instanceStrideFloats ?? 16);
                const bytesPerMat = Math.max(16, strideFloats) * 4;
                const bytesPerVec4 = 4 * 4;
                for (let i = 0; i < 4; i++) {
                    const loc = 4 + i;
                    gl.enableVertexAttribArray(loc);
                    gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, bytesPerMat, i * bytesPerVec4);
                    gl.vertexAttribDivisor(loc, 1);
                }
                // Optional tint index at location 12.
                if (strideFloats >= 17) {
                    gl.enableVertexAttribArray(12);
                    gl.vertexAttribPointer(12, 1, gl.FLOAT, false, bytesPerMat, 16 * 4);
                    gl.vertexAttribDivisor(12, 1);
                } else {
                    try {
                        gl.disableVertexAttribArray(12);
                        gl.vertexAttrib1f(12, 0.0);
                    } catch { /* ignore */ }
                }
            }

            gl.drawElementsInstanced(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_INT, 0, it.instanceCount);
        }

        // Leave GL in a predictable state.
        try { gl.disable(gl.POLYGON_OFFSET_FILL); } catch { /* ignore */ }
        gl.bindVertexArray(null);
    }
}



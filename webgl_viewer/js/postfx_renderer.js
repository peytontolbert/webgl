import { ShaderProgram } from './shader_program.js';

/**
 * Post-processing:
 * - Render the whole scene into an offscreen framebuffer in linear space
 * - Apply CodeWalker-like tone mapping + (optional) bloom
 * - Encode to sRGB once when drawing to the canvas
 *
 * This is the main missing piece vs CodeWalker’s pipeline:
 * CodeWalker writes linear HDR and tone-maps in a final pass (PPFinalPassPS.hlsl).
 */
export class PostFxRenderer {
    /**
     * @param {WebGL2RenderingContext} gl
     */
    constructor(gl) {
        this.gl = gl;
        this.ready = false;

        // Public knobs (App wires these from UI)
        this.enabled = false;
        this.exposure = 1.0;  // multiplies avgLum (like CodeWalker g_param.x)
        this.avgLum = 1.0;    // stand-in / bias for CodeWalker’s lum[0] reduction (when auto-exposure is enabled, this acts as a multiplier)
        this.enableAutoExposure = false;
        this.autoExposureSpeed = 1.5; // higher = adapts faster
        this.enableBloom = false;
        this.bloomStrength = 0.6;
        // CodeWalker: BRIGHT_THRESHOLD = 50.0f in PPBloomFilterBPHCS.hlsl
        this.bloomThreshold = 50.0; // in linear scene units
        this.bloomRadius = 2.0;    // blur radius in texels at bloom resolution

        // Scene render target
        this._scene = { fbo: null, tex: null, depth: null, w: 0, h: 0, isHdr: false };

        // Bloom ping-pong targets (quarter res)
        this._bloom = {
            w: 0, h: 0,
            fboA: null, texA: null,
            fboB: null, texB: null,
        };

        // Luminance reduction targets (auto exposure)
        // We compute log-average luminance via a small downsample chain to 1x1.
        this._lum = {
            base: 64, // base resolution for luminance extraction (square)
            levels: [], // [{w,h,tex,fbo}]
            isFloat: false,
        };
        this._auto = {
            lastMs: 0,
            measuredLum: 1.0,
            adaptedLum: 1.0,
            readbackEveryNFrames: 3,
            frame: 0,
            pixF32: new Float32Array(4),
            pixU8: new Uint8Array(4),
        };

        // Shader programs
        this._tonemapProg = new ShaderProgram(gl);
        this._bloomExtractProg = new ShaderProgram(gl);
        this._bloomBlurProg = new ShaderProgram(gl);
        this._lumExtractProg = new ShaderProgram(gl);
        this._lumDownProg = new ShaderProgram(gl);
        this._fsVao = null;

        // Debug / diagnostics (surfaced via console and can be inspected by callers).
        this.lastError = null; // { where, status, message, detail }

        this._u = {
            tonemap: null,
            extract: null,
            blur: null,
            lumExtract: null,
            lumDown: null,
        };
    }

    _setLastError(where, message, detail = null, status = null) {
        try {
            this.lastError = {
                where: String(where || 'postfx'),
                status: (status === null || status === undefined) ? null : status,
                message: String(message || 'error'),
                detail: detail ?? null,
                whenMs: (performance?.now?.() ?? Date.now()),
            };
        } catch {
            // ignore
        }
    }

    _ensureColorTargetBoundAndWritable(fbo) {
        const gl = this.gl;
        try {
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            // IMPORTANT:
            // drawBuffers is per-FBO state in WebGL2. If any prior code ever touched it for this FBO,
            // leaving it at NONE will make all color writes silently disappear.
            try { gl.drawBuffers([gl.COLOR_ATTACHMENT0]); } catch { /* ignore */ }
        } catch {
            // ignore
        }
    }

    _checkFramebufferComplete(where, fbo) {
        const gl = this.gl;
        try {
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            // Ensure we are actually drawing to COLOR_ATTACHMENT0 for this FBO.
            try { gl.drawBuffers([gl.COLOR_ATTACHMENT0]); } catch { /* ignore */ }
            const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
            if (status !== gl.FRAMEBUFFER_COMPLETE) {
                this._setLastError(where, 'Framebuffer incomplete', { status }, status);
                try { console.warn(`PostFxRenderer: ${where} framebuffer incomplete:`, status); } catch { /* ignore */ }
                return false;
            }
            return true;
        } catch (e) {
            this._setLastError(where, 'Exception during framebuffer status check', { error: String(e) });
            try { console.warn(`PostFxRenderer: ${where} framebuffer status check threw:`, e); } catch { /* ignore */ }
            return false;
        } finally {
            try { gl.bindFramebuffer(gl.FRAMEBUFFER, null); } catch { /* ignore */ }
        }
    }

    async init() {
        const gl = this.gl;

        // Fullscreen triangle
        this._fsVao = gl.createVertexArray();

        const vs = `#version 300 es
out vec2 vUv;
void main() {
    vec2 p;
    if (gl_VertexID == 0) p = vec2(-1.0, -1.0);
    else if (gl_VertexID == 1) p = vec2(3.0, -1.0);
    else p = vec2(-1.0, 3.0);
    vUv = p * 0.5 + 0.5;
    gl_Position = vec4(p, 0.0, 1.0);
}`;

        const fsTonemap = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSceneTex;
uniform sampler2D uBloomTex;
uniform bool uEnableBloom;

uniform float uExposure;
uniform float uAvgLum;
uniform float uBloomStrength;

// CodeWalker constants
const float MIDDLE_GRAY = 0.72;
const float LUM_WHITE = 1.5;

vec3 encodeSrgb(vec3 c) {
    vec3 x = max(c, vec3(0.0));
    vec3 low = x * 12.92;
    vec3 high = 1.055 * pow(x, vec3(1.0 / 2.4)) - 0.055;
    bvec3 cut = lessThanEqual(x, vec3(0.0031308));
    return vec3(cut.x ? low.x : high.x,
                cut.y ? low.y : high.y,
                cut.z ? low.z : high.z);
}

vec3 toneMapCodeWalker(vec3 c, float lum) {
    float fLum = clamp(lum, 0.2, 10.0);
    vec3 v = c * (MIDDLE_GRAY / (fLum + 0.001));
    v *= (1.0 + v / LUM_WHITE);
    v /= (1.0 + v);
    return v;
}

void main() {
    vec3 c = texture(uSceneTex, vUv).rgb;
    float lum = max(0.0, uAvgLum) * max(0.0, uExposure);
    vec3 outLin = toneMapCodeWalker(c, lum);
    if (uEnableBloom) {
        vec3 b = texture(uBloomTex, vUv).rgb;
        outLin += max(0.0, uBloomStrength) * b;
    }
    fragColor = vec4(encodeSrgb(outLin), 1.0);
}`;

        const fsBloomExtract = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSceneTex;
uniform float uThreshold;

void main() {
    vec3 c = texture(uSceneTex, vUv).rgb;
    // Bright-pass (linear). CodeWalker uses a very high threshold (~50) because its scene is HDR.
    vec3 b = max(c - vec3(uThreshold), vec3(0.0));
    fragColor = vec4(b, 1.0);
}`;

        const fsBloomBlur = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTex;
uniform vec2 uTexel;    // 1/size
uniform vec2 uDir;      // (1,0) or (0,1)
uniform float uRadius;  // blur radius in texels

// 7-tap Gaussian-ish weights (normalized).
// Keep cheap; bloom is quarter-res.
void main() {
    vec2 o = uDir * uTexel * max(0.0, uRadius);
    vec3 s = vec3(0.0);
    s += texture(uTex, vUv - 3.0 * o).rgb * 0.06;
    s += texture(uTex, vUv - 2.0 * o).rgb * 0.12;
    s += texture(uTex, vUv - 1.0 * o).rgb * 0.18;
    s += texture(uTex, vUv).rgb          * 0.28;
    s += texture(uTex, vUv + 1.0 * o).rgb * 0.18;
    s += texture(uTex, vUv + 2.0 * o).rgb * 0.12;
    s += texture(uTex, vUv + 3.0 * o).rgb * 0.06;
    fragColor = vec4(s, 1.0);
}`;

        const fsLumExtract = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSceneTex;
// Encode log-average luminance in .r (also replicated to .g/.b for easier debugging).
// IMPORTANT (stability):
// We encode log-luminance into [0..1] so the luminance reduction chain can be stored in RGBA8
// and read back reliably via UNSIGNED_BYTE on all platforms. Float readPixels is not robust
// across all WebGL2 implementations and can return garbage without throwing.
void main() {
    vec3 c = texture(uSceneTex, vUv).rgb;
    // Relative luminance (linear)
    float y = max(0.0, dot(c, vec3(0.2126, 0.7152, 0.0722)));
    float logY = log(max(y, 1e-6));
    // Map a practical log range into UNORM8. Range chosen to cover most GTA lighting:
    // logY in [-8..2] => Y in [~0.000335..~7.389]
    const float LOG_MIN = -8.0;
    const float LOG_MAX =  2.0;
    float enc = clamp((logY - LOG_MIN) / (LOG_MAX - LOG_MIN), 0.0, 1.0);
    fragColor = vec4(enc, enc, enc, 1.0);
}`;

        const fsLumDown = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTex;
uniform vec2 uTexel;
void main() {
    // 2x2 box filter downsample
    vec2 o = uTexel * 0.5;
    vec3 a = texture(uTex, vUv + vec2(-o.x, -o.y)).rgb;
    vec3 b = texture(uTex, vUv + vec2( o.x, -o.y)).rgb;
    vec3 c = texture(uTex, vUv + vec2(-o.x,  o.y)).rgb;
    vec3 d = texture(uTex, vUv + vec2( o.x,  o.y)).rgb;
    vec3 m = (a + b + c + d) * 0.25;
    fragColor = vec4(m, 1.0);
}`;

        const okA = await this._tonemapProg.createProgram(vs, fsTonemap);
        const okB = await this._bloomExtractProg.createProgram(vs, fsBloomExtract);
        const okC = await this._bloomBlurProg.createProgram(vs, fsBloomBlur);
        const okD = await this._lumExtractProg.createProgram(vs, fsLumExtract);
        const okE = await this._lumDownProg.createProgram(vs, fsLumDown);
        if (!okA || !okB || !okC || !okD || !okE) return false;

        this._u.tonemap = {
            uSceneTex: gl.getUniformLocation(this._tonemapProg.program, 'uSceneTex'),
            uBloomTex: gl.getUniformLocation(this._tonemapProg.program, 'uBloomTex'),
            uEnableBloom: gl.getUniformLocation(this._tonemapProg.program, 'uEnableBloom'),
            uExposure: gl.getUniformLocation(this._tonemapProg.program, 'uExposure'),
            uAvgLum: gl.getUniformLocation(this._tonemapProg.program, 'uAvgLum'),
            uBloomStrength: gl.getUniformLocation(this._tonemapProg.program, 'uBloomStrength'),
        };
        this._u.extract = {
            uSceneTex: gl.getUniformLocation(this._bloomExtractProg.program, 'uSceneTex'),
            uThreshold: gl.getUniformLocation(this._bloomExtractProg.program, 'uThreshold'),
        };
        this._u.blur = {
            uTex: gl.getUniformLocation(this._bloomBlurProg.program, 'uTex'),
            uTexel: gl.getUniformLocation(this._bloomBlurProg.program, 'uTexel'),
            uDir: gl.getUniformLocation(this._bloomBlurProg.program, 'uDir'),
            uRadius: gl.getUniformLocation(this._bloomBlurProg.program, 'uRadius'),
        };
        this._u.lumExtract = {
            uSceneTex: gl.getUniformLocation(this._lumExtractProg.program, 'uSceneTex'),
        };
        this._u.lumDown = {
            uTex: gl.getUniformLocation(this._lumDownProg.program, 'uTex'),
            uTexel: gl.getUniformLocation(this._lumDownProg.program, 'uTexel'),
        };

        this.ready = true;
        return true;
    }

    /**
     * Ensure offscreen targets match the canvas size.
     * @param {number} w
     * @param {number} h
     */
    resize(w, h) {
        const gl = this.gl;
        const W = Math.max(1, w | 0);
        const H = Math.max(1, h | 0);
        if (this._scene.fbo && this._scene.w === W && this._scene.h === H) return;

        // Detect HDR target support (RGBA16F renderable).
        // WebGL2: needs EXT_color_buffer_float for rendering to floating point color buffers.
        let canHdr = false;
        try {
            const ext = gl.getExtension('EXT_color_buffer_float');
            canHdr = !!ext;
        } catch {
            canHdr = false;
        }

        const delTex = (t) => { try { if (t) gl.deleteTexture(t); } catch { /* ignore */ } };
        const delRb = (r) => { try { if (r) gl.deleteRenderbuffer(r); } catch { /* ignore */ } };
        const delFb = (f) => { try { if (f) gl.deleteFramebuffer(f); } catch { /* ignore */ } };

        delTex(this._scene.tex);
        delRb(this._scene.depth);
        delFb(this._scene.fbo);

        const makeScene = (wantHdr) => {
            const isHdr = !!wantHdr;
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            if (isHdr) {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, W, H, 0, gl.RGBA, gl.HALF_FLOAT, null);
            } else {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            }

            const depth = gl.createRenderbuffer();
            gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
            gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, W, H);

            const fbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
            // Ensure this FBO writes to COLOR_ATTACHMENT0 (do not rely on defaults).
            try { gl.drawBuffers([gl.COLOR_ATTACHMENT0]); } catch { /* ignore */ }

            const ok = this._checkFramebufferComplete(isHdr ? 'scene(HDR)' : 'scene(LDR)', fbo);
            if (!ok) {
                try { gl.deleteFramebuffer(fbo); } catch { /* ignore */ }
                try { gl.deleteTexture(tex); } catch { /* ignore */ }
                try { gl.deleteRenderbuffer(depth); } catch { /* ignore */ }
                return null;
            }
            return { fbo, tex, depth, w: W, h: H, isHdr };
        };

        // Try HDR first (if supported), then fall back to LDR if needed.
        let scene = null;
        if (canHdr) scene = makeScene(true);
        if (!scene) scene = makeScene(false);
        if (!scene) {
            // Give up: disable postfx for stability.
            this._scene = { fbo: null, tex: null, depth: null, w: W, h: H, isHdr: false };
            this._setLastError('resize', 'Failed to allocate a complete scene framebuffer; disabling PostFX', { w: W, h: H });
            try { console.warn('PostFxRenderer: disabling (scene FBO incomplete).'); } catch { /* ignore */ }
            try { gl.bindFramebuffer(gl.FRAMEBUFFER, null); } catch { /* ignore */ }
            try { gl.bindTexture(gl.TEXTURE_2D, null); } catch { /* ignore */ }
            try { gl.bindRenderbuffer(gl.RENDERBUFFER, null); } catch { /* ignore */ }
            return;
        }

        this._scene = scene;

        // Bloom targets are quarter-res of scene.
        this._resizeBloomTargets(Math.max(1, (W / 4) | 0), Math.max(1, (H / 4) | 0));
        // Luminance targets are fixed-size chain (independent of canvas aspect).
        this._resizeLumTargets(this._lum.base);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    }

    _resizeLumTargets(baseSize) {
        const gl = this.gl;
        const base = Math.max(8, Math.min(256, baseSize | 0));

        // IMPORTANT (stability):
        // Keep the luminance chain RGBA8 even when HDR is enabled.
        // We store encoded log-luminance in UNORM8 and decode on CPU.
        // This avoids float readPixels, which is inconsistent across drivers.
        const isFloat = false;

        // Delete old
        try {
            for (const lv of (this._lum.levels || [])) {
                try { if (lv?.tex) gl.deleteTexture(lv.tex); } catch { /* ignore */ }
                try { if (lv?.fbo) gl.deleteFramebuffer(lv.fbo); } catch { /* ignore */ }
            }
        } catch { /* ignore */ }

        const levels = [];
        let w = base;
        let h = base;
        const make = (W, H) => {
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            if (isFloat) {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, W, H, 0, gl.RGBA, gl.HALF_FLOAT, null);
            } else {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            }
            const fbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
            try { gl.drawBuffers([gl.COLOR_ATTACHMENT0]); } catch { /* ignore */ }
            return { w: W, h: H, tex, fbo };
        };

        while (true) {
            levels.push(make(w, h));
            if (w === 1 && h === 1) break;
            w = Math.max(1, (w / 2) | 0);
            h = Math.max(1, (h / 2) | 0);
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);

        this._lum = { base, levels, isFloat };
        // Reset adaptation state on resize so exposure doesn't jump wildly.
        this._auto.measuredLum = 1.0;
        this._auto.adaptedLum = 1.0;
        this._auto.lastMs = 0;
        this._auto.frame = 0;
    }

    _resizeBloomTargets(w, h) {
        const gl = this.gl;
        const W = Math.max(1, w | 0);
        const H = Math.max(1, h | 0);
        if (this._bloom.fboA && this._bloom.w === W && this._bloom.h === H) return;

        const delTex = (t) => { try { if (t) gl.deleteTexture(t); } catch { /* ignore */ } };
        const delFb = (f) => { try { if (f) gl.deleteFramebuffer(f); } catch { /* ignore */ } };
        delTex(this._bloom.texA);
        delTex(this._bloom.texB);
        delFb(this._bloom.fboA);
        delFb(this._bloom.fboB);

        const make = () => {
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            // Bloom can be LDR; keep it simple.
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            const fbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
            try { gl.drawBuffers([gl.COLOR_ATTACHMENT0]); } catch { /* ignore */ }
            return { tex, fbo };
        };

        const a = make();
        const b = make();
        this._bloom = { w: W, h: H, texA: a.tex, fboA: a.fbo, texB: b.tex, fboB: b.fbo };
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
    }

    /**
     * Bind the scene framebuffer to start rendering the world into it.
     * Returns the framebuffer to bind (or null if disabled/not ready).
     */
    beginScene({ w, h } = {}) {
        if (!this.ready || !this.enabled) return null;
        this.resize(w, h);
        if (!this._scene?.fbo || !this._scene?.tex) return null;
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._scene.fbo);
        // Ensure we are writing to COLOR_ATTACHMENT0 for this scene FBO.
        try { gl.drawBuffers([gl.COLOR_ATTACHMENT0]); } catch { /* ignore */ }
        gl.viewport(0, 0, this._scene.w, this._scene.h);

        // IMPORTANT (stability):
        // Scene rendering starts here; ensure prior fullscreen/post/occlusion state cannot leak into the scene.
        // - scissor can cause partial clears
        // - colorMask(false) can prevent clears entirely
        // - leaving scene RT bound on a texture unit can trigger a feedback loop if a draw forgets to bind a map
        try { gl.disable(gl.SCISSOR_TEST); } catch { /* ignore */ }
        try { gl.disable(gl.STENCIL_TEST); } catch { /* ignore */ }
        try { gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE); } catch { /* ignore */ }
        try { gl.colorMask(true, true, true, true); } catch { /* ignore */ }
        try { gl.depthMask(true); } catch { /* ignore */ }
        try { gl.clearDepth(1.0); } catch { /* ignore */ }
        try {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.activeTexture(gl.TEXTURE0);
        } catch { /* ignore */ }

        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        return this._scene.fbo;
    }

    /**
     * Run bloom (optional) + tonemap + encode to the default framebuffer.
     */
    endScene({ canvasW, canvasH } = {}) {
        if (!this.ready || !this.enabled) return;
        if (!this._scene?.tex) return;
        const gl = this.gl;

        // IMPORTANT (stability):
        // Fullscreen post passes must not inherit draw-state from scene renderers (models/terrain/decals),
        // otherwise a single "leftover" state (BLEND, COLOR_MASK, SAMPLE_ALPHA_TO_COVERAGE, etc) can make
        // the tonemap pass look broken with no obvious WebGL error.
        try { gl.disable(gl.SCISSOR_TEST); } catch { /* ignore */ }
        try { gl.disable(gl.STENCIL_TEST); } catch { /* ignore */ }
        try { gl.disable(gl.CULL_FACE); } catch { /* ignore */ }
        try { gl.colorMask(true, true, true, true); } catch { /* ignore */ }
        try { gl.disable(gl.BLEND); } catch { /* ignore */ }
        try { gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE); } catch { /* ignore */ }
        try {
            gl.blendEquation(gl.FUNC_ADD);
            gl.blendFunc(gl.ONE, gl.ZERO);
        } catch { /* ignore */ }

        // Optional auto exposure: compute log-average luminance and adapt over time.
        // We compute this *before* bloom/tonemap, from the linear scene buffer.
        if (this.enableAutoExposure) {
            try { this._updateAutoExposure(); } catch { /* ignore */ }
        }

        // Build bloom texture at quarter res
        let bloomTexForTonemap = null;
        if (this.enableBloom && this._bloom?.fboA && this._bloom?.fboB) {
            const bw = this._bloom.w;
            const bh = this._bloom.h;

            // Extract bright areas
            gl.bindFramebuffer(gl.FRAMEBUFFER, this._bloom.fboA);
            try { gl.drawBuffers([gl.COLOR_ATTACHMENT0]); } catch { /* ignore */ }
            gl.viewport(0, 0, bw, bh);
            gl.disable(gl.DEPTH_TEST);
            gl.depthMask(false);
            this._bloomExtractProg.use();
            gl.bindVertexArray(this._fsVao);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this._scene.tex);
            gl.uniform1i(this._u.extract.uSceneTex, 0);
            gl.uniform1f(this._u.extract.uThreshold, Number(this.bloomThreshold) || 0.0);
            gl.drawArrays(gl.TRIANGLES, 0, 3);

            // Blur X
            gl.bindFramebuffer(gl.FRAMEBUFFER, this._bloom.fboB);
            try { gl.drawBuffers([gl.COLOR_ATTACHMENT0]); } catch { /* ignore */ }
            gl.viewport(0, 0, bw, bh);
            this._bloomBlurProg.use();
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this._bloom.texA);
            gl.uniform1i(this._u.blur.uTex, 0);
            gl.uniform2f(this._u.blur.uTexel, 1.0 / bw, 1.0 / bh);
            gl.uniform2f(this._u.blur.uDir, 1.0, 0.0);
            gl.uniform1f(this._u.blur.uRadius, Number(this.bloomRadius) || 0.0);
            gl.drawArrays(gl.TRIANGLES, 0, 3);

            // Blur Y (back into A)
            gl.bindFramebuffer(gl.FRAMEBUFFER, this._bloom.fboA);
            try { gl.drawBuffers([gl.COLOR_ATTACHMENT0]); } catch { /* ignore */ }
            gl.viewport(0, 0, bw, bh);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this._bloom.texB);
            gl.uniform1i(this._u.blur.uTex, 0);
            gl.uniform2f(this._u.blur.uTexel, 1.0 / bw, 1.0 / bh);
            gl.uniform2f(this._u.blur.uDir, 0.0, 1.0);
            gl.uniform1f(this._u.blur.uRadius, Number(this.bloomRadius) || 0.0);
            gl.drawArrays(gl.TRIANGLES, 0, 3);

            bloomTexForTonemap = this._bloom.texA;
        }

        // Tonemap to default framebuffer
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, Math.max(1, canvasW | 0), Math.max(1, canvasH | 0));
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(false);
        this._tonemapProg.use();
        gl.bindVertexArray(this._fsVao);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._scene.tex);
        gl.uniform1i(this._u.tonemap.uSceneTex, 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, bloomTexForTonemap || this._scene.tex);
        gl.uniform1i(this._u.tonemap.uBloomTex, 1);

        gl.uniform1i(this._u.tonemap.uEnableBloom, (this.enableBloom && !!bloomTexForTonemap) ? 1 : 0);
        gl.uniform1f(this._u.tonemap.uExposure, Number(this.exposure) || 0.0);
        // If auto exposure is enabled, avgLum becomes a *bias* multiplier on the adapted luminance.
        // If it's disabled, avgLum is used directly (legacy/manual control).
        const lumBias = Number(this.avgLum) || 0.0;
        const lum = this.enableAutoExposure ? (Math.max(0.0, this._auto.adaptedLum) * Math.max(0.0, lumBias)) : Math.max(0.0, lumBias);
        gl.uniform1f(this._u.tonemap.uAvgLum, lum);
        gl.uniform1f(this._u.tonemap.uBloomStrength, Number(this.bloomStrength) || 0.0);

        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
        gl.depthMask(true);
        // IMPORTANT:
        // Avoid leaving render-target textures bound on common units (0/1).
        // If the next frame begins rendering into the scene FBO again and a draw path fails to bind a map,
        // WebGL can detect a framebuffer-texture feedback loop and throw INVALID_OPERATION on draw calls.
        try {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.activeTexture(gl.TEXTURE0);
        } catch { /* ignore */ }
    }

    _updateAutoExposure() {
        const gl = this.gl;
        const lv = this._lum?.levels;
        if (!lv || lv.length < 1) return;
        if (!this._scene?.tex) return;
        if (!this._lumExtractProg?.program || !this._lumDownProg?.program) return;

        // IMPORTANT (stability): avoid inheriting scene renderer state (scissor/cull/blend).
        try { gl.disable(gl.SCISSOR_TEST); } catch { /* ignore */ }
        try { gl.disable(gl.STENCIL_TEST); } catch { /* ignore */ }
        try { gl.disable(gl.CULL_FACE); } catch { /* ignore */ }
        try { gl.disable(gl.BLEND); } catch { /* ignore */ }
        try { gl.colorMask(true, true, true, true); } catch { /* ignore */ }

        // Throttle readback to reduce stalls; adaptation uses EMA so it remains smooth.
        this._auto.frame = (this._auto.frame + 1) >>> 0;
        const doReadback = (this._auto.frame % Math.max(1, this._auto.readbackEveryNFrames | 0)) === 0;

        // 1) Extract log luminance into level 0
        {
            const L0 = lv[0];
            gl.bindFramebuffer(gl.FRAMEBUFFER, L0.fbo);
            gl.viewport(0, 0, L0.w, L0.h);
            gl.disable(gl.DEPTH_TEST);
            gl.depthMask(false);
            this._lumExtractProg.use();
            gl.bindVertexArray(this._fsVao);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this._scene.tex);
            gl.uniform1i(this._u.lumExtract.uSceneTex, 0);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        }

        // 2) Downsample chain (box filter of log luminance)
        for (let i = 0; i + 1 < lv.length; i++) {
            const src = lv[i];
            const dst = lv[i + 1];
            gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
            gl.viewport(0, 0, dst.w, dst.h);
            this._lumDownProg.use();
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, src.tex);
            gl.uniform1i(this._u.lumDown.uTex, 0);
            gl.uniform2f(this._u.lumDown.uTexel, 1.0 / src.w, 1.0 / src.h);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        }

        // 3) Read 1x1 result (log luminance), then exp to get average luminance.
        if (doReadback) {
            const last = lv[lv.length - 1];
            gl.bindFramebuffer(gl.FRAMEBUFFER, last.fbo);
            // Read encoded log-luminance from RGBA8 (stable across implementations).
            let avgLum = null;
            try {
                gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._auto.pixU8);
                const u = (this._auto.pixU8[0] || 0) / 255.0;
                const logY = (-8.0) + u * 10.0; // must match fsLumExtract LOG_MIN/LOG_MAX
                avgLum = Math.exp(logY);
            } catch { /* ignore */ }
            if (avgLum !== null && Number.isFinite(avgLum)) {
                // Clamp to keep tonemap stable.
                this._auto.measuredLum = Math.max(1e-3, Math.min(1e3, avgLum));
            }
        }

        // 4) Adapt over time (EMA in linear luminance domain)
        const now = performance.now();
        const dt = (this._auto.lastMs > 0) ? Math.max(0.0, (now - this._auto.lastMs) * 0.001) : (1.0 / 60.0);
        this._auto.lastMs = now;
        const speed = Math.max(0.0, Number(this.autoExposureSpeed) || 0.0);
        const k = 1.0 - Math.exp(-dt * speed);
        const prev = Number(this._auto.adaptedLum) || 1.0;
        const next = prev + (this._auto.measuredLum - prev) * k;
        this._auto.adaptedLum = Number.isFinite(next) ? next : prev;

        gl.bindVertexArray(null);
        gl.depthMask(true);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    /** @returns {WebGLFramebuffer|null} */
    get sceneFramebuffer() {
        return this._scene?.fbo || null;
    }
}



import { glMatrix } from './glmatrix.js';

/**
 * Minimal occlusion proxy (v1):
 * - Render occluders (terrain/buildings) into a small depth-only framebuffer.
 * - Read depth to CPU at a throttled cadence.
 * - Conservative visibility test for bounding spheres via a few projected sample points.
 *
 * Notes:
 * - This is intentionally conservative: if anything looks uncertain, we return "visible".
 * - Depth readback can be slow on some GPUs; keep resolution small and allow throttling.
 */
export class OcclusionCuller {
    /**
     * @param {WebGL2RenderingContext} gl
     * @param {{ width?: number, height?: number, readbackEveryNFrames?: number, depthEps?: number, preferDepthReadback?: boolean }} opts
     */
    constructor(gl, opts = {}) {
        this.gl = gl;
        this.enabled = true;

        this.width = Number.isFinite(opts.width) ? Math.max(64, Math.min(1024, opts.width | 0)) : 256;
        this.height = Number.isFinite(opts.height) ? Math.max(64, Math.min(1024, opts.height | 0)) : 256;
        this.readbackEveryNFrames = Number.isFinite(opts.readbackEveryNFrames)
            ? Math.max(1, Math.min(16, opts.readbackEveryNFrames | 0))
            : 2;
        this.depthEps = Number.isFinite(opts.depthEps) ? Math.max(0.0, Math.min(0.02, Number(opts.depthEps))) : 0.0025;

        this._frameIndex = 0;
        this._depthTex = null;
        this._fbo = null;
        this._depthReadFbo = null; // alias for clarity (depth-only FBO)
        this._rgbaFbo = null; // FBO with RGBA color attachment for fallback readback
        this._rgbaTex = null;
        this._depthToRgbaProgram = null;
        this._depthToRgbaVAO = null;

        this._depthU32 = null;
        this._depthF32 = null;
        this._useFloatReadback = false;
        this._readbackSupported = true; // true if ANY readback mode works
        // Default to the most compatible readback path:
        // - readPixels(RGBA, UNSIGNED_BYTE) is the only guaranteed combo across implementations.
        // - depth readPixels frequently fails with INVALID_ENUM on some GPUs/drivers (as you've seen).
        // You can opt back into trying depth readPixels via opts.preferDepthReadback.
        this._readbackMode = (opts && opts.preferDepthReadback) ? 'depth' : 'rgba'; // 'depth' | 'rgba'
        this._persistKey = 'webglgta.occlusion.readbackMode';
        this._warnedReadback = false;

        this._lastStats = {
            occlusionTests: 0,
            culled: 0,
            readbacks: 0,
            lastReadbackMs: 0,
            lastReadbackOk: false,
        };

        this._tmpV4 = glMatrix.vec4.create();

        // If a previous session already determined depth readPixels is rejected, start in RGBA mode
        // to avoid re-triggering noisy "WebGL: INVALID_ENUM" console warnings every reload.
        try {
            const v = globalThis?.localStorage?.getItem?.(this._persistKey);
            // Stored value overrides default unless user explicitly forced a mode via opts.
            if (!(opts && opts.preferDepthReadback)) {
                if (String(v) === 'rgba') this._readbackMode = 'rgba';
                if (String(v) === 'depth') this._readbackMode = 'depth';
            }
        } catch { /* ignore */ }

        this._ensureResources();
    }

    setSize(w, h) {
        const ww = Number.isFinite(w) ? Math.max(64, Math.min(2048, w | 0)) : this.width;
        const hh = Number.isFinite(h) ? Math.max(64, Math.min(2048, h | 0)) : this.height;
        if (ww === this.width && hh === this.height) return;
        this.width = ww;
        this.height = hh;
        this._destroyResources();
        this._ensureResources();
    }

    getStats() {
        return {
            ...this._lastStats,
            width: this.width,
            height: this.height,
            enabled: !!this.enabled,
            readbackSupported: !!this._readbackSupported,
            readbackMode: this._readbackMode,
        };
    }

    /**
     * Render occluders to depth and optionally read back.
     * Call this once per frame before running visibility tests.
     *
     * @param {{ viewProjectionMatrix: Float32Array, drawOccluders: Function }} args
     */
    buildDepth({ viewProjectionMatrix, drawOccluders }) {
        if (!this.enabled) return;
        if (!this._fbo || !this._depthTex) return;
        if (!this._readbackSupported) return;
        if (!viewProjectionMatrix || viewProjectionMatrix.length < 16) return;
        if (typeof drawOccluders !== 'function') return;

        const gl = this.gl;
        this._frameIndex++;

        // Save a tiny bit of GL state we mutate.
        const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        const prevViewport = gl.getParameter(gl.VIEWPORT); // Int32Array[4]
        const prevColorMask = gl.getParameter(gl.COLOR_WRITEMASK); // boolean[4]
        const prevDepthMask = gl.getParameter(gl.DEPTH_WRITEMASK);
        const prevDepthFunc = gl.getParameter(gl.DEPTH_FUNC);
        const depthTestWas = gl.isEnabled(gl.DEPTH_TEST);
        const blendWas = gl.isEnabled(gl.BLEND);
        const cullWas = gl.isEnabled(gl.CULL_FACE);
        const prevCullFaceMode = gl.getParameter(gl.CULL_FACE_MODE);
        const prevFrontFace = gl.getParameter(gl.FRONT_FACE);

        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);
        gl.viewport(0, 0, this.width, this.height);
        gl.colorMask(false, false, false, false);
        gl.disable(gl.BLEND);
        gl.enable(gl.DEPTH_TEST);
        // Use a standard depth func for the prepass; we restore afterward.
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(true);
        gl.clearDepth(1.0);
        gl.clear(gl.DEPTH_BUFFER_BIT);

        try {
            drawOccluders();
        } catch (e) {
            // If occluder draw throws, fail open and stop trying this frame.
            console.warn('OcclusionCuller: drawOccluders failed', e);
        }

        // Readback throttled (keeps this from dominating CPU/GPU sync).
        const doReadback = (this._frameIndex % this.readbackEveryNFrames) === 0;
        if (doReadback) {
            const t0 = performance.now();
            const ok = this._readDepthPixels();
            const t1 = performance.now();
            this._lastStats.readbacks += 1;
            this._lastStats.lastReadbackMs = (t1 - t0);
            this._lastStats.lastReadbackOk = !!ok;
        }

        // Restore state.
        gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
        gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
        gl.colorMask(prevColorMask[0], prevColorMask[1], prevColorMask[2], prevColorMask[3]);
        gl.depthMask(prevDepthMask);
        try { gl.depthFunc(prevDepthFunc); } catch { /* ignore */ }
        if (!depthTestWas) gl.disable(gl.DEPTH_TEST);
        if (blendWas) gl.enable(gl.BLEND);
        if (cullWas) gl.enable(gl.CULL_FACE);
        else gl.disable(gl.CULL_FACE);
        try { gl.cullFace(prevCullFaceMode); } catch { /* ignore */ }
        try { gl.frontFace(prevFrontFace); } catch { /* ignore */ }
    }

    /**
     * Conservative visibility test for a bounding sphere in VIEWER space.
     * Returns true => keep drawing.
     *
     * @param {{ center: number[], radius: number, viewProjectionMatrix: Float32Array, viewportWidth: number, viewportHeight: number }} args
     */
    isVisibleSphere({ center, radius, viewProjectionMatrix, viewportWidth, viewportHeight }) {
        this._lastStats.occlusionTests += 1;

        // Fail open if disabled or no depth buffer.
        if (!this.enabled) return true;
        if ((!this._depthU32 && !this._depthF32) || (!this._fbo)) return true;
        if (!center || center.length < 3) return true;
        const r = Number(radius);
        if (!Number.isFinite(r) || r <= 0) return true;
        if (!viewProjectionMatrix || viewProjectionMatrix.length < 16) return true;
        if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight) || viewportWidth <= 2 || viewportHeight <= 2) return true;

        // If we don't have a recent readback, fail open.
        if (!this._lastStats.lastReadbackOk) return true;

        // Sample points on/near the sphere. If ANY sample can't be evaluated, fail open.
        const samples = [
            [0, 0, 0],
            [ r, 0, 0],
            [-r, 0, 0],
            [0,  r, 0],
            [0, -r, 0],
            [0, 0,  r],
            [0, 0, -r],
        ];

        // We only cull if *all* sample points are behind depth at their screen coords.
        let tested = 0;
        for (const s of samples) {
            const vx = center[0] + s[0];
            const vy = center[1] + s[1];
            const vz = center[2] + s[2];

            const ok = this._projectToNdc(viewProjectionMatrix, vx, vy, vz, this._tmpV4);
            if (!ok) return true;
            const ndcX = this._tmpV4[0];
            const ndcY = this._tmpV4[1];
            const ndcZ = this._tmpV4[2];

            // Outside clip => we can’t safely reason about occlusion.
            if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1 || ndcZ < -1 || ndcZ > 1) return true;

            const depth01 = ndcZ * 0.5 + 0.5;
            // Convert from screen pixel -> occlusion buffer pixel.
            const sx = (ndcX * 0.5 + 0.5) * viewportWidth;
            const sy = (ndcY * 0.5 + 0.5) * viewportHeight;

            const ox = Math.floor((sx / viewportWidth) * this.width);
            const oy = Math.floor((sy / viewportHeight) * this.height);
            if (ox < 0 || ox >= this.width || oy < 0 || oy >= this.height) return true;

            const d = this._sampleDepth01(ox, oy);
            if (!(d >= 0 && d <= 1)) return true;

            tested++;
            // If the occluder depth is NOT closer than our point by margin => visible.
            if (!(d <= (depth01 - this.depthEps))) return true;
        }

        // If we didn't evaluate anything (shouldn't happen), fail open.
        if (tested <= 0) return true;

        // All samples were behind existing depth: treat as occluded.
        this._lastStats.culled += 1;
        return false;
    }

    _sampleDepth01(x, y) {
        const idx = (y * this.width + x);
        if (this._depthF32) {
            // DEPTH_COMPONENT + FLOAT readPixels returns normalized depth in [0..1] (implementation may clamp).
            const d = this._depthF32[idx];
            return Number.isFinite(d) ? d : NaN;
        }
        if (this._depthU32) {
            // DEPTH_COMPONENT + UNSIGNED_SHORT readPixels returns 0..65535 mapping to [0..1].
            return this._depthU32[idx] / 65535.0;
        }
        if (this._depthRGBA) {
            // Packed 24-bit depth in RGB: depth01 ≈ (r + g*256 + b*65536) / 16777215.
            const off = idx * 4;
            const r = this._depthRGBA[off] | 0;
            const g = this._depthRGBA[off + 1] | 0;
            const b = this._depthRGBA[off + 2] | 0;
            const u24 = (r + (g << 8) + (b << 16)) >>> 0;
            return u24 / 16777215.0;
        }
        return NaN;
    }

    _projectToNdc(m, x, y, z, outV4) {
        // out = m * vec4(x,y,z,1), then divide by w.
        // gl-matrix uses column-major; treat m as Float32Array length 16.
        const w =
            m[3] * x + m[7] * y + m[11] * z + m[15] * 1.0;
        if (!Number.isFinite(w) || Math.abs(w) < 1e-8) return false;
        const px =
            m[0] * x + m[4] * y + m[8] * z + m[12] * 1.0;
        const py =
            m[1] * x + m[5] * y + m[9] * z + m[13] * 1.0;
        const pz =
            m[2] * x + m[6] * y + m[10] * z + m[14] * 1.0;
        outV4[0] = px / w;
        outV4[1] = py / w;
        outV4[2] = pz / w;
        outV4[3] = 1.0;
        return true;
    }

    _ensureResources() {
        const gl = this.gl;
        if (!gl || typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) {
            // We depend on WebGL2 depth textures + readPixels formats.
            this._destroyResources();
            return;
        }

        this._fbo = gl.createFramebuffer();
        this._depthReadFbo = this._fbo;
        this._depthTex = gl.createTexture();

        gl.bindTexture(gl.TEXTURE_2D, this._depthTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        // Ensure sampling returns raw depth values (not comparison results) for our RGBA fallback path.
        try { gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.NONE); } catch { /* ignore */ }
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            // Prefer DEPTH_COMPONENT16 for maximum compatibility with readPixels.
            // Some drivers reject DEPTH_COMPONENT + UNSIGNED_INT readback from DEPTH_COMPONENT24.
            gl.DEPTH_COMPONENT16,
            this.width,
            this.height,
            0,
            gl.DEPTH_COMPONENT,
            gl.UNSIGNED_SHORT,
            null
        );

        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this._depthTex, 0);
        gl.drawBuffers([gl.NONE]);
        gl.readBuffer(gl.NONE);

        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            console.warn('OcclusionCuller: depth framebuffer incomplete', status);
            this._destroyResources();
            return;
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);

        // Allocate CPU readback buffers.
        // Keep the field name _depthU32 to minimize changes elsewhere, but it now stores u16 depth samples.
        this._depthU32 = new Uint16Array(this.width * this.height);
        this._depthF32 = null;
        this._useFloatReadback = false; // legacy
        this._depthRGBA = new Uint8Array(this.width * this.height * 4);
        this._lastStats.lastReadbackOk = false;
        this._readbackSupported = true;
        // IMPORTANT: don't clobber an already-selected readback mode.
        // - constructor may have loaded 'rgba' from localStorage
        // - setSize() destroys/recreates resources; we want to keep using 'rgba' if already known-good
        if (this._readbackMode !== 'rgba') this._readbackMode = 'depth';

        // Prepare RGBA fallback FBO/texture (readPixels RGBA is broadly supported even when depth readPixels isn't).
        this._rgbaFbo = gl.createFramebuffer();
        this._rgbaTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this._rgbaTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

        gl.bindFramebuffer(gl.FRAMEBUFFER, this._rgbaFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._rgbaTex, 0);
        try { gl.drawBuffers([gl.COLOR_ATTACHMENT0]); } catch { /* ignore */ }
        const rgbaStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (rgbaStatus !== gl.FRAMEBUFFER_COMPLETE) {
            // Still keep depth-only path; we'll mark fallback unavailable if needed.
            try { console.warn('OcclusionCuller: RGBA fallback framebuffer incomplete', rgbaStatus); } catch { /* ignore */ }
            try { gl.deleteFramebuffer(this._rgbaFbo); } catch { /* ignore */ }
            try { gl.deleteTexture(this._rgbaTex); } catch { /* ignore */ }
            this._rgbaFbo = null;
            this._rgbaTex = null;
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
    }

    _readDepthPixels() {
        const gl = this.gl;
        if (!this._fbo) return false;
        if (!this._readbackSupported) return false;

        // Read from our depth FBO.
        const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);

        // Mode 1: depth readPixels (fastest when supported).
        if (this._readbackMode === 'depth') {
            gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);

            // Many WebGL2 implementations are picky here; prefer the most compatible path:
            // DEPTH_COMPONENT + UNSIGNED_SHORT from a DEPTH_COMPONENT16 attachment.
            //
            // If this fails (INVALID_ENUM on some GPUs/drivers), fall back to RGBA packing.
            // NOTE: only one depth readPixels attempt is made; after that we won't retry (avoids console spam).
            let ok = false;
            try {
                // Clear any prior error so we interpret the result of this call only.
                try { gl.getError(); } catch { /* ignore */ }
                gl.readPixels(0, 0, this.width, this.height, gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT, this._depthU32);
                const e = gl.getError();
                ok = (e === gl.NO_ERROR);
            } catch {
                ok = false;
            }

            gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
            if (ok) {
                this._lastStats.lastReadbackOk = true;
                try { globalThis?.localStorage?.setItem?.(this._persistKey, 'depth'); } catch { /* ignore */ }
                return true;
            }

            // Switch permanently to fallback mode.
            this._readbackMode = 'rgba';
            try { globalThis?.localStorage?.setItem?.(this._persistKey, 'rgba'); } catch { /* ignore */ }
            if (!this._warnedReadback) {
                this._warnedReadback = true;
                try {
                    console.warn('OcclusionCuller: depth readPixels rejected by this GPU/browser; switching to RGBA-packed depth readback.');
                } catch { /* ignore */ }
            }
        }

        // Mode 2: RGBA-packed depth (works on many drivers that reject depth readPixels).
        const ok2 = this._readDepthViaRgbaPacked();
        this._lastStats.lastReadbackOk = !!ok2;
        if (!ok2) {
            this._readbackSupported = false;
            try { globalThis?.localStorage?.setItem?.(this._persistKey, 'none'); } catch { /* ignore */ }
            if (!this._warnedReadback) {
                this._warnedReadback = true;
                try {
                    console.warn('OcclusionCuller: depth readback not supported on this GPU/browser; disabling occlusion readback.');
                } catch { /* ignore */ }
            }
        }
        return ok2;
    }

    _ensureDepthToRgbaProgram() {
        const gl = this.gl;
        if (!gl) return false;
        if (this._depthToRgbaProgram && this._depthToRgbaVAO) return true;

        const vs = `#version 300 es
        precision highp float;
        const vec2 POS[3] = vec2[3](
            vec2(-1.0, -1.0),
            vec2( 3.0, -1.0),
            vec2(-1.0,  3.0)
        );
        void main() {
            gl_Position = vec4(POS[gl_VertexID], 0.0, 1.0);
        }`;

        const fs = `#version 300 es
        precision highp float;
        uniform sampler2D uDepthTex;
        out vec4 fragColor;

        vec3 packDepth24(float depth01) {
            float d = clamp(depth01, 0.0, 1.0);
            float u = floor(d * 16777215.0 + 0.5); // 2^24 - 1
            float r = mod(u, 256.0);
            float g = mod(floor(u / 256.0), 256.0);
            float b = mod(floor(u / 65536.0), 256.0);
            return vec3(r, g, b) / 255.0;
        }

        void main() {
            // gl_FragCoord.xy uses the same bottom-left origin as readPixels.
            ivec2 ip = ivec2(gl_FragCoord.xy) - ivec2(0, 0);
            float d = texelFetch(uDepthTex, ip, 0).r;
            vec3 rgb = packDepth24(d);
            fragColor = vec4(rgb, 1.0);
        }`;

        const compile = (type, src) => {
            const sh = gl.createShader(type);
            gl.shaderSource(sh, src);
            gl.compileShader(sh);
            if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
                const info = gl.getShaderInfoLog(sh) || '';
                try { gl.deleteShader(sh); } catch { /* ignore */ }
                throw new Error(info);
            }
            return sh;
        };

        try {
            const vsh = compile(gl.VERTEX_SHADER, vs);
            const fsh = compile(gl.FRAGMENT_SHADER, fs);
            const prog = gl.createProgram();
            gl.attachShader(prog, vsh);
            gl.attachShader(prog, fsh);
            gl.linkProgram(prog);
            try { gl.deleteShader(vsh); } catch { /* ignore */ }
            try { gl.deleteShader(fsh); } catch { /* ignore */ }
            if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
                const info = gl.getProgramInfoLog(prog) || '';
                try { gl.deleteProgram(prog); } catch { /* ignore */ }
                throw new Error(info);
            }
            this._depthToRgbaProgram = prog;
        } catch (e) {
            try { console.warn('OcclusionCuller: failed to build depth->RGBA fallback shader', e); } catch { /* ignore */ }
            this._depthToRgbaProgram = null;
            return false;
        }

        try {
            this._depthToRgbaVAO = gl.createVertexArray();
        } catch {
            this._depthToRgbaVAO = null;
        }
        // WebGL2 requires a VAO bound for drawArrays, even when using gl_VertexID only.
        if (!this._depthToRgbaVAO) {
            try { if (this._depthToRgbaProgram) gl.deleteProgram(this._depthToRgbaProgram); } catch { /* ignore */ }
            this._depthToRgbaProgram = null;
            return false;
        }
        return true;
    }

    _readDepthViaRgbaPacked() {
        const gl = this.gl;
        if (!this._rgbaFbo || !this._rgbaTex || !this._depthTex || !this._depthRGBA) return false;
        if (!this._ensureDepthToRgbaProgram()) return false;

        const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        const prevViewport = gl.getParameter(gl.VIEWPORT);
        const prevProg = gl.getParameter(gl.CURRENT_PROGRAM);
        const prevVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
        const prevActiveTex = gl.getParameter(gl.ACTIVE_TEXTURE);
        let prevTex0 = null;
        try {
            gl.activeTexture(gl.TEXTURE0);
            prevTex0 = gl.getParameter(gl.TEXTURE_BINDING_2D);
        } catch {
            prevTex0 = null;
        }

        let prevColorMask = null;
        try { prevColorMask = gl.getParameter(gl.COLOR_WRITEMASK); } catch { prevColorMask = null; }

        // Draw depth->RGBA into the color FBO.
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._rgbaFbo);
        gl.viewport(0, 0, this.width, this.height);
        gl.colorMask(true, true, true, true);
        try { gl.disable(gl.DEPTH_TEST); } catch { /* ignore */ }
        try { gl.disable(gl.BLEND); } catch { /* ignore */ }

        gl.useProgram(this._depthToRgbaProgram);
        try { gl.bindVertexArray(this._depthToRgbaVAO); } catch { /* ignore */ }

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._depthTex);
        const loc = gl.getUniformLocation(this._depthToRgbaProgram, 'uDepthTex');
        if (loc) gl.uniform1i(loc, 0);

        // Clear (optional) then draw full-screen triangle.
        try { gl.clearColor(1, 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT); } catch { /* ignore */ }
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        // Read pixels from RGBA color attachment (widely supported).
        let ok = false;
        try {
            try { gl.getError(); } catch { /* ignore */ }
            gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, this._depthRGBA);
            const e = gl.getError();
            ok = (e === gl.NO_ERROR);
        } catch {
            ok = false;
        }

        // Restore minimal state.
        gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
        gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
        try { gl.useProgram(prevProg); } catch { /* ignore */ }
        try { gl.bindVertexArray(prevVao); } catch { /* ignore */ }
        try { gl.activeTexture(prevActiveTex); } catch { /* ignore */ }
        try {
            gl.activeTexture(gl.TEXTURE0);
            if (prevTex0) gl.bindTexture(gl.TEXTURE_2D, prevTex0);
            gl.activeTexture(prevActiveTex);
        } catch { /* ignore */ }
        if (prevColorMask && prevColorMask.length >= 4) {
            try { gl.colorMask(!!prevColorMask[0], !!prevColorMask[1], !!prevColorMask[2], !!prevColorMask[3]); } catch { /* ignore */ }
        }

        return ok;
    }

    _destroyResources() {
        const gl = this.gl;
        if (gl) {
            try { if (this._depthTex) gl.deleteTexture(this._depthTex); } catch { /* ignore */ }
            try { if (this._fbo) gl.deleteFramebuffer(this._fbo); } catch { /* ignore */ }
            try { if (this._rgbaTex) gl.deleteTexture(this._rgbaTex); } catch { /* ignore */ }
            try { if (this._rgbaFbo) gl.deleteFramebuffer(this._rgbaFbo); } catch { /* ignore */ }
            try { if (this._depthToRgbaProgram) gl.deleteProgram(this._depthToRgbaProgram); } catch { /* ignore */ }
            try { if (this._depthToRgbaVAO) gl.deleteVertexArray(this._depthToRgbaVAO); } catch { /* ignore */ }
        }
        this._depthTex = null;
        this._fbo = null;
        this._depthReadFbo = null;
        this._rgbaTex = null;
        this._rgbaFbo = null;
        this._depthToRgbaProgram = null;
        this._depthToRgbaVAO = null;
        this._depthU32 = null;
        this._depthF32 = null;
        this._depthRGBA = null;
        this._useFloatReadback = false;
        this._lastStats.lastReadbackOk = false;
        // Preserve _readbackMode across resizes/recreates; it is updated on success/failure paths.
        this._readbackSupported = true;
    }
}



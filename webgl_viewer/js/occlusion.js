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
     * @param {{ width?: number, height?: number, readbackEveryNFrames?: number, depthEps?: number }} opts
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
        this._depthU32 = null;
        this._depthF32 = null;
        this._useFloatReadback = false;
        this._readbackSupported = true;
        this._warnedReadback = false;

        this._lastStats = {
            occlusionTests: 0,
            culled: 0,
            readbacks: 0,
            lastReadbackMs: 0,
            lastReadbackOk: false,
        };

        this._tmpV4 = glMatrix.vec4.create();
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
            readbackMode: this._useFloatReadback ? 'float' : 'u16',
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
        this._depthTex = gl.createTexture();

        gl.bindTexture(gl.TEXTURE_2D, this._depthTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
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
        this._lastStats.lastReadbackOk = false;
        this._readbackSupported = true;
    }

    _readDepthPixels() {
        const gl = this.gl;
        if (!this._fbo) return false;
        if (!this._readbackSupported) return false;

        // Read from our depth FBO.
        const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);

        // Many WebGL2 implementations are picky here; prefer the most compatible path:
        // DEPTH_COMPONENT + UNSIGNED_SHORT from a DEPTH_COMPONENT16 attachment.
        //
        // If this fails (INVALID_ENUM on some GPUs/drivers), disable readback permanently and fail open.
        let ok = false;
        this._useFloatReadback = false;
        try {
            // Clear any prior error so we interpret the result of this call only.
            try { gl.getError(); } catch { /* ignore */ }
            gl.readPixels(0, 0, this.width, this.height, gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT, this._depthU32);
            const e = gl.getError();
            ok = (e === gl.NO_ERROR);
        } catch {
            ok = false;
        }

        // Fallback: some ANGLE/GPU combos reject DEPTH_COMPONENT + UNSIGNED_SHORT with INVALID_ENUM.
        // Try float readback (still normalized 0..1), which tends to be more broadly supported.
        if (!ok) {
            try {
                if (!this._depthF32 || this._depthF32.length !== (this.width * this.height)) {
                    this._depthF32 = new Float32Array(this.width * this.height);
                }
                try { gl.getError(); } catch { /* ignore */ }
                gl.readPixels(0, 0, this.width, this.height, gl.DEPTH_COMPONENT, gl.FLOAT, this._depthF32);
                const e2 = gl.getError();
                ok = (e2 === gl.NO_ERROR);
                this._useFloatReadback = ok;
            } catch {
                ok = false;
                this._useFloatReadback = false;
            }
        } else {
            // Successful u16 readback => ignore any float buffer.
            this._depthF32 = null;
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
        this._lastStats.lastReadbackOk = !!ok;
        if (!ok) {
            this._readbackSupported = false;
            if (!this._warnedReadback) {
                this._warnedReadback = true;
                try {
                    console.warn('OcclusionCuller: depth readPixels not supported on this GPU/browser; disabling occlusion readback.');
                } catch { /* ignore */ }
            }
        }
        return ok;
    }

    _destroyResources() {
        const gl = this.gl;
        if (gl) {
            try { if (this._depthTex) gl.deleteTexture(this._depthTex); } catch { /* ignore */ }
            try { if (this._fbo) gl.deleteFramebuffer(this._fbo); } catch { /* ignore */ }
        }
        this._depthTex = null;
        this._fbo = null;
        this._depthU32 = null;
        this._depthF32 = null;
        this._useFloatReadback = false;
        this._lastStats.lastReadbackOk = false;
    }
}



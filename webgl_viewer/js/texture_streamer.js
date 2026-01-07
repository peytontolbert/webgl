import { fetchBlob, deleteAssetCacheEntry } from './asset_fetcher.js';
import { uploadDdsToTexture } from './dds_loader.js';

export class TextureStreamer {
    constructor(gl, { maxTextures = 256, maxBytes = 256 * 1024 * 1024 } = {}) {
        this.gl = gl;
        // Cache caps (user-controlled). IMPORTANT: these are NOT tied to the "quality" setting.
        // Quality affects decode/upload behavior, not how much we keep resident.
        this.maxTextures = maxTextures;
        this.maxBytes = maxBytes;

        /**
         * Texture quality affects how textures are decoded/uploaded.
         * - high: full res + mipmaps
         * - medium: downscale ~1/2 + mipmaps
         * - low: downscale ~1/4 + no mipmaps
         * @type {'high'|'medium'|'low'}
         */
        this.quality = 'high';

        /**
         * Cache is keyed by `${tier}|${baseUrl}` so we can keep multiple quality tiers resident
         * and upgrade on demand without thrashing.
         *
         * key -> { baseUrl, tier, tex, bytes, lastUse, loading }
         */
        this.cache = new Map();
        this.totalBytes = 0;

        // Frame-scoped request stats (optional; used for debugging).
        this._frameId = 0;
        this._frameRequests = new Map(); // cacheKey -> { baseUrl, tier, distance, priority }
        this._lastFrameRequestCount = 0;
        this._lastFrameTouchedCount = 0;

        // Streaming scheduler:
        // - We record desired textures via touch()
        // - We start a bounded number of new loads in endFrame()
        //
        // This prevents a single frame from spawning thousands of fetches (which causes stalls and thrash).
        this._maxLoadsInFlight = 32;
        this._loadsInFlight = 0;
        this._maxNewLoadsPerFrame = 64;

        // Eviction/debug stats.
        this._evictionCount = 0;
        this._lastEvictedUrl = null;
        this._lastEvictedTier = null;
        this._lastErrorUrl = null;
        this._lastErrorMsg = null;
        // Recent error ring buffer (even if console warnings are suppressed).
        this._recentErrors = [];
        this._recentErrorsMax = 120;

        // Try to avoid evicting textures that were used very recently (reduces visible churn).
        this.minResidentMs = 1250;

        // Negative cache for missing texture URLs (prevents repeated 404 spam and enables
        // "try alternate candidate" logic in renderers).
        // url -> { untilMs: number, count: number }
        this._missing404 = new Map();
        this._missing404TtlMs = 10 * 60 * 1000; // 10 minutes

        // Distance -> tier thresholds (viewer-space units; tune as needed).
        // dist <= highDist => high, dist <= mediumDist => medium, else low.
        this.highDist = 250;
        this.mediumDist = 900;

        // Debug toggles (can be enabled via DevTools: __viewerApp.textureStreamer.setDebug({ ... }))
        this.debug = {
            enabled: false,
            logEvictions: false,
        };

        // Debug placeholders:
        // Historically we used loud checkerboard placeholders (yellow=loading, magenta=missing).
        // For debugging missing exports, placeholders are confusing: they'd look like "a texture exists".
        // So we expose *no placeholder textures* and represent missing/loading as `null`.
        /** @type {WebGLTexture|null} */
        this.placeholderLoading = null;
        /** @type {WebGLTexture|null} */
        this.placeholderMissing = null;
        /** @type {WebGLTexture|null} */
        this.placeholder = null;

        // Color pipeline: prefer uploading color textures as sRGB so sampling returns linear.
        // (WebGL2 supports SRGB8_ALPHA8; WebGL1 may support EXT_sRGB / WEBGL_sRGB.)
        this._srgbSupport = null; // { ok: boolean, internalFormat: number, format: number } | null
    }

    _nowMs() {
        try { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); } catch { return Date.now(); }
    }

    isMissing(url) {
        const u = String(url || '');
        if (!u) return false;
        const info = this._missing404.get(u);
        if (!info) return false;
        const now = this._nowMs();
        if (now >= (info.untilMs || 0)) {
            try { this._missing404.delete(u); } catch { /* ignore */ }
            return false;
        }
        return true;
    }

    _markMissing404(url) {
        const u = String(url || '');
        if (!u) return;
        const now = this._nowMs();
        const prev = this._missing404.get(u);
        const count = (prev?.count || 0) + 1;
        this._missing404.set(u, { untilMs: now + this._missing404TtlMs, count });
    }

    setQuality(q) {
        const next = (String(q || 'high')).toLowerCase();
        if (next !== 'high' && next !== 'medium' && next !== 'low') return;
        this.quality = next;

        // When lowering quality, aggressively drop disallowed higher-tier textures first.
        this._evictDisallowedTiers();
        this._evictIfNeeded();
    }

    setCacheCaps({ maxTextures, maxBytes } = {}) {
        const mt = Number(maxTextures);
        const mb = Number(maxBytes);
        // maxTextures:
        // - 0 => unlimited (still bounded by maxBytes)
        // - N > 0 => cap loaded textures at N
        if (Number.isFinite(mt)) this.maxTextures = Math.max(0, Math.floor(mt));
        if (Number.isFinite(mb)) this.maxBytes = Math.max(32 * 1024 * 1024, Math.floor(mb));
        this._evictIfNeeded();
    }

    setDistanceTierConfig({ highDist, mediumDist, minResidentMs } = {}) {
        const hd = Number(highDist);
        const md = Number(mediumDist);
        const mr = Number(minResidentMs);
        if (Number.isFinite(hd)) this.highDist = Math.max(0, hd);
        if (Number.isFinite(md)) this.mediumDist = Math.max(this.highDist, md);
        if (Number.isFinite(mr)) this.minResidentMs = Math.max(0, mr);
    }

    setDebug({ enabled, logEvictions } = {}) {
        if (enabled !== undefined) this.debug.enabled = !!enabled;
        if (logEvictions !== undefined) this.debug.logEvictions = !!logEvictions;
    }

    setStreamingConfig({ maxLoadsInFlight, maxNewLoadsPerFrame } = {}) {
        const mi = Number(maxLoadsInFlight);
        const mpf = Number(maxNewLoadsPerFrame);
        if (Number.isFinite(mi)) this._maxLoadsInFlight = Math.max(1, Math.min(512, Math.floor(mi)));
        if (Number.isFinite(mpf)) this._maxNewLoadsPerFrame = Math.max(1, Math.min(2048, Math.floor(mpf)));
    }

    beginFrame(frameId = null) {
        if (frameId === null || frameId === undefined) this._frameId++;
        else this._frameId = (frameId | 0);
        this._frameRequests.clear();
        this._lastFrameTouchedCount = 0;
    }

    endFrame() {
        this._lastFrameRequestCount = this._frameRequests.size;
        // Start a bounded number of new loads from this frame's request set.
        // Prefer: high priority, then nearest distance, then stable URL order.
        try {
            const want = Array.from(this._frameRequests.entries())
                .map(([key, r]) => ({ key, ...r }))
                .sort((a, b) => {
                    const ap = (a.priority === 'high') ? 0 : 1;
                    const bp = (b.priority === 'high') ? 0 : 1;
                    if (ap !== bp) return ap - bp;
                    const ad = Number(a.distance ?? 0);
                    const bd = Number(b.distance ?? 0);
                    if (ad !== bd) return ad - bd;
                    return String(a.baseUrl || '').localeCompare(String(b.baseUrl || ''));
                });

            let started = 0;
            for (const r of want) {
                if (started >= this._maxNewLoadsPerFrame) break;
                if (this._loadsInFlight >= this._maxLoadsInFlight) break;
                const baseUrl = String(r.baseUrl || '');
                if (!baseUrl) continue;
                if (this.isMissing(baseUrl)) continue;

                const kind = r.kind || 'diffuse';
                const tier = r.tier || 'high';
                const k = this._cacheKey(baseUrl, tier, kind);
                const e = this.cache.get(k);
                if (e?.tex || e?.loading) continue;
                started++;
                this._loadsInFlight++;
                void this.ensure(baseUrl, { tier, priority: r.priority || 'low', kind })
                    .catch(() => { /* errors are handled inside ensure */ })
                    .finally(() => {
                        try { this._loadsInFlight = Math.max(0, (this._loadsInFlight | 0) - 1); } catch { /* ignore */ }
                    });
            }
        } catch { /* ignore */ }

        this._evictIfNeeded();
    }

    _createSolidTexture(rgba255) {
        const gl = this.gl;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        // NPOT-safe defaults (works in WebGL1 + WebGL2).
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba255));
        return tex;
    }

    _createCheckerTexture({ a, b, size = 16, cell = 2 } = {}) {
        // Creates a small RGBA checkerboard texture (NPOT-safe defaults).
        // a/b: RGBA[4] bytes.
        const gl = this.gl;
        const s = Math.max(2, Math.min(256, (Number(size) | 0) || 16));
        const c = Math.max(1, Math.min(s, (Number(cell) | 0) || 2));
        const ca = Array.isArray(a) && a.length >= 4 ? a : [255, 0, 255, 255];
        const cb = Array.isArray(b) && b.length >= 4 ? b : [0, 0, 0, 255];
        const data = new Uint8Array(s * s * 4);
        for (let y = 0; y < s; y++) {
            for (let x = 0; x < s; x++) {
                const useA = (((x / c) | 0) + ((y / c) | 0)) % 2 === 0;
                const src = useA ? ca : cb;
                const i = (y * s + x) * 4;
                data[i + 0] = src[0] & 255;
                data[i + 1] = src[1] & 255;
                data[i + 2] = src[2] & 255;
                data[i + 3] = src[3] & 255;
            }
        }
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, s, s, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        return tex;
    }

    _isPowerOfTwo(n) {
        const v = n | 0;
        return v > 0 && (v & (v - 1)) === 0;
    }

    _allowedTierMax() {
        // Global clamp based on UI "Texture quality".
        if (this.quality === 'low') return 'low';
        if (this.quality === 'medium') return 'medium';
        return 'high';
    }

    _clampTierToAllowed(tier) {
        const t = String(tier || 'high').toLowerCase();
        const maxT = this._allowedTierMax();
        if (maxT === 'low') return 'low';
        if (maxT === 'medium') return (t === 'high') ? 'medium' : (t === 'low' ? 'low' : 'medium');
        return (t === 'low' || t === 'medium' || t === 'high') ? t : 'high';
    }

    _tierForDistance(distance, kind = 'diffuse') {
        // Conservative: keep normals/spec a tier lower at the same distance.
        const d0 = Number(distance);
        const d = Number.isFinite(d0) ? d0 : 0;
        let tier;
        if (d <= this.highDist) tier = 'high';
        else if (d <= this.mediumDist) tier = 'medium';
        else tier = 'low';

        const k = String(kind || 'diffuse').toLowerCase();
        if (k === 'normal' || k === 'spec') {
            if (tier === 'high') tier = 'medium';
            else if (tier === 'medium') tier = 'low';
        }
        return this._clampTierToAllowed(tier);
    }

    _colorSpaceForKind(kind) {
        // Color textures should be sRGB decoded for correct lighting.
        // Data textures must remain linear.
        const k = String(kind || 'diffuse').toLowerCase();
        // NOTE:
        // CodeWalker generally relies on *sRGB texture views* so shader `Sample()` returns linear.
        // In the viewer we emulate that by uploading these kinds as sRGB when supported.
        //
        // - diffuse/diffuse2/emissive are color
        // - env maps are also color (lat-long reflections, and sometimes repurposed as color layers)
        // - tint palettes are color lookup textures
        if (
            k === 'diffuse' ||
            k === 'diffuse2' ||
            k === 'emissive' ||
            k === 'env' ||
            k === 'tintpalette'
        ) return 'srgb';
        return 'linear';
    }

    _getSrgbSupport() {
        if (this._srgbSupport) return this._srgbSupport;
        const gl = this.gl;

        // WebGL2: SRGB8_ALPHA8 is core.
        try {
            const isWebGL2 = (typeof WebGL2RenderingContext !== 'undefined') && (gl instanceof WebGL2RenderingContext);
            if (isWebGL2 && typeof gl.SRGB8_ALPHA8 === 'number') {
                this._srgbSupport = { ok: true, internalFormat: gl.SRGB8_ALPHA8, format: gl.RGBA };
                return this._srgbSupport;
            }
        } catch { /* ignore */ }

        // WebGL1: EXT_sRGB / WEBGL_sRGB
        try {
            const ext = gl.getExtension('EXT_sRGB') || gl.getExtension('WEBGL_sRGB');
            if (ext && typeof ext.SRGB_ALPHA_EXT === 'number') {
                // In WebGL1, internalformat and format must match.
                this._srgbSupport = { ok: true, internalFormat: ext.SRGB_ALPHA_EXT, format: ext.SRGB_ALPHA_EXT };
                return this._srgbSupport;
            }
        } catch { /* ignore */ }

        this._srgbSupport = { ok: false, internalFormat: gl.RGBA, format: gl.RGBA };
        return this._srgbSupport;
    }

    _drainGlErrors(gl, max = 8) {
        // WebGL error flags are sticky until read. If some *other* subsystem (terrain MSAA resolve,
        // feedback loop, etc.) triggers an error, it can cause our texture upload sanity-check to
        // incorrectly fail and downgrade real textures to placeholders.
        //
        // Drain a few pending errors so our checks only reflect errors from this code path.
        try {
            let n = 0;
            while (n < (max | 0)) {
                const e = gl.getError();
                if (!e || e === gl.NO_ERROR) break;
                n++;
            }
        } catch { /* ignore */ }
    }

    supportsSrgbTextures() {
        return !!this._getSrgbSupport().ok;
    }

    _readU64(dv, off) {
        // DataView doesn't have getBigUint64 in older engines; implement safely.
        try {
            if (typeof dv.getBigUint64 === 'function') return Number(dv.getBigUint64(off, true));
        } catch { /* ignore */ }
        const lo = dv.getUint32(off, true);
        const hi = dv.getUint32(off + 4, true);
        // NOTE: assumes offsets fit in 53-bit safe integer range (true for our assets).
        return hi * 4294967296 + lo;
    }

    _uploadKtx2(arrayBuffer, { kind = 'diffuse', tier = 'high' } = {}) {
        const gl = this.gl;
        const dv = new DataView(arrayBuffer);

        // KTX2 identifier: 0xAB 0x4B 0x54 0x58 0x20 0x32 0x30 0xBB 0x0D 0x0A 0x1A 0x0A
        if (dv.byteLength < 80) throw new Error('KTX2: buffer too small');
        const id = new Uint8Array(arrayBuffer, 0, 12);
        const isKtx2 = id[0] === 0xAB && id[1] === 0x4B && id[2] === 0x54 && id[3] === 0x58
            && id[4] === 0x20 && id[5] === 0x32 && id[6] === 0x30 && id[7] === 0xBB
            && id[8] === 0x0D && id[9] === 0x0A && id[10] === 0x1A && id[11] === 0x0A;
        if (!isKtx2) throw new Error('KTX2: bad identifier');

        const vkFormat = dv.getUint32(12, true);
        const typeSize = dv.getUint32(16, true);
        const pixelWidth = dv.getUint32(20, true);
        const pixelHeight = dv.getUint32(24, true);
        const pixelDepth = dv.getUint32(28, true);
        const layerCount = dv.getUint32(32, true);
        const faceCount = dv.getUint32(36, true);
        const levelCount = dv.getUint32(40, true);
        const supercompressionScheme = dv.getUint32(44, true);
        // DFD/KVD/SGD are ignored here; we rely on vkFormat only.

        // Minimal support: 2D textures, no arrays/cubemaps, no supercompression.
        if (pixelWidth <= 0 || pixelHeight <= 0) throw new Error('KTX2: invalid dimensions');
        if (pixelDepth !== 0 && pixelDepth !== 1) throw new Error('KTX2: 3D not supported');
        if (layerCount > 1) throw new Error('KTX2: arrays not supported');
        if (faceCount !== 1) throw new Error('KTX2: cubemaps not supported');
        if (supercompressionScheme !== 0) throw new Error('KTX2: supercompression not supported (need transcoder)');
        if (typeSize !== 1) throw new Error('KTX2: typeSize != 1 not supported');

        // Only accept RGBA8 formats for now.
        // VK_FORMAT_R8G8B8A8_UNORM = 37
        // VK_FORMAT_R8G8B8A8_SRGB  = 43
        const VK_RGBA8_UNORM = 37;
        const VK_RGBA8_SRGB = 43;
        if (vkFormat !== VK_RGBA8_UNORM && vkFormat !== VK_RGBA8_SRGB) {
            throw new Error(`KTX2: unsupported vkFormat=${vkFormat} (only RGBA8 UNORM/SRGB supported without transcoder)`);
        }

        const levels = Math.max(1, levelCount | 0);
        const levelIndexOff = 80;
        const levelEntryBytes = 24;
        if (dv.byteLength < levelIndexOff + levels * levelEntryBytes) throw new Error('KTX2: truncated level index');

        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);

        const prevFlip = (() => {
            try { return gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL); } catch { return null; }
        })();
        try { gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); } catch { /* ignore */ }

        // Choose sRGB internalFormat only for color textures, when supported and vkFormat is SRGB.
        const cs = this._colorSpaceForKind(kind);
        const srgb = this._getSrgbSupport();
        const wantSrgb = (cs === 'srgb') && (vkFormat === VK_RGBA8_SRGB) && srgb.ok;
        const internalFormat = wantSrgb ? srgb.internalFormat : gl.RGBA;
        const format = wantSrgb ? srgb.format : gl.RGBA;

        let uploadedBytes = 0;
        for (let level = 0; level < levels; level++) {
            const entryOff = levelIndexOff + level * levelEntryBytes;
            const byteOffset = this._readU64(dv, entryOff + 0);
            const byteLength = this._readU64(dv, entryOff + 8);
            // const uncompressedByteLength = this._readU64(dv, entryOff + 16);
            if (byteOffset <= 0 || byteLength <= 0) continue;
            if (byteOffset + byteLength > dv.byteLength) throw new Error('KTX2: level data out of range');

            const w = Math.max(1, pixelWidth >> level);
            const h = Math.max(1, pixelHeight >> level);
            const expected = w * h * 4;
            if (byteLength < expected) throw new Error(`KTX2: level ${level} too small (${byteLength} < ${expected})`);
            const pixels = new Uint8Array(arrayBuffer, byteOffset, expected);
            gl.texImage2D(gl.TEXTURE_2D, level, internalFormat, w, h, 0, format, gl.UNSIGNED_BYTE, pixels);
            uploadedBytes += expected;
        }

        // Texture params:
        // - If KTX2 includes mip levels, use them when allowed.
        // - IMPORTANT for GTA parity: most materials rely on tiling (UVs outside 0..1),
        //   so prefer REPEAT when possible (WebGL2 or power-of-two textures).
        const isWebGL2 = (() => {
            try {
                return (typeof WebGL2RenderingContext !== 'undefined') && (gl instanceof WebGL2RenderingContext);
            } catch {
                return false;
            }
        })();
        const isPot = this._isPowerOfTwo(pixelWidth) && this._isPowerOfTwo(pixelHeight);
        const canRepeat = isWebGL2 || isPot;
        const canMips = isWebGL2 || isPot;
        const hasMips = levels > 1;
        const useMips = hasMips && canMips;

        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, useMips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, canRepeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, canRepeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);

        if (useMips) {
            // Anisotropic filtering greatly improves texture sharpness at grazing angles.
            try {
                const extAniso =
                    gl.getExtension('EXT_texture_filter_anisotropic')
                    || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic')
                    || gl.getExtension('MOZ_EXT_texture_filter_anisotropic');
                if (extAniso) {
                    const maxA = gl.getParameter(extAniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1;
                    const wantA = Math.min(8, Math.max(1, Number(maxA) || 1));
                    gl.texParameterf(gl.TEXTURE_2D, extAniso.TEXTURE_MAX_ANISOTROPY_EXT, wantA);
                }
            } catch { /* ignore */ }
        }

        try {
            if (prevFlip !== null) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, prevFlip);
        } catch { /* ignore */ }

        // Sanity check upload.
        try {
            const e0 = gl.getError();
            if (e0 && e0 !== gl.NO_ERROR) throw new Error(`gl error ${e0} after KTX2 upload`);
        } catch (e) {
            try { gl.deleteTexture(tex); } catch { /* ignore */ }
            throw e;
        }

        return { tex, bytes: uploadedBytes, width: pixelWidth, height: pixelHeight, levels, uploadedAsSrgb: wantSrgb, vkFormat };
    }

    _cacheKey(baseUrl, tier, kind = 'diffuse') {
        const u = String(baseUrl || '');
        const t = this._clampTierToAllowed(tier);
        const cs = this._colorSpaceForKind(kind);
        return `${t}|${cs}|${u}`;
    }

    _parseKey(key) {
        const s = String(key || '');
        const parts = s.split('|');
        if (parts.length < 3) {
            // Back-compat: old keys were `${tier}|${url}`
            const i = s.indexOf('|');
            if (i === -1) return { tier: this._clampTierToAllowed('high'), colorSpace: 'linear', baseUrl: s };
            return { tier: this._clampTierToAllowed(s.slice(0, i)), colorSpace: 'linear', baseUrl: s.slice(i + 1) };
        }
        return {
            tier: this._clampTierToAllowed(parts[0]),
            colorSpace: (parts[1] === 'srgb') ? 'srgb' : 'linear',
            baseUrl: parts.slice(2).join('|'),
        };
    }

    _evictDisallowedTiers() {
        const maxT = this._allowedTierMax();
        if (maxT === 'high') return;

        const disallowed = [];
        for (const [k, v] of this.cache.entries()) {
            if (!v || v.loading || !v.tex) continue;
            const tier = String(v.tier || this._parseKey(k).tier);
            if (maxT === 'medium' && tier === 'high') disallowed.push([k, v]);
            if (maxT === 'low' && (tier === 'high' || tier === 'medium')) disallowed.push([k, v]);
        }

        // Evict newest-last (doesn't matter much; these are explicitly disallowed).
        for (const [k, v] of disallowed) {
            try { this.gl.deleteTexture(v.tex); } catch { /* ignore */ }
            this.totalBytes -= v.bytes || 0;
            this.cache.delete(k);
        }
    }

    _evictIfNeeded() {
        // Simple LRU eviction.
        //
        // IMPORTANT:
        // `this.cache` also includes *loading* entries (tex=null, loading=true).
        // Those should NOT count toward the eviction threshold, otherwise a large burst of
        // in-flight requests can cause us to evict already-loaded textures unnecessarily,
        // leading to severe placeholder "thrash".
        const loadedCount = (() => {
            try {
                let n = 0;
                for (const v of this.cache.values()) {
                    if (v && v.tex && !v.loading) n++;
                }
                return n;
            } catch {
                return 0;
            }
        })();
        const maxTex = (Number.isFinite(this.maxTextures) && this.maxTextures > 0) ? this.maxTextures : Infinity;
        if (loadedCount <= maxTex && this.totalBytes <= this.maxBytes) return;

        const now = performance.now();
        const all = Array.from(this.cache.entries())
            .filter(([, v]) => v && v.tex && !v.loading);

        // Try to avoid evicting very-recently-used textures to reduce visible "black churn".
        const oldEnough = all.filter(([, v]) => (now - (v.lastUse ?? 0)) >= this.minResidentMs);
        const entries = (oldEnough.length > 0 ? oldEnough : all)
            .sort((a, b) => (a[1].lastUse ?? 0) - (b[1].lastUse ?? 0));

        let loadedRemaining = loadedCount;
        for (const [url, v] of entries) {
            if (loadedRemaining <= maxTex && this.totalBytes <= this.maxBytes) break;
            try {
                this.gl.deleteTexture(v.tex);
            } catch {
                // ignore
            }
            this.totalBytes -= v.bytes || 0;
            this.cache.delete(url);
            loadedRemaining = Math.max(0, loadedRemaining - 1);
            this._evictionCount++;
            this._lastEvictedUrl = v?.baseUrl ?? null;
            this._lastEvictedTier = v?.tier ?? null;
            if (this.debug?.enabled && this.debug?.logEvictions) {
                try {
                    console.log(`TextureStreamer: evicted tier=${v?.tier ?? '?'} url=${v?.baseUrl ?? url} bytes=${v?.bytes ?? 0} totalBytes=${this.totalBytes}`);
                } catch { /* ignore */ }
            }
        }
    }

    get(url, { distance = 0, kind = 'diffuse', tier = null } = {}) {
        const baseUrl = String(url || '');
        if (!baseUrl) return null;
        if (this.isMissing(baseUrl)) return null;

        const desired = this._clampTierToAllowed(tier ?? this._tierForDistance(distance, kind));

        // Only return textures within the globally-allowed tier cap.
        const wantOrder = (desired === 'high')
            ? ['high', 'medium', 'low']
            : (desired === 'medium')
                ? ['medium', 'low']
                : ['low'];

        for (const t of wantOrder) {
            const k = this._cacheKey(baseUrl, t, kind);
            const e = this.cache.get(k);
            if (e?.tex) {
                e.lastUse = performance.now();
                return e.tex;
            }
            if (e?.loading) {
                // Loading: return null so renderers can disable sampling cleanly.
                return null;
            }
        }
        return null;
    }

    /**
     * Return texture + metadata so renderers can decide whether shader-side sRGB decode is needed.
     * @returns {{ tex: WebGLTexture, isPlaceholder: boolean, uploadedAsSrgb: boolean, needsUvFlipY: boolean }}
     */
    getWithInfo(url, { distance = 0, kind = 'diffuse', tier = null } = {}) {
        const baseUrl = String(url || '');
        if (!baseUrl) return { tex: null, isPlaceholder: true, uploadedAsSrgb: false, needsUvFlipY: false };
        if (this.isMissing(baseUrl)) return { tex: null, isPlaceholder: true, uploadedAsSrgb: false, needsUvFlipY: false };
        const desired = this._clampTierToAllowed(tier ?? this._tierForDistance(distance, kind));
        const wantOrder = (desired === 'high')
            ? ['high', 'medium', 'low']
            : (desired === 'medium')
                ? ['medium', 'low']
                : ['low'];
        for (const t of wantOrder) {
            const k = this._cacheKey(baseUrl, t, kind);
            const e = this.cache.get(k);
            if (e?.tex) {
                e.lastUse = performance.now();
                return { tex: e.tex, isPlaceholder: false, uploadedAsSrgb: !!e.uploadedAsSrgb, needsUvFlipY: !!e.needsUvFlipY };
            }
            if (e?.loading) {
                return { tex: null, isPlaceholder: true, uploadedAsSrgb: false, needsUvFlipY: false };
            }
        }
        return { tex: null, isPlaceholder: true, uploadedAsSrgb: false, needsUvFlipY: false };
    }

    prefetch(url) {
        // Back-compat helper: schedule a low-priority request.
        const baseUrl = String(url || '');
        if (!baseUrl) return;
        this.touch(baseUrl, { distance: 0, kind: 'diffuse', priority: 'low' });
    }

    touch(url, { distance = 0, kind = 'diffuse', priority = null, tier = null } = {}) {
        const baseUrl = String(url || '');
        if (!baseUrl) return;

        // If we know this URL 404s, don't keep retrying every frame.
        if (this.isMissing(baseUrl)) return;

        const desiredTier = this._clampTierToAllowed(tier ?? this._tierForDistance(distance, kind));
        const k = this._cacheKey(baseUrl, desiredTier, kind);

        // Record request (for debugging/stats).
        const distNum = Number(distance);
        const dist = Number.isFinite(distNum) ? distNum : 0;
        const pri = (priority === 'low' || priority === 'high') ? priority : (dist <= this.highDist ? 'high' : 'low');
        const prev = this._frameRequests.get(k);
        if (!prev || dist < (prev.distance ?? 1e30)) {
            this._frameRequests.set(k, { baseUrl, tier: desiredTier, distance: dist, priority: pri, kind });
        }

        // Mark the best currently-loaded tier as used so it isn't evicted mid-session.
        // (If we haven't loaded any tier yet, this does nothing.)
        try {
            const now = performance.now();
            const existing = this.cache.get(k);
            if (existing) existing.lastUse = now;
        } catch { /* ignore */ }

        // Start load if needed (fire-and-forget; de-duped by cache entry + asset_fetcher inflight).
        // NOTE: actual load scheduling happens in endFrame() so we can bound concurrency
        // and prioritize by distance/priority. Here we only record intent.
        this._lastFrameTouchedCount++;
    }

    async ensure(url, { tier = null, priority = 'low', kind = 'diffuse' } = {}) {
        const baseUrl = String(url || '');
        if (!baseUrl) return null;

        if (this.isMissing(baseUrl)) return null;

        const t = this._clampTierToAllowed(tier ?? this.quality);
        const key = this._cacheKey(baseUrl, t, kind);

        const existing = this.cache.get(key);
        if (existing?.tex) {
            existing.lastUse = performance.now();
            return existing.tex;
        }
        if (existing?.loading) return null;

        this.cache.set(key, { baseUrl, tier: t, tex: null, bytes: 0, lastUse: performance.now(), loading: true, uploadedAsSrgb: false, needsUvFlipY: false });

        try {
            // LOW priority: textures are important for quality, but should not starve chunk/mesh/meta loads.
            const pr = (priority === 'high') ? 'high' : 'low';
            let blob = null;
            try {
                blob = await fetchBlob(baseUrl, { priority: pr, usePersistentCache: true });
            } catch (e0) {
                // Some browsers surface ERR_CONTENT_LENGTH_MISMATCH / truncated cache entries
                // as a generic TypeError("Failed to fetch") even though the file exists.
                // Best-effort recovery:
                // - evict this URL from Cache Storage
                // - retry once without persistent cache
                try { await deleteAssetCacheEntry(baseUrl); } catch { /* ignore */ }
                blob = await fetchBlob(baseUrl, { priority: pr, usePersistentCache: false });
            }

            const gl = this.gl;
            this._drainGlErrors(gl, 16);

            // Quick sanity check: if the server returned HTML (SPA fallback) or some other non-image,
            // createImageBitmap will throw a vague "invalid format" / decode error.
            // Sniff the first few bytes to provide a clearer error message.
            let sniffIsKtx2 = false;
            let sniffIsDds = false;
            try {
                const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
                const isPng = head.length >= 8
                    && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47
                    && head[4] === 0x0D && head[5] === 0x0A && head[6] === 0x1A && head[7] === 0x0A;
                const isJpeg = head.length >= 3 && head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF;
                const isGif = head.length >= 4 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38;
                const isBmp = head.length >= 2 && head[0] === 0x42 && head[1] === 0x4D;
                const isWebp = head.length >= 12
                    && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 // RIFF
                    && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50; // WEBP
                // Common “wrong format under .png name” cases:
                // - DDS (CodeWalker exports DDS by default)
                // - KTX2 (Basis/UASTC/ETC/BC transcodable containers)
                const isDds = head.length >= 4
                    && head[0] === 0x44 && head[1] === 0x44 && head[2] === 0x53 && head[3] === 0x20; // 'DDS '
                const isKtx2 = head.length >= 12
                    && head[0] === 0xAB && head[1] === 0x4B && head[2] === 0x54 && head[3] === 0x58
                    && head[4] === 0x20 && head[5] === 0x32 && head[6] === 0x30 && head[7] === 0xBB
                    && head[8] === 0x0D && head[9] === 0x0A && head[10] === 0x1A && head[11] === 0x0A;
                const looksLikeHtml = head.length >= 1 && (head[0] === 0x3C /* '<' */);

                sniffIsKtx2 = !!isKtx2;
                sniffIsDds = !!isDds;
                // KTX2 is supported via a separate upload path (when uncompressed RGBA8).
                // DDS is supported via a separate upload path (compressed formats via WebGL extensions).
                if (!(isPng || isJpeg || isGif || isBmp || isWebp || isKtx2 || isDds) || looksLikeHtml) {
                    const hex = Array.from(head).map((b) => b.toString(16).padStart(2, '0')).join(' ');
                    const kind = looksLikeHtml
                        ? 'html'
                        : (isDds ? 'dds' : (isKtx2 ? 'ktx2' : 'unknown'));
                    const hint = (kind === 'html')
                        ? 'Your server is likely returning index.html (SPA fallback) for a missing /assets/... texture URL.'
                        : (kind === 'dds')
                            ? 'This looks like a DDS file. The viewer can upload some DDS-compressed formats (BC1/3/4/5/6H/7) via WebGL extensions, but not all DDS variants.'
                            : (kind === 'ktx2')
                                ? 'This looks like a KTX2 texture container. If it is not uncompressed RGBA8 KTX2, the viewer will need a transcoder to support it.'
                                : 'The bytes are not a known browser image format; the file may be corrupted or mislabeled.';
                    // If we accidentally cached HTML under this URL, evict it so a later fix to hosting
                    // (or a newly-added file) will be picked up without requiring a full cache clear.
                    if (kind === 'html') {
                        try { await deleteAssetCacheEntry(baseUrl); } catch { /* ignore */ }
                    }
                    throw new Error(
                        `Texture blob is not a supported image (or is HTML). ` +
                        `url=${baseUrl} size=${blob.size} kind=${kind} head=[${hex}]. ` +
                        hint
                    );
                }
            } catch (e) {
                // If sniffing fails for any reason, continue and let decode throw; we'll still log once per URL.
                // However, if sniffing explicitly found a non-image, rethrow for clarity.
                const msg = String(e?.message || '');
                if (msg.includes('Texture blob is not a supported image')) throw e;
            }

            // KTX2 path: decode/upload without ImageBitmap.
            if (sniffIsKtx2) {
                const ab = await blob.arrayBuffer();
                const out = this._uploadKtx2(ab, { kind, tier: t });
                this.totalBytes += out.bytes;
                // KTX2 path applies UNPACK_FLIP_Y_WEBGL during upload (like PNG).
                this.cache.set(key, { baseUrl, tier: t, tex: out.tex, bytes: out.bytes, lastUse: performance.now(), loading: false, uploadedAsSrgb: !!out.uploadedAsSrgb, needsUvFlipY: false });
                this._evictIfNeeded();
                return out.tex;
            }

            // DDS path: upload compressed data without ImageBitmap.
            if (sniffIsDds) {
                const ab = await blob.arrayBuffer();
                const out = uploadDdsToTexture(gl, ab, { kind, tier: t });
                this.totalBytes += out.bytes;
                // IMPORTANT: UNPACK_FLIP_Y_WEBGL is not reliably honored for compressedTexImage2D.
                // To match the PNG/KTX2 upload path (which flips on upload), renderers must flip UV.y in shader for DDS.
                this.cache.set(key, { baseUrl, tier: t, tex: out.tex, bytes: out.bytes, lastUse: performance.now(), loading: false, uploadedAsSrgb: !!out.uploadedAsSrgb, needsUvFlipY: true });
                this._evictIfNeeded();
                return out.tex;
            }

            // Browser-image path:
            // Prefer createImageBitmap (fast path). Fallback to HTMLImageElement for older browsers.
            /** @type {any} */
            let img = null;
            /** @type {any} */
            let full = null;
            const canCIB = (typeof createImageBitmap === 'function');
            if (canCIB) {
                // Always decode once so we can clamp to GPU MAX_TEXTURE_SIZE (prevents silent black textures).
                // Important for color correctness:
                // - Request no implicit color space conversion
                // - Request no alpha premultiplication
                // (Browsers vary in support; fall back if options aren't accepted.)
                try {
                    full = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
                } catch {
                    full = await createImageBitmap(blob);
                }

                // Choose target dimensions based on quality tier AND GPU max texture size.
                const maxSize = (() => {
                    try {
                        const m = gl.getParameter(gl.MAX_TEXTURE_SIZE);
                        return Number.isFinite(Number(m)) ? Math.max(1, Number(m)) : 4096;
                    } catch {
                        return 4096;
                    }
                })();

                const qualityScale = (t === 'medium') ? 0.5 : (t === 'low' ? 0.25 : 1.0);
                let targetW = Math.max(1, Math.floor(full.width * qualityScale));
                let targetH = Math.max(1, Math.floor(full.height * qualityScale));

                // Clamp to maxSize while preserving aspect ratio.
                const tooBig = targetW > maxSize || targetH > maxSize;
                if (tooBig) {
                    const s = Math.min(maxSize / Math.max(1, targetW), maxSize / Math.max(1, targetH));
                    targetW = Math.max(1, Math.floor(targetW * s));
                    targetH = Math.max(1, Math.floor(targetH * s));
                }

                if (targetW !== full.width || targetH !== full.height) {
                    try {
                        img = await createImageBitmap(full, {
                            resizeWidth: targetW,
                            resizeHeight: targetH,
                            resizeQuality: (t === 'high') ? 'high' : (t === 'medium' ? 'medium' : 'low'),
                            colorSpaceConversion: 'none',
                            premultiplyAlpha: 'none',
                        });
                    } catch {
                        img = await createImageBitmap(full, {
                            resizeWidth: targetW,
                            resizeHeight: targetH,
                            resizeQuality: (t === 'high') ? 'high' : (t === 'medium' ? 'medium' : 'low'),
                        });
                    }
                } else {
                    img = full;
                    full = null;
                }
            } else {
                // Fallback path: decode via Image element.
                img = await new Promise((resolve, reject) => {
                    try {
                        const imgEl = new Image();
                        imgEl.onload = () => resolve(imgEl);
                        imgEl.onerror = () => reject(new Error('Image decode failed'));
                        const objUrl = URL.createObjectURL(blob);
                        imgEl.src = objUrl;
                        // Ensure URL is released after load/error.
                        const revoke = () => { try { URL.revokeObjectURL(objUrl); } catch { /* ignore */ } };
                        imgEl.onloadend = revoke;
                        // Some browsers don't fire onloadend; be safe:
                        setTimeout(revoke, 10000);
                    } catch (e) {
                        reject(e);
                    }
                });
            }

            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);

            // GTA assets are authored for DirectX-style texture coordinates in many cases.
            // Flip Y on upload so UVs from CodeWalker line up in WebGL without shader hacks.
            // (This streamer is used for model textures, not for the terrain heightmap path.)
            const prevFlip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
            const prevPma = (() => {
                try { return gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL); } catch { return null; }
            })();
            const prevCsc = (() => {
                try {
                    return gl.getParameter(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL);
                } catch {
                    return null;
                }
            })();
            try {
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            } catch {
                // ignore
            }
            // GTA textures are authored as straight alpha; avoid browser-side premultiply on upload.
            try {
                if (prevPma !== null && typeof gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL !== 'undefined') {
                    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
                }
            } catch { /* ignore */ }
            try {
                if (prevCsc !== null && typeof gl.UNPACK_COLORSPACE_CONVERSION_WEBGL !== 'undefined') {
                    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
                }
            } catch { /* ignore */ }

            // WebGL1 restriction: mipmaps + REPEAT require power-of-two textures.
            // WebGL2 lifts NPOT restrictions, so we can use mipmaps + REPEAT for NPOT textures too.
            // (This is a major quality difference vs CodeWalker: without mips/aniso, textures look blurry/shimmery.)
            const isWebGL2 = (() => {
                try {
                    return (typeof WebGL2RenderingContext !== 'undefined') && (gl instanceof WebGL2RenderingContext);
                } catch {
                    return false;
                }
            })();
            const isPot = this._isPowerOfTwo(img.width) && this._isPowerOfTwo(img.height);
            const canMips = isWebGL2 || isPot;
            const canRepeat = isWebGL2 || isPot;
            const useMips = (t !== 'low') && canMips;
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, useMips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, canRepeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, canRepeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);

            // Upload: choose sRGB internalFormat for color textures when supported.
            const cs = this._colorSpaceForKind(kind);
            const srgb = this._getSrgbSupport();
            const internalFormat = (cs === 'srgb' && srgb.ok) ? srgb.internalFormat : gl.RGBA;
            const format = (cs === 'srgb' && srgb.ok) ? srgb.format : gl.RGBA;
            gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, format, gl.UNSIGNED_BYTE, img);
            try {
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, prevFlip);
            } catch {
                // ignore
            }
            try {
                if (prevPma !== null && typeof gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL !== 'undefined') {
                    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, prevPma);
                }
            } catch { /* ignore */ }
            try {
                if (prevCsc !== null && typeof gl.UNPACK_COLORSPACE_CONVERSION_WEBGL !== 'undefined') {
                    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, prevCsc);
                }
            } catch { /* ignore */ }
            if (useMips) {
                gl.generateMipmap(gl.TEXTURE_2D);

                // Anisotropic filtering greatly improves texture sharpness at grazing angles.
                // (CodeWalker/DX typically uses anisotropy; browsers default to none.)
                try {
                    const extAniso =
                        gl.getExtension('EXT_texture_filter_anisotropic')
                        || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic')
                        || gl.getExtension('MOZ_EXT_texture_filter_anisotropic');
                    if (extAniso) {
                        const maxA = gl.getParameter(extAniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1;
                        // Conservative default to avoid perf cliffs on low-end GPUs.
                        const wantA = Math.min(8, Math.max(1, Number(maxA) || 1));
                        gl.texParameterf(gl.TEXTURE_2D, extAniso.TEXTURE_MAX_ANISOTROPY_EXT, wantA);
                    }
                } catch { /* ignore */ }
            }
            // If upload failed, don't leave an incomplete texture bound (can sample black).
            try {
                // Drain again so we don't attribute earlier unrelated errors to this upload.
                this._drainGlErrors(gl, 16);
                const e0 = gl.getError();
                if (e0 && e0 !== gl.NO_ERROR) throw new Error(`gl error ${e0} after tex upload`);
            } catch (e) {
                try { gl.deleteTexture(tex); } catch { /* ignore */ }
                throw e;
            }

            // Release decoded bitmaps (helps memory).
            try { if (img && img !== full) img.close?.(); } catch { /* ignore */ }
            try { full?.close?.(); } catch { /* ignore */ }

            // Approximate GPU memory:
            // - base level: w*h*4
            // - mip chain adds ~33% on average for POT textures
            const baseBytes = img.width * img.height * 4;
            const bytes = Math.floor(baseBytes * (useMips ? (4.0 / 3.0) : 1.0));
            this.totalBytes += bytes;
            // Browser-image uploads can request sRGB internalFormat when supported (see internalFormat selection above).
            // Record whether this entry was uploaded as sRGB so shaders can decide whether to decode.
            const uploadedAsSrgb = (cs === 'srgb' && srgb.ok);
            // Browser-image path flips on upload via UNPACK_FLIP_Y_WEBGL.
            this.cache.set(key, { baseUrl, tier: t, tex, bytes, lastUse: performance.now(), loading: false, uploadedAsSrgb, needsUvFlipY: false });
            this._evictIfNeeded();
            return tex;
        } catch (e) {
            // If this is a 404, mark it missing so we can stop spamming and allow renderers
            // to try alternate candidate URLs (hash-only vs hash+slug, etc).
            let status = null;
            try {
                const msg = String(e?.message || e || '');
                const m = msg.match(/status=(\d+)/i);
                status = m ? Number(m[1]) : null;
                if (status === 404) this._markMissing404(baseUrl);
            } catch { /* ignore */ }

            // Always record for debugging, even if we suppress console warnings.
            try {
                const now = this._nowMs();
                const entry = {
                    t: now,
                    subsystem: 'TextureStreamer',
                    url: baseUrl,
                    status: status,
                    message: String(e?.message || e || 'unknown'),
                };
                this._recentErrors.push(entry);
                if (this._recentErrors.length > this._recentErrorsMax) {
                    this._recentErrors.splice(0, this._recentErrors.length - this._recentErrorsMax);
                }
                try {
                    globalThis.__viewerReportError?.({
                        subsystem: 'texture',
                        level: (status === 404) ? 'warn' : 'error',
                        message: entry.message,
                        url: baseUrl,
                        detail: { status },
                        stack: e?.stack,
                        name: e?.name,
                    });
                } catch { /* ignore */ }
            } catch { /* ignore */ }

            // Log once per URL to make real issues visible while keeping noise low.
            // IMPORTANT: 404s are often expected because we probe alternate candidate URLs
            // (e.g. hash-only vs hash+slug). Avoid confusing "fail" spam when the fallback succeeds.
            try {
                if (!this._warned) this._warned = new Set();
                const shouldWarn = (status !== 404) || !!this.debug?.enabled;
                if (shouldWarn && !this._warned.has(baseUrl)) {
                    this._warned.add(baseUrl);
                    console.warn('TextureStreamer: failed to load texture', baseUrl, e);
                }
            } catch { /* ignore */ }
            try {
                this._lastErrorUrl = baseUrl;
                this._lastErrorMsg = String(e?.message || e || 'unknown');
            } catch { /* ignore */ }
            this.cache.delete(key);
            return null;
        }
    }

    getStats() {
        let loading = 0;
        let loaded = 0;
        for (const v of this.cache.values()) {
            if (v?.loading) loading++;
            if (v?.tex && !v?.loading) loaded++;
        }
        // Count currently-active missing URLs (TTL not expired).
        let missing404 = 0;
        try {
            const now = this._nowMs();
            for (const info of this._missing404.values()) {
                if (info && now < (info.untilMs || 0)) missing404++;
            }
        } catch { /* ignore */ }
        return {
            // `textures` is how many GPU textures are actually resident (loaded).
            // Keep `cacheEntries` as a separate field so we can see if we’re accumulating too many
            // in-flight placeholder entries.
            textures: loaded,
            cacheEntries: this.cache.size,
            loading,
            loadsInFlight: this._loadsInFlight,
            maxLoadsInFlight: this._maxLoadsInFlight,
            maxNewLoadsPerFrame: this._maxNewLoadsPerFrame,
            bytes: this.totalBytes,
            maxTextures: this.maxTextures,
            maxBytes: this.maxBytes,
            evictions: this._evictionCount,
            lastEvictedUrl: this._lastEvictedUrl,
            lastEvictedTier: this._lastEvictedTier,
            lastErrorUrl: this._lastErrorUrl,
            lastErrorMsg: this._lastErrorMsg,
            lastFrameRequests: this._lastFrameRequestCount,
            lastFrameTouches: this._lastFrameTouchedCount,
            qualityCap: this._allowedTierMax(),
            tierConfig: { highDist: this.highDist, mediumDist: this.mediumDist, minResidentMs: this.minResidentMs },
            missing404,
            recentErrors: (() => {
                try { return (this._recentErrors || []).slice(Math.max(0, (this._recentErrors || []).length - 10)); } catch { return []; }
            })(),
        };
    }

    getRecentErrors(n = 25) {
        const nn = Number.isFinite(Number(n)) ? Math.max(0, Math.min(500, Math.floor(Number(n)))) : 25;
        return (this._recentErrors || []).slice(Math.max(0, (this._recentErrors || []).length - nn));
    }

    /**
     * Debug helper: return a summary of URLs in the "missing 404" negative cache.
     * This is useful for sharing a concrete "what textures are missing right now" dump.
     */
    getMissing404Summary(limit = 50) {
        const lim = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(500, Math.floor(Number(limit)))) : 50;
        try {
            const now = this._nowMs();
            /** @type {Array<{ url: string, count: number, ttlMs: number }>} */
            const rows = [];
            for (const [url, info] of (this._missing404 || new Map()).entries()) {
                const untilMs = Number(info?.untilMs || 0);
                const ttlMs = Math.max(0, Math.floor(untilMs - now));
                const count = Number(info?.count || 0) | 0;
                rows.push({ url: String(url || ''), count, ttlMs });
            }
            rows.sort((a, b) => (b.count - a.count) || (a.ttlMs - b.ttlMs) || a.url.localeCompare(b.url));
            return rows.slice(0, lim);
        } catch {
            return [];
        }
    }

    /**
     * Build a JSON-serializable debug dump for missing/loading texture diagnosis.
     * This is intentionally lightweight and stable so we can persist it to disk.
     */
    buildDebugDump({ reason = 'manual', limitMissing = 200, limitErrors = 50 } = {}) {
        const now = (() => {
            try { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); } catch { return Date.now(); }
        })();
        const iso = (() => {
            try { return new Date().toISOString(); } catch { return null; }
        })();
        const stats = (() => {
            try { return this.getStats(); } catch { return null; }
        })();
        const missing = (() => {
            try { return this.getMissing404Summary(limitMissing); } catch { return []; }
        })();
        const errors = (() => {
            try { return this.getRecentErrors(limitErrors); } catch { return []; }
        })();
        return {
            kind: 'textures',
            reason,
            timeIso: iso,
            timeMs: now,
            page: (() => { try { return globalThis.location?.href || null; } catch { return null; } })(),
            userAgent: (() => { try { return globalThis.navigator?.userAgent || null; } catch { return null; } })(),
            stats,
            missing404: missing,
            recentErrors: errors,
        };
    }

    /**
     * Download a debug dump as a JSON file (browser-only).
     */
    downloadDebugDump(dumpObj, { filename = null } = {}) {
        try {
            const obj = dumpObj || this.buildDebugDump({ reason: 'download' });
            const txt = JSON.stringify(obj, null, 2);
            const blob = new Blob([txt], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const ts = (() => {
                try { return new Date().toISOString().replace(/[:.]/g, '-'); } catch { return 'dump'; }
            })();
            a.href = url;
            a.download = filename || `viewer_textures_${ts}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }, 2500);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * POST a debug dump to a local dump server that writes it to disk.
     * Defaults to the companion server started by `webgl_viewer/run.py`.
     */
    async postDebugDump(dumpObj, { endpoint = '/__viewer_dump' } = {}) {
        const obj = dumpObj || this.buildDebugDump({ reason: 'post' });
        const ep = String(endpoint || '').trim();
        if (!ep) throw new Error('postDebugDump: empty endpoint');
        const res = await fetch(ep, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(obj),
        });
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(`postDebugDump: HTTP ${res.status} ${t}`.slice(0, 500));
        }
        return await res.json().catch(() => ({}));
    }
}



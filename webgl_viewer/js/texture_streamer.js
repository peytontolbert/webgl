import { fetchBlob } from './asset_fetcher.js';

export class TextureStreamer {
    constructor(gl, { maxTextures = 256, maxBytes = 256 * 1024 * 1024 } = {}) {
        this.gl = gl;
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

        // Eviction/debug stats.
        this._evictionCount = 0;
        this._lastEvictedUrl = null;
        this._lastEvictedTier = null;
        this._lastErrorUrl = null;
        this._lastErrorMsg = null;

        // Try to avoid evicting textures that were used very recently (reduces visible churn).
        this.minResidentMs = 1250;

        // Distance -> tier thresholds (viewer-space units; tune as needed).
        // dist <= highDist => high, dist <= mediumDist => medium, else low.
        this.highDist = 250;
        this.mediumDist = 900;

        // Debug toggles (can be enabled via DevTools: __viewerApp.textureStreamer.setDebug({ ... }))
        this.debug = {
            enabled: false,
            logEvictions: false,
        };

        // 1x1 placeholder (gray)
        this.placeholder = this._createSolidTexture([160, 160, 160, 255]);

        // Color pipeline: prefer uploading color textures as sRGB so sampling returns linear.
        // (WebGL2 supports SRGB8_ALPHA8; WebGL1 may support EXT_sRGB / WEBGL_sRGB.)
        this._srgbSupport = null; // { ok: boolean, internalFormat: number, format: number } | null
    }

    setQuality(q) {
        const next = (String(q || 'high')).toLowerCase();
        if (next !== 'high' && next !== 'medium' && next !== 'low') return;
        this.quality = next;

        // Adjust cache caps based on quality (rough defaults).
        if (next === 'high') {
            this.maxTextures = 512;
            this.maxBytes = 512 * 1024 * 1024;
        } else if (next === 'medium') {
            this.maxTextures = 384;
            this.maxBytes = 320 * 1024 * 1024;
        } else {
            this.maxTextures = 256;
            this.maxBytes = 192 * 1024 * 1024;
        }

        // When lowering quality, aggressively drop disallowed higher-tier textures first.
        this._evictDisallowedTiers();
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

    beginFrame(frameId = null) {
        if (frameId === null || frameId === undefined) this._frameId++;
        else this._frameId = (frameId | 0);
        this._frameRequests.clear();
        this._lastFrameTouchedCount = 0;
    }

    endFrame() {
        this._lastFrameRequestCount = this._frameRequests.size;
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
        if (k === 'diffuse' || k === 'diffuse2' || k === 'emissive') return 'srgb';
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

        // Choose sRGB internalFormat only for color textures, when supported and format is SRGB.
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

        // Texture params: if KTX2 has mips, use them; else stay non-mipped.
        const hasMips = levels > 1;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, hasMips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

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

        return { tex, bytes: uploadedBytes, width: pixelWidth, height: pixelHeight, levels };
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
        if (this.cache.size <= this.maxTextures && this.totalBytes <= this.maxBytes) return;

        const now = performance.now();
        const all = Array.from(this.cache.entries())
            .filter(([, v]) => v && v.tex && !v.loading);

        // Try to avoid evicting very-recently-used textures to reduce visible "black churn".
        const oldEnough = all.filter(([, v]) => (now - (v.lastUse ?? 0)) >= this.minResidentMs);
        const entries = (oldEnough.length > 0 ? oldEnough : all)
            .sort((a, b) => (a[1].lastUse ?? 0) - (b[1].lastUse ?? 0));

        for (const [url, v] of entries) {
            if (this.cache.size <= this.maxTextures && this.totalBytes <= this.maxBytes) break;
            try {
                this.gl.deleteTexture(v.tex);
            } catch {
                // ignore
            }
            this.totalBytes -= v.bytes || 0;
            this.cache.delete(url);
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
        if (!baseUrl) return this.placeholder;

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
        }
        return this.placeholder;
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
        const e = this.cache.get(k);
        if (e?.tex || e?.loading) {
            this._lastFrameTouchedCount++;
            return;
        }
        this._lastFrameTouchedCount++;
        void this.ensure(baseUrl, { tier: desiredTier, priority: pri, kind });
    }

    async ensure(url, { tier = null, priority = 'low', kind = 'diffuse' } = {}) {
        const baseUrl = String(url || '');
        if (!baseUrl) return this.placeholder;

        const t = this._clampTierToAllowed(tier ?? this.quality);
        const key = this._cacheKey(baseUrl, t, kind);

        const existing = this.cache.get(key);
        if (existing?.tex) {
            existing.lastUse = performance.now();
            return existing.tex;
        }
        if (existing?.loading) return this.placeholder;

        this.cache.set(key, { baseUrl, tier: t, tex: null, bytes: 0, lastUse: performance.now(), loading: true });

        try {
            // LOW priority: textures are important for quality, but should not starve chunk/mesh/meta loads.
            const pr = (priority === 'high') ? 'high' : 'low';
            const blob = await fetchBlob(baseUrl, { priority: pr });

            const gl = this.gl;

            // Quick sanity check: if the server returned HTML (SPA fallback) or some other non-image,
            // createImageBitmap will throw a vague "invalid format" / decode error.
            // Sniff the first few bytes to provide a clearer error message.
            let sniffIsKtx2 = false;
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
                // KTX2 is supported via a separate upload path (when uncompressed RGBA8).
                if (!(isPng || isJpeg || isGif || isBmp || isWebp || isKtx2) || looksLikeHtml) {
                    const hex = Array.from(head).map((b) => b.toString(16).padStart(2, '0')).join(' ');
                    const kind = looksLikeHtml
                        ? 'html'
                        : (isDds ? 'dds' : (isKtx2 ? 'ktx2' : 'unknown'));
                    const hint = (kind === 'html')
                        ? 'Your server is likely returning index.html (SPA fallback) for a missing /assets/... texture URL.'
                        : (kind === 'dds')
                            ? 'This looks like a DDS file. CodeWalker commonly exports DDS; convert to PNG/JPEG/WebP for the browser, or fix your manifest/path so it references an actual PNG.'
                            : (kind === 'ktx2')
                                ? 'This looks like a KTX2 texture container. If it is not uncompressed RGBA8 KTX2, the viewer will need a transcoder to support it.'
                                : 'The bytes are not a known browser image format; the file may be corrupted or mislabeled.';
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
                this.cache.set(key, { baseUrl, tier: t, tex: out.tex, bytes: out.bytes, lastUse: performance.now(), loading: false });
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
                full = await createImageBitmap(blob);

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
                    img = await createImageBitmap(full, {
                        resizeWidth: targetW,
                        resizeHeight: targetH,
                        resizeQuality: (t === 'high') ? 'high' : (t === 'medium' ? 'medium' : 'low'),
                    });
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
            this.cache.set(key, { baseUrl, tier: t, tex, bytes, lastUse: performance.now(), loading: false });
            this._evictIfNeeded();
            return tex;
        } catch (e) {
            // Log once per URL to make missing/cors/NPOT issues visible while keeping noise low.
            try {
                if (!this._warned) this._warned = new Set();
                if (!this._warned.has(baseUrl)) {
                    this._warned.add(baseUrl);
                    console.warn('TextureStreamer: failed to load texture', baseUrl, e);
                }
            } catch { /* ignore */ }
            try {
                this._lastErrorUrl = baseUrl;
                this._lastErrorMsg = String(e?.message || e || 'unknown');
            } catch { /* ignore */ }
            this.cache.delete(key);
            return this.placeholder;
        }
    }

    getStats() {
        let loading = 0;
        for (const v of this.cache.values()) {
            if (v?.loading) loading++;
        }
        return {
            textures: this.cache.size,
            loading,
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
        };
    }
}



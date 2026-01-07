import { glMatrix } from './glmatrix.js';
import { extractFrustumPlanes, aabbIntersectsFrustum } from './frustum_culling.js';
import { fetchArrayBufferWithPriority, fetchJSON, fetchNDJSON } from './asset_fetcher.js';
import { joaat } from './joaat.js';

export class EntityStreamer {
    constructor({ modelMatrix }) {
        this.modelMatrix = modelMatrix;
        this.invModelMatrix = glMatrix.mat4.create();
        glMatrix.mat4.invert(this.invModelMatrix, this.modelMatrix);

        this.index = null;
        this.ready = false;

        /** @type {Set<string>} */
        this.loading = new Set();
        /** @type {Set<string>} */
        this.loaded = new Set();

        this.maxLoadedChunks = 25; // 5x5 around camera
        this.radiusChunks = 2;
        this.enableFrustumCulling = true;

        // Avoid spamming hundreds of requests in a single frame; stream progressively.
        this.maxNewLoadsPerUpdate = 8;

        // Optional fast-path: binary ENT0 tiles in assets/entities_chunks_bin/*.bin.
        // If you haven't generated/copied those bins, leave this off to avoid any 404s.
        // (JSONL fallback is fast enough for most use, and avoids network noise.)
        this.preferBinary = false;

        // Whether to use CacheStorage for streamed chunk files (JSONL / optional bins).
        // Default false because chunks can be very large; controlled by the UI.
        this.usePersistentCacheForChunks = false;

        // Stale-request cancellation/dropping for chunk loads.
        /** @type {Map<string, { controller: AbortController, token: number }>} */
        this._chunkLoadReqs = new Map();
        this._chunkLoadNextToken = 1;

        // Time/weather ymap gating (optional; driven by assets/ymap_gates.json).
        this.enableTimeWeatherYmapGating = true;
        /** @type {null | { byYmapHash?: Record<string, { hoursOnOff?: number, weatherTypes?: Array<string|number> }> }} */
        this._ymapGates = null;
        this._ymapGateHour = 13;
        this._ymapGateWeatherHash = 0;

        // Lightweight diagnostics (surfaced in perf HUD / console).
        this.stats = {
            started: 0,
            loaded: 0,
            aborted: 0,
            failed: 0,
            lastError: '',
        };
    }

    setTimeWeather({ hour = null, weather = null } = {}) {
        const h0 = Number(hour);
        const nextHour = Number.isFinite(h0) ? Math.max(0, Math.min(23, Math.floor(h0 % 24))) : this._ymapGateHour;

        let nextWeather = this._ymapGateWeatherHash;
        if (weather !== null && weather !== undefined) {
            if (typeof weather === 'number') nextWeather = Number.isFinite(weather) ? (weather >>> 0) : 0;
            else {
                const s = String(weather || '').trim();
                nextWeather = s ? (joaat(s.toLowerCase()) >>> 0) : 0;
            }
        }

        const changed = (nextHour !== this._ymapGateHour) || (nextWeather !== this._ymapGateWeatherHash);
        this._ymapGateHour = nextHour;
        this._ymapGateWeatherHash = nextWeather;
        // Entity dots can be rebuilt by reloading chunks; we fail-open if gates not present.
        // To keep this lightweight, we do not force reload on every change here.
        return changed;
    }

    _ymapHashFromPath(p) {
        const s0 = String(p || '').trim();
        if (!s0) return 0;
        const s = s0.replace(/\\/g, '/');
        const parts = s.split('/');
        const last = parts.length ? parts[parts.length - 1] : s;
        const base = last.replace(/\.ymap$/i, '').trim().toLowerCase();
        if (!base) return 0;
        try { return (joaat(base) >>> 0); } catch { return 0; }
    }

    _isYmapAvailableHash(ymapHashU32) {
        if (!this.enableTimeWeatherYmapGating) return true;
        if (!this._ymapGates || typeof this._ymapGates !== 'object') return true;
        const by = this._ymapGates.byYmapHash;
        if (!by || typeof by !== 'object') return true;
        const h = (Number(ymapHashU32) >>> 0);
        if (!h) return true; // unknown => fail open
        const gate = by[String(h)];
        if (!gate || typeof gate !== 'object') return true;

        const mask = Number(gate.hoursOnOff ?? gate.hours_onoff ?? 0);
        const hour = (Number(this._ymapGateHour) | 0);
        if (Number.isFinite(mask) && mask !== 0 && hour >= 0 && hour <= 23) {
            const bit = (1 << hour) >>> 0;
            if (((mask >>> 0) & bit) === 0) return false;
        }

        const w = (Number(this._ymapGateWeatherHash) >>> 0);
        const weathers = gate.weatherTypes ?? gate.weather_types ?? null;
        if (w !== 0 && Array.isArray(weathers) && weathers.length > 0) {
            for (const vv of weathers) {
                const n = Number(vv);
                if (Number.isFinite(n) && (n >>> 0) === w) return true;
            }
            return false;
        }

        return true;
    }

    _isYmapAvailableObj(obj) {
        if (!this.enableTimeWeatherYmapGating || !this._ymapGates) return true;
        const ymapHash =
            (Number(obj?.ymap_hash ?? obj?.ymapHash ?? obj?.ymap_hash32 ?? 0) >>> 0) ||
            this._ymapHashFromPath(obj?.ymap);
        return this._isYmapAvailableHash(ymapHash);
    }

    async init() {
        try {
            this.index = await fetchJSON('assets/entities_index.json');
        } catch {
            console.warn('No entities_index.json found; entity streaming disabled.');
            return;
        }
        try {
            const gates = await fetchJSON('assets/ymap_gates.json', { priority: 'low', usePersistentCache: true });
            if (gates && typeof gates === 'object') {
                this._ymapGates = gates;
                const by = gates.byYmapHash;
                const hasAny = !!(by && typeof by === 'object' && Object.keys(by).length > 0);
                if (hasAny && this.enableTimeWeatherYmapGating) this.preferBinary = false; // ENT0 has no ymap identity
            }
        } catch {
            this._ymapGates = null;
        }
        this.ready = true;
    }

    _cancelChunkLoad(key, reason = 'cancelled') {
        const k = String(key || '');
        if (!k) return;
        const req = this._chunkLoadReqs.get(k);
        if (!req) return;
        try { req.controller.abort(); } catch { /* ignore */ }
        this._chunkLoadReqs.delete(k);
        try { this.loading.delete(k); } catch { /* ignore */ }
        try { this.stats.aborted++; } catch { /* ignore */ }
    }

    _cameraToDataSpace(cameraPosVec3) {
        // Convert camera position from viewer space back into data (GTA) space using inverse model matrix.
        const v = glMatrix.vec4.fromValues(cameraPosVec3[0], cameraPosVec3[1], cameraPosVec3[2], 1.0);
        const out = glMatrix.vec4.create();
        glMatrix.vec4.transformMat4(out, v, this.invModelMatrix);
        return out; // vec4
    }

    _cameraDirToDataSpace(cameraDirVec3) {
        // Transform a direction vector (w=0) from viewer-space into data-space.
        const v = glMatrix.vec4.fromValues(cameraDirVec3[0], cameraDirVec3[1], cameraDirVec3[2], 0.0);
        const out = glMatrix.vec4.create();
        glMatrix.vec4.transformMat4(out, v, this.invModelMatrix);
        return out;
    }

    _chunkAABBDataSpace(key) {
        const chunkSize = this.index?.chunk_size ?? 512.0;
        const b = this.index?.bounds ?? { min_z: -10000, max_z: 10000 };
        const [sx, sy] = key.split('_').map(v => parseInt(v, 10));
        if (!Number.isFinite(sx) || !Number.isFinite(sy)) return null;
        const minx = sx * chunkSize;
        const miny = sy * chunkSize;
        return {
            min: [minx, miny, b.min_z ?? -10000],
            max: [minx + chunkSize, miny + chunkSize, b.max_z ?? 10000],
        };
    }

    _chunkCenterDataSpace(key) {
        const chunkSize = this.index?.chunk_size ?? 512.0;
        const [sx, sy] = key.split('_').map(v => parseInt(v, 10));
        if (!Number.isFinite(sx) || !Number.isFinite(sy)) return null;
        return [(sx + 0.5) * chunkSize, (sy + 0.5) * chunkSize, 0.0];
    }

    _sortWantedKeys(keys, camera, centerDataPos = null, { inFrustumSet = null } = {}) {
        if (!keys || keys.length <= 1 || !this.index) return keys || [];

        const p = centerDataPos
            ? glMatrix.vec4.fromValues(centerDataPos[0], centerDataPos[1], centerDataPos[2], 1.0)
            : this._cameraToDataSpace(camera.position);

        // Small forward-bias so chunks in front of the camera tend to appear first.
        const fwd = this._cameraDirToDataSpace(camera.direction || [0, 0, -1]);
        const fwdLen = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1.0;
        const fx = fwd[0] / fwdLen, fy = fwd[1] / fwdLen, fz = fwd[2] / fwdLen;

        const scored = keys.map((k) => {
            const c = this._chunkCenterDataSpace(k);
            if (!c) return { k, score: 1e30 };
            const dx = c[0] - p[0];
            const dy = c[1] - p[1];
            const dz = c[2] - p[2];
            const dist2 = dx * dx + dy * dy + dz * dz;
            const dot = (dx * fx + dy * fy + dz * fz);
            // Penalize chunks behind the camera a bit so "look around" feels responsive.
            const behindPenalty = (dot >= 0) ? 1.0 : 1.6;
            let score = dist2 * behindPenalty;
            // Game-like preload: if frustum culling is enabled, treat it as a PRIORITY hint,
            // not an exclusion rule. Chunks outside the current frustum still load, just later.
            if (this.enableFrustumCulling && inFrustumSet && !inFrustumSet.has(k)) {
                score *= 1.9;
            }
            return { k, score };
        });

        scored.sort((a, b) => a.score - b.score);
        return scored.map(s => s.k);
    }

    _wantedKeysForCamera(camera, centerDataPos = null) {
        if (!this.index) return [];
        const chunkSize = this.index.chunk_size;
        const p = centerDataPos ? glMatrix.vec4.fromValues(centerDataPos[0], centerDataPos[1], centerDataPos[2], 1.0) : this._cameraToDataSpace(camera.position);
        const cx = Math.floor(p[0] / chunkSize);
        const cy = Math.floor(p[1] / chunkSize);

        const keys = [];
        const inFrustumSet = new Set();
        // IMPORTANT: chunk AABBs are in *data space*, so we must extract frustum planes in data space too.
        // Clip = cameraVP * (modelMatrix * dataPos) => use (cameraVP * modelMatrix) to get planes that match data-space AABBs.
        const planes = this.enableFrustumCulling
            ? (() => {
                const vpData = glMatrix.mat4.create();
                glMatrix.mat4.multiply(vpData, camera.viewProjectionMatrix, this.modelMatrix);
                return extractFrustumPlanes(vpData);
            })()
            : null;
        for (let dy = -this.radiusChunks; dy <= this.radiusChunks; dy++) {
            for (let dx = -this.radiusChunks; dx <= this.radiusChunks; dx++) {
                const k = `${cx + dx}_${cy + dy}`;
                if (planes) {
                    const aabb = this._chunkAABBDataSpace(k);
                    // Missing AABB => treat as visible so we don't accidentally starve it.
                    const inFrustum = !aabb || aabbIntersectsFrustum(planes, aabb.min, aabb.max);
                    if (inFrustum) inFrustumSet.add(k);
                } else {
                    inFrustumSet.add(k);
                }
                keys.push(k);
            }
        }
        return this._sortWantedKeys(keys, camera, centerDataPos, { inFrustumSet });
    }

    /**
     * Public helper for boot-time preload logic.
     * @returns {string[]}
     */
    getWantedKeys(camera, centerDataPos = null) {
        return this._wantedKeysForCamera(camera, centerDataPos);
    }

    async _loadChunk(key, entityRenderer, { priority = 'high' } = {}) {
        if (!this.index) return;
        const meta = (this.index.chunks || {})[key];
        if (!meta) return; // chunk doesn't exist

        if (this.loaded.has(key) || this.loading.has(key)) return;
        this.loading.add(key);
        const controller = new AbortController();
        const token = (this._chunkLoadNextToken++ >>> 0);
        this._chunkLoadReqs.set(key, { controller, token });
        const signal = controller.signal;
        try { this.stats.started++; } catch { /* ignore */ }

        try {
            const jsonlPath = `assets/${this.index.chunks_dir}/${meta.file}`;

            // Prefer binary positions chunk if present:
            // assets/entities_chunks_bin/<chunk>.bin with ENT0 header.
            let positions = null;
            if (this.preferBinary) {
                try {
                    const binFile = String(meta.file || '').replace(/\.jsonl$/i, '.bin');
                    const binPath = `assets/entities_chunks_bin/${binFile}`;
                    const buf = await fetchArrayBufferWithPriority(binPath, { priority, usePersistentCache: this.usePersistentCacheForChunks, signal });
                    const dv = new DataView(buf);
                    if (dv.byteLength >= 8) {
                        const magic =
                            String.fromCharCode(dv.getUint8(0)) +
                            String.fromCharCode(dv.getUint8(1)) +
                            String.fromCharCode(dv.getUint8(2)) +
                            String.fromCharCode(dv.getUint8(3));
                        if (magic === 'ENT0') {
                            const count = dv.getUint32(4, true);
                            const needBytes = 8 + count * 3 * 4;
                            if (count > 0 && needBytes <= dv.byteLength) {
                                positions = new Float32Array(buf, 8, count * 3);
                            } else if (count === 0) {
                                positions = new Float32Array(0);
                            }
                        }
                    }
                    // If header wasn't recognized, fall through to JSONL.
                } catch (e) {
                    // If the directory isn't present, disable the binary fast-path to avoid spamming 404s.
                    const msg = String(e?.message || e || '');
                    if (msg.includes('status=404')) this.preferBinary = false;
                    // Fall back to JSONL streaming.
                }
            }

            if (!positions) {
                // Stream-parse jsonl -> Float32Array positions (avoids allocating whole text + split()).
                let cap = 3 * 16384;
                let out = new Float32Array(cap);
                let n = 0;
                const push3 = (x, y, z) => {
                    if (n + 3 > cap) {
                        cap = Math.max(cap * 2, n + 3);
                        const next = new Float32Array(cap);
                        next.set(out);
                        out = next;
                    }
                    out[n++] = x;
                    out[n++] = y;
                    out[n++] = z;
                };

                await fetchNDJSON(jsonlPath, {
                    usePersistentCache: this.usePersistentCacheForChunks,
                    priority,
                    signal,
                    onObject: (obj) => {
                        if (!this._isYmapAvailableObj(obj)) return;
                        const pos = obj?.position;
                        if (!pos || pos.length < 3) return;
                        const x = Number(pos[0]);
                        const y = Number(pos[1]);
                        const z = Number(pos[2]);
                        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
                        push3(x, y, z);
                    },
                });
                positions = out.subarray(0, n);
            }

            // Drop stale/aborted loads before mutating any renderer state.
            const live = this._chunkLoadReqs.get(key);
            if (!live || live.token !== token || signal.aborted) return;

            if (positions && positions.length > 0) {
                entityRenderer.setChunk(key, positions);
            }

            this.loaded.add(key);
            try { this.stats.loaded++; } catch { /* ignore */ }
        } catch (e) {
            const isAbort = (String(e?.name || '') === 'AbortError');
            if (!isAbort) {
                try { this.stats.failed++; } catch { /* ignore */ }
                try { this.stats.lastError = String(e?.message || e || ''); } catch { /* ignore */ }
                console.warn(`Chunk load failed ${key}:`, e);
            }
        } finally {
            this.loading.delete(key);
            const live = this._chunkLoadReqs.get(key);
            if (live && live.token === token) this._chunkLoadReqs.delete(key);
        }
    }

    _trim(entityRenderer, wantedSet) {
        // Unload chunks that are far away, keeping memory bounded.
        for (const key of Array.from(this.loaded)) {
            if (!wantedSet.has(key)) {
                entityRenderer.deleteChunk(key);
                this.loaded.delete(key);
            }
        }
        // Cancel any in-flight loads that are no longer wanted.
        for (const k of Array.from(this.loading)) {
            if (!wantedSet.has(k)) this._cancelChunkLoad(k, 'stale_inflight_not_wanted');
        }

        // Hard cap, if needed
        if (this.loaded.size <= this.maxLoadedChunks) return;
        const extra = this.loaded.size - this.maxLoadedChunks;

        // Drop the farthest chunks first (stable streaming when rotating/moving camera).
        const wantedArr = Array.from(wantedSet);
        const centerKey = wantedArr.length > 0 ? wantedArr[0] : null;
        const centerCoord = centerKey ? centerKey.split('_').map(v => parseInt(v, 10)) : null;
        const cx = (centerCoord && Number.isFinite(centerCoord[0])) ? centerCoord[0] : null;
        const cy = (centerCoord && Number.isFinite(centerCoord[1])) ? centerCoord[1] : null;

        const loadedSorted = Array.from(this.loaded).map((k) => {
            if (cx === null || cy === null) return { k, d2: 1e30 };
            const [sx, sy] = k.split('_').map(v => parseInt(v, 10));
            const dx = (Number.isFinite(sx) ? (sx - cx) : 1e9);
            const dy = (Number.isFinite(sy) ? (sy - cy) : 1e9);
            return { k, d2: dx * dx + dy * dy };
        });
        loadedSorted.sort((a, b) => b.d2 - a.d2);
        const toDrop = loadedSorted.slice(0, extra).map(e => e.k);

        for (const key of toDrop) {
            entityRenderer.deleteChunk(key);
            this.loaded.delete(key);
        }
    }

    update(camera, entityRenderer, centerDataPos = null) {
        if (!this.ready) return;

        const wanted = this._wantedKeysForCamera(camera, centerDataPos);
        const wantedSet = new Set(wanted);

        // Trim first to keep memory stable
        this._trim(entityRenderer, wantedSet);

        // Kick off loads (fire-and-forget)
        const budget = Math.max(1, Math.floor(this.maxNewLoadsPerUpdate));
        let started = 0;
        for (let i = 0; i < wanted.length; i++) {
            if (started >= budget) break;
            const key = wanted[i];
            if (this.loaded.has(key) || this.loading.has(key)) continue;

            // Closest chunks should always be high priority; the rest can be low priority background work.
            const priority = (i < Math.max(9, this.radiusChunks * 2 + 1)) ? 'high' : 'low';
            started++;
            void this._loadChunk(key, entityRenderer, { priority });
        }
    }
}



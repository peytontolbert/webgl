import { glMatrix } from './glmatrix.js';
import { extractFrustumPlanes, aabbIntersectsFrustum } from './frustum_culling.js';
import { fetchArrayBufferWithPriority, fetchJSON, fetchNDJSON, fetchStreamBytes, fetchText } from './asset_fetcher.js';

/**
 * Streams entity chunks and converts entity transforms into per-archetype instance matrices,
 * but only for archetypes that have exported mesh bins in assets/models/manifest.json.
 */
export class DrawableStreamer {
    constructor({ modelMatrix, modelManager, modelRenderer }) {
        this.modelMatrix = modelMatrix;
        this.invModelMatrix = glMatrix.mat4.create();
        glMatrix.mat4.invert(this.invModelMatrix, this.modelMatrix);

        this.modelManager = modelManager;
        this.modelRenderer = modelRenderer;

        this.index = null;
        this.ready = false;

        this.loading = new Set();
        this.loaded = new Set();
        this.chunkInstances = new Map(); // chunkKey -> Map<hash, Float32Array mats>
        this.chunkMinDist = new Map(); // chunkKey -> Map<hash, minDist>
        this.chunkArchetypeCounts = new Map(); // chunkKey -> Map<hash, count> (all archetypes seen, including missing)
        // NOTE: we do NOT store "missing" counts per chunk anymore, because with a sharded manifest
        // a mesh can look "missing" simply because its shard hasn't been loaded yet.

        // Debug: last chunk load stats (helps diagnose "only dots")
        this.lastLoadStats = null; // { key, totalLines, parsed, withArchetype, matchedMesh, instancedArchetypes }
        this.coverageStats = null; // aggregated over loaded chunks (rebuilt when dirty)

        this.maxLoadedChunks = 25;
        this.radiusChunks = 2;
        this.enableFrustumCulling = true;
        // Avoid scheduling huge bursts of chunk work in a single frame.
        this.maxNewLoadsPerUpdate = 6;

        // Optional fast-path: binary ENT1 tiles in assets/entities_chunks_inst/*.bin.
        // If they aren't present, browsers will log noisy 404s. Auto-disable after first 404.
        this.preferBinary = true;
        this._instProbeDone = false;

        // Whether to use CacheStorage for streamed chunk files (JSONL / ENT1 bins).
        // Default false because chunks can be very large; controlled by the UI.
        this.usePersistentCacheForChunks = false;
        this.maxArchetypes = 250; // cap instanced archetypes to avoid loading thousands at once
        // Distance-based selection: only instance archetypes whose nearest instance is within this distance.
        // Set to Infinity to disable distance cutoff.
        this.maxModelDistance = 350.0;
        this._dirty = true; // rebuild instances only when chunk set changes (not every frame)

        // Cross-archetype instancing: group by (lod + meshFile + materialSignature) instead of per-archetype.
        // This can reduce draw calls when many different hashes share the same exported mesh bins/materials.
        this.enableCrossArchetypeInstancing = true;

        /**
         * Force a specific LOD for all streamed drawables.
         * null => automatic distance-based choice.
         * @type {null | 'high' | 'med' | 'low' | 'vlow'}
         */
        this.forcedLod = null;

        // Track previous desired (hash:lod) keys so we can delete stale instances on rebuild.
        this._prevDesiredInstanceKeys = new Set();

        // Off-main-thread chunk parsing/matrix building.
        this._chunkWorker = null;
        this._chunkWorkerDisabled = false;
        this._chunkWorkerNextReqId = 1;
        /** @type {Map<number, { resolve: Function, reject: Function }>} */
        this._chunkWorkerPending = new Map();
    }

    _getChunkWorker() {
        if (this._chunkWorkerDisabled) return null;
        if (this._chunkWorker) return this._chunkWorker;
        const canWorker = (typeof Worker !== 'undefined') && (typeof URL !== 'undefined');
        if (!canWorker) {
            this._chunkWorkerDisabled = true;
            return null;
        }
        try {
            const w = new Worker(new URL('./chunk_worker.js', import.meta.url), { type: 'module' });
            w.onmessage = (e) => {
                const m = e?.data || {};
                const t = String(m.type || '');
                if (t === 'progress') {
                    const arr = Array.isArray(m.newHashes) ? m.newHashes : [];
                    for (const h of arr) {
                        try { this.modelManager?.prefetchMeta?.(h); } catch { /* ignore */ }
                    }
                    return;
                }
                if (t === 'result') {
                    const reqId = Number(m.reqId);
                    const pending = this._chunkWorkerPending.get(reqId);
                    if (!pending) return;
                    this._chunkWorkerPending.delete(reqId);
                    if (m.ok) pending.resolve(m);
                    else pending.reject(new Error(m.error || 'chunk worker failed'));
                }
            };
            w.onerror = (err) => {
                // Disable worker and fall back to main-thread parsing for future chunks.
                this._chunkWorkerDisabled = true;
                try { w.terminate(); } catch { /* ignore */ }
                this._chunkWorker = null;
                for (const [reqId, pending] of this._chunkWorkerPending.entries()) {
                    this._chunkWorkerPending.delete(reqId);
                    try { pending.reject(err?.error || err || new Error('chunk worker crashed')); } catch { /* ignore */ }
                }
            };
            this._chunkWorker = w;
            return w;
        } catch {
            this._chunkWorkerDisabled = true;
            this._chunkWorker = null;
            return null;
        }
    }

    async _parseChunkNDJSONInWorker(url, camData, priority) {
        const w = this._getChunkWorker();
        if (!w) return null;
        const reqId = (this._chunkWorkerNextReqId++ >>> 0);
        const p = new Promise((resolve, reject) => {
            this._chunkWorkerPending.set(reqId, { resolve, reject });
        });

        try {
            w.postMessage({ type: 'begin_ndjson', reqId, camData });
            await fetchStreamBytes(url, {
                usePersistentCache: this.usePersistentCacheForChunks,
                priority,
                onChunk: (u8) => {
                    try {
                        // Transfer buffer to avoid copying.
                        w.postMessage(
                            { type: 'chunk', reqId, buffer: u8.buffer, offset: u8.byteOffset, length: u8.byteLength },
                            [u8.buffer]
                        );
                    } catch {
                        // ignore
                    }
                },
            });
            w.postMessage({ type: 'end', reqId });
            return await p;
        } catch (e) {
            try { w.postMessage({ type: 'cancel', reqId }); } catch { /* ignore */ }
            this._chunkWorkerPending.delete(reqId);
            throw e;
        }
    }

    async _parseENT1InWorker(buffer, camData) {
        const w = this._getChunkWorker();
        if (!w) return null;
        const reqId = (this._chunkWorkerNextReqId++ >>> 0);
        const p = new Promise((resolve, reject) => {
            this._chunkWorkerPending.set(reqId, { resolve, reject });
        });
        try {
            w.postMessage({ type: 'parse_ent1', reqId, camData, buffer }, [buffer]);
            return await p;
        } catch (e) {
            try { w.postMessage({ type: 'cancel', reqId }); } catch { /* ignore */ }
            this._chunkWorkerPending.delete(reqId);
            throw e;
        }
    }

    /**
     * Explicit teardown hook (call when the app is shutting down).
     * - Terminates the chunk worker (if any)
     * - Rejects any pending worker requests
     */
    destroy() {
        // Reject any in-flight worker requests to avoid dangling Promises.
        for (const [reqId, pending] of this._chunkWorkerPending.entries()) {
            this._chunkWorkerPending.delete(reqId);
            try { pending.reject(new Error('DrawableStreamer destroyed')); } catch { /* ignore */ }
        }
        if (this._chunkWorker) {
            try { this._chunkWorker.terminate(); } catch { /* ignore */ }
        }
        this._chunkWorker = null;
        this._chunkWorkerDisabled = true;
    }

    async init() {
        try {
            this.index = await fetchJSON('assets/entities_index.json');
        } catch {
            console.warn('No entities_index.json found; drawable streaming disabled.');
            return;
        }

        // Probe once to see if the ENT1 binary directory exists, so we don't spam 404s.
        try {
            const resp = await fetch('assets/entities_chunks_inst/', { cache: 'no-store' });
            if (!resp.ok) this.preferBinary = false;
        } catch {
            this.preferBinary = false;
        } finally {
            this._instProbeDone = true;
        }

        this.ready = true;
    }

    _cameraToDataSpace(cameraPosVec3) {
        const v = glMatrix.vec4.fromValues(cameraPosVec3[0], cameraPosVec3[1], cameraPosVec3[2], 1.0);
        const out = glMatrix.vec4.create();
        glMatrix.vec4.transformMat4(out, v, this.invModelMatrix);
        return out;
    }

    _cameraDirToDataSpace(cameraDirVec3) {
        const v = glMatrix.vec4.fromValues(cameraDirVec3[0], cameraDirVec3[1], cameraDirVec3[2], 0.0);
        const out = glMatrix.vec4.create();
        glMatrix.vec4.transformMat4(out, v, this.invModelMatrix);
        return out;
    }

    _chunkAABBDataSpace(key) {
        // Approximate chunk AABB from grid coordinates and chunk_size; z uses global bounds.
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

    _wantedKeysForCamera(camera, centerDataPos = null) {
        if (!this.index) return [];
        const chunkSize = this.index.chunk_size;
        const p = centerDataPos ? glMatrix.vec4.fromValues(centerDataPos[0], centerDataPos[1], centerDataPos[2], 1.0) : this._cameraToDataSpace(camera.position);
        const cx = Math.floor(p[0] / chunkSize);
        const cy = Math.floor(p[1] / chunkSize);

        const keys = [];
        const inFrustumSet = new Set();
        // IMPORTANT: chunk AABBs are in *data space*, so extract frustum planes in data space too.
        // Clip = cameraVP * (modelMatrix * dataPos) => use (cameraVP * modelMatrix).
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

        // Sort near-first with a slight "in front of camera" bias for faster look-around.
        if (keys.length <= 1) return keys;
        const fwd = this._cameraDirToDataSpace(camera.direction || [0, 0, -1]);
        const fwdLen = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1.0;
        const fx = fwd[0] / fwdLen, fy = fwd[1] / fwdLen, fz = fwd[2] / fwdLen;

        const scored = keys.map((k) => {
            const [sx, sy] = k.split('_').map(v => parseInt(v, 10));
            if (!Number.isFinite(sx) || !Number.isFinite(sy)) return { k, score: 1e30 };
            const ccx = (sx + 0.5) * chunkSize;
            const ccy = (sy + 0.5) * chunkSize;
            const dx = ccx - p[0];
            const dy = ccy - p[1];
            const dz = 0.0 - p[2];
            const dist2 = dx * dx + dy * dy + dz * dz;
            const dot = dx * fx + dy * fy + dz * fz;
            const behindPenalty = (dot >= 0) ? 1.0 : 1.6;
            let score = dist2 * behindPenalty;
            // Game-like preload: frustum culling acts as PRIORITY, not inclusion.
            if (this.enableFrustumCulling && inFrustumSet && !inFrustumSet.has(k)) {
                score *= 1.9;
            }
            return { k, score };
        });
        scored.sort((a, b) => a.score - b.score);
        return scored.map(s => s.k);
    }

    /**
     * Public helper for boot-time preload logic.
     * @returns {string[]}
     */
    getWantedKeys(camera, centerDataPos = null) {
        return this._wantedKeysForCamera(camera, centerDataPos);
    }

    _entityToMat4(obj) {
        const pos = obj.position || [0, 0, 0];
        const scale = obj.scale || [1, 1, 1];
        const q = obj.rotation_quat; // [x,y,z,w] or null

        const m = glMatrix.mat4.create();
        glMatrix.mat4.fromTranslation(m, pos);

        if (q && q.length >= 4) {
            // Ensure quaternion is normalized; some exporters/data can be slightly non-unit and cause shear.
            const qq = glMatrix.quat.create();
            glMatrix.quat.set(qq, q[0], q[1], q[2], q[3]);
            glMatrix.quat.normalize(qq, qq);
            const rm = glMatrix.mat4.create();
            glMatrix.mat4.fromQuat(rm, qq);
            glMatrix.mat4.multiply(m, m, rm);
        }

        const sm = glMatrix.mat4.create();
        glMatrix.mat4.fromScaling(sm, scale);
        glMatrix.mat4.multiply(m, m, sm);
        return m;
    }

    _instanceStrideFloatsForLen(len) {
        const n = Number(len ?? 0);
        if (!Number.isFinite(n) || n <= 0) return 16;
        // New layout: 16 (mat4) + 1 (tintIndex)
        if ((n % 17) === 0) return 17;
        return 16;
    }

    _safeTintIndex(v) {
        const n0 = Number(v);
        if (!Number.isFinite(n0)) return 0;
        const n = Math.floor(n0);
        return Math.max(0, Math.min(255, n));
    }

    async _loadChunk(key, { priority = 'high' } = {}) {
        if (!this.index) return;
        const meta = (this.index.chunks || {})[key];
        if (!meta) return;

        if (this.loaded.has(key) || this.loading.has(key)) return;
        this.loading.add(key);

        try {
            const jsonlPath = `assets/${this.index.chunks_dir}/${meta.file}`;

            const byHash = new Map(); // hash -> number[] mats
            const minDistByHash = new Map(); // hash -> number
            let archetypeCounts = new Map(); // hash -> count
            const camData = this._cameraToDataSpace(window.__appCameraPosForDrawableStreamer || [0, 0, 0]);
            let workerResult = null;

            // Try binary instance tile first: assets/entities_chunks_inst/<chunk>.bin
            // Format (ENT1):
            // - 4 bytes: 'ENT1'
            // - u32: count
            // - count records: <I3f4f3f> = archetypeHash, pos(xyz), quat(xyzw), scale(xyz)
            // Optional v2: <I3f4f3fI> adds u32 tintIndex after scale (stride=48).
            let usedBinary = false;
            if (this.preferBinary) {
                try {
                    const binFile = String(meta.file || '').replace(/\.jsonl$/i, '.bin');
                    const binPath = `assets/entities_chunks_inst/${binFile}`;
                    const buf = await fetchArrayBufferWithPriority(binPath, { priority, usePersistentCache: this.usePersistentCacheForChunks });
                    const dv = new DataView(buf);
                    if (dv.byteLength >= 8) {
                        const magic =
                            String.fromCharCode(dv.getUint8(0)) +
                            String.fromCharCode(dv.getUint8(1)) +
                            String.fromCharCode(dv.getUint8(2)) +
                            String.fromCharCode(dv.getUint8(3));
                        if (magic === 'ENT1') {
                            const count = dv.getUint32(4, true);
                            // v1 stride=44, v2 stride=48 (tintIndex).
                            const stride = (dv.byteLength >= (8 + count * 48)) ? 48 : 44;
                            const start = 8;
                            const need = start + count * stride;
                            if (count >= 0 && need <= dv.byteLength) {
                                usedBinary = true;

                                // Prefer worker path: parse + build matrices off-thread.
                                try {
                                    const wr = await this._parseENT1InWorker(buf.slice(0), [camData[0], camData[1], camData[2]]);
                                    if (wr && wr.ok) workerResult = wr;
                                } catch {
                                    workerResult = null;
                                }

                                if (!workerResult) {
                                    // Temp objects for matrix build (avoids per-entity allocations).
                                    const q = glMatrix.quat.create();
                                    const p = glMatrix.vec3.create();
                                    const s = glMatrix.vec3.create();
                                    const m = glMatrix.mat4.create();

                                    for (let i = 0; i < count; i++) {
                                        const off = start + i * stride;
                                        const h = dv.getUint32(off + 0, true) >>> 0;
                                        const hash = String(h);

                                        // Kick off shard load early so real meshes can appear ASAP.
                                        this.modelManager?.prefetchMeta?.(hash);

                                        const px = dv.getFloat32(off + 4, true);
                                        const py = dv.getFloat32(off + 8, true);
                                        const pz = dv.getFloat32(off + 12, true);

                                        const qx = dv.getFloat32(off + 16, true);
                                        const qy = dv.getFloat32(off + 20, true);
                                        const qz = dv.getFloat32(off + 24, true);
                                        const qw = dv.getFloat32(off + 28, true);

                                        const sx = dv.getFloat32(off + 32, true);
                                        const sy = dv.getFloat32(off + 36, true);
                                        const sz = dv.getFloat32(off + 40, true);
                                        const tintIndex = (stride >= 48) ? (dv.getUint32(off + 44, true) >>> 0) : 0;

                                        archetypeCounts.set(hash, (archetypeCounts.get(hash) ?? 0) + 1);

                                        // Distance (data-space) for prioritization / cutoff.
                                        const dx = px - camData[0];
                                        const dy = py - camData[1];
                                        const dz = pz - camData[2];
                                        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                                        const prev = minDistByHash.get(hash);
                                        if (prev === undefined || d < prev) minDistByHash.set(hash, d);

                                        // Build instance matrix.
                                        glMatrix.vec3.set(p, px, py, pz);
                                        glMatrix.quat.set(q, qx, qy, qz, qw);
                                        glMatrix.quat.normalize(q, q);
                                        glMatrix.vec3.set(s, sx, sy, sz);
                                        glMatrix.mat4.fromRotationTranslationScale(m, q, p, s);

                                        let arr = byHash.get(hash);
                                        if (!arr) {
                                            arr = [];
                                            byHash.set(hash, arr);
                                        }
                                        for (let k = 0; k < 16; k++) arr.push(m[k]);
                                        arr.push(this._safeTintIndex(tintIndex));
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    // If the directory isn't present, disable the binary fast-path to avoid spamming 404s.
                    const msg = String(e?.message || e || '');
                    if (msg.includes('status=404')) this.preferBinary = false;
                    // Fall back to JSONL.
                }
            }

            let totalLines = 0;
            let parsed = 0;
            let withArchetype = 0;
            let matchedMesh = 0;
            let badArchetype = 0;
            let missingMeshEntities = 0;
            let unknownMetaEntities = 0;

            if (!usedBinary) {
                // Prefer worker path: stream bytes -> worker parses JSONL and builds matrices off-thread.
                try {
                    const wr = await this._parseChunkNDJSONInWorker(jsonlPath, [camData[0], camData[1], camData[2]], priority);
                    if (wr && wr.ok) workerResult = wr;
                } catch {
                    workerResult = null;
                }

                if (!workerResult) {
                    await fetchNDJSON(jsonlPath, {
                        usePersistentCache: this.usePersistentCacheForChunks,
                        priority,
                        onObject: (obj) => {
                            totalLines++;
                            parsed++;
                            const a = obj?.archetype;
                            if (a === undefined || a === null) return;
                            withArchetype++;
                            const hash = this.modelManager.normalizeId(a);
                            if (!hash) {
                                badArchetype++;
                                return;
                            }

                            // Kick off shard load early so real meshes can appear ASAP.
                            this.modelManager?.prefetchMeta?.(hash);

                            archetypeCounts.set(hash, (archetypeCounts.get(hash) ?? 0) + 1);

                            // Distance (data-space) for prioritization / cutoff.
                            const pp = obj.position || [0, 0, 0];
                            const dx = pp[0] - camData[0];
                            const dy = pp[1] - camData[1];
                            const dz = pp[2] - camData[2];
                            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                            const prev = minDistByHash.get(hash);
                            if (prev === undefined || d < prev) minDistByHash.set(hash, d);

                            // If sharded meta isn't loaded yet, don't treat it as "missing export"—it's just unknown.
                            const shardKnown = this.modelManager?.isShardLoadedForHash?.(hash) ?? true;
                            if (!shardKnown) {
                                unknownMetaEntities++;
                            } else {
                                const hasReal = (this.modelManager?.hasRealMesh?.(hash) ?? false);
                                if (!hasReal) missingMeshEntities++;
                                else matchedMesh++;
                            }

                            const m = this._entityToMat4(obj);
                            const tintIndex = this._safeTintIndex(obj?.tintIndex ?? obj?.tint);
                            let arr = byHash.get(hash);
                            if (!arr) {
                                arr = [];
                                byHash.set(hash, arr);
                            }
                            for (let i = 0; i < 16; i++) arr.push(m[i]);
                            arr.push(tintIndex);
                        },
                    });
                }
            } else {
                if (!workerResult) {
                    // Approximate stats for binary path.
                    const aTotal = Array.from(archetypeCounts.values()).reduce((acc, v) => acc + (v ?? 0), 0);
                    totalLines = aTotal;
                    parsed = aTotal;
                    withArchetype = aTotal;
                    matchedMesh = byHash.size; // not exact, but used only for debug
                    // In sharded mode we can't know "missing" without having loaded relevant shards, so treat as unknown.
                    missingMeshEntities = 0;
                    unknownMetaEntities = aTotal;
                }
            }

            let chunkMap;
            let chunkMin;
            if (workerResult && workerResult.ok) {
                usedBinary = !!workerResult.usedBinary;
                totalLines = Number(workerResult.totalLines ?? 0);
                parsed = Number(workerResult.parsed ?? 0);
                withArchetype = Number(workerResult.withArchetype ?? 0);
                badArchetype = Number(workerResult.badArchetype ?? 0);

                archetypeCounts = new Map(Array.isArray(workerResult.archetypeCountEntries) ? workerResult.archetypeCountEntries : []);
                chunkMin = new Map(Array.isArray(workerResult.minDistEntries) ? workerResult.minDistEntries : []);

                // Trigger shard prefetch for all archetypes seen (progress messages may have already done this).
                for (const h of archetypeCounts.keys()) {
                    try { this.modelManager?.prefetchMeta?.(h); } catch { /* ignore */ }
                }

                chunkMap = new Map();
                const buf = workerResult.matsBuffer;
                const idxArr = Array.isArray(workerResult.matsIndex) ? workerResult.matsIndex : [];
                if (buf && buf.byteLength && idxArr.length) {
                    for (const it of idxArr) {
                        const hash = String(it?.hash ?? '');
                        if (!hash) continue;
                        const offFloats = Number(it?.offsetFloats ?? 0);
                        const lenFloats = Number(it?.lengthFloats ?? 0);
                        if (!Number.isFinite(offFloats) || !Number.isFinite(lenFloats) || lenFloats <= 0) continue;
                        try {
                            chunkMap.set(hash, new Float32Array(buf, offFloats * 4, lenFloats));
                        } catch {
                            // ignore bad slice
                        }
                    }
                }

                // Recompute mesh availability stats on the main thread (depends on sharded manifest load state).
                matchedMesh = 0;
                missingMeshEntities = 0;
                unknownMetaEntities = 0;
                for (const [hash, cnt] of archetypeCounts.entries()) {
                    const c = Number(cnt ?? 0);
                    if (!Number.isFinite(c) || c <= 0) continue;
                    const shardKnown = this.modelManager?.isShardLoadedForHash?.(hash) ?? true;
                    if (!shardKnown) {
                        unknownMetaEntities += c;
                    } else {
                        const hasReal = (this.modelManager?.hasRealMesh?.(hash) ?? false);
                        if (!hasReal) missingMeshEntities += c;
                        else matchedMesh += c;
                    }
                }
            } else {
                chunkMap = new Map();
                chunkMin = new Map();
                for (const [hash, mats] of byHash.entries()) {
                    chunkMap.set(hash, new Float32Array(mats));
                    chunkMin.set(hash, minDistByHash.get(hash) ?? 1e30);
                }
            }
            this.chunkInstances.set(key, chunkMap);
            this.chunkMinDist.set(key, chunkMin);
            this.chunkArchetypeCounts.set(key, archetypeCounts);

            this.loaded.add(key);
            this._dirty = true;

            this.lastLoadStats = {
                key,
                totalLines,
                parsed,
                withArchetype,
                matchedMesh,
                instancedArchetypes: chunkMap.size,
                badArchetype,
                missingMeshEntities,
                unknownMetaEntities,
                usedBinary,
            };
        } catch (e) {
            console.warn(`Drawable chunk load failed ${key}:`, e);
        } finally {
            this.loading.delete(key);
        }
    }

    _computeCoverageStats({ keptArchetypes = null, droppedArchetypes = null, totalMeshArchetypes = null, keptInstances = null, totalMeshInstances = null, keptRealArchetypes = null, keptPlaceholderArchetypes = null } = {}) {
        // Aggregate unexported archetypes + totals across loaded chunks.
        let entitiesWithArchetype = 0;
        const allArchetypes = new Set();
        const missingAgg = new Map(); // hash -> count (known missing)
        const unknownAgg = new Map(); // hash -> count (manifest shard not loaded yet)
        for (const key of this.loaded) {
            const cmap = this.chunkArchetypeCounts.get(key);
            if (cmap) {
                for (const [hash, cnt] of cmap.entries()) {
                    allArchetypes.add(hash);
                    entitiesWithArchetype += (cnt ?? 0);
                    const shardKnown = this.modelManager?.isShardLoadedForHash?.(hash) ?? true;
                    if (!shardKnown) {
                        unknownAgg.set(hash, (unknownAgg.get(hash) ?? 0) + (cnt ?? 0));
                    } else if (!(this.modelManager?.hasRealMesh?.(hash) ?? true)) {
                        missingAgg.set(hash, (missingAgg.get(hash) ?? 0) + (cnt ?? 0));
                    }
                }
            }
        }

        // Sort by frequency for quick debugging.
        const unexportedTop = Array.from(missingAgg.entries())
            .map(([hash, count]) => ({ hash, count }))
            .sort((a, b) => (b.count - a.count) || (a.hash < b.hash ? -1 : 1));
        const unknownTop = Array.from(unknownAgg.entries())
            .map(([hash, count]) => ({ hash, count }))
            .sort((a, b) => (b.count - a.count) || (a.hash < b.hash ? -1 : 1));

        const unexportedEntities = unexportedTop.reduce((acc, e) => acc + (e.count ?? 0), 0);
        const entitiesWithMeshInManifest = (totalMeshInstances ?? null);

        this.coverageStats = {
            loadedChunks: this.loaded.size,
            entitiesWithArchetype,
            uniqueArchetypes: allArchetypes.size,
            // With placeholder meshes enabled, "missing renderables" is always 0.
            missingEntities: 0,
            missingArchetypes: 0,
            missingTop: [],
            // Still report export gaps (rendered as placeholder cubes).
            unexportedEntities,
            unexportedArchetypes: missingAgg.size,
            unexportedTop,
            // Sharded-manifest visibility: how many entities are "unknown" because we haven't loaded their shard yet.
            unknownMetaEntities: unknownTop.reduce((acc, e) => acc + (e.count ?? 0), 0),
            unknownMetaArchetypes: unknownAgg.size,
            unknownMetaTop: unknownTop.slice(0, 50),
            // These are computed in _rebuildAllInstances (they depend on maxArchetypes cap).
            totalMeshArchetypes,
            keptArchetypes,
            droppedArchetypes,
            keptRealArchetypes,
            keptPlaceholderArchetypes,
            totalMeshInstances,
            keptInstances,
            droppedInstances: (Number.isFinite(totalMeshInstances) && Number.isFinite(keptInstances)) ? Math.max(0, totalMeshInstances - keptInstances) : null,
            entitiesWithMeshInManifest,
        };
    }

    getCoverageStats() {
        return this.coverageStats;
    }

    getMissingArchetypesTop(n = 20) {
        // Backward-compatible API: return "unexported" archetypes (placeholders).
        const top = this.coverageStats?.unexportedTop ?? [];
        const nn = Number.isFinite(n) ? Math.max(0, Math.min(500, Math.floor(n))) : 20;
        return top.slice(0, nn);
    }

    _rebuildAllInstances() {
        // Aggregate matrices across all loaded chunks per archetype.
        const agg = new Map(); // hash -> number[]
        const minD = new Map(); // hash -> number
        for (const key of this.loaded) {
            const cmap = this.chunkInstances.get(key);
            if (!cmap) continue;
            const dmap = this.chunkMinDist.get(key);
            for (const [hash, mats] of cmap.entries()) {
                let arr = agg.get(hash);
                if (!arr) {
                    arr = [];
                    agg.set(hash, arr);
                }
                for (let i = 0; i < mats.length; i++) arr.push(mats[i]);

                const d = dmap?.get(hash);
                if (d !== undefined) {
                    const prev = minD.get(hash);
                    if (prev === undefined || d < prev) minD.set(hash, d);
                }
            }
        }

        // Distance-first selection (closest archetypes first), but prefer REAL meshes over placeholders
        // so placeholders don't crowd out real geometry under maxArchetypes.
        const entries = Array.from(agg.entries()).map(([hash, mats]) => ({
            hash,
            mats,
            d: minD.get(hash) ?? 1e30,
            isPlaceholder: !(this.modelManager?.hasRealMesh?.(hash) ?? true),
        }));
        entries.sort((a, b) => {
            const pa = a.isPlaceholder ? 1 : 0;
            const pb = b.isPlaceholder ? 1 : 0;
            if (pa !== pb) return pa - pb;
            return a.d - b.d;
        });
        const maxD = Number.isFinite(this.maxModelDistance) ? Math.max(0, this.maxModelDistance) : 1e30;
        const within = entries.filter(e => e.d <= maxD);
        const maxArch = (this.maxArchetypes | 0);
        const keep = (maxArch > 0) ? within.slice(0, maxArch) : within;

        // Stats (helps distinguish "missing meshes" vs "capped by maxArchetypes").
        let totalMeshInstances = 0;
        for (const e of entries) {
            const stride = this._instanceStrideFloatsForLen(e.mats.length ?? 0);
            totalMeshInstances += Math.floor((e.mats.length ?? 0) / stride);
        }
        let keptInstances = 0;
        for (const e of keep) {
            const stride = this._instanceStrideFloatsForLen(e.mats.length ?? 0);
            keptInstances += Math.floor((e.mats.length ?? 0) / stride);
        }
        const keptReal = keep.reduce((acc, e) => acc + (e.isPlaceholder ? 0 : 1), 0);
        const keptPlaceholder = keep.reduce((acc, e) => acc + (e.isPlaceholder ? 1 : 0), 0);

        // If enabled, regroup instances by (lod + submesh file + material signature) and feed bucket renderer.
        if (this.enableCrossArchetypeInstancing && this.modelManager?.getEffectiveMaterialAndSignature && this.modelRenderer?.setInstancesForBucket) {
            /** @type {Map<string, { lod: string, file: string, material: any, mats: number[] }>} */
            const buckets = new Map();

            for (const e of keep) {
                const lod = this._chooseLod(e.hash, e.d);
                const metaEntry = this.modelManager?.manifest?.meshes?.[String(e.hash)];
                const entryMat = metaEntry?.material ?? null;
                const subs = this.modelManager.getLodSubmeshes(e.hash, lod) || [];
                if (!subs || subs.length === 0) continue;

                for (const sm of subs) {
                    const file = String(sm?.file || '').trim();
                    if (!file) continue;
                    const { sig, material } = this.modelManager.getEffectiveMaterialAndSignature(entryMat, sm?.material ?? null);
                    const bucketId = `${String(lod)}:${file}:${sig}`;
                    let b = buckets.get(bucketId);
                    if (!b) {
                        b = { lod: String(lod), file, material, mats: [], minDist: e.d };
                        buckets.set(bucketId, b);
                    } else {
                        // Track the closest contributing archetype so texture tiering can be distance-based.
                        const prevD = Number(b.minDist);
                        const nextD = Number(e.d);
                        if (!Number.isFinite(prevD) || (Number.isFinite(nextD) && nextD < prevD)) b.minDist = nextD;
                    }
                    // Append this archetype's instance matrices into this bucket.
                    for (let i = 0; i < e.mats.length; i++) b.mats.push(e.mats[i]);
                }
            }

            // Remove stale archetype-instance entries (hash:lod) that were previously set.
            // (Cross instancing bypasses setInstancesForArchetype entirely.)
            for (const k of this._prevDesiredInstanceKeys) {
                const [h, lod] = String(k).split(':', 2);
                if (h) void this.modelRenderer.setInstancesForArchetype(h, lod || 'high', null);
            }
            this._prevDesiredInstanceKeys = new Set();

            // Track previous bucket ids so we can delete stale ones.
            if (!this._prevDesiredBucketIds) this._prevDesiredBucketIds = new Set();
            const desiredBucketIds = new Set(buckets.keys());
            for (const bid of this._prevDesiredBucketIds) {
                if (!desiredBucketIds.has(bid)) {
                    // clearing only needs bucketId; other args are ignored on clear path
                    void this.modelRenderer.setInstancesForBucket(bid, 'high', '__clear__', null, null);
                }
            }
            for (const [bid, b] of buckets.entries()) {
                void this.modelRenderer.setInstancesForBucket(bid, b.lod, b.file, b.material, new Float32Array(b.mats), b.minDist);
            }
            this._prevDesiredBucketIds = desiredBucketIds;

            // Keep coverage stats semantics: still counts kept archetypes/instances.
            this._computeCoverageStats({
                totalMeshArchetypes: entries.length,
                keptArchetypes: keep.length,
                droppedArchetypes: Math.max(0, entries.length - keep.length),
                keptRealArchetypes: keptReal,
                keptPlaceholderArchetypes: keptPlaceholder,
                totalMeshInstances,
                keptInstances,
            });
            return;
        }

        // Remove stale instance entries (hash:lod) that are no longer desired.
        const desiredKeys = new Set();
        for (const e of keep) {
            const lod = this._chooseLod(e.hash, e.d);
            desiredKeys.add(`${String(e.hash)}:${String(lod)}`);
            void this.modelRenderer.setInstancesForArchetype(e.hash, lod, new Float32Array(e.mats), e.d);
        }
        for (const k of this._prevDesiredInstanceKeys) {
            if (!desiredKeys.has(k)) {
                const [h, lod] = String(k).split(':', 2);
                if (h) void this.modelRenderer.setInstancesForArchetype(h, lod || 'high', null);
            }
        }
        this._prevDesiredInstanceKeys = desiredKeys;

        // If we were previously in cross-instancing mode, clear stale buckets.
        if (this._prevDesiredBucketIds && this.modelRenderer?.setInstancesForBucket) {
            for (const bid of this._prevDesiredBucketIds) {
                void this.modelRenderer.setInstancesForBucket(bid, 'high', '__clear__', null, null);
            }
            this._prevDesiredBucketIds = new Set();
        }

        this._computeCoverageStats({
            totalMeshArchetypes: entries.length,
            keptArchetypes: keep.length,
            droppedArchetypes: Math.max(0, entries.length - keep.length),
            keptRealArchetypes: keptReal,
            keptPlaceholderArchetypes: keptPlaceholder,
            totalMeshInstances,
            keptInstances,
        });
    }

    _chooseLod(hash, dist) {
        if (this.forcedLod) return this.forcedLod;
        // Manifest provides lod distances (if exported). Fallback: high.
        const h = String(hash);
        const entry = this.modelManager?.manifest?.meshes?.[h];
        const ld = entry?.lodDistances || {};
        // CodeWalker distances are “switch distances”; keep it simple:
        // dist < high => high, else if dist < med => med, else if dist < low => low, else vlow.
        const hi = Number(ld.High ?? ld.high ?? 1e30);
        const med = Number(ld.Med ?? ld.med ?? 1e30);
        const low = Number(ld.Low ?? ld.low ?? 1e30);
        const vlow = Number(ld.VLow ?? ld.vlow ?? 1e30);

        // If distances are missing/garbage, stick to high.
        if (!Number.isFinite(hi) && !Number.isFinite(med) && !Number.isFinite(low) && !Number.isFinite(vlow)) {
            return 'high';
        }

        if (Number.isFinite(hi) && dist <= hi) return 'high';
        if (Number.isFinite(med) && dist <= med) return 'med';
        if (Number.isFinite(low) && dist <= low) return 'low';
        // IMPORTANT: beyond VLow we should keep the *lowest* LOD, not pop back to high.
        if (Number.isFinite(vlow)) return 'vlow';
        return 'low';
    }

    _trim(wantedSet, wantedOrdered = null) {
        let changed = false;
        for (const key of Array.from(this.loaded)) {
            if (!wantedSet.has(key)) {
                this.loaded.delete(key);
                this.chunkInstances.delete(key);
                this.chunkMinDist.delete(key);
                this.chunkArchetypeCounts.delete(key);
                changed = true;
            }
        }
        if (this.loaded.size <= this.maxLoadedChunks) return;
        const extra = this.loaded.size - this.maxLoadedChunks;

        // Drop farthest chunks first for stability when turning/moving.
        const centerKey = (wantedOrdered && wantedOrdered.length > 0) ? wantedOrdered[0] : null;
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
            this.loaded.delete(key);
            this.chunkInstances.delete(key);
            this.chunkMinDist.delete(key);
            this.chunkArchetypeCounts.delete(key);
            changed = true;
        }
        if (changed) this._dirty = true;
    }

    update(camera, centerDataPos = null) {
        if (!this.ready) return;
        // Expose camera position for distance computations inside chunk load (async).
        // (We avoid capturing camera object into async closures.)
        window.__appCameraPosForDrawableStreamer = [camera.position[0], camera.position[1], camera.position[2]];
        const wanted = this._wantedKeysForCamera(camera, centerDataPos);
        const wantedSet = new Set(wanted);
        this._trim(wantedSet, wanted);
        if (this._dirty) {
            this._dirty = false;
            this._rebuildAllInstances();
        }

        const budget = Math.max(1, Math.floor(this.maxNewLoadsPerUpdate));
        let started = 0;
        for (let i = 0; i < wanted.length; i++) {
            if (started >= budget) break;
            const key = wanted[i];
            if (this.loaded.has(key) || this.loading.has(key)) continue;

            const priority = (i < Math.max(9, this.radiusChunks * 2 + 1)) ? 'high' : 'low';
            started++;
            void this._loadChunk(key, { priority });
        }
    }
}



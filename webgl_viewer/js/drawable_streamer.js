import { glMatrix } from './glmatrix.js';
import { extractFrustumPlanes, aabbIntersectsFrustum } from './frustum_culling.js';
import { fetchArrayBufferWithPriority, fetchJSON, fetchNDJSON, fetchStreamBytes, fetchText } from './asset_fetcher.js';
import { joaat } from './joaat.js';

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

        // Streaming window. The player-centered core is independent of camera direction, so looking
        // around cannot replace chunks under the player. Any forward extension is prefetch-only.
        this.maxLoadedChunks = 9;
        this.radiusChunks = 1;
        this.extraFrontChunks = 1;
        this.residencyHysteresisChunks = 0.18;
        this._residentCenterChunk = null;
        // Optional data-space rectangle used by the spawn-district demo. Chunks that
        // overlap it are parsed, then individual instances outside it are discarded.
        this.worldBounds = null;
        // /demo replaces a much larger source chunk with one prefiltered ENT1 tile.
        // It is kept as a single resident key so player movement cannot trigger reloads.
        this.demoBootstrap = null;
        this.enableFrustumCulling = true;
        // Aggressive per-instance frustum culling is opt-in because it requires camera-coupled
        // instance-buffer rebuilds. /demo enables it; full-map streaming keeps resident buffers stable.
        this.enableWorkerFrustumCulling = false;
        this.workerFrustumPadding = 16.0;
        // WASM culling is for high-density non-demo rebuilds. It bulk-filters packed instance slices in
        // the worker, then JS keeps the existing dedupe/selection/packing behavior.
        this.enableWasmCulling = true;
        this.wasmCullingMinInstances = 50000;
        this.wasmCullingMinSliceInstances = 512;
        // Optional WebGPU compute culler is available as a backend module, but stays
        // opt-in because WebGPU upload/readback can lose to WASM below very high density.
        this.enableWebGpuCulling = false;
        this.webGpuCullingMinInstances = 100000;
        this.webGpuCullingMinSliceInstances = 2048;
        // Avoid scheduling huge bursts of chunk work in a single frame.
        this.maxNewLoadsPerUpdate = 3;

        // Optional fast-path: binary ENT1 tiles in assets/entities_chunks_inst/*.bin.
        // If they aren't present, browsers will log noisy 404s. Auto-disable after first 404.
        this.preferBinary = true;
        this._instProbeDone = false;

        // Whether to use CacheStorage for streamed chunk files (JSONL / ENT1 bins).
        // Default false because chunks can be very large; controlled by the UI.
        this.usePersistentCacheForChunks = false;
        this.maxArchetypes = 96; // cap instanced archetypes to avoid loading thousands at once
        // Distance-based selection: only instance archetypes whose nearest instance is within this distance.
        // Set to Infinity to disable distance cutoff.
        //
        // NOTE: 350 is far too small at GTA scale and looks like geometry is "cut off" in front of the camera.
        this.maxModelDistance = 320.0;
        // Enforced before instance buffers reach the GPU.
        this.maxVisibleInstances = 12000;
        this.maxInstancesPerArchetype = 128;
        this.maxBehindModelDistance = 180.0;
        this._dirty = true; // rebuild instances only when chunk set changes (not every frame)

        // Cross-archetype instancing is only useful when the asset export shares mesh-bin files across
        // archetypes. The current export emits one file namespace per archetype, so keep this opt-in.
        this.enableCrossArchetypeInstancing = false;

        // Entity-level LOD traversal (CodeWalker-style parent-vs-children leaf selection).
        // NOTE: requires updated `entities_chunks/*.jsonl` that include:
        // - ymap_entity_index
        // - parent_index / num_children
        // - lod_dist / child_lod_dist
        // This path is slower and currently disables the ENT1 fast-path (ENT1 doesn't carry hierarchy info).
        this.enableEntityLodTraversal = false;
        // Production friendliness: entity LOD traversal schema mismatches are common during iteration,
        // so warn only once per session by default (instead of once per chunk).
        this.warnEntityLodTraversalMissingHierarchy = true;
        this._warnedEntityLodTraversalMissingHierarchy = false;
        this.entityLodDistMult = 1.0;
        this.entityLodUpdateMinMove = 12.0; // data-space units
        this.entityLodUpdateMinMs = 200;    // ms throttle
        this._entityNodesByKey = new Map(); // key -> node
        this._chunkEntityKeys = new Map();  // chunkKey -> Set<nodeKey>
        this._pendingChildrenByParentKey = new Map(); // parentKey -> Set<childKey>
        this._dirtyEntityLod = true;
        this._lastEntityLodCam = null; // [x,y,z] in data-space
        this._lastEntityLodMs = 0;
        this._lastEntityLodLeafCount = 0;

        // Interiors / MLOs (minimal viable)
        this.enableInteriors = true;
        this.enableRoomGating = true;         // portal/room gating
        this.interiorPortalDepth = 2;         // BFS depth through portals from current room
        this.enableMloEntitySets = true;      // gate entity-set entities

        this._mloDefs = new Map();            // mloArchetypeHash -> def JSON
        this._mloDefsLoading = new Set();     // hashes currently loading
        this._mloSetOverrides = new Map();    // key `${parentGuid}:${setHash}` -> boolean
        this._activeInterior = null;          // { parentGuid, archHash, roomIndex, visibleRooms:Set<number> }
        this._activeInteriorKey = '';         // cached change detector
        this._mloInstancesLast = [];          // last discovered MLO instances (from last rebuild)
        this._lastCamDataPos = [0, 0, 0];     // updated each frame (data-space)
        this._lastCamDataDir = [0, 0, -1];    // updated each frame (data-space, normalized)

        // Static world instance buffers stay resident while the chunk set is stable.  Re-selecting every
        // few metres recreates large typed arrays and reuploads them, which looks like the city is resetting.
        // This remains opt-in for diagnostics or a future fine-grained culling path; normal movement only
        // updates the player and camera, while chunk/interior changes mark the stream dirty.
        this.rebuildInstancesOnMove = false;
        this.instanceRebuildMinMove = 512.0; // data-space units when explicitly enabled
        this.instanceRebuildMinMs = 1000;    // ms throttle when explicitly enabled
        this.instanceRebuildMinDirDot = 0.985; // rebuild when camera turns by ~10 degrees (if enabled)
        this._lastInstanceRebuildCam = null; // [x,y,z] data-space
        this._lastInstanceRebuildDir = null; // [x,y,z] data-space
        this._lastInstanceRebuildMs = 0;

        // Prefer keeping/rendering archetypes that are in front of the camera when capped.
        this.enableCameraForwardPrioritization = true;
        this.cameraBehindPenalty = 1.6;

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

        // Scratch buffers to reduce per-frame allocations (GC spikes / hitching).
        this._tmpVec4In = glMatrix.vec4.create();
        this._tmpVec4Out = glMatrix.vec4.create();
        this._tmpVpData = glMatrix.mat4.create();
        this._tmpFrustumPlanes = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
        this._tmpFrustumPlanesFlat = new Float32Array(24);
        this._lastFrustumPlanesData = null;
        this._lastFrustumStats = { enabled: false, tested: 0, culled: 0 };
        this._lastWasmStats = { enabled: false, tested: 0, kept: 0, rejected: 0 };
        this._lastWebGpuStats = { enabled: false, requested: false, reason: '', tested: 0, kept: 0, rejected: 0 };
        this._tmpWantedKeys = [];
        this._tmpWantedScored = [];
        this._tmpInFrustumSet = new Set();
        this._tmpWantedSet = new Set();

        // Store camera-space values in-place to avoid allocating new arrays each frame.
        this._lastCamDataPos = new Float32Array([0, 0, 0]);
        this._lastCamDataDir = new Float32Array([0, 0, -1]);

        // Offload rebuild/aggregation into the worker for game-like frame pacing.
        this.enableWorkerRebuild = true;
        this._workerStoredChunks = new Set(); // chunkKeys stored in worker
        this._rebuildWorkerReqInFlight = false;
        this._rebuildWorkerLastReqId = 0;

        // Adaptive load budget (based on frame time)
        this._lastUpdateMs = 0;
        this._frameMsEma = 16.7;

        // Stale-request cancellation/dropping:
        // - Each in-flight chunk load gets its own AbortController.
        // - When a chunk falls out of the wanted set, we abort the fetch and ignore late results.
        /** @type {Map<string, { controller: AbortController, token: number, workerReqId?: number }>} */
        this._chunkLoadReqs = new Map();
        this._chunkLoadNextToken = 1;

        // Time/weather YMAP gating (CodeWalker-style MapDataGroups):
        // - Optional, driven by `assets/ymap_gates.json` generated offline.
        // - If absent, gating is a no-op (everything visible).
        this.enableTimeWeatherYmapGating = true;
        /** @type {null | { byYmapHash?: Record<string, { hoursOnOff?: number, weatherTypes?: Array<string|number> }> }} */
        this._ymapGates = null;
        this._ymapGateHour = 13;          // 0..23
        this._ymapGateWeatherHash = 0;    // 0 => ignore weather gating
    }

    /**
     * Update the time/weather state used for MapDataGroup gating.
     * - hour: number (0..24) -> internally rounded down to 0..23.
     * - weather: string (e.g. "CLEAR") or u32 hash; 0/"" means "ignore weather".
     */
    setTimeWeather({ hour = null, weather = null } = {}) {
        const h0 = Number(hour);
        const nextHour = Number.isFinite(h0) ? Math.max(0, Math.min(23, Math.floor(h0 % 24))) : this._ymapGateHour;

        let nextWeather = this._ymapGateWeatherHash;
        if (weather !== null && weather !== undefined) {
            if (typeof weather === 'number') {
                nextWeather = Number.isFinite(weather) ? (weather >>> 0) : 0;
            } else {
                const s = String(weather || '').trim();
                nextWeather = s ? (joaat(s.toLowerCase()) >>> 0) : 0;
            }
        }

        const changed = (nextHour !== this._ymapGateHour) || (nextWeather !== this._ymapGateWeatherHash);
        this._ymapGateHour = nextHour;
        this._ymapGateWeatherHash = nextWeather;
        if (changed && this.enableTimeWeatherYmapGating && this._ymapGates) {
            // Rebuild from already-loaded chunks (we keep per-instance ymapHash in the instance buffer).
            this._dirty = true;
            this._dirtyEntityLod = true;
        }
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

        // HoursOnOff bitmask: if a bit for the current hour is NOT set, the ymap is disabled.
        const mask = Number(gate.hoursOnOff ?? gate.hours_onoff ?? 0);
        const hour = (Number(this._ymapGateHour) | 0);
        if (Number.isFinite(mask) && mask !== 0 && hour >= 0 && hour <= 23) {
            const bit = (1 << hour) >>> 0;
            if (((mask >>> 0) & bit) === 0) return false;
        }

        // WeatherTypes: only enforce when a specific weather is set (non-zero), to match CodeWalker behavior.
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

    _lodLevelRank(name) {
        // CodeWalker uses rage__eLodType ordering to reject certain parentIndex links.
        // We approximate the ordering using the exported enum names.
        const s = String(name || '').trim().toUpperCase();
        if (!s) return null;
        // Lower rank = higher detail / closer.
        // Note: ORPHANHD is handled as a special case in CodeWalker.
        const order = [
            'LODTYPES_DEPTH_HD',
            'LODTYPES_DEPTH_LOD',
            'LODTYPES_DEPTH_SLOD1',
            'LODTYPES_DEPTH_SLOD2',
            'LODTYPES_DEPTH_SLOD3',
            'LODTYPES_DEPTH_SLOD4',
            'LODTYPES_DEPTH_VLOD',
            'LODTYPES_DEPTH_SLOD',
            'LODTYPES_DEPTH_ORPHANHD',
        ];
        const idx = order.indexOf(s);
        return (idx >= 0) ? idx : null;
    }

    _isInvalidParentLinkCodeWalkerStyle(parentNode, childNode) {
        if (!parentNode || !childNode) return false;
        const pName = String(parentNode.lodLevelStr || '').trim().toUpperCase();
        const cName = String(childNode.lodLevelStr || '').trim().toUpperCase();
        // Mirrors CodeWalker EnsureEntities:
        // if ((p.lodLevel <= d.lodLevel) ||
        //     ((p.lodLevel == ORPHANHD) && (d.lodLevel != ORPHANHD))) { isroot=true; p=null; }
        if (pName === 'LODTYPES_DEPTH_ORPHANHD' && cName !== 'LODTYPES_DEPTH_ORPHANHD') return true;
        const pr = parentNode.lodLevelRank;
        const cr = childNode.lodLevelRank;
        if (pr === null || pr === undefined || cr === null || cr === undefined) return false;
        return (Number(pr) <= Number(cr));
    }

    _fallbackEntityLodDistForHash(hash) {
        // CodeWalker fallback when entity lodDist==0 is archetype.LodDist (from YTYP).
        // We don't parse YTYP in the viewer today, so approximate with the largest
        // drawable LOD switch distance exported in the model manifest (usually VLow).
        const h = String(hash || '').trim();
        if (!h) return null;
        const entry = this.modelManager?.manifest?.meshes?.[h];
        const ld = entry?.lodDistances;
        if (!ld || typeof ld !== 'object') return null;
        const vals = [
            Number(ld.VLow ?? ld.vlow),
            Number(ld.Low ?? ld.low),
            Number(ld.Med ?? ld.med),
            Number(ld.High ?? ld.high),
        ].filter((v) => Number.isFinite(v) && v > 0);
        if (!vals.length) return null;
        return Math.max(...vals);
    }

    setEntityLodTraversalEnabled(enabled) {
        const on = !!enabled;
        if (this.enableEntityLodTraversal === on) return;
        this.enableEntityLodTraversal = on;

        // ENT1 fast-path doesn't carry hierarchy; disable it when entity LOD is enabled.
        if (this.enableEntityLodTraversal) this.preferBinary = false;

        // Reset streamed data so we don't mix modes (also forces reload).
        try {
            for (const k of this._prevDesiredInstanceKeys) {
                const [h, lod] = String(k).split(':', 2);
                if (h) void this.modelRenderer?.setInstancesForArchetype?.(h, lod || 'high', null);
            }
        } catch { /* ignore */ }
        this._prevDesiredInstanceKeys = new Set();

        this.loading = new Set();
        this.loaded = new Set();
        this.chunkInstances = new Map();
        this.chunkMinDist = new Map();
        this.chunkArchetypeCounts = new Map();
        this.lastLoadStats = null;
        this.coverageStats = null;
        this._dirty = true;

        this._entityNodesByKey = new Map();
        this._chunkEntityKeys = new Map();
        this._pendingChildrenByParentKey = new Map();
        this._dirtyEntityLod = true;
        this._lastEntityLodCam = null;
        this._lastEntityLodMs = 0;
        this._lastEntityLodLeafCount = 0;
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
                try {
                    console.error('DrawableStreamer: chunk worker crashed; falling back to main-thread parsing.', err);
                } catch { /* ignore */ }
                try {
                    globalThis.__viewerReportError?.({
                        subsystem: 'chunkWorker',
                        level: 'error',
                        message: 'chunk worker crashed; falling back to main-thread parsing',
                        detail: { error: String(err?.message || err || '') },
                    });
                } catch { /* ignore */ }
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

    async _parseChunkNDJSONInWorker(url, camData, priority, { storeKey = null, storeOnly = false, worldBounds = null, signal = undefined, onReqId = null } = {}) {
        const w = this._getChunkWorker();
        if (!w) return null;
        const reqId = (this._chunkWorkerNextReqId++ >>> 0);
        try { if (typeof onReqId === 'function') onReqId(reqId); } catch { /* ignore */ }
        const p = new Promise((resolve, reject) => {
            this._chunkWorkerPending.set(reqId, { resolve, reject });
        });

        try {
            w.postMessage({ type: 'begin_ndjson', reqId, camData, storeKey, storeOnly, worldBounds });
            await fetchStreamBytes(url, {
                usePersistentCache: this.usePersistentCacheForChunks,
                priority,
                signal,
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

    async _parseENT1InWorker(buffer, camData, { storeKey = null, storeOnly = false, worldBounds = null, onReqId = null } = {}) {
        const w = this._getChunkWorker();
        if (!w) return null;
        const reqId = (this._chunkWorkerNextReqId++ >>> 0);
        try { if (typeof onReqId === 'function') onReqId(reqId); } catch { /* ignore */ }
        const p = new Promise((resolve, reject) => {
            this._chunkWorkerPending.set(reqId, { resolve, reject });
        });
        try {
            w.postMessage({ type: 'parse_ent1', reqId, camData, buffer, storeKey, storeOnly, worldBounds }, [buffer]);
            return await p;
        } catch (e) {
            try { w.postMessage({ type: 'cancel', reqId }); } catch { /* ignore */ }
            this._chunkWorkerPending.delete(reqId);
            throw e;
        }
    }

    async _rebuildAllInstancesInWorker() {
        if (!this.enableWorkerRebuild) return false;
        const w = this._getChunkWorker();
        if (!w) return false;
        if (this.enableEntityLodTraversal) return false; // keep entity LOD path as-is for now

        if (this._rebuildWorkerReqInFlight) return false;
        this._rebuildWorkerReqInFlight = true;

        const reqId = (this._chunkWorkerNextReqId++ >>> 0);
        this._rebuildWorkerLastReqId = reqId;
        const p = new Promise((resolve, reject) => {
            this._chunkWorkerPending.set(reqId, { resolve, reject });
        });

        try {
            const cam = this._lastCamDataPos || [0, 0, 0];
            const dir = this._lastCamDataDir || [0, 0, -1];
            const maxCandidates = Math.max(1, (this.maxArchetypes | 0) > 0 ? (this.maxArchetypes | 0) * 4 : 1200);
            const behindPenalty = Number.isFinite(Number(this.cameraBehindPenalty)) ? Math.max(1.0, Number(this.cameraBehindPenalty)) : 1.6;
            const keys = Array.from(this._workerStoredChunks);
            const frustumPlanes = (this.enableFrustumCulling && this.enableWorkerFrustumCulling && this._lastFrustumPlanesData)
                ? this._lastFrustumPlanesData
                : null;
            this._lastFrustumStats = { enabled: !!frustumPlanes, tested: 0, culled: 0 };
            this._lastWasmStats = { enabled: false, tested: 0, kept: 0, rejected: 0 };
            this._lastWebGpuStats = { enabled: false, requested: false, reason: '', tested: 0, kept: 0, rejected: 0 };
            w.postMessage({
                type: 'rebuild_stored',
                reqId,
                keys,
                camData: [cam[0], cam[1], cam[2]],
                camDir: [dir[0], dir[1], dir[2]],
                maxCandidates,
                maxModelDistance: this.maxModelDistance,
                behindPenalty,
                maxVisibleInstances: this.maxVisibleInstances,
                maxInstancesPerArchetype: this.maxInstancesPerArchetype,
                maxBehindModelDistance: this.maxBehindModelDistance,
                nonRenderableHashes: this.modelManager?.getNonRenderableHashes?.() ?? [],
                frustumPlanes,
                frustumPadding: this.workerFrustumPadding,
                cullRadiusEntries: frustumPlanes ? this._buildFrustumCullRadiusEntries() : [],
                enableWasmCulling: !!(this.enableWasmCulling && !this.demoBootstrap),
                wasmCullingMinInstances: this.wasmCullingMinInstances,
                wasmCullingMinSliceInstances: this.wasmCullingMinSliceInstances,
                // Keep WASM disabled for the fixed demo bootstrap, but allow the
                // explicit WebGPU toggle so /demo can exercise the compute backend.
                enableWebGpuCulling: !!this.enableWebGpuCulling,
                webGpuCullingMinInstances: this.webGpuCullingMinInstances,
                webGpuCullingMinSliceInstances: this.webGpuCullingMinSliceInstances,
            });

            const res = await p;
            if (!res || !res.ok) return false;
            this._lastFrustumStats = {
                enabled: !!res.frustumEnabled,
                tested: Math.max(0, Math.floor(Number(res.frustumTested) || 0)),
                culled: Math.max(0, Math.floor(Number(res.frustumCulled) || 0)),
            };
            this._lastWasmStats = {
                enabled: !!res.wasmCullingEnabled,
                tested: Math.max(0, Math.floor(Number(res.wasmCullingTested) || 0)),
                kept: Math.max(0, Math.floor(Number(res.wasmCullingKept) || 0)),
                rejected: Math.max(0, Math.floor(Number(res.wasmCullingRejected) || 0)),
            };
            this._lastWebGpuStats = {
                enabled: !!res.webGpuCullingEnabled,
                requested: !!res.webGpuCullingRequested,
                reason: String(res.webGpuCullingReason || ''),
                tested: Math.max(0, Math.floor(Number(res.webGpuCullingTested) || 0)),
                kept: Math.max(0, Math.floor(Number(res.webGpuCullingKept) || 0)),
                rejected: Math.max(0, Math.floor(Number(res.webGpuCullingRejected) || 0)),
            };

            // Convert packed response to entries compatible with existing apply pipeline.
            const buf = res.matsBuffer;
            const idxArr = Array.isArray(res.matsIndex) ? res.matsIndex : [];
            const minDistByHash = new Map(Array.isArray(res.minDistEntries) ? res.minDistEntries : []);
            const bestDotByHash = new Map(Array.isArray(res.bestDotEntries) ? res.bestDotEntries : []);

            const agg = new Map();
            if (buf && buf.byteLength && idxArr.length) {
                for (const it of idxArr) {
                    const hash = String(it?.hash ?? '');
                    if (!hash) continue;
                    const offFloats = Number(it?.offsetFloats ?? 0);
                    const lenFloats = Number(it?.lengthFloats ?? 0);
                    if (!Number.isFinite(offFloats) || !Number.isFinite(lenFloats) || lenFloats <= 0) continue;
                    try {
                        agg.set(hash, new Float32Array(buf, offFloats * 4, lenFloats));
                    } catch { /* ignore */ }
                }
            }

            const entries = Array.from(agg.entries()).map(([hash, mats]) => ({
                hash,
                mats,
                d: Number(minDistByHash.get(hash) ?? 1e30),
                dot: Number(bestDotByHash.get(hash) ?? 0.0),
                isPlaceholder: !(this.modelManager?.hasRealMesh?.(hash) ?? true),
            }));

            // Apply interior gating + sorting + renderer updates using existing logic by temporarily
            // swapping in a lightweight agg map.
            this._applyRebuiltEntries(entries, {
                sourceInstanceCount: Number(res.sourceInstances),
                duplicateInstancesDropped: Number(res.duplicateInstancesDropped),
            });

            return true;
        } catch {
            return false;
        } finally {
            this._chunkWorkerPending.delete(reqId);
            this._rebuildWorkerReqInFlight = false;
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

    _cancelChunkLoad(key, reason = 'cancelled') {
        const k = String(key || '');
        if (!k) return;
        const req = this._chunkLoadReqs.get(k);
        if (!req) return;
        try { req.controller.abort(); } catch { /* ignore */ }
        // If this chunk was using the worker, cancel the worker job too (best-effort).
        if (req.workerReqId) {
            try {
                const w = this._getChunkWorker();
                if (w) w.postMessage({ type: 'cancel', reqId: req.workerReqId });
            } catch { /* ignore */ }
        }
        this._chunkLoadReqs.delete(k);
        // Mark as not loading so future frames can reschedule if it becomes wanted again.
        try { this.loading.delete(k); } catch { /* ignore */ }
    }

    async init() {
        try {
            this.index = await fetchJSON('assets/entities_index.json');
        } catch {
            console.warn('No entities_index.json found; drawable streaming disabled.');
            return;
        }

        // Cache-bust token for entity chunk URLs.
        // This prevents stale browser CacheStorage entries (from older exports) from being reused
        // when the underlying assets/entities_chunks schema changed.
        this._chunkCacheBust = '';
        try {
            const meta = await fetchJSON('assets/meta/steps.json');
            const rid = String(meta?.run_id || '').trim();
            if (rid) this._chunkCacheBust = rid;
        } catch {
            // ignore; no meta available
        }

        // Probe once to see if ENT1 binary tiles are actually present.
        // Avoid probing a directory (static servers often 404/deny directory listings),
        // and be resilient to servers that don't support HEAD.
        try {
            const chunks = this.index?.chunks || {};
            const firstKey = Object.keys(chunks)[0];
            const firstMeta = firstKey ? chunks[firstKey] : null;
            const firstJsonl = String(firstMeta?.file || '');
            const binFile = (firstJsonl
                ? firstJsonl.replace(/\.jsonl(\.gz)?$/i, '.bin')
                : (firstKey ? `${firstKey}.bin` : ''));

            if (!binFile) {
                this.preferBinary = false;
            } else {
                const url = `assets/entities_chunks_inst/${binFile}`;
                let resp = await fetch(url, { method: 'HEAD', cache: 'no-store' });
                if (!resp.ok && (resp.status === 405 || resp.status === 501)) {
                    resp = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-31' }, cache: 'no-store' });
                }
                this.preferBinary = !!resp.ok;
            }
        } catch {
            this.preferBinary = false;
        } finally {
            this._instProbeDone = true;
        }

        // Optional: load time/weather ymap gating info (MapDataGroups HoursOnOff + WeatherTypes).
        // If missing, gating is a no-op (fail-open).
        try {
            const gates = await fetchJSON('assets/ymap_gates.json', { priority: 'low', usePersistentCache: true });
            if (gates && typeof gates === 'object') {
                this._ymapGates = gates;
                const by = gates.byYmapHash;
                const hasAny = !!(by && typeof by === 'object' && Object.keys(by).length > 0);
                if (hasAny && this.enableTimeWeatherYmapGating) {
                    // ENT1 binary tiles currently don't carry ymap identity, so time/weather gating can't be applied there.
                    // Force JSONL path when gates are present to ensure correctness.
                    this.preferBinary = false;
                    // Worker-side rebuild path currently doesn't apply per-instance ymap gating.
                    // Disable it for correctness when ymap gates are present.
                    this.enableWorkerRebuild = false;
                }
            }
        } catch {
            this._ymapGates = null;
        }

        this.ready = true;
    }

    _cameraToDataSpace(cameraPosVec3, out = null) {
        const o = out || this._tmpVec4Out;
        const v = this._tmpVec4In;
        v[0] = cameraPosVec3[0]; v[1] = cameraPosVec3[1]; v[2] = cameraPosVec3[2]; v[3] = 1.0;
        glMatrix.vec4.transformMat4(o, v, this.invModelMatrix);
        return o;
    }

    _cameraDirToDataSpace(cameraDirVec3, out = null) {
        const o = out || this._tmpVec4Out;
        const v = this._tmpVec4In;
        v[0] = cameraDirVec3[0]; v[1] = cameraDirVec3[1]; v[2] = cameraDirVec3[2]; v[3] = 0.0;
        glMatrix.vec4.transformMat4(o, v, this.invModelMatrix);
        return o;
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

    setWorldBounds(bounds = null) {
        const minX = Number(bounds?.minX);
        const minY = Number(bounds?.minY);
        const maxX = Number(bounds?.maxX);
        const maxY = Number(bounds?.maxY);
        this.worldBounds = [minX, minY, maxX, maxY].every(Number.isFinite) && maxX > minX && maxY > minY
            ? { minX, minY, maxX, maxY }
            : null;
        this._residentCenterChunk = null;
        this._dirty = true;
    }

    setDemoBootstrap(config = null) {
        const instanceFile = String(config?.instanceFile || '').replace(/^assets\//i, '').replace(/^\/+/, '');
        if (!instanceFile) {
            this.demoBootstrap = null;
            this._residentCenterChunk = null;
            this._dirty = true;
            return;
        }
        this.demoBootstrap = {
            key: String(config?.key || '__demo_spawn_district__'),
            instanceFile,
        };
        this._residentCenterChunk = null;
        this._dirty = true;
    }

    _isDataPositionInWorldBounds(x, y) {
        const b = this.worldBounds;
        if (!b) return true;
        return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
    }

    _isChunkInWorldBounds(key) {
        const b = this.worldBounds;
        if (!b) return true;
        const aabb = this._chunkAABBDataSpace(key);
        if (!aabb) return false;
        return aabb.max[0] > b.minX && aabb.min[0] < b.maxX &&
            aabb.max[1] > b.minY && aabb.min[1] < b.maxY;
    }

    _resolveResidentCenterChunk(p, chunkSize) {
        const x = Number(p?.[0]);
        const y = Number(p?.[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !(chunkSize > 0)) return null;

        const nextX = Math.floor(x / chunkSize);
        const nextY = Math.floor(y / chunkSize);
        const previous = this._residentCenterChunk;
        if (!previous || !Number.isFinite(previous.x) || !Number.isFinite(previous.y)) {
            this._residentCenterChunk = { x: nextX, y: nextY };
            return this._residentCenterChunk;
        }

        // Avoid stream ping-pong when a character jitters around a chunk boundary.
        const margin = Math.max(0, Math.min(0.45, Number(this.residencyHysteresisChunks) || 0)) * chunkSize;
        if (
            x >= previous.x * chunkSize - margin &&
            x < (previous.x + 1) * chunkSize + margin &&
            y >= previous.y * chunkSize - margin &&
            y < (previous.y + 1) * chunkSize + margin
        ) return previous;

        this._residentCenterChunk = { x: nextX, y: nextY };
        return this._residentCenterChunk;
    }

    _wantedKeysForCamera(camera, centerDataPos = null) {
        if (!this.index) return [];
        if (this.demoBootstrap) return [this.demoBootstrap.key];
        const chunkSize = this.index.chunk_size;
        const p = centerDataPos
            ? (() => {
                const v = this._tmpVec4Out;
                v[0] = centerDataPos[0]; v[1] = centerDataPos[1]; v[2] = centerDataPos[2]; v[3] = 1.0;
                return v;
            })()
            : this._cameraToDataSpace(camera.position, this._tmpVec4Out);
        const anchor = this._resolveResidentCenterChunk(p, chunkSize);
        if (!anchor) return [];
        const cx = anchor.x;
        const cy = anchor.y;

        const keys = this._tmpWantedKeys;
        keys.length = 0;
        const r = Math.max(0, Math.floor(this.radiusChunks));
        const maxWanted = Math.max(1, Math.floor(Number(this.maxLoadedChunks) || 1));

        // The core is the resident gameplay bubble: nearest-first, always player-centered, never frustum
        // or direction filtered. With the default r=1 / max=9 this is exactly a stable 3x3 block.
        const core = this._tmpWantedScored;
        let coreCount = 0;
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                const key = `${cx + dx}_${cy + dy}`;
                if (!this._isChunkInWorldBounds(key)) continue;
                if (coreCount >= core.length) core.push({ k: '', score: 0 });
                core[coreCount].k = key;
                core[coreCount].score = dx * dx + dy * dy;
                coreCount++;
            }
        }
        core.length = coreCount;
        core.sort((a, b) => a.score - b.score || (a.k < b.k ? -1 : 1));
        for (let i = 0; i < core.length && keys.length < maxWanted; i++) keys.push(core[i].k);
        if (keys.length >= maxWanted) return keys;

        // Larger custom budgets can retain a forward prefetch ring. The resident core above remains intact
        // when the camera turns, so this can improve travel look-ahead without causing local resets.
        const extra = Math.max(0, Math.floor(this.extraFrontChunks || 0));
        if (extra <= 0) return keys;
        const fwd2 = this._cameraDirToDataSpace(camera.direction || [0, 0, -1]);
        const fxyLen2 = Math.hypot(fwd2[0], fwd2[1]) || 1.0;
        const fx2 = fwd2[0] / fxyLen2, fy2 = fwd2[1] / fxyLen2;
        const seen = this._tmpInFrustumSet;
        seen.clear();
        for (const k of keys) seen.add(k);
        const prefetch = [];
        for (let dy = -(r + extra); dy <= (r + extra); dy++) {
            for (let dx = -(r + extra); dx <= (r + extra); dx++) {
                if (Math.abs(dx) <= r && Math.abs(dy) <= r) continue;
                const dot2 = dx * fx2 + dy * fy2;
                const allow = (dot2 >= 0)
                    ? (Math.abs(dx) <= (r + extra) && Math.abs(dy) <= (r + extra))
                    : (Math.abs(dx) <= r && Math.abs(dy) <= r);
                if (!allow) continue;
                const k = `${cx + dx}_${cy + dy}`;
                if (!this._isChunkInWorldBounds(k)) continue;
                if (!seen.has(k)) prefetch.push({ k, score: (dx * dx + dy * dy) - (dot2 * 0.12) });
            }
        }
        prefetch.sort((a, b) => a.score - b.score || (a.k < b.k ? -1 : 1));
        for (let i = 0; i < prefetch.length && keys.length < maxWanted; i++) keys.push(prefetch[i].k);
        return keys;
    }

    /**
     * Public helper for boot-time preload logic.
     * @returns {string[]}
     */
    getWantedKeys(camera, centerDataPos = null) {
        return this._wantedKeysForCamera(camera, centerDataPos);
    }

    _entityToMat4(obj) {
        const o = (obj && typeof obj === 'object') ? obj : {};

        // Accept position as:
        // - [x,y,z]
        // - {x,y,z}
        // - {X,Y,Z} (some exporters)
        const pos0 = o.position ?? o.pos ?? null;
        const pos = (() => {
            if (Array.isArray(pos0) && pos0.length >= 3) return [Number(pos0[0]) || 0, Number(pos0[1]) || 0, Number(pos0[2]) || 0];
            if (pos0 && typeof pos0 === 'object') {
                const x = Number(pos0.x ?? pos0.X ?? 0);
                const y = Number(pos0.y ?? pos0.Y ?? 0);
                const z = Number(pos0.z ?? pos0.Z ?? 0);
                return [Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0, Number.isFinite(z) ? z : 0];
            }
            return [0, 0, 0];
        })();

        // Accept scale as:
        // - [sx,sy,sz]
        // - {x,y,z} or {X,Y,Z}
        // - scaleXY + scaleZ (YMAP-style)
        const scale0 = o.scale ?? o.scl ?? null;
        const scale = (() => {
            if (Array.isArray(scale0) && scale0.length >= 3) return [Number(scale0[0]) || 1, Number(scale0[1]) || 1, Number(scale0[2]) || 1];
            if (scale0 && typeof scale0 === 'object') {
                const x = Number(scale0.x ?? scale0.X ?? 1);
                const y = Number(scale0.y ?? scale0.Y ?? 1);
                const z = Number(scale0.z ?? scale0.Z ?? 1);
                return [Number.isFinite(x) ? x : 1, Number.isFinite(y) ? y : 1, Number.isFinite(z) ? z : 1];
            }
            const sxy = Number(o.scaleXY ?? o.scale_xy ?? o.scale ?? NaN);
            const sz = Number(o.scaleZ ?? o.scale_z ?? NaN);
            if (Number.isFinite(sxy) || Number.isFinite(sz)) {
                const sx = Number.isFinite(sxy) ? sxy : 1.0;
                const sy = Number.isFinite(sxy) ? sxy : 1.0;
                const zz = Number.isFinite(sz) ? sz : 1.0;
                return [sx, sy, zz];
            }
            return [1, 1, 1];
        })();

        // Accept quaternion as:
        // - rotation_quat = [x,y,z,w] (preferred)
        // - rotationQuat / rotation_quaternion variants
        // - rotation = [w,x,y,z] OR [x,y,z,w] (heuristic)
        const q0 =
            o.rotation_quat ?? o.rotationQuat ?? o.rotation_quaternion ?? o.rotationQuaternion ?? o.quat ?? o.quaternion ?? o.rotation ?? null;
        const q = (() => {
            if (Array.isArray(q0) && q0.length >= 4) {
                const a0 = Number(q0[0]), a1 = Number(q0[1]), a2 = Number(q0[2]), a3 = Number(q0[3]);
                // Heuristic: if the first component looks like w (often close to ±1 for identity-ish rotations)
                // and the last component looks like x/y/z (often smaller), treat as [w,x,y,z].
                const abs0 = Math.abs(a0), abs3 = Math.abs(a3);
                const looksLikeWxyz = abs0 > 0.5 && abs3 < 0.75;
                if (looksLikeWxyz) return [a1 || 0, a2 || 0, a3 || 0, a0 || 1]; // -> [x,y,z,w]
                return [a0 || 0, a1 || 0, a2 || 0, a3 || 1];
            }
            if (q0 && typeof q0 === 'object') {
                // object quaternion: {x,y,z,w} or {w,x,y,z}
                const x = Number(q0.x ?? q0.X ?? 0);
                const y = Number(q0.y ?? q0.Y ?? 0);
                const z = Number(q0.z ?? q0.Z ?? 0);
                const w = Number(q0.w ?? q0.W ?? 1);
                if ([x, y, z, w].some((v) => !Number.isFinite(v))) return null;
                return [x, y, z, w];
            }
            return null;
        })(); // [x,y,z,w] or null

        const m = glMatrix.mat4.create();
        glMatrix.mat4.fromTranslation(m, pos);

        if (q && q.length >= 4) {
            // Ensure quaternion is normalized; some exporters/data can be slightly non-unit and cause shear.
            const qq = glMatrix.quat.create();
            glMatrix.quat.set(qq, q[0], q[1], q[2], q[3]);
            glMatrix.quat.normalize(qq, qq);

            // IMPORTANT: YMAP CEntityDef.rotation is stored inverted for normal entities.
            // CodeWalker does:
            //   Orientation = new Quaternion(_CEntityDef.rotation);
            //   if (Orientation != Identity) Orientation = Quaternion.Invert(Orientation);
            //
            // Our exporter currently writes raw CEntityDef.rotation into `rotation_quat`,
            // so we must invert here to get world orientation.
            //
            // Exceptions:
            // - MLO instance entities (is_mlo_instance=true): CodeWalker does NOT invert.
            // - Interior child entities (mlo_parent_guid != 0): exporter uses world `Orientation` already.
            const isMloInstance = !!o.is_mlo_instance;
            const mloParentGuid = (Number(o.mlo_parent_guid ?? o.mloParentGuid ?? o.mloParentGUID ?? 0) >>> 0);
            const shouldInvert = (!isMloInstance) && (mloParentGuid === 0);
            if (shouldInvert) {
                // Inverse of a unit quaternion is its conjugate.
                try {
                    if (glMatrix.quat.conjugate) glMatrix.quat.conjugate(qq, qq);
                    else { qq[0] = -qq[0]; qq[1] = -qq[1]; qq[2] = -qq[2]; }
                } catch {
                    qq[0] = -qq[0]; qq[1] = -qq[1]; qq[2] = -qq[2];
                }
            }
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
        // Layouts:
        // - v0: 16 (mat4)
        // - v1: 17 (mat4 + tintIndex)
        // - v3: 21 (mat4 + tintIndex + guid + mloParentGuid + mloEntitySetHash + mloFlags)
        // - v4: 22 (mat4 + tintIndex + guid + mloParentGuid + mloEntitySetHash + mloFlags + ymapHash)
        if ((n % 22) === 0) return 22;
        if ((n % 21) === 0) return 21;
        if ((n % 17) === 0) return 17;
        return 16;
    }

    _instanceTransformSignature(mats, offset, stride) {
        // Match the worker-side duplicate key. Repeated YMAP records have the
        // same drawable transform and otherwise waste upload/draw budget.
        const q = (index, scale) => {
            const n = Number(mats[offset + index]);
            return Number.isFinite(n) ? Math.round(n * scale) : 0;
        };
        return [
            q(0, 10000), q(1, 10000), q(2, 10000),
            q(4, 10000), q(5, 10000), q(6, 10000),
            q(8, 10000), q(9, 10000), q(10, 10000),
            q(12, 1000), q(13, 1000), q(14, 1000),
            stride >= 17 ? q(16, 1) : 0,
        ].join(',');
    }

    async _ensureMloDefLoaded(archHash) {
        const h = String(archHash ?? '').trim();
        if (!h) return;
        if (this._mloDefs.has(h) || this._mloDefsLoading.has(h)) return;
        this._mloDefsLoading.add(h);
        try {
            const def = await fetchJSON(`assets/interiors/${h}.json`);
            if (def && typeof def === 'object') this._mloDefs.set(h, def);
        } catch {
            // ignore missing interiors defs
        } finally {
            this._mloDefsLoading.delete(h);
        }
    }

    _pointInAABB(p, minV, maxV) {
        return (p[0] >= minV[0] && p[0] <= maxV[0]) &&
               (p[1] >= minV[1] && p[1] <= maxV[1]) &&
               (p[2] >= minV[2] && p[2] <= maxV[2]);
    }

    _computeVisibleRooms(def, startRoomIdx) {
        const rooms = Array.isArray(def?.rooms) ? def.rooms : [];
        const portals = Array.isArray(def?.portals) ? def.portals : [];
        const maxDepth = Math.max(0, Math.min(8, Math.floor(this.interiorPortalDepth || 0)));
        const vis = new Set();
        if (!(Number.isFinite(startRoomIdx) && startRoomIdx >= 0)) return vis;
        vis.add(startRoomIdx);
        if (!this.enableRoomGating || maxDepth <= 0) return vis;

        // Build adjacency from portals.
        /** @type {Map<number, number[]>} */
        const adj = new Map();
        for (const p of portals) {
            const a = Number(p?.roomFrom);
            const b = Number(p?.roomTo);
            if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
            if (a < 0 || b < 0 || a >= rooms.length || b >= rooms.length) continue;
            if (!adj.has(a)) adj.set(a, []);
            if (!adj.has(b)) adj.set(b, []);
            adj.get(a).push(b);
            adj.get(b).push(a);
        }

        /** @type {Array<{r:number,d:number}>} */
        const q = [{ r: startRoomIdx, d: 0 }];
        while (q.length) {
            const { r, d } = q.shift();
            if (d >= maxDepth) continue;
            const ns = adj.get(r) || [];
            for (const n of ns) {
                if (vis.has(n)) continue;
                vis.add(n);
                q.push({ r: n, d: d + 1 });
            }
        }
        return vis;
    }

    _isMloSetEnabled(parentGuid, setHash) {
        if (!this.enableMloEntitySets) return true;
        const pg = (Number(parentGuid) >>> 0);
        const sh = (Number(setHash) >>> 0);
        if (!pg || !sh) return true; // not an entity-set child
        const key = `${pg}:${sh}`;
        const v = this._mloSetOverrides.get(key);
        return (v === undefined) ? true : !!v;
    }

    _filterEntriesForActiveInterior(entries) {
        if (!this.enableInteriors) return entries;

        // Discover MLO instances present in the loaded set (metadata stride=21).
        /** @type {Array<{ parentGuid:number, archHash:string, mat16:Float32Array }>} */
        const mloInstances = [];
        for (const e of entries) {
            const mats = e.mats;
            const stride = this._instanceStrideFloatsForLen(mats.length ?? 0);
            if (stride < 21) continue;
            for (let i = 0; i + 20 < mats.length; i += stride) {
                const flags = (mats[i + 20] >>> 0);
                if ((flags & 1) === 0) continue; // not isMloInstance
                const guid = (mats[i + 17] >>> 0);
                if (!guid) continue;
                // Copy mat4 floats (avoid aliasing into the big array).
                const m = new Float32Array(16);
                for (let k = 0; k < 16; k++) m[k] = mats[i + k];
                mloInstances.push({ parentGuid: guid, archHash: String(e.hash), mat16: m });
                void this._ensureMloDefLoaded(String(e.hash));
            }
        }
        this._mloInstancesLast = mloInstances;

        // Compute active interior (if camera is inside any room AABB in local space).
        let active = null;
        const cam = this._lastCamDataPos || [0, 0, 0];
        for (const inst of mloInstances) {
            const def = this._mloDefs.get(String(inst.archHash));
            if (!def) continue;
            const rooms = Array.isArray(def.rooms) ? def.rooms : [];
            if (rooms.length === 0) continue;

            const inv = glMatrix.mat4.create();
            if (!glMatrix.mat4.invert(inv, inst.mat16)) continue;
            const v4 = glMatrix.vec4.fromValues(cam[0], cam[1], cam[2], 1.0);
            const out = glMatrix.vec4.create();
            glMatrix.vec4.transformMat4(out, v4, inv);
            const local = [out[0], out[1], out[2]];

            let roomIdx = -1;
            for (let ri = 0; ri < rooms.length; ri++) {
                const r = rooms[ri];
                const mn = r?.bbMin;
                const mx = r?.bbMax;
                if (!Array.isArray(mn) || !Array.isArray(mx) || mn.length < 3 || mx.length < 3) continue;
                if (this._pointInAABB(local, mn, mx)) { roomIdx = ri; break; }
            }
            if (roomIdx >= 0) {
                const visibleRooms = this._computeVisibleRooms(def, roomIdx);
                active = { parentGuid: inst.parentGuid, archHash: String(inst.archHash), roomIndex: roomIdx, visibleRooms, invMat: inv };
                break;
            }
        }

        const key = active ? `${active.parentGuid}:${active.archHash}:${active.roomIndex}:${Array.from(active.visibleRooms).sort((a,b)=>a-b).join(',')}` : '';
        this._activeInterior = active;
        this._activeInteriorKey = key;

        // If we are not inside any interior, drop all interior-child instances.
        if (!active) {
            const outEntries = [];
            for (const e of entries) {
                const stride = this._instanceStrideFloatsForLen(e.mats.length ?? 0);
                if (stride < 21) { outEntries.push(e); continue; }
                const filtered = [];
                const a = e.mats;
                for (let i = 0; i + (stride - 1) < a.length; i += stride) {
                    const mloParentGuid = (a[i + 18] >>> 0);
                    if (mloParentGuid) continue; // interior child: hide when not inside
                    for (let k = 0; k < stride; k++) filtered.push(a[i + k]);
                }
                outEntries.push({ ...e, mats: filtered });
            }
            return outEntries;
        }

        // Inside one interior: only render that interior's children, with room + entity-set gating.
        const outEntries = [];
        for (const e of entries) {
            const stride = this._instanceStrideFloatsForLen(e.mats.length ?? 0);
            if (stride < 21) { outEntries.push(e); continue; }
            const filtered = [];
            const a = e.mats;
            for (let i = 0; i + (stride - 1) < a.length; i += stride) {
                const mloParentGuid = (a[i + 18] >>> 0);
                const mloSetHash = (a[i + 19] >>> 0);
                if (mloParentGuid) {
                    if (mloParentGuid !== (active.parentGuid >>> 0)) continue;
                    if (!this._isMloSetEnabled(mloParentGuid, mloSetHash)) continue;

                    if (this.enableRoomGating && active.invMat) {
                        const tx = a[i + 12], ty = a[i + 13], tz = a[i + 14];
                        const v4 = glMatrix.vec4.fromValues(tx, ty, tz, 1.0);
                        const out = glMatrix.vec4.create();
                        glMatrix.vec4.transformMat4(out, v4, active.invMat);
                        const local = [out[0], out[1], out[2]];
                        const def = this._mloDefs.get(String(active.archHash));
                        const rooms = Array.isArray(def?.rooms) ? def.rooms : [];
                        let ri = -1;
                        for (let rj = 0; rj < rooms.length; rj++) {
                            const r = rooms[rj];
                            const mn = r?.bbMin;
                            const mx = r?.bbMax;
                            if (!Array.isArray(mn) || !Array.isArray(mx) || mn.length < 3 || mx.length < 3) continue;
                            if (this._pointInAABB(local, mn, mx)) { ri = rj; break; }
                        }
                        if (ri >= 0 && !active.visibleRooms.has(ri)) continue;
                    }
                }
                for (let k = 0; k < stride; k++) filtered.push(a[i + k]);
            }
            outEntries.push({ ...e, mats: filtered });
        }
        return outEntries;
    }

    _computeActiveInteriorFromCache() {
        if (!this.enableInteriors) return { active: null, key: '' };
        const cam = this._lastCamDataPos || [0, 0, 0];
        for (const inst of (this._mloInstancesLast || [])) {
            const def = this._mloDefs.get(String(inst.archHash));
            if (!def) continue;
            const rooms = Array.isArray(def.rooms) ? def.rooms : [];
            if (rooms.length === 0) continue;

            const inv = glMatrix.mat4.create();
            if (!glMatrix.mat4.invert(inv, inst.mat16)) continue;
            const v4 = glMatrix.vec4.fromValues(cam[0], cam[1], cam[2], 1.0);
            const out = glMatrix.vec4.create();
            glMatrix.vec4.transformMat4(out, v4, inv);
            const local = [out[0], out[1], out[2]];

            let roomIdx = -1;
            for (let ri = 0; ri < rooms.length; ri++) {
                const r = rooms[ri];
                const mn = r?.bbMin;
                const mx = r?.bbMax;
                if (!Array.isArray(mn) || !Array.isArray(mx) || mn.length < 3 || mx.length < 3) continue;
                if (this._pointInAABB(local, mn, mx)) { roomIdx = ri; break; }
            }
            if (roomIdx >= 0) {
                const visibleRooms = this._computeVisibleRooms(def, roomIdx);
                const active = { parentGuid: inst.parentGuid, archHash: String(inst.archHash), roomIndex: roomIdx, visibleRooms };
                const key = `${active.parentGuid}:${active.archHash}:${active.roomIndex}:${Array.from(active.visibleRooms).sort((a,b)=>a-b).join(',')}`;
                return { active, key };
            }
        }
        return { active: null, key: '' };
    }

    /**
     * Best-effort interior query for spawn/grounding:
     * Given a DATA-space position, detect if it lies inside (or near) any known MLO room AABB,
     * and return that room's floor Z in DATA space.
     *
     * This is intentionally conservative and only uses already-loaded interior defs/instances.
     *
     * @param {number[]} posData [x,y,z] in GTA data space
     * @param {{ zPadBelow?: number, zPadAbove?: number, maxRaise?: number }} opts
     * @returns {null | { floorZ:number, inRoom:boolean, delta:number, roomIndex:number, archHash:string, parentGuid:number }}
     */
    getInteriorFloorAtDataPos(posData, opts = {}) {
        try {
            if (!this.enableInteriors) return null;
            if (!posData || posData.length < 3) return null;
            const x = Number(posData[0]);
            const y = Number(posData[1]);
            const z = Number(posData[2]);
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;

            const zPadBelow = Number.isFinite(opts.zPadBelow) ? Math.max(0.0, Math.min(200.0, Number(opts.zPadBelow))) : 12.0;
            const zPadAbove = Number.isFinite(opts.zPadAbove) ? Math.max(0.0, Math.min(200.0, Number(opts.zPadAbove))) : 6.0;
            const maxRaise = Number.isFinite(opts.maxRaise) ? Math.max(0.0, Math.min(500.0, Number(opts.maxRaise))) : 35.0;

            let best = null;
            let bestDelta = Number.POSITIVE_INFINITY;

            for (const inst of (this._mloInstancesLast || [])) {
                const def = this._mloDefs.get(String(inst.archHash));
                if (!def) continue;
                const rooms = Array.isArray(def.rooms) ? def.rooms : [];
                if (rooms.length === 0) continue;

                const inv = glMatrix.mat4.create();
                if (!glMatrix.mat4.invert(inv, inst.mat16)) continue;

                const v4 = glMatrix.vec4.fromValues(x, y, z, 1.0);
                const out = glMatrix.vec4.create();
                glMatrix.vec4.transformMat4(out, v4, inv);
                const lx = out[0], ly = out[1], lz = out[2];

                for (let ri = 0; ri < rooms.length; ri++) {
                    const r = rooms[ri];
                    const mn = r?.bbMin;
                    const mx = r?.bbMax;
                    if (!Array.isArray(mn) || !Array.isArray(mx) || mn.length < 3 || mx.length < 3) continue;

                    // XY must be within the room footprint; Z is allowed a tolerance so we can "snap up"
                    // when the spawn is slightly under the room floor.
                    if (!(lx >= mn[0] && lx <= mx[0] && ly >= mn[1] && ly <= mx[1])) continue;

                    const inRoomStrict = (lz >= mn[2] && lz <= mx[2]);
                    const inRoomPadded = (lz >= (mn[2] - zPadBelow) && lz <= (mx[2] + zPadAbove));
                    if (!inRoomStrict && !inRoomPadded) continue;

                    // Compute world/data-space floor Z at the same local XY.
                    const floorLocal = glMatrix.vec4.fromValues(lx, ly, mn[2], 1.0);
                    const floorOut = glMatrix.vec4.create();
                    glMatrix.vec4.transformMat4(floorOut, floorLocal, inst.mat16);
                    const floorZ = Number(floorOut[2]);
                    if (!Number.isFinite(floorZ)) continue;

                    const delta = floorZ - z;
                    // If we are far above the floor, keep the point "inside" but don't force snapping.
                    // If we are below, only allow snapping up within a reasonable range.
                    if (delta > maxRaise) continue;
                    if (delta < -zPadBelow) continue;

                    // Prefer a true in-room hit immediately (this is strong evidence we should not
                    // terrain-snap, because we'd likely end up below MLO floors).
                    if (inRoomStrict) {
                        return {
                            floorZ,
                            inRoom: true,
                            delta,
                            roomIndex: ri,
                            archHash: String(inst.archHash),
                            parentGuid: (inst.parentGuid >>> 0),
                        };
                    }

                    // Otherwise, pick the nearest non-negative raise (smallest lift).
                    if (delta >= 0.0 && delta < bestDelta) {
                        bestDelta = delta;
                        best = {
                            floorZ,
                            inRoom: false,
                            delta,
                            roomIndex: ri,
                            archHash: String(inst.archHash),
                            parentGuid: (inst.parentGuid >>> 0),
                        };
                    }
                }
            }

            return best;
        } catch {
            return null;
        }
    }

    setMloEntitySetEnabled(parentGuid, setHash, enabled) {
        const pg = (Number(parentGuid) >>> 0);
        const sh = (Number(setHash) >>> 0);
        if (!pg || !sh) return;
        const key = `${pg}:${sh}`;
        this._mloSetOverrides.set(key, !!enabled);
        this._dirty = true;
    }

    clearMloEntitySetOverrides(parentGuid = null) {
        if (parentGuid === null || parentGuid === undefined) {
            this._mloSetOverrides.clear();
        } else {
            const pg = (Number(parentGuid) >>> 0);
            for (const k of Array.from(this._mloSetOverrides.keys())) {
                if (String(k).startsWith(`${pg}:`)) this._mloSetOverrides.delete(k);
            }
        }
        this._dirty = true;
    }

    _safeTintIndex(v) {
        const n0 = Number(v);
        if (!Number.isFinite(n0)) return 0;
        const n = Math.floor(n0);
        return Math.max(0, Math.min(255, n));
    }

    _safeNum(x, fallback = 0.0) {
        const n = Number(x);
        return Number.isFinite(n) ? n : fallback;
    }

    _dist3(ax, ay, az, bx, by, bz) {
        const dx = ax - bx;
        const dy = ay - by;
        const dz = az - bz;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    _updateFrustumPlanesData(camera) {
        if (!this.enableFrustumCulling || !this.enableWorkerFrustumCulling || !camera?.viewProjectionMatrix) {
            this._lastFrustumPlanesData = null;
            return null;
        }
        try {
            // Extract planes in data space: clip = VP * modelMatrix * dataPosition.
            glMatrix.mat4.multiply(this._tmpVpData, camera.viewProjectionMatrix, this.modelMatrix);
            const planes = extractFrustumPlanes(this._tmpVpData, this._tmpFrustumPlanes);
            const flat = this._tmpFrustumPlanesFlat;
            for (let i = 0; i < 6; i++) {
                const p = planes[i];
                flat[i * 4 + 0] = Number(p?.[0]) || 0;
                flat[i * 4 + 1] = Number(p?.[1]) || 0;
                flat[i * 4 + 2] = Number(p?.[2]) || 0;
                flat[i * 4 + 3] = Number(p?.[3]) || 0;
            }
            this._lastFrustumPlanesData = flat.slice(0);
            return this._lastFrustumPlanesData;
        } catch {
            this._lastFrustumPlanesData = null;
            return null;
        }
    }

    _sphereIntersectsDataFrustum(x, y, z, radius) {
        const planes = this._lastFrustumPlanesData;
        if (!planes || planes.length < 24) return true;
        const r = Math.max(0.0, Number(radius) || 0.0);
        for (let i = 0; i < 6; i++) {
            const o = i * 4;
            if ((planes[o] * x + planes[o + 1] * y + planes[o + 2] * z + planes[o + 3]) < -r) return false;
        }
        return true;
    }

    _instanceMaxScale(arr, offset) {
        const sx = Math.hypot(Number(arr[offset + 0]) || 0, Number(arr[offset + 1]) || 0, Number(arr[offset + 2]) || 0);
        const sy = Math.hypot(Number(arr[offset + 4]) || 0, Number(arr[offset + 5]) || 0, Number(arr[offset + 6]) || 0);
        const sz = Math.hypot(Number(arr[offset + 8]) || 0, Number(arr[offset + 9]) || 0, Number(arr[offset + 10]) || 0);
        const s = Math.max(sx, sy, sz);
        return Number.isFinite(s) && s > 0 ? s : 1.0;
    }

    _buildFrustumCullRadiusEntries() {
        if (!this.enableFrustumCulling || !this.enableWorkerFrustumCulling) return [];
        const maxArch = Math.max(1, Math.floor(Number(this.maxArchetypes) || 512));
        const limit = Math.max(1024, Math.min(12000, maxArch * 16));
        try {
            return this.modelManager?.getApproxRadiusEntries?.({ limit }) ?? [];
        } catch {
            return [];
        }
    }

    _entityKeyFromObj(obj) {
        const ymap = String(obj?.ymap || '').trim();
        // Prefer the canonical (ymap, ymap_entity_index) key (matches CodeWalker entity indices).
        const idx = Number(obj?.ymap_entity_index);
        if (!ymap) return null;
        if (!Number.isFinite(idx) || idx < 0) return null;
        return `${ymap}|${(idx | 0)}`;
    }

    _entityKeyFallback(obj, chunkKey, lineNo) {
        // Best-effort fallback when exports don't include `ymap_entity_index`.
        // This enables the "entity LOD traversal" code path to still *render something*
        // (as a flat leaf set) instead of silently drawing nothing.
        const ymap = String(obj?.ymap || '').trim();
        if (!ymap) return null;

        // If we have a GUID, prefer a stable key so entities don't churn between sessions/loads.
        // Note: without ymap_entity_index + parent_index we cannot reconstruct hierarchy, but
        // at least we can keep a deterministic identity for instancing/caching.
        const guid0 = obj?.guid ?? obj?.GUID ?? obj?.Guid ?? null;
        const guid = (guid0 === null || guid0 === undefined) ? '' : String(guid0).trim();
        // Ignore sentinel/invalid GUIDs (0 is very common for interior child entities).
        if (guid && guid !== '0') return `${ymap}|guid:${guid}`;

        // Interior child entities often have ymap_entity_index=-1 and guid=0, but do have a parent MLO guid.
        // Build a reasonably stable key from (mlo_parent_guid, archetype/name, quantized position).
        const mpg0 = obj?.mlo_parent_guid ?? obj?.mloParentGuid ?? obj?.mlo_parent_GUID ?? obj?.mloParentGUID ?? null;
        const mpg = (mpg0 === null || mpg0 === undefined) ? '' : String(mpg0).trim();
        if (mpg && mpg !== '0') {
            const name = String(obj?.name ?? obj?.Name ?? '').trim();
            const arch = String(obj?.archetype_hash ?? obj?.archetypeHash ?? obj?.archetype ?? '').trim();
            const p = Array.isArray(obj?.position) ? obj.position : [0, 0, 0];
            const qx = Number(p?.[0] ?? 0), qy = Number(p?.[1] ?? 0), qz = Number(p?.[2] ?? 0);
            const q = (v) => {
                const n = Number(v);
                if (!Number.isFinite(n)) return '0';
                // quantize to mm to avoid float noise but stay stable
                return String(Math.round(n * 1000) / 1000);
            };
            return `${ymap}|mlo:${mpg}|a:${arch}|n:${name}|p:${q(qx)},${q(qy)},${q(qz)}`;
        }

        const n = Number(lineNo);
        const ln = Number.isFinite(n) ? (n | 0) : 0;
        return `${ymap}|__chunk:${String(chunkKey || '')}__line:${ln}`;
    }

    _addPendingChild(parentKey, childKey) {
        if (!parentKey || !childKey) return;
        let s = this._pendingChildrenByParentKey.get(parentKey);
        if (!s) {
            s = new Set();
            this._pendingChildrenByParentKey.set(parentKey, s);
        }
        s.add(childKey);
    }

    _removePendingChild(parentKey, childKey) {
        if (!parentKey || !childKey) return;
        const s = this._pendingChildrenByParentKey.get(parentKey);
        if (!s) return;
        s.delete(childKey);
        if (s.size === 0) this._pendingChildrenByParentKey.delete(parentKey);
    }

    _removeChunkEntities(chunkKey) {
        const keys = this._chunkEntityKeys.get(chunkKey);
        if (!keys) return;
        for (const k of keys) {
            const node = this._entityNodesByKey.get(k);
            if (!node) continue;

            if (node.parentKey) {
                const p = this._entityNodesByKey.get(node.parentKey);
                if (p && p.children) p.children.delete(k);
                this._removePendingChild(node.parentKey, k);
            }

            // Children remain pending on missing parent so they won't be treated as roots.
            if (node.children && node.children.size > 0) {
                for (const ck of node.children) {
                    const cn = this._entityNodesByKey.get(ck);
                    if (cn && cn.parentKey === k) this._addPendingChild(k, ck);
                }
            }

            this._entityNodesByKey.delete(k);
        }
        this._chunkEntityKeys.delete(chunkKey);
        this._dirtyEntityLod = true;
    }

    async _loadChunk(key, { priority = 'high' } = {}) {
        if (!this.index) return;
        const isDemoBootstrap = !!this.demoBootstrap && key === this.demoBootstrap.key;
        const meta = isDemoBootstrap ? { file: this.demoBootstrap.instanceFile } : (this.index.chunks || {})[key];
        if (!meta) return;

        if (this.loaded.has(key) || this.loading.has(key)) return;
        this.loading.add(key);
        const controller = new AbortController();
        const token = (this._chunkLoadNextToken++ >>> 0);
        this._chunkLoadReqs.set(key, { controller, token });
        const signal = controller.signal;

        try {
            const bust = this._chunkCacheBust ? `?v=${encodeURIComponent(this._chunkCacheBust)}` : '';
            const jsonlPath = isDemoBootstrap ? '' : `assets/${this.index.chunks_dir}/${meta.file}${bust}`;

            // Entity-level LOD traversal needs hierarchy fields (not present in ENT1 bins),
            // so we always parse JSONL in this mode.
            if (this.enableEntityLodTraversal && !isDemoBootstrap) {
                const camData = this._cameraToDataSpace(window.__appCameraPosForDrawableStreamer || [0, 0, 0]);
                const cx = this._safeNum(camData?.[0], 0.0);
                const cy = this._safeNum(camData?.[1], 0.0);
                const cz = this._safeNum(camData?.[2], 0.0);

                const chunkKeys = new Set();
                const newHashes = new Set();
                let totalLines = 0;
                let parsed = 0;
                let withArchetype = 0;
                let badKey = 0;
                let badArchetype = 0;
                let usedFallbackKeys = 0;

                await fetchNDJSON(jsonlPath, {
                    usePersistentCache: this.usePersistentCacheForChunks,
                    priority,
                    signal,
                    onObject: (obj) => {
                        totalLines++;
                        if (!obj) return;
                        parsed++;
                        const pos0 = obj?.position || obj?.pos || [0, 0, 0];
                        if (!this._isDataPositionInWorldBounds(Number(pos0[0]), Number(pos0[1]))) return;

                        const a = obj?.archetype;
                        if (a === undefined || a === null) return;
                        withArchetype++;

                        let nodeKey = this._entityKeyFromObj(obj);
                        if (!nodeKey) {
                            // If the export omitted `ymap_entity_index`, we can still build instances
                            // (but we can't reconstruct parent/child hierarchy).
                            nodeKey = this._entityKeyFallback(obj, key, totalLines);
                            if (nodeKey) {
                                usedFallbackKeys++;
                                if (!warnedMissingHierarchy) {
                                    warnedMissingHierarchy = true;
                                    console.warn(
                                        'Entity LOD traversal: some entities have missing/invalid `ymap_entity_index` (eg -1) and cannot fully participate in parent/child traversal. ' +
                                        'Using fallback per-entity keys (prefers nonzero `guid`, otherwise MLO-parent + name/pos). ' +
                                        'Those entities will be treated as flat leaves (no parent/child traversal). ' +
                                        'To get full CodeWalker-style traversal, re-export entities_chunks with hierarchy fields.'
                                    );
                                }
                            } else {
                                badKey++;
                                return;
                            }
                        }

                        const hash = this.modelManager?.normalizeId?.(a);
                        if (!hash) {
                            badArchetype++;
                            return;
                        }
                        newHashes.add(hash);

                        const ymap = String(obj?.ymap || '').trim();
                        const ymapEntityIndex = Number(obj?.ymap_entity_index);
                        const hasCanonicalKey =
                            !!ymap &&
                            Number.isFinite(ymapEntityIndex) &&
                            ymapEntityIndex >= 0 &&
                            nodeKey === `${ymap}|${(ymapEntityIndex | 0)}`;
                        const parentIndex = Number(obj?.parent_index);
                        const rawFlags = Number(obj?.flags ?? 0);
                        // CodeWalker: LodInParentYmap is flags bit 3 (0x8).
                        const lodInParentYmap = Number.isFinite(rawFlags) ? ((((rawFlags >>> 0) >>> 3) & 1) !== 0) : false;

                        // If exports omitted canonical hierarchy identity (`ymap_entity_index`), treat as a root.
                        // We do NOT attempt best-effort parent linking for fallback-keyed entities because their
                        // identity is not CodeWalker-compatible and can churn/collide across loads.
                        let parentKey = (hasCanonicalKey && !lodInParentYmap && Number.isFinite(parentIndex) && parentIndex >= 0)
                            ? `${ymap}|${(parentIndex | 0)}`
                            : null;
                        const numChildren = Number(obj?.num_children);

                        const lodLevelStr = String(obj?.lod_level ?? obj?.lodLevel ?? '').trim();
                        const lodLevelRank = this._lodLevelRank(lodLevelStr);

                        const pp = obj?.position || [0, 0, 0];
                        const px = this._safeNum(pp?.[0], 0.0);
                        const py = this._safeNum(pp?.[1], 0.0);
                        const pz = this._safeNum(pp?.[2], 0.0);

                        const dist = this._dist3(px, py, pz, cx, cy, cz);
                        const lodDistRaw = this._safeNum(obj?.lod_dist, 0.0);
                        const childLodDistRaw = this._safeNum(obj?.child_lod_dist, 0.0);
                        const fallbackLod = Number.isFinite(this.maxModelDistance) ? Math.max(0, this.maxModelDistance) : 350.0;
                        // CodeWalker: if entity.lodDist<=0 => use archetype.LodDist. Approximate via model manifest.
                        const archLodFallback = this._fallbackEntityLodDistForHash(hash);
                        const lodDist = (lodDistRaw > 0.0)
                            ? lodDistRaw
                            : (Number.isFinite(archLodFallback) ? archLodFallback : ((childLodDistRaw > 0.0) ? childLodDistRaw : fallbackLod));
                        // CodeWalker: if childLodDist<0 => lodDist*0.5. Our exports often use 0 when unknown,
                        // so treat <=0 as "default" instead of "never show children".
                        const childLodDist = (childLodDistRaw > 0.0)
                            ? childLodDistRaw
                            : (Number(lodDist) * 0.5);

                        const m16 = this._entityToMat4(obj);
                        const mat17 = new Float32Array(17);
                        mat17.set(m16, 0);
                        mat17[16] = this._safeTintIndex(obj?.tintIndex ?? obj?.tint);

                        const node = {
                            key: nodeKey,
                            hash,
                            ymap,
                            parentKey,
                            numChildren: (Number.isFinite(numChildren) ? Math.max(0, (numChildren | 0)) : 0),
                            lodDist,
                            childLodDist,
                            lodInParentYmap,
                            lodLevelStr,
                            lodLevelRank,
                            px, py, pz,
                            dist,
                            mat17,
                            children: new Set(),
                        };

                        // Apply CodeWalker parent rejection rules (lodLevel ordering + ORPHANHD special).
                        // If the parent isn't loaded yet, we will re-check when resolving pending children.
                        if (node.parentKey) {
                            const p = this._entityNodesByKey.get(node.parentKey);
                            if (p && this._isInvalidParentLinkCodeWalkerStyle(p, node)) {
                                node.parentKey = null;
                                parentKey = null;
                            }
                        }

                        // If we're replacing an existing node, detach it from any old parent links.
                        const prev = this._entityNodesByKey.get(nodeKey);
                        if (prev && prev.parentKey && prev.parentKey !== parentKey) {
                            const p = this._entityNodesByKey.get(prev.parentKey);
                            if (p && p.children) p.children.delete(nodeKey);
                            this._removePendingChild(prev.parentKey, nodeKey);
                        }

                        this._entityNodesByKey.set(nodeKey, node);
                        chunkKeys.add(nodeKey);

                        // Attach to parent if present (or pend until parent loads).
                        if (parentKey) {
                            const p = this._entityNodesByKey.get(parentKey);
                            if (p && p.children) {
                                // Reject invalid links immediately when parent is available.
                                if (!this._isInvalidParentLinkCodeWalkerStyle(p, node)) {
                                    p.children.add(nodeKey);
                                } else {
                                    node.parentKey = null;
                                    parentKey = null;
                                }
                            } else {
                                this._addPendingChild(parentKey, nodeKey);
                            }
                        }

                        // If any children were waiting for us, attach them now.
                        const pending = this._pendingChildrenByParentKey.get(nodeKey);
                        if (pending && pending.size > 0) {
                            for (const ck of pending) {
                                const child = this._entityNodesByKey.get(ck);
                                if (child && this._isInvalidParentLinkCodeWalkerStyle(node, child)) {
                                    // Promote child to root instead of linking.
                                    child.parentKey = null;
                                    continue;
                                }
                                node.children.add(ck);
                            }
                            this._pendingChildrenByParentKey.delete(nodeKey);
                        }
                    },
                });

                // Prefetch mesh meta for discovered hashes so real meshes appear ASAP.
                for (const h of newHashes) {
                    try { this.modelManager?.prefetchMeta?.(h); } catch { /* ignore */ }
                }

                if (usedFallbackKeys > 0 && this.warnEntityLodTraversalMissingHierarchy && !this._warnedEntityLodTraversalMissingHierarchy) {
                    this._warnedEntityLodTraversalMissingHierarchy = true;
                    console.warn(
                        `Entity LOD traversal: ${usedFallbackKeys} entities in chunk ${String(key)} have missing/invalid ymap_entity_index (e.g. -1), so they cannot participate in CodeWalker-style parent/child traversal. ` +
                        `They are rendered as flat leaves (no parent/child traversal). ` +
                        `To get full traversal, re-export assets/entities_chunks/*.jsonl with hierarchy fields: ymap_entity_index, parent_index, num_children, flags (LodInParentYmap), lod_dist, child_lod_dist, lod_level.`
                    );
                }

                this._chunkEntityKeys.set(key, chunkKeys);
                this.loaded.add(key);
                this._dirty = true;
                this._dirtyEntityLod = true;
                this.lastLoadStats = {
                    key,
                    totalLines,
                    parsed,
                    withArchetype,
                    badArchetype,
                    entityLodMode: true,
                    nodes: chunkKeys.size,
                    badKey,
                    usedFallbackKeys,
                };
                return;
            }

            const byHash = new Map(); // hash -> number[] mats
            const minDistByHash = new Map(); // hash -> number
            let archetypeCounts = new Map(); // hash -> count
            const camData = this._cameraToDataSpace(window.__appCameraPosForDrawableStreamer || [0, 0, 0]);
            let workerResult = null;

            // Try binary instance tile first: assets/entities_chunks_inst/<chunk>.bin
            // Format (ENT1):
            // - 4 bytes: 'ENT1'
            // - u32: count
            // - count records: v1 <I3f4f3f> = archetypeHash, pos(xyz), quat(xyzw), scale(xyz)
            // - v2 <I3f4f3fI> adds u32 tintIndex after scale (stride=48).
            // - v3 <I3f4f3f5I> adds u32 tintIndex + guid + mloParentGuid + mloEntitySetHash + flags (stride=64).
            let usedBinary = false;
            if (this.preferBinary || isDemoBootstrap) {
                try {
                    const binFile = String(meta.file || '').replace(/\.jsonl$/i, '.bin');
                    const binPath = isDemoBootstrap ? `assets/${binFile}` : `assets/entities_chunks_inst/${binFile}`;
                    const buf = await fetchArrayBufferWithPriority(binPath, { priority, usePersistentCache: this.usePersistentCacheForChunks, signal });
                    const dv = new DataView(buf);
                    if (dv.byteLength >= 8) {
                        const magic =
                            String.fromCharCode(dv.getUint8(0)) +
                            String.fromCharCode(dv.getUint8(1)) +
                            String.fromCharCode(dv.getUint8(2)) +
                            String.fromCharCode(dv.getUint8(3));
                        if (magic === 'ENT1') {
                            const count = dv.getUint32(4, true);
                            // v1 stride=44, v2 stride=48 (tintIndex), v3 stride=64 (mlo metadata)
                            const stride = (dv.byteLength >= (8 + count * 64)) ? 64 : ((dv.byteLength >= (8 + count * 48)) ? 48 : 44);
                            const start = 8;
                            const need = start + count * stride;
                            if (count >= 0 && need <= dv.byteLength) {
                                usedBinary = true;

                                // Prefer worker path: parse + build matrices off-thread.
                                try {
                                    const wr = await this._parseENT1InWorker(
                                        buf.slice(0),
                                        [camData[0], camData[1], camData[2]],
                                        {
                                            storeKey: key,
                                            storeOnly: !!this.enableWorkerRebuild,
                                            worldBounds: this.worldBounds,
                                            onReqId: (rid) => {
                                                const live = this._chunkLoadReqs.get(key);
                                                if (live && live.token === token) live.workerReqId = (Number(rid) >>> 0);
                                            },
                                        }
                                    );
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
                                        if (!this._isDataPositionInWorldBounds(px, py)) continue;

                                        const qx = dv.getFloat32(off + 16, true);
                                        const qy = dv.getFloat32(off + 20, true);
                                        const qz = dv.getFloat32(off + 24, true);
                                        const qw = dv.getFloat32(off + 28, true);

                                        const sx = dv.getFloat32(off + 32, true);
                                        const sy = dv.getFloat32(off + 36, true);
                                        const sz = dv.getFloat32(off + 40, true);
                                        const tintIndex = (stride >= 48) ? (dv.getUint32(off + 44, true) >>> 0) : 0;
                                        const guid = (stride >= 64) ? (dv.getUint32(off + 48, true) >>> 0) : 0;
                                        const mloParentGuid = (stride >= 64) ? (dv.getUint32(off + 52, true) >>> 0) : 0;
                                        const mloSetHash = (stride >= 64) ? (dv.getUint32(off + 56, true) >>> 0) : 0;
                                        const mloFlags = (stride >= 64) ? (dv.getUint32(off + 60, true) >>> 0) : 0;

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
                                        // v3 metadata (always present in our in-memory layout; zeros for older bins)
                                        arr.push(Number(guid >>> 0));
                                        arr.push(Number(mloParentGuid >>> 0));
                                        arr.push(Number(mloSetHash >>> 0));
                                        arr.push(Number(mloFlags >>> 0));
                                        // v4 metadata: ymap hash (ENT1 bins don't carry it today).
                                        arr.push(0);
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    if (isDemoBootstrap) throw e;
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
                    const wr = await this._parseChunkNDJSONInWorker(
                        jsonlPath,
                        [camData[0], camData[1], camData[2]],
                        priority,
                        {
                            storeKey: key,
                            storeOnly: !!this.enableWorkerRebuild,
                            worldBounds: this.worldBounds,
                            signal,
                            onReqId: (rid) => {
                                const live = this._chunkLoadReqs.get(key);
                                if (live && live.token === token) live.workerReqId = (Number(rid) >>> 0);
                            },
                        }
                    );
                    if (wr && wr.ok) workerResult = wr;
                } catch (e) {
                    workerResult = null;
                    // IMPORTANT: aborts are expected when chunks fall out of the wanted set.
                    // Do NOT warn and do NOT fall back to main-thread parsing (that just creates hitching).
                    if (signal?.aborted || String(e?.name || '') === 'AbortError') {
                        throw e;
                    }
                    try {
                        globalThis.__viewerWarnOnce?.(
                            `worker_ndjson_fail:${String(key)}`,
                            'DrawableStreamer: worker NDJSON parse failed; falling back to main thread for this chunk.',
                            { chunk: key, err: String(e?.message || e || '') }
                        );
                    } catch { /* ignore */ }
                    try {
                        globalThis.__viewerReportError?.({
                            subsystem: 'drawableStreamer',
                            level: 'warn',
                            message: 'worker NDJSON parse failed; fell back to main thread',
                            detail: { chunk: key, err: String(e?.message || e || '') },
                        });
                    } catch { /* ignore */ }
                }

                if (!workerResult) {
                    await fetchNDJSON(jsonlPath, {
                        usePersistentCache: this.usePersistentCacheForChunks,
                        priority,
                        signal,
                        onObject: (obj) => {
                            totalLines++;
                            parsed++;
                            const a =
                                obj?.archetype ??
                                obj?.archetype_hash ??
                                obj?.archetypeHash ??
                                obj?.archetype_id ??
                                obj?.archetypeId ??
                                obj?.archetypeHash32 ??
                                null;
                            if (a === undefined || a === null) return;
                            const pp = obj.position || obj.pos || [0, 0, 0];
                            if (!this._isDataPositionInWorldBounds(Number(pp[0]), Number(pp[1]))) return;
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
                            // v3 metadata (always present in our in-memory layout; zeros if absent)
                            const mloParentGuid = (Number(obj?.mlo_parent_guid ?? 0) >>> 0);
                            const mloSetHash = (Number(obj?.mlo_entity_set_hash ?? 0) >>> 0);
                            const flags =
                                ((obj?.is_mlo_instance ? 1 : 0) >>> 0) |
                                ((mloParentGuid ? 1 : 0) << 1) |
                                ((mloSetHash ? 1 : 0) << 2);
                            arr.push(Number((Number(obj?.guid ?? 0) >>> 0)));
                            arr.push(Number(mloParentGuid));
                            arr.push(Number(mloSetHash));
                            arr.push(Number(flags >>> 0));
                            // v4 metadata: ymap hash (needed for time/weather gating; computed from path if absent).
                            const ymapHash =
                                (Number(obj?.ymap_hash ?? obj?.ymapHash ?? obj?.ymap_hash32 ?? 0) >>> 0) ||
                                this._ymapHashFromPath(obj?.ymap);
                            arr.push(Number(ymapHash >>> 0));
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

                if (workerResult.stored) {
                    // Chunk instance data is stored inside the worker; we only keep summary maps on main.
                    this._workerStoredChunks.add(key);
                    chunkMap = null;
                } else {
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
                                const mats = new Float32Array(buf, offFloats * 4, lenFloats);
                                // Validate worker-produced instance buffer shape + sanity.
                                // If this is corrupted (wrong stride / NaNs), it can cause the whole frame to appear grey
                                // because shader math can produce NaNs and some drivers propagate that.
                                const stride =
                                    ((mats.length % 22) === 0) ? 22 :
                                    (((mats.length % 21) === 0) ? 21 :
                                    (((mats.length % 17) === 0) ? 17 : 16));
                                const instCount = Math.floor(mats.length / stride);
                                if (!(instCount > 0) || (instCount * stride) !== mats.length) {
                                    console.warn(`DrawableStreamer: bad instance buffer shape for hash=${hash} (lenFloats=${mats.length}, stride=${stride}, inst=${instCount})`);
                                    continue;
                                }
                                // Quick finite check over a small prefix (enough to catch NaNs/infs early).
                                let bad = false;
                                const lim = Math.min(mats.length, Math.min(512, stride * Math.min(instCount, 8)));
                                for (let i = 0; i < lim; i++) {
                                    const v = mats[i];
                                    if (!Number.isFinite(v)) { bad = true; break; }
                                }
                                if (bad) {
                                    console.warn(`DrawableStreamer: non-finite instance data for hash=${hash} (dropping this archetype for this chunk)`);
                                    continue;
                                }
                                chunkMap.set(hash, mats);
                            } catch {
                                // ignore bad slice
                            }
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
            // Drop stale/aborted loads before mutating any state.
            const live = this._chunkLoadReqs.get(key);
            if (!live || live.token !== token || signal.aborted) {
                return;
            }

            // When worker-stored, we don't keep per-chunk instance buffers on the main thread.
            if (chunkMap) this.chunkInstances.set(key, chunkMap);
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
                instancedArchetypes: chunkMap ? chunkMap.size : Number(workerResult?.instancedArchetypes ?? 0),
                badArchetype,
                missingMeshEntities,
                unknownMetaEntities,
                usedBinary,
            };
        } catch (e) {
            // Ignore aborts: these are expected when chunks fall out of the wanted set.
            if (String(e?.name || '') !== 'AbortError') {
                console.warn(`Drawable chunk load failed ${key}:`, e);
            }
        } finally {
            this.loading.delete(key);
            const live = this._chunkLoadReqs.get(key);
            if (live && live.token === token) this._chunkLoadReqs.delete(key);
        }
    }

    _computeCoverageStats({ keptArchetypes = null, droppedArchetypes = null, totalMeshArchetypes = null, keptInstances = null, totalMeshInstances = null, keptRealArchetypes = null, keptPlaceholderArchetypes = null, duplicateInstancesDropped = 0 } = {}) {
        // Aggregate unexported archetypes + totals across loaded chunks.
        let entitiesWithArchetype = 0;
        const allArchetypes = new Set();
        const missingAgg = new Map(); // hash -> count (known missing)
        const nonRenderableAgg = new Map(); // hash -> count (valid, intentionally drawable-less)
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
                    } else if (this.modelManager?.isNonRenderable?.(hash)) {
                        nonRenderableAgg.set(hash, (nonRenderableAgg.get(hash) ?? 0) + (cnt ?? 0));
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
        const nonRenderableTop = Array.from(nonRenderableAgg.entries())
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
            nonRenderableEntities: nonRenderableTop.reduce((acc, e) => acc + (e.count ?? 0), 0),
            nonRenderableArchetypes: nonRenderableAgg.size,
            nonRenderableTop: nonRenderableTop.slice(0, 50),
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
            duplicateInstancesDropped: Math.max(0, Math.floor(Number(duplicateInstancesDropped) || 0)),
            frustumCullingEnabled: !!this._lastFrustumStats?.enabled,
            frustumTestedInstances: Math.max(0, Math.floor(Number(this._lastFrustumStats?.tested) || 0)),
            frustumCulledInstances: Math.max(0, Math.floor(Number(this._lastFrustumStats?.culled) || 0)),
            wasmCullingEnabled: !!this._lastWasmStats?.enabled,
            wasmCullingTestedInstances: Math.max(0, Math.floor(Number(this._lastWasmStats?.tested) || 0)),
            wasmCullingKeptInstances: Math.max(0, Math.floor(Number(this._lastWasmStats?.kept) || 0)),
            wasmCullingRejectedInstances: Math.max(0, Math.floor(Number(this._lastWasmStats?.rejected) || 0)),
            webGpuCullingEnabled: !!this._lastWebGpuStats?.enabled,
            webGpuCullingRequested: !!this._lastWebGpuStats?.requested,
            webGpuCullingReason: String(this._lastWebGpuStats?.reason || ''),
            webGpuCullingTestedInstances: Math.max(0, Math.floor(Number(this._lastWebGpuStats?.tested) || 0)),
            webGpuCullingKeptInstances: Math.max(0, Math.floor(Number(this._lastWebGpuStats?.kept) || 0)),
            webGpuCullingRejectedInstances: Math.max(0, Math.floor(Number(this._lastWebGpuStats?.rejected) || 0)),
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
        const minD = new Map(); // hash -> number (from current camera)
        const bestDot = new Map(); // hash -> dot(camForward, toClosestInstance)
        const bestDist2 = new Map(); // hash -> number
        const seenTransformsByHash = new Map(); // hash -> Set<quantized transform>
        let sourceInstanceCount = 0;
        let duplicateInstancesDropped = 0;

        const cam = this._lastCamDataPos || [0, 0, 0];
        const fwd0 = this._lastCamDataDir || [0, 0, -1];
        const fwdLen = Math.hypot(fwd0[0], fwd0[1], fwd0[2]) || 1.0;
        const fx = fwd0[0] / fwdLen, fy = fwd0[1] / fwdLen, fz = fwd0[2] / fwdLen;
        const behindPenalty = Number.isFinite(Number(this.cameraBehindPenalty)) ? Math.max(1.0, Number(this.cameraBehindPenalty)) : 1.6;
        const useFrustum = !!(this.enableFrustumCulling && this.enableWorkerFrustumCulling && this._lastFrustumPlanesData);
        const frustumPadding = Math.max(0.0, Number(this.workerFrustumPadding) || 0.0);
        let frustumTested = 0;
        let frustumCulled = 0;

        for (const key of this.loaded) {
            const cmap = this.chunkInstances.get(key);
            if (!cmap) continue;
            for (const [hash, mats] of cmap.entries()) {
                let arr = agg.get(hash);
                if (!arr) {
                    arr = [];
                    agg.set(hash, arr);
                }
                const stride = this._instanceStrideFloatsForLen(mats.length ?? 0);
                const radiusRaw = useFrustum ? Number(this.modelManager?.getApproxRadiusForHash?.(hash, null, null)) : NaN;
                const hasFrustumRadius = Number.isFinite(radiusRaw) && radiusRaw > 0;
                const baseRadius = hasFrustumRadius ? Math.max(0.5, radiusRaw) : 0.0;
                for (let i = 0; i + (stride - 1) < mats.length; i += stride) {
                    // Time/weather ymap gating is evaluated per-instance (fail-open if unknown).
                    if (stride >= 22) {
                        const ymapHash = Number(mats[i + (stride - 1)] ?? 0) >>> 0;
                        if (!this._isYmapAvailableHash(ymapHash)) continue;
                    }
                    sourceInstanceCount++;
                    const tx = Number(mats[i + 12] ?? 0);
                    const ty = Number(mats[i + 13] ?? 0);
                    const tz = Number(mats[i + 14] ?? 0);
                    if (hasFrustumRadius) {
                        frustumTested++;
                        const radius = baseRadius * Math.max(1.0, this._instanceMaxScale(mats, i)) + frustumPadding;
                        if (!this._sphereIntersectsDataFrustum(tx, ty, tz, radius)) {
                            frustumCulled++;
                            continue;
                        }
                    }
                    let seenTransforms = seenTransformsByHash.get(hash);
                    if (!seenTransforms) {
                        seenTransforms = new Set();
                        seenTransformsByHash.set(hash, seenTransforms);
                    }
                    const transformKey = this._instanceTransformSignature(mats, i, stride);
                    if (seenTransforms.has(transformKey)) {
                        duplicateInstancesDropped++;
                        continue;
                    }
                    seenTransforms.add(transformKey);
                    const dx = tx - Number(cam[0] ?? 0);
                    const dy = ty - Number(cam[1] ?? 0);
                    const dz = tz - Number(cam[2] ?? 0);
                    const dist2 = dx * dx + dy * dy + dz * dz;

                    const prev2 = bestDist2.get(hash);
                    if (prev2 === undefined || dist2 < prev2) {
                        bestDist2.set(hash, dist2);
                        minD.set(hash, Math.sqrt(dist2));
                        bestDot.set(hash, dx * fx + dy * fy + dz * fz);
                    }

                    for (let k = 0; k < stride; k++) arr.push(mats[i + k]);
                }
            }
        }
        this._lastFrustumStats = { enabled: useFrustum, tested: frustumTested, culled: frustumCulled };
        this._lastWasmStats = { enabled: false, tested: 0, kept: 0, rejected: 0 };
        this._lastWebGpuStats = { enabled: false, requested: false, reason: '', tested: 0, kept: 0, rejected: 0 };

        // Distance-first selection (closest archetypes first), but prefer REAL meshes over placeholders
        // so placeholders don't crowd out real geometry under maxArchetypes.
        const entries = Array.from(agg.entries())
            .filter(([, mats]) => Array.isArray(mats) && mats.length > 0)
            .map(([hash, mats]) => ({
            hash,
            mats,
            d: minD.get(hash) ?? 1e30,
            dot: bestDot.get(hash) ?? 0.0,
            isPlaceholder: !(this.modelManager?.hasRealMesh?.(hash) ?? true),
        }));

        this._applyRebuiltEntries(entries, { behindPenalty, sourceInstanceCount, duplicateInstancesDropped });
    }

    _limitInstancesForRendering(entriesIn) {
        const entries = Array.isArray(entriesIn) ? entriesIn : [];
        const cam = this._lastCamDataPos || [0, 0, 0];
        const fwd0 = this._lastCamDataDir || [0, 0, -1];
        const fwdLen = Math.hypot(fwd0[0], fwd0[1], fwd0[2]) || 1.0;
        const fx = fwd0[0] / fwdLen, fy = fwd0[1] / fwdLen, fz = fwd0[2] / fwdLen;
        const maxDist = Number.isFinite(this.maxModelDistance) ? Math.max(0, this.maxModelDistance) : Infinity;
        const maxVisible = Math.max(1, Math.floor(Number(this.maxVisibleInstances) || 12000));
        const maxPerArch = Math.max(1, Math.floor(Number(this.maxInstancesPerArchetype) || 128));
        const maxBehind = Math.min(maxDist, Math.max(24.0, Number(this.maxBehindModelDistance) || (maxDist * 0.55)));
        let remaining = maxVisible;
        const out = [];

        for (const entry of entries) {
            if (remaining <= 0) break;
            const mats = entry?.mats;
            const stride = this._instanceStrideFloatsForLen(mats?.length ?? 0);
            if (!mats || stride < 16) continue;
            const desiredCount = Math.min(maxPerArch, remaining);
            const nearest = []; // max-heap: farthest retained item at index 0
            const isWorse = (a, b) => (a.dist > b.dist) || (a.dist === b.dist && a.offset > b.offset);
            const pushNearest = (candidate) => {
                if (desiredCount <= 0) return;
                if (nearest.length < desiredCount) {
                    let child = nearest.length;
                    nearest.push(candidate);
                    while (child > 0) {
                        const parent = (child - 1) >> 1;
                        if (!isWorse(nearest[child], nearest[parent])) break;
                        [nearest[child], nearest[parent]] = [nearest[parent], nearest[child]];
                        child = parent;
                    }
                    return;
                }
                if (!isWorse(nearest[0], candidate)) return;
                nearest[0] = candidate;
                let parent = 0;
                while (true) {
                    const left = parent * 2 + 1;
                    const right = left + 1;
                    let worst = parent;
                    if (left < nearest.length && isWorse(nearest[left], nearest[worst])) worst = left;
                    if (right < nearest.length && isWorse(nearest[right], nearest[worst])) worst = right;
                    if (worst === parent) break;
                    [nearest[parent], nearest[worst]] = [nearest[worst], nearest[parent]];
                    parent = worst;
                }
            };
            for (let i = 0; i + (stride - 1) < mats.length; i += stride) {
                const dx = Number(mats[i + 12] ?? 0) - Number(cam[0] ?? 0);
                const dy = Number(mats[i + 13] ?? 0) - Number(cam[1] ?? 0);
                const dz = Number(mats[i + 14] ?? 0) - Number(cam[2] ?? 0);
                const dist = Math.hypot(dx, dy, dz);
                if (dist > maxDist) continue;
                const dot = dx * fx + dy * fy + dz * fz;
                if (dot < 0.0 && dist > maxBehind) continue;
                pushNearest({ offset: i, dist });
            }
            nearest.sort((a, b) => (a.dist - b.dist) || (a.offset - b.offset));
            const selected = [];
            for (const candidate of nearest) {
                for (let k = 0; k < stride; k++) selected.push(mats[candidate.offset + k]);
            }
            const selectedCount = nearest.length;
            remaining -= selectedCount;
            if (selectedCount > 0) out.push({ ...entry, mats: new Float32Array(selected) });
        }
        return out;
    }

    _applyRebuiltEntries(entriesIn, { behindPenalty = 1.6, sourceInstanceCount = null, duplicateInstancesDropped = 0 } = {}) {
        let entries = Array.isArray(entriesIn) ? entriesIn : [];

        // Apply interior visibility gating (drops interior children unless camera is inside).
        entries = this._filterEntriesForActiveInterior(entries);
        // Some valid YTYP archetypes intentionally have no drawable (collision/metadata/LOD helpers).
        // They are classified by the exporter and must not consume a placeholder or a render budget.
        entries = entries.filter((e) => !this.modelManager?.isNonRenderable?.(e?.hash));
        entries.sort((a, b) => {
            const pa = a.isPlaceholder ? 1 : 0;
            const pb = b.isPlaceholder ? 1 : 0;
            if (pa !== pb) return pa - pb;
            if (this.enableCameraForwardPrioritization) {
                const ba = (Number(a.dot) >= 0) ? 1.0 : behindPenalty;
                const bb = (Number(b.dot) >= 0) ? 1.0 : behindPenalty;
                const sa = Number(a.d) * ba;
                const sb = Number(b.d) * bb;
                if (sa !== sb) return sa - sb;
            }
            return Number(a.d) - Number(b.d);
        });
        const maxD = Number.isFinite(this.maxModelDistance) ? Math.max(0, this.maxModelDistance) : 1e30;
        const within = entries.filter(e => Number(e.d) <= maxD);
        const maxArch = (this.maxArchetypes | 0);
        const archetypeKeep = (maxArch > 0) ? within.slice(0, maxArch) : within;
        const keep = this._limitInstancesForRendering(archetypeKeep);

        // Stats (helps distinguish "missing meshes" vs "capped by maxArchetypes").
        let totalMeshInstances = Number.isFinite(sourceInstanceCount) && sourceInstanceCount >= 0
            ? Math.floor(sourceInstanceCount)
            : 0;
        if (!Number.isFinite(sourceInstanceCount) || sourceInstanceCount < 0) {
            for (const e of entries) {
                const stride = this._instanceStrideFloatsForLen(e.mats.length ?? 0);
                totalMeshInstances += Math.floor((e.mats.length ?? 0) / stride);
            }
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
                droppedArchetypes: Math.max(0, entries.length - archetypeKeep.length),
                keptRealArchetypes: keptReal,
                keptPlaceholderArchetypes: keptPlaceholder,
                totalMeshInstances,
                keptInstances,
                duplicateInstancesDropped,
            });
            return;
        }

        // Remove stale instance entries (hash:lod) that are no longer desired.
        const desiredKeys = new Set();
        for (const e of keep) {
            const lod = this._chooseLod(e.hash, e.d);
            desiredKeys.add(`${String(e.hash)}:${String(lod)}`);
            const mats = (e.mats instanceof Float32Array) ? e.mats : new Float32Array(e.mats);
            void this.modelRenderer.setInstancesForArchetype(e.hash, lod, mats, e.d);
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
            duplicateInstancesDropped,
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

    _selectVisibleLeavesCodeWalkerStyle(camDataPos) {
        const cx = this._safeNum(camDataPos?.[0], 0.0);
        const cy = this._safeNum(camDataPos?.[1], 0.0);
        const cz = this._safeNum(camDataPos?.[2], 0.0);
        const lodMult = Number.isFinite(this.entityLodDistMult) ? this.entityLodDistMult : 1.0;

        // CodeWalker builds hierarchy from fully-loaded YMAPs, so "parent not loaded" doesn't exist there.
        // In our chunked streaming, parents can legitimately be missing (different chunk / different YMAP),
        // and treating those children as non-roots can black-hole them (never rendered).
        //
        // So: treat entities with a missing/unresolved parent as *provisional roots*.
        // If/when the parent loads and the link becomes valid, the child will naturally stop being a root.
        const roots = [];
        for (const n of this._entityNodesByKey.values()) {
            if (!n) continue;
            if (!n.parentKey) {
                roots.push(n);
                continue;
            }
            // Parent key exists but parent node isn't loaded/resolved => provisional root.
            const p = this._entityNodesByKey.get(n.parentKey);
            if (!p) roots.push(n);
        }

        const leaves = [];

        const recurse = (ent) => {
            if (!ent) return;
            ent.dist = this._dist3(ent.px, ent.py, ent.pz, cx, cy, cz);

            // Mirrors CodeWalker.GetEntityChildren:
            // - all children must be present: childrenCount >= numChildren
            // - recurse if within ChildLodDist OR any child is within its own LodDist
            let clist = null;
            const wantChildren = (ent.numChildren | 0);
            const haveChildren = ent.children ? ent.children.size : 0;
            if (wantChildren > 0 && haveChildren >= wantChildren) {
                if (ent.dist <= (Number(ent.childLodDist || 0.0) * lodMult)) {
                    clist = ent.children;
                } else {
                    for (const ck of ent.children) {
                        const child = this._entityNodesByKey.get(ck);
                        if (!child) continue;
                        child.dist = this._dist3(child.px, child.py, child.pz, cx, cy, cz);
                        if (child.dist <= (Number(child.lodDist || 0.0) * lodMult)) {
                            clist = ent.children;
                            break;
                        }
                    }
                }
            }

            if (clist) {
                for (const ck of clist) {
                    const child = this._entityNodesByKey.get(ck);
                    if (!child) continue;
                    recurse(child);
                }
                return;
            }

            // Leaf: only render if within LodDist
            if (ent.dist <= (Number(ent.lodDist || 0.0) * lodMult)) {
                leaves.push(ent);
            }
        };

        for (const r of roots) {
            r.dist = this._dist3(r.px, r.py, r.pz, cx, cy, cz);
            if (r.dist <= (Number(r.lodDist || 0.0) * lodMult)) {
                recurse(r);
            }
        }

        return leaves;
    }

    _rebuildInstancesFromEntityLeaves(leaves) {
        const byHash = new Map();      // hash -> number[] (mat17 packed)
        const minD = new Map();        // hash -> min distance
        const bestDot = new Map();     // hash -> dot(camForward, toClosestInstance)
        const bestDist2 = new Map();   // hash -> number

        const cam = this._lastCamDataPos || [0, 0, 0];
        const fwd0 = this._lastCamDataDir || [0, 0, -1];
        const fwdLen = Math.hypot(fwd0[0], fwd0[1], fwd0[2]) || 1.0;
        const fx = fwd0[0] / fwdLen, fy = fwd0[1] / fwdLen, fz = fwd0[2] / fwdLen;
        const behindPenalty = Number.isFinite(Number(this.cameraBehindPenalty)) ? Math.max(1.0, Number(this.cameraBehindPenalty)) : 1.6;

        for (const e of leaves) {
            const hash = String(e?.hash || '');
            if (!hash) continue;
            const d = Number(e?.dist ?? 0.0);

            // Distance cutoff
            const maxD = Number.isFinite(this.maxModelDistance) ? Math.max(0, this.maxModelDistance) : 1e30;
            if (d > maxD) continue;

            const prev = minD.get(hash);
            if (prev === undefined || d < prev) minD.set(hash, d);

            try {
                const dx = Number(e?.px ?? 0) - Number(cam[0] ?? 0);
                const dy = Number(e?.py ?? 0) - Number(cam[1] ?? 0);
                const dz = Number(e?.pz ?? 0) - Number(cam[2] ?? 0);
                const dist2 = dx * dx + dy * dy + dz * dz;
                const prev2 = bestDist2.get(hash);
                if (prev2 === undefined || dist2 < prev2) {
                    bestDist2.set(hash, dist2);
                    bestDot.set(hash, dx * fx + dy * fy + dz * fz);
                }
            } catch { /* ignore */ }

            let arr = byHash.get(hash);
            if (!arr) {
                arr = [];
                byHash.set(hash, arr);
            }
            const m = e.mat17;
            for (let i = 0; i < 17; i++) arr.push(m[i]);
        }

        let entries = Array.from(byHash.entries()).map(([hash, mats]) => ({
            hash,
            mats,
            d: minD.get(hash) ?? 1e30,
            dot: bestDot.get(hash) ?? 0.0,
            isPlaceholder: !(this.modelManager?.hasRealMesh?.(hash) ?? true),
        }));
        entries.sort((a, b) => {
            const pa = a.isPlaceholder ? 1 : 0;
            const pb = b.isPlaceholder ? 1 : 0;
            if (pa !== pb) return pa - pb;
            if (this.enableCameraForwardPrioritization) {
                const ba = (Number(a.dot) >= 0) ? 1.0 : behindPenalty;
                const bb = (Number(b.dot) >= 0) ? 1.0 : behindPenalty;
                const sa = Number(a.d) * ba;
                const sb = Number(b.d) * bb;
                if (sa !== sb) return sa - sb;
            }
            return Number(a.d) - Number(b.d);
        });

        const maxArch = (this.maxArchetypes | 0);
        const keep = (maxArch > 0) ? entries.slice(0, maxArch) : entries;

        // Disable cross-archetype instancing for this path for now (simpler + correctness first).
        // Clear any stale buckets, if present.
        if (this._prevDesiredBucketIds && this.modelRenderer?.setInstancesForBucket) {
            for (const bid of this._prevDesiredBucketIds) {
                void this.modelRenderer.setInstancesForBucket(bid, 'high', '__clear__', null, null);
            }
            this._prevDesiredBucketIds = new Set();
        }

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

        this.coverageStats = {
            mode: 'entityLodTraversal',
            loadedChunks: this.loaded.size,
            loadedEntities: this._entityNodesByKey.size,
            visibleLeaves: leaves.length,
            instancedArchetypes: keep.length,
        };
    }

    _trim(wantedSet, wantedOrdered = null) {
        let changed = false;
        for (const key of Array.from(this.loaded)) {
            if (!wantedSet.has(key)) {
                // If a load is still in-flight for this chunk, cancel it.
                if (this.loading.has(key) || this._chunkLoadReqs.has(key)) this._cancelChunkLoad(key, 'fell_out_of_wanted_set');
                if (this.enableEntityLodTraversal) this._removeChunkEntities(key);
                this.loaded.delete(key);
                this.chunkInstances.delete(key);
                this.chunkMinDist.delete(key);
                this.chunkArchetypeCounts.delete(key);
                if (this._workerStoredChunks && this._workerStoredChunks.has(key)) {
                    this._workerStoredChunks.delete(key);
                    try {
                        const w = this._getChunkWorker();
                        if (w) w.postMessage({ type: 'drop_stored', reqId: (this._chunkWorkerNextReqId++ >>> 0), keys: [key] });
                    } catch { /* ignore */ }
                }
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
            if (this.loading.has(key) || this._chunkLoadReqs.has(key)) this._cancelChunkLoad(key, 'dropped_for_maxLoadedChunks');
            if (this.enableEntityLodTraversal) this._removeChunkEntities(key);
            this.loaded.delete(key);
            this.chunkInstances.delete(key);
            this.chunkMinDist.delete(key);
            this.chunkArchetypeCounts.delete(key);
            if (this._workerStoredChunks?.delete(key)) {
                try {
                    const w = this._getChunkWorker();
                    if (w) w.postMessage({ type: 'drop_stored', reqId: (this._chunkWorkerNextReqId++ >>> 0), keys: [key] });
                } catch { /* ignore */ }
            }
            changed = true;
        }
        if (changed) this._dirty = true;

        // Cancel any in-flight loads that are no longer wanted.
        for (const k of Array.from(this.loading)) {
            if (!wantedSet.has(k)) {
                this._cancelChunkLoad(k, 'stale_inflight_not_wanted');
            }
        }
    }

    clear() {
        for (const key of Array.from(this.loading)) {
            this._cancelChunkLoad(key, 'clear');
        }
        for (const key of Array.from(this._chunkLoadReqs.keys())) {
            this._cancelChunkLoad(key, 'clear');
        }
        this.loading.clear();
        this.loaded.clear();
        this.chunkInstances.clear();
        this.chunkMinDist.clear();
        this.chunkArchetypeCounts.clear();
        this.coverageStats = null;
        this.lastLoadStats = null;
        this._prevDesiredInstanceKeys.clear();
        this._residentCenterChunk = null;
        this._entityNodesByKey.clear();
        this._chunkEntityKeys.clear();
        this._pendingChildrenByParentKey.clear();
        const workerKeys = Array.from(this._workerStoredChunks || []);
        this._workerStoredChunks.clear();
        try {
            if (workerKeys.length) {
                const w = this._getChunkWorker?.();
                if (w) w.postMessage({ type: 'drop_stored', reqId: (this._chunkWorkerNextReqId++ >>> 0), keys: workerKeys });
            }
        } catch { /* ignore */ }
        this._dirty = true;
        this._dirtyEntityLod = true;
    }

    update(camera, centerDataPos = null) {
        if (!this.ready) return;
        // Expose camera position for distance computations inside chunk load (async).
        // (We avoid capturing camera object into async closures.)
        window.__appCameraPosForDrawableStreamer = [camera.position[0], camera.position[1], camera.position[2]];
        try {
            const c = centerDataPos || this._cameraToDataSpace(camera.position, this._tmpVec4Out);
            this._lastCamDataPos[0] = c[0]; this._lastCamDataPos[1] = c[1]; this._lastCamDataPos[2] = c[2];
        } catch {
            this._lastCamDataPos[0] = 0; this._lastCamDataPos[1] = 0; this._lastCamDataPos[2] = 0;
        }
        try {
            const d = this._cameraDirToDataSpace(camera.direction || [0, 0, -1], this._tmpVec4Out);
            const len = Math.hypot(d[0], d[1], d[2]) || 1.0;
            this._lastCamDataDir[0] = d[0] / len; this._lastCamDataDir[1] = d[1] / len; this._lastCamDataDir[2] = d[2] / len;
        } catch {
            this._lastCamDataDir[0] = 0; this._lastCamDataDir[1] = 0; this._lastCamDataDir[2] = -1;
        }
        this._updateFrustumPlanesData(camera);

        const wanted = this._wantedKeysForCamera(camera, centerDataPos);
        const wantedSet = this._tmpWantedSet;
        wantedSet.clear();
        for (let i = 0; i < wanted.length; i++) wantedSet.add(wanted[i]);
        this._trim(wantedSet, wanted);

        if (this.enableEntityLodTraversal) {
            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            const cam = this._lastCamDataPos || [0, 0, 0];
            const last = this._lastEntityLodCam;
            const moved = last ? this._dist3(cam[0], cam[1], cam[2], last[0], last[1], last[2]) : 1e30;

            const moveOk = moved >= (Number(this.entityLodUpdateMinMove) || 0.0);
            const timeOk = (now - (Number(this._lastEntityLodMs) || 0)) >= (Number(this.entityLodUpdateMinMs) || 0);
            const dirtyNow = !!(this._dirty || this._dirtyEntityLod);

            // If chunk-set changed, rebuild immediately. Otherwise throttle rebuilds while moving.
            if (dirtyNow || (moveOk && timeOk)) {
                this._dirty = false;
                this._dirtyEntityLod = false;
                this._lastEntityLodCam = [cam[0], cam[1], cam[2]];
                this._lastEntityLodMs = now;

                const leaves = this._selectVisibleLeavesCodeWalkerStyle(cam);
                this._lastEntityLodLeafCount = leaves.length;
                this._rebuildInstancesFromEntityLeaves(leaves);
            }
        } else {
            // An optional diagnostic path can rebuild from resident chunks as the focus moves.  It is
            // deliberately disabled for gameplay: the static city must not churn GPU buffers on walking.
            try {
                const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                const cam = this._lastCamDataPos || [0, 0, 0];
                const last = this._lastInstanceRebuildCam;
                const moved = last ? this._dist3(cam[0], cam[1], cam[2], last[0], last[1], last[2]) : 1e30;
                const moveOk = moved >= (Number(this.instanceRebuildMinMove) || 0.0);
                const timeOk = (now - (Number(this._lastInstanceRebuildMs) || 0)) >= (Number(this.instanceRebuildMinMs) || 0);
                let dirOk = false;
                if (this.enableWorkerFrustumCulling) {
                    const dir = this._lastCamDataDir || [0, 0, -1];
                    const lastDir = this._lastInstanceRebuildDir;
                    if (!lastDir) {
                        dirOk = true;
                    } else {
                        const dot = (Number(dir[0]) || 0) * (Number(lastDir[0]) || 0)
                            + (Number(dir[1]) || 0) * (Number(lastDir[1]) || 0)
                            + (Number(dir[2]) || 0) * (Number(lastDir[2]) || 0);
                        const minDot = Number.isFinite(Number(this.instanceRebuildMinDirDot))
                            ? Math.max(-1.0, Math.min(1.0, Number(this.instanceRebuildMinDirDot)))
                            : 0.985;
                        dirOk = dot < minDot;
                    }
                }
                if (this.rebuildInstancesOnMove && timeOk && (moveOk || dirOk)) this._dirty = true;
            } catch { /* ignore */ }

            // Interior visibility can change as the camera moves (enter/exit rooms), even when chunk set is stable.
            // Use the cached MLO instance list from the last rebuild to decide if we should rebuild.
            if (this.enableInteriors && this._mloInstancesLast && this._mloInstancesLast.length > 0) {
                const { key } = this._computeActiveInteriorFromCache();
                if (key !== this._activeInteriorKey) this._dirty = true;
            }
            if (this._dirty) {
                // If we have worker-stored chunk data, rebuild off-main-thread for smoother frames.
                const didWorker = (this.enableWorkerRebuild && this._workerStoredChunks && this._workerStoredChunks.size > 0);
                if (didWorker) {
                    // Keep drawing the last complete buffer set while one structural rebuild is in flight.
                    // Chunk loads/drops that happen meanwhile set `_dirty` again and schedule one follow-up.
                    if (!this._rebuildWorkerReqInFlight) {
                        this._dirty = false;
                        void this._rebuildAllInstancesInWorker().then((ok) => {
                            if (!ok) this._dirty = true;
                        });
                    }
                } else {
                    this._dirty = false;
                    this._rebuildAllInstances();
                }
                try {
                    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                    const cam = this._lastCamDataPos || [0, 0, 0];
                    const dir = this._lastCamDataDir || [0, 0, -1];
                    this._lastInstanceRebuildCam = [cam[0], cam[1], cam[2]];
                    this._lastInstanceRebuildDir = [dir[0], dir[1], dir[2]];
                    this._lastInstanceRebuildMs = now;
                } catch { /* ignore */ }
            }
        }

        // Adaptive load budget: if frames are slow, schedule fewer new chunk loads to avoid stutter.
        const nowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const last = Number(this._lastUpdateMs) || 0;
        if (last > 0) {
            const dt = Math.max(0.0, Math.min(200.0, nowMs - last));
            const a = 0.12; // EMA smoothing
            this._frameMsEma = (this._frameMsEma * (1.0 - a)) + (dt * a);
        }
        this._lastUpdateMs = nowMs;
        const baseBudget = Math.max(1, Math.floor(this.maxNewLoadsPerUpdate));
        const ema = Number(this._frameMsEma) || 16.7;
        const factor = Math.max(0.25, Math.min(1.0, 16.7 / Math.max(8.0, ema)));
        const budget = Math.max(1, Math.floor(baseBudget * factor));
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



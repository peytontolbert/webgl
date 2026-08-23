import { glMatrix } from './glmatrix.js';
import { extractFrustumPlanes, aabbIntersectsFrustum } from './frustum_culling.js';
import { fetchArrayBufferWithPriority, fetchJSON, fetchNDJSON, fetchStreamBytes, fetchText } from './asset_fetcher.js';
import { joaat } from './joaat.js';

const MLO_FLAG_INSTANCE = 1;
const MLO_FLAG_ENTITY_SET_DEFAULT = 8;
const MLO_ROOM_SHIFT = 8;
const MLO_PORTAL_SHIFT = 16;
const MLO_PORTAL_FLAG_ONE_WAY = 1;
const MLO_PORTAL_FLAG_MIRROR = 4;
const MLO_PORTAL_FLAG_HIDE_WHEN_DOOR_CLOSED = 64;
const MLO_PORTAL_FLAG_LIGHT_BLEED = 8192;

function ent1RecordKey(bytes, offset, stride) {
    // Position alone is not a duplicate definition for GTA compound assets. A
    // byte-identical ENT1 record includes the transform, tint, and MLO metadata.
    return String.fromCharCode(...bytes.subarray(offset, offset + stride));
}

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
        this._demoChunkIndex = null;
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
        // Optional overlap cache above the current wanted set. A value <= 0
        // follows maxLoadedChunks exactly.
        this.maxResidentChunks = 0;
        this.staleChunkGraceMs = 0;
        this.chunkRebuildSettleMs = 0;
        this.radiusChunks = 1;
        this.extraFrontChunks = 1;
        this.prefetchHorizonSeconds = 10.0;
        this.residencyHysteresisChunks = 0.18;
        this._residentCenterChunk = null;
        this._prefetchFocusSample = null;
        this._prefetchMoveDir = null;
        this._prefetchMoveDirMs = 0;
        this._prefetchMoveSpeed = 0;
        this._lastResidentCoreCount = 0;
        this._lastPrefetchStats = { speed: 0, leadChunks: 0, core: 0, forward: 0 };
        this._chunkLastWantedMs = new Map();
        this._lastChunkSetChangeMs = 0;
        this._instanceRebuildCount = 0;
        this._lastInstanceRebuildCompletedMs = 0;
        this._lastWantedKeys = [];
        this._lastCoreWantedSet = new Set();
        this._lastCoreSignature = '';
        // Optional data-space rectangle used by the spawn-district demo. Chunks that
        // overlap it are parsed, then individual instances outside it are discarded.
        this.worldBounds = null;
        // /demo replaces a much larger source chunk with one prefiltered ENT1 tile.
        // It is kept as a single resident key so player movement cannot trigger reloads.
        this.demoBootstrap = null;
        this._demoDataSourceSignature = null;
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
        this._instanceTransformOverridesByHash = new Map();

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

        // Interiors / MLOs. Child room and portal ownership is packed into the
        // upper bytes of the ENT1 MLO flags field by the demo preprocessor.
        this.enableInteriors = true;
        this.enableRoomGating = true;         // portal/room gating
        // Portal connectivity remains authoritative, but the approximate cone
        // test can reject valid custom-MLO portals whose winding differs from
        // Rockstar's native raster clipper. Fail open until exact polygon
        // clipping is available so authored rooms never disappear.
        this.enableMloPortalApertureCulling = false;
        // Imported interiors currently contain connected room graphs with a
        // diameter of up to five portals. Three silently removed valid rooms.
        this.interiorPortalDepth = 8;
        this.interiorExteriorDistance = 80.0; // retain nearby interiors through exterior portals
        // Some custom MLOs export sentinel room bounds hundreds of metres wide. Limit those
        // claims to their actual district and rank overlaps by distance to the MLO root.
        this.interiorMaxRootDistance = 120.0;
        this.enableMloEntitySets = true;      // gate entity-set entities

        this._mloDefs = new Map();            // mloArchetypeHash -> def JSON
        this._mloDefsLoading = new Set();     // hashes currently loading
        this._mloDefinitionRevision = 'v1';   // cache key for preprocessed interior definitions
        this._mloSetOverrides = new Map();    // key `${parentGuid}:${setHash}` -> boolean
        this._mloSetDefaults = new Map();     // key `${parentGuid}:${setHash}` -> authored default
        this._mloPortalOpenOverrides = new Map(); // key `${parentGuid}:${portalIndex}` -> door progress
        this._mloPortalDefinitionOverrides = new Map(); // instance-scoped FiveM portal mutations
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
        // Destroyed fragment instances are suppressed by hash + world-space origin.
        // The compact ENT1 format has no stable entity id, so this is the narrowest
        // identity available without re-exporting the tile schema.
        this._suppressedInstancesByHash = new Map();

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
        this._lastInstanceLimitStats = { eligible: 0, kept: 0, capped: 0 };
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
            // Keep this exact inline new Worker(new URL(...)) form: Vite uses
            // it to bundle the worker's module imports into the emitted asset.
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
                        detail: {
                            error: String(err?.message || err || ''),
                            eventType: String(err?.type || ''),
                            filename: String(err?.filename || ''),
                            line: Number(err?.lineno) || 0,
                            column: Number(err?.colno) || 0,
                        },
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

    async _parseENT1InWorker(buffer, camData, { storeKey = null, storeOnly = false, worldBounds = null, dedupeExactRecords = false, onReqId = null } = {}) {
        const w = this._getChunkWorker();
        if (!w) return null;
        const reqId = (this._chunkWorkerNextReqId++ >>> 0);
        try { if (typeof onReqId === 'function') onReqId(reqId); } catch { /* ignore */ }
        const p = new Promise((resolve, reject) => {
            this._chunkWorkerPending.set(reqId, { resolve, reject });
        });
        try {
            w.postMessage({ type: 'parse_ent1', reqId, camData, buffer, storeKey, storeOnly, worldBounds, dedupeExactRecords }, [buffer]);
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
            const keys = this._lastWantedKeys.length
                ? this._lastWantedKeys.filter((key) => this._workerStoredChunks.has(key))
                : Array.from(this._workerStoredChunks);
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
            const mloInstances = [];
            for (const packedRoot of (Array.isArray(res.mloInstanceEntries) ? res.mloInstanceEntries : [])) {
                if (!Array.isArray(packedRoot) || packedRoot.length < 18) continue;
                const archHash = String(packedRoot[0] ?? '');
                const parentGuid = Number(packedRoot[1]) >>> 0;
                if (!archHash || !parentGuid) continue;
                const mat16 = new Float32Array(16);
                let valid = true;
                for (let i = 0; i < 16; i++) {
                    const value = Number(packedRoot[i + 2]);
                    if (!Number.isFinite(value)) { valid = false; break; }
                    mat16[i] = value;
                }
                if (!valid) continue;
                let spatialBounds = null;
                if (packedRoot.length >= 25) {
                    const values = packedRoot.slice(18, 24).map(Number);
                    if (values.every(Number.isFinite)) {
                        spatialBounds = {
                            min: values.slice(0, 3),
                            max: values.slice(3, 6),
                            childCount: Math.max(0, Number(packedRoot[24]) || 0),
                        };
                    }
                }
                mloInstances.push({ parentGuid, archHash, mat16, spatialBounds });
                void this._ensureMloDefLoaded(archHash);
            }

            const agg = new Map();
            if (buf && buf.byteLength && idxArr.length) {
                for (const it of idxArr) {
                    const hash = String(it?.hash ?? '');
                    if (!hash) continue;
                    const offFloats = Number(it?.offsetFloats ?? 0);
                    const lenFloats = Number(it?.lengthFloats ?? 0);
                    if (!Number.isFinite(offFloats) || !Number.isFinite(lenFloats) || lenFloats <= 0) continue;
                    try {
                        const mats = new Float32Array(buf, offFloats * 4, lenFloats);
                        mats.__webglgtaInstanceStride = this._instanceStrideFloatsForLen(mats.length, it?.strideFloats);
                        agg.set(hash, mats);
                    } catch { /* ignore */ }
                }
            }

            const entries = Array.from(agg.entries()).map(([hash, mats]) => ({
                hash,
                mats,
                instanceStrideFloats: this._instanceStrideFloatsForLen(mats.length, mats.__webglgtaInstanceStride),
                d: Number(minDistByHash.get(hash) ?? 1e30),
                dot: Number(bestDotByHash.get(hash) ?? 0.0),
                isPlaceholder: !(this.modelManager?.hasRealMesh?.(hash) ?? true),
            }));

            // Apply interior gating + sorting + renderer updates using existing logic by temporarily
            // swapping in a lightweight agg map.
            this._applyRebuiltEntries(entries, {
                sourceInstanceCount: Number(res.sourceInstances),
                duplicateInstancesDropped: Number(res.duplicateInstancesDropped),
                preCappedInstances: Number(res.cappedInstances),
                mloInstances,
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
            const globalIndex = await fetchJSON('assets/entities_index.json');
            // /demo may install its compact index while this request is in
            // flight. Network completion order must not replace that index.
            if (!this._demoChunkIndex) this.index = globalIndex;
        } catch {
            if (!this._demoChunkIndex && !this.demoBootstrap) {
                console.warn('No entities_index.json found; drawable streaming disabled.');
                return;
            }
            console.info('[demo] Generic entity index unavailable; using the installed compact district index.');
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
            if (this.demoBootstrap || this._demoChunkIndex) {
                this.preferBinary = true;
            } else {
                const chunks = this.index?.chunks || {};
                const firstKey = Object.keys(chunks)[0];
                const firstMeta = firstKey ? chunks[firstKey] : null;
                const firstJsonl = String(firstMeta?.file || '');
                const explicitBinary = String(firstMeta?.binaryFile || '');
                const binFile = (explicitBinary || (firstJsonl
                    ? firstJsonl.replace(/\.jsonl(\.gz)?$/i, '.bin')
                    : (firstKey ? `${firstKey}.bin` : '')));

                if (!binFile) {
                    this.preferBinary = false;
                } else {
                    const url = explicitBinary
                        ? `assets/${binFile.replace(/^assets\//i, '').replace(/^\/+/, '')}`
                        : `assets/entities_chunks_inst/${binFile}`;
                    let resp = await fetch(url, { method: 'HEAD', cache: 'no-store' });
                    if (!resp.ok && (resp.status === 405 || resp.status === 501)) {
                        resp = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-31' }, cache: 'no-store' });
                    }
                    this.preferBinary = !!resp.ok;
                }
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
            if (this._demoDataSourceSignature) this.clear();
            this.demoBootstrap = null;
            this._demoDataSourceSignature = null;
            this._residentCenterChunk = null;
            this._dirty = true;
            return;
        }
        const key = String(config?.key || '__demo_spawn_district__');
        const signature = `bootstrap:${key}:${instanceFile}`;
        if (this._demoDataSourceSignature && this._demoDataSourceSignature !== signature) this.clear();
        this.demoBootstrap = {
            key,
            instanceFile,
        };
        this._demoChunkIndex = null;
        this._demoDataSourceSignature = signature;
        this._residentCenterChunk = null;
        this._dirty = true;
    }

    setDemoChunkIndex(config = null) {
        const chunkSize = Number(config?.chunk_size);
        const chunks = config?.chunks;
        if (!(chunkSize > 0) || !chunks || typeof chunks !== 'object') return false;

        const signature = `chunks:${String(config?.revision || '')}:${String(config?.chunks_dir || '')}:${chunkSize}:${JSON.stringify(chunks)}`;
        if (this._demoDataSourceSignature && this._demoDataSourceSignature !== signature) this.clear();

        // Drop the fixed-cell bootstrap and use the regular, player-centered
        // residency path with a compact demo-only index.
        this.demoBootstrap = null;
        this._demoChunkIndex = {
            version: Number(config?.version) || 1,
            revision: String(config?.revision || ''),
            chunk_size: chunkSize,
            chunks_dir: String(config?.chunks_dir || 'demo/spawn_district_chunks'),
            bounds: config?.bounds || this.index?.bounds || null,
            chunks,
        };
        this.index = this._demoChunkIndex;
        this._demoDataSourceSignature = signature;
        this.preferBinary = true;
        this._residentCenterChunk = null;
        this._prefetchFocusSample = null;
        this._prefetchMoveDir = null;
        this._prefetchMoveDirMs = 0;
        this._prefetchMoveSpeed = 0;
        this._lastResidentCoreCount = 0;
        this._lastPrefetchStats = { speed: 0, leadChunks: 0, core: 0, forward: 0 };
        this._chunkLastWantedMs.clear();
        this._lastChunkSetChangeMs = 0;
        this._lastWantedKeys = [];
        this._lastCoreWantedSet.clear();
        this._lastCoreSignature = '';
        this._dirty = true;
        return true;
    }

    _isDataPositionInWorldBounds(x, y) {
        const b = this._effectiveWorldBounds();
        if (!b) return true;
        return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
    }

    _effectiveWorldBounds() {
        if (this.worldBounds) return this.worldBounds;
        const bounds = this.index?.bounds;
        const minX = Number(bounds?.minX ?? bounds?.min_x);
        const minY = Number(bounds?.minY ?? bounds?.min_y);
        const maxX = Number(bounds?.maxX ?? bounds?.max_x);
        const maxY = Number(bounds?.maxY ?? bounds?.max_y);
        return [minX, minY, maxX, maxY].every(Number.isFinite) && maxX > minX && maxY > minY
            ? { minX, minY, maxX, maxY }
            : null;
    }

    _isChunkInWorldBounds(key) {
        const b = this._effectiveWorldBounds();
        if (!b) return true;
        const aabb = this._chunkAABBDataSpace(key);
        if (!aabb) return false;
        return aabb.max[0] > b.minX && aabb.min[0] < b.maxX &&
            aabb.max[1] > b.minY && aabb.min[1] < b.maxY;
    }

    _hasIndexedChunk(key) {
        const chunks = this.index?.chunks;
        return !chunks || typeof chunks !== 'object' || Object.prototype.hasOwnProperty.call(chunks, key);
    }

    _resolveResidentCenterChunk(p, chunkSize) {
        let x = Number(p?.[0]);
        let y = Number(p?.[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !(chunkSize > 0)) return null;

        // Multiplayer corrections can briefly place a demo client beyond the
        // compact district. Keep residency on the nearest authored tile instead
        // of falling through to missing global JSONL chunks.
        const bounds = this._effectiveWorldBounds();
        if (bounds) {
            const epsilon = Math.min(0.01, chunkSize * 1e-5);
            x = Math.max(Number(bounds.minX) + epsilon, Math.min(Number(bounds.maxX) - epsilon, x));
            y = Math.max(Number(bounds.minY) + epsilon, Math.min(Number(bounds.maxY) - epsilon, y));
        }

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

        // Derive look-ahead from actual focus movement, not camera rotation. A
        // short dead zone prevents idle/network jitter from changing residency.
        const nowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const px = Number(p[0]);
        const py = Number(p[1]);
        const previousFocus = this._prefetchFocusSample;
        if (previousFocus && Number.isFinite(px) && Number.isFinite(py)) {
            const dt = Math.max(0, (nowMs - previousFocus.ms) / 1000.0);
            const dx = px - previousFocus.x;
            const dy = py - previousFocus.y;
            const distance = Math.hypot(dx, dy);
            if (dt >= 0.04 && distance >= 0.3) {
                if (!this._prefetchMoveDir) this._prefetchMoveDir = new Float32Array(2);
                this._prefetchMoveDir[0] = dx / distance;
                this._prefetchMoveDir[1] = dy / distance;
                const instantSpeed = Math.min(120.0, distance / dt);
                const response = 1.0 - Math.exp(-Math.min(1.0, dt) * 5.0);
                this._prefetchMoveSpeed = this._prefetchMoveSpeed > 0
                    ? this._prefetchMoveSpeed + (instantSpeed - this._prefetchMoveSpeed) * response
                    : instantSpeed;
                this._prefetchMoveDirMs = nowMs;
            }
        }
        if (!previousFocus || nowMs - previousFocus.ms >= 40) {
            this._prefetchFocusSample = { x: px, y: py, ms: nowMs };
        }

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
                if (!this._hasIndexedChunk(key)) continue;
                if (coreCount >= core.length) core.push({ k: '', score: 0 });
                core[coreCount].k = key;
                core[coreCount].score = dx * dx + dy * dy;
                coreCount++;
            }
        }
        core.length = coreCount;
        core.sort((a, b) => a.score - b.score || (a.k < b.k ? -1 : 1));
        for (let i = 0; i < core.length && keys.length < maxWanted; i++) keys.push(core[i].k);
        this._lastResidentCoreCount = keys.length;
        if (keys.length >= maxWanted) {
            this._lastPrefetchStats = { speed: this._prefetchMoveSpeed, leadChunks: 0, core: keys.length, forward: 0 };
            return keys;
        }

        // Larger custom budgets can retain a forward prefetch ring. The resident core above remains intact
        // when the camera turns, so this can improve travel look-ahead without causing local resets.
        const maxExtra = Math.max(0, Math.floor(this.extraFrontChunks || 0));
        if (maxExtra <= 0) {
            this._lastPrefetchStats = { speed: this._prefetchMoveSpeed, leadChunks: 0, core: keys.length, forward: 0 };
            return keys;
        }
        const moveDir = (this._prefetchMoveDir && nowMs - this._prefetchMoveDirMs <= 1200)
            ? this._prefetchMoveDir
            : null;
        if (!moveDir) {
            this._prefetchMoveSpeed = 0;
            this._lastPrefetchStats = { speed: 0, leadChunks: 0, core: keys.length, forward: 0 };
            return keys;
        }
        const fx2 = moveDir[0], fy2 = moveDir[1];
        const speed = Math.max(0, Number(this._prefetchMoveSpeed) || 0);
        const horizon = Math.max(1.0, Math.min(20.0, Number(this.prefetchHorizonSeconds) || 10.0));
        const leadChunks = Math.max(0.5, Math.min(maxExtra, speed * horizon / chunkSize));
        const extra = Math.max(1, Math.min(maxExtra, Math.ceil(leadChunks)));
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
                if (!this._hasIndexedChunk(k)) continue;
                if (!seen.has(k)) {
                    const predictedDx = dx - fx2 * leadChunks;
                    const predictedDy = dy - fy2 * leadChunks;
                    const lateral = dx * -fy2 + dy * fx2;
                    prefetch.push({
                        k,
                        score: predictedDx * predictedDx + predictedDy * predictedDy
                            + lateral * lateral * 0.2 + (dx * dx + dy * dy) * 0.04,
                    });
                }
            }
        }
        prefetch.sort((a, b) => a.score - b.score || (a.k < b.k ? -1 : 1));
        for (let i = 0; i < prefetch.length && keys.length < maxWanted; i++) keys.push(prefetch[i].k);
        this._lastPrefetchStats = {
            speed,
            leadChunks,
            core: this._lastResidentCoreCount,
            forward: Math.max(0, keys.length - this._lastResidentCoreCount),
        };
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

    _instanceStrideFloatsForLen(len, explicitStride = null) {
        const n = Number(len ?? 0);
        if (!Number.isFinite(n) || n <= 0) return 16;
        // Layouts:
        // - v0: 16 (mat4)
        // - v1: 17 (mat4 + tintIndex)
        // - v3: 21 (mat4 + tintIndex + guid + mloParentGuid + mloEntitySetHash + mloFlags)
        // - v4: 22 (mat4 + tintIndex + guid + mloParentGuid + mloEntitySetHash + mloFlags + ymapHash)
        const requested = Math.floor(Number(explicitStride));
        if ([16, 17, 21, 22].includes(requested) && (n % requested) === 0) return requested;
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
            const revision = encodeURIComponent(this._mloDefinitionRevision || 'v1');
            const def = await fetchJSON(`assets/interiors/${h}.json?rev=${revision}`);
            if (def && typeof def === 'object') {
                this._mloDefs.set(h, def);
                // A definition can finish after the resident instance set was
                // built. Re-run gating immediately instead of waiting for the
                // next chunk or camera transition to reveal the interior.
                this._dirty = true;
            }
        } catch {
            // ignore missing interiors defs
        } finally {
            this._mloDefsLoading.delete(h);
        }
    }

    _pointInAABB(p, minV, maxV) {
        // Several FiveM MLO room definitions store one or more AABB axes in
        // descending order. Treat the values as endpoints instead of assuming
        // the exporter normalized them; otherwise a valid room becomes limbo.
        return (p[0] >= Math.min(Number(minV[0]), Number(maxV[0])) && p[0] <= Math.max(Number(minV[0]), Number(maxV[0]))) &&
               (p[1] >= Math.min(Number(minV[1]), Number(maxV[1])) && p[1] <= Math.max(Number(minV[1]), Number(maxV[1]))) &&
               (p[2] >= Math.min(Number(minV[2]), Number(maxV[2])) && p[2] <= Math.max(Number(minV[2]), Number(maxV[2])));
    }

    _decodeMloFlags(flagsValue) {
        const flags = Number(flagsValue) >>> 0;
        return {
            flags,
            roomIndex: ((flags >>> MLO_ROOM_SHIFT) & 0xff) - 1,
            portalIndex: ((flags >>> MLO_PORTAL_SHIFT) & 0xff) - 1,
            entitySetDefault: (flags & MLO_FLAG_ENTITY_SET_DEFAULT) !== 0,
        };
    }

    _findExteriorRoomIndex(def) {
        const rooms = Array.isArray(def?.rooms) ? def.rooms : [];
        const named = rooms.findIndex((room) => String(room?.name || '').trim().toLowerCase() === 'limbo');
        return named >= 0 ? named : (rooms.length ? 0 : -1);
    }

    _findContainingRoomIndex(def, local) {
        const rooms = Array.isArray(def?.rooms) ? def.rooms : [];
        const exterior = this._findExteriorRoomIndex(def);
        let best = -1;
        let bestVolume = Number.POSITIVE_INFINITY;
        for (let ri = 0; ri < rooms.length; ri++) {
            const mn = rooms[ri]?.bbMin;
            const mx = rooms[ri]?.bbMax;
            if (!Array.isArray(mn) || !Array.isArray(mx) || mn.length < 3 || mx.length < 3) continue;
            if (!this._pointInAABB(local, mn, mx)) continue;
            if (ri === exterior) {
                if (best < 0) best = ri;
                continue;
            }
            const volume = Math.abs(Number(mx[0]) - Number(mn[0]))
                * Math.abs(Number(mx[1]) - Number(mn[1]))
                * Math.abs(Number(mx[2]) - Number(mn[2]));
            if (volume < bestVolume) {
                best = ri;
                bestVolume = volume;
            }
        }
        return best;
    }

    _distanceToInteriorBounds(def, local) {
        const rooms = Array.isArray(def?.rooms) ? def.rooms : [];
        const room = rooms[this._findExteriorRoomIndex(def)] || rooms[0];
        const mn = room?.bbMin;
        const mx = room?.bbMax;
        if (!Array.isArray(mn) || !Array.isArray(mx)) return Number.POSITIVE_INFINITY;
        const dx = Math.max(Math.min(Number(mn[0]), Number(mx[0])) - local[0], 0, local[0] - Math.max(Number(mn[0]), Number(mx[0])));
        const dy = Math.max(Math.min(Number(mn[1]), Number(mx[1])) - local[1], 0, local[1] - Math.max(Number(mn[1]), Number(mx[1])));
        const dz = Math.max(Math.min(Number(mn[2]), Number(mx[2])) - local[2], 0, local[2] - Math.max(Number(mn[2]), Number(mx[2])));
        return Math.hypot(dx, dy, dz);
    }

    _hasSentinelRoomBounds(def) {
        const rooms = Array.isArray(def?.rooms) ? def.rooms : [];
        return rooms.some((room) => {
            const mn = room?.bbMin;
            const mx = room?.bbMax;
            if (!Array.isArray(mn) || !Array.isArray(mx) || mn.length < 3 || mx.length < 3) return false;
            return Math.abs(Number(mx[0]) - Number(mn[0])) > 200.0
                || Math.abs(Number(mx[1]) - Number(mn[1])) > 200.0
                || Math.abs(Number(mx[2]) - Number(mn[2])) > 50.0;
        });
    }

    _distanceToMloSpatialBounds(position, bounds, xyPadding = 0.0, zPadding = 0.0) {
        const mn = bounds?.min;
        const mx = bounds?.max;
        if (!Array.isArray(mn) || !Array.isArray(mx) || mn.length < 3 || mx.length < 3) {
            return Number.POSITIVE_INFINITY;
        }
        const px = Math.max(0.0, Number(xyPadding) || 0.0);
        const pz = Math.max(0.0, Number(zPadding) || 0.0);
        const dx = Math.max(Number(mn[0]) - px - position[0], 0, position[0] - (Number(mx[0]) + px));
        const dy = Math.max(Number(mn[1]) - px - position[1], 0, position[1] - (Number(mx[1]) + px));
        const dz = Math.max(Number(mn[2]) - pz - position[2], 0, position[2] - (Number(mx[2]) + pz));
        return Math.hypot(dx, dy, dz);
    }

    _distanceToMloContentBounds(localPosition, definition, xyPadding = 0.0, zPadding = 0.0) {
        const bounds = definition?.contentBounds;
        if (bounds?.complete !== true) return Number.POSITIVE_INFINITY;
        const mn = bounds?.min;
        const mx = bounds?.max;
        if (!Array.isArray(mn) || !Array.isArray(mx) || mn.length < 3 || mx.length < 3) {
            return Number.POSITIVE_INFINITY;
        }
        const values = [...mn.slice(0, 3), ...mx.slice(0, 3), ...localPosition.slice(0, 3)].map(Number);
        if (!values.every(Number.isFinite)) return Number.POSITIVE_INFINITY;
        const px = Math.max(0, Number(xyPadding) || 0);
        const pz = Math.max(0, Number(zPadding) || 0);
        const dx = Math.max(values[0] - px - values[6], 0, values[6] - (values[3] + px));
        const dy = Math.max(values[1] - px - values[7], 0, values[7] - (values[4] + px));
        const dz = Math.max(values[2] - pz - values[8], 0, values[8] - (values[5] + pz));
        return Math.hypot(dx, dy, dz);
    }

    _attachMloSpatialBounds(entries, instances) {
        const byParent = new Map();
        for (const instance of (instances || [])) {
            const parentGuid = Number(instance?.parentGuid) >>> 0;
            if (!parentGuid) continue;
            const existing = instance?.spatialBounds;
            const mn = existing?.min;
            const mx = existing?.max;
            byParent.set(parentGuid, {
                instance,
                min: Array.isArray(mn) ? mn.slice(0, 3).map(Number) : [Infinity, Infinity, Infinity],
                max: Array.isArray(mx) ? mx.slice(0, 3).map(Number) : [-Infinity, -Infinity, -Infinity],
                childCount: Math.max(0, Number(existing?.childCount) || 0),
            });
        }
        for (const entry of (entries || [])) {
            const mats = entry?.mats;
            const stride = this._instanceStrideFloatsForLen(mats?.length ?? 0, entry?.instanceStrideFloats);
            if (!mats || stride < 21) continue;
            const radiusRaw = Number(this.modelManager?.getApproxRadiusForHash?.(entry.hash, null, 0));
            const radius = Number.isFinite(radiusRaw) ? Math.max(0, Math.min(80, radiusRaw)) : 0;
            for (let offset = 0; offset + stride <= mats.length; offset += stride) {
                const parentGuid = Number(mats[offset + 18]) >>> 0;
                const target = byParent.get(parentGuid);
                if (!target) continue;
                const x = Number(mats[offset + 12]);
                const y = Number(mats[offset + 13]);
                const z = Number(mats[offset + 14]);
                if (![x, y, z].every(Number.isFinite)) continue;
                const extent = radius * this._instanceMaxScale(mats, offset);
                target.min[0] = Math.min(target.min[0], x - extent);
                target.min[1] = Math.min(target.min[1], y - extent);
                target.min[2] = Math.min(target.min[2], z - extent);
                target.max[0] = Math.max(target.max[0], x + extent);
                target.max[1] = Math.max(target.max[1], y + extent);
                target.max[2] = Math.max(target.max[2], z + extent);
                target.childCount++;
            }
        }
        for (const target of byParent.values()) {
            if (!target.min.every(Number.isFinite) || !target.max.every(Number.isFinite)) continue;
            target.instance.spatialBounds = {
                min: target.min,
                max: target.max,
                childCount: target.childCount,
            };
        }
        return instances;
    }

    _interiorActivationRadius(def) {
        const configured = Math.max(1.0, Number(this.interiorMaxRootDistance) || 120.0);
        const hasSentinelBounds = this._hasSentinelRoomBounds(def);
        if (!hasSentinelBounds) return configured;

        // Some loose FiveM MLOs use a map-sized sentinel AABB for every room.
        // Treating that box as playable interior keeps the MLO active far out in
        // the street, where its children replace unrelated exterior content.
        // Authored portal corners still describe the real shell aperture and
        // give us a resource-driven activation radius without destination IDs
        // or hand-authored world coordinates.
        let portalRadius = 0.0;
        for (const portal of (Array.isArray(def?.portals) ? def.portals : [])) {
            for (const corner of (Array.isArray(portal?.corners) ? portal.corners : [])) {
                if (!Array.isArray(corner) || corner.length < 3) continue;
                const x = Number(corner[0]);
                const y = Number(corner[1]);
                const z = Number(corner[2]);
                if (![x, y, z].every(Number.isFinite)) continue;
                portalRadius = Math.max(portalRadius, Math.hypot(x, y, z));
            }
        }
        const authoredRadius = portalRadius > 0.0 ? portalRadius + 16.0 : 48.0;
        return Math.min(configured, Math.max(24.0, authoredRadius));
    }

    _portalKey(parentGuid, portal) {
        return `${Number(parentGuid) >>> 0}:${Number(portal?.index) >>> 0}`;
    }

    _runtimePortal(parentGuid, portal) {
        const patch = this._mloPortalDefinitionOverrides.get(this._portalKey(parentGuid, portal));
        return patch ? { ...portal, ...patch } : portal;
    }

    _isPortalOpen(parentGuid, portal) {
        portal = this._runtimePortal(parentGuid, portal);
        const flags = Number(portal?.flags) >>> 0;
        if ((flags & MLO_PORTAL_FLAG_HIDE_WHEN_DOOR_CLOSED) === 0) return true;
        const progress = this._portalOpenProgress(parentGuid, portal);
        // A hide-when-closed portal without a bound door is an open architectural portal.
        return progress >= 0.35;
    }

    _portalOpenProgress(parentGuid, portal) {
        const progress = this._mloPortalOpenOverrides.get(this._portalKey(parentGuid, portal));
        return progress === undefined ? 1 : Math.max(0, Math.min(1, Number(progress) || 0));
    }

    _portalVisibleThroughAperture(eye, aperture, candidate) {
        if (!this.enableMloPortalApertureCulling || !Array.isArray(eye) || eye.length < 3) return true;
        const source = Array.isArray(aperture?.corners) ? aperture.corners : [];
        const target = Array.isArray(candidate?.corners) ? candidate.corners : [];
        if (source.length < 3 || target.length < 3) return true;
        const valid = (point) => Array.isArray(point) && point.length >= 3
            && [Number(point[0]), Number(point[1]), Number(point[2])].every(Number.isFinite);
        if (!source.every(valid) || !target.every(valid)) return true;
        const center = [0, 1, 2].map((axis) => source.reduce((sum, point) => sum + Number(point[axis]), 0) / source.length);
        const targetPoints = [...target, [0, 1, 2].map((axis) => target.reduce((sum, point) => sum + Number(point[axis]), 0) / target.length)];
        const planes = [];
        for (let index = 0; index < source.length; index++) {
            const a = source[index];
            const b = source[(index + 1) % source.length];
            const ax = Number(a[0]) - eye[0]; const ay = Number(a[1]) - eye[1]; const az = Number(a[2]) - eye[2];
            const bx = Number(b[0]) - eye[0]; const by = Number(b[1]) - eye[1]; const bz = Number(b[2]) - eye[2];
            let nx = ay * bz - az * by;
            let ny = az * bx - ax * bz;
            let nz = ax * by - ay * bx;
            const length = Math.hypot(nx, ny, nz);
            if (length < 1e-7) continue;
            const centerDot = nx * (center[0] - eye[0]) + ny * (center[1] - eye[1]) + nz * (center[2] - eye[2]);
            if (centerDot < 0) { nx = -nx; ny = -ny; nz = -nz; }
            planes.push([nx / length, ny / length, nz / length]);
        }
        if (planes.length < 3) return true;
        // Conservative polygon/cone test. A generous angular epsilon keeps
        // touching portal edges and imprecise custom-MLO corners fail-open.
        return targetPoints.some((point) => planes.every((plane) => (
            plane[0] * (Number(point[0]) - eye[0])
            + plane[1] * (Number(point[1]) - eye[1])
            + plane[2] * (Number(point[2]) - eye[2])
        ) >= -0.075));
    }

    _portalCenterData(instance, portal) {
        const corners = this._portalCornersData(instance, portal);
        if (!corners.length) return null;
        return [0, 1, 2].map((axis) => corners.reduce((sum, corner) => sum + corner[axis], 0) / corners.length);
    }

    _portalCornersData(instance, portal) {
        const corners = Array.isArray(portal?.corners) ? portal.corners : [];
        if (!instance?.mat16 || corners.length === 0) return [];
        const output = [];
        for (const corner of corners) {
            if (!Array.isArray(corner) || corner.length < 3) continue;
            const point = glMatrix.vec4.fromValues(Number(corner[0]) || 0, Number(corner[1]) || 0, Number(corner[2]) || 0, 1);
            const transformed = glMatrix.vec4.create();
            glMatrix.vec4.transformMat4(transformed, point, instance.mat16);
            output.push([transformed[0], transformed[1], transformed[2]]);
        }
        return output;
    }

    _distanceToPortalAperture(point, corners) {
        if (!Array.isArray(point) || !Array.isArray(corners) || corners.length < 3) return Number.POSITIVE_INFINITY;
        const center = [0, 1, 2].map((axis) => corners.reduce((sum, corner) => sum + corner[axis], 0) / corners.length);
        let radius = 0;
        for (const corner of corners) radius = Math.max(radius, Math.hypot(corner[0] - center[0], corner[1] - center[1], corner[2] - center[2]));
        const edgeA = [corners[1][0] - corners[0][0], corners[1][1] - corners[0][1], corners[1][2] - corners[0][2]];
        const edgeB = [corners[2][0] - corners[0][0], corners[2][1] - corners[0][1], corners[2][2] - corners[0][2]];
        const normal = [
            edgeA[1] * edgeB[2] - edgeA[2] * edgeB[1],
            edgeA[2] * edgeB[0] - edgeA[0] * edgeB[2],
            edgeA[0] * edgeB[1] - edgeA[1] * edgeB[0],
        ];
        const normalLength = Math.hypot(...normal);
        if (normalLength < 1e-6) return Math.hypot(point[0] - center[0], point[1] - center[1], point[2] - center[2]);
        const planeDistance = Math.abs(
            (point[0] - center[0]) * normal[0]
            + (point[1] - center[1]) * normal[1]
            + (point[2] - center[2]) * normal[2]
        ) / normalLength;
        const centerDistance = Math.hypot(point[0] - center[0], point[1] - center[1], point[2] - center[2]);
        const radialOverflow = Math.max(0, centerDistance - radius);
        return Math.hypot(planeDistance, radialOverflow);
    }

    syncMloPortalDoors(doors = [], states = new Map()) {
        const next = new Map();
        for (const instance of this._mloInstancesLast || []) {
            const def = this._mloDefs.get(String(instance.archHash));
            for (const authoredPortal of (def?.portals || [])) {
                const portal = this._runtimePortal(instance.parentGuid, authoredPortal);
                if (((Number(portal?.flags) >>> 0) & MLO_PORTAL_FLAG_HIDE_WHEN_DOOR_CLOSED) === 0) continue;
                const corners = this._portalCornersData(instance, portal);
                if (!corners.length) continue;
                let progress = -1;
                for (const door of (Array.isArray(doors) ? doors : [])) {
                    const coords = door?.coords;
                    if (!coords) continue;
                    const distance = this._distanceToPortalAperture(
                        [Number(coords.x), Number(coords.y), Number(coords.z)],
                        corners,
                    );
                    const bindRadius = Math.max(1.5, Math.min(3.0, Number(door?.radius) || 0));
                    if (!(distance <= bindRadius)) continue;
                    progress = Math.max(progress, Number(states?.get?.(door.id)?.progress) || 0);
                }
                if (progress >= 0) next.set(this._portalKey(instance.parentGuid, portal), progress);
            }
        }
        let visibilityChanged = next.size !== this._mloPortalOpenOverrides.size;
        if (!visibilityChanged) {
            for (const [key, value] of next) {
                const previous = this._mloPortalOpenOverrides.get(key);
                if ((Number(previous) >= 0.35) !== (Number(value) >= 0.35)) {
                    visibilityChanged = true;
                    break;
                }
            }
        }
        this._mloPortalOpenOverrides = next;
        if (visibilityChanged) this._dirty = true;
        return next.size;
    }

    _computeVisibleRooms(def, startRoomIdx, parentGuid = 0, localViewPosition = null) {
        const rooms = Array.isArray(def?.rooms) ? def.rooms : [];
        const portals = Array.isArray(def?.portals) ? def.portals : [];
        const maxDepth = Math.max(0, Math.min(8, Math.floor(this.interiorPortalDepth || 0)));
        const vis = new Set();
        if (!(Number.isFinite(startRoomIdx) && startRoomIdx >= 0)) return vis;
        vis.add(startRoomIdx);
        if (!this.enableRoomGating || maxDepth <= 0) return vis;

        // Build adjacency from portals.
        /** @type {Map<number, Array<{ room:number, portal:object }>>} */
        const adj = new Map();
        for (const authoredPortal of portals) {
            const p = this._runtimePortal(parentGuid, authoredPortal);
            const a = Number(p?.roomFrom);
            const b = Number(p?.roomTo);
            if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
            if (a < 0 || b < 0 || a >= rooms.length || b >= rooms.length) continue;
            if (!this._isPortalOpen(parentGuid, p)) continue;
            if (!adj.has(a)) adj.set(a, []);
            adj.get(a).push({ room: b, portal: p });
            if (((Number(p?.flags) >>> 0) & MLO_PORTAL_FLAG_ONE_WAY) === 0) {
                if (!adj.has(b)) adj.set(b, []);
                adj.get(b).push({ room: a, portal: p });
            }
        }

        /** @type {Array<{r:number,d:number,aperture:object|null}>} */
        const q = [{ r: startRoomIdx, d: 0, aperture: null }];
        while (q.length) {
            const { r, d, aperture } = q.shift();
            if (d >= maxDepth) continue;
            const ns = adj.get(r) || [];
            for (const edge of ns) {
                const n = edge.room;
                if (vis.has(n)) continue;
                if (aperture && !this._portalVisibleThroughAperture(localViewPosition, aperture, edge.portal)) continue;
                const nextDepth = d + 1;
                const exteriorDepth = Number(rooms[n]?.exteriorVisibilityDepth);
                if (startRoomIdx === this._findExteriorRoomIndex(def)
                    && Number.isFinite(exteriorDepth) && exteriorDepth >= 0 && nextDepth > exteriorDepth) continue;
                vis.add(n);
                q.push({ r: n, d: nextDepth, aperture: edge.portal });
            }
        }
        return vis;
    }

    _isMloSetEnabled(parentGuid, setHash, flags = 0) {
        if (!this.enableMloEntitySets) return true;
        const pg = (Number(parentGuid) >>> 0);
        const sh = (Number(setHash) >>> 0);
        if (!pg || !sh) return true; // not an entity-set child
        const key = `${pg}:${sh}`;
        const v = this._mloSetOverrides.get(key);
        if (v !== undefined) return !!v;
        const decoded = this._decodeMloFlags(flags);
        const hasRuntimeOwnership = ((decoded.flags >>> MLO_ROOM_SHIFT) & 0xffff) !== 0;
        if (hasRuntimeOwnership) this._mloSetDefaults.set(key, decoded.entitySetDefault);
        return hasRuntimeOwnership ? decoded.entitySetDefault : true;
    }

    _resolveActiveInterior(instances, position) {
        let nearestInterior = null;
        let nearestInteriorDistance = Number.POSITIVE_INFINITY;
        let nearestExterior = null;
        let nearestDistance = Number.POSITIVE_INFINITY;
        for (const inst of instances || []) {
            const def = this._mloDefs.get(String(inst.archHash));
            if (!def || !Array.isArray(def.rooms) || def.rooms.length === 0) continue;
            const inv = glMatrix.mat4.create();
            if (!glMatrix.mat4.invert(inv, inst.mat16)) continue;
            const input = glMatrix.vec4.fromValues(position[0], position[1], position[2], 1.0);
            const output = glMatrix.vec4.create();
            glMatrix.vec4.transformMat4(output, input, inv);
            const local = [output[0], output[1], output[2]];
            const rootDistance = Math.hypot(
                position[0] - Number(inst.mat16[12]),
                position[1] - Number(inst.mat16[13]),
                position[2] - Number(inst.mat16[14]),
            );
            const sentinelBounds = this._hasSentinelRoomBounds(def);
            const hasContentBounds = Number.isFinite(this._distanceToMloContentBounds(local, def));
            const hasSpatialBounds = Number.isFinite(this._distanceToMloSpatialBounds(position, inst.spatialBounds));
            let insideSpatialEnvelope = false;
            if (sentinelBounds && (hasContentBounds || hasSpatialBounds)) {
                // V3 definitions store this envelope once at import time. The
                // streamed-child envelope remains a compatibility fallback for
                // older packages only.
                const envelopeDistance = hasContentBounds
                    ? this._distanceToMloContentBounds(local, def, 4.0, 6.0)
                    : this._distanceToMloSpatialBounds(position, inst.spatialBounds, 4.0, 6.0);
                insideSpatialEnvelope = envelopeDistance === 0;
                const exteriorDistance = hasContentBounds
                    ? this._distanceToMloContentBounds(local, def, 0.0, 4.0)
                    : this._distanceToMloSpatialBounds(position, inst.spatialBounds, 0.0, 4.0);
                if (!insideSpatialEnvelope && exteriorDistance > Math.min(40.0, this.interiorExteriorDistance)) continue;
            } else if (rootDistance > this._interiorActivationRadius(def)) {
                continue;
            }
            const exteriorRoomIndex = this._findExteriorRoomIndex(def);
            const roomIndex = sentinelBounds && (hasContentBounds || hasSpatialBounds) && !insideSpatialEnvelope
                ? exteriorRoomIndex
                : this._findContainingRoomIndex(def, local);
            if (roomIndex >= 0 && roomIndex !== exteriorRoomIndex && rootDistance < nearestInteriorDistance) {
                nearestInteriorDistance = rootDistance;
                nearestInterior = {
                    parentGuid: inst.parentGuid,
                    archHash: String(inst.archHash),
                    roomIndex,
                    exteriorRoomIndex,
                    isExterior: false,
                    visibleRooms: this._computeVisibleRooms(def, roomIndex, inst.parentGuid, local),
                    invMat: inv,
                    mat16: inst.mat16,
                    localPosition: local,
                };
                continue;
            }
            const distance = this._distanceToInteriorBounds(def, local);
            if (exteriorRoomIndex >= 0 && distance <= this.interiorExteriorDistance && distance < nearestDistance) {
                nearestDistance = distance;
                nearestExterior = {
                    parentGuid: inst.parentGuid,
                    archHash: String(inst.archHash),
                    roomIndex: exteriorRoomIndex,
                    exteriorRoomIndex,
                    isExterior: true,
                    visibleRooms: this._computeVisibleRooms(def, exteriorRoomIndex, inst.parentGuid, local),
                    invMat: inv,
                    mat16: inst.mat16,
                    localPosition: local,
                };
            }
        }
        return nearestInterior || nearestExterior;
    }

    _resolveVisibleInteriors(instances, position) {
        const visible = new Map();
        let active = null;
        let activeDistance = Number.POSITIVE_INFINITY;
        for (const instance of instances || []) {
            const state = this._resolveActiveInterior([instance], position);
            if (!state) continue;
            visible.set(Number(state.parentGuid) >>> 0, state);
            const rootDistance = Math.hypot(
                position[0] - Number(instance.mat16?.[12]),
                position[1] - Number(instance.mat16?.[13]),
                position[2] - Number(instance.mat16?.[14]),
            );
            // A containing room owns environment/audio state. If more than one
            // authored shell overlaps, choose the nearest root deterministically.
            if (!active || (active.isExterior && !state.isExterior)
                || (active.isExterior === state.isExterior && rootDistance < activeDistance)) {
                active = state;
                activeDistance = rootDistance;
            }
        }
        return { active, visible };
    }

    _filterEntriesForActiveInterior(entries, suppliedMloInstances = null) {
        if (!this.enableInteriors) return entries;

        // Discover MLO instances present in the loaded set (metadata stride=21).
        /** @type {Array<{ parentGuid:number, archHash:string, mat16:Float32Array }>} */
        const mloInstances = Array.isArray(suppliedMloInstances) ? suppliedMloInstances : [];
        if (!Array.isArray(suppliedMloInstances)) {
            for (const e of entries) {
                const mats = e.mats;
                const stride = this._instanceStrideFloatsForLen(mats.length ?? 0, e.instanceStrideFloats);
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
        }
        this._mloInstancesLast = mloInstances;

        // Worker roots carry the complete pre-cull child envelope. The
        // fallback path enriches it from resident render entries and mesh
        // radii. Both paths therefore use the same MLO activation semantics.
        this._attachMloSpatialBounds(entries, mloInstances);

        const resolved = this._resolveVisibleInteriors(mloInstances, this._lastCamDataPos || [0, 0, 0]);
        const active = resolved.active;
        this._visibleMloInteriors = resolved.visible;

        const key = active ? `${active.parentGuid}:${active.archHash}:${active.roomIndex}:${active.isExterior ? 1 : 0}:${Array.from(active.visibleRooms).sort((a,b)=>a-b).join(',')}` : '';
        this._activeInterior = active;
        this._activeInteriorKey = key;
        this._publishInteriorRuntimeStatus();

        // If no imported shell is close enough to contribute through its
        // exterior room/portals, drop all interior-child instances.
        if (resolved.visible.size === 0) {
            const outEntries = [];
            for (const e of entries) {
                const stride = this._instanceStrideFloatsForLen(e.mats.length ?? 0, e.instanceStrideFloats);
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

        // Render every nearby MLO shell using its own room/portal visibility.
        // Only `active` owns environment/audio; visibility is not globally
        // collapsed to one interior, which avoids isolated/vanishing MLOs.
        const outEntries = [];
        for (const e of entries) {
            const stride = this._instanceStrideFloatsForLen(e.mats.length ?? 0, e.instanceStrideFloats);
            if (stride < 21) { outEntries.push(e); continue; }
            const filtered = [];
            const a = e.mats;
            for (let i = 0; i + (stride - 1) < a.length; i += stride) {
                const mloParentGuid = (a[i + 18] >>> 0);
                const mloSetHash = (a[i + 19] >>> 0);
                const mloFlags = (a[i + 20] >>> 0);
                if (mloParentGuid) {
                    const visibility = resolved.visible.get(mloParentGuid);
                    if (!visibility) continue;
                    if (!this._isMloSetEnabled(mloParentGuid, mloSetHash, mloFlags)) continue;

                    if (this.enableRoomGating && visibility.invMat) {
                        const def = this._mloDefs.get(String(visibility.archHash));
                        const rooms = Array.isArray(def?.rooms) ? def.rooms : [];
                        const ownership = this._decodeMloFlags(mloFlags);
                        if (ownership.portalIndex >= 0) {
                            const portal = this._runtimePortal(
                                mloParentGuid,
                                (def?.portals || [])[ownership.portalIndex],
                            );
                            const from = Number(portal?.roomFrom);
                            const to = Number(portal?.roomTo);
                            if (!visibility.visibleRooms.has(from) && !visibility.visibleRooms.has(to)) continue;
                        } else {
                            let ri = ownership.roomIndex;
                            if (ri < 0) {
                                const tx = a[i + 12], ty = a[i + 13], tz = a[i + 14];
                                const v4 = glMatrix.vec4.fromValues(tx, ty, tz, 1.0);
                                const out = glMatrix.vec4.create();
                                glMatrix.vec4.transformMat4(out, v4, visibility.invMat);
                                ri = this._findContainingRoomIndex(def, [out[0], out[1], out[2]]);
                            }
                            if (ri >= 0 && ri < rooms.length && !visibility.visibleRooms.has(ri)) continue;
                        }
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
        const active = this._resolveVisibleInteriors(
            this._mloInstancesLast || [], this._lastCamDataPos || [0, 0, 0]
        ).active;
        const key = active
            ? `${active.parentGuid}:${active.archHash}:${active.roomIndex}:${active.isExterior ? 1 : 0}:${Array.from(active.visibleRooms).sort((a, b) => a - b).join(',')}`
            : '';
        return { active, key };
    }

    getInteriorStateAtDataPos(posData, { includeExterior = true } = {}) {
        if (!this.enableInteriors || !posData || posData.length < 3) return null;
        const position = [Number(posData[0]), Number(posData[1]), Number(posData[2])];
        if (!position.every(Number.isFinite)) return null;
        const active = this._resolveActiveInterior(this._mloInstancesLast || [], position);
        if (!active || (!includeExterior && active.isExterior)) return null;
        const def = this._mloDefs.get(String(active.archHash));
        const room = def?.rooms?.[active.roomIndex] || null;
        return {
            ...active,
            definition: def || null,
            room: room || null,
            roomName: String(room?.name || ''),
        };
    }

    _findPortalPath(def, fromRoom, toRoom, parentGuid = 0) {
        if (fromRoom === toRoom) return [];
        const portals = Array.isArray(def?.portals) ? def.portals : [];
        const queue = [{ room: fromRoom, path: [] }];
        const visited = new Set([fromRoom]);
        while (queue.length) {
            const current = queue.shift();
            if (current.path.length >= 12) continue;
            for (const authoredPortal of portals) {
                const portal = this._runtimePortal(parentGuid, authoredPortal);
                if (!this._isPortalOpen(parentGuid, portal)) continue;
                const a = Number(portal?.roomFrom);
                const b = Number(portal?.roomTo);
                const oneWay = ((Number(portal?.flags) >>> 0) & MLO_PORTAL_FLAG_ONE_WAY) !== 0;
                const next = a === current.room ? b : (!oneWay && b === current.room ? a : -1);
                if (next < 0 || visited.has(next)) continue;
                const path = current.path.concat(portal);
                if (next === toRoom) return path;
                visited.add(next);
                queue.push({ room: next, path });
            }
        }
        return null;
    }

    getMloAcousticPath(sourcePosData, listenerPosData) {
        const source = this.getInteriorStateAtDataPos(sourcePosData, { includeExterior: true });
        const listener = this.getInteriorStateAtDataPos(listenerPosData, { includeExterior: true });
        if (!source && !listener) return { occluded: false, gain: 1, cutoffHz: 20000, portalCount: 0 };
        if (!source || !listener || source.parentGuid !== listener.parentGuid) {
            const enclosed = !!(source && !source.isExterior) || !!(listener && !listener.isExterior);
            return enclosed
                ? { occluded: true, gain: 0.32, cutoffHz: 1050, portalCount: 0 }
                : { occluded: false, gain: 1, cutoffHz: 20000, portalCount: 0 };
        }
        const path = this._findPortalPath(source.definition, source.roomIndex, listener.roomIndex, source.parentGuid);
        if (path === null) return { occluded: true, gain: 0.18, cutoffHz: 700, portalCount: 0 };
        if (path.length === 0) return { occluded: false, gain: 1, cutoffHz: 20000, portalCount: 0 };
        let authored = 0;
        let doorClosure = 0;
        for (const portal of path) {
            const raw = Math.max(0, Number(portal?.audioOcclusion) || 0);
            const normalized = raw <= 1 ? raw : Math.min(1, raw / 255);
            authored += normalized;
            doorClosure += 1 - this._portalOpenProgress(source.parentGuid, portal);
        }
        const barrier = Math.min(1, 0.18 * path.length + 0.62 * authored + 0.55 * doorClosure);
        return {
            occluded: barrier > 0.02,
            gain: Math.max(0.18, 1 - barrier * 0.72),
            cutoffHz: Math.max(650, 20000 * Math.pow(0.075, barrier)),
            portalCount: path.length,
        };
    }

    getActiveInteriorEnvironment(hour = 12) {
        const active = this._activeInterior;
        if (!active || active.isExterior) return null;
        const def = this._mloDefs.get(String(active.archHash));
        const room = def?.rooms?.[active.roomIndex];
        if (!room) return null;
        let modifierStrength = 0;
        const local = active.localPosition || [0, 0, 0];
        const h = ((Number(hour) || 0) % 24 + 24) % 24;
        for (const modifier of (def.timecycleModifiers || [])) {
            const start = Number(modifier?.startHour) || 0;
            const end = Number(modifier?.endHour) || 24;
            const activeHour = start <= end ? (h >= start && h <= end) : (h >= start || h <= end);
            if (!activeHour) continue;
            const sphere = modifier?.sphere;
            if (!Array.isArray(sphere) || sphere.length < 4) continue;
            const distance = Math.hypot(local[0] - sphere[0], local[1] - sphere[1], local[2] - sphere[2]);
            const radius = Math.max(0.001, Number(sphere[3]) || Number(modifier?.range) || 0.001);
            const spatial = Math.max(0, 1 - distance / radius);
            const percentage = Number(modifier?.percentage);
            const weight = Number.isFinite(percentage) ? Math.min(1, percentage > 1 ? percentage / 100 : percentage) : 1;
            modifierStrength = Math.max(modifierStrength, spatial * weight);
        }
        const blend = Math.max(0, Math.min(1, Number(room.blend) || 0));
        const hasNamedTimecycle = (Number(room.timecycleName) >>> 0) !== 0 || (Number(room.secondaryTimecycleName) >>> 0) !== 0;
        const exteriorRoom = this._findExteriorRoomIndex(def);
        const exteriorPath = exteriorRoom >= 0
            ? this._findPortalPath(def, active.roomIndex, exteriorRoom, active.parentGuid)
            : null;
        let exteriorInfluence = 0;
        if (Array.isArray(exteriorPath) && exteriorPath.length > 0) {
            let transmission = 1;
            for (const portal of exteriorPath) {
                const flags = Number(portal?.flags) >>> 0;
                const opacityRaw = Math.max(0, Number(portal?.opacity) || 0);
                const opacity = opacityRaw <= 1 ? opacityRaw : Math.min(1, opacityRaw / 255);
                const doorTransmission = this._portalOpenProgress(active.parentGuid, portal);
                transmission *= ((flags & MLO_PORTAL_FLAG_LIGHT_BLEED) !== 0 ? (1 - opacity * 0.75) : 0.55)
                    * doorTransmission;
            }
            exteriorInfluence = Math.max(0, Math.min(0.65, 0.58 * transmission / Math.sqrt(exteriorPath.length)));
        }
        const authoredStrength = Math.max(modifierStrength, hasNamedTimecycle ? 0.72 : 0.45 + 0.25 * blend);
        return {
            parentGuid: active.parentGuid,
            archetypeHash: active.archHash,
            roomIndex: active.roomIndex,
            roomName: String(room.name || ''),
            timecycleName: Number(room.timecycleName) >>> 0,
            timecycleNameText: String(room.timecycleNameText || ''),
            secondaryTimecycleName: Number(room.secondaryTimecycleName) >>> 0,
            secondaryTimecycleNameText: String(room.secondaryTimecycleNameText || ''),
            exteriorInfluence,
            strength: authoredStrength * (1 - exteriorInfluence * 0.5),
        };
    }

    getInteriorRuntimeStatus() {
        const active = this._activeInterior;
        return {
            definitions: this._mloDefs.size,
            instances: this._mloInstancesLast.length,
            active: !!active,
            exterior: !!active?.isExterior,
            archetypeHash: active?.archHash || '',
            roomIndex: Number.isFinite(active?.roomIndex) ? active.roomIndex : -1,
            visibleRooms: active ? Array.from(active.visibleRooms).sort((a, b) => a - b) : [],
            rootArchetypeHashes: this._mloInstancesLast.map((instance) => String(instance.archHash)),
            loadedChunks: Array.from(this.loaded || []).map(String).sort(),
            focus: Array.from(this._lastCamDataPos || []).slice(0, 3).map((value) => Math.round(Number(value) * 100) / 100),
        };
    }

    _publishInteriorRuntimeStatus() {
        try {
            document.documentElement.dataset.mloRuntime = JSON.stringify(this.getInteriorRuntimeStatus());
        } catch { /* non-browser tests */ }
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

                const exteriorRoomIndex = this._findExteriorRoomIndex(def);
                const roomOrder = rooms.map((_room, index) => index)
                    .sort((a, b) => (a === exteriorRoomIndex ? 1 : 0) - (b === exteriorRoomIndex ? 1 : 0));
                for (const ri of roomOrder) {
                    const r = rooms[ri];
                    const mn = r?.bbMin;
                    const mx = r?.bbMax;
                    if (!Array.isArray(mn) || !Array.isArray(mx) || mn.length < 3 || mx.length < 3) continue;

                    // XY must be within the room footprint; Z is allowed a tolerance so we can "snap up"
                    // when the spawn is slightly under the room floor.
                    let roomMinX = Math.min(Number(mn[0]), Number(mx[0]));
                    let roomMaxX = Math.max(Number(mn[0]), Number(mx[0]));
                    let roomMinY = Math.min(Number(mn[1]), Number(mx[1]));
                    let roomMaxY = Math.max(Number(mn[1]), Number(mx[1]));
                    let roomMinZ = Math.min(Number(mn[2]), Number(mx[2]));
                    let roomMaxZ = Math.max(Number(mn[2]), Number(mx[2]));

                    // Some converted FiveM MLOs retain the archetype's giant
                    // fallback bounds for every room. Those bounds put the
                    // nominal floor tens of metres underground. For the active
                    // room, recover a conservative footprint and threshold
                    // height from its authored portals instead. This is still
                    // source metadata: no destination coordinates or room names
                    // are baked into gameplay code.
                    const suspiciousBounds = (roomMaxX - roomMinX) > 200.0
                        || (roomMaxY - roomMinY) > 200.0
                        || (roomMaxZ - roomMinZ) > 50.0;
                    const active = this._activeInterior;
                    const isActiveRoom = suspiciousBounds
                        && (Number(active?.parentGuid) >>> 0) === (Number(inst.parentGuid) >>> 0)
                        && String(active?.archHash) === String(inst.archHash)
                        && Number(active?.roomIndex) === Number(ri);
                    if (isActiveRoom) {
                        const portalCorners = (Array.isArray(def.portals) ? def.portals : [])
                            .filter((portal) => Number(portal?.roomFrom) === Number(ri) || Number(portal?.roomTo) === Number(ri))
                            .flatMap((portal) => Array.isArray(portal?.corners) ? portal.corners : [])
                            .filter((corner) => Array.isArray(corner) && corner.length >= 3 && corner.slice(0, 3).every(Number.isFinite));
                        if (portalCorners.length >= 4) {
                            const portalPad = 6.0;
                            roomMinX = Math.min(...portalCorners.map((corner) => Number(corner[0]))) - portalPad;
                            roomMaxX = Math.max(...portalCorners.map((corner) => Number(corner[0]))) + portalPad;
                            roomMinY = Math.min(...portalCorners.map((corner) => Number(corner[1]))) - portalPad;
                            roomMaxY = Math.max(...portalCorners.map((corner) => Number(corner[1]))) + portalPad;
                            roomMinZ = Math.min(...portalCorners.map((corner) => Number(corner[2])));
                            roomMaxZ = Math.max(...portalCorners.map((corner) => Number(corner[2]))) + 2.0;
                        }
                    }
                    if (!(lx >= roomMinX && lx <= roomMaxX && ly >= roomMinY && ly <= roomMaxY)) continue;

                    const inRoomStrict = (lz >= roomMinZ && lz <= roomMaxZ);
                    const inRoomPadded = (lz >= (roomMinZ - zPadBelow) && lz <= (roomMaxZ + zPadAbove));
                    if (!inRoomStrict && !inRoomPadded) continue;

                    // Compute world/data-space floor Z at the same local XY.
                    const floorLocal = glMatrix.vec4.fromValues(lx, ly, roomMinZ, 1.0);
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
        if (!pg || !sh) return false;
        const key = `${pg}:${sh}`;
        this._mloSetOverrides.set(key, !!enabled);
        this._dirty = true;
        try {
            window.dispatchEvent(new CustomEvent('webglgta:mlo-entity-set-changed', {
                detail: { parentGuid: pg, setHash: sh, enabled: !!enabled },
            }));
        } catch { /* non-browser tests */ }
        return true;
    }

    _resolveMloEntitySetHash(def, setIdentifier) {
        const numeric = Number(setIdentifier);
        if (Number.isFinite(numeric) && numeric > 0) return numeric >>> 0;
        const wanted = String(setIdentifier ?? '').trim().toLowerCase();
        if (!wanted) return 0;
        const match = (def?.entitySets || []).find((set) => String(set?.name || '').trim().toLowerCase() === wanted);
        return Number(match?.hash) >>> 0;
    }

    getMloEntitySets(parentGuid = null) {
        const wantedParent = parentGuid === null || parentGuid === undefined ? null : (Number(parentGuid) >>> 0);
        const result = [];
        for (const instance of this._mloInstancesLast || []) {
            const pg = Number(instance.parentGuid) >>> 0;
            if (wantedParent !== null && pg !== wantedParent) continue;
            const def = this._mloDefs.get(String(instance.archHash));
            for (const set of (def?.entitySets || [])) {
                const setHash = Number(set?.hash) >>> 0;
                const key = `${pg}:${setHash}`;
                const override = this._mloSetOverrides.get(key);
                const authoredDefault = this._mloSetDefaults.get(key);
                result.push({
                    parentGuid: pg,
                    archetypeHash: String(instance.archHash),
                    setHash,
                    name: String(set?.name || ''),
                    enabled: override !== undefined ? !!override : authoredDefault !== false,
                    overridden: override !== undefined,
                });
            }
        }
        return result;
    }

    setMloEntitySetEnabledForInterior(interiorIdentifier, setIdentifier, enabled) {
        const wanted = String(interiorIdentifier ?? '').trim();
        const numeric = Number(interiorIdentifier);
        let changed = 0;
        for (const instance of this._mloInstancesLast || []) {
            const pg = Number(instance.parentGuid) >>> 0;
            const parentMatch = Number.isFinite(numeric) && numeric > 0 && pg === (numeric >>> 0);
            const archetypeMatch = wanted && String(instance.archHash) === wanted;
            if (!parentMatch && !archetypeMatch) continue;
            const def = this._mloDefs.get(String(instance.archHash));
            const setHash = this._resolveMloEntitySetHash(def, setIdentifier);
            if (setHash && this.setMloEntitySetEnabled(pg, setHash, enabled)) changed++;
        }
        return changed;
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

    getMloPortals(parentGuid = null) {
        const wantedParent = parentGuid === null || parentGuid === undefined ? null : (Number(parentGuid) >>> 0);
        const result = [];
        for (const instance of this._mloInstancesLast || []) {
            const pg = Number(instance.parentGuid) >>> 0;
            if (wantedParent !== null && pg !== wantedParent) continue;
            const def = this._mloDefs.get(String(instance.archHash));
            for (const authoredPortal of (def?.portals || [])) {
                const portal = this._runtimePortal(pg, authoredPortal);
                result.push({
                    parentGuid: pg,
                    archetypeHash: String(instance.archHash),
                    index: Number(portal?.index) >>> 0,
                    roomFrom: Number(portal?.roomFrom),
                    roomTo: Number(portal?.roomTo),
                    flags: Number(portal?.flags) >>> 0,
                    mirrorPriority: Number(portal?.mirrorPriority) || 0,
                    opacity: Number(portal?.opacity) || 0,
                    audioOcclusion: Number(portal?.audioOcclusion) || 0,
                    overridden: this._mloPortalDefinitionOverrides.has(this._portalKey(pg, authoredPortal)),
                });
            }
        }
        return result;
    }

    getVisibleMloMirrorPortal({ maxDistance = 80 } = {}) {
        const camera = this._lastCamDataPos || [0, 0, 0];
        let best = null;
        for (const instance of this._mloInstancesLast || []) {
            const parentGuid = Number(instance.parentGuid) >>> 0;
            const visibility = this._visibleMloInteriors?.get?.(parentGuid);
            if (!visibility) continue;
            const def = this._mloDefs.get(String(instance.archHash));
            for (const authoredPortal of (def?.portals || [])) {
                const portal = this._runtimePortal(parentGuid, authoredPortal);
                if (((Number(portal?.flags) >>> 0) & MLO_PORTAL_FLAG_MIRROR) === 0) continue;
                const from = Number(portal?.roomFrom);
                const to = Number(portal?.roomTo);
                if (!visibility.visibleRooms?.has?.(from) && !visibility.visibleRooms?.has?.(to)) continue;
                const corners = this._portalCornersData(instance, portal);
                if (corners.length < 3) continue;
                const center = [0, 1, 2].map((axis) => corners.reduce((sum, corner) => sum + corner[axis], 0) / corners.length);
                const distance = Math.hypot(center[0] - camera[0], center[1] - camera[1], center[2] - camera[2]);
                if (distance > Math.max(4, Number(maxDistance) || 80)) continue;
                const direction = this._lastCamDataDir || [0, 0, -1];
                const facing = distance > 1e-5
                    ? ((center[0] - camera[0]) * direction[0]
                        + (center[1] - camera[1]) * direction[1]
                        + (center[2] - camera[2]) * direction[2]) / distance
                    : 1;
                if (facing < -0.15) continue;
                const priority = Number(portal?.mirrorPriority) || 0;
                const score = distance - priority * 2;
                if (!best || score < best.score) {
                    best = {
                        parentGuid,
                        archetypeHash: String(instance.archHash),
                        portalIndex: Number(portal?.index) >>> 0,
                        flags: Number(portal?.flags) >>> 0,
                        mirrorPriority: priority,
                        cornersData: corners,
                        centerData: center,
                        distance,
                        score,
                    };
                }
            }
        }
        return best;
    }

    setMloPortalDefinition(parentGuid, portalIndex, patch = {}) {
        const pg = Number(parentGuid) >>> 0;
        const index = Number(portalIndex) >>> 0;
        const instance = (this._mloInstancesLast || []).find((entry) => (Number(entry.parentGuid) >>> 0) === pg);
        const def = instance ? this._mloDefs.get(String(instance.archHash)) : null;
        const authoredPortal = (def?.portals || []).find((portal) => (Number(portal?.index) >>> 0) === index);
        if (!pg || !authoredPortal) return false;
        const current = this._mloPortalDefinitionOverrides.get(this._portalKey(pg, authoredPortal)) || {};
        const next = { ...current };
        for (const key of ['roomFrom', 'roomTo', 'flags']) {
            if (!(key in patch)) continue;
            const value = Number(patch[key]);
            if (!Number.isFinite(value) || value < 0) return false;
            next[key] = key === 'flags' ? value >>> 0 : Math.floor(value);
        }
        this._mloPortalDefinitionOverrides.set(this._portalKey(pg, authoredPortal), next);
        this._dirty = true;
        try {
            window.dispatchEvent(new CustomEvent('webglgta:mlo-portal-changed', {
                detail: { parentGuid: pg, portalIndex: index, ...next },
            }));
        } catch { /* non-browser tests */ }
        return true;
    }

    clearMloPortalOverrides(parentGuid = null) {
        if (parentGuid === null || parentGuid === undefined) {
            this._mloPortalDefinitionOverrides.clear();
        } else {
            const prefix = `${Number(parentGuid) >>> 0}:`;
            for (const key of Array.from(this._mloPortalDefinitionOverrides.keys())) {
                if (String(key).startsWith(prefix)) this._mloPortalDefinitionOverrides.delete(key);
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

    async loadInteriorDefinitions(archetypeHashes = [], revision = 'v1') {
        const nextRevision = String(revision || 'v1');
        if (nextRevision !== this._mloDefinitionRevision) {
            this._mloDefinitionRevision = nextRevision;
            this._mloDefs.clear();
            this._mloDefsLoading.clear();
        }
        const hashes = Array.from(new Set((Array.isArray(archetypeHashes) ? archetypeHashes : [])
            .map((value) => String(value ?? '').trim())
            .filter(Boolean)));
        await Promise.all(hashes.map((hash) => this._ensureMloDefLoaded(hash)));
        this._dirty = true;
        this._publishInteriorRuntimeStatus();
        return this._mloDefs.size;
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
            const revision = [this._chunkCacheBust, this.index?.revision].filter(Boolean).join('-');
            const bust = revision ? `?v=${encodeURIComponent(revision)}` : '';
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
                if (this.chunkRebuildSettleMs <= 0 || this._lastCoreWantedSet.has(key)) {
                    this._dirty = true;
                    this._lastChunkSetChangeMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                }
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
            // An explicit binaryFile is authoritative. Demo-only indexes do not
            // ship an NDJSON twin, so global feature probes (for example ymap
            // time/weather gating) must not make us parse the .bin as text.
            if (this.preferBinary || isDemoBootstrap || meta.binaryFile) {
                try {
                    const binFile = String(meta.binaryFile || meta.file || '').replace(/\.jsonl$/i, '.bin');
                    const binPathBase = isDemoBootstrap
                        ? `assets/${binFile}`
                        : (meta.binaryFile
                            ? `assets/${binFile.replace(/^assets\//i, '').replace(/^\/+/, '')}`
                            : `assets/entities_chunks_inst/${binFile}`);
                    const binPath = `${binPathBase}${bust}`;
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
                                const dedupeExactRecords = isDemoBootstrap || !!this._demoChunkIndex;

                                // Prefer worker path: parse + build matrices off-thread.
                                try {
                                    const wr = await this._parseENT1InWorker(
                                        buf.slice(0),
                                        [camData[0], camData[1], camData[2]],
                                        {
                                            storeKey: key,
                                            storeOnly: !!this.enableWorkerRebuild,
                                            worldBounds: this.worldBounds,
                                            dedupeExactRecords,
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
                                    const bytes = dedupeExactRecords ? new Uint8Array(buf) : null;
                                    const exactRecords = dedupeExactRecords ? new Set() : null;

                                    for (let i = 0; i < count; i++) {
                                        const off = start + i * stride;
                                        if (exactRecords) {
                                            const recordKey = ent1RecordKey(bytes, off, stride);
                                            if (exactRecords.has(recordKey)) continue;
                                            exactRecords.add(recordKey);
                                        }
                                        const h = dv.getUint32(off + 0, true) >>> 0;
                                        const hash = String(h);

                                        // Kick off shard load early so real meshes can appear ASAP.
                                        this.modelManager?.prefetchMeta?.(hash);

                                        const px = dv.getFloat32(off + 4, true);
                                        const py = dv.getFloat32(off + 8, true);
                                        const pz = dv.getFloat32(off + 12, true);
                                        if (!this._isDataPositionInWorldBounds(px, py)) continue;

                                        let qx = dv.getFloat32(off + 16, true);
                                        let qy = dv.getFloat32(off + 20, true);
                                        let qz = dv.getFloat32(off + 24, true);
                                        const qw = dv.getFloat32(off + 28, true);

                                        const sx = dv.getFloat32(off + 32, true);
                                        const sy = dv.getFloat32(off + 36, true);
                                        const sz = dv.getFloat32(off + 40, true);
                                        const tintIndex = (stride >= 48) ? (dv.getUint32(off + 44, true) >>> 0) : 0;
                                        const guid = (stride >= 64) ? (dv.getUint32(off + 48, true) >>> 0) : 0;
                                        const mloParentGuid = (stride >= 64) ? (dv.getUint32(off + 52, true) >>> 0) : 0;
                                        const mloSetHash = (stride >= 64) ? (dv.getUint32(off + 56, true) >>> 0) : 0;
                                        const mloFlags = (stride >= 64) ? (dv.getUint32(off + 60, true) >>> 0) : 0;

                                        // ENT1 carries raw CEntityDef rotations. Match the JSON/CodeWalker
                                        // path by conjugating base YMAP entities only. MLO roots and
                                        // interior children already carry their world-space orientation.
                                        const isMloInstance = (mloFlags & 1) !== 0;
                                        const hasMloParent = mloParentGuid !== 0;
                                        if (!isMloInstance && !hasMloParent) {
                                            qx = -qx;
                                            qy = -qy;
                                            qz = -qz;
                                        }

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
                                const stride = this._instanceStrideFloatsForLen(mats.length, it?.strideFloats);
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
                                mats.__webglgtaInstanceStride = stride;
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
                    const packed = new Float32Array(mats);
                    packed.__webglgtaInstanceStride = 22;
                    chunkMap.set(hash, packed);
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
            if (this.chunkRebuildSettleMs <= 0 || this._lastCoreWantedSet.has(key)) {
                this._dirty = true;
                this._lastChunkSetChangeMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            }

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

    _computeCoverageStats({ keptArchetypes = null, droppedArchetypes = null, totalMeshArchetypes = null, keptInstances = null, totalMeshInstances = null, keptRealArchetypes = null, keptPlaceholderArchetypes = null, duplicateInstancesDropped = 0, cappedInstances = 0 } = {}) {
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
            cappedInstances: Math.max(0, Math.floor(Number(cappedInstances) || 0)),
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

    suppressInstance({ archetypeHash, x, y, z, radius = 0.2 } = {}) {
        const hash = String(archetypeHash || '').trim();
        const px = Number(x); const py = Number(y); const pz = Number(z);
        if (!hash || ![px, py, pz].every(Number.isFinite)) return false;
        const tolerance = Math.max(0.08, Math.min(1.0, Number(radius) * 0.12 || 0.2));
        let records = this._suppressedInstancesByHash.get(hash);
        if (!records) {
            records = [];
            this._suppressedInstancesByHash.set(hash, records);
        }
        if (records.some((record) => Math.hypot(record.x - px, record.y - py, record.z - pz) <= Math.min(record.tolerance, tolerance))) {
            return false;
        }
        records.push({ x: px, y: py, z: pz, tolerance });
        this._dirty = true;
        return true;
    }

    setInstanceTransformOverride({ archetypeHash, source, position } = {}) {
        const hash = String(archetypeHash || '').trim();
        const from = Array.isArray(source) ? source.map(Number) : [];
        const to = Array.isArray(position) ? position.map(Number) : [];
        if (!hash || from.length < 3 || to.length < 3 || ![...from, ...to].every(Number.isFinite)) return false;
        let records = this._instanceTransformOverridesByHash.get(hash);
        if (!records) {
            records = [];
            this._instanceTransformOverridesByHash.set(hash, records);
        }
        let record = records.find((item) => Math.hypot(item.source[0] - from[0], item.source[1] - from[1], item.source[2] - from[2]) <= 0.12);
        if (!record) {
            record = { source: from.slice(0, 3), position: to.slice(0, 3) };
            records.push(record);
        } else {
            record.position = to.slice(0, 3);
        }
        this._dirty = true;
        return true;
    }

    _instanceTransformOverride(hash, x, y, z) {
        for (const record of this._instanceTransformOverridesByHash.get(String(hash)) || []) {
            if (Math.hypot(record.source[0] - x, record.source[1] - y, record.source[2] - z) <= 0.12) return record;
        }
        return null;
    }

    _isInstanceSuppressed(hash, x, y, z) {
        const records = this._suppressedInstancesByHash.get(String(hash));
        if (!records?.length) return false;
        for (const record of records) {
            if (Math.hypot(record.x - x, record.y - y, record.z - z) <= record.tolerance) return true;
        }
        return false;
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
        const aggStrides = new Map(); // hash -> authoritative source stride
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
                const stride = this._instanceStrideFloatsForLen(mats.length ?? 0, mats.__webglgtaInstanceStride);
                const priorStride = aggStrides.get(hash);
                if (priorStride === undefined) aggStrides.set(hash, stride);
                else if (priorStride !== stride) {
                    console.warn(`DrawableStreamer: mixed instance layouts for hash=${hash}; dropping incompatible chunk slice`);
                    continue;
                }
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
                    const sourceTx = Number(mats[i + 12] ?? 0);
                    const sourceTy = Number(mats[i + 13] ?? 0);
                    const sourceTz = Number(mats[i + 14] ?? 0);
                    const transformOverride = this._instanceTransformOverride(hash, sourceTx, sourceTy, sourceTz);
                    const tx = transformOverride?.position[0] ?? sourceTx;
                    const ty = transformOverride?.position[1] ?? sourceTy;
                    const tz = transformOverride?.position[2] ?? sourceTz;
                    if (this._isInstanceSuppressed(hash, tx, ty, tz)) continue;
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

                    for (let k = 0; k < stride; k++) {
                        if (k === 12) arr.push(tx);
                        else if (k === 13) arr.push(ty);
                        else if (k === 14) arr.push(tz);
                        else arr.push(mats[i + k]);
                    }
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
            instanceStrideFloats: aggStrides.get(hash) ?? 16,
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
        let eligibleInstances = 0;
        let keptInstances = 0;

        for (const entry of entries) {
            const mats = entry?.mats;
            const stride = this._instanceStrideFloatsForLen(mats?.length ?? 0, entry?.instanceStrideFloats);
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
                eligibleInstances++;
                pushNearest({ offset: i, dist });
            }
            nearest.sort((a, b) => (a.dist - b.dist) || (a.offset - b.offset));
            const selected = [];
            for (const candidate of nearest) {
                for (let k = 0; k < stride; k++) selected.push(mats[candidate.offset + k]);
            }
            const selectedCount = nearest.length;
            keptInstances += selectedCount;
            remaining -= selectedCount;
            if (selectedCount > 0) out.push({ ...entry, mats: new Float32Array(selected) });
        }
        this._lastInstanceLimitStats = {
            eligible: eligibleInstances,
            kept: keptInstances,
            capped: Math.max(0, eligibleInstances - keptInstances),
        };
        return out;
    }

    _applyRebuiltEntries(entriesIn, { behindPenalty = 1.6, sourceInstanceCount = null, duplicateInstancesDropped = 0, preCappedInstances = 0, mloInstances = null } = {}) {
        let entries = Array.isArray(entriesIn) ? entriesIn : [];

        // Apply interior visibility gating (drops interior children unless camera is inside).
        entries = this._filterEntriesForActiveInterior(entries, mloInstances);
        // A destination teleport can expose hundreds of surrounding exterior
        // archetypes at once. Mark the active room's own MLO children so their
        // mesh jobs outrank nearby streets instead of leaving the store/studio
        // as placeholders while unrelated city packs drain first.
        const activeParentGuid = Number(this._activeInterior?.parentGuid) >>> 0;
        if (activeParentGuid) {
            for (const entry of entries) {
                const mats = entry?.mats;
                const stride = this._instanceStrideFloatsForLen(mats?.length ?? 0, entry?.instanceStrideFloats);
                let activeInteriorChild = false;
                let activeInteriorPriority = 0;
                if (stride >= 21 && mats) {
                    for (let offset = 0; offset + stride <= mats.length; offset += stride) {
                        if ((Number(mats[offset + 18]) >>> 0) === activeParentGuid) {
                            activeInteriorChild = true;
                            const ownership = this._decodeMloFlags(mats[offset + 20]);
                            let priority = 5000;
                            if (ownership.roomIndex === Number(this._activeInterior?.exteriorRoomIndex)
                                && this._activeInterior?.visibleRooms?.has?.(ownership.roomIndex)) {
                                // GTA/FiveM commonly attaches the structural shell (floor,
                                // enclosing walls, roof) to limbo/exterior room 0. Loading
                                // current-room props first leaves shelves floating in a void
                                // for tens of seconds after a destination teleport.
                                priority = 12000;
                            } else if (ownership.roomIndex === Number(this._activeInterior?.roomIndex)) {
                                // Load the room containing the player before adjacent rooms and
                                // other visible rooms once the enclosing shell is resident.
                                priority = 11000;
                            } else if (ownership.portalIndex >= 0) {
                                const def = this._mloDefs.get(String(this._activeInterior?.archHash));
                                const portal = (def?.portals || [])[ownership.portalIndex];
                                if (Number(portal?.roomFrom) === Number(this._activeInterior?.roomIndex)
                                    || Number(portal?.roomTo) === Number(this._activeInterior?.roomIndex)) {
                                    priority = 10000;
                                }
                            }
                            activeInteriorPriority = Math.max(activeInteriorPriority, priority);
                        }
                    }
                }
                entry.activeInteriorChild = activeInteriorChild;
                entry.activeInteriorPriority = activeInteriorPriority;
            }
        }
        // Some valid YTYP archetypes intentionally have no drawable (collision/metadata/LOD helpers).
        // They are classified by the exporter and must not consume a placeholder or a render budget.
        entries = entries.filter((e) => !this.modelManager?.isNonRenderable?.(e?.hash));
        entries.sort((a, b) => {
            const ia = Number(a.activeInteriorPriority) || 0;
            const ib = Number(b.activeInteriorPriority) || 0;
            if (ia !== ib) return ib - ia;
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
        const cappedInstances = Math.max(0, Math.floor(Number(preCappedInstances) || 0))
            + Math.max(0, Math.floor(Number(this._lastInstanceLimitStats?.capped) || 0));

        // Stats (helps distinguish "missing meshes" vs "capped by maxArchetypes").
        let totalMeshInstances = Number.isFinite(sourceInstanceCount) && sourceInstanceCount >= 0
            ? Math.floor(sourceInstanceCount)
            : 0;
        if (!Number.isFinite(sourceInstanceCount) || sourceInstanceCount < 0) {
            for (const e of entries) {
                const stride = this._instanceStrideFloatsForLen(e.mats.length ?? 0, e.instanceStrideFloats);
                totalMeshInstances += Math.floor((e.mats.length ?? 0) / stride);
            }
        }
        let keptInstances = 0;
        for (const e of keep) {
            const stride = this._instanceStrideFloatsForLen(e.mats.length ?? 0, e.instanceStrideFloats);
            keptInstances += Math.floor((e.mats.length ?? 0) / stride);
        }
        const keptReal = keep.reduce((acc, e) => acc + (e.isPlaceholder ? 0 : 1), 0);
        const keptPlaceholder = keep.reduce((acc, e) => acc + (e.isPlaceholder ? 1 : 0), 0);

        // If enabled, regroup instances by (lod + submesh file + material signature) and feed bucket renderer.
        if (this.enableCrossArchetypeInstancing && this.modelManager?.getEffectiveMaterialAndSignature && this.modelRenderer?.setInstancesForBucket) {
            /** @type {Map<string, { lod: string, file: string, material: any, mats: number[] }>} */
            const buckets = new Map();

            for (const e of keep) {
                // The active MLO is gameplay space, not a distant city prop,
                // but it must still honor the selected quality profile. Forcing
                // every interior child to high made medium/low queue hundreds
                // of unnecessary submeshes and delayed the structural shell.
                const lod = this._chooseLod(e.hash, e.d);
                const interiorPriority = Number(e.activeInteriorPriority) || (e.activeInteriorChild ? 5000 : 0);
                const metaEntry = this.modelManager?.manifest?.meshes?.[String(e.hash)];
                const entryMat = metaEntry?.material ?? null;
                const subs = this.modelManager.getLodSubmeshes(e.hash, lod) || [];
                if (!subs || subs.length === 0) continue;

                for (const sm of subs) {
                    const file = String(sm?.file || '').trim();
                    if (!file) continue;
                    const { sig, material } = this.modelManager.getEffectiveMaterialAndSignature(entryMat, sm?.material ?? null);
                    const stride = this._instanceStrideFloatsForLen(e.mats.length ?? 0, e.instanceStrideFloats);
                    // LOD selection frequently resolves to the same fallback mesh file.
                    // Key by the actual render payload so changing quality can reuse the
                    // resident bucket instead of deleting and reloading identical data.
                    const bucketId = `${file}:${sig}:${stride}`;
                    let b = buckets.get(bucketId);
                    if (!b) {
                        b = {
                            lod: String(lod),
                            file,
                            material,
                            mats: [],
                            minDist: e.d,
                            stride,
                            loadPriority: interiorPriority,
                            sourceHashes: new Set([String(e.hash)]),
                        };
                        buckets.set(bucketId, b);
                    } else {
                        // Track the closest contributing archetype so texture tiering can be distance-based.
                        const prevD = Number(b.minDist);
                        const nextD = Number(e.d);
                        if (!Number.isFinite(prevD) || (Number.isFinite(nextD) && nextD < prevD)) b.minDist = nextD;
                        if (e.activeInteriorChild) b.loadPriority = Math.max(interiorPriority, Number(b.loadPriority) || 0);
                        b.sourceHashes.add(String(e.hash));
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
                void this.modelRenderer.setInstancesForBucket(
                    bid, b.lod, b.file, b.material, new Float32Array(b.mats), b.minDist, b.stride,
                    { loadPriority: Number(b.loadPriority) || 0, sourceHashes: Array.from(b.sourceHashes) },
                );
            }
            this._prevDesiredBucketIds = desiredBucketIds;

            // Keep coverage stats semantics: still counts kept archetypes/instances.
            this._computeCoverageStats({
                totalMeshArchetypes: entries.length,
                keptArchetypes: keep.length,
                droppedArchetypes: Math.max(0, within.length - archetypeKeep.length),
                keptRealArchetypes: keptReal,
                keptPlaceholderArchetypes: keptPlaceholder,
                totalMeshInstances,
                keptInstances,
                duplicateInstancesDropped,
                cappedInstances,
            });
            return;
        }

        // Remove stale instance entries (hash:lod) that are no longer desired.
        const desiredKeys = new Set();
        for (const e of keep) {
            const lod = this._chooseLod(e.hash, e.d);
            desiredKeys.add(`${String(e.hash)}:${String(lod)}`);
            const mats = (e.mats instanceof Float32Array) ? e.mats : new Float32Array(e.mats);
            void this.modelRenderer.setInstancesForArchetype(e.hash, lod, mats, e.d, {
                instanceStrideFloats: e.instanceStrideFloats,
                loadPriority: Number(e.activeInteriorPriority) || (e.activeInteriorChild ? 5000 : 0),
            });
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
            droppedArchetypes: Math.max(0, within.length - archetypeKeep.length),
            keptRealArchetypes: keptReal,
            keptPlaceholderArchetypes: keptPlaceholder,
            totalMeshInstances,
            keptInstances,
            duplicateInstancesDropped,
            cappedInstances,
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
            instanceStrideFloats: 17,
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
            void this.modelRenderer.setInstancesForArchetype(e.hash, lod, new Float32Array(e.mats), e.d, {
                instanceStrideFloats: 17,
            });
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
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        for (const key of wantedSet) this._chunkLastWantedMs.set(key, now);
        const wantedCap = Math.max(1, Math.floor(Number(this.maxLoadedChunks) || 1));
        const residentCap = Math.max(wantedCap, Math.floor(Number(this.maxResidentChunks) || wantedCap));
        const graceMs = Math.max(0, Number(this.staleChunkGraceMs) || 0);
        let changed = false;

        // Rank stale chunks by age, then distance. Wanted chunks are never
        // evicted to make room; replacements can load while the prior street
        // remains visible inside the bounded overlap cache.
        const centerKey = (wantedOrdered && wantedOrdered.length > 0) ? wantedOrdered[0] : null;
        const centerCoord = centerKey ? centerKey.split('_').map(v => parseInt(v, 10)) : null;
        const cx = (centerCoord && Number.isFinite(centerCoord[0])) ? centerCoord[0] : null;
        const cy = (centerCoord && Number.isFinite(centerCoord[1])) ? centerCoord[1] : null;
        const stale = Array.from(this.loaded).filter((key) => !wantedSet.has(key)).map((key) => {
            const lastWanted = Number(this._chunkLastWantedMs.get(key)) || 0;
            const [sx, sy] = key.split('_').map(v => parseInt(v, 10));
            const dx = cx === null || !Number.isFinite(sx) ? 1e9 : sx - cx;
            const dy = cy === null || !Number.isFinite(sy) ? 1e9 : sy - cy;
            return { key, lastWanted, age: now - lastWanted, d2: dx * dx + dy * dy };
        });
        stale.sort((a, b) => b.age - a.age || b.d2 - a.d2 || (a.key < b.key ? -1 : 1));
        const drop = new Set(stale.filter((entry) => graceMs <= 0 || entry.age >= graceMs).map((entry) => entry.key));
        let projectedSize = this.loaded.size - drop.size;
        if (projectedSize > residentCap) {
            for (const entry of stale) {
                if (projectedSize <= residentCap) break;
                if (drop.has(entry.key)) continue;
                drop.add(entry.key);
                projectedSize--;
            }
        }

        for (const key of drop) {
            if (this.loading.has(key) || this._chunkLoadReqs.has(key)) this._cancelChunkLoad(key, 'retired_from_overlap_cache');
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
            this._chunkLastWantedMs.delete(key);
            changed = true;
        }
        if (changed) {
            this._lastChunkSetChangeMs = now;
            if (this.chunkRebuildSettleMs <= 0) this._dirty = true;
        }

        // Let recently displaced prefetches finish, but do not allow obsolete
        // requests to occupy the fetch lanes after their overlap window ends.
        for (const k of Array.from(this.loading)) {
            if (!wantedSet.has(k)) {
                const age = now - (Number(this._chunkLastWantedMs.get(k)) || 0);
                if (graceMs <= 0 || age >= Math.min(graceMs, 2000) || this.loaded.size + this.loading.size > residentCap + 4) {
                    this._cancelChunkLoad(k, 'stale_inflight_not_wanted');
                    this._chunkLastWantedMs.delete(k);
                }
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
        this._prefetchFocusSample = null;
        this._prefetchMoveDir = null;
        this._prefetchMoveDirMs = 0;
        this._prefetchMoveSpeed = 0;
        this._lastResidentCoreCount = 0;
        this._lastPrefetchStats = { speed: 0, leadChunks: 0, core: 0, forward: 0 };
        this._chunkLastWantedMs.clear();
        this._lastChunkSetChangeMs = 0;
        this._lastWantedKeys = [];
        this._lastCoreWantedSet.clear();
        this._lastCoreSignature = '';
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
        this._lastWantedKeys = wanted.slice();
        const coreKeys = wanted.slice(0, Math.min(this._lastResidentCoreCount, wanted.length));
        const coreSignature = coreKeys.join('|');
        if (coreSignature !== this._lastCoreSignature) {
            this._lastCoreSignature = coreSignature;
            this._lastCoreWantedSet = new Set(coreKeys);
            this._dirty = true;
            this._lastChunkSetChangeMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        }
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
                // Direction changes alter front-vs-rear prioritization even
                // without worker frustum culling. Otherwise a turn can retain
                // stale off-screen archetypes until the next chunk boundary.
                let dirOk = false;
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
                const rebuildNow = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                const settleMs = Math.max(0, Number(this.chunkRebuildSettleMs) || 0);
                const coreCount = Math.min(this._lastResidentCoreCount, wanted.length);
                const requiredCoreReady = coreCount <= 0 || wanted.slice(0, coreCount).every((key) => this.loaded.has(key));
                const waitingForRequiredCore = didWorker && settleMs > 0 && !requiredCoreReady;
                const waitingForChunkBatch = didWorker
                    && this._prevDesiredInstanceKeys.size > 0
                    && this._lastChunkSetChangeMs > this._lastInstanceRebuildMs
                    && rebuildNow - this._lastChunkSetChangeMs < settleMs;
                const waitingForResidency = waitingForRequiredCore || waitingForChunkBatch;
                let rebuildStarted = false;
                if (didWorker && !waitingForResidency) {
                    // Keep drawing the last complete buffer set while one structural rebuild is in flight.
                    // Chunk loads/drops that happen meanwhile set `_dirty` again and schedule one follow-up.
                    if (!this._rebuildWorkerReqInFlight) {
                        this._dirty = false;
                        rebuildStarted = true;
                        void this._rebuildAllInstancesInWorker().then((ok) => {
                            if (!ok) this._dirty = true;
                            else this._lastInstanceRebuildCompletedMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                        });
                    }
                } else if (!didWorker) {
                    this._dirty = false;
                    this._rebuildAllInstances();
                    rebuildStarted = true;
                    this._lastInstanceRebuildCompletedMs = rebuildNow;
                }
                if (rebuildStarted) try {
                    const cam = this._lastCamDataPos || [0, 0, 0];
                    const dir = this._lastCamDataDir || [0, 0, -1];
                    this._lastInstanceRebuildCam = [cam[0], cam[1], cam[2]];
                    this._lastInstanceRebuildDir = [dir[0], dir[1], dir[2]];
                    this._lastInstanceRebuildMs = rebuildNow;
                    this._instanceRebuildCount++;
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

            const forwardWarmCount = (Number(this._prefetchMoveSpeed) || 0) >= 8.0 ? 4 : 0;
            const priority = i < (this._lastResidentCoreCount + forwardWarmCount) ? 'high' : 'low';
            started++;
            void this._loadChunk(key, { priority });
        }
    }
}



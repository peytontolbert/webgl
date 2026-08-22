import { joaat } from './joaat.js';
import { deleteAssetCacheEntry, fetchArrayBufferPreferredCompressed, fetchJSON } from './asset_fetcher.js';
import { createWireframeIndices } from './wireframe_indices.js';

// Custom-resource drawables whose required source data is known to be absent.
// Keep these out of the placeholder path as well as future compact manifests.
const BUILTIN_NON_RENDERABLE_HASHES = Object.freeze([
    '1993703776', // prop_plant_florek: missing diffuse atlas 150093784.png
]);

export class ModelManager {
    constructor(gl) {
        this.gl = gl;
        this.manifest = null; // { version, meshes: { [hash]: { lods: {...}, lodDistances, material } } }

        // Sharded manifest support (optional).
        this._sharded = false;
        this._manifestBaseDir = 'assets/models';
        this._manifestIndex = null; // { schema, shard_bits, shard_dir, ... }
        this._manifestShardCacheBust = '';
        this._loadedShards = new Set(); // shardId (number)
        this._loadingShards = new Map(); // shardId -> Promise<boolean>
        // Runtime subsets (notably /demo's packed district) are authoritative.
        // A forced source-shard load for a player/NPC can contain the same world
        // hashes and must not replace their packed mesh/texture references.
        this._manifestSubsetOverrides = new Map();
        /** @type {null | ((info: any) => void)} */
        this.onManifestUpdated = null;
        // Exporting drawables mutates the asset tree and can take seconds. It is a deliberate user action,
        // never part of the frame/streaming loop.
        this.enableLiveExport = false;
        this.liveExportBatchSize = 12;
        this.liveExportTextures = false;
        this._liveExportDisabled = false;
        this._liveExportRequested = new Set();
        this._liveExportInFlight = false;
        this._liveExportQueue = [];
        this._liveExportLastMs = 0;
        this._nonRenderableHashes = new Set(BUILTIN_NON_RENDERABLE_HASHES);
        this._nonRenderableLoadPromise = null;

        // Cache actual mesh bins by file path (since multiple submeshes/lods can reference different files).
        this.meshCache = new Map(); // key(file) -> { vao, indexCount, buffers... }
        // Retain position/index CPU copies for precise asset picking. Disabled by
        // default because full-world streaming can load many unique mesh bins.
        this.retainCpuPickData = false;

        // Mesh cache budget + LRU eviction (Task A3).
        // Note: renderer-created per-submesh VAOs reference these buffers; eviction marks meshes as disposed
        // so renderers can drop/reload those bindings safely.
        // GTA-scale worlds have *lots* of unique mesh bins. A low default causes constant churn.
        // This is "approx GPU buffer bytes" (not exact), used only for LRU budgeting.
        this.maxMeshCacheBytes = 512 * 1024 * 1024; // app profiles can raise this explicitly
        this.meshCacheDebug = false;
        this._meshCacheBytes = 0;
        this._meshCacheEvictions = 0;
        this._meshCacheHotEvictionDeferrals = 0;
        this.meshCacheHotProtectionMs = 2500;
        this.meshCacheHardLimitMultiplier = 1.35;
        /** @type {Map<string, number>} */
        this._meshCacheApproxBytes = new Map(); // key -> approxBytes
        // Keep a bounded set of recently used demo packs. Camera movement tends
        // to revisit neighboring submeshes, and immediately releasing packs can
        // turn those revisits into duplicate HTTP/cache reads.
        this.maxMeshPackCacheBytes = 32 * 1024 * 1024;
        this._meshPackCacheBytes = 0;
        this._meshPackLoads = new Map(); // pack path -> { promise, byteLength, lastUsedMs }

        // Network completion is bursty. Parse/upload only a small number of
        // packed world meshes per animation frame to protect gameplay latency.
        this.maxPackedMeshUploadsPerFrame = 2;
        this.maxPackedMeshUploadMsPerFrame = 4.0;
        this._packedMeshUploadQueue = [];
        this._packedMeshUploadScheduled = false;

        // If an archetype exists in the world data but wasn't exported to a mesh bin,
        // we still want "0 missing": render a small placeholder mesh instead.
        this.enablePlaceholderMeshes = true;
        this._placeholderMesh = this._createPlaceholderMesh();

        // Optional CodeWalker shader param name map (hash -> enum name).
        // When present (assets/shader_param_names.json), we can resolve shaderParams.*ByHash into
        // friendly names and auto-populate common material fields from vectorsByHash.
        this._shaderParamNameMap = null; // { [hashStr]: name }
        this._shaderParamNameMapPromise = null; // Promise<void> | null
    }

    _kickoffShaderParamNameMapLoad() {
        if (this._shaderParamNameMap || this._shaderParamNameMapPromise) return;
        this._shaderParamNameMapPromise = (async () => {
            try {
                const data = await fetchJSON('assets/shader_param_names.json', { priority: 'low' });
                const byHash = data?.byHash;
                if (byHash && typeof byHash === 'object') {
                    this._shaderParamNameMap = byHash;
                }
            } catch {
                // Optional file; ignore.
            } finally {
                // Prevent unbounded promise retention even if it failed.
                this._shaderParamNameMapPromise = null;
            }
        })();
    }

    _kickoffNonRenderableIndexLoad(baseDir) {
        if (this._nonRenderableLoadPromise) return;
        const url = `${String(baseDir || this._manifestBaseDir || 'assets/models')}/non_renderable_archetypes.json`;
        this._nonRenderableLoadPromise = (async () => {
            try {
                const data = await fetchJSON(url, { priority: 'low', usePersistentCache: false, useMemoryCache: false });
                const hashes = Array.isArray(data?.hashes) ? data.hashes : [];
                const next = new Set(BUILTIN_NON_RENDERABLE_HASHES);
                for (const hash of hashes) {
                    const h = this.normalizeId(hash);
                    if (h) next.add(h);
                }
                this._nonRenderableHashes = next;
                try { this.onManifestUpdated?.({ type: 'nonRenderableIndex', count: next.size }); } catch { /* ignore */ }
            } catch {
                // Optional classification data. Unknown archetypes remain export candidates.
            } finally {
                this._nonRenderableLoadPromise = null;
            }
        })();
    }

    async refreshNonRenderableIndex() {
        if (this._nonRenderableLoadPromise) {
            try { await this._nonRenderableLoadPromise; } catch { /* ignore */ }
        }
        this._nonRenderableLoadPromise = null;
        this._kickoffNonRenderableIndexLoad(this._manifestBaseDir);
        try { await this._nonRenderableLoadPromise; } catch { /* ignore */ }
    }

    /**
     * Touch a cached mesh entry to keep it hot in the LRU.
     * Uses Map insertion order as the LRU queue by moving the entry to the end.
     */
    touchMesh(keyOrMesh, frameNow = null) {
        const key = (typeof keyOrMesh === 'string')
            ? keyOrMesh
            : (keyOrMesh && typeof keyOrMesh === 'object' ? String(keyOrMesh.key || '') : '');
        if (!key) return false;
        const mesh = this.meshCache.get(key);
        if (!mesh) return false;
        // If the mesh has been disposed/evicted, treat as absent.
        if (mesh._disposed) return false;
        const now = Number.isFinite(frameNow)
            ? frameNow
            : ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now());
        // Renderers touch every visible submesh. Reordering a large Map hundreds
        // of times per frame is unnecessary; a two-second LRU cadence still keeps
        // resident scene meshes well ahead of inactive entries.
        if (Number.isFinite(mesh._lastLruTouchMs) && (now - mesh._lastLruTouchMs) < 2000) {
            mesh._lastUsedMs = now;
            return true;
        }
        // At low cache pressure there is no eviction decision to improve, so
        // moving thousands of visible entries through Map insertion order only
        // creates periodic main-thread spikes. Keep timestamps current and
        // restore strict LRU ordering once the cache approaches its byte cap.
        const cap = Math.max(1, Number(this.maxMeshCacheBytes) || 1);
        if (this._meshCacheBytes < cap * 0.80) {
            mesh._lastLruTouchMs = now;
            mesh._lastUsedMs = now;
            return true;
        }
        // Move to MRU position.
        this.meshCache.delete(key);
        this.meshCache.set(key, mesh);
        mesh._lastLruTouchMs = now;
        mesh._lastUsedMs = now;
        return true;
    }

    _parseDemoMeshPackRef(file) {
        const match = /^@demo-pack\/([^#]+)#(\d+):(\d+)$/.exec(String(file || '').trim());
        if (!match) return null;
        const offset = Number(match[2]);
        const length = Number(match[3]);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) return null;
        return { packFile: match[1], offset, length };
    }

    async _loadDemoMeshPackSlice(ref, { usePersistentCache = true } = {}) {
        const rawRevision = this.manifest?.meshPackRevisions?.[ref.packFile];
        const revision = (typeof rawRevision === 'string' || Number.isFinite(rawRevision))
            ? String(rawRevision).trim()
            : '';
        const path = `assets/demo/${ref.packFile}${revision ? `?rev=${encodeURIComponent(revision)}` : ''}`;
        let cached = this._meshPackLoads.get(path);
        if (!cached) {
            cached = {
                // The persistent asset cache intentionally normalizes URL query
                // strings. Revisioned packs must bypass it or an older binary
                // with the same basename can be returned for new slice offsets.
                // Demo mesh packs are emitted as compressed-only `.gz` assets
                // by the production packager.  The helper still falls back to
                // the raw path so existing dev/legacy deployments keep working.
                promise: fetchArrayBufferPreferredCompressed(path, {
                    usePersistentCache: revision ? false : !!usePersistentCache,
                }),
                byteLength: 0,
                lastUsedMs: Date.now(),
            };
            this._meshPackLoads.set(path, cached);
            cached.promise.then((pack) => {
                if (this._meshPackLoads.get(path) !== cached) return;
                cached.byteLength = pack.byteLength;
                cached.lastUsedMs = Date.now();
                this._meshPackCacheBytes += pack.byteLength;
                this._evictDemoMeshPacks(path);
            }).catch(() => { /* handled by the awaiting caller */ });
        }
        cached.lastUsedMs = Date.now();
        let pack;
        try {
            pack = await cached.promise;
        } catch (error) {
            this._meshPackLoads.delete(path);
            throw error;
        }
        const end = ref.offset + ref.length;
        if (end > pack.byteLength) throw new Error(`packed mesh range exceeds ${path}`);
        return pack.slice(ref.offset, end);
    }

    _evictDemoMeshPacks(protectedPath = '') {
        while (this._meshPackCacheBytes > this.maxMeshPackCacheBytes) {
            let oldestPath = '';
            let oldest = Number.POSITIVE_INFINITY;
            for (const [path, entry] of this._meshPackLoads) {
                if (path === protectedPath || !entry?.byteLength) continue;
                if (entry.lastUsedMs < oldest) {
                    oldest = entry.lastUsedMs;
                    oldestPath = path;
                }
            }
            if (!oldestPath) break;
            const entry = this._meshPackLoads.get(oldestPath);
            this._meshPackLoads.delete(oldestPath);
            this._meshPackCacheBytes = Math.max(0, this._meshPackCacheBytes - (entry?.byteLength || 0));
        }
    }

    _enqueuePackedMeshUpload(key, arrayBuffer) {
        return new Promise((resolve, reject) => {
            this._packedMeshUploadQueue.push({ key, arrayBuffer, resolve, reject });
            this._schedulePackedMeshUploads();
        });
    }

    _schedulePackedMeshUploads() {
        if (this._packedMeshUploadScheduled || !this._packedMeshUploadQueue.length) return;
        this._packedMeshUploadScheduled = true;
        const schedule = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame
            : (callback) => setTimeout(() => callback(Date.now()), 0);
        schedule(() => {
            this._packedMeshUploadScheduled = false;
            const started = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            let completed = 0;
            while (this._packedMeshUploadQueue.length && completed < this.maxPackedMeshUploadsPerFrame) {
                const job = this._packedMeshUploadQueue.shift();
                try {
                    job.resolve(this._parseAndUploadMesh(job.key, job.arrayBuffer));
                } catch (error) {
                    job.reject(error);
                }
                completed++;
                const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                if ((now - started) >= this.maxPackedMeshUploadMsPerFrame) break;
            }
            this._schedulePackedMeshUploads();
        });
    }

    isMeshDisposed(mesh) {
        return !!(mesh && typeof mesh === 'object' && mesh._disposed);
    }

    getMeshCacheStats() {
        return {
            count: this.meshCache.size,
            approxBytes: this._meshCacheBytes,
            maxBytes: this.maxMeshCacheBytes,
            evictions: this._meshCacheEvictions,
            hotEvictionDeferrals: this._meshCacheHotEvictionDeferrals,
            overBudgetBytes: Math.max(0, this._meshCacheBytes - this.maxMeshCacheBytes),
        };
    }

    setMeshCacheCaps({ maxBytes, debug } = {}) {
        const mb = Number(maxBytes);
        if (Number.isFinite(mb)) {
            // Allow large budgets for full-game streaming, but keep a sane floor.
            this.maxMeshCacheBytes = Math.max(64 * 1024 * 1024, Math.floor(mb));
        }
        if (debug !== undefined) this.meshCacheDebug = !!debug;
        this._evictMeshCacheIfNeeded();
    }

    _disposeMesh(mesh) {
        if (!mesh || typeof mesh !== 'object') return;
        if (mesh._disposed) return;
        const gl = this.gl;
        mesh._disposed = true;
        try { if (mesh.vao) gl.deleteVertexArray(mesh.vao); } catch { /* ignore */ }
        try { if (mesh.posBuffer) gl.deleteBuffer(mesh.posBuffer); } catch { /* ignore */ }
        try { if (mesh.nrmBuffer) gl.deleteBuffer(mesh.nrmBuffer); } catch { /* ignore */ }
        try { if (mesh.uvBuffer) gl.deleteBuffer(mesh.uvBuffer); } catch { /* ignore */ }
        try { if (mesh.uv1Buffer) gl.deleteBuffer(mesh.uv1Buffer); } catch { /* ignore */ }
        try { if (mesh.uv2Buffer) gl.deleteBuffer(mesh.uv2Buffer); } catch { /* ignore */ }
        try { if (mesh.tanBuffer) gl.deleteBuffer(mesh.tanBuffer); } catch { /* ignore */ }
        try { if (mesh.col0Buffer) gl.deleteBuffer(mesh.col0Buffer); } catch { /* ignore */ }
        try { if (mesh.col1Buffer) gl.deleteBuffer(mesh.col1Buffer); } catch { /* ignore */ }
        try { if (mesh.blendWeightsBuffer) gl.deleteBuffer(mesh.blendWeightsBuffer); } catch { /* ignore */ }
        try { if (mesh.blendIndicesBuffer) gl.deleteBuffer(mesh.blendIndicesBuffer); } catch { /* ignore */ }
        try { if (mesh.idxBuffer) gl.deleteBuffer(mesh.idxBuffer); } catch { /* ignore */ }
        try { if (mesh.lineIdxBuffer) gl.deleteBuffer(mesh.lineIdxBuffer); } catch { /* ignore */ }
        mesh.vao = null;
        mesh.posBuffer = null;
        mesh.nrmBuffer = null;
        mesh.uvBuffer = null;
        mesh.uv1Buffer = null;
        mesh.uv2Buffer = null;
        mesh.tanBuffer = null;
        mesh.col0Buffer = null;
        mesh.col1Buffer = null;
        mesh.blendWeightsBuffer = null;
        mesh.blendIndicesBuffer = null;
        mesh.idxBuffer = null;
        mesh.lineIdxBuffer = null;
        mesh.pickPositions = null;
        mesh.pickIndices = null;
        mesh.pickPositionMin = null;
        mesh.pickPositionExtent = null;
    }

    _evictMeshCacheIfNeeded() {
        const budget = Number(this.maxMeshCacheBytes);
        const maxBytes = Number.isFinite(budget) ? Math.max(0, budget) : (256 * 1024 * 1024);
        this.maxMeshCacheBytes = maxBytes;
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const hotProtectionMs = Math.max(0, Number(this.meshCacheHotProtectionMs) || 0);
        const hardMaxBytes = maxBytes * Math.max(1, Number(this.meshCacheHardLimitMultiplier) || 1);
        // Prefer cold LRU entries. A mesh drawn in the current view must not be
        // disposed merely because a network completion briefly pushes the cache
        // over its soft budget; that creates a perpetual reload loop while driving.
        while (this._meshCacheBytes > maxBytes && this.meshCache.size > 0) {
            let oldestKey = null;
            let oldestMesh = null;
            const forceOldest = this._meshCacheBytes > hardMaxBytes;
            for (const [key, candidate] of this.meshCache) {
                if (key === '__placeholder__') continue;
                const lastUse = Number(candidate?._lastUsedMs);
                const hot = Number.isFinite(lastUse) && (now - lastUse) < hotProtectionMs;
                if (!hot || forceOldest) {
                    oldestKey = key;
                    oldestMesh = candidate;
                    break;
                }
            }
            if (!oldestKey) break;
            const mesh = oldestMesh;
            this.meshCache.delete(oldestKey);
            const b = this._meshCacheApproxBytes.get(oldestKey) ?? (mesh?.approxBytes ?? 0);
            this._meshCacheApproxBytes.delete(oldestKey);
            if (Number.isFinite(b)) this._meshCacheBytes = Math.max(0, this._meshCacheBytes - Math.max(0, b));
            this._disposeMesh(mesh);
            this._meshCacheEvictions++;
            if (this.meshCacheDebug) {
                try {
                    const mb = (Number.isFinite(b) ? (b / (1024 * 1024)) : 0);
                    const totalMb = this._meshCacheBytes / (1024 * 1024);
                    const maxMb = maxBytes / (1024 * 1024);
                    console.debug(`ModelManager: evicted mesh ${oldestKey} (~${mb.toFixed(2)}MB). cache=${totalMb.toFixed(2)}MB/${maxMb.toFixed(2)}MB`);
                } catch { /* ignore */ }
            }
        }
        if (this._meshCacheBytes > maxBytes && this._meshCacheBytes <= hardMaxBytes) {
            this._meshCacheHotEvictionDeferrals++;
        }
    }

    clearMeshCache() {
        for (const mesh of this.meshCache.values()) {
            try { this._disposeMesh(mesh); } catch { /* ignore */ }
        }
        this.meshCache.clear();
        this._meshCacheApproxBytes.clear();
        this._meshCacheBytes = 0;
    }

    _roundNum(x, decimals = 4) {
        const n = Number(x);
        if (!Number.isFinite(n)) return null;
        const d = Number.isFinite(decimals) ? Math.max(0, Math.min(8, Math.floor(decimals))) : 4;
        const p = Math.pow(10, d);
        return Math.round(n * p) / p;
    }

    _normalizeUv0ScaleOffset(v) {
        if (!Array.isArray(v) || v.length < 4) return null;
        const out = [
            this._roundNum(v[0]),
            this._roundNum(v[1]),
            this._roundNum(v[2]),
            this._roundNum(v[3]),
        ];
        if (out.some((x) => x === null)) return null;
        return out;
    }

    _normalizeUvScaleOffset(v) {
        // Alias for readability when we support multiple UV sets.
        return this._normalizeUv0ScaleOffset(v);
    }

    _looksLikePathOrFile(s) {
        const t = String(s || '').trim();
        if (!t) return false;
        if (t.includes('/') || t.includes('\\')) return true;
        // Common texture extensions we might see in manifests.
        if (/\.(png|ktx2|jpg|jpeg|webp|dds)$/i.test(t)) return true;
        return false;
    }

    _slugifyTextureName(name) {
        // Match exporter-style filenames like "<hash>_prop_lod.png" from "Prop_LOD".
        const s = String(name || '').trim().toLowerCase();
        if (!s) return '';
        return s
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+/, '')
            .replace(/_+$/, '');
    }

    _textureRelFromShaderParamValue(v) {
        // ShaderParam payloads commonly store just a texture name (e.g. "Prop_LOD"),
        // but may also store a direct relative path.
        const s0 = String(v || '').trim();
        if (!s0) return null;
        const s = s0.replace(/\\/g, '/');
        if (this._looksLikePathOrFile(s)) {
            // Keep as a manifest-relative path; strip any leading "assets/" to avoid doubling.
            return s.replace(/^assets\//i, '');
        }

        const slug = this._slugifyTextureName(s);
        const h = joaat(s);
        // Viewer expects texture files to live under assets/models_textures/...
        //
        // IMPORTANT:
        // - Some export pipelines emit *hash-only* filenames (e.g. "123.png")
        // - Others emit *hash+slug* filenames (e.g. "123_prop_wall.png") to aid debugging and/or
        //   avoid accidental overwrites when exporters preserve original names.
        //
        // Our renderer-side URL chooser (`InstancedModelRenderer._chooseTextureUrl`) already
        // implements a robust fallback:
        // - if given hash+slug, it tries hash-only first, then the original hash+slug
        //
        // So: prefer emitting hash+slug here when we have a slug, so we work with BOTH layouts.
        if (slug) return `models_textures/${h}_${slug}.webp`;
        return `models_textures/${h}.webp`;
    }

    _resolveShaderParamName(hashStr) {
        const h = String(hashStr || '').trim();
        if (!h) return null;
        const m = this._shaderParamNameMap;
        if (m && typeof m === 'object') {
            const n = m[h] ?? m[String(Number(h))];
            if (typeof n === 'string' && n) return n;
        }
        return null;
    }

    _vec4First(v, fallback = null) {
        // shaderParams.vectorsByHash values are arrays (vec4-ish). Sometimes scalars are stored as [x,0,0,0].
        if (!Array.isArray(v) || v.length < 1) return fallback;
        const x = Number(v[0]);
        return Number.isFinite(x) ? x : fallback;
    }

    _vec3FromVec4(v, fallback = null) {
        if (!Array.isArray(v) || v.length < 3) return fallback;
        const x = Number(v[0]), y = Number(v[1]), z = Number(v[2]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return fallback;
        return [x, y, z];
    }

    _resolveShaderParamsForDebugInPlace(mat) {
        // Provide a resolved view of shaderParams for debugging / parity checks.
        if (!mat || typeof mat !== 'object') return;
        if (mat.shaderParamsResolved) return;
        const sp = mat.shaderParams;
        if (!sp || typeof sp !== 'object') return;

        // Kick off map load (async). Resolution will become available later in the session.
        if (!this._shaderParamNameMap) this._kickoffShaderParamNameMapLoad();

        const texByHash = sp.texturesByHash;
        const vecByHash = sp.vectorsByHash;
        const map = this._shaderParamNameMap;
        if (!map || typeof map !== 'object') return; // can't resolve yet

        /** @type {Record<string, any>} */
        const texturesByName = {};
        /** @type {Record<string, any>} */
        const vectorsByName = {};

        if (texByHash && typeof texByHash === 'object') {
            for (const [k, v] of Object.entries(texByHash)) {
                const name = this._resolveShaderParamName(k) || k;
                texturesByName[String(name)] = v;
            }
        }
        if (vecByHash && typeof vecByHash === 'object') {
            for (const [k, v] of Object.entries(vecByHash)) {
                const name = this._resolveShaderParamName(k) || k;
                vectorsByName[String(name)] = v;
            }
        }
        mat.shaderParamsResolved = { texturesByName, vectorsByName };
    }

    _applyCommonMaterialFieldsFromShaderParamsInPlace(mat) {
        // Convert common CodeWalker shader scalar/vector params into viewer-friendly material fields
        // that InstancedModelRenderer already understands.
        if (!mat || typeof mat !== 'object') return;
        const sp = mat.shaderParams;
        const vecByHash = (sp && typeof sp === 'object') ? sp.vectorsByHash : null;
        if (!vecByHash || typeof vecByHash !== 'object') return;

        // Kick off async map load; we'll also support a minimal hardcoded mapping (hash-based)
        // for the most important fields so this works even without shader_param_names.json.
        if (!this._shaderParamNameMap) this._kickoffShaderParamNameMapLoad();

        const setIfAbsentNum = (key, val) => {
            if (val === null || val === undefined) return;
            if (mat[key] !== undefined && mat[key] !== null) return;
            const n = Number(val);
            if (!Number.isFinite(n)) return;
            mat[key] = n;
        };
        const setIfAbsentArr3 = (key, v3) => {
            if (!v3) return;
            if (mat[key] !== undefined && mat[key] !== null) return;
            mat[key] = v3;
        };
        const setIfAbsentArr4 = (key, v4) => {
            if (!Array.isArray(v4) || v4.length < 4) return;
            if (mat[key] !== undefined && mat[key] !== null) return;
            // Normalize to 4 floats (avoid huge arrays from odd exporters).
            const out = [
                this._roundNum(v4[0]),
                this._roundNum(v4[1]),
                this._roundNum(v4[2]),
                this._roundNum(v4[3]),
            ];
            if (out.some((x) => x === null)) return;
            mat[key] = out;
        };

        const getVec = (hashStr) => vecByHash[String(hashStr)] ?? vecByHash[Number(hashStr)] ?? null;

        // Hardcoded hashes (from CodeWalker ShaderParams.cs)
        // bumpiness=4134611841, SpecularIntensity=2841625909, SpecularPower=2313518026,
        // AlphaScale=931055822, alphaTestValue=3310830370, AlphaTest=950204405, emissiveMultiplier=1592520008,
        // globalAnimUV0=3617324062, globalAnimUV1=3126116752,
        // gTexCoordScaleOffset0=3099617970, detailSettings=3038654095,
        // gTexCoordScaleOffset1=2745647232, gTexCoordScaleOffset2=2499388197, gTexCoordScaleOffset3=2456002041,
        // parallaxScaleBias=2178632789,
        // materialWetnessMultiplier=3170143313, wetnessMultiplier=853385205, WetDarken=3170546064,
        // reflectivePower=1002989215, fresnelRolloff=3796399242
        // Tint/dirt/decal/puddle:
        // tintPaletteSelector=4258764495, dirtLevel=47191856, dirtLevelMod=3961814809, dirtColor=1146381126,
        // DecalTint=3092072610, g_PuddleParams=3536830402, g_Puddle_ScaleXY_Range=529156535
        // BasicPS spec params:
        // specMapIntMask=4279333149, specularIntensityMult=4095226703,
        // specularFalloffMult=2272544384, specularFresnel=666481402
        setIfAbsentNum('bumpiness', this._vec4First(getVec('4134611841'), null));
        setIfAbsentNum('specularIntensity', this._vec4First(getVec('2841625909'), null));
        setIfAbsentNum('specularPower', this._vec4First(getVec('2313518026'), null));
        setIfAbsentNum('alphaScale', this._vec4First(getVec('931055822'), null));
        setIfAbsentNum('alphaCutoff', this._vec4First(getVec('3310830370'), null));
        setIfAbsentNum('alphaCutoff', this._vec4First(getVec('950204405'), null));
        setIfAbsentNum('emissiveIntensity', this._vec4First(getVec('1592520008'), null));
        // CodeWalker BasicPS uses specularIntensityMult instead of SpecularIntensity; prefer it when present.
        setIfAbsentNum('specularIntensity', this._vec4First(getVec('4095226703'), null));
        // CodeWalker BasicPS: dot(spec.xyz, specMapIntMask.xyz) for intensity.
        setIfAbsentArr3('specMaskWeights', this._vec3FromVec4(getVec('4279333149'), null));
        // Extra spec knobs (not fully simulated yet, but we preserve them for debugging/future use).
        setIfAbsentNum('specularFalloffMult', this._vec4First(getVec('2272544384'), null));
        setIfAbsentNum('specularFresnel', this._vec4First(getVec('666481402'), null));
        setIfAbsentArr3('globalAnimUV0', this._vec3FromVec4(getVec('3617324062'), null));
        setIfAbsentArr3('globalAnimUV1', this._vec3FromVec4(getVec('3126116752'), null));
        // UV transform (major visual parity factor for GTA tiling/offset).
        // Convention (matches InstancedModelRenderer): [scaleU, scaleV, offsetU, offsetV]
        setIfAbsentArr4('uv0ScaleOffset', getVec('3099617970'));
        setIfAbsentArr4('uv1ScaleOffset', getVec('2745647232'));
        setIfAbsentArr4('uv2ScaleOffset', getVec('2499388197'));
        setIfAbsentArr4('uv3ScaleOffset', getVec('2456002041'));
        // Detail settings (BasicPS): vec4 where y=intensity, z/w = UV scale.
        setIfAbsentArr4('detailSettings', getVec('3038654095'));

        // Parallax (best-effort): vec4-ish; viewer consumes x=scale, y=bias.
        setIfAbsentArr4('parallaxScaleBias', getVec('2178632789'));

        // Wetness (best-effort): treat as scalar multipliers.
        // Many assets use either materialWetnessMultiplier or wetnessMultiplier.
        const wetA = this._vec4First(getVec('3170143313'), null);
        const wetB = this._vec4First(getVec('853385205'), null);
        setIfAbsentNum('wetness', (wetA !== null && wetA !== undefined) ? wetA : wetB);
        setIfAbsentNum('wetDarken', this._vec4First(getVec('3170546064'), null));

        // Reflection/fresnel knobs (best-effort). These are not 1:1 with GTA, but help env/wetness looks.
        setIfAbsentNum('reflectionIntensity', this._vec4First(getVec('1002989215'), null));
        setIfAbsentNum('fresnelPower', this._vec4First(getVec('3796399242'), null));

        // IsDistMap: distanceMapSampler uses special alpha/channel behavior in CodeWalker BasicPS.
        if (mat.isDistMap === undefined || mat.isDistMap === null) {
            const sp2 = mat.shaderParams;
            const texByHash2 = (sp2 && typeof sp2 === 'object') ? sp2.texturesByHash : null;
            const hasDist = !!(texByHash2 && (texByHash2['1616890976'] || texByHash2[1616890976]));
            if (hasDist) mat.isDistMap = true;
        }

        // Tint palette selector (often vec2 packed in vec4.x/y). Keep as 2 floats (0..1).
        if (mat.tintPaletteSelector === undefined || mat.tintPaletteSelector === null) {
            const tps = getVec('4258764495');
            if (Array.isArray(tps) && tps.length >= 2) {
                const x = Number(tps[0]), y = Number(tps[1]);
                if (Number.isFinite(x) && Number.isFinite(y)) mat.tintPaletteSelector = [x, y];
            }
        }

        // Tint mode (CodeWalker BasicShader parity):
        // 0=none, 1=legacy viewer instance-index lookup, 2=weapon diffuse alpha,
        // 3=Colour0.b, 4=Colour1.b. The per-entity tint index selects the palette row.
        if (mat.tintMode === undefined || mat.tintMode === null) {
            const hasTintPalette = !!(typeof mat.tintPalette === 'string' && mat.tintPalette);
            if (!hasTintPalette) {
                mat.tintMode = 0;
            } else {
                const sn = String(mat.shaderName || '').toLowerCase();
                if (sn.includes('weapon') && sn.includes('palette')) mat.tintMode = 2;
                else if (sn.includes('trees') && sn.includes('_tnt')) mat.tintMode = 4;
                // CodeWalker BasicVS default tinting uses vertex Colour0.b as the palette X coordinate.
                // (Trees use Colour1.b; weapon palettes use diffuse alpha in PS.)
                else mat.tintMode = 3;
            }
        }

        // Dirt controls (best-effort).
        setIfAbsentNum('dirtLevel', this._vec4First(getVec('47191856'), null));
        setIfAbsentNum('dirtLevel', this._vec4First(getVec('3961814809'), null)); // allow mod to stand in
        if (mat.dirtColor === undefined || mat.dirtColor === null) {
            const dc = getVec('1146381126');
            const v3 = this._vec3FromVec4(dc, null);
            if (v3) mat.dirtColor = v3;
        }

        // Decal tint (vec3)
        if (mat.decalTint === undefined || mat.decalTint === null) {
            const dt = getVec('3092072610');
            const v3 = this._vec3FromVec4(dt, null);
            if (v3) mat.decalTint = v3;
        }

        // Decal masks (best-effort): used by CodeWalker BasicPS for decal_dirt style shaders.
        // These are usually float3 (RGB) in engine data, but we normalize to vec4 for the viewer shader.
        const normMask4 = (v) => {
            if (!Array.isArray(v) || v.length < 3) return null;
            const x = this._roundNum(v[0]);
            const y = this._roundNum(v[1]);
            const z = this._roundNum(v[2]);
            const w = this._roundNum((v.length >= 4) ? v[3] : 0.0);
            if (x === null || y === null || z === null || w === null) return null;
            return [x, y, z, w];
        };
        if (mat.ambientDecalMask === undefined || mat.ambientDecalMask === null) {
            const v4 = normMask4(getVec('3686186843'));
            if (v4) mat.ambientDecalMask = v4;
        }
        if (mat.dirtDecalMask === undefined || mat.dirtDecalMask === null) {
            const v4 = normMask4(getVec('1050016400'));
            if (v4) mat.dirtDecalMask = v4;
        }

        // Puddles (best-effort, vec4s)
        setIfAbsentArr4('puddleParams', getVec('3536830402'));
        setIfAbsentArr4('puddleScaleRange', getVec('529156535'));

        // If we have a name map, also accept name-based fields (future-proof).
        const map = this._shaderParamNameMap;
        if (!map || typeof map !== 'object') return;
        for (const [hashStr, v] of Object.entries(vecByHash)) {
            const nm = this._resolveShaderParamName(hashStr);
            if (!nm) continue;
            if (nm === 'bumpiness') setIfAbsentNum('bumpiness', this._vec4First(v, null));
            else if (nm === 'SpecularIntensity' || nm === 'gSpecularIntensity') setIfAbsentNum('specularIntensity', this._vec4First(v, null));
            else if (nm === 'SpecularPower' || nm === 'gSpecularExponent' || nm === 'specularExponent') setIfAbsentNum('specularPower', this._vec4First(v, null));
            else if (nm === 'AlphaScale') setIfAbsentNum('alphaScale', this._vec4First(v, null));
            else if (nm === 'alphaTestValue' || nm === 'AlphaTest' || nm === 'alphaTest') setIfAbsentNum('alphaCutoff', this._vec4First(v, null));
            else if (nm === 'emissiveMultiplier') setIfAbsentNum('emissiveIntensity', this._vec4First(v, null));
            else if (nm === 'specularIntensityMult') setIfAbsentNum('specularIntensity', this._vec4First(v, null));
            else if (nm === 'specMapIntMask') setIfAbsentArr3('specMaskWeights', this._vec3FromVec4(v, null));
            else if (nm === 'specularFalloffMult') setIfAbsentNum('specularFalloffMult', this._vec4First(v, null));
            else if (nm === 'specularFresnel') setIfAbsentNum('specularFresnel', this._vec4First(v, null));
            else if (nm === 'globalAnimUV0') setIfAbsentArr3('globalAnimUV0', this._vec3FromVec4(v, null));
            else if (nm === 'globalAnimUV1') setIfAbsentArr3('globalAnimUV1', this._vec3FromVec4(v, null));
            else if (nm === 'gTexCoordScaleOffset0') setIfAbsentArr4('uv0ScaleOffset', v);
            else if (nm === 'gTexCoordScaleOffset1') setIfAbsentArr4('uv1ScaleOffset', v);
            else if (nm === 'gTexCoordScaleOffset2') setIfAbsentArr4('uv2ScaleOffset', v);
            else if (nm === 'gTexCoordScaleOffset3') setIfAbsentArr4('uv3ScaleOffset', v);
            else if (nm === 'detailSettings') setIfAbsentArr4('detailSettings', v);
            else if (nm === 'parallaxScaleBias') setIfAbsentArr4('parallaxScaleBias', v);
            else if (nm === 'materialWetnessMultiplier' || nm === 'wetnessMultiplier') setIfAbsentNum('wetness', this._vec4First(v, null));
            else if (nm === 'WetDarken') setIfAbsentNum('wetDarken', this._vec4First(v, null));
            else if (nm === 'reflectivePower' || nm === 'normReflectivePower') setIfAbsentNum('reflectionIntensity', this._vec4First(v, null));
            else if (nm === 'fresnelRolloff' || nm === 'normFresnelRolloff') setIfAbsentNum('fresnelPower', this._vec4First(v, null));
            else if (nm === 'tintPaletteSelector') {
                if (mat.tintPaletteSelector === undefined || mat.tintPaletteSelector === null) {
                    const x = Number(v?.[0]), y = Number(v?.[1]);
                    if (Number.isFinite(x) && Number.isFinite(y)) mat.tintPaletteSelector = [x, y];
                }
            }
            else if (nm === 'dirtLevel' || nm === 'dirtLevelMod') setIfAbsentNum('dirtLevel', this._vec4First(v, null));
            else if (nm === 'dirtColor') setIfAbsentArr3('dirtColor', this._vec3FromVec4(v, null));
            else if (nm === 'DecalTint') setIfAbsentArr3('decalTint', this._vec3FromVec4(v, null));
            else if (nm === 'AmbientDecalMask' || nm === 'ambientDecalMask') {
                if (mat.ambientDecalMask === undefined || mat.ambientDecalMask === null) {
                    const v4 = normMask4(v);
                    if (v4) mat.ambientDecalMask = v4;
                }
            }
            else if (nm === 'DirtDecalMask' || nm === 'dirtDecalMask') {
                if (mat.dirtDecalMask === undefined || mat.dirtDecalMask === null) {
                    const v4 = normMask4(v);
                    if (v4) mat.dirtDecalMask = v4;
                }
            }
            else if (nm === 'g_PuddleParams') setIfAbsentArr4('puddleParams', v);
            else if (nm === 'g_Puddle_ScaleXY_Range') setIfAbsentArr4('puddleScaleRange', v);
        }
    }

    _normalizeMaterialFromShaderParamsInPlace(mat) {
        // Some exporters only populate `shaderParams.texturesByHash` (CodeWalker-style),
        // and omit viewer-friendly keys like `diffuse` / `normal` / `spec`.
        // We patch-in best-effort defaults so textures are at least requested.
        if (!mat || typeof mat !== 'object') return;

        // --- Trees/foliage shaders ---
        // Tree exports are especially susceptible to the generic material fallback: a few older
        // manifests populated every texture field with the diffuse atlas. Keep their known sampler
        // layout authoritative so diffuse, normal, specular, and palette maps cannot get crossed.
        try {
            const sn = String(mat.shaderName || '').toLowerCase();
            const isColorPassHelperShader = sn.includes('cpv_only')
                || sn.includes('decal_shadow_only')
                || sn.includes('trees_shadow_proxy');
            if (isColorPassHelperShader) {
                // CodeWalker does not put these shaders into a visible colour batch.
                // Rendering them in our colour pass creates pale/proxy blobs inside foliage.
                mat.skipColorPass = true;
            }

            const alphaMode = String(mat.alphaMode || '').toLowerCase();
            const texNames = [];
            try {
                const texByHash0 = mat.shaderParams?.texturesByHash;
                if (texByHash0 && typeof texByHash0 === 'object') {
                    for (const v of Object.values(texByHash0)) {
                        if (typeof v === 'string' && v) texNames.push(v);
                    }
                }
            } catch { /* ignore */ }
            for (const key of ['diffuse', 'diffuseName', 'diffuseKtx2']) {
                if (typeof mat[key] === 'string' && mat[key]) texNames.push(mat[key]);
            }
            const texText = texNames.join(' ').toLowerCase();
            const looksFoliageAtlas = texText.includes('branch')
                || texText.includes('branches')
                || texText.includes('leaf')
                || texText.includes('leaves')
                || texText.includes('foliage');
            const isTreeFoliageShader = sn.includes('trees_');
            const isFoliageCutout = isTreeFoliageShader
                || ((alphaMode === 'cutout' || sn.includes('cutout')) && looksFoliageAtlas);

            if (isFoliageCutout && !isColorPassHelperShader) {
                mat.shaderFamily = 'basic';
                mat.alphaMode = 'cutout';
                if (!Number.isFinite(Number(mat.alphaCutoff))) {
                    const vecByHash = mat.shaderParams?.vectorsByHash;
                    const getVec = (hashStr) => (vecByHash && typeof vecByHash === 'object')
                        ? (vecByHash[String(hashStr)] ?? vecByHash[Number(hashStr)] ?? null)
                        : null;
                    const exportedCutoff = this._vec4First(getVec('3310830370'), this._vec4First(getVec('950204405'), null));
                    const cutoff = Number(exportedCutoff);
                    mat.alphaCutoff = (Number.isFinite(cutoff) && cutoff > 0.01)
                        ? Math.max(0.0, Math.min(1.0, cutoff))
                        : 0.33;
                }
                mat.doubleSided = true;
                mat.alphaToCoverage = true;
                // TreesLodShader and TreesLod2Shader sample diffuse on Texcoord1.
                if (sn.includes('trees_lod') && mat.diffuseUvSet === undefined && mat.diffuseUv === undefined) {
                    mat.diffuseUv = 'uv1';
                }
            }
        } catch { /* ignore */ }

        const sp = mat.shaderParams;
        const texByHash = (sp && typeof sp === 'object') ? sp.texturesByHash : null;
        if (!texByHash || typeof texByHash !== 'object') return;
        const textureBindingsExplicit = mat.textureBindingsExplicit === true;

        // --- Terrain drawable detection (CodeWalker terrain_cb_* family) ---
        // In your exported manifests, many terrain drawables come through with shaderFamily="wetness"
        // even though their shaderName is terrain_cb_* and should be handled by the terrain material branch.
        // Fix that up early so the renderer can select the correct code path.
        try {
            const sn0 = String(mat.shaderName || '').toLowerCase();
            if (sn0.includes('terrain_cb_')) {
                mat.shaderFamily = 'terrain';
            }
        } catch { /* ignore */ }

        // CodeWalker ShaderParamNames hashes (see CodeWalker.Core/GameFiles/Resources/ShaderParams.cs).
        // We only map fields the viewer actually understands.
        //
        // Observed in your manifest.json (top keys):
        // - DiffuseSampler=4059966321
        // - BumpSampler=1186448975
        // - SpecSampler=1619499462
        // - DetailSampler=3393362404
        // - DiffuseSampler2=181641832
        // - TextureSampler_layer0=3576369631  (layered materials; best-effort fallback to diffuse)
        // - DiffuseHfSampler=2946270081       (best-effort fallback to diffuse)
        // - BumpSampler_layer0..3=1073714531/1422769919/2745359528/2975430677 (fallback to normal)
        const SLOTS = [
            // Diffuse-ish
            { key: 'diffuse', hashes: ['4059966321', '1732587965', '1399472831', '2669264211', '934209648', '3576369631', '2946270081', '1616890976'] }, // + distanceMapSampler
            { key: 'diffuse2', hashes: ['181641832'] },
            // Normal-ish
            { key: 'normal', hashes: ['1186448975', '2327911600', '1073714531', '1422769919', '2745359528', '2975430677'] },
            // Spec-ish
            { key: 'spec', hashes: ['1619499462', '2134197289'] },
            // Detail-ish (detail normal / detail map)
            { key: 'detail', hashes: ['3393362404', '1041827691'] },
            // AO / occlusion
            { key: 'ao', hashes: ['50748941', '1212577329'] },
            // Decal alpha mask / opacity mask
            { key: 'alphaMask', hashes: ['1705051233'] },
            // Height/parallax (best-effort)
            { key: 'height', hashes: ['1008099585', '4049987115', '4152773162'] },
            // Tint palettes
            { key: 'tintPalette', hashes: ['4131954791', '2878898974'] }, // TintPaletteSampler, TextureSamplerDiffPal
            { key: 'tint', hashes: ['1530343050'] },
            // Env maps (best-effort)
            { key: 'env', hashes: ['3317411368', '2951443911', '3837901164'] },
            // Dirt/damage/puddles (best-effort)
            { key: 'dirt', hashes: ['2124031998'] },
            { key: 'damage', hashes: ['3579349756', '4132715990'] },
            { key: 'damageSpec', hashes: ['3820652825'] },
            { key: 'damageMask', hashes: ['1117905904'] },
            { key: 'puddleMask', hashes: ['1899494261'] },
            // Water (CodeWalker WaterShader)
            { key: 'waterFlow', hashes: ['1214194352'] }, // FlowSampler
            { key: 'waterFoam', hashes: ['3266349336'] }, // FoamSampler
            // Terrain (best-effort; commonly authored as DiffuseTexSampler01..04)
            { key: 'terrainColor1', hashes: ['255045494'] },
            { key: 'terrainColor2', hashes: ['2707084226'] },
            { key: 'terrainColor3', hashes: ['2981196911'] },
            { key: 'terrainColor4', hashes: ['3291650421'] },
            // Terrain normals (best-effort layer normals)
            { key: 'terrainNormal1', hashes: ['1422769919'] },
            { key: 'terrainNormal2', hashes: ['2745359528'] },
            { key: 'terrainNormal3', hashes: ['2975430677'] },
            { key: 'terrainNormal4', hashes: ['2417505683'] },
        ];

        const getHashVal = (hashStr) => {
            const h = String(hashStr || '');
            return texByHash[h] ?? texByHash[Number(h)] ?? null;
        };
        const hasPreprocessedTexture = (key) => {
            const rel = mat[key];
            return typeof rel === 'string' && /^demo\/models_textures(?:_v\d+)?\//i.test(rel);
        };

        const clearTextureSlot = (key) => {
            delete mat[key];
            delete mat[`${key}Ktx2`];
            delete mat[`${key}Name`];
            delete mat[`${key}ParamHash`];
            if (key === 'diffuse2') delete mat.diffuse2Uv;
        };
        const setTextureSlot = (key, rel, hash) => {
            mat[key] = rel;
            delete mat[`${key}Ktx2`];
            mat[`${key}ParamHash`] = Number(hash);
            if (key === 'diffuse2') mat.diffuse2Uv = 'uv1';
        };

        // Tree shader parameter layouts are compact and known. Do this before the generic mapping
        // below, which intentionally makes broad best-effort guesses for unrelated shader families.
        try {
            const sn = String(mat.shaderName || '').toLowerCase();
            if (sn.includes('trees_')) {
                const setTreeTexture = (key, hash) => {
                    if (hasPreprocessedTexture(key)) return;
                    const v = getHashVal(hash);
                    const rel = (typeof v === 'string' && v) ? this._textureRelFromShaderParamValue(v) : null;
                    if (rel) {
                        mat[key] = rel;
                    } else {
                        delete mat[key];
                        delete mat[`${key}Ktx2`];
                    }
                };
                const clearTreeTexture = (key) => {
                    if (hasPreprocessedTexture(key)) return;
                    delete mat[key];
                    delete mat[`${key}Ktx2`];
                };

                setTreeTexture('diffuse', '4059966321');
                clearTreeTexture('diffuse2');
                clearTreeTexture('detail');
                clearTreeTexture('ao');
                clearTreeTexture('height');
                clearTreeTexture('emissive');

                if (sn.includes('trees_normal_spec')) {
                    setTreeTexture('normal', '1186448975');
                    setTreeTexture('spec', '1619499462');
                } else {
                    clearTreeTexture('normal');
                    clearTreeTexture('spec');
                }

                if (sn.includes('trees_tnt')) {
                    setTreeTexture('tintPalette', '4131954791');
                } else {
                    clearTreeTexture('tintPalette');
                }
            }
        } catch { /* ignore */ }

        for (const s of SLOTS) {
            // FiveM/custom-resource exporters resolve their local YTD up front.
            // Their raw shader metadata can reference external texture dictionaries
            // that were not part of the resource. Preserve the verified bindings
            // instead of synthesizing URLs that overwrite them and repeatedly 404.
            if (textureBindingsExplicit) continue;
            // Compact demo manifests contain authoritative, content-addressed
            // bindings. Reconstructing them from shader texture names points the
            // runtime back at the multi-gigabyte source PNG tree.
            if (hasPreprocessedTexture(s.key)) continue;
            let resolved = null;
            let resolvedHash = null;
            for (const hash of (s.hashes || [])) {
                const v = getHashVal(hash);
                if (typeof v !== 'string' || !v) continue;
                const rel = this._textureRelFromShaderParamValue(v);
                if (rel) {
                    resolved = rel;
                    resolvedHash = hash;
                    break;
                }
            }
            if (resolved) {
                // `shaderParams` is the source asset binding from the drawable. Older
                // exports can prefill generic slots from a different submesh, so it
                // must override those fallback fields rather than merely fill blanks.
                setTextureSlot(s.key, resolved, resolvedHash);
                continue;
            }

            const sourceHash = Number(mat[`${s.key}ParamHash`]);
            const isKnownSource = Number.isFinite(sourceHash)
                && (s.hashes || []).some((hash) => Number(hash) === sourceHash);
            if (!isKnownSource && typeof mat[s.key] === 'string' && mat[s.key]) {
                // A fallback field tagged with a sampler that belongs to another slot
                // (for example DiffuseSampler copied into detail/AO) is invalid.
                clearTextureSlot(s.key);
            }
        }

        // GTA's Basic shader has no independent emissive sampler. The primary diffuse
        // map is used by emissive shader variants, while ordinary materials must not
        // inherit arbitrary `emissive` fields from an exporter fallback.
        if (!textureBindingsExplicit) {
            const shaderNameLower = String(mat.shaderName || '').toLowerCase();
            if (shaderNameLower.includes('emissive')) {
                if (typeof mat.diffuse === 'string' && mat.diffuse) {
                    mat.emissive = mat.diffuse;
                    delete mat.emissiveKtx2;
                    mat.emissiveParamHash = 4059966321;
                }
            } else {
                clearTextureSlot('emissive');
            }
        }

        // Also pull common scalar/vector fields out of vectorsByHash where possible.
        try { this._applyCommonMaterialFieldsFromShaderParamsInPlace(mat); } catch { /* ignore */ }
        try { this._resolveShaderParamsForDebugInPlace(mat); } catch { /* ignore */ }

        // Terrain/water adapter: map specialized exporter fields into the generic slots
        // that InstancedModelRenderer already binds (shader branches interpret them by shaderFamily).
        try {
            const fam = String(mat.shaderFamily || '').toLowerCase();
            if (fam === 'terrain') {
                // Prefer direct hashes observed in your terrain_cb_* materials.
                // These correspond to the 4 diffuse layers + 4 bump layers + 1 colourmask in CodeWalker TerrainPS*.
                // NOTE: We intentionally map these into existing renderer slots so InstancedModelRenderer’s
                // terrain branch can bind without exploding sampler counts.
                const getTexRel = (hashStr) => {
                    const v = texByHash[String(hashStr)] ?? texByHash[Number(hashStr)] ?? null;
                    if (typeof v !== 'string' || !v) return null;
                    return this._textureRelFromShaderParamValue(v);
                };

                // Diffuse layers (Colourmap1..4 in CodeWalker)
                const tLayer1 = getTexRel('3576369631'); // observed: TextureSampler_layer0
                const tLayer2 = getTexRel('606121937');
                const tLayer3 = getTexRel('831736502');
                const tLayer4 = getTexRel('2025281789');
                if (tLayer1 && !(typeof mat.diffuse === 'string' && mat.diffuse)) mat.diffuse = tLayer1;
                if (tLayer2 && !(typeof mat.diffuse2 === 'string' && mat.diffuse2)) {
                    mat.diffuse2 = tLayer2;
                    mat.diffuse2Uv = 'uv0';
                }
                if (tLayer3 && !(typeof mat.emissive === 'string' && mat.emissive)) {
                    mat.emissive = tLayer3;
                    // Terrain branch uses emissive as a colour layer; keep additive emissive disabled by default.
                    if (!Number.isFinite(Number(mat.emissiveIntensity))) mat.emissiveIntensity = 0.0;
                }
                if (tLayer4 && !(typeof mat.env === 'string' && mat.env)) mat.env = tLayer4;

                // Colourmask (CodeWalker Colourmask sampled on Texcoord1). Map to alphaMask slot for the terrain branch.
                const tMask = getTexRel('2295086480');
                if (tMask && !(typeof mat.alphaMask === 'string' && mat.alphaMask)) mat.alphaMask = tMask;

                // Normal layers (Normalmap1..4 in CodeWalker). Map across existing samplers:
                // - normal  -> layer1 bump
                // - detail  -> layer2 bump (repurposed in terrain branch)
                // - dirt    -> layer3 bump (repurposed in terrain branch)
                // - damage  -> layer4 bump (repurposed in terrain branch)
                const nLayer1 = getTexRel('1073714531');
                const nLayer2 = getTexRel('1422769919');
                const nLayer3 = getTexRel('2745359528');
                const nLayer4 = getTexRel('2975430677');
                if (nLayer1 && !(typeof mat.normal === 'string' && mat.normal)) mat.normal = nLayer1;
                if (nLayer2 && !(typeof mat.detail === 'string' && mat.detail)) mat.detail = nLayer2;
                if (nLayer3 && !(typeof mat.dirt === 'string' && mat.dirt)) mat.dirt = nLayer3;
                if (nLayer4 && !(typeof mat.damage === 'string' && mat.damage)) mat.damage = nLayer4;

                // Some terrain shaders provide a 5th diffuse/normal; best-effort: bind as spec if present.
                const tLayer5 = getTexRel('3291650421') || getTexRel('2981196911') || getTexRel('2707084226') || getTexRel('255045494');
                if (tLayer5 && !(typeof mat.spec === 'string' && mat.spec)) mat.spec = tLayer5;
            } else if (fam === 'water') {
                // Accept CodeWalker WaterPS.hlsli texture names and map them into the viewer's existing slots.
                // CodeWalker WaterPS binds:
                //  - Colourmap (t0)      -> diffuse
                //  - Bumpmap   (t2)      -> normal (water bumpmap, not ripple bumps)
                //  - Foammap   (t3)      -> dirt slot (repurposed as foammap for water family)
                //  - WaterBumpSampler (t4)  -> detail slot (repurposed)
                //  - WaterBumpSampler2 (t5) -> spec slot (repurposed)
                //  - WaterFog (t6)          -> env slot (repurposed)
                // FlowSampler (VS) drives Flow.zw; we map it into damage slot (repurposed).

                // Alias-friendly fields (support both camelCase and CodeWalker capitalization).
                const cwColour = (typeof mat.Colourmap === 'string' && mat.Colourmap) ? mat.Colourmap : (typeof mat.colourmap === 'string' ? mat.colourmap : null);
                const cwBump = (typeof mat.Bumpmap === 'string' && mat.Bumpmap) ? mat.Bumpmap : (typeof mat.bumpmap === 'string' ? mat.bumpmap : null);
                const cwFoam = (typeof mat.Foammap === 'string' && mat.Foammap) ? mat.Foammap : (typeof mat.foammap === 'string' ? mat.foammap : null);
                const cwWaterBump1 = (typeof mat.WaterBumpSampler === 'string' && mat.WaterBumpSampler) ? mat.WaterBumpSampler : (typeof mat.waterBumpSampler === 'string' ? mat.waterBumpSampler : null);
                const cwWaterBump2 = (typeof mat.WaterBumpSampler2 === 'string' && mat.WaterBumpSampler2) ? mat.WaterBumpSampler2 : (typeof mat.waterBumpSampler2 === 'string' ? mat.waterBumpSampler2 : null);
                const cwWaterFog = (typeof mat.WaterFog === 'string' && mat.WaterFog) ? mat.WaterFog : (typeof mat.waterFog === 'string' ? mat.waterFog : null);
                const cwFlow = (typeof mat.FlowSampler === 'string' && mat.FlowSampler) ? mat.FlowSampler : (typeof mat.flowSampler === 'string' ? mat.flowSampler : null);
                const cwFoamSampler = (typeof mat.FoamSampler === 'string' && mat.FoamSampler) ? mat.FoamSampler : (typeof mat.foamSampler === 'string' ? mat.foamSampler : null);

                // Prefer explicit "water*" exporter fields, otherwise fall back to CodeWalker names.
                const wDiffuse = (typeof mat.waterDiffuse === 'string' && mat.waterDiffuse) ? mat.waterDiffuse : cwColour;
                const wBump = (typeof mat.waterBump === 'string' && mat.waterBump) ? mat.waterBump : cwBump;
                const wFoam = (typeof mat.waterFoam === 'string' && mat.waterFoam) ? mat.waterFoam : (cwFoam ?? cwFoamSampler);
                const wFlow = (typeof mat.waterFlow === 'string' && mat.waterFlow) ? mat.waterFlow : cwFlow;
                const wB1 = (typeof mat.waterBumpSampler === 'string' && mat.waterBumpSampler) ? mat.waterBumpSampler : cwWaterBump1;
                const wB2 = (typeof mat.waterBumpSampler2 === 'string' && mat.waterBumpSampler2) ? mat.waterBumpSampler2 : cwWaterBump2;
                const wFog = (typeof mat.waterFog === 'string' && mat.waterFog) ? mat.waterFog : cwWaterFog;

                if (wDiffuse && !(typeof mat.diffuse === 'string' && mat.diffuse)) mat.diffuse = wDiffuse;
                if (wBump && !(typeof mat.normal === 'string' && mat.normal)) mat.normal = wBump;

                // Water branch uses existing dirt/damage samplers as foam/flow to avoid adding new sampler uniforms.
                if (wFoam && !(typeof mat.dirt === 'string' && mat.dirt)) mat.dirt = wFoam;
                if (wFlow && !(typeof mat.damage === 'string' && mat.damage)) mat.damage = wFlow;

                // Ripple bump textures + water fog (repurpose detail/spec/env).
                if (wB1 && !(typeof mat.detail === 'string' && mat.detail)) mat.detail = wB1;
                if (wB2 && !(typeof mat.spec === 'string' && mat.spec)) mat.spec = wB2;
                if (wFog && !(typeof mat.env === 'string' && mat.env)) mat.env = wFog;

                if (!(typeof mat.alphaMode === 'string' && mat.alphaMode)) mat.alphaMode = 'blend';
            }
        } catch { /* ignore */ }

        // Alpha-to-coverage (best-effort): used heavily by CodeWalker for foliage/grass cutouts.
        if (mat.alphaToCoverage === undefined || mat.alphaToCoverage === null) {
            const am = String(mat.alphaMode || '').toLowerCase();
            if (am === 'cutout') {
                // If a material is cutout + double-sided, A2C is usually a better approximation than hard discard edges.
                mat.alphaToCoverage = !!mat.doubleSided;
            } else {
                mat.alphaToCoverage = false;
            }
        }
    }

    _clearStaleEntryTextureFallbackForSubmeshLodsInPlace(entry) {
        const mat = entry?.material;
        if (!mat || typeof mat !== 'object') return;
        const entryHasAuthoritativeShader = !!(
            (typeof mat.shaderName === 'string' && mat.shaderName)
            || (mat.shaderParams && typeof mat.shaderParams === 'object')
        );
        if (entryHasAuthoritativeShader) return;

        let submeshCount = 0;
        let materialCount = 0;
        const lods = entry?.lods;
        if (lods && typeof lods === 'object') {
            for (const lodMeta of Object.values(lods)) {
                const subs = lodMeta?.submeshes;
                if (!Array.isArray(subs)) continue;
                for (const sm of subs) {
                    if (!sm || typeof sm !== 'object') continue;
                    submeshCount++;
                    if (sm.material && typeof sm.material === 'object' && Object.keys(sm.material).length > 0) materialCount++;
                }
            }
        }
        if (submeshCount > 0 && submeshCount === materialCount) delete entry.material;
    }

    _normalizeManifestMeshEntryInPlace(entry) {
        if (!entry || typeof entry !== 'object') return;
        if (entry.__viewerNormalizedMaterials) return;

        try {
            this._normalizeMaterialFromShaderParamsInPlace(entry.material);
        } catch { /* ignore */ }

        try {
            const lods = entry.lods;
            if (lods && typeof lods === 'object') {
                for (const lodMeta of Object.values(lods)) {
                    if (!lodMeta || typeof lodMeta !== 'object') continue;
                    const subs = lodMeta.submeshes;
                    if (!Array.isArray(subs)) continue;
                    for (const sm of subs) {
                        if (!sm || typeof sm !== 'object') continue;
                        this._normalizeMaterialFromShaderParamsInPlace(sm.material);
                    }
                }
            }
        } catch { /* ignore */ }

        try {
            this._clearStaleEntryTextureFallbackForSubmeshLodsInPlace(entry);
        } catch { /* ignore */ }

        // Mark so we don't redo this work on every call site.
        entry.__viewerNormalizedMaterials = true;
    }

    /**
     * Build a stable "material signature" string so we can group meshes/submeshes that
     * effectively use the same material (diffuse/normal/spec + scalar params + UV transform).
     *
     * This is intentionally conservative: if fields differ, signatures differ.
     */
    _materialSignature(mat) {
        const m = (mat && typeof mat === 'object') ? mat : {};
        const sigObj = {
            shaderFamily: (typeof m.shaderFamily === 'string' && m.shaderFamily) ? m.shaderFamily : null,
            shaderName: (typeof m.shaderName === 'string' && m.shaderName) ? m.shaderName : null,
            diffuse: (typeof m.diffuse === 'string' && m.diffuse) ? m.diffuse : null,
            diffuseKtx2: (typeof m.diffuseKtx2 === 'string' && m.diffuseKtx2) ? m.diffuseKtx2 : null,
            diffuse2: (typeof m.diffuse2 === 'string' && m.diffuse2) ? m.diffuse2 : null,
            diffuse2Uv: (typeof m.diffuse2Uv === 'string' && m.diffuse2Uv) ? m.diffuse2Uv : null,
            diffuse2Ktx2: (typeof m.diffuse2Ktx2 === 'string' && m.diffuse2Ktx2) ? m.diffuse2Ktx2 : null,
            normal: (typeof m.normal === 'string' && m.normal) ? m.normal : null,
            normalKtx2: (typeof m.normalKtx2 === 'string' && m.normalKtx2) ? m.normalKtx2 : null,
            spec: (typeof m.spec === 'string' && m.spec) ? m.spec : null,
            specKtx2: (typeof m.specKtx2 === 'string' && m.specKtx2) ? m.specKtx2 : null,
            emissive: (typeof m.emissive === 'string' && m.emissive) ? m.emissive : null,
            emissiveKtx2: (typeof m.emissiveKtx2 === 'string' && m.emissiveKtx2) ? m.emissiveKtx2 : null,
            detail: (typeof m.detail === 'string' && m.detail) ? m.detail : null,
            detailKtx2: (typeof m.detailKtx2 === 'string' && m.detailKtx2) ? m.detailKtx2 : null,
            ao: (typeof m.ao === 'string' && m.ao) ? m.ao : null,
            aoKtx2: (typeof m.aoKtx2 === 'string' && m.aoKtx2) ? m.aoKtx2 : null,
            height: (typeof m.height === 'string' && m.height) ? m.height : null,
            heightKtx2: (typeof m.heightKtx2 === 'string' && m.heightKtx2) ? m.heightKtx2 : null,
            alphaMask: (typeof m.alphaMask === 'string' && m.alphaMask) ? m.alphaMask : null,
            alphaMaskKtx2: (typeof m.alphaMaskKtx2 === 'string' && m.alphaMaskKtx2) ? m.alphaMaskKtx2 : null,
            isDistMap: !!m.isDistMap,
            diffuseUvSet: (m.diffuseUvSet ?? m.diffuseUv ?? null),
            // Store the resolved renderer behavior rather than the source spelling so aliases such as
            // "RG" and "rg" continue to batch while distinct normal decoding cannot be combined.
            normalEncoding: (String(m.normalSwizzle || 'rg').toLowerCase() === 'ag') ? 1 : 0,
            normalReconstructZ: (m.normalReconstructZ === undefined || m.normalReconstructZ === null)
                ? 1
                : this._roundNum(m.normalReconstructZ),
            // Extra workflow textures (best-effort parity): include in signature to prevent incorrect batching.
            tintPalette: (typeof m.tintPalette === 'string' && m.tintPalette) ? m.tintPalette : null,
            env: (typeof m.env === 'string' && m.env) ? m.env : null,
            dirt: (typeof m.dirt === 'string' && m.dirt) ? m.dirt : null,
            damage: (typeof m.damage === 'string' && m.damage) ? m.damage : null,
            damageMask: (typeof m.damageMask === 'string' && m.damageMask) ? m.damageMask : null,
            puddleMask: (typeof m.puddleMask === 'string' && m.puddleMask) ? m.puddleMask : null,
            // Per-texture UV selectors (viewer-side feature; prevents batching incompatible UV choices).
            // Accept either "*UvSet" numeric fields or "*Uv" string fields ("uv0"/"uv1"/"uv2").
            normalUvSet: (m.normalUvSet ?? m.normalUv ?? null),
            specUvSet: (m.specUvSet ?? m.specUv ?? null),
            detailUvSet: (m.detailUvSet ?? m.detailUv ?? null),
            aoUvSet: (m.aoUvSet ?? m.aoUv ?? null),
            emissiveUvSet: (m.emissiveUvSet ?? m.emissiveUv ?? null),
            uv0ScaleOffset: this._normalizeUvScaleOffset(m.uv0ScaleOffset),
            uv1ScaleOffset: this._normalizeUvScaleOffset(m.uv1ScaleOffset),
            uv2ScaleOffset: this._normalizeUvScaleOffset(m.uv2ScaleOffset),
            uv3ScaleOffset: this._normalizeUvScaleOffset(m.uv3ScaleOffset),
            tintMode: Number.isFinite(Number(m.tintMode)) ? (Number(m.tintMode) | 0) : null,
            globalAnimUV0: (Array.isArray(m.globalAnimUV0) && m.globalAnimUV0.length >= 3)
                ? [this._roundNum(m.globalAnimUV0[0]), this._roundNum(m.globalAnimUV0[1]), this._roundNum(m.globalAnimUV0[2])]
                : null,
            globalAnimUV1: (Array.isArray(m.globalAnimUV1) && m.globalAnimUV1.length >= 3)
                ? [this._roundNum(m.globalAnimUV1[0]), this._roundNum(m.globalAnimUV1[1]), this._roundNum(m.globalAnimUV1[2])]
                : null,
            bumpiness: this._roundNum(m.bumpiness),
            specularIntensity: this._roundNum(m.specularIntensity),
            specularPower: this._roundNum(m.specularPower),
            specularFalloffMult: this._roundNum(m.specularFalloffMult),
            specularFresnel: this._roundNum(m.specularFresnel),
            emissiveIntensity: this._roundNum(m.emissiveIntensity),
            aoStrength: this._roundNum(m.aoStrength),
            parallaxScaleBias: (Array.isArray(m.parallaxScaleBias) && m.parallaxScaleBias.length >= 2)
                ? [this._roundNum(m.parallaxScaleBias[0]), this._roundNum(m.parallaxScaleBias[1]), this._roundNum(m.parallaxScaleBias[2]), this._roundNum(m.parallaxScaleBias[3])]
                : null,
            wetness: this._roundNum(m.wetness),
            wetDarken: this._roundNum(m.wetDarken),
            wetSpecBoost: this._roundNum(m.wetSpecBoost),
            reflectionIntensity: this._roundNum(m.reflectionIntensity),
            fresnelPower: this._roundNum(m.fresnelPower),
            dirtLevel: this._roundNum(m.dirtLevel),
            dirtColor: (Array.isArray(m.dirtColor) && m.dirtColor.length >= 3)
                ? [this._roundNum(m.dirtColor[0]), this._roundNum(m.dirtColor[1]), this._roundNum(m.dirtColor[2])]
                : null,
            decalTint: (Array.isArray(m.decalTint) && m.decalTint.length >= 3)
                ? [this._roundNum(m.decalTint[0]), this._roundNum(m.decalTint[1]), this._roundNum(m.decalTint[2])]
                : null,
            puddleParams: (Array.isArray(m.puddleParams) && m.puddleParams.length >= 4)
                ? [this._roundNum(m.puddleParams[0]), this._roundNum(m.puddleParams[1]), this._roundNum(m.puddleParams[2]), this._roundNum(m.puddleParams[3])]
                : null,
            puddleScaleRange: (Array.isArray(m.puddleScaleRange) && m.puddleScaleRange.length >= 4)
                ? [this._roundNum(m.puddleScaleRange[0]), this._roundNum(m.puddleScaleRange[1]), this._roundNum(m.puddleScaleRange[2]), this._roundNum(m.puddleScaleRange[3])]
                : null,
            ambientDecalMask: (Array.isArray(m.ambientDecalMask) && m.ambientDecalMask.length >= 4)
                ? [this._roundNum(m.ambientDecalMask[0]), this._roundNum(m.ambientDecalMask[1]), this._roundNum(m.ambientDecalMask[2]), this._roundNum(m.ambientDecalMask[3])]
                : null,
            dirtDecalMask: (Array.isArray(m.dirtDecalMask) && m.dirtDecalMask.length >= 4)
                ? [this._roundNum(m.dirtDecalMask[0]), this._roundNum(m.dirtDecalMask[1]), this._roundNum(m.dirtDecalMask[2]), this._roundNum(m.dirtDecalMask[3])]
                : null,
            alphaMode: (typeof m.alphaMode === 'string' && m.alphaMode) ? m.alphaMode : null,
            alphaCutoff: this._roundNum(m.alphaCutoff),
            alphaScale: this._roundNum(m.alphaScale),
            hardAlphaBlend: this._roundNum(m.hardAlphaBlend),
            alphaToCoverage: !!m.alphaToCoverage,
            doubleSided: !!m.doubleSided,
            pedHairTint: m.pedHairTint === true,
            decalBlendMode: (typeof m.decalBlendMode === 'string' && m.decalBlendMode) ? m.decalBlendMode : null,
            decalDepthBias: this._roundNum(m.decalDepthBias),
            decalSlopeScale: this._roundNum(m.decalSlopeScale),
            // Spec map channel weights (vec3) - stable key so batching doesn't mix different semantics.
            specMaskWeights: (Array.isArray(m.specMaskWeights) && m.specMaskWeights.length >= 3)
                ? [this._roundNum(m.specMaskWeights[0]), this._roundNum(m.specMaskWeights[1]), this._roundNum(m.specMaskWeights[2])]
                : null,
            detailSettings: (Array.isArray(m.detailSettings) && m.detailSettings.length >= 4)
                ? [this._roundNum(m.detailSettings[0]), this._roundNum(m.detailSettings[1]), this._roundNum(m.detailSettings[2]), this._roundNum(m.detailSettings[3])]
                : null,

            // Terrain (separate shader path)
            terrainColor0: (typeof m.terrainColor0 === 'string' && m.terrainColor0) ? m.terrainColor0 : null,
            terrainColor1: (typeof m.terrainColor1 === 'string' && m.terrainColor1) ? m.terrainColor1 : null,
            terrainColor2: (typeof m.terrainColor2 === 'string' && m.terrainColor2) ? m.terrainColor2 : null,
            terrainColor3: (typeof m.terrainColor3 === 'string' && m.terrainColor3) ? m.terrainColor3 : null,
            terrainColor4: (typeof m.terrainColor4 === 'string' && m.terrainColor4) ? m.terrainColor4 : null,
            terrainMask: (typeof m.terrainMask === 'string' && m.terrainMask) ? m.terrainMask : null,
            terrainNormal0: (typeof m.terrainNormal0 === 'string' && m.terrainNormal0) ? m.terrainNormal0 : null,
            terrainNormal1: (typeof m.terrainNormal1 === 'string' && m.terrainNormal1) ? m.terrainNormal1 : null,
            terrainNormal2: (typeof m.terrainNormal2 === 'string' && m.terrainNormal2) ? m.terrainNormal2 : null,
            terrainNormal3: (typeof m.terrainNormal3 === 'string' && m.terrainNormal3) ? m.terrainNormal3 : null,
            terrainNormal4: (typeof m.terrainNormal4 === 'string' && m.terrainNormal4) ? m.terrainNormal4 : null,

            // Water (separate shader path)
            waterDiffuse: (typeof m.waterDiffuse === 'string' && m.waterDiffuse) ? m.waterDiffuse : null,
            waterBump: (typeof m.waterBump === 'string' && m.waterBump) ? m.waterBump : null,
            waterFoam: (typeof m.waterFoam === 'string' && m.waterFoam) ? m.waterFoam : null,
            waterFlow: (typeof m.waterFlow === 'string' && m.waterFlow) ? m.waterFlow : null,
            waterBumpSampler: (typeof m.waterBumpSampler === 'string' && m.waterBumpSampler) ? m.waterBumpSampler : null,
            waterBumpSampler2: (typeof m.waterBumpSampler2 === 'string' && m.waterBumpSampler2) ? m.waterBumpSampler2 : null,
            waterFog: (typeof m.waterFog === 'string' && m.waterFog) ? m.waterFog : null,
            // Water params (CodeWalker-style)
            gFlowParams: (Array.isArray(m.gFlowParams) && m.gFlowParams.length >= 4)
                ? [this._roundNum(m.gFlowParams[0]), this._roundNum(m.gFlowParams[1]), this._roundNum(m.gFlowParams[2]), this._roundNum(m.gFlowParams[3])]
                : null,
            waterFogParams: (Array.isArray(m.waterFogParams) && m.waterFogParams.length >= 4)
                ? [this._roundNum(m.waterFogParams[0]), this._roundNum(m.waterFogParams[1]), this._roundNum(m.waterFogParams[2]), this._roundNum(m.waterFogParams[3])]
                : null,
            waterEnableTexture: (m.waterEnableTexture === undefined || m.waterEnableTexture === null)
                ? !String(m.shaderName || '').toLowerCase().includes('foam')
                : !!m.waterEnableTexture,
            waterEnableBumpMap: (m.waterEnableBumpMap === undefined || m.waterEnableBumpMap === null)
                ? true
                : !!m.waterEnableBumpMap,
            waterEnableFoamMap: (m.waterEnableFoamMap === undefined || m.waterEnableFoamMap === null)
                ? String(m.shaderName || '').toLowerCase().includes('foam')
                : !!m.waterEnableFoamMap,
            waterEnableFogtex: (m.waterEnableFogtex === undefined || m.waterEnableFogtex === null)
                ? (!!m.env && Array.isArray(m.waterFogParams) && m.waterFogParams.length >= 4)
                : !!m.waterEnableFogtex,
            enableWaterFlow: (m.enableWaterFlow === undefined || m.enableWaterFlow === null) ? null : !!m.enableWaterFlow,
            waterMode: Number.isFinite(Number(m.waterMode)) ? (Number(m.waterMode) | 0) : null,
            rippleSpeed: this._roundNum(m.rippleSpeed),
            rippleScale: this._roundNum(m.rippleScale),
            rippleBumpiness: this._roundNum(m.rippleBumpiness),
        };
        return JSON.stringify(sigObj);
    }

    _effectiveMaterialForSubmesh(entryMaterial, submeshMaterial) {
        const base = (entryMaterial && typeof entryMaterial === 'object') ? entryMaterial : null;
        const sm = (submeshMaterial && typeof submeshMaterial === 'object') ? submeshMaterial : null;
        if (!base && !sm) return {};
        if (!base) return { ...sm };
        if (!sm) return { ...base };
        const smHasAuthoritativeShaderParams = !!(sm.shaderParams && typeof sm.shaderParams === 'object');
        const baseHasAuthoritativeShader = !!(
            (typeof base.shaderName === 'string' && base.shaderName)
            || (base.shaderParams && typeof base.shaderParams === 'object')
        );
        if (smHasAuthoritativeShaderParams || !baseHasAuthoritativeShader) return { ...sm };
        // Submesh fields override entry fields when present.
        return { ...base, ...sm };
    }

    /**
     * Public helper: compute a stable signature + effective material for a (possibly per-entry) material.
     * Useful for cross-archetype instancing buckets.
     *
     * @returns {{ sig: string, material: any }}
     */
    getEffectiveMaterialAndSignature(entryMaterial, submeshMaterial) {
        const eff = this._effectiveMaterialForSubmesh(entryMaterial, submeshMaterial);
        return { sig: this._materialSignature(eff), material: eff };
    }

    /**
     * Scan the currently-loaded manifest entries and group submeshes by their effective material signature.
     * This answers: "Do any assets use the same material (potential batching candidates)?"
     *
     * Notes:
     * - In sharded mode, this only scans shards that have been loaded so far.
     * - In monolithic mode, this scans the entire manifest (can be slow on huge manifests).
     *
     * @returns {{
     *   scannedMeshes: number,
     *   scannedSubmeshes: number,
     *   groups: Array<{ sig: string, count: number, uniqueFiles: number, sample: Array<{hash: string, lod: string, file: string}> }>
     * }}
     */
    getMaterialReuseReport({ lod = 'high', includeAllLods = false, minCount = 2, limitGroups = 50, samplePerGroup = 10 } = {}) {
        const m = this.manifest?.meshes;
        if (!m || typeof m !== 'object') {
            return { scannedMeshes: 0, scannedSubmeshes: 0, groups: [] };
        }

        const l = String(lod || 'high').toLowerCase();
        const wantAll = !!includeAllLods;
        const minC = Number.isFinite(Number(minCount)) ? Math.max(1, Math.floor(Number(minCount))) : 2;
        const lim = Number.isFinite(Number(limitGroups)) ? Math.max(1, Math.min(500, Math.floor(Number(limitGroups)))) : 50;
        const samp = Number.isFinite(Number(samplePerGroup)) ? Math.max(0, Math.min(50, Math.floor(Number(samplePerGroup)))) : 10;

        /** @type {Map<string, { total: number, files: Set<string>, sample: Array<any> }>} */
        const bySig = new Map();

        let scannedMeshes = 0;
        let scannedSubmeshes = 0;

        for (const [hash, entry] of Object.entries(m)) {
            scannedMeshes++;
            if (!entry || typeof entry !== 'object') continue;
            const entryMat = entry.material ?? null;

            const lodKeys = wantAll
                ? Object.keys(entry.lods || {}).map((k) => String(k || '').toLowerCase()).filter(Boolean)
                : [l];

            for (const lk of lodKeys) {
                const subs = this.getLodSubmeshes(hash, lk);
                if (!subs || subs.length === 0) continue;
                for (const sm of subs) {
                    const file = String(sm?.file || '');
                    if (!file) continue;
                    scannedSubmeshes++;

                    const eff = this._effectiveMaterialForSubmesh(entryMat, sm?.material ?? null);
                    const sig = this._materialSignature(eff);
                    let agg = bySig.get(sig);
                    if (!agg) {
                        agg = { total: 0, files: new Set(), sample: [] };
                        bySig.set(sig, agg);
                    }
                    agg.total++;
                    agg.files.add(file);
                    if (samp > 0 && agg.sample.length < samp) {
                        agg.sample.push({ hash: String(hash), lod: String(lk || 'high'), file });
                    }
                }
            }
        }

        const groups = Array.from(bySig.entries())
            .map(([sig, v]) => ({
                sig,
                count: v.total,
                uniqueFiles: v.files.size,
                sample: v.sample,
            }))
            .filter((g) => g.count >= minC)
            // Sort by "how many distinct meshes share this material" first, then total refs.
            .sort((a, b) => (b.uniqueFiles - a.uniqueFiles) || (b.count - a.count))
            .slice(0, lim);

        return { scannedMeshes, scannedSubmeshes, groups };
    }

    /**
     * Normalize an archetype identifier into a manifest key.
     * - If it's already numeric, returns the unsigned 32-bit decimal string.
     * - Otherwise returns the joaat(name) decimal string.
     */
    normalizeId(id) {
        if (id === null || id === undefined) return null;

        // Fast path: already numeric (common for parsed YMAP/ENT exports).
        if (typeof id === 'number') {
            if (!Number.isFinite(id)) return null;
            // Coerce to uint32 (handles negative signed exports too).
            return String((id >>> 0));
        }

        const s = String(id).trim();
        if (!s) return null;

        // Common export variants we need to tolerate:
        // - signed decimal: "-123"
        // - uint32 decimal: "4294967173"
        // - hex: "0xDEADBEEF"
        // - float-like numeric strings: "123.0"
        const hex = s.match(/^0x([0-9a-f]+)$/i);
        if (hex) {
            const n = Number.parseInt(hex[1], 16);
            if (!Number.isFinite(n)) return null;
            return String((n >>> 0));
        }

        if (/^-?\d+$/.test(s)) {
            const n = Number.parseInt(s, 10);
            if (!Number.isFinite(n)) return null;
            return String((n >>> 0));
        }

        if (/^-?\d+\.\d+$/.test(s)) {
            const n = Math.trunc(Number(s));
            if (!Number.isFinite(n)) return null;
            return String((n >>> 0));
        }

        // Name path: joaat is lowercased internally (matches GTA convention).
        return String(joaat(s));
    }

    async init(manifestPath = 'assets/models/manifest.json') {
        // Prefer a sharded manifest index if present (fast startup, loads only needed shards).
        // Fallback to monolithic manifest.json (optionally parsed in a Worker).
        const path = String(manifestPath || 'assets/models/manifest.json');
        const baseDir = path.replace(/\/[^\/]+$/, '') || 'assets/models';
        this._manifestBaseDir = baseDir;
        this._kickoffNonRenderableIndexLoad(baseDir);

        // 1) Try sharded index first: <baseDir>/manifest_index.json
        try {
            const idxPath = `${baseDir}/manifest_index.json`;
            const idx = await fetchJSON(idxPath, {
                priority: 'high',
                usePersistentCache: false,
                useMemoryCache: false,
            });
            if (idx && typeof idx === 'object' && idx.schema === 'webglgta-manifest-index-v1') {
                this._sharded = true;
                this._manifestIndex = idx;
                const shardVersion = [
                    idx.source_mtime_ns,
                    idx.mesh_count,
                    idx.manifest_version,
                ].map((v) => String(v ?? '').trim()).filter(Boolean).join('-');
                this._manifestShardCacheBust = shardVersion ? `?v=${encodeURIComponent(shardVersion)}` : '';
                this.manifest = { version: (idx.manifest_version ?? 1), meshes: {} };
                this._applyManifestSubsetOverrides();
                return true;
            }
        } catch {
            // no sharded index; fall through
        }

        // 2) Monolithic manifest path
        this._sharded = false;
        this._manifestIndex = null;
        this._manifestShardCacheBust = '';
        this._loadedShards.clear();
        this._loadingShards.clear();

        // Manifest is large; prefer parsing off-thread in a Worker when possible.
        try {
            const canWorker =
                typeof Worker !== 'undefined' &&
                typeof URL !== 'undefined' &&
                // Some environments expose Worker but disallow module workers; we’ll try/catch creation anyway.
                true;

            if (canWorker) {
                try {
                    const w = new Worker(new URL('./manifest_worker.js', import.meta.url), { type: 'module' });
                    // Relative URLs inside a module worker resolve against the worker
                    // bundle (for example /bundled/), not the viewer document. Resolve
                    // here so compact deployments can fall back to manifest.json.
                    const workerManifestUrl = (() => {
                        try {
                            return new URL(path, document.baseURI).href;
                        } catch {
                            return path;
                        }
                    })();
                    const data = await new Promise((resolve, reject) => {
                        const cleanup = () => {
                            try { w.terminate(); } catch { /* ignore */ }
                        };
                        w.onmessage = (e) => {
                            const m = e?.data || {};
                            if (m.ok) {
                                cleanup();
                                resolve(m.data);
                            } else {
                                cleanup();
                                reject(new Error(m.error || 'Manifest worker failed'));
                            }
                        };
                        w.onerror = (err) => {
                            cleanup();
                            reject(err?.error || err);
                        };
                        w.postMessage({ url: workerManifestUrl });
                    });

                    this.manifest = data;
                    this._applyManifestSubsetOverrides();
                    return true;
                } catch {
                    // Fall back to main-thread JSON if Worker path fails (older browsers / CSP / file://, etc.)
                }
            }

            this.manifest = await fetchJSON(path);
            this._applyManifestSubsetOverrides();
            return true;
        } catch {
            console.warn(`ModelManager: no manifest at ${path}`);
            this.manifest = { version: 1, meshes: {} };
            return false;
        }
    }

    _shardIdForHash(hash) {
        if (!this._sharded || !this._manifestIndex) return null;
        const h = this.normalizeId(hash);
        if (!h) return null;
        const n = Number.parseInt(h, 10);
        if (!Number.isFinite(n)) return null;
        const bits = Number(this._manifestIndex.shard_bits ?? 8);
        const b = Number.isFinite(bits) ? Math.max(4, Math.min(12, Math.floor(bits))) : 8;
        const mask = (1 << b) - 1;
        return ((n >>> 0) & mask);
    }

    _shardFilename(shardId) {
        const idx = this._manifestIndex || {};
        const bits = Number(idx.shard_bits ?? 8);
        const b = Number.isFinite(bits) ? Math.max(4, Math.min(12, Math.floor(bits))) : 8;
        const hexDigits = Math.ceil(b / 4);
        const hex = (Number(shardId) >>> 0).toString(16).padStart(hexDigits, '0');
        const dir = String(idx.shard_dir || 'manifest_shards');
        const ext = String(idx.shard_file_ext || '.json');
        return `${this._manifestBaseDir}/${dir}/${hex}${ext}`;
    }

    isShardLoadedForHash(hash) {
        if (!this._sharded) return true;
        const h = this.normalizeId(hash);
        if (h && this.manifest?.meshes?.[h]) return true;
        const sid = this._shardIdForHash(hash);
        if (sid === null) return true;
        return this._loadedShards.has(sid);
    }

    prefetchMeta(hash, { priority = 'high', force = false } = {}) {
        // Fire-and-forget loading of metadata shard for this archetype.
        if (!this._sharded) return Promise.resolve(true);
        const h = this.normalizeId(hash);
        // /demo installs one spatially-filtered manifest before it starts the instance
        // stream. Do not then fetch the source shard for every one of those hashes.
        if (!force && h && this.manifest?.meshes?.[h]) return Promise.resolve(true);
        const sid = this._shardIdForHash(hash);
        if (sid === null) return Promise.resolve(false);
        return this.prefetchShardById(sid, { priority, force });
    }

    installManifestSubset(data, { source = 'runtime' } = {}) {
        const meshes = data?.meshes;
        if (!this.manifest || !this.manifest.meshes || !meshes || typeof meshes !== 'object') return 0;
        if (data?.meshPackRevisions && typeof data.meshPackRevisions === 'object') {
            this.manifest.meshPackRevisions = {
                ...(this.manifest.meshPackRevisions || {}),
                ...data.meshPackRevisions,
            };
        }
        let added = 0;
        for (const [hash, entry] of Object.entries(meshes)) {
            const h = this.normalizeId(hash);
            if (!h || !entry || typeof entry !== 'object') continue;
            this._normalizeManifestMeshEntryInPlace(entry);
            if (!this.manifest.meshes[h]) added++;
            this._manifestSubsetOverrides.set(h, entry);
            this.manifest.meshes[h] = entry;
        }
        let nonRenderableAdded = 0;
        for (const rawHash of (Array.isArray(data?.nonRenderableHashes) ? data.nonRenderableHashes : [])) {
            const h = this.normalizeId(rawHash);
            if (!h || this._nonRenderableHashes.has(h)) continue;
            this._nonRenderableHashes.add(h);
            nonRenderableAdded++;
        }
        if (added > 0 || nonRenderableAdded > 0) {
            try {
                this.onManifestUpdated?.({
                    type: 'manifestSubset',
                    source,
                    added,
                    nonRenderableAdded,
                });
            } catch { /* ignore */ }
        }
        return added;
    }

    _applyManifestSubsetOverrides() {
        if (!this.manifest?.meshes || !this._manifestSubsetOverrides.size) return;
        for (const [hash, entry] of this._manifestSubsetOverrides.entries()) {
            this.manifest.meshes[hash] = entry;
        }
    }

    /**
     * Prefetch a manifest shard directly by shardId.
     * This is useful when we have a spatial index that maps world chunks -> shard IDs, and
     * we want to warm manifest metadata *before* parsing chunk contents.
     */
    prefetchShardById(shardId, { priority = 'high', force = false } = {}) {
        if (!this._sharded) return Promise.resolve(false);
        const sid0 = Number(shardId);
        if (!Number.isFinite(sid0)) return Promise.resolve(false);
        const sid = (sid0 | 0) >>> 0;
        if (this._loadedShards.has(sid) && !force) return Promise.resolve(true);
        if (this._loadingShards.has(sid)) return this._loadingShards.get(sid);

        if (force) this._loadedShards.delete(sid);
        const urlBase = this._shardFilename(sid);
        const bust = String(this._manifestShardCacheBust || '');
        const versionedUrl = `${urlBase}${bust}`;
        const url = force
            ? `${versionedUrl}${bust ? '&' : '?'}live=${Date.now()}`
            : versionedUrl;
        const p = (async () => {
            try {
                if (force) {
                    try { await deleteAssetCacheEntry(urlBase); } catch { /* ignore */ }
                    try { await deleteAssetCacheEntry(versionedUrl); } catch { /* ignore */ }
                }
                // Shard meta gates whether we can render real meshes for nearby archetypes.
                const data = await fetchJSON(url, {
                    priority: (priority === 'low' ? 'low' : 'high'),
                    usePersistentCache: !force,
                    useMemoryCache: !force,
                });
                const meshes = data?.meshes;
                if (this.manifest && this.manifest.meshes && meshes && typeof meshes === 'object') {
                    const before = Object.keys(this.manifest.meshes).length;
                    for (const [k, v] of Object.entries(meshes)) {
                        const h = this.normalizeId(k);
                        if (h && this._manifestSubsetOverrides.has(h)) continue;
                        this.manifest.meshes[h || k] = v;
                    }
                    const after = Object.keys(this.manifest.meshes).length;
                    this._loadedShards.add(sid);
                    try {
                        this.onManifestUpdated?.({ type: 'shardLoaded', shardId: sid, url, added: Math.max(0, after - before) });
                    } catch {
                        // ignore
                    }
                } else {
                    this._loadedShards.add(sid);
                }
                return true;
            } catch (error) {
                // A failed shard is not loaded. Callers that depend on its metadata
                // must be able to retry instead of permanently treating meshes as absent.
                this._loadedShards.delete(sid);
                console.warn(`ModelManager: manifest shard ${sid} failed to load`, error);
                return false;
            } finally {
                this._loadingShards.delete(sid);
            }
        })();

        this._loadingShards.set(sid, p);
        return p;
    }

    async refreshMetaForHashes(hashes) {
        if (!this._sharded) return false;
        const sids = new Set();
        for (const hash of (Array.isArray(hashes) ? hashes : [])) {
            const sid = this._shardIdForHash(hash);
            if (sid !== null) sids.add(sid);
        }
        if (!sids.size) return false;
        const jobs = [];
        for (const sid of sids) jobs.push(this.prefetchShardById(sid, { priority: 'high', force: true }));
        await Promise.allSettled(jobs);
        return true;
    }

    requestLiveExportForHashes(hashes, { exportTextures = this.liveExportTextures } = {}) {
        if (!this.enableLiveExport || this._liveExportDisabled || this._liveExportInFlight) return;
        let batch = [];
        for (const hash of (Array.isArray(hashes) ? hashes : [])) {
            const h = this.normalizeId(hash);
            if (!h) continue;
            if (this.hasRealMesh(h)) continue;
            if (this._liveExportRequested.has(h)) continue;
            this._liveExportRequested.add(h);
            batch.push(h);
            if (batch.length >= this.liveExportBatchSize) break;
        }
        if (!batch.length) return;

        const now = Date.now();
        const delayMs = Math.max(0, 12000 - (now - this._liveExportLastMs));
        this._liveExportQueue.push({ hashes: batch, exportTextures: !!exportTextures });
        window.setTimeout(() => this._drainLiveExportQueue(), delayMs);
    }

    async _drainLiveExportQueue() {
        if (this._liveExportInFlight || this._liveExportDisabled) return;
        const next = this._liveExportQueue.shift();
        if (!next) return;
        this._liveExportInFlight = true;
        this._liveExportLastMs = Date.now();
        try {
            const resp = await fetch('/__live_export/archetypes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    hashes: next.hashes,
                    top: next.hashes.length,
                    exportTextures: !!next.exportTextures,
                }),
            });
            if (resp.status === 404 || resp.status === 405) {
                this._liveExportDisabled = true;
                return;
            }
            const data = await resp.json().catch(() => null);
            if (!resp.ok || !data?.ok) {
                console.warn('ModelManager: live export failed', data || resp.status);
                return;
            }
            await this.refreshMetaForHashes(next.hashes);
            await this.refreshNonRenderableIndex();
            try {
                this.onManifestUpdated?.({ type: 'liveExport', hashes: next.hashes, durationMs: data.durationMs });
            } catch {
                // ignore
            }
        } catch (e) {
            console.warn('ModelManager: live export request failed', e);
        } finally {
            this._liveExportInFlight = false;
            if (this._liveExportQueue.length) {
                window.setTimeout(() => this._drainLiveExportQueue(), 12000);
            }
        }
    }

    hasMesh(hash) {
        const h0 = this.normalizeId(hash);
        if (!h0) return false;
        return this.hasRealMesh(h0) || !!this.enablePlaceholderMeshes;
    }

    hasRealMesh(hash) {
        const h0 = this.normalizeId(hash);
        if (!h0) return false;
        return !!(this.manifest && this.manifest.meshes && this.manifest.meshes[h0] && this.manifest.meshes[h0].lods);
    }

    isNonRenderable(hash) {
        const h0 = this.normalizeId(hash);
        return !!h0 && this._nonRenderableHashes.has(h0);
    }

    getNonRenderableHashes() {
        return Array.from(this._nonRenderableHashes);
    }

    getApproxRadiusForHash(hash, lod = null, fallback = null) {
        const fallbackNumber = Number(fallback);
        const fallbackRadius = Number.isFinite(fallbackNumber) && fallbackNumber > 0 ? fallbackNumber : null;
        const h = this.normalizeId(hash);
        if (!h || !this.manifest || !this.manifest.meshes || !this.manifest.meshes[h]) return fallbackRadius;

        const entry = this.manifest.meshes[h];
        const finiteRadius = (v) => {
            const n = Number(v);
            return Number.isFinite(n) && n > 0 ? n : null;
        };
        const scanLod = (lodMeta) => {
            if (!lodMeta || typeof lodMeta !== 'object') return null;
            let best = finiteRadius(lodMeta.radius);
            const subs = Array.isArray(lodMeta.submeshes)
                ? lodMeta.submeshes
                : (Array.isArray(lodMeta.meshes) ? lodMeta.meshes : []);
            for (const sm of subs) {
                const r = finiteRadius(sm?.radius);
                if (r !== null && (best === null || r > best)) best = r;
            }
            return best;
        };

        if (lod) {
            const r = scanLod(this._getLodMetaEntry(h, lod));
            if (r !== null) return r;
        }

        const entryRadius = finiteRadius(entry.radius);
        if (entryRadius !== null) return entryRadius;

        let best = null;
        const lods = entry.lods || {};
        for (const lodMeta of Object.values(lods)) {
            const r = scanLod(lodMeta);
            if (r !== null && (best === null || r > best)) best = r;
        }
        return best !== null ? best : fallbackRadius;
    }

    getApproxRadiusEntries({ lod = null, limit = 5000, fallback = null } = {}) {
        const meshes = this.manifest?.meshes;
        if (!meshes || typeof meshes !== 'object') return [];
        const lim = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : 5000;
        const out = [];
        for (const hash of Object.keys(meshes)) {
            const radius = this.getApproxRadiusForHash(hash, lod, fallback);
            if (Number.isFinite(radius) && radius > 0) out.push([String(hash), radius]);
            if (lim > 0 && out.length >= lim) break;
        }
        return out;
    }

    /**
     * Return the chosen LOD metadata node for an archetype (supports both v3 and v4 manifests).
     * @returns {any|null}
     */
    _getLodMetaEntry(h, lod) {
        const l = String(lod || 'high').toLowerCase();
        if (!this.manifest || !this.manifest.meshes || !this.manifest.meshes[h]) return null;
        const metaEntry = this.manifest.meshes[h];
        const lods = metaEntry.lods || {};
        const orders = {
            high: ['high', 'med', 'low', 'vlow'],
            med: ['med', 'low', 'vlow', 'high'],
            low: ['low', 'vlow', 'med', 'high'],
            vlow: ['vlow', 'low', 'med', 'high'],
        };
        const order = orders[l] || orders.high;
        for (const key of order) {
            if (lods[key]) return lods[key];
        }
        return null;
    }

    /**
     * Get per-LOD submesh list for an archetype.
     * - v4: lodMeta = { submeshes: [ {file, material, ...}, ... ] }
     * - v3: lodMeta = { file, ... } and material is at metaEntry.material
     *
     * @returns {Array<{file: string, material: any, skinned?: boolean, boneIds?: number[], hasBlendWeights?: boolean, hasBlendIndices?: boolean, fragmentBoneTag?: number|null}>}
     */
    getLodSubmeshes(hash, lod = 'high') {
        const h = this.normalizeId(hash);
        if (!h) return [];
        if (!this.manifest || !this.manifest.meshes || !this.manifest.meshes[h]) return [];
        const metaEntry = this.manifest.meshes[h];
        // Normalize materials lazily (only for entries we actually touch at runtime).
        // This keeps startup fast even with huge manifests.
        this._normalizeManifestMeshEntryInPlace(metaEntry);
        const lodMeta = this._getLodMetaEntry(h, lod);
        if (!lodMeta) return [];
        const entryMat = metaEntry?.material ?? null;
        const pedComponent = (metaEntry?.pedComponent && typeof metaEntry.pedComponent === 'object')
            ? metaEntry.pedComponent
            : null;

        // v4 path
        if (lodMeta && typeof lodMeta === 'object' && Array.isArray(lodMeta.submeshes)) {
            return lodMeta.submeshes
                .filter((sm) => {
                    const material = this._effectiveMaterialForSubmesh(entryMat, sm?.material ?? null);
                    const shaderName = String(material?.shaderName || '').toLowerCase();
                    if (!shaderName.includes('ped_hair_spiked')) return true;
                    const order = material?.shaderParams?.vectorsByHash?.['1617153586'];
                    return !(Array.isArray(order) && Number(order[0]) > 0);
                })
                .map((sm) => {
                    const file = String(sm?.file || '');
                    if (!file) return null;
                    // Always return an *effective* material so downstream paths (bucketing, renderer)
                    // can reliably see diffuse/normal/spec even if some fields are only present at the entry level.
                    const eff = this._effectiveMaterialForSubmesh(entryMat, sm?.material ?? null);
                    return {
                        file,
                        material: eff,
                        pedComponent,
                        skinned: !!sm?.skinned,
                        boneIds: Array.isArray(sm?.boneIds) ? sm.boneIds.slice(0) : [],
                        hasBlendWeights: !!sm?.hasBlendWeights,
                        hasBlendIndices: !!sm?.hasBlendIndices,
                        fragmentBoneTag: Number.isFinite(Number(sm?.fragmentBoneTag)) ? Number(sm.fragmentBoneTag) : null,
                        // Fragment metadata is consumed by the vehicle renderer. Keep it
                        // alongside the render-facing copy instead of dropping it here.
                        fragmentPivot: Array.isArray(sm?.fragmentPivot) ? sm.fragmentPivot.slice(0, 3).map(Number) : null,
                        bounds: sm?.bounds && typeof sm.bounds === 'object' ? sm.bounds : null,
                        radius: Number.isFinite(Number(sm?.radius)) ? Number(sm.radius) : 0,
                        trackSource: typeof sm?.trackSource === 'string' ? sm.trackSource : null,
                        trackGroup: sm?.trackGroup !== null && sm?.trackGroup !== undefined && Number.isFinite(Number(sm.trackGroup))
                            ? Number(sm.trackGroup)
                            : null,
                        loadPriority: Number.isFinite(Number(sm?.loadPriority)) ? Number(sm.loadPriority) : 0,
                    };
                })
                .filter(Boolean);
        }

        // v3 path (single mesh)
        const file = String(lodMeta?.file || '');
        if (!file) return [];
        return [{
            file,
            material: entryMat,
            skinned: false,
            boneIds: [],
            hasBlendWeights: false,
            hasBlendIndices: false,
            fragmentPivot: Array.isArray(lodMeta?.fragmentPivot) ? lodMeta.fragmentPivot.slice(0, 3).map(Number) : null,
            bounds: lodMeta?.bounds && typeof lodMeta.bounds === 'object' ? lodMeta.bounds : null,
            radius: Number.isFinite(Number(lodMeta?.radius)) ? Number(lodMeta.radius) : 0,
            trackSource: typeof lodMeta?.trackSource === 'string' ? lodMeta.trackSource : null,
            trackGroup: lodMeta?.trackGroup !== null && lodMeta?.trackGroup !== undefined && Number.isFinite(Number(lodMeta.trackGroup))
                ? Number(lodMeta.trackGroup)
                : null,
            loadPriority: Number.isFinite(Number(lodMeta?.loadPriority)) ? Number(lodMeta.loadPriority) : 0,
        }];
    }

    async loadMeshFile(file, {
        usePersistentCache = true,
        cacheBust = '',
        requireBlendAttributes = false,
    } = {}) {
        const f = String(file || '').trim();
        if (!f) return null;
        const key = f;
        if (this.meshCache.has(key)) {
            const m = this.meshCache.get(key);
            const hasRequiredBlendAttributes = !requireBlendAttributes || (
                !!m?.blendWeightsBuffer && !!m?.blendIndicesBuffer
            );
            if (m && !m._disposed && hasRequiredBlendAttributes) {
                this.touchMesh(key);
                return m;
            }
            // Drop stale pre-skinning cache entries before a ped requests the current v8 mesh.
            this.meshCache.delete(key);
            const bytes = this._meshCacheApproxBytes.get(key) ?? (m?.approxBytes ?? 0);
            this._meshCacheApproxBytes.delete(key);
            if (Number.isFinite(bytes)) this._meshCacheBytes = Math.max(0, this._meshCacheBytes - Math.max(0, bytes));
            this._disposeMesh(m);
        }

        const packedRef = this._parseDemoMeshPackRef(f);
        const basePath = packedRef ? `assets/demo/${packedRef.packFile}` : `assets/models/${f}`;
        const freshToken = String(cacheBust || '').trim();
        const path = freshToken
            ? `${basePath}${basePath.includes('?') ? '&' : '?'}live=${encodeURIComponent(freshToken)}`
            : basePath;
        let buf;
        try {
            buf = packedRef
                ? await this._loadDemoMeshPackSlice(packedRef, { usePersistentCache })
                : await fetchArrayBufferPreferredCompressed(path, { usePersistentCache: !!usePersistentCache });
        } catch (e) {
            console.warn(`ModelManager: failed to fetch/read mesh bin ${path}`, e);
            return null;
        }
        const compressedByName = /\.(?:gz|gzip)$/i.test(f);
        const hasGzipHeader = buf.byteLength >= 2
            && new Uint8Array(buf, 0, 2)[0] === 0x1f
            && new Uint8Array(buf, 0, 2)[1] === 0x8b;
        // Vite serves .gz files with Content-Encoding, so fetch() has already
        // decompressed those responses. Static production hosting serves the
        // raw file, where the signature remains and needs decompression here.
        if (compressedByName && hasGzipHeader) {
            if (typeof DecompressionStream !== 'function') throw new Error('This browser does not support compressed mesh assets');
            const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
            buf = await new Response(stream).arrayBuffer();
        }
        const mesh = packedRef
            ? await this._enqueuePackedMeshUpload(key, buf)
            : this._parseAndUploadMesh(key, buf);
        if (mesh && requireBlendAttributes && (!mesh.blendWeightsBuffer || !mesh.blendIndicesBuffer)) {
            console.warn(`ModelManager: ${f} was requested as skinned but has no blend attributes`);
            this._disposeMesh(mesh);
            return null;
        }
        if (mesh) {
            this.meshCache.set(key, mesh);
            const bytes = Number(mesh.approxBytes ?? 0);
            const b = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
            this._meshCacheApproxBytes.set(key, b);
            this._meshCacheBytes += b;
            this.touchMesh(key);
            this._evictMeshCacheIfNeeded();
        }
        return mesh;
    }

    async loadMesh(hash, lod = 'high') {
        const h = this.normalizeId(hash);
        if (!h) return null;
        if (!this.manifest || !this.manifest.meshes || !this.manifest.meshes[h]) {
            return this.enablePlaceholderMeshes ? this._placeholderMesh : null;
        }
        const subs = this.getLodSubmeshes(h, lod);
        const first = subs && subs.length ? subs[0] : null;
        if (!first || !first.file) return this.enablePlaceholderMeshes ? this._placeholderMesh : null;
        return await this.loadMeshFile(first.file);
    }

    _createPlaceholderMesh() {
        const gl = this.gl;
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);

        // Unit cube centered at origin, with per-face normals (24 verts).
        const positions = new Float32Array([
            // +X
            0.5, -0.5, -0.5,  0.5,  0.5, -0.5,  0.5,  0.5,  0.5,  0.5, -0.5,  0.5,
            // -X
           -0.5, -0.5,  0.5, -0.5,  0.5,  0.5, -0.5,  0.5, -0.5, -0.5, -0.5, -0.5,
            // +Y
           -0.5,  0.5, -0.5, -0.5,  0.5,  0.5,  0.5,  0.5,  0.5,  0.5,  0.5, -0.5,
            // -Y
           -0.5, -0.5,  0.5, -0.5, -0.5, -0.5,  0.5, -0.5, -0.5,  0.5, -0.5,  0.5,
            // +Z
           -0.5, -0.5,  0.5,  0.5, -0.5,  0.5,  0.5,  0.5,  0.5, -0.5,  0.5,  0.5,
            // -Z
            0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5,  0.5, -0.5,  0.5,  0.5, -0.5,
        ]);
        const normals = new Float32Array([
            // +X
            1,0,0,  1,0,0,  1,0,0,  1,0,0,
            // -X
           -1,0,0, -1,0,0, -1,0,0, -1,0,0,
            // +Y
            0,1,0,  0,1,0,  0,1,0,  0,1,0,
            // -Y
            0,-1,0, 0,-1,0, 0,-1,0, 0,-1,0,
            // +Z
            0,0,1,  0,0,1,  0,0,1,  0,0,1,
            // -Z
            0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1,
        ]);
        const indices = new Uint32Array([
            0, 1, 2, 0, 2, 3,
            4, 5, 6, 4, 6, 7,
            8, 9,10, 8,10,11,
           12,13,14,12,14,15,
           16,17,18,16,18,19,
           20,21,22,20,22,23,
        ]);

        const posBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

        const nrmBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

        let uploadIndices = indices;
        let indexType = gl.UNSIGNED_INT;
        if (indices.length > 0) {
            let maxIndex = 0;
            for (let i = 0; i < indices.length; i++) maxIndex = Math.max(maxIndex, indices[i]);
            if (maxIndex <= 0xffff) {
                uploadIndices = new Uint16Array(indices);
                indexType = gl.UNSIGNED_SHORT;
            }
        }

        const idxBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, uploadIndices, gl.STATIC_DRAW);

        const lineIndices = createWireframeIndices(
            uploadIndices,
            indexType === gl.UNSIGNED_SHORT ? Uint16Array : Uint32Array,
        );
        const lineIdxBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, lineIdxBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, lineIndices, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuffer);

        // aColor0: location 8 (default to white when absent)
        try {
            gl.disableVertexAttribArray(8);
            gl.vertexAttrib4f(8, 1.0, 1.0, 1.0, 1.0);
        } catch { /* ignore */ }

        gl.bindVertexArray(null);

        return {
            key: '__placeholder__',
            vao,
            posBuffer,
            nrmBuffer,
            uvBuffer: null,
            uv1Buffer: null,
            uv2Buffer: null,
            tanBuffer: null,
            col0Buffer: null,
            col1Buffer: null,
            blendWeightsBuffer: null,
            blendIndicesBuffer: null,
            idxBuffer,
            lineIdxBuffer,
            indexCount: indices.length,
            lineIndexCount: lineIndices.length,
            indexType,
            lineIndexType: indexType,
            // Conservative local-space bounds (unit cube) + bounding sphere radius.
            bounds: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5], center: [0, 0, 0] },
            radius: Math.sqrt(0.5 * 0.5 + 0.5 * 0.5 + 0.5 * 0.5),
        };
    }

    _parseAndUploadMesh(key, arrayBuffer) {
        const gl = this.gl;
        const dv = new DataView(arrayBuffer);

        // Header: <4sIIII> = magic, version, vertexCount, indexCount, flags
        const magic =
            String.fromCharCode(dv.getUint8(0)) +
            String.fromCharCode(dv.getUint8(1)) +
            String.fromCharCode(dv.getUint8(2)) +
            String.fromCharCode(dv.getUint8(3));
        const version = dv.getUint32(4, true);
        const vertexCount = dv.getUint32(8, true);
        const indexCount = dv.getUint32(12, true);
        const flags = dv.getUint32(16, true);

        if (magic !== 'MSH0' || (version < 1 || version > 10)) {
            console.warn(`ModelManager: bad mesh header for ${key} (magic=${magic}, version=${version})`);
            return null;
        }

        const affinePositions = version === 10;
        const headerBytes = affinePositions ? 44 : 20;
        if (arrayBuffer.byteLength < headerBytes) {
            console.warn(`ModelManager: truncated mesh header for ${key}`);
            return null;
        }
        const packed = version >= 9;
        const positionMin = affinePositions
            ? [dv.getFloat32(20, true), dv.getFloat32(24, true), dv.getFloat32(28, true)]
            : null;
        const positionExtent = affinePositions
            ? [dv.getFloat32(32, true), dv.getFloat32(36, true), dv.getFloat32(40, true)]
            : null;
        const posBytes = vertexCount * 3 * (packed ? 2 : 4);
        const hasNormals = version >= 2 && (flags & 1) === 1;
        const hasInt8Normals = packed && (flags & 1024) === 1024;
        const hasTightInt8Normals = hasInt8Normals && (flags & 2048) === 2048;
        const nrmBytes = hasNormals ? vertexCount * (hasTightInt8Normals ? 3 : (hasInt8Normals ? 4 : (packed ? 6 : 12))) : 0;
        const hasUvs = version >= 3 && (flags & 2) === 2;
        const uvBytes = hasUvs ? vertexCount * 2 * (packed ? 2 : 4) : 0;
        const hasUv1 = version >= 6 && (flags & 16) === 16;
        const uv1Bytes = hasUv1 ? vertexCount * 2 * (packed ? 2 : 4) : 0;
        const hasUv2 = version >= 7 && (flags & 32) === 32;
        const uv2Bytes = hasUv2 ? vertexCount * 2 * (packed ? 2 : 4) : 0;
        const hasTangents = version >= 4 && (flags & 4) === 4;
        const tanBytes = hasTangents ? vertexCount * 4 * (packed ? 1 : 4) : 0;
        const hasColor0 = version >= 5 && (flags & 8) === 8;
        const col0Bytes = hasColor0 ? vertexCount * 4 : 0;
        const hasColor1 = version >= 7 && (flags & 64) === 64;
        const col1Bytes = hasColor1 ? vertexCount * 4 : 0;
        const hasBlendWeights = version >= 8 && (flags & 128) === 128;
        const blendWeightsBytes = hasBlendWeights ? vertexCount * 4 : 0;
        const hasBlendIndices = version >= 8 && (flags & 256) === 256;
        const blendIndicesBytes = hasBlendIndices ? vertexCount * 4 : 0;
        const hasUint16Indices = packed && (flags & 512) === 512;
        const hasDeltaIndices = hasUint16Indices && (flags & 4096) === 4096;
        const fixedIdxBytes = indexCount * (hasUint16Indices ? 2 : 4);
        const normalOffset = headerBytes + posBytes;
        const uvOffset = hasTightInt8Normals ? ((normalOffset + nrmBytes + 1) & ~1) : normalOffset + nrmBytes;
        const uv1Offset = uvOffset + uvBytes;
        const uv2Offset = uv1Offset + uv1Bytes;
        const tangentOffset = uv2Offset + uv2Bytes;
        const color0Offset = tangentOffset + tanBytes;
        const color1Offset = color0Offset + col0Bytes;
        const blendWeightsOffset = color1Offset + col1Bytes;
        const blendIndicesOffset = blendWeightsOffset + blendWeightsBytes;
        const vertexPayloadEnd = blendIndicesOffset + blendIndicesBytes;
        const indexOffset = packed ? ((vertexPayloadEnd + 3) & ~3) : vertexPayloadEnd;
        const idxBytes = hasDeltaIndices ? arrayBuffer.byteLength - indexOffset : fixedIdxBytes;
        if (indexOffset + idxBytes > arrayBuffer.byteLength) {
            console.warn(`ModelManager: truncated mesh ${key}`);
            return null;
        }

        if (headerBytes + posBytes > arrayBuffer.byteLength) {
            console.warn(`ModelManager: truncated position stream for ${key}`);
            return null;
        }

        const diskPositions = packed ? new Uint16Array(arrayBuffer, headerBytes, vertexCount * 3) : null;
        // MSH10 stores each local position as unorm16 inside the affine bounds
        // from its header. Keep that compact stream on the GPU and decode in the
        // vertex shader instead of expanding it into a Float32Array per mesh.
        const positions = packed ? diskPositions : new Float32Array(arrayBuffer, headerBytes, vertexCount * 3);
        const normals = hasNormals ? (hasInt8Normals
            ? new Int8Array(arrayBuffer, normalOffset, vertexCount * (hasTightInt8Normals ? 3 : 4))
            : (packed ? new Int16Array(arrayBuffer, normalOffset, vertexCount * 3) : new Float32Array(arrayBuffer, normalOffset, vertexCount * 3))) : null;
        const uvs = hasUvs ? (packed ? new Uint16Array(arrayBuffer, uvOffset, vertexCount * 2) : new Float32Array(arrayBuffer, uvOffset, vertexCount * 2)) : null;
        const uv1 = hasUv1 ? (packed ? new Uint16Array(arrayBuffer, uv1Offset, vertexCount * 2) : new Float32Array(arrayBuffer, uv1Offset, vertexCount * 2)) : null;
        const uv2 = hasUv2 ? (packed ? new Uint16Array(arrayBuffer, uv2Offset, vertexCount * 2) : new Float32Array(arrayBuffer, uv2Offset, vertexCount * 2)) : null;
        const tangents = hasTangents ? (packed ? new Int8Array(arrayBuffer, tangentOffset, vertexCount * 4) : new Float32Array(arrayBuffer, tangentOffset, vertexCount * 4)) : null;
        const color0 = hasColor0 ? new Uint8Array(arrayBuffer, color0Offset, vertexCount * 4) : null;
        const color1 = hasColor1 ? new Uint8Array(arrayBuffer, color1Offset, vertexCount * 4) : null;
        const blendWeights = hasBlendWeights ? new Uint8Array(arrayBuffer, blendWeightsOffset, vertexCount * 4) : null;
        const blendIndices = hasBlendIndices ? new Uint8Array(arrayBuffer, blendIndicesOffset, vertexCount * 4) : null;
        let indices;
        if (hasDeltaIndices) {
            indices = new Uint32Array(indexCount);
            const encoded = new Uint8Array(arrayBuffer, indexOffset, idxBytes);
            let cursor = 0;
            let previous = 0;
            for (let i = 0; i < indexCount; i += 1) {
                let value = 0;
                let shift = 0;
                let byte = 0;
                do {
                    if (cursor >= encoded.length || shift > 28) throw new Error(`ModelManager: invalid delta indices in ${key}`);
                    byte = encoded[cursor++];
                    value |= (byte & 0x7f) << shift;
                    shift += 7;
                } while (byte & 0x80);
                const delta = (value >>> 1) ^ -(value & 1);
                previous = (previous + delta) >>> 0;
                indices[i] = previous;
            }
        } else {
            const diskIndices = hasUint16Indices
                ? new Uint16Array(arrayBuffer, indexOffset, indexCount)
                : new Uint32Array(arrayBuffer, indexOffset, indexCount);
            indices = hasUint16Indices ? new Uint32Array(diskIndices) : diskIndices;
        }

        // Do this before any GPU allocation. WebGL only reports a bad index at
        // draw time, where the error otherwise looks like an unrelated renderer
        // failure and can leave subsequent passes with stale state.
        for (let i = 0; i < indices.length; i += 1) {
            if (indices[i] >= vertexCount) {
                console.warn(`ModelManager: mesh ${key} has index ${indices[i]} outside ${vertexCount} vertices`);
                return null;
            }
        }

        const halfToFloat = (value) => {
            const sign = (value & 0x8000) ? -1 : 1;
            const exponent = (value >>> 10) & 0x1f;
            const fraction = value & 0x03ff;
            if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024);
            if (exponent === 0x1f) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
            return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
        };

        // Conservative local-space bounds + sphere radius (used by occlusion/culling).
        const bmin = affinePositions
            ? [positionMin[0], positionMin[1], positionMin[2]]
            : [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
        const bmax = affinePositions
            ? [
                positionMin[0] + positionExtent[0],
                positionMin[1] + positionExtent[1],
                positionMin[2] + positionExtent[2],
            ]
            : [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
        if (!affinePositions) {
            for (let i = 0; i < positions.length; i += 3) {
                const x = packed ? halfToFloat(positions[i + 0]) : positions[i + 0];
                const y = packed ? halfToFloat(positions[i + 1]) : positions[i + 1];
                const z = packed ? halfToFloat(positions[i + 2]) : positions[i + 2];
                if (x < bmin[0]) bmin[0] = x;
                if (y < bmin[1]) bmin[1] = y;
                if (z < bmin[2]) bmin[2] = z;
                if (x > bmax[0]) bmax[0] = x;
                if (y > bmax[1]) bmax[1] = y;
                if (z > bmax[2]) bmax[2] = z;
            }
        }
        if (!Number.isFinite(bmin[0])) {
            bmin[0] = bmin[1] = bmin[2] = 0;
            bmax[0] = bmax[1] = bmax[2] = 0;
        }
        const cx = (bmin[0] + bmax[0]) * 0.5;
        const cy = (bmin[1] + bmax[1]) * 0.5;
        const cz = (bmin[2] + bmax[2]) * 0.5;
        const dx = (bmax[0] - bmin[0]) * 0.5;
        const dy = (bmax[1] - bmin[1]) * 0.5;
        const dz = (bmax[2] - bmin[2]) * 0.5;
        const radius = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const bounds = { min: bmin, max: bmax, center: [cx, cy, cz] };

        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);

        const posBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

        // aPosition: location 0.
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, affinePositions ? gl.UNSIGNED_SHORT : (packed ? gl.HALF_FLOAT : gl.FLOAT), affinePositions, 0, 0);

        let nrmBuffer = null;
        if (normals) {
            nrmBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);
            // aNormal: location 1
            gl.enableVertexAttribArray(1);
            gl.vertexAttribPointer(1, 3, hasInt8Normals ? gl.BYTE : (packed ? gl.SHORT : gl.FLOAT), packed, hasInt8Normals ? (hasTightInt8Normals ? 3 : 4) : 0, 0);
        }

        let uvBuffer = null;
        if (uvs) {
            uvBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
            // aTexcoord0: location 2
            gl.enableVertexAttribArray(2);
            gl.vertexAttribPointer(2, 2, packed ? gl.HALF_FLOAT : gl.FLOAT, false, 0, 0);
        }

        let uv1Buffer = null;
        if (uv1) {
            uv1Buffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, uv1Buffer);
            gl.bufferData(gl.ARRAY_BUFFER, uv1, gl.STATIC_DRAW);
            // aTexcoord1: location 9
            gl.enableVertexAttribArray(9);
            gl.vertexAttribPointer(9, 2, packed ? gl.HALF_FLOAT : gl.FLOAT, false, 0, 0);
        } else if (uvBuffer) {
            // Fallback: bind UV0 to UV1 so shaders that expect UV1 degrade gracefully.
            gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
            gl.enableVertexAttribArray(9);
            gl.vertexAttribPointer(9, 2, packed ? gl.HALF_FLOAT : gl.FLOAT, false, 0, 0);
        } else {
            try {
                gl.disableVertexAttribArray(9);
                gl.vertexAttrib2f(9, 0.0, 0.0);
            } catch { /* ignore */ }
        }

        let tanBuffer = null;
        if (tangents) {
            tanBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, tanBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, tangents, gl.STATIC_DRAW);
            // aTangent: location 3
            gl.enableVertexAttribArray(3);
            gl.vertexAttribPointer(3, 4, packed ? gl.BYTE : gl.FLOAT, packed, 0, 0);
        }

        let col0Buffer = null;
        if (color0) {
            col0Buffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, col0Buffer);
            gl.bufferData(gl.ARRAY_BUFFER, color0, gl.STATIC_DRAW);
            // aColor0: location 8 (normalized u8 RGBA)
            gl.enableVertexAttribArray(8);
            gl.vertexAttribPointer(8, 4, gl.UNSIGNED_BYTE, true, 0, 0);
        } else {
            // Default to white so shaders can always safely multiply by aColor0.
            try {
                gl.disableVertexAttribArray(8);
                gl.vertexAttrib4f(8, 1.0, 1.0, 1.0, 1.0);
            } catch { /* ignore */ }
        }

        let uv2Buffer = null;
        if (uv2) {
            uv2Buffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, uv2Buffer);
            gl.bufferData(gl.ARRAY_BUFFER, uv2, gl.STATIC_DRAW);
            // aTexcoord2: location 10
            gl.enableVertexAttribArray(10);
            gl.vertexAttribPointer(10, 2, packed ? gl.HALF_FLOAT : gl.FLOAT, false, 0, 0);
        } else if (uvBuffer) {
            gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
            gl.enableVertexAttribArray(10);
            gl.vertexAttribPointer(10, 2, packed ? gl.HALF_FLOAT : gl.FLOAT, false, 0, 0);
        } else {
            try {
                gl.disableVertexAttribArray(10);
                gl.vertexAttrib2f(10, 0.0, 0.0);
            } catch { /* ignore */ }
        }

        let col1Buffer = null;
        if (color1) {
            col1Buffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, col1Buffer);
            gl.bufferData(gl.ARRAY_BUFFER, color1, gl.STATIC_DRAW);
            // aColor1: location 11 (normalized u8 RGBA)
            gl.enableVertexAttribArray(11);
            gl.vertexAttribPointer(11, 4, gl.UNSIGNED_BYTE, true, 0, 0);
        } else {
            try {
                gl.disableVertexAttribArray(11);
                gl.vertexAttrib4f(11, 1.0, 1.0, 1.0, 1.0);
            } catch { /* ignore */ }
        }

        let blendWeightsBuffer = null;
        if (blendWeights) {
            blendWeightsBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, blendWeightsBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, blendWeights, gl.STATIC_DRAW);
            // aBlendWeights: location 13 (normalized u8 -> 0..1)
            gl.enableVertexAttribArray(13);
            gl.vertexAttribPointer(13, 4, gl.UNSIGNED_BYTE, true, 0, 0);
        } else {
            try {
                gl.disableVertexAttribArray(13);
                gl.vertexAttrib4f(13, 1.0, 0.0, 0.0, 0.0);
            } catch { /* ignore */ }
        }

        let blendIndicesBuffer = null;
        if (blendIndices) {
            blendIndicesBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, blendIndicesBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, blendIndices, gl.STATIC_DRAW);
            // aBlendIndices: location 14 (raw u8 palette indices)
            gl.enableVertexAttribArray(14);
            gl.vertexAttribPointer(14, 4, gl.UNSIGNED_BYTE, false, 0, 0);
        } else {
            try {
                gl.disableVertexAttribArray(14);
                gl.vertexAttrib4f(14, 0.0, 0.0, 0.0, 0.0);
            } catch { /* ignore */ }
        }

        let uploadIndices = indices;
        let indexType = gl.UNSIGNED_INT;
        if (indices.length > 0) {
            let maxIndex = 0;
            for (let i = 0; i < indices.length; i++) maxIndex = Math.max(maxIndex, indices[i]);
            if (maxIndex <= 0xffff) {
                uploadIndices = new Uint16Array(indices);
                indexType = gl.UNSIGNED_SHORT;
            }
        }

        const idxBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, uploadIndices, gl.STATIC_DRAW);

        const lineIndices = createWireframeIndices(
            uploadIndices,
            indexType === gl.UNSIGNED_SHORT ? Uint16Array : Uint32Array,
        );
        const lineIdxBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, lineIdxBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, lineIndices, gl.STATIC_DRAW);
        const lineIdxBytes = lineIndices.byteLength || (lineIndices.length * 4);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuffer);

        gl.bindVertexArray(null);

        // Keep a compact CPU copy only when the opt-in asset inspector is
        // active. MSH10 positions are unorm16 within the affine bounds, so
        // expanding them to floats would double the diagnostic memory cost.
        const retainPick = !!this.retainCpuPickData
            && vertexCount > 0
            && indexCount > 0
            && indexCount <= 300000;
        const pickPositions = retainPick
            ? (affinePositions ? new Uint16Array(diskPositions) : new Float32Array(positions))
            : null;
        const pickIndices = retainPick ? new Uint32Array(indices) : null;
        const pickBytes = (pickPositions?.byteLength || 0) + (pickIndices?.byteLength || 0);

        return {
            key,
            vao,
            posBuffer,
            nrmBuffer,
            uvBuffer,
            uv1Buffer,
            uv2Buffer,
            tanBuffer,
            col0Buffer,
            col1Buffer,
            blendWeightsBuffer,
            blendIndicesBuffer,
            // InstancedModelRenderer builds its own VAO so it can attach the
            // per-instance matrix. Preserve the compact source attribute
            // format: MSH9 uses f16 positions and MSH10 uses normalized u16
            // positions decoded from its affine header in the vertex shader.
            positionAttribType: affinePositions ? gl.UNSIGNED_SHORT : (packed ? gl.HALF_FLOAT : gl.FLOAT),
            positionAttribNormalized: affinePositions,
            positionQuantized: affinePositions,
            positionMin: affinePositions ? positionMin : null,
            positionExtent: affinePositions ? positionExtent : null,
            normalAttribType: hasInt8Normals ? gl.BYTE : (packed ? gl.SHORT : gl.FLOAT),
            normalAttribNormalized: !!packed,
            normalAttribStride: hasInt8Normals ? (hasTightInt8Normals ? 3 : 4) : 0,
            uvAttribType: packed ? gl.HALF_FLOAT : gl.FLOAT,
            tangentAttribType: packed ? gl.BYTE : gl.FLOAT,
            tangentAttribNormalized: !!packed,
            idxBuffer,
            lineIdxBuffer,
            vertexCount,
            indexCount,
            lineIndexCount: lineIndices.length,
            indexType,
            lineIndexType: indexType,
            pickPositions,
            pickIndices,
            pickPositionQuantized: !!(retainPick && affinePositions),
            pickPositionMin: retainPick && affinePositions ? [...positionMin] : null,
            pickPositionExtent: retainPick && affinePositions ? [...positionExtent] : null,
            approxBytes: (positions.byteLength + nrmBytes + uvBytes + uv1Bytes + uv2Bytes + tanBytes + col0Bytes + col1Bytes + blendWeightsBytes + blendIndicesBytes + uploadIndices.byteLength + lineIdxBytes + pickBytes),
            bounds,
            radius,
            _lastUsedMs: (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(),
            _disposed: false,
        };
    }
}



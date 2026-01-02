import { joaat } from './joaat.js';
import { fetchArrayBuffer, fetchJSON } from './asset_fetcher.js';

export class ModelManager {
    constructor(gl) {
        this.gl = gl;
        this.manifest = null; // { version, meshes: { [hash]: { lods: {...}, lodDistances, material } } }

        // Sharded manifest support (optional).
        this._sharded = false;
        this._manifestBaseDir = 'assets/models';
        this._manifestIndex = null; // { schema, shard_bits, shard_dir, ... }
        this._loadedShards = new Set(); // shardId (number)
        this._loadingShards = new Map(); // shardId -> Promise<boolean>
        /** @type {null | ((info: any) => void)} */
        this.onManifestUpdated = null;

        // Cache actual mesh bins by file path (since multiple submeshes/lods can reference different files).
        this.meshCache = new Map(); // key(file) -> { vao, indexCount, buffers... }

        // Mesh cache budget + LRU eviction (Task A3).
        // Note: renderer-created per-submesh VAOs reference these buffers; eviction marks meshes as disposed
        // so renderers can drop/reload those bindings safely.
        this.maxMeshCacheBytes = 256 * 1024 * 1024; // default 256MB (approx GPU buffer bytes)
        this.meshCacheDebug = false;
        this._meshCacheBytes = 0;
        this._meshCacheEvictions = 0;
        /** @type {Map<string, number>} */
        this._meshCacheApproxBytes = new Map(); // key -> approxBytes

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

    /**
     * Touch a cached mesh entry to keep it hot in the LRU.
     * Uses Map insertion order as the LRU queue by moving the entry to the end.
     */
    touchMesh(keyOrMesh) {
        const key = (typeof keyOrMesh === 'string')
            ? keyOrMesh
            : (keyOrMesh && typeof keyOrMesh === 'object' ? String(keyOrMesh.key || '') : '');
        if (!key) return false;
        const mesh = this.meshCache.get(key);
        if (!mesh) return false;
        // If the mesh has been disposed/evicted, treat as absent.
        if (mesh._disposed) return false;
        // Move to MRU position.
        this.meshCache.delete(key);
        this.meshCache.set(key, mesh);
        try { mesh._lastUsedMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); } catch { /* ignore */ }
        return true;
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
        };
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
        try { if (mesh.idxBuffer) gl.deleteBuffer(mesh.idxBuffer); } catch { /* ignore */ }
        mesh.vao = null;
        mesh.posBuffer = null;
        mesh.nrmBuffer = null;
        mesh.uvBuffer = null;
        mesh.uv1Buffer = null;
        mesh.uv2Buffer = null;
        mesh.tanBuffer = null;
        mesh.col0Buffer = null;
        mesh.col1Buffer = null;
        mesh.idxBuffer = null;
    }

    _evictMeshCacheIfNeeded() {
        const budget = Number(this.maxMeshCacheBytes);
        const maxBytes = Number.isFinite(budget) ? Math.max(0, budget) : (256 * 1024 * 1024);
        this.maxMeshCacheBytes = maxBytes;
        // Evict LRU entries until we're under budget.
        while (this._meshCacheBytes > maxBytes && this.meshCache.size > 0) {
            const oldestKey = this.meshCache.keys().next().value;
            if (!oldestKey) break;
            const mesh = this.meshCache.get(oldestKey);
            // Never evict placeholder (it isn't in meshCache today, but keep the guard).
            if (oldestKey === '__placeholder__') {
                this.meshCache.delete(oldestKey);
                this.meshCache.set(oldestKey, mesh);
                break;
            }
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
        // IMPORTANT: The export pipeline commonly writes *hash-only* filenames (e.g. "123.png")
        // into assets/models_textures/. Using hash+slug here causes lots of avoidable 404s when
        // only the hash-only variant exists.
        //
        // Manifests typically store paths relative to assets/ (without the assets/ prefix).
        // If/when we need human-readable names, we can build them into an index instead.
        return `models_textures/${h}.png`;
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

        const getVec = (hashStr) => vecByHash[String(hashStr)] ?? vecByHash[Number(hashStr)] ?? null;

        // Hardcoded hashes (from CodeWalker ShaderParams.cs)
        // bumpiness=4134611841, SpecularIntensity=2841625909, SpecularPower=2313518026,
        // AlphaScale=931055822, alphaTestValue=3310830370, emissiveMultiplier=1592520008,
        // globalAnimUV0=3617324062, globalAnimUV1=3126116752
        setIfAbsentNum('bumpiness', this._vec4First(getVec('4134611841'), null));
        setIfAbsentNum('specularIntensity', this._vec4First(getVec('2841625909'), null));
        setIfAbsentNum('specularPower', this._vec4First(getVec('2313518026'), null));
        setIfAbsentNum('alphaScale', this._vec4First(getVec('931055822'), null));
        setIfAbsentNum('alphaCutoff', this._vec4First(getVec('3310830370'), null));
        setIfAbsentNum('emissiveIntensity', this._vec4First(getVec('1592520008'), null));
        setIfAbsentArr3('globalAnimUV0', this._vec3FromVec4(getVec('3617324062'), null));
        setIfAbsentArr3('globalAnimUV1', this._vec3FromVec4(getVec('3126116752'), null));

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
            else if (nm === 'alphaTestValue') setIfAbsentNum('alphaCutoff', this._vec4First(v, null));
            else if (nm === 'emissiveMultiplier') setIfAbsentNum('emissiveIntensity', this._vec4First(v, null));
            else if (nm === 'globalAnimUV0') setIfAbsentArr3('globalAnimUV0', this._vec3FromVec4(v, null));
            else if (nm === 'globalAnimUV1') setIfAbsentArr3('globalAnimUV1', this._vec3FromVec4(v, null));
        }
    }

    _normalizeMaterialFromShaderParamsInPlace(mat) {
        // Some exporters only populate `shaderParams.texturesByHash` (CodeWalker-style),
        // and omit viewer-friendly keys like `diffuse` / `normal` / `spec`.
        // We patch-in best-effort defaults so textures are at least requested.
        if (!mat || typeof mat !== 'object') return;
        const sp = mat.shaderParams;
        const texByHash = (sp && typeof sp === 'object') ? sp.texturesByHash : null;
        if (!texByHash || typeof texByHash !== 'object') return;

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
            { key: 'diffuse', hashes: ['4059966321', '3576369631', '2946270081'] },
            { key: 'diffuse2', hashes: ['181641832'] },
            { key: 'normal', hashes: ['1186448975', '1073714531', '1422769919', '2745359528', '2975430677'] },
            { key: 'spec', hashes: ['1619499462'] },
            { key: 'detail', hashes: ['3393362404'] },
            { key: 'ao', hashes: ['1212577329'] },
            { key: 'alphaMask', hashes: ['1705051233'] },
        ];

        const getHashVal = (hashStr) => {
            const h = String(hashStr || '');
            return texByHash[h] ?? texByHash[Number(h)] ?? null;
        };

        for (const s of SLOTS) {
            if (typeof mat[s.key] === 'string' && mat[s.key]) continue; // already present
            for (const hash of (s.hashes || [])) {
                const v = getHashVal(hash);
                if (typeof v !== 'string' || !v) continue;
                const rel = this._textureRelFromShaderParamValue(v);
                if (rel) {
                    mat[s.key] = rel;
                    break;
                }
            }
        }

        // Also pull common scalar/vector fields out of vectorsByHash where possible.
        try { this._applyCommonMaterialFieldsFromShaderParamsInPlace(mat); } catch { /* ignore */ }
        try { this._resolveShaderParamsForDebugInPlace(mat); } catch { /* ignore */ }
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
            alphaMask: (typeof m.alphaMask === 'string' && m.alphaMask) ? m.alphaMask : null,
            alphaMaskKtx2: (typeof m.alphaMaskKtx2 === 'string' && m.alphaMaskKtx2) ? m.alphaMaskKtx2 : null,
            // Per-texture UV selectors (viewer-side feature; prevents batching incompatible UV choices).
            // Accept either "*UvSet" numeric fields or "*Uv" string fields ("uv0"/"uv1"/"uv2").
            normalUvSet: (m.normalUvSet ?? m.normalUv ?? null),
            specUvSet: (m.specUvSet ?? m.specUv ?? null),
            detailUvSet: (m.detailUvSet ?? m.detailUv ?? null),
            aoUvSet: (m.aoUvSet ?? m.aoUv ?? null),
            emissiveUvSet: (m.emissiveUvSet ?? m.emissiveUv ?? null),
            uv0ScaleOffset: this._normalizeUv0ScaleOffset(m.uv0ScaleOffset),
            globalAnimUV0: (Array.isArray(m.globalAnimUV0) && m.globalAnimUV0.length >= 3)
                ? [this._roundNum(m.globalAnimUV0[0]), this._roundNum(m.globalAnimUV0[1]), this._roundNum(m.globalAnimUV0[2])]
                : null,
            globalAnimUV1: (Array.isArray(m.globalAnimUV1) && m.globalAnimUV1.length >= 3)
                ? [this._roundNum(m.globalAnimUV1[0]), this._roundNum(m.globalAnimUV1[1]), this._roundNum(m.globalAnimUV1[2])]
                : null,
            bumpiness: this._roundNum(m.bumpiness),
            specularIntensity: this._roundNum(m.specularIntensity),
            specularPower: this._roundNum(m.specularPower),
            emissiveIntensity: this._roundNum(m.emissiveIntensity),
            aoStrength: this._roundNum(m.aoStrength),
            alphaMode: (typeof m.alphaMode === 'string' && m.alphaMode) ? m.alphaMode : null,
            alphaCutoff: this._roundNum(m.alphaCutoff),
            alphaScale: this._roundNum(m.alphaScale),
            hardAlphaBlend: this._roundNum(m.hardAlphaBlend),
            doubleSided: !!m.doubleSided,
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
        };
        return JSON.stringify(sigObj);
    }

    _effectiveMaterialForSubmesh(entryMaterial, submeshMaterial) {
        const base = (entryMaterial && typeof entryMaterial === 'object') ? entryMaterial : null;
        const sm = (submeshMaterial && typeof submeshMaterial === 'object') ? submeshMaterial : null;
        if (!base && !sm) return {};
        if (!base) return { ...sm };
        if (!sm) return { ...base };
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
        const s = String(id ?? '').trim();
        if (!s) return null;
        if (/^\d+$/.test(s)) {
            const n = Number.parseInt(s, 10);
            if (!Number.isFinite(n)) return null;
            return String((n >>> 0));
        }
        return String(joaat(s));
    }

    async init(manifestPath = 'assets/models/manifest.json') {
        // Prefer a sharded manifest index if present (fast startup, loads only needed shards).
        // Fallback to monolithic manifest.json (optionally parsed in a Worker).
        const path = String(manifestPath || 'assets/models/manifest.json');
        const baseDir = path.replace(/\/[^\/]+$/, '') || 'assets/models';
        this._manifestBaseDir = baseDir;

        // 1) Try sharded index first: <baseDir>/manifest_index.json
        try {
            const idxPath = `${baseDir}/manifest_index.json`;
            const idx = await fetchJSON(idxPath);
            if (idx && typeof idx === 'object' && idx.schema === 'webglgta-manifest-index-v1') {
                this._sharded = true;
                this._manifestIndex = idx;
                this.manifest = { version: (idx.manifest_version ?? 1), meshes: {} };
                return true;
            }
        } catch {
            // no sharded index; fall through
        }

        // 2) Monolithic manifest path
        this._sharded = false;
        this._manifestIndex = null;
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
                        w.postMessage({ url: path });
                    });

                    this.manifest = data;
                    return true;
                } catch {
                    // Fall back to main-thread JSON if Worker path fails (older browsers / CSP / file://, etc.)
                }
            }

            this.manifest = await fetchJSON(path);
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
        const sid = this._shardIdForHash(hash);
        if (sid === null) return true;
        return this._loadedShards.has(sid);
    }

    prefetchMeta(hash) {
        // Fire-and-forget loading of metadata shard for this archetype.
        if (!this._sharded) return;
        const sid = this._shardIdForHash(hash);
        if (sid === null) return;
        this.prefetchShardById(sid, { priority: 'high' });
    }

    /**
     * Prefetch a manifest shard directly by shardId.
     * This is useful when we have a spatial index that maps world chunks -> shard IDs, and
     * we want to warm manifest metadata *before* parsing chunk contents.
     */
    prefetchShardById(shardId, { priority = 'high' } = {}) {
        if (!this._sharded) return;
        const sid0 = Number(shardId);
        if (!Number.isFinite(sid0)) return;
        const sid = (sid0 | 0) >>> 0;
        if (this._loadedShards.has(sid)) return;
        if (this._loadingShards.has(sid)) return;

        const url = this._shardFilename(sid);
        const p = (async () => {
            try {
                // Shard meta gates whether we can render real meshes for nearby archetypes.
                const data = await fetchJSON(url, { priority: (priority === 'low' ? 'low' : 'high') });
                const meshes = data?.meshes;
                if (this.manifest && this.manifest.meshes && meshes && typeof meshes === 'object') {
                    const before = Object.keys(this.manifest.meshes).length;
                    for (const [k, v] of Object.entries(meshes)) {
                        this.manifest.meshes[k] = v;
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
            } catch {
                // If shard fetch fails, don't spam retries; mark as "loaded" so we won't loop forever.
                this._loadedShards.add(sid);
                return false;
            } finally {
                this._loadingShards.delete(sid);
            }
        })();

        this._loadingShards.set(sid, p);
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

    /**
     * Return the chosen LOD metadata node for an archetype (supports both v3 and v4 manifests).
     * @returns {any|null}
     */
    _getLodMetaEntry(h, lod) {
        const l = String(lod || 'high').toLowerCase();
        if (!this.manifest || !this.manifest.meshes || !this.manifest.meshes[h]) return null;
        const metaEntry = this.manifest.meshes[h];
        const lods = metaEntry.lods || {};
        return lods[l] || lods.high || lods.med || lods.low || lods.vlow || null;
    }

    /**
     * Get per-LOD submesh list for an archetype.
     * - v4: lodMeta = { submeshes: [ {file, material, ...}, ... ] }
     * - v3: lodMeta = { file, ... } and material is at metaEntry.material
     *
     * @returns {Array<{file: string, material: any}>}
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

        // v4 path
        if (lodMeta && typeof lodMeta === 'object' && Array.isArray(lodMeta.submeshes)) {
            return lodMeta.submeshes
                .map((sm) => {
                    const file = String(sm?.file || '');
                    if (!file) return null;
                    // Always return an *effective* material so downstream paths (bucketing, renderer)
                    // can reliably see diffuse/normal/spec even if some fields are only present at the entry level.
                    const eff = this._effectiveMaterialForSubmesh(entryMat, sm?.material ?? null);
                    return { file, material: eff };
                })
                .filter(Boolean);
        }

        // v3 path (single mesh)
        const file = String(lodMeta?.file || '');
        if (!file) return [];
        return [{ file, material: entryMat }];
    }

    async loadMeshFile(file) {
        const f = String(file || '').trim();
        if (!f) return null;
        const key = f;
        if (this.meshCache.has(key)) {
            const m = this.meshCache.get(key);
            if (m && !m._disposed) {
                this.touchMesh(key);
                return m;
            }
            // If it was disposed but still referenced somewhere, drop it and reload.
            this.meshCache.delete(key);
            this._meshCacheApproxBytes.delete(key);
        }

        const path = `assets/models/${f}`;
        let buf;
        try {
            buf = await fetchArrayBuffer(path);
        } catch (e) {
            console.warn(`ModelManager: failed to fetch/read mesh bin ${path}`, e);
            return null;
        }
        const mesh = this._parseAndUploadMesh(key, buf);
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

        const idxBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

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
            idxBuffer,
            indexCount: indices.length,
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

        if (magic !== 'MSH0' || (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5 && version !== 6 && version !== 7)) {
            console.warn(`ModelManager: bad mesh header for ${key} (magic=${magic}, version=${version})`);
            return null;
        }

        const headerBytes = 20;
        const posBytes = vertexCount * 3 * 4;
        const hasNormals = version >= 2 && (flags & 1) === 1;
        const nrmBytes = hasNormals ? vertexCount * 3 * 4 : 0;
        const hasUvs = version >= 3 && (flags & 2) === 2;
        const uvBytes = hasUvs ? vertexCount * 2 * 4 : 0;
        const hasUv1 = version >= 6 && (flags & 16) === 16;
        const uv1Bytes = hasUv1 ? vertexCount * 2 * 4 : 0;
        const hasUv2 = version >= 7 && (flags & 32) === 32;
        const uv2Bytes = hasUv2 ? vertexCount * 2 * 4 : 0;
        const hasTangents = version >= 4 && (flags & 4) === 4;
        const tanBytes = hasTangents ? vertexCount * 4 * 4 : 0;
        const hasColor0 = version >= 5 && (flags & 8) === 8;
        const col0Bytes = hasColor0 ? vertexCount * 4 : 0;
        const hasColor1 = version >= 7 && (flags & 64) === 64;
        const col1Bytes = hasColor1 ? vertexCount * 4 : 0;
        const idxBytes = indexCount * 4;
        if (headerBytes + posBytes + nrmBytes + uvBytes + uv1Bytes + uv2Bytes + tanBytes + col0Bytes + col1Bytes + idxBytes > arrayBuffer.byteLength) {
            console.warn(`ModelManager: truncated mesh ${key}`);
            return null;
        }

        const positions = new Float32Array(arrayBuffer, headerBytes, vertexCount * 3);
        const normals = hasNormals ? new Float32Array(arrayBuffer, headerBytes + posBytes, vertexCount * 3) : null;
        const uvs = hasUvs ? new Float32Array(arrayBuffer, headerBytes + posBytes + nrmBytes, vertexCount * 2) : null;
        const uv1 = hasUv1 ? new Float32Array(arrayBuffer, headerBytes + posBytes + nrmBytes + uvBytes, vertexCount * 2) : null;
        const uv2 = hasUv2 ? new Float32Array(arrayBuffer, headerBytes + posBytes + nrmBytes + uvBytes + uv1Bytes, vertexCount * 2) : null;
        const tangents = hasTangents ? new Float32Array(arrayBuffer, headerBytes + posBytes + nrmBytes + uvBytes + uv1Bytes + uv2Bytes, vertexCount * 4) : null;
        const color0 = hasColor0 ? new Uint8Array(arrayBuffer, headerBytes + posBytes + nrmBytes + uvBytes + uv1Bytes + uv2Bytes + tanBytes, vertexCount * 4) : null;
        const color1 = hasColor1 ? new Uint8Array(arrayBuffer, headerBytes + posBytes + nrmBytes + uvBytes + uv1Bytes + uv2Bytes + tanBytes + col0Bytes, vertexCount * 4) : null;
        const indices = new Uint32Array(arrayBuffer, headerBytes + posBytes + nrmBytes + uvBytes + uv1Bytes + uv2Bytes + tanBytes + col0Bytes + col1Bytes, indexCount);

        // Conservative local-space bounds + sphere radius (used by occlusion/culling).
        const bmin = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
        const bmax = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i + 0];
            const y = positions[i + 1];
            const z = positions[i + 2];
            if (x < bmin[0]) bmin[0] = x;
            if (y < bmin[1]) bmin[1] = y;
            if (z < bmin[2]) bmin[2] = z;
            if (x > bmax[0]) bmax[0] = x;
            if (y > bmax[1]) bmax[1] = y;
            if (z > bmax[2]) bmax[2] = z;
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
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

        let nrmBuffer = null;
        if (normals) {
            nrmBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);
            // aNormal: location 1
            gl.enableVertexAttribArray(1);
            gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
        }

        let uvBuffer = null;
        if (uvs) {
            uvBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
            // aTexcoord0: location 2
            gl.enableVertexAttribArray(2);
            gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
        }

        let uv1Buffer = null;
        if (uv1) {
            uv1Buffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, uv1Buffer);
            gl.bufferData(gl.ARRAY_BUFFER, uv1, gl.STATIC_DRAW);
            // aTexcoord1: location 9
            gl.enableVertexAttribArray(9);
            gl.vertexAttribPointer(9, 2, gl.FLOAT, false, 0, 0);
        } else if (uvBuffer) {
            // Fallback: bind UV0 to UV1 so shaders that expect UV1 degrade gracefully.
            gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
            gl.enableVertexAttribArray(9);
            gl.vertexAttribPointer(9, 2, gl.FLOAT, false, 0, 0);
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
            gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 0, 0);
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
            gl.vertexAttribPointer(10, 2, gl.FLOAT, false, 0, 0);
        } else if (uvBuffer) {
            gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
            gl.enableVertexAttribArray(10);
            gl.vertexAttribPointer(10, 2, gl.FLOAT, false, 0, 0);
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

        const idxBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

        gl.bindVertexArray(null);

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
            idxBuffer,
            indexCount,
            approxBytes: (posBytes + nrmBytes + uvBytes + uv1Bytes + uv2Bytes + tanBytes + col0Bytes + col1Bytes + idxBytes),
            bounds,
            radius,
            _lastUsedMs: (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(),
            _disposed: false,
        };
    }
}



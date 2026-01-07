import { glMatrix } from './glmatrix.js';
import { Camera } from './camera.js';
import { TerrainRenderer } from './terrain_renderer.js';
import { EntityRenderer } from './entity_renderer.js';
import { EntityStreamer } from './entity_streamer.js';
import { PedRenderer } from './ped_renderer.js';
import { BuildingRenderer } from './building_renderer.js';
import { ModelManager } from './model_manager.js';
import { InstancedModelRenderer } from './instanced_model_renderer.js';
import { DrawableStreamer } from './drawable_streamer.js';
import { TextureStreamer } from './texture_streamer.js';
import { SkyRenderer } from './sky_renderer.js';
import { joaat } from './joaat.js';
import { clearAssetCacheStorage, clearAssetMemoryCaches, fetchJSON, setAssetFetchConcurrency, supportsAssetCacheStorage } from './asset_fetcher.js';
import { OcclusionCuller } from './occlusion.js';
import { FileBlobReader } from './vfs/readers.js';
import { RpfArchive } from './rpf/rpf_archive.js';
import { PostFxRenderer } from './postfx_renderer.js';

const _LS_SETTINGS_KEY = 'webglgta.viewer.settings.v1';
const _LS_VIEW_KEY = 'webglgta.viewer.view.v1';

class GpuTimer {
    constructor(gl) {
        this.gl = gl;
        this.ext = null;
        this.supported = false;
        this._pending = [];
        this.lastMs = null;

        try {
            this.ext = gl?.getExtension?.('EXT_disjoint_timer_query_webgl2') || null;
            this.supported = !!this.ext && !!gl?.createQuery;
        } catch {
            this.ext = null;
            this.supported = false;
        }
    }

    beginFrame() {
        if (!this.supported) return;
        try {
            const gl = this.gl;
            const ext = this.ext;
            const q = gl.createQuery();
            gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
            this._pending.push(q);
        } catch {
            // ignore
        }
    }

    endFrame() {
        if (!this.supported) return;
        try {
            const gl = this.gl;
            const ext = this.ext;
            gl.endQuery(ext.TIME_ELAPSED_EXT);
        } catch {
            // ignore
        }
    }

    poll() {
        if (!this.supported) return null;
        const gl = this.gl;
        const ext = this.ext;
        try {
            const disjoint = !!gl.getParameter(ext.GPU_DISJOINT_EXT);
            if (disjoint) {
                for (const q of this._pending) {
                    try { gl.deleteQuery(q); } catch { /* ignore */ }
                }
                this._pending.length = 0;
                this.lastMs = null;
                return null;
            }
        } catch {
            // ignore
        }

        for (let i = 0; i < this._pending.length; i++) {
            const q = this._pending[i];
            let available = false;
            try { available = !!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); } catch { available = false; }
            if (!available) break;

            try {
                const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
                if (Number.isFinite(Number(ns))) this.lastMs = Number(ns) / 1e6;
            } catch {
                // ignore
            }
            try { gl.deleteQuery(q); } catch { /* ignore */ }
            this._pending.shift();
            i--;
        }
        return this.lastMs;
    }
}

export class App {
    constructor(canvas) {
        this.canvas = canvas;

        // Centralized error reporting (keeps "silent failures" debuggable without console spam).
        // Other modules can call: globalThis.__viewerReportError({ subsystem, message, ... }).
        this._errorRing = [];
        this._errorRingMax = 250;
        this._warnedOnce = new Set();
        const pushErr = (info) => {
            try {
                const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                const entry = {
                    t: now,
                    subsystem: String(info?.subsystem || 'app'),
                    level: String(info?.level || 'error'),
                    message: String(info?.message || 'unknown error'),
                    name: info?.name ? String(info.name) : undefined,
                    url: info?.url ? String(info.url) : undefined,
                    detail: info?.detail ?? undefined,
                    stack: info?.stack ? String(info.stack) : undefined,
                };
                this._errorRing.push(entry);
                if (this._errorRing.length > this._errorRingMax) this._errorRing.splice(0, this._errorRing.length - this._errorRingMax);
            } catch {
                // ignore
            }
        };
        const warnOnce = (key, ...args) => {
            const k = String(key || '');
            if (!k) return;
            if (this._warnedOnce.has(k)) return;
            this._warnedOnce.add(k);
            try { console.warn(...args); } catch { /* ignore */ }
        };
        try {
            globalThis.__viewerReportError = (info) => pushErr(info);
            globalThis.__viewerGetErrors = (n = 100) => {
                const nn = Number.isFinite(Number(n)) ? Math.max(0, Math.min(1000, Math.floor(Number(n)))) : 100;
                return this._errorRing.slice(Math.max(0, this._errorRing.length - nn));
            };
            globalThis.__viewerClearErrors = () => { try { this._errorRing.length = 0; } catch { /* ignore */ } };
            globalThis.__viewerWarnOnce = warnOnce;
        } catch {
            // ignore
        }

        // Capture global errors/rejections that otherwise show up as confusing "nothing happened".
        try {
            window.addEventListener('error', (e) => {
                pushErr({
                    subsystem: 'window',
                    level: 'error',
                    message: e?.message || 'window error',
                    url: e?.filename,
                    detail: { lineno: e?.lineno, colno: e?.colno },
                    stack: e?.error?.stack,
                    name: e?.error?.name,
                });
            });
            window.addEventListener('unhandledrejection', (e) => {
                const r = e?.reason;
                pushErr({
                    subsystem: 'promise',
                    level: 'error',
                    message: (r && (r.message || String(r))) || 'unhandled rejection',
                    detail: { reason: r },
                    stack: r?.stack,
                    name: r?.name,
                });
            });
        } catch {
            // ignore
        }

        // Let index.html's inline boot UI know the module actually started.
        try {
            window.__viewerSetBootStatus?.('main.js loaded; creating app…');
        } catch {
            // ignore
        }
        
        // Get WebGL context with error checking
        this.gl = canvas.getContext('webgl2');
        if (!this.gl) {
            console.error('WebGL 2 not supported, falling back to WebGL 1');
            this.gl = canvas.getContext('webgl');
            if (!this.gl) {
                console.error('Failed to get WebGL context');
                try {
                    window.__viewerShowFatal?.('Failed to get WebGL context. Your browser/GPU may not support WebGL.');
                } catch {
                    // ignore
                }
                return;
            }
        }
        console.log('WebGL context created successfully');

        // Post FX (CodeWalker-like tone mapping/bloom). WebGL2 only.
        this.postFx = null;
        this.enablePostFx = false;
        this.postFxExposure = 1.0;
        this.postFxLum = 1.0;
        this.enableAutoExposure = false;
        this.autoExposureSpeed = 1.5;
        this.enableBloom = false;
        this.bloomStrength = 0.6;
        // CodeWalker BRIGHT_THRESHOLD is 50.0 in PPBloomFilterBPHCS.hlsl.
        this.bloomThreshold = 50.0;
        this.bloomRadius = 2.0;
        try {
            const isWebGL2 = (typeof WebGL2RenderingContext !== 'undefined') && (this.gl instanceof WebGL2RenderingContext);
            if (isWebGL2) {
                this.postFx = new PostFxRenderer(this.gl);
                this.postFx.init().then((ok) => {
                    if (!ok) console.warn('PostFxRenderer: init failed (post FX disabled).');
                });
            }
        } catch {
            this.postFx = null;
        }

        // Shadows (directional shadow map). Optional and OFF by default.
        // UI can enable it later; renderer treats falsy as disabled.
        this.enableShadows = false;
        this.shadowMapSize = 2048;

        // Streaming can trigger hundreds of loads; keep fetch concurrency bounded to avoid resource exhaustion.
        // (Cache hits bypass the limiter.)
        setAssetFetchConcurrency(24);

        // Loading state
        this._loading = true;
        this._loadingSkipped = false;
        this._animationStarted = false;
        this._loadingResolve = null;
        this._loadingPromise = new Promise((resolve) => {
            this._loadingResolve = resolve;
        });
        try {
            window.__viewerSkipLoading = () => {
                this._loadingSkipped = true;
                this._loadingResolve?.();
                // Immediately hide the overlay and start rendering whatever is available.
                // (Heavy loads can continue in the background; render paths are guarded by readiness.)
                try { this._setLoading({ visible: false }); } catch { /* ignore */ }
                try { this._startAnimationLoop(); } catch { /* ignore */ }
            };
        } catch {
            // ignore
        }
        
        // Initialize camera first
        this.camera = new Camera();
        console.log('Camera initialized');

        // Map-view snapshot so "character/ped view" can be toggled off and restore the prior free camera pose.
        this._mapViewSnapshot = null; // { position:[x,y,z], target:[x,y,z], fov, minZoom, maxZoom, near, far }
        this._spawnCharacterBtn = null;

        // Camera speed UI (multiplies Camera.moveSpeed)
        this._baseCameraMoveSpeed = Number(this.camera.moveSpeed) || 500.0;
        
        // Initialize terrain renderer
        this.terrainRenderer = new TerrainRenderer(this.gl);
        console.log('Terrain renderer initialized');
        // Models-only default: users who exported real drawables + textures generally want to see the actual world props,
        // not a proxy terrain mesh.
        this.showTerrain = true;

        // Initialize entity streaming (client-like)
        this.entityRenderer = new EntityRenderer(this.gl);
        this.entityStreamer = new EntityStreamer({ modelMatrix: this.entityRenderer.modelMatrix });
        this.entityReady = false;

        // Buildings (city geometry)
        this.buildingRenderer = new BuildingRenderer(this.gl);
        this.showBuildings = true;
        this.showWater = true;

        // Entity dots (always-available point rendering)
        this.showEntityDots = false;
        // Overlay mode makes dots visible even when entities are underground/interior, but it can obscure meshes.
        this.entityDotsOverlay = false;

        // Real GTA drawables (exported offline into assets/models/*)
        // Cache sizing heuristic:
        // - Browsers vary wildly in how much GPU memory they can actually allocate for WebGL buffers/textures.
        // - `navigator.deviceMemory` (GB) is a coarse signal, but good enough to avoid picking absurd defaults
        //   for low-memory devices while still allowing large GTA-scale caches on desktops.
        const devMemGb = (() => {
            try {
                const v = Number((typeof navigator !== 'undefined') ? navigator.deviceMemory : NaN);
                return Number.isFinite(v) ? v : null;
            } catch { return null; }
        })();
        const cacheCaps = (() => {
            // Defaults assume desktop-class hardware.
            let meshGb = 4;
            let texGb = 1.5;
            let maxTextures = 4096;
            if (devMemGb !== null) {
                if (devMemGb <= 4) {
                    meshGb = 1;
                    texGb = 0.5;
                    maxTextures = 1024;
                } else if (devMemGb <= 8) {
                    meshGb = 2;
                    texGb = 1.0;
                    maxTextures = 2048;
                } else if (devMemGb >= 16) {
                    meshGb = 6;      // big desktop/workstation
                    texGb = 2.0;
                    maxTextures = 8192;
                }
            }
            return {
                deviceMemoryGb: devMemGb,
                meshMaxBytes: Math.floor(meshGb * 1024 * 1024 * 1024),
                texMaxBytes: Math.floor(texGb * 1024 * 1024 * 1024),
                texMaxTextures: maxTextures,
            };
        })();

        this.modelManager = new ModelManager(this.gl);
        // Default: strict mode (missing exports simply don't appear).
        // You can toggle placeholders on in the UI to visualize missing exports.
        this.modelManager.enablePlaceholderMeshes = false;
        // Mesh cache caps (GPU buffer residency).
        // The base game has a huge number of unique mesh bins; low budgets churn constantly when streaming.
        // If your GPU/driver can't handle this much residency, lower it via DevTools:
        //   __viewerApp.modelManager.setMeshCacheCaps({ maxBytes: ... })
        try { this.modelManager.setMeshCacheCaps?.({ maxBytes: cacheCaps.meshMaxBytes }); } catch { /* ignore */ }
        // Default texture cache caps:
        // We keep these reasonably high to avoid visible texture eviction/thrash when many unique
        // materials are in view (city blocks, highways, vegetation).
        //
        // NOTE: eviction is now based on *loaded* textures, not in-flight entries, so larger scenes
        // won't immediately churn even when many loads are pending.
        this.textureStreamer = new TextureStreamer(this.gl, { maxTextures: cacheCaps.texMaxTextures, maxBytes: cacheCaps.texMaxBytes });
        // Limit how many new texture loads we start each frame (prevents huge stalls/thrash in dense scenes).
        try { this.textureStreamer.setStreamingConfig({ maxLoadsInFlight: 32, maxNewLoadsPerFrame: 64 }); } catch { /* ignore */ }
        this.instancedModelRenderer = new InstancedModelRenderer(this.gl, this.modelManager, this.textureStreamer);
        this.drawableStreamer = new DrawableStreamer({
            modelMatrix: this.entityRenderer.modelMatrix,
            modelManager: this.modelManager,
            modelRenderer: this.instancedModelRenderer,
        });
        // When sharded manifest shards load, rebuild instance selection so real meshes pop in quickly.
        this.modelManager.onManifestUpdated = () => {
            if (this.drawableStreamer) this.drawableStreamer._dirty = true;
        };
        // Models ON by default: this viewer is primarily for streaming the actual world props/drawables.
        this.showModels = true;
        this.modelsInitialized = false;
        this._modelsInitPromise = null;

        // Viewer controls
        /** @type {null|'high'|'med'|'low'} */
        this.forcedModelLod = null;

        // RPF (experimental)
        this._rpfArchive = null;
        this._rpfStatusEl = null;

        // Cached transforms for viewer<->data conversions
        this._dataToViewMatrix = null;
        this._viewToDataMatrix = null;

        // Animation timing
        this._lastFrameMs = performance.now();

        // UI apply hooks (populated in setupEventListeners)
        this._applyStreamingFromUI = null;
        this._applyLodFromUI = null;
        this._applyTextureQualityFromUI = null;

        // Streaming center policy (camera-centric streaming helps first-view a lot).
        this.streamFromCamera = true;
        this._streamingUiParams = null; // { radius, maxLoaded, maxArch, maxDist, maxLoads, fc }
        this._streamingRampTimer = null;

        // Persistence + cache
        this.restoreOnRefresh = true;
        // Default ON when CacheStorage is available; can be toggled in UI and persists via localStorage.
        this.cacheStreamedChunks = supportsAssetCacheStorage();
        this._settingsSaveTimer = null;
        this._lastViewSaveMs = 0;
        this._restoredViewApplied = false;

        // Simple "ped" marker renderer
        this.pedRenderer = new PedRenderer(this.gl);
        this.ped = null; // { posData: [x,y,z], posView: [x,y,z], camOffset: [x,y,z] }
        this.followPed = true;
        this.controlPed = false;

        // Follow-ped vertical smoothing (terrain height changes can cause unpleasant camera bob).
        // We smooth only Y so horizontal tracking stays responsive.
        this._followPedYSmoothed = null;  // viewer-space Y
        this._followPedYSharpness = 18.0; // higher = snappier (less smoothing)

        // Convention: `ped.posData` is the *eye/aim point* in data-space (not the feet).
        // We keep the ped on terrain by setting Z = groundZ + this offset.
        // The rendered character mesh (whose origin is typically at/near the feet) compensates for this.
        this.pedEyeHeightData = 1.2;

        // "Real" player entity (static mesh instance, no skeleton/physics).
        this.player = {
            enabled: false,
            hash: null,        // stringified u32
            lod: 'high',
            headingRad: 0.0,   // data-space yaw (around +Z)
            _mat: glMatrix.mat4.create(),
            _matBuf: new Float32Array(16),
            _lastMoveDirData: [0, 0, 0],
        };

        // Gameplay camera controller (smooth follow/orbit/zoom around the player).
        this.gameplayCamEnabled = true;
        this._gpYaw = 0.0;
        this._gpPitch = -0.22;
        this._gpDist = 6.0;
        this._gpFollowSharpness = 14.0; // higher = snappier

        // Atmosphere (sky + fog)
        this.atmosphereEnabled = true;
        this.timeOfDayHours = 13.0; // 0..24
        // Optional "game-like" weather selection (used for ymap time/weather gating if ymap_gates.json is present).
        // Leave empty to ignore weather-based gating.
        // You can set this from DevTools: __viewerApp.weatherType = 'CLEAR';
        this.weatherType = '';
        this.fogEnabled = true;
        this.fogStart = 1200.0;
        this.fogEnd = 9000.0;
        this.fogColor = [0.62, 0.72, 0.82];
        this.skyTopColor = [0.18, 0.34, 0.62];
        this.skyBottomColor = [0.66, 0.74, 0.84];

        this.skyRenderer = new SkyRenderer(this.gl);

        // Occlusion proxy (depth prepass + conservative cull), off by default.
        this.enableOcclusionCulling = false;
        this.occlusionCuller = null;
        try {
            if (this.gl && typeof WebGL2RenderingContext !== 'undefined' && (this.gl instanceof WebGL2RenderingContext)) {
                this.occlusionCuller = new OcclusionCuller(this.gl, { width: 256, height: 256, readbackEveryNFrames: 2, depthEps: 0.0025 });
            }
        } catch {
            this.occlusionCuller = null;
        }

        // Follow-ped camera orbit state (viewer-space).
        this._orbitSensitivity = 0.005;
        this._orbitPitchLimit = 0.98; // clamp |y| <= limit * dist

        // Spawned-ped grounding behavior:
        // - If enabled, we snap to terrain only when the provided Z is "close enough" to ground.
        //   This avoids breaking interior/roof spawns where Z is far above the terrain surface.
        this.groundPedToTerrain = true;
        this.groundPedMaxDelta = 25.0; // data-space units
        this._pedGroundingDebug = null; // { desiredZ, groundZ, finalZ, usedGround }
        this._pedDebugEl = null;
        this._streamDebugEl = null;
        this._bootStatusEl = null;

        // Perf HUD (Task A6)
        this._perfHudEl = null;
        this.enablePerfHud = false;
        this._perfHudLastUpdateMs = 0;
        this._perfDtMs = 0;
        this._fpsEma = null;
        this._gpuTimer = null;
        
        // Set initial canvas size after camera is initialized
        this.resize();

        // Setup event listeners
        this.setupEventListeners();

        // Boot async, then start animation once "world is ready"
        void this.initializeTerrain();
        
        // Do not start animation loop yet; we do that after boot/preload.
    }
    
    async initializeTerrain() {
        try {
            this._setLoading({ title: 'Loading world…', detail: 'Loading terrain mesh…', progress: 0.08, visible: true });
            this._setBootStatus('Loading terrain mesh…');
            // Load terrain mesh first
            await this.terrainRenderer.loadTerrainMesh();
            // Sky is cheap; init now (non-blocking shader compile errors are still visible in console).
            try { await this.skyRenderer.init(); } catch { /* ignore */ }

            // Cache model matrices (terrain/entity use the same transform convention).
            this._dataToViewMatrix = this.terrainRenderer.modelMatrix || this.entityRenderer.modelMatrix;
            if (this._dataToViewMatrix) {
                this._viewToDataMatrix = glMatrix.mat4.create();
                glMatrix.mat4.invert(this._viewToDataMatrix, this._dataToViewMatrix);
            }

            // Frame the terrain bounds so we don't "jump away" after first render.
            if (this.terrainRenderer.sceneBoundsView) {
                const b = this.terrainRenderer.sceneBoundsView;
                this.camera.frameAABB(b.min, b.max);
            }

            // Kick off non-critical loads in the background so we can get to "first playable frame" faster.
            // (Terrain + entity dots + ped are enough to verify the world/coords and start moving.)
            this._setLoading({ detail: 'Loading textures/buildings (background)…', progress: 0.18 });
            this._setBootStatus('Loading textures/buildings (background)…');
            void this.loadTextures().catch((e) => {
                console.warn('Texture load failed:', e);
            });

            void (async () => {
                try {
                    await this.buildingRenderer.init();
                    await this.buildingRenderer.loadOBJ('assets/buildings.obj');
                    if (this.buildingRenderer.boundsView) {
                        // Expand framing to include buildings too (if present)
                        this.camera.frameAABB(this.buildingRenderer.boundsView.min, this.buildingRenderer.boundsView.max);
                    }
                } catch (e) {
                    console.warn('Building load failed:', e);
                }
            })();

            // Init entity renderer + streamer after terrain is ready
            this._setLoading({ detail: 'Loading entities index…', progress: 0.30 });
            this._setBootStatus('Loading entities index…');
            await this.entityRenderer.init();
            await this.entityStreamer.init();
            this.entityReady = this.entityRenderer.ready && this.entityStreamer.ready;
            if (this.entityReady) {
                const chunkCount = this.entityStreamer?.index?.chunks ? Object.keys(this.entityStreamer.index.chunks).length : 0;
                const total = this.entityStreamer?.index?.total_entities ?? null;
                console.log(`Entity streaming enabled: chunks=${chunkCount} total_entities=${total ?? 'n/a'}`);
            }

            // Init ped renderer
            this._setLoading({ detail: 'Starting…', progress: 0.40 });
            this._setBootStatus('Starting…');
            await this.pedRenderer.init();

            // If models are enabled by default, start initializing them now, but DO NOT block first frame on it.
            // (manifest.json can be huge; we want the world to be "playable" quickly.)
            {
                const modelsEl = document.getElementById('showModels');
                // Sync runtime flag from UI (restore-on-refresh can toggle this before boot).
                if (modelsEl) this.showModels = !!modelsEl.checked;
                if (this.showModels) {
                    if (modelsEl) modelsEl.checked = true;
                    void this._preloadModelsIfEnabled();
                } else {
                    console.log('Models are disabled (Show Models unchecked or restored settings). Enable "Show Models" to initialize streaming drawables.');
                }
            }

            // Boot the viewer like a "client": restore view if enabled, otherwise spawn a default ped.
            if (!this._tryRestoreViewFromStorage()) {
                try {
                    const follow = document.getElementById('followPed');
                    if (follow) follow.checked = true;
                    this.followPed = true;

                    const control = document.getElementById('controlPed');
                    if (control) control.checked = true;
                    this.controlPed = true;

                    // Prefer UI ped/cam vector4s; otherwise spawn at a reasonable city-ish ground location.
                    if (!this._spawnPedCamFromUiOrFallback()) {
                        this.spawnPedAtCity();
                    }
                } catch {
                    // ignore
                }
            }

            // Phase A complete: start rendering immediately (fast first playable frame).
            // Resolve the "skip loading" promise so any time-bounded boot tasks (like models init)
            // can continue in the background without blocking the renderer.
            this._loading = false;
            this._loadingResolve?.();
            this._setLoading({ visible: false, progress: 1.0 });
            this._startAnimationLoop();

            // Phase B: warm up streaming in the background (soft warmup; no boot stall).
            void this._warmupStreaming({ showOverlay: false }).then(() => {
                this._setBootStatus('');
            }).catch((e) => {
                console.warn('Warmup streaming failed:', e);
            });
        } catch (error) {
            console.error('Failed to initialize terrain:', error);
            const msg = `Startup failed:\n${error?.message || error}`;
            this._setBootStatus(msg);
            try {
                window.__viewerShowFatal?.(msg);
            } catch {
                // ignore
            }
        }
    }

    _setBootStatus(text) {
        const t = text || '';
        if (this._bootStatusEl) this._bootStatusEl.textContent = t;
        try {
            window.__viewerSetBootStatus?.(t);
        } catch {
            // ignore
        }
    }

    _setLoading({ title, detail, progress, visible } = {}) {
        try {
            // If the user clicked "Skip loading", never re-show the blocking overlay.
            // We still update the lightweight status panel elsewhere.
            if (this._loadingSkipped) visible = false;
            window.__viewerSetLoading?.({ title, detail, progress, visible });
        } catch {
            // ignore
        }
    }

    _safeLocalStorageGet(key) {
        try { return window.localStorage.getItem(key); } catch { return null; }
    }

    _safeLocalStorageSet(key, value) {
        try { window.localStorage.setItem(key, value); return true; } catch { return false; }
    }

    _restoreUiFromStorage() {
        const raw = this._safeLocalStorageGet(_LS_SETTINGS_KEY);
        if (!raw) return;
        let data = null;
        try { data = JSON.parse(raw); } catch { data = null; }
        if (!data || typeof data !== 'object') return;

        // Backward-compat: older builds stored camera speed as a multiplier slider (id `cameraSpeed`, range 0.1..10).
        // New builds store it as 1..100 (id `cameraSpeedPct`) where pct=10 => 1.0x.
        try {
            if (data.cameraSpeedPct === undefined && data.cameraSpeed !== undefined) {
                const oldMul = Number(data.cameraSpeed);
                if (Number.isFinite(oldMul) && oldMul > 0) {
                    data.cameraSpeedPct = String(Math.round(oldMul * 10));
                }
            }
        } catch {
            // ignore
        }

        const setVal = (id) => {
            const el = document.getElementById(id);
            if (!el) return;
            const v = data[id];
            if (v === undefined) return;
            if (el.type === 'checkbox') el.checked = !!v;
            else el.value = String(v);
        };

        // Toggles + numeric/select knobs
        [
            'showTerrain', 'showBuildings', 'showWater', 'showEntityDots', 'entityDotsOverlay',
            'showModels', 'crossArchetypeInstancing', 'showPlaceholders',
            'followPed', 'controlPed', 'groundPedToTerrain',
            'enableAtmosphere', 'enableFog',
            'enablePostFx', 'postFxExposure', 'postFxLum', 'enableAutoExposure', 'autoExposureSpeed', 'enableBloom', 'bloomStrength', 'bloomThreshold', 'bloomRadius',
            'frustumCulling', 'streamFromCamera',
            'enableOcclusionCulling',
            'enableShadows', 'shadowMapSize',
            'enablePerfHud',
            'restoreOnRefresh', 'cacheStreamedChunks',
            'streamRadius', 'maxLoadedChunks', 'maxArchetypes', 'maxModelDistance', 'maxMeshLoadsInFlight',
            'textureQuality', 'lodLevel',
            'cameraSpeedPct',
            'timeOfDay', 'fogStart', 'fogEnd',
            'groundPedMaxDelta',
            'pedCoords', 'camCoords',
        ].forEach(setVal);
    }

    _collectUiSettings() {
        const out = {};
        const read = (id) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (el.type === 'checkbox') out[id] = !!el.checked;
            else out[id] = String(el.value ?? '');
        };

        [
            'showTerrain', 'showBuildings', 'showWater', 'showEntityDots', 'entityDotsOverlay',
            'showModels', 'crossArchetypeInstancing', 'showPlaceholders',
            'followPed', 'controlPed', 'groundPedToTerrain',
            'enableAtmosphere', 'enableFog',
            'enablePostFx', 'postFxExposure', 'postFxLum', 'enableAutoExposure', 'autoExposureSpeed', 'enableBloom', 'bloomStrength', 'bloomThreshold', 'bloomRadius',
            'frustumCulling', 'streamFromCamera',
            'enableOcclusionCulling',
            'enableShadows', 'shadowMapSize',
            'enablePerfHud',
            'restoreOnRefresh', 'cacheStreamedChunks',
            'streamRadius', 'maxLoadedChunks', 'maxArchetypes', 'maxModelDistance', 'maxMeshLoadsInFlight',
            'textureQuality', 'lodLevel',
            'cameraSpeedPct',
            'timeOfDay', 'fogStart', 'fogEnd',
            'groundPedMaxDelta',
            'pedCoords', 'camCoords',
        ].forEach(read);

        out.__savedAt = new Date().toISOString();
        out.__version = 1;
        return out;
    }

    _scheduleSaveSettings() {
        if (!this.restoreOnRefresh) return;
        if (this._settingsSaveTimer) return;
        this._settingsSaveTimer = setTimeout(() => {
            this._settingsSaveTimer = null;
            const settings = this._collectUiSettings();
            this._safeLocalStorageSet(_LS_SETTINGS_KEY, JSON.stringify(settings));
        }, 250);
    }

    _tryRestoreViewFromStorage() {
        if (!this.restoreOnRefresh) return false;
        if (this._restoredViewApplied) return true;

        const raw = this._safeLocalStorageGet(_LS_VIEW_KEY);
        if (!raw) return false;
        let data = null;
        try { data = JSON.parse(raw); } catch { data = null; }
        if (!data || typeof data !== 'object') return false;

        try {
            const cam = data.camera || null;
            if (cam && Array.isArray(cam.position) && Array.isArray(cam.target)) {
                this.camera.position[0] = Number(cam.position[0]) || 0;
                this.camera.position[1] = Number(cam.position[1]) || 0;
                this.camera.position[2] = Number(cam.position[2]) || 0;
                this.camera.target[0] = Number(cam.target[0]) || 0;
                this.camera.target[1] = Number(cam.target[1]) || 0;
                this.camera.target[2] = Number(cam.target[2]) || 0;
                if (Number.isFinite(Number(cam.fov))) this.camera.setFovDegrees?.(Number(cam.fov));
                if (Number.isFinite(Number(cam.near)) && Number.isFinite(Number(cam.far))) this.camera.setClipPlanes?.(Number(cam.near), Number(cam.far));
                if (Number.isFinite(Number(cam.minZoom)) && Number.isFinite(Number(cam.maxZoom))) this.camera.setZoomLimits?.(Number(cam.minZoom), Number(cam.maxZoom));
                this.camera.updateViewMatrix();
                this.camera.updateProjectionMatrix();
            }

            // Ped restore (data-space)
            const ped = data.ped || null;
            if (ped && Array.isArray(ped.posData)) {
                const posData = [Number(ped.posData[0]) || 0, Number(ped.posData[1]) || 0, Number(ped.posData[2]) || 0];
                const posView = this._dataToViewer(posData);
                const off = Array.isArray(ped.camOffset) ? ped.camOffset : null;
                const camOffset = off ? [Number(off[0]) || 0, Number(off[1]) || 0, Number(off[2]) || 0] : [0, 0, 0];
                this.ped = { posData, posView, camOffset };
                this.pedRenderer?.setPositions?.([posData]);
            }

            // If we restored a "map view" camera (very far away), clamp back to a ground third-person rig.
            // This fixes the “everything looks tiny” feeling after refresh.
            if (this.followPed && this.ped) {
                const dx = this.camera.position[0] - this.camera.target[0];
                const dy = this.camera.position[1] - this.camera.target[1];
                const dz = this.camera.position[2] - this.camera.target[2];
                const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (Number.isFinite(d) && d > 900.0) {
                    this._setGtaThirdPersonRigForPed({ distanceData: 6.0, heightData: 1.7, sideData: 0.6 });
                }
            }

            this._restoredViewApplied = true;
            return true;
        } catch {
            return false;
        }
    }

    _maybeSaveViewToStorage() {
        if (!this.restoreOnRefresh) return;
        const now = performance.now();
        if (now - this._lastViewSaveMs < 900) return;
        this._lastViewSaveMs = now;

        const payload = {
            __version: 1,
            savedAt: new Date().toISOString(),
            camera: {
                position: [this.camera.position[0], this.camera.position[1], this.camera.position[2]],
                target: [this.camera.target[0], this.camera.target[1], this.camera.target[2]],
                fov: this.camera.fieldOfView,
                near: this.camera.nearPlane,
                far: this.camera.farPlane,
                minZoom: this.camera.minZoom,
                maxZoom: this.camera.maxZoom,
            },
            ped: this.ped ? {
                posData: [this.ped.posData[0], this.ped.posData[1], this.ped.posData[2]],
                camOffset: [this.ped.camOffset[0], this.ped.camOffset[1], this.ped.camOffset[2]],
            } : null,
        };
        this._safeLocalStorageSet(_LS_VIEW_KEY, JSON.stringify(payload));
    }

    _readStreamingUiParams() {
        const r = Number(document.getElementById('streamRadius')?.value ?? 2);
        const m = Number(document.getElementById('maxLoadedChunks')?.value ?? 25);
        const a = Number(document.getElementById('maxArchetypes')?.value ?? (this.drawableStreamer?.maxArchetypes ?? 250));
        const md = Number(document.getElementById('maxModelDistance')?.value ?? (this.drawableStreamer?.maxModelDistance ?? 350));
        const ml = Number(document.getElementById('maxMeshLoadsInFlight')?.value ?? (this.instancedModelRenderer?.maxMeshLoadsInFlight ?? 6));
        const fc = !!document.getElementById('frustumCulling')?.checked;

        const radius = Number.isFinite(r) ? Math.max(1, Math.min(24, Math.floor(r))) : 2;
        const maxLoaded = Number.isFinite(m) ? Math.max(9, Math.min(4000, Math.floor(m))) : 25;
        // 0 means "no cap" (distance cutoff still applies).
        const maxArch = Number.isFinite(a) ? Math.max(0, Math.floor(a)) : 250;
        const maxDist = Number.isFinite(md) ? Math.max(0, Math.min(100000, md)) : 350;
        const maxLoads = Number.isFinite(ml) ? Math.max(1, Math.min(64, Math.floor(ml))) : 6;
        return { radius, maxLoaded, maxArch, maxDist, maxLoads, fc };
    }

    _cancelStreamingRamp() {
        if (this._streamingRampTimer) {
            clearInterval(this._streamingRampTimer);
            this._streamingRampTimer = null;
        }
    }

    _applyStreamingParams({ radius, maxLoaded, maxArch, maxDist, maxLoads, fc } = {}) {
        if (this.entityStreamer) {
            if (Number.isFinite(radius)) this.entityStreamer.radiusChunks = radius;
            if (Number.isFinite(maxLoaded)) this.entityStreamer.maxLoadedChunks = maxLoaded;
            if (typeof fc === 'boolean') this.entityStreamer.enableFrustumCulling = fc;
        }
        if (this.drawableStreamer) {
            if (Number.isFinite(radius)) this.drawableStreamer.radiusChunks = radius;
            if (Number.isFinite(maxLoaded)) this.drawableStreamer.maxLoadedChunks = maxLoaded;
            if (typeof fc === 'boolean') this.drawableStreamer.enableFrustumCulling = fc;
            if (Number.isFinite(maxArch)) this.drawableStreamer.maxArchetypes = maxArch;
            if (Number.isFinite(maxDist)) this.drawableStreamer.maxModelDistance = maxDist;
            // Force rebuild so caps apply immediately.
            this.drawableStreamer._dirty = true;
        }
        if (this.instancedModelRenderer) {
            if (Number.isFinite(maxLoads)) this.instancedModelRenderer.maxMeshLoadsInFlight = maxLoads;
        }
    }

    _startStreamingFastRamp() {
        // Already ramping.
        if (this._streamingRampTimer) return;

        const target = this._streamingUiParams || this._readStreamingUiParams();
        this._streamingUiParams = target;
        if (!target) return;

        // Boot-small bubble: get first-view quickly, then expand outward.
        const boot = {
            radius: Math.min(2, target.radius),
            maxLoaded: Math.min(25, target.maxLoaded),
            maxArch: Math.min(250, target.maxArch),
            maxDist: Math.min(350, target.maxDist),
            maxLoads: Math.min(6, target.maxLoads),
            fc: target.fc,
        };

        // Only clamp down; don't unexpectedly increase if user already chose tiny settings.
        const curRadius = this.entityStreamer?.radiusChunks ?? boot.radius;
        const curLoaded = this.entityStreamer?.maxLoadedChunks ?? boot.maxLoaded;
        const curArch = this.drawableStreamer?.maxArchetypes ?? boot.maxArch;
        const curDist = this.drawableStreamer?.maxModelDistance ?? boot.maxDist;
        const curLoads = this.instancedModelRenderer?.maxMeshLoadsInFlight ?? boot.maxLoads;

        const start = {
            radius: Math.min(curRadius, boot.radius),
            maxLoaded: Math.min(curLoaded, boot.maxLoaded),
            maxArch: Math.min(curArch, boot.maxArch),
            maxDist: Math.min(curDist, boot.maxDist),
            maxLoads: Math.min(curLoads, boot.maxLoads),
            fc: boot.fc,
        };
        this._applyStreamingParams(start);

        const stepMs = 650;
        this._streamingRampTimer = setInterval(() => {
            // If user changed settings explicitly, stop the ramp.
            const latest = this._streamingUiParams || target;
            if (!latest) {
                this._cancelStreamingRamp();
                return;
            }

            const curR = this.entityStreamer?.radiusChunks ?? start.radius;
            const curM = this.entityStreamer?.maxLoadedChunks ?? start.maxLoaded;
            const curA = this.drawableStreamer?.maxArchetypes ?? start.maxArch;
            const curD = this.drawableStreamer?.maxModelDistance ?? start.maxDist;
            const curL = this.instancedModelRenderer?.maxMeshLoadsInFlight ?? start.maxLoads;

            const next = {
                radius: Math.min(latest.radius, curR + 1),
                maxLoaded: Math.min(latest.maxLoaded, curM + 60),
                maxArch: Math.min(latest.maxArch, curA + 200),
                maxDist: Math.min(latest.maxDist, curD + 250),
                maxLoads: Math.min(latest.maxLoads, curL + 1),
                fc: latest.fc,
            };

            this._applyStreamingParams(next);

            const done =
                next.radius >= latest.radius &&
                next.maxLoaded >= latest.maxLoaded &&
                next.maxArch >= latest.maxArch &&
                next.maxDist >= latest.maxDist &&
                next.maxLoads >= latest.maxLoads;

            if (done) this._cancelStreamingRamp();
        }, stepMs);
    }

    async _preloadModelsIfEnabled() {
        if (!this.showModels) return;
        this._setLoading({
            title: 'Loading world…',
            detail: 'Loading GTA models manifest… (large manifests may take a while; you can skip)',
            progress: 0.55,
            visible: true,
        });

        // Start the heavy model pipeline init, but only wait a short time for "fast path" wins.
        // If it takes longer, let it continue in the background and don't block first render.
        const maxWaitMs = 1800;
        const initPromise = this.ensureModelsInitialized();
        const okOrNull = await Promise.race([
            initPromise, // resolves true/false
            (async () => {
                await this._loadingPromise; // user clicked "Skip loading"
                return null;
            })(),
            new Promise((resolve) => setTimeout(() => resolve(null), maxWaitMs)),
        ]);

        if (okOrNull === true) {
            this._setLoading({ detail: 'Models ready; warming up streaming…', progress: 0.70 });
            return;
        }

        if (okOrNull === false) {
            // Model init failed quickly: flip models off to avoid repeated work until user toggles back on.
            this.showModels = false;
            const modelsEl = document.getElementById('showModels');
            if (modelsEl) modelsEl.checked = false;
            this._setLoading({ detail: 'Model init failed; starting without models…', progress: 0.62 });
            return;
        }

        // okOrNull === null: skipped or timed out. Keep models enabled and let init continue in background.
        this._setLoading({
            detail: 'Starting without waiting for models… (models will pop in as they finish loading)',
            progress: 0.62,
        });
    }

    async _warmupStreaming({ showOverlay = true, timeoutMs = 6000 } = {}) {
        // If user skipped, do the bare minimum and get to first frame.
        if (this._loadingSkipped) return;

        // Use the same center policy as the main update loop.
        const center = (!this.streamFromCamera && this.followPed && this.ped) ? this.ped.posData : null;

        // Fast-start: temporarily use a small bubble and ramp up to UI settings in the background.
        // This makes "first look around" responsive instead of waiting on a huge chunk burst.
        this._startStreamingFastRamp();

        // Kick streaming once to populate wanted keys and begin async loads.
        if (this.entityReady) this.entityStreamer.update(this.camera, this.entityRenderer, center);
        try { this.entityStreamer?.setTimeWeather?.({ hour: this.timeOfDayHours, weather: this.weatherType }); } catch { /* ignore */ }
        try { this.drawableStreamer?.setTimeWeather?.({ hour: this.timeOfDayHours, weather: this.weatherType }); } catch { /* ignore */ }
        if (this.showModels && this.modelsInitialized) this.drawableStreamer.update(this.camera, center);

        // Wait briefly for initial chunk bubble to load (bounded; don't hang forever).
        const start = performance.now();
        const tickMs = 60;

        // Compute the set of chunk keys that actually exist in the index (missing meta should not block boot).
        const wantedEntity = (this.entityReady && this.entityStreamer?.getWantedKeys)
            ? this.entityStreamer.getWantedKeys(this.camera, center).filter((k) => !!this.entityStreamer?.index?.chunks?.[k])
            : [];
        const wantedDraw = (this.showModels && this.modelsInitialized && this.drawableStreamer?.getWantedKeys)
            ? this.drawableStreamer.getWantedKeys(this.camera, center).filter((k) => !!this.drawableStreamer?.index?.chunks?.[k])
            : [];

        while (performance.now() - start < timeoutMs) {
            if (this._loadingSkipped) return;

            // Keep requesting wanted chunks (async loads are fire-and-forget).
            if (this.entityReady) this.entityStreamer.update(this.camera, this.entityRenderer, center);
            try { this.entityStreamer?.setTimeWeather?.({ hour: this.timeOfDayHours, weather: this.weatherType }); } catch { /* ignore */ }
            try { this.drawableStreamer?.setTimeWeather?.({ hour: this.timeOfDayHours, weather: this.weatherType }); } catch { /* ignore */ }
            if (this.showModels && this.modelsInitialized) this.drawableStreamer.update(this.camera, center);

            // Drive mesh queue without drawing.
            if (this.showModels && this.modelsInitialized) {
                this.instancedModelRenderer?.pumpMeshLoadsOnce?.();
                this.instancedModelRenderer?.prefetchDiffuseTextures?.(220);
            }

            const eDone = wantedEntity.every((k) => this.entityStreamer.loaded.has(k));
            const dDone = wantedDraw.every((k) => this.drawableStreamer.loaded.has(k));

            const stats = this.instancedModelRenderer?.getMeshLoadStats?.() || null;
            const q = stats ? stats.queued : 0;
            const inflight = stats ? stats.inFlight : 0;

            const eLoaded = this.entityStreamer?.loaded?.size ?? 0;
            const eNeed = wantedEntity.length;
            const dLoaded = this.drawableStreamer?.loaded?.size ?? 0;
            const dNeed = wantedDraw.length;

            if (showOverlay) {
                this._setLoading({
                    title: 'Loading world…',
                    detail:
                        `Streaming chunks around spawn…\n` +
                        `Entities: ${eLoaded}/${eNeed || 'n/a'} loaded\n` +
                        `Drawables: ${dLoaded}/${dNeed || 'n/a'} loaded\n` +
                        `Meshes: queue=${q} inFlight=${inflight}`,
                    progress: 0.82,
                    visible: true,
                });
            } else {
                // Keep a light-weight status in the controls panel instead of blocking the whole screen.
                this._setBootStatus(
                    `Streaming (background): Entities ${eLoaded}/${eNeed || 'n/a'} | ` +
                    `Drawables ${dLoaded}/${dNeed || 'n/a'} | ` +
                    `Meshes q=${q} inFlight=${inflight}`
                );
            }

            // If chunks are ready and mesh queue has drained (or models are off), we can start.
            const meshOk = (!this.showModels || !this.modelsInitialized) ? true : (q === 0 && inflight === 0);
            if (eDone && dDone && meshOk) break;

            await new Promise((r) => setTimeout(r, tickMs));
        }

        if (showOverlay) this._setLoading({ detail: 'Starting renderer…', progress: 0.95 });
    }

    _startAnimationLoop() {
        if (this._animationStarted) return;
        this._animationStarted = true;
        this.animate();
    }

    async ensureModelsInitialized() {
        if (this.modelsInitialized) return true;
        if (this._modelsInitPromise) return this._modelsInitPromise;

        this._modelsInitPromise = (async () => {
            try {
                this._setLoading({ detail: 'Loading GTA models manifest…', progress: 0.58, visible: true });
                this._setBootStatus('Loading GTA models manifest (this can take a while)…');
                // Note: manifest.json can be ~50MB; only load on-demand.
                await this.modelManager.init('assets/models/manifest.json');
                await this.instancedModelRenderer.init();
                await this.drawableStreamer.init();
                this.modelsInitialized = true;
                this._setBootStatus('');
                return true;
            } catch (e) {
                console.error('Failed to initialize model pipeline:', e);
                this._setBootStatus(`Model init failed:\n${e?.message || e}`);
                this.modelsInitialized = false;
                return false;
            } finally {
                // Allow retry if it failed.
                if (!this.modelsInitialized) this._modelsInitPromise = null;
            }
        })();

        return this._modelsInitPromise;
    }

    _dataToViewer(posData) {
        // Convert GTA/data-space position to viewer-space using the same modelMatrix all renderers use.
        const m = this._dataToViewMatrix || this.terrainRenderer.modelMatrix || this.entityRenderer.modelMatrix;
        const v = glMatrix.vec4.fromValues(posData[0], posData[1], posData[2], 1.0);
        const out = glMatrix.vec4.create();
        glMatrix.vec4.transformMat4(out, v, m);
        return [out[0], out[1], out[2]];
    }

    _viewerDirToDataDir(dirViewVec3) {
        // Transform a direction vector (w=0) from viewer-space to data-space.
        const inv = this._viewToDataMatrix;
        if (!inv) return [dirViewVec3[0], dirViewVec3[1], dirViewVec3[2]];
        const v = glMatrix.vec4.fromValues(dirViewVec3[0], dirViewVec3[1], dirViewVec3[2], 0.0);
        const out = glMatrix.vec4.create();
        glMatrix.vec4.transformMat4(out, v, inv);
        return [out[0], out[1], out[2]];
    }

    _viewerPosToDataPos(posViewVec3) {
        // Transform a position (w=1) from viewer-space to data-space.
        const inv = this._viewToDataMatrix;
        if (!inv) return [posViewVec3[0], posViewVec3[1], posViewVec3[2]];
        const v = glMatrix.vec4.fromValues(posViewVec3[0], posViewVec3[1], posViewVec3[2], 1.0);
        const out = glMatrix.vec4.create();
        glMatrix.vec4.transformMat4(out, v, inv);
        return [out[0], out[1], out[2]];
    }

    _orbitFollowPed(deltaX, deltaY) {
        if (!this.ped) return;

        const off = glMatrix.vec3.fromValues(this.ped.camOffset[0], this.ped.camOffset[1], this.ped.camOffset[2]);
        let dist = glMatrix.vec3.length(off);
        if (!Number.isFinite(dist) || dist < 1e-5) dist = 10.0;

        const yaw = deltaX * this._orbitSensitivity;
        const pitch = -deltaY * this._orbitSensitivity;

        // Yaw around global up (viewer-space Y up).
        const qYaw = glMatrix.quat.create();
        glMatrix.quat.setAxisAngle(qYaw, this.camera.up, yaw);
        glMatrix.vec3.transformQuat(off, off, qYaw);

        // Pitch around camera-right axis derived from (target - position) and up.
        const fwd = glMatrix.vec3.create();
        glMatrix.vec3.scale(fwd, off, -1.0);
        if (glMatrix.vec3.length(fwd) < 1e-5) fwd[2] = -1.0;
        glMatrix.vec3.normalize(fwd, fwd);

        const right = glMatrix.vec3.create();
        glMatrix.vec3.cross(right, fwd, this.camera.up);
        if (glMatrix.vec3.length(right) < 1e-5) right[0] = 1.0;
        glMatrix.vec3.normalize(right, right);

        const qPitch = glMatrix.quat.create();
        glMatrix.quat.setAxisAngle(qPitch, right, pitch);
        glMatrix.vec3.transformQuat(off, off, qPitch);

        // Clamp pitch to avoid flipping over the poles.
        dist = glMatrix.vec3.length(off) || dist;
        const maxY = dist * this._orbitPitchLimit;
        off[1] = Math.max(-maxY, Math.min(maxY, off[1]));

        // Renormalize to preserve distance after clamping.
        const dist2 = glMatrix.vec3.length(off) || 1.0;
        glMatrix.vec3.scale(off, off, dist / dist2);

        this.ped.camOffset = [off[0], off[1], off[2]];

        // Apply immediately.
        this.ped.posView = this._dataToViewer(this.ped.posData);
        this.camera.lookAtPoint(this.ped.posView);
        this.camera.position[0] = this.ped.posView[0] + this.ped.camOffset[0];
        this.camera.position[1] = this.ped.posView[1] + this.ped.camOffset[1];
        this.camera.position[2] = this.ped.posView[2] + this.ped.camOffset[2];
        this.camera.updateViewMatrix();
    }

    _zoomFollowPed(wheelDeltaY) {
        if (!this.ped) return;
        const off = glMatrix.vec3.fromValues(this.ped.camOffset[0], this.ped.camOffset[1], this.ped.camOffset[2]);
        const dist = glMatrix.vec3.length(off) || 10.0;

        // Match Camera.zoom / gameplay camera behavior: exponential zoom with clamping.
        const k = 0.0012;
        const exp = Math.max(-0.25, Math.min(0.25, (Number(wheelDeltaY) || 0.0) * k));
        const newDist = dist * Math.exp(exp);
        const clamped = Math.max(this.camera.minZoom, Math.min(this.camera.maxZoom, newDist));

        glMatrix.vec3.normalize(off, off);
        glMatrix.vec3.scale(off, off, clamped);
        this.ped.camOffset = [off[0], off[1], off[2]];

        // Apply immediately (same as follow update).
        this.ped.posView = this._dataToViewer(this.ped.posData);
        this.camera.lookAtPoint(this.ped.posView);
        this.camera.position[0] = this.ped.posView[0] + this.ped.camOffset[0];
        this.camera.position[1] = this.ped.posView[1] + this.ped.camOffset[1];
        this.camera.position[2] = this.ped.posView[2] + this.ped.camOffset[2];
        this.camera.updateViewMatrix();
    }

    _parseVector4(text) {
        if (!text) return null;
        const s = String(text).trim();
        // Accept: vector4(x, y, z, w) or just "x, y, z, w"
        const m = s.match(/vector4\s*\(\s*([^\)]+)\s*\)\s*$/i);
        const inner = m ? m[1] : s;
        const parts = inner.split(',').map(p => p.trim()).filter(Boolean);
        if (parts.length < 3) return null;
        // NOTE: allow NaN for ped Z so "Ground ped to terrain" can pick a sensible height.
        // Callers must validate where finite values are required (e.g. camera coords).
        const nums = parts.slice(0, 4).map(v => Number(v));
        while (nums.length < 4) nums.push(0);
        return nums;
    }

    _parseVec3Any(text) {
        // Accept common debug formats:
        // - vec3(x, y, z)
        // - vector3(x, y, z)
        // - vector4(x, y, z, w)  (we take xyz)
        // - "x y z" / "x,y,z"
        // - pasted blocks like "viewer: vec3(...)\n data: vec3(...)" (we take the first vec3/vector4)
        if (!text) return null;
        const s = String(text);

        // Prefer explicit vec3/vector3/vector4 groups if present.
        const m3 = s.match(/vec3\s*\(\s*([^\)]+)\s*\)/i) || s.match(/vector3\s*\(\s*([^\)]+)\s*\)/i);
        if (m3) {
            const parts = String(m3[1]).split(',').map(p => p.trim()).filter(Boolean);
            if (parts.length >= 3) {
                const v = [Number(parts[0]), Number(parts[1]), Number(parts[2])];
                if (this._isFiniteVec3(v)) return v;
            }
        }
        const m4 = s.match(/vector4\s*\(\s*([^\)]+)\s*\)/i);
        if (m4) {
            const parts = String(m4[1]).split(',').map(p => p.trim()).filter(Boolean);
            if (parts.length >= 3) {
                const v = [Number(parts[0]), Number(parts[1]), Number(parts[2])];
                if (this._isFiniteVec3(v)) return v;
            }
        }

        // Fallback: extract first 3 numbers from the string.
        const nums = (s.match(/-?\d+(?:\.\d+)?/g) || []).slice(0, 3).map(Number);
        if (nums.length >= 3) {
            const v = [nums[0], nums[1], nums[2]];
            if (this._isFiniteVec3(v)) return v;
        }
        return null;
    }

    teleportCameraToViewer(posViewVec3) {
        if (!this._isFiniteVec3(posViewVec3)) return false;

        // If we are in character view, exit first so follow/gameplay camera doesn't instantly override.
        try {
            if (this.player?.enabled) this.exitCharacterView();
        } catch { /* ignore */ }

        // Ensure we are not in ped-follow mode (otherwise update() will immediately lock to ped).
        this.followPed = false;
        this.controlPed = false;
        this._followPedYSmoothed = null;
        try {
            const follow = document.getElementById('followPed');
            if (follow) follow.checked = false;
            const control = document.getElementById('controlPed');
            if (control) control.checked = false;
        } catch { /* ignore */ }

        // Preserve current orientation: keep direction + distance and just move the camera rig.
        const dist = Number(this.camera?.getDistance?.()) || 1000.0;
        const dir = this.camera?.direction ? [this.camera.direction[0], this.camera.direction[1], this.camera.direction[2]] : [0, 0, -1];
        const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1.0;
        dir[0] /= dl; dir[1] /= dl; dir[2] /= dl;

        this.camera.position[0] = posViewVec3[0];
        this.camera.position[1] = posViewVec3[1];
        this.camera.position[2] = posViewVec3[2];
        this.camera.target[0] = posViewVec3[0] + dir[0] * dist;
        this.camera.target[1] = posViewVec3[1] + dir[1] * dist;
        this.camera.target[2] = posViewVec3[2] + dir[2] * dist;
        this.camera.updateViewMatrix();
        return true;
    }

    _snapshotMapViewPose() {
        // Capture the current free camera pose + key camera params so we can restore after toggling ped/character view.
        this._mapViewSnapshot = {
            position: [this.camera.position[0], this.camera.position[1], this.camera.position[2]],
            target: [this.camera.target[0], this.camera.target[1], this.camera.target[2]],
            fov: this.camera.fieldOfView,
            minZoom: this.camera.minZoom,
            maxZoom: this.camera.maxZoom,
            near: this.camera.nearPlane,
            far: this.camera.farPlane,
        };
    }

    _restoreMapViewPoseIfAny() {
        const s = this._mapViewSnapshot;
        if (!s) return;
        try {
            this.camera.position[0] = s.position[0];
            this.camera.position[1] = s.position[1];
            this.camera.position[2] = s.position[2];
            this.camera.target[0] = s.target[0];
            this.camera.target[1] = s.target[1];
            this.camera.target[2] = s.target[2];
            this.camera.setFovDegrees?.(s.fov);
            this.camera.setZoomLimits?.(s.minZoom, s.maxZoom);
            this.camera.setClipPlanes?.(s.near, s.far);
            this.camera.updateViewMatrix();
        } catch {
            // ignore
        }
        this._mapViewSnapshot = null;
    }

    _setSpawnCharacterButtonLabel() {
        const btn = this._spawnCharacterBtn;
        if (!btn) return;
        const inChar = !!(this.player && this.player.enabled);
        btn.textContent = inChar ? 'Exit character view (back to map)' : 'Spawn character (GTA camera)';
    }

    exitCharacterView() {
        // Disable player mesh instance (and clear its instance buffer so it doesn't linger).
        const h = this.player?.hash;
        const lod = this.player?.lod || 'high';
        if (this.player) {
            this.player.enabled = false;
            this.player.hash = null;
        }
        try {
            if (h && this.instancedModelRenderer?.ready && this.instancedModelRenderer.setInstancesForArchetype) {
                // Empty instance list.
                void this.instancedModelRenderer.setInstancesForArchetype(String(h), String(lod), new Float32Array(0), 0.0);
            }
        } catch {
            // ignore
        }

        // Clear ped state + marker.
        this.ped = null;
        try { this.pedRenderer?.setPositions?.([]); } catch { /* ignore */ }

        // Exit follow/control mode back to map view defaults.
        this.followPed = false;
        this.controlPed = false;
        this._followPedYSmoothed = null;

        // Best-effort UI sync.
        try {
            const follow = document.getElementById('followPed');
            if (follow) follow.checked = false;
            const control = document.getElementById('controlPed');
            if (control) control.checked = false;
        } catch {
            // ignore
        }

        // Restore prior map-view camera pose if we captured it.
        this._restoreMapViewPoseIfAny();
        this._setSpawnCharacterButtonLabel();
    }

    _isFiniteVec3(v) {
        return !!v && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
    }

    _isFiniteVec2(v) {
        return !!v && Number.isFinite(v[0]) && Number.isFinite(v[1]);
    }

    _spawnPedCamFromUiOrFallback() {
        const ped = this._parseVector4(document.getElementById('pedCoords')?.value);
        const cam = this._parseVector4(document.getElementById('camCoords')?.value);
        if (!cam || !this._isFiniteVec3(cam)) return false;

        // Allow ped Z to be NaN (auto-ground), but require XY to be valid.
        const pedOk = ped && this._isFiniteVec2(ped);
        const pedV4 = pedOk ? ped : [cam[0], cam[1], cam[2], 0.0];
        this.applyPedAndCameraFromConfig(pedV4, cam);
        return true;
    }

    spawnPedAt(posDataXYZ) {
        const x = posDataXYZ[0];
        const y = posDataXYZ[1];
        const z = posDataXYZ[2];
        const posData = [x, y, z];
        const posView = this._dataToViewer(posData);

        // Keep camera offset so follow mode feels natural.
        const camOffset = glMatrix.vec3.create();
        glMatrix.vec3.subtract(camOffset, this.camera.position, this.camera.target);

        this.ped = { posData, posView, camOffset: [camOffset[0], camOffset[1], camOffset[2]] };
        this.pedRenderer.setPositions([posData]);
    }

    _setGtaThirdPersonRigForPed({ distanceData = 6.0, heightData = 1.7, sideData = 0.6 } = {}) {
        // GTA-like follow camera is best defined in *data space* (GTA units), not viewer-space.
        if (!this.ped) return;

        // Ensure we’re targeting the ped.
        const pedData = this.ped.posData;
        this.ped.posView = this._dataToViewer(pedData);
        const pedView = this.ped.posView;

        // Derive a horizontal "forward" direction in DATA SPACE from the current camera facing.
        // This makes the follow camera feel stable even without a real ped heading animation system.
        const dirData = this._viewerDirToDataDir(this.camera.direction || [0, 0, -1]);
        let fx = Number(dirData[0]) || 0.0;
        let fy = Number(dirData[1]) || 1.0;
        // DATA space is Z-up; keep movement/camera basis on XY plane.
        const fl = Math.hypot(fx, fy) || 1.0;
        fx /= fl;
        fy /= fl;

        // Back/right basis in data-space.
        const bx = -fx, by = -fy;
        const rx = -by, ry = bx; // rotate 90 degrees

        const dist = Math.max(1.0, Number(distanceData) || 6.0);
        const h = Number(heightData) || 1.7;
        const side = Number(sideData) || 0.6;

        const camData = [
            pedData[0] + bx * dist + rx * side,
            pedData[1] + by * dist + ry * side,
            pedData[2] + h,
        ];
        const camView = this._dataToViewer(camData);

        this.camera.position[0] = camView[0];
        this.camera.position[1] = camView[1];
        this.camera.position[2] = camView[2];
        this.camera.lookAtPoint(pedView);

        // GTA-ish defaults: wider FOV + close zoom limits.
        this.camera.setFovDegrees?.(60.0);
        this.camera.setZoomLimits?.(2.0, 200.0);
        // Clip planes get tightened dynamically in the follow update loop.

        // Update follow offset so follow mode preserves this rig.
        const off = glMatrix.vec3.create();
        glMatrix.vec3.subtract(off, this.camera.position, this.camera.target);
        this.ped.camOffset = [off[0], off[1], off[2]];
        this.camera.updateViewMatrix();
    }

    _isInTerrainXY(x, y) {
        const b = this.terrainRenderer?.terrainBounds;
        const s = this.terrainRenderer?.terrainSize;
        if (!b || !s) return true; // if unknown, don't block
        const minX = b[0], minY = b[1];
        const maxX = b[0] + s[0], maxY = b[1] + s[1];
        return x >= minX && x <= maxX && y >= minY && y <= maxY;
    }

    _chooseCitySpawn() {
        // A handful of known “Los Santos-ish” coordinates in GTA data space.
        // We pick the first candidate that’s within terrain bounds and has a sane ground height.
        const candidates = [
            // Legion Square (approx)
            [195.0, -933.0],

            // Downtown-ish / safe “city” defaults
            [-763.2816, 330.0418],   // downtown-ish
            [215.0, -920.0],         // mission row-ish (backup near Legion Square)
            [-75.0, -818.0],         // downtown-ish
            [-420.0, -1200.0],       // south city-ish
            [-1150.0, -570.0],       // del perro-ish

            // Iconic-ish spots (approximate; will be skipped if outside extracted bounds)
            [-802.0, 175.0],         // Michael's house area (Rockford Hills) (approx)
            [-15.0, -1440.0],        // Franklin's house area (Strawberry) (approx)
            [1985.0, 3825.0],        // Trevor / Sandy Shores (approx)
            [-1030.0, -2730.0],      // LSIA (approx)
            [-1850.0, -1220.0],      // Vespucci / Del Perro beach (approx)
            [425.0, 5585.0],         // Paleto Bay area (approx)
            [710.0, 1195.0],         // Vinewood sign-ish (approx)
        ];

        for (const [x, y] of candidates) {
            if (!this._isInTerrainXY(x, y)) continue;
            const hz = this.terrainRenderer.getHeightAtXY?.(x, y);
            if (hz === null || hz === undefined || !Number.isFinite(hz)) continue;
            // Exclude extreme values (edge artifacts)
            if (hz < -10 || hz > 400) continue;
            return { x, y, z: hz + this.pedEyeHeightData };
        }

        // Fallback: center of terrain bounds.
        const b = this.terrainRenderer?.terrainBounds || [0, 0, 0];
        const s = this.terrainRenderer?.terrainSize || [0, 0, 0];
        const x = b[0] + (s[0] || 0) * 0.5;
        const y = b[1] + (s[1] || 0) * 0.5;
        const hz = this.terrainRenderer.getHeightAtXY?.(x, y);
        const z = (Number.isFinite(hz) ? hz : (b[2] || 0)) + this.pedEyeHeightData;
        return { x, y, z };
    }

    applyPedAndCameraFromConfig(pedV4, camV4) {
        if (!pedV4 || !camV4) return;

        // Decide ped Z:
        // - If heightmap is available, use ground Z *only* when the provided Z is near the ground.
        //   Otherwise keep provided Z (common for interiors/roofs).
        const x = Number(pedV4[0]);
        const y = Number(pedV4[1]);
        const desiredZ = Number(pedV4[2]);
        const groundZ = this.terrainRenderer.getHeightAtXY?.(x, y);

        let baseZ = desiredZ;
        let usedGround = false;
        let usedInterior = false;
        let interior = null;

        // If the point is in/near a known MLO room, prefer its floor and/or avoid terrain-snapping.
        // This prevents spawns from ending up *under* interior floors when terrain is close.
        try {
            const zHint = Number.isFinite(desiredZ)
                ? desiredZ
                : (Number.isFinite(groundZ) ? groundZ : 0.0);
            interior = this.drawableStreamer?.getInteriorFloorAtDataPos?.([x, y, zHint], {
                zPadBelow: 14.0,
                zPadAbove: 8.0,
                maxRaise: this.groundPedMaxDelta,
            }) || null;
        } catch {
            interior = null;
        }

        const blockTerrainSnap = !!(interior && interior.inRoom);
        if (!blockTerrainSnap && this.groundPedToTerrain && Number.isFinite(groundZ)) {
            if (!Number.isFinite(baseZ) || Math.abs(baseZ - groundZ) <= this.groundPedMaxDelta) {
                baseZ = groundZ;
                usedGround = true;
            }
        }

        // If interior floor is known and would raise us, snap up (prefer smallest raise).
        if (interior && Number.isFinite(interior.floorZ)) {
            if (!Number.isFinite(baseZ) || interior.floorZ > baseZ) {
                baseZ = interior.floorZ;
                usedInterior = true;
                usedGround = false;
            }
        }
        if (!Number.isFinite(baseZ)) baseZ = Number.isFinite(groundZ) ? groundZ : 0.0;

        const z = baseZ + this.pedEyeHeightData; // eye-height-ish offset
        this.spawnPedAt([x, y, z]);
        this._pedGroundingDebug = {
            desiredZ,
            groundZ: Number.isFinite(groundZ) ? groundZ : null,
            interiorFloorZ: (interior && Number.isFinite(interior.floorZ)) ? interior.floorZ : null,
            usedGround,
            usedInterior,
            finalZ: z,
        };

        // Place camera at CamCoords and look at ped.
        const camData = [camV4[0], camV4[1], camV4[2]];
        const camView = this._dataToViewer(camData);
        this.camera.position[0] = camView[0];
        this.camera.position[1] = camView[1];
        this.camera.position[2] = camView[2];

        const pedView = this.ped.posView;
        this.camera.lookAtPoint(pedView);

        // Update follow offset so follow mode exactly preserves the supplied camera rig.
        const off = glMatrix.vec3.create();
        glMatrix.vec3.subtract(off, this.camera.position, this.camera.target);
        this.ped.camOffset = [off[0], off[1], off[2]];
        this.camera.updateViewMatrix();
    }

    spawnPedAtCity() {
        // Ensure we spawn on ground at a reliable city-ish coordinate.
        const p = this._chooseCitySpawn();

        // Update the UI inputs so it's obvious where we spawned.
        const pedInput = document.getElementById('pedCoords');
        if (pedInput) pedInput.value = `vector4(${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)}, 0.0)`;

        // Spawn ped first, then force a close 3rd-person rig in viewer-space.
        this.spawnPedAt([p.x, p.y, p.z]);
        this._setGtaThirdPersonRigForPed({ distanceData: 6.0, heightData: 1.7, sideData: 0.6 });

        // Update the camCoords UI from the actual camera position (data-space).
        const camInput = document.getElementById('camCoords');
        if (camInput) {
            const camData = this._viewerPosToDataPos(this.camera.position);
            camInput.value = `vector4(${camData[0].toFixed(4)}, ${camData[1].toFixed(4)}, ${camData[2].toFixed(4)}, 0.0)`;
        }

        // Do not override scene toggles here. The user-selected checkboxes (or index.html defaults)
        // define whether we are in models-only vs debug modes.

        const texQ = document.getElementById('textureQuality');
        if (texQ) texQ.value = 'high';
        this._applyTextureQualityFromUI?.();

        const lodSel = document.getElementById('lodLevel');
        if (lodSel) lodSel.value = '0'; // full detail
        this._applyLodFromUI?.();

        // IMPORTANT: don't auto-crank streaming on boot.
        // Large radii can trigger hundreds of chunk loads and make "first paint" feel like the viewer is hung.
        // Let the user opt-in via "Stream more (city)" or the preset dropdown.
    }

    /**
     * “Game-like” spawn: spawn a ped marker and immediately enable follow + WASD control,
     * with a GTA-ish 3rd-person camera rig.
     */
    async spawnCharacter() {
        // Toggle: if already spawned, clicking again exits back to map view.
        if (this.player?.enabled) {
            this.exitCharacterView();
            return;
        }

        // Snapshot the current map-view pose so we can toggle back later.
        this._snapshotMapViewPose();

        // Ensure a ped exists first (and it already applies a 3rd-person-ish camera rig).
        this.spawnPedAtCity();

        // Ensure model pipeline is ready so we can render a real player entity mesh.
        // (If this fails, we still keep the marker + camera controls working.)
        try {
            // Force models on (we need instanced meshes for the player entity).
            this.showModels = true;
            const showModelsEl = document.getElementById('showModels');
            if (showModelsEl) showModelsEl.checked = true;
            await this.ensureModelsInitialized();
        } catch {
            // ignore
        }

        // Pick character model hash from UI (name or numeric hash).
        const raw = String(document.getElementById('characterModel')?.value || '').trim();
        let h = null;
        if (raw) {
            if (/^\d+$/.test(raw)) h = String((Number(raw) >>> 0));
            else h = String((joaat(raw) >>> 0));
        }
        // Default to Michael if input is empty.
        if (!h) h = String((joaat('player_zero') >>> 0));

        this.player.enabled = true;
        this.player.hash = h;
        this.player.lod = 'high';

        // Enable follow + control mode.
        this.followPed = true;
        this.controlPed = true;

        // Keep the UI in sync (best-effort).
        try {
            const follow = document.getElementById('followPed');
            if (follow) follow.checked = true;
            const control = document.getElementById('controlPed');
            if (control) control.checked = true;
        } catch {
            // ignore
        }

        // Re-apply rig in case follow was previously off and camera settings were in map mode.
        this._setGtaThirdPersonRigForPed({ distanceData: 6.0, heightData: 1.7, sideData: 0.6 });

        // Initialize gameplay camera angles from current camera offset so it feels continuous.
        try { this._initGameplayCameraFromCurrentPose(); } catch { /* ignore */ }

        // Seed the player mesh instance once (updates after that use the fast path).
        try { this._syncPlayerEntityMesh(true); } catch { /* ignore */ }
        this._setSpawnCharacterButtonLabel();
    }

    _initGameplayCameraFromCurrentPose() {
        if (!this.ped) return;
        const pedView = this._dataToViewer(this.ped.posData);
        const off = glMatrix.vec3.fromValues(
            this.camera.position[0] - pedView[0],
            this.camera.position[1] - pedView[1],
            this.camera.position[2] - pedView[2]
        );
        const d = glMatrix.vec3.length(off) || 6.0;
        this._gpDist = d;
        this._gpYaw = Math.atan2(off[0], off[2]);
        this._gpPitch = Math.asin(Math.max(-1, Math.min(1, off[1] / d)));
        // Clamp pitch a bit so we don't end up flipped.
        this._gpPitch = Math.max(-1.2, Math.min(1.2, this._gpPitch));
    }

    _applyGameplayCameraInputDelta(deltaX, deltaY) {
        const sens = 0.0045;
        this._gpYaw += deltaX * sens;
        this._gpPitch += -deltaY * sens;
        this._gpPitch = Math.max(-1.15, Math.min(1.15, this._gpPitch));
    }

    _applyGameplayCameraZoomDelta(wheelDeltaY) {
        // Exponential zoom so it feels stable across scales.
        const k = 0.0012;
        const s = Math.exp(Math.max(-0.25, Math.min(0.25, wheelDeltaY * k)));
        this._gpDist = Math.max(2.0, Math.min(20000.0, this._gpDist * s));
    }

    _updateGameplayCamera(dt) {
        if (!this.ped) return;
        const pedView = this._dataToViewer(this.ped.posData);

        // Smooth vertical component to reduce bobbing when the ped is grounded to noisy terrain.
        // (This keeps GTA-like responsiveness in X/Z while filtering Y.)
        if (!Number.isFinite(this._followPedYSmoothed)) this._followPedYSmoothed = pedView[1];
        const ySharp = Number.isFinite(Number(this._followPedYSharpness)) ? Number(this._followPedYSharpness) : 18.0;
        const ay = 1.0 - Math.exp(-Math.max(1.0, ySharp) * Math.max(0.001, dt));
        this._followPedYSmoothed = this._followPedYSmoothed * (1 - ay) + pedView[1] * ay;
        pedView[1] = this._followPedYSmoothed;

        // Desired camera position in viewer-space from yaw/pitch/dist.
        const cy = Math.cos(this._gpPitch);
        const dir = [
            Math.sin(this._gpYaw) * cy,
            Math.sin(this._gpPitch),
            Math.cos(this._gpYaw) * cy,
        ];
        const desiredPos = [
            pedView[0] + dir[0] * this._gpDist,
            pedView[1] + dir[1] * this._gpDist,
            pedView[2] + dir[2] * this._gpDist,
        ];

        // Smooth follow (critically-damped-ish exponential).
        const sharp = Number.isFinite(Number(this._gpFollowSharpness)) ? Number(this._gpFollowSharpness) : 14.0;
        const a = 1.0 - Math.exp(-Math.max(1.0, sharp) * Math.max(0.001, dt));
        this.camera.position[0] = this.camera.position[0] * (1 - a) + desiredPos[0] * a;
        this.camera.position[1] = this.camera.position[1] * (1 - a) + desiredPos[1] * a;
        this.camera.position[2] = this.camera.position[2] * (1 - a) + desiredPos[2] * a;

        // Target the player.
        this.camera.target[0] = pedView[0];
        this.camera.target[1] = pedView[1];
        this.camera.target[2] = pedView[2];
        this.camera.updateViewMatrix();

        // Keep ped.camOffset in sync so other systems (save/restore, etc.) remain coherent.
        this.ped.camOffset = [
            this.camera.position[0] - pedView[0],
            this.camera.position[1] - pedView[1],
            this.camera.position[2] - pedView[2],
        ];
        this.ped.posView = pedView;
    }

    _syncPlayerEntityMesh(forceFullInit = false) {
        if (!this.player?.enabled || !this.ped) return;
        if (!this.modelsInitialized || !this.instancedModelRenderer?.ready) return;
        const h = String(this.player.hash || '');
        if (!h) return;

        // Update heading from last movement direction (data-space XY).
        const md = this.player._lastMoveDirData;
        const mv2 = Math.hypot(Number(md[0]) || 0, Number(md[1]) || 0);
        if (mv2 > 1e-4) {
            this.player.headingRad = Math.atan2(md[1], md[0]);
        }

        // Build a data-space transform.
        const q = glMatrix.quat.create();
        glMatrix.quat.setAxisAngle(q, [0, 0, 1], this.player.headingRad || 0.0);
        // `ped.posData` tracks the *eye* position for camera targeting.
        // Player meshes are authored with origin at/near the feet, so compensate to keep feet on ground.
        const px = this.ped.posData[0];
        const py = this.ped.posData[1];
        const pz = this.ped.posData[2] - (Number(this.pedEyeHeightData) || 0.0);
        glMatrix.mat4.fromRotationTranslation(this.player._mat, q, [px, py, pz]);
        this.player._matBuf.set(this.player._mat);

        if (forceFullInit) {
            // Ensure instance entry exists and submeshes are discovered once.
            void this.instancedModelRenderer.setInstancesForArchetype(h, this.player.lod, this.player._matBuf, 0.0);
            return;
        }

        // Fast path update each frame.
        const ok = this.instancedModelRenderer.updateInstanceMatricesForArchetype(h, this.player.lod, this.player._matBuf, 0.0);
        if (!ok) {
            // Entry doesn't exist yet (first frame after spawn / async init); create it.
            void this.instancedModelRenderer.setInstancesForArchetype(h, this.player.lod, this.player._matBuf, 0.0);
        }
    }
    
    async loadTextures() {
        try {
            console.log('Loading terrain textures...');
            
            // Load terrain info first to get texture information
            // LOW priority: terrain textures are optional and load in the background.
            const info = await fetchJSON('assets/terrain_info.json', { priority: 'low' });
            
            if (!info.texture_info) {
                throw new Error('No texture information found in terrain info');
            }

            // Always try to load the precomputed normalmap if it exists.
            // This is generated by the extractor even when no real GTA terrain textures were exported.
            await this.terrainRenderer.loadTexture('normal', 'assets/normalmap.png');

            // If we have explicit terrain-type mappings, load them into the shader samplers.
            // These map to uGrassDiffuseMap/uRockDiffuseMap/etc in the terrain shader.
            const tt = info.texture_info?.terrain_types;
            if (tt && typeof tt === 'object') {
                const kinds = ['grass', 'rock', 'dirt', 'sand', 'snow'];
                for (const k of kinds) {
                    const entry = tt[k];
                    if (!entry || typeof entry !== 'object') continue;
                    const base = String(entry.name || '');
                    if (!base) continue;

                    await this.terrainRenderer.loadTexture(`${k}.diffuse`, `assets/textures/${base}_diffuse.png`);
                    if (entry.has_normal) {
                        await this.terrainRenderer.loadTexture(`${k}.normal`, `assets/textures/${base}_normal.png`);
                    }
                }

                // Also set the "base" diffuse to grass (nice default) if present.
                const grassBase = String(tt.grass?.name || '');
                if (grassBase) {
                    await this.terrainRenderer.loadTexture('diffuse', `assets/textures/${grassBase}_diffuse.png`);
                    if (tt.grass?.has_normal) {
                        await this.terrainRenderer.loadTexture('normal', `assets/textures/${grassBase}_normal.png`);
                    }
                }
            }
            
            // Find the main terrain texture (usually grass or ground)
            const mainTexture = Object.entries(info.texture_info).find(([name, tex]) => 
                name.includes('grass') || name.includes('ground') || name.includes('dirt')
            );
            
            if (mainTexture) {
                const [name, tex] = mainTexture;
                // Load diffuse texture
                await this.terrainRenderer.loadTexture('diffuse', `assets/textures/${name}_diffuse.png`);
                // Load normal map if available
                if (tex.has_normal) {
                    await this.terrainRenderer.loadTexture('normal', `assets/textures/${name}_normal.png`);
                }
            }
            
            // Load additional layers if available
            if (info.texture_info.layers) {
                for (let i = 0; i < Math.min(4, info.texture_info.layers.length); i++) {
                    const layer = info.texture_info.layers[i];
                    await this.terrainRenderer.loadTexture(`layer${i + 1}`, `assets/textures/${layer.name}_diffuse.png`);
                    // Normal-map naming in extracted assets isn't perfectly consistent (some are *_normal.png,
                    // others come through as *_nm_diffuse.png). Try both.
                    const tryNormal = async (key, baseName, { preferAltFirst = false } = {}) => {
                        const canonical = `assets/textures/${baseName}_normal.png`;
                        const alt = `assets/textures/${baseName}_nm_diffuse.png`;

                        // Prefer canonical naming for "has_normal" layers, but avoid 404 spam for layers that
                        // claim they don't have normals (some still ship as *_nm_diffuse.png, e.g. da_dirttrack2).
                        const first = preferAltFirst ? alt : canonical;
                        const second = preferAltFirst ? canonical : alt;

                        const ok1 = await this.terrainRenderer.loadTexture(key, first);
                        if (ok1) return true;
                        return await this.terrainRenderer.loadTexture(key, second);
                    };

                    if (layer.has_normal) {
                        await tryNormal(`normal${i + 1}`, layer.name, { preferAltFirst: false });
                    } else {
                        // If metadata says "no normal" but we actually have an nm texture, use it anyway.
                        // (loadTexture returns false if missing; that's fine.)
                        await tryNormal(`normal${i + 1}`, layer.name, { preferAltFirst: true });
                    }
                }
            }
            
            // Load blend mask
            if (info.texture_info.blend_mask) {
                await this.terrainRenderer.loadTexture('blendMask', `assets/textures/terrain_blend_mask.png`);
            }
            
            // If the extractor didn’t export any textures, call it out once (helps debugging).
            if ((info.num_textures === 0 || !info.num_textures) && (!info.texture_info.layers || info.texture_info.layers.length === 0)) {
                console.warn('Terrain textures were not exported (num_textures=0). Viewer will use placeholder colors + normalmap.');
            }
        } catch (error) {
            console.error('Failed to load textures:', error);
            console.error('Error stack:', error.stack);
        }
    }
    
    setupEventListeners() {
        // Apply persisted UI state first so all the "read initial values" logic below picks it up.
        this._restoreUiFromStorage();
        const hasSavedSettings = !!this._safeLocalStorageGet(_LS_SETTINGS_KEY);

        // Window resize
        window.addEventListener('resize', () => {
            this.resize();
        });
        
        // Mouse / pointer movement (use pointer capture so dragging doesn't "drop" when leaving the canvas).
        let activePointerId = null;
        let lastX = 0;
        let lastY = 0;

        // Prevent context menu from stealing focus while looking around.
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        this.canvas.addEventListener('pointerdown', (e) => {
            // Left button only for now; prevents accidental camera motion while interacting with the page.
            if (e.button !== 0) return;
            activePointerId = e.pointerId;
            lastX = e.clientX;
            lastY = e.clientY;
            try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        });

        this.canvas.addEventListener('pointermove', (e) => {
            if (activePointerId === null || e.pointerId !== activePointerId) return;

            const deltaX = e.clientX - lastX;
            const deltaY = e.clientY - lastY;

            // In follow-ped mode, orbit around the ped instead of rotating the camera target away.
            if (this.followPed && this.ped) {
                if (this.gameplayCamEnabled) this._applyGameplayCameraInputDelta(deltaX, deltaY);
                else this._orbitFollowPed(deltaX, deltaY);
            } else {
                this.camera.rotate(deltaX, deltaY);
            }

            lastX = e.clientX;
            lastY = e.clientY;
        });

        const stopDrag = (e) => {
            if (activePointerId === null) return;
            try { this.canvas.releasePointerCapture(activePointerId); } catch { /* ignore */ }
            activePointerId = null;
        };
        this.canvas.addEventListener('pointerup', stopDrag);
        this.canvas.addEventListener('pointercancel', stopDrag);
        window.addEventListener('blur', stopDrag);
        
        // Mouse wheel
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (this.followPed && this.ped) {
                if (this.gameplayCamEnabled) this._applyGameplayCameraZoomDelta(e.deltaY);
                else this._zoomFollowPed(e.deltaY);
            } else {
                // Pass raw wheel delta; Camera.zoom handles normalization/clamping.
                this.camera.zoom(e.deltaY);
            }
        });
        
        // Keyboard controls
        const keyState = {};
        
        window.addEventListener('keydown', (e) => {
            const k = String(e.key || '').toLowerCase();
            // One-shot debug toggles (don't spam while held).
            if (!e.repeat) {
                if (k === 'i') {
                    if (this.drawableStreamer) {
                        this.drawableStreamer.enableInteriors = !this.drawableStreamer.enableInteriors;
                        this.drawableStreamer._dirty = true;
                        console.log(`Interiors enabled: ${this.drawableStreamer.enableInteriors}`);
                    }
                    return;
                }
                if (k === 'u') {
                    if (this.drawableStreamer) {
                        this.drawableStreamer.enableRoomGating = !this.drawableStreamer.enableRoomGating;
                        this.drawableStreamer._dirty = true;
                        console.log(`Interior room gating enabled: ${this.drawableStreamer.enableRoomGating}`);
                    }
                    return;
                }
                if (k === 'o') {
                    if (this.drawableStreamer) {
                        this.drawableStreamer.enableMloEntitySets = !this.drawableStreamer.enableMloEntitySets;
                        this.drawableStreamer._dirty = true;
                        console.log(`MLO entity sets enabled: ${this.drawableStreamer.enableMloEntitySets}`);
                    }
                    return;
                }
                if (k === 'p') {
                    if (this.drawableStreamer?.clearMloEntitySetOverrides) {
                        this.drawableStreamer.clearMloEntitySetOverrides();
                        console.log('Cleared MLO entity set overrides');
                    }
                    return;
                }
            }
            keyState[k] = true;
        });
        
        window.addEventListener('keyup', (e) => {
            keyState[e.key.toLowerCase()] = false;
        });
        
        // Update movement in animation loop
        this.keyState = keyState;
        
        // UI controls
        const controlsRoot = document.getElementById('controls');
        if (controlsRoot) {
            // One central persistence hook for most UI widgets.
            controlsRoot.addEventListener('change', () => this._scheduleSaveSettings());
            controlsRoot.addEventListener('input', () => this._scheduleSaveSettings());
        }
        document.getElementById('wireframe').addEventListener('change', (e) => {
            this.terrainRenderer.setWireframeMode(e.target.checked);
        });

        const spawnBtn = document.getElementById('spawnPedCity');
        if (spawnBtn) {
            spawnBtn.addEventListener('click', () => this.spawnPedAtCity());
        }
        const spawnCharBtn = document.getElementById('spawnCharacter');
        if (spawnCharBtn) {
            this._spawnCharacterBtn = spawnCharBtn;
            // Ensure label matches current state (e.g. restored sessions).
            this._setSpawnCharacterButtonLabel();
            spawnCharBtn.addEventListener('click', () => { void this.spawnCharacter(); });
        }

        const gpCam = document.getElementById('enableGameplayCamera');
        if (gpCam) {
            this.gameplayCamEnabled = !!gpCam.checked;
            gpCam.addEventListener('change', (e) => {
                this.gameplayCamEnabled = !!e.target.checked;
                try { if (this.gameplayCamEnabled) this._initGameplayCameraFromCurrentPose(); } catch { /* ignore */ }
            });
        }
        const applyBtn = document.getElementById('applyPedCam');
        if (applyBtn) {
            applyBtn.addEventListener('click', () => {
                const ped = this._parseVector4(document.getElementById('pedCoords')?.value);
                const cam = this._parseVector4(document.getElementById('camCoords')?.value);
                if (!cam || !this._isFiniteVec3(cam) || !ped || !this._isFiniteVec2(ped)) {
                    console.warn('Invalid ped/cam vector4 input (camera requires finite xyz; ped requires finite xy)');
                    return;
                }
                this.applyPedAndCameraFromConfig(ped, cam);
            });
        }
        const follow = document.getElementById('followPed');
        if (follow) {
            this.followPed = !!follow.checked;
            follow.addEventListener('change', (e) => {
                this.followPed = !!e.target.checked;
                // Reset smoothing state when switching modes so we don't "snap" from stale values.
                this._followPedYSmoothed = null;
                if (this.followPed && this.ped) {
                    // Recompute offset based on current camera state
                    const camOffset = glMatrix.vec3.create();
                    glMatrix.vec3.subtract(camOffset, this.camera.position, this.camera.target);
                    this.ped.camOffset = [camOffset[0], camOffset[1], camOffset[2]];
                    // Ped camera defaults (3rd-person-ish)
                    this.camera.setFovDegrees?.(60.0);
                    this.camera.setZoomLimits?.(2.0, 20000.0);
                }
                if (!this.followPed) {
                    // Restore map-view defaults so free camera feels normal again.
                    this.camera.setFovDegrees?.(45.0);
                    this.camera.setZoomLimits?.(10.0, 80000.0);
                    this.camera.setClipPlanes?.(1.0, 100000.0);
                }
            });
        }

        const control = document.getElementById('controlPed');
        if (control) {
            this.controlPed = !!control.checked;
            control.addEventListener('change', (e) => {
                this.controlPed = !!e.target.checked;
            });
        }

        const ground = document.getElementById('groundPedToTerrain');
        if (ground) {
            this.groundPedToTerrain = !!ground.checked;
            ground.addEventListener('change', (e) => {
                this.groundPedToTerrain = !!e.target.checked;
            });
        }

        const groundDelta = document.getElementById('groundPedMaxDelta');
        if (groundDelta) {
            const apply = () => {
                const v = Number(groundDelta.value);
                if (Number.isFinite(v)) this.groundPedMaxDelta = Math.max(0.0, Math.min(100000.0, v));
            };
            groundDelta.addEventListener('change', apply);
            apply();
        }

        this._pedDebugEl = document.getElementById('pedDebug');
        this._streamDebugEl = document.getElementById('streamDebug');
        this._bootStatusEl = document.getElementById('bootStatus');
        this._liveCoordsEl = document.getElementById('liveCoords');
        this._perfHudEl = document.getElementById('perfHud');
        this._rpfStatusEl = document.getElementById('rpfStatus');
        if (this._streamDebugEl) {
            // Allow multi-line status in the debug HUD.
            this._streamDebugEl.style.whiteSpace = 'pre-line';
        }

        // RPF explorer (experimental)
        const rpfInput = document.getElementById('rpfFileInput');
        const mountBtn = document.getElementById('mountRpfBtn');
        const extractBtn = document.getElementById('rpfExtractBtn');
        const extractPathEl = document.getElementById('rpfExtractPath');
        const setRpfStatus = (msg) => {
            if (!this._rpfStatusEl) return;
            this._rpfStatusEl.textContent = String(msg || '');
        };
        if (mountBtn && rpfInput) {
            mountBtn.addEventListener('click', () => {
                try { rpfInput.click(); } catch { /* ignore */ }
            });
            rpfInput.addEventListener('change', async () => {
                const file = rpfInput.files && rpfInput.files[0] ? rpfInput.files[0] : null;
                if (!file) return;
                setRpfStatus(`Mounting ${file.name} (${Math.round((file.size || 0) / (1024 * 1024))} MB)…`);
                try {
                    const reader = new FileBlobReader(file);
                    const arc = new RpfArchive(reader, { name: file.name, basePath: file.name });
                    await arc.init();
                    this._rpfArchive = arc;
                    const enc = arc.encryption >>> 0;
                    const encLabel = (enc === 0) ? 'NONE' : (enc === 0x4E45504F ? 'OPEN' : `0x${enc.toString(16)}`);
                    setRpfStatus(
                        `Mounted: ${file.name}\n` +
                        `- entries: ${arc.entryCount}\n` +
                        `- toc encryption: ${encLabel}\n` +
                        `Tip: try extracting "common\\data\\..." or "x64a.rpf\\common\\data\\..."`
                    );
                } catch (e) {
                    this._rpfArchive = null;
                    setRpfStatus(`Failed to mount:\n${e?.stack || e?.message || String(e)}`);
                }
            });
        }
        if (extractBtn) {
            extractBtn.addEventListener('click', async () => {
                const arc = this._rpfArchive;
                if (!arc) {
                    setRpfStatus('No RPF mounted yet.');
                    return;
                }
                const p = String(extractPathEl?.value || '').trim();
                if (!p) {
                    setRpfStatus('Enter a path to extract (example: common\\data\\levels\\gta5\\...)');
                    return;
                }
                try {
                    setRpfStatus(`Extracting:\n${p}`);
                    const u8 = await arc.extract(p, { decompress: true });
                    const nameGuess = (() => {
                        const s = p.replace(/\\/g, '/');
                        const parts = s.split('/');
                        return parts[parts.length - 1] || 'file.bin';
                    })();
                    const blob = new Blob([u8], { type: 'application/octet-stream' });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = nameGuess;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch { /* ignore */ } }, 5000);
                    setRpfStatus(`Extracted ${u8.byteLength} bytes → download started`);
                } catch (e) {
                    setRpfStatus(`Extract failed:\n${e?.stack || e?.message || String(e)}`);
                }
            });
        }

        const copyBtn = document.getElementById('copyLiveCoords');
        if (copyBtn) {
            copyBtn.addEventListener('click', async () => {
                const text = String(this._liveCoordsEl?.value || '').trim();
                if (!text) return;
                try {
                    await navigator.clipboard.writeText(text);
                    copyBtn.textContent = 'Copied!';
                    setTimeout(() => { copyBtn.textContent = 'Copy camera coords'; }, 900);
                } catch {
                    // Fallback: prompt-based copy for older browsers / permissions.
                    try { window.prompt('Copy camera coords:', text); } catch { /* ignore */ }
                }
            });
        }

        const terrain = document.getElementById('showTerrain');
        if (terrain) {
            this.showTerrain = !!terrain.checked;
            terrain.addEventListener('change', (e) => {
                this.showTerrain = !!e.target.checked;
            });
        }

        const buildings = document.getElementById('showBuildings');
        if (buildings) {
            this.showBuildings = !!buildings.checked;
            buildings.addEventListener('change', (e) => {
                this.showBuildings = !!e.target.checked;
            });
        }

        const water = document.getElementById('showWater');
        if (water) {
            this.showWater = !!water.checked;
            water.addEventListener('change', (e) => {
                this.showWater = !!e.target.checked;
            });
        }

        const entityDots = document.getElementById('showEntityDots');
        if (entityDots) {
            this.showEntityDots = !!entityDots.checked;
            entityDots.addEventListener('change', (e) => {
                this.showEntityDots = !!e.target.checked;
            });
        }

        const dotsOverlay = document.getElementById('entityDotsOverlay');
        if (dotsOverlay) {
            this.entityDotsOverlay = !!dotsOverlay.checked;
            dotsOverlay.addEventListener('change', (e) => {
                this.entityDotsOverlay = !!e.target.checked;
            });
        }

        const models = document.getElementById('showModels');
        if (models) {
            this.showModels = !!models.checked;
            models.addEventListener('change', (e) => {
                this.showModels = !!e.target.checked;
                if (this.showModels) {
                    // When enabling real meshes, default to depth-tested dots so the dots don't obscure geometry.
                    // Users can opt back into overlay mode for debugging.
                    const dotsOverlay = document.getElementById('entityDotsOverlay');
                    if (dotsOverlay && dotsOverlay.checked) {
                        dotsOverlay.checked = false;
                        this.entityDotsOverlay = false;
                    }
                    // Defer the heavy manifest parse until the user opts in.
                    this.ensureModelsInitialized().then((ok) => {
                        if (!ok) {
                            this.showModels = false;
                            e.target.checked = false;
                        }
                    });
                }
            });
        }

        const placeholders = document.getElementById('showPlaceholders');
        if (placeholders) {
            this.modelManager.enablePlaceholderMeshes = !!placeholders.checked;
            placeholders.addEventListener('change', (e) => {
                this.modelManager.enablePlaceholderMeshes = !!e.target.checked;
                // Changing placeholder mode affects which archetypes we choose to render under caps;
                // force a rebuild of instances so coverage stats + selection update immediately.
                if (this.drawableStreamer) this.drawableStreamer._dirty = true;
            });
        }

        const dumpMissing = document.getElementById('dumpMissingArchetypes');
        if (dumpMissing) {
            dumpMissing.addEventListener('click', () => {
                const top = this.drawableStreamer?.getMissingArchetypesTop?.(50) ?? [];
                const cov = this.drawableStreamer?.getCoverageStats?.() ?? null;
                console.log('Missing archetypes (top 50, current loaded chunks):', top);
                console.log('Coverage stats (current loaded chunks):', cov);
                if (!top.length) {
                    console.log('No missing archetypes detected in currently loaded chunks.');
                }
            });
        }

        const downloadMissing = document.getElementById('downloadMissingArchetypes');
        if (downloadMissing) {
            downloadMissing.addEventListener('click', () => {
                const cov = this.drawableStreamer?.getCoverageStats?.() ?? null;
                const top = this.drawableStreamer?.getMissingArchetypesTop?.(500) ?? [];
                const payload = {
                    version: 1,
                    createdAt: new Date().toISOString(),
                    note: 'Missing archetypes for currently loaded chunks (viewer-side).',
                    coverage: cov,
                    missingTop: top,
                };
                const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                const ts = payload.createdAt.replaceAll(':', '').replaceAll('-', '');
                a.download = `missing_archetypes_${ts}.json`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 2500);
            });
        }

        const lodSel = document.getElementById('lodLevel');
        if (lodSel) {
            const applyLod = () => {
                const v = String(lodSel.value ?? '0');
                // UI: 0=Full Detail, 1=Medium, 2=Low.
                if (v === '0') this.forcedModelLod = 'high';
                else if (v === '1') this.forcedModelLod = 'med';
                else if (v === '2') this.forcedModelLod = 'low';
                else this.forcedModelLod = null;

                if (this.drawableStreamer) {
                    this.drawableStreamer.forcedLod = this.forcedModelLod;
                }
                console.log(`Model LOD: ${this.forcedModelLod ?? 'auto'}`);
                this._scheduleSaveSettings();
            };
            lodSel.addEventListener('change', applyLod);
            applyLod();
            this._applyLodFromUI = applyLod;
        }

        const texSel = document.getElementById('textureQuality');
        if (texSel) {
            const applyTexQ = () => {
                const q = String(texSel.value ?? 'high').toLowerCase();
                this.textureStreamer?.setQuality?.(q);
                console.log(`Texture quality: ${q}`);
                this._scheduleSaveSettings();
            };
            texSel.addEventListener('change', applyTexQ);
            applyTexQ();
            this._applyTextureQualityFromUI = applyTexQ;
        }

        const applyStreaming = () => {
            const r = Number(document.getElementById('streamRadius')?.value ?? 2);
            const m = Number(document.getElementById('maxLoadedChunks')?.value ?? 25);
            const a = Number(document.getElementById('maxArchetypes')?.value ?? (this.drawableStreamer?.maxArchetypes ?? 250));
            const md = Number(document.getElementById('maxModelDistance')?.value ?? (this.drawableStreamer?.maxModelDistance ?? 350));
            const ml = Number(document.getElementById('maxMeshLoadsInFlight')?.value ?? (this.instancedModelRenderer?.maxMeshLoadsInFlight ?? 6));
            const fc = !!document.getElementById('frustumCulling')?.checked;
            const cross = !!document.getElementById('crossArchetypeInstancing')?.checked;
            const entLod = !!document.getElementById('entityLodTraversal')?.checked;
            const radius = Number.isFinite(r) ? Math.max(1, Math.min(24, Math.floor(r))) : 2;
            const maxLoaded = Number.isFinite(m) ? Math.max(9, Math.min(4000, Math.floor(m))) : 25;
            // 0 means "no cap" (distance cutoff still applies).
            const maxArch = Number.isFinite(a) ? Math.max(0, Math.floor(a)) : 250;
            const maxDist = Number.isFinite(md) ? Math.max(0, Math.min(100000, md)) : 350;
            const maxLoads = Number.isFinite(ml) ? Math.max(1, Math.min(64, Math.floor(ml))) : 6;

            // Cache UI params so boot/ramp can use them without reading DOM repeatedly.
            this._streamingUiParams = { radius, maxLoaded, maxArch, maxDist, maxLoads, fc };
            this._cancelStreamingRamp();

            // Apply to both point-entity streamer and drawable streamer.
            if (this.entityStreamer) {
                this.entityStreamer.radiusChunks = radius;
                this.entityStreamer.maxLoadedChunks = maxLoaded;
                this.entityStreamer.enableFrustumCulling = fc;
            }
            if (this.drawableStreamer) {
                this.drawableStreamer.radiusChunks = radius;
                this.drawableStreamer.maxLoadedChunks = maxLoaded;
                this.drawableStreamer.enableFrustumCulling = fc;
                this.drawableStreamer.forcedLod = this.forcedModelLod;
                this.drawableStreamer.maxArchetypes = maxArch;
                this.drawableStreamer.maxModelDistance = maxDist;
                this.drawableStreamer.enableCrossArchetypeInstancing = cross;
                // Entity-level LOD traversal: selects parent-vs-children leaves like CodeWalker.
                // This changes chunk parsing + instance selection, so treat as a streaming-mode change.
                if (typeof this.drawableStreamer.setEntityLodTraversalEnabled === 'function') {
                    this.drawableStreamer.setEntityLodTraversalEnabled(entLod);
                } else {
                    this.drawableStreamer.enableEntityLodTraversal = entLod;
                    this.drawableStreamer._dirty = true;
                }
                // Important: changing caps doesn't automatically rebuild unless chunk-set changes.
                // Force a rebuild so the new limits take effect immediately.
                this.drawableStreamer._dirty = true;
            }
            if (this.instancedModelRenderer) {
                this.instancedModelRenderer.maxMeshLoadsInFlight = maxLoads;
            }
            console.log(`Streaming: radiusChunks=${radius}, maxLoadedChunks=${maxLoaded}, maxArchetypes=${maxArch}, maxModelDistance=${maxDist}, maxMeshLoadsInFlight=${maxLoads}, frustumCulling=${fc}`);

            // Apply chunk-cache toggle (persists across refresh if enabled).
            const cacheChunks = !!document.getElementById('cacheStreamedChunks')?.checked;
            this.cacheStreamedChunks = cacheChunks;
            if (this.entityStreamer) this.entityStreamer.usePersistentCacheForChunks = cacheChunks;
            if (this.drawableStreamer) this.drawableStreamer.usePersistentCacheForChunks = cacheChunks;

            this._scheduleSaveSettings();
        };

        const radiusInput = document.getElementById('streamRadius');
        if (radiusInput) radiusInput.addEventListener('change', applyStreaming);
        const maxInput = document.getElementById('maxLoadedChunks');
        if (maxInput) maxInput.addEventListener('change', applyStreaming);
        const maxDistInput = document.getElementById('maxModelDistance');
        if (maxDistInput) maxDistInput.addEventListener('change', applyStreaming);
        const fcInput = document.getElementById('frustumCulling');
        if (fcInput) fcInput.addEventListener('change', applyStreaming);
        const crossInput = document.getElementById('crossArchetypeInstancing');
        if (crossInput) crossInput.addEventListener('change', applyStreaming);
        const entLodInput = document.getElementById('entityLodTraversal');
        if (entLodInput) entLodInput.addEventListener('change', applyStreaming);
        this._applyStreamingFromUI = applyStreaming;

        const occ = document.getElementById('enableOcclusionCulling');
        if (occ) {
            this.enableOcclusionCulling = !!occ.checked;
            occ.addEventListener('change', (e) => {
                this.enableOcclusionCulling = !!e.target.checked;
                // Keep culler "enabled" in sync so it can early-out cheaply.
                if (this.occlusionCuller) this.occlusionCuller.enabled = this.enableOcclusionCulling;
            });
        }

        // Directional shadow map (sun shadows) toggle + size.
        const sh = document.getElementById('enableShadows');
        if (sh) {
            this.enableShadows = !!sh.checked;
            sh.addEventListener('change', (e) => {
                this.enableShadows = !!e.target.checked;
                this._scheduleSaveSettings();
            });
        } else {
            this.enableShadows = false;
        }
        const shSize = document.getElementById('shadowMapSize');
        if (shSize) {
            const parse = () => {
                const v = Number(shSize.value);
                this.shadowMapSize = Number.isFinite(v) ? Math.max(256, Math.min(8192, Math.floor(v))) : 2048;
                this._scheduleSaveSettings();
            };
            parse();
            shSize.addEventListener('change', parse);
        } else {
            this.shadowMapSize = 2048;
        }

        const perfHud = document.getElementById('enablePerfHud');
        if (perfHud) {
            this.enablePerfHud = !!perfHud.checked;
            const apply = () => {
                if (this._perfHudEl) this._perfHudEl.style.display = this.enablePerfHud ? 'block' : 'none';
                if (this.enablePerfHud && !this._gpuTimer) this._gpuTimer = new GpuTimer(this.gl);
            };
            perfHud.addEventListener('change', (e) => {
                this.enablePerfHud = !!e.target.checked;
                apply();
            });
            apply();
        }

        const streamFromCamera = document.getElementById('streamFromCamera');
        if (streamFromCamera) {
            this.streamFromCamera = !!streamFromCamera.checked;
            streamFromCamera.addEventListener('change', (e) => {
                this.streamFromCamera = !!e.target.checked;
            });
        }

        const restoreOnRefresh = document.getElementById('restoreOnRefresh');
        if (restoreOnRefresh) {
            this.restoreOnRefresh = !!restoreOnRefresh.checked;
            restoreOnRefresh.addEventListener('change', (e) => {
                this.restoreOnRefresh = !!e.target.checked;
                this._scheduleSaveSettings();
            });
        }

        const cacheChunksEl = document.getElementById('cacheStreamedChunks');
        if (cacheChunksEl) {
            // If the user hasn't saved settings yet, default to enabling persistent chunk cache
            // when CacheStorage is available (feels much more game-like on revisits).
            if (!hasSavedSettings) {
                try { cacheChunksEl.checked = supportsAssetCacheStorage(); } catch { /* ignore */ }
            }
            this.cacheStreamedChunks = !!cacheChunksEl.checked;
            if (this.entityStreamer) this.entityStreamer.usePersistentCacheForChunks = this.cacheStreamedChunks;
            if (this.drawableStreamer) this.drawableStreamer.usePersistentCacheForChunks = this.cacheStreamedChunks;
            cacheChunksEl.addEventListener('change', (e) => {
                this.cacheStreamedChunks = !!e.target.checked;
                if (this.entityStreamer) this.entityStreamer.usePersistentCacheForChunks = this.cacheStreamedChunks;
                if (this.drawableStreamer) this.drawableStreamer.usePersistentCacheForChunks = this.cacheStreamedChunks;
                this._scheduleSaveSettings();
            });
        }

        const cacheStatus = document.getElementById('cacheStatus');
        if (cacheStatus) {
            cacheStatus.textContent = supportsAssetCacheStorage()
                ? 'Cache: enabled (CacheStorage available)'
                : 'Cache: unavailable (need https/localhost or Vite preview)';
        }

        const clearCacheBtn = document.getElementById('clearAssetCache');
        if (clearCacheBtn) {
            clearCacheBtn.addEventListener('click', async () => {
                // Clear in-memory caches immediately (these survive until reload otherwise).
                try { clearAssetMemoryCaches(); } catch { /* ignore */ }
                const ok = await clearAssetCacheStorage();
                // Also clear persisted viewer UI/view state so a "clear cache" feels like a clean slate.
                try { window.localStorage.removeItem(_LS_SETTINGS_KEY); } catch { /* ignore */ }
                try { window.localStorage.removeItem(_LS_VIEW_KEY); } catch { /* ignore */ }
                try {
                    clearCacheBtn.textContent = ok ? 'Cache cleared' : 'Cache not available';
                    setTimeout(() => { clearCacheBtn.textContent = 'Clear cache'; }, 1200);
                } catch {
                    // ignore
                }
                // Only reload when CacheStorage exists (otherwise it feels like the button "does nothing"
                // other than refreshing the page).
                if (ok) {
                    // Best-effort: force a reload so stale module/asset caches don't linger.
                    // (The browser HTTP cache for JS modules is outside CacheStorage.)
                    try { window.location.reload(); } catch { /* ignore */ }
                }
            });
        }

        const streamCity = document.getElementById('streamCity');
        if (streamCity) {
            streamCity.addEventListener('click', () => {
                // Reasonable “city feels filled” defaults without going totally unbounded.
                const r = document.getElementById('streamRadius');
                const m = document.getElementById('maxLoadedChunks');
                const a = document.getElementById('maxArchetypes');
                const ml = document.getElementById('maxMeshLoadsInFlight');
                if (r) r.value = '6';      // 13x13 = 169 chunks
                if (m) m.value = '200';    // allow most of that to stick
                if (a) a.value = '800';
                if (ml) ml.value = '10';
                applyStreaming();
                // Turn on models, since "city fully loaded" implies drawables.
                const models = document.getElementById('showModels');
                if (models) {
                    models.checked = true;
                    this.showModels = true;
                }
                // Ensure the model pipeline is initialized when this button enables models.
                this.ensureModelsInitialized?.().then((ok) => {
                    if (!ok) {
                        this.showModels = false;
                        if (models) models.checked = false;
                    }
                });
            });
        }

        const applyPresetBtn = document.getElementById('applyStreamPreset');
        if (applyPresetBtn) {
            applyPresetBtn.addEventListener('click', () => {
                const preset = String(document.getElementById('streamPreset')?.value ?? 'game');
                const r = document.getElementById('streamRadius');
                const m = document.getElementById('maxLoadedChunks');
                const a = document.getElementById('maxArchetypes');
                const ml = document.getElementById('maxMeshLoadsInFlight');
                const fc = document.getElementById('frustumCulling');

                if (preset === 'game') {
                    // Feels like “playing”: moderate radius, bounded memory, stable frame-time.
                    if (r) r.value = '6';
                    if (m) m.value = '250';
                    if (a) a.value = '900';
                    if (ml) ml.value = '8';
                    if (fc) fc.checked = true;
                } else if (preset === 'city') {
                    // Heavier: more chunks + more archetypes, still client-ish.
                    if (r) r.value = '10';
                    if (m) m.value = '900';
                    if (a) a.value = '2500';
                    if (ml) ml.value = '12';
                    if (fc) fc.checked = true;
                } else if (preset === 'extreme') {
                    // Huge loads; may hitch/crash depending on GPU/VRAM and how many textures you have.
                    if (r) r.value = '16';
                    if (m) m.value = '2200';
                    if (a) a.value = '8000';
                    if (ml) ml.value = '16';
                    if (fc) fc.checked = true;
                }

                applyStreaming();
                const models = document.getElementById('showModels');
                if (models) {
                    models.checked = true;
                    this.showModels = true;
                }
                // Ensure the model pipeline is initialized when presets enable models.
                this.ensureModelsInitialized?.().then((ok) => {
                    if (!ok) {
                        this.showModels = false;
                        if (models) models.checked = false;
                    }
                });
            });
        }

        // One-click “make it look like GTA”: enable world layers + bump streaming.
        const highDetailBtn = document.getElementById('applyHighDetail');
        if (highDetailBtn) {
            highDetailBtn.addEventListener('click', () => {
                const setCheck = (id, val) => {
                    const el = document.getElementById(id);
                    if (el) el.checked = !!val;
                };

                // Full scene layers on.
                setCheck('showTerrain', true);
                setCheck('showBuildings', true);
                setCheck('showWater', true);
                setCheck('showModels', true);
                // Dots are debug; keep off for “GTA view”.
                setCheck('showEntityDots', false);
                setCheck('entityDotsOverlay', false);

                this.showTerrain = true;
                this.showBuildings = true;
                this.showWater = true;
                this.showModels = true;
                this.showEntityDots = false;
                this.entityDotsOverlay = false;

                // Quality knobs.
                const texQ = document.getElementById('textureQuality');
                if (texQ) texQ.value = 'high';
                this._applyTextureQualityFromUI?.();

                const lodSel = document.getElementById('lodLevel');
                if (lodSel) lodSel.value = '0';
                this._applyLodFromUI?.();

                // Streaming: still bounded, but actually fills the world.
                const r = document.getElementById('streamRadius');
                const m = document.getElementById('maxLoadedChunks');
                const a = document.getElementById('maxArchetypes');
                const md = document.getElementById('maxModelDistance');
                const ml = document.getElementById('maxMeshLoadsInFlight');
                const fc = document.getElementById('frustumCulling');
                if (r) r.value = '10';
                if (m) m.value = '900';
                if (a) a.value = '2500';
                if (md) md.value = '2600';
                if (ml) ml.value = '12';
                if (fc) fc.checked = true;
                this._applyStreamingFromUI?.();

                // Ensure model pipeline is initialized.
                this.ensureModelsInitialized?.().then((ok) => {
                    if (!ok) {
                        this.showModels = false;
                        const models = document.getElementById('showModels');
                        if (models) models.checked = false;
                    }
                });
            });
        }

        // Atmosphere controls
        const atmo = document.getElementById('enableAtmosphere');
        if (atmo) {
            this.atmosphereEnabled = !!atmo.checked;
            atmo.addEventListener('change', (e) => {
                this.atmosphereEnabled = !!e.target.checked;
            });
        }
        const fog = document.getElementById('enableFog');
        if (fog) {
            this.fogEnabled = !!fog.checked;
            fog.addEventListener('change', (e) => {
                this.fogEnabled = !!e.target.checked;
            });
        }
        const fogStart = document.getElementById('fogStart');
        if (fogStart) {
            const apply = () => {
                const v = Number(fogStart.value);
                if (Number.isFinite(v)) this.fogStart = Math.max(0.0, Math.min(1000000.0, v));
            };
            fogStart.addEventListener('change', apply);
            apply();
        }
        const fogEnd = document.getElementById('fogEnd');
        if (fogEnd) {
            const apply = () => {
                const v = Number(fogEnd.value);
                if (Number.isFinite(v)) this.fogEnd = Math.max(0.0, Math.min(2000000.0, v));
            };
            fogEnd.addEventListener('change', apply);
            apply();
        }

        // Post FX controls (tone mapping / bloom)
        const postFx = document.getElementById('enablePostFx');
        if (postFx) {
            this.enablePostFx = !!postFx.checked;
            postFx.addEventListener('change', (e) => {
                this.enablePostFx = !!e.target.checked;
                this._scheduleSaveSettings();
            });
        }
        const postFxExposure = document.getElementById('postFxExposure');
        if (postFxExposure) {
            const apply = () => {
                const v = Number(postFxExposure.value);
                if (Number.isFinite(v)) this.postFxExposure = Math.max(0.0, Math.min(10.0, v));
            };
            postFxExposure.addEventListener('input', apply);
            postFxExposure.addEventListener('change', () => { apply(); this._scheduleSaveSettings(); });
            apply();
        }
        const postFxLum = document.getElementById('postFxLum');
        if (postFxLum) {
            const apply = () => {
                const v = Number(postFxLum.value);
                if (Number.isFinite(v)) this.postFxLum = Math.max(0.0, Math.min(10.0, v));
            };
            postFxLum.addEventListener('input', apply);
            postFxLum.addEventListener('change', () => { apply(); this._scheduleSaveSettings(); });
            apply();
        }

        const autoExp = document.getElementById('enableAutoExposure');
        if (autoExp) {
            this.enableAutoExposure = !!autoExp.checked;
            autoExp.addEventListener('change', (e) => {
                this.enableAutoExposure = !!e.target.checked;
                this._scheduleSaveSettings();
            });
        }
        const autoExpSpeed = document.getElementById('autoExposureSpeed');
        if (autoExpSpeed) {
            const apply = () => {
                const v = Number(autoExpSpeed.value);
                if (Number.isFinite(v)) this.autoExposureSpeed = Math.max(0.0, Math.min(10.0, v));
            };
            autoExpSpeed.addEventListener('input', apply);
            autoExpSpeed.addEventListener('change', () => { apply(); this._scheduleSaveSettings(); });
            apply();
        }
        const bloom = document.getElementById('enableBloom');
        if (bloom) {
            this.enableBloom = !!bloom.checked;
            bloom.addEventListener('change', (e) => {
                this.enableBloom = !!e.target.checked;
                this._scheduleSaveSettings();
            });
        }
        const bloomStrength = document.getElementById('bloomStrength');
        if (bloomStrength) {
            const apply = () => {
                const v = Number(bloomStrength.value);
                if (Number.isFinite(v)) this.bloomStrength = Math.max(0.0, Math.min(4.0, v));
            };
            bloomStrength.addEventListener('input', apply);
            bloomStrength.addEventListener('change', () => { apply(); this._scheduleSaveSettings(); });
            apply();
        }
        const bloomThreshold = document.getElementById('bloomThreshold');
        if (bloomThreshold) {
            const apply = () => {
                const v = Number(bloomThreshold.value);
                if (Number.isFinite(v)) this.bloomThreshold = Math.max(0.0, Math.min(1000.0, v));
            };
            bloomThreshold.addEventListener('input', apply);
            bloomThreshold.addEventListener('change', () => { apply(); this._scheduleSaveSettings(); });
            apply();
        }
        const bloomRadius = document.getElementById('bloomRadius');
        if (bloomRadius) {
            const apply = () => {
                const v = Number(bloomRadius.value);
                if (Number.isFinite(v)) this.bloomRadius = Math.max(0.0, Math.min(8.0, v));
            };
            bloomRadius.addEventListener('input', apply);
            bloomRadius.addEventListener('change', () => { apply(); this._scheduleSaveSettings(); });
            apply();
        }
        const tod = document.getElementById('timeOfDay');
        if (tod) {
            const apply = () => {
                const v = Number(tod.value);
                if (Number.isFinite(v)) this.timeOfDayHours = Math.max(0.0, Math.min(24.0, v));
            };
            tod.addEventListener('input', apply);
            tod.addEventListener('change', apply);
            apply();
        }

        // Camera speed slider (~0.1..200 where 10 => 1.0x multiplier on Camera.moveSpeed)
        const camSpeed = document.getElementById('cameraSpeedPct');
        const camSpeedValue = document.getElementById('cameraSpeedValue');
        if (camSpeed) {
            const apply = () => {
                const v = Number(camSpeed.value);
                const vv = Number.isFinite(v) ? Math.max(0.1, Math.min(200.0, v)) : 10.0;
                const m = vv / 10.0; // 10 => 1.0x, 200 => 20x
                this.camera.moveSpeed = this._baseCameraMoveSpeed * m;
                if (camSpeedValue) {
                    const vvText = vv.toFixed(1).replace(/\.0$/, '');
                    const mText = (m < 1.0 ? m.toFixed(2) : m.toFixed(1)).replace(/\.0$/, '');
                    camSpeedValue.textContent = `${vvText} (${mText}×)`;
                }
            };
            camSpeed.addEventListener('input', apply);
            camSpeed.addEventListener('change', apply);
            apply();
        }

        // Reset camera (full map framing)
        const resetCam = document.getElementById('resetCamera');
        if (resetCam) {
            resetCam.addEventListener('click', () => {
                try { this.resetCameraToFullMap(); } catch { /* ignore */ }
            });
        }

        // Teleport camera (viewer-space coords)
        const tpInput = document.getElementById('teleportCoords');
        const tpBtn = document.getElementById('teleportCamera');
        const doTeleport = () => {
            const v = this._parseVec3Any(tpInput?.value);
            if (!v) {
                console.warn('Teleport: could not parse coords. Expected vec3(x,y,z) or x y z.');
                return;
            }
            const ok = this.teleportCameraToViewer(v);
            if (!ok) console.warn('Teleport: invalid coords.');
        };
        if (tpBtn) tpBtn.addEventListener('click', () => { try { doTeleport(); } catch { /* ignore */ } });
        if (tpInput) {
            tpInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    try { doTeleport(); } catch { /* ignore */ }
                }
            });
        }
    }

    _getSceneBoundsViewForMap() {
        // Prefer terrain AABB (most reliable), then building mesh bounds.
        const tb = this.terrainRenderer?.sceneBoundsView;
        if (tb && tb.min && tb.max) return tb;
        const bb = this.buildingRenderer?.boundsView;
        if (bb && bb.min && bb.max) return bb;
        return null;
    }

    resetCameraToFullMap() {
        // If we are in character view, exit first so follow/gameplay camera doesn't instantly override.
        try {
            if (this.player?.enabled) this.exitCharacterView();
        } catch { /* ignore */ }

        // Ensure we are not in ped-follow mode (otherwise update() will immediately lock to ped).
        this.followPed = false;
        this.controlPed = false;
        this._followPedYSmoothed = null;
        try {
            const follow = document.getElementById('followPed');
            if (follow) follow.checked = false;
            const control = document.getElementById('controlPed');
            if (control) control.checked = false;
        } catch { /* ignore */ }

        const b = this._getSceneBoundsViewForMap();
        if (b) {
            this.camera.frameAABB(b.min, b.max);
            // Reset map-ish defaults.
            this.camera.setFovDegrees?.(45.0);
            this.camera.setZoomLimits?.(1.0, 80000.0);
            return;
        }

        // Fallback to the camera constructor defaults.
        this.camera.position[0] = 10000;
        this.camera.position[1] = 8000;
        this.camera.position[2] = 10000;
        this.camera.target[0] = 0;
        this.camera.target[1] = 0;
        this.camera.target[2] = 0;
        this.camera.setFovDegrees?.(45.0);
        this.camera.setZoomLimits?.(1.0, 80000.0);
        this.camera.updateViewMatrix();
    }

    _clampMapViewCameraToBounds() {
        // Only clamp in map view (not in ped follow); follow mode intentionally overrides the camera pose.
        if (this.followPed && this.ped) return;

        const b = this._getSceneBoundsViewForMap();
        if (!b || !b.min || !b.max) return;
        const mn = b.min;
        const mx = b.max;
        if (!(mn.length >= 3 && mx.length >= 3)) return;

        // Horizontal bounds (viewer XZ plane). Keep a small margin so clamping doesn't feel sticky at edges.
        const sx = Math.max(1.0, (mx[0] - mn[0]));
        const sz = Math.max(1.0, (mx[2] - mn[2]));
        const marginX = Math.max(250.0, sx * 0.05);
        const marginZ = Math.max(250.0, sz * 0.05);
        const minX = mn[0] - marginX;
        const maxX = mx[0] + marginX;
        const minZ = mn[2] - marginZ;
        const maxZ = mx[2] + marginZ;

        // IMPORTANT: clamp based on CAMERA POSITION, not target.
        // If we clamp the target, click+drag rotation (which changes target) would cause camera translation,
        // which feels like "dragging moves location". WASD should be responsible for translation.
        const px0 = this.camera.position[0];
        const pz0 = this.camera.position[2];
        const px = Math.max(minX, Math.min(maxX, px0));
        const pz = Math.max(minZ, Math.min(maxZ, pz0));
        const dx = px - px0;
        const dz = pz - pz0;
        if (dx !== 0.0 || dz !== 0.0) {
            // Translate both position and target to preserve view direction while keeping the camera "over the map".
            this.camera.position[0] += dx;
            this.camera.position[2] += dz;
            this.camera.target[0] += dx;
            this.camera.target[2] += dz;
            this.camera.updateViewMatrix();
        }
    }

    _updateMapViewClipPlanes() {
        // Fix: when we frame the whole map (frameAABB), nearPlane can become huge and then
        // close geometry gets clipped when you zoom in. Keep clip planes responsive to distance.
        if (this.followPed && this.ped) return; // follow/ped mode manages clip planes separately

        const d = this.camera.getDistance?.() ?? glMatrix.vec3.distance(this.camera.position, this.camera.target);
        const dist = Number(d);
        if (!Number.isFinite(dist) || dist <= 0.01) return;

        // Heuristic tuned for GTA-scale viewing:
        // - near: small enough for close inspection, but grows with distance to preserve depth precision.
        // - far: large enough for full-map view, but not insanely large when close (avoids z-fighting).
        const near = Math.max(0.05, Math.min(10.0, dist * 0.001));    // dist=100 -> 0.1, 1k -> 1, 10k -> 10
        const far = Math.max(5000.0, Math.min(1000000.0, dist * 600)); // dist=1k -> 600k, dist=10k -> 1M (clamped)
        this.camera.setClipPlanes?.(near, far);
    }

    _keepMapViewCameraAboveTerrain() {
        // In map view you can fly the camera below the terrain (e.g. holding E).
        // Keep camera + target above terrain in DATA space by lifting both together.
        if (this.followPed && this.ped) return;
        if (!this.terrainRenderer?.getHeightAtXY) return;

        const posD = this._viewerPosToDataPos(this.camera.position);
        const tgtD = this._viewerPosToDataPos(this.camera.target);
        if (!posD || !tgtD) return;

        const px = Number(posD[0]), py = Number(posD[1]), pz = Number(posD[2]);
        const tx = Number(tgtD[0]), ty = Number(tgtD[1]), tz = Number(tgtD[2]);
        if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return;
        if (!Number.isFinite(tx) || !Number.isFinite(ty) || !Number.isFinite(tz)) return;

        const hPos = this.terrainRenderer.getHeightAtXY(px, py);
        const hp = (hPos === null || hPos === undefined) ? NaN : Number(hPos);

        // Clearances in DATA-space Z units (GTA-ish). Keep a tiny cushion to avoid z-fighting/going underground.
        const posClear = 2.0;

        let raise = 0.0;
        if (Number.isFinite(hp)) raise = Math.max(raise, (hp + posClear) - pz);

        if (!(raise > 0.0)) return;
        // Avoid absurd lifts from bad samples.
        raise = Math.min(5000.0, raise);

        const posV = this._dataToViewer([px, py, pz + raise]);
        const tgtV = this._dataToViewer([tx, ty, tz + raise]);
        if (!posV || !tgtV) return;

        this.camera.position[0] = posV[0]; this.camera.position[1] = posV[1]; this.camera.position[2] = posV[2];
        this.camera.target[0] = tgtV[0]; this.camera.target[1] = tgtV[1]; this.camera.target[2] = tgtV[2];
        this.camera.updateViewMatrix();
    }
    
    resize() {
        // Update canvas size
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        
        // Update camera
        this.camera.resize(this.canvas.width, this.canvas.height);
        
        // Update viewport
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        
        console.log(`Canvas resized to ${this.canvas.width}x${this.canvas.height}`);
    }
    
    update() {
        // Delta time (seconds), clamped to avoid huge jumps on tab-switch.
        const now = performance.now();
        const dt = Math.max(0.001, Math.min(0.05, (now - this._lastFrameMs) / 1000.0));
        this._lastFrameMs = now;

        // Perf HUD timing
        this._perfDtMs = dt * 1000.0;
        const fps = 1.0 / dt;
        this._fpsEma = (this._fpsEma === null || this._fpsEma === undefined) ? fps : (this._fpsEma * 0.9 + fps * 0.1);

        // Handle keyboard input
        const moveDir = glMatrix.vec3.create();
        const moveSpeed = this.keyState['shift'] ? 2.5 : 1.0;
        
        if (this.keyState['w']) moveDir[2] -= moveSpeed;
        if (this.keyState['s']) moveDir[2] += moveSpeed;
        if (this.keyState['a']) moveDir[0] -= moveSpeed;
        if (this.keyState['d']) moveDir[0] += moveSpeed;
        if (this.keyState['q']) moveDir[1] += moveSpeed;
        if (this.keyState['e']) moveDir[1] -= moveSpeed;
        
        if (glMatrix.vec3.length(moveDir) > 0) {
            glMatrix.vec3.normalize(moveDir, moveDir);
            if (this.controlPed && this.ped) {
                // Move ped in data space relative to camera facing (character-like).
                const sprint = !!this.keyState['shift'];
                const speed = sprint ? 240.0 : 140.0; // units per second in GTA/data space-ish

                // Build a horizontal forward/right basis from camera direction.
                const fwdView = glMatrix.vec3.fromValues(this.camera.direction[0], this.camera.direction[1], this.camera.direction[2]);
                fwdView[1] = 0.0; // keep movement on ground plane (viewer-space up is Y)
                if (glMatrix.vec3.length(fwdView) < 1e-5) fwdView[2] = -1.0;
                glMatrix.vec3.normalize(fwdView, fwdView);
                const rightView = glMatrix.vec3.create();
                glMatrix.vec3.cross(rightView, fwdView, this.camera.up);
                glMatrix.vec3.normalize(rightView, rightView);

                const fwdData = this._viewerDirToDataDir(fwdView);
                const rightData = this._viewerDirToDataDir(rightView);

                // moveDir: x=left/right, z=forward/back (per key mapping above)
                const vx = (moveDir[0] * rightData[0] + moveDir[2] * fwdData[0]) * speed * dt;
                const vy = (moveDir[0] * rightData[1] + moveDir[2] * fwdData[1]) * speed * dt;
                const vz = (moveDir[0] * rightData[2] + moveDir[2] * fwdData[2]) * speed * dt;

                this.ped.posData[0] += vx;
                this.ped.posData[1] += vy;
                this.ped.posData[2] += vz;

                // Track last movement direction in data space (for player mesh heading).
                if (this.player) this.player._lastMoveDirData = [vx, vy, vz];

                const hz = this.terrainRenderer.getHeightAtXY?.(this.ped.posData[0], this.ped.posData[1]);
                if (hz !== null && hz !== undefined) this.ped.posData[2] = hz + this.pedEyeHeightData;
                this.pedRenderer.setPositions([this.ped.posData]);
            } else {
                // Map view (not following a ped): fly camera in the air (move along look direction).
                // Ped view/follow: keep WASD level to avoid unwanted bobbing while orbiting around the character.
                // Only flatten in *actual* ped-follow mode (a ped exists). The UI defaults "Follow ped" to checked,
                // but in the default map view there is no ped, and movement should be true fly (move along look).
                const flattenForward = !!(this.followPed && this.ped);
                this.camera.move(moveDir, dt, { flattenForward });
            }
        }

        // If following a spawned ped, keep target locked to it.
        if (this.followPed && this.ped) {
            // Tighten camera for close-up character-level viewing.
            // (This avoids the old 5km min zoom / huge near plane behavior.)
            this.camera.setFovDegrees?.(60.0);
            this.camera.setZoomLimits?.(2.0, 20000.0);

            // Use distance-based clip planes so the ped feels correctly scaled and doesn't clip.
            // Keeping far plane somewhat bounded improves depth precision near the player.
            const d = this.camera.getDistance?.() ?? glMatrix.vec3.distance(this.camera.position, this.camera.target);
            const near = Math.max(0.05, Math.min(2.0, d * 0.02));      // e.g. d=50 -> near=1.0; d=10 -> 0.2
            const far = Math.max(5000.0, Math.min(80000.0, d * 1200.0)); // e.g. d=50 -> far=60000
            this.camera.setClipPlanes?.(near, far);

            if (this.gameplayCamEnabled) {
                this._updateGameplayCamera(dt);
            } else {
                this.ped.posView = this._dataToViewer(this.ped.posData);

                // Smooth vertical component to reduce bobbing while walking over terrain.
                if (!Number.isFinite(this._followPedYSmoothed)) this._followPedYSmoothed = this.ped.posView[1];
                const ySharp = Number.isFinite(Number(this._followPedYSharpness)) ? Number(this._followPedYSharpness) : 18.0;
                const ay = 1.0 - Math.exp(-Math.max(1.0, ySharp) * Math.max(0.001, dt));
                this._followPedYSmoothed = this._followPedYSmoothed * (1 - ay) + this.ped.posView[1] * ay;
                this.ped.posView[1] = this._followPedYSmoothed;

                this.camera.lookAtPoint(this.ped.posView);
                this.camera.position[0] = this.ped.posView[0] + this.ped.camOffset[0];
                this.camera.position[1] = this.ped.posView[1] + this.ped.camOffset[1];
                this.camera.position[2] = this.ped.posView[2] + this.ped.camOffset[2];
                this.camera.updateViewMatrix();
            }
        }

        // Map-view guardrails: keep the camera from drifting far away from the world bounds.
        // This is intentionally light-touch: it only clamps the horizontal (XZ) target/position.
        try { this._clampMapViewCameraToBounds(); } catch { /* ignore */ }

        // Map-view grounding: keep camera above the terrain so the viewer doesn't end up underground.
        try { this._keepMapViewCameraAboveTerrain(); } catch { /* ignore */ }

        // Map-view clip planes: prevent near-plane clipping of close meshes after map framing/zooming.
        try { this._updateMapViewClipPlanes(); } catch { /* ignore */ }

        // Keep the player mesh instance updated (single-instance archetype render).
        try { this._syncPlayerEntityMesh(false); } catch { /* ignore */ }

        // Stream entities based on camera (client-like chunk loading)
        if (this.entityReady) {
            const center = (!this.streamFromCamera && this.followPed && this.ped) ? this.ped.posData : null;
            this.entityStreamer.update(this.camera, this.entityRenderer, center);
        }

        // Stream drawables based on camera (requires exported meshes manifest)
        if (this.showModels && this.modelsInitialized) {
            const center = (!this.streamFromCamera && this.followPed && this.ped) ? this.ped.posData : null;
            try { this.entityStreamer?.setTimeWeather?.({ hour: this.timeOfDayHours, weather: this.weatherType }); } catch { /* ignore */ }
            try { this.drawableStreamer?.setTimeWeather?.({ hour: this.timeOfDayHours, weather: this.weatherType }); } catch { /* ignore */ }
            this.drawableStreamer.update(this.camera, center);
        }

        // Streaming debug HUD (helps diagnose "nothing loaded")
        if (this._streamDebugEl) {
            const eLoaded = this.entityStreamer?.loaded?.size ?? 0;
            const eLoading = this.entityStreamer?.loading?.size ?? 0;
            const eChunks = this.entityRenderer?.chunkBuffers?.size ?? 0;
            const es = this.entityStreamer?.stats || null;
            const dLoaded = this.drawableStreamer?.loaded?.size ?? 0;
            const dLoading = this.drawableStreamer?.loading?.size ?? 0;
            const mCount = (this.modelsInitialized && this.modelManager?.manifest?.meshes)
                ? Object.keys(this.modelManager.manifest.meshes).length
                : 0;
            const modelsOn = !!this.showModels;
            const cov = this.drawableStreamer?.getCoverageStats?.();
            const covLine = cov
                ? (
                    `Coverage (loaded area): missing=${cov.missingEntities ?? 0}/${cov.missingArchetypes ?? 0} ` +
                    `unexported(placeholders)=${cov.unexportedEntities ?? 0}/${cov.unexportedArchetypes ?? 0} ` +
                    `cappedInstances=${cov.droppedInstances ?? 0} ` +
                    `cappedArchetypes=${cov.droppedArchetypes ?? 0}`
                )
                : 'Coverage (loaded area): n/a';

            this._streamDebugEl.textContent =
                `Entities: ready=${!!this.entityReady} chunks=${eChunks} loaded=${eLoaded} loading=${eLoading} dots=${!!this.showEntityDots}` +
                (es ? ` started=${es.started ?? 0} ok=${es.loaded ?? 0} abort=${es.aborted ?? 0} fail=${es.failed ?? 0}` : '') +
                (es && es.lastError ? ` lastErr=${String(es.lastError).slice(0, 80)}` : '') +
                `\n` +
                `Drawables: on=${modelsOn} initialized=${!!this.modelsInitialized} manifestMeshes=${mCount} loaded=${dLoaded} loading=${dLoading}\n` +
                covLine;
        }

        // Live camera coords HUD (copy/paste friendly)
        if (this._liveCoordsEl) {
            const pv = this.camera?.position || [0, 0, 0];
            const pd = this._viewerPosToDataPos(pv);
            const fmt3 = (v) => `${v[0].toFixed(3)}, ${v[1].toFixed(3)}, ${v[2].toFixed(3)}`;
            this._liveCoordsEl.value =
                `viewer: vec3(${fmt3(pv)})\n` +
                `data:   vec3(${fmt3(pd)})\n` +
                `data vector4: vector4(${pd[0].toFixed(4)}, ${pd[1].toFixed(4)}, ${pd[2].toFixed(4)}, 0.0)`;
        }

        // Debug readout for spawned ped grounding.
        if (this._pedDebugEl && this._pedGroundingDebug) {
            const d = this._pedGroundingDebug;
            const gz = (d.groundZ === null || d.groundZ === undefined) ? 'n/a' : d.groundZ.toFixed(2);
            const iz = (d.interiorFloorZ === null || d.interiorFloorZ === undefined) ? 'n/a' : d.interiorFloorZ.toFixed(2);
            const dz = Number.isFinite(d.desiredZ) ? d.desiredZ.toFixed(2) : 'n/a';
            const mode = d.usedInterior ? 'interior' : (d.usedGround ? 'terrain' : 'kept');
            this._pedDebugEl.textContent = `Z desired=${dz} | ground=${gz} | interiorFloor=${iz} | final=${d.finalZ.toFixed(2)} | ${mode}`;
        } else if (this._pedDebugEl) {
            this._pedDebugEl.textContent = '';
        }

        // Persist view state so refresh restores quickly.
        this._maybeSaveViewToStorage();
    }
    
    render() {
        // Color pipeline note:
        // The UI stores colors in sRGB-ish space (what humans pick), but our shaders do lighting/fog math in *linear*.
        // Passing sRGB colors directly into linear math causes an overly strong blue/purple cast (especially fog/env).
        const _srgbToLinear1 = (c) => {
            const x = Math.max(0, Math.min(1, Number(c) || 0));
            return (x <= 0.04045) ? (x / 12.92) : Math.pow((x + 0.055) / 1.055, 2.4);
        };
        const _srgbToLinear3 = (rgb) => {
            const r = Array.isArray(rgb) ? rgb : [0.6, 0.7, 0.8];
            return [_srgbToLinear1(r[0]), _srgbToLinear1(r[1]), _srgbToLinear1(r[2])];
        };
        const fogColorLinear = _srgbToLinear3(this.fogColor || [0.6, 0.7, 0.8]);

        // Per-frame texture visibility/distance policy (models call textureStreamer.touch(...) while drawing).
        try { this.textureStreamer?.beginFrame?.(); } catch { /* ignore */ }

        // Optional GPU timer (only when Perf HUD is enabled).
        if (this.enablePerfHud) {
            try { this._gpuTimer?.beginFrame?.(); } catch { /* ignore */ }
        }

        // Optional CodeWalker-like post FX:
        // render the whole scene into an offscreen framebuffer in linear space, then tonemap+encode once.
        const postFxReady = !!(this.enablePostFx && this.postFx && this.postFx.ready);
        let sceneFbo = null;
        if (postFxReady) {
            try {
                this.postFx.enabled = true;
                this.postFx.exposure = this.postFxExposure;
                this.postFx.avgLum = this.postFxLum;
                this.postFx.enableAutoExposure = !!this.enableAutoExposure;
                this.postFx.autoExposureSpeed = this.autoExposureSpeed;
                this.postFx.enableBloom = !!this.enableBloom;
                this.postFx.bloomStrength = this.bloomStrength;
                this.postFx.bloomThreshold = this.bloomThreshold;
                this.postFx.bloomRadius = this.bloomRadius;
                sceneFbo = this.postFx.beginScene({ w: this.canvas.width, h: this.canvas.height });
            } catch {
                sceneFbo = null;
            }
        }

        // PostFX is only "active" if we successfully acquired a scene framebuffer.
        // If beginScene() failed (sceneFbo==null), we must NOT run tonemap this frame (avoids flicker / double pipeline).
        const postFxOn = !!(postFxReady && sceneFbo);
        try { if (this.postFx) this.postFx.enabled = postFxOn; } catch { /* ignore */ }

        if (!postFxOn) {
            // Clear buffers first (default framebuffer).
            this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
            this.gl.clearColor(0.0, 0.0, 0.0, 1.0);
            this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
        }

        // --- Global lighting (best-effort CodeWalker-ish) ---
        // We derive a simple directional light from time-of-day and pass it into renderers.
        // This also helps the HDR tonemap/bloom path because scene values become meaningfully > 1.0 at daytime.
        const t01 = (this.timeOfDayHours % 24.0) / 24.0;
        const ang = (t01 * Math.PI * 2.0) - (Math.PI * 0.5); // noon-ish up
        const sunDirRaw = [Math.cos(ang) * 0.35, Math.sin(ang) * 0.95, 0.20];
        const n3 = (v) => {
            const x = Number(v?.[0]) || 0, y = Number(v?.[1]) || 0, z = Number(v?.[2]) || 0;
            const l = Math.hypot(x, y, z) || 1.0;
            return [x / l, y / l, z / l];
        };
        const sunDir = n3(sunDirRaw);
        const sunUp = Math.sin(ang); // -1..1
        const day01 = Math.max(0.0, Math.min(1.0, (sunUp * 0.55) + 0.45));
        // Intensity in linear HDR-ish units. (CodeWalker scene is HDR; tonemap expects this.)
        const sunI = Math.max(0.03, day01 * 1.15);
        const sunCol = [1.0, 0.97, 0.88];
        const lightColor = [sunCol[0] * sunI * 2.5, sunCol[1] * sunI * 2.5, sunCol[2] * sunI * 2.5];
        // Ambient term: used as a scalar in our forward shaders and as additive irradiance in terrain deferred.
        const ambientIntensity = 0.08 + 0.35 * day01;

        // Draw sky gradient (atmosphere). This is a pure background pass.
        if (this.atmosphereEnabled && this.skyRenderer?.ready) {
            // Simple timecycle-ish sky colors (blend between a night palette and the configured day palette).
            const nightTop = [0.02, 0.03, 0.06];
            const nightBottom = [0.01, 0.02, 0.03];
            const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
            const topColorSrgb = lerp3(nightTop, this.skyTopColor, day01);
            const bottomColorSrgb = lerp3(nightBottom, this.skyBottomColor, day01);

            // IMPORTANT:
            // SkyRenderer outputs *linear* (it does no encode). For PostFX/HDR we must feed linear values.
            // The UI stores colors in sRGB-ish space, so convert here.
            const topColor = _srgbToLinear3(topColorSrgb);
            const bottomColor = _srgbToLinear3(bottomColorSrgb);

            // Moon is opposite the sun in this simple model.
            const moonDir = [-sunDir[0], -sunDir[1], -sunDir[2]];
            const moonI = Math.max(0.0, (1.0 - day01) * 0.35);
            const starI = Math.max(0.0, (1.0 - day01) * 0.85);
            this.skyRenderer.render({
                topColor,
                bottomColor,
                sunDir,
                // Treat these UI-ish colors as sRGB and convert to linear for the shader.
                sunColor: _srgbToLinear3(sunCol),
                sunIntensity: sunI,
                moonDir,
                moonColor: _srgbToLinear3([0.70, 0.78, 0.90]),
                moonIntensity: moonI,
                starIntensity: starI,
            });
        }
        
        // Enable depth testing
        this.gl.enable(this.gl.DEPTH_TEST);
        
        // Check for WebGL errors
        const error = this.gl.getError();
        if (error !== this.gl.NO_ERROR) {
            console.error('WebGL error before render:', error);
        }
        
        // Render terrain (heightmap)
        const outputSrgb = !postFxOn;

        if (this.showTerrain) {
            // Tell TerrainRenderer where to composite (default vs offscreen) and whether to encode.
            try { this.terrainRenderer?.setOutputFramebuffer?.(sceneFbo); } catch { /* ignore */ }
            this.terrainRenderer.render(this.camera.viewProjectionMatrix, this.camera.position, {
                enabled: this.atmosphereEnabled && this.fogEnabled,
                color: fogColorLinear,
                start: this.fogStart,
                end: this.fogEnd,
                lightDir: sunDir,
                lightColor,
                ambientIntensity,
                outputSrgb,
            });
        }

        // Render buildings/city geometry
        if (this.buildingRenderer?.ready) {
            this.buildingRenderer.render(
                this.camera.viewProjectionMatrix,
                this.showBuildings,
                {
                    showWater: this.showWater,
                    waterAlpha: 0.35,
                    waterEps: 0.05,
                    fog: {
                        enabled: this.atmosphereEnabled && this.fogEnabled,
                        color: fogColorLinear,
                        start: this.fogStart,
                        end: this.fogEnd,
                        lightDir: sunDir,
                        lightColor,
                        ambientIntensity,
                    },
                    cameraPos: this.camera.position,
                }
            );
        }

        // Render real models
        if (this.showModels && this.modelsInitialized && this.instancedModelRenderer?.ready) {
            // Optional occlusion depth prepass (terrain/buildings) into an offscreen depth buffer.
            // This MUST happen before we ask InstancedModelRenderer to cull by depth.
            if (this.enableOcclusionCulling && this.occlusionCuller) {
                this.occlusionCuller.enabled = true;
                this.occlusionCuller.buildDepth({
                    viewProjectionMatrix: this.camera.viewProjectionMatrix,
                    drawOccluders: () => {
                        // Use current scene toggles as occluders; water is excluded (transparent).
                        if (this.showTerrain) {
                            // IMPORTANT: OcclusionCuller binds its own depth-only framebuffer.
                            // Do NOT call the full terrain render path here (it may bind/composite other FBOs).
                            this.terrainRenderer.renderDepthOnly?.(this.camera.viewProjectionMatrix);
                        }
                        if (this.buildingRenderer?.ready && this.showBuildings) {
                            this.buildingRenderer.render(
                                this.camera.viewProjectionMatrix,
                                true,
                                {
                                    showWater: false,
                                    waterAlpha: 0.0,
                                    waterEps: 0.05,
                                    fog: { enabled: false, color: this.fogColor, start: this.fogStart, end: this.fogEnd },
                                    cameraPos: this.camera.position,
                                }
                            );
                        }
                    },
                });

                // If the GPU/browser rejects *all* occlusion readback modes, auto-disable occlusion culling
                // so users don't think rendering/streaming is "stuck" (occlusion is optional).
                try {
                    const s = this.occlusionCuller.getStats?.();
                    if (s && s.readbackSupported === false) {
                        this.enableOcclusionCulling = false;
                        const occEl = document.getElementById('enableOcclusionCulling');
                        if (occEl) occEl.checked = false;
                        console.warn('OcclusionCuller: disabling occlusion culling (depth readback unsupported on this GPU/browser).');
                    }
                } catch { /* ignore */ }
            } else if (this.occlusionCuller) {
                this.occlusionCuller.enabled = false;
            }

            // IMPORTANT:
            // Some renderers (occlusion, terrain deferred, etc) may bind their own FBO/viewport temporarily.
            // Ensure models always render into the intended scene target (PostFX scene FBO when enabled).
            try {
                this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, sceneFbo || null);
                this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
            } catch { /* ignore */ }

            this.instancedModelRenderer.render(this.camera.viewProjectionMatrix, this.showModels, this.camera.position, {
                enabled: this.atmosphereEnabled && this.fogEnabled,
                color: fogColorLinear,
                start: this.fogStart,
                end: this.fogEnd,
                lightDir: sunDir,
                lightColor,
                ambientIntensity,
                // Use the same UI toggle for BOTH building-water and model-water materials.
                // This lets us isolate whether water shaders are causing the "grey screen when drawables render" issue.
                showWater: !!this.showWater,
                // Directional shadow map (optional; experimental)
                shadowEnabled: !!this.enableShadows,
                shadowMapSize: Number(this.shadowMapSize) || 2048,
                occlusion: (this.enableOcclusionCulling ? this.occlusionCuller : null),
                viewportWidth: this.canvas.width,
                viewportHeight: this.canvas.height,
                outputSrgb,
            });

            // Kick texture streaming even if the first few frames are mesh-bound or camera is far away.
            // This also helps diagnose "Tex cache stays 0" quickly: if we have submeshes with diffuse paths,
            // this will schedule loads regardless of whether the camera is currently drawing them.
            try {
                if (!this._lastTexPrefetchMs) this._lastTexPrefetchMs = 0;
                const now = performance.now();
                if (now - this._lastTexPrefetchMs > 900) {
                    this._lastTexPrefetchMs = now;
                    this.instancedModelRenderer.prefetchDiffuseTextures?.(256);
                }
            } catch { /* ignore */ }
        }

        // Render streamed entities on top
        if (this.entityReady && this.showEntityDots) {
            // Point size scales slightly with zoom distance
            const dist = this.camera.getDistance();
            const pt = Math.max(2.0, Math.min(6.0, dist / 6000.0));
            if (this.entityDotsOverlay) {
                // Overlay mode: visible even for underground/interior entities.
                const depthWasEnabled = this.gl.isEnabled(this.gl.DEPTH_TEST);
                const depthMaskWas = this.gl.getParameter(this.gl.DEPTH_WRITEMASK);
                if (depthWasEnabled) this.gl.disable(this.gl.DEPTH_TEST);
                this.gl.depthMask(false);
                this.entityRenderer.render(this.camera.viewProjectionMatrix, pt);
                this.gl.depthMask(depthMaskWas);
                if (depthWasEnabled) this.gl.enable(this.gl.DEPTH_TEST);
            } else {
                // Depth-tested mode: dots respect scene depth (doesn't obscure meshes).
                this.entityRenderer.render(this.camera.viewProjectionMatrix, pt);
            }
        }

        // Render the spawned ped marker last
        if (this.ped && this.pedRenderer?.ready) {
            const dist = this.camera.getDistance();
            const pt = Math.max(6.0, Math.min(18.0, dist / 1200.0));
            // Render as overlay for the same reason as entity dots.
            const depthWasEnabled = this.gl.isEnabled(this.gl.DEPTH_TEST);
            if (depthWasEnabled) this.gl.disable(this.gl.DEPTH_TEST);
            this.pedRenderer.render(this.camera.viewProjectionMatrix, pt, [0.15, 0.8, 1.0, 1.0]);
            if (depthWasEnabled) this.gl.enable(this.gl.DEPTH_TEST);
        }
        
        // If postFX is enabled (and active), tonemap+encode to the canvas now.
        if (postFxOn) {
            try {
                this.postFx.endScene({ canvasW: this.canvas.width, canvasH: this.canvas.height });
            } catch { /* ignore */ }
        }

        // Check for WebGL errors after render
        const errorAfter = this.gl.getError();
        if (errorAfter !== this.gl.NO_ERROR) {
            console.error('WebGL error after render:', errorAfter);
            // If models are enabled and the model renderer recorded a culprit drawable, surface it here too.
            try {
                const e = this.instancedModelRenderer?._lastGlError || null;
                if (e) console.error('InstancedModelRenderer last GL error detail:', e);
            } catch { /* ignore */ }
        }

        // End-of-frame: allow streamer to do eviction/housekeeping.
        try { this.textureStreamer?.endFrame?.(); } catch { /* ignore */ }

        if (this.enablePerfHud) {
            try { this._gpuTimer?.endFrame?.(); } catch { /* ignore */ }
            try { this._gpuTimer?.poll?.(); } catch { /* ignore */ }
            try { this._updatePerfHud?.(); } catch { /* ignore */ }
        }
    }

    _formatBytes(n) {
        const v = Number(n);
        if (!Number.isFinite(v) || v <= 0) return '0 B';
        const kb = 1024;
        const mb = kb * 1024;
        const gb = mb * 1024;
        if (v >= gb) return `${(v / gb).toFixed(2)} GB`;
        if (v >= mb) return `${(v / mb).toFixed(2)} MB`;
        if (v >= kb) return `${(v / kb).toFixed(2)} KB`;
        return `${Math.floor(v)} B`;
    }

    _updatePerfHud() {
        const el = this._perfHudEl;
        if (!el || !this.enablePerfHud) return;
        const now = performance.now();
        if (now - (this._perfHudLastUpdateMs || 0) < 200) return;
        this._perfHudLastUpdateMs = now;

        const dtMs = Number(this._perfDtMs) || 0;
        const fpsAvg = Number(this._fpsEma) || 0;
        const gpuMs = Number(this._gpuTimer?.lastMs);

        const r = this.instancedModelRenderer?.getRenderStats?.() || null;
        const occ = this.instancedModelRenderer?._occlusionStats || null;
        const mesh = this.modelManager?.getMeshCacheStats?.() || null;
        const tex = this.textureStreamer?.getStats?.() || null;

        const lines = [];
        lines.push(`Frame: ${dtMs.toFixed(2)} ms  |  FPS(avg): ${fpsAvg.toFixed(1)}${Number.isFinite(gpuMs) ? `  |  GPU: ${gpuMs.toFixed(2)} ms` : ''}`);

        if (r) {
            lines.push(
                `Models: draws=${r.drawCalls ?? 0} items=${r.drawItems ?? 0} ` +
                `buckets=${r.bucketDraws ?? 0} submeshes=${r.submeshDraws ?? 0}`
            );
            lines.push(`        inst=${r.instances ?? 0} tris≈${r.triangles ?? 0}${occ ? `  |  occ tested=${occ.tested ?? 0} culled=${occ.culled ?? 0}` : ''}`);
            // Texture diagnostics:
            if (r.diffuseWanted !== undefined) {
                lines.push(
                    `        tex(diffuse): wanted=${r.diffuseWanted ?? 0} real=${r.diffuseReal ?? 0} placeholder=${r.diffusePlaceholder ?? 0} missingUvItems=${r.drawItemsMissingUv ?? 0}`
                );
            }
        } else {
            lines.push('Models: n/a');
        }

        if (mesh) {
            lines.push(`Mesh cache: count=${mesh.count ?? 0}  bytes≈${this._formatBytes(mesh.approxBytes ?? 0)} / ${this._formatBytes(mesh.maxBytes ?? 0)}  evict=${mesh.evictions ?? 0}`);
        }
        if (tex) {
            lines.push(`Tex cache:  count=${tex.textures ?? 0}  bytes≈${this._formatBytes(tex.bytes ?? 0)} / ${this._formatBytes(tex.maxBytes ?? 0)}  evict=${tex.evictions ?? 0}`);
            if (tex.lastErrorUrl || tex.lastErrorMsg) {
                const u = tex.lastErrorUrl ? String(tex.lastErrorUrl) : 'n/a';
                const m = tex.lastErrorMsg ? String(tex.lastErrorMsg) : 'n/a';
                lines.push(`Tex lastError: ${u} | ${m}`);
            }
        }

        el.textContent = lines.join('\n');
    }
    
    animate() {
        this.update();
        this.render();
        requestAnimationFrame(() => this.animate());
    }

    /**
     * Best-effort teardown to release WebGL/Worker resources when navigating away.
     * (Not all browsers guarantee this runs, but it's cheap and helps long dev sessions.)
     */
    destroy() {
        try { this.drawableStreamer?.destroy?.(); } catch { /* ignore */ }
        // We could add more teardown here later (textures, buffers, etc.) if needed.
    }
}

// Start application when page loads
window.addEventListener('load', () => {
    const canvas = document.getElementById('glCanvas');
    const app = new App(canvas);
    // Tear down background workers when leaving the page.
    try {
        window.addEventListener('beforeunload', () => {
            try { app.destroy(); } catch { /* ignore */ }
        });
    } catch { /* ignore */ }
    // DevTools helpers for quick inspection / perf investigation.
    // Usage:
    //   await __viewerApp.ensureModelsInitialized()
    //   __viewerReportMaterialReuse({ lod: 'high', minCount: 10, limitGroups: 50 })
    try {
        window.__viewerApp = app;
        // Texture dump helper:
        // - If the local dump server is running (started by `webgl_viewer/run.py`), this will write to:
        //   webgl_viewer/tools/out/viewer_dumps/*.json
        // - Otherwise it falls back to downloading a JSON file.
        window.__viewerDumpTextures = async (opts = {}) => {
            try {
                const ts = app?.textureStreamer || null;
                if (!ts || typeof ts.buildDebugDump !== 'function') return null;
                const dump = ts.buildDebugDump({ reason: opts?.reason || 'manual' });
                const endpoint = (opts && typeof opts.endpoint === 'string')
                    ? opts.endpoint
                    : '/__viewer_dump';
                try {
                    if (typeof ts.postDebugDump === 'function') {
                        return await ts.postDebugDump(dump, { endpoint });
                    }
                } catch {
                    // fall through to download
                }
                try { if (typeof ts.downloadDebugDump === 'function') ts.downloadDebugDump(dump); } catch { /* ignore */ }
                return null;
            } catch {
                return null;
            }
        };
        window.__viewerSetCrossArchetypeInstancing = (on) => {
            try {
                const el = document.getElementById('crossArchetypeInstancing');
                if (el && el.type === 'checkbox') el.checked = !!on;
                // Re-apply streaming params so it takes effect immediately.
                app?._applyStreamingFromUI?.();
                return true;
            } catch {
                return false;
            }
        };
        window.__viewerReportMaterialReuse = (opts = {}) => {
            try {
                if (!app?.modelManager) {
                    console.warn('viewer: modelManager not ready');
                    return null;
                }
                const rep = app.modelManager.getMaterialReuseReport(opts || {});
                const top = rep?.groups || [];
                console.log(
                    `Material reuse report: scannedMeshes=${rep?.scannedMeshes ?? 0} ` +
                    `scannedSubmeshes=${rep?.scannedSubmeshes ?? 0} groupsShown=${top.length}`
                );
                console.table(top.map((g) => ({
                    uniqueFiles: g.uniqueFiles,
                    count: g.count,
                    sig: g.sig,
                    sample: (g.sample || []).slice(0, 3).map((x) => `${x.hash}:${x.lod}:${x.file}`).join(' | '),
                })));
                return rep;
            } catch (e) {
                console.error('viewer: report failed', e);
                return null;
            }
        };

        /**
         * Texture coverage dump (DevTools helper).
         *
         * This is the texture analogue of the mesh/archetype coverage dump:
         * - Scans the currently-loaded model manifest entries (loaded shards only).
         * - Counts referenced `models_textures/<hash>...` texture rel paths.
         * - Uses TexturePathResolver's loaded `models_textures/index.json` to classify "missing from exported set".
         * - Includes runtime missing-404 cache + recent decode/fetch errors from TextureStreamer.
         *
         * Usage:
         *   await __viewerDumpTextureCoverage()
         *   copy(JSON.stringify(await __viewerDumpTextureCoverage({ topN: 50 }), null, 2))
         */
        window.__viewerDumpTextureCoverage = async (opts = {}) => {
            const topN = Number.isFinite(Number(opts?.topN)) ? Math.max(1, Math.min(500, Math.floor(Number(opts.topN)))) : 50;
            const maxMeshes = Number.isFinite(Number(opts?.maxMeshes)) ? Math.max(1, Math.min(500000, Math.floor(Number(opts.maxMeshes)))) : 50000;
            const includeAllLods = !!opts?.includeAllLods;
            const lod = String(opts?.lod || 'high').toLowerCase();

            const mm = app?.modelManager;
            const imr = app?.instancedModelRenderer;
            const ts = app?.textureStreamer;

            // Best-effort wait for models_textures index to load (optional but improves missing classification).
            try {
                const r = imr?._texResolver;
                if (r && r._modelsTexturesIndexPromise) await r._modelsTexturesIndexPromise;
            } catch { /* ignore */ }

            const meshes = mm?.manifest?.meshes;
            if (!meshes || typeof meshes !== 'object') {
                return {
                    schema: 'webglgta-texture-coverage-v1',
                    error: 'model manifest not loaded',
                    textureStats: ts?.getStats?.() || null,
                    recentTextureErrors: ts?.getRecentErrors?.(25) || [],
                    missing404: ts?.getMissing404Summary?.(topN) || [],
                };
            }

            const resolver = imr?._texResolver || null;
            const seenByRel = new Map(); // rel -> count
            const missingFromIndex = new Map(); // hash -> { count, sampleRel }

            let scannedMeshes = 0;
            let scannedSubmeshes = 0;

            const bumpRel = (rel) => {
                const k = String(rel || '').trim();
                if (!k) return;
                seenByRel.set(k, (seenByRel.get(k) || 0) + 1);
            };

            const considerMissing = (rel) => {
                const r = String(rel || '').trim();
                if (!r) return;
                // Only handle model textures here.
                if (!/models_textures\//i.test(r)) return;
                const m = r.replace(/^\/+/, '').replace(/^assets\//i, '').match(/^models_textures\/(\d+)/i);
                const hash = m ? String(m[1]) : null;
                if (!hash) return;
                // If resolver exists and index is loaded, it returns null when index proves missing.
                try {
                    if (resolver && typeof resolver.chooseTextureUrl === 'function') {
                        const url = resolver.chooseTextureUrl(r);
                        if (url === null) {
                            const prev = missingFromIndex.get(hash) || { count: 0, sampleRel: r };
                            prev.count += 1;
                            if (!prev.sampleRel) prev.sampleRel = r;
                            missingFromIndex.set(hash, prev);
                        }
                    }
                } catch { /* ignore */ }
            };

            // Scan loaded manifest entries (loaded shards only).
            for (const [hash, entry] of Object.entries(meshes)) {
                scannedMeshes++;
                if (scannedMeshes > maxMeshes) break;
                if (!entry || typeof entry !== 'object') continue;

                const entryMat = entry.material ?? null;
                const lodKeys = includeAllLods
                    ? Object.keys(entry.lods || {}).map((k) => String(k || '').toLowerCase()).filter(Boolean)
                    : [lod];

                for (const lk of lodKeys) {
                    const subs = mm?.getLodSubmeshes?.(hash, lk) || [];
                    if (!Array.isArray(subs) || subs.length === 0) continue;
                    for (const sm of subs) {
                        scannedSubmeshes++;
                        const subMat = sm?.material ?? null;
                        // Effective material merge (same idea as renderer).
                        const eff = { ...(entryMat || {}), ...(subMat || {}) };

                        const keys = [
                            'diffuse', 'diffuse2', 'normal', 'spec', 'detail', 'ao', 'emissive', 'alphaMask',
                            // KTX2 variants (if present)
                            'diffuseKtx2', 'diffuse2Ktx2', 'normalKtx2', 'specKtx2', 'detailKtx2', 'aoKtx2', 'emissiveKtx2', 'alphaMaskKtx2',
                        ];
                        for (const k of keys) {
                            const rel = eff?.[k];
                            if (typeof rel !== 'string' || !rel) continue;
                            bumpRel(rel);
                            considerMissing(rel);
                        }
                    }
                }
            }

            const topMissing = Array.from(missingFromIndex.entries())
                .map(([hash, v]) => ({ hash, count: v.count | 0, sampleRel: v.sampleRel }))
                .sort((a, b) => (b.count - a.count) || (a.hash.localeCompare(b.hash)))
                .slice(0, topN);

            return {
                schema: 'webglgta-texture-coverage-v1',
                opts: { topN, maxMeshes, includeAllLods, lod },
                scannedMeshes,
                scannedSubmeshes,
                uniqueTextureRels: seenByRel.size,
                // Missing classification only covers model textures when models_textures/index.json is loaded.
                missingFromExportedSetTop: topMissing,
                // Runtime health:
                textureStats: ts?.getStats?.() || null,
                missing404: ts?.getMissing404Summary?.(topN) || [],
                recentTextureErrors: ts?.getRecentErrors?.(25) || [],
            };
        };

        // Frame-level texture dump (what the renderer actually used this frame).
        // Usage:
        //   copy(JSON.stringify(__viewerDumpTextureFrame(80), null, 2))
        window.__viewerDumpTextureFrame = (limit = 80) => {
            try {
                const rep = app?.instancedModelRenderer?.getTextureFrameReport?.(limit) || null;
                const ts = app?.textureStreamer;
                return {
                    schema: 'webglgta-texture-frame-dump-v1',
                    frameReport: rep,
                    missing404: ts?.getMissing404Summary?.(limit) || [],
                    recentTextureErrors: ts?.getRecentErrors?.(25) || [],
                    textureStats: ts?.getStats?.() || null,
                };
            } catch (e) {
                return { schema: 'webglgta-texture-frame-dump-v1', error: String(e?.message || e || 'unknown') };
            }
        };
    } catch {
        // ignore
    }
}); 
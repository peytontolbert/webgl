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
import { clearAssetCacheStorage, fetchJSON, setAssetFetchConcurrency, supportsAssetCacheStorage } from './asset_fetcher.js';
import { OcclusionCuller } from './occlusion.js';

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
        this.modelManager = new ModelManager(this.gl);
        // Default: strict mode (missing exports simply don't appear).
        // You can toggle placeholders on in the UI to visualize missing exports.
        this.modelManager.enablePlaceholderMeshes = false;
        this.textureStreamer = new TextureStreamer(this.gl, { maxTextures: 512, maxBytes: 512 * 1024 * 1024 });
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
        this.cacheStreamedChunks = false;
        this._settingsSaveTimer = null;
        this._lastViewSaveMs = 0;
        this._restoredViewApplied = false;

        // Simple "ped" marker renderer
        this.pedRenderer = new PedRenderer(this.gl);
        this.ped = null; // { posData: [x,y,z], posView: [x,y,z], camOffset: [x,y,z] }
        this.followPed = true;
        this.controlPed = false;

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
            'frustumCulling', 'streamFromCamera',
            'enableOcclusionCulling',
            'enablePerfHud',
            'restoreOnRefresh', 'cacheStreamedChunks',
            'streamRadius', 'maxLoadedChunks', 'maxArchetypes', 'maxModelDistance', 'maxMeshLoadsInFlight',
            'textureQuality', 'lodLevel',
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
            'frustumCulling', 'streamFromCamera',
            'enableOcclusionCulling',
            'enablePerfHud',
            'restoreOnRefresh', 'cacheStreamedChunks',
            'streamRadius', 'maxLoadedChunks', 'maxArchetypes', 'maxModelDistance', 'maxMeshLoadsInFlight',
            'textureQuality', 'lodLevel',
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
        const maxArch = Number.isFinite(a) ? Math.max(0, Math.min(20000, Math.floor(a))) : 250;
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

        // Match Camera.zoom behavior: pass delta in same scale as current code (wheelDeltaY * 0.001).
        const delta = wheelDeltaY * 0.001;
        const newDist = dist * (1.0 - delta * 0.5);
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
        if (this.groundPedToTerrain && Number.isFinite(groundZ)) {
            if (!Number.isFinite(baseZ) || Math.abs(baseZ - groundZ) <= this.groundPedMaxDelta) {
                baseZ = groundZ;
                usedGround = true;
            }
        }
        if (!Number.isFinite(baseZ)) baseZ = Number.isFinite(groundZ) ? groundZ : 0.0;

        const z = baseZ + this.pedEyeHeightData; // eye-height-ish offset
        this.spawnPedAt([x, y, z]);
        this._pedGroundingDebug = { desiredZ, groundZ: Number.isFinite(groundZ) ? groundZ : null, finalZ: z, usedGround };

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
                    if (layer.has_normal) {
                        await this.terrainRenderer.loadTexture(`normal${i + 1}`, `assets/textures/${layer.name}_normal.png`);
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

        // Window resize
        window.addEventListener('resize', () => {
            this.resize();
        });
        
        // Mouse movement
        let isDragging = false;
        let lastX = 0;
        let lastY = 0;
        
        this.canvas.addEventListener('mousedown', (e) => {
            isDragging = true;
            lastX = e.clientX;
            lastY = e.clientY;
        });
        
        this.canvas.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            
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
        
        this.canvas.addEventListener('mouseup', () => {
            isDragging = false;
        });
        
        // Mouse wheel
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (this.followPed && this.ped) {
                if (this.gameplayCamEnabled) this._applyGameplayCameraZoomDelta(e.deltaY);
                else this._zoomFollowPed(e.deltaY);
            } else {
                this.camera.zoom(e.deltaY * 0.001);
            }
        });
        
        // Keyboard controls
        const keyState = {};
        
        window.addEventListener('keydown', (e) => {
            keyState[e.key.toLowerCase()] = true;
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
        if (this._streamDebugEl) {
            // Allow multi-line status in the debug HUD.
            this._streamDebugEl.style.whiteSpace = 'pre-line';
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
            const radius = Number.isFinite(r) ? Math.max(1, Math.min(24, Math.floor(r))) : 2;
            const maxLoaded = Number.isFinite(m) ? Math.max(9, Math.min(4000, Math.floor(m))) : 25;
            // 0 means "no cap" (distance cutoff still applies).
            const maxArch = Number.isFinite(a) ? Math.max(0, Math.min(20000, Math.floor(a))) : 250;
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
                const ok = await clearAssetCacheStorage();
                try {
                    clearCacheBtn.textContent = ok ? 'Cache cleared' : 'Cache not available';
                    setTimeout(() => { clearCacheBtn.textContent = 'Clear cache'; }, 1200);
                } catch {
                    // ignore
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
                this.camera.move(moveDir);
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
                this.camera.lookAtPoint(this.ped.posView);
                this.camera.position[0] = this.ped.posView[0] + this.ped.camOffset[0];
                this.camera.position[1] = this.ped.posView[1] + this.ped.camOffset[1];
                this.camera.position[2] = this.ped.posView[2] + this.ped.camOffset[2];
                this.camera.updateViewMatrix();
            }
        }

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
            this.drawableStreamer.update(this.camera, center);
        }

        // Streaming debug HUD (helps diagnose "nothing loaded")
        if (this._streamDebugEl) {
            const eLoaded = this.entityStreamer?.loaded?.size ?? 0;
            const eLoading = this.entityStreamer?.loading?.size ?? 0;
            const eChunks = this.entityRenderer?.chunkBuffers?.size ?? 0;
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
                `Entities: ready=${!!this.entityReady} chunks=${eChunks} loaded=${eLoaded} loading=${eLoading} dots=${!!this.showEntityDots}\n` +
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
            const dz = Number.isFinite(d.desiredZ) ? d.desiredZ.toFixed(2) : 'n/a';
            this._pedDebugEl.textContent = `Z desired=${dz} | ground=${gz} | final=${d.finalZ.toFixed(2)} | ${d.usedGround ? 'snapped' : 'kept'}`;
        } else if (this._pedDebugEl) {
            this._pedDebugEl.textContent = '';
        }

        // Persist view state so refresh restores quickly.
        this._maybeSaveViewToStorage();
    }
    
    render() {
        // Per-frame texture visibility/distance policy (models call textureStreamer.touch(...) while drawing).
        try { this.textureStreamer?.beginFrame?.(); } catch { /* ignore */ }

        // Optional GPU timer (only when Perf HUD is enabled).
        if (this.enablePerfHud) {
            try { this._gpuTimer?.beginFrame?.(); } catch { /* ignore */ }
        }

        // Clear buffers first.
        this.gl.clearColor(0.0, 0.0, 0.0, 1.0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);

        // Draw sky gradient (atmosphere). This is a pure background pass.
        if (this.atmosphereEnabled && this.skyRenderer?.ready) {
            // Approximate sun direction from time-of-day: morning/evening near horizon.
            const t01 = (this.timeOfDayHours % 24.0) / 24.0;
            const ang = (t01 * Math.PI * 2.0) - (Math.PI * 0.5); // noon-ish up
            const sunDir = [Math.cos(ang) * 0.35, Math.sin(ang) * 0.95, 0.20];
            const sunI = Math.max(0.05, Math.sin(ang) * 1.1);
            this.skyRenderer.render({
                topColor: this.skyTopColor,
                bottomColor: this.skyBottomColor,
                sunDir,
                sunColor: [1.0, 0.97, 0.88],
                sunIntensity: sunI,
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
        if (this.showTerrain) {
            this.terrainRenderer.render(this.camera.viewProjectionMatrix, this.camera.position, {
                enabled: this.atmosphereEnabled && this.fogEnabled,
                color: this.fogColor,
                start: this.fogStart,
                end: this.fogEnd,
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
                        color: this.fogColor,
                        start: this.fogStart,
                        end: this.fogEnd,
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
                            this.terrainRenderer.render(this.camera.viewProjectionMatrix, this.camera.position, {
                                enabled: false,
                                color: this.fogColor,
                                start: this.fogStart,
                                end: this.fogEnd,
                            });
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
            } else if (this.occlusionCuller) {
                this.occlusionCuller.enabled = false;
            }

            this.instancedModelRenderer.render(this.camera.viewProjectionMatrix, this.showModels, this.camera.position, {
                enabled: this.atmosphereEnabled && this.fogEnabled,
                color: this.fogColor,
                start: this.fogStart,
                end: this.fogEnd,
                occlusion: (this.enableOcclusionCulling ? this.occlusionCuller : null),
                viewportWidth: this.canvas.width,
                viewportHeight: this.canvas.height,
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
        
        // Check for WebGL errors after render
        const errorAfter = this.gl.getError();
        if (errorAfter !== this.gl.NO_ERROR) {
            console.error('WebGL error after render:', errorAfter);
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
    } catch {
        // ignore
    }
}); 
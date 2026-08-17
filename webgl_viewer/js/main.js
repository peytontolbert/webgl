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
import { clearAssetCacheStorage, clearAssetMemoryCaches, fetchArrayBufferPreferredCompressed, fetchJSON, setAssetFetchConcurrency, setAssetFetchPriorityConfig, supportsAssetCacheStorage } from './asset_fetcher.js';
import { OcclusionCuller } from './occlusion.js';
import { FileBlobReader } from './vfs/readers.js';
import { RpfArchive } from './rpf/rpf_archive.js';
import { PostFxRenderer } from './postfx_renderer.js';
import { SpawnSystem } from './gameplay/spawn_system.js';
import { CollisionWorld } from './gameplay/collision_world.js';
import { PlayerController } from './gameplay/player_controller.js';
import { WeaponController } from './gameplay/weapon_controller.js';
import { InventoryOverlay } from './gameplay/inventory_overlay.js';
import { BankingController } from './gameplay/banking_controller.js';
import { InteractionSystem } from './gameplay/interactions.js';
import { DoorController } from './gameplay/door_controller.js';
import { VehicleController } from './gameplay/vehicle_controller.js';
import { GameplayPersistence } from './gameplay/persistence.js';
import { WeaponRenderer } from './weapon_renderer.js';
import { DemoBoundaryRenderer } from './demo_boundary_renderer.js';
import { TrackRoadRenderer } from './track_road_renderer.js';
import { TrackSceneRenderer } from './track_scene_renderer.js';
import { NpcSystem } from './gameplay/npc_system.js';
import { MeleeController } from './gameplay/melee_controller.js';
import { MultiplayerClient } from './gameplay/multiplayer_client.js';
import { GameAudioSystem } from './gameplay/audio_system.js';
import { GtaHud } from './gameplay/gta_hud.js';
import { GroundPickupRenderer } from './ground_pickup_renderer.js';
import { FragmentDebrisSystem } from './gameplay/fragment_debris_system.js';
import { ChatMenuController } from './gameplay/chat_menu.js';
import { EmotePaletteController } from './gameplay/emote_palette_controller.js';
import { PhoneController } from './gameplay/phone_controller.js';
import { DrivingPerformanceMonitor } from './gameplay/driving_performance.js';
import { getWebGpuCullingAvailability } from './webgpu_culler.js';
import { decodeSkinningAnimationPack } from './skinning_animation_codec.js';

const _LS_SETTINGS_KEY = 'webglgta.viewer.settings.v1';
const _LS_VIEW_KEY = 'webglgta.viewer.view.v1';
const _SETTINGS_VERSION = 26;
const DEFAULT_CHARACTER_MODEL_NAME = 'a_m_y_skater_01';
const FREEMODE_CHARACTER_MODELS = Object.freeze({
    male: Object.freeze({
        modelName: 'mp_m_freemode_01', modelHash: 1885233650,
        skeleton: 'peds/1885233650_skeleton.json', animations: 'peds/1885233650_animations.json',
    }),
    female: Object.freeze({
        modelName: 'mp_f_freemode_01', modelHash: 2627665880,
        skeleton: 'peds/2627665880_skeleton.json', animations: 'peds/2627665880_animations.json',
    }),
});
const POLICE_PED_MODEL = Object.freeze({
    modelName: 's_m_y_cop_01',
    modelHash: '1581098148',
    skeleton: 'peds/1581098148_skeleton.json',
    animations: 'peds/1581098148_animations.json',
});
const AMBIENT_PED_MODELS = Object.freeze([
    { modelName: 'a_m_y_skater_01', modelHash: '3250873975' },
    { modelName: 'a_m_y_business_02', modelHash: '3014915558' },
    { modelName: 'a_f_y_business_02', modelHash: '826475330' },
    { modelName: 'a_m_m_bevhills_02', modelHash: '1068876755' },
    { modelName: 'a_f_y_tourist_01', modelHash: '1446741360' },
].map((model) => Object.freeze({
    ...model,
    skeleton: `peds/${model.modelHash}_skeleton.json`,
    animations: `peds/${model.modelHash}_animations.json`,
})));
// nx-mod-coke's actual runtime prop. The demo server supplies the placement;
// the base GTA drawable is already included by the district model manifest.
const COCA_HARVEST_MODEL_HASH = '2611685511';
// Gameplay stores yaw 0 as data-space +X. The exported freemode drawable is
// authored facing local -Y, so only its render transform needs this alignment.
const PLAYER_DRAWABLE_FORWARD_OFFSET_RAD = Math.PI * 0.5;
const PED_COMPONENT_DISPLAY_NAMES = Object.freeze({
    1: 'Masks',
    3: 'Arms / Torso',
    6: 'Shoes',
    8: 'Undershirt / Accessories',
    11: 'Upper Body / Tops',
});
const OPTIONAL_PED_COMPONENT_IDS = new Set([1, 5, 7, 8, 9, 10, 11]);
const REQUIRED_PED_COMPONENT_IDS = new Set([0, 2, 3, 4, 6]);
const PED_COMPONENT_NONE_KEY = '__none__';
// The source Glock mesh is in GTA weapon space (+X barrel, +Z sight/up). This
// is the inverse SKEL_R_Hand basis sampled at the middle of aim_med_loop, so a
// heading-zero ped holds the barrel along data +X with the sights upright. The
// translation is the skeleton's SKEL_R_Hand -> PH_R_Hand palm offset; adding a
// lateral wrist-space offset twists the grip out of the rendered fingers.
const GLOCK_RIGHT_HAND_ATTACHMENT_TRANSFORM = new Float32Array([
    0.5083044, -0.2485916, 0.8245348, 0.0,
    0.8577046, 0.0601933, -0.5106212, 0.0,
    0.0773049, 0.9667699, 0.2438386, 0.0,
    0.0544350, 0.0, 0.0, 1.0,
]);
// Local point around which the firing hand closes. The exported YDR origin is
// near the slide, not inside the grip, so mounting its origin to PH_R_Hand puts
// the fingers on top of the pistol and leaves the handle hanging below them.
const GLOCK_GRIP_ANCHOR_LOCAL = Object.freeze([-0.064, 0.0067, -0.045]);
const GLOCK_ADS_MAX_BARREL_CORRECTION_RAD = 0.34;
const GTA_HAIR_COLORS = Object.freeze([
    [29, 8, 0], [41, 13, 4], [57, 24, 16], [80, 35, 24], [105, 50, 35], [127, 63, 44], [155, 83, 57], [180, 103, 76],
    [202, 128, 93], [220, 155, 118], [230, 184, 151], [243, 210, 181], [89, 47, 20], [119, 69, 32], [154, 104, 55], [190, 145, 86],
    [226, 192, 133], [238, 218, 180], [18, 18, 18], [35, 35, 35], [55, 55, 55], [85, 85, 85], [125, 125, 125], [170, 170, 170],
    [205, 205, 205], [235, 235, 235], [92, 28, 31], [122, 35, 39], [160, 48, 51], [196, 66, 68], [222, 100, 102], [238, 145, 146],
    [74, 20, 92], [104, 31, 128], [139, 49, 164], [170, 76, 194], [35, 45, 109], [44, 67, 150], [56, 94, 188], [78, 128, 216],
    [17, 88, 71], [25, 122, 94], [39, 158, 117], [67, 192, 143], [89, 91, 20], [128, 128, 29], [168, 165, 42], [202, 198, 71],
    [129, 55, 18], [166, 75, 24], [202, 101, 35], [229, 135, 57], [106, 32, 66], [142, 44, 89], [180, 63, 115], [214, 91, 145],
    [14, 14, 14], [44, 28, 20], [83, 54, 38], [126, 88, 60], [174, 129, 90], [213, 174, 127], [232, 207, 167], [250, 238, 212],
]);

function hairColorLinear(index) {
    const rgb = GTA_HAIR_COLORS[Math.max(0, Math.min(GTA_HAIR_COLORS.length - 1, Number(index) | 0))] || GTA_HAIR_COLORS[0];
    return rgb.map((value) => Math.pow(value / 255, 2.2));
}

function isSpawnDistrictDemoRoute() {
    const pathname = String(window?.location?.pathname || '/').replace(/\/+$/, '') || '/';
    return pathname === '/demo';
}

function spawnDistrictDescriptorPath() {
    try {
        const outpost = new URLSearchParams(window.location.search).get('outpost');
        // Keep the normal Legion tile stable. Outposts are an explicit route
        // because each is its own bounded playable cell and asset set.
        if (outpost === 'weed') return 'assets/demo/weed_shop_district.json';
    } catch { /* use the Legion descriptor */ }
    return 'assets/demo/spawn_district.json';
}

function isAssetPickDiagnosticEnabled() {
    if (!isSpawnDistrictDemoRoute()) return false;
    try { return new URLSearchParams(window.location.search).get('assetPick') === '1'; } catch { return false; }
}

function isStaticSupermeshEnabled() {
    if (!isSpawnDistrictDemoRoute()) return false;
    try {
        // The bake only contains opaque, non-animated geometry. MLOs,
        // destructibles, decals, transparent materials, and palette-based props
        // remain in the normal source residency stream.
        const params = new URLSearchParams(window.location.search);
        return params.get('staticSupermesh') !== '0';
    } catch {
        return false;
    }
}

const PERF_PROFILES = {
    gameplay: {
        streamRadius: 1,
        maxLoadedChunks: 9,
        maxArchetypes: 96,
        maxModelDistance: 320,
        maxVisibleInstances: 12000,
        maxInstancesPerArchetype: 128,
        maxMeshLoadsInFlight: 3,
        meshMaxBytes: 128 * 1024 * 1024,
        texMaxBytes: 64 * 1024 * 1024,
        texMaxTextures: 256,
        assetConcurrency: 6,
        texLoadsInFlight: 4,
        texNewLoadsPerFrame: 8,
        textureQuality: 'low',
        lodLevel: '2',
        showModels: true,
        wireframe: true,
        cacheStreamedChunks: false,
    },
    city: {
        streamRadius: 3,
        maxLoadedChunks: 49,
        maxArchetypes: 360,
        maxModelDistance: 800,
        maxVisibleInstances: 60000,
        maxInstancesPerArchetype: 640,
        maxMeshLoadsInFlight: 6,
        meshMaxBytes: 1024 * 1024 * 1024,
        texMaxBytes: 384 * 1024 * 1024,
        texMaxTextures: 1536,
        assetConcurrency: 12,
        texLoadsInFlight: 12,
        texNewLoadsPerFrame: 24,
        textureQuality: 'medium',
        lodLevel: '1',
        showModels: true,
        wireframe: false,
        cacheStreamedChunks: false,
    },
    high: {
        streamRadius: 6,
        maxLoadedChunks: 169,
        maxArchetypes: 1200,
        maxModelDistance: 1600,
        maxVisibleInstances: 180000,
        maxInstancesPerArchetype: 2048,
        maxMeshLoadsInFlight: 12,
        meshMaxBytes: 2 * 1024 * 1024 * 1024,
        texMaxBytes: 1024 * 1024 * 1024,
        texMaxTextures: 4096,
        assetConcurrency: 20,
        texLoadsInFlight: 24,
        texNewLoadsPerFrame: 48,
        textureQuality: 'high',
        lodLevel: '0',
        showModels: true,
        wireframe: false,
        cacheStreamedChunks: false,
    },
};
// The demo intentionally begins in the constrained profile. Users can raise
// this from Settings after the nearby district is resident, but booting at
// medium evicts visible facade maps on devices with limited texture memory.
const SPAWN_DEMO_TEXTURE_QUALITY = 'low';
const SPAWN_DEMO_MODEL_LOD = 'med';
const SPAWN_DEMO_LOD_LEVEL = '1';
// Keep /demo at a stable internal resolution. Reallocating the WebGL canvas
// and post-process targets while the player turns is much more noticeable than
// the small quality gain from dynamic resolution in this dense world.
const SPAWN_DEMO_RENDER_SCALE = 0.50;
const SPAWN_DEMO_SECONDARY_MAP_DISTANCE = 90.0;
const SPAWN_DEMO_MED_SECONDARY_MAP_DISTANCE = 56.0;
const SPAWN_DEMO_LOW_SECONDARY_MAP_DISTANCE = 32.0;
// The source manifest retains thousands of GTA decal/overlay submeshes that
// cannot be merged into opaque supermeshes. Submitting them across an entire
// 3x3 neighborhood costs more than the opaque city pass. Keep them at gameplay
// inspection range; primary roads/buildings and their collision are unaffected.
const SPAWN_DEMO_LOW_ALPHA_DISTANCE = 96.0;
const SPAWN_DEMO_LOW_DECAL_DISTANCE = 56.0;
const SPAWN_DEMO_LOW_ADDITIVE_DISTANCE = 72.0;
const SPAWN_DEMO_MIN_PROJECTED_PROP_RADIUS_PX = 2.0;
const SPAWN_DEMO_MAX_SAFE_DRAW_ITEMS = 850;
const SPAWN_DEMO_GROUP_BUDGET_MIN_DISTANCE = 120.0;
// Keep the live gameplay neighborhood bounded. A 3x3 core covers every
// adjacent tile while movement-directed look-ahead warms up to three tiles.
// The previous 5x5 + 12-forward configuration settled at more than 2,000
// material submissions per frame even while the player was stationary.
const SPAWN_DEMO_STREAM_RADIUS_CHUNKS = 1;
const SPAWN_DEMO_STREAM_CORE_CHUNKS = (SPAWN_DEMO_STREAM_RADIUS_CHUNKS * 2 + 1) ** 2;
const SPAWN_DEMO_STREAM_FORWARD_SLOTS = 3;
const SPAWN_DEMO_STREAM_MAX_CHUNKS = SPAWN_DEMO_STREAM_CORE_CHUNKS + SPAWN_DEMO_STREAM_FORWARD_SLOTS;
const SPAWN_DEMO_STREAM_RESIDENT_CHUNKS = SPAWN_DEMO_STREAM_MAX_CHUNKS + 3;
const SPAWN_DEMO_STREAM_FORWARD_CHUNKS = 3;
const SPAWN_DEMO_STREAM_HORIZON_SECONDS = 10.0;
const SPAWN_DEMO_STREAM_STALE_GRACE_MS = 3_000;
const SPAWN_DEMO_STREAM_REBUILD_SETTLE_MS = 750;
const SPAWN_DEMO_MAX_MODEL_DISTANCE = 760;
const SPAWN_DEMO_MAX_VISIBLE_INSTANCES = 18_000;
const SPAWN_DEMO_MAX_INSTANCES_PER_ARCHETYPE = 2_048;

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
        this.safeDrawBudgetEnabled = true;
        try {
            this.safeDrawBudgetEnabled = new URLSearchParams(window.location.search).get('safeDrawBudget') !== '0';
        } catch { /* keep production default */ }

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
        this.debugFrameGlErrors = false;

        // Streaming can trigger hundreds of loads; keep fetch concurrency bounded to avoid resource exhaustion.
        // (Cache hits bypass the limiter.)
        setAssetFetchConcurrency(24);

        // Loading state
        this._loading = true;
        // This is intentionally separate from `_loading`: the latter is also
        // used to gate the native splash overlay, while integrations need a
        // stable, observable first-playable-frame boundary.
        this._worldReady = false;
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
        // The heightfield is a coarse terrain/collision proxy. Streamed GTA drawables own the city surface,
        // so do not place the proxy over world geometry by default.
        this.showTerrain = false;

        // Initialize entity streaming (client-like)
        this.entityRenderer = new EntityRenderer(this.gl);
        this.entityStreamer = new EntityStreamer({ modelMatrix: this.entityRenderer.modelMatrix });
        this.entityReady = false;

        // Buildings (city geometry)
        this.buildingRenderer = new BuildingRenderer(this.gl);
        this.demoBoundaryRenderer = new DemoBoundaryRenderer(this.gl);
        this.trackRoadRenderer = new TrackRoadRenderer(this.gl);
        this.trackSceneRenderer = new TrackSceneRenderer(this.gl);
        // The district limit is enforced by CollisionWorld. The cyan fence is
        // useful while authoring bounds but is not part of the playable world.
        this.showDemoBoundary = false;
        // The OBJ city shell is a coarse fallback. Keep it off while streamed
        // GTA drawables are active so coincident geometry cannot fight for depth.
        this.showBuildings = false;
        this.showWater = true;

        // Entity dots (always-available point rendering)
        this.showEntityDots = false;
        // Overlay mode makes dots visible even when entities are underground/interior, but it can obscure meshes.
        this.entityDotsOverlay = false;

        // Real GTA drawables (exported offline into assets/models/*)
        // Cache sizing heuristic:
        // - Browsers can hit WebGL allocation limits far below system RAM.
        // - Default to a bounded gameplay profile; larger city/high-detail profiles are explicit opt-ins.
        const devMemGb = (() => {
            try {
                const v = Number((typeof navigator !== 'undefined') ? navigator.deviceMemory : NaN);
                return Number.isFinite(v) ? v : null;
            } catch { return null; }
        })();
        const cacheCaps = (() => {
            const caps = { ...PERF_PROFILES.gameplay };
            if (devMemGb !== null && devMemGb <= 4) {
                caps.meshMaxBytes = 96 * 1024 * 1024;
                caps.texMaxBytes = 48 * 1024 * 1024;
                caps.texMaxTextures = 192;
                caps.assetConcurrency = 5;
                caps.texLoadsInFlight = 3;
                caps.texNewLoadsPerFrame = 6;
                caps.maxLoadedChunks = 36;
                caps.maxArchetypes = 220;
            }
            return {
                deviceMemoryGb: devMemGb,
                ...caps,
            };
        })();
        this._activePerformanceProfile = 'gameplay';
        this._defaultRuntimeCaps = cacheCaps;
        try { setAssetFetchConcurrency(cacheCaps.assetConcurrency); } catch { /* ignore */ }
        try { setAssetFetchPriorityConfig({ highShare: 0.82 }); } catch { /* ignore */ }

        this.modelManager = new ModelManager(this.gl);
        // Custom clothing catalogs load independently of the base model manifest.
        // Retain every collection so model initialization order cannot drop one.
        this.runtimeCustomClothingManifests = new Map();
        this.modelManager.retainCpuPickData = isAssetPickDiagnosticEnabled();
        // Default: strict mode (missing exports simply don't appear).
        // You can toggle placeholders on in the UI to visualize missing exports.
        this.modelManager.enablePlaceholderMeshes = false;
        // Mesh cache caps (GPU buffer residency).
        try { this.modelManager.setMeshCacheCaps?.({ maxBytes: cacheCaps.meshMaxBytes }); } catch { /* ignore */ }
        this.textureStreamer = new TextureStreamer(this.gl, { maxTextures: cacheCaps.texMaxTextures, maxBytes: cacheCaps.texMaxBytes });
        try {
            this.textureStreamer.setStreamingConfig({
                maxLoadsInFlight: cacheCaps.texLoadsInFlight,
                maxNewLoadsPerFrame: cacheCaps.texNewLoadsPerFrame,
            });
        } catch { /* ignore */ }
        this.instancedModelRenderer = new InstancedModelRenderer(this.gl, this.modelManager, this.textureStreamer);
        // Fracture pieces are authored YFT child meshes, not streamed map instances.
        // Keep their renderer independent so camera residency rebuilds cannot reset debris.
        this.fragmentDebrisSystem = new FragmentDebrisSystem(this);
        // Player drawables need an independent shader pass so their render style can differ from the streamed city.
        // Mesh buffers and texture cache are still shared with the world renderer.
        this.playerModelRenderer = null;
        this._playerModelRendererInitPromise = null;
        this.npcModelRenderer = null;
        this.npcCombatModelRenderer = null;
        this.policeNpcModelRenderer = null;
        this.ambientNpcModelRenderers = new Map();
        this.remotePlayerRenderer = null;
        this._npcModelRendererInitPromise = null;
        this._policeNpcModelRendererInitPromise = null;
        this._nativeNpcManifestPromise = null;
        this._ambientNpcRendererInitPromises = new Map();
        this._ambientNpcCombatAnimationPromises = new Map();
        this._ambientNpcCombatAnimationsReady = new Set();
        this._nativeNpcReadyModels = new Set();
        this._npcPipelineErrorAt = new Map();
        this._npcSyncDiagnostics = { syncs: 0, submissions: 0, ambient: 0, combat: 0, police: 0, hashes: [] };
        this._remotePlayerRendererInitPromise = null;
        this._npcActiveMeshKeys = new Set();
        this._npcCombatActiveMeshKeys = new Set();
        this._policeNpcActiveMeshKeys = new Set();
        this._ambientNpcActiveMeshKeys = new Map();
        this._remotePlayerActiveMeshKeys = new Set();
        this._remotePlayers = [];
        this._remotePlayerAnimationHashes = [];
        this._npcCombatAnimationPose = null;
        this._npcAnimatedNpcs = [];
        this._npcAmbientNpcs = [];
        this._ambientNpcRenderGroups = [];
        this._npcAnimationHashes = [];
        this._policeNpcAnimationHashes = [{ hash: POLICE_PED_MODEL.modelHash, lod: 'high' }];
        this._npcAnimPhase = 1.873;
        this._npcAmbientLocomotion = { enabled: false, move01: 0.0, gait: 'idle', stride: 1.0 };
        // Reuse dynamic ped transform buffers across simulation and render
        // passes. Ped groups can be static for long stretches, so this also
        // lets their instance update be skipped entirely when nothing moved.
        this._npcInstanceScratchByRenderer = new WeakMap();
        this._npcAppearanceSpecs = null;
        this._npcAppearanceHair = null;
        this.showNpcs = true;
        // Weapons are small, fixed assets. Keep them outside the streamed-world renderer so
        // drawing one never competes with the archetype and chunk residency budgets.
        this.weaponModelRenderer = null;
        this._weaponModelRendererInitPromise = null;
        this.weaponModelAsset = null;
        this._weaponModelMat = glMatrix.mat4.create();
        this._weaponModelMatBuf = new Float32Array(16);
        this._weaponHandBoneMat = glMatrix.mat4.create();
        this._weaponHandDataMat = glMatrix.mat4.create();
        this._weaponGripDataMat = glMatrix.mat4.create();
        this._weaponAdsCorrectionMat = glMatrix.mat4.create();
        this._weaponAdsRotationMat = glMatrix.mat4.create();
        this._weaponAdsCorrectionQuat = glMatrix.quat.create();
        this._weaponAdsIdentityQuat = glMatrix.quat.create();
        this._weaponModelActiveKey = null;
        this._weaponModelMeshReady = false;
        this._weaponModelPrecachePromise = null;
        this._weaponModelTexturesQueued = false;
        // The phone is a small hand prop with its own tiny residency pool. It
        // must not enter city streaming or compete with world archetypes.
        this.phoneModelRenderer = null;
        this._phoneModelRendererInitPromise = null;
        this.phoneModelAsset = null;
        this._phoneModelMat = glMatrix.mat4.create();
        this._phoneModelMatBuf = new Float32Array(16);
        this._phoneHandBoneMat = glMatrix.mat4.create();
        this._phoneHandDataMat = glMatrix.mat4.create();
        this._phoneModelActiveKey = null;
        this._phoneModelMeshReady = false;
        this._phoneModelPrecachePromise = null;
        this.vehicleModelRenderer = null;
        this._vehicleModelRendererInitPromise = null;
        this._vehicleManifestPromises = new Map();
        this._vehicleManifestReadyKeys = new Set();
        this._vehicleModelMat = glMatrix.mat4.create();
        this._vehicleModelMatBuf = new Float32Array(16);
        this._vehicleModelQuat = glMatrix.quat.create();
        this._vehicleModelActiveKey = null;
        this._vehicleModelMeshReady = false;
        this._vehicleModelMeshStatus = null;
        this._vehicleModelStatusKey = '';
        this._vehicleModelStatusNextMs = 0;
        this.cokePlantModelRenderer = null;
        this._cokePlantModelRendererInitPromise = null;
        this._cokePlantModelActive = false;
        this._cokePlantModelSignature = '';
        this._cokePlantModelMat = glMatrix.mat4.create();
        this._cokePlantModelQuat = glMatrix.quat.create();
        this.drawableStreamer = new DrawableStreamer({
            modelMatrix: this.entityRenderer.modelMatrix,
            modelManager: this.modelManager,
            modelRenderer: this.instancedModelRenderer,
        });
        // When sharded manifest shards load, rebuild instance selection so real meshes pop in quickly.
        this.modelManager.onManifestUpdated = () => {
            if (this.drawableStreamer) this.drawableStreamer._dirty = true;
            if (this.player?.enabled) {
                try { this._syncPlayerEntityMesh(true); } catch { /* ignore */ }
            }
        };
        // Models remain on, but startup is capped by the gameplay profile above.
        this.showModels = !!cacheCaps.showModels;
        this.modelsInitialized = false;
        this._modelsInitPromise = null;

        // Viewer controls
        this.playerWireframeMode = false;
        this.objectsWireframeMode = !!cacheCaps.wireframe;
        this.terrainWireframeMode = !!cacheCaps.wireframe;
        this.buildingsWireframeMode = !!cacheCaps.wireframe;
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

        // A local player is always the streaming center. The camera is only a free-map fallback.
        this.streamFromCamera = false;
        this._streamingUiParams = null; // { radius, maxLoaded, maxArch, maxDist, maxVisible, maxPerArch, maxLoads, fc }
        this._streamingRampTimer = null;

        // Persistence + cache
        this.restoreOnRefresh = false;
        this.spawnCharacterOnBoot = true;
        // Disk-caching large chunk files is opt-in; it can hide stale exports and pressure storage.
        this.cacheStreamedChunks = !!cacheCaps.cacheStreamedChunks;
        this._settingsSaveTimer = null;
        this._lastViewSaveMs = 0;
        this._restoredViewApplied = false;
        this.settingsMenuOpen = false;
        this._settingsMenuEl = null;
        this._settingsBackdropEl = null;
        this._gameplayPointerWasLocked = false;
        this._suppressPointerUnlockMenu = false;

        // Simple "ped" marker renderer
        this.pedRenderer = new PedRenderer(this.gl);
        this.ped = null; // { posData: [x,y,z], posView: [x,y,z], camOffset: [x,y,z] }
        this.showPlayer = true;
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
        // The exported heightmap is useful for terrain-only spawns, but it is not trusted to
        // override an authoritative FiveM/GTA street Z while a player is moving.
        this._pedGroundSource = 'runtime'; // terrain | interior | runtime

        // "Real" player entity (mesh instance; freemode components can use exported skin palettes).
        this.player = {
            enabled: false,
            hash: null,        // stringified u32
            hashes: [],        // one or more renderable mesh hashes (freemode components use several)
            labels: [],
            lod: 'high',
            renderMode: 'single',
            requireRenderableCount: 1,
            headingRad: 0.0,   // data-space yaw (around +Z)
            _mat: glMatrix.mat4.create(),
            _matBuf: new Float32Array(16),
            _lastMoveDirData: [0, 0, 0],
            _locomotionGait: 'idle',
            _locomotionTransition: null,
            _activeMeshKeys: new Set(),
            animPhase: 0.0,
            animMove01: 0.0,
            animSpeed: 0.0,
            animGait: 'idle',
            handsUp: false,
            emote: null,
        };
        // Ambient pedestrians share the established skinned component pass. A
        // parallel renderer can have an empty mesh queue while the player is ready.
        this._playerPassPedMatrices = new Float32Array(16);
        this._playerPassAmbientNpcCount = 0;
        this.runtimeCharacterProfile = null;
        this.runtimeCharacterOptions = [];
        this.runtimeCharacterSelectedIndex = -1;
        this.runtimeCharacterDisabledComponentIds = new Set();
        this.runtimeCharacterComponentCatalog = null;
        this.runtimeCharacterBaseProfile = null;
        this._runtimeCharacterLoadPromise = null;
        this.playerSkinningSkeleton = null;
        this._runtimeCharacterSkeletonPromise = null;
        this.playerSkinningAnimations = null;
        this._runtimeCharacterAnimationsPromise = null;
        this._weaponCombatAnimationsPromise = null;
        this._weaponCombatAnimationsLoaded = false;
        this.weaponCombatSkinningAnimations = null;
        this._weaponCombatAnimationsUnavailable = false;
        this._meleeAnimationsPromise = null;
        this._meleeAnimationsLoaded = false;
        this._meleeAnimationsUnavailable = false;
        this.meleeSkinningAnimations = null;
        this._playerMeshStatus = null;
        this._pedVelocityData = [0, 0, 0];
        this._pedVerticalVelocityData = 0.0;
        this._pedOnGround = true;
        this._lastUpdateDt = 1 / 60;
        this.gameplayMoveConfig = {
            // Tuned to the sampled `move_m` clips. The browser owns root
            // displacement, while the palette owns leg cadence and pose.
            walkSpeed: 1.45,
            runSpeed: 3.85,
            sprintSpeed: 6.15,
            acceleration: 4.6,
            walkAcceleration: 2.6,
            runAcceleration: 4.6,
            sprintAcceleration: 3.7,
            aimAcceleration: 6.0,
            braking: 6.4,
            walkTurnRate: 2.2,
            runTurnRate: 4.25,
            sprintTurnRate: 3.25,
            aimTurnRate: 8.5,
            turnSharpness: 5.2,
            gravity: 22.0,
            jumpSpeed: 6.2,
            maxStepUp: 1.15,
            groundProbePad: 0.08,
        };

        // Browser-native gameplay layer. FiveM resources feed the manifest; the browser owns simulation.
        this.runtimeGameplayManifest = null;
        this.spawnSystem = new SpawnSystem();
        this.collisionWorld = new CollisionWorld(this);
        this.playerController = new PlayerController(this, this.collisionWorld);
        this.adminNoclipEnabled = false;
        this.npcSystem = new NpcSystem(this, this.collisionWorld);
        this.meleeController = new MeleeController(this);
        this.weaponController = new WeaponController(this);
        this.phoneController = new PhoneController(this);
        this.inventoryOverlay = new InventoryOverlay(this);
        this.bankingController = new BankingController(this);
        this.weaponRenderer = new WeaponRenderer(this.gl);
        // The bounded district is intentionally isolated behind /demo. It must not leak
        // into the normal full-world viewer through persisted control state.
        this.spawnDistrictDemo = isSpawnDistrictDemoRoute();
        this.spawnDistrictBounds = null;
        this._spawnDistrictDescriptor = null;
        this.interactionSystem = new InteractionSystem();
        this.doorController = new DoorController(this);
        this.vehicleController = new VehicleController(this);
        this.gameplayPersistence = new GameplayPersistence();
        this.audioSystem = new GameAudioSystem(this);
        this.gtaHud = new GtaHud(this);
        this.multiplayer = new MultiplayerClient(this);
        this.emotePalette = new EmotePaletteController(this);
        this.chatMenu = new ChatMenuController(this);
        this.groundPickupRenderer = new GroundPickupRenderer(this.gl);
        this.audioSystem.attachMultiplayer(this.multiplayer);
        this._lastGameplayAction = null;
        this._gameplayManifestStatus = 'pending';

        // Gameplay camera controller (smooth follow/orbit/zoom around the player).
        this.gameplayCamEnabled = true;
        this.gameplayCameraMode = 'thirdPerson';
        this._gpYaw = 0.0;
        this._gpPitch = -0.22;
        this._gpAimNeutralPitch = this._gpPitch;
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
        // Some WebGL implementations cannot read back the depth proxy. Record
        // that capability once so automatic driving occlusion fails open rather
        // than attempting an unsupported readback every frame.
        this._occlusionReadbackUnsupported = false;
        try {
            if (this.gl && typeof WebGL2RenderingContext !== 'undefined' && (this.gl instanceof WebGL2RenderingContext)) {
                this.occlusionCuller = new OcclusionCuller(this.gl, {
                    width: 192,
                    height: 192,
                    // Avoid a readback stall on every turn while preserving a
                    // temporally stable HZB for compact world-prop groups.
                    readbackEveryNFrames: 4,
                    depthEps: 0.0025,
                    enableSoftwareHzb: true,
                    hzbMinScreenPixels: 4,
                    temporalKeepFrames: 4,
                });
            }
        } catch {
            this.occlusionCuller = null;
        }

        // Follow-ped camera orbit state (viewer-space).
        this._orbitSensitivity = 0.005;
        this._orbitPitchLimit = 0.98; // clamp |y| <= limit * dist

        // YBN/interior collision is authoritative for gameplay grounding. GTA's
        // heightmap.dat is a pair of coarse bounds envelopes, not a street surface.
        this.groundPedToTerrain = true;
        this.groundPedMaxDelta = 25.0; // data-space units
        this.runtimeSpawnGroundSnapMaxDelta = 2.5; // Saved ped root can sit above the YBN floor.
        this._pedGroundingDebug = null; // { desiredZ, groundZ, finalZ, usedGround }
        this._runtimeSpawnInfo = null;
        this._bundledRuntimeSpawn = null;
        this._pedDebugEl = null;
        this._streamDebugEl = null;
        this._bootStatusEl = null;
        this._assetInspectorEl = null;
        this._assetInspectorTitleEl = null;
        this._assetInspectorSummaryEl = null;
        this._assetInspectorBodyEl = null;
        this._assetInspectorCopyBtn = null;
        this._assetInspectorText = '';
        this._lastAssetInspectorReport = null;
        this._vehiclePromptEl = null;
        this.assetPickerEnabled = false;
        this._weaponInventoryDialog = null;
        this._weaponInventoryKey = '';

        // Perf HUD (Task A6)
        this._perfHudEl = null;
        this.enablePerfHud = false;
        this._perfHudLastUpdateMs = 0;
        this._perfDtMs = 0;
        this._fpsEma = null;
        this._cpuUpdateMs = 0;
        this._cpuRenderMs = 0;
        this._cpuFrameMs = 0;
        this._gpuTimer = null;
        // The driving ledger is separate from the optional HUD. It stays cheap
        // when on foot and exposes p50/p95 budgets for repeatable drive tests.
        this.drivingPerformance = new DrivingPerformanceMonitor();
        
        // Set initial canvas size after camera is initialized
        this.resize();

        // Setup event listeners
        this.setupEventListeners();
        this._createMultiplayerHud();

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
            if (!this.spawnDistrictDemo) {
                void this.loadTextures().catch((e) => {
                    console.warn('Texture load failed:', e);
                });
            }

            if (!this.spawnDistrictDemo) void (async () => {
                try {
                    await this.buildingRenderer.init();
                    const runtimeManifest = await fetchJSON('assets/manifest.json', { priority: 'low' }).catch(() => null);
                    const buildingObj =
                        runtimeManifest?.buildings?.obj_file ||
                        runtimeManifest?.buildings_obj ||
                        runtimeManifest?.terrain?.buildings_obj ||
                        null;
                    if (buildingObj) {
                        await this.buildingRenderer.loadOBJ(`assets/${String(buildingObj).replace(/^assets[\\/]/i, '')}`);
                        if (this.buildingRenderer.boundsView) {
                            // Expand framing to include debug buildings if a monolithic OBJ is intentionally staged.
                            this.camera.frameAABB(this.buildingRenderer.boundsView.min, this.buildingRenderer.boundsView.max);
                        }
                    }
                } catch (e) {
                    console.warn('Building load failed:', e);
                }
            })();

            // Init entity renderer + streamer after terrain is ready
            this._setLoading({ detail: 'Loading entities index…', progress: 0.30 });
            this._setBootStatus('Loading entities index…');
            if (this.spawnDistrictDemo) {
                // Install the fixed point tile before the entity streamer can yield during init.
                // Drawable data is selected from the authoritative descriptor immediately before
                // drawableStreamer.init(); do not stage the obsolete, pre-MLO base ENT here.
                this.entityStreamer.setDemoBootstrap?.({
                    key: '__demo_spawn_district__',
                    pointFile: 'demo/spawn_district_points.bin',
                });
            }
            await this.entityRenderer.init();
            await this.entityStreamer.init();
            try { await this.demoBoundaryRenderer.init(this._dataToViewMatrix); } catch (e) {
                console.warn('Demo boundary renderer init failed:', e);
            }
            try { await this.trackRoadRenderer.init(this._dataToViewMatrix); } catch (e) {
                console.warn('Track road renderer init failed:', e);
            }
            try { await this.trackSceneRenderer.init(this._dataToViewMatrix); } catch (e) {
                console.warn('Track scene renderer init failed:', e);
            }
            this.entityReady = this.entityRenderer.ready && this.entityStreamer.ready;
            if (this.entityReady) {
                const chunkCount = this.entityStreamer?.index?.chunks ? Object.keys(this.entityStreamer.index.chunks).length : 0;
                const total = this.entityStreamer?.index?.total_entities ?? null;
                console.log(`Entity streaming enabled: chunks=${chunkCount} total_entities=${total ?? 'n/a'}`);
            }

            // The district descriptor below selects either the legacy YBNC tile
            // or the compiled stream; do not allocate both in demo mode.
            if (!this.spawnDistrictDemo) await this.collisionWorld?.loadYbnGround?.();
            const derivedRoad = await this.collisionWorld?.loadDerivedRoad?.();
            if (derivedRoad) {
                try { await this.trackRoadRenderer?.load?.(); } catch (e) { console.warn('Track road render load failed:', e); }
                // The full visual circuit is intentionally asynchronous.  The
                // compact sectors stream after the road/collision package so a
                // playable demo never waits on the large scene import.
                void this.trackSceneRenderer?.load?.();
                // The district bounds may have been installed before this optional
                // package finished loading. Recompute them now so the track is a
                // playable extension, not a teleport target that is clamped back
                // into the city by the next movement update.
                if (this.spawnDistrictDemo) this._setSpawnDistrictDemo(true, { dropResident: false });
            }
            globalThis.__viewerNurburgring = {
                available: () => !!this.collisionWorld?.getDerivedRoadSpawn?.(),
                teleport: () => this.teleportToDerivedRoad(),
                bounds: () => this.collisionWorld?.getDerivedRoadBounds?.() || null,
            };
            // The demo descriptor carries the authoritative FiveM spawn. Load that
            // small JSON before the normal boot spawn, while the full model subset
            // remains deferred until after the first playable frame.
            if (this.spawnDistrictDemo) await this._loadSpawnDistrictDescriptor();
            this._setSpawnDistrictDemo(this.spawnDistrictDemo, { dropResident: false });

            // Init ped renderer
            this._setLoading({ detail: 'Starting…', progress: 0.40 });
            this._setBootStatus('Starting…');
            await this.pedRenderer.init();
            try { await this.groundPickupRenderer.init(this._dataToViewMatrix); } catch (error) {
                console.warn('Ground pickup renderer init failed:', error);
            }
            await this._loadRuntimeCharacterProfile({ timeoutMs: 5_000 });
            await this._loadGameplayManifest({ timeoutMs: 900 });

            // Sync model setting, but do not start model initialization yet. The manifest/drawable path is heavy;
            // street-level spawn should get its first frame before this work starts.
            {
                const modelsEl = document.getElementById('showModels');
                // Sync runtime flag from UI (restore-on-refresh can toggle this before boot).
                if (modelsEl) this.showModels = !!modelsEl.checked;
                if (this.showModels && modelsEl) modelsEl.checked = true;
                if (!this.showModels) {
                    console.log('Models are disabled (Show Models unchecked or restored settings). Enable "Show Models" to initialize streaming drawables.');
                }
            }
            // Boot the viewer like a "client": start on foot in the city unless explicit restore is enabled.
            if (!this._tryRestoreViewFromStorage()) {
                try {
                    const follow = document.getElementById('followPed');
                    if (follow) follow.checked = true;
                    this.followPed = true;

                    const control = document.getElementById('controlPed');
                    if (control) control.checked = true;
                    this.controlPed = true;

                    if (this.spawnDistrictDemo) {
                        // Each bounded demo route owns its descriptor and spawn.  Applying
                        // runtime_spawn.json here would overwrite an outpost's interior
                        // coordinates with the Legion profile after the descriptor loaded.
                        await this.spawnCharacter({ toggle: false, waitForModel: false, snapshot: false, initModel: false });
                    } else {
                        // The remote resolver reads a live FiveM/MySQL profile and can take
                        // longer than the first-playable budget. Keep a locally exported
                        // snapshot in flight so a timeout never sends the user to the old,
                        // arbitrary Legion Square fallback.
                        const bundledSpawnPromise = this._loadBundledRuntimeSpawn();
                        const runtimeSpawn = await this._resolveRuntimeSpawn({ timeoutMs: 1400 });
                        const spawnToApply = runtimeSpawn || await bundledSpawnPromise;
                        if (!this._applyRuntimeSpawn(spawnToApply)) {
                            await this.spawnCharacter({ toggle: false, waitForModel: false, snapshot: false, initModel: false });
                        }
                    }
                } catch {
                    try {
                        // The editable coordinate controls are for an explicit manual spawn,
                        // not an automatic boot fallback. A stale control value must never
                        // displace the normal city-character fallback.
                        await this.spawnCharacter({ toggle: false, waitForModel: false, snapshot: false, initModel: false });
                    } catch {
                        // ignore
                    }
                }
            }

            // Do not render the character before the spawn-area world is resident. Starting
            // the loop here used to show the ped against collision/terrain first, then stream
            // the actual road above it on a later frame.
            const spawnWarmupCenter = this.ped
                ? [this.ped.posData[0], this.ped.posData[1], this.ped.posData[2]]
                : null;
            if (this.showModels || this.showPlayer) {
                const modelsReady = await this.ensureModelsInitialized();
                if (modelsReady) {
                    await this._warmupStreaming({
                        showOverlay: true,
                        timeoutMs: this.spawnDistrictDemo ? 90000 : 30000,
                        // Source residency can enqueue thousands of unrelated
                        // submeshes.  Waiting eight seconds here kept the renderer
                        // stopped even after the spawn chunks were usable, which made
                        // a cold refresh look like a ped-only scene.  The animation
                        // loop reprioritizes the remainder against the active camera.
                        minWaitMs: this.spawnDistrictDemo ? 4500 : 0,
                        centerDataPos: spawnWarmupCenter,
                    });
                    // Mesh metadata and skinned bounds are now final, so rebuild the player
                    // transform once before its first visible frame.
                    try { this._syncPlayerEntityMesh(true); } catch { /* ignore */ }
                }
            }

            // The first visible character frame now has both the player and nearby road data.
            this._loading = false;
            this._loadingResolve?.();
            this._setLoading({ visible: false, progress: 1.0 });
            this._startAnimationLoop();
            this._markWorldReady();
            this._setBootStatus('');
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
            // After the first playable frame, model/chunk warmup must stay in the lightweight status panel.
            // This prevents background manifest work from bringing the fullscreen loader back.
            if (visible === true && !this._loading) visible = false;
            window.__viewerSetLoading?.({ title, detail, progress, visible });
        } catch {
            // ignore
        }
    }

    _markWorldReady() {
        if (this._worldReady) return;
        this._worldReady = true;
        try {
            window.dispatchEvent(new CustomEvent('webglgta:world-ready'));
        } catch {
            // CustomEvent is available in supported browsers. Do not make a
            // non-essential integration signal affect renderer startup.
        }
    }

    async _initializeAppearancePreview() {
        try {
            this.spawnDistrictDemo = false;
            this.showModels = true;
            this.showPlayer = true;
            this.enablePostFx = false;
            this.atmosphereEnabled = true;
            this.timeOfDayHours = 12;
            this._setLoading({ title: 'Loading character preview', detail: 'Loading freemode components', progress: 0.2, visible: true });
            this._dataToViewMatrix = glMatrix.mat4.create();
            glMatrix.mat4.rotateX(this._dataToViewMatrix, this._dataToViewMatrix, -Math.PI / 2);
            this._viewToDataMatrix = glMatrix.mat4.create();
            glMatrix.mat4.invert(this._viewToDataMatrix, this._dataToViewMatrix);
            await this.skyRenderer.init();
            await this.pedRenderer.init();
            await this.modelManager.init('assets/models/manifest.json');
            await this.instancedModelRenderer.init();
            this.modelsInitialized = true;
            await this._loadRuntimeCharacterProfile({ timeoutMs: 5_000 });
            await this._loadRuntimeCharacterComponentCatalog();
            if (!this.runtimeCharacterProfile) throw new Error('Runtime freemode character profile is unavailable');
            await Promise.all([
                this._loadRuntimePlayerSkeleton(this.runtimeCharacterProfile),
                this._loadRuntimePlayerAnimations(this.runtimeCharacterProfile),
            ]);
            this.player.enabled = true;
            this.player.lod = 'high';
            this.player.headingRad = 0;
            this.player.animPhase = 0;
            this.player.animMove01 = 0;
            this.player.animGait = 'idle';
            this.spawnPedAt([0, 0, this.pedEyeHeightData], { groundSource: 'appearance_preview' });
            this.camera.position[0] = 0;
            this.camera.position[1] = 1.15;
            this.camera.position[2] = 3.4;
            this.camera.lookAtPoint([0, 1.0, 0]);
            this.camera.setFovDegrees?.(42);
            this.camera.setClipPlanes?.(0.05, 100);
            this.camera.updateViewMatrix();
            await this._ensurePlayerModelRenderer();
            this._applyPlayerRenderTargetsFromProfileOrUi({ preserveStored: true });
            this._tryApplyClothingPackPreview();
            this._syncPlayerEntityMesh(true);
            this.playerModelRenderer?.pumpMeshLoadsOnce?.();
            if (this.gtaHud?.root) this.gtaHud.root.style.display = 'none';
            this._loading = false;
            this._loadingResolve?.();
            this._setLoading({ visible: false, progress: 1 });
            this._startAnimationLoop();
            this._markWorldReady();
            this._setBootStatus('');
        } catch (error) {
            console.error('Failed to initialize character preview:', error);
            const message = `Character preview failed:\n${error?.message || error}`;
            this._setBootStatus(message);
            try { window.__viewerShowFatal?.(message); } catch { /* ignore */ }
        }
    }

    async _resolveRuntimeSpawn({ timeoutMs = 1400 } = {}) {
        // Static demo hosting has no resolver route. Deployments that provide one
        // can opt in before App initialization; the bundled spawn remains the default.
        if (globalThis.__WEBGLGTA_ENABLE_RUNTIME_SPAWN_RESOLVER !== true) return null;
        const ms = Number.isFinite(Number(timeoutMs)) ? Math.max(200, Number(timeoutMs)) : 1400;
        const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = ac ? window.setTimeout(() => ac.abort(), ms) : null;
        try {
            const resp = await fetch('/__spawn/resolve', {
                method: 'GET',
                cache: 'no-store',
                signal: ac?.signal,
            });
            if (!resp.ok) return null;
            const data = await resp.json().catch(() => null);
            if (!data?.ok || !data?.spawn) return null;
            return data;
        } catch {
            return null;
        } finally {
            if (timer !== null) window.clearTimeout(timer);
        }
    }

    async _loadBundledRuntimeSpawn({ timeoutMs = 1000 } = {}) {
        if (this._bundledRuntimeSpawn?.spawn) return this._bundledRuntimeSpawn;
        const ms = Number.isFinite(Number(timeoutMs)) ? Math.max(200, Number(timeoutMs)) : 1000;
        const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = ac ? window.setTimeout(() => ac.abort(), ms) : null;
        try {
            const response = await fetch('assets/runtime_spawn.json', {
                cache: 'no-store',
                signal: ac?.signal,
            });
            if (!response.ok) return null;
            const data = await response.json().catch(() => null);
            const ped = this._spawnObjToVector4(data?.spawn?.ped);
            if (!data?.spawn || !ped || !this._isFiniteVec2(ped)) return null;
            this._bundledRuntimeSpawn = {
                ...data,
                diagnostics: {
                    ...(data?.diagnostics || {}),
                    fallback: 'assets/runtime_spawn.json',
                },
            };
            return this._bundledRuntimeSpawn;
        } catch {
            return null;
        } finally {
            if (timer !== null) window.clearTimeout(timer);
        }
    }

    async _loadGameplayManifest({ timeoutMs = 900, refresh = false } = {}) {
        this._gameplayManifestStatus = 'loading';
        const manifest = await this.spawnSystem?.load?.({ timeoutMs, refresh });
        if (!manifest?.ok) {
            this.runtimeGameplayManifest = null;
            this._gameplayManifestStatus = this.spawnSystem?.lastError || 'missing';
            return null;
        }

        let effectiveManifest = manifest;
        if (this.spawnDistrictDemo) {
            try {
                const interactables = await fetchJSON('assets/demo/interactables.json?rev=parking-gates-v1', {
                    priority: 'high',
                    usePersistentCache: false,
                });
                if (interactables?.schema === 'webglgta-demo-interactables-v1') {
                    effectiveManifest = { ...manifest, doors: interactables.doors || [], interactableInventory: interactables.inventory || {} };
                }
            } catch { /* demo remains playable without optional interactables */ }
        }
        this.runtimeGameplayManifest = effectiveManifest;
        try { this.collisionWorld?.setManifest?.(effectiveManifest); } catch { /* ignore */ }
        try { this.interactionSystem?.setManifest?.(effectiveManifest); } catch { /* ignore */ }
        try { this.doorController?.setManifest?.(effectiveManifest); } catch { /* ignore */ }
        try { this.vehicleController?.setManifest?.(effectiveManifest); } catch { /* ignore */ }

        const s = this.spawnSystem?.summarize?.() || {};
        this._gameplayManifestStatus =
            `${s.mode || 'loaded'} jobs=${s.jobs || 0} items=${s.items || 0} shops=${s.shops || 0} ` +
            `garages=${s.garages || 0} vehicles=${s.vehicles || 0} interactions=${s.interactions || 0}`;
        return manifest;
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

        const savedVersion = Number(data.__version ?? 0);
        if (!Number.isFinite(savedVersion) || savedVersion < 2) {
            // Older builds defaulted to restoring aerial/map camera state. Reset that legacy default so
            // the viewer now opens as a street-level city character unless the user opts in again.
            data.restoreOnRefresh = false;
        }
        if (!Number.isFinite(savedVersion) || savedVersion < 20) {
            const p = PERF_PROFILES.gameplay;
            Object.assign(data, {
                // The old visual heightfield was frequently left enabled in saved state. It is
                // only a coarse landscape reference and must not overlap a streamed city by default.
                showTerrain: false,
                showModels: p.showModels,
                showBuildings: false,
                showPlayer: true,
                showNpcs: true,
                enableAutoExposure: false,
                playerTextured: true,
                objectsTextured: false,
                terrainTextured: false,
                buildingsTextured: false,
                crossArchetypeInstancing: false,
                cacheStreamedChunks: p.cacheStreamedChunks,
                streamRadius: p.streamRadius,
                maxLoadedChunks: p.maxLoadedChunks,
                maxArchetypes: p.maxArchetypes,
                maxModelDistance: p.maxModelDistance,
                maxVisibleInstances: p.maxVisibleInstances,
                maxInstancesPerArchetype: p.maxInstancesPerArchetype,
                maxMeshLoadsInFlight: p.maxMeshLoadsInFlight,
                textureQuality: p.textureQuality,
                lodLevel: p.lodLevel,
                enableShadows: false,
                enablePostFx: false,
                enableBloom: false,
                groundPedToTerrain: true,
                characterModel: DEFAULT_CHARACTER_MODEL_NAME,
                assetPicker: false,
            });
        }
        if (!Number.isFinite(savedVersion) || savedVersion < 21) {
            // Gameplay should boot with the actual textured character visible.
            // This also repairs version-20 saves that retained the old debug default.
            data.showPlayer = true;
            data.playerTextured = true;
        }
        if (!Number.isFinite(savedVersion) || savedVersion < 23) {
            data.ambientAudio = true;
            data.ambientVolume = '0.28';
            data.gameplayAudio = true;
            data.sfxVolume = '0.8';
            data.voiceVolume = '1';
            data.voiceMode = '1';
        }
        if (!Number.isFinite(savedVersion) || savedVersion < 24) {
            // Remove the previously unconditional cyan demo fence from both
            // clean starts and restored settings. Collision still owns limits.
            data.showDemoBoundary = false;
        }
        if (!Number.isFinite(savedVersion) || savedVersion < 25) data.vehiclePhysicsMode = 'gta';
        if (!Number.isFinite(savedVersion) || savedVersion < 26) data.vehicleCameraMode = 'chase';

        // Toggles + numeric/select knobs
        [
            'showTerrain', 'showBuildings', 'showWater', 'showEntityDots', 'entityDotsOverlay',
            'showPlayer', 'showNpcs', 'playerTextured', 'objectsTextured', 'terrainTextured', 'buildingsTextured',
            'showModels', 'crossArchetypeInstancing', 'showPlaceholders', 'showDemoBoundary',
            'followPed', 'controlPed', 'groundPedToTerrain', 'vehiclePhysicsMode', 'vehicleCameraMode',
            'enableAtmosphere', 'enableFog',
            'ambientAudio', 'ambientVolume', 'gameplayAudio', 'sfxVolume', 'voiceVolume', 'voiceMode',
            'enablePostFx', 'postFxExposure', 'postFxLum', 'enableAutoExposure', 'autoExposureSpeed', 'enableBloom', 'bloomStrength', 'bloomThreshold', 'bloomRadius',
            'frustumCulling', 'streamFromCamera',
            'enableOcclusionCulling', 'enableWebGpuCulling',
            'enableShadows', 'shadowMapSize',
            'enablePerfHud',
            'assetPicker',
            'restoreOnRefresh', 'cacheStreamedChunks',
            'streamRadius', 'maxLoadedChunks', 'maxArchetypes', 'maxModelDistance', 'maxVisibleInstances', 'maxInstancesPerArchetype', 'maxMeshLoadsInFlight',
            'textureQuality', 'lodLevel',
            'cameraSpeedPct',
            'timeOfDay', 'fogStart', 'fogEnd',
            'groundPedMaxDelta',
            'characterModel', 'pedCoords', 'camCoords',
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
            'showPlayer', 'showNpcs', 'playerTextured', 'objectsTextured', 'terrainTextured', 'buildingsTextured',
            'showModels', 'crossArchetypeInstancing', 'showPlaceholders', 'showDemoBoundary',
            'followPed', 'controlPed', 'groundPedToTerrain', 'vehiclePhysicsMode', 'vehicleCameraMode',
            'enableAtmosphere', 'enableFog',
            'ambientAudio', 'ambientVolume', 'gameplayAudio', 'sfxVolume', 'voiceVolume', 'voiceMode',
            'enablePostFx', 'postFxExposure', 'postFxLum', 'enableAutoExposure', 'autoExposureSpeed', 'enableBloom', 'bloomStrength', 'bloomThreshold', 'bloomRadius',
            'frustumCulling', 'streamFromCamera',
            'enableOcclusionCulling', 'enableWebGpuCulling',
            'enableShadows', 'shadowMapSize',
            'enablePerfHud',
            'assetPicker',
            'restoreOnRefresh', 'cacheStreamedChunks',
            'streamRadius', 'maxLoadedChunks', 'maxArchetypes', 'maxModelDistance', 'maxVisibleInstances', 'maxInstancesPerArchetype', 'maxMeshLoadsInFlight',
            'textureQuality', 'lodLevel',
            'cameraSpeedPct',
            'timeOfDay', 'fogStart', 'fogEnd',
            'groundPedMaxDelta',
            'characterModel', 'pedCoords', 'camCoords',
        ].forEach(read);

        out.__savedAt = new Date().toISOString();
        out.__version = _SETTINGS_VERSION;
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

            const player = data.player || null;
            if (this.ped && player && player.enabled) {
                const hash = String(player.hash || '').trim();
                this.player.enabled = true;
                this.player.hash = hash || String((joaat(DEFAULT_CHARACTER_MODEL_NAME) >>> 0));
                this.player.hashes = Array.isArray(player.hashes) && player.hashes.length
                    ? player.hashes.map((x) => String(x || '').trim()).filter(Boolean)
                    : [this.player.hash];
                this.player.labels = [];
                this.player.lod = String(player.lod || 'high');
                this.player.headingRad = Number(player.headingRad) || 0.0;
                this._applyPlayerRenderTargetsFromProfileOrUi({ preserveStored: true });
                try { this._syncPlayerEntityMesh(true); } catch { /* ignore */ }
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
            this._setSpawnCharacterButtonLabel();
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
            __version: _SETTINGS_VERSION,
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
            player: this.player?.enabled ? {
                enabled: true,
                hash: String(this.player.hash || ''),
                hashes: Array.isArray(this.player.hashes) ? this.player.hashes.slice(0, 64).map((h) => String(h)) : [],
                lod: String(this.player.lod || 'high'),
                headingRad: Number(this.player.headingRad) || 0.0,
            } : null,
        };
        this._safeLocalStorageSet(_LS_VIEW_KEY, JSON.stringify(payload));
    }

    _readStreamingUiParams() {
        const r = Number(document.getElementById('streamRadius')?.value ?? 2);
        const m = Number(document.getElementById('maxLoadedChunks')?.value ?? 25);
        const a = Number(document.getElementById('maxArchetypes')?.value ?? (this.drawableStreamer?.maxArchetypes ?? 250));
        const md = Number(document.getElementById('maxModelDistance')?.value ?? (this.drawableStreamer?.maxModelDistance ?? 350));
        const vi = Number(document.getElementById('maxVisibleInstances')?.value ?? (this.drawableStreamer?.maxVisibleInstances ?? 12000));
        const pa = Number(document.getElementById('maxInstancesPerArchetype')?.value ?? (this.drawableStreamer?.maxInstancesPerArchetype ?? 128));
        const ml = Number(document.getElementById('maxMeshLoadsInFlight')?.value ?? (this.instancedModelRenderer?.maxMeshLoadsInFlight ?? 6));
        const fc = !!document.getElementById('frustumCulling')?.checked;
        const webgpu = !!document.getElementById('enableWebGpuCulling')?.checked
            && getWebGpuCullingAvailability().available;

        const radius = Number.isFinite(r) ? Math.max(1, Math.min(24, Math.floor(r))) : 2;
        const maxLoaded = Number.isFinite(m) ? Math.max(9, Math.min(4000, Math.floor(m))) : 25;
        // 0 means "no cap" (distance cutoff still applies).
        const maxArch = Number.isFinite(a) ? Math.max(0, Math.floor(a)) : 250;
        const maxDist = Number.isFinite(md) ? Math.max(0, Math.min(100000, md)) : 350;
        const maxVisible = Number.isFinite(vi) ? Math.max(1, Math.min(1000000, Math.floor(vi))) : 12000;
        const maxPerArch = Number.isFinite(pa) ? Math.max(1, Math.min(100000, Math.floor(pa))) : 128;
        const maxLoads = Number.isFinite(ml) ? Math.max(1, Math.min(64, Math.floor(ml))) : 6;
        return { radius, maxLoaded, maxArch, maxDist, maxVisible, maxPerArch, maxLoads, fc, webgpu };
    }

    _getStreamingFocusDataPos() {
        // Free-map mode streams from the camera. Character mode should stream like the game:
        // the local ped is the focus, even when the third-person camera is offset behind it.
        if (this.ped) {
            return this.ped.posData;
        }
        return null;
    }

    _getSpawnDistrictBounds() {
        const authored = this._spawnDistrictDescriptor?.bounds;
        const authoredBounds = {
            minX: Number(authored?.minX),
            minY: Number(authored?.minY),
            maxX: Number(authored?.maxX),
            maxY: Number(authored?.maxY),
        };
        let baseBounds = null;
        if (
            Object.values(authoredBounds).every(Number.isFinite)
            && authoredBounds.maxX > authoredBounds.minX
            && authoredBounds.maxY > authoredBounds.minY
        ) {
            // The deployment descriptor is the single source of truth for the
            // bounded demo. Derived track/road extents can include unrelated
            // imported routes and previously expanded this 2 km district to
            // more than 11 km at runtime.
            return authoredBounds;
        }

        if (!baseBounds) {
            const ybn = this.collisionWorld?.ybnGround;
            const minX = Number(ybn?.minX);
            const minY = Number(ybn?.minY);
            const maxX = Number(ybn?.maxX);
            const maxY = Number(ybn?.maxY);
            if ([minX, minY, maxX, maxY].every(Number.isFinite) && maxX > minX && maxY > minY) {
                baseBounds = { minX, minY, maxX, maxY };
            }
        }
        const trackBounds = this.collisionWorld?.getDerivedRoadBounds?.();
        if (!baseBounds) return trackBounds || null;
        if (!trackBounds) return baseBounds;
        return {
            minX: Math.min(baseBounds.minX, trackBounds.minX), minY: Math.min(baseBounds.minY, trackBounds.minY),
            maxX: Math.max(baseBounds.maxX, trackBounds.maxX), maxY: Math.max(baseBounds.maxY, trackBounds.maxY),
        };
    }

    _clampDataPositionToSpawnDistrict(posData) {
        const x = Number(posData?.[0]);
        const y = Number(posData?.[1]);
        const z = Number(posData?.[2]);
        const b = this.spawnDistrictDemo ? this.spawnDistrictBounds : null;
        if (!b || !Number.isFinite(x) || !Number.isFinite(y)) return [x, y, z];
        return [
            Math.max(b.minX, Math.min(b.maxX, x)),
            Math.max(b.minY, Math.min(b.maxY, y)),
            z,
        ];
    }

    activateDemoDestination(destination = {}) {
        const x = Number(destination.x);
        const y = Number(destination.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false;

        // Switch movement ownership before the authoritative position arrives,
        // otherwise spawnPedAt() clamps the player back into the Legion cell.
        const halfSize = Math.max(80, Math.min(250, Number(destination.halfSize) || 150));
        const bounds = {
            minX: x - halfSize,
            minY: y - halfSize,
            maxX: x + halfSize,
            maxY: y + halfSize,
        };
        this.spawnDistrictDemo = true;
        this.spawnDistrictBounds = bounds;
        this.collisionWorld?.setMovementBounds?.(bounds);
        this.entityStreamer?.setWorldBounds?.(bounds);
        this.drawableStreamer?.setWorldBounds?.(bounds);
        if (this.demoBoundaryRenderer?.ready) {
            const offset = Number(this.collisionWorld?.ybnGroundOffset) || 0.0;
            this.demoBoundaryRenderer.setBounds(bounds, (sampleX, sampleY) => {
                const raw = this.collisionWorld?._getYbnGroundAtXY?.(sampleX, sampleY, NaN, 1000.0);
                return Number.isFinite(Number(raw)) ? Number(raw) + offset : NaN;
            });
        }
        this._runtimeSpawnInfo = {
            kind: 'destination_teleport',
            source: String(destination.label || destination.destination || 'destination'),
            ped: [x, y, Number(destination.z) || 0, 0],
        };
        return true;
    }

    _setSpawnDistrictDemo(enabled, { dropResident = true } = {}) {
        this.spawnDistrictDemo = !!enabled;
        this.spawnDistrictBounds = this.spawnDistrictDemo ? this._getSpawnDistrictBounds() : null;
        const bounds = this.spawnDistrictBounds;

        this.collisionWorld?.setMovementBounds?.(bounds);
        this.entityStreamer?.setWorldBounds?.(bounds);
        this.drawableStreamer?.setWorldBounds?.(bounds);
        if (!this.spawnDistrictDemo) {
            this.npcSystem?.clear?.();
            this._clearNpcEntityMeshes();
        }
        if (this.demoBoundaryRenderer?.ready) {
            if (bounds) {
                const offset = Number(this.collisionWorld?.ybnGroundOffset) || 0.0;
                this.demoBoundaryRenderer.setBounds(bounds, (x, y) => {
                    const raw = this.collisionWorld?._getYbnGroundAtXY?.(x, y, NaN, 1000.0);
                    return Number.isFinite(Number(raw)) ? Number(raw) + offset : NaN;
                });
            } else {
                this.demoBoundaryRenderer.clear();
            }
        }
        try {
            if (this.spawnDistrictDemo) {
                globalThis.__WEBGLGTA_TEXTURE_SLUG_FALLBACK = true;
            } else if (globalThis.__WEBGLGTA_TEXTURE_SLUG_FALLBACK === true) {
                delete globalThis.__WEBGLGTA_TEXTURE_SLUG_FALLBACK;
            }
        } catch { /* ignore */ }
        if (!this.spawnDistrictDemo) {
            this.entityStreamer?.setDemoBootstrap?.(null);
            this.drawableStreamer?.setDemoBootstrap?.(null);
            if (this.drawableStreamer) {
                this.drawableStreamer.enableWorkerFrustumCulling = false;
                this.drawableStreamer.enableWasmCulling = true;
                this.drawableStreamer.rebuildInstancesOnMove = false;
                this.drawableStreamer._dirty = true;
            }
        } else {
            // /demo is a bounded playable district. Always begin with its local
            // drawables and diffuse textures visible, regardless of a saved
            // full-map wireframe preference. The controls remain user-editable
            // once the demo has loaded.
            this.showTerrain = false;
            this.showBuildings = false;
            this.showModels = true;
            this.showNpcs = true;
            this.objectsWireframeMode = false;
            this.forcedModelLod = SPAWN_DEMO_MODEL_LOD;
            this._setControlValue('showTerrain', false);
            this._setControlValue('showBuildings', false);
            this._setControlValue('showModels', true);
            this._setControlValue('showNpcs', true);
            this._setControlValue('objectsTextured', true);
            this._setControlValue('lodLevel', SPAWN_DEMO_LOD_LEVEL);
            this._setControlValue('textureQuality', SPAWN_DEMO_TEXTURE_QUALITY);
            this._setControlValue('crossArchetypeInstancing', false);
            this._setControlValue('entityLodTraversal', false);
            this._applySpawnDistrictDemoBudget();
            // Software HZB occlusion uses a depth pass + readback cadence. Keep it
            // available in the UI, but default it off for gameplay frame pacing.
            this.enableOcclusionCulling = false;
            this._setControlValue('enableOcclusionCulling', false);
            if (this.drawableStreamer) {
                this.drawableStreamer.enableCrossArchetypeInstancing = false;
                this.drawableStreamer.forcedLod = this.forcedModelLod;
                if (typeof this.drawableStreamer.setEntityLodTraversalEnabled === 'function') {
                    this.drawableStreamer.setEntityLodTraversalEnabled(false);
                } else {
                    this.drawableStreamer.enableEntityLodTraversal = false;
                }
            }
            if (this.npcSystem) this.npcSystem.enabled = true;
            this._configureSpawnDistrictDemoOcclusion();
            if (this.occlusionCuller) this.occlusionCuller.enabled = false;
        }

        if (bounds && this.ped) {
            const current = this.ped.posData;
            const clamped = this._clampDataPositionToSpawnDistrict(current);
            if (clamped[0] !== current[0] || clamped[1] !== current[1]) {
                this.spawnPedAt(clamped, { groundSource: this._pedGroundSource });
            }
        }
        if (dropResident) this._dropStreamedResidency({ dropEntities: true });
        this._scheduleSaveSettings();
    }

    _configureSpawnDistrictDemoOcclusion() {
        const occ = this.occlusionCuller;
        if (!this.spawnDistrictDemo || !occ) return;
        // Keep the software HZB path active, but bias toward stability for the
        // visual demo so uncertain/near-edge bounds fail open instead of popping.
        occ.enableSoftwareHzb = true;
        occ.readbackEveryNFrames = 3;
        occ.depthEps = 0.006;
        occ.hzbMinScreenPixels = 8.0;
        occ.temporalKeepFrames = 6;
    }

    _applySpawnDistrictDemoBudget() {
        if (!this.spawnDistrictDemo) return;
        const descriptor = this._spawnDistrictDescriptor || null;
        const demoInstances = Math.max(0, Math.floor(Number(descriptor?.instanceCount) || 0));
        const demoNonRenderable = Math.max(0, Math.floor(Number(descriptor?.nonRenderableEntityCount) || 0));
        const demoRenderableInstances = Math.max(0, demoInstances - demoNonRenderable);
        const demoArchetypes = Math.max(
            0,
            Math.floor(Number(descriptor?.manifestArchetypeCount ?? descriptor?.archetypeCount) || 0),
        );
        const runtimeArchetypes = Math.max(
            demoArchetypes,
            Object.keys(this.modelManager?.manifest?.meshes || {}).length,
        );
        const bounds = descriptor?.bounds || null;
        const spanX = Math.max(0, Number(bounds?.maxX) - Number(bounds?.minX));
        const spanY = Math.max(0, Number(bounds?.maxY) - Number(bounds?.minY));
        const districtRadius = Math.hypot(spanX, spanY) * 0.5;
        const chunkedDemo = !!String(descriptor?.instanceIndexFile || '').trim();
        const expandedChunkedDemo = chunkedDemo && Math.max(spanX, spanY) >= 900;
        const runtimeInstances = Math.max(
            demoRenderableInstances,
            Math.floor(Number(this.drawableStreamer?.index?.total_entities) || 0),
        );
        // Keep a complete player-centered 3x3 neighborhood eligible and use
        // movement-directed look-ahead for driving.
        const budget = {
            radius: expandedChunkedDemo ? SPAWN_DEMO_STREAM_RADIUS_CHUNKS : (chunkedDemo ? 1 : 0),
            // The 3x3 core consumes nine slots. Expanded demos reserve three
            // more for movement-directed look-ahead.
            maxLoaded: expandedChunkedDemo ? SPAWN_DEMO_STREAM_MAX_CHUNKS : (chunkedDemo ? 9 : 1),
            // The compact supermesh manifest has more definitions than the source
            // descriptor because it includes MLO children and generated material
            // draws. A fixed 420-archetype cap silently removed most of the city.
            maxArch: runtimeArchetypes > 0
                ? Math.max(512, Math.min(4096, runtimeArchetypes + 16))
                : 2048,
            maxDist: expandedChunkedDemo
                ? SPAWN_DEMO_MAX_MODEL_DISTANCE
                : Math.max(340, Math.min(760, Math.ceil(districtRadius + 120))),
            maxVisible: runtimeInstances > 0 ? SPAWN_DEMO_MAX_VISIBLE_INSTANCES : 2048,
            maxPerArch: runtimeInstances > 0 ? SPAWN_DEMO_MAX_INSTANCES_PER_ARCHETYPE : 2048,
            maxLoads: chunkedDemo ? 12 : 10,
            fc: true,
        };
        this._applyStreamingParams(budget);
        this.showTerrain = false;
        this.showBuildings = false;
        this.forcedModelLod = SPAWN_DEMO_MODEL_LOD;
        this.enableOcclusionCulling = false;
        this._setControlValue('showTerrain', false);
        this._setControlValue('showBuildings', false);
        this._setControlValue('lodLevel', SPAWN_DEMO_LOD_LEVEL);
        this._setControlValue('textureQuality', SPAWN_DEMO_TEXTURE_QUALITY);
        this._setControlValue('enableOcclusionCulling', false);
        this._setControlValue('enableWebGpuCulling', false);
        this._setControlValue('crossArchetypeInstancing', false);
        this._setControlValue('entityLodTraversal', false);
        if (this.entityStreamer) {
            this.entityStreamer.maxNewLoadsPerUpdate = 1;
            this.entityStreamer.extraFrontChunks = 0;
        }
        if (this.drawableStreamer) {
            this.drawableStreamer.maxNewLoadsPerUpdate = expandedChunkedDemo ? 2 : 1;
            this.drawableStreamer.extraFrontChunks = expandedChunkedDemo ? SPAWN_DEMO_STREAM_FORWARD_CHUNKS : 0;
            this.drawableStreamer.prefetchHorizonSeconds = expandedChunkedDemo ? SPAWN_DEMO_STREAM_HORIZON_SECONDS : 6.0;
            this.drawableStreamer.maxResidentChunks = expandedChunkedDemo
                ? SPAWN_DEMO_STREAM_RESIDENT_CHUNKS
                : budget.maxLoaded;
            this.drawableStreamer.staleChunkGraceMs = expandedChunkedDemo ? SPAWN_DEMO_STREAM_STALE_GRACE_MS : 0;
            this.drawableStreamer.chunkRebuildSettleMs = expandedChunkedDemo ? SPAWN_DEMO_STREAM_REBUILD_SETTLE_MS : 0;
            // The compact demo index and static supermesh are already authored
            // for this bounded route. Global YMAP gate loading disables worker
            // rebuilds because source JSONL gating is not implemented there,
            // which forced one synchronous main-thread rebuild per tile.
            this.drawableStreamer.enableTimeWeatherYmapGating = false;
            this.drawableStreamer.enableWorkerRebuild = true;
            this.drawableStreamer.preferBinary = true;
            // Keep loaded tile buffers resident while the player crosses a
            // boundary. Camera-coupled worker compaction replaced them on every
            // turn/movement, causing upload spikes and obvious reappearance.
            this.drawableStreamer.enableWorkerFrustumCulling = false;
            this.drawableStreamer.enableWasmCulling = false;
            this.drawableStreamer.enableWebGpuCulling = false;
            this.drawableStreamer.webGpuCullingMinInstances = 2048;
            this.drawableStreamer.webGpuCullingMinSliceInstances = 1;
            this.drawableStreamer.enableCrossArchetypeInstancing = false;
            this.drawableStreamer.forcedLod = this.forcedModelLod;
            this.drawableStreamer.maxBehindModelDistance = budget.maxDist;
            if (typeof this.drawableStreamer.setEntityLodTraversalEnabled === 'function') {
                this.drawableStreamer.setEntityLodTraversalEnabled(false);
            } else {
                this.drawableStreamer.enableEntityLodTraversal = false;
            }
            this.drawableStreamer.workerFrustumPadding = 28.0;
            this.drawableStreamer.rebuildInstancesOnMove = false;
            this.drawableStreamer._dirty = true;
        }
        this._configureSpawnDistrictDemoOcclusion();
        if (this.occlusionCuller) this.occlusionCuller.enabled = false;
        try { setAssetFetchConcurrency(12); } catch { /* ignore */ }
        try { setAssetFetchPriorityConfig({ highShare: 0.9 }); } catch { /* ignore */ }
        try {
            const deviceMemoryGb = Number(this._defaultRuntimeCaps?.deviceMemoryGb);
            const constrainedDevice = Number.isFinite(deviceMemoryGb) && deviceMemoryGb <= 4;
            this.modelManager?.setMeshCacheCaps?.({
                // The deployed low-LOD mesh pack is about 290 MB before GPU
                // bookkeeping. The old 256 MB cap forced perpetual mesh churn.
                maxBytes: constrainedDevice ? (384 * 1024 * 1024) : (512 * 1024 * 1024),
            });
        } catch { /* ignore */ }
        // Keep nearby diffuse maps resident across streamed neighborhood changes.
        // Explicit profile changes such as Memory saver still override this.
        try {
            const deviceMemoryGb = Number(this._defaultRuntimeCaps?.deviceMemoryGb);
            const constrainedDevice = Number.isFinite(deviceMemoryGb) && deviceMemoryGb <= 4;
            this.textureStreamer?.setCacheCaps?.({
                // The demo contains many small material maps. A low entry cap can
                // churn while the byte cache is still mostly empty, causing visible
                // real-texture/placeholder flicker as the camera moves.
                maxTextures: constrainedDevice ? 2048 : 3072,
                maxBytes: constrainedDevice ? (256 * 1024 * 1024) : (384 * 1024 * 1024),
            });
            this.textureStreamer?.setStreamingConfig?.({
                maxLoadsInFlight: constrainedDevice ? 4 : 8,
                maxNewLoadsPerFrame: constrainedDevice ? 8 : 16,
            });
            this.textureStreamer?.setDistanceTierConfig?.({
                highDist: constrainedDevice ? 28 : 45,
                mediumDist: constrainedDevice ? 170 : 260,
                minResidentMs: constrainedDevice ? 6000 : 12000,
            });
            this.textureStreamer?.setQuality?.(SPAWN_DEMO_TEXTURE_QUALITY);
        } catch { /* ignore */ }

        // /demo is a visual-density test, not the memory-saver profile. Saved/default
        // gameplay settings leave objects in wireframe, which makes texture loading
        // look broken even when culling is doing the right thing.
        this.objectsWireframeMode = false;
        this._setControlValue('objectsTextured', true);

        this._setControlValue('streamRadius', budget.radius);
        this._setControlValue('maxLoadedChunks', budget.maxLoaded);
        this._setControlValue('maxArchetypes', budget.maxArch);
        this._setControlValue('maxModelDistance', budget.maxDist);
        this._setControlValue('maxVisibleInstances', budget.maxVisible);
        this._setControlValue('maxInstancesPerArchetype', budget.maxPerArch);
        this._setControlValue('maxMeshLoadsInFlight', budget.maxLoads);
    }

    async _loadSpawnDistrictDescriptor() {
        if (!this.spawnDistrictDemo) return null;
        const existing = this._spawnDistrictDescriptor;
        if (existing?.bounds && Number.isFinite(Number(existing.bounds.minX)) && Number.isFinite(Number(existing.bounds.minY))
            && Number.isFinite(Number(existing.bounds.maxX)) && Number.isFinite(Number(existing.bounds.maxY))) {
            return existing;
        }
        try {
            // This descriptor controls world bounds and names every compact source.
            // Revision the request so a newly preprocessed district cannot be paired
            // with an older browser-cached descriptor under the same filename.
            const descriptorPath = spawnDistrictDescriptorPath();
            const descriptor = await fetchJSON(`${descriptorPath}?rev=mlo-outpost-v1`, {
                priority: 'high',
                usePersistentCache: false,
                useMemoryCache: false,
            });
            const bounds = descriptor?.bounds;
            const validBounds = [bounds?.minX, bounds?.minY, bounds?.maxX, bounds?.maxY]
                .map(Number)
                .every(Number.isFinite) && Number(bounds?.maxX) > Number(bounds?.minX) && Number(bounds?.maxY) > Number(bounds?.minY);
            const instanceFile = String(descriptor?.instanceFile || '').trim();
            const pointFile = String(descriptor?.pointFile || '').trim();
            const manifestFile = String(descriptor?.manifestFile || '').trim();
            if (!validBounds || !instanceFile || !manifestFile) throw new Error('invalid spawn district descriptor');

            this._spawnDistrictDescriptor = descriptor;
            this.spawnDistrictBounds = {
                minX: Number(bounds.minX), minY: Number(bounds.minY),
                maxX: Number(bounds.maxX), maxY: Number(bounds.maxY),
            };
            return descriptor;
        } catch (e) {
            console.warn('[demo] Spawn district descriptor unavailable; using generic city spawn.', e);
            return null;
        }
    }

    async _prepareSpawnDistrictDemoAssets() {
        if (!this.spawnDistrictDemo) return false;
        try {
            const descriptor = await this._loadSpawnDistrictDescriptor();
            if (!descriptor) throw new Error('spawn district descriptor unavailable');
            const staticSupermeshRequested = isStaticSupermeshEnabled();
            const useStaticSupermesh = staticSupermeshRequested
                && !!descriptor?.staticSupermesh?.enabled
                && !isAssetPickDiagnosticEnabled();
            const runtimeDescriptor = useStaticSupermesh ? { ...descriptor, ...descriptor.staticSupermesh } : descriptor;
            const instanceFile = String(runtimeDescriptor.instanceFile || '').trim();
            const instanceIndexFile = String(runtimeDescriptor.instanceIndexFile || '').trim();
            const pointFile = String(descriptor.pointFile || '').trim();
            const manifestFile = String(runtimeDescriptor.manifestFile || '').trim();
            const destructibleManifestFile = String(descriptor.destructibleManifestFile || '').trim();
            const fragmentChildrenManifestFile = String(descriptor.fragmentChildrenManifestFile || '').trim();
            const assetColliderManifestFile = String(descriptor.assetColliderManifestFile || '').trim();
            const compiledCollisionManifestFile = String(descriptor.compiledCollisionManifestFile || '').trim();
            const manifestRevision = encodeURIComponent(String(
                runtimeDescriptor.sourceRevision || runtimeDescriptor.generatedAt || descriptor.generatedAt || 'v1'
            ));
            const manifest = await fetchJSON(`assets/${manifestFile.replace(/^assets\//i, '')}?rev=${manifestRevision}`, {
                priority: 'high',
                usePersistentCache: false,
                useMemoryCache: false,
            });
            const installed = this.modelManager?.installManifestSubset?.(manifest, { source: 'demo/spawn_district_models.json' }) ?? 0;
            if (destructibleManifestFile) {
                try {
                    const destructibleManifest = await fetchJSON(`assets/${destructibleManifestFile.replace(/^assets\//i, '')}`, {
                        priority: 'high',
                        usePersistentCache: false,
                        useMemoryCache: false,
                    });
                    const added = this.collisionWorld?.addDestructibles?.(destructibleManifest?.destructibles) ?? 0;
                    this._demoDestructibleManifest = destructibleManifest;
                    // Suppressing an instance after impact requires the local compact
                    // tile to remain on the main thread; the worker-only path has no
                    // entity identity in its message protocol yet.
                    if (added > 0 && this.drawableStreamer) this.drawableStreamer.enableWorkerRebuild = false;
                    console.info(`[demo] Installed ${added.toLocaleString()} authored fragment candidates.`);
                } catch (e) {
                    console.warn('[demo] Fragment gameplay manifest unavailable; continuing without destructible props.', e);
                }
            }
            if (compiledCollisionManifestFile) {
                try {
                    const compiledCollisionUrl = `assets/${compiledCollisionManifestFile.replace(/^assets\//i, '')}`;
                    const layers = await this.collisionWorld?.loadCompiledCollisionLayers?.(compiledCollisionUrl);
                    const streamPoint = Array.isArray(this.ped?.posData) && this.ped.posData.length >= 2
                        ? this.ped.posData
                        : [
                            (Number(descriptor?.bounds?.minX) + Number(descriptor?.bounds?.maxX)) * 0.5,
                            (Number(descriptor?.bounds?.minY) + Number(descriptor?.bounds?.maxY)) * 0.5,
                        ];
                    await Promise.all([
                        this.collisionWorld?.streamCompiledStaticCollisionAt?.(streamPoint[0], streamPoint[1]),
                        this.collisionWorld?.streamCompiledAssetCollidersAt?.(streamPoint[0], streamPoint[1]),
                    ]);
                    this._demoAssetColliderManifest = { compiled: true, layers };
                    console.info('[demo] Installed compiled-only streaming collision layers.');
                } catch (e) {
                    // No YBNC fallback here: a descriptor that opts in to this
                    // package must fail visibly if its deployment is incomplete.
                    throw new Error(`Compiled collision package unavailable: ${e?.message || e}`);
                }
            } else if (assetColliderManifestFile) {
                try {
                    const assetColliderRevision = encodeURIComponent(String(descriptor.assetColliderRevision || 'prop-physics-v9'));
                    const assetColliderUrl = `assets/${assetColliderManifestFile.replace(/^assets\//i, '')}?rev=${assetColliderRevision}`;
                    const assetColliders = await fetchJSON(assetColliderUrl, {
                        priority: 'high',
                        usePersistentCache: false,
                        useMemoryCache: false,
                    });
                    const added = this.collisionWorld?.setAssetColliders?.(assetColliders?.colliders) ?? 0;
                    this.collisionWorld?.setYbnCollisionExclusions?.(assetColliders?.ybnCollisionExclusions);
                    this._demoAssetColliderManifest = assetColliders;
                    const pushableCount = Number(assetColliders?.pushableColliderCount) || 0;
                    console.info(`[demo] Installed ${added.toLocaleString()} static asset collision bounds (${pushableCount.toLocaleString()} pushable).`);
                } catch (e) {
                    console.warn('[demo] Static asset collision manifest unavailable; using map YBN collision only.', e);
                }
            }
            if (fragmentChildrenManifestFile) {
                try {
                    const fragmentChildren = await fetchJSON(`assets/${fragmentChildrenManifestFile.replace(/^assets\//i, '')}`, {
                        priority: 'high',
                        usePersistentCache: false,
                        useMemoryCache: false,
                    });
                    const profileCount = this.fragmentDebrisSystem?.installManifest?.(fragmentChildren) ?? 0;
                    if (profileCount > 0) await this.fragmentDebrisSystem?.ensureRenderer?.();
                    console.info(`[demo] Installed ${profileCount.toLocaleString()} YFT child-debris profiles.`);
                } catch (e) {
                    console.warn('[demo] Fragment child meshes unavailable; intact fragment suppression remains active.', e);
                }
            }
            if (instanceIndexFile) {
                const demoIndex = await fetchJSON(`assets/${instanceIndexFile.replace(/^assets\//i, '')}?rev=${manifestRevision}`, {
                    priority: 'high',
                    usePersistentCache: false,
                    useMemoryCache: false,
                });
                if (!this.drawableStreamer?.setDemoChunkIndex?.(demoIndex)) {
                    throw new Error('invalid spawn district streaming index');
                }
            } else {
                this.drawableStreamer?.setDemoBootstrap?.({ key: '__demo_spawn_district__', instanceFile });
            }
            const interiorHashes = descriptor?.mloRuntime?.interiorArchetypeHashes;
            if (Array.isArray(interiorHashes) && interiorHashes.length > 0) {
                await this.drawableStreamer?.loadInteriorDefinitions?.(
                    interiorHashes,
                    descriptor?.mloRuntime?.revision || descriptor?.generatedAt || 'v1',
                );
            }
            if (pointFile) this.entityStreamer?.setDemoBootstrap?.({ key: '__demo_spawn_district__', pointFile });
            this._setSpawnDistrictDemo(true, { dropResident: false });
            if (useStaticSupermesh) {
                console.info(`[demo] Static supermeshes enabled: ${Number(descriptor.staticSupermesh.generatedDraws || 0).toLocaleString()} chunk/material draws, ${Number(descriptor.staticSupermesh.strippedSourceSubmeshes || 0).toLocaleString()} source submeshes replaced.`);
            } else if (descriptor?.staticSupermesh?.enabled && !isAssetPickDiagnosticEnabled()) {
                console.info('[demo] Using source drawable residency (static batching disabled by URL).');
            }
            console.info(`[demo] Prepared ${Number(descriptor.instanceCount || 0).toLocaleString()} instances and ${installed.toLocaleString()} model definitions.`);
            return true;
        } catch (e) {
            // Preserve the normal world-data path if a developer has not generated the demo bundle yet.
            console.warn('[demo] Compact district assets unavailable; using filtered source chunks.', e);
            this.entityStreamer?.setDemoBootstrap?.(null);
            this.drawableStreamer?.setDemoBootstrap?.(null);
            return false;
        }
    }

    onDestructibleDestroyed(event, destructible) {
        const debrisStarted = this.fragmentDebrisSystem?.breakFragment?.(event, destructible) ?? false;
        let hidden = false;
        if (debrisStarted) {
            // Do not let a first-time child-mesh fetch turn a hit prop invisible.
            // The intact streamed instance stays up until a real YFT child mesh is
            // resident in the debris renderer, then this exact instance is hidden.
            this.fragmentDebrisSystem?.deferSourceSuppression?.(event, () => {
                const coords = destructible?.coords || destructible || {};
                hidden = this.drawableStreamer?.suppressInstance?.({
                    archetypeHash: destructible?.archetypeHash || event?.archetypeHash,
                    x: Number(coords.x),
                    y: Number(coords.y),
                    z: Number(coords.z),
                    radius: Number(destructible?.radius),
                }) ?? false;
            });
        }
        try {
            const visibility = debrisStarted ? ' with YFT debris' : ' (intact visual retained: no YFT child mesh export)';
            console.info(`[gameplay] ${String(event?.source || 'impact')} destroyed ${String(event?.label || event?.id || 'fragment')}${hidden ? '' : ' (source remains until debris is resident)'}${visibility}`);
        } catch { /* ignore diagnostic failures */ }
    }

    onDynamicPropMoved(event) {
        this.drawableStreamer?.setInstanceTransformOverride?.({
            archetypeHash: event?.archetypeHash,
            source: event?.source,
            position: event?.position,
        });
    }

    _cancelStreamingRamp() {
        if (this._streamingRampTimer) {
            clearInterval(this._streamingRampTimer);
            this._streamingRampTimer = null;
        }
    }

    _applyStreamingParams({ radius, maxLoaded, maxArch, maxDist, maxVisible, maxPerArch, maxLoads, fc } = {}) {
        if (this.entityStreamer) {
            if (Number.isFinite(radius)) this.entityStreamer.radiusChunks = radius;
            if (Number.isFinite(maxLoaded)) this.entityStreamer.maxLoadedChunks = maxLoaded;
            if (typeof fc === 'boolean') this.entityStreamer.enableFrustumCulling = fc;
        }
        if (this.drawableStreamer) {
            let changed = false;
            const assignNumber = (key, value) => {
                if (!Number.isFinite(value) || Number(this.drawableStreamer[key]) === Number(value)) return;
                this.drawableStreamer[key] = value;
                changed = true;
            };
            assignNumber('radiusChunks', radius);
            assignNumber('maxLoadedChunks', maxLoaded);
            assignNumber('maxArchetypes', maxArch);
            assignNumber('maxModelDistance', maxDist);
            assignNumber('maxVisibleInstances', maxVisible);
            assignNumber('maxInstancesPerArchetype', maxPerArch);
            if (typeof fc === 'boolean' && this.drawableStreamer.enableFrustumCulling !== fc) {
                this.drawableStreamer.enableFrustumCulling = fc;
                changed = true;
            }
            if (changed) this.drawableStreamer._dirty = true;
        }
        if (this.instancedModelRenderer) {
            if (Number.isFinite(maxLoads)) this.instancedModelRenderer.maxMeshLoadsInFlight = maxLoads;
        }
    }

    _setControlValue(id, value) {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.type === 'checkbox') el.checked = !!value;
        else el.value = String(value);
    }

    _dropStreamedResidency({ dropEntities = false } = {}) {
        try { this._cancelStreamingRamp(); } catch { /* ignore */ }
        try { this.fragmentDebrisSystem?.clear?.(); } catch { /* ignore */ }
        try { this.instancedModelRenderer?.clearScene?.(); } catch { /* ignore */ }
        try { this.modelManager?.clearMeshCache?.(); } catch { /* ignore */ }
        try { this.textureStreamer?.clear?.(); } catch { /* ignore */ }
        try { this.drawableStreamer?.clear?.(); } catch { /* ignore */ }
        if (dropEntities) {
            try { this.entityStreamer?.clear?.(this.entityRenderer); } catch { /* ignore */ }
            try { this.entityRenderer?.clear?.(); } catch { /* ignore */ }
        }
        try { clearAssetMemoryCaches(); } catch { /* ignore */ }
        if (this.showPlayer && this.player?.enabled) {
            try { this._syncPlayerEntityMesh(true); } catch { /* ignore */ }
        }
    }

    _applyPerformanceProfile(name = 'gameplay', { updateUi = true, dropResident = false, save = false, startModels = false } = {}) {
        const key = Object.prototype.hasOwnProperty.call(PERF_PROFILES, name) ? String(name) : 'gameplay';
        const p = PERF_PROFILES[key];
        this._activePerformanceProfile = key;

        if (updateUi) {
            this._setControlValue('streamRadius', p.streamRadius);
            this._setControlValue('maxLoadedChunks', p.maxLoadedChunks);
            this._setControlValue('maxArchetypes', p.maxArchetypes);
            this._setControlValue('maxModelDistance', p.maxModelDistance);
            this._setControlValue('maxVisibleInstances', p.maxVisibleInstances);
            this._setControlValue('maxInstancesPerArchetype', p.maxInstancesPerArchetype);
            this._setControlValue('maxMeshLoadsInFlight', p.maxMeshLoadsInFlight);
            this._setControlValue('textureQuality', p.textureQuality);
            this._setControlValue('lodLevel', p.lodLevel);
            this._setControlValue('showModels', p.showModels);
            this._setControlValue('objectsTextured', !p.wireframe);
            this._setControlValue('terrainTextured', !p.wireframe);
            this._setControlValue('buildingsTextured', !p.wireframe);
            this._setControlValue('cacheStreamedChunks', p.cacheStreamedChunks);
            this._setControlValue('frustumCulling', true);
            this._setControlValue('enableWebGpuCulling', false);
            this._setControlValue('enableShadows', false);
            this._setControlValue('enablePostFx', false);
            this._setControlValue('enableBloom', false);
        }

        this.showModels = !!p.showModels;
        this.objectsWireframeMode = !!p.wireframe;
        this.terrainWireframeMode = !!p.wireframe;
        this.buildingsWireframeMode = !!p.wireframe;
        this.cacheStreamedChunks = !!p.cacheStreamedChunks;
        if (this.entityStreamer) this.entityStreamer.usePersistentCacheForChunks = this.cacheStreamedChunks;
        if (this.drawableStreamer) this.drawableStreamer.usePersistentCacheForChunks = this.cacheStreamedChunks;

        try { setAssetFetchConcurrency(p.assetConcurrency); } catch { /* ignore */ }
        try { setAssetFetchPriorityConfig({ highShare: 0.82 }); } catch { /* ignore */ }
        try { this.modelManager?.setMeshCacheCaps?.({ maxBytes: p.meshMaxBytes }); } catch { /* ignore */ }
        try {
            this.textureStreamer?.setCacheCaps?.({ maxTextures: p.texMaxTextures, maxBytes: p.texMaxBytes });
            this.textureStreamer?.setStreamingConfig?.({
                maxLoadsInFlight: p.texLoadsInFlight,
                maxNewLoadsPerFrame: p.texNewLoadsPerFrame,
            });
            this.textureStreamer?.setQuality?.(p.textureQuality);
        } catch { /* ignore */ }

        this._applyLodFromUI?.();
        this._applyStreamingFromUI?.();
        if (this.spawnDistrictDemo) {
            // Quality presets may lower texture resolution, mesh LOD, cache size,
            // and upload concurrency, but they must not remove authored world
            // geometry from the bounded demo. Preserve a complete local chunk
            // budget independently of the selected visual quality.
            const descriptor = this._spawnDistrictDescriptor || null;
            const bounds = descriptor?.bounds || null;
            const spanX = Math.max(0, Number(bounds?.maxX) - Number(bounds?.minX));
            const spanY = Math.max(0, Number(bounds?.maxY) - Number(bounds?.minY));
            const districtRadius = Math.hypot(spanX, spanY) * 0.5;
            const expandedChunkedDemo = !!String(descriptor?.instanceIndexFile || '').trim()
                && Math.max(spanX, spanY) >= 900;
            const runtimeArchetypes = Object.keys(this.modelManager?.manifest?.meshes || {}).length;
            const runtimeInstances = Math.max(
                Math.floor(Number(descriptor?.instanceCount) || 0),
                Math.floor(Number(this.drawableStreamer?.index?.total_entities) || 0),
            );
            const geometryFloor = {
                radius: expandedChunkedDemo ? SPAWN_DEMO_STREAM_RADIUS_CHUNKS : 1,
                maxLoaded: expandedChunkedDemo ? SPAWN_DEMO_STREAM_MAX_CHUNKS : 12,
                maxArch: Math.max(512, Math.min(4096, runtimeArchetypes + 16)),
                maxDist: expandedChunkedDemo
                    ? SPAWN_DEMO_MAX_MODEL_DISTANCE
                    : Math.max(340, Math.min(760, Math.ceil(districtRadius + 120))),
                maxVisible: runtimeInstances > 0 ? SPAWN_DEMO_MAX_VISIBLE_INSTANCES : 2048,
                maxPerArch: runtimeInstances > 0 ? SPAWN_DEMO_MAX_INSTANCES_PER_ARCHETYPE : 2048,
                maxLoads: Math.max(6, Number(p.maxMeshLoadsInFlight) || 6),
                fc: true,
            };
            this._applyStreamingParams(geometryFloor);
            this._setControlValue('streamRadius', geometryFloor.radius);
            this._setControlValue('maxLoadedChunks', geometryFloor.maxLoaded);
            this._setControlValue('maxArchetypes', geometryFloor.maxArch);
            this._setControlValue('maxModelDistance', geometryFloor.maxDist);
            this._setControlValue('maxVisibleInstances', geometryFloor.maxVisible);
            this._setControlValue('maxInstancesPerArchetype', geometryFloor.maxPerArch);
            this._setControlValue('maxMeshLoadsInFlight', geometryFloor.maxLoads);
        }
        if (dropResident) this._dropStreamedResidency({ dropEntities: true });
        if (startModels && (this.showModels || this.showPlayer)) {
            void this.ensureModelsInitialized?.().then((ok) => {
                if (!ok) {
                    this.showModels = false;
                    this._setControlValue('showModels', false);
                }
            });
        }
        if (save) this._scheduleSaveSettings();
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
            maxVisible: Math.min(8000, target.maxVisible),
            maxPerArch: Math.min(96, target.maxPerArch),
            maxLoads: Math.min(6, target.maxLoads),
            fc: target.fc,
        };

        // Only clamp down; don't unexpectedly increase if user already chose tiny settings.
        const curRadius = this.entityStreamer?.radiusChunks ?? boot.radius;
        const curLoaded = this.entityStreamer?.maxLoadedChunks ?? boot.maxLoaded;
        const curArch = this.drawableStreamer?.maxArchetypes ?? boot.maxArch;
        const curDist = this.drawableStreamer?.maxModelDistance ?? boot.maxDist;
        const curVisible = this.drawableStreamer?.maxVisibleInstances ?? boot.maxVisible;
        const curPerArch = this.drawableStreamer?.maxInstancesPerArchetype ?? boot.maxPerArch;
        const curLoads = this.instancedModelRenderer?.maxMeshLoadsInFlight ?? boot.maxLoads;

        const start = {
            radius: Math.min(curRadius, boot.radius),
            maxLoaded: Math.min(curLoaded, boot.maxLoaded),
            maxArch: Math.min(curArch, boot.maxArch),
            maxDist: Math.min(curDist, boot.maxDist),
            maxVisible: Math.min(curVisible, boot.maxVisible),
            maxPerArch: Math.min(curPerArch, boot.maxPerArch),
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
            const curV = this.drawableStreamer?.maxVisibleInstances ?? start.maxVisible;
            const curP = this.drawableStreamer?.maxInstancesPerArchetype ?? start.maxPerArch;
            const curL = this.instancedModelRenderer?.maxMeshLoadsInFlight ?? start.maxLoads;

            const next = {
                radius: Math.min(latest.radius, curR + 1),
                maxLoaded: Math.min(latest.maxLoaded, curM + 60),
                maxArch: Math.min(latest.maxArch, curA + 200),
                maxDist: Math.min(latest.maxDist, curD + 250),
                maxVisible: Math.min(latest.maxVisible, curV + 8000),
                maxPerArch: Math.min(latest.maxPerArch, curP + 128),
                maxLoads: Math.min(latest.maxLoads, curL + 1),
                fc: latest.fc,
            };

            this._applyStreamingParams(next);

            const done =
                next.radius >= latest.radius &&
                next.maxLoaded >= latest.maxLoaded &&
                next.maxArch >= latest.maxArch &&
                next.maxDist >= latest.maxDist &&
                next.maxVisible >= latest.maxVisible &&
                next.maxPerArch >= latest.maxPerArch &&
                next.maxLoads >= latest.maxLoads;

            if (done) this._cancelStreamingRamp();
        }, stepMs);
    }

    async _preloadModelsIfEnabled({ showOverlay = true, maxWaitMs = 1800 } = {}) {
        if (!this.showModels && !this.showPlayer) return;
        if (!showOverlay) this._setBootStatus('Loading GTA models manifest in background...');
        if (showOverlay) this._setLoading({
            title: 'Loading world…',
            detail: 'Loading GTA models manifest… (large manifests may take a while; you can skip)',
            progress: 0.55,
            visible: true,
        });

        // Start the heavy model pipeline init, but only wait a short time for "fast path" wins.
        // If it takes longer, let it continue in the background and don't block first render.
        const initPromise = this.ensureModelsInitialized();
        if (maxWaitMs <= 0) {
            void initPromise;
            return;
        }
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

    async _warmupStreaming({ showOverlay = true, timeoutMs = 6000, minWaitMs = 0, centerDataPos = null } = {}) {
        // If user skipped, do the bare minimum and get to first frame.
        if (this._loadingSkipped) return;

        // Use a supplied spawn focus when available, otherwise match the main update loop.
        const center = centerDataPos || this._getStreamingFocusDataPos();

        // Fast-start: temporarily use a small bubble and ramp up to UI settings in the background.
        // This makes "first look around" responsive instead of waiting on a huge chunk burst.
        if (this.spawnDistrictDemo) this._cancelStreamingRamp();
        else this._startStreamingFastRamp();

        // Kick streaming once to populate wanted keys and begin async loads.
        if (this.entityReady && this.showEntityDots) this.entityStreamer.update(this.camera, this.entityRenderer, center);
        try { this.entityStreamer?.setTimeWeather?.({ hour: this.timeOfDayHours, weather: this.weatherType }); } catch { /* ignore */ }
        try { this.drawableStreamer?.setTimeWeather?.({ hour: this.timeOfDayHours, weather: this.weatherType }); } catch { /* ignore */ }
        if (this.showModels && this.modelsInitialized) this.drawableStreamer.update(this.camera, center);

        // Wait briefly for initial chunk bubble to load (bounded; don't hang forever).
        const start = performance.now();
        const tickMs = 60;
        let settledTicks = 0;
        const initialTextureStats = this.textureStreamer?.getStats?.() || null;
        const initialMaxLoadsInFlight = initialTextureStats?.maxLoadsInFlight;
        const initialMaxNewLoadsPerFrame = initialTextureStats?.maxNewLoadsPerFrame;
        const initialMaxMeshLoadsInFlight = this.instancedModelRenderer?.maxMeshLoadsInFlight;
        const initialMaxMeshPackCacheBytes = this.modelManager?.maxMeshPackCacheBytes;
        const initialMaxPackedMeshUploadsPerFrame = this.modelManager?.maxPackedMeshUploadsPerFrame;
        const initialMaxPackedMeshUploadMsPerFrame = this.modelManager?.maxPackedMeshUploadMsPerFrame;
        const demoWarmupFetchConcurrency = this.spawnDistrictDemo ? 24 : null;
        if (demoWarmupFetchConcurrency) {
            // The bounded demo has four local entity chunks and a fixed mesh
            // cache budget. Keeping its fetch lane at the initial 24 requests
            // avoids releasing a ped-only scene then halving throughput while
            // the immediate street still has more than a thousand meshes queued.
            try { setAssetFetchConcurrency(demoWarmupFetchConcurrency); } catch { /* ignore */ }
        }
        if (this.spawnDistrictDemo && this.textureStreamer?.setStreamingConfig) {
            this.textureStreamer.setStreamingConfig({
                maxLoadsInFlight: Math.max(16, Number(initialMaxLoadsInFlight) || 0),
                maxNewLoadsPerFrame: Math.max(32, Number(initialMaxNewLoadsPerFrame) || 0),
            });
        }
        if (this.spawnDistrictDemo && this.instancedModelRenderer) {
            // The first playable scene is staged before the animation loop starts,
            // so use a short, bounded burst here. The normal per-frame limit is
            // restored immediately afterward.
            this.instancedModelRenderer.maxMeshLoadsInFlight = Math.max(24, Number(initialMaxMeshLoadsInFlight) || 0);
        }
        if (this.spawnDistrictDemo && this.modelManager) {
            // Demo mesh references are slices of a small number of shared packs. Retaining the
            // complete starter set during boot avoids repeatedly downloading an evicted pack.
            this.modelManager.maxMeshPackCacheBytes = Math.max(192 * 1024 * 1024, Number(initialMaxMeshPackCacheBytes) || 0);
            this.modelManager.maxPackedMeshUploadsPerFrame = Math.max(32, Number(initialMaxPackedMeshUploadsPerFrame) || 0);
            this.modelManager.maxPackedMeshUploadMsPerFrame = Math.max(14, Number(initialMaxPackedMeshUploadMsPerFrame) || 0);
        }
        const restoreTextureConfig = () => {
            if (demoWarmupFetchConcurrency) {
                // _applySpawnDistrictDemoBudget owns the steady-state demo
                // value. Restore it after the bounded boot burst so movement
                // and texture streaming keep their low-memory cadence.
                try { setAssetFetchConcurrency(12); } catch { /* ignore */ }
            }
            if (this.spawnDistrictDemo && this.textureStreamer?.setStreamingConfig) {
                this.textureStreamer.setStreamingConfig({
                    maxLoadsInFlight: initialMaxLoadsInFlight,
                    maxNewLoadsPerFrame: initialMaxNewLoadsPerFrame,
                });
            }
            if (this.spawnDistrictDemo && this.instancedModelRenderer && Number.isFinite(Number(initialMaxMeshLoadsInFlight))) {
                this.instancedModelRenderer.maxMeshLoadsInFlight = Number(initialMaxMeshLoadsInFlight);
            }
            if (this.spawnDistrictDemo && this.modelManager) {
                if (Number.isFinite(Number(initialMaxMeshPackCacheBytes))) {
                    // The active 300 m demo references about 134 MB of packed
                    // source meshes. Returning to the 32 MB global default
                    // immediately evicted packs that the player would need
                    // again after a turn, producing the visible rebuild/pop-in
                    // loop. Keep a fixed, bounded local residency window.
                    this.modelManager.maxMeshPackCacheBytes = Math.max(
                        160 * 1024 * 1024,
                        Number(initialMaxMeshPackCacheBytes),
                    );
                }
                if (Number.isFinite(Number(initialMaxPackedMeshUploadsPerFrame))) {
                    // Once the first frame is live, retain a modestly wider upload
                    // budget for the bounded demo. Restoring the global default of
                    // two mesh uploads per frame made a cold city take tens of
                    // seconds to fill despite its data already being resident.
                    this.modelManager.maxPackedMeshUploadsPerFrame = Math.max(
                        6,
                        Number(initialMaxPackedMeshUploadsPerFrame),
                    );
                }
                if (Number.isFinite(Number(initialMaxPackedMeshUploadMsPerFrame))) {
                    this.modelManager.maxPackedMeshUploadMsPerFrame = Math.max(
                        8,
                        Number(initialMaxPackedMeshUploadMsPerFrame),
                    );
                }
            }
        };

        // Compute the set of chunk keys that actually exist in the index (missing meta should not block boot).
        const wantedEntity = (this.entityReady && this.showEntityDots && this.entityStreamer?.getWantedKeys)
            ? this.entityStreamer.getWantedKeys(this.camera, center).filter((k) => (
                k === this.entityStreamer?.demoBootstrap?.key || !!this.entityStreamer?.index?.chunks?.[k]
            ))
            : [];
        const wantedDraw = (this.showModels && this.modelsInitialized && this.drawableStreamer?.getWantedKeys)
            ? this.drawableStreamer.getWantedKeys(this.camera, center).filter((k) => (
                k === this.drawableStreamer?.demoBootstrap?.key || !!this.drawableStreamer?.index?.chunks?.[k]
            ))
            : [];
        let diffuseOutstanding = 0;
        let secondaryOutstanding = 0;

        while (performance.now() - start < timeoutMs) {
            if (this._loadingSkipped) {
                restoreTextureConfig();
                return;
            }

            // Keep requesting wanted chunks (async loads are fire-and-forget).
            if (this.entityReady && this.showEntityDots) this.entityStreamer.update(this.camera, this.entityRenderer, center);
            try { this.entityStreamer?.setTimeWeather?.({ hour: this.timeOfDayHours, weather: this.weatherType }); } catch { /* ignore */ }
            try { this.drawableStreamer?.setTimeWeather?.({ hour: this.timeOfDayHours, weather: this.weatherType }); } catch { /* ignore */ }
            if (this.showModels && this.modelsInitialized) this.drawableStreamer.update(this.camera, center);

            // Drive mesh queue without drawing.
            if (this.showModels && this.modelsInitialized) {
                try { this.textureStreamer?.beginFrame?.(); } catch { /* ignore */ }
                this.instancedModelRenderer?.pumpMeshLoadsOnce?.(this.camera?.position, this.gpuFrustumCulling);
                const textureQuality = String(this.textureStreamer?.quality || 'medium').toLowerCase();
                const demoPrefetchLimit = textureQuality === 'high' ? 1536 : (textureQuality === 'medium' ? 1024 : 512);
                const prefetchLimit = this.spawnDistrictDemo ? demoPrefetchLimit : 48;
                diffuseOutstanding = 0;
                secondaryOutstanding = 0;
                if (!this.objectsWireframeMode) {
                    diffuseOutstanding = this.instancedModelRenderer?.prefetchDiffuseTextures?.(prefetchLimit, {
                        includeSecondary: false,
                        skipSettled: this.spawnDistrictDemo,
                    }) || 0;
                    // Once all visible color maps have been scheduled, spend the remaining
                    // loading-screen time on material detail for medium and high quality.
                    if (this.spawnDistrictDemo && diffuseOutstanding === 0 && textureQuality !== 'low') {
                        secondaryOutstanding = this.instancedModelRenderer?.prefetchDiffuseTextures?.(
                            textureQuality === 'high' ? 768 : 384,
                            { includeSecondary: true, skipSettled: true },
                        ) || 0;
                    }
                }
                if (!this.playerWireframeMode) {
                    // Character components can originate from a locally installed clothing
                    // manifest. Their generated WebP textures intentionally are not part of
                    // the world texture index, so this isolated renderer must be allowed to
                    // request those known asset paths directly.
                    this.playerModelRenderer?.prefetchDiffuseTextures?.(textureQuality === 'high' ? 96 : 48, {
                        includeSecondary: false,
                        allowIndexMiss: true,
                        skipSettled: this.spawnDistrictDemo,
                    });
                }
                try { this.textureStreamer?.endFrame?.(); } catch { /* ignore */ }
            }

            const eDone = wantedEntity.every((k) => this.entityStreamer.loaded.has(k));
            const dDone = wantedDraw.every((k) => this.drawableStreamer.loaded.has(k));

            const stats = this.instancedModelRenderer?.getMeshLoadStats?.() || null;
            const q = stats ? stats.queued : 0;
            const inflight = stats ? stats.inFlight : 0;
            const completedMeshes = stats ? stats.completed : 0;
            // All nearby district chunks contain roughly 730 material draws.
            // Starting at 256 meant the player entered while the surrounding
            // building shells were still absent. 640 keeps the loading overlay
            // through the stable local scene, without requiring every distant
            // source submesh to decode before input becomes available.
            const demoSize = Math.max(0, Number(this._spawnDistrictDescriptor?.size) || 0);
            const demoInitialMeshTarget = this.spawnDistrictDemo ? (demoSize >= 900 ? 900 : 640) : 0;
            const texStats = this.textureStreamer?.getStats?.() || null;
            const texLoading = texStats?.loading ?? 0;
            const texInFlight = texStats?.loadsInFlight ?? 0;
            const texResident = texStats?.textures ?? 0;

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
                        `Meshes: ready=${completedMeshes}${demoInitialMeshTarget ? `/${demoInitialMeshTarget} local` : ''} queue=${q} inFlight=${inflight}\n` +
                        `Textures: resident=${texResident} loading=${texLoading} inFlight=${texInFlight}\n` +
                        `Texture scan: diffuse=${diffuseOutstanding} secondary=${secondaryOutstanding}`,
                    progress: (eDone && dDone && q === 0 && inflight === 0) ? 0.90 : 0.82,
                    visible: true,
                });
            } else {
                // Keep a light-weight status in the controls panel instead of blocking the whole screen.
                this._setBootStatus(
                    `Streaming (background): Entities ${eLoaded}/${eNeed || 'n/a'} | ` +
                    `Drawables ${dLoaded}/${dNeed || 'n/a'} | ` +
                    `Meshes q=${q} inFlight=${inflight} | ` +
                    `Textures resident=${texResident} loading=${texLoading} inFlight=${texInFlight}`
                );
            }

            // Require a stable drain outside the demo. In /demo, chunk descriptors are
            // already resident by the minimum wait window, but their full mesh set can
            // contain thousands of individually queued submeshes. The animation loop is
            // the scheduler that continues that work at normal frame cadence, so keeping
            // it blocked here delays both visible progress and multiplayer unnecessarily.
            const playableDemoWindowElapsed = this.spawnDistrictDemo
                && performance.now() - start >= Math.max(0, Number(minWaitMs) || 0);
            const meshDrainComplete = (!this.showModels || !this.modelsInitialized) ? true : (q === 0 && inflight === 0);
            // /demo only needs a small camera-prioritized mesh set before first frame.
            // Draining the whole source-resident queue here blocked rendering behind a
            // full-screen loader despite thousands of remaining distant submeshes.
            const demoInitialWorldReady = !this.spawnDistrictDemo || completedMeshes >= demoInitialMeshTarget;
            const demoWorldGateExpired = this.spawnDistrictDemo && performance.now() - start >= 24000;
            const meshOk = meshDrainComplete || (
                playableDemoWindowElapsed && (demoInitialWorldReady || demoWorldGateExpired)
            );
            const textureScanOk = diffuseOutstanding === 0 && secondaryOutstanding === 0;
            // Texture uploads are intentionally asynchronous. Waiting for every active
            // texture request here made /demo appear offline for up to the 90 second
            // warmup timeout even after its local chunk bubble and meshes were ready.
            // After the minimum world-residency window, leave texture refinement to the
            // normal frame loop so the network client and peds become playable promptly.
            const textureDrainComplete = textureScanOk && texLoading === 0 && texInFlight === 0;
            const texturesOk = !this.spawnDistrictDemo || !this.textureStreamer || textureDrainComplete || playableDemoWindowElapsed;
            settledTicks = (eDone && dDone && meshOk && texturesOk) ? (settledTicks + 1) : 0;
            const minimumElapsed = performance.now() - start >= Math.max(0, Number(minWaitMs) || 0);
            // A full second of stable queues catches delayed mesh/material work that is
            // scheduled just after its parent chunk reports loaded.
            if (minimumElapsed && settledTicks >= Math.ceil(1000 / tickMs)) break;

            await new Promise((r) => setTimeout(r, tickMs));
        }

        restoreTextureConfig();

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
                this._installRuntimeCustomClothingManifests();
                await this.instancedModelRenderer.init();
                // Install the compact demo manifest before the drawable streamer is
                // marked ready. This prevents one frame of source-chunk shard requests.
                await this._prepareSpawnDistrictDemoAssets();
                await this.drawableStreamer.init();
                this.modelsInitialized = true;
                if (this.player?.enabled) {
                    await this._ensurePlayerModelRenderer();
                    this._applyPlayerRenderTargetsFromProfileOrUi({ preserveStored: true });
                    try { this._syncPlayerEntityMesh(true); } catch { /* ignore */ }
                    try { this.playerModelRenderer?.pumpMeshLoadsOnce?.(); } catch { /* ignore */ }
                }
                // Fixed inventory assets are made resident while the world is still
                // warming so drawing never exposes a loading placeholder.
                void this.prepareWeaponForDraw();
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

    _installRuntimeCustomClothingManifests() {
        if (!this.modelManager?.manifest || !(this.runtimeCustomClothingManifests instanceof Map)) return 0;
        let added = 0;
        for (const [source, manifest] of this.runtimeCustomClothingManifests.entries()) {
            added += this.modelManager.installManifestSubset(manifest, { source });
        }
        return added;
    }

    _installRuntimeCustomClothingAsset(hash) {
        const h = this.modelManager?.normalizeId?.(hash) || String(hash || '').trim();
        if (!h || !this.modelManager?.manifest || !(this.runtimeCustomClothingManifests instanceof Map)) return false;
        if (this.modelManager.hasRealMesh?.(h)) return true;
        for (const [source, manifest] of this.runtimeCustomClothingManifests.entries()) {
            const entry = manifest?.meshes?.[h];
            if (!entry) continue;
            this.modelManager.installManifestSubset({ meshes: { [h]: entry } }, { source });
            return !!this.modelManager.hasRealMesh?.(h);
        }
        return false;
    }

    async _ensurePlayerModelRenderer() {
        if (this.playerModelRenderer?.ready) return true;
        if (this._playerModelRendererInitPromise) return this._playerModelRendererInitPromise;

        this._playerModelRendererInitPromise = (async () => {
            try {
                const renderer = new InstancedModelRenderer(this.gl, this.modelManager, this.textureStreamer);
                // A player has only a handful of component meshes; keep its queue focused without competing with world bursts.
                renderer.maxMeshLoadsInFlight = 2;
                // Character bins were upgraded with blend weights after earlier exports had
                // reached Cache Storage. Keep that cache isolation limited to the player.
                renderer.meshLoadOptions = {
                    usePersistentCache: false,
                    cacheBust: `player-skin-v8-${Date.now()}`,
                    requireBlendAttributes: true,
                };
                await renderer.init();
                if (!renderer.ready) return false;
                this.playerModelRenderer = renderer;
                this._syncPlayerHairAppearance();
                if (this.playerSkinningSkeleton) {
                    try { renderer.setSkinningSkeleton?.(this.playerSkinningSkeleton); } catch { /* ignore */ }
                } else if (this.runtimeCharacterProfile) {
                    try { void this._loadRuntimePlayerSkeleton(this.runtimeCharacterProfile); } catch { /* ignore */ }
                }
                if (this.playerSkinningAnimations) {
                    try { renderer.setSkinningAnimationSet?.(this.playerSkinningAnimations); } catch { /* ignore */ }
                } else if (this.runtimeCharacterProfile) {
                    try { void this._loadRuntimePlayerAnimations(this.runtimeCharacterProfile); } catch { /* ignore */ }
                }
                if (this.meleeSkinningAnimations) renderer.mergeSkinningAnimationSet?.(this.meleeSkinningAnimations);
                if (this.weaponCombatSkinningAnimations) renderer.mergeSkinningAnimationSet?.(this.weaponCombatSkinningAnimations);
                return true;
            } catch (e) {
                console.warn('Player model renderer failed to initialize:', e);
                return false;
            } finally {
                if (!this.playerModelRenderer?.ready) this._playerModelRendererInitPromise = null;
            }
        })();

        return this._playerModelRendererInitPromise;
    }

    async _ensureNpcModelRenderer() {
        if (this.npcModelRenderer?.ready) return true;
        if (this._npcModelRendererInitPromise) return this._npcModelRendererInitPromise;
        if (!this.modelsInitialized) return false;

        this._npcModelRendererInitPromise = (async () => {
            try {
                if (!Array.isArray(this._npcAppearanceSpecs) || !this._npcAppearanceSpecs.length) {
                    const source = this.runtimeCharacterBaseProfile || this.runtimeCharacterProfile || null;
                    const profile = source ? structuredClone(source) : null;
                    const chosen = this._getPlayerRenderSpecsFromProfileOrUi({ profile });
                    this._npcAppearanceSpecs = (chosen.specs || []).map((spec) => ({
                        hash: String(spec.hash || ''),
                        label: String(spec.label || spec.hash || ''),
                        lod: String(spec.lod || this.player?.lod || 'high').toLowerCase(),
                    })).filter((spec) => !!spec.hash);
                    this._npcAppearanceHair = structuredClone(profile?.appearance?.hair || { color: 0, highlight: 0 });
                }
                if (this.runtimeCharacterProfile && !this.playerSkinningSkeleton) await this._loadRuntimePlayerSkeleton(this.runtimeCharacterProfile);
                if (this.runtimeCharacterProfile && !this.playerSkinningAnimations) await this._loadRuntimePlayerAnimations(this.runtimeCharacterProfile);
                const renderer = new InstancedModelRenderer(this.gl, this.modelManager, this.textureStreamer);
                renderer.maxMeshLoadsInFlight = 2;
                renderer.meshLoadOptions = {
                    usePersistentCache: false,
                    cacheBust: 'npc-skin-v1',
                    requireBlendAttributes: true,
                };
                await renderer.init();
                if (!renderer.ready) return false;
                const hair = this._npcAppearanceHair || { color: 0, highlight: 0 };
                renderer.pedHairPrimary = hairColorLinear(hair.color);
                renderer.pedHairHighlight = hairColorLinear(hair.highlight);
                if (this.playerSkinningSkeleton) renderer.setSkinningSkeleton?.(this.playerSkinningSkeleton);
                if (this.playerSkinningAnimations) renderer.setSkinningAnimationSet?.(this.playerSkinningAnimations);
                if (this.meleeSkinningAnimations) renderer.mergeSkinningAnimationSet?.(this.meleeSkinningAnimations);
                this.npcModelRenderer = renderer;
                const combatRenderer = new InstancedModelRenderer(this.gl, this.modelManager, this.textureStreamer);
                combatRenderer.maxMeshLoadsInFlight = 2;
                combatRenderer.meshLoadOptions = {
                    usePersistentCache: false,
                    cacheBust: 'npc-combat-skin-v1',
                    requireBlendAttributes: true,
                };
                await combatRenderer.init();
                if (combatRenderer.ready) {
                    combatRenderer.pedHairPrimary = renderer.pedHairPrimary;
                    combatRenderer.pedHairHighlight = renderer.pedHairHighlight;
                    if (this.playerSkinningSkeleton) combatRenderer.setSkinningSkeleton?.(this.playerSkinningSkeleton);
                    if (this.playerSkinningAnimations) combatRenderer.setSkinningAnimationSet?.(this.playerSkinningAnimations);
                    if (this.meleeSkinningAnimations) combatRenderer.mergeSkinningAnimationSet?.(this.meleeSkinningAnimations);
                    if (this.weaponCombatSkinningAnimations) combatRenderer.mergeSkinningAnimationSet?.(this.weaponCombatSkinningAnimations);
                    this.npcCombatModelRenderer = combatRenderer;
                }
                void this._ensurePoliceNpcModelRenderer();
                this._syncNpcEntityMeshes(true);
                return true;
            } catch (error) {
                console.warn('NPC model renderer failed to initialize:', error);
                return false;
            } finally {
                if (!this.npcModelRenderer?.ready) this._npcModelRendererInitPromise = null;
            }
        })();
        return this._npcModelRendererInitPromise;
    }

    async _ensurePoliceNpcModelRenderer() {
        if (this.policeNpcModelRenderer?.ready) return true;
        if (this._policeNpcModelRendererInitPromise) return this._policeNpcModelRendererInitPromise;
        if (!this.modelsInitialized) return false;

        this._policeNpcModelRendererInitPromise = (async () => {
            try {
                const [, skeleton, animations] = await Promise.all([
                    this._ensureNativeNpcModelMetadata(POLICE_PED_MODEL.modelHash, POLICE_PED_MODEL.modelName),
                    this._fetchNativePedJSON(POLICE_PED_MODEL.skeleton),
                    this._fetchNativePedJSON(POLICE_PED_MODEL.animations),
                ]);
                if (!Array.isArray(skeleton?.bones) || !animations?.clips) {
                    throw new Error(`Invalid skeleton or animation set for ${POLICE_PED_MODEL.modelName}`);
                }
                const [combatResult, meleeResult] = await Promise.allSettled([
                    this._fetchNativePedJSON(POLICE_PED_MODEL.animations.replace('_animations.json', '_combat_animations.json')),
                    this._fetchNativePedJSON(POLICE_PED_MODEL.animations.replace('_animations.json', '_melee_animations.json')),
                ]);
                const combat = combatResult.status === 'fulfilled' ? combatResult.value : null;
                const melee = meleeResult.status === 'fulfilled' ? meleeResult.value : null;
                const renderer = new InstancedModelRenderer(this.gl, this.modelManager, this.textureStreamer);
                // The cop has fourteen independently exported drawable parts.
                // A one-at-a-time queue makes a police response appear absent
                // for several seconds after a cold page load.
                renderer.maxMeshLoadsInFlight = 3;
                renderer.meshLoadOptions = {
                    usePersistentCache: false,
                    cacheBust: 'native-police-ped-v1',
                    requireBlendAttributes: true,
                };
                await renderer.init();
                if (!renderer.ready) return false;
                renderer.setSkinningSkeleton?.(skeleton);
                renderer.setSkinningAnimationSet?.(animations);
                if (combat?.clips) renderer.mergeSkinningAnimationSet?.(combat);
                if (melee?.clips) renderer.mergeSkinningAnimationSet?.(melee);
                this.policeNpcModelRenderer = renderer;
                console.info(`[npc] Native renderer initialized: ${POLICE_PED_MODEL.modelName} (${POLICE_PED_MODEL.modelHash})`);
                return true;
            } catch (error) {
                console.warn('Native GTA police ped renderer failed to initialize:', error);
                return false;
            } finally {
                this._policeNpcModelRendererInitPromise = null;
            }
        })();
        return this._policeNpcModelRendererInitPromise;
    }

    async _fetchNativePedJSON(relativePath) {
        const path = String(relativePath || '').replace(/^\/+/, '');
        if (!path) throw new Error('Native ped asset path is missing');
        if (/^peds\/[^/]+_animations\.json$/i.test(path)) {
            return await this._fetchSkinningAnimationSet(path);
        }
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 30_000);
        try {
            const response = await fetch(`assets/${path}`, {
                cache: 'force-cache',
                credentials: 'same-origin',
                signal: controller.signal,
            });
            if (!response.ok) throw new Error(`Native ped asset ${path} returned ${response.status}`);
            return await response.json();
        } finally {
            window.clearTimeout(timeout);
        }
    }

    async _fetchSkinningAnimationSet(relativePath) {
        const path = String(relativePath || '').replace(/^\/+/, '');
        if (!/^peds\/[^/]+_animations\.json$/i.test(path)) {
            throw new Error(`Invalid ped animation path: ${relativePath}`);
        }
        const packPath = path.replace(/\.json$/i, '.skp');
        // Base freemode palettes carry locomotion plus native phone clips.
        // Bump only that archive so existing browsers cannot retain the old
        // compact pack under the same static filename.
        const rootMotionRevision = path === 'peds/1885233650_animations.json'
            ? '?rev=root-motion-v3'
            : '';
        try {
            const packed = await fetchArrayBufferPreferredCompressed(`assets/${packPath}${rootMotionRevision}`, {
                usePersistentCache: false,
                priority: 'high',
            });
            return decodeSkinningAnimationPack(packed);
        } catch (packError) {
            // JSON remains a compatibility fallback while a browser cannot stream-decompress.
            try {
                return await fetchJSON(`assets/${path}?live=${Date.now()}`, {
                    usePersistentCache: false,
                    useMemoryCache: false,
                    priority: 'high',
                });
            } catch (jsonError) {
                throw new Error(`Ped animation load failed (${path}): ${packError?.message || packError}; fallback: ${jsonError?.message || jsonError}`);
            }
        }
    }

    async _ensureNativeNpcModelMetadata(modelHash, modelName = modelHash) {
        const hash = String(modelHash || '');
        if (!hash) throw new Error('Native NPC model hash is missing');
        if (!this.modelManager?.hasRealMesh?.(hash)) {
            if (!this._nativeNpcManifestPromise) {
                this._nativeNpcManifestPromise = this._fetchNativePedJSON('peds/native_ped_models.json').then((manifest) => {
                    if (manifest?.schema !== 'webglgta-native-ped-manifest-v1' || !manifest?.meshes) {
                        throw new Error('Native ped model manifest is invalid');
                    }
                    this.modelManager?.installManifestSubset?.(manifest, { source: 'peds/native_ped_models.json' });
                    return manifest;
                }).catch((error) => {
                    this._nativeNpcManifestPromise = null;
                    throw error;
                });
            }
            await this._nativeNpcManifestPromise;
        }
        let loaded = await this.modelManager?.prefetchMeta?.(hash, { priority: 'high' });
        if (loaded && !this.modelManager?.hasRealMesh?.(hash)) {
            loaded = await this.modelManager?.prefetchMeta?.(hash, { priority: 'high', force: true });
        }
        const submeshes = this.modelManager?.getLodSubmeshes?.(hash, 'high') || [];
        if (!loaded || !this.modelManager?.hasRealMesh?.(hash) || !submeshes.length) {
            throw new Error(`Native NPC metadata is unavailable for ${modelName} (${hash})`);
        }
        return submeshes;
    }

    async _ensureAmbientNpcModelRenderer(model) {
        const modelHash = String(model?.modelHash || '');
        if (!modelHash) return false;
        if (this.ambientNpcModelRenderers.get(modelHash)?.ready) return true;
        if (this._ambientNpcRendererInitPromises.has(modelHash)) {
            return this._ambientNpcRendererInitPromises.get(modelHash);
        }
        if (!this.modelsInitialized) return false;

        const promise = (async () => {
            try {
                const [, skeleton, animations] = await Promise.all([
                    this._ensureNativeNpcModelMetadata(modelHash, model?.modelName),
                    this._fetchNativePedJSON(model.skeleton),
                    this._fetchNativePedJSON(model.animations),
                ]);
                if (!Array.isArray(skeleton?.bones) || !animations?.clips) {
                    throw new Error(`Invalid skeleton or animation set for ${model?.modelName || modelHash}`);
                }
                const renderer = new InstancedModelRenderer(this.gl, this.modelManager, this.textureStreamer);
                renderer.maxMeshLoadsInFlight = 1;
                renderer.meshLoadOptions = {
                    usePersistentCache: false,
                    cacheBust: `native-ambient-ped-${modelHash}-v1`,
                    requireBlendAttributes: true,
                };
                await renderer.init();
                if (!renderer.ready) return false;
                renderer.setSkinningSkeleton?.(skeleton);
                renderer.setSkinningAnimationSet?.(animations);
                this.ambientNpcModelRenderers.set(modelHash, renderer);
                console.info(`[npc] Native renderer initialized: ${model?.modelName || modelHash} (${modelHash})`);
                if (!this._ambientNpcActiveMeshKeys.has(modelHash)) this._ambientNpcActiveMeshKeys.set(modelHash, new Set());
                this._syncNpcEntityMeshes(true);
                return true;
            } catch (error) {
                console.warn(`Native GTA ambient ped ${model?.modelName || modelHash} failed to initialize:`, error);
                return false;
            } finally {
                this._ambientNpcRendererInitPromises.delete(modelHash);
            }
        })();
        this._ambientNpcRendererInitPromises.set(modelHash, promise);
        return promise;
    }

    async _ensureAmbientNpcCombatAnimations(modelHash) {
        const key = String(modelHash || '');
        if (!key || this._ambientNpcCombatAnimationsReady.has(key)) return true;
        if (this._ambientNpcCombatAnimationPromises.has(key)) return this._ambientNpcCombatAnimationPromises.get(key);
        const renderer = this.ambientNpcModelRenderers.get(key);
        const model = AMBIENT_PED_MODELS.find((candidate) => candidate.modelHash === key);
        if (!renderer?.ready || !model) return false;
        const promise = (async () => {
            try {
                const [combatResult, meleeResult] = await Promise.allSettled([
                    this._fetchNativePedJSON(model.animations.replace('_animations.json', '_combat_animations.json')),
                    this._fetchNativePedJSON(model.animations.replace('_animations.json', '_melee_animations.json')),
                ]);
                const combat = combatResult.status === 'fulfilled' ? combatResult.value : null;
                const melee = meleeResult.status === 'fulfilled' ? meleeResult.value : null;
                if (combat?.clips) renderer.mergeSkinningAnimationSet?.(combat);
                if (melee?.clips) renderer.mergeSkinningAnimationSet?.(melee);
                if (!combat?.clips && !melee?.clips) return false;
                this._ambientNpcCombatAnimationsReady.add(key);
                return true;
            } catch (error) {
                console.warn(`Native GTA ambient combat palettes ${key} failed to load:`, error);
                return false;
            } finally {
                if (!this._ambientNpcCombatAnimationsReady.has(key)) this._ambientNpcCombatAnimationPromises.delete(key);
            }
        })();
        this._ambientNpcCombatAnimationPromises.set(key, promise);
        return promise;
    }

    async _ensureRemotePlayerRenderer() {
        if (this.remotePlayerRenderer?.ready) return true;
        if (this._remotePlayerRendererInitPromise) return this._remotePlayerRendererInitPromise;
        if (!this.modelsInitialized || !this.runtimeCharacterProfile) return false;
        this._remotePlayerRendererInitPromise = (async () => {
            try {
                if (!this.playerSkinningSkeleton) await this._loadRuntimePlayerSkeleton(this.runtimeCharacterProfile);
                if (!this.playerSkinningAnimations) await this._loadRuntimePlayerAnimations(this.runtimeCharacterProfile);
                const renderer = new InstancedModelRenderer(this.gl, this.modelManager, this.textureStreamer);
                renderer.maxMeshLoadsInFlight = 2;
                renderer.meshLoadOptions = {
                    usePersistentCache: false,
                    cacheBust: 'multiplayer-skin-v1',
                    requireBlendAttributes: true,
                };
                await renderer.init();
                if (!renderer.ready) return false;
                const hair = this.runtimeCharacterProfile?.appearance?.hair || { color: 0, highlight: 0 };
                renderer.pedHairPrimary = hairColorLinear(hair.color);
                renderer.pedHairHighlight = hairColorLinear(hair.highlight);
                if (this.playerSkinningSkeleton) renderer.setSkinningSkeleton?.(this.playerSkinningSkeleton);
                if (this.playerSkinningAnimations) renderer.setSkinningAnimationSet?.(this.playerSkinningAnimations);
                this.remotePlayerRenderer = renderer;
                this._syncRemotePlayerMeshes(true);
                return true;
            } catch (error) {
                console.warn('Remote player renderer failed to initialize:', error);
                return false;
            } finally {
                if (!this.remotePlayerRenderer?.ready) this._remotePlayerRendererInitPromise = null;
            }
        })();
        return this._remotePlayerRendererInitPromise;
    }

    _clearRemotePlayerMeshes() {
        this._clearNpcRendererInstances(this.remotePlayerRenderer, this._remotePlayerActiveMeshKeys);
        this._remotePlayers = [];
        this._remotePlayerAnimationHashes = [];
    }

    _syncRemotePlayerMeshes(forceFullInit = false) {
        const players = this.multiplayer?.getRemotePlayers?.() || [];
        this._remotePlayers = players;
        if (!players.length) {
            this._clearRemotePlayerMeshes();
            return;
        }
        if (!this.remotePlayerRenderer?.ready) {
            void this._ensureRemotePlayerRenderer();
            return;
        }
        const chosen = this._getPlayerRenderSpecsFromProfileOrUi({ preserveStored: true });
        const visibleComponent = /^(head|hair|uppr|lowr|hand|feet|jbib)_/i;
        this._remotePlayerAnimationHashes = (chosen.specs || [])
            .filter((spec) => visibleComponent.test(String(spec.label || '')))
            .map((spec) => String(spec.hash || ''))
            .filter(Boolean);
        if (!this._remotePlayerAnimationHashes.length) return;
        this._setNpcRendererInstances(
            this.remotePlayerRenderer,
            this._remotePlayerActiveMeshKeys,
            this._remotePlayerAnimationHashes,
            players.slice(0, 1),
            forceFullInit,
        );
    }

    _createMultiplayerHud() {
        if (!this.spawnDistrictDemo || document.getElementById('multiplayerHud')) return;
        const hud = document.createElement('div');
        hud.id = 'multiplayerHud';
        hud.style.cssText = 'position:fixed;top:14px;right:14px;z-index:25;padding:7px 10px;border:1px solid rgba(255,255,255,.22);background:rgba(10,12,14,.78);color:#fff;font:600 12px/1.2 system-ui,sans-serif;pointer-events:none';
        document.body.appendChild(hud);
        this._multiplayerHudEl = hud;
        this._syncMultiplayerHud();
    }

    _syncMultiplayerHud() {
        const hud = this._multiplayerHudEl;
        if (!hud) return;
        const status = String(this.multiplayer?.status || 'offline');
        const peers = this.multiplayer?.peers?.size || 0;
        const voice = this.audioSystem?.getNetworkState?.();
        const voiceState = voice?.voiceTalking ? 'TALKING' : voice?.voiceEnabled ? 'MIC' : 'MUTED';
        hud.textContent = `${status === 'online' ? 'ONLINE' : status.toUpperCase()}  ${peers + 1}  ROOM ${this.multiplayer?.room || 'demo'}  ${voiceState}`;
        hud.style.color = status === 'online' ? '#9ff0ba' : '#ffd28a';
    }

    _clearNpcEntityMeshes() {
        this._clearNpcRendererInstances(this.npcModelRenderer, this._npcActiveMeshKeys);
        this._clearNpcRendererInstances(this.npcCombatModelRenderer, this._npcCombatActiveMeshKeys);
        this._clearNpcRendererInstances(this.policeNpcModelRenderer, this._policeNpcActiveMeshKeys);
        for (const [modelHash, renderer] of this.ambientNpcModelRenderers) {
            this._clearNpcRendererInstances(renderer, this._ambientNpcActiveMeshKeys.get(modelHash) || new Set());
        }
        this._npcCombatAnimationPose = null;
        this._npcAnimatedNpcs = [];
        this._npcAmbientNpcs = [];
        this._ambientNpcRenderGroups = [];
        this._npcAnimationHashes = [];
    }

    _clearNpcRendererInstances(renderer, activeKeys) {
        if (!renderer?.ready) return;
        for (const key of activeKeys) {
            const [hash, lod = 'high'] = String(key).split(':');
            if (hash) try { void renderer.setInstancesForArchetype(hash, lod, new Float32Array(0), 0.0); } catch { /* ignore */ }
        }
        activeKeys.clear();
    }

    _hasCompleteNpcArchetype(renderer, hashes) {
        if (!renderer?.ready) return false;
        const fallbackLod = String(this.player?.lod || 'high').toLowerCase();
        let found = false;
        for (const source of hashes || []) {
            const hash = typeof source === 'object' ? String(source?.hash || '') : String(source || '');
            const lod = String((typeof source === 'object' ? source?.lod : null) || fallbackLod).toLowerCase();
            if (!hash) continue;
            const entry = renderer.instances?.get?.(`${hash}:${lod}`);
            const submeshes = Array.from(entry?.submeshes || []).filter(([file]) => file !== '__placeholder__');
            if (!submeshes.length || submeshes.some(([, submesh]) => !submesh?.mesh)) return false;
            found = true;
        }
        return found;
    }

    _hasRenderableNpcArchetype(renderer, hashes) {
        if (!renderer?.ready) return false;
        const fallbackLod = String(this.player?.lod || 'high').toLowerCase();
        for (const source of hashes || []) {
            const hash = typeof source === 'object' ? String(source?.hash || '') : String(source || '');
            const lod = String((typeof source === 'object' ? source?.lod : null) || fallbackLod).toLowerCase();
            const entry = renderer.instances?.get?.(`${hash}:${lod}`);
            if (Array.from(entry?.submeshes?.entries?.() || []).some(([file, submesh]) => file !== '__placeholder__' && !!submesh?.mesh)) {
                return true;
            }
        }
        return false;
    }

    _reportNativeNpcReady(modelHash, modelName, renderer) {
        const hash = String(modelHash || '');
        if (!hash || this._nativeNpcReadyModels.has(hash)) return;
        const entry = renderer?.instances?.get?.(`${hash}:high`);
        const loadedSubmeshes = Array.from(entry?.submeshes || []).filter(([file, submesh]) => (
            file !== '__placeholder__' && !!submesh?.mesh
        )).length;
        if (!loadedSubmeshes) return;
        this._nativeNpcReadyModels.add(hash);
        console.info(`[npc] Native ped ready: ${modelName || hash} (${hash}), ${loadedSubmeshes} submeshes`);
    }

    _reportNpcPipelineError(stage, error) {
        const now = performance.now();
        const previous = Number(this._npcPipelineErrorAt.get(stage)) || 0;
        if (now - previous < 5000) return;
        this._npcPipelineErrorAt.set(stage, now);
        console.warn(`[npc] ${stage} failed`, error);
    }

    _setNpcRendererInstances(renderer, activeKeys, hashes, npcs, forceFullInit) {
        if (!renderer?.ready) return;
        if (!npcs.length) {
            this._clearNpcRendererInstances(renderer, activeKeys);
            return;
        }
        const fallbackLod = String(this.player?.lod || 'high').toLowerCase();
        const specsByKey = new Map();
        for (const source of hashes || []) {
            const hash = typeof source === 'object' ? String(source?.hash || '') : String(source || '');
            const lod = String((typeof source === 'object' ? source?.lod : null) || fallbackLod).toLowerCase();
            if (hash) specsByKey.set(`${hash}:${lod}`, { hash, lod });
        }
        const specs = Array.from(specsByKey.values());
        if (!specs.length) return;
        this._npcSyncDiagnostics.submissions += 1;
        let scratch = this._npcInstanceScratchByRenderer.get(renderer);
        if (!scratch) {
            scratch = {
                matrices: new Float32Array(0),
                q: glMatrix.quat.create(),
                mat: glMatrix.mat4.create(),
                specsKey: '',
            };
            this._npcInstanceScratchByRenderer.set(renderer, scratch);
        }
        const requiredFloats = npcs.length * 16;
        let transformsChanged = !!forceFullInit || scratch.matrices.length !== requiredFloats;
        if (scratch.matrices.length !== requiredFloats) scratch.matrices = new Float32Array(requiredFloats);
        const matrices = scratch.matrices;
        const q = scratch.q;
        const mat = scratch.mat;
        for (let i = 0; i < npcs.length; i++) {
            const npc = npcs[i];
            const heading = Number.isFinite(Number(npc.heading)) ? Number(npc.heading) : 0.0;
            glMatrix.quat.setAxisAngle(q, [0, 0, 1], heading + PLAYER_DRAWABLE_FORWARD_OFFSET_RAD);
            const ragdollPitch = Number(npc.ragdollPitch) || 0.0;
            const ragdollRoll = Number(npc.ragdollRoll) || 0.0;
            if (Math.abs(ragdollPitch) > 1e-5) glMatrix.quat.rotateX(q, q, ragdollPitch);
            if (Math.abs(ragdollRoll) > 1e-5) glMatrix.quat.rotateY(q, q, ragdollRoll);
            glMatrix.mat4.fromRotationTranslation(mat, q, [
                npc.x,
                npc.y,
                npc.feetZ + (Number(npc.ragdollOffsetZ) || 0.0) + (Number(npc.ragdollGroundOffsetZ) || 0.0),
            ]);
            const offset = i * 16;
            for (let column = 0; column < 16; column++) {
                if (matrices[offset + column] !== mat[column]) transformsChanged = true;
                matrices[offset + column] = mat[column];
            }
        }
        const desired = new Set(specs.map(({ hash, lod }) => `${hash}:${lod}`));
        for (const oldKey of Array.from(activeKeys)) {
            if (desired.has(oldKey)) continue;
            const [oldHash, oldLod = fallbackLod] = oldKey.split(':');
            try { void renderer.setInstancesForArchetype(oldHash, oldLod, new Float32Array(0), 0.0); } catch { /* ignore */ }
            activeKeys.delete(oldKey);
        }
        const specsKey = specs.map(({ hash, lod }) => `${hash}:${lod}`).join('|');
        if (scratch.specsKey !== specsKey) transformsChanged = true;
        scratch.specsKey = specsKey;
        for (const { hash, lod } of specs) {
            const key = `${hash}:${lod}`;
            const existing = renderer.instances?.get?.(key);
            const hasPlaceholderMesh = !!existing?.submeshes?.has?.('__placeholder__');
            const isWaitingForRealMesh = !existing
                || !existing.submeshes
                || existing.submeshes.size === 0
                || Array.from(existing.submeshes.entries()).some(([file, submesh]) => (
                    file !== '__placeholder__' && !submesh?.mesh
                ));
            if (isWaitingForRealMesh) {
                void this.modelManager?.prefetchMeta?.(hash, { priority: 'high' });
            }
            // Static peds do not need to rewalk instance data or touch a GPU
            // buffer. Dynamic ped groups are never occlusion-tested, so skip
            // their aggregate bounds rebuild as well.
            if (!transformsChanged && !hasPlaceholderMesh && !isWaitingForRealMesh) {
                activeKeys.add(key);
                continue;
            }
            const updated = !forceFullInit
                && !hasPlaceholderMesh
                && !isWaitingForRealMesh
                && renderer.updateInstanceMatricesForArchetype(hash, lod, matrices, 0.0, { skipInstanceBounds: true });
            if (!updated) void renderer.setInstancesForArchetype(hash, lod, matrices, -1.0, {
                loadPriority: 90,
                allowPlaceholderMesh: false,
                skipInstanceBounds: true,
            });
            activeKeys.add(key);
        }
    }

    _syncNpcEntityMeshes(forceFullInit = false) {
        const npcs = this.showNpcs && this.spawnDistrictDemo ? (this.npcSystem?.npcs || []) : [];
        this._npcSyncDiagnostics.syncs += 1;
        this._npcSyncDiagnostics.hashes = Array.from(new Set(npcs.map((npc) => String(npc?.modelHash || 'missing'))));
        if (!npcs.length) {
            this._clearNpcEntityMeshes();
            return;
        }
        if (!this.npcModelRenderer?.ready) void this._ensureNpcModelRenderer();
        for (const model of AMBIENT_PED_MODELS) {
            if (!this.ambientNpcModelRenderers.get(model.modelHash)?.ready) void this._ensureAmbientNpcModelRenderer(model);
        }
        const hashes = (this._npcAppearanceSpecs || [])
            .map((spec) => ({
                hash: String(spec.hash || ''),
                lod: String(spec.lod || this.player?.lod || 'high').toLowerCase(),
        }))
            .filter((spec) => !!spec.hash);
        const policeNpcs = npcs.filter((npc) => npc?.role === 'police');
        const civilianNpcs = npcs.filter((npc) => npc?.role !== 'police');
        const combatNpcs = civilianNpcs.filter((npc) => !!this.npcSystem?.getAnimationPose?.(npc));
        const ambientNpcs = civilianNpcs.filter((npc) => !this.npcSystem?.getAnimationPose?.(npc));
        this._npcSyncDiagnostics.ambient = ambientNpcs.length;
        this._npcSyncDiagnostics.combat = combatNpcs.length;
        this._npcSyncDiagnostics.police = policeNpcs.length;
        this._npcCombatAnimationPose = combatNpcs.length ? this.npcSystem.getAnimationPose(combatNpcs[0]) : null;
        this._npcAnimatedNpcs = [...combatNpcs, ...policeNpcs];
        this._npcAmbientNpcs = ambientNpcs;
        this._ambientNpcRenderGroups = [];
        this._npcAnimationHashes = hashes;
        if (combatNpcs.some((npc) => this.npcSystem?.getAnimationPose?.(npc)?.armed)) {
            void this._ensureWeaponCombatAnimations();
        }
        for (const npc of combatNpcs) {
            const modelHash = String(npc?.modelHash || '');
            if (this.ambientNpcModelRenderers.get(modelHash)?.ready) void this._ensureAmbientNpcCombatAnimations(modelHash);
        }
        // Do not batch civilians through the player's renderer. That renderer has
        // one live skin palette, so every civilian inherited the local player's
        // walk/aim input and appeared to be player-controlled. NPC renderers keep
        // their own AI-driven pose clock and only receive NPC world transforms.
        const nativeAmbientIds = new Set();
        const activeNativeModelHashes = new Set(
            civilianNpcs.map((npc) => String(npc?.modelHash || '')).filter(Boolean),
        );
        for (const model of AMBIENT_PED_MODELS) {
            const modelNpcs = ambientNpcs.filter((npc) => String(npc?.modelHash || '') === model.modelHash);
            for (const npc of modelNpcs) nativeAmbientIds.add(npc.id);
            const nativeRenderer = this.ambientNpcModelRenderers.get(model.modelHash);
            if (!nativeRenderer?.ready || !modelNpcs.length) continue;
            const activeKeys = this._ambientNpcActiveMeshKeys.get(model.modelHash) || new Set();
            this._ambientNpcActiveMeshKeys.set(model.modelHash, activeKeys);
            const nativeHashes = [{ hash: model.modelHash, lod: 'high' }];
            this._setNpcRendererInstances(nativeRenderer, activeKeys, nativeHashes, modelNpcs, forceFullInit);
            if (!this._hasCompleteNpcArchetype(nativeRenderer, nativeHashes)) continue;
            this._reportNativeNpcReady(model.modelHash, model.modelName, nativeRenderer);
            this._ambientNpcRenderGroups.push({ model, renderer: nativeRenderer, activeKeys, npcs: modelNpcs });
        }
        for (const [modelHash, renderer] of this.ambientNpcModelRenderers) {
            // A renderer that is still loading has no render group yet. Keep its
            // instance entry alive until the last NPC using this native model is gone.
            if (activeNativeModelHashes.has(modelHash)) continue;
            this._clearNpcRendererInstances(renderer, this._ambientNpcActiveMeshKeys.get(modelHash) || new Set());
        }
        const fallbackAmbient = ambientNpcs.filter((npc) => !nativeAmbientIds.has(npc.id));
        if (this.npcModelRenderer?.ready && hashes.length) {
            this._setNpcRendererInstances(this.npcModelRenderer, this._npcActiveMeshKeys, hashes, fallbackAmbient, forceFullInit);
        }
        if (policeNpcs.length) {
            if (!this.policeNpcModelRenderer?.ready) void this._ensurePoliceNpcModelRenderer();
            else this._setNpcRendererInstances(
                this.policeNpcModelRenderer,
                this._policeNpcActiveMeshKeys,
                this._policeNpcAnimationHashes,
                policeNpcs,
                forceFullInit,
            );
            if (this._hasCompleteNpcArchetype(this.policeNpcModelRenderer, this._policeNpcAnimationHashes)) {
                this._reportNativeNpcReady(POLICE_PED_MODEL.modelHash, POLICE_PED_MODEL.modelName, this.policeNpcModelRenderer);
            }
        } else {
            this._clearNpcRendererInstances(this.policeNpcModelRenderer, this._policeNpcActiveMeshKeys);
        }
        const nativeModelHashes = new Set(AMBIENT_PED_MODELS.map((model) => model.modelHash));
        const fallbackCombat = combatNpcs.filter((npc) => !nativeModelHashes.has(String(npc?.modelHash || '')));
        if (!fallbackCombat.length || !this.npcCombatModelRenderer?.ready) {
            this._clearNpcRendererInstances(this.npcCombatModelRenderer, this._npcCombatActiveMeshKeys);
            return;
        }
        this._setNpcRendererInstances(this.npcCombatModelRenderer, this._npcCombatActiveMeshKeys, hashes, fallbackCombat.slice(0, 1), forceFullInit);
    }

    _updateNpcAmbientLocomotion(dt) {
        const npcs = Array.isArray(this._npcAmbientNpcs) ? this._npcAmbientNpcs : [];
        const running = npcs.some((npc) => ['flee', 'hostile', 'retiring'].includes(String(npc?.state || '')));
        const walking = running || npcs.some((npc) => ['wander', 'patrol'].includes(String(npc?.state || '')));
        const gait = running ? 'run' : (walking ? 'walk' : 'idle');
        const move01 = running ? 0.95 : (walking ? 0.62 : 0.0);
        const stride = running ? 1.0 : (walking ? 0.72 : 1.0);
        const cycleSeconds = running ? 1.05 : 3.6666667;
        if (walking) {
            this._npcAnimPhase = (this._npcAnimPhase + (Math.PI * 2.0 / cycleSeconds) * Math.max(0.0, Number(dt) || 0.0)) % (Math.PI * 2.0);
        }
        this._npcAmbientLocomotion = { enabled: walking, move01, gait, stride };
        return this._npcAmbientLocomotion;
    }

    _getNpcMeshStatus() {
        const describeRenderer = (renderer) => {
            if (!renderer?.ready) return { ready: false, entries: [] };
            const entries = [];
            for (const [key, entry] of renderer.instances || []) {
                entries.push({
                    key,
                    instanceCount: Number(entry?.instanceCount) || 0,
                    submeshes: Array.from(entry?.submeshes?.values?.() || []).map((submesh) => ({
                        file: String(submesh?.file || ''),
                        loaded: !!submesh?.mesh,
                    })),
                });
            }
            return { ready: true, entries };
        };
        const npcs = this.npcSystem?.npcs || [];
        return {
            schema: 'webglgta-npc-status-v1',
            enabled: !!this.showNpcs && !!this.spawnDistrictDemo,
            total: npcs.length,
            civilians: npcs.filter((npc) => npc?.role === 'civilian').length,
            police: npcs.filter((npc) => npc?.role === 'police').length,
            ambientInPlayerPass: Number(this._playerPassAmbientNpcCount) || 0,
            activeAmbientMeshKeys: Array.from(this._npcActiveMeshKeys || []),
            activeCombatMeshKeys: Array.from(this._npcCombatActiveMeshKeys || []),
            renderer: describeRenderer(this.npcModelRenderer),
            combatRenderer: describeRenderer(this.npcCombatModelRenderer),
            policeRenderer: describeRenderer(this.policeNpcModelRenderer),
            nativeAmbientRenderers: Object.fromEntries(
                Array.from(this.ambientNpcModelRenderers, ([modelHash, renderer]) => [modelHash, describeRenderer(renderer)]),
            ),
            navigation: {
                ready: !!this.npcSystem?.navigation?.ready,
                nodes: Number(this.npcSystem?.navigation?.nodes?.length) || 0,
            },
        };
    }

    async _ensureWeaponModelRenderer() {
        if (this.weaponModelRenderer?.ready && this.weaponModelAsset?.hash) return true;
        if (this._weaponModelRendererInitPromise) return this._weaponModelRendererInitPromise;
        if (!this.modelsInitialized || !this.modelManager?.manifest) return false;

        this._weaponModelRendererInitPromise = (async () => {
            try {
                const manifest = await fetchJSON('assets/custom_weapons/glock17.json', {
                    usePersistentCache: false,
                    useMemoryCache: false,
                    priority: 'high',
                });
                const weapon = manifest?.weapon || null;
                const hash = String(weapon?.hash || '').trim();
                if (!hash || !manifest?.meshes?.[hash]) return false;

                this.modelManager.installManifestSubset(manifest, { source: 'custom_weapons/glock17.json' });
                const renderer = new InstancedModelRenderer(this.gl, this.modelManager, this.textureStreamer);
                renderer.maxMeshLoadsInFlight = 1;
                renderer.meshLoadOptions = {
                    usePersistentCache: false,
                    cacheBust: 'fivem-glock17-v1',
                    requireBlendAttributes: false,
                };
                await renderer.init();
                if (!renderer.ready) return false;

                this.weaponModelRenderer = renderer;
                this.weaponModelAsset = { hash, lod: 'high', modelName: String(weapon?.modelName || 'w_pi_glock17_luxe') };
                return true;
            } catch (error) {
                console.warn('Glock-17 model renderer failed to initialize:', error);
                return false;
            } finally {
                if (!this.weaponModelRenderer?.ready) this._weaponModelRendererInitPromise = null;
            }
        })();

        return this._weaponModelRendererInitPromise;
    }

    _refreshWeaponModelResidency() {
        const hash = String(this.weaponModelAsset?.hash || '');
        const lod = String(this.weaponModelAsset?.lod || 'high').toLowerCase();
        const entry = hash ? this.weaponModelRenderer?.instances?.get?.(`${hash}:${lod}`) : null;
        const submeshes = entry?.submeshes ? Array.from(entry.submeshes.values()) : [];
        this._weaponModelMeshReady = submeshes.length > 0 && submeshes.every((submesh) => !!submesh?.mesh);
        if (submeshes.length && !this._weaponModelTexturesQueued) {
            this._weaponModelTexturesQueued = true;
            try {
                this.weaponModelRenderer?.prefetchDiffuseTextures?.(16, {
                    allowIndexMiss: true,
                    includeSecondary: true,
                });
            } catch { /* ignore */ }
        }
        return this._weaponModelMeshReady;
    }

    async _precacheWeaponModel() {
        if (this._refreshWeaponModelResidency()) return true;
        if (this._weaponModelPrecachePromise) return this._weaponModelPrecachePromise;
        this._weaponModelPrecachePromise = (async () => {
            if (!(await this._ensureWeaponModelRenderer())) return false;
            const hash = String(this.weaponModelAsset?.hash || '');
            const lod = String(this.weaponModelAsset?.lod || 'high').toLowerCase();
            if (!hash) return false;

            // Keep one non-rendered instance alive while holstered. The weapon pass
            // is gated separately, so this only retains mesh/VAO residency.
            const preloadMatrix = glMatrix.mat4.create();
            preloadMatrix[14] = -10000.0;
            await this.weaponModelRenderer.setInstancesForArchetype(
                hash,
                lod,
                preloadMatrix,
                -1.0,
                { loadPriority: 140, allowPlaceholderMesh: false },
            );
            this._weaponModelActiveKey = `${hash}:${lod}`;

            const deadline = performance.now() + 10000.0;
            while (!this._refreshWeaponModelResidency() && performance.now() < deadline) {
                this.weaponModelRenderer.pumpMeshLoadsOnce?.();
                await new Promise((resolve) => setTimeout(resolve, 16));
            }
            this._refreshWeaponModelResidency();
            return this._weaponModelMeshReady;
        })().finally(() => {
            this._weaponModelPrecachePromise = null;
        });
        return this._weaponModelPrecachePromise;
    }

    async prepareWeaponForDraw() {
        const [modelReady, animationsReady] = await Promise.all([
            this._precacheWeaponModel(),
            this._ensureWeaponCombatAnimations(),
        ]);
        return !!modelReady && !!animationsReady;
    }

    async _ensurePhoneModelRenderer() {
        if (this.phoneModelRenderer?.ready && this.phoneModelAsset?.hash) return true;
        if (this._phoneModelRendererInitPromise) return this._phoneModelRendererInitPromise;
        if (!this.modelsInitialized || !this.modelManager?.manifest) return false;

        this._phoneModelRendererInitPromise = (async () => {
            try {
                const manifest = await fetchJSON('assets/custom_phone/prop_phone_ing.json', {
                    usePersistentCache: false,
                    useMemoryCache: false,
                    priority: 'high',
                });
                const prop = manifest?.prop || null;
                const hash = String(prop?.hash || '').trim();
                if (!hash || !manifest?.meshes?.[hash]) return false;

                this.modelManager.installManifestSubset(manifest, { source: 'custom_phone/prop_phone_ing.json' });
                const renderer = new InstancedModelRenderer(this.gl, this.modelManager, this.textureStreamer);
                renderer.maxMeshLoadsInFlight = 1;
                renderer.meshLoadOptions = {
                    usePersistentCache: false,
                    cacheBust: 'gta-phone-prop-v1',
                    requireBlendAttributes: false,
                };
                await renderer.init();
                if (!renderer.ready) return false;

                this.phoneModelRenderer = renderer;
                this.phoneModelAsset = { hash, lod: 'high', modelName: String(prop?.modelName || 'prop_phone_ing') };
                return true;
            } catch (error) {
                console.warn('Phone prop renderer failed to initialize:', error);
                return false;
            } finally {
                if (!this.phoneModelRenderer?.ready) this._phoneModelRendererInitPromise = null;
            }
        })();

        return this._phoneModelRendererInitPromise;
    }

    _refreshPhoneModelResidency() {
        const hash = String(this.phoneModelAsset?.hash || '');
        const lod = String(this.phoneModelAsset?.lod || 'high').toLowerCase();
        const entry = hash ? this.phoneModelRenderer?.instances?.get?.(`${hash}:${lod}`) : null;
        const submeshes = entry?.submeshes ? Array.from(entry.submeshes.values()) : [];
        this._phoneModelMeshReady = submeshes.length > 0 && submeshes.every((submesh) => !!submesh?.mesh);
        return this._phoneModelMeshReady;
    }

    async _precachePhoneModel() {
        if (this._refreshPhoneModelResidency()) return true;
        if (this._phoneModelPrecachePromise) return this._phoneModelPrecachePromise;
        this._phoneModelPrecachePromise = (async () => {
            if (!(await this._ensurePhoneModelRenderer())) return false;
            const hash = String(this.phoneModelAsset?.hash || '');
            const lod = String(this.phoneModelAsset?.lod || 'high').toLowerCase();
            if (!hash) return false;

            const preloadMatrix = glMatrix.mat4.create();
            preloadMatrix[14] = -10000.0;
            await this.phoneModelRenderer.setInstancesForArchetype(
                hash,
                lod,
                preloadMatrix,
                -1.0,
                { loadPriority: 140, allowPlaceholderMesh: false },
            );
            this._phoneModelActiveKey = `${hash}:${lod}`;

            const deadline = performance.now() + 10000.0;
            while (!this._refreshPhoneModelResidency() && performance.now() < deadline) {
                this.phoneModelRenderer.pumpMeshLoadsOnce?.();
                await new Promise((resolve) => setTimeout(resolve, 16));
            }
            this._refreshPhoneModelResidency();
            return this._phoneModelMeshReady;
        })().finally(() => {
            this._phoneModelPrecachePromise = null;
        });
        return this._phoneModelPrecachePromise;
    }

    async preparePhoneForUse() {
        return this._precachePhoneModel();
    }

    async _ensureVehicleModelDefinition(state) {
        const hash = String(state?.hash || '').trim();
        const customManifest = String(state?.assetManifest || '').trim();
        if (!hash) return false;
        if (!customManifest) {
            await this.modelManager.prefetchMeta?.(hash, { priority: 'high', force: true });
            return !!this.modelManager.hasRealMesh?.(hash);
        }
        const key = `${hash}:${customManifest}`;
        if (this._vehicleManifestReadyKeys.has(key) && this.modelManager?.manifest?.meshes?.[hash]) return true;
        if (this._vehicleManifestPromises.has(key)) return this._vehicleManifestPromises.get(key);
        const promise = (async () => {
            try {
                const manifest = await fetchJSON(`assets/${customManifest}?live=${Date.now()}`, {
                    usePersistentCache: false,
                    useMemoryCache: false,
                    priority: 'high',
                });
                if (!manifest?.meshes?.[hash]) return false;
                this.modelManager.installManifestSubset(manifest, { source: customManifest });
                this._vehicleManifestReadyKeys.add(key);
                return true;
            } catch (error) {
                console.warn(`Custom vehicle manifest failed to load (${customManifest}):`, error);
                return false;
            } finally {
                this._vehicleManifestPromises.delete(key);
            }
        })();
        this._vehicleManifestPromises.set(key, promise);
        return promise;
    }

    async _ensureVehicleModelRenderer() {
        if (this.vehicleModelRenderer?.ready) return true;
        if (this._vehicleModelRendererInitPromise) return this._vehicleModelRendererInitPromise;
        if (!this.modelsInitialized || !this.modelManager?.manifest) return false;
        const state = this.vehicleController?.getRenderState?.();
        const hash = String(state?.hash || '').trim();
        if (!hash) return false;

        this._vehicleModelRendererInitPromise = (async () => {
            try {
                const customManifest = String(state?.assetManifest || '').trim();
                if (!await this._ensureVehicleModelDefinition(state)) return false;
                const renderer = new InstancedModelRenderer(this.gl, this.modelManager, this.textureStreamer);
                renderer.maxMeshLoadsInFlight = 4;
                renderer.meshLoadOptions = {
                    usePersistentCache: false,
                    cacheBust: customManifest ? `custom-vehicle-${state.model}-v3` : 'demo-sultan-v3-exact-wheels',
                    requireBlendAttributes: false,
                };
                await renderer.init();
                if (!renderer.ready) return false;
                this.vehicleModelRenderer = renderer;
                return true;
            } catch (error) {
                console.warn('Vehicle model renderer failed to initialize:', error);
                return false;
            } finally {
                if (!this.vehicleModelRenderer?.ready) this._vehicleModelRendererInitPromise = null;
            }
        })();
        return this._vehicleModelRendererInitPromise;
    }

    _getCokeHarvestPickups() {
        return (this.multiplayer?.pickups || [])
            .filter((pickup) => pickup?.available !== false
                && String(pickup?.visual || '') === 'coca_plant'
                && String(pickup?.modelHash || COCA_HARVEST_MODEL_HASH) === COCA_HARVEST_MODEL_HASH)
            .slice(0, 12)
            .sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
    }

    _clearCokePlantMeshes() {
        if (this.cokePlantModelRenderer?.setInstancesForArchetype) {
            try { void this.cokePlantModelRenderer.setInstancesForArchetype(COCA_HARVEST_MODEL_HASH, 'high', null); } catch { /* ignore */ }
        }
        this._cokePlantModelActive = false;
        this._cokePlantModelSignature = '';
    }

    async _ensureCokePlantModelRenderer() {
        if (this.cokePlantModelRenderer?.ready) return true;
        if (this._cokePlantModelRendererInitPromise) return this._cokePlantModelRendererInitPromise;
        if (!this.modelsInitialized || !this.modelManager?.manifest) return false;

        this._cokePlantModelRendererInitPromise = (async () => {
            try {
                await this.modelManager.prefetchMeta?.(COCA_HARVEST_MODEL_HASH, { priority: 'high' });
                if (!this.modelManager?.hasRealMesh?.(COCA_HARVEST_MODEL_HASH)) return false;
                const renderer = new InstancedModelRenderer(this.gl, this.modelManager, this.textureStreamer);
                renderer.maxMeshLoadsInFlight = 1;
                renderer.meshLoadOptions = {
                    usePersistentCache: false,
                    cacheBust: 'nx-coke-plant-v1',
                    requireBlendAttributes: false,
                };
                await renderer.init();
                if (!renderer.ready) return false;
                this.cokePlantModelRenderer = renderer;
                return true;
            } catch (error) {
                console.warn('Coke harvest prop renderer failed to initialize:', error);
                return false;
            } finally {
                if (!this.cokePlantModelRenderer?.ready) this._cokePlantModelRendererInitPromise = null;
            }
        })();
        return this._cokePlantModelRendererInitPromise;
    }

    _syncCokePlantMeshes(forceFullInit = false) {
        const plants = this._getCokeHarvestPickups();
        if (!this.spawnDistrictDemo || !this.modelsInitialized || !plants.length) {
            this._clearCokePlantMeshes();
            return;
        }
        if (!this.cokePlantModelRenderer?.ready) {
            void this._ensureCokePlantModelRenderer().then((ok) => {
                if (ok) this._syncCokePlantMeshes(true);
            });
            return;
        }

        const signature = plants.map((plant) => [
            plant.id,
            Number(plant.x) || 0,
            Number(plant.y) || 0,
            Number(plant.feetZ) || 0,
            Number(plant.heading) || 0,
        ].join(':')).join('|');
        if (forceFullInit || signature !== this._cokePlantModelSignature) {
            const matrices = new Float32Array(plants.length * 16);
            for (let i = 0; i < plants.length; i++) {
                const plant = plants[i];
                glMatrix.quat.setAxisAngle(this._cokePlantModelQuat, [0, 0, 1], (Number(plant.heading) || 0) * Math.PI / 180.0);
                // nx-mod-coke calls CreateObject at the configured Z minus one metre.
                glMatrix.mat4.fromRotationTranslation(this._cokePlantModelMat, this._cokePlantModelQuat, [
                    Number(plant.x) || 0,
                    Number(plant.y) || 0,
                    (Number(plant.feetZ) || 0) - 1.0,
                ]);
                matrices.set(this._cokePlantModelMat, i * 16);
            }
            void this.cokePlantModelRenderer.setInstancesForArchetype(
                COCA_HARVEST_MODEL_HASH, 'high', matrices, -1.0,
                { loadPriority: 135, allowPlaceholderMesh: false },
            );
            this._cokePlantModelSignature = signature;
        }
        const entry = this.cokePlantModelRenderer.instances?.get?.(`${COCA_HARVEST_MODEL_HASH}:high`);
        this._cokePlantModelActive = Array.from(entry?.submeshes?.values?.() || []).some((submesh) => !!submesh?.mesh);
    }

    async _loadRuntimePlayerSkeleton(profile = null) {
        const render = profile?.render || null;
        const relRaw = String(render?.skeleton || '').trim();
        const wantsSkinning = !!render?.skinning && !!relRaw;
        if (!wantsSkinning) {
            this.playerSkinningSkeleton = null;
            try { this.playerModelRenderer?.setSkinningSkeleton?.(null); } catch { /* ignore */ }
            return null;
        }
        const rel = relRaw.replace(/^assets[\\/]/i, '').replace(/\\/g, '/').replace(/^\/+/, '');
        const url = `assets/${rel}?live=${Date.now()}`;
        this._runtimeCharacterSkeletonPromise = (async () => {
            try {
                const skeleton = await fetchJSON(url, {
                    usePersistentCache: false,
                    useMemoryCache: false,
                    priority: 'high',
                });
                if (!skeleton || !Array.isArray(skeleton.bones)) return null;
                this.playerSkinningSkeleton = skeleton;
                try { this.playerModelRenderer?.setSkinningSkeleton?.(skeleton); } catch { /* ignore */ }
                return skeleton;
            } catch (e) {
                console.warn('Runtime player skeleton failed to load:', e);
                this.playerSkinningSkeleton = null;
                try { this.playerModelRenderer?.setSkinningSkeleton?.(null); } catch { /* ignore */ }
                return null;
            }
        })();
        return this._runtimeCharacterSkeletonPromise;
    }

    async _loadRuntimePlayerAnimations(profile = null) {
        const render = profile?.render || null;
        const relRaw = String(render?.animations || '').trim();
        const wantsAnimations = !!render?.skinning && !!relRaw;
        if (!wantsAnimations) {
            this.playerSkinningAnimations = null;
            try { this.playerModelRenderer?.setSkinningAnimationSet?.(null); } catch { /* ignore */ }
            return null;
        }
        const rel = relRaw.replace(/^assets[\\/]/i, '').replace(/\\/g, '/').replace(/^\/+/, '');
        this._runtimeCharacterAnimationsPromise = (async () => {
            try {
                const animations = await this._fetchSkinningAnimationSet(rel);
                if (!animations || !animations.clips || typeof animations.clips !== 'object') return null;
                this.playerSkinningAnimations = animations;
                try { this.playerModelRenderer?.setSkinningAnimationSet?.(animations); } catch { /* ignore */ }
                return animations;
            } catch (e) {
                console.warn('Runtime player animations failed to load:', e);
                this.playerSkinningAnimations = null;
                try { this.playerModelRenderer?.setSkinningAnimationSet?.(null); } catch { /* ignore */ }
                return null;
            }
        })();
        return this._runtimeCharacterAnimationsPromise;
    }

    async _ensureWeaponCombatAnimations() {
        if (this._weaponCombatAnimationsLoaded) return true;
        if (this._weaponCombatAnimationsUnavailable) return false;
        if (this._weaponCombatAnimationsPromise) return this._weaponCombatAnimationsPromise;
        const profile = this.runtimeCharacterProfile;
        const render = profile?.render || null;
        const animationRel = String(render?.animations || '').trim();
        if (!animationRel) return false;
        const combatRel = animationRel
            .replace(/^assets[\\/]/i, '')
            .replace(/\\/g, '/')
            .replace(/_animations\.json$/i, '_combat_animations.json');
        if (!combatRel || combatRel === animationRel) return false;

        this._weaponCombatAnimationsPromise = (async () => {
            try {
                if (!this.playerModelRenderer?.ready) {
                    const ready = await this._ensurePlayerModelRenderer();
                    if (!ready) return false;
                }
                if (!this.playerSkinningAnimations) await this._loadRuntimePlayerAnimations(profile);
                const animations = await this._fetchSkinningAnimationSet(combatRel);
                if (!animations?.clips || typeof animations.clips !== 'object') return false;
                const merged = this.playerModelRenderer?.mergeSkinningAnimationSet?.(animations);
                this.weaponCombatSkinningAnimations = animations;
                this.npcModelRenderer?.mergeSkinningAnimationSet?.(animations);
                this.npcCombatModelRenderer?.mergeSkinningAnimationSet?.(animations);
                this._weaponCombatAnimationsLoaded = !!merged;
                return this._weaponCombatAnimationsLoaded;
            } catch (error) {
                this._weaponCombatAnimationsUnavailable = true;
                console.warn('GTA pistol combat clips failed to load:', error);
                return false;
            } finally {
                this._weaponCombatAnimationsPromise = null;
            }
        })();
        return this._weaponCombatAnimationsPromise;
    }

    async _ensureMeleeAnimations() {
        if (this._meleeAnimationsLoaded) return true;
        if (this._meleeAnimationsUnavailable) return false;
        if (this._meleeAnimationsPromise) return this._meleeAnimationsPromise;
        const animationRel = String(this.runtimeCharacterProfile?.render?.animations || '').trim();
        const meleeRel = animationRel
            .replace(/^assets[\\/]/i, '')
            .replace(/\\/g, '/')
            .replace(/_animations\.json$/i, '_melee_animations.json');
        if (!animationRel || !meleeRel || meleeRel === animationRel) return false;
        this._meleeAnimationsPromise = (async () => {
            try {
                if (!this.playerModelRenderer?.ready && !(await this._ensurePlayerModelRenderer())) return false;
                if (!this.playerSkinningAnimations) await this._loadRuntimePlayerAnimations(this.runtimeCharacterProfile);
                const animations = await this._fetchSkinningAnimationSet(meleeRel);
                if (!animations?.clips || typeof animations.clips !== 'object') return false;
                this.meleeSkinningAnimations = animations;
                const playerMerged = this.playerModelRenderer?.mergeSkinningAnimationSet?.(animations);
                this.npcModelRenderer?.mergeSkinningAnimationSet?.(animations);
                this.npcCombatModelRenderer?.mergeSkinningAnimationSet?.(animations);
                this._meleeAnimationsLoaded = !!playerMerged;
                return this._meleeAnimationsLoaded;
            } catch (error) {
                this._meleeAnimationsUnavailable = true;
                console.warn('GTA melee clips failed to load:', error);
                return false;
            } finally {
                this._meleeAnimationsPromise = null;
            }
        })();
        return this._meleeAnimationsPromise;
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

    _getGameplayAimDirectionData() {
        const fallback = this._viewerDirToDataDir(this.camera?.direction || [0, 0, -1]);
        if (!this.gameplayCamEnabled || !this.ped?.posData || !this.camera?.position) return fallback;

        const cameraData = this._viewerPosToDataPos(this.camera.position);
        const pedData = this.ped.posData;
        const toPedX = Number(pedData[0]) - Number(cameraData[0]);
        const toPedY = Number(pedData[1]) - Number(cameraData[1]);
        const horizontalLength = Math.hypot(toPedX, toPedY);
        if (!Number.isFinite(horizontalLength) || horizontalLength < 1e-5) return fallback;

        // The visual orbit looks at the ped eye point. For gameplay, neutral aim
        // must be level instead of continuing that downward camera-to-eye slope.
        const neutralPitch = Number.isFinite(Number(this._gpAimNeutralPitch))
            ? Number(this._gpAimNeutralPitch)
            : Number(this._gpPitch) || 0.0;
        const aimPitch = Math.max(-0.9, Math.min(0.9, neutralPitch - (Number(this._gpPitch) || 0.0)));
        const horizontalScale = Math.cos(aimPitch);
        return [
            (toPedX / horizontalLength) * horizontalScale,
            (toPedY / horizontalLength) * horizontalScale,
            Math.sin(aimPitch),
        ];
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

    teleportToDerivedRoad() {
        const spawn = this.collisionWorld?.getDerivedRoadSpawn?.();
        if (!Array.isArray(spawn) || spawn.length < 3) return false;
        // Both spawnPedAt() and CollisionWorld movement sweeps clamp to the
        // district bounds. Refresh them from the now-loaded derived road before
        // placing an on-foot player or a seated vehicle at the circuit.
        if (this.spawnDistrictDemo) this._setSpawnDistrictDemo(true, { dropResident: false });
        const [x, y, z] = spawn;
        const vehicle = this.vehicleController?.vehicle;
        if (vehicle && this.vehicleController?.inVehicle) {
            vehicle.position = [x, y, z + (Number(vehicle.groundOffset) || 0.4)];
            vehicle.velocity = [0, 0, 0];
            vehicle.velocityLocal = [0, 0];
            vehicle.speed = 0;
            vehicle.yawRate = 0;
            vehicle.headingRad = 0;
            // Clear wheel/drivetrain state too.  Resetting only the rendered
            // vehicle left the dedicated Assetto solver carrying its old speed
            // into the first circuit frame after /track.
            this.vehicleController?.resetAssettoState?.({ preserveMotion: false });
            vehicle._chassisGroundCache = null;
            try { this.vehicleController?._syncOccupantPed?.(); } catch { /* next fixed step will sync */ }
        } else {
            this.spawnPedAt([x, y, z + (Number(this.pedEyeHeightData) || 1.65)], { groundSource: 'derived_track_road' });
        }
        this._setGtaThirdPersonRigForPed?.({ distanceData: 7.5, heightData: 2.0, sideData: 0.7 });
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
        btn.textContent = inChar ? 'Exit character view (back to map)' : 'Spawn character (city)';
    }

    exitCharacterView() {
        // Disable player mesh instance (and clear its instance buffer so it doesn't linger).
        if (this.player) {
            try { this._clearPlayerEntityMeshes(); } catch { /* ignore */ }
            this.player.enabled = false;
            this.player.hash = null;
            this.player.hashes = [];
            this.player.labels = [];
        }

        // Clear ped state + marker.
        this.ped = null;
        this._resetPedMotion();
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

    _spawnObjToVector4(obj) {
        if (!obj || typeof obj !== 'object') return null;
        const v = [
            Number(obj.x),
            Number(obj.y),
            Number(obj.z),
            Number(obj.w ?? obj.heading ?? 0.0),
        ];
        return this._isFiniteVec3(v) ? v : null;
    }

    _getCharacterModelHashFromUi() {
        const el = document.getElementById('characterModel');
        let raw = String(el?.value || '').trim();
        if (!raw) {
            raw = DEFAULT_CHARACTER_MODEL_NAME;
            if (el && !String(el.value || '').trim()) el.value = raw;
        }
        return this._hashModelToken(raw);
    }

    _hashModelToken(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        if (/^\d+$/.test(raw)) return String((Number(raw) >>> 0));
        return String((joaat(raw) >>> 0));
    }

    async _loadRuntimeCharacterProfile({ timeoutMs = 5_000 } = {}) {
        if (this._runtimeCharacterLoadPromise) return this._runtimeCharacterLoadPromise;
        const ms = Number.isFinite(Number(timeoutMs)) ? Math.max(100, Number(timeoutMs)) : 900;
        this._runtimeCharacterLoadPromise = (async () => {
            const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            const timer = ac ? window.setTimeout(() => ac.abort(), ms) : null;
            try {
                const resp = await fetch(`assets/runtime_character.json?live=${Date.now()}`, {
                    method: 'GET',
                    cache: 'no-store',
                    signal: ac?.signal,
                });
                if (!resp.ok) return null;
                const data = await resp.json().catch(() => null);
                if (!data || typeof data !== 'object') return null;
                this.runtimeCharacterProfile = data;
                this.runtimeCharacterBaseProfile = structuredClone(data);
                this._applyRuntimeCharacterProfileToUi(data);
                void this._loadRuntimeCharacterComponentCatalog();
                this._tryApplyClothingPackPreview();
                void this._loadRuntimePlayerSkeleton(data);
                void this._loadRuntimePlayerAnimations(data);
                if (this.player?.enabled) {
                    this._applyPlayerRenderTargetsFromProfileOrUi({ preserveStored: true });
                    try { this._syncPlayerEntityMesh(true); } catch { /* ignore */ }
                }
                return data;
            } catch (error) {
                window.setTimeout(() => { this._runtimeCharacterLoadPromise = null; }, 0);
                console.warn('[character] Runtime profile load failed; a later sync may retry.', error);
                return null;
            } finally {
                if (timer !== null) window.clearTimeout(timer);
            }
        })();
        return this._runtimeCharacterLoadPromise;
    }

    async _loadRuntimeCharacterOptions({ timeoutMs = 900 } = {}) {
        const ms = Number.isFinite(Number(timeoutMs)) ? Math.max(100, Number(timeoutMs)) : 900;
        const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = ac ? window.setTimeout(() => ac.abort(), ms) : null;
        try {
            const resp = await fetch(`assets/runtime_characters.json?live=${Date.now()}`, {
                method: 'GET',
                cache: 'no-store',
                signal: ac?.signal,
            });
            if (!resp.ok) return [];
            const data = await resp.json().catch(() => null);
            const chars = Array.isArray(data?.characters) ? data.characters.filter((x) => x && typeof x === 'object') : [];
            this.runtimeCharacterOptions = chars;
            this._populateRuntimeAppearanceSelect();
            return chars;
        } catch {
            return [];
        } finally {
            if (timer !== null) window.clearTimeout(timer);
        }
    }

    async _loadRuntimeCharacterComponentCatalog() {
        try {
            const [response, customResponse, clothingPackResponse] = await Promise.all([
                fetch(`assets/character_component_catalog.json?live=${Date.now()}`, { cache: 'no-store' }),
                fetch(`assets/custom_clothing/nx_chains.json?live=${Date.now()}`, { cache: 'no-store' }),
                fetch(`assets/custom_clothing/clothingpack5m.json?live=${Date.now()}`, { cache: 'no-store' }),
            ]);
            if (!response.ok) return null;
            const catalog = await response.json();
            const customPayloads = [
                customResponse.ok ? await customResponse.json() : null,
                clothingPackResponse.ok ? await clothingPackResponse.json() : null,
            ].filter(Boolean);
            for (const custom of customPayloads) {
              if (custom?.models && custom?.meshes) {
                for (const [modelName, components] of Object.entries(custom.models)) {
                    const targetModel = catalog.models?.[modelName];
                    if (!targetModel || !components || typeof components !== 'object') continue;
                    for (const [componentId, variants] of Object.entries(components)) {
                        if (!Array.isArray(variants)) continue;
                        targetModel[componentId] = [
                            ...(Array.isArray(targetModel[componentId]) ? targetModel[componentId] : []),
                            ...variants,
                        ];
                    }
                }
                const collection = String(custom.collection || 'custom').trim() || 'custom';
                const source = collection === 'nx-mod-chains'
                    ? 'custom_clothing/nx_chains.json'
                    : `custom_clothing/${collection}.json`;
                this.runtimeCustomClothingManifests.set(source, custom);
                if (this.modelManager?.manifest) {
                    this.modelManager.installManifestSubset(custom, { source });
                }
              }
            }
            this.runtimeCharacterComponentCatalog = catalog && typeof catalog === 'object' ? catalog : null;
            const resolvedComponents = this._resolveRuntimeCharacterComponentAssets();
            this._renderRuntimeAppearanceComponents();
            this._tryApplyClothingPackPreview();
            if (resolvedComponents) {
                this._applyPlayerRenderTargetsFromProfileOrUi({ preserveStored: true });
                if (this.player?.enabled) this._syncPlayerEntityMesh(true);
            }
            return this.runtimeCharacterComponentCatalog;
        } catch {
            return null;
        }
    }

    _tryApplyClothingPackPreview() {
        if (!new URLSearchParams(window.location.search).has('appearancePreview')) return;
        if (!this.runtimeCharacterProfile || !this.runtimeCharacterComponentCatalog || this._clothingPackPreviewApplied) return;
        let preview = null;
        try { preview = JSON.parse(localStorage.getItem('webglgta.clothingpack5m.preview.v1') || 'null'); } catch { return; }
        if (!preview?.id) return;
        const modelName = preview.sex === 'female' ? 'mp_f_freemode_01' : 'mp_m_freemode_01';
        if (this.runtimeCharacterProfile.modelName !== modelName) {
            void this._switchRuntimeCharacterSex(preview.sex).then(() => this._tryApplyClothingPackPreview());
            return;
        }
        const variants = this.runtimeCharacterComponentCatalog.models?.[modelName]?.[String(preview.componentId)] || [];
        const variant = variants.find((entry) => entry.itemId === preview.id);
        if (!variant) return;
        this._clothingPackPreviewApplied = true;
        this._setRuntimeCharacterComponent(Number(preview.componentId), variant, Number(preview.texture ?? variant.textures?.[0]) || 0);
        this._setGtaThirdPersonRigForPed({ distanceData: 3.1, heightData: 0.75, sideData: 0 });
        if (!new URLSearchParams(window.location.search).has('catalogPreview')) {
            window.setTimeout(() => document.getElementById('openCharacterCreator')?.click(), 250);
        }
    }

    _applyRuntimeCharacterProfileToUi(profile) {
        if (!profile || typeof profile !== 'object') return;
        if (Array.isArray(profile.disabledComponentIds)) {
            this.runtimeCharacterDisabledComponentIds = new Set(
                profile.disabledComponentIds.map(Number).filter((id) => OPTIONAL_PED_COMPONENT_IDS.has(id)),
            );
        }
        const modelName = String(profile.modelName || '').trim();
        const el = document.getElementById('characterModel');
        if (el && modelName) {
            const cur = String(el.value || '').trim();
            if (!cur || cur === DEFAULT_CHARACTER_MODEL_NAME || cur === 'player_zero' || modelName.startsWith('mp_')) {
                el.value = modelName;
            }
        }
        this._syncRuntimeCharacterSexControls();
        this._renderRuntimeAppearanceComponents();
        this._renderCompleteAppearanceControls();
        this._syncPlayerHairAppearance();
    }

    _syncRuntimeCharacterSexControls() {
        const modelName = String(this.runtimeCharacterProfile?.modelName || '');
        document.querySelectorAll('[data-character-sex]').forEach((button) => {
            const selected = modelName === FREEMODE_CHARACTER_MODELS[button.dataset.characterSex]?.modelName;
            button.setAttribute('aria-pressed', String(selected));
        });
    }

    async _switchRuntimeCharacterSex(sex) {
        const target = FREEMODE_CHARACTER_MODELS[String(sex || '').toLowerCase()];
        const catalog = this.runtimeCharacterComponentCatalog?.models?.[target?.modelName];
        if (!target || !catalog) return false;
        if (this.runtimeCharacterProfile?.modelName === target.modelName) return true;

        const previous = this._ensureCompleteAppearanceProfile() || {};
        const previousComponents = new Map((previous.components || []).map((component) => [
            Number(component.componentId ?? component.component_id ?? component.id), component,
        ]));
        const components = Object.keys(catalog).map(Number).sort((a, b) => a - b).map((componentId) => {
            const variants = Array.isArray(catalog[String(componentId)]) ? catalog[String(componentId)] : [];
            const old = previousComponents.get(componentId);
            const variant = (!old?.collection
                ? variants.find((item) => !item.collection && Number(item.drawable) === Number(old?.drawable))
                : null) || variants.find((item) => !item.collection) || variants[0];
            if (!variant) return null;
            const textures = Array.isArray(variant.textures) && variant.textures.length ? variant.textures : [0];
            const texture = textures.includes(Number(old?.texture)) ? Number(old.texture) : Number(textures[0]);
            return {
                componentId,
                drawable: Number(variant.drawable) || 0,
                texture: Number.isFinite(texture) ? texture : 0,
                palette: Number(old?.palette) || 0,
                assetName: String(variant.assetName || ''),
                assetHash: String(variant.textureAssets?.[String(texture)] || variant.hash || ''),
                drawableName: String(variant.assetName || ''),
                collection: variant.collection ? String(variant.collection) : null,
                itemId: variant.itemId ? String(variant.itemId) : null,
                variantKey: variant.variantKey ? String(variant.variantKey) : null,
            };
        }).filter(Boolean);

        const profile = structuredClone(previous);
        profile.modelName = target.modelName;
        profile.modelHash = target.modelHash;
        profile.components = components;
        profile.render = {
            ...(profile.render || {}),
            mode: 'freemode_components',
            modelNames: components.map((component) => component.assetHash).filter(Boolean),
            fallbackModelName: DEFAULT_CHARACTER_MODEL_NAME,
            meshComposition: 'skinned_drawable_components',
            skinning: true,
            skeleton: target.skeleton,
            animations: target.animations,
        };
        this.runtimeCharacterProfile = profile;
        this.runtimeCharacterSelectedIndex = -1;
        this.runtimeCharacterDisabledComponentIds = new Set();
        const selection = document.getElementById('runtimeAppearanceSelect');
        if (selection) selection.value = '';
        const modelInput = document.getElementById('characterModel');
        if (modelInput) modelInput.value = target.modelName;
        this._applyRuntimeCharacterProfileToUi(profile);
        this._applyPlayerRenderTargetsFromProfileOrUi();
        await Promise.all([this._loadRuntimePlayerSkeleton(profile), this._loadRuntimePlayerAnimations(profile)]);
        if (this.player?.enabled) this._syncPlayerEntityMesh(true);
        this._saveRuntimeAppearanceDraft();
        return true;
    }

    _runtimeAppearanceOptionLabel(profile, index) {
        const row = profile?.row || {};
        const model = String(profile?.modelName || 'unknown');
        const cid = String(row.citizenid || '').trim();
        const active = String(row.active || '').trim();
        const rowId = String(row.rowId || row.updated || '').trim();
        const bits = [`${index + 1}`, model];
        if (cid) bits.push(cid);
        if (active) bits.push(`active=${active}`);
        if (rowId) bits.push(rowId);
        return bits.join(' | ');
    }

    _populateRuntimeAppearanceSelect() {
        const el = document.getElementById('runtimeAppearanceSelect');
        if (!el) return;
        const prev = String(el.value || '');
        while (el.options.length > 1) el.remove(1);
        const chars = Array.isArray(this.runtimeCharacterOptions) ? this.runtimeCharacterOptions : [];
        for (let i = 0; i < chars.length; i++) {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = this._runtimeAppearanceOptionLabel(chars[i], i);
            el.appendChild(opt);
        }
        if (this.runtimeCharacterSelectedIndex >= 0 && this.runtimeCharacterSelectedIndex < chars.length) {
            el.value = String(this.runtimeCharacterSelectedIndex);
        } else if (prev && chars[Number(prev)]) {
            el.value = prev;
        } else {
            el.value = '';
        }
    }

    _activeRuntimeCharacterComponents(profile = this.runtimeCharacterProfile) {
        const disabled = this.runtimeCharacterDisabledComponentIds instanceof Set
            ? this.runtimeCharacterDisabledComponentIds
            : new Set();
        return (Array.isArray(profile?.components) ? profile.components : [])
            .filter((c) => c && typeof c === 'object')
            .filter((c) => {
                const id = Number(c.componentId ?? c.component_id ?? c.id);
                return !Number.isFinite(id) || !disabled.has(id);
            });
    }

    _setRuntimeCharacterComponentEnabled(componentId, enabled, { render = true } = {}) {
        const id = Number(componentId);
        if (!Number.isFinite(id) || (REQUIRED_PED_COMPONENT_IDS.has(id) && !enabled)) return false;
        const disabled = this.runtimeCharacterDisabledComponentIds instanceof Set
            ? this.runtimeCharacterDisabledComponentIds
            : new Set();
        if (enabled) disabled.delete(id);
        else disabled.add(id);
        this.runtimeCharacterDisabledComponentIds = disabled;
        if (this.runtimeCharacterProfile) {
            this.runtimeCharacterProfile.disabledComponentIds = Array.from(disabled).sort((a, b) => a - b);
        }
        if (render) {
            this._applyPlayerRenderTargetsFromProfileOrUi({ preserveStored: true });
            if (this.player?.enabled) this._syncPlayerEntityMesh(true);
            this._saveRuntimeAppearanceDraft();
        }
        return true;
    }

    _applyShirtlessRuntimeAppearance() {
        const profile = this.runtimeCharacterProfile;
        const model = String(profile?.modelName || '');
        const variants = this.runtimeCharacterComponentCatalog?.models?.[model]?.['3'] || [];
        const torso = variants.find((variant) => !variant.collection && Number(variant.drawable) === 15);
        if (!profile || !torso) return false;
        this._setRuntimeCharacterComponentEnabled(8, false, { render: false });
        this._setRuntimeCharacterComponentEnabled(11, false, { render: false });
        this._setRuntimeCharacterComponentEnabled(3, true, { render: false });
        this._setRuntimeCharacterComponent(3, torso, Number(torso.textures?.[0]) || 0, { render: false });
        this._applyPlayerRenderTargetsFromProfileOrUi({ preserveStored: true });
        if (this.player?.enabled) this._syncPlayerEntityMesh(true);
        this._saveRuntimeAppearanceDraft();
        this._renderRuntimeAppearanceComponents();
        return true;
    }

    _resolveRuntimeCharacterComponentAssets(profile = this.runtimeCharacterProfile) {
        const modelName = String(profile?.modelName || '').trim();
        const modelCatalog = this.runtimeCharacterComponentCatalog?.models?.[modelName];
        if (!modelCatalog || !Array.isArray(profile?.components)) return false;
        let changed = false;
        for (const component of profile.components) {
            if (!component || typeof component !== 'object') continue;
            const componentId = Number(component.componentId ?? component.component_id ?? component.id);
            const drawable = Number(component.drawable ?? component.drawable_id ?? component.drawableId);
            const texture = Number(component.texture ?? component.texture_id ?? component.textureId) || 0;
            const variants = modelCatalog[String(componentId)];
            if (!Number.isFinite(componentId) || !Number.isFinite(drawable) || !Array.isArray(variants)) continue;
            const exactVariant = (component.variantKey
                ? variants.find((item) => String(item?.variantKey || '') === String(component.variantKey))
                : null)
                || (component.itemId
                    ? variants.find((item) => String(item?.itemId || '') === String(component.itemId))
                    : null)
                || variants.find((item) => !item?.collection && Number(item?.drawable) === drawable)
                || variants.find((item) => Number(item?.drawable) === drawable);
            const variant = exactVariant
                || variants.find((item) => !item?.collection)
                || variants[0];
            if (!variant) continue;
            const supportedTextures = Array.isArray(variant.textures) && variant.textures.length
                ? variant.textures.map(Number).filter(Number.isFinite)
                : Object.keys(variant.textureAssets || {}).map(Number).filter(Number.isFinite);
            const resolvedTexture = supportedTextures.includes(texture) ? texture : (supportedTextures[0] ?? texture);
            const assetHash = String(variant.textureAssets?.[String(resolvedTexture)] || variant.hash || '').trim();
            if (!assetHash) continue;
            const resolvedDrawable = Number(variant.drawable);
            if (Number.isFinite(resolvedDrawable) && Number(component.drawable) !== resolvedDrawable) {
                component.drawable = resolvedDrawable;
                changed = true;
            }
            if (Number(component.texture) !== resolvedTexture) {
                component.texture = resolvedTexture;
                changed = true;
            }
            if (String(component.assetHash || '') !== assetHash) {
                component.assetHash = assetHash;
                changed = true;
            }
            const assetName = String(variant.assetName || '').trim();
            if (assetName && String(component.assetName || '') !== assetName) {
                component.assetName = assetName;
                changed = true;
            }
            if (assetName) component.drawableName = assetName;
        }
        return changed;
    }

    _profileWithActiveComponents(profile = this.runtimeCharacterProfile) {
        if (!profile || typeof profile !== 'object') return profile;
        const components = this._activeRuntimeCharacterComponents(profile);
        const names = components.map((c) => String(c.assetHash || c.assetName || '').trim()).filter(Boolean);
        const render = { ...(profile.render || {}) };
        if (String(render.mode || '') === 'freemode_components' || names.length > 1) {
            render.modelNames = names;
        }
        return { ...profile, components, render };
    }

    _renderRuntimeAppearanceComponents() {
        const roots = [
            document.getElementById('runtimeAppearanceComponents'),
            document.getElementById('characterCreatorComponents'),
        ].filter(Boolean);
        if (!roots.length) return;
        const profile = this.runtimeCharacterProfile || null;
        const components = Array.isArray(profile?.components) ? profile.components : [];
        if (!components.length) {
            for (const root of roots) root.textContent = 'No saved freemode components loaded.';
            return;
        }
        const disabled = this.runtimeCharacterDisabledComponentIds instanceof Set
            ? this.runtimeCharacterDisabledComponentIds
            : new Set();
        for (const root of roots) root.replaceChildren();
        for (const c of components) {
            if (!c || typeof c !== 'object') continue;
            const id = Number(c.componentId ?? c.component_id ?? c.id);
            const row = document.createElement('div');
            row.style.display = 'grid';
            row.style.gridTemplateColumns = '22px minmax(76px, 1fr) minmax(88px, 1.25fr) 58px';
            row.style.gap = '4px';
            row.style.alignItems = 'center';
            row.style.marginTop = '5px';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !(Number.isFinite(id) && disabled.has(id));
            cb.disabled = REQUIRED_PED_COMPONENT_IDS.has(id);
            cb.title = cb.disabled ? 'Required body mesh' : 'Show or remove this clothing layer';
            cb.addEventListener('change', () => {
                if (!this._setRuntimeCharacterComponentEnabled(id, cb.checked)) return;
                drawableSelect.value = cb.checked ? optionKey(selectedVariant || available[0]) : PED_COMPONENT_NONE_KEY;
                textureSelect.disabled = !cb.checked;
            });
            const name = String(c.assetName || '').trim() || `component_${Number.isFinite(id) ? id : '?'}`;
            const draw = Number(c.drawable ?? c.drawable_id ?? c.drawableId);
            const tex = Number(c.texture ?? c.texture_id ?? c.textureId);
            const model = String(profile?.modelName || 'mp_m_freemode_01');
            const variants = this.runtimeCharacterComponentCatalog?.models?.[model]?.[String(id)] || [];
            const title = document.createElement('span');
            title.textContent = String(PED_COMPONENT_DISPLAY_NAMES[id] || variants[0]?.label || name.split('_')[0] || `Slot ${id}`);
            cb.setAttribute('aria-label', `Show ${title.textContent}`);

            const drawableSelect = document.createElement('select');
            drawableSelect.title = `${title.textContent} drawable`;
            drawableSelect.setAttribute('aria-label', `${title.textContent} drawable`);
            const available = variants.length ? variants : [{ drawable: draw, assetName: name, textures: [tex] }];
            const optionKey = (variant) => String(variant?.variantKey || `base:${variant?.drawable}`);
            if (OPTIONAL_PED_COMPONENT_IDS.has(id)) {
                const option = document.createElement('option');
                option.value = PED_COMPONENT_NONE_KEY;
                option.textContent = 'None / remove';
                drawableSelect.appendChild(option);
            }
            for (const variant of available) {
                const option = document.createElement('option');
                option.value = optionKey(variant);
                const collection = String(variant.collection || '').toLowerCase();
                const customKind = collection === 'nx-mod-chains'
                    ? 'Chain'
                    : (collection === 'clothingpack5m' ? 'Pack' : 'Collection');
                const customName = collection === 'clothingpack5m'
                    ? String(variant.assetName || variant.label || variant.itemId || '').replace(/^.*\^/, '')
                    : String(variant.label || variant.itemId || variant.assetName || 'Custom item');
                option.textContent = variant.barefoot
                    ? 'Barefoot'
                    : variant.collection
                    ? `${customKind}: ${customName}`
                    : `${variant.drawable}: ${variant.assetName}`;
                drawableSelect.appendChild(option);
            }
            const selectedVariant = c.variantKey
                ? available.find((variant) => variant.variantKey === c.variantKey)
                : available.find((variant) => !variant.collection && Number(variant.drawable) === draw);
            drawableSelect.value = disabled.has(id) && OPTIONAL_PED_COMPONENT_IDS.has(id)
                ? PED_COMPONENT_NONE_KEY
                : optionKey(selectedVariant || available[0]);

            const textureSelect = document.createElement('select');
            textureSelect.title = `${title.textContent} texture`;
            textureSelect.setAttribute('aria-label', `${title.textContent} texture`);
            const fillTextures = (variant) => {
                textureSelect.replaceChildren();
                const textures = Array.isArray(variant?.textures) && variant.textures.length ? variant.textures : [tex];
                for (const texture of textures) {
                    const option = document.createElement('option');
                    option.value = String(texture);
                    option.textContent = `T${texture}`;
                    textureSelect.appendChild(option);
                }
                textureSelect.value = String(tex);
            };
            fillTextures(selectedVariant || available[0]);
            textureSelect.disabled = disabled.has(id);

            drawableSelect.addEventListener('change', () => {
                if (drawableSelect.value === PED_COMPONENT_NONE_KEY) {
                    cb.checked = false;
                    textureSelect.disabled = true;
                    this._setRuntimeCharacterComponentEnabled(id, false);
                    return;
                }
                const variant = available.find((v) => optionKey(v) === drawableSelect.value);
                if (!variant) return;
                cb.checked = true;
                textureSelect.disabled = false;
                this._setRuntimeCharacterComponentEnabled(id, true, { render: false });
                fillTextures(variant);
                this._setRuntimeCharacterComponent(id, variant, Number(textureSelect.value));
            });
            textureSelect.addEventListener('change', () => {
                const variant = available.find((v) => optionKey(v) === drawableSelect.value);
                if (variant) this._setRuntimeCharacterComponent(id, variant, Number(textureSelect.value));
            });

            row.append(cb, title, drawableSelect, textureSelect);
            for (const root of roots) root.appendChild(root === roots[0] ? row : row.cloneNode(true));
        }
        // Cloned creator rows need their own event handlers; rendering once per
        // destination keeps the compact panel and dialog synchronized.
        if (roots.length > 1 && roots[1].children.length) {
            const compact = roots[0];
            const clones = Array.from(compact.children).map((node) => {
                const clone = node.cloneNode(true);
                const sourceControls = node.querySelectorAll('input,select');
                const cloneControls = clone.querySelectorAll('input,select');
                cloneControls.forEach((control, index) => {
                    const source = sourceControls[index];
                    if (!source) return;
                    if (control.type === 'checkbox') control.checked = source.checked;
                    else control.value = source.value;
                });
                return clone;
            });
            roots[1].replaceChildren(...clones);
            for (let i = 0; i < roots[1].children.length; i++) {
                const sourceRow = compact.children[i];
                const targetRow = roots[1].children[i];
                const sourceControls = sourceRow.querySelectorAll('input,select');
                const targetControls = targetRow.querySelectorAll('input,select');
                targetControls.forEach((control, index) => {
                    control.addEventListener('change', () => {
                        const source = sourceControls[index];
                        if (!source) return;
                        if (control.type === 'checkbox') source.checked = control.checked;
                        else source.value = control.value;
                        source.dispatchEvent(new Event('change'));
                        this._renderRuntimeAppearanceComponents();
                    });
                });
            }
        }
    }

    _setRuntimeCharacterComponent(componentId, variant, texture, { render = true } = {}) {
        const profile = this.runtimeCharacterProfile;
        if (!profile || !Array.isArray(profile.components)) return;
        const component = profile.components.find((c) => Number(c.componentId ?? c.component_id ?? c.id) === Number(componentId));
        if (!component) return;
        component.componentId = Number(componentId);
        component.drawable = Number(variant.drawable) || 0;
        component.texture = Number.isFinite(Number(texture)) ? Number(texture) : 0;
        component.palette = Number(component.palette) || 0;
        component.assetName = String(variant.assetName || component.assetName || '');
        component.assetHash = String(variant.textureAssets?.[String(component.texture)] || variant.hash || '');
        component.drawableName = component.assetName;
        component.collection = variant.collection ? String(variant.collection) : null;
        component.itemId = variant.itemId ? String(variant.itemId) : null;
        component.variantKey = variant.variantKey ? String(variant.variantKey) : null;
        if (component.collection && component.assetHash) {
            this._installRuntimeCustomClothingAsset(component.assetHash);
        }
        if (render) {
            this._applyPlayerRenderTargetsFromProfileOrUi({ preserveStored: true });
            if (this.player?.enabled) this._syncPlayerEntityMesh(true);
            this._saveRuntimeAppearanceDraft();
        }
    }

    _getIlleniumAppearancePayload() {
        const profile = this.runtimeCharacterProfile || {};
        return {
            model: String(profile.modelName || ''),
            components: (profile.components || []).map((c) => ({
                component_id: Number(c.componentId ?? c.component_id ?? c.id),
                drawable: Number(c.drawable ?? 0),
                texture: Number(c.texture ?? 0),
                collection: c.collection ? String(c.collection) : null,
                itemId: c.itemId ? String(c.itemId) : null,
                variantKey: c.variantKey ? String(c.variantKey) : null,
                assetHash: c.assetHash ? String(c.assetHash) : null,
                assetName: c.assetName ? String(c.assetName) : null,
            })),
            props: Array.isArray(profile.props) ? profile.props : [],
            disabledComponentIds: Array.from(this.runtimeCharacterDisabledComponentIds || []).sort((a, b) => a - b),
            hair: profile.appearance?.hair || { color: 0, highlight: 0 },
            headBlend: profile.headBlend || profile.appearance?.headBlend || null,
            faceFeatures: profile.faceFeatures || profile.appearance?.faceFeatures || {},
            headOverlays: profile.headOverlays || profile.appearance?.headOverlays || {},
            tattoos: Array.isArray(profile.tattoos) ? profile.tattoos : [],
        };
    }

    _ensureCompleteAppearanceProfile() {
        const profile = this.runtimeCharacterProfile;
        if (!profile) return null;
        profile.appearance ||= {};
        profile.appearance.hair ||= { color: 0, highlight: 0 };
        profile.headBlend ||= { shapeFirst: 0, shapeSecond: 0, shapeThird: 0, skinFirst: 0, skinSecond: 0, skinThird: 0, shapeMix: 0.5, skinMix: 0.5, thirdMix: 0 };
        profile.faceFeatures ||= {};
        profile.headOverlays ||= {};
        profile.props ||= [0, 1, 2, 6, 7].map((propId) => ({ propId, drawable: -1, texture: 0 }));
        profile.tattoos ||= [];
        return profile;
    }

    _renderCompleteAppearanceControls() {
        const profile = this._ensureCompleteAppearanceProfile();
        if (!profile) return;
        const makeNumber = (root, label, value, min, max, step, onChange) => {
            if (!root) return;
            const row = document.createElement('label');
            row.className = 'appearance-field';
            const title = document.createElement('span'); title.textContent = label;
            const input = document.createElement('input'); input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = value;
            const number = document.createElement('input'); number.type = 'number'; number.min = min; number.max = max; number.step = step; number.value = value;
            const apply = (next) => { input.value = next; number.value = next; onChange(Number(next)); this._saveRuntimeAppearanceDraft(); };
            input.addEventListener('input', () => apply(input.value));
            number.addEventListener('change', () => apply(number.value));
            row.append(title, input, number); root.appendChild(row);
        };
        const heritage = document.getElementById('characterCreatorHeritage');
        heritage?.replaceChildren();
        for (const [key, label, min, max, step] of [
            ['shapeFirst', 'Mother shape', 0, 45, 1], ['shapeSecond', 'Father shape', 0, 45, 1],
            ['skinFirst', 'Mother skin', 0, 45, 1], ['skinSecond', 'Father skin', 0, 45, 1],
            ['shapeMix', 'Shape mix', 0, 1, 0.01], ['skinMix', 'Skin mix', 0, 1, 0.01],
        ]) makeNumber(heritage, label, profile.headBlend[key] ?? 0, min, max, step, (v) => { profile.headBlend[key] = v; });

        const face = document.getElementById('characterCreatorFace');
        face?.replaceChildren();
        const faceNames = ['Nose width','Nose peak','Nose length','Nose bone','Nose tip','Nose twist','Brow height','Brow depth','Cheekbone height','Cheekbone width','Cheek width','Eye opening','Lip thickness','Jaw width','Jaw shape','Chin height','Chin depth','Chin width','Chin indent','Neck width'];
        faceNames.forEach((label, index) => makeNumber(face, label, profile.faceFeatures[index] ?? 0, -1, 1, 0.01, (v) => { profile.faceFeatures[index] = v; }));

        const overlays = document.getElementById('characterCreatorOverlays');
        overlays?.replaceChildren();
        const overlayNames = ['Blemishes','Facial hair','Eyebrows','Ageing','Makeup','Blush','Complexion','Sun damage','Lipstick','Moles/freckles','Chest hair','Body blemishes'];
        overlayNames.forEach((label, index) => makeNumber(overlays, label, profile.headOverlays[index]?.value ?? -1, -1, 63, 1, (v) => { profile.headOverlays[index] = { ...(profile.headOverlays[index] || {}), value: v, opacity: profile.headOverlays[index]?.opacity ?? 1 }; }));
        makeNumber(overlays, 'Hair color', profile.appearance.hair.color ?? 0, 0, 63, 1, (v) => { profile.appearance.hair.color = v; this._syncPlayerHairAppearance(); });
        makeNumber(overlays, 'Hair highlight', profile.appearance.hair.highlight ?? 0, 0, 63, 1, (v) => { profile.appearance.hair.highlight = v; this._syncPlayerHairAppearance(); });

        const props = document.getElementById('characterCreatorProps');
        props?.replaceChildren();
        const propNames = {0:'Hat',1:'Glasses',2:'Ears',6:'Watch',7:'Bracelet'};
        profile.props.forEach((prop) => makeNumber(props, propNames[prop.propId] || `Prop ${prop.propId}`, prop.drawable ?? -1, -1, 255, 1, (v) => { prop.drawable = v; }));
    }

    _saveRuntimeAppearanceDraft() {
        try { localStorage.setItem('webglgta.characterAppearanceDraft', JSON.stringify(this._getIlleniumAppearancePayload())); } catch { /* ignore */ }
    }

    _syncPlayerHairAppearance() {
        const renderer = this.playerModelRenderer;
        if (!renderer) return;
        const hair = this.runtimeCharacterProfile?.appearance?.hair || { color: 0, highlight: 0 };
        renderer.pedHairPrimary = hairColorLinear(hair.color);
        renderer.pedHairHighlight = hairColorLinear(hair.highlight);
    }

    _getPlayerRenderSpecsFromProfileOrUi({ preserveStored = false, profile: profileOverride = null } = {}) {
        const sourceProfile = profileOverride || this.runtimeCharacterProfile || null;
        this._resolveRuntimeCharacterComponentAssets(sourceProfile);
        const profile = this._profileWithActiveComponents(sourceProfile);
        const render = profile?.render || null;
        const names = Array.isArray(render?.modelNames)
            ? render.modelNames.map((x) => String(x || '').trim()).filter(Boolean)
            : [];
        if (names.length) {
            const mode = String(render?.mode || (names.length > 1 ? 'composite' : 'single'));
            const isComposite = names.length > 1 || mode === 'freemode_components';
            return {
                specs: names.map((name) => ({
                    hash: /^\d+$/.test(name) ? String(Number(name) >>> 0) : this._hashModelToken(name),
                    label: name,
                })).filter((s) => !!s.hash),
                mode,
                requireRenderableCount: isComposite ? names.length : 1,
            };
        }

        if (preserveStored && Array.isArray(this.player?.hashes) && this.player.hashes.length) {
            const storedLabels = Array.isArray(this.player?.labels) ? this.player.labels : [];
            return {
                specs: this.player.hashes.map((h, index) => {
                    const hash = String(h);
                    const manifestLabel = this.modelManager?.manifest?.meshes?.[hash]?.pedComponent?.drawableName;
                    const storedLabel = String(storedLabels[index] || '').trim();
                    const usefulStoredLabel = storedLabel && !/^\d+$/.test(storedLabel) ? storedLabel : '';
                    return {
                        hash,
                        label: String(usefulStoredLabel || manifestLabel || hash),
                    };
                }),
                mode: this.player?.renderMode || 'single',
                requireRenderableCount: 1,
            };
        }

        const h = this._getCharacterModelHashFromUi();
        return {
            specs: h ? [{ hash: h, label: String(document.getElementById('characterModel')?.value || h) }] : [],
            mode: 'single',
            requireRenderableCount: 1,
        };
    }

    _applyPlayerRenderTargetsFromProfileOrUi({ preserveStored = false } = {}) {
        if (!this.player) return [];
        const chosen = this._getPlayerRenderSpecsFromProfileOrUi({ preserveStored });
        const specs = chosen.specs || [];
        this.player.hashes = specs.map((s) => String(s.hash)).filter(Boolean);
        this.player.labels = specs.map((s) => String(s.label || s.hash));
        this.player.hash = this.player.hashes[0] || String((joaat(DEFAULT_CHARACTER_MODEL_NAME) >>> 0));
        this.player.renderMode = String(chosen.mode || (this.player.hashes.length > 1 ? 'composite' : 'single'));
        this.player.requireRenderableCount = Math.max(1, Number(chosen.requireRenderableCount) || 1);
        for (const h of this.player.hashes) this._queuePlayerModelMetaRefresh(h);
        return this.player.hashes;
    }

    _clearPlayerEntityMeshes() {
        if (!this.player || !this.playerModelRenderer?.ready || !this.playerModelRenderer.setInstancesForArchetype) return;
        const keys = this.player._activeMeshKeys instanceof Set
            ? Array.from(this.player._activeMeshKeys)
            : [];
        const lod = String(this.player.lod || 'high');
        for (const key of keys) {
            const h = String(key).split(':')[0];
            if (!h) continue;
            try { void this.playerModelRenderer.setInstancesForArchetype(h, lod, new Float32Array(0), 0.0); } catch { /* ignore */ }
        }
        if (this.player._activeMeshKeys instanceof Set) this.player._activeMeshKeys.clear();
    }

    _queuePlayerModelMetaRefresh(h) {
        if (!h || !this.modelManager?.prefetchMeta) return;
        try {
            // Runtime clothing already supplies its own manifest metadata. Forcing
            // a refresh here incorrectly requests a base shard for the custom hash.
            if (this._installRuntimeCustomClothingAsset(h) || this.modelManager.hasRealMesh?.(h)) {
                try { this._syncPlayerEntityMesh(true); } catch { /* ignore */ }
                try { this.playerModelRenderer?.pumpMeshLoadsOnce?.(); } catch { /* ignore */ }
                return;
            }
            const p = this.modelManager.prefetchMeta(h, { priority: 'high', force: true });
            if (p && typeof p.then === 'function') {
                void p.then(() => {
                    try { this._syncPlayerEntityMesh(true); } catch { /* ignore */ }
                    try { this.playerModelRenderer?.pumpMeshLoadsOnce?.(); } catch { /* ignore */ }
                });
            }
        } catch {
            // ignore
        }
    }

    _applyRuntimeSpawn(result) {
        const spawn = result?.spawn || null;
        if (!spawn || typeof spawn !== 'object') return false;
        const ped = this._spawnObjToVector4(spawn.ped);
        if (!ped || !this._isFiniteVec2(ped)) return false;
        const cam = this._spawnObjToVector4(spawn.cam);
        this._runtimeYbnAlignment = Number.isFinite(Number(ped[2]))
            ? this.collisionWorld?.alignYbnToKnownSurface?.(ped[0], ped[1], ped[2])
            : null;
        const rawHeightEnvelopeZ = this.terrainRenderer?.getHeightAtXY?.(ped[0], ped[1]);
        const heightVisualOffset = Number.isFinite(Number(rawHeightEnvelopeZ)) && Number.isFinite(Number(ped[2]))
            ? Number(ped[2]) - Number(rawHeightEnvelopeZ)
            : 0.0;
        this.terrainRenderer?.setVisualZOffset?.(heightVisualOffset);
        this._terrainDebugVisualOffset = heightVisualOffset;

        if (cam && this._isFiniteVec3(cam)) {
            this.applyPedAndCameraFromConfig(ped, cam, { preservePedZ: true });
        } else {
            this.spawnPedAt([ped[0], ped[1], ped[2] + this.pedEyeHeightData], { groundSource: 'runtime' });
            this._setGtaThirdPersonRigForPed({ distanceData: 6.0, heightData: 1.7, sideData: 0.6 });
        }

        // Keep manual controls truthful after a server-resolved spawn. Previously
        // they retained a legacy fallback position even when the player was placed
        // at the active FiveM location.
        try {
            const pedInput = document.getElementById('pedCoords');
            if (pedInput) pedInput.value = `vector4(${ped[0].toFixed(4)}, ${ped[1].toFixed(4)}, ${ped[2].toFixed(4)}, ${ped[3].toFixed(4)})`;
            const camInput = document.getElementById('camCoords');
            if (camInput && cam) camInput.value = `vector4(${cam[0].toFixed(4)}, ${cam[1].toFixed(4)}, ${cam[2].toFixed(4)}, ${cam[3].toFixed(4)})`;
        } catch {
            // ignore UI-only update
        }

        this.player.enabled = true;
        this.player.lod = 'high';
        this.player.headingRad = glMatrix.glMatrix.toRadian(Number(ped[3]) || 0.0);
        this.player._lastMoveDirData = [0, 0, 0];
        this.player.animPhase = 0.0;
        this.player.animMove01 = 0.0;
        this.player.animSpeed = 0.0;
        this.player.animGait = 'idle';
        this.player.handsUp = false;
        this.followPed = true;
        this.controlPed = true;
        this._followPedYSmoothed = null;
        this._applyPlayerRenderTargetsFromProfileOrUi();
        try { this._initGameplayCameraFromCurrentPose(); } catch { /* ignore */ }
        try { this._syncPlayerEntityMesh(true); } catch { /* ignore */ }

        try {
            const follow = document.getElementById('followPed');
            if (follow) follow.checked = true;
            const control = document.getElementById('controlPed');
            if (control) control.checked = true;
        } catch {
            // ignore
        }

        this._runtimeSpawnInfo = {
            kind: String(spawn.kind || 'unknown'),
            source: String(spawn.source || ''),
            ped: [ped[0], ped[1], ped[2], ped[3]],
            diagnostics: result?.diagnostics || null,
        };
        this._setSpawnCharacterButtonLabel();
        const sourceText = this._runtimeSpawnInfo.source ? ` (${this._runtimeSpawnInfo.source})` : '';
        this._setBootStatus(`Spawn source: ${this._runtimeSpawnInfo.kind}${sourceText}`);
        return true;
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

    spawnPedAt(posDataXYZ, { groundSource = null } = {}) {
        const constrained = this._clampDataPositionToSpawnDistrict(posDataXYZ);
        const x = constrained[0];
        const y = constrained[1];
        const z = constrained[2];
        const posData = [x, y, z];
        const posView = this._dataToViewer(posData);

        // Keep camera offset so follow mode feels natural.
        const camOffset = glMatrix.vec3.create();
        glMatrix.vec3.subtract(camOffset, this.camera.position, this.camera.target);

        this.ped = { posData, posView, camOffset: [camOffset[0], camOffset[1], camOffset[2]] };
        if (groundSource) this._pedGroundSource = String(groundSource);
        this._resetPedMotion();
        if (this.pedRenderer?.setPosition) this.pedRenderer.setPosition(posData);
        else this.pedRenderer?.setPositions?.([posData]);
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

        const distance = Number(distanceData);
        const height = Number(heightData);
        const shoulderOffset = Number(sideData);
        const dist = Math.max(1.0, Number.isFinite(distance) ? distance : 6.0);
        const h = Number.isFinite(height) ? height : 1.7;
        const side = Number.isFinite(shoulderOffset) ? shoulderOffset : 0.6;

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

    _getSpawnDistrictCameraRig() {
        const authored = this._spawnDistrictDescriptor?.camera;
        if (!this.spawnDistrictDemo || !authored || typeof authored !== 'object') {
            return { distanceData: 6.0, heightData: 1.7, sideData: 0.6 };
        }
        const distanceData = Number(authored.distanceData);
        const heightData = Number(authored.heightData);
        const sideData = Number(authored.sideData);
        return {
            distanceData: Number.isFinite(distanceData) ? Math.max(1.0, Math.min(8.0, distanceData)) : 6.0,
            heightData: Number.isFinite(heightData) ? Math.max(-1.0, Math.min(2.0, heightData)) : 1.7,
            sideData: Number.isFinite(sideData) ? Math.max(-2.0, Math.min(2.0, sideData)) : 0.6,
        };
    }

    _isInTerrainXY(x, y) {
        const b = this.terrainRenderer?.terrainBounds;
        const s = this.terrainRenderer?.terrainSize;
        if (!b || !s) return true; // if unknown, don't block
        const minX = b[0], minY = b[1];
        const maxX = b[0] + s[0], maxY = b[1] + s[1];
        return x >= minX && x <= maxX && y >= minY && y <= maxY;
    }

    _getSpawnDistrictDemoGroundZAtXY(x, y) {
        if (!this.spawnDistrictDemo) return null;
        const nx = Number(x);
        const ny = Number(y);
        if (![nx, ny].every(Number.isFinite)) return null;
        const b = this.spawnDistrictBounds;
        if (b && (nx < b.minX || nx > b.maxX || ny < b.minY || ny > b.maxY)) return null;

        const desc = this._spawnDistrictDescriptor || {};
        const sp = desc.spawn;
        const spawnX = Number(sp?.x);
        const spawnY = Number(sp?.y);
        // A configured FiveM profile stores a ped root coordinate, not a terrain
        // sample. Never use it to pull arbitrary player positions onto a floor.
        const profileSpawn = sp?.source === 'configured_fivem_profile';
        const spawnGroundZ = profileSpawn ? NaN : Number(sp?.groundZ ?? sp?.z);
        if ([spawnX, spawnY, spawnGroundZ].every(Number.isFinite) && Math.hypot(nx - spawnX, ny - spawnY) <= 5.0) {
            return spawnGroundZ;
        }
        return null;
    }

    _chooseCitySpawn() {
        if (this.spawnDistrictDemo) {
            const sp = this._spawnDistrictDescriptor?.spawn;
            const x = Number(sp?.x);
            const y = Number(sp?.y);
            // FiveM persists the player root location. It is already the correct
            // street/interior elevation, so use it exactly once with the viewer's
            // eye-point convention. `groundZ` is accepted only for descriptors
            // written before this field was named correctly.
            const profileSpawn = sp?.source === 'configured_fivem_profile';
            const pedZ = Number(sp?.pedZ ?? (profileSpawn ? sp?.groundZ : NaN));
            if ([x, y, pedZ].every(Number.isFinite)) {
                return {
                    x,
                    y,
                    z: pedZ + this.pedEyeHeightData,
                    groundSource: 'runtime',
                    spawnKind: 'configured_fivem_profile',
                    spawnSource: String(sp?.source || 'assets/demo/spawn_district.json'),
                    spawnPedZ: pedZ,
                };
            }
            const groundZ = this._getSpawnDistrictDemoGroundZAtXY(x, y);
            if ([x, y, groundZ].every(Number.isFinite)) {
                return {
                    x,
                    y,
                    z: groundZ + this.pedEyeHeightData,
                    groundSource: 'demo',
                    spawnKind: 'configured_fivem_profile',
                    spawnSource: String(sp?.source || 'assets/demo/spawn_district.json'),
                    spawnGroundZ: groundZ,
                };
            }
        }

        // A handful of known “Los Santos-ish” coordinates in GTA data space.
        // We pick the first candidate that’s within terrain bounds and has a sane ground height.
        // Match the boot fallback when the live resolver is slow or unavailable.
        // The bundled snapshot is generated from the same FiveM profile and is a
        // better default than a generic terrain coordinate.
        const bundled = this._bundledRuntimeSpawn;
        const bundledPed = this._spawnObjToVector4(bundled?.spawn?.ped);
        if (bundledPed && this._isFiniteVec2(bundledPed) && Number.isFinite(Number(bundledPed[2]))) {
            return {
                x: Number(bundledPed[0]),
                y: Number(bundledPed[1]),
                z: Number(bundledPed[2]) + this.pedEyeHeightData,
                groundSource: 'runtime',
                spawnKind: String(bundled?.kind || 'bundled_runtime_snapshot'),
                spawnSource: 'assets/runtime_spawn.json',
                spawnPedZ: Number(bundledPed[2]),
            };
        }

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
            const b = this.spawnDistrictDemo ? this.spawnDistrictBounds : null;
            if (b && (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY)) continue;
            if (!this._isInTerrainXY(x, y)) continue;
            const floor = this.collisionWorld?.resolveGround?.(x, y, NaN, { preferInterior: false });
            if (floor?.source !== 'ybn' || !Number.isFinite(Number(floor.z))) continue;
            return { x, y, z: Number(floor.z) + this.pedEyeHeightData, groundSource: 'ybn' };
        }

        // Fallback: center of terrain bounds.
        const b = this.terrainRenderer?.terrainBounds || [0, 0, 0];
        const s = this.terrainRenderer?.terrainSize || [0, 0, 0];
        const constrained = this._clampDataPositionToSpawnDistrict([
            b[0] + (s[0] || 0) * 0.5,
            b[1] + (s[1] || 0) * 0.5,
            0.0,
        ]);
        const x = constrained[0];
        const y = constrained[1];
        return { x, y, z: this.pedEyeHeightData, groundSource: 'runtime' };
    }

    applyPedAndCameraFromConfig(pedV4, camV4, { preservePedZ = false } = {}) {
        if (!pedV4 || !camV4) return;

        // FiveM stores a ped root Z while YBN/interior collision describes floors.
        // heightmap.dat is deliberately excluded: it contains bounds envelopes.
        const constrainedPed = this._clampDataPositionToSpawnDistrict(pedV4);
        const x = Number(constrainedPed[0]);
        const y = Number(constrainedPed[1]);
        const desiredZ = Number(constrainedPed[2]);
        const terrainEnvelopeZ = this.terrainRenderer.getHeightAtXY?.(x, y);
        const demoGroundZ = this._getSpawnDistrictDemoGroundZAtXY(x, y);

        let baseZ = desiredZ;
        let usedGround = false;
        let usedDemoGround = false;
        let usedYbnGround = false;
        let usedInterior = false;
        let collisionGround = null;
        let interior = null;

        // The full viewer can use nearby drawable floor probes for MLOs. In
        // /demo, those visual meshes often overlap the street and YBN owns the
        // collision contract, so do not let a render-only floor move the spawn.
        if (!this.spawnDistrictDemo) {
            try {
                const zHint = Number.isFinite(desiredZ)
                    ? desiredZ
                    : 0.0;
                interior = this.drawableStreamer?.getInteriorFloorAtDataPos?.([x, y, zHint], {
                    zPadBelow: 14.0,
                    zPadAbove: 8.0,
                    maxRaise: this.groundPedMaxDelta,
                }) || null;
            } catch {
                interior = null;
            }
        }

        if (this.groundPedToTerrain) {
            try {
                collisionGround = this.collisionWorld?.resolveGround?.(x, y, desiredZ, {
                    maxSnapDistance: this.groundPedMaxDelta,
                }) || null;
            } catch {
                collisionGround = null;
            }
            const collisionZ = Number(collisionGround?.z);
            const collisionSource = String(collisionGround?.source || '');
            const isCollisionFloor = collisionSource === 'terrain' || collisionSource === 'ybn' || collisionSource === 'interior';
            const maxRuntimeGroundSnap = Math.max(
                0.5,
                Math.min(5.0, Number(this.runtimeSpawnGroundSnapMaxDelta) || 2.5),
            );
            if (!preservePedZ && !Number.isFinite(desiredZ) && isCollisionFloor && Number.isFinite(collisionZ)) {
                baseZ = collisionZ;
                usedYbnGround = collisionSource === 'ybn';
                usedGround = usedYbnGround;
                usedInterior = collisionSource === 'interior';
            } else if (
                !preservePedZ && collisionSource === 'terrain' && Number.isFinite(collisionZ)
            ) {
                baseZ = collisionZ;
                usedGround = true;
                usedYbnGround = false;
                usedInterior = false;
            } else if (
                preservePedZ && Number.isFinite(desiredZ) && isCollisionFloor &&
                Number.isFinite(collisionZ) &&
                (collisionSource === 'terrain' || Math.abs(collisionZ - desiredZ) <= maxRuntimeGroundSnap)
            ) {
                baseZ = collisionZ;
                usedYbnGround = collisionSource === 'ybn';
                usedGround = collisionSource === 'terrain' || usedYbnGround;
                usedInterior = collisionSource === 'interior';
                usedDemoGround = false;
            }
        }

        const blockConfiguredSnap = preservePedZ || !!(interior && interior.inRoom);
        if (!blockConfiguredSnap && Number.isFinite(demoGroundZ) && (!Number.isFinite(baseZ) || demoGroundZ > baseZ + 0.25)) {
            baseZ = demoGroundZ;
            usedDemoGround = true;
            usedGround = false;
            usedYbnGround = false;
        }

        // If interior floor is known and would raise us, snap up (prefer smallest raise).
        if (!this.spawnDistrictDemo && interior && Number.isFinite(interior.floorZ)) {
            if (!Number.isFinite(baseZ) || interior.floorZ > baseZ) {
                baseZ = interior.floorZ;
                usedInterior = true;
                usedGround = false;
                usedDemoGround = false;
                usedYbnGround = false;
            }
        }
        if (!Number.isFinite(baseZ)) baseZ = 0.0;

        const z = baseZ + this.pedEyeHeightData; // eye-height-ish offset
        const groundSource = usedInterior
            ? 'interior'
            : (usedYbnGround ? 'ybn' : (usedDemoGround ? 'demo' : (usedGround ? 'terrain' : 'runtime')));
        this.spawnPedAt([x, y, z], {
            groundSource,
        });
        this._pedGroundingDebug = {
            desiredZ,
            groundZ: Number.isFinite(baseZ) ? Number(baseZ) : null,
            terrainEnvelopeZ: Number.isFinite(terrainEnvelopeZ) ? terrainEnvelopeZ : null,
            demoGroundZ: Number.isFinite(demoGroundZ) ? demoGroundZ : null,
            ybnZ: Number.isFinite(Number(collisionGround?.ybnZ)) ? Number(collisionGround.ybnZ) : null,
            rawYbnZ: Number.isFinite(Number(collisionGround?.rawYbnZ)) ? Number(collisionGround.rawYbnZ) : null,
            ybnAlignmentOffset: Number.isFinite(Number(collisionGround?.ybnCalibrationOffset)) ? Number(collisionGround.ybnCalibrationOffset) : null,
            collisionGroundZ: Number.isFinite(Number(collisionGround?.z)) ? Number(collisionGround.z) : null,
            collisionGroundSource: collisionGround?.source || null,
            heightmapLoaded: !!this.terrainRenderer?.heightmapPixels,
            interiorFloorZ: (interior && Number.isFinite(interior.floorZ)) ? interior.floorZ : null,
            usedGround,
            usedDemoGround,
            usedYbnGround,
            usedInterior,
            groundSource: this._pedGroundSource,
            finalZ: z,
        };

        // Place camera at CamCoords and look at ped.
        const originalPedZ = Number.isFinite(desiredZ)
            ? desiredZ + this.pedEyeHeightData
            : z;
        const camZDelta = ((usedDemoGround || usedYbnGround) && Number.isFinite(originalPedZ)) ? (z - originalPedZ) : 0.0;
        const camData = [camV4[0], camV4[1], Number(camV4[2]) + camZDelta];
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
        const pedInputZ = Number.isFinite(Number(p.spawnPedZ)) ? Number(p.spawnPedZ) : p.z;
        if (pedInput) pedInput.value = `vector4(${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${pedInputZ.toFixed(4)}, 0.0)`;

        // Spawn ped first, then force a close 3rd-person rig in viewer-space.
        this.spawnPedAt([p.x, p.y, p.z], { groundSource: p.groundSource || null });
        // When the remote resolver is unavailable at boot, /demo falls back to the
        // descriptor generated from the FiveM profile. Keep the diagnostics explicit
        // so this does not read as an arbitrary local-coordinate fallback.
        if (p.spawnKind) {
            this._runtimeSpawnInfo = {
                kind: String(p.spawnKind),
                source: String(p.spawnSource || ''),
                ped: [p.x, p.y, Number.isFinite(Number(p.spawnPedZ)) ? Number(p.spawnPedZ) : (Number.isFinite(Number(p.spawnGroundZ)) ? Number(p.spawnGroundZ) : p.z), 0.0],
                diagnostics: { fallback: 'demo_descriptor' },
            };
        }
        this._setGtaThirdPersonRigForPed(this._getSpawnDistrictCameraRig());

        // Update the camCoords UI from the actual camera position (data-space).
        const camInput = document.getElementById('camCoords');
        if (camInput) {
            const camData = this._viewerPosToDataPos(this.camera.position);
            camInput.value = `vector4(${camData[0].toFixed(4)}, ${camData[1].toFixed(4)}, ${camData[2].toFixed(4)}, 0.0)`;
        }

        // Do not override scene toggles here. The user-selected checkboxes (or index.html defaults)
        // define whether we are in models-only vs debug modes.

        // IMPORTANT: don't auto-crank streaming on boot.
        // Large radii can trigger hundreds of chunk loads and make "first paint" feel like the viewer is hung.
        // Let the user opt-in via "Stream more (city)" or the preset dropdown.
    }

    respawnPlayerFromDeath() {
        const spawn = this._chooseCitySpawn();
        if (![spawn?.x, spawn?.y, spawn?.z].map(Number).every(Number.isFinite)) return false;

        this.spawnPedAt([Number(spawn.x), Number(spawn.y), Number(spawn.z)], {
            groundSource: spawn.groundSource || 'runtime',
        });
        this.showPlayer = true;
        this.player.enabled = true;
        this.player.handsUp = false;
        this.player.animPhase = 0.0;
        this.player.animMove01 = 0.0;
        this.player.animSpeed = 0.0;
        this.player.animGait = 'idle';
        this.player._sprintRequested = false;
        this.player._lastMoveDirData = [0.0, 0.0, 0.0];
        this.followPed = true;
        this.controlPed = true;
        this._followPedYSmoothed = null;
        this._resetPedMotion();
        for (const key of Object.keys(this.keyState || {})) this.keyState[key] = false;
        try { this.weaponController?.holsterImmediate?.(); } catch { /* ignore */ }
        try { this._setGtaThirdPersonRigForPed(this._getSpawnDistrictCameraRig()); } catch { /* ignore */ }
        try { this._applyPlayerRenderTargetsFromProfileOrUi(); } catch { /* ignore */ }
        try { this._syncPlayerEntityMesh(true); } catch { /* ignore */ }

        const showPlayerEl = document.getElementById('showPlayer');
        if (showPlayerEl) showPlayerEl.checked = true;
        const followEl = document.getElementById('followPed');
        if (followEl) followEl.checked = true;
        const controlEl = document.getElementById('controlPed');
        if (controlEl) controlEl.checked = true;
        return true;
    }

    /**
     * “Game-like” spawn: spawn a ped marker and immediately enable follow + WASD control,
     * with a GTA-ish 3rd-person camera rig.
     */
    async spawnCharacter({ toggle = true, waitForModel = true, snapshot = true, initModel = true } = {}) {
        // Toggle: if already spawned, clicking again exits back to map view.
        if (this.player?.enabled) {
            if (toggle) this.exitCharacterView();
            return;
        }

        // Snapshot the current map-view pose so we can toggle back later.
        if (snapshot) this._snapshotMapViewPose();

        // Ensure a ped exists first (and it already applies a 3rd-person-ish camera rig).
        this.spawnPedAtCity();

        if (initModel) {
            // Ensure model pipeline is ready so we can render a real player entity mesh.
            // (If this fails, we still keep the fallback wireframe character + camera controls working.)
            try {
                // The player has its own render pass, so enabling character view does not force world objects on.
                this.showPlayer = true;
                const showPlayerEl = document.getElementById('showPlayer');
                if (showPlayerEl) showPlayerEl.checked = true;
                this.playerWireframeMode = false;
                const playerTexturedEl = document.getElementById('playerTextured');
                if (playerTexturedEl) playerTexturedEl.checked = true;
                const initPromise = this.ensureModelsInitialized();
                if (waitForModel) await initPromise;
            } catch {
                // ignore
            }
        }
        this.player.enabled = true;
        this.player.lod = 'high';
        this.player.animPhase = 0.0;
        this.player.animMove01 = 0.0;
        this.player.animSpeed = 0.0;
        this.player.animGait = 'idle';
        this.player.handsUp = false;
        this._applyPlayerRenderTargetsFromProfileOrUi();

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
        this._setGtaThirdPersonRigForPed(this._getSpawnDistrictCameraRig());

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
        this._gpAimNeutralPitch = this._gpPitch;
    }

    _isFirstPersonGameplayCamera() {
        return this.gameplayCamEnabled
            && this.gameplayCameraMode === 'firstPerson'
            && !!this.followPed
            && !!this.ped;
    }

    _syncVehicleCameraViewControls() {
        const cockpit = this.gameplayCameraMode === 'firstPerson';
        const inVehicle = !!this.vehicleController?.inVehicle;
        const preference = document.getElementById('vehicleCameraMode');
        // On foot, preserve the selected vehicle preset instead of allowing the
        // regular on-foot camera mode to overwrite it before the next entry.
        const selectedCockpit = inVehicle
            ? cockpit
            : (preference ? String(preference.value).toLowerCase() === 'cockpit' : cockpit);
        if (preference && inVehicle) preference.value = cockpit ? 'cockpit' : 'chase';
        const cockpitButton = document.getElementById('vehicleCameraCockpit');
        const chaseButton = document.getElementById('vehicleCameraChase');
        if (cockpitButton) cockpitButton.setAttribute('aria-pressed', selectedCockpit ? 'true' : 'false');
        if (chaseButton) chaseButton.setAttribute('aria-pressed', selectedCockpit ? 'false' : 'true');
        const status = document.getElementById('vehicleCameraStatus');
        if (status) {
            status.textContent = inVehicle
                ? (cockpit
                    ? 'Cockpit: Assetto-style onboard anchor (56° FOV). Press V or choose Chase to switch.'
                    : 'Chase: vehicle-following third-person camera. Press V or choose Cockpit to switch.')
                : `${selectedCockpit ? 'Cockpit' : 'Chase'} selected. Enter a vehicle to use this view.`;
        }
    }

    _setVehicleCameraView(view) {
        const cockpit = String(view || '').toLowerCase() === 'cockpit';
        const preference = document.getElementById('vehicleCameraMode');
        if (preference) preference.value = cockpit ? 'cockpit' : 'chase';
        if (!this.vehicleController?.inVehicle || !this.vehicleController?.vehicle) {
            this._syncVehicleCameraViewControls();
            this._scheduleSaveSettings();
            return false;
        }

        // These match the local Assetto Corsa onboard defaults: a vehicle-aligned
        // driver anchor and 56 degree FOV. Chase remains a separate third-person
        // preset instead of inheriting the free-map camera pose.
        this.gameplayCamEnabled = true;
        this.followPed = true;
        const gameplayControl = document.getElementById('enableGameplayCamera');
        const followControl = document.getElementById('followPed');
        if (gameplayControl) gameplayControl.checked = true;
        if (followControl) followControl.checked = true;
        this._setGameplayCameraMode(cockpit ? 'firstPerson' : 'thirdPerson', { preserveView: false });

        const heading = Number(this.vehicleController.vehicle.headingRad) || 0.0;
        this._gpYaw = heading + (cockpit ? -Math.PI * 0.5 : Math.PI * 0.5);
        this._gpPitch = cockpit ? -0.0211265 : 0.18;
        this._gpAimNeutralPitch = this._gpPitch;
        if (!cockpit) this._gpDist = 10.5;
        this.camera.setFovDegrees?.(cockpit ? 56.0 : 60.0);
        this._followPedYSmoothed = null;
        this._updateGameplayCamera(1 / 60);
        this._syncVehicleCameraViewControls();
        this._scheduleSaveSettings();
        return true;
    }

    _applyPreferredVehicleCamera() {
        const preference = document.getElementById('vehicleCameraMode');
        return this._setVehicleCameraView(preference?.value || 'chase');
    }

    _setGameplayCameraMode(mode, { preserveView = true } = {}) {
        const next = String(mode || '').toLowerCase() === 'firstperson' ? 'firstPerson' : 'thirdPerson';
        if (next === this.gameplayCameraMode) return false;
        if (preserveView && this.camera?.direction) {
            const direction = this.camera.direction;
            const length = Math.hypot(Number(direction[0]) || 0, Number(direction[1]) || 0, Number(direction[2]) || 0) || 1.0;
            this._gpYaw = Math.atan2((Number(direction[0]) || 0) / length, (Number(direction[2]) || 0) / length);
            this._gpPitch = Math.max(-1.35, Math.min(1.35, Math.asin(Math.max(-1.0, Math.min(1.0, (Number(direction[1]) || 0) / length)))));
        }
        this.gameplayCameraMode = next;
        this._followPedYSmoothed = null;
        const control = document.getElementById('firstPersonCamera');
        if (control) control.checked = next === 'firstPerson';
        this._syncVehicleCameraViewControls();
        return true;
    }

    _toggleGameplayCameraMode() {
        if (this.vehicleController?.inVehicle) {
            return this._setVehicleCameraView(this.gameplayCameraMode === 'firstPerson' ? 'chase' : 'cockpit');
        }
        return this._setGameplayCameraMode(this.gameplayCameraMode === 'firstPerson' ? 'thirdPerson' : 'firstPerson');
    }

    _applyGameplayCameraInputDelta(deltaX, deltaY) {
        const sens = 0.0045;
        if (this._isFirstPersonGameplayCamera()) {
            this._gpYaw += deltaX * sens;
            this._gpPitch -= deltaY * sens;
            this._gpPitch = Math.max(-1.35, Math.min(1.35, this._gpPitch));
            return;
        }
        // This is an orbit camera: the gameplay aim ray points from the camera
        // back toward the ped. Its angular input must therefore be the inverse of
        // a first-person camera, otherwise right/up mouse motion aims left/down.
        this._gpYaw -= deltaX * sens;
        this._gpPitch += deltaY * sens;
        this._gpPitch = Math.max(-1.15, Math.min(1.15, this._gpPitch));
    }

    _applyGameplayCameraZoomDelta(wheelDeltaY) {
        if (this._isFirstPersonGameplayCamera()) return;
        // Exponential zoom so it feels stable across scales.
        const k = 0.0012;
        const s = Math.exp(Math.max(-0.25, Math.min(0.25, wheelDeltaY * k)));
        this._gpDist = Math.max(2.0, Math.min(20000.0, this._gpDist * s));
    }

    _updateGameplayCamera(dt) {
        if (!this.ped) return;
        if (this._isFirstPersonGameplayCamera()) {
            const vehicleAnchor = this.vehicleController?.inVehicle
                ? this.vehicleController?.getDriverCameraTransform?.()
                : null;
            const anchorData = Array.isArray(vehicleAnchor?.position)
                ? vehicleAnchor.position
                : this.ped.posData;
            const eyeView = this._dataToViewer(anchorData);
            const cosPitch = Math.cos(this._gpPitch);
            const forward = [
                Math.sin(this._gpYaw) * cosPitch,
                Math.sin(this._gpPitch),
                Math.cos(this._gpYaw) * cosPitch,
            ];
            // The tiny forward offset avoids a head/seat-boundary triangle without
            // moving the viewpoint outside the actual driver position.
            this.camera.position[0] = eyeView[0] + forward[0] * 0.025;
            this.camera.position[1] = eyeView[1] + forward[1] * 0.025;
            this.camera.position[2] = eyeView[2] + forward[2] * 0.025;
            this.camera.target[0] = this.camera.position[0] + forward[0] * 100.0;
            this.camera.target[1] = this.camera.position[1] + forward[1] * 100.0;
            this.camera.target[2] = this.camera.position[2] + forward[2] * 100.0;
            this.camera.updateViewMatrix();
            this.ped.posView = eyeView;
            this.ped.camOffset = [0.0, 0.0, 0.0];
            return;
        }
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

        // While aiming, make the center of the viewport the authoritative aim ray.
        // The normal follow camera looks down toward the player, which otherwise
        // leaves a center-screen reticle visibly offset from the shot direction.
        if (this.weaponController?.isAiming?.()) {
            const cameraData = this._viewerPosToDataPos(this.camera.position);
            const aimData = this._getGameplayAimDirectionData();
            const aimTargetView = this._dataToViewer([
                cameraData[0] + aimData[0] * 100.0,
                cameraData[1] + aimData[1] * 100.0,
                cameraData[2] + aimData[2] * 100.0,
            ]);
            this.camera.target[0] = aimTargetView[0];
            this.camera.target[1] = aimTargetView[1];
            this.camera.target[2] = aimTargetView[2];
        } else {
            this.camera.target[0] = pedView[0];
            this.camera.target[1] = pedView[1];
            this.camera.target[2] = pedView[2];
        }
        this.camera.updateViewMatrix();

        // Keep ped.camOffset in sync so other systems (save/restore, etc.) remain coherent.
        this.ped.camOffset = [
            this.camera.position[0] - pedView[0],
            this.camera.position[1] - pedView[1],
            this.camera.position[2] - pedView[2],
        ];
        this.ped.posView = pedView;
    }

    _resetPedMotion() {
        this._pedVelocityData = [0, 0, 0];
        this._pedVerticalVelocityData = 0.0;
        this._pedOnGround = true;
        this.playerController?.reset?.();
        if (this.player) {
            this.player._lastMoveDirData = [0, 0, 0];
            this.player._locomotionGait = 'idle';
            this.player._locomotionTransition = null;
            this.player.animMove01 = 0.0;
            this.player.animSpeed = 0.0;
            this.player.animGait = 'idle';
        }
    }

    _lerpAngleRad(a, b, t) {
        const twoPi = Math.PI * 2.0;
        let d = (b - a) % twoPi;
        if (d > Math.PI) d -= twoPi;
        if (d < -Math.PI) d += twoPi;
        return a + d * Math.max(0.0, Math.min(1.0, t));
    }

    _updateControlledPed(dt) {
        if (!this.ped) return;
        if (this.playerController?.update?.(dt)) return;
        const cfg = this.gameplayMoveConfig || {};
        const ks = this.keyState || {};

        const inputRight = (ks['d'] ? 1 : 0) - (ks['a'] ? 1 : 0);
        const inputForward = (ks['w'] ? 1 : 0) - (ks['s'] ? 1 : 0);
        const inputLen = Math.hypot(inputRight, inputForward);
        const hasInput = inputLen > 1e-5;

        let desiredVx = 0.0;
        let desiredVy = 0.0;
        if (hasInput) {
            const invInput = 1.0 / inputLen;

            const fwdView = glMatrix.vec3.fromValues(
                this.camera.direction[0],
                this.camera.direction[1],
                this.camera.direction[2],
            );
            fwdView[1] = 0.0;
            if (glMatrix.vec3.length(fwdView) < 1e-5) fwdView[2] = -1.0;
            glMatrix.vec3.normalize(fwdView, fwdView);

            const rightView = glMatrix.vec3.create();
            glMatrix.vec3.cross(rightView, fwdView, this.camera.up);
            glMatrix.vec3.normalize(rightView, rightView);

            const fwdData = this._viewerDirToDataDir(fwdView);
            const rightData = this._viewerDirToDataDir(rightView);
            const fx = Number(fwdData[0]) || 0.0;
            const fy = Number(fwdData[1]) || 0.0;
            const rx = Number(rightData[0]) || 0.0;
            const ry = Number(rightData[1]) || 0.0;

            let dx = (inputRight * invInput) * rx + (inputForward * invInput) * fx;
            let dy = (inputRight * invInput) * ry + (inputForward * invInput) * fy;
            const dLen = Math.hypot(dx, dy) || 1.0;
            dx /= dLen;
            dy /= dLen;

            const slow = !!(ks['control'] || ks['ctrl'] || ks['alt']);
            const sprint = !!ks['shift'] && inputForward > 0.15 && !slow;
            const speed = slow
                ? (Number(cfg.walkSpeed) || 1.7)
                : (sprint ? (Number(cfg.sprintSpeed) || 7.4) : (Number(cfg.runSpeed) || 4.6));
            desiredVx = dx * speed;
            desiredVy = dy * speed;

            const turnA = 1.0 - Math.exp(-(Number(cfg.turnSharpness) || 14.0) * dt);
            if (this.player) {
                const targetHeading = Math.atan2(dy, dx);
                this.player.headingRad = this._lerpAngleRad(Number(this.player.headingRad) || targetHeading, targetHeading, turnA);
                this.player._lastMoveDirData = [dx, dy, 0.0];
            }
        } else if (this.player) {
            this.player._lastMoveDirData = [0, 0, 0];
        }

        const vel = this._pedVelocityData || [0, 0, 0];
        const accelBase = hasInput
            ? (Number(cfg.acceleration) || 11.0)
            : (Number(cfg.braking) || 14.0);
        const accel = (hasInput && !!ks['shift'])
            ? (Number(cfg.sprintAcceleration) || accelBase)
            : accelBase;
        const a = 1.0 - Math.exp(-Math.max(0.1, accel) * dt);
        vel[0] = vel[0] * (1 - a) + desiredVx * a;
        vel[1] = vel[1] * (1 - a) + desiredVy * a;
        if (!hasInput && Math.hypot(vel[0], vel[1]) < 0.02) {
            vel[0] = 0.0;
            vel[1] = 0.0;
        }

        const oldX = this.ped.posData[0];
        const oldY = this.ped.posData[1];
        const eye = Number(this.pedEyeHeightData) || 0.0;
        const oldFeetZ = this.ped.posData[2] - eye;
        const oldFloor = this.collisionWorld?.resolveGround?.(oldX, oldY, oldFeetZ, { preferInterior: true });
        const oldGroundZ = (oldFloor?.source === 'ybn' || oldFloor?.source === 'interior')
            ? Number(oldFloor.z)
            : null;
        let newX = oldX + vel[0] * dt;
        let newY = oldY + vel[1] * dt;
        const newFloor = this.collisionWorld?.resolveGround?.(newX, newY, oldFeetZ, { preferInterior: true });
        let newGroundZ = (newFloor?.source === 'ybn' || newFloor?.source === 'interior')
            ? Number(newFloor.z)
            : null;

        const maxStepUp = Number(cfg.maxStepUp) || 1.15;
        if (
            this._pedOnGround &&
            Number.isFinite(oldGroundZ) &&
            Number.isFinite(newGroundZ) &&
            newGroundZ - oldGroundZ > maxStepUp
        ) {
            newX = oldX;
            newY = oldY;
            newGroundZ = oldGroundZ;
            vel[0] *= 0.15;
            vel[1] *= 0.15;
        }

        let feetZ = oldFeetZ;
        const jumpPressed = !!(ks[' '] || ks['space'] || ks['spacebar']);
        if (jumpPressed && this._pedOnGround) {
            this._pedVerticalVelocityData = Number(cfg.jumpSpeed) || 6.2;
            this._pedOnGround = false;
        }

        if (!this._pedOnGround) {
            this._pedVerticalVelocityData -= (Number(cfg.gravity) || 22.0) * dt;
            feetZ += this._pedVerticalVelocityData * dt;
        }

        if (Number.isFinite(newGroundZ)) {
            const pad = Number(cfg.groundProbePad) || 0.08;
            if (this._pedOnGround || feetZ <= newGroundZ + pad) {
                feetZ = newGroundZ;
                this._pedVerticalVelocityData = 0.0;
                this._pedOnGround = true;
            }
        }

        this._pedVelocityData = vel;
        this.ped.posData[0] = newX;
        this.ped.posData[1] = newY;
        this.ped.posData[2] = feetZ + eye;
        this.ped.posView = this._dataToViewer(this.ped.posData);
        if (this.pedRenderer?.setPosition) this.pedRenderer.setPosition(this.ped.posData);
        else this.pedRenderer?.setPositions?.([this.ped.posData]);
    }

    _updatePlayerAnimationState(dt) {
        if (!this.player?.enabled || !this.ped) return;
        const phonePose = this.phoneController?.update?.(dt) || null;
        if (phonePose?.active) {
            this.player.animPhase = Number(phonePose.phase) || 0.0;
            this.player.animMove01 = 0.0;
            this.player.animSpeed = 0.0;
            this.player.animGait = 'idle';
            return;
        }
        const vel = this._pedVelocityData || [0, 0, 0];
        const speed = Math.hypot(Number(vel[0]) || 0, Number(vel[1]) || 0);
        if (this.emotePalette?.active) {
            if (this.emotePalette.update(dt, speed >= 0.08)) {
                this.player.animMove01 = 0.0;
                this.player.animSpeed = 0.0;
                this.player.animGait = 'idle';
                return;
            }
        }
        const sprintSpeed = Number(this.gameplayMoveConfig?.sprintSpeed) || 7.4;
        const walkSpeed = Number(this.gameplayMoveConfig?.walkSpeed) || 1.7;
        const runSpeed = Number(this.gameplayMoveConfig?.runSpeed) || 4.6;
        const requestedGait = String(this.player._locomotionGait || '').toLowerCase();
        const configuredReferenceSpeed = requestedGait === 'walk'
            ? walkSpeed
            : (requestedGait === 'sprint' ? sprintSpeed : runSpeed);
        const nativeReferenceSpeed = Number(this.player._locomotionReferenceSpeed);
        const referenceSpeed = Number.isFinite(nativeReferenceSpeed) && nativeReferenceSpeed > 0.08
            ? nativeReferenceSpeed
            : configuredReferenceSpeed;
        const target01 = Math.max(0.0, Math.min(1.0, speed / Math.max(0.1, referenceSpeed)));
        const a = 1.0 - Math.exp(-8.0 * Math.max(0.001, dt));
        this.player.animMove01 = (Number(this.player.animMove01) || 0.0) * (1 - a) + target01 * a;
        this.player.animSpeed = speed;
        if (speed < 0.08) {
            this.player.animGait = 'idle';
        } else if (requestedGait === 'walk') {
            this.player.animGait = 'walk';
        } else if (requestedGait === 'sprint' || this.player._sprintRequested) {
            this.player.animGait = 'sprint';
        } else {
            this.player.animGait = 'run';
        }

        // Play each exported GTA YCD clip at its stored native duration. The
        // palette source is authoritative here: a later animation export must not
        // leave the controller running against a stale hand-written duration.
        const gaitCycle = this.player.animGait === 'walk'
            ? { referenceSpeed: walkSpeed, fallbackDuration: 3.6666667 }
            : (this.player.animGait === 'sprint'
                ? { referenceSpeed: sprintSpeed, fallbackDuration: 1.0666667 }
                : { referenceSpeed: runSpeed, fallbackDuration: 2.6333334 });
        gaitCycle.referenceSpeed = referenceSpeed;
        if (speed >= 0.08 && this.player.animMove01 > 0.01) {
            const nativeDuration = Number(this.playerModelRenderer?.getSkinningAnimationClipDuration?.(this.player.animGait));
            const clipDuration = Number.isFinite(nativeDuration) && nativeDuration > 0.0
                ? nativeDuration
                : gaitCycle.fallbackDuration;
            const speedScale = Math.min(1.35, speed / Math.max(0.1, gaitCycle.referenceSpeed));
            const phaseRate = (Math.PI * 2.0 / clipDuration) * speedScale;
            this.player.animPhase = (Number(this.player.animPhase) || 0.0) + phaseRate * dt;
        }
    }

    _syncWeaponUi() {
        const status = this.weaponController?.getStatus?.();
        if (!status) return;
        const stateLabel = status.phase === 'equipped'
            ? (status.automatic ? 'AUTO' : 'SEMI')
            : String(status.phase || 'holstered').toUpperCase();
        const key = [status.id, stateLabel, status.preparing, status.aiming, status.magazineAmmo, status.reserveAmmo, status.switchItems, status.switchInstalled].join('|');
        if (key === this._weaponUiKey) return;
        this._weaponUiKey = key;
        const hud = document.getElementById('weaponHud');
        const hudState = document.getElementById('weaponHudState');
        const hudAmmo = document.getElementById('weaponHudAmmo');
        const crosshair = document.getElementById('combatCrosshair');
        if (hud) hud.hidden = false;
        if (hudState) hudState.textContent = `${status.label} ${stateLabel}`;
        if (hudAmmo) hudAmmo.textContent = `${status.magazineAmmo} / ${status.reserveAmmo}`;
        if (crosshair) crosshair.hidden = status.phase !== 'equipped' || !status.aiming;
        const toggle = document.getElementById('weaponToggle');
        if (toggle) {
            toggle.textContent = status.preparing
                ? 'Preparing weapon...'
                : status.phase === 'equipped'
                ? `Holster ${status.label}`
                : (status.phase === 'drawing' ? 'Drawing...' : (status.phase === 'holstering' ? 'Holstering...' : `Draw ${status.label}`));
            toggle.disabled = status.preparing || status.phase === 'drawing' || status.phase === 'holstering' || status.phase === 'reloading';
        }
        const reload = document.getElementById('weaponReload');
        if (reload) reload.disabled = status.phase !== 'equipped' || status.magazineAmmo >= status.magazineCapacity || status.reserveAmmo <= 0;
        const install = document.getElementById('weaponSwitch');
        if (install) {
            install.disabled = status.phase !== 'equipped' || status.switchInstalled || status.switchItems <= 0;
            install.textContent = status.switchInstalled ? 'Glock switch installed' : 'Install Glock switch';
        }
        this._syncWeaponInventory();
    }

    _syncMeleeUi() {
        const status = this.meleeController?.getStatus?.();
        const hud = document.getElementById('meleeHud');
        if (!status || !hud) return;
        hud.dataset.combatState = status.attacking ? 'attacking' : (status.guarding ? 'guarding' : 'idle');
        hud.dataset.combo = String(status.combo || 0);
        hud.dataset.target = String(status.target?.id || '');
        hud.dataset.renderCombatState = String(this.playerModelRenderer?.characterLocomotion?.combat?.phase || '');
        hud.dataset.skinPoseVersion = String(this.playerModelRenderer?._skinPoseVersion || 0);
        hud.dataset.renderClip = String(this.playerModelRenderer?.characterLocomotion?.combat?.clip || '');
        hud.dataset.meleeAnimations = this._meleeAnimationsLoaded ? 'loaded' : (this._meleeAnimationsUnavailable ? 'unavailable' : 'loading');
        hud.dataset.lifeState = String(status.lifeState || 'alive');
        hud.hidden = !this.spawnDistrictDemo;
        const healthPct = Math.max(0, Math.min(100, (status.health / Math.max(1, status.maxHealth)) * 100));
        const playerFill = document.getElementById('meleePlayerHealth');
        const playerText = document.getElementById('meleePlayerHealthText');
        if (playerFill) playerFill.style.width = `${healthPct.toFixed(1)}%`;
        if (playerText) playerText.textContent = String(Math.round(status.health));
        const targetRow = document.getElementById('meleeTargetRow');
        const targetFill = document.getElementById('meleeTargetHealth');
        const targetText = document.getElementById('meleeTargetHealthText');
        if (targetRow) targetRow.hidden = !status.target;
        if (status.target) {
            const targetPct = Math.max(0, Math.min(100, (status.target.health / Math.max(1, status.target.maxHealth)) * 100));
            if (targetFill) targetFill.style.width = `${targetPct.toFixed(1)}%`;
            if (targetText) targetText.textContent = String(Math.round(status.target.health));
        }
        const deathOverlay = document.getElementById('deathOverlay');
        const deathCountdown = document.getElementById('deathCountdown');
        const dead = status.lifeState === 'dead';
        if (dead !== !!this._deathUiActive) {
            this._deathUiActive = dead;
            this._weaponUiKey = '';
        }
        if (deathOverlay) deathOverlay.hidden = !dead;
        document.body.classList.toggle('player-dead', dead);
        const crosshair = document.getElementById('combatCrosshair');
        const weaponHud = document.getElementById('weaponHud');
        if (dead && crosshair) crosshair.hidden = true;
        if (weaponHud) weaponHud.hidden = dead;
        if (deathCountdown) {
            deathCountdown.textContent = `RESPAWNING IN ${Math.max(0, Math.ceil(Number(status.respawnRemaining) || 0))}`;
        }
    }

    _syncWeaponInventory() {
        this.inventoryOverlay?.sync?.();
    }

    _toggleWeaponInventory(forceOpen = null) {
        return this.inventoryOverlay?.toggle?.(forceOpen) || false;
    }

    _getPlayerAnimationForRender() {
        if (!this.player?.enabled) return null;
        const seated = !!this.vehicleController?.inVehicle;
        const handsUp = !!this.player.handsUp && !this.vehicleController?.inVehicle;
        const phone = (!seated && !handsUp) ? this.phoneController?.getCharacterPose?.() : null;
        const emote = (!seated && !handsUp && !phone?.active) ? this.emotePalette?.getActiveGesture?.() : null;
        const transition = (!seated && !handsUp && !phone?.active && !emote && !this.weaponController?.isVisible?.())
            ? (this.player._locomotionTransition?.active ? this.player._locomotionTransition : null)
            : null;
        return {
            phase: Number(this.player.animPhase) || 0.0,
            move01: Number(this.player.animMove01) || 0.0,
            speed: Number(this.player.animSpeed) || 0.0,
            gait: (handsUp || seated || phone?.active) ? 'idle' : String(this.player.animGait || 'idle'),
            onGround: !!this._pedOnGround,
            gesture: seated
                ? { active: true, clip: 'sit' }
                : (handsUp ? { active: true, clip: 'handsup_base' } : (phone?.active ? phone : emote)),
            combat: (handsUp || seated || phone?.active || emote) ? null : (this.weaponController?.isVisible?.()
                ? (this.weaponController?.getCharacterPose?.() || null)
                : (this.meleeController?.getCharacterPose?.() || null)),
            transition,
        };
    }

    _syncPlayerEntityMesh(forceFullInit = false) {
        if (!this.player?.enabled || !this.ped) return;
        if (!this.showPlayer) return;
        if (!this.modelsInitialized) return;
        if (!this.playerModelRenderer?.ready) {
            void this._ensurePlayerModelRenderer().then((ok) => {
                if (ok) this._syncPlayerEntityMesh(true);
            });
            return;
        }
        let hashes = Array.isArray(this.player.hashes) ? this.player.hashes.map((h) => String(h || '').trim()).filter(Boolean) : [];
        if (!hashes.length && this.player.hash) hashes = [String(this.player.hash)];
        if (!hashes.length) return;

        // Appearance targets can be selected before the sharded model manifest is
        // initialized. Retry missing component metadata here so startup ordering
        // cannot leave a composite ped permanently stuck on its fallback marker.
        for (const h of hashes) {
            if (this.modelManager?.isShardLoadedForHash?.(h)) continue;
            try {
                const pending = this.modelManager?.prefetchMeta?.(h, { priority: 'high' });
                if (pending && typeof pending.then === 'function') {
                    void pending.then((ok) => {
                        if (ok) this._syncPlayerEntityMesh(true);
                    });
                }
            } catch {
                // The normal frame retry will try again after model initialization.
            }
        }

        // During aim the body follows the targeting direction; otherwise retain the
        // normal movement-driven heading used by third-person locomotion.
        const inVehicle = !!this.vehicleController?.inVehicle;
        const md = this.player._lastMoveDirData;
        const mv2 = Math.hypot(Number(md[0]) || 0, Number(md[1]) || 0);
        const combatPose = this.weaponController?.getCharacterPose?.() || null;
        let targetHeading = null;
        if (!inVehicle && combatPose?.aiming && this.camera?.direction && typeof this._viewerDirToDataDir === 'function') {
            const aimDirection = this._getGameplayAimDirectionData();
            const aimLength = Math.hypot(Number(aimDirection?.[0]) || 0.0, Number(aimDirection?.[1]) || 0.0);
            if (aimLength > 1e-4) targetHeading = Math.atan2(aimDirection[1], aimDirection[0]);
        }
        // PlayerController owns third-person body turns. Re-applying an input
        // vector lerp here bypasses its gait-specific turn gate and makes the
        // visual ped snap ahead of its collision trajectory. Aim remains
        // camera-driven below, and the fallback controller still has this path.
        if (!inVehicle && !this.playerController && targetHeading === null && mv2 > 1e-4) {
            targetHeading = Math.atan2(md[1], md[0]);
        }
        if (inVehicle && Number.isFinite(Number(this.vehicleController?.vehicle?.headingRad))) {
            this.player.headingRad = Number(this.vehicleController.vehicle.headingRad);
        }
        if (targetHeading !== null) {
            const dt = Number(this._lastUpdateDt) || (1 / 60);
            const turnA = 1.0 - Math.exp(-(Number(this.gameplayMoveConfig?.turnSharpness) || 14.0) * dt);
            this.player.headingRad = this._lerpAngleRad(Number(this.player.headingRad) || targetHeading, targetHeading, turnA);
        }

        // Build a data-space transform. Keep `headingRad` in gameplay space so
        // controls/camera remain unchanged; align the GTA drawable root axis here.
        const q = glMatrix.quat.create();
        const drawableHeading = (this.player.headingRad || 0.0) + PLAYER_DRAWABLE_FORWARD_OFFSET_RAD;
        glMatrix.quat.setAxisAngle(q, [0, 0, 1], drawableHeading);
        // `ped.posData` tracks the *eye* position for camera targeting. Freemode
        // component meshes use a bind-space root above the shoe sole, so placing
        // that root directly on the collision floor sinks the visible ped. The
        // guarded shoe/lower-body contact bound supplies only the render offset;
        // gameplay collision and the authoritative feet position stay unchanged.
        const seat = inVehicle ? this.vehicleController?.getDriverSeatTransform?.() : null;
        const px = seat?.position?.[0] ?? this.ped.posData[0];
        const py = seat?.position?.[1] ?? this.ped.posData[1];
        const feetZ = this.ped.posData[2] - (Number(this.pedEyeHeightData) || 0.0);
        // Seated roots are authored directly in the vehicle seat. They do not
        // use the standing shoe correction, so avoid a full component/status
        // scan every occupied frame.
        const meshFootLocalZ = seat ? 0.0 : this._getPlayerMeshFootLocalZData(this._getPlayerMeshStatus());
        // Driver-seat metadata is authored as the ped root position inside the
        // vehicle. The standing path compensates from eye height to shoe sole;
        // doing that again here lifts a seated ped out through the roof.
        const pz = seat?.position?.[2] ?? (feetZ - meshFootLocalZ);
        glMatrix.mat4.fromRotationTranslation(this.player._mat, q, [px, py, pz]);
        this.player._matBuf.set(this.player._mat);
        const playerPassMatrices = this._buildPlayerPassPedMatrices();

        const active = this.player._activeMeshKeys instanceof Set ? this.player._activeMeshKeys : new Set();
        if (!(this.player._activeMeshKeys instanceof Set)) this.player._activeMeshKeys = active;
        const desiredKeys = new Set(hashes.map((h) => `${h}:${String(this.player.lod || 'high').toLowerCase()}`));
        for (const oldKey of Array.from(active)) {
            if (desiredKeys.has(oldKey)) continue;
            const oldHash = String(oldKey).split(':')[0];
            if (oldHash) {
                try { void this.playerModelRenderer.setInstancesForArchetype(oldHash, this.player.lod, new Float32Array(0), 0.0); } catch { /* ignore */ }
            }
            active.delete(oldKey);
        }

        for (const h of hashes) {
            const key = `${h}:${String(this.player.lod || 'high').toLowerCase()}`;
            if (forceFullInit) {
                // Ensure instance entry exists and submeshes are discovered once.
                void this.playerModelRenderer.setInstancesForArchetype(h, this.player.lod, playerPassMatrices, -1.0, { loadPriority: 100 });
                active.add(key);
                continue;
            }

            // Fast path update each frame.
            const ok = this.playerModelRenderer.updateInstanceMatricesForArchetype(h, this.player.lod, playerPassMatrices, 0.0);
            if (!ok) {
                // Entry doesn't exist yet (first frame after spawn / async init); create it.
                void this.playerModelRenderer.setInstancesForArchetype(h, this.player.lod, playerPassMatrices, -1.0, { loadPriority: 100 });
            }
            active.add(key);
        }
    }

    _buildPlayerPassPedMatrices() {
        // This pass is strictly local-player data. Ambient NPCs use their own
        // renderer so their animation state cannot be driven by local keyboard
        // input or the local player's combat pose.
        const requiredFloats = 16;
        if (!(this._playerPassPedMatrices instanceof Float32Array) || this._playerPassPedMatrices.length !== requiredFloats) {
            this._playerPassPedMatrices = new Float32Array(requiredFloats);
        }
        const matrices = this._playerPassPedMatrices;
        matrices.set(this.player._mat, 0);
        this._playerPassAmbientNpcCount = 0;
        return matrices;
    }

    _clearWeaponModelMesh() {
        const key = String(this._weaponModelActiveKey || '');
        const renderer = this.weaponModelRenderer;
        if (key && renderer?.ready && renderer.setInstancesForArchetype) {
            const [hash, lod = 'high'] = key.split(':');
            if (hash) {
                try { void renderer.setInstancesForArchetype(hash, lod, new Float32Array(0), 0.0); } catch { /* ignore */ }
            }
        }
        this._weaponModelActiveKey = null;
        this._weaponModelMeshReady = false;
    }

    _getWeaponRightHandMatrix(out = this._weaponHandDataMat) {
        if (!this.player?._mat || !this.playerModelRenderer?.getSkinningBoneTransform) return null;
        // GTA weapon attachments use the visible hand bone. PH_R_Hand is a
        // physics helper whose independent animated basis makes a rigid prop
        // drift from the rendered fingers in the pistol clips.
        const handLocal = this.playerModelRenderer.getSkinningBoneTransform('SKEL_R_Hand', this._weaponHandBoneMat)
            || this.playerModelRenderer.getSkinningBoneTransform('IK_R_Hand', this._weaponHandBoneMat)
            || this.playerModelRenderer.getSkinningBoneTransform('PH_R_Hand', this._weaponHandBoneMat);
        if (!handLocal) return null;
        glMatrix.mat4.multiply(out, this.player._mat, handLocal);
        return out;
    }

    _getPhoneHandMatrix(hand = 'right', out = this._phoneHandDataMat) {
        if (!this.player?._mat || !this.playerModelRenderer?.getSkinningBoneTransform) return null;
        const left = hand === 'left';
        const handLocal = left
            ? (this.playerModelRenderer.getSkinningBoneTransform('SKEL_L_Hand', this._phoneHandBoneMat)
                || this.playerModelRenderer.getSkinningBoneTransform('IK_L_Hand', this._phoneHandBoneMat)
                || this.playerModelRenderer.getSkinningBoneTransform('PH_L_Hand', this._phoneHandBoneMat))
            : (this.playerModelRenderer.getSkinningBoneTransform('SKEL_R_Hand', this._phoneHandBoneMat)
                || this.playerModelRenderer.getSkinningBoneTransform('IK_R_Hand', this._phoneHandBoneMat)
                || this.playerModelRenderer.getSkinningBoneTransform('PH_R_Hand', this._phoneHandBoneMat));
        if (!handLocal) return null;
        glMatrix.mat4.multiply(out, this.player._mat, handLocal);
        return out;
    }

    _getWeaponRightHandPose() {
        const hand = this._getWeaponRightHandMatrix();
        if (!hand) return null;
        const grip = this._weaponGripDataMat;
        glMatrix.mat4.multiply(grip, hand, GLOCK_RIGHT_HAND_ATTACHMENT_TRANSFORM);
        const normalize = (x, y, z) => {
            const length = Math.hypot(x, y, z) || 1.0;
            return [x / length, y / length, z / length];
        };
        return {
            hand: [grip[12], grip[13], grip[14]],
            forward: normalize(grip[0], grip[1], grip[2]),
            right: normalize(grip[4], grip[5], grip[6]),
            up: normalize(grip[8], grip[9], grip[10]),
        };
    }

    _alignWeaponBarrelToAim(modelMatrix, aimDirection, gripPoint = null) {
        if (!modelMatrix || !Array.isArray(aimDirection)) return false;
        const tx = Number(aimDirection[0]) || 0.0;
        const ty = Number(aimDirection[1]) || 0.0;
        const tz = Number(aimDirection[2]) || 0.0;
        const targetLength = Math.hypot(tx, ty, tz);
        if (targetLength < 1e-5) return false;

        const fx = Number(modelMatrix[0]) || 0.0;
        const fy = Number(modelMatrix[1]) || 0.0;
        const fz = Number(modelMatrix[2]) || 0.0;
        const forwardLength = Math.hypot(fx, fy, fz);
        if (forwardLength < 1e-5) return false;

        const forward = [fx / forwardLength, fy / forwardLength, fz / forwardLength];
        const target = [tx / targetLength, ty / targetLength, tz / targetLength];
        const dot = Math.max(-1.0, Math.min(1.0, forward[0] * target[0] + forward[1] * target[1] + forward[2] * target[2]));
        const angle = Math.acos(dot);
        if (angle < 0.0005) return false;

        const correction = this._weaponAdsCorrectionQuat;
        glMatrix.quat.rotationTo(correction, forward, target);
        if (angle > GLOCK_ADS_MAX_BARREL_CORRECTION_RAD) {
            glMatrix.quat.slerp(correction, this._weaponAdsIdentityQuat, correction, GLOCK_ADS_MAX_BARREL_CORRECTION_RAD / angle);
        }

        // Rotate around the already-mounted grip, not the wrist bone. The latter
        // has a distinct origin and pulled the pistol visibly out of the hand.
        const pivot = Array.isArray(gripPoint) && gripPoint.length >= 3
            ? [Number(gripPoint[0]) || 0.0, Number(gripPoint[1]) || 0.0, Number(gripPoint[2]) || 0.0]
            : [Number(modelMatrix[12]) || 0.0, Number(modelMatrix[13]) || 0.0, Number(modelMatrix[14]) || 0.0];
        const rotation = this._weaponAdsRotationMat;
        const aroundHand = this._weaponAdsCorrectionMat;
        glMatrix.mat4.fromQuat(rotation, correction);
        glMatrix.mat4.identity(aroundHand);
        glMatrix.mat4.translate(aroundHand, aroundHand, pivot);
        glMatrix.mat4.multiply(aroundHand, aroundHand, rotation);
        glMatrix.mat4.translate(aroundHand, aroundHand, [-pivot[0], -pivot[1], -pivot[2]]);
        glMatrix.mat4.multiply(modelMatrix, aroundHand, modelMatrix);
        return true;
    }

    _syncWeaponModelMesh(forceFullInit = false) {
        const visible = !!this.showPlayer && !!this.ped && !this.vehicleController?.inVehicle && !!this.weaponController?.isVisible?.();
        if (!visible) {
            // Keep the holstered weapon resident; the render pass is visibility-gated.
            this._refreshWeaponModelResidency();
            return;
        }
        if (!this.modelsInitialized) return;
        if (!this.weaponModelRenderer?.ready || !this.weaponModelAsset?.hash) {
            void this._precacheWeaponModel().then((ok) => {
                if (ok) this._syncWeaponModelMesh(false);
            });
            return;
        }

        const pose = this.weaponController?.getWeaponPoseData?.();
        if (!pose?.hand || !Array.isArray(pose.direction) || !Array.isArray(pose.right)) return;
        const hash = String(this.weaponModelAsset.hash);
        const lod = String(this.weaponModelAsset.lod || 'high').toLowerCase();
        const key = `${hash}:${lod}`;
        // The exported YDR bounds are already in GTA metres (a 20 cm pistol),
        // so rescaling it oversized the grip and made its hand offset obvious.
        const scale = 1.0;
        const weaponRenderState = this.weaponController?.getRenderState?.() || null;
        const recoil = Math.max(0.0, Math.min(1.0, Number(weaponRenderState?.recoil01) || 0.0));
        const hand = this._getWeaponRightHandMatrix();
        if (hand) {
            // Reconstruct the same current hand pose that skinned the ped this
            // frame, apply the weapon's authored axes, then move the exported
            // grip point onto the palm. GTA weapon origins are not grip anchors.
            glMatrix.mat4.multiply(this._weaponModelMat, hand, GLOCK_RIGHT_HAND_ATTACHMENT_TRANSFORM);
            glMatrix.mat4.translate(this._weaponModelMat, this._weaponModelMat, [
                -GLOCK_GRIP_ANCHOR_LOCAL[0],
                -GLOCK_GRIP_ANCHOR_LOCAL[1],
                -GLOCK_GRIP_ANCHOR_LOCAL[2],
            ]);
            this._weaponModelMat[12] -= this._weaponModelMat[0] * recoil * 0.018;
            this._weaponModelMat[13] -= this._weaponModelMat[1] * recoil * 0.018;
            this._weaponModelMat[14] -= this._weaponModelMat[2] * recoil * 0.018;
            if (pose.aiming) this._alignWeaponBarrelToAim(this._weaponModelMat, pose.direction, pose.hand);
            glMatrix.mat4.scale(this._weaponModelMat, this._weaponModelMat, [scale, scale, scale]);
        } else {
            // Static/unskinned fallback for profiles that do not expose SKEL_R_Hand.
            const forward = pose.direction;
            const side = [-pose.right[0], -pose.right[1], -pose.right[2]];
            const tx = Number(pose.hand[0]) + Number(forward[0]) * (0.04 - recoil * 0.025);
            const ty = Number(pose.hand[1]) + Number(forward[1]) * (0.04 - recoil * 0.025);
            const tz = Number(pose.hand[2]) + 0.065;
            glMatrix.mat4.set(this._weaponModelMat,
                Number(forward[0]) * scale, Number(forward[1]) * scale, Number(forward[2]) * scale, 0.0,
                Number(side[0]) * scale, Number(side[1]) * scale, Number(side[2]) * scale, 0.0,
                0.0, 0.0, scale, 0.0,
                tx, ty, tz, 1.0);
        }
        this._weaponModelMatBuf.set(this._weaponModelMat);

        if (this._weaponModelActiveKey && this._weaponModelActiveKey !== key) this._clearWeaponModelMesh();
        const updated = !forceFullInit && this.weaponModelRenderer.updateInstanceMatricesForArchetype(
            hash,
            lod,
            this._weaponModelMatBuf,
            0.0,
        );
        if (!updated) {
            void this.weaponModelRenderer.setInstancesForArchetype(
                hash,
                lod,
                this._weaponModelMatBuf,
                -1.0,
                { loadPriority: 125 },
            );
        }
        this._weaponModelActiveKey = key;

        this._refreshWeaponModelResidency();
    }

    _clearPhoneModelMesh() {
        const key = String(this._phoneModelActiveKey || '');
        const renderer = this.phoneModelRenderer;
        if (key && renderer?.ready && renderer.setInstancesForArchetype) {
            const [hash, lod = 'high'] = key.split(':');
            if (hash) {
                try { void renderer.setInstancesForArchetype(hash, lod, new Float32Array(0), 0.0); } catch { /* ignore */ }
            }
        }
        this._phoneModelActiveKey = null;
        this._phoneModelMeshReady = false;
    }

    _syncPhoneModelMesh(forceFullInit = false) {
        const pose = this.phoneController?.getCharacterPose?.() || null;
        const visible = !!this.showPlayer && !!this.ped && !this.vehicleController?.inVehicle && !!pose?.active;
        if (!visible) {
            this._refreshPhoneModelResidency();
            return;
        }
        if (!this.modelsInitialized) return;
        if (!this.phoneModelRenderer?.ready || !this.phoneModelAsset?.hash) {
            void this._precachePhoneModel().then((ok) => {
                if (ok) this._syncPhoneModelMesh(false);
            });
            return;
        }

        const hash = String(this.phoneModelAsset.hash);
        const lod = String(this.phoneModelAsset.lod || 'high').toLowerCase();
        const key = `${hash}:${lod}`;
        // RPEmotes attaches prop_phone_ing at zero local offset from hand bone
        // 28422/60309. Use the same authored contract rather than tuning an
        // arbitrary browser offset around individual clips.
        const hand = this._getPhoneHandMatrix(pose.hand);
        if (!hand) return;
        this._phoneModelMat.set(hand);
        this._phoneModelMatBuf.set(this._phoneModelMat);

        if (this._phoneModelActiveKey && this._phoneModelActiveKey !== key) this._clearPhoneModelMesh();
        const updated = !forceFullInit && this.phoneModelRenderer.updateInstanceMatricesForArchetype(
            hash,
            lod,
            this._phoneModelMatBuf,
            0.0,
        );
        if (!updated) {
            void this.phoneModelRenderer.setInstancesForArchetype(
                hash,
                lod,
                this._phoneModelMatBuf,
                -1.0,
                { loadPriority: 125, allowPlaceholderMesh: false },
            );
        }
        this._phoneModelActiveKey = key;
        this._refreshPhoneModelResidency();
    }

    _clearVehicleModelMesh() {
        if (this._vehicleModelActiveKey && this.vehicleModelRenderer?.setInstancesForArchetype) {
            const [hash, lod] = this._vehicleModelActiveKey.split(':', 2);
            try { void this.vehicleModelRenderer.setInstancesForArchetype(hash, lod || 'high', null); } catch { /* ignore */ }
        }
        this._vehicleModelActiveKey = null;
        this._vehicleModelMeshReady = false;
        this._vehicleModelMeshStatus = null;
        this._vehicleModelStatusKey = '';
        this._vehicleModelStatusNextMs = 0;
    }

    _vehicleSubmeshIsChassisAnchor(submesh) {
        const fragmentTag = submesh?.fragmentBoneTag;
        if (!submesh || (fragmentTag !== null && fragmentTag !== undefined && fragmentTag !== '' && Number.isFinite(Number(fragmentTag)))) return false;
        const material = submesh.material || {};
        const shaderName = String(material.shaderName || '').toLowerCase();
        const bounds = submesh.bounds || {};
        const min = bounds.min;
        const max = bounds.max;
        const span = Array.isArray(min) && Array.isArray(max) && min.length >= 3 && max.length >= 3
            ? Math.max(
                Math.abs(Number(max[0]) - Number(min[0])) || 0,
                Math.abs(Number(max[1]) - Number(min[1])) || 0,
                Math.abs(Number(max[2]) - Number(min[2])) || 0,
            )
            : 0;
        const radius = Number(submesh.radius) || 0;
        return radius >= 1.0 || span >= 1.6 || /vehicle_(?:paint|mesh)|chassis|body/.test(shaderName);
    }

    _markVehicleChassisLoadPriority(hash, lod = 'high') {
        const h = this.modelManager?.normalizeId?.(String(hash)) || String(hash);
        const lodEntry = this.modelManager?.manifest?.meshes?.[h]?.lods?.[String(lod).toLowerCase()];
        const submeshes = Array.isArray(lodEntry?.submeshes) ? lodEntry.submeshes : [];
        for (const submesh of submeshes) {
            if (!submesh || !this._vehicleSubmeshIsChassisAnchor(submesh)) continue;
            // This is runtime-only metadata on the installed custom manifest.
            // It lets the generic renderer keep its normal queueing behavior for
            // city assets while bringing a recognizable vehicle body in first.
            submesh.loadPriority = Math.max(Number(submesh.loadPriority) || 0, 80);
        }
    }

    _syncVehicleModelMesh(forceFullInit = false) {
        const state = this.vehicleController?.getRenderState?.();
        if (!state?.hash || !Array.isArray(state.position)) {
            this._clearVehicleModelMesh();
            return;
        }
        if (!this.modelsInitialized) return;
        const hash = String(state.hash);
        const lod = 'high';
        const key = `${hash}:${lod}`;
        const modelChanged = this._vehicleModelActiveKey !== key;
        if (this._vehicleModelActiveKey && modelChanged) this._clearVehicleModelMesh();
        const customManifest = String(state.assetManifest || '').trim();
        const manifestKey = `${hash}:${customManifest}`;
        if (customManifest && !this._vehicleManifestReadyKeys.has(manifestKey)) {
            void this._ensureVehicleModelDefinition(state).then((ok) => {
                const current = this.vehicleController?.getRenderState?.();
                if (ok && String(current?.hash || '') === hash) this._syncVehicleModelMesh(true);
            });
            return;
        }
        if (!this.vehicleModelRenderer?.ready) {
            void this._ensureVehicleModelRenderer().then((ok) => {
                if (ok) this._syncVehicleModelMesh(true);
            });
            return;
        }

        // The renderer is shared across spawned models. Its request revision must
        // follow the selected vehicle, otherwise a DB11 can retain the first
        // vehicle's cache key and make asset diagnostics misleading.
        const cacheBust = customManifest
            ? `custom-vehicle-${String(state.model || hash)}-v3`
            : 'demo-sultan-v3-exact-wheels';
        if (this.vehicleModelRenderer.meshLoadOptions?.cacheBust !== cacheBust) {
            this.vehicleModelRenderer.meshLoadOptions = {
                ...this.vehicleModelRenderer.meshLoadOptions,
                cacheBust,
            };
        }

        if (modelChanged) this._markVehicleChassisLoadPriority(hash, lod);

        const q = this._vehicleModelQuat;
        // GTA vehicle drawables face local +Y; gameplay heading is data-space +X.
        glMatrix.quat.setAxisAngle(q, [0, 0, 1], Number(state.headingRad || 0) - Math.PI * 0.5);
        glMatrix.quat.rotateY(q, q, Number(state.bodyRoll) || 0);
        glMatrix.quat.rotateX(q, q, Number(state.bodyPitch) || 0);
        glMatrix.mat4.fromRotationTranslation(this._vehicleModelMat, q, state.position);
        this._vehicleModelMatBuf.set(this._vehicleModelMat);

        const updated = !forceFullInit && this.vehicleModelRenderer.updateInstanceMatricesForArchetype(
            hash, lod, this._vehicleModelMatBuf, 0.0,
        );
        if (!updated) {
            void this.vehicleModelRenderer.setInstancesForArchetype(
                hash, lod, this._vehicleModelMatBuf, -1.0, { loadPriority: 150 },
            );
        }
        this._vehicleModelActiveKey = key;
        const statusNow = performance.now();
        if (!forceFullInit && this._vehicleModelStatusKey === key && statusNow < this._vehicleModelStatusNextMs) return;
        this._vehicleModelStatusKey = key;
        this._vehicleModelStatusNextMs = statusNow + 250.0;
        const entry = this.vehicleModelRenderer.instances?.get?.(key);
        const submeshes = entry?.submeshes ? Array.from(entry.submeshes.values()) : [];
        const chassis = submeshes.filter((submesh) => this._vehicleSubmeshIsChassisAnchor(submesh));
        const loaded = submeshes.filter((submesh) => !!submesh?.mesh);
        const loadedChassis = chassis.filter((submesh) => !!submesh?.mesh);
        const pending = submeshes.filter((submesh) => !submesh?.mesh).length;
        const failed = submeshes.filter((submesh) => this.vehicleModelRenderer?._meshLoadFailures?.has?.(`${key}:${submesh?.file}`)).length;
        // A complete custom vehicle commonly has many optional fragment parts.
        // Wait for a real chassis anchor, then stream those optional pieces in
        // progressively. Rendering as soon as *any* mesh exists produced the
        // intermittent detached-wheel/partial-vehicle presentation.
        this._vehicleModelMeshReady = loadedChassis.length > 0 || (chassis.length === 0 && loaded.length > 0);
        this._vehicleModelMeshStatus = {
            model: String(state.model || ''),
            total: submeshes.length,
            loaded: loaded.length,
            chassisTotal: chassis.length,
            chassisLoaded: loadedChassis.length,
            pending,
            failed,
        };
    }

    _applyVehicleStreamingBudget() {
        const renderer = this.vehicleModelRenderer;
        if (!renderer) return;
        const speed = Math.abs(Number(this.vehicleController?.vehicle?.speed) || 0.0);
        const moving = !!this.vehicleController?.inVehicle && speed > 1.0;
        // Keep the chassis priority at entry, then leave optional fragments to a
        // single background decode while the player is actively driving. The
        // renderer itself pumps its queue during rendering, so this cap applies
        // to both the update and render paths.
        const targetLoads = moving && this._vehicleModelMeshReady ? 1 : 4;
        if (Number(renderer.maxMeshLoadsInFlight) !== targetLoads) {
            renderer.maxMeshLoadsInFlight = targetLoads;
        }
    }

    _mergePlayerLocalBoundsData(a, b) {
        if (!b || !Number.isFinite(Number(b.minZ)) || !Number.isFinite(Number(b.maxZ))) return a || null;
        if (!a || !Number.isFinite(Number(a.minZ)) || !Number.isFinite(Number(a.maxZ))) {
            return { minZ: Number(b.minZ), maxZ: Number(b.maxZ), height: Number(b.maxZ) - Number(b.minZ) };
        }
        const minZ = Math.min(Number(a.minZ), Number(b.minZ));
        const maxZ = Math.max(Number(a.maxZ), Number(b.maxZ));
        return { minZ, maxZ, height: maxZ - minZ };
    }

    _isPlayerFootAnchorComponent(component, label = '') {
        const id = Number(component?.componentId ?? component?.component_id ?? component?.id);
        if (id === 4 || id === 6) return true; // GTA freemode lower body + feet/shoes.
        const s = `${label || ''} ${component?.assetName || ''} ${component?.drawableName || ''}`.toLowerCase();
        return s.includes('lowr_') || s.includes('feet_') || s.includes('shoe');
    }

    _isPlausiblePlayerFootBounds(bounds) {
        const minZ = Number(bounds?.minZ);
        const maxZ = Number(bounds?.maxZ);
        const height = Number(bounds?.height ?? (maxZ - minZ));
        // Reject component-bound outliers. A bad accessory/hair bound here lifts the whole mesh.
        return Number.isFinite(minZ)
            && Number.isFinite(maxZ)
            && Number.isFinite(height)
            && minZ >= -1.75
            && minZ <= 0.35
            && height > 0.05
            && height <= 2.6;
    }

    _getPlayerMeshFootLocalZData(status = null) {
        try {
            const render = this.runtimeCharacterProfile?.render || null;
            if (!render?.skinning) return 0.0;
            const ps = status || this._getPlayerMeshStatus();
            const preferred = ps?.contactBoundsData || null;
            const fallback = ps?.localBoundsData || null;
            const candidate = this._isPlausiblePlayerFootBounds(preferred) ? preferred : fallback;
            const z = Number(candidate?.minZ);
            return this._isPlausiblePlayerFootBounds(candidate) && Number.isFinite(z) ? z : 0.0;
        } catch {
            return 0.0;
        }
    }

    _getPlayerMeshStatus() {
        const hashes = Array.isArray(this.player?.hashes)
            ? this.player.hashes.map((h) => String(h || '').trim()).filter(Boolean)
            : [];
        if (!hashes.length && this.player?.hash) hashes.push(String(this.player.hash));
        const lod = String(this.player?.lod || 'high').toLowerCase();
        const required = hashes.length
            ? Math.min(hashes.length, Math.max(1, Number(this.player?.requireRenderableCount) || 1))
            : 0;
        const status = {
            enabled: !!this.player?.enabled && !!this.showPlayer,
            ready: false,
            renderable: false,
            fallbackVisible: true,
            renderMode: String(this.player?.renderMode || 'single'),
            skinningExpected: !!this.runtimeCharacterProfile?.render?.skinning,
            skinningSkeletonReady: !!this.playerModelRenderer?.hasSkinningSkeleton?.(),
            skinningAnimationsReady: !!this.playerModelRenderer?.hasSkinningAnimations?.(),
            skinningAnimationClips: this.playerModelRenderer?.getSkinningAnimationStatus?.()?.clips || [],
            lod,
            targetCount: hashes.length,
            required,
            readyCount: 0,
            coreReadyCount: 0,
            coreRequiredCount: 0,
            loadedRealSubmeshes: 0,
            loadedSkinnedSubmeshes: 0,
            loadedSkinInfluenceSubmeshes: 0,
            queued: this.playerModelRenderer?.getMeshLoadStats?.()?.queued ?? 0,
            inFlight: this.playerModelRenderer?.getMeshLoadStats?.()?.inFlight ?? 0,
            entries: [],
            activeComponents: this._activeRuntimeCharacterComponents(this.runtimeCharacterProfile || null)
                .map((c) => ({
                    componentId: Number(c.componentId ?? c.component_id ?? c.id),
                    assetName: String(c.assetName || ''),
                    drawable: Number(c.drawable ?? c.drawable_id ?? c.drawableId),
                    texture: Number(c.texture ?? c.texture_id ?? c.textureId),
                })),
            disabledComponentIds: Array.from(this.runtimeCharacterDisabledComponentIds || []),
            localBoundsData: null,
            contactBoundsData: null,
            shoeBoundsData: null,
            lowerBodyBoundsData: null,
            footAnchorEntries: 0,
        };
        if (!status.enabled || !this.playerModelRenderer?.instances || !hashes.length) {
            this._playerMeshStatus = status;
            return status;
        }

        for (let i = 0; i < hashes.length; i++) {
            const h = hashes[i];
            const entry = this.playerModelRenderer.instances.get(`${h}:${lod}`);
            const component = Array.isArray(status.activeComponents) ? (status.activeComponents[i] || null) : null;
            const label = String(this.player?.labels?.[i] || component?.assetName || h);
            const isFootAnchor = this._isPlayerFootAnchorComponent(component, label);
            let loadedReal = 0;
            let placeholders = 0;
            let submeshes = 0;
            let skinnedSubmeshes = 0;
            let skinInfluenceSubmeshes = 0;
            let minZ = Number.POSITIVE_INFINITY;
            let maxZ = Number.NEGATIVE_INFINITY;
            for (const sm of entry?.submeshes?.values?.() || []) {
                if (!sm) continue;
                submeshes++;
                if (sm.file === '__placeholder__') {
                    placeholders++;
                    continue;
                }
                if (sm.mesh && !this.modelManager?.isMeshDisposed?.(sm.mesh)) {
                    loadedReal++;
                    if (sm.skinned && Array.isArray(sm.boneIds) && sm.boneIds.length) skinnedSubmeshes++;
                    if (sm.mesh.blendWeightsBuffer && sm.mesh.blendIndicesBuffer) skinInfluenceSubmeshes++;
                    const b = sm.mesh.bounds || null;
                    const z0 = Number(b?.min?.[2]);
                    const z1 = Number(b?.max?.[2]);
                    if (Number.isFinite(z0)) minZ = Math.min(minZ, z0);
                    if (Number.isFinite(z1)) maxZ = Math.max(maxZ, z1);
                }
            }
            if (loadedReal > 0 && (Number(entry?.instanceCount) || 0) > 0) status.readyCount++;
            const componentId = Number(component?.componentId);
            if ([0, 3, 4].includes(componentId)) {
                status.coreRequiredCount++;
                if (loadedReal > 0 && (Number(entry?.instanceCount) || 0) > 0) status.coreReadyCount++;
            }
            status.loadedRealSubmeshes += loadedReal;
            status.loadedSkinnedSubmeshes += skinnedSubmeshes;
            status.loadedSkinInfluenceSubmeshes += skinInfluenceSubmeshes;
            const localBoundsData = (Number.isFinite(minZ) && Number.isFinite(maxZ))
                ? { minZ, maxZ, height: maxZ - minZ }
                : null;
            if (localBoundsData) {
                if (!status.localBoundsData) status.localBoundsData = { ...localBoundsData };
                else {
                    status.localBoundsData.minZ = Math.min(status.localBoundsData.minZ, localBoundsData.minZ);
                    status.localBoundsData.maxZ = Math.max(status.localBoundsData.maxZ, localBoundsData.maxZ);
                    status.localBoundsData.height = status.localBoundsData.maxZ - status.localBoundsData.minZ;
                }
                if (isFootAnchor && this._isPlausiblePlayerFootBounds(localBoundsData)) {
                    const componentId = Number(component?.componentId);
                    const isShoe = componentId === 6 || /feet_|shoe/i.test(label);
                    if (isShoe) status.shoeBoundsData = this._mergePlayerLocalBoundsData(status.shoeBoundsData, localBoundsData);
                    else status.lowerBodyBoundsData = this._mergePlayerLocalBoundsData(status.lowerBodyBoundsData, localBoundsData);
                    status.footAnchorEntries++;
                }
            }
            status.entries.push({
                hash: h,
                label,
                lod,
                componentId: Number.isFinite(Number(component?.componentId)) ? Number(component.componentId) : null,
                footAnchor: !!isFootAnchor,
                shardLoaded: !!this.modelManager?.isShardLoadedForHash?.(h),
                manifestReady: !!this.modelManager?.hasRealMesh?.(h),
                entry: !!entry,
                instanceCount: Number(entry?.instanceCount) || 0,
                submeshes,
                loadedReal,
                skinnedSubmeshes,
                skinInfluenceSubmeshes,
                placeholders,
                localBoundsData,
            });
        }

        // The shoe sole is authoritative. Lower-body geometry is only a fallback
        // for incomplete outfits and must not shift a valid shoe component.
        status.contactBoundsData = status.shoeBoundsData || status.lowerBodyBoundsData || null;

        const skinOk = !status.skinningExpected || (
            status.skinningSkeletonReady &&
            status.skinningAnimationsReady &&
            status.loadedSkinnedSubmeshes > 0 &&
            status.loadedSkinInfluenceSubmeshes >= status.loadedSkinnedSubmeshes
        );
        status.ready = status.readyCount >= required && required > 0 && skinOk;
        const coreReady = status.coreRequiredCount > 0 && status.coreReadyCount >= status.coreRequiredCount;
        // Freemode outfits stream component-by-component. A shoe, mask, or jacket
        // replacement must not hide the already resident body while it loads.
        status.renderable = skinOk && (status.ready || coreReady);
        // Never draw the cyan debug skeleton over a partially resident real ped.
        status.fallbackVisible = !status.renderable && status.loadedRealSubmeshes === 0;
        this._playerMeshStatus = status;
        return status;
    }

    _isPlayerMeshRenderable() {
        return !!this._getPlayerMeshStatus()?.renderable;
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

    _initAssetInspector() {
        this._assetInspectorEl = document.getElementById('assetInspector');
        this._assetInspectorTitleEl = document.getElementById('assetInspectorTitle');
        this._assetInspectorSummaryEl = document.getElementById('assetInspectorSummary');
        this._assetInspectorBodyEl = document.getElementById('assetInspectorBody');
        this._assetInspectorCopyBtn = document.getElementById('copyAssetMetadata');
        const closeBtn = document.getElementById('closeAssetInspector');
        if (this._assetInspectorCopyBtn) {
            this._assetInspectorCopyBtn.addEventListener('click', () => {
                void this._copyAssetInspectorMetadata();
            });
        }
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                this._setAssetPickerEnabled(false);
                const picker = document.getElementById('assetPicker');
                if (picker) picker.checked = false;
                this._scheduleSaveSettings();
            });
        }
        this._setAssetPickerEnabled(!!document.getElementById('assetPicker')?.checked);
    }

    _setAssetPickerEnabled(enabled) {
        this.assetPickerEnabled = !!enabled;
        if (this.assetPickerEnabled) {
            // Asset inspection is an explicit mouse mode. It must not inherit a
            // captured combat pointer or pointer lock from normal gameplay.
            this._suppressPointerUnlockMenu = true;
            try { this.weaponController?.clearPointerState?.(); } catch { /* ignore */ }
            try { document.exitPointerLock?.(); } catch { /* ignore */ }
        }
        if (!this.assetPickerEnabled && this._assetInspectorEl) this._assetInspectorEl.style.display = 'none';
    }

    _inspectDemoAssetAtClientPoint(clientX, clientY) {
        if (!this.assetPickerEnabled || !this.spawnDistrictDemo) return;
        if (!this.canvas || !this.instancedModelRenderer?.pickAssetAtScreen) return;
        const rect = this.canvas.getBoundingClientRect();
        if (!rect || !(rect.width > 0) || !(rect.height > 0)) return;
        const x = (Number(clientX) - rect.left) * (this.canvas.width / rect.width);
        const y = (Number(clientY) - rect.top) * (this.canvas.height / rect.height);
        const report = this.instancedModelRenderer.pickAssetAtScreen({
            x,
            y,
            viewportWidth: this.canvas.width,
            viewportHeight: this.canvas.height,
            viewProjectionMatrix: this.camera?.viewProjectionMatrix,
            maxPixelDistance: 28,
            nearbyLimit: 10,
        }) || {
            schema: 'webglgta-demo-asset-pick-v1',
            click: { x, y, viewportWidth: this.canvas.width, viewportHeight: this.canvas.height },
            selected: null,
            nearby: [],
        };
        report.app = this._buildAssetInspectorAppState();
        this._showAssetInspectorReport(report);
    }

    _buildAssetInspectorAppState() {
        const cov = (() => { try { return this.drawableStreamer?.getCoverageStats?.() || null; } catch { return null; } })();
        const tex = (() => { try { return this.textureStreamer?.getStats?.() || null; } catch { return null; } })();
        const occ = (() => { try { return this.occlusionCuller?.getStats?.() || null; } catch { return null; } })();
        const renderStats = (() => { try { return this.instancedModelRenderer?.getRenderStats?.() || null; } catch { return null; } })();
        return {
            page: (() => { try { return window.location.href; } catch { return null; } })(),
            route: this.spawnDistrictDemo ? '/demo' : '/',
            spawnDistrictDemo: !!this.spawnDistrictDemo,
            spawnDistrictBounds: this.spawnDistrictBounds || null,
            demoDescriptor: this._spawnDistrictDescriptor ? {
                instanceCount: Number(this._spawnDistrictDescriptor.instanceCount || 0),
                sourceInstanceCount: Number(this._spawnDistrictDescriptor.sourceInstanceCount || 0),
                archetypeCount: Number(this._spawnDistrictDescriptor.archetypeCount || 0),
                manifestArchetypeCount: Number(this._spawnDistrictDescriptor.manifestArchetypeCount || 0),
                instanceFile: this._spawnDistrictDescriptor.instanceFile || null,
                manifestFile: this._spawnDistrictDescriptor.manifestFile || null,
            } : null,
            toggles: {
                showTerrain: !!this.showTerrain,
                showBuildings: !!this.showBuildings,
                showModels: !!this.showModels,
                objectsWireframeMode: !!this.objectsWireframeMode,
                forcedModelLod: this.forcedModelLod || null,
                enableOcclusionCulling: !!this.enableOcclusionCulling,
                enableWorkerFrustumCulling: !!this.drawableStreamer?.enableWorkerFrustumCulling,
                enableWasmCulling: !!this.drawableStreamer?.enableWasmCulling,
                enableWebGpuCulling: !!this.drawableStreamer?.enableWebGpuCulling,
                enableCrossArchetypeInstancing: !!this.drawableStreamer?.enableCrossArchetypeInstancing,
                enableEntityLodTraversal: !!this.drawableStreamer?.enableEntityLodTraversal,
            },
            streaming: {
                radiusChunks: this.drawableStreamer?.radiusChunks ?? null,
                maxLoadedChunks: this.drawableStreamer?.maxLoadedChunks ?? null,
                maxResidentChunks: this.drawableStreamer?.maxResidentChunks ?? null,
                staleChunkGraceMs: this.drawableStreamer?.staleChunkGraceMs ?? null,
                chunkRebuildSettleMs: this.drawableStreamer?.chunkRebuildSettleMs ?? null,
                maxNewLoadsPerUpdate: this.drawableStreamer?.maxNewLoadsPerUpdate ?? null,
                extraFrontChunks: this.drawableStreamer?.extraFrontChunks ?? null,
                prefetchHorizonSeconds: this.drawableStreamer?.prefetchHorizonSeconds ?? null,
                prefetch: this.drawableStreamer?._lastPrefetchStats || null,
                frameMsEma: this.drawableStreamer?._frameMsEma ?? null,
                instanceRebuildCount: this.drawableStreamer?._instanceRebuildCount ?? null,
                lastInstanceRebuildCompletedMs: this.drawableStreamer?._lastInstanceRebuildCompletedMs ?? null,
                maxArchetypes: this.drawableStreamer?.maxArchetypes ?? null,
                maxModelDistance: this.drawableStreamer?.maxModelDistance ?? null,
                maxVisibleInstances: this.drawableStreamer?.maxVisibleInstances ?? null,
                maxInstancesPerArchetype: this.drawableStreamer?.maxInstancesPerArchetype ?? null,
                maxBehindModelDistance: this.drawableStreamer?.maxBehindModelDistance ?? null,
                workerFrustumPadding: this.drawableStreamer?.workerFrustumPadding ?? null,
            },
            coverage: cov,
            renderStats,
            textureStats: tex,
            occlusionStats: occ,
        };
    }

    _showAssetInspectorReport(report) {
        if (!this.assetPickerEnabled) return;
        this._lastAssetInspectorReport = report || null;
        this._assetInspectorText = JSON.stringify(report || {}, null, 2);
        if (this._assetInspectorTitleEl) {
            const selected = report?.selected;
            const hash = selected?.identity?.hash || 'none';
            const file = selected?.identity?.file || 'no hit';
            this._assetInspectorTitleEl.textContent = selected ? `${hash} / ${file}` : 'No asset selected';
        }
        if (this._assetInspectorSummaryEl) {
            this._assetInspectorSummaryEl.textContent = this._buildAssetInspectorSummary(report);
        }
        if (this._assetInspectorBodyEl) {
            this._assetInspectorBodyEl.textContent = this._assetInspectorText;
        }
        if (this._assetInspectorCopyBtn) {
            this._assetInspectorCopyBtn.textContent = 'Copy metadata';
        }
        if (this._assetInspectorEl) {
            this._assetInspectorEl.style.display = 'block';
        }
    }

    _buildAssetInspectorSummary(report) {
        const selected = report?.selected;
        if (!selected) {
            const n = Array.isArray(report?.nearby) ? report.nearby.length : 0;
            return `hit=none nearby=${n}`;
        }
        const id = selected.identity || {};
        const mat = selected.material || {};
        const diff = selected.textures?.diffuse || {};
        const inst = selected.instance || {};
        const pick = selected.pick || {};
        return [
            `hash=${id.hash || 'n/a'} lod=${id.lod || 'n/a'} file=${id.file || 'n/a'}`,
            `shader=${mat.shaderName || 'n/a'} family=${mat.shaderFamily || 'basic'} diffuse=${diff.state || 'none'}`,
            `pos=${Array.isArray(inst.dataPosition) ? inst.dataPosition.join(', ') : 'n/a'} pickPx=${pick.distancePx ?? 'n/a'}`,
        ].join('\n');
    }

    async _copyAssetInspectorMetadata() {
        const text = this._assetInspectorText || JSON.stringify(this._lastAssetInspectorReport || {}, null, 2);
        if (!text) return false;
        try {
            await navigator.clipboard.writeText(text);
            if (this._assetInspectorCopyBtn) {
                this._assetInspectorCopyBtn.textContent = 'Copied';
                setTimeout(() => {
                    if (this._assetInspectorCopyBtn) this._assetInspectorCopyBtn.textContent = 'Copy metadata';
                }, 900);
            }
            return true;
        } catch {
            try { window.prompt('Asset metadata:', text); } catch { /* ignore */ }
            return false;
        }
    }

    _requestGameplayPointerLock() {
        const canCapture = !this.settingsMenuOpen
            && !this.chatMenu?.capturesInput
            && !!this.followPed
            && !!this.ped
            && !document.querySelector('dialog[open]');
        if (!canCapture || document.pointerLockElement === this.canvas) return false;
        try {
            const lock = this.canvas.requestPointerLock?.();
            if (lock && typeof lock.catch === 'function') void lock.catch(() => {});
            return true;
        } catch {
            return false;
        }
    }

    _setSettingsMenuOpen(open, { recapturePointer = false } = {}) {
        const nextOpen = !!open;
        this.settingsMenuOpen = nextOpen;

        const menu = this._settingsMenuEl || document.getElementById('controls');
        const backdrop = this._settingsBackdropEl || document.getElementById('settingsBackdrop');
        if (menu) {
            menu.hidden = !nextOpen;
            menu.setAttribute('aria-hidden', nextOpen ? 'false' : 'true');
        }
        if (backdrop) backdrop.hidden = !nextOpen;

        if (nextOpen) {
            for (const key of Object.keys(this.keyState || {})) this.keyState[key] = false;
            if (Array.isArray(this._pedVelocityData)) {
                this._pedVelocityData[0] = 0.0;
                this._pedVelocityData[1] = 0.0;
            }
            if (this.player) this.player._sprintRequested = false;
            try { this.weaponController?.clearPointerState?.(); } catch { /* ignore */ }
            try { this.meleeController?.clearInput?.(); } catch { /* ignore */ }
            this._suppressPointerUnlockMenu = true;
            try { document.exitPointerLock?.(); } catch { /* ignore */ }
            requestAnimationFrame(() => document.getElementById('closeSettings')?.focus());
            return;
        }

        const active = document.activeElement;
        if (active instanceof HTMLElement && menu?.contains(active)) active.blur();
        try { this.canvas.focus({ preventScroll: true }); } catch { /* ignore */ }
        if (recapturePointer) this._requestGameplayPointerLock();
    }
    
    setupEventListeners() {
        // Apply persisted UI state first so all the "read initial values" logic below picks it up.
        this._restoreUiFromStorage();
        // Route mode is deliberately not persisted: / remains the full-world viewer while
        // /demo owns the bounded YBN spawn district regardless of earlier UI state.
        this.spawnDistrictDemo = isSpawnDistrictDemoRoute();
        const hasSavedSettings = !!this._safeLocalStorageGet(_LS_SETTINGS_KEY);

        // Window resize
        window.addEventListener('resize', () => {
            this.resize();
        });
        
        // Mouse / pointer movement (use pointer capture so dragging doesn't "drop" when leaving the canvas).
        let activePointerId = null;
        let lastX = 0;
        let lastY = 0;
        let dragStartX = 0;
        let dragStartY = 0;
        let dragDistancePx = 0;
        let activeCombatPointer = false;
        const combatInputActive = () => !!this.weaponController?.isVisible?.()
            && !this.assetPickerEnabled
            && !this.phoneController?.active
            && !!this.followPed
            && !!this.ped
            && !this._weaponInventoryDialog?.open;
        const gameplayLookActive = () => !this.settingsMenuOpen
            && !this.assetPickerEnabled
            && !this.chatMenu?.capturesInput
            && !!this.followPed
            && !!this.ped
            && !document.querySelector('dialog[open]');
        const meleeInputActive = () => gameplayLookActive()
            && !this.phoneController?.active
            && !!this.meleeController?.canUse?.();
        const syncCombatButtons = (e) => {
            if (!combatInputActive() || !Number.isFinite(Number(e?.buttons))) return;
            const buttons = Number(e.buttons);
            const aiming = (buttons & 2) !== 0;
            // Establish ADS before evaluating fire. This keeps a simultaneous
            // RMB + LMB press from being discarded as a non-ADS click.
            this.weaponController?.setAimHeld?.(aiming);
            this.weaponController?.setFireHeld?.(aiming && (buttons & 1) !== 0);
        };
        const syncMeleeButtons = (e) => {
            if (!Number.isFinite(Number(e?.buttons))) return;
            this.meleeController?.setGuardHeld?.(meleeInputActive() && (Number(e.buttons) & 2) !== 0);
        };
        const applyPointerCameraDelta = (deltaX, deltaY) => {
            if (this.followPed && this.ped) {
                if (this.gameplayCamEnabled) this._applyGameplayCameraInputDelta(deltaX, deltaY);
                else this._orbitFollowPed(deltaX, deltaY);
            } else {
                this.camera.rotate(deltaX, deltaY);
            }
        };

        // Prevent context menu from stealing focus while looking around.
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        this.canvas.addEventListener('pointerdown', (e) => {
            if (this.settingsMenuOpen) return;
            keyState.shift = !!e.shiftKey;
            keyState.control = !!e.ctrlKey;
            keyState.ctrl = !!e.ctrlKey;
            keyState.alt = !!e.altKey;
            syncCombatButtons(e);
            syncMeleeButtons(e);
            if (this.assetPickerEnabled) {
                if (e.button === 0) {
                    this._inspectDemoAssetAtClientPoint(e.clientX, e.clientY);
                    e.preventDefault();
                }
                return;
            }
            if (gameplayLookActive()) this._requestGameplayPointerLock();
            if (combatInputActive()) {
                // Keep a normal captured-pointer path as a fallback when pointer
                // lock is unavailable or rejected by the embedding browser.
                activePointerId = e.pointerId;
                activeCombatPointer = true;
                lastX = e.clientX;
                lastY = e.clientY;
                dragStartX = e.clientX;
                dragStartY = e.clientY;
                dragDistancePx = 0;
                try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
                e.preventDefault();
                return;
            }
            if (meleeInputActive() && (e.button === 0 || e.button === 2)) {
                if (e.button === 0) this.meleeController?.pressAttack?.();
                activeCombatPointer = true;
                e.preventDefault();
                return;
            }
            // Both mouse buttons steer the third-person view. The left button
            // also drives fire; the right button drives aim while armed.
            if (e.button !== 0 && e.button !== 2) return;
            activePointerId = e.pointerId;
            activeCombatPointer = false;
            lastX = e.clientX;
            lastY = e.clientY;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            dragDistancePx = 0;
            try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        });

        this.canvas.addEventListener('pointermove', (e) => {
            if (this.settingsMenuOpen) return;
            keyState.shift = !!e.shiftKey;
            keyState.control = !!e.ctrlKey;
            keyState.ctrl = !!e.ctrlKey;
            keyState.alt = !!e.altKey;
            // Pointer Lock in an embedded browser can interrupt the original
            // pointer capture. Reconcile the real button bitmask on every move
            // so ADS/fire recover without requiring another click.
            syncCombatButtons(e);
            syncMeleeButtons(e);
            if (document.pointerLockElement === this.canvas && gameplayLookActive()) {
                applyPointerCameraDelta(Number(e.movementX) || 0.0, Number(e.movementY) || 0.0);
                return;
            }
            if (activePointerId === null || e.pointerId !== activePointerId) return;

            const deltaX = e.clientX - lastX;
            const deltaY = e.clientY - lastY;
            dragDistancePx = Math.max(
                dragDistancePx,
                Math.hypot(e.clientX - dragStartX, e.clientY - dragStartY),
            );

            applyPointerCameraDelta(deltaX, deltaY);

            lastX = e.clientX;
            lastY = e.clientY;
        });

        const stopDrag = (e) => {
            syncCombatButtons(e);
            syncMeleeButtons(e);
            if (e?.button === 0) this.weaponController?.setFireHeld?.(false);
            if (e?.button === 2) this.weaponController?.setAimHeld?.(false);
            if (e?.button === 2) this.meleeController?.setGuardHeld?.(false);
            if (e?.type === 'blur' || e?.type === 'pointercancel') {
                this.weaponController?.clearPointerState?.();
                this.meleeController?.clearInput?.();
            }
            if (activePointerId === null) return;
            const endedPointerId = activePointerId;
            const endX = Number(e?.clientX);
            const endY = Number(e?.clientY);
            const clickDistancePx = (Number.isFinite(endX) && Number.isFinite(endY))
                ? Math.max(dragDistancePx, Math.hypot(endX - dragStartX, endY - dragStartY))
                : dragDistancePx;
            const wasClick = e?.type === 'pointerup' && e.pointerId === endedPointerId && clickDistancePx <= 4.0;
            try { this.canvas.releasePointerCapture(endedPointerId); } catch { /* ignore */ }
            activePointerId = null;
            const wasCombatPointer = activeCombatPointer;
            activeCombatPointer = false;
            if (wasClick && !wasCombatPointer && e?.button === 0) this._inspectDemoAssetAtClientPoint(e.clientX, e.clientY);
        };
        this.canvas.addEventListener('pointerup', stopDrag);
        this.canvas.addEventListener('pointercancel', stopDrag);
        window.addEventListener('blur', stopDrag);
        document.addEventListener('pointerlockchange', () => {
            if (document.pointerLockElement === this.canvas) {
                this._gameplayPointerWasLocked = true;
                this._suppressPointerUnlockMenu = false;
                return;
            }
            const shouldOpenMenu = !!this._gameplayPointerWasLocked
                && !this._suppressPointerUnlockMenu
                && !this.settingsMenuOpen
                && !document.querySelector('dialog[open]')
                && document.hasFocus();
            this._gameplayPointerWasLocked = false;
            this._suppressPointerUnlockMenu = false;
            if (shouldOpenMenu) this._setSettingsMenuOpen(true);
        });
        
        // Mouse wheel
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (this.settingsMenuOpen) return;
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
        const movementKeyForEvent = (e) => {
            const code = String(e?.code || '').toLowerCase();
            if (code === 'shiftleft' || code === 'shiftright') return 'shift';
            if (code === 'controlleft' || code === 'controlright') return 'control';
            if (code === 'altleft' || code === 'altright') return 'alt';
            if (code === 'space') return 'space';
            if (code === 'keyw') return 'w';
            if (code === 'keya') return 'a';
            if (code === 'keys') return 's';
            if (code === 'keyd') return 'd';
            return String(e?.key || '').toLowerCase();
        };
        const setMovementKey = (e, pressed) => {
            const key = movementKeyForEvent(e);
            if (key) keyState[key] = !!pressed;
            // Keep legacy aliases synchronized for the existing movement code.
            if (key === 'control') keyState.ctrl = !!pressed;
            if (key === 'space') {
                keyState[' '] = !!pressed;
                keyState.spacebar = !!pressed;
            }
        };
        
        window.addEventListener('keydown', (e) => {
            const k = movementKeyForEvent(e);
            if (k === 'escape' && !e.repeat) {
                if (this.phoneController?.active) {
                    this.phoneController.close();
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                const modalOpen = !!document.querySelector('dialog[open]');
                if (!modalOpen) {
                    this._setSettingsMenuOpen(!this.settingsMenuOpen, { recapturePointer: this.settingsMenuOpen });
                    e.preventDefault();
                    e.stopPropagation();
                }
                return;
            }
            if (this.settingsMenuOpen) {
                e.preventDefault();
                return;
            }
            const target = e.target;
            if (target instanceof HTMLElement && (
                target.isContentEditable
                || target.tagName === 'INPUT'
                || target.tagName === 'SELECT'
                || target.tagName === 'TEXTAREA'
                || target.tagName === 'BUTTON'
            )) return;
            if (this.audioSystem?.handleKeyDown?.(e)) return;
            // One-shot debug toggles (don't spam while held).
            if (!e.repeat) {
                if (k === 'm') {
                    if (this.phoneController?.toggle?.()) e.preventDefault();
                    return;
                }
                if (this.phoneController?.active) {
                    if (k === 'c') {
                        if (this.phoneController.startCall()) e.preventDefault();
                        return;
                    }
                    if (k === 'f') {
                        if (this.phoneController.startPhoto()) e.preventDefault();
                        return;
                    }
                    if (k === 'q') {
                        if (this.phoneController.startSelfie()) e.preventDefault();
                        return;
                    }
                }
                if (k === 'tab' || k === 'i') {
                    this._toggleWeaponInventory();
                    e.preventDefault();
                    return;
                }
                if (k === 'z') {
                    if (!this._weaponInventoryDialog?.open) this.inventoryOverlay?.showHotbar?.();
                    e.preventDefault();
                    return;
                }
                if (k === '1') {
                    if (this.phoneController?.active) {
                        this.phoneController.close();
                        e.preventDefault();
                        return;
                    }
                    if (this.weaponController?.toggleDraw?.()) e.preventDefault();
                    return;
                }
                if (k === 'r') {
                    if (this.weaponController?.reload?.()) e.preventDefault();
                    return;
                }
                if (k === 'b') {
                    if (this.weaponController?.installSwitch?.()) e.preventDefault();
                    return;
                }
                if (k === 'x') {
                    if (this.player?.enabled && !this.vehicleController?.inVehicle) {
                        this.phoneController?.hideImmediate?.();
                        this.player.handsUp = !this.player.handsUp;
                        if (this.player.handsUp) {
                            this.weaponController?.holsterImmediate?.();
                            this._resetPedMotion?.();
                        }
                        e.preventDefault();
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
                if (k === 'v' && this.ped && this.followPed) {
                    this._toggleGameplayCameraMode();
                    e.preventDefault();
                    return;
                }
            }
            setMovementKey(e, true);
        });
        
        window.addEventListener('keyup', (e) => {
            this.audioSystem?.handleKeyUp?.(e);
            setMovementKey(e, false);
        });
        
        // Update movement in animation loop
        this.keyState = keyState;
        
        // UI controls
        const controlsRoot = document.getElementById('controls');
        this._settingsMenuEl = controlsRoot;
        this._settingsBackdropEl = document.getElementById('settingsBackdrop');
        this._setSettingsMenuOpen(false);
        if (controlsRoot) {
            // One central persistence hook for most UI widgets.
            controlsRoot.addEventListener('change', () => this._scheduleSaveSettings());
            controlsRoot.addEventListener('input', () => this._scheduleSaveSettings());
        }
        const vehiclePhysicsMode = document.getElementById('vehiclePhysicsMode');
        const vehiclePhysicsModeStatus = document.getElementById('vehiclePhysicsModeStatus');
        const nurburgringStatus = document.getElementById('nurburgringStatus');
        const applyVehiclePhysicsMode = () => {
            const mode = this.vehicleController?.setPhysicsMode?.(vehiclePhysicsMode?.value) || 'gta';
            if (vehiclePhysicsMode) vehiclePhysicsMode.value = mode;
            if (vehiclePhysicsModeStatus) {
                const loaded = this.vehicleController?.vehicle?.assettoProfileStatus === 'loaded';
                vehiclePhysicsModeStatus.textContent = mode === 'assetto'
                    ? (loaded ? 'A local Assetto Corsa profile is active for this vehicle.' : 'Assetto Corsa profile baseline is active. A local profile is loaded automatically when available.')
                    : 'GTA handling is active.';
            }
            this._scheduleSaveSettings();
        };
        vehiclePhysicsMode?.addEventListener('change', applyVehiclePhysicsMode);
        applyVehiclePhysicsMode();
        const trackLoaded = !!this.collisionWorld?.getDerivedRoadSpawn?.();
        if (nurburgringStatus) nurburgringStatus.textContent = trackLoaded
            ? 'Derived Nordschleife road is loaded with matching road contact.'
            : 'Local derived track package not loaded.';
        document.getElementById('teleportNurburgring')?.addEventListener('click', () => {
            if (!this.teleportToDerivedRoad()) console.warn('Nurburgring road package is not available. Generate it locally first.');
        });
        document.getElementById('closeSettings')?.addEventListener('click', () => this._setSettingsMenuOpen(false, { recapturePointer: true }));
        this._settingsBackdropEl?.addEventListener('click', () => this._setSettingsMenuOpen(false, { recapturePointer: true }));
        const ambientAudio = document.getElementById('ambientAudio');
        if (ambientAudio) {
            this.audioSystem.setAmbientEnabled(!!ambientAudio.checked);
            ambientAudio.addEventListener('change', (event) => this.audioSystem.setAmbientEnabled(!!event.target.checked));
        }
        const ambientVolume = document.getElementById('ambientVolume');
        if (ambientVolume) {
            this.audioSystem.setAmbientVolume(ambientVolume.value);
            ambientVolume.addEventListener('input', (event) => this.audioSystem.setAmbientVolume(event.target.value));
        }
        const gameplayAudio = document.getElementById('gameplayAudio');
        if (gameplayAudio) {
            this.audioSystem.setGameplayEnabled(!!gameplayAudio.checked);
            gameplayAudio.addEventListener('change', (event) => this.audioSystem.setGameplayEnabled(!!event.target.checked));
        }
        const sfxVolume = document.getElementById('sfxVolume');
        if (sfxVolume) {
            this.audioSystem.setSfxVolume(sfxVolume.value);
            sfxVolume.addEventListener('input', (event) => this.audioSystem.setSfxVolume(event.target.value));
        }
        const voiceVolume = document.getElementById('voiceVolume');
        if (voiceVolume) {
            this.audioSystem.setVoiceVolume(voiceVolume.value);
            voiceVolume.addEventListener('input', (event) => this.audioSystem.setVoiceVolume(event.target.value));
        }
        const voiceMode = document.getElementById('voiceMode');
        if (voiceMode) {
            this.audioSystem.setVoiceMode(voiceMode.value);
            voiceMode.addEventListener('change', (event) => this.audioSystem.setVoiceMode(event.target.value));
        }
        document.getElementById('voiceMicToggle')?.addEventListener('click', () => { void this.audioSystem.toggleMicrophone(); });
        const weaponToggle = document.getElementById('weaponToggle');
        if (weaponToggle) weaponToggle.addEventListener('click', () => this.weaponController?.toggleDraw?.());
        const weaponReload = document.getElementById('weaponReload');
        if (weaponReload) weaponReload.addEventListener('click', () => this.weaponController?.reload?.());
        const weaponSwitch = document.getElementById('weaponSwitch');
        if (weaponSwitch) weaponSwitch.addEventListener('click', () => this.weaponController?.installSwitch?.());
        const weaponInventory = document.getElementById('weaponInventory');
        if (weaponInventory) weaponInventory.addEventListener('click', () => this._toggleWeaponInventory());
        this._weaponInventoryDialog = document.getElementById('weaponInventoryDialog');
        const assetPicker = document.getElementById('assetPicker');
        if (assetPicker) {
            this._setAssetPickerEnabled(!!assetPicker.checked);
            assetPicker.addEventListener('change', (e) => this._setAssetPickerEnabled(!!e.target.checked));
        }
        this._syncWeaponUi();
        const showPlayerEl = document.getElementById('showPlayer');
        if (showPlayerEl) {
            this.showPlayer = !!showPlayerEl.checked;
            showPlayerEl.addEventListener('change', (e) => {
                this.showPlayer = !!e.target.checked;
                if (!this.showPlayer) {
                    this._clearPlayerEntityMeshes();
                    return;
                }
                void this.ensureModelsInitialized().then((ok) => {
                    if (ok) this._syncPlayerEntityMesh(true);
                });
            });
        }
        const showNpcsEl = document.getElementById('showNpcs');
        if (showNpcsEl) {
            this.showNpcs = !!showNpcsEl.checked;
            showNpcsEl.addEventListener('change', (e) => {
                this.showNpcs = !!e.target.checked;
                if (this.npcSystem) this.npcSystem.enabled = this.showNpcs;
                if (!this.showNpcs) this._clearNpcEntityMeshes();
                else this._syncNpcEntityMeshes(true);
            });
        }

        const bindTexturedToggle = (id, property) => {
            const el = document.getElementById(id);
            if (!el) return;
            this[property] = !el.checked;
            el.addEventListener('change', (e) => {
                this[property] = !e.target.checked;
            });
        };
        bindTexturedToggle('playerTextured', 'playerWireframeMode');
        bindTexturedToggle('objectsTextured', 'objectsWireframeMode');
        bindTexturedToggle('terrainTextured', 'terrainWireframeMode');
        bindTexturedToggle('buildingsTextured', 'buildingsWireframeMode');

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
        const characterModelEl = document.getElementById('characterModel');
        if (characterModelEl) {
            characterModelEl.addEventListener('change', () => {
                if (!this.player?.enabled) return;
                this.runtimeCharacterProfile = null;
                this.runtimeCharacterSelectedIndex = -1;
                this.runtimeCharacterDisabledComponentIds = new Set();
                const sel = document.getElementById('runtimeAppearanceSelect');
                if (sel) sel.value = '';
                this._renderRuntimeAppearanceComponents();
                this._applyPlayerRenderTargetsFromProfileOrUi();
                try { this._syncPlayerEntityMesh(true); } catch { /* ignore */ }
            });
        }
        const runtimeAppearanceEl = document.getElementById('runtimeAppearanceSelect');
        if (runtimeAppearanceEl) {
            runtimeAppearanceEl.addEventListener('change', () => {
                const idx = Number(runtimeAppearanceEl.value);
                const profile = Number.isInteger(idx) ? this.runtimeCharacterOptions?.[idx] : null;
                this.runtimeCharacterSelectedIndex = profile ? idx : -1;
                this.runtimeCharacterDisabledComponentIds = new Set();
                if (profile) {
                    this.runtimeCharacterProfile = structuredClone(profile);
                    this.runtimeCharacterBaseProfile = structuredClone(profile);
                    this._applyRuntimeCharacterProfileToUi(profile);
                    void this._loadRuntimePlayerSkeleton(profile);
                    void this._loadRuntimePlayerAnimations(profile);
                } else {
                    this.runtimeCharacterProfile = null;
                    this._runtimeCharacterLoadPromise = null;
                    void this._loadRuntimeCharacterProfile({ timeoutMs: 5_000 }).then(() => {
                        this._applyPlayerRenderTargetsFromProfileOrUi({ preserveStored: true });
                        if (this.player?.enabled) this._syncPlayerEntityMesh(true);
                    });
                }
                this._applyPlayerRenderTargetsFromProfileOrUi({ preserveStored: true });
                if (this.player?.enabled) this._syncPlayerEntityMesh(true);
            });
            void this._loadRuntimeCharacterOptions({ timeoutMs: 1100 });
            void this._loadRuntimeCharacterComponentCatalog();
        }
        const creatorDialog = document.getElementById('characterCreatorDialog');
        document.getElementById('openCharacterCreator')?.addEventListener('click', () => {
            this._characterCreatorOpenSnapshot = this.runtimeCharacterProfile
                ? structuredClone(this.runtimeCharacterProfile)
                : null;
            this._renderRuntimeAppearanceComponents();
            this._renderCompleteAppearanceControls();
            this._syncRuntimeCharacterSexControls();
            if (creatorDialog?.showModal) creatorDialog.showModal();
            else if (creatorDialog) creatorDialog.setAttribute('open', '');
        });
        const restoreCreatorSnapshot = async () => {
            const snapshot = this._characterCreatorOpenSnapshot;
            this._characterCreatorOpenSnapshot = null;
            if (!snapshot) return;
            this.runtimeCharacterProfile = structuredClone(snapshot);
            this.runtimeCharacterDisabledComponentIds = new Set();
            this._applyRuntimeCharacterProfileToUi(this.runtimeCharacterProfile);
            this._applyPlayerRenderTargetsFromProfileOrUi();
            await Promise.all([
                this._loadRuntimePlayerSkeleton(this.runtimeCharacterProfile),
                this._loadRuntimePlayerAnimations(this.runtimeCharacterProfile),
            ]);
            if (this.player?.enabled) this._syncPlayerEntityMesh(true);
        };
        const cancelCreator = async () => {
            await restoreCreatorSnapshot();
            creatorDialog?.close?.();
        };
        document.getElementById('closeCharacterCreator')?.addEventListener('click', () => { void cancelCreator(); });
        document.getElementById('cancelCharacterCreator')?.addEventListener('click', () => { void cancelCreator(); });
        document.getElementById('saveCharacterCreator')?.addEventListener('click', () => {
            this.runtimeCharacterBaseProfile = this.runtimeCharacterProfile
                ? structuredClone(this.runtimeCharacterProfile)
                : null;
            this._characterCreatorOpenSnapshot = null;
            this._saveRuntimeAppearanceDraft();
            creatorDialog?.close?.();
        });
        document.getElementById('copyCharacterCreator')?.addEventListener('click', async (event) => {
            const button = event.currentTarget;
            const text = JSON.stringify(this._getIlleniumAppearancePayload(), null, 2);
            try {
                await navigator.clipboard.writeText(text);
                button.textContent = 'Copied';
                window.setTimeout(() => { button.textContent = 'Copy JSON'; }, 1200);
            } catch {
                console.log(text);
            }
        });
        creatorDialog?.addEventListener('cancel', (event) => {
            event.preventDefault();
            void cancelCreator();
        });
        document.querySelectorAll('[data-character-sex]').forEach((button) => {
            button.addEventListener('click', () => { void this._switchRuntimeCharacterSex(button.dataset.characterSex); });
        });
        document.getElementById('setCharacterShirtless')?.addEventListener('click', () => {
            this._applyShirtlessRuntimeAppearance();
        });
        document.querySelectorAll('[data-character-tab]').forEach((button) => {
            button.addEventListener('click', () => {
                const selected = String(button.dataset.characterTab || 'clothing');
                document.querySelectorAll('[data-character-tab]').forEach((item) => item.setAttribute('aria-selected', String(item === button)));
                document.querySelectorAll('[data-character-panel]').forEach((panel) => { panel.hidden = panel.dataset.characterPanel !== selected; });
            });
        });
        const resetAppearance = document.getElementById('resetRuntimeAppearance');
        if (resetAppearance) {
            resetAppearance.addEventListener('click', () => {
                if (!this.runtimeCharacterBaseProfile) return;
                this.runtimeCharacterProfile = structuredClone(this.runtimeCharacterBaseProfile);
                this.runtimeCharacterDisabledComponentIds = new Set(
                    (this.runtimeCharacterProfile.disabledComponentIds || [])
                        .map(Number)
                        .filter((id) => OPTIONAL_PED_COMPONENT_IDS.has(id)),
                );
                this._renderRuntimeAppearanceComponents();
                this._renderCompleteAppearanceControls();
                this._syncPlayerHairAppearance();
                this._applyPlayerRenderTargetsFromProfileOrUi({ preserveStored: true });
                if (this.player?.enabled) this._syncPlayerEntityMesh(true);
            });
        }
        const copyAppearance = document.getElementById('copyRuntimeAppearance');
        if (copyAppearance) {
            copyAppearance.addEventListener('click', async () => {
                const text = JSON.stringify(this._getIlleniumAppearancePayload(), null, 2);
                try {
                    await navigator.clipboard.writeText(text);
                    copyAppearance.textContent = 'Copied';
                    window.setTimeout(() => { copyAppearance.textContent = 'Copy appearance JSON'; }, 1200);
                } catch {
                    console.log(text);
                }
            });
        }

        const gpCam = document.getElementById('enableGameplayCamera');
        if (gpCam) {
            this.gameplayCamEnabled = !!gpCam.checked;
            gpCam.addEventListener('change', (e) => {
                this.gameplayCamEnabled = !!e.target.checked;
                try { if (this.gameplayCamEnabled) this._initGameplayCameraFromCurrentPose(); } catch { /* ignore */ }
            });
        }
        const firstPersonCamera = document.getElementById('firstPersonCamera');
        if (firstPersonCamera) {
            firstPersonCamera.checked = this.gameplayCameraMode === 'firstPerson';
            firstPersonCamera.addEventListener('change', (e) => {
                if (this.vehicleController?.inVehicle) this._setVehicleCameraView(e.target.checked ? 'cockpit' : 'chase');
                else this._setGameplayCameraMode(e.target.checked ? 'firstPerson' : 'thirdPerson');
            });
        }
        document.getElementById('vehicleCameraCockpit')?.addEventListener('click', () => this._setVehicleCameraView('cockpit'));
        document.getElementById('vehicleCameraChase')?.addEventListener('click', () => this._setVehicleCameraView('chase'));
        this._syncVehicleCameraViewControls();
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

        this._setSpawnDistrictDemo(this.spawnDistrictDemo, { dropResident: false });

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
        this._vehiclePromptEl = document.getElementById('vehiclePrompt');
        this._liveCoordsEl = document.getElementById('liveCoords');
        this._perfHudEl = document.getElementById('perfHud');
        this._rpfStatusEl = document.getElementById('rpfStatus');
        this._initAssetInspector();
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
                } else {
                    this._dropStreamedResidency({ dropEntities: false });
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

        const demoBoundary = document.getElementById('showDemoBoundary');
        if (demoBoundary) {
            this.showDemoBoundary = !!demoBoundary.checked;
            demoBoundary.addEventListener('change', (e) => {
                this.showDemoBoundary = !!e.target.checked;
            });
        }

        const resolveMissing = document.getElementById('resolveMissingArchetypes');
        if (resolveMissing) {
            resolveMissing.addEventListener('click', () => {
                const top = this.drawableStreamer?.getMissingArchetypesTop?.(12) ?? [];
                if (!top.length) {
                    console.log('No exportable missing archetypes in the current resident area.');
                    return;
                }
                // Deliberate, bounded local export. The streamer remains resident while this runs.
                this.modelManager.enableLiveExport = true;
                this.modelManager.requestLiveExportForHashes?.(top.map((e) => e.hash), { exportTextures: false });
                console.log(`Queued local export for ${top.length} current-area archetypes.`);
            });
        }

        const lodSel = document.getElementById('lodLevel');
        if (lodSel) {
            const applyLod = () => {
                let v = String(lodSel.value ?? '0');
                // UI: 0=Full Detail, 1=Medium, 2=Low.
                const prev = this.forcedModelLod || null;
                if (v === '0') this.forcedModelLod = 'high';
                else if (v === '1') this.forcedModelLod = 'med';
                else if (v === '2') this.forcedModelLod = 'low';
                else this.forcedModelLod = null;

                if (this.drawableStreamer) {
                    this.drawableStreamer.forcedLod = this.forcedModelLod;
                    this.drawableStreamer._dirty = true;
                    this.drawableStreamer._dirtyEntityLod = true;
                }
                // The drawable streamer reconciles old and new LOD buckets. Clearing the
                // entire scene here made a quality change blank the city while thousands
                // of otherwise-cached meshes were queued again.
                if (prev !== (this.forcedModelLod || null) && this.drawableStreamer) {
                    this.drawableStreamer._dirty = true;
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
                let q = String(texSel.value ?? 'low').toLowerCase();
                if (q !== 'high' && q !== 'medium' && q !== 'low') q = 'low';
                this.textureStreamer?.setQuality?.(q);
                if (this.spawnDistrictDemo && this.textureStreamer) {
                    const deviceMemoryGb = Number(this._defaultRuntimeCaps?.deviceMemoryGb);
                    const constrainedDevice = Number.isFinite(deviceMemoryGb) && deviceMemoryGb <= 4;
                    if (q === 'high') {
                        this.textureStreamer.setCacheCaps({
                            maxTextures: constrainedDevice ? 2048 : 4096,
                            maxBytes: constrainedDevice ? (256 * 1024 * 1024) : (640 * 1024 * 1024),
                        });
                        this.textureStreamer.setStreamingConfig({
                            maxLoadsInFlight: constrainedDevice ? 6 : 10,
                            maxNewLoadsPerFrame: constrainedDevice ? 18 : 32,
                        });
                        this.textureStreamer.setDistanceTierConfig({
                            highDist: constrainedDevice ? 180 : 420,
                            mediumDist: constrainedDevice ? 320 : 520,
                            minResidentMs: constrainedDevice ? 12000 : 24000,
                        });
                    } else if (q === 'medium') {
                        this.textureStreamer.setCacheCaps({
                            maxTextures: constrainedDevice ? 2048 : 3072,
                            maxBytes: constrainedDevice ? (256 * 1024 * 1024) : (384 * 1024 * 1024),
                        });
                        this.textureStreamer.setStreamingConfig({
                            maxLoadsInFlight: constrainedDevice ? 4 : 6,
                            maxNewLoadsPerFrame: constrainedDevice ? 8 : 12,
                        });
                        this.textureStreamer.setDistanceTierConfig({
                            highDist: constrainedDevice ? 28 : 45,
                            mediumDist: constrainedDevice ? 170 : 260,
                            minResidentMs: constrainedDevice ? 6000 : 12000,
                        });
                    } else {
                        this.textureStreamer.setCacheCaps({
                            // Low quality lowers uploaded resolution; it must not
                            // evict diffuse maps simply because the district uses
                            // many unique materials. Entry churn causes visible
                            // real-texture/fallback flicker even below the byte cap.
                            // Resolution is the low-quality lever. Keep every small
                            // material entry until the byte budget is genuinely full;
                            // an entry-count cap caused continuous diffuse eviction.
                            maxTextures: 0,
                            maxBytes: constrainedDevice ? (256 * 1024 * 1024) : (384 * 1024 * 1024),
                        });
                        this.textureStreamer.setStreamingConfig({
                            maxLoadsInFlight: constrainedDevice ? 3 : 4,
                            maxNewLoadsPerFrame: constrainedDevice ? 6 : 8,
                        });
                        this.textureStreamer.setDistanceTierConfig({
                            highDist: 0,
                            mediumDist: constrainedDevice ? 80 : 120,
                            minResidentMs: constrainedDevice ? 4000 : 8000,
                        });
                    }
                }
                try {
                    this._lastTexPrefetchMs = 0;
                    this.textureStreamer?.beginFrame?.();
                    const high = q === 'high';
                    const limit = high ? (this.spawnDistrictDemo ? 512 : 256) : (q === 'medium' ? 128 : 64);
                    if (!this.objectsWireframeMode) {
                        this.instancedModelRenderer?.prefetchDiffuseTextures?.(limit, { includeSecondary: high });
                    }
                    if (!this.playerWireframeMode) {
                        this.playerModelRenderer?.prefetchDiffuseTextures?.(high ? 128 : 48, {
                            includeSecondary: high,
                            allowIndexMiss: true,
                        });
                    }
                    this.textureStreamer?.endFrame?.();
                } catch { /* ignore */ }
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
            const vi = Number(document.getElementById('maxVisibleInstances')?.value ?? (this.drawableStreamer?.maxVisibleInstances ?? 12000));
            const pa = Number(document.getElementById('maxInstancesPerArchetype')?.value ?? (this.drawableStreamer?.maxInstancesPerArchetype ?? 128));
            const ml = Number(document.getElementById('maxMeshLoadsInFlight')?.value ?? (this.instancedModelRenderer?.maxMeshLoadsInFlight ?? 6));
            const fc = !!document.getElementById('frustumCulling')?.checked;
            const webgpu = !!document.getElementById('enableWebGpuCulling')?.checked
                && getWebGpuCullingAvailability().available;
            const cross = !!document.getElementById('crossArchetypeInstancing')?.checked;
            let entLod = !!document.getElementById('entityLodTraversal')?.checked;
            if (this.spawnDistrictDemo) {
                entLod = false;
                this._setControlValue('entityLodTraversal', false);
            }
            const radius = Number.isFinite(r) ? Math.max(1, Math.min(24, Math.floor(r))) : 2;
            const maxLoaded = Number.isFinite(m) ? Math.max(9, Math.min(4000, Math.floor(m))) : 25;
            // 0 means "no cap" (distance cutoff still applies).
            const maxArch = Number.isFinite(a) ? Math.max(0, Math.floor(a)) : 250;
            const maxDist = Number.isFinite(md) ? Math.max(0, Math.min(100000, md)) : 350;
            const maxVisible = Number.isFinite(vi) ? Math.max(1, Math.min(1000000, Math.floor(vi))) : 12000;
            const maxPerArch = Number.isFinite(pa) ? Math.max(1, Math.min(100000, Math.floor(pa))) : 128;
            const maxLoads = Number.isFinite(ml) ? Math.max(1, Math.min(64, Math.floor(ml))) : 6;

            // Cache UI params so boot/ramp can use them without reading DOM repeatedly.
            this._streamingUiParams = { radius, maxLoaded, maxArch, maxDist, maxVisible, maxPerArch, maxLoads, fc, webgpu };
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
                this.drawableStreamer.enableWebGpuCulling = webgpu;
                this.drawableStreamer.forcedLod = this.forcedModelLod;
                this.drawableStreamer.maxArchetypes = maxArch;
                this.drawableStreamer.maxModelDistance = maxDist;
                this.drawableStreamer.maxVisibleInstances = maxVisible;
                this.drawableStreamer.maxInstancesPerArchetype = maxPerArch;
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
            console.log(`Streaming: radiusChunks=${radius}, maxLoadedChunks=${maxLoaded}, maxArchetypes=${maxArch}, maxModelDistance=${maxDist}, maxVisibleInstances=${maxVisible}, maxInstancesPerArchetype=${maxPerArch}, maxMeshLoadsInFlight=${maxLoads}, frustumCulling=${fc}, webGpuCulling=${webgpu}`);

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
        const maxArchInput = document.getElementById('maxArchetypes');
        if (maxArchInput) maxArchInput.addEventListener('change', applyStreaming);
        const maxDistInput = document.getElementById('maxModelDistance');
        if (maxDistInput) maxDistInput.addEventListener('change', applyStreaming);
        const maxVisibleInput = document.getElementById('maxVisibleInstances');
        if (maxVisibleInput) maxVisibleInput.addEventListener('change', applyStreaming);
        const maxPerArchInput = document.getElementById('maxInstancesPerArchetype');
        if (maxPerArchInput) maxPerArchInput.addEventListener('change', applyStreaming);
        const maxMeshLoadsInput = document.getElementById('maxMeshLoadsInFlight');
        if (maxMeshLoadsInput) maxMeshLoadsInput.addEventListener('change', applyStreaming);
        const fcInput = document.getElementById('frustumCulling');
        if (fcInput) fcInput.addEventListener('change', applyStreaming);
        const webGpuInput = document.getElementById('enableWebGpuCulling');
        if (webGpuInput) {
            const webGpuAvailability = getWebGpuCullingAvailability();
            webGpuInput.disabled = !webGpuAvailability.available;
            webGpuInput.title = webGpuAvailability.available
                ? 'WebGPU compute culling available'
                : `WebGPU compute culling unavailable: ${webGpuAvailability.reason}`;
            if (!webGpuAvailability.available) webGpuInput.checked = false;
            webGpuInput.addEventListener('change', applyStreaming);
        }
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
                if (this.spawnDistrictDemo && this.enableOcclusionCulling) {
                    this._configureSpawnDistrictDemoOcclusion();
                }
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
            try {
                if (new URLSearchParams(window.location.search).get('perf') === '1') perfHud.checked = true;
            } catch { /* ignore */ }
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
            // Keep persistent chunk cache opt-in. These files can be large and can hide stale exports.
            if (!hasSavedSettings) {
                try { cacheChunksEl.checked = !!PERF_PROFILES.gameplay.cacheStreamedChunks; } catch { /* ignore */ }
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
                ? 'Cache: available (off by default)'
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
                this._applyPerformanceProfile('city', { updateUi: true, dropResident: true, save: true, startModels: true });
                return;
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
                const profile = (preset === 'game' || preset === 'gameplay') ? 'gameplay'
                    : ((preset === 'extreme') ? 'high' : preset);
                this._applyPerformanceProfile(profile, { updateUi: true, dropResident: true, save: true, startModels: true });
                return;
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
        const memorySaverBtn = document.getElementById('applyMemorySaver');
        if (memorySaverBtn) {
            memorySaverBtn.addEventListener('click', () => {
                this._applyPerformanceProfile('gameplay', { updateUi: true, dropResident: true, save: true, startModels: true });
                this._setBootStatus('Memory saver applied: low LOD, wireframe, bounded caches, resident chunks trimmed.');
            });
        }

        const highDetailBtn = document.getElementById('applyHighDetail');
        if (highDetailBtn) {
            highDetailBtn.addEventListener('click', () => {
                const setCheck = (id, val) => {
                    const el = document.getElementById(id);
                    if (el) el.checked = !!val;
                };

                // Streamed drawables are the authoritative city layer. The heightfield and OBJ
                // shell remain available as manual fallbacks for coverage gaps.
                setCheck('showTerrain', false);
                setCheck('showBuildings', false);
                setCheck('showWater', true);
                setCheck('showModels', true);
                // Dots are debug; keep off for “GTA view”.
                setCheck('showEntityDots', false);
                setCheck('entityDotsOverlay', false);

                this.showTerrain = false;
                this.showBuildings = false;
                this.showWater = true;
                this.showModels = true;
                this.showEntityDots = false;
                this.entityDotsOverlay = false;

                this._applyPerformanceProfile('high', { updateUi: true, dropResident: true, save: true, startModels: true });
                return;

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
        // Keep CSS at native size while reducing the demo's internal pixel count.
        // This cuts fragment shading and texture bandwidth without touching world geometry.
        const scale = this.spawnDistrictDemo ? SPAWN_DEMO_RENDER_SCALE : 1.0;
        this.renderScale = scale;
        this.canvas.width = Math.max(1, Math.round(window.innerWidth * scale));
        this.canvas.height = Math.max(1, Math.round(window.innerHeight * scale));
        
        // Update camera
        this.camera.resize(this.canvas.width, this.canvas.height);
        
        // Update viewport
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        
        console.log(`Canvas resized to ${this.canvas.width}x${this.canvas.height}`);
    }

    _measureDrivingPhase(name, callback) {
        const monitor = this.drivingPerformance;
        return monitor?.measure ? monitor.measure(name, callback) : callback();
    }
    
    update() {
        // Simulation delta is clamped to avoid huge jumps on tab-switch, but
        // diagnostics must retain wall time or stalls below 20 FPS are hidden.
        const now = performance.now();
        const wallDt = Math.max(0.001, (now - this._lastFrameMs) / 1000.0);
        const dt = Math.min(0.05, wallDt);
        this._lastFrameMs = now;
        this._lastUpdateDt = dt;

        // Perf HUD timing
        this._perfDtMs = wallDt * 1000.0;
        const fps = 1.0 / wallDt;
        this._fpsEma = (this._fpsEma === null || this._fpsEma === undefined) ? fps : (this._fpsEma * 0.9 + fps * 0.1);
        // Browser-native gameplay systems.
        let gameplayAction = null;
        try {
            gameplayAction = this.interactionSystem?.update?.({
                posData: this.ped?.posData || null,
                keyState: this.keyState || {},
            }) || null;
            this._lastGameplayAction = gameplayAction;
        } catch {
            gameplayAction = null;
        }
        const benchmarkVehicleInput = this.drivingPerformance?.getBenchmarkInput?.();
        const vehicleKeyState = benchmarkVehicleInput || this.keyState || {};
        try {
            this._measureDrivingPhase('vehiclePhysics', () => this.vehicleController?.update?.({
                action: gameplayAction,
                keyState: vehicleKeyState,
                dt,
            }));
        } catch {
            // ignore
        }
        try { this.doorController?.update?.({ posData: this.ped?.posData || null, action: gameplayAction, dt }); } catch { /* ignore */ }
        try { this.bankingController?.handleInteraction?.(gameplayAction); } catch { /* ignore */ }
        try {
            const prompt = this.vehicleController?.getPrompt?.() || '';
            if (this._vehiclePromptEl) {
                this._vehiclePromptEl.textContent = prompt;
                this._vehiclePromptEl.hidden = !prompt;
            }
        } catch { /* ignore */ }
        try { this.weaponController?.update?.(dt); } catch { /* ignore */ }
        try { this.meleeController?.update?.(dt); } catch { /* ignore */ }
        try { this.fragmentDebrisSystem?.update?.(dt); } catch { /* debris is presentation-only */ }
        if (this.spawnDistrictDemo && !this._meleeAnimationsLoaded) void this._ensureMeleeAnimations();
        if (this.weaponController?.isVisible?.() && !this._weaponCombatAnimationsLoaded) {
            void this._ensureWeaponCombatAnimations();
        }
        try { this._syncWeaponUi(); } catch { /* ignore */ }
        try { this._syncMeleeUi(); } catch { /* ignore */ }
        try { this.gtaHud?.update?.(); } catch { /* ignore */ }

        // Keep a look-ahead ring of compiled collision resident around the
        // controlled actor.  This path is asynchronous and never substitutes
        // the legacy YBNC tile while a chunk is in flight.
        const collisionStreamPoint = this.ped?.posData;
        const compiledCollision = this.collisionWorld?.compiledStaticCollision;
        if (compiledCollision && Array.isArray(collisionStreamPoint) && collisionStreamPoint.length >= 2 && !this._compiledCollisionStreamPending) {
            const px = Number(collisionStreamPoint[0]); const py = Number(collisionStreamPoint[1]);
            const previous = this._compiledCollisionStreamCenter;
            if ([px, py].every(Number.isFinite) && (!previous || Math.hypot(px - previous[0], py - previous[1]) >= 32.0)) {
                this._compiledCollisionStreamCenter = [px, py];
                this._compiledCollisionStreamPending = Promise.all([
                    this.collisionWorld.streamCompiledStaticCollisionAt(px, py),
                    this.collisionWorld.streamCompiledAssetCollidersAt(px, py),
                ]).catch((error) => {
                    this._compiledCollisionStreamError = String(error?.message || error);
                    console.error('Compiled collision streaming failed:', error);
                }).finally(() => { this._compiledCollisionStreamPending = null; });
            }
        }

        // Handle keyboard input
        const moveDir = glMatrix.vec3.create();
        const moveSpeed = this.keyState['shift'] ? 2.5 : 1.0;
        
        if (this.keyState['w']) moveDir[2] -= moveSpeed;
        if (this.keyState['s']) moveDir[2] += moveSpeed;
        if (this.keyState['a']) moveDir[0] -= moveSpeed;
        if (this.keyState['d']) moveDir[0] += moveSpeed;
        if (this.keyState['q']) moveDir[1] += moveSpeed;
        if (this.keyState['e']) moveDir[1] -= moveSpeed;
        
        if (this.controlPed && this.ped) {
            this._updateControlledPed(dt);
        } else if (glMatrix.vec3.length(moveDir) > 0) {
            glMatrix.vec3.normalize(moveDir, moveDir);
            // Map view (not following a ped): fly camera in the air (move along look direction).
            // Ped view/follow: keep WASD level to avoid unwanted bobbing while orbiting around the character.
            // Only flatten in *actual* ped-follow mode (a ped exists). The UI defaults "Follow ped" to checked,
            // but in the default map view there is no ped, and movement should be true fly (move along look).
            const flattenForward = !!(this.followPed && this.ped);
            this.camera.move(moveDir, dt, { flattenForward });
        }

        // If following a spawned ped, keep target locked to it.
        if (this.followPed && this.ped) {
            // Tighten camera for close-up character-level viewing.
            // (This avoids the old 5km min zoom / huge near plane behavior.)
            const firstPerson = this._isFirstPersonGameplayCamera();
            this.camera.setFovDegrees?.(firstPerson ? 70.0 : (this.weaponController?.isAiming?.() ? 48.0 : 60.0));
            this.camera.setZoomLimits?.(firstPerson ? 0.025 : 2.0, 20000.0);

            // Use distance-based clip planes so the ped feels correctly scaled and doesn't clip.
            // Keeping far plane somewhat bounded improves depth precision near the player.
            const d = this.camera.getDistance?.() ?? glMatrix.vec3.distance(this.camera.position, this.camera.target);
            const near = firstPerson ? 0.025 : Math.max(0.05, Math.min(2.0, d * 0.02));
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

        // Keep the player mesh/component instances updated.
        try { this._updatePlayerAnimationState(dt); } catch { /* ignore */ }
        try { this._measureDrivingPhase('audio', () => this.audioSystem?.updateGameplay?.(dt)); } catch { /* ignore */ }
        try { this._syncPlayerEntityMesh(false); } catch { /* ignore */ }
        // The player waits for a complete skinned residency set before drawing.
        // Pump its focused mesh queue here so that guard cannot stall loading.
        try { this.playerModelRenderer?.pumpMeshLoadsOnce?.(); } catch { /* ignore */ }
        try {
            if (this.npcSystem) this.npcSystem.enabled = !!(this.showNpcs && this.spawnDistrictDemo);
            this._measureDrivingPhase('npcSimulation', () => this.npcSystem?.update?.(dt));
        } catch (error) { this._reportNpcPipelineError('simulation/network interpolation', error); }
        try { this._measureDrivingPhase('npcMeshSync', () => this._syncNpcEntityMeshes(false)); }
        catch (error) { this._reportNpcPipelineError('mesh synchronization', error); }
        try { this._measureDrivingPhase('npcAnimation', () => this._updateNpcAmbientLocomotion(dt)); }
        catch (error) { this._reportNpcPipelineError('animation state', error); }
        try {
            this.npcModelRenderer?.pumpMeshLoadsOnce?.();
            this.npcCombatModelRenderer?.pumpMeshLoadsOnce?.();
            this.policeNpcModelRenderer?.pumpMeshLoadsOnce?.();
            for (const renderer of this.ambientNpcModelRenderers.values()) renderer.pumpMeshLoadsOnce?.();
        } catch (error) { this._reportNpcPipelineError('mesh loading', error); }
        try {
            this.multiplayer?.update?.();
            this._syncRemotePlayerMeshes(false);
            this.remotePlayerRenderer?.pumpMeshLoadsOnce?.();
        } catch { /* ignore */ }
        try { this._syncWeaponModelMesh(false); } catch { /* ignore */ }
        try { this.weaponModelRenderer?.pumpMeshLoadsOnce?.(); } catch { /* ignore */ }
        try { this._syncPhoneModelMesh(false); } catch { /* ignore */ }
        try { this.phoneModelRenderer?.pumpMeshLoadsOnce?.(); } catch { /* ignore */ }
        try { this._measureDrivingPhase('vehicleAssets', () => this._syncVehicleModelMesh(false)); } catch { /* ignore */ }
        try { this._measureDrivingPhase('vehicleAssets', () => this._applyVehicleStreamingBudget()); } catch { /* ignore */ }
        try { this._measureDrivingPhase('vehicleAssets', () => this.vehicleModelRenderer?.pumpMeshLoadsOnce?.()); } catch { /* ignore */ }
        try { this._syncCokePlantMeshes(false); } catch { /* ignore */ }
        try { this.cokePlantModelRenderer?.pumpMeshLoadsOnce?.(); } catch { /* ignore */ }
        try { this.gameplayPersistence?.update?.(this, this.runtimeGameplayManifest); } catch { /* ignore */ }

        // Stream entities based on camera (client-like chunk loading)
        if (this.entityReady && this.showEntityDots) {
            const center = this._getStreamingFocusDataPos();
            this.entityStreamer.update(this.camera, this.entityRenderer, center);
        }

        // Stream drawables based on camera (requires exported meshes manifest)
        if (this.showModels && this.modelsInitialized) {
            const center = this._getStreamingFocusDataPos();
            try { this.entityStreamer?.setTimeWeather?.({ hour: this.timeOfDayHours, weather: this.weatherType }); } catch { /* ignore */ }
            try { this.drawableStreamer?.setTimeWeather?.({ hour: this.timeOfDayHours, weather: this.weatherType }); } catch { /* ignore */ }
            this.drawableStreamer.update(this.camera, center);
        }

        // Diagnostics are useful but component-residency scans and large DOM
        // strings do not belong on the gameplay tick.
        const debugHudNow = performance.now();
        const updateDebugHud = debugHudNow - (this._debugHudLastUpdateMs || 0) >= 250;
        if (updateDebugHud) this._debugHudLastUpdateMs = debugHudNow;

        // Streaming debug HUD (helps diagnose "nothing loaded")
        if (updateDebugHud && this._streamDebugEl) {
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
            const worldMeshLoads = this.instancedModelRenderer?.getMeshLoadStats?.() || null;
            const worldRenderStats = this.instancedModelRenderer?.getRenderStats?.() || null;
            const cov = this.drawableStreamer?.getCoverageStats?.();
            const covLine = cov
                ? (
                    `Coverage (loaded area): missing=${cov.missingEntities ?? 0}/${cov.missingArchetypes ?? 0} ` +
                    `unexported(placeholders)=${cov.unexportedEntities ?? 0}/${cov.unexportedArchetypes ?? 0} ` +
                    `nonrenderable=${cov.nonRenderableEntities ?? 0}/${cov.nonRenderableArchetypes ?? 0} ` +
                    `deduped=${cov.duplicateInstancesDropped ?? 0} ` +
                    `frustum=${cov.frustumCulledInstances ?? 0}/${cov.frustumTestedInstances ?? 0} ` +
                    `wasm=${cov.wasmCullingKeptInstances ?? 0}/${cov.wasmCullingTestedInstances ?? 0} ` +
                    `webgpu=${cov.webGpuCullingKeptInstances ?? 0}/${cov.webGpuCullingTestedInstances ?? 0}` +
                    `${cov.webGpuCullingReason ? `(${cov.webGpuCullingReason})` : ''} ` +
                    `cappedInstances=${cov.cappedInstances ?? 0} ` +
                    `cappedArchetypes=${cov.droppedArchetypes ?? 0}`
                )
                : 'Coverage (loaded area): n/a';
            const spawnPoint = this._runtimeSpawnInfo?.ped;
            const spawnCoords = Array.isArray(spawnPoint) && Number.isFinite(Number(spawnPoint[0])) && Number.isFinite(Number(spawnPoint[1]))
                ? ` @ ${Number(spawnPoint[0]).toFixed(2)}, ${Number(spawnPoint[1]).toFixed(2)}, ${Number(spawnPoint[2]).toFixed(2)}`
                : '';
            const spawnLine = this._runtimeSpawnInfo
                ? `Spawn: ${this._runtimeSpawnInfo.kind}${spawnCoords}${this._runtimeSpawnInfo.source ? ` (${this._runtimeSpawnInfo.source})` : ''}`
                : 'Spawn: local fallback';
            const district = this.spawnDistrictBounds;
            const districtLine = this.spawnDistrictDemo && district
                ? `District: demo ${Math.round(district.maxX - district.minX)}m x ${Math.round(district.maxY - district.minY)}m, boundary active`
                : 'District: full-map streaming';
            const charProfile = this.runtimeCharacterProfile || null;
            const ps = this._playerMeshStatus || this._getPlayerMeshStatus();
            const skinLine = (ps.loadedSkinnedSubmeshes || ps.loadedSkinInfluenceSubmeshes)
                ? ` skinData=${ps.loadedSkinInfluenceSubmeshes || 0}/${ps.loadedSkinnedSubmeshes || 0} skeleton=${ps.skinningSkeletonReady ? 'on' : (ps.skinningExpected ? 'loading' : 'off')} ycd=${ps.skinningAnimationsReady ? ps.skinningAnimationClips.join('/') : 'off'}`
                : ' skinData=none';
            const compTotal = Array.isArray(charProfile?.components) ? charProfile.components.length : 0;
            const compActive = Array.isArray(ps.activeComponents) ? ps.activeComponents.length : 0;
            const compLine = compTotal ? ` components=${compActive}/${compTotal}` : '';
            const playerMeshLine = ` player=${ps.readyCount}/${ps.required || ps.targetCount || 0}${compLine} submeshes=${ps.loadedRealSubmeshes || 0}${skinLine} q=${ps.queued || 0}/${ps.inFlight || 0} fallback=${ps.fallbackVisible ? 'on' : 'off'}`;
            const playerEntryLine = Array.isArray(ps.entries) && ps.entries.length
                ? `Components: ${ps.entries.map((entry) => `${entry.label}[shard=${entry.shardLoaded ? 1 : 0},meta=${entry.manifestReady ? 1 : 0},entry=${entry.entry ? 1 : 0},mesh=${entry.loadedReal || 0}]`).join(' ')}`
                : 'Components: n/a';
            const charRenderKind = charProfile?.render?.skinning ? 'skinned components' : 'static components';
            const charLine = charProfile
                ? `Character: ${charProfile.modelName || 'unknown'} render=${charProfile.render?.mode || 'unknown'} meshes=${this.player?.hashes?.length || 0} gait=${this.player?.animGait || 'idle'} (${charRenderKind})${playerMeshLine}\n${playerEntryLine}`
                : `Character: ${document.getElementById('characterModel')?.value || DEFAULT_CHARACTER_MODEL_NAME} render=single gait=${this.player?.animGait || 'idle'} (static drawable)${playerMeshLine}\n${playerEntryLine}`;
            const npcStatus = this._getNpcMeshStatus();
            const networkStatus = this.npcSystem?.getNetworkStatus?.();
            const nativeNpcEntries = Object.values(npcStatus.nativeAmbientRenderers || {}).flatMap((renderer) => renderer.entries || []);
            const nativeNpcSubmeshes = nativeNpcEntries.flatMap((entry) => entry.submeshes || []);
            const npcLine = `NPCs: total=${npcStatus.total} init=${this._ambientNpcRendererInitPromises.size} renderers=${this.ambientNpcModelRenderers.size} nativeReady=${this._nativeNpcReadyModels.size}/${AMBIENT_PED_MODELS.length} `
                + `entries=${nativeNpcEntries.length} meshes=${nativeNpcSubmeshes.filter((submesh) => submesh.loaded).length}/${nativeNpcSubmeshes.length} `
                + `syncs=${this._npcSyncDiagnostics.syncs} submits=${this._npcSyncDiagnostics.submissions} groups=${this._npcSyncDiagnostics.ambient}/${this._npcSyncDiagnostics.combat}/${this._npcSyncDiagnostics.police} `
                + `hashes=${this._npcSyncDiagnostics.hashes.join(',') || 'none'} `
                + `net=${networkStatus?.authoritative ? 'server' : 'local'} samples=${networkStatus?.sampled || 0} age=${Number.isFinite(networkStatus?.ageMs) ? Math.round(networkStatus.ageMs) : 'n/a'}ms`;
            const vehicleAudio = this.audioSystem?.getVehicleAudioStatus?.();
            const vehicleRenderState = this.vehicleController?.getRenderState?.();
            const vehicleMeshStatus = this._vehicleModelMeshStatus;
            const vehicleRenderLine = vehicleRenderState
                ? `Vehicle render: ${vehicleRenderState.model || 'unknown'} mesh=${this._vehicleModelMeshReady ? 'ready' : 'loading'} renderer=${this.vehicleModelRenderer?.ready ? 'ready' : 'loading'} `
                    + `parts=${vehicleMeshStatus?.loaded || 0}/${vehicleMeshStatus?.total || 0} chassis=${vehicleMeshStatus?.chassisLoaded || 0}/${vehicleMeshStatus?.chassisTotal || 0} failed=${vehicleMeshStatus?.failed || 0}`
                : '';
            const audioLine = vehicleAudio
                ? `Audio: ${vehicleAudio.mode || 'idle'} bank=${vehicleAudio.activeBank || vehicleAudio.bank || 'none'} channels=${vehicleAudio.activeChannels || 0} grains=${vehicleAudio.activeGrains || 0}`
                : '';
            const gameplayLine = [
                this._gameplayManifestStatus ? `Manifest: ${this._gameplayManifestStatus}` : 'Manifest: n/a',
                this.interactionSystem?.getStatusLine?.() || '',
                this.vehicleController?.getStatusLine?.() || '',
                vehicleRenderLine,
                audioLine,
                this.gameplayPersistence?.getStatusLine?.() || '',
            ].filter(Boolean).join('\n');

            this._streamDebugEl.textContent =
                `${spawnLine}\n` +
                `${districtLine}\n` +
                `${charLine}\n` +
                `${npcLine}\n` +
                `${gameplayLine}\n` +
                `Entities: ready=${!!this.entityReady} chunks=${eChunks} loaded=${eLoaded} loading=${eLoading} dots=${!!this.showEntityDots}` +
                (es ? ` started=${es.started ?? 0} ok=${es.loaded ?? 0} abort=${es.aborted ?? 0} fail=${es.failed ?? 0}` : '') +
                (es && es.lastError ? ` lastErr=${String(es.lastError).slice(0, 80)}` : '') +
                `\n` +
                `Drawables: on=${modelsOn} initialized=${!!this.modelsInitialized} manifestMeshes=${mCount} loaded=${dLoaded}/${this.drawableStreamer?.maxResidentChunks || this.drawableStreamer?.maxLoadedChunks || 0} loading=${dLoading} ` +
                `wanted=${this.drawableStreamer?.maxLoadedChunks || 0} forward=${this.drawableStreamer?._lastPrefetchStats?.forward || 0} rebuilds=${this.drawableStreamer?._instanceRebuildCount || 0}\n` +
                `World meshes: ready=${worldMeshLoads?.completed ?? 0} queued=${worldMeshLoads?.queued ?? 0} deferred=${worldMeshLoads?.deferred ?? 0} inFlight=${worldMeshLoads?.inFlight ?? 0} failed=${worldMeshLoads?.failed ?? 0} ` +
                `draws=${worldRenderStats?.drawCalls ?? 0} instances=${worldRenderStats?.instances ?? 0} items=${worldRenderStats?.drawItems ?? 0}\n` +
                covLine;
        }

        // Live camera coords HUD (copy/paste friendly)
        if (updateDebugHud && this._liveCoordsEl) {
            const pv = this.camera?.position || [0, 0, 0];
            const pd = this._viewerPosToDataPos(pv);
            const fmt3 = (v) => `${v[0].toFixed(3)}, ${v[1].toFixed(3)}, ${v[2].toFixed(3)}`;
            this._liveCoordsEl.value =
                `viewer: vec3(${fmt3(pv)})\n` +
                `data:   vec3(${fmt3(pd)})\n` +
                `data vector4: vector4(${pd[0].toFixed(4)}, ${pd[1].toFixed(4)}, ${pd[2].toFixed(4)}, 0.0)`;
        }

        // Debug readout for spawned ped grounding.
        if (updateDebugHud && this._pedDebugEl && this._pedGroundingDebug) {
            const d = this._pedGroundingDebug;
            const gz = (d.groundZ === null || d.groundZ === undefined) ? 'n/a' : d.groundZ.toFixed(2);
            const dgz = (d.demoGroundZ === null || d.demoGroundZ === undefined) ? 'n/a' : d.demoGroundZ.toFixed(2);
            const iz = (d.interiorFloorZ === null || d.interiorFloorZ === undefined) ? 'n/a' : d.interiorFloorZ.toFixed(2);
            const hz = Number.isFinite(d.terrainEnvelopeZ) ? d.terrainEnvelopeZ.toFixed(2) : 'n/a';
            const heightVisualZ = Number.isFinite(d.terrainEnvelopeZ)
                ? d.terrainEnvelopeZ + (Number(this._terrainDebugVisualOffset) || 0.0)
                : NaN;
            const hvz = Number.isFinite(heightVisualZ) ? heightVisualZ.toFixed(2) : 'n/a';
            const yz = Number.isFinite(d.ybnZ) ? d.ybnZ.toFixed(2) : 'n/a';
            const ryz = Number.isFinite(d.rawYbnZ) ? d.rawYbnZ.toFixed(2) : 'n/a';
            const yoff = Number.isFinite(d.ybnAlignmentOffset) ? d.ybnAlignmentOffset.toFixed(2) : 'n/a';
            const dz = Number.isFinite(d.desiredZ) ? d.desiredZ.toFixed(2) : 'n/a';
            const mode = d.usedInterior
                ? 'interior'
                : ((d.groundSource === 'ybn' || d.usedYbnGround)
                    ? 'YBN collision'
                    : (d.usedDemoGround ? 'demo' : (d.usedGround ? 'terrain' : 'kept')));
            const blocked = d.blocked ? ` | blocked=${d.blockReason || 'yes'}` : '';
            const playerMeshStatus = this._playerMeshStatus || this._getPlayerMeshStatus?.() || null;
            const meshFootZ = this._getPlayerMeshFootLocalZData?.(playerMeshStatus);
            const footBounds = playerMeshStatus?.contactBoundsData || null;
            const meshFoot = Number.isFinite(meshFootZ) ? Number(meshFootZ).toFixed(3) : 'n/a';
            const meshBounds = footBounds
                ? `${Number(footBounds.minZ).toFixed(3)}..${Number(footBounds.maxZ).toFixed(3)}`
                : 'n/a';
            this._pedDebugEl.textContent = `Z savedRoot=${dz} | heightmap raw=${hz} visual=${hvz} | YBN raw=${ryz} aligned=${yz} offset=${yoff} | selectedFloor=${gz} | demo=${dgz} | interiorFloor=${iz} | finalEye=${d.finalZ.toFixed(2)} | meshFoot=${meshFoot} bounds=${meshBounds} anchors=${playerMeshStatus?.footAnchorEntries || 0} | ${mode}${blocked}`;
        } else if (updateDebugHud && this._pedDebugEl) {
            this._pedDebugEl.textContent = '';
        }

        // Persist view state so refresh restores quickly.
        this._maybeSaveViewToStorage();
    }
    
    render() {
        const terrainWireframe = !!this.terrainWireframeMode;
        const buildingsWireframe = !!this.buildingsWireframeMode;
        const objectsWireframe = !!this.objectsWireframeMode;
        const playerWireframe = !!this.playerWireframeMode;
        const allVisibleGeometryWireframe = terrainWireframe && buildingsWireframe && objectsWireframe && (!this.showPlayer || playerWireframe);

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
        const interiorEnvironment = this.drawableStreamer?.getActiveInteriorEnvironment?.(this.timeOfDayHours) || null;
        const interiorTimecycleStrength = Math.max(0, Math.min(1, Number(interiorEnvironment?.strength) || 0));
        let fogColorLinear = _srgbToLinear3(this.fogColor || [0.6, 0.7, 0.8]);
        if (interiorTimecycleStrength > 0) {
            const interiorFog = [0.035, 0.04, 0.045];
            fogColorLinear = fogColorLinear.map((value, index) => value + (interiorFog[index] - value) * interiorTimecycleStrength * 0.7);
        }

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
                this.postFx.exposure = this.postFxExposure * (1 - interiorTimecycleStrength * 0.18);
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
        const exteriorLightScale = 1 - interiorTimecycleStrength * 0.68;
        const lightColor = [sunCol[0] * sunI * 2.5 * exteriorLightScale, sunCol[1] * sunI * 2.5 * exteriorLightScale, sunCol[2] * sunI * 2.5 * exteriorLightScale];
        // Ambient term: used as a scalar in our forward shaders and as additive irradiance in terrain deferred.
        const ambientIntensity = (0.08 + 0.35 * day01) * (1 - interiorTimecycleStrength * 0.42);

        // Draw sky gradient (atmosphere). This is a pure background pass.
        if (!allVisibleGeometryWireframe && this.atmosphereEnabled && this.skyRenderer?.ready) {
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
                fastStateRestore: !!this.spawnDistrictDemo,
            });
        }
        
        // Enable depth testing
        this.gl.enable(this.gl.DEPTH_TEST);
        
        // Driver error polling is opt-in; gl.getError() can synchronize WebGL.
        if (this.debugFrameGlErrors) {
            const error = this.gl.getError();
            if (error !== this.gl.NO_ERROR) {
                console.error('WebGL error before render:', error);
            }
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
                wireframe: terrainWireframe,
                wireframeColor: [0.0, 1.0, 0.72],
            });
        }

        if (this.trackSceneRenderer?.ready && this.trackSceneRenderer.models?.length) {
            try {
                this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, sceneFbo || null);
                this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
                this.trackSceneRenderer.render(this.camera.viewProjectionMatrix, { fastStateRestore: !!this.spawnDistrictDemo });
            } catch (error) {
                console.warn('Track scene render failed:', error);
            }
        }

        // Draw the collision/drive ribbon last so it remains visible while
        // visual-track sectors stream or contain coarser clustered geometry.
        if (this.trackRoadRenderer?.ready && this.trackRoadRenderer.vertexCount > 0) {
            try {
                this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, sceneFbo || null);
                this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
                this.trackRoadRenderer.render(this.camera.viewProjectionMatrix, { fastStateRestore: !!this.spawnDistrictDemo });
            } catch (error) {
                console.warn('Track road render failed:', error);
            }
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
                    wireframe: buildingsWireframe,
                    wireframeColor: [0.70, 0.86, 1.0],
                }
            );
        }

        // Render real models
        if (this.showModels && this.modelsInitialized && this.instancedModelRenderer?.ready) {
            // CPU HZB uses synchronous readPixels. Automatically enabling it
            // while driving introduced a GPU/CPU synchronization point every
            // other frame, exactly when stable frame pacing matters most.
            // Keep it available as an explicit diagnostic toggle only.
            const useOcclusionCulling = !!this.enableOcclusionCulling
                && !this._occlusionReadbackUnsupported;
            // Optional occlusion depth prepass into an offscreen depth buffer.
            // This MUST happen before we ask InstancedModelRenderer to cull by depth.
            if (useOcclusionCulling && this.occlusionCuller) {
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
                        // Streamed GTA drawables are the primary occluders. The earlier
                        // terrain/OBJ-only pass could not let a nearby high-rise hide the
                        // material work for city drawables behind it.
                        this.instancedModelRenderer.renderOccluderDepth?.(this.camera.viewProjectionMatrix, {
                            maxDistance: this.spawnDistrictDemo ? 160 : 130,
                            maxDrawItems: this.spawnDistrictDemo ? 96 : 48,
                            minRadius: this.spawnDistrictDemo ? 3.0 : 4.0,
                        });
                    },
                });

                // If the GPU/browser rejects *all* occlusion readback modes, auto-disable occlusion culling
                // so users don't think rendering/streaming is "stuck" (occlusion is optional).
                try {
                    const s = this.occlusionCuller.getStats?.();
                    if (s && s.readbackSupported === false) {
                        this._occlusionReadbackUnsupported = true;
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

            this._measureDrivingPhase('worldRender', () => this.instancedModelRenderer.render(this.camera.viewProjectionMatrix, this.showModels, this.camera.position, {
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
                occlusion: (useOcclusionCulling ? this.occlusionCuller : null),
                // Only baked supermesh cells have trustworthy spatial bounds. Cull
                // those commands before submission while source archetypes fail open;
                // this avoids the historical disappearing-road regression.
                coarseFrustumCulling: !!this.spawnDistrictDemo,
                coarseFrustumSafeOnly: !!this.spawnDistrictDemo,
                // Per-instance shader culling is independent of the unsafe
                // aggregate CPU culler. It keeps GPU work proportional to the
                // camera frustum without rebuilding stream residency.
                gpuFrustumCulling: !!this.spawnDistrictDemo,
                gpuFrustumPadding: this.spawnDistrictDemo ? 12.0 : 0.0,
                // CPU HZB is only allowed for compact instance aggregates.
                // Large roads/facades fail open and remain visible.
                occlusionMaxAggregateRadius: this.spawnDistrictDemo ? 26.0 : 0.0,
                fastStateRestore: !!this.spawnDistrictDemo,
                alphaToCoverageEnabled: !this.spawnDistrictDemo,
                secondaryMapDistance: this.spawnDistrictDemo
                    ? (String(this.textureStreamer?.quality || 'low').toLowerCase() === 'high'
                        ? SPAWN_DEMO_SECONDARY_MAP_DISTANCE
                        : (String(this.textureStreamer?.quality || 'low').toLowerCase() === 'medium'
                            ? SPAWN_DEMO_MED_SECONDARY_MAP_DISTANCE
                            : SPAWN_DEMO_LOW_SECONDARY_MAP_DISTANCE))
                    : Number.POSITIVE_INFINITY,
                // Nearby surfaces retain material depth; distant surfaces become a
                // diffuse-only far field. Texture mipmaps provide the stable painted
                // appearance without changing geometry or gameplay collision.
                primaryDiffuseOnly: false,
                projectionScalePx: Math.abs(Number(this.camera?.projectionMatrix?.[5]) || 0) * this.canvas.height * 0.5,
                // Cull only verified compact, low-instance meshes once they are
                // sub-pixel. Roads, buildings, and aggregate bounds fail open.
                projectedSizeSafeOnly: !!this.spawnDistrictDemo,
                minProjectedRadiusPx: this.spawnDistrictDemo ? SPAWN_DEMO_MIN_PROJECTED_PROP_RADIUS_PX : 0.0,
                // Opaque and cutout shells stay resident across the full demo.
                // At low texture quality, distant blended overlays are much more
                // expensive than their visual contribution, so clip only those
                // late passes. This never removes a building's primary geometry.
                maxAlphaDistance: this.spawnDistrictDemo && String(this.textureStreamer?.quality || 'low').toLowerCase() === 'low'
                    ? SPAWN_DEMO_LOW_ALPHA_DISTANCE : Number.POSITIVE_INFINITY,
                maxDecalDistance: this.spawnDistrictDemo && String(this.textureStreamer?.quality || 'low').toLowerCase() === 'low'
                    ? SPAWN_DEMO_LOW_DECAL_DISTANCE : Number.POSITIVE_INFINITY,
                maxAdditiveDistance: this.spawnDistrictDemo && String(this.textureStreamer?.quality || 'low').toLowerCase() === 'low'
                    ? SPAWN_DEMO_LOW_ADDITIVE_DISTANCE : Number.POSITIVE_INFINITY,
                // Budget complete distant compact-prop groups only. Building and
                // road material sets are never split or truncated.
                safeDrawBudgetOnly: !!this.spawnDistrictDemo && this.safeDrawBudgetEnabled,
                // Never split a source archetype's material set. Once a whole
                // group is outside the nearby gameplay bubble it may yield to
                // the frame budget until the player approaches it.
                groupDrawBudgetMinDistance: this.spawnDistrictDemo
                    ? SPAWN_DEMO_GROUP_BUDGET_MIN_DISTANCE
                    : Number.POSITIVE_INFINITY,
                maxDrawItems: this.spawnDistrictDemo && this.safeDrawBudgetEnabled
                    ? SPAWN_DEMO_MAX_SAFE_DRAW_ITEMS
                    : 0,
                restoreFramebuffer: sceneFbo || null,
                restoreViewportWidth: this.canvas.width,
                restoreViewportHeight: this.canvas.height,
                viewportWidth: this.canvas.width,
                viewportHeight: this.canvas.height,
                outputSrgb,
                wireframe: objectsWireframe,
                wireframeColor: [0.82, 0.92, 1.0],
            }));

            // Kick texture streaming even if the first few frames are mesh-bound or camera is far away.
            // This also helps diagnose "Tex cache stays 0" quickly: if we have submeshes with diffuse paths,
            // this will schedule loads regardless of whether the camera is currently drawing them.
            try {
                if (!this._lastTexPrefetchMs) this._lastTexPrefetchMs = 0;
                const now = performance.now();
                const textureQuality = String(this.textureStreamer?.quality || 'medium').toLowerCase();
                const highDemoQuality = this.spawnDistrictDemo && textureQuality === 'high';
                const vehicleSpeed = Math.abs(Number(this.vehicleController?.vehicle?.speed) || 0.0);
                const driving = !!this.vehicleController?.inVehicle && vehicleSpeed > 1.0;
                // Texture requests compete with terrain/chassis uploads on the
                // same main thread. Preserve smooth steering under motion and
                // complete texture residency during the natural idle windows.
                const prefetchIntervalMs = highDemoQuality ? 700 : (this.spawnDistrictDemo ? (driving ? 1500 : 1200) : 900);
                const prefetchLimit = highDemoQuality ? 256 : (this.spawnDistrictDemo ? (driving ? 48 : 96) : 64);
                if (!this.objectsWireframeMode && now - this._lastTexPrefetchMs > prefetchIntervalMs) {
                    this._lastTexPrefetchMs = now;
                    this._measureDrivingPhase('textureStreaming', () => this.instancedModelRenderer.prefetchDiffuseTextures?.(prefetchLimit, { includeSecondary: highDemoQuality }));
                }
            } catch { /* ignore */ }
        }

        // YFT child debris is dynamic presentation state. It deliberately renders
        // after the streamed world pass and outside DrawableStreamer's residency.
        if (this.showModels && this.fragmentDebrisSystem?.renderer?.ready) {
            try {
                this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, sceneFbo || null);
                this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
                this.fragmentDebrisSystem.render(this.camera.viewProjectionMatrix, this.camera.position, {
                    enabled: this.atmosphereEnabled && this.fogEnabled,
                    color: fogColorLinear,
                    start: this.fogStart,
                    end: this.fogEnd,
                    lightDir: sunDir,
                    lightColor,
                    ambientIntensity,
                    showWater: false,
                    shadowEnabled: false,
                    fastStateRestore: true,
                    restoreFramebuffer: sceneFbo || null,
                    restoreViewportWidth: this.canvas.width,
                    restoreViewportHeight: this.canvas.height,
                    viewportWidth: this.canvas.width,
                    viewportHeight: this.canvas.height,
                    outputSrgb,
                    wireframe: objectsWireframe,
                    wireframeColor: [0.96, 0.74, 0.38],
                });
            } catch (error) {
                console.warn('Fragment debris render failed:', error);
            }
        }

        if (this.spawnDistrictDemo && this.showDemoBoundary && this.demoBoundaryRenderer?.ready) {
            try {
                this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, sceneFbo || null);
                this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
                this.demoBoundaryRenderer.render(this.camera.viewProjectionMatrix, { fastStateRestore: true });
            } catch (error) {
                console.warn('Demo boundary render failed:', error);
            }
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

        // Render the player's components in their own pass so player wireframe and city/object wireframe stay independent.
        const playerMeshStatus = this._getPlayerMeshStatus();
        const vehicleMeshActive = !!this._vehicleModelMeshReady && !!this.vehicleModelRenderer?.ready;
        if (vehicleMeshActive) {
            try {
                const vehicleTextureQuality = String(this.textureStreamer?.quality || 'low').toLowerCase();
                const vehicleSpeed = Math.abs(Number(this.vehicleController?.vehicle?.speed) || 0.0);
                const vehicleDiffuseOnly = this.spawnDistrictDemo && vehicleTextureQuality === 'low' && vehicleSpeed > 1.0;
                this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, sceneFbo || null);
                this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
                this._measureDrivingPhase('vehicleRender', () => this.vehicleModelRenderer.render(this.camera.viewProjectionMatrix, true, this.camera.position, {
                    enabled: this.atmosphereEnabled && this.fogEnabled,
                    color: fogColorLinear,
                    start: this.fogStart,
                    end: this.fogEnd,
                    lightDir: sunDir,
                    lightColor,
                    ambientIntensity,
                    showWater: false,
                    shadowEnabled: false,
                    occlusion: null,
                    fastStateRestore: true,
                    restoreFramebuffer: sceneFbo || null,
                    restoreViewportWidth: this.canvas.width,
                    restoreViewportHeight: this.canvas.height,
                    viewportWidth: this.canvas.width,
                    viewportHeight: this.canvas.height,
                    outputSrgb,
                    wireframe: false,
                    // Vehicle packs contain exterior, interior, and glass shells
                    // with inconsistent authored winding. The independent vehicle
                    // pass is tiny, so favor a complete visible body over culling
                    // away a custom-car shell.
                    forceDoubleSided: true,
                    allowTextureIndexMiss: true,
                    // Custom vehicle packs currently export high LOD only. On
                    // the low demo preset keep its authored base/alpha shells
                    // but defer expensive secondary maps while moving.
                    primaryDiffuseOnly: vehicleDiffuseOnly,
                    secondaryMapDistance: vehicleDiffuseOnly ? 0.0 : Number.POSITIVE_INFINITY,
                    characterLocomotion: null,
                    vehicleWheels: {
                        spinRad: Number(this.vehicleController?.vehicle?.wheelRotationRad) || 0.0,
                        steeringRad: Number(this.vehicleController?.vehicle?.steeringRad) || 0.0,
                        byTag: this.vehicleController?.vehicle?.wheelStates || null,
                    },
                }));
                this._measureDrivingPhase('vehicleRender', () => this.vehicleModelRenderer.prefetchDiffuseTextures?.(24, {
                    allowIndexMiss: true,
                    includeSecondary: !vehicleDiffuseOnly,
                }));
            } catch (error) {
                console.warn('Vehicle model render failed:', error);
            }
        }

        if (this._cokePlantModelActive && this.cokePlantModelRenderer?.ready) {
            try {
                this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, sceneFbo || null);
                this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
                this.cokePlantModelRenderer.render(this.camera.viewProjectionMatrix, true, this.camera.position, {
                    enabled: this.atmosphereEnabled && this.fogEnabled,
                    color: fogColorLinear,
                    start: this.fogStart,
                    end: this.fogEnd,
                    lightDir: sunDir,
                    lightColor,
                    ambientIntensity,
                    showWater: false,
                    shadowEnabled: false,
                    occlusion: null,
                    fastStateRestore: true,
                    restoreFramebuffer: sceneFbo || null,
                    restoreViewportWidth: this.canvas.width,
                    restoreViewportHeight: this.canvas.height,
                    viewportWidth: this.canvas.width,
                    viewportHeight: this.canvas.height,
                    outputSrgb,
                    wireframe: false,
                    allowTextureIndexMiss: true,
                    characterLocomotion: null,
                    vehicleWheels: null,
                });
                this.cokePlantModelRenderer.prefetchDiffuseTextures?.(8, { allowIndexMiss: true, includeSecondary: true });
            } catch (error) {
                console.warn('Coke harvest prop render failed:', error);
            }
        }

        if (this.showNpcs && this.spawnDistrictDemo && this.npcSystem?.npcs?.length) {
            try {
                const ambientRenderers = this._ambientNpcRenderGroups.map((group) => group.renderer);
                if (this.npcModelRenderer?.ready && this._npcActiveMeshKeys.size) ambientRenderers.push(this.npcModelRenderer);
                for (const renderer of ambientRenderers) {
                    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, sceneFbo || null);
                    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
                    renderer.render(this.camera.viewProjectionMatrix, true, this.camera.position, {
                    enabled: this.atmosphereEnabled && this.fogEnabled,
                    color: fogColorLinear,
                    start: this.fogStart,
                    end: this.fogEnd,
                    lightDir: sunDir,
                    lightColor,
                    ambientIntensity,
                    showWater: false,
                    shadowEnabled: false,
                    occlusion: null,
                    fastStateRestore: true,
                    restoreFramebuffer: sceneFbo || null,
                    restoreViewportWidth: this.canvas.width,
                    restoreViewportHeight: this.canvas.height,
                    viewportWidth: this.canvas.width,
                    viewportHeight: this.canvas.height,
                    outputSrgb,
                    wireframe: false,
                    allowTextureIndexMiss: true,
                    characterLocomotion: {
                        enabled: !!this._npcAmbientLocomotion?.enabled,
                        move01: Number(this._npcAmbientLocomotion?.move01) || 0.0,
                        phase: this._npcAnimPhase,
                        gait: String(this._npcAmbientLocomotion?.gait || 'idle'),
                        stride: Number(this._npcAmbientLocomotion?.stride) || 1.0,
                        combat: null,
                    },
                    });
                    renderer.prefetchDiffuseTextures?.(24, { allowIndexMiss: true });
                }
            } catch (error) {
                console.warn('NPC render failed:', error);
            }
        }

        if (this.showNpcs && this.spawnDistrictDemo && this._npcAnimatedNpcs.length) {
            try {
                for (const npc of this._npcAnimatedNpcs) {
                    const isPolice = npc?.role === 'police';
                    const pose = this.npcSystem?.getAnimationPose?.(npc) || null;
                    // Police spend most of their approach in the hostile state, which
                    // deliberately has no combat clip. They still need a native ped
                    // draw call with locomotion, otherwise they only appear while
                    // aiming, shooting, or reacting to damage.
                    if (!pose && !isPolice) continue;
                    const modelHash = String(npc?.modelHash || '');
                    const nativeCandidate = isPolice
                        ? this.policeNpcModelRenderer
                        : this.ambientNpcModelRenderers.get(modelHash);
                    const nativeHashes = isPolice
                        ? this._policeNpcAnimationHashes
                        : [{ hash: modelHash, lod: 'high' }];
                    const nativeActiveKeys = isPolice
                        ? this._policeNpcActiveMeshKeys
                        : (this._ambientNpcActiveMeshKeys.get(modelHash) || new Set());
                    if (nativeCandidate?.ready && !this._hasCompleteNpcArchetype(nativeCandidate, nativeHashes)) {
                        this._setNpcRendererInstances(nativeCandidate, nativeActiveKeys, nativeHashes, [npc], false);
                    }
                    // Police parts arrive independently. Render the loaded body
                    // subset immediately rather than withholding the cop until
                    // the final accessory mesh is resident.
                    const nativeRenderer = this._hasRenderableNpcArchetype(nativeCandidate, nativeHashes)
                        ? nativeCandidate
                        : null;
                    const requiresNativeModel = isPolice || AMBIENT_PED_MODELS.some((model) => model.modelHash === modelHash);
                    const renderer = nativeRenderer || (!requiresNativeModel ? this.npcCombatModelRenderer : null);
                    const activeMeshKeys = isPolice
                        ? (nativeRenderer ? this._policeNpcActiveMeshKeys : this._npcCombatActiveMeshKeys)
                        : (nativeRenderer ? nativeActiveKeys : this._npcCombatActiveMeshKeys);
                    const animationHashes = nativeRenderer ? nativeHashes : this._npcAnimationHashes;
                    if (!renderer?.ready) continue;
                    this._setNpcRendererInstances(
                        renderer,
                        activeMeshKeys,
                        animationHashes,
                        [npc],
                        false,
                    );
                    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, sceneFbo || null);
                    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
                    const policeLocomotion = isPolice && !pose && !['dead', 'ragdoll', 'knocked_out'].includes(String(npc?.state || ''));
                    const policeMoving = policeLocomotion && ['hostile', 'patrol', 'retiring'].includes(String(npc?.state || ''));
                    renderer.render(this.camera.viewProjectionMatrix, true, this.camera.position, {
                        enabled: this.atmosphereEnabled && this.fogEnabled,
                        color: fogColorLinear,
                        start: this.fogStart,
                        end: this.fogEnd,
                        lightDir: sunDir,
                        lightColor,
                        ambientIntensity,
                        showWater: false,
                        shadowEnabled: false,
                        occlusion: null,
                        fastStateRestore: true,
                        restoreFramebuffer: sceneFbo || null,
                        restoreViewportWidth: this.canvas.width,
                        restoreViewportHeight: this.canvas.height,
                        viewportWidth: this.canvas.width,
                        viewportHeight: this.canvas.height,
                        outputSrgb,
                        wireframe: false,
                        allowTextureIndexMiss: true,
                        characterLocomotion: {
                            enabled: policeLocomotion,
                            move01: policeMoving ? 0.72 : 0.0,
                            phase: this._npcAnimPhase,
                            gait: policeMoving ? 'walk' : 'idle',
                            stride: policeMoving ? 0.82 : 1.0,
                            combat: pose ? {
                                armed: !!pose.armed,
                                melee: pose.melee !== false,
                                phase: pose.phase,
                                clip: pose.clip,
                                clipProgress: pose.progress,
                                progress: pose.progress,
                                blend: 1.0,
                                aiming: !!pose.aiming,
                                firing: !!pose.firing,
                            } : null,
                        },
                    });
                }
                this.npcCombatModelRenderer?.prefetchDiffuseTextures?.(64, { allowIndexMiss: true });
                this.policeNpcModelRenderer?.prefetchDiffuseTextures?.(32, { allowIndexMiss: true });
                for (const renderer of this.ambientNpcModelRenderers.values()) renderer.prefetchDiffuseTextures?.(16, { allowIndexMiss: true });
            } catch (error) {
                console.warn('Combat NPC render failed:', error);
            }
        }

        if (this.spawnDistrictDemo && this._remotePlayers.length && this.remotePlayerRenderer?.ready) {
            try {
                for (const remote of this._remotePlayers) {
                    const remoteHashes = Array.isArray(remote.appearance?.hashes) && remote.appearance.hashes.length
                        ? remote.appearance.hashes.slice(0, 32).map((hash) => String(hash)).filter(Boolean)
                        : this._remotePlayerAnimationHashes;
                    this._setNpcRendererInstances(
                        this.remotePlayerRenderer,
                        this._remotePlayerActiveMeshKeys,
                        remoteHashes,
                        [remote],
                        false,
                    );
                    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, sceneFbo || null);
                    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
                    const gait = String(remote.gait || 'idle');
                    let remoteCombat = null;
                    if (remote.dead) {
                        remoteCombat = { phase: 'dead', clip: 'melee_death_a', clipProgress: 0.96, progress: 0.96, blend: 1.0, incapacitated: true };
                    } else if (remote.meleeAttacking) {
                        const clips = { right_punch: 'melee_punch_right', left_punch: 'melee_punch_left', front_kick: 'melee_kick' };
                        remoteCombat = { armed: false, melee: true, phase: 'attack', attackType: remote.meleeAction, clip: clips[remote.meleeAction] || 'melee_punch_right', progress: Number(remote.meleeProgress) || 0, clipProgress: Number(remote.meleeProgress) || 0, blend: 1.0 };
                    } else if (remote.weaponPhase && remote.weaponPhase !== 'holstered') {
                        remoteCombat = { armed: true, phase: remote.weaponPhase, firing: !!remote.weaponFiring, aiming: remote.weaponPhase === 'equipped', blend: 1.0, clipProgress: remote.weaponFiring ? 0.35 : 1.0 };
                    }
                    const remotePhone = !remote.dead && !remote.inVehicle && remote.phone?.active
                        ? { active: true, clip: String(remote.phone.clip || ''), samplePhase: true }
                        : null;
                    const remoteTransition = !remoteCombat && !remotePhone && remote.locomotionTransition?.active
                        ? remote.locomotionTransition
                        : null;
                    this.remotePlayerRenderer.render(this.camera.viewProjectionMatrix, true, this.camera.position, {
                        enabled: this.atmosphereEnabled && this.fogEnabled,
                        color: fogColorLinear,
                        start: this.fogStart,
                        end: this.fogEnd,
                        lightDir: sunDir,
                        lightColor,
                        ambientIntensity,
                        showWater: false,
                        shadowEnabled: false,
                        occlusion: null,
                        fastStateRestore: true,
                        restoreFramebuffer: sceneFbo || null,
                        restoreViewportWidth: this.canvas.width,
                        restoreViewportHeight: this.canvas.height,
                        viewportWidth: this.canvas.width,
                        viewportHeight: this.canvas.height,
                        outputSrgb,
                        wireframe: false,
                        allowTextureIndexMiss: false,
                        characterLocomotion: {
                            enabled: !remote.dead && !remote.inVehicle && !remotePhone && (
                                Number(remote.move01) > 0.005 || !!remoteTransition?.active
                            ),
                            move01: remote.inVehicle ? 0.0 : Number(remote.move01) || 0.0,
                            phase: Number(remote.phase) || 0.0,
                            gait: remote.inVehicle ? 'idle' : gait,
                            stride: gait === 'sprint' ? 1.25 : (gait === 'walk' ? 0.72 : 1.0),
                            combat: remoteCombat,
                            gesture: remote.inVehicle ? { active: true, clip: 'sit' } : remotePhone,
                            transition: remoteTransition,
                        },
                    });
                }
                this.remotePlayerRenderer.prefetchDiffuseTextures?.(64);
            } catch (error) {
                console.warn('Remote player render failed:', error);
            }
        }

        if (this.showPlayer && playerMeshStatus.renderable && this.modelsInitialized && this.playerModelRenderer?.ready) {
            const playerAnimation = this._getPlayerAnimationForRender();
            const gait = String(playerAnimation?.gait || 'idle');
            const stride = gait === 'sprint' ? 1.25 : (gait === 'walk' ? 0.72 : 1.0);
            try {
                this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, sceneFbo || null);
                this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
            } catch { /* ignore */ }
            this.playerModelRenderer.render(this.camera.viewProjectionMatrix, true, this.camera.position, {
                enabled: this.atmosphereEnabled && this.fogEnabled,
                color: fogColorLinear,
                start: this.fogStart,
                end: this.fogEnd,
                lightDir: sunDir,
                lightColor,
                ambientIntensity,
                showWater: false,
                shadowEnabled: false,
                occlusion: null,
                fastStateRestore: true,
                restoreFramebuffer: sceneFbo || null,
                restoreViewportWidth: this.canvas.width,
                restoreViewportHeight: this.canvas.height,
                viewportWidth: this.canvas.width,
                viewportHeight: this.canvas.height,
                outputSrgb,
                wireframe: playerWireframe,
                wireframeColor: [0.82, 1.0, 0.9],
                // Custom clothing is installed from its own manifest and uses generated
                // WebP files that intentionally do not appear in the world texture index.
                allowTextureIndexMiss: true,
                characterLocomotion: playerAnimation ? {
                    enabled: !playerAnimation.gesture?.active && (
                        Number(playerAnimation.move01) > 0.005 || !!playerAnimation.transition?.active
                    ),
                    move01: playerAnimation.gesture?.active ? 0.0 : playerAnimation.move01,
                    phase: playerAnimation.phase,
                    gait,
                    stride,
                    combat: playerAnimation.combat,
                    gesture: playerAnimation.gesture,
                    transition: playerAnimation.transition,
                } : null,
            });

            try {
                if (!this.playerWireframeMode) {
                    this.playerModelRenderer.prefetchDiffuseTextures?.(48, { allowIndexMiss: true });
                }
            } catch { /* ignore */ }
        }

        // The player pass samples the current YCD palette. Update the held prop
        // immediately afterwards so it uses this frame's SKEL_R_Hand transform,
        // not the previous frame's wrist position.
        try { this._syncWeaponModelMesh(false); } catch { /* ignore */ }
        try { this._syncPhoneModelMesh(false); } catch { /* ignore */ }

        const phoneMeshActive = !!this._phoneModelMeshReady
            && !!this.phoneController?.active
            && !!this.phoneModelRenderer?.ready;
        if (phoneMeshActive) {
            try {
                this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, sceneFbo || null);
                this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
                this.phoneModelRenderer.render(this.camera.viewProjectionMatrix, true, this.camera.position, {
                    enabled: this.atmosphereEnabled && this.fogEnabled,
                    color: fogColorLinear,
                    start: this.fogStart,
                    end: this.fogEnd,
                    lightDir: sunDir,
                    lightColor,
                    ambientIntensity,
                    showWater: false,
                    shadowEnabled: false,
                    occlusion: null,
                    fastStateRestore: true,
                    restoreFramebuffer: sceneFbo || null,
                    restoreViewportWidth: this.canvas.width,
                    restoreViewportHeight: this.canvas.height,
                    viewportWidth: this.canvas.width,
                    viewportHeight: this.canvas.height,
                    outputSrgb,
                    wireframe: playerWireframe,
                    wireframeColor: [0.82, 1.0, 0.9],
                    allowTextureIndexMiss: true,
                    characterLocomotion: null,
                });
            } catch (error) {
                console.warn('Phone prop render failed:', error);
            }
        }

        const weaponMeshActive = !!this._weaponModelMeshReady
            && !!this.weaponController?.isVisible?.()
            && !!this.weaponModelRenderer?.ready;
        if (weaponMeshActive) {
            try {
                this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, sceneFbo || null);
                this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
                this.weaponModelRenderer.render(this.camera.viewProjectionMatrix, true, this.camera.position, {
                    enabled: this.atmosphereEnabled && this.fogEnabled,
                    color: fogColorLinear,
                    start: this.fogStart,
                    end: this.fogEnd,
                    lightDir: sunDir,
                    lightColor,
                    ambientIntensity,
                    showWater: false,
                    shadowEnabled: false,
                    occlusion: null,
                    fastStateRestore: true,
                    restoreFramebuffer: sceneFbo || null,
                    restoreViewportWidth: this.canvas.width,
                    restoreViewportHeight: this.canvas.height,
                    viewportWidth: this.canvas.width,
                    viewportHeight: this.canvas.height,
                    outputSrgb,
                    wireframe: playerWireframe,
                    wireframeColor: [0.82, 1.0, 0.9],
                    // This isolated FiveM weapon manifest intentionally sits outside
                    // the world texture index. Its paths are local and known, so do
                    // not let the base-world index gate its texture request.
                    allowTextureIndexMiss: true,
                    characterLocomotion: null,
                });
                if (!playerWireframe) this.weaponModelRenderer.prefetchDiffuseTextures?.(4, { allowIndexMiss: true });
            } catch (error) {
                console.warn('Glock-17 model render failed:', error);
            }
        }

        if (this.showPlayer && !this._isFirstPersonGameplayCamera() && !this.vehicleController?.inVehicle && this.ped && this.weaponRenderer?.ready) {
            try {
                this.weaponRenderer.render(this, this.camera.viewProjectionMatrix, {
                    wireframe: playerWireframe,
                    drawFallbackModel: false,
                });
            } catch (error) {
                console.warn('Weapon render failed:', error);
            }
        }
        if (this.showNpcs && this.spawnDistrictDemo && this.weaponRenderer?.ready) {
            try {
                this.weaponRenderer.renderNpcEffects(this, this.camera.viewProjectionMatrix, {
                    wireframe: false,
                });
            } catch (error) {
                console.warn('NPC weapon effects render failed:', error);
            }
        }

        // Network pickups are gameplay entities, not streamed GTA drawables. Render them
        // from their authoritative feetZ so they remain visible without model/texture assets.
        if (this.spawnDistrictDemo && this.groundPickupRenderer?.ready) {
            try {
                this.groundPickupRenderer.render(
                    this.camera.viewProjectionMatrix,
                    this.camera,
                    this.multiplayer?.pickups || [],
                    { outputSrgb, timeSeconds: performance.now() * 0.001 }
                );
            } catch (error) {
                console.warn('Ground pickup render failed:', error);
            }
        }

        // Render the spawned ped/player marker last.
        if (this.showPlayer && !this._isFirstPersonGameplayCamera() && !this.vehicleController?.inVehicle && this.ped && this.pedRenderer?.ready) {
            const dist = this.camera.getDistance();
            const pt = Math.max(6.0, Math.min(18.0, dist / 1200.0));
            const playerMeshStatus = this._getPlayerMeshStatus();
            const playerMeshReady = !!playerMeshStatus.renderable;
            if (!playerMeshReady && playerMeshStatus.fallbackVisible) {
                // Render fallback as overlay for the same reason as entity dots.
                const depthWasEnabled = this.gl.isEnabled(this.gl.DEPTH_TEST);
                if (depthWasEnabled) this.gl.disable(this.gl.DEPTH_TEST);
                if (this.player?.enabled && this.pedRenderer.renderCharacter) {
                    this.pedRenderer.renderCharacter(
                        this.camera.viewProjectionMatrix,
                        this.ped.posData,
                        Number(this.player.headingRad) || 0.0,
                        {
                            eyeHeightData: this.pedEyeHeightData,
                            color: playerWireframe ? [0.82, 1.0, 0.9, 1.0] : [0.1, 0.95, 1.0, 1.0],
                            animation: this._getPlayerAnimationForRender(),
                        }
                    );
                } else {
                    this.pedRenderer.render(this.camera.viewProjectionMatrix, pt, [0.15, 0.8, 1.0, 1.0]);
                }
                if (depthWasEnabled) this.gl.enable(this.gl.DEPTH_TEST);
            }
        }
        
        // If postFX is enabled (and active), tonemap+encode to the canvas now.
        if (postFxOn) {
            try {
                this.postFx.endScene({ canvasW: this.canvas.width, canvasH: this.canvas.height });
            } catch { /* ignore */ }
        }

        // gl.getError() can synchronize the command queue. Keep it out of the
        // gameplay frame unless explicit driver diagnostics are enabled.
        if (this.debugFrameGlErrors) {
            const errorAfter = this.gl.getError();
            if (errorAfter !== this.gl.NO_ERROR) {
                console.error('WebGL error after render:', errorAfter);
                try {
                    const e = this.instancedModelRenderer?._lastGlError || null;
                    if (e) console.error('InstancedModelRenderer last GL error detail:', e);
                } catch { /* ignore */ }
            }
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
        let occCull = null;
        try { occCull = this.occlusionCuller?.getStats?.() || null; } catch { occCull = null; }
        const mesh = this.modelManager?.getMeshCacheStats?.() || null;
        const tex = this.textureStreamer?.getStats?.() || null;

        const lines = [];
        lines.push(`Frame: ${dtMs.toFixed(2)} ms  |  FPS(avg): ${fpsAvg.toFixed(1)}${Number.isFinite(gpuMs) ? `  |  GPU: ${gpuMs.toFixed(2)} ms` : ''}`);
        lines.push(
            `CPU: update=${Number(this._cpuUpdateMs || 0).toFixed(2)} ms  ` +
            `render=${Number(this._cpuRenderMs || 0).toFixed(2)} ms  ` +
            `frame=${Number(this._cpuFrameMs || 0).toFixed(2)} ms`
        );
        const drivePerf = this.drivingPerformance?.getSnapshot?.() || null;
        if (drivePerf?.sampleCount) {
            const cpu95 = Number(drivePerf.cpu?.p95Ms);
            const gpu95 = Number(drivePerf.gpu?.p95Ms);
            lines.push(
                `Drive p95: cpu=${Number.isFinite(cpu95) ? cpu95.toFixed(2) : 'n/a'}/${Number(drivePerf.cpu?.budgetMs || 10).toFixed(0)}ms ` +
                `gpu=${Number.isFinite(gpu95) ? gpu95.toFixed(2) : 'n/a'}/${Number(drivePerf.gpu?.budgetMs || 12).toFixed(0)}ms ` +
                `samples=${drivePerf.sampleCount}`
            );
            const phaseText = Object.entries(drivePerf.phases || {})
                .sort((a, b) => Number(b[1]?.p95Ms || 0) - Number(a[1]?.p95Ms || 0))
                .slice(0, 4)
                .map(([name, phase]) => `${name}=${Number(phase?.p95Ms || 0).toFixed(2)}`)
                .join(' ');
            if (phaseText) lines.push(`Drive phases p95: ${phaseText}`);
        }

        if (r) {
            lines.push(
                `Models: draws=${r.drawCalls ?? 0} items=${r.drawItems ?? 0} ` +
                `buckets=${r.bucketDraws ?? 0} submeshes=${r.submeshDraws ?? 0} ` +
                `frustumGroups=${r.coarseFrustumCulled ?? 0}/${r.spatialCullEligible ?? 0} subpixelGroups=${r.projectedSizeCulled ?? 0} ` +
                `latePassGroups=${r.latePassCulled ?? 0} budgetGroups=${r.budgetCulled ?? 0}/${r.budgetEligible ?? 0} cap=group-safe`
            );
            lines.push(`        inst=${r.instances ?? 0} tris≈${r.triangles ?? 0}${occ ? `  |  occ tested=${occ.tested ?? 0} culled=${occ.culled ?? 0} depth=${occ.depthDraws ?? 0}` : ''}`);
            lines.push(
                `        render stages: setup=${Number(r.setupMs || 0).toFixed(2)}ms ` +
                `commands=${Number(r.commandBuildMs || 0).toFixed(2)}ms ` +
                `submit=${Number(r.submitMs || 0).toFixed(2)}ms ` +
                `total=${Number(r.totalRenderMs || 0).toFixed(2)}ms`
            );
            lines.push(
                `        passes: opaque=${r.opaqueDrawItems ?? 0} cutout=${r.cutoutDrawItems ?? 0} ` +
                `decal=${r.decalDrawItems ?? 0} alpha=${r.alphaDrawItems ?? 0} additive=${r.additiveDrawItems ?? 0}`
            );
            // Texture diagnostics:
            if (r.diffuseWanted !== undefined) {
                lines.push(
                    `        tex(diffuse): wanted=${r.diffuseWanted ?? 0} real=${r.diffuseReal ?? 0} ` +
                    `placeholder=${r.diffusePlaceholder ?? 0} missingIndex=${r.diffuseMissingFromIndex ?? 0} ` +
                    `missingUvItems=${r.drawItemsMissingUv ?? 0}`
                );
                if ((r.diffuseMissingFromIndex ?? 0) > 0 && Array.isArray(r.diffuseMissingFromIndexTop) && r.diffuseMissingFromIndexTop.length) {
                    const top = r.diffuseMissingFromIndexTop
                        .slice(0, 5)
                        .map((x) => `${x.hash || x.rel}x${x.count ?? 0}`)
                        .join(', ');
                    lines.push(`        tex missingIndex top: ${top}`);
                }
            }
            if (occCull && this.enableOcclusionCulling) {
                lines.push(
                    `        hzb=${occCull.hzbBuilt ? 'on' : 'off'} levels=${occCull.hzbLevels ?? 0} ` +
                    `hzbCulled=${occCull.hzbCulled ?? 0}/${occCull.hzbTests ?? 0} ` +
                    `kept=${occCull.temporalKeeps ?? 0} build=${Number(occCull.lastHzbBuildMs ?? 0).toFixed(2)}ms`
                );
            }
        } else {
            lines.push('Models: n/a');
        }

        if (mesh) {
            lines.push(`Mesh cache: count=${mesh.count ?? 0}  bytes≈${this._formatBytes(mesh.approxBytes ?? 0)} / ${this._formatBytes(mesh.maxBytes ?? 0)}  evict=${mesh.evictions ?? 0}`);
        }
        const meshLoads = this.instancedModelRenderer?.getMeshLoadStats?.() || null;
        if (meshLoads) {
            lines.push(
                `Mesh queue: ready=${meshLoads.completed ?? 0} queued=${meshLoads.queued ?? 0} deferred=${meshLoads.deferred ?? 0} ` +
                `scan=${meshLoads.priorityScanned ?? 0}/${Number(meshLoads.priorityMs || 0).toFixed(2)}ms sort=${Number(meshLoads.sortMs || 0).toFixed(2)}ms`
            );
        }
        if (tex) {
            lines.push(
                `Tex cache: resident=${tex.textures ?? 0} entries=${tex.cacheEntries ?? 0} loading=${tex.loading ?? 0} ` +
                `bytes≈${this._formatBytes(tex.bytes ?? 0)} / ${this._formatBytes(tex.maxBytes ?? 0)} evict=${tex.evictions ?? 0}`
            );
            lines.push(
                `Tex stream: inFlight=${tex.loadsInFlight ?? 0}/${tex.maxLoadsInFlight ?? 0} ` +
                `requests=${tex.lastFrameRequests ?? 0} touches=${tex.lastFrameTouches ?? 0} missing404=${tex.missing404 ?? 0}`
            );
            if (tex.lastErrorUrl || tex.lastErrorMsg) {
                const u = tex.lastErrorUrl ? String(tex.lastErrorUrl) : 'n/a';
                const m = tex.lastErrorMsg ? String(tex.lastErrorMsg) : 'n/a';
                lines.push(`Tex lastError: ${u} | ${m}`);
            }
        }

        const collision = this.collisionWorld?.ybnGround || null;
        if (collision) {
            const grounding = this._pedGroundingDebug || null;
            const ped = this.ped?.posData || null;
            const feetZ = ped ? Number(ped[2]) - Number(this.pedEyeHeightData || 1.2) : NaN;
            const overlapsWall = ped
                ? !!this.collisionWorld?._firstYbnWallHit?.(Number(ped[0]), Number(ped[1]), feetZ, 0.38, 1.8, 1.15)
                : false;
            lines.push(
                `Collision: tris=${Math.floor((collision.indices?.length || 0) / 3)} ` +
                `walls=${collision.wallGrid?.triangleCount ?? 0} cells=${collision.wallGrid?.cells?.size ?? 0} ` +
                `assets=${this.collisionWorld?.assetColliderCount ?? 0} props=${this.collisionWorld?.drawableCollisionProxyCount ?? 0} ` +
                `overlap=${overlapsWall ? 'yes' : 'no'} blocked=${grounding?.blocked ? 'yes' : 'no'} ` +
                `reason=${grounding?.blockReason || 'none'}`
            );
        }

        el.textContent = lines.join('\n');
    }
    
    animate() {
        const frameStart = performance.now();
        const vehicleAtFrameStart = this.vehicleController?.vehicle || null;
        this.drivingPerformance?.beginFrame?.({ driving: !!this.vehicleController?.inVehicle });
        this.update();
        const renderStart = performance.now();
        this._cpuUpdateMs = renderStart - frameStart;
        this.render();
        const frameEnd = performance.now();
        this._cpuRenderMs = frameEnd - renderStart;
        this._cpuFrameMs = frameEnd - frameStart;
        const vehicle = this.vehicleController?.vehicle || vehicleAtFrameStart;
        this.drivingPerformance?.endFrame?.({
            cpuMs: this._cpuFrameMs,
            gpuMs: this._gpuTimer?.lastMs,
            speedMps: Math.abs(Number(vehicle?.speed) || 0),
            drawCalls: this.instancedModelRenderer?.getRenderStats?.()?.drawCalls || 0,
        });
        this.drivingPerformance?.advanceBenchmarkWallTime?.(Math.max(0.001, this._perfDtMs / 1000));
        requestAnimationFrame(() => this.animate());
    }

    /**
     * Best-effort teardown to release WebGL/Worker resources when navigating away.
     * (Not all browsers guarantee this runs, but it's cheap and helps long dev sessions.)
     */
    destroy() {
        try { this.gameplayPersistence?.save?.(this, this.runtimeGameplayManifest); } catch { /* ignore */ }
        try { this.multiplayer?.destroy?.(); } catch { /* ignore */ }
        try { this.audioSystem?.destroy?.(); } catch { /* ignore */ }
        try { this.gtaHud?.destroy?.(); } catch { /* ignore */ }
        try { this.drawableStreamer?.destroy?.(); } catch { /* ignore */ }
        try { this._clearRemotePlayerMeshes(); } catch { /* ignore */ }
        try { this.remotePlayerRenderer?.destroy?.(); } catch { /* ignore */ }
        try { this._clearVehicleModelMesh(); } catch { /* ignore */ }
        try { this.vehicleModelRenderer?.destroy?.(); } catch { /* ignore */ }
        try { this._clearCokePlantMeshes(); } catch { /* ignore */ }
        try { this.cokePlantModelRenderer?.destroy?.(); } catch { /* ignore */ }
        try { this._clearPhoneModelMesh(); } catch { /* ignore */ }
        try { this.phoneModelRenderer?.destroy?.(); } catch { /* ignore */ }
        try { this._clearWeaponModelMesh(); } catch { /* ignore */ }
        try { this.weaponRenderer?.destroy?.(); } catch { /* ignore */ }
        try { this.groundPickupRenderer?.destroy?.(); } catch { /* ignore */ }
        try { this.fragmentDebrisSystem?.clear?.(); } catch { /* ignore */ }
        // We could add more teardown here later (textures, buffers, etc.) if needed.
    }
}

// Start after document load, or immediately when a cached module arrives after it.
const startApplication = () => {
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
        window.__viewerDrivePerf = () => app.drivingPerformance?.getSnapshot?.() || null;
        window.__viewerDriveBenchmark = () => app.drivingPerformance?.getBenchmark?.() || null;
        window.__viewerStartDriveBenchmark = (options = {}) => {
            const vehicle = app.vehicleController?.vehicle;
            if (!app.vehicleController?.inVehicle || !vehicle) {
                throw new Error('Enter a demo vehicle before starting the driving benchmark.');
            }
            return app.drivingPerformance?.startBenchmark?.({
                seconds: Number(options?.seconds) || 60,
                label: options?.label || 'demo-drive-route',
                autoDrive: options?.autoDrive !== false,
            }) || null;
        };
        window.__viewerCancelDriveBenchmark = () => app.drivingPerformance?.cancelBenchmark?.() || null;
        window.__webglgtaMloRuntime = {
            getStatus: () => app.drawableStreamer?.getInteriorRuntimeStatus?.() || null,
            getEntitySets: (parentGuid = null) => app.drawableStreamer?.getMloEntitySets?.(parentGuid) || [],
            activateEntitySet: (interior, set) => app.drawableStreamer?.setMloEntitySetEnabledForInterior?.(interior, set, true) || 0,
            deactivateEntitySet: (interior, set) => app.drawableStreamer?.setMloEntitySetEnabledForInterior?.(interior, set, false) || 0,
            clearEntitySetOverrides: (parentGuid = null) => app.drawableStreamer?.clearMloEntitySetOverrides?.(parentGuid),
            getAcousticPath: (source, listener) => app.drawableStreamer?.getMloAcousticPath?.(source, listener) || null,
        };
        if (new URLSearchParams(window.location.search).get('mloRuntime') === '1') {
            const runMloProbe = (position) => {
                if (!Array.isArray(position)) return;
                const state = app.drawableStreamer?.getInteriorStateAtDataPos?.(position, { includeExterior: true });
                const environment = state && !state.isExterior
                    ? (() => {
                        const previous = app.drawableStreamer._activeInterior;
                        app.drawableStreamer._activeInterior = state;
                        const value = app.drawableStreamer.getActiveInteriorEnvironment?.(app.timeOfDayHours) || null;
                        app.drawableStreamer._activeInterior = previous;
                        return value;
                    })()
                    : null;
                document.documentElement.dataset.mloProbe = JSON.stringify(state ? {
                    parentGuid: state.parentGuid,
                    archetypeHash: state.archHash,
                    roomIndex: state.roomIndex,
                    roomName: state.roomName,
                    exterior: state.isExterior,
                    visibleRooms: Array.from(state.visibleRooms || []).sort((a, b) => a - b),
                    environment,
                } : null);
            };
            window.addEventListener('webglgta:mlo-probe', (event) => {
                let position = event?.detail?.position;
                if (!Array.isArray(position)) {
                    try { position = JSON.parse(document.documentElement.dataset.mloProbePosition || 'null'); } catch { position = null; }
                }
                runMloProbe(position);
            });
            document.getElementById('teleportCoords')?.addEventListener('input', (event) => {
                const value = String(event.target?.value || '').trim();
                if (!value.startsWith('[')) return;
                try { runMloProbe(JSON.parse(value)); } catch { /* normal teleport input */ }
            });
        }
        window.__viewerPickupStatus = () => ({
            renderer: { ...(app.groundPickupRenderer?.lastStatus || {}) },
            pickups: (app.multiplayer?.pickups || []).map((pickup) => ({
                id: pickup.id,
                type: pickup.type,
                available: pickup.available !== false,
                position: [pickup.x, pickup.y, pickup.feetZ],
            })),
        });
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
        window.__viewerPlayerStatus = () => {
            try { return app?._getPlayerMeshStatus?.() || null; } catch { return null; }
        };
        window.__viewerShoeStatus = () => {
            try {
                const component = app?._activeRuntimeCharacterComponents?.()
                    ?.find?.((entry) => Number(entry?.componentId ?? entry?.component_id ?? entry?.id) === 6) || null;
                const hash = String(component?.assetHash || '').trim();
                const playerStatus = app?._getPlayerMeshStatus?.() || null;
                const renderEntry = playerStatus?.entries?.find?.((entry) => Number(entry?.componentId) === 6) || null;
                const manifestEntry = hash ? app?.modelManager?.manifest?.meshes?.[hash] : null;
                return {
                    schema: 'webglgta-shoe-status-v1',
                    component: component ? {
                        componentId: 6,
                        drawable: Number(component.drawable),
                        texture: Number(component.texture),
                        collection: String(component.collection || ''),
                        itemId: String(component.itemId || ''),
                        variantKey: String(component.variantKey || ''),
                        assetName: String(component.assetName || ''),
                        assetHash: hash,
                    } : null,
                    customManifestSources: Array.from(app?.runtimeCustomClothingManifests?.keys?.() || []),
                    manifestReady: !!manifestEntry,
                    manifestComponent: manifestEntry?.pedComponent || null,
                    manifestSubmeshes: manifestEntry?.lods?.[String(app?.player?.lod || 'high').toLowerCase()]?.submeshes?.length || 0,
                    renderEntry,
                    playerRenderable: !!playerStatus?.renderable,
                    playerReady: !!playerStatus?.ready,
                };
            } catch {
                return null;
            }
        };
        window.__viewerWeaponAnimationDiagnostics = () => {
            try {
                const hand = app?._getWeaponRightHandMatrix?.();
                const model = app?._weaponModelMat;
                return {
                    schema: 'webglgta-weapon-animation-diagnostics-v3',
                    characterPose: app?.weaponController?.getCharacterPose?.() || null,
                    weapon: app?.weaponController?.getStatus?.() || null,
                    renderer: app?.playerModelRenderer?.getWeaponAnimationDiagnostics?.() || null,
                    attachment: {
                        hand: hand ? [hand[12], hand[13], hand[14]] : null,
                        model: model ? [model[12], model[13], model[14]] : null,
                        mountedTo: 'SKEL_R_Hand',
                    },
                };
            } catch {
                return null;
            }
        };
        window.__viewerNpcStatus = () => {
            try { return app?._getNpcMeshStatus?.() || null; } catch { return null; }
        };
        window.__viewerMeleeDiagnostics = () => {
            try {
                return {
                    schema: 'webglgta-melee-diagnostics-v1',
                    status: app?.meleeController?.getStatus?.() || null,
                    playerCombat: app?._getPlayerCharacterLocomotion?.()?.combat || null,
                    meleeAnimations: {
                        loaded: !!app?._meleeAnimationsLoaded,
                        unavailable: !!app?._meleeAnimationsUnavailable,
                    },
                };
            } catch {
                return null;
            }
        };
        window.__viewerVehicleStatus = () => {
            try {
                const state = app?.vehicleController?.getRenderState?.() || null;
                return {
                    schema: 'webglgta-vehicle-status-v1',
                    state,
                    distanceToPlayer: app?.vehicleController?.getDistanceToPlayer?.() ?? null,
                    prompt: app?.vehicleController?.getPrompt?.() || '',
                    meshReady: !!app?._vehicleModelMeshReady,
                    rendererReady: !!app?.vehicleModelRenderer?.ready,
                    meshStatus: app?._vehicleModelMeshStatus || null,
                    lastEvent: app?.vehicleController?.lastEvent || '',
                    lastCollision: app?.vehicleController?.lastCollision || null,
                    audio: app?.audioSystem?.getVehicleAudioStatus?.() || null,
                };
            } catch {
                return null;
            }
        };
        window.__viewerVehicleDiagnostics = {
            start: (label = 'manual') => app?.vehicleController?.startDiagnostics?.(label) || null,
            stop: () => app?.vehicleController?.stopDiagnostics?.() || null,
            clear: () => app?.vehicleController?.diagnostics?.clear?.(),
            snapshot: (includeSamples = true) => app?.vehicleController?.getDiagnostics?.({ includeSamples }) || null,
        };
        window.__viewerDestructibleStatus = () => {
            try {
                const manifest = app?._demoDestructibleManifest || null;
                const world = app?.collisionWorld || null;
                return {
                    schema: 'webglgta-destructible-status-v1',
                    catalogProfiles: Number(manifest?.fragmentProfileCount) || 0,
                    catalogInstances: Number(manifest?.destructibleInstanceCount) || 0,
                    active: world?.destructibles?.size ?? 0,
                    destroyed: world?.destroyedDestructibleIds?.size ?? 0,
                    staticAssetColliders: world?.assetColliderCount ?? 0,
                    suppressedHashes: app?.drawableStreamer?._suppressedInstancesByHash?.size ?? 0,
                    debris: app?.fragmentDebrisSystem?.getStatus?.() || null,
                };
            } catch {
                return null;
            }
        };
        window.__viewerGroundingStatus = () => {
            try {
                const ps = app?._getPlayerMeshStatus?.() || null;
                const ped = app?.ped?.posData || null;
                const eye = Number(app?.pedEyeHeightData) || 0.0;
                return {
                    schema: 'webglgta-grounding-status-v1',
                    ped: ped ? {
                        posData: [Number(ped[0]), Number(ped[1]), Number(ped[2])],
                        eyeHeightData: eye,
                        feetZ: Number(ped[2]) - eye,
                    } : null,
                    grounding: app?._pedGroundingDebug || null,
                    playerMesh: {
                        ready: !!ps?.ready,
                        footLocalZ: app?._getPlayerMeshFootLocalZData?.(ps) ?? 0.0,
                        contactBoundsData: ps?.contactBoundsData || null,
                        footAnchorEntries: ps?.footAnchorEntries || 0,
                        localBoundsData: ps?.localBoundsData || null,
                        entries: Array.isArray(ps?.entries) ? ps.entries.map((e) => ({
                            label: e.label,
                            componentId: e.componentId,
                            footAnchor: !!e.footAnchor,
                            loadedReal: e.loadedReal,
                            localBoundsData: e.localBoundsData || null,
                        })) : [],
                    },
                };
            } catch {
                return null;
            }
        };
        window.__viewerSetRuntimeComponentEnabled = (componentId, enabled) => {
            try {
                const id = Number(componentId);
                if (!Number.isFinite(id)) return false;
                if (!(app.runtimeCharacterDisabledComponentIds instanceof Set)) {
                    app.runtimeCharacterDisabledComponentIds = new Set();
                }
                if (enabled) app.runtimeCharacterDisabledComponentIds.delete(id);
                else app.runtimeCharacterDisabledComponentIds.add(id);
                app._renderRuntimeAppearanceComponents?.();
                app._applyPlayerRenderTargetsFromProfileOrUi?.({ preserveStored: true });
                if (app.player?.enabled) app._syncPlayerEntityMesh?.(true);
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

        window.__viewerLastAssetPick = () => {
            try {
                return app?._lastAssetInspectorReport || app?.instancedModelRenderer?.getLastPickReport?.() || null;
            } catch {
                return null;
            }
        };

        window.__viewerCopyLastAssetPick = async () => {
            try {
                return await app?._copyAssetInspectorMetadata?.();
            } catch {
                return false;
            }
        };
    } catch {
        // ignore
    }
};
if (document.readyState === 'loading') window.addEventListener('load', startApplication, { once: true });
else startApplication();

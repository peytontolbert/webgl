// Import gl-matrix
import * as glMatrix from 'gl-matrix';
import { Camera } from './camera.js';
import { TerrainRenderer } from './terrain_renderer.js';
import { EntityPointsRenderer } from './entity_points_renderer.js';
import { EntityBoxesRenderer } from './entity_boxes_renderer.js';
import { ModelManager } from './model_manager.js';
import { InstancedModelsRenderer } from './instanced_models_renderer.js';

export class App {
    constructor(canvas) {
        this.canvas = canvas;
        this.statusEl = document.getElementById('status');
        this.setStatus('Starting…');
        
        // Get WebGL context with error checking
        this.gl = canvas.getContext('webgl2');
        if (!this.gl) {
            console.error('WebGL 2 not supported, falling back to WebGL 1');
            this.gl = canvas.getContext('webgl');
            if (!this.gl) {
                console.error('Failed to get WebGL context');
                this.setStatus('Error: failed to create WebGL context (WebGL not supported?)');
                return;
            }
        }
        console.log('WebGL context created successfully');
        this.installGlobalErrorHandlers();
        
        // Initialize camera first
        this.camera = new Camera();
        console.log('Camera initialized');
        
        // Initialize terrain renderer
        this.terrainRenderer = new TerrainRenderer(this.gl);
        console.log('Terrain renderer initialized');

        // Entity placement points (optional)
        this.entitiesEnabled = true;
        this.entityPoints = new EntityPointsRenderer(this.gl);
        this.entityBoxesEnabled = true;
        this.entityBoxes = new EntityBoxesRenderer(this.gl);

        // Real meshes (best-effort) exported into assets/models/*.bin + assets/models/manifest.json
        this.realMeshesEnabled = true;
        this.modelManager = new ModelManager(this.gl);
        this.instancedModels = new InstancedModelsRenderer(this.gl, this.modelManager);
        this.modelsManifestLoaded = false;
        // Entity streaming sources:
        // - preferred: assets/entities_index.json + assets/entities_chunks/*.jsonl (client-like chunk streaming)
        // - fallback: assets/ymap/index.json + assets/ymap/entities/*.json (legacy, slower)
        this.entitiesIndex = null;
        this.entitiesChunkLoaded = new Map(); // chunkKey -> { lastUsedTs }
        this.entitiesChunkLoading = new Set();

        this.ymapIndex = null;
        this.ymapLoaded = new Map(); // file -> { lastUsedTs }
        this.ymapLoading = new Set();
        this._lastYmapUpdateTs = 0;
        this._lastDebugUiTs = 0;
        this._lastWantedCount = 0;
        this._lastBoxesCount = 0;
        this.terrainHasTextureInfo = false;
        
        // Load terrain mesh and textures
        this.initializeTerrain();
        
        // Set initial canvas size after camera is initialized
        this.resize();
        
        // Setup event listeners
        this.setupEventListeners();
        
        // Start animation loop
        this.animate();
    }

    setStatus(message, { isError = false, autoHideMs = 0 } = {}) {
        if (!this.statusEl) return;
        this.statusEl.textContent = message;
        this.statusEl.style.borderColor = isError ? 'rgba(255, 80, 80, 0.55)' : 'rgba(255, 255, 255, 0.15)';
        this.statusEl.classList.remove('hidden');
        if (autoHideMs > 0) {
            clearTimeout(this._statusTimer);
            this._statusTimer = setTimeout(() => {
                this.statusEl?.classList.add('hidden');
            }, autoHideMs);
        }
    }

    installGlobalErrorHandlers() {
        window.addEventListener('error', (e) => {
            const msg = e?.message || 'Unknown error';
            this.setStatus(`Error: ${msg}`, { isError: true });
        });
        window.addEventListener('unhandledrejection', (e) => {
            const reason = e?.reason?.message || String(e?.reason || 'Unknown rejection');
            this.setStatus(`Unhandled promise rejection: ${reason}`, { isError: true });
        });
    }
    
    async initializeTerrain() {
        try {
            this.setStatus('Loading terrain…');
            // Load terrain mesh first
            const ok = await this.terrainRenderer.loadTerrainMesh();
            
            if (!ok) {
                this.setStatus('Error: failed to load terrain mesh (see console for details)', { isError: true });
                return;
            }

            // Optional: textures (the renderer will still draw without them)
            await this.loadTextures();

            // Non-fatal: entity placements (points). This is NOT model geometry; it's just placements.
            await this.initializeEntityPlacements();

            // Critical: reset camera to the actual terrain extents so streaming selects nearby YMAPs.
            this.resetCameraToTerrain();

            this.setStatus('Ready (drag to rotate, wheel to zoom, WASD/QE to move)', { autoHideMs: 3500 });
        } catch (error) {
            console.error('Failed to initialize terrain:', error);
            this.setStatus(`Error initializing terrain: ${error?.message || error}`, { isError: true });
        }
    }

    resetCameraToTerrain() {
        try {
            const tr = this.terrainRenderer;
            const mm = tr?.modelMatrix;
            if (!tr || !mm || !tr.terrainBounds || !tr.terrainSize) return;

            const b = tr.terrainBounds;
            const s = tr.terrainSize;
            const cx = b[0] + s[0] * 0.5;
            const cy = b[1] + s[1] * 0.5;
            const cz = b[2] + s[2] * 0.5;

            // Put camera in data-space a bit "south" and above center, then convert to viewer-space.
            const sceneDiam = Math.max(s[0], s[1], s[2]);
            const dist = Math.max(sceneDiam * 1.1, 4000.0);
            const height = Math.max(s[2] * 3.0, 2500.0);

            const posData = glMatrix.vec4.fromValues(cx, cy - dist, cz + height, 1.0);
            const tgtData = glMatrix.vec4.fromValues(cx, cy, cz, 1.0);
            const posView = glMatrix.vec4.create();
            const tgtView = glMatrix.vec4.create();
            glMatrix.vec4.transformMat4(posView, posData, mm);
            glMatrix.vec4.transformMat4(tgtView, tgtData, mm);

            this.camera.setZoomBoundsForSceneDiameter(sceneDiam);
            this.camera.setLookAt([posView[0], posView[1], posView[2]], [tgtView[0], tgtView[1], tgtView[2]]);
            this.setStatus('Camera reset to terrain (streaming should load nearby entities now)', { autoHideMs: 6000 });
        } catch (e) {
            console.warn('Failed to reset camera:', e);
        }
    }

    async initializeEntityPlacements() {
        try {
            const ok = await this.entityPoints.init();
            if (!ok) {
                console.warn('EntityPointsRenderer failed to init');
                return;
            }

            const okBoxes = await this.entityBoxes.init();
            if (!okBoxes) {
                console.warn('EntityBoxesRenderer failed to init');
            }

            this.modelsManifestLoaded = await this.modelManager.init('assets/models/manifest.json');
            const okInst = await this.instancedModels.init();
            if (!okInst) {
                console.warn('InstancedModelsRenderer failed to init');
            }

            // Preferred: chunked entity streaming index (generated by scripts/build_entities_streaming_index.py)
            try {
                const r0 = await fetch('assets/entities_index.json');
                if (r0.ok) {
                    this.entitiesIndex = await r0.json();
                    const c = this.entitiesIndex?.counts?.chunks ?? 0;
                    const e = this.entitiesIndex?.counts?.entities ?? 0;
                    console.log(`Loaded entities_index.json: chunks=${c} entities=${e}`);
                    this.setStatus(
                        'Entity streaming: chunked index loaded (client-like). Next: export real meshes for nearby chunks.',
                        { autoHideMs: 9000 }
                    );
                    return;
                }
            } catch (e) {
                // fall through to ymap
            }

            // Fallback: compact ymap index (generated by setup_assets.py).
            const resp = await fetch('assets/ymap/index.json');
            if (!resp.ok) {
                console.warn('No assets/entities_index.json or assets/ymap/index.json found; entity placements disabled.');
                this.setStatus(
                    'Note: entity placements not available. Run `python setup_assets.py` to copy/link output/ymap (and entities_streaming) into assets/.',
                    { autoHideMs: 12000 }
                );
                return;
            }
            this.ymapIndex = await resp.json();
            const n = Array.isArray(this.ymapIndex?.ymaps) ? this.ymapIndex.ymaps.length : 0;
            console.log(`Loaded ymap index: ${n} entries`);

            this.setStatus(
                'Entity placements enabled (orange points). Entity “Models” are placeholder instanced cubes so you can see geometry now; full GTA meshes still need an export pipeline.',
                { autoHideMs: 12000 }
            );
        } catch (e) {
            console.warn('Failed to init entity placements:', e);
        }
    }
    
    async loadTextures() {
        try {
            console.log('Loading terrain textures...');
            
            // Load terrain info first to get texture information
            const infoResponse = await fetch('assets/terrain_info.json');
            if (!infoResponse.ok) throw new Error('Failed to load terrain info');
            
            const info = await infoResponse.json();
            
            // texture_info may be empty depending on extraction settings; that's OK.
            if (!info.texture_info || Object.keys(info.texture_info).length === 0) {
                console.warn('No texture_info found in terrain_info.json; rendering will use height-based colors');
                this.terrainHasTextureInfo = false;
                return;
            }
            this.terrainHasTextureInfo = true;
            
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
            
        } catch (error) {
            console.error('Failed to load textures:', error);
            console.error('Error stack:', error.stack);
            // Non-fatal: we can still render without textures.
            this.setStatus(`Textures failed to load (still rendering): ${error?.message || error}`, { isError: false, autoHideMs: 8000 });
        }
    }
    
    setupEventListeners() {
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
            
            this.camera.rotate(deltaX, deltaY);
            
            lastX = e.clientX;
            lastY = e.clientY;
        });
        
        this.canvas.addEventListener('mouseup', () => {
            isDragging = false;
        });
        
        // Mouse wheel
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.camera.zoom(e.deltaY * 0.001);
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
        const wireframeEl = document.getElementById('wireframe');
        if (wireframeEl && this.terrainRenderer.setWireframeMode) {
            wireframeEl.addEventListener('change', (e) => {
                this.terrainRenderer.setWireframeMode(e.target.checked);
            });
        }

        const entitiesEl = document.getElementById('entities');
        if (entitiesEl) {
            entitiesEl.addEventListener('change', (e) => {
                this.entitiesEnabled = !!e.target.checked;
                if (!this.entitiesEnabled) {
                    this.entityPoints?.clear?.();
                    this.ymapLoaded.clear();
                }
            });
        }

        const entityBoxesEl = document.getElementById('entityBoxes');
        if (entityBoxesEl) {
            entityBoxesEl.addEventListener('change', (e) => {
                this.entityBoxesEnabled = !!e.target.checked;
                if (!this.entityBoxesEnabled) {
                    this.entityBoxes?.clear?.();
                }
            });
        }

        const resetBtn = document.getElementById('resetCamera');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                this.resetCameraToTerrain();
            });
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
        // Handle keyboard input
        const moveSpeed = 0.1;
        const moveDir = glMatrix.vec3.create();
        
        if (this.keyState['w']) moveDir[2] -= moveSpeed;
        if (this.keyState['s']) moveDir[2] += moveSpeed;
        if (this.keyState['a']) moveDir[0] -= moveSpeed;
        if (this.keyState['d']) moveDir[0] += moveSpeed;
        if (this.keyState['q']) moveDir[1] += moveSpeed;
        if (this.keyState['e']) moveDir[1] -= moveSpeed;
        
        if (glMatrix.vec3.length(moveDir) > 0) {
            glMatrix.vec3.normalize(moveDir, moveDir);
            this.camera.move(moveDir);
        }

        // Entity placement streaming (throttled)
        this.updateEntityPlacements();
        this.updateDebugUi();
    }

    _cameraPosDataSpace() {
        // Convert camera from viewer space back into data-space using inverse of terrain model matrix.
        const mm = this.terrainRenderer?.modelMatrix;
        if (!mm) return null;
        const inv = glMatrix.mat4.create();
        glMatrix.mat4.invert(inv, mm);
        const v = glMatrix.vec4.fromValues(this.camera.position[0], this.camera.position[1], this.camera.position[2], 1.0);
        const out = glMatrix.vec4.create();
        glMatrix.vec4.transformMat4(out, v, inv);
        return out; // vec4
    }

    updateEntityPlacements() {
        if (!this.entitiesEnabled && !this.entityBoxesEnabled) return;

        const now = performance.now();
        if (now - this._lastYmapUpdateTs < 250) return; // 4Hz
        this._lastYmapUpdateTs = now;

        const cam = this._cameraPosDataSpace();
        if (!cam) return;
        const cx = cam[0];
        const cy = cam[1];

        // Preferred: chunk streaming
        if (this.entitiesIndex && this.entitiesIndex?.chunks) {
            const chunkSize = Number(this.entitiesIndex.chunk_size || this.entitiesIndex.chunkSize || 512) || 512;
            const centerCx = Math.floor(cx / chunkSize);
            const centerCy = Math.floor(cy / chunkSize);
            const radiusChunks = 1; // 3x3 neighborhood; keep this bounded for now
            const maxChunks = 9;

            const candidates = [];
            for (let dy = -radiusChunks; dy <= radiusChunks; dy++) {
                for (let dx = -radiusChunks; dx <= radiusChunks; dx++) {
                    const k = `${centerCx + dx}_${centerCy + dy}`;
                    const meta = this.entitiesIndex.chunks?.[k];
                    if (!meta?.file) continue;
                    candidates.push({ key: k, file: meta.file, dist2: dx * dx + dy * dy });
                }
            }
            candidates.sort((a, b) => a.dist2 - b.dist2);
            const wanted = candidates.slice(0, maxChunks);
            this._lastWantedCount = wanted.length;
            const wantedSet = new Set(wanted.map(x => x.key));

            // Unload chunks not wanted
            for (const key of Array.from(this.entitiesChunkLoaded.keys())) {
                if (!wantedSet.has(key)) {
                    this.entityPoints.deleteChunk(key);
                    this.entityBoxes.deleteChunk(key);
                    this.instancedModels.deleteChunk(key);
                    this.entitiesChunkLoaded.delete(key);
                }
            }

            for (const w of wanted) {
                const key = w.key;
                const existing = this.entitiesChunkLoaded.get(key);
                if (existing) {
                    existing.lastUsedTs = now;
                    continue;
                }
                if (this.entitiesChunkLoading.has(key)) continue;
                this.entitiesChunkLoading.add(key);

                const url = `assets/entities_chunks/${w.file}`;
                void fetch(url)
                    .then(r => {
                        if (!r.ok) throw new Error(`Failed to fetch ${url} (status=${r.status})`);
                        return r.text();
                    })
                    .then(text => {
                        const lines = (text || '').split('\n');
                        const maxEnt = 60000; // safety cap per chunk
                        const positions = new Float32Array(Math.min(lines.length, maxEnt) * 3);
                        let pn = 0;

                        const maxBoxes = 12000;
                        const instanceStride = 19; // mat4 (16) + color (3)
                        const inst = new Float32Array(maxBoxes * instanceStride);
                        let instCount = 0;

                        const tmpM = glMatrix.mat4.create();
                        const tmpR = glMatrix.mat4.create();
                        const tmpT = glMatrix.mat4.create();
                        const tmpS = glMatrix.mat4.create();
                        const q = glMatrix.quat.create();

                        // hash -> { mats: Float32Array, count, color }
                        const realByHash = new Map();

                        for (let i = 0; i < lines.length; i++) {
                            if (instCount >= maxBoxes && pn >= positions.length) break;
                            const line = lines[i].trim();
                            if (!line) continue;
                            let e;
                            try {
                                e = JSON.parse(line);
                            } catch {
                                continue;
                            }
                            const p = e?.position;
                            if (!p || p.length < 3) continue;
                            const x = Number(p[0]), y = Number(p[1]), z = Number(p[2]);
                            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

                            // Points
                            if (pn + 2 < positions.length) {
                                positions[pn++] = x;
                                positions[pn++] = y;
                                positions[pn++] = z;
                            }

                            // Cubes (debug geometry)
                            if (instCount < maxBoxes) {
                                const ah = Number(e?.archetype ?? 0) >>> 0;
                                // Rotation is [w,x,y,z] in our export
                                const rwxyz = e?.rotation;
                                if (rwxyz && rwxyz.length >= 4) {
                                    glMatrix.quat.set(q, Number(rwxyz[1]) || 0, Number(rwxyz[2]) || 0, Number(rwxyz[3]) || 0, Number(rwxyz[0]) || 1);
                                    glMatrix.quat.normalize(q, q);
                                } else {
                                    glMatrix.quat.identity(q);
                                }
                                const sc = e?.scale;
                                const base = 1.0;
                                const sx = (Number(sc?.[0]) || 1) * base;
                                const sy = (Number(sc?.[1]) || 1) * base;
                                const sz = (Number(sc?.[2]) || 1) * base;

                                glMatrix.mat4.fromTranslation(tmpT, [x, y, z]);
                                glMatrix.mat4.fromQuat(tmpR, q);
                                glMatrix.mat4.fromScaling(tmpS, [sx, sy, sz]);
                                glMatrix.mat4.multiply(tmpM, tmpT, tmpR);
                                glMatrix.mat4.multiply(tmpM, tmpM, tmpS);

                                const cr = 0.25 + (((ah * 2654435761) >>> 0) % 255) / 255 * 0.75;
                                const cg = 0.25 + (((ah * 1597334677) >>> 0) % 255) / 255 * 0.75;
                                const cb = 0.25 + (((ah * 3812015801) >>> 0) % 255) / 255 * 0.75;

                                const off = instCount * instanceStride;
                                for (let k = 0; k < 16; k++) inst[off + k] = tmpM[k];
                                inst[off + 16] = cr;
                                inst[off + 17] = cg;
                                inst[off + 18] = cb;
                                instCount++;

                                // Real mesh instancing: only if manifest has this archetype hash
                                const hashStr = String(ah);
                                if (this.realMeshesEnabled && this.modelsManifestLoaded && this.modelManager.hasMesh(hashStr)) {
                                    let rec = realByHash.get(hashStr);
                                    if (!rec) {
                                        rec = { mats: new Float32Array(200 * 16), count: 0, color: [cr, cg, cb] };
                                        realByHash.set(hashStr, rec);
                                    }
                                    if (rec.count < 200) {
                                        rec.mats.set(tmpM, rec.count * 16);
                                        rec.count++;
                                    }
                                }
                            }
                        }

                        const posFinal = positions.subarray(0, pn);
                        if (this.entitiesEnabled) this.entityPoints.setChunk(key, posFinal);
                        if (this.entityBoxesEnabled && instCount > 0) this.entityBoxes.setChunk(key, inst.subarray(0, instCount * instanceStride), instCount);
                        this._lastBoxesCount = instCount;

                        // Push real instances (per chunk)
                        if (this.realMeshesEnabled && this.modelsManifestLoaded) {
                            const byHash = new Map();
                            for (const [hashStr, rec] of realByHash.entries()) {
                                if (!rec || rec.count <= 0) continue;
                                byHash.set(hashStr, { mats: rec.mats, count: rec.count, color: rec.color });
                            }
                            this.instancedModels.setChunk(key, byHash);
                        }

                        this.entitiesChunkLoaded.set(key, { lastUsedTs: now });
                    })
                    .catch(e => {
                        console.warn('Failed to load entity chunk:', key, e);
                    })
                    .finally(() => {
                        this.entitiesChunkLoading.delete(key);
                    });
            }
            return;
        }

        // Fallback: YMAP streaming
        if (!this.ymapIndex || !Array.isArray(this.ymapIndex.ymaps)) return;

        // Load a small neighborhood worth of YMAP entity files.
        const radius = 1800.0; // meters in GTA data-space (bigger so you see something immediately)
        const maxFiles = 8;   // keep bounded
        const entsDir = String(this.ymapIndex.entities_dir || 'ymap/entities');

        // Find nearby ymap files by extents intersection with a square around camera.
        const minx = cx - radius, maxx = cx + radius;
        const miny = cy - radius, maxy = cy + radius;

        const candidates = [];
        for (const y of this.ymapIndex.ymaps) {
            const mn = y?.min, mx = y?.max;
            const file = y?.file;
            if (!file || !mn || !mx) continue;
            if (mx[0] < minx || mn[0] > maxx) continue;
            if (mx[1] < miny || mn[1] > maxy) continue;
            // prefer entity-rich ymaps (skip 0-entity tiles)
            const cnt = Number(y.entityCount || 0);
            if (cnt <= 0) continue;
            // distance to AABB center for sorting
            const ax = 0.5 * (mn[0] + mx[0]);
            const ay = 0.5 * (mn[1] + mx[1]);
            const dx = ax - cx, dy = ay - cy;
            candidates.push({ file, dist2: dx * dx + dy * dy });
        }
        candidates.sort((a, b) => a.dist2 - b.dist2);
        const wanted = candidates.slice(0, maxFiles).map(x => x.file);
        this._lastWantedCount = wanted.length;
        const wantedSet = new Set(wanted);

        // Unload not-wanted
        for (const file of Array.from(this.ymapLoaded.keys())) {
            if (!wantedSet.has(file)) {
                this.entityPoints.deleteChunk(file);
                this.entityBoxes.deleteChunk(file);
                this.ymapLoaded.delete(file);
            }
        }

        // Load wanted (fire-and-forget)
        for (const file of wanted) {
            const existing = this.ymapLoaded.get(file);
            if (existing) {
                existing.lastUsedTs = now;
                continue;
            }
            if (this.ymapLoading.has(file)) continue;
            this.ymapLoading.add(file);

            const url = `assets/${entsDir}/${file}`;
            void fetch(url)
                .then(r => {
                    if (!r.ok) throw new Error(`Failed to fetch ${url} (status=${r.status})`);
                    return r.json();
                })
                .then(data => {
                    const ents = data?.entities;
                    if (!Array.isArray(ents) || ents.length === 0) return;

                    // Points buffer (all entities, but may be filtered later)
                    const out = new Float32Array(ents.length * 3);
                    let n = 0;

                    // Instance cubes: cap + skip heavy procedural grass for performance.
                    const maxBoxes = 4000;
                    const instanceStride = 19; // mat4 (16) + color (3)
                    const inst = new Float32Array(maxBoxes * instanceStride);
                    let instCount = 0;

                    const tmpM = glMatrix.mat4.create();
                    const tmpR = glMatrix.mat4.create();
                    const tmpT = glMatrix.mat4.create();
                    const tmpS = glMatrix.mat4.create();
                    const q = glMatrix.quat.create();

                    // Real mesh instances, grouped by archetype hash (only for hashes that exist in manifest).
                    const realMatsByHash = new Map(); // hash -> number[] mats
                    const realCountByHash = new Map(); // hash -> count

                    for (const e of ents) {
                        const p = e?.position;
                        if (!p || p.length < 3) continue;
                        const x = Number(p[0]), y = Number(p[1]), z = Number(p[2]);
                        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

                        out[n++] = x;
                        out[n++] = y;
                        out[n++] = z;

                        if (instCount >= maxBoxes) continue;
                        const name = String(e?.archetypeName || '').toLowerCase();
                        if (name.startsWith('proc_') || name.includes('grass')) continue;

                        // Rotation is exported as [w,x,y,z] (see extract_ymaps.py). gl-matrix wants [x,y,z,w].
                        const rwxyz = e?.rotation;
                        if (rwxyz && rwxyz.length >= 4) {
                            glMatrix.quat.set(q, Number(rwxyz[1]) || 0, Number(rwxyz[2]) || 0, Number(rwxyz[3]) || 0, Number(rwxyz[0]) || 1);
                            glMatrix.quat.normalize(q, q);
                        } else {
                            glMatrix.quat.identity(q);
                        }

                        // Base cube size: pseudo-random per archetype hash to give some variety.
                        const ah = Number(e?.archetypeHash ?? 0) >>> 0;
                        const r = (ah % 97) / 97.0;
                        const base = 0.6 + r * 2.0; // 0.6..2.6 meters-ish
                        const sc = e?.scale;
                        const sx = (Number(sc?.[0]) || 1) * base;
                        const sy = (Number(sc?.[1]) || 1) * base;
                        const sz = (Number(sc?.[2]) || 1) * base;

                        glMatrix.mat4.fromTranslation(tmpT, [x, y, z]);
                        glMatrix.mat4.fromQuat(tmpR, q);
                        glMatrix.mat4.fromScaling(tmpS, [sx, sy, sz]);
                        glMatrix.mat4.multiply(tmpM, tmpT, tmpR);
                        glMatrix.mat4.multiply(tmpM, tmpM, tmpS);

                        // Color from hash (stable)
                        const cr = 0.25 + (((ah * 2654435761) >>> 0) % 255) / 255 * 0.75;
                        const cg = 0.25 + (((ah * 1597334677) >>> 0) % 255) / 255 * 0.75;
                        const cb = 0.25 + (((ah * 3812015801) >>> 0) % 255) / 255 * 0.75;

                        const off = instCount * instanceStride;
                        for (let k = 0; k < 16; k++) inst[off + k] = tmpM[k];
                        inst[off + 16] = cr;
                        inst[off + 17] = cg;
                        inst[off + 18] = cb;
                        instCount++;

                        // Best-effort real mesh instancing if we have an exported mesh for this archetype.
                        const hashStr = String(ah);
                        if (this.realMeshesEnabled && this.modelsManifestLoaded && this.modelManager.hasMesh(hashStr)) {
                            let arr = realMatsByHash.get(hashStr);
                            if (!arr) {
                                arr = [];
                                realMatsByHash.set(hashStr, arr);
                                realCountByHash.set(hashStr, 0);
                            }
                            const cur = realCountByHash.get(hashStr) || 0;
                            if (cur < 200) {
                                for (let k = 0; k < 16; k++) arr.push(tmpM[k]);
                                realCountByHash.set(hashStr, cur + 1);
                            }
                        }
                    }

                    const positions = out.subarray(0, n);
                    if (this.entitiesEnabled) this.entityPoints.setChunk(file, positions);
                    if (this.entityBoxesEnabled && instCount > 0) this.entityBoxes.setChunk(file, inst.subarray(0, instCount * instanceStride), instCount);
                    this._lastBoxesCount = instCount;

                    // Publish real mesh instances (per chunk key)
                    if (this.realMeshesEnabled && this.modelsManifestLoaded) {
                        const byHash = new Map();
                        for (const [hashStr, mats] of realMatsByHash.entries()) {
                            const cnt = realCountByHash.get(hashStr) || 0;
                            if (cnt <= 0) continue;
                            const ah = Number(hashStr) >>> 0;
                            const col = [
                                0.25 + (((ah * 2654435761) >>> 0) % 255) / 255 * 0.75,
                                0.25 + (((ah * 1597334677) >>> 0) % 255) / 255 * 0.75,
                                0.25 + (((ah * 3812015801) >>> 0) % 255) / 255 * 0.75,
                            ];
                            byHash.set(hashStr, { mats: new Float32Array(mats), count: cnt, color: col });
                        }
                        this.instancedModels.setChunk(file, byHash);
                    }
                    this.ymapLoaded.set(file, { lastUsedTs: now });
                })
                .catch(e => {
                    console.warn('Failed to load ymap entities:', file, e);
                })
                .finally(() => {
                    this.ymapLoading.delete(file);
                });
        }
    }

    updateDebugUi() {
        const now = performance.now();
        if (now - this._lastDebugUiTs < 1200) return;
        this._lastDebugUiTs = now;

        const ymapIndexCount = Array.isArray(this.ymapIndex?.ymaps) ? this.ymapIndex.ymaps.length : 0;
        const loadedFiles = this.entitiesIndex ? this.entitiesChunkLoaded.size : this.ymapLoaded.size;
        const loadingFiles = this.entitiesIndex ? this.entitiesChunkLoading.size : this.ymapLoading.size;
        const wanted = this._lastWantedCount;
        const boxes = this._lastBoxesCount;

        const meshKeys = this.modelManager?.meshKeyCount ?? 0;
        const nonProxyKeys = this.modelManager?.nonProxyMeshKeyCount ?? 0;

        this.setStatus(
            `${this.entitiesIndex ? 'Entities index: yes' : 'YMAP index: ' + ymapIndexCount} | wanted: ${wanted} | loaded: ${loadedFiles} | loading: ${loadingFiles} | last cubes: ${boxes}\n` +
            `Terrain textures metadata: ${this.terrainHasTextureInfo ? 'yes' : 'no'} | models/manifest: ${this.modelsManifestLoaded ? 'yes' : 'no'} (entries=${meshKeys}, real=${nonProxyKeys})`,
            { autoHideMs: 0 }
        );
    }
    
    render() {
        // Clear canvas with a dark gray color to make it easier to see if rendering is working
        this.gl.clearColor(0.2, 0.2, 0.2, 1.0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
        
        // Enable depth testing
        this.gl.enable(this.gl.DEPTH_TEST);
        
        // Check for WebGL errors
        const error = this.gl.getError();
        if (error !== this.gl.NO_ERROR) {
            console.error('WebGL error before render:', error);
        }
        
        // Render terrain
        this.terrainRenderer.render(this.camera.viewProjectionMatrix);

        // Render entity placements on top (points)
        if (this.entitiesEnabled && this.entityPoints && this.terrainRenderer?.modelMatrix) {
            this.entityPoints.render(this.camera.viewProjectionMatrix, this.terrainRenderer.modelMatrix, {
                pointSize: 3.0,
                color: [1.0, 0.65, 0.2, 0.9],
            });
        }

        // Render placeholder “model” cubes (instanced)
        if (this.entityBoxesEnabled && this.entityBoxes && this.terrainRenderer?.modelMatrix) {
            this.entityBoxes.render(this.camera.viewProjectionMatrix, this.terrainRenderer.modelMatrix);
        }

        // Render real meshes (if any were exported)
        if (this.realMeshesEnabled && this.modelsManifestLoaded && this.instancedModels && this.terrainRenderer?.modelMatrix) {
            void this.instancedModels.renderAll(this.camera.viewProjectionMatrix, this.terrainRenderer.modelMatrix);
        }
        
        // Check for WebGL errors after render
        const errorAfter = this.gl.getError();
        if (errorAfter !== this.gl.NO_ERROR) {
            console.error('WebGL error after render:', errorAfter);
        }
    }
    
    animate() {
        this.update();
        this.render();
        requestAnimationFrame(() => this.animate());
    }
}

// Start application when page loads
window.addEventListener('load', () => {
    const canvas = document.getElementById('glCanvas');
    new App(canvas);
}); 
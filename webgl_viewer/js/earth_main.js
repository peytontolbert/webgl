import { glMatrix } from './glmatrix.js';
import { Camera } from './camera.js';
import { ExternalDatasetRenderer } from './external_dataset_renderer.js';
import { GeoJsonLineRenderer } from './geojson_line_renderer.js';
import { SimpleMeshRenderer } from './simple_mesh_renderer.js';
import { loadExternalDatasetsManifest, loadExternalDatasetGeoJSONById, geojsonToDataSpacePoints } from './external_dataset_manager.js';

class EarthApp {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl2') || canvas.getContext('webgl');

        this._statusEl = document.getElementById('externalDatasetStatus');
        this._toggleEl = document.getElementById('showExternalDataset');
        this._selectEl = document.getElementById('externalDataset');

        if (!this.gl) {
            console.error('WebGL not supported');
            this._setStatus('WebGL not supported in this browser/GPU.');
            return;
        }

        this.camera = new Camera();
        // Start closer for “street-level-ish” debugging.
        this.camera.frameAABB([-200, 0, -200], [200, 50, 200]);

        this.keyState = {};
        this._pointerActive = false;
        this._lastX = 0;
        this._lastY = 0;

        this.datasetRenderer = new ExternalDatasetRenderer(this.gl);
        // Earth mode uses identity (no GTA data-space transforms).
        glMatrix.mat4.identity(this.datasetRenderer.modelMatrix);
        // Two line layers: roads + buildings (different colors).
        this.roadsRenderer = new GeoJsonLineRenderer(this.gl);
        this.buildingsRenderer = new GeoJsonLineRenderer(this.gl);
        glMatrix.mat4.identity(this.roadsRenderer.modelMatrix);
        glMatrix.mat4.identity(this.buildingsRenderer.modelMatrix);

        // Two mesh layers: roads (strips) + buildings (extruded walls).
        this.roadsMesh = new SimpleMeshRenderer(this.gl);
        this.buildingsMesh = new SimpleMeshRenderer(this.gl);
        glMatrix.mat4.identity(this.roadsMesh.modelMatrix);
        glMatrix.mat4.identity(this.buildingsMesh.modelMatrix);

        this.showExternalDataset = false;
        this.externalDatasetId = '';
        this._datasetLoadToken = 0;
        this._datasetPending = null; // { points: Float32Array }

        this._setupEvents();
        this.resize();
        window.addEventListener('resize', () => this.resize());

        void this._init();
    }

    _setStatus(msg) {
        if (!this._statusEl) return;
        this._statusEl.textContent = String(msg || '');
    }

    async _init() {
        await this.datasetRenderer.init();
        glMatrix.mat4.identity(this.datasetRenderer.modelMatrix);
        await this.roadsRenderer.init();
        await this.buildingsRenderer.init();
        glMatrix.mat4.identity(this.roadsRenderer.modelMatrix);
        glMatrix.mat4.identity(this.buildingsRenderer.modelMatrix);
        await this.roadsMesh.init();
        await this.buildingsMesh.init();
        glMatrix.mat4.identity(this.roadsMesh.modelMatrix);
        glMatrix.mat4.identity(this.buildingsMesh.modelMatrix);

        if (this._datasetPending?.points) {
            this.datasetRenderer.setPoints(this._datasetPending.points);
            this._datasetPending = null;
        }

        await this._populateDatasets();
        this._applyDatasetFromUi();

        this._start();
    }

    async _populateDatasets() {
        const sel = this._selectEl;
        if (!sel) return;
        try {
            const datasets = await loadExternalDatasetsManifest();
            const wanted = String(sel.value || '').trim();
            sel.textContent = '';
            for (const d of datasets) {
                const opt = document.createElement('option');
                opt.value = d.id;
                opt.textContent = d.label || d.id;
                sel.appendChild(opt);
            }
            if (datasets.length === 0) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = '(no datasets found in assets/datasets/manifest.json)';
                opt.disabled = true;
                opt.selected = true;
                sel.appendChild(opt);
                this._setStatus('Datasets manifest loaded, but it contained 0 entries.');
            } else if (wanted) {
                sel.value = wanted;
            } else {
                sel.value = datasets[0].id;
            }
            this._setStatus(`Datasets loaded: ${datasets.length}\n(If you don't see options, ensure you're on /earth.html not /index.html)`);
        } catch (e) {
            sel.textContent = '';
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '(failed to load datasets manifest)';
            opt.disabled = true;
            opt.selected = true;
            sel.appendChild(opt);
            this._setStatus(`Failed to load datasets manifest:\n${e?.message || String(e)}\n\nExpected URL: assets/datasets/manifest.json`);
        }
    }

    _setupEvents() {
        window.addEventListener('keydown', (e) => { this.keyState[String(e.key || '').toLowerCase()] = true; });
        window.addEventListener('keyup', (e) => { this.keyState[String(e.key || '').toLowerCase()] = false; });

        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
        this.canvas.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            this._pointerActive = true;
            this._lastX = e.clientX;
            this._lastY = e.clientY;
            try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        });
        this.canvas.addEventListener('pointermove', (e) => {
            if (!this._pointerActive) return;
            const dx = e.clientX - this._lastX;
            const dy = e.clientY - this._lastY;
            this.camera.rotate(dx, dy);
            this._lastX = e.clientX;
            this._lastY = e.clientY;
        });
        const stop = () => { this._pointerActive = false; };
        this.canvas.addEventListener('pointerup', stop);
        this.canvas.addEventListener('pointercancel', stop);
        this.canvas.addEventListener('pointerleave', stop);

        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.camera.zoom(e.deltaY);
        }, { passive: false });

        if (this._toggleEl) {
            this._toggleEl.addEventListener('change', () => this._applyDatasetFromUi());
        }
        if (this._selectEl) {
            this._selectEl.addEventListener('change', () => this._applyDatasetFromUi());
        }
    }

    async _applyDatasetFromUi() {
        const show = !!(this._toggleEl && this._toggleEl.checked);
        this.showExternalDataset = show;
        if (!show) {
            this.datasetRenderer.clear();
            this.roadsRenderer.clear();
            this.buildingsRenderer.clear();
            this.roadsMesh.clear();
            this.buildingsMesh.clear();
            this._setStatus('');
            return;
        }
        const id = String(this._selectEl?.value || '').trim();
        this.externalDatasetId = id;
        if (!id) {
            this.datasetRenderer.clear();
            this.roadsRenderer.clear();
            this.buildingsRenderer.clear();
            this.roadsMesh.clear();
            this.buildingsMesh.clear();
            this._setStatus('No dataset selected.');
            return;
        }

        const token = ++this._datasetLoadToken;
        this._setStatus(`Loading "${id}"…`);
        try {
            const { entry, geojson } = await loadExternalDatasetGeoJSONById(id);
            if (token !== this._datasetLoadToken) return;

            // Clear both renderers first; dataset decides which one is used.
            this.datasetRenderer.clear();
            this.roadsRenderer.clear();
            this.buildingsRenderer.clear();
            this.roadsMesh.clear();
            this.buildingsMesh.clear();

            const kind = String(entry?.kind || '');
            if (kind === 'bundle') {
                const bundleIds = Array.isArray(entry?.bundle) ? entry.bundle : [];
                if (!bundleIds.length) throw new Error('Bundle dataset has no bundle[] ids');

                // Load all bundle items first.
                const items = [];
                for (const childId of bundleIds) items.push(await loadExternalDatasetGeoJSONById(String(childId)));

                // Compute one shared origin (lon/lat) for all items so they align.
                const originLonLat = computeBundleOriginLonLat(items.map((x) => x.geojson));

                let framed = false;
                for (const { entry: childEntry, geojson: childGeo } of items) {
                    const cid = String(childEntry?.id || '');
                    const ck = String(childEntry?.kind || '');
                    if (!ck.startsWith('geojson-wgs84-lines')) continue;

                    // Debug lines:
                    const seg = geojsonToWgs84LineSegmentsLocalMeters(childGeo, { originLonLat });
                    if (cid.includes('highway')) this.roadsRenderer.setSegments(seg.segments);
                    else if (cid.includes('building')) this.buildingsRenderer.setSegments(seg.segments);
                    else this.roadsRenderer.setSegments(seg.segments);

                    // 3D meshes:
                    if (cid.includes('highway')) {
                        const mesh = geojsonWgs84ToRoadStripMesh(childGeo, { originLonLat, widthMeters: 6.0, y: 0.03 });
                        this.roadsMesh.setMesh(mesh);
                    }
                    if (cid.includes('building')) {
                        const mesh = geojsonWgs84ToBuildingWallsMesh(childGeo, { originLonLat, baseY: 0.0, defaultHeight: 24.0 });
                        this.buildingsMesh.setMesh(mesh);
                    }

                    if (!framed && seg.bounds) {
                        this._frameAABBStreet(seg.bounds.min, seg.bounds.max);
                        framed = true;
                    }
                }

                this._setStatus(`${entry.label || entry.id}\n(bundle: ${bundleIds.join(', ')})\n3D: roads strips + building walls`);
                return;
            }

            if (kind.startsWith('geojson-dataspace')) {
                const points = geojsonToDataSpacePoints(geojson);
                this.datasetRenderer.setPoints(points);
                // Frame around points if possible.
                const b = _boundsFromPoints(points);
                if (b) this.camera.frameAABB(b.min, b.max);
                this._setStatus(`${entry.label || entry.id}\npoints=${Math.floor(points.length / 3)}`);
                return;
            }

            if (kind.startsWith('geojson-wgs84-lines')) {
                const seg = geojsonToWgs84LineSegmentsLocalMeters(geojson);
                // Default: treat as roads.
                this.roadsRenderer.setSegments(seg.segments);
                // Also attempt a 3D road strip mesh (useful for highways dataset).
                try {
                    const mesh = geojsonWgs84ToRoadStripMesh(geojson, { originLonLat: seg.originLonLat, widthMeters: 6.0, y: 0.03 });
                    this.roadsMesh.setMesh(mesh);
                } catch {
                    // ignore
                }
                if (seg.bounds) this._frameAABBStreet(seg.bounds.min, seg.bounds.max);
                this._setStatus(
                    `${entry.label || entry.id}\n` +
                    `segments=${Math.floor(seg.segments.length / 6)}\n` +
                    `origin=${seg.originLonLat[0].toFixed(5)},${seg.originLonLat[1].toFixed(5)}`
                );
                return;
            }

            // Fallback: try points.
            const points = geojsonToDataSpacePoints(geojson);
            this.datasetRenderer.setPoints(points);
            const b = _boundsFromPoints(points);
            if (b) this.camera.frameAABB(b.min, b.max);
            this._setStatus(`${entry.label || entry.id}\npoints=${Math.floor(points.length / 3)}\n(kind=${kind || 'unknown'})`);
        } catch (e) {
            if (token !== this._datasetLoadToken) return;
            this.datasetRenderer.clear();
            this.roadsRenderer.clear();
            this.buildingsRenderer.clear();
            this.roadsMesh.clear();
            this.buildingsMesh.clear();
            this._setStatus(`Failed to load "${id}":\n${e?.message || String(e)}`);
        }
    }

    resize() {
        const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
        const w = Math.floor(this.canvas.clientWidth * dpr);
        const h = Math.floor(this.canvas.clientHeight * dpr);
        if (this.canvas.width !== w) this.canvas.width = w;
        if (this.canvas.height !== h) this.canvas.height = h;
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        this.camera.aspectRatio = (this.canvas.width / Math.max(1, this.canvas.height));
        this.camera.updateProjectionMatrix();
    }

    _updateMovement(dt) {
        const k = this.keyState;
        const dir = [0, 0, 0];
        if (k['w']) dir[2] += 1;
        if (k['s']) dir[2] -= 1;
        // NOTE: Camera.move() computes `right` as cross(forward, up), which points left in a
        // standard Y-up RHS. Rather than changing shared camera code (used by the GTA viewer),
        // we flip strafe mapping here for Earth mode.
        if (k['a']) dir[0] += 1;
        if (k['d']) dir[0] -= 1;
        if (k['q']) dir[1] -= 1;
        if (k['e']) dir[1] += 1;
        const len = Math.hypot(dir[0], dir[1], dir[2]);
        if (len > 1e-6) {
            dir[0] /= len; dir[1] /= len; dir[2] /= len;
            // Translate camera (move both position + target) so WASD feels like navigation,
            // not dollying toward a fixed target.
            this.camera.move(dir, dt, { keepTarget: false, flattenForward: true });
        }
    }

    _start() {
        let last = performance.now();
        const tick = () => {
            const now = performance.now();
            const dt = Math.max(0.0, Math.min(0.05, (now - last) / 1000.0));
            last = now;

            this._updateMovement(dt);
            this.render();
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    render() {
        const gl = this.gl;
        gl.clearColor(0.02, 0.02, 0.03, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);

        if (this.showExternalDataset) {
            // 3D meshes (depth-tested)
            this.roadsMesh.render(this.camera.viewProjectionMatrix, { color: [0.12, 0.75, 0.35, 0.95], lightDir: [0.35, 0.85, 0.25] });
            // Disable culling for building walls so they don't disappear due to winding/orientation quirks.
            this.buildingsMesh.render(this.camera.viewProjectionMatrix, { color: [0.85, 0.78, 0.40, 0.95], lightDir: [0.35, 0.85, 0.25], cull: false });

            // Debug overlays (no depth)
            const depthWasEnabled = gl.isEnabled(gl.DEPTH_TEST);
            if (depthWasEnabled) gl.disable(gl.DEPTH_TEST);
            this.roadsRenderer.render(this.camera.viewProjectionMatrix, { color: [0.10, 1.0, 0.60, 0.35] });
            this.buildingsRenderer.render(this.camera.viewProjectionMatrix, { color: [1.00, 0.85, 0.20, 0.30] });
            const dist = this.camera.getDistance();
            const pt = Math.max(4.0, Math.min(18.0, dist / 120.0));
            this.datasetRenderer.render(this.camera.viewProjectionMatrix, { pointSize: pt, color: [0.95, 0.35, 0.95, 0.35] });
            if (depthWasEnabled) gl.enable(gl.DEPTH_TEST);
        }
    }
}

const canvas = document.getElementById('earthCanvas');
if (canvas) new EarthApp(canvas);

function _boundsFromPoints(pointsFloat32) {
    if (!pointsFloat32 || pointsFloat32.length < 3) return null;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < pointsFloat32.length; i += 3) {
        const x = pointsFloat32[i + 0];
        const y = pointsFloat32[i + 1];
        const z = pointsFloat32[i + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
    return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function geojsonToWgs84LineSegmentsLocalMeters(geojson, { maxSegments = 800000, originLonLat = null } = {}) {
    // Compute lon/lat bounds and choose an origin.
    const bbox = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
    const collectLonLat = (c) => {
        if (!c || c.length < 2) return;
        const lon = Number(c[0]);
        const lat = Number(c[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
        if (lon < bbox.minLon) bbox.minLon = lon;
        if (lat < bbox.minLat) bbox.minLat = lat;
        if (lon > bbox.maxLon) bbox.maxLon = lon;
        if (lat > bbox.maxLat) bbox.maxLat = lat;
    };
    const walkCoords = (coords, depth) => {
        if (!coords) return;
        if (depth === 0) { collectLonLat(coords); return; }
        if (Array.isArray(coords)) for (const cc of coords) walkCoords(cc, depth - 1);
    };
    const walkGeomForBounds = (g) => {
        if (!g) return;
        const t = String(g.type || '');
        const c = g.coordinates;
        if (t === 'Point') walkCoords(c, 0);
        else if (t === 'MultiPoint' || t === 'LineString') walkCoords(c, 1);
        else if (t === 'MultiLineString' || t === 'Polygon') walkCoords(c, 2);
        else if (t === 'MultiPolygon') walkCoords(c, 3);
        else if (t === 'GeometryCollection') {
            const geoms = Array.isArray(g.geometries) ? g.geometries : [];
            for (const gg of geoms) walkGeomForBounds(gg);
        }
    };
    const walkForBounds = (obj) => {
        if (!obj) return;
        const t = String(obj.type || '');
        if (t === 'FeatureCollection') {
            const feats = Array.isArray(obj.features) ? obj.features : [];
            for (const f of feats) walkForBounds(f);
            return;
        }
        if (t === 'Feature') { walkGeomForBounds(obj.geometry); return; }
        walkGeomForBounds(obj);
    };
    walkForBounds(geojson);

    const originLon = originLonLat && originLonLat.length >= 2 ? Number(originLonLat[0]) : (Number.isFinite(bbox.minLon) && Number.isFinite(bbox.maxLon) ? (bbox.minLon + bbox.maxLon) * 0.5 : 0.0);
    const originLat = originLonLat && originLonLat.length >= 2 ? Number(originLonLat[1]) : (Number.isFinite(bbox.minLat) && Number.isFinite(bbox.maxLat) ? (bbox.minLat + bbox.maxLat) * 0.5 : 0.0);
    const originLonLatOut = [originLon, originLat];
    // (returned below as originLonLat)

    // Equirectangular projection around origin (good enough for city-scale).
    const R = 6378137.0;
    const lat0 = originLat * Math.PI / 180.0;
    const cosLat0 = Math.cos(lat0);
    const toXY = (lon, lat) => {
        const x = (lon - originLon) * (Math.PI / 180.0) * R * cosLat0;
        const y = (lat - originLat) * (Math.PI / 180.0) * R;
        return [x, 0.0, y]; // Y-up; put lat into Z to match our Camera's Y-up convention.
    };

    const seg = [];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    const pushSeg = (a, b) => {
        if (seg.length >= maxSegments * 6) return;
        const lonA = Number(a[0]), latA = Number(a[1]);
        const lonB = Number(b[0]), latB = Number(b[1]);
        if (!Number.isFinite(lonA) || !Number.isFinite(latA) || !Number.isFinite(lonB) || !Number.isFinite(latB)) return;
        const pa = toXY(lonA, latA);
        const pb = toXY(lonB, latB);
        seg.push(pa[0], pa[1], pa[2], pb[0], pb[1], pb[2]);
        for (const p of [pa, pb]) {
            const x = p[0], y = p[1], z = p[2];
            if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
            if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
        }
    };

    const addLine = (coords, closed) => {
        if (!Array.isArray(coords) || coords.length < 2) return;
        for (let i = 1; i < coords.length; i++) pushSeg(coords[i - 1], coords[i]);
        if (closed) pushSeg(coords[coords.length - 1], coords[0]);
    };

    const walkGeom = (g) => {
        if (!g) return;
        const t = String(g.type || '');
        const c = g.coordinates;
        if (t === 'LineString') { addLine(c, false); return; }
        if (t === 'MultiLineString') { if (Array.isArray(c)) for (const l of c) addLine(l, false); return; }
        if (t === 'Polygon') { if (Array.isArray(c)) for (const ring of c) addLine(ring, true); return; }
        if (t === 'MultiPolygon') { if (Array.isArray(c)) for (const poly of c) if (Array.isArray(poly)) for (const ring of poly) addLine(ring, true); return; }
        if (t === 'GeometryCollection') {
            const geoms = Array.isArray(g.geometries) ? g.geometries : [];
            for (const gg of geoms) walkGeom(gg);
            return;
        }
        // Ignore points for line renderer.
    };
    const walk = (obj) => {
        if (!obj) return;
        const t = String(obj.type || '');
        if (t === 'FeatureCollection') {
            const feats = Array.isArray(obj.features) ? obj.features : [];
            for (const f of feats) walk(f);
            return;
        }
        if (t === 'Feature') { walkGeom(obj.geometry); return; }
        walkGeom(obj);
    };
    walk(geojson);

    const bounds = (Number.isFinite(minX) && Number.isFinite(maxX))
        ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] }
        : null;

    return { segments: new Float32Array(seg), bounds, originLonLat: originLonLatOut };
}

function computeBundleOriginLonLat(geojsonList) {
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    const collect = (c) => {
        if (!c || c.length < 2) return;
        const lon = Number(c[0]), lat = Number(c[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
        if (lon < minLon) minLon = lon;
        if (lat < minLat) minLat = lat;
        if (lon > maxLon) maxLon = lon;
        if (lat > maxLat) maxLat = lat;
    };
    const walkCoords = (coords, depth) => {
        if (!coords) return;
        if (depth === 0) { collect(coords); return; }
        if (Array.isArray(coords)) for (const cc of coords) walkCoords(cc, depth - 1);
    };
    const walkGeom = (g) => {
        if (!g) return;
        const t = String(g.type || '');
        const c = g.coordinates;
        if (t === 'Point') walkCoords(c, 0);
        else if (t === 'MultiPoint' || t === 'LineString') walkCoords(c, 1);
        else if (t === 'MultiLineString' || t === 'Polygon') walkCoords(c, 2);
        else if (t === 'MultiPolygon') walkCoords(c, 3);
        else if (t === 'GeometryCollection') {
            const geoms = Array.isArray(g.geometries) ? g.geometries : [];
            for (const gg of geoms) walkGeom(gg);
        }
    };
    const walk = (obj) => {
        if (!obj) return;
        const t = String(obj.type || '');
        if (t === 'FeatureCollection') {
            const feats = Array.isArray(obj.features) ? obj.features : [];
            for (const f of feats) walk(f);
            return;
        }
        if (t === 'Feature') { walkGeom(obj.geometry); return; }
        walkGeom(obj);
    };
    for (const g of geojsonList) walk(g);
    if (!Number.isFinite(minLon) || !Number.isFinite(maxLon)) return [0.0, 0.0];
    return [(minLon + maxLon) * 0.5, (minLat + maxLat) * 0.5];
}

function _projector(originLonLat) {
    const originLon = Number(originLonLat?.[0] ?? 0.0);
    const originLat = Number(originLonLat?.[1] ?? 0.0);
    const R = 6378137.0;
    const lat0 = originLat * Math.PI / 180.0;
    const cosLat0 = Math.cos(lat0);
    return {
        originLonLat: [originLon, originLat],
        toXYZ(lon, lat, y = 0.0) {
            const x = (lon - originLon) * (Math.PI / 180.0) * R * cosLat0;
            const z = (lat - originLat) * (Math.PI / 180.0) * R;
            return [x, y, z];
        },
    };
}

function geojsonWgs84ToRoadStripMesh(geojson, { originLonLat, widthMeters = 6.0, y = 0.03, maxSegments = 500000 } = {}) {
    const proj = _projector(originLonLat);
    const half = Math.max(0.5, Number(widthMeters) * 0.5);
    const pos = [];
    const nrm = [];
    let segCount = 0;

    const addQuad = (a, b) => {
        if (segCount >= maxSegments) return;
        const lonA = Number(a[0]), latA = Number(a[1]);
        const lonB = Number(b[0]), latB = Number(b[1]);
        if (!Number.isFinite(lonA) || !Number.isFinite(latA) || !Number.isFinite(lonB) || !Number.isFinite(latB)) return;
        const pa = proj.toXYZ(lonA, latA, y);
        const pb = proj.toXYZ(lonB, latB, y);
        const dx = pb[0] - pa[0];
        const dz = pb[2] - pa[2];
        const len = Math.hypot(dx, dz);
        if (len < 0.5) return;
        // Perp in XZ
        const px = -dz / len;
        const pz = dx / len;
        const ax0 = pa[0] + px * half, az0 = pa[2] + pz * half;
        const ax1 = pa[0] - px * half, az1 = pa[2] - pz * half;
        const bx0 = pb[0] + px * half, bz0 = pb[2] + pz * half;
        const bx1 = pb[0] - px * half, bz1 = pb[2] - pz * half;

        // Two triangles (ax0 -> bx0 -> bx1) and (ax0 -> bx1 -> ax1)
        pos.push(
            ax0, y, az0,
            bx0, y, bz0,
            bx1, y, bz1,
            ax0, y, az0,
            bx1, y, bz1,
            ax1, y, az1,
        );
        // Up normals
        for (let i = 0; i < 6; i++) nrm.push(0, 1, 0);
        segCount++;
    };

    const addLine = (coords) => {
        if (!Array.isArray(coords) || coords.length < 2) return;
        for (let i = 1; i < coords.length; i++) addQuad(coords[i - 1], coords[i]);
    };

    const walkGeom = (g) => {
        if (!g) return;
        const t = String(g.type || '');
        const c = g.coordinates;
        if (t === 'LineString') { addLine(c); return; }
        if (t === 'MultiLineString') { if (Array.isArray(c)) for (const l of c) addLine(l); return; }
        if (t === 'GeometryCollection') {
            const geoms = Array.isArray(g.geometries) ? g.geometries : [];
            for (const gg of geoms) walkGeom(gg);
        }
        // Ignore polygons/points here.
    };
    const walk = (obj) => {
        if (!obj) return;
        const t = String(obj.type || '');
        if (t === 'FeatureCollection') {
            const feats = Array.isArray(obj.features) ? obj.features : [];
            for (const f of feats) walk(f);
            return;
        }
        if (t === 'Feature') { walkGeom(obj.geometry); return; }
        walkGeom(obj);
    };
    walk(geojson);

    return { positions: new Float32Array(pos), normals: new Float32Array(nrm) };
}

function geojsonWgs84ToBuildingWallsMesh(geojson, { originLonLat, baseY = 0.0, defaultHeight = 12.0, maxWalls = 300000 } = {}) {
    const proj = _projector(originLonLat);
    const pos = [];
    const nrm = [];
    let wallCount = 0;

    const heightFromProps = (props, fallback, lon, lat) => {
        const p = props && typeof props === 'object' ? props : null;
        const h = p ? Number(p.height) : NaN;
        if (Number.isFinite(h) && h > 1) return h;
        const lv = p ? Number(p['building:levels']) : NaN;
        if (Number.isFinite(lv) && lv > 0) return Math.max(3.0, lv * 3.0);
        // No-placeholder mode: if we don't have real height metadata, use a fixed default.
        // (We can later improve this with landuse/type heuristics or LiDAR correction.)
        void lon; void lat;
        return fallback;
    };

    const addWall = (a, b, h) => {
        if (wallCount >= maxWalls) return;
        const lonA = Number(a[0]), latA = Number(a[1]);
        const lonB = Number(b[0]), latB = Number(b[1]);
        if (!Number.isFinite(lonA) || !Number.isFinite(latA) || !Number.isFinite(lonB) || !Number.isFinite(latB)) return;
        const p0 = proj.toXYZ(lonA, latA, baseY);
        const p1 = proj.toXYZ(lonB, latB, baseY);
        const p2 = proj.toXYZ(lonB, latB, baseY + h);
        const p3 = proj.toXYZ(lonA, latA, baseY + h);
        const dx = p1[0] - p0[0];
        const dz = p1[2] - p0[2];
        const len = Math.hypot(dx, dz);
        if (len < 0.5) return;
        // Normal (perp in XZ). Either direction is fine for lighting.
        const nx = -dz / len;
        const nz = dx / len;

        // Two triangles: p0->p1->p2 and p0->p2->p3
        pos.push(
            p0[0], p0[1], p0[2],
            p1[0], p1[1], p1[2],
            p2[0], p2[1], p2[2],
            p0[0], p0[1], p0[2],
            p2[0], p2[1], p2[2],
            p3[0], p3[1], p3[2],
        );
        for (let i = 0; i < 6; i++) nrm.push(nx, 0, nz);
        wallCount++;
    };

    const addPolygon = (rings, props) => {
        if (!Array.isArray(rings) || rings.length === 0) return;
        const outer = rings[0];
        if (!Array.isArray(outer) || outer.length < 3) return;
        // Derive height from properties + centroid-ish lon/lat.
        let lonSum = 0, latSum = 0, n = 0;
        for (const c of outer) { if (c && c.length >= 2) { lonSum += Number(c[0]) || 0; latSum += Number(c[1]) || 0; n++; } }
        const lonC = n ? (lonSum / n) : 0.0;
        const latC = n ? (latSum / n) : 0.0;
        const h = heightFromProps(props, defaultHeight, lonC, latC);
        for (let i = 1; i < outer.length; i++) addWall(outer[i - 1], outer[i], h);
        // Close if not closed
        const a = outer[outer.length - 1];
        const b = outer[0];
        if (a && b && (a[0] !== b[0] || a[1] !== b[1])) addWall(a, b, h);

        // Optional roof cap (simple fan). This is a prototype: correct for convex-ish rings,
        // and "good enough" for street-level viewing even when imperfect.
        if (outer.length >= 3 && outer.length <= 128) {
            // Build projected ring in local coords, excluding duplicated last point.
            const ring = [];
            for (let i = 0; i < outer.length; i++) {
                const c = outer[i];
                if (!c || c.length < 2) continue;
                ring.push([Number(c[0]), Number(c[1])]);
            }
            if (ring.length >= 3) {
                const last = ring[ring.length - 1];
                const first = ring[0];
                if (last && first && last[0] === first[0] && last[1] === first[1]) ring.pop();
            }
            if (ring.length >= 3) {
                let cx = 0, cz = 0;
                const pts = [];
                for (const [lon, lat] of ring) {
                    const p = proj.toXYZ(lon, lat, baseY + h);
                    pts.push(p);
                    cx += p[0];
                    cz += p[2];
                }
                cx /= pts.length;
                cz /= pts.length;
                const cy = baseY + h;
                for (let i = 1; i < pts.length - 1; i++) {
                    const p1 = pts[i];
                    const p2 = pts[i + 1];
                    // Triangle fan: center -> p1 -> p2
                    pos.push(
                        cx, cy, cz,
                        p1[0], p1[1], p1[2],
                        p2[0], p2[1], p2[2],
                    );
                    // Up normal
                    nrm.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
                }
            }
        }
    };

    const walkGeom = (g, props) => {
        if (!g) return;
        const t = String(g.type || '');
        const c = g.coordinates;
        if (t === 'Polygon') { addPolygon(c, props); return; }
        if (t === 'MultiPolygon') { if (Array.isArray(c)) for (const poly of c) addPolygon(poly, props); return; }
        if (t === 'GeometryCollection') {
            const geoms = Array.isArray(g.geometries) ? g.geometries : [];
            for (const gg of geoms) walkGeom(gg, props);
        }
        // Ignore points/lines here.
    };
    const walk = (obj) => {
        if (!obj) return;
        const t = String(obj.type || '');
        if (t === 'FeatureCollection') {
            const feats = Array.isArray(obj.features) ? obj.features : [];
            for (const f of feats) walk(f);
            return;
        }
        if (t === 'Feature') { walkGeom(obj.geometry, obj.properties); return; }
        walkGeom(obj, null);
    };
    walk(geojson);

    return { positions: new Float32Array(pos), normals: new Float32Array(nrm) };
}

// Make “3D-ness” obvious: a lower, oblique framing than Camera.frameAABB’s high overview.
EarthApp.prototype._frameAABBStreet = function(minVec3, maxVec3) {
    try {
        this.camera.frameAABB(minVec3, maxVec3);
        const cx = (minVec3[0] + maxVec3[0]) * 0.5;
        const cy = (minVec3[1] + maxVec3[1]) * 0.5;
        const cz = (minVec3[2] + maxVec3[2]) * 0.5;
        const dx = (maxVec3[0] - minVec3[0]);
        const dy = (maxVec3[1] - minVec3[1]);
        const dz = (maxVec3[2] - minVec3[2]);
        const radius = Math.max(10.0, Math.sqrt(dx*dx + dy*dy + dz*dz) * 0.5);

        // Target center; position low-ish and offset so vertical walls read as 3D.
        this.camera.target[0] = cx;
        this.camera.target[1] = cy + Math.min(6.0, radius * 0.05);
        this.camera.target[2] = cz;

        this.camera.position[0] = cx + radius * 0.55;
        this.camera.position[1] = cy + Math.max(12.0, radius * 0.22);
        this.camera.position[2] = cz + radius * 0.55;
        this.camera.updateViewMatrix();
    } catch {
        // ignore
    }
};



import { fetchJSON } from './asset_fetcher.js';

const _MANIFEST_URL = 'assets/datasets/manifest.json';

let _cachedManifest = null;

export async function loadExternalDatasetsManifest() {
    if (_cachedManifest) return _cachedManifest;
    const m = await fetchJSON(_MANIFEST_URL, { priority: 'low' });
    const datasets = Array.isArray(m?.datasets) ? m.datasets : [];
    _cachedManifest = datasets.map((d) => ({
        id: String(d?.id || '').trim(),
        label: String(d?.label || d?.id || '').trim(),
        // Some entries are bundles (no URL). Keep both.
        url: (typeof d?.url === 'string') ? String(d.url).trim() : '',
        kind: String(d?.kind || 'geojson').trim(),
        bundle: Array.isArray(d?.bundle) ? d.bundle.map((x) => String(x || '').trim()).filter(Boolean) : [],
    })).filter((d) => d.id && (d.url || (d.bundle && d.bundle.length)));
    return _cachedManifest;
}

export async function loadExternalDatasetGeoJSONById(id) {
    const datasets = await loadExternalDatasetsManifest();
    const entry = datasets.find((d) => d.id === id) || null;
    if (!entry) throw new Error(`Unknown dataset id: ${id}`);
    const obj = await fetchJSON(entry.url, { priority: 'low' });
    return { entry, geojson: obj };
}

/**
 * Parse a GeoJSON-ish object into a Float32Array of data-space XYZ points.
 * Intended for small overlays. Coordinates must already be in GTA data-space.
 */
export function geojsonToDataSpacePoints(geojson, { maxPoints = 200000 } = {}) {
    const out = [];
    const pushXYZ = (c) => {
        if (!c) return;
        if (out.length >= maxPoints * 3) return;
        const x = Number(c[0]);
        const y = Number(c[1]);
        const z = (c.length >= 3) ? Number(c[2]) : 0.0;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
        out.push(x, y, z);
    };

    const walkGeom = (g) => {
        if (!g) return;
        const t = String(g.type || '');
        const c = g.coordinates;

        if (t === 'Point') {
            pushXYZ(c);
            return;
        }
        if (t === 'MultiPoint' || t === 'LineString') {
            if (Array.isArray(c)) for (const p of c) pushXYZ(p);
            return;
        }
        if (t === 'MultiLineString' || t === 'Polygon') {
            if (Array.isArray(c)) for (const ring of c) if (Array.isArray(ring)) for (const p of ring) pushXYZ(p);
            return;
        }
        if (t === 'MultiPolygon') {
            if (Array.isArray(c)) for (const poly of c) if (Array.isArray(poly)) for (const ring of poly) if (Array.isArray(ring)) for (const p of ring) pushXYZ(p);
            return;
        }
        if (t === 'GeometryCollection') {
            const geoms = Array.isArray(g.geometries) ? g.geometries : [];
            for (const gg of geoms) walkGeom(gg);
            return;
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
        if (t === 'Feature') {
            walkGeom(obj.geometry);
            return;
        }
        // Allow raw geometry as root.
        walkGeom(obj);
    };

    walk(geojson);
    return new Float32Array(out);
}

export async function loadExternalDatasetPointsById(id) {
    const datasets = await loadExternalDatasetsManifest();
    const entry = datasets.find((d) => d.id === id) || null;
    if (!entry) throw new Error(`Unknown dataset id: ${id}`);
    const obj = await fetchJSON(entry.url, { priority: 'low' });
    const pts = geojsonToDataSpacePoints(obj);
    return { entry, points: pts };
}



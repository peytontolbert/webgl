import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = new Set(process.argv.slice(2));
const assetsIndex = process.argv.indexOf('--assets-dir');
const assetsDir = resolve(assetsIndex >= 0 ? process.argv[assetsIndex + 1] : 'webgl_viewer/assets');
const checkOnly = args.has('--check');
const wheelTags = ['27922', '26418', '27902', '26398'];

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function wheelFallback(definition, tag) {
    const wheel = definition?.wheel || {};
    const front = Math.max(0.15, finite(wheel.scale, definition?.wheelRadius ?? 0.35));
    const rear = Math.max(0.15, finite(wheel.rearScale, front));
    return tag === '27902' || tag === '26398' ? rear : front;
}

function calibrate(definition, manifest) {
    const entry = manifest?.meshes?.[String(definition.hash)] || manifest?.meshes?.[Object.keys(manifest?.meshes || {})[0]];
    const rows = entry?.lods?.high?.submeshes || [];
    const pivots = definition.wheelPivots || {};
    const radii = {};
    const contactOffsets = [];
    for (const tag of wheelTags) {
        const pivot = pivots[tag];
        let radius = wheelFallback(definition, tag);
        if (Array.isArray(pivot) && pivot.length >= 3) {
            for (const row of rows) {
                if (String(row?.fragmentBoneTag) !== tag) continue;
                const bounds = row?.bounds;
                if (!Array.isArray(bounds?.min) || !Array.isArray(bounds?.max)) continue;
                radius = Math.max(radius, Math.abs(finite(bounds.min[2]) - finite(pivot[2])), Math.abs(finite(bounds.max[2]) - finite(pivot[2])));
            }
            contactOffsets.push(radius - finite(pivot[2]));
        }
        radii[tag] = Number(radius.toFixed(5));
    }
    const radiusValues = Object.values(radii);
    const contactPlane = contactOffsets.length ? Math.max(...contactOffsets) : finite(definition.groundOffset, 0.4);
    const groundOffset = Math.max(0.15, Math.min(1.5, contactPlane));
    return {
        radii,
        groundOffset: Number(groundOffset.toFixed(5)),
        wheelRadius: Number((radiusValues.reduce((sum, value) => sum + value, 0) / radiusValues.length).toFixed(5)),
    };
}

const catalogPath = resolve(assetsDir, 'custom_vehicles/catalog.json');
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
const failures = [];
let changed = 0;
for (const definition of catalog.vehicles || []) {
    const manifestPath = resolve(assetsDir, String(definition.manifest || `custom_vehicles/${definition.model}.json`));
    try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        const result = calibrate(definition, manifest);
        const signature = JSON.stringify({ groundOffset: result.groundOffset, wheelRadius: result.wheelRadius, wheelRadii: result.radii });
        const oldSignature = JSON.stringify({ groundOffset: definition.groundOffset, wheelRadius: definition.wheelRadius, wheelRadii: definition.wheelRadii || null });
        Object.assign(definition, { groundOffset: result.groundOffset, wheelRadius: result.wheelRadius, wheelRadii: result.radii });
        manifest.vehicle = { ...(manifest.vehicle || {}), ...definition };
        if (signature !== oldSignature) changed++;
        if (!checkOnly) await writeFile(manifestPath, JSON.stringify(manifest));
    } catch (error) {
        failures.push({ model: definition?.model || 'unknown', error: String(error?.message || error) });
    }
}
catalog.stats = { ...(catalog.stats || {}), wheelGeometryCalibrated: (catalog.vehicles || []).length - failures.length, wheelGeometryCalibrationFailures: failures.length };
if (!checkOnly) await writeFile(catalogPath, JSON.stringify(catalog));
console.log(JSON.stringify({ changed, failures, stats: catalog.stats }, null, 2));
process.exitCode = failures.length ? 1 : 0;

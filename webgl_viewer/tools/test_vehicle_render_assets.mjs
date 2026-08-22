import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const catalog = JSON.parse(await readFile(new URL('../assets/custom_vehicles/catalog.json', import.meta.url), 'utf8'));
let meshes = 0;
let chassis = 0;
let wheelParts = 0;

function isChassisAnchor(submesh) {
    const tag = submesh?.fragmentBoneTag;
    if (tag !== null && tag !== undefined && tag !== '' && Number.isFinite(Number(tag))) return false;
    const min = submesh?.bounds?.min;
    const max = submesh?.bounds?.max;
    const span = Array.isArray(min) && Array.isArray(max) && min.length >= 3 && max.length >= 3
        ? Math.max(...min.slice(0, 3).map((value, index) => Math.abs(Number(max[index]) - Number(value)) || 0))
        : 0;
    const shader = String(submesh?.material?.shaderName || '').toLowerCase();
    return Number(submesh?.radius) >= 1.0 || span >= 1.6 || /vehicle_(?:paint|mesh)|chassis|body/.test(shader);
}

for (const vehicle of catalog.vehicles || []) {
    const manifestPath = String(vehicle?.manifest || '');
    const hash = String(vehicle?.hash || '');
    assert.ok(manifestPath && hash, 'catalog vehicles need a manifest and model hash');
    const manifest = JSON.parse(await readFile(new URL(`../assets/${manifestPath}`, import.meta.url), 'utf8'));
    const submeshes = manifest?.meshes?.[hash]?.lods?.high?.submeshes;
    assert.ok(Array.isArray(submeshes) && submeshes.length, `${vehicle.model} needs high-detail submeshes`);
    assert.ok(submeshes.some(isChassisAnchor), `${vehicle.model} needs a non-wheel chassis anchor`);
    const wheels = new Set(submeshes.map((submesh) => String(submesh?.fragmentBoneTag ?? '')).filter(Boolean));
    for (const tag of ['27922', '26418', '27902', '26398']) assert.ok(wheels.has(tag), `${vehicle.model} missing wheel geometry ${tag}`);
    for (const submesh of submeshes) {
        const file = String(submesh?.file || '');
        assert.ok(file, `${vehicle.model} has a submesh without geometry`);
        await access(new URL(`../assets/models/${file}`, import.meta.url));
        meshes++;
        if (isChassisAnchor(submesh)) chassis++;
        const tag = submesh?.fragmentBoneTag;
        if (tag !== null && tag !== undefined && tag !== '' && Number.isFinite(Number(tag))) wheelParts++;
    }
}

assert.ok(chassis >= (catalog.vehicles || []).length, 'every exported vehicle needs a chassis draw anchor');
console.log(`vehicle render assets: ${catalog.vehicles.length} vehicles, ${meshes} geometry parts, ${chassis} chassis anchors, ${wheelParts} wheel parts verified`);

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const catalog = JSON.parse(await readFile(new URL('../assets/custom_vehicles/catalog.json', import.meta.url), 'utf8'));
const wheelTags = ['27922', '26418', '27902', '26398'];
for (const vehicle of catalog.vehicles || []) {
    assert.ok(vehicle.wheelRadii && typeof vehicle.wheelRadii === 'object', `${vehicle.model} needs exported wheel radii`);
    for (const tag of wheelTags) {
        const pivot = vehicle.wheelPivots?.[tag];
        const radius = Number(vehicle.wheelRadii[tag]);
        assert.ok(Array.isArray(pivot) && pivot.length >= 3, `${vehicle.model} missing wheel pivot ${tag}`);
        assert.ok(Number.isFinite(radius) && radius >= 0.15 && radius <= 1.0, `${vehicle.model} invalid visual radius ${tag}`);
        assert.ok(vehicle.groundOffset + 1e-4 >= radius - Number(pivot[2]), `${vehicle.model} contact plane clips wheel ${tag}`);
    }
}
assert.equal(catalog.stats?.wheelGeometryCalibrationFailures, 0, 'wheel geometry calibration must cover every vehicle');
console.log(`vehicle wheel geometry: ${catalog.vehicles.length} vehicles have calibrated fragment contact planes`);

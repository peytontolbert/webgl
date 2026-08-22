import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const catalog = JSON.parse(await readFile(new URL('../assets/custom_vehicles/catalog.json', import.meta.url), 'utf8'));
const requiredHandling = [
    'mass', 'dragCoeff', 'centerOfMass', 'inertiaMultiplier', 'driveForce', 'driveInertia',
    'clutchChangeRateUpShift', 'clutchChangeRateDownShift', 'brakeBiasFront', 'handBrakeForce',
    'tractionMin', 'tractionLateral', 'suspensionForce', 'suspensionCompDamp', 'suspensionReboundDamp',
    'antiRollBarForce', 'collisionDamageMult', 'deformationDamageMult', 'engineDamageMult',
];

assert.ok(Array.isArray(catalog.vehicles) && catalog.vehicles.length >= 170, 'custom vehicle catalog should remain populated');
for (const vehicle of catalog.vehicles) {
    assert.ok(vehicle.camera?.povOffset?.length === 3, `${vehicle.model} needs a first-person camera offset`);
    assert.ok(Number.isFinite(vehicle.damage?.bodyHealth), `${vehicle.model} needs body health metadata`);
    for (const key of requiredHandling) assert.ok(vehicle.handling?.[key] !== undefined, `${vehicle.model} missing handling.${key}`);
}
assert.equal(catalog.stats?.mechanicsEnrichmentFailures, 0, 'metadata enrichment must not drop vehicles');

console.log(`vehicle metadata catalog: ${catalog.vehicles.length} vehicles expose expanded CodeWalker mechanics`);

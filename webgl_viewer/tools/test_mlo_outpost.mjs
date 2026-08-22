import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const demo = path.join(root, 'assets', 'demo');
const descriptor = JSON.parse(fs.readFileSync(path.join(demo, 'weed_shop_district.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(demo, 'weed_shop_models.json'), 'utf8'));
const entities = fs.readFileSync(path.join(demo, 'weed_shop_entities.bin'));

assert.equal(descriptor.schema, 'webglgta-spawn-district-mlo-outpost-v1');
assert.equal(descriptor.size, 300);
assert.deepEqual(descriptor.mloRuntime.interiorArchetypeHashes, ['251203108']);
assert.deepEqual(descriptor.camera, { distanceData: 1.75, heightData: 0, sideData: 0 });
assert.equal(entities.subarray(0, 4).toString('ascii'), 'ENT1');
const count = entities.readUInt32LE(4);
assert.equal(count, 628);
assert.equal((entities.length - 8) / count, 64);
assert.equal(entities.readUInt32LE(8), 251203108);
assert.equal(entities.readUInt32LE(8 + 60) & 1, 1);
assert.equal(Object.keys(manifest.meshes).length, 147);
assert.equal(manifest.mloOutpost.childArchetypeCount, 147);

console.log('weed-shop MLO outpost: descriptor, root, children, and manifest passed');

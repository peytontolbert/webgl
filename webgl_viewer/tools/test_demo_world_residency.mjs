import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(path.join(root, 'js', 'main.js'), 'utf8');
const descriptor = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'demo', 'spawn_district.json'), 'utf8'));

assert.ok(Number(descriptor.instanceCount) > 8_192, 'demo must exercise residency above the old visibility cap');
assert.match(main, /const SPAWN_DEMO_MAX_VISIBLE_INSTANCES = 9_000/);
assert.match(main, /const SPAWN_DEMO_MAX_INSTANCES_PER_ARCHETYPE = 768/);
assert.match(main, /Math\.min\(12_000, runtimeArchetypes \+ 16\)/);
assert.match(main, /maxVisible: runtimeInstances > 0 \? SPAWN_DEMO_MAX_VISIBLE_INSTANCES : 2048/);
assert.match(main, /maxPerArch: runtimeInstances > 0 \? SPAWN_DEMO_MAX_INSTANCES_PER_ARCHETYPE : 2048/);
assert.match(main, /this\.drawableStreamer\.enableWorkerFrustumCulling = false/);
assert.match(main, /this\.drawableStreamer\.rebuildInstancesOnMove = false/);
assert.match(main, /this\.drawableStreamer\.maxBehindModelDistance = Math\.min\(budget\.maxDist, 280\.0\)/);
assert.match(main, /coarseFrustumCulling: !!this\.spawnDistrictDemo/);
assert.match(main, /coarseFrustumSafeOnly: !!this\.spawnDistrictDemo/);
assert.match(main, /minProjectedRadiusPx: this\.spawnDistrictDemo \? SPAWN_DEMO_MIN_PROJECTED_PROP_RADIUS_PX : 0\.0/);
assert.doesNotMatch(main, /maxVisible: runtimeInstances > 0 \? 8192 : 2048/);

console.log('demo world residency contract passed');

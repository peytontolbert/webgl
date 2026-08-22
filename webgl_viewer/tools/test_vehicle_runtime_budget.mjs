import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(path.join(root, 'js', 'main.js'), 'utf8');

assert.match(main, /_applyVehicleStreamingBudget\(\)/);
assert.match(main, /const targetLoads = moving && this\._vehicleModelMeshReady \? 1 : 4/);
assert.match(main, /driving \? 1500 : 1200/);
assert.match(main, /driving \? 48 : 96/);
assert.doesNotMatch(main, /driving \? 550 : 1200/);
assert.doesNotMatch(main, /driving \? 160 : 96/);

console.log('vehicle runtime budget contract passed');

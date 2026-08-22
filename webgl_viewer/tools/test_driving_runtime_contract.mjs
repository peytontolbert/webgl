import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(path.join(root, 'js', 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'js', 'instanced_model_renderer.js'), 'utf8');
const audio = fs.readFileSync(path.join(root, 'js', 'gameplay', 'audio_system.js'), 'utf8');
const worklet = fs.readFileSync(path.join(root, 'js', 'gameplay', 'gta_vehicle_audio_worklet.js'), 'utf8');

assert.match(main, /gpuFrustumCulling: !!this\.spawnDistrictDemo/);
assert.match(main, /coarseFrustumSafeOnly: !!this\.spawnDistrictDemo/);
assert.match(main, /occlusionMaxAggregateRadius: this\.spawnDistrictDemo \? 26\.0 : 0\.0/);
assert.match(renderer, /coarseFrustumCulling \|\| gpuFrustumCulling/);
assert.match(renderer, /maxAggregateRadius/);
assert.match(audio, /_ensureVehicleGranularWorklet/);
assert.match(audio, /AudioWorkletNode/);
assert.match(worklet, /registerProcessor\('webglgta-gta-vehicle-granular-v1'/);

console.log('driving runtime contract: stable visibility guard and AudioWorklet granular mixer passed');

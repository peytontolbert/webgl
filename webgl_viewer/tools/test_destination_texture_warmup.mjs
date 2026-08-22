import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'js', 'main.js'), 'utf8');

const required = [
    'this._startDestinationTextureWarmup();',
    '_startDestinationTextureWarmup(durationMs = 12_000)',
    'maxLoadsInFlight: Math.max(16, baseline.maxLoadsInFlight)',
    'maxNewLoadsPerFrame: Math.max(32, baseline.maxNewLoadsPerFrame)',
    'A quality/profile change owns the new limits and must not be undone.',
];

for (const token of required) {
    if (!source.includes(token)) {
        throw new Error(`Destination texture warmup contract missing: ${token}`);
    }
}

console.log('Destination texture warmup contract passed.');

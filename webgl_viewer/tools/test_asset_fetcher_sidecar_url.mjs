import assert from 'node:assert/strict';
import { appendUrlPathSuffix } from '../js/asset_fetcher.js';

assert.equal(
    appendUrlPathSuffix('assets/peds/1885233650_animations.skp?rev=root-motion-v3', '.gz'),
    'assets/peds/1885233650_animations.skp.gz?rev=root-motion-v3',
);
assert.equal(
    appendUrlPathSuffix('assets/demo/pack.bin#range', '.gz'),
    'assets/demo/pack.bin.gz#range',
);
assert.equal(appendUrlPathSuffix('assets/demo/pack.bin', '.gz'), 'assets/demo/pack.bin.gz');

console.log('asset sidecar URL suffix contract passed');

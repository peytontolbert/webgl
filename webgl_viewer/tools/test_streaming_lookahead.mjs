import assert from 'node:assert/strict';
import { glMatrix } from '../js/glmatrix.js';
import { DrawableStreamer } from '../js/drawable_streamer.js';

const streamer = new DrawableStreamer({
    modelMatrix: glMatrix.mat4.create(),
    modelManager: {},
    modelRenderer: {},
});
const denseChunks = {};
for (let y = -10; y <= 10; y++) {
    for (let x = -10; x <= 10; x++) denseChunks[`${x}_${y}`] = { binaryFile: `${x}_${y}.bin` };
}
streamer.index = {
    chunk_size: 256,
    bounds: { minX: -2048, minY: -2048, maxX: 2048, maxY: 2048, min_z: -100, max_z: 500 },
    chunks: denseChunks,
};
streamer.radiusChunks = 2;
streamer.maxLoadedChunks = 37;
streamer.extraFrontChunks = 3;
streamer.prefetchHorizonSeconds = 10;

const camera = { position: [0, 0, 0] };
const stationary = streamer.getWantedKeys(camera, [0, 0, 0]);
assert.equal(stationary.length, 25, 'stationary residency should contain only the complete 5x5 core');

streamer._prefetchFocusSample = { x: 0, y: 0, ms: performance.now() - 1000 };
const driving = streamer.getWantedKeys(camera, [40, 0, 0]);
assert.equal(driving.length, 37, 'driving residency should fill twelve reserved forward slots');
assert.equal(streamer._lastResidentCoreCount, 25, 'forward prefetch must not displace core tiles');
assert.ok(streamer._lastPrefetchStats.speed >= 35, 'look-ahead should derive vehicle-scale speed from focus movement');
assert.ok(streamer._lastPrefetchStats.leadChunks > 1, 'vehicle speed should project more than one chunk ahead');

const core = driving.slice(0, 25).map((key) => key.split('_').map(Number));
assert.ok(core.every(([x, y]) => Math.abs(x) <= 2 && Math.abs(y) <= 2), 'the first 25 priorities must remain the player-centered core');
const forward = driving.slice(25).map((key) => key.split('_').map(Number));
assert.ok(forward.every(([x]) => x >= 0), 'movement-directed extras must stay ahead of the player');
assert.ok(forward.some(([x]) => x >= 3), 'look-ahead must request tiles beyond the resident core');

const sparseStreamer = new DrawableStreamer({
    modelMatrix: glMatrix.mat4.create(),
    modelManager: {},
    modelRenderer: {},
});
sparseStreamer.index = {
    chunk_size: 256,
    bounds: { minX: -475, minY: -2115, maxX: -175, maxY: -1815, min_z: -100, max_z: 500 },
    chunks: {
        '-2_-8': { binaryFile: '-2_-8.bin' },
        '-1_-8': { binaryFile: '-1_-8.bin' },
        '-2_-9': { binaryFile: '-2_-9.bin' },
    },
};
sparseStreamer.setWorldBounds({ minX: -475, minY: -2115, maxX: -175, maxY: -1815 });
sparseStreamer.radiusChunks = 1;
sparseStreamer.maxLoadedChunks = 9;
assert.deepEqual(
    sparseStreamer.getWantedKeys(camera, [-325, -1965, 31]),
    ['-2_-8', '-1_-8', '-2_-9'],
    'sparse demo residency must not wait for an unindexed boundary tile',
);

streamer.maxResidentChunks = 49;
streamer.staleChunkGraceMs = 12_000;
const makeWindow = (centerX) => {
    const keys = [];
    for (let y = -3; y <= 3 && keys.length < 37; y++) {
        for (let x = centerX - 3; x <= centerX + 3 && keys.length < 37; x++) keys.push(`${x}_${y}`);
    }
    return keys;
};
const oldWindow = makeWindow(0);
const nextWindow = makeWindow(1);
streamer.loaded = new Set(oldWindow);
for (const key of oldWindow) streamer._chunkLastWantedMs.set(key, performance.now());
for (const key of nextWindow) streamer.loaded.add(key);
streamer._trim(new Set(nextWindow), nextWindow);
assert.ok(streamer.loaded.size > nextWindow.length, 'recently displaced tiles should remain during boundary overlap');
assert.ok(streamer.loaded.size <= 49, 'boundary overlap must remain within its resident ceiling');
assert.ok(nextWindow.every((key) => streamer.loaded.has(key)), 'wanted replacement tiles must never be evicted');

const farWindow = makeWindow(5);
for (const key of farWindow) streamer.loaded.add(key);
streamer._trim(new Set(farWindow), farWindow);
assert.equal(streamer.loaded.size, 49, 'sustained travel must cap stale plus wanted residency');
assert.ok(farWindow.every((key) => streamer.loaded.has(key)), 'capacity eviction must retain the complete wanted window');

for (const key of streamer.loaded) {
    if (!farWindow.includes(key)) streamer._chunkLastWantedMs.set(key, performance.now() - 13_000);
}
streamer._trim(new Set(farWindow), farWindow);
assert.equal(streamer.loaded.size, farWindow.length, 'expired overlap tiles should retire after the grace period');

console.log('streaming look-ahead: stable core, speed-directed prefetch, and bounded transition overlap passed');

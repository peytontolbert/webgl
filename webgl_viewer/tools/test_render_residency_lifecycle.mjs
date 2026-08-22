import assert from 'node:assert/strict';
import { InstancedModelRenderer } from '../js/instanced_model_renderer.js';
import { ModelManager } from '../js/model_manager.js';
import { TextureStreamer } from '../js/texture_streamer.js';

function makePrefetchRenderer(materialCount = 2000) {
    const renderer = Object.create(InstancedModelRenderer.prototype);
    renderer.buckets = new Map();
    renderer.instances = new Map();
    for (let i = 0; i < materialCount; i++) {
        renderer.buckets.set(`bucket-${i}`, {
            minDist: i,
            material: { diffuse: `texture-${i}.png`, shaderName: 'default' },
        });
    }
    renderer._texturePrefetchRevision = 1;
    renderer._texturePrefetchCacheRevision = 0;
    renderer._texturePrefetchSources = [];
    renderer._texturePrefetchCursors = new Map();
    renderer._texturePrefetchLastScanned = 0;
    renderer._texturePrefetchLastTouched = 0;
    renderer._chooseTextureUrl = (rel) => rel;
    const touched = [];
    renderer.textureStreamer = {
        highDist: 45,
        getResidencyState(url) {
            return url === 'texture-700.png' ? 'absent' : 'resident';
        },
        touch(url) { touched.push(url); },
    };
    return { renderer, touched };
}

{
    const { renderer, touched } = makePrefetchRenderer();
    assert.equal(renderer.prefetchDiffuseTextures(2, { skipSettled: true }), 0);
    const cachedSources = renderer._texturePrefetchSources;
    assert.equal(renderer._texturePrefetchLastScanned, 512, 'settled scans must have a bounded per-pass cost');
    assert.equal(renderer.prefetchDiffuseTextures(2, { skipSettled: true }), 1);
    assert.equal(renderer._texturePrefetchSources, cachedSources, 'unchanged scenes must reuse their sorted source list');
    assert.deepEqual(touched, ['texture-700.png'], 'the progressive cursor must reach later unresolved textures');
}

{
    const renderer = Object.create(InstancedModelRenderer.prototype);
    renderer.instances = new Map();
    renderer.buckets = new Map();
    renderer._meshLoadFailures = new Map();
    renderer._meshEntryGenerations = new Map([['retired', 0]]);
    renderer._meshLoadQueueDirty = false;
    renderer._retireMeshLoadEntry('retired');
    assert.equal(renderer._meshEntryGenerations.get('retired'), 1, 'retiring a streamed entry must invalidate its queued generation');
    assert.equal(renderer._meshLoadQueueDirty, true);
}

{
    const manager = Object.create(ModelManager.prototype);
    const now = performance.now();
    manager.gl = { deleteVertexArray() {}, deleteBuffer() {} };
    manager.maxMeshCacheBytes = 100;
    manager.meshCacheHotProtectionMs = 2500;
    manager.meshCacheHardLimitMultiplier = 1.35;
    manager.meshCacheDebug = false;
    manager.meshCache = new Map([
        ['a', { key: 'a', _lastUsedMs: now, approxBytes: 60 }],
        ['b', { key: 'b', _lastUsedMs: now, approxBytes: 60 }],
    ]);
    manager._meshCacheApproxBytes = new Map([['a', 60], ['b', 60]]);
    manager._meshCacheBytes = 120;
    manager._meshCacheEvictions = 0;
    manager._meshCacheHotEvictionDeferrals = 0;
    manager._evictMeshCacheIfNeeded();
    assert.equal(manager.meshCache.size, 2, 'recently drawn meshes may exceed the soft cap briefly');
    assert.equal(manager._meshCacheHotEvictionDeferrals, 1);

    manager._meshCacheBytes = 140;
    manager._meshCacheApproxBytes.set('a', 70);
    manager._meshCacheApproxBytes.set('b', 70);
    manager._evictMeshCacheIfNeeded();
    assert.equal(manager.meshCache.size, 1, 'the hard cap must still bound hot residency');
}

{
    const streamer = Object.create(TextureStreamer.prototype);
    streamer.maxTextures = 0;
    streamer.maxBytes = 100;
    streamer.totalBytes = 50;
    streamer.cache = { values() { throw new Error('byte-only under-budget eviction scanned the cache'); } };
    streamer._evictIfNeeded();
}

console.log('render residency lifecycle: progressive warmup, generation invalidation, and hot-cache protection passed');

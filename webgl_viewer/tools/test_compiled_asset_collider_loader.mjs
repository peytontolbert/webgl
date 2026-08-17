#!/usr/bin/env node
// Node-only streaming smoke test for the derived static asset-collider layer.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const collisionWorldModule = process.env.COLLISION_WORLD_MODULE || new URL('../js/gameplay/collision_world.js', import.meta.url).href;
const { CollisionWorld } = await import(collisionWorldModule);
const root = process.argv[2];
if (!root) throw new Error('usage: test_compiled_asset_collider_loader.mjs <compiled-asset-collider-dir>');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const url = 'http://collision.local/assets/collision/compiled/asset_colliders/manifest.json';
globalThis.window = { location: url };
globalThis.fetch = async (requested) => {
    const filename = new URL(String(requested)).pathname.split('/').pop();
    try { return new Response(readFileSync(join(root, filename))); }
    catch { return new Response('missing', { status: 404 }); }
};
const first = manifest.chunks[0];
const world = new CollisionWorld({});
await world.loadCompiledAssetColliders(url);
const liveCount = world.assetColliderCount;
const streamed = await world.streamCompiledAssetCollidersAt((first.gx + 0.5) * manifest.cell_size, (first.gy + 0.5) * manifest.cell_size, 0);
if (streamed.colliderCount <= liveCount || !world.ybnCollisionExclusions.length) throw new Error('static or live collider layer was not installed');
console.log(JSON.stringify({ valid: true, liveCount, ...streamed, exclusions: world.ybnCollisionExclusions.length }, null, 2));

#!/usr/bin/env node
// Node-only decoder smoke test for a staged CWCT package. It injects a local
// fetch implementation; it does not open a server or modify package contents.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const collisionWorldModule = process.env.COLLISION_WORLD_MODULE || new URL('../js/gameplay/collision_world.js', import.meta.url).href;
const { CollisionWorld } = await import(collisionWorldModule);

const root = process.argv[2];
const manifestName = process.argv[3] || 'ybn_2000_static.json';
if (!root) throw new Error('usage: test_compiled_collision_loader.mjs <compiled-static-ybn-dir> [manifest-name]');
const manifest = JSON.parse(readFileSync(join(root, manifestName), 'utf8'));
const url = `http://collision.local/assets/collision/compiled/static_ybn/${manifestName}`;
globalThis.window = { location: url };
globalThis.fetch = async (requested) => {
    const filename = new URL(String(requested)).pathname.split('/').pop();
    try { return new Response(readFileSync(join(root, filename))); }
    catch { return new Response('missing', { status: 404 }); }
};
const first = Object.values(manifest.chunks)[0];
const x = (Number(first.bounds.min_x) + Number(first.bounds.max_x)) * 0.5;
const y = (Number(first.bounds.min_y) + Number(first.bounds.max_y)) * 0.5;
const world = new CollisionWorld({});
await world.loadCompiledStaticCollision(url);
const streamed = await world.streamCompiledStaticCollisionAt(x, y, 0);
if (!world.ybnGround?.vertices?.length || !world.ybnGround?.indices?.length || !world.ybnGround?.grid?.size) {
    throw new Error('compiled loader decoded an empty collision world');
}
console.log(JSON.stringify({
    valid: true,
    ...streamed,
    vertices: world.ybnGround.vertices.length / 3,
    triangles: world.ybnGround.indices.length / 3,
    gridCells: world.ybnGround.grid.size,
}, null, 2));

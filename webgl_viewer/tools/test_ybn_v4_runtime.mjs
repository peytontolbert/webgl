import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CollisionWorld } from '../js/gameplay/collision_world.js';

globalThis.window = { location: { href: 'http://collision.test/' } };

async function loadWorld(metaPath, binPath) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const bytes = fs.readFileSync(binPath);
    globalThis.fetch = async (url) => String(url).endsWith('.json')
        ? { ok: true, json: async () => meta }
        : { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    const world = new CollisionWorld({ groundPedToTerrain: true, spawnDistrictDemo: true });
    await world.loadYbnGround('http://collision.test/ybn_spawn.json');
    assert.equal(world.ybnGroundError, null);
    return world;
}

const legacy = await loadWorld('assets/collision/ybn_spawn.json', 'assets/collision/ybn_spawn.bin');
const v4 = await loadWorld('tmp/ybn_v4/ybn_spawn.json', 'tmp/ybn_v4/ybn_spawn.bin');
assert.equal(v4.ybnGround.meta.version, 4);
assert.ok(v4.ybnGround.materialPalette.length > 20, 'CodeWalker material palette should not collapse to DEFAULT');
assert.equal(v4.ybnGround.triangleMaterials.length, v4.ybnGround.indices.length / 3);

const probes = [
    [221.54, -806.78, 30.67],
    [215.0, -810.0, 31.0],
    [180.0, -850.0, 31.0],
    [250.0, -825.0, 31.0],
];
for (const [x, y, z] of probes) {
    const before = legacy.resolveGround(x, y, z, { applyYbnCalibration: false });
    const after = v4.resolveGround(x, y, z, { applyYbnCalibration: false });
    assert.ok(Math.abs(before.z - after.z) < 1e-5, `v4 changed collision height at ${x},${y}`);
    if (after.source === 'ybn') assert.ok(Number.isFinite(after.grip), `v4 omitted grip at ${x},${y}`);
}

console.log(`ybn v4 runtime: identical road heights with ${v4.ybnGround.materialPalette.length} GTA material profiles`);

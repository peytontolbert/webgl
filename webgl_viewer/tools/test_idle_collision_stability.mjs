import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CollisionWorld } from '../js/gameplay/collision_world.js';

const collision = new CollisionWorld({ groundPedToTerrain: false });
let groundQueries = 0;
let blockerSweeps = 0;
collision.resolveGround = () => {
    groundQueries += 1;
    return { z: 31.17, source: 'test' };
};
collision._sweepBlockers = () => {
    blockerSweeps += 1;
    return null;
};

const result = collision.moveCapsule({
    x: 186.94,
    y: -850.84,
    feetZ: 31.17,
    vx: 0,
    vy: 0,
    dt: 1 / 60,
});

assert.equal(result.blocked, false);
assert.equal(result.ground.z, 31.17);
assert.equal(groundQueries, 1, 'an idle ped should resolve the floor once');
assert.equal(blockerSweeps, 0, 'an idle ped must not sweep world blockers');

const bundle = fs.readFileSync(new URL('../.codex-tmp/hard-refresh/main-CameraStable03.js', import.meta.url), 'utf8');
assert.match(bundle, /Math\.hypot\(x-j\(e\),v-j\(t\)\)<1e-8&&!y/,
    'the deploy bundle must contain the stationary-capsule early-out');

console.log('idle collision stability contract passed');

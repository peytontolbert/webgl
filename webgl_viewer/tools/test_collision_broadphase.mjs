import assert from 'node:assert/strict';
import { CollisionWorld } from '../js/gameplay/collision_world.js';

const world = new CollisionWorld({});
world.setManifest({
    collision: {
        blockers: Array.from({ length: 400 }, (_, index) => ({
            id: `blocker:${index}`,
            x: index * 20,
            y: 0,
            z: 0,
            radius: 0.8,
            height: 2,
        })),
        destructibles: [{ id: 'sign', x: 4, y: 0, z: 0, radius: 0.6, height: 2, breakSpeed: 3 }],
    },
});

assert.ok(world._blockerGrid.size > 1, 'blockers should be indexed into spatial cells');
assert.ok(world._destructibleGrid.size > 0, 'destructibles should be indexed into spatial cells');
const nearby = world._queryCircleGrid(world._blockerGrid, world._blockerCellSize, -2, -2, 8, 2);
assert.ok(nearby.length < world.blockers.length, 'local vehicle query must not scan the full blocker set');
const impact = world.findDestructibleImpact({ start: [0, 0], end: [6, 0], radius: 1, feetZ: 0 });
assert.equal(impact?.id, 'sign', 'swept destructible query should preserve exact hits');
const collision = world.moveVehicle({
    x: -3, y: 0, feetZ: 0, vx: 6, vy: 0, dt: 1,
    heading: 0, halfWidth: 0.9, halfLength: 2.0,
});
assert.equal(collision.blocked, true, 'vehicle broadphase must still feed the chassis narrow phase');

console.log('vehicle collision broadphase: local blocker/destructible queries and chassis hits passed');

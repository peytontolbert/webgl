import assert from 'node:assert/strict';
import { DrawableStreamer } from '../js/drawable_streamer.js';
import { CollisionWorld } from '../js/gameplay/collision_world.js';
import { glMatrix } from '../js/glmatrix.js';

const identity = glMatrix.mat4.create();
const streamer = new DrawableStreamer({ modelMatrix: identity, modelManager: {}, modelRenderer: {} });
const definition = {
    rooms: [
        { index: 0, name: 'room0', bbMin: [-4, -4, -2], bbMax: [0, 4, 2] },
        { index: 1, name: 'room1', bbMin: [0, -4, -2], bbMax: [4, 4, 2] },
        { index: 2, name: 'around_corner', bbMin: [4, 8, -2], bbMax: [8, 12, 2] },
    ],
    portals: [
        { index: 0, roomFrom: 0, roomTo: 1, flags: 0, corners: [[0, -2, -1], [0, 2, -1], [0, 2, 1], [0, -2, 1]] },
        { index: 1, roomFrom: 1, roomTo: 2, flags: 0, corners: [[4, 9, -1], [4, 11, -1], [4, 11, 1], [4, 9, 1]] },
    ],
};
streamer._mloDefs.set('99', definition);
streamer._mloInstancesLast = [{ parentGuid: 77, archHash: '99', mat16: identity }];

assert.deepEqual(
    [...streamer._computeVisibleRooms(definition, 0, 77, [-2, 0, 0])],
    [0, 1],
    'a portal hidden around a corner must not leak its room into the PVS',
);
streamer.enableMloPortalApertureCulling = false;
assert.deepEqual([...streamer._computeVisibleRooms(definition, 0, 77, [-2, 0, 0])], [0, 1, 2]);
streamer.enableMloPortalApertureCulling = true;

assert.equal(streamer.setMloPortalDefinition(77, 1, { flags: 1 }), true);
assert.equal(streamer.getMloPortals(77).find((portal) => portal.index === 1)?.flags, 1);
assert.equal(streamer._findPortalPath(definition, 2, 1, 77), null, 'one-way mutation must be instance scoped and affect traversal');
streamer.clearMloPortalOverrides(77);
assert.equal(streamer._findPortalPath(definition, 2, 1, 77)?.length, 1);

const collision = new CollisionWorld({});
collision.setDoorDefinitions([{
    id: 'swing-door',
    archetypeHash: '123',
    coords: { x: 1, y: 0, z: 1 },
    origin: { x: 0, y: 0, z: 1 },
    motion: 'swing',
    openAmount: Math.PI / 2,
    openSign: 1,
    passageRadius: 1.1,
    passageHalfDepth: 0.35,
}]);
collision.setDoorOpenProgress('swing-door', 0.5);
const movingLeaf = collision._firstDynamicDoorHit(
    Math.SQRT1_2, Math.SQRT1_2, 0, 0.2, 1.8, 0,
    1, -1, 0,
);
assert.equal(movingLeaf?.source, 'dynamic_door', 'partially open doors must retain collision at their animated position');
assert.equal(
    collision._firstDynamicDoorHit(1.4, -0.4, 0, 0.1, 1.8, 0, 1, 0, 0),
    null,
    'the authored closed position must be clear after the leaf rotates away',
);

console.log('advanced MLO runtime: aperture PVS, portal mutations, and dynamic door collision passed');

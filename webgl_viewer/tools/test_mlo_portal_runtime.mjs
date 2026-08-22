import assert from 'node:assert/strict';
import { DrawableStreamer } from '../js/drawable_streamer.js';
import { glMatrix } from '../js/glmatrix.js';

const identity = glMatrix.mat4.create();
const streamer = new DrawableStreamer({
    modelMatrix: identity,
    modelManager: {},
    modelRenderer: {},
});

const definition = {
    rooms: [
        { index: 0, name: 'limbo', bbMin: [-4, -4, -2], bbMax: [0, 4, 2] },
        { index: 1, name: 'room01', bbMin: [0, -4, -2], bbMax: [4, 4, 2], timecycleName: 123 },
        { index: 2, name: 'room02', bbMin: [4, -4, -2], bbMax: [8, 4, 2] },
    ],
    portals: [
        {
            index: 0,
            roomFrom: 1,
            roomTo: 0,
            flags: 64 | 8192,
            corners: [[0, -1, -1], [0, -1, 1], [0, 1, 1], [0, 1, -1]],
        },
        {
            index: 1,
            roomFrom: 1,
            roomTo: 2,
            flags: 1,
            corners: [[4, -1, -1], [4, -1, 1], [4, 1, 1], [4, 1, -1]],
        },
    ],
    entitySets: [{ hash: 456, name: 'furniture_variant' }],
    timecycleModifiers: [],
};

streamer._mloDefs.set('99', definition);
streamer._mloInstancesLast = [{ parentGuid: 77, archHash: '99', mat16: identity }];

const doors = [
    { id: 'left', coords: { x: 0, y: -0.4, z: 0 }, radius: 2.5 },
    { id: 'right', coords: { x: 0, y: 0.4, z: 0 }, radius: 2.5 },
];
const states = new Map([
    ['left', { progress: 0 }],
    ['right', { progress: 0 }],
]);

assert.equal(streamer.syncMloPortalDoors(doors, states), 1);
assert.deepEqual([...streamer._computeVisibleRooms(definition, 0, 77)], [0]);
assert.equal(streamer._findPortalPath(definition, 1, 0, 77), null);

states.get('left').progress = 1;
streamer.syncMloPortalDoors(doors, states);
assert.deepEqual([...streamer._computeVisibleRooms(definition, 0, 77)], [0, 1, 2]);
assert.deepEqual([...streamer._computeVisibleRooms(definition, 2, 77)], [2]);
assert.equal(streamer._findPortalPath(definition, 1, 0, 77).length, 1);

streamer._activeInterior = streamer.getInteriorStateAtDataPos([2, 0, 0]);
assert.ok(streamer.getActiveInteriorEnvironment(12).exteriorInfluence > 0);
states.get('left').progress = 0;
streamer.syncMloPortalDoors(doors, states);
streamer._activeInterior = streamer.getInteriorStateAtDataPos([2, 0, 0]);
assert.equal(streamer.getActiveInteriorEnvironment(12).exteriorInfluence, 0);
assert.equal(streamer.getMloAcousticPath([2, 0, 0], [-2, 0, 0]).occluded, true);

streamer._mloSetDefaults.set('77:456', false);
assert.equal(streamer.getMloEntitySets(77)[0].enabled, false);
assert.equal(streamer.setMloEntitySetEnabledForInterior(77, 'furniture_variant', true), 1);
assert.equal(streamer.getMloEntitySets(77)[0].enabled, true);

// Optimized manifests omit metadata-only MLO roots from drawable entries. The
// worker-supplied root channel must still activate the interior room graph.
streamer._lastCamDataPos = [2, 0, 0];
assert.deepEqual(streamer._filterEntriesForActiveInterior([], [
    { parentGuid: 77, archHash: '99', mat16: identity },
]), []);
assert.equal(streamer._mloInstancesLast.length, 1);
assert.equal(streamer._activeInterior?.roomIndex, 1);

console.log('mlo portal runtime: door binding, traversal, audio, light bleed, and entity sets passed');

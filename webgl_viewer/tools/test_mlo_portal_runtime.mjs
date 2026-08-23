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
            // Doors can sit near an edge of a wide authored aperture. Binding
            // must test the portal plane/extent, not only its center point.
            corners: [[0, -5, -1], [0, -5, 1], [0, 5, 1], [0, 5, -1]],
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
    { id: 'left', coords: { x: 0, y: 4.0, z: 0 }, radius: 2.5 },
    { id: 'right', coords: { x: 0, y: 4.4, z: 0 }, radius: 2.5 },
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

// Malformed loose-MLO room bounds must not keep an interior active out in the
// surrounding city. Portal metadata provides the authored shell scale.
const sentinelDefinition = {
    rooms: [
        { index: 0, name: 'limbo', bbMin: [-360, -330, -80], bbMax: [360, 330, 80] },
        { index: 1, name: 'store', bbMin: [-360, -330, -80], bbMax: [360, 330, 80] },
    ],
    portals: [{
        index: 0,
        roomFrom: 1,
        roomTo: 0,
        corners: [[-7, 34, 0], [-7, 34, 9], [19, 34, 9], [19, 34, 0]],
    }],
};
streamer._mloDefs.set('100', sentinelDefinition);
streamer._mloInstancesLast = [{ parentGuid: 88, archHash: '100', mat16: identity }];
assert.equal(streamer.getInteriorStateAtDataPos([61, 0, 0]), null);
assert.equal(streamer.getInteriorStateAtDataPos([0, 0, 0])?.roomIndex, 1);

// Large custom MLOs such as Walmart can extend far from their root and single
// entrance portal. The authored child envelope must keep the entire structure
// active, while still refusing to claim unrelated city blocks.
const boundedRoot = {
    parentGuid: 88,
    archHash: '100',
    mat16: identity,
    spatialBounds: { min: [-72, -38, -3], max: [42, 38, 12], childCount: 236 },
};
streamer._mloInstancesLast = [boundedRoot];
assert.equal(streamer.getInteriorStateAtDataPos([-65, 0, 1])?.roomIndex, 1);
assert.equal(streamer.getInteriorStateAtDataPos([48, 0, 1])?.isExterior, true);
assert.equal(streamer.getInteriorStateAtDataPos([100, 0, 1]), null);

// The non-worker path derives the same envelope from ENT1 child ownership.
const childMatrix = new Float32Array(22);
childMatrix.set(identity, 0);
childMatrix[12] = -65;
childMatrix[18] = 88;
streamer._lastCamDataPos = [-65, 0, 1];
streamer._filterEntriesForActiveInterior([{
    hash: '200',
    mats: childMatrix,
    instanceStrideFloats: 22,
}], [{ parentGuid: 88, archHash: '100', mat16: identity }]);
assert.equal(streamer._activeInterior?.parentGuid, 88);
assert.ok(streamer._mloInstancesLast[0].spatialBounds?.childCount >= 1);

console.log('mlo portal runtime: door binding, traversal, audio, light bleed, and entity sets passed');

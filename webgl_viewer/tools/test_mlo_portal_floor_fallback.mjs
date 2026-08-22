import assert from 'node:assert/strict';
import * as glMatrix from 'gl-matrix';

globalThis.glMatrix = glMatrix;
const { DrawableStreamer } = await import('../js/drawable_streamer.js');

const parentGuid = 267247856;
const archHash = '4279763927';
const matrix = glMatrix.mat4.create();
glMatrix.mat4.translate(matrix, matrix, [-324.08173, -1995.22095, 28.99709]);
const room = {
    index: 1,
    bbMin: [-360.7254, -330.3574, -80.67625],
    bbMax: [360.7254, 330.3572, 80.67625],
};
const portal = (corners) => ({ roomFrom: 1, roomTo: 0, corners });
const definition = {
    rooms: [{ ...room, index: 0 }, room],
    portals: [
        portal([[2.52, 3.581, 0.258], [2.52, 3.581, 3.34], [0.683, 1.315, 3.34], [0.683, 1.315, 0.258]]),
        portal([[-0.16, 0.112, 0], [-0.16, 0.112, 3.34], [-1.12, -1.26, 3.34], [-1.12, -1.26, 0]]),
        portal([[-21.577, 4.757, 0.395], [-21.577, 4.757, 3.138], [-21.577, -2.024, 3.138], [-21.577, -2.024, 0.395]]),
    ],
};
const streamer = Object.create(DrawableStreamer.prototype);
streamer.enableInteriors = true;
streamer._mloInstancesLast = [{ parentGuid, archHash, mat16: matrix }];
streamer._mloDefs = new Map([[archHash, definition]]);
streamer._activeInterior = { parentGuid, archHash, roomIndex: 1 };
streamer._findExteriorRoomIndex = () => 0;

const point = [-342.68284, -1993.86590, 30.2]; // active-room local [-18.60, 1.355, 1.203]
const ground = streamer.getInteriorFloorAtDataPos(point, { zPadBelow: 14, zPadAbove: 8, maxRaise: 35 });
assert.equal(ground?.inRoom, true);
assert.ok(Math.abs(ground.floorZ - 28.99709) < 1e-4, 'corrupt room bounds must recover floor Z from authored portal thresholds');

streamer._activeInterior = null;
assert.equal(streamer.getInteriorFloorAtDataPos(point, { zPadBelow: 14, zPadAbove: 8, maxRaise: 35 }), null,
    'portal fallback must be scoped to the active room');

console.log('MLO portal-derived floor fallback passed');

import assert from 'node:assert/strict';
import { glMatrix } from '../js/glmatrix.js';
import { DrawableStreamer } from '../js/drawable_streamer.js';


const streamer = Object.create(DrawableStreamer.prototype);
streamer._mloDefs = new Map();
streamer.interiorPortalDepth = 3;
streamer.interiorExteriorDistance = 80;
streamer.interiorMaxRootDistance = 120;
streamer.enableRoomGating = true;
streamer._mloPortalOpenOverrides = new Map();

const definition = {
  rooms: [
    { name: 'limbo', bbMin: [-360, -330, -80], bbMax: [360, 330, 80] },
    { name: 'interior', bbMin: [-360, -330, -80], bbMax: [360, 330, 80] },
  ],
  portals: [{ roomFrom: 1, roomTo: 0, flags: 0 }],
};
streamer._mloDefs.set('near', definition);
streamer._mloDefs.set('far', definition);

const instance = (archHash, parentGuid, x) => {
  const matrix = glMatrix.mat4.create();
  glMatrix.mat4.fromTranslation(matrix, [x, 0, 0]);
  return { archHash, parentGuid, mat16: matrix };
};

const active = streamer._resolveActiveInterior([
  instance('far', 1, 0),
  instance('near', 2, 100),
], [95, 0, 0]);
assert.equal(active?.archHash, 'near', 'nearest overlapping sentinel interior should win');
assert.equal(active?.parentGuid, 2);

const outside = streamer._resolveActiveInterior([
  instance('far', 1, 0),
  instance('near', 2, 100),
], [500, 0, 0]);
assert.equal(outside, null, 'sentinel room bounds must not claim distant players');

const reversedDefinition = {
  rooms: [
    { name: 'limbo', bbMin: [-100, -100, -50], bbMax: [100, 100, 50] },
    { name: 'studio', bbMin: [-6, -14, 10.6], bbMax: [20, 18, 5.1] },
  ],
  portals: [],
};
streamer._mloDefs.set('reversed', reversedDefinition);
const reversedInstance = instance('reversed', 3, 68.8);
const reversedActive = streamer._resolveActiveInterior([reversedInstance], [68.8, 0, 7.0]);
assert.equal(reversedActive?.roomIndex, 1, 'descending room bounds must still identify the authored interior');
streamer.enableInteriors = true;
streamer._mloInstancesLast = [reversedInstance];
const reversedFloor = streamer.getInteriorFloorAtDataPos([68.8, 0, 7.0]);
assert.ok(reversedFloor, 'descending room bounds must produce an interior floor');
assert.ok(Math.abs(reversedFloor.floorZ - 5.1) < 1e-4, `expected normalized room floor 5.1, got ${reversedFloor.floorZ}`);

console.log('MLO overlap selection passed');

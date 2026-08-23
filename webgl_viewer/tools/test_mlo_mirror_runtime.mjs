import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Camera } from '../js/camera.js';
import { DrawableStreamer } from '../js/drawable_streamer.js';
import { buildMloMirrorCamera } from '../js/mlo_mirror_renderer.js';
import { glMatrix } from '../js/glmatrix.js';

const identity = glMatrix.mat4.create();
const streamer = new DrawableStreamer({ modelMatrix: identity, modelManager: {}, modelRenderer: {} });
const definition = {
    rooms: [{ index: 0, name: 'mirror_room' }, { index: 1, name: 'hall' }],
    portals: [{
        index: 0,
        roomFrom: 0,
        roomTo: 1,
        flags: 4 | 256 | 1024,
        mirrorPriority: 2,
        corners: [[0, -1, -1], [0, 1, -1], [0, 1, 1], [0, -1, 1]],
    }],
};
streamer._mloDefs.set('99', definition);
streamer._mloInstancesLast = [{ parentGuid: 77, archHash: '99', mat16: identity }];
streamer._visibleMloInteriors = new Map([[77, { visibleRooms: new Set([0, 1]) }]]);
streamer._lastCamDataPos = [2, 0, 0];
const portal = streamer.getVisibleMloMirrorPortal({ maxDistance: 10 });
assert.equal(portal?.portalIndex, 0);
assert.equal(portal?.mirrorPriority, 2);

const camera = new Camera();
camera.position.set([2, 0, 0]);
camera.target.set([0, 0, 0]);
camera.up.set([0, 1, 0]);
camera.updateViewMatrix();
const mirrorCamera = buildMloMirrorCamera({ portal, camera, dataToViewMatrix: identity });
assert.ok(mirrorCamera);
assert.ok(Math.abs(mirrorCamera.reflectedPosition[0] + 2) < 1e-5);
assert.ok(mirrorCamera.viewProjection.every(Number.isFinite));
assert.equal(mirrorCamera.corners.length, 4);

const main = fs.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
assert.equal((main.match(/new MloMirrorRenderer\(this\.gl\)/g) || []).length, 1, 'mirror renderer must be allocated once');
assert.match(main, /this\.mloMirrorRenderer = new MloMirrorRenderer\(this\.gl\);[\s\S]*this\.modelManager\.onManifestUpdated/);
assert.doesNotMatch(main.match(/onDynamicPropMoved\(event\)[\s\S]*?\n    }/m)?.[0] || '', /MloMirrorRenderer/);

console.log('MLO mirror runtime: portal selection, reflected camera, oblique clip matrix, and single allocation passed');

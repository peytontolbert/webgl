import assert from 'node:assert/strict';
import { DoorController } from '../js/gameplay/door_controller.js';
import { InteractionSystem } from '../js/gameplay/interactions.js';

const door = {
    id: 'studio-door',
    type: 'door',
    action: 'use_door',
    label: 'Studio Door',
    archetypeHash: '3667038197',
    coords: { x: 10.6, y: 20, z: 2 },
    origin: { x: 10, y: 20, z: 2 },
    radius: 2.35,
    automatic: false,
    locked: false,
    source: 'FiveM MLO loose YDR: StudioDoor.ydr',
};
const stride = 21;
const instanceData = new Float32Array(stride);
instanceData[0] = instanceData[5] = instanceData[10] = instanceData[15] = 1;
instanceData[12] = door.origin.x;
instanceData[13] = door.origin.y;
instanceData[14] = door.origin.z;
const bucket = {
    instanceData,
    instanceStrideFloats: stride,
    sourceHashes: [door.archetypeHash],
};
let bucketUpdates = 0;
const renderer = {
    ready: true,
    instances: new Map(),
    buckets: new Map([['studio-bucket', bucket]]),
    updateInstanceMatricesForBucket(key, output) {
        assert.equal(key, 'studio-bucket');
        bucket.instanceData = output;
        bucketUpdates++;
        return true;
    },
};
const app = {
    multiplayer: { status: 'offline' },
    instancedModelRenderer: renderer,
    collisionWorld: { setDoorDefinitions() {}, setDoorOpenProgress() {} },
    drawableStreamer: { syncMloPortalDoors() {} },
};
const controller = new DoorController(app);
controller.setManifest({ doors: [door] });
for (let frame = 0; frame < 30; frame++) {
    controller.update({ posData: [door.coords.x, door.coords.y, door.coords.z], dt: 1 / 60 });
}
assert.equal(controller.getDoorState(door.id).target, 1, 'unlocked imported MLO doors must proximity-open');
assert.ok(bucketUpdates > 0, 'cross-archetype bucket must receive animated door matrices');
assert.deepEqual(controller.getRuntimeDiagnostics().unboundDoorIds, []);

const interactions = new InteractionSystem();
interactions.setManifest({
    interactions: [{ id: 'generic', label: 'Generic', coords: { x: 10.5, y: 20, z: 2 }, radius: 3 }],
    doors: [door],
});
interactions.update({ posData: [10.5, 20, 2], keyState: {} });
assert.equal(interactions.active?.id, door.id, 'door interaction must not be masked by overlapping generic spots');

console.log('mlo door runtime: metadata proximity, cross-bucket animation, diagnostics, and interaction priority passed');

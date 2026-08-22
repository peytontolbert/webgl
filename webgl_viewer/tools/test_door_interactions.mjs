import assert from 'node:assert/strict';
import { DoorController } from '../js/gameplay/door_controller.js';
import { InteractionSystem } from '../js/gameplay/interactions.js';

const door = {
    id: 'door_test',
    type: 'door',
    action: 'use_door',
    label: 'Test Door',
    archetypeHash: '123',
    coords: { x: 10, y: 20, z: 1 },
    origin: { x: 10, y: 20, z: 0 },
    radius: 2.35,
    motion: 'swing',
    openAmount: Math.PI / 2,
    openSign: 1,
    automatic: false,
    locked: false,
};

const interactions = new InteractionSystem();
interactions.setManifest({ ok: true, doors: [door] });
assert.equal(interactions.spots.filter((spot) => spot.type === 'door').length, 1);
assert.equal(interactions.update({ posData: [10, 20, 1], keyState: {} }), null);
assert.equal(interactions.update({ posData: [10, 20, 1], keyState: { e: true } })?.type, 'use_door');
assert.equal(interactions.update({ posData: [10, 20, 1], keyState: { e: true } }), null);

const instanceData = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    10, 20, 0, 1,
]);
const entry = {
    hash: '123',
    lod: 'high',
    minDist: 0,
    instanceStrideFloats: 16,
    instanceData,
};
let uploaded = null;
let collisionProgress = 0;
const app = {
    multiplayer: { status: 'offline' },
    instancedModelRenderer: {
        ready: true,
        instances: new Map([['123:high', entry]]),
        updateInstanceMatricesForArchetype(_hash, _lod, matrices) {
            uploaded = new Float32Array(matrices);
            entry.instanceData.set(matrices);
            return true;
        },
    },
    collisionWorld: {
        setDoorDefinitions(records) { assert.equal(records.length, 1); },
        setDoorOpenProgress(id, progress) {
            assert.equal(id, door.id);
            collisionProgress = progress;
        },
    },
};

const controller = new DoorController(app);
controller.setManifest({ doors: [door] });
controller.update({
    posData: [10, 20, 1],
    action: { type: 'use_door', spot: { id: door.id } },
    dt: 0.25,
});
assert.ok(controller.getDoorState(door.id).progress > 0.9);
assert.ok(collisionProgress > 0.9);
assert.ok(uploaded);
assert.equal(uploaded[12], 10);
assert.equal(uploaded[13], 20);
assert.ok(Math.abs(uploaded[0]) < 0.01);
assert.ok(Math.abs(uploaded[1] - 1) < 0.01);

controller.update({
    posData: [10, 20, 1],
    action: { type: 'use_door', spot: { id: door.id } },
    dt: 0.25,
});
for (let index = 0; index < 8; index++) controller.update({ posData: [30, 40, 1], dt: 0.25 });
assert.equal(controller.getDoorState(door.id).progress, 0);
assert.equal(collisionProgress, 0);

console.log('door interactions: manual input edge, animation, and collision state passed');

import assert from 'node:assert/strict';
import { CollisionWorld } from '../js/gameplay/collision_world.js';

function worldWith(collider) {
    const world = new CollisionWorld({ groundPedToTerrain: false });
    world.resolveGround = () => ({ z: 0, source: 'ybn', material: 'asphalt' });
    world.setAssetColliders([{
        id: collider.id,
        archetypeHash: collider.id,
        source: 'test_bounds',
        x: collider.x,
        y: collider.y,
        minZ: collider.minZ,
        maxZ: collider.maxZ,
        halfX: collider.halfX,
        halfY: collider.halfY,
        axisXX: 1,
        axisXY: 0,
        axisYX: 0,
        axisYY: 1,
    }]);
    return world;
}

function drive(world, overrides = {}) {
    return world.moveVehicle({
        x: 0,
        y: 0,
        feetZ: 0,
        heading: 0,
        vx: 6,
        vy: 0,
        dt: 1,
        halfWidth: 0.9,
        halfLength: 1.65,
        chassisClearance: 0.22,
        chassisHeight: 1.15,
        wheelRadius: 0.4,
        maxStepUp: 0.65,
        ...overrides,
    });
}

{
    const curb = worldWith({ id: 'curb', x: 2, y: 0, minZ: 0, maxZ: 0.2, halfX: 0.1, halfY: 4 });
    const result = drive(curb);
    assert.equal(result.blocked, false, 'wheel clearance must carry the chassis over a 20 cm curb');
    assert.equal(result.surface, 'asphalt');
}

{
    const wall = worldWith({ id: 'wall', x: 3, y: 0, minZ: 0, maxZ: 2.5, halfX: 0.15, halfY: 4 });
    const result = drive(wall);
    assert.equal(result.blocked, true, 'a wall must hit the raised chassis');
    assert.equal(result.hit?.id, 'wall');
    assert.ok(result.hit?.chassisProbeOffset > 0, 'the front chassis lobe must make first contact');
}

{
    const gate = worldWith({ id: 'gate', x: 3, y: 0, minZ: 0.8, maxZ: 1.2, halfX: 0.1, halfY: 4 });
    gate.setDoorDefinitions([{
        id: 'gate-door', archetypeHash: 'gate', coords: { x: 3, y: 0, z: 1 }, passageRadius: 5, passageHalfHeight: 2,
    }]);
    assert.equal(drive(gate).blocked, true, 'closed gate must block the chassis');
    gate.setDoorOpenProgress('gate-door', 1);
    assert.equal(drive(gate).blocked, false, 'open gate must release the chassis collider');
}

console.log('vehicle chassis collision: curb clearance, oriented body wall contact, and gates passed');

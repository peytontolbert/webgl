import assert from 'node:assert/strict';
import { WeaponController } from '../js/gameplay/weapon_controller.js';

const app = {
    ped: { posData: [10, 20, 31.2] },
    pedEyeHeightData: 1.2,
    player: { headingRad: 0 },
    camera: { position: [4, 16, 34] },
    _viewerPosToDataPos: (value) => [...value],
    _getGameplayAimDirectionData: () => [1, 0, 0],
    collisionWorld: { raycast: () => null },
    npcSystem: { raycast: () => null },
};

const weapon = new WeaponController(app);
weapon.phase = 'equipped';
weapon.aimHeld = true;
weapon._buildTracer();

const shot = weapon.getStatus().lastShot;
assert.deepEqual(shot.reticle.origin, [4, 16, 34], 'the center-screen reticle must trace from the camera');
assert.deepEqual(shot.network.origin, app.ped.posData, 'the authoritative ray must use the server-validated ped eye');
const networkEnd = shot.network.origin.map((value, index) => value + shot.network.direction[index] * shot.network.maxDistance);
assert.ok(Math.hypot(networkEnd[0] - 94, networkEnd[1] - 16, networkEnd[2] - 34) < 0.01,
    'the authoritative ray must converge on the camera reticle target');

console.log('weapon controller targeting tests passed');

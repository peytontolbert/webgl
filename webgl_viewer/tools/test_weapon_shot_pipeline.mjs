import assert from 'node:assert/strict';

import { WeaponController } from '../js/gameplay/weapon_controller.js';

const npcPoint = [0, 10, 1.56];
const app = {
  ped: { posData: [0, 0, 1.2] },
  pedEyeHeightData: 1.2,
  player: { headingRad: Math.PI / 2 },
  camera: { position: [0, -3, 2], direction: [0, 1, 0] },
  _viewerPosToDataPos: (position) => position.slice(),
  _getGameplayAimDirectionData: () => [0, 1, 0],
  _getWeaponRightHandPose: () => null,
  collisionWorld: { raycast: () => null },
  npcSystem: {
    raycast: () => ({ id: 'ambient_test', zone: 'head', distance: 10, point: npcPoint.slice() }),
    applyBulletHit: () => ({ applied: true, damage: 110, lethal: true }),
  },
};

const weapon = new WeaponController(app);
weapon.phase = 'equipped';
weapon.aimHeld = true;
weapon.aimRequested = true;
const tracer = weapon._buildTracer();

assert.equal(tracer.hit.npcId, 'ambient_test');
assert.equal(tracer.hit.zone, 'head');
assert.equal(weapon.lastShotDiagnostics.result.source, 'npc');
assert.equal(weapon.lastShotDiagnostics.network.npcId, 'ambient_test');
assert.equal(weapon.lastShotDiagnostics.network.zone, 'head');
assert.deepEqual(weapon.lastShotDiagnostics.network.impactPoint, npcPoint);
assert.ok(Math.abs(Math.hypot(...weapon.lastShotDiagnostics.network.direction) - 1) < 1e-9);
assert.ok(weapon.lastShotDiagnostics.network.maxDistance > 0);

console.log('weapon shot pipeline test passed');

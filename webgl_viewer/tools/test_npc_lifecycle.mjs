import assert from 'node:assert/strict';

import { NpcSystem } from '../js/gameplay/npc_system.js';

const app = {
  spawnDistrictDemo: false,
  ped: { posData: [0, 0, 1.2] },
  player: { enabled: true },
  meleeController: { lifeState: 'dead', playerHealth: 0, receiveNpcHit: () => { throw new Error('dead player was hit'); } },
};
const system = new NpcSystem(app, null);
system.npcs.push({
  id: 'hostile_1', role: 'civilian', state: 'attack', hostile: true,
  x: 0.5, y: 0, feetZ: 0, homeX: 0.5, homeY: 0,
  targetX: 0, targetY: 0, attackRemaining: 1, attackElapsed: 0.9,
  attackHitAt: 1, attackDidHit: false, attackCooldown: 0,
  fleeRemaining: 0, impactCooldown: 0, stateElapsed: 0, retargetIn: 0,
});
system.npcs.push({
  id: 'police_1', role: 'police', state: 'shooting', hostile: true, weapon: 'pistol',
  x: 4, y: 0, feetZ: 0, homeX: 4, homeY: 0,
  targetX: 0, targetY: 0, attackRemaining: 0, attackElapsed: 0,
  attackDidHit: false, attackCooldown: 0, fleeRemaining: 0,
  impactCooldown: 0, stateElapsed: 0, retargetIn: 0, retireElapsed: 5.98,
});

system.update(0.05);
assert.equal(system.wantedLevel, 0);
assert.equal(system.npcs.some((npc) => npc.id === 'police_1'), false);
const hostile = system.getById('hostile_1');
assert.equal(hostile.hostile, false);
assert.equal(hostile.attackRemaining, 0);
assert.equal(hostile.attackDidHit, true);
assert.equal(hostile.state, 'wander');

console.log('npc lifecycle test passed');

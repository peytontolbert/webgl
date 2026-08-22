import assert from 'node:assert/strict';

import { NpcSystem } from '../js/gameplay/npc_system.js';

const surfaces = [29.0, 31.2, 32.25, 35.5];
const collisionWorld = {
  resolveGround(_x, _y, hint, options) {
    assert.equal(options.preferInterior, true);
    assert.ok(options.maxRise === 1.15 || options.maxRise === 1.75);
    assert.equal(options.maxDrop, 12.0);
    assert.equal(options.nearestToHint, false);
    const candidates = surfaces.filter((z) => z >= hint - options.maxDrop && z <= hint + options.maxRise);
    const z = candidates.sort((a, b) => b - a)[0];
    return Number.isFinite(z) ? { z, source: 'ybn' } : null;
  },
};

const system = new NpcSystem({ spawnDistrictDemo: false }, collisionWorld);
const now = performance.now();
const npc = {
  id: 'network_npc',
  x: 10,
  y: 20,
  feetZ: 30.8,
  heading: 0,
  _networkSamples: [
    { at: now - 200, x: 10, y: 20, feetZ: 30.8, heading: 0 },
    { at: now, x: 11, y: 20, feetZ: 30.8, heading: 0 },
  ],
};

system._updateNetworkTransform(npc, now);
assert.equal(npc.networkFeetZ, 30.8);
assert.equal(npc.feetZ, 32.25, 'a floor intersecting the standing capsule should depenetrate the NPC upward');

collisionWorld.resolveGround = (_x, _y, hint, options) => {
  const candidates = [29.0, 31.2, 33.0].filter((z) => z >= hint - options.maxDrop && z <= hint + options.maxRise);
  const z = candidates.sort((a, b) => b - a)[0];
  return Number.isFinite(z) ? { z, source: 'ybn' } : null;
};
npc._networkGroundRefreshAt = 0;
system._updateNetworkTransform(npc, now);
assert.equal(npc.feetZ, 31.2, 'recovery must not snap to a floor above the standing capsule');

collisionWorld.resolveGround = (_x, _y, hint) => ({ z: hint, source: 'runtime' });
npc._networkGroundRefreshAt = 0;
system._updateNetworkTransform(npc, now);
assert.equal(npc.feetZ, 30.8, 'missing local collision must preserve the server height');

console.log('npc network grounding test passed');

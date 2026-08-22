import assert from 'node:assert/strict';
import { MeleeController } from '../js/gameplay/melee_controller.js';

let respawnCalls = 0;
const app = {
    ped: { posData: [0, 0, 1.2] },
    player: { enabled: true },
    settingsMenuOpen: false,
    weaponController: { isVisible: () => false },
    respawnPlayerFromDeath: () => { respawnCalls++; return true; },
};
const melee = new MeleeController(app);

melee.applyAuthoritativeState({ health: 0, armor: 0, dead: true });
assert.equal(melee.getStatus().lifeState, 'dead');
assert.equal(melee.getMovementScale(), 0);

melee.applyAuthoritativeState({ health: 100, armor: 25, dead: false });
assert.equal(melee.getStatus().lifeState, 'alive', 'a healthy character activation clears stale local death');
assert.equal(melee.getStatus().health, 100);
assert.equal(melee.getStatus().armor, 25);
assert.equal(melee.getMovementScale(), 1);
assert.equal(respawnCalls, 0, 'join reconciliation must not teleport through the respawn path');

melee._setLifeState('knockdown', 5, 'melee_knockdown');
melee.applyAuthoritativeState({ health: 80, armor: 0, dead: false });
assert.equal(melee.getStatus().lifeState, 'knockdown', 'healthy synchronization preserves temporary knockdown');

melee.applyAuthoritativeState({ health: 100, armor: 0, dead: false, respawn: true });
assert.equal(melee.getStatus().lifeState, 'alive');
assert.equal(respawnCalls, 1);

console.log('player life-state reconciliation passed');

import assert from 'node:assert/strict';
import { NpcSystem } from '../js/gameplay/npc_system.js';

const receivedHits = [];
const app = {
    spawnDistrictDemo: true,
    spawnDistrictBounds: { minX: -250, maxX: 250, minY: -250, maxY: 250 },
    _spawnDistrictDescriptor: { spawn: { x: 0, y: 0, pedZ: 30 } },
    ped: { posData: [0, 0, 30] },
    player: { enabled: true },
    meleeController: {
        lifeState: 'alive',
        playerHealth: 100,
        receiveNpcHit(npc, damage) {
            receivedHits.push({ npc: npc.id, damage });
            return true;
        },
    },
};
const collisionWorld = {
    resolveGround(x, y) { return { z: 30, x, y }; },
    moveCapsule({ x, y, feetZ, vx, vy, dt }) {
        return { x: x + vx * dt, y: y + vy * dt, feetZ, ground: { z: feetZ }, blocked: false };
    },
    raycast() { return null; },
};

const system = new NpcSystem(app, collisionWorld);
assert.equal(system.ensureDemoCrowd(), true);
const victim = system.npcs.find((npc) => npc.role === 'civilian');
const bodyHit = system.applyBulletHit(victim.id, { damage: 38, direction: [1, 0], force: 5.2, zone: 'torso' });
assert.equal(bodyHit.applied, true);
assert.equal(bodyHit.lethal, false);
assert.equal(bodyHit.state, 'hit');
assert.equal(victim.state, 'hit');
assert.equal(system.wantedLevel, 1);

system._ensurePoliceResponse(0, 0);
assert.equal(system.npcs.filter((npc) => npc.role === 'police').length, 1);
system._ensurePoliceResponse(0, 0);
assert.equal(system.npcs.filter((npc) => npc.role === 'police').length, 1);

const officer = system.npcs.find((npc) => npc.role === 'police');
officer.weapon = 'pistol';
system._random = () => 0;
assert.equal(system._fireNpcPistol(officer, 10), true);
assert.equal(system.shotEffects.length, 1);
assert.equal(system.lastShot.npcId, officer.id);
assert.equal(system.lastShot.hit, true);
assert.equal(receivedHits.length, 1);

system.collisionWorld.raycast = () => { throw new Error('collision unavailable'); };
assert.equal(system._hasLineOfSightToPlayer(officer, 10), false);

console.log('npc_system parity tests passed');

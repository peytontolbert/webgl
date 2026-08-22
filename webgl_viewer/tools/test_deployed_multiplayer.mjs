import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const endpoint = process.argv[2] || 'ws://192.168.0.85:5173/__multiplayer';

function connect(label, x, y = 0, feetZ = 0) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    const messages = [];
    const timer = setTimeout(() => reject(new Error(`Timed out connecting ${label}`)), 5_000);
    socket.on('message', (data) => {
      const message = JSON.parse(data);
      messages.push(message);
      if (message.type !== 'welcome') return;
      clearTimeout(timer);
      resolve({ socket, messages, welcome: message });
    });
    socket.on('error', reject);
    socket.on('open', () => socket.send(JSON.stringify({
      type: 'join', sessionId: `${label}-${randomUUID()}`, name: label,
      state: { x, y, feetZ, heading: 0, gait: 'idle' },
    })));
  });
}

function next(client, type, timeout = 3_000) {
  const existing = client.messages.find((message) => message.type === type);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `Timed out waiting for ${type}; recent messages=${JSON.stringify(client.messages.slice(-8))}`
    )), timeout);
    const handler = (data) => {
      const message = JSON.parse(data);
      if (message.type !== type) return;
      clearTimeout(timer);
      client.socket.off('message', handler);
      resolve(message);
    };
    client.socket.on('message', handler);
  });
}

function nextMatching(client, type, predicate, timeout = 4_000) {
  const existing = client.messages.find((message) => message.type === type && predicate(message));
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for matching ${type}`)), timeout);
    const handler = (data) => {
      const message = JSON.parse(data);
      if (message.type !== type || !predicate(message)) return;
      clearTimeout(timer);
      client.socket.off('message', handler);
      resolve(message);
    };
    client.socket.on('message', handler);
  });
}

let attacker;
let target;
let collector;
try {
  attacker = await connect('deployed-attacker', 186.94, -850.84, 31.17);
  assert.equal(attacker.welcome.adminCommands, true, 'deployed demo must expose enabled admin commands');
  attacker.messages.length = 0;
  attacker.socket.send(JSON.stringify({ type: 'admin_command', command: 'money', args: { amount: 1 } }));
  const adminResult = await next(attacker, 'admin_result');
  assert.equal(adminResult.result.success, true, 'deployed demo must execute enabled admin commands');
  assert.equal(attacker.welcome.world.length, 6, 'deployed demo includes the authoritative ambient pedestrians');
  assert.ok(attacker.welcome.world.every((npc) => npc.role === 'civilian' && npc.modelHash), 'deployed NPC snapshots include model identifiers');
  assert.ok(Array.isArray(attacker.welcome.world) && attacker.welcome.world.length >= 6);
  assert.ok(attacker.welcome.world.every((npc) => (
    String(npc.id || '').startsWith('ambient_')
    && /^\d+$/.test(String(npc.modelHash || ''))
    && Number.isFinite(Number(npc.x))
    && Number.isFinite(Number(npc.y))
    && Number.isFinite(Number(npc.feetZ))
  )));
  target = await connect('deployed-target', 191.94, -850.84, 31.17);
  assert.deepEqual(
    target.welcome.world.map((npc) => npc.id).sort(),
    attacker.welcome.world.map((npc) => npc.id).sort(),
  );
  attacker.messages.length = 0;
  target.messages.length = 0;
  const eventId = `deployed-shot-${randomUUID()}`;
  attacker.socket.send(JSON.stringify({ type: 'action', action: { kind: 'shoot', eventId, direction: [1, 0, 0] } }));
  const damaged = await next(target, 'player_state');
  const accepted = await next(attacker, 'gameplay_event');
  assert.equal(damaged.profile.health, 62);
  assert.equal(accepted.eventId, eventId);
  assert.equal(accepted.profile.inventory.pistol_ammo, 67);
  assert.equal(accepted.result.hit, true);
  attacker.messages.length = 0;
  const policeWorld = await nextMatching(attacker, 'world_state', (message) => (
    message.npcs?.filter((npc) => npc.role === 'police' && npc.hostile).length >= 2
  ));
  const officer = policeWorld.npcs
    .filter((npc) => npc.role === 'police' && npc.hostile)
    .sort((a, b) => a.x - b.x)[0];
  const origin = [186.94, -850.84, 32.37];
  const toOfficer = [officer.x - origin[0], officer.y - origin[1], officer.feetZ + 1.1 - origin[2]];
  const rayLength = Math.hypot(...toOfficer);
  await new Promise((resolve) => setTimeout(resolve, 90));
  attacker.messages.length = 0;
  attacker.socket.send(JSON.stringify({
    type: 'action',
    action: {
      kind: 'shoot', eventId: `deployed-police-shot-${randomUUID()}`, origin,
      direction: toOfficer.map((value) => value / rayLength), maxDistance: rayLength + 1,
    },
  }));
  const policeHit = await next(attacker, 'gameplay_event');
  assert.equal(policeHit.result.npcId, officer.id,
    `the deployed server must authoritatively hit a police NPC: ${JSON.stringify(policeHit.result)}`);
  assert.equal(policeHit.result.hit, true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  attacker.messages.length = 0;
  const refreshedWorld = await nextMatching(attacker, 'world_state', (message) => (
    message.npcs?.some((npc) => npc.id === officer.id && npc.state !== 'dead')
  ));
  const refreshedOfficer = refreshedWorld.npcs.find((npc) => npc.id === officer.id);
  const reconciledImpact = [refreshedOfficer.x, refreshedOfficer.y, refreshedOfficer.feetZ + 5.1];
  const reconciledVector = reconciledImpact.map((value, index) => value - origin[index]);
  const reconciledDistance = Math.hypot(...reconciledVector);
  attacker.messages.length = 0;
  attacker.socket.send(JSON.stringify({
    type: 'action',
    action: {
      kind: 'shoot', eventId: `deployed-grounded-shot-${randomUUID()}`, origin,
      direction: reconciledVector.map((value) => value / reconciledDistance), maxDistance: reconciledDistance,
      npcId: refreshedOfficer.id, zone: 'torso', impactPoint: reconciledImpact,
    },
  }));
  const reconciledHit = await next(attacker, 'gameplay_event');
  assert.equal(reconciledHit.result.npcId, refreshedOfficer.id,
    `the deployed server must reconcile visual NPC ground height: ${JSON.stringify(reconciledHit.result)}`);
  assert.equal(reconciledHit.result.groundReconciled, true);
  assert.equal(reconciledHit.result.hit, true);
  attacker.socket.send(JSON.stringify({ type: 'state', state: { x: 9_999, y: 9_999, feetZ: 0, gait: 'walk' } }));
  const correction = await next(attacker, 'state_correction');
  assert.ok(Math.abs(correction.state.x - 186.94) < 0.1);
  collector = await connect('deployed-collector', 193.5, -846.5, 31.17);
  collector.messages.length = 0;
  collector.socket.send(JSON.stringify({ type: 'action', action: { kind: 'collect_pickup', eventId: `pickup-${randomUUID()}`, pickupId: 'pickup_armor_1' } }));
  const pickup = await next(collector, 'gameplay_event');
  assert.equal(pickup.result.type, 'armor');
  assert.equal(pickup.profile.armor, 50);
  console.log(`deployed multiplayer authority passed (${endpoint})`);
} finally {
  attacker?.socket?.terminate();
  target?.socket?.terminate();
  collector?.socket?.terminate();
}

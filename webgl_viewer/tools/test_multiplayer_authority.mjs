import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webglgta-mp-'));
process.env.WEBGLGTA_PROFILE_FILE = path.join(dataDir, 'profiles.json');
process.env.WEBGLGTA_CHARACTER_FILE = path.join(dataDir, 'characters.json');
process.env.WEBGLGTA_ADMIN_COMMANDS = '1';
const { installMultiplayerServer } = await import(`../multiplayer_server.js?test=${Date.now()}`);
const server = http.createServer((_, response) => response.end('ok'));
const multiplayer = installMultiplayerServer(server);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

function connect(sessionId, x = 186.94, y = -850.84, feetZ = 31.17, resumeToken = '', district = 'demo') {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/__multiplayer`);
    const messages = [];
    socket.on('message', (data) => {
      const message = JSON.parse(data);
      messages.push(message);
      if (message.type === 'welcome') resolve({ socket, messages, welcome: message });
    });
    socket.on('error', reject);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'join', district, sessionId, resumeToken, name: sessionId, state: { x, y, feetZ, heading: 0, gait: 'idle' } })));
  });
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/__multiplayer`);
    const messages = [];
    socket.on('message', (data) => messages.push(JSON.parse(data)));
    socket.on('error', reject);
    socket.on('open', () => resolve({ socket, messages }));
  });
}

function next(client, type, timeout = 1500) {
  const existing = client.messages.find((message) => message.type === type);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeout);
    const handler = (data) => {
      const message = JSON.parse(data);
      if (message.type !== type) return;
      clearTimeout(timer); client.socket.off('message', handler); resolve(message);
    };
    client.socket.on('message', handler);
  });
}

let attacker;
let target;
let collector;
let banker;
let doorUser;
let character;
let profileOwner;
let duplicateProfile;
let weedVisitor;
try {
  character = await openSocket();
  character.socket.send(JSON.stringify({ type: 'character_bootstrap', accountId: '11111111-1111-4111-8111-111111111111' }));
  let slots = await next(character, 'character_slots');
  assert.deepEqual(slots.slots, []);
  character.messages.length = 0;
  character.socket.send(JSON.stringify({ type: 'character_create', name: 'Door Tester' }));
  slots = await next(character, 'character_slots');
  assert.equal(slots.slots.length, 1);
  assert.equal(slots.slots[0].name, 'Door Tester');
  character.messages.length = 0;
  character.socket.send(JSON.stringify({
    type: 'character_activate', token: slots.slots[0].token, sessionId: 'character-session',
    state: { x: 0, y: 0, feetZ: 0, heading: 0, gait: 'idle' },
  }));
  const characterWelcome = await next(character, 'welcome');
  assert.equal(characterWelcome.resumeToken, slots.slots[0].token);
  const doorCount = JSON.parse(fs.readFileSync(path.resolve('assets', 'demo', 'interactables.json'), 'utf8')).doors.length;
  assert.equal(characterWelcome.doors.length, doorCount);
  assert.equal(characterWelcome.world.length, 6, 'the demo starts with its authoritative ambient pedestrian set');
  assert.ok(characterWelcome.world.every((npc) => npc.role === 'civilian' && npc.modelHash), 'NPC snapshots include a renderable native ped model');
  character.socket.close();
  profileOwner = await connect('profile-owner', 186.94, -850.84, 31.17, characterWelcome.resumeToken);
  duplicateProfile = await openSocket();
  duplicateProfile.socket.send(JSON.stringify({
    type: 'join', sessionId: 'profile-clone', resumeToken: characterWelcome.resumeToken, name: 'profile-clone',
    state: { x: 186.94, y: -850.84, feetZ: 31.17, heading: 0, gait: 'idle' },
  }));
  const duplicateRejected = await next(duplicateProfile, 'profile_in_use');
  assert.equal(duplicateRejected.code, 'profile_in_use');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(multiplayer.hub.rooms.get('demo').size, 1, 'one profile must have one active peer');
  profileOwner.socket.terminate();
  await new Promise((resolve) => setTimeout(resolve, 40));
  duplicateProfile.socket.close();
  duplicateProfile = await connect('profile-reconnect', 186.94, -850.84, 31.17, characterWelcome.resumeToken);
  assert.equal(duplicateProfile.welcome.id, profileOwner.welcome.id, 'an owner may reconnect after its socket leaves');
  weedVisitor = await connect('weed-shop-visitor', -33.01, -1038.05, 29.17, '', 'weed_shop');
  assert.equal(weedVisitor.welcome.room, 'weed_shop');
  assert.ok(Math.abs(weedVisitor.welcome.state.x + 33.01) < 0.01, 'weed-shop joins retain the isolated MLO spawn');
  attacker = await connect('attacker');
  target = await connect('target', 191.94, -850.84, 31.17);
  attacker.socket.send(JSON.stringify({
    type: 'state',
    state: {
      x: 186.94, y: -850.84, feetZ: 31.17, heading: 0, gait: 'run', move01: 0.5,
      locomotionTransition: { active: true, clip: 'locomotion_start_run_left', progress: 0.35 },
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(multiplayer.hub.rooms.get('demo').get(attacker.welcome.id).state.locomotionTransition, {
    active: true, clip: 'locomotion_start_run_left', progress: 0.35,
  }, 'valid native locomotion transitions must replicate to remote players');
  attacker.socket.send(JSON.stringify({
    type: 'state',
    state: {
      x: 186.94, y: -850.84, feetZ: 31.17, heading: 0, gait: 'run', move01: 0.5,
      locomotionTransition: { active: true, clip: 'untrusted_clip', progress: 0.5 },
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(multiplayer.hub.rooms.get('demo').get(attacker.welcome.id).state.locomotionTransition, null,
    'the server must reject transition names outside the exported native clip set');
  attacker.messages.length = 0;
  target.messages.length = 0;
  attacker.socket.send(JSON.stringify({ type: 'action', action: { kind: 'shoot', eventId: 'shot-1', direction: [1, 0, 0] } }));
  const damaged = await next(target, 'player_state');
  assert.equal(damaged.profile.health, 62);
  assert.equal(damaged.profile.inventory.pistol_ammo, 68);
  const shot = await next(attacker, 'gameplay_event');
  assert.equal(shot.profile.inventory.pistol_ammo, 67);
  const world = multiplayer.hub.rooms.get('demo').world;
  const testOfficer = {
    id: 'test-officer', role: 'police', state: 'combat', health: 100,
    x: 189.94, y: -844.84, feetZ: 31.17, hostileTo: '', fleeFrom: '', deadUntil: 0,
    positionHistory: [{ at: Date.now(), x: 186.94, y: -844.84, feetZ: 31.17 }],
  };
  attacker.messages.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 120));
  world.npcs.push(testOfficer);
  attacker.socket.send(JSON.stringify({
    type: 'action',
    action: { kind: 'shoot', eventId: 'shot-police', origin: [186.94, -850.84, 32.37], direction: [0, 1, 0] },
  }));
  const policeShot = await next(attacker, 'gameplay_event');
  assert.equal(policeShot.result.npcId, testOfficer.id, `the rewound authoritative body ray must hit police NPCs: ${JSON.stringify(policeShot.result)}`);
  assert.equal(policeShot.result.hit, true);
  assert.equal(testOfficer.health, 62);
  assert.equal(testOfficer.state, 'combat', 'a surviving police officer must engage rather than flee');
  assert.equal(testOfficer.hostileTo, attacker.welcome.id);
  const groundedNpc = {
    id: 'grounded-target', role: 'civilian', state: 'wander', health: 100,
    x: 186.94, y: -848.84, feetZ: 24.0, hostileTo: '', fleeFrom: '', deadUntil: 0,
    positionHistory: [],
  };
  world.npcs.push(groundedNpc);
  await new Promise((resolve) => setTimeout(resolve, 120));
  attacker.messages.length = 0;
  const groundedImpact = [groundedNpc.x, groundedNpc.y, 32.27];
  const groundedOrigin = [186.94, -850.84, 32.37];
  const groundedVector = groundedImpact.map((value, index) => value - groundedOrigin[index]);
  const groundedDistance = Math.hypot(...groundedVector);
  attacker.socket.send(JSON.stringify({
    type: 'action',
    action: {
      kind: 'shoot', eventId: 'shot-ground-reconciled', origin: groundedOrigin,
      direction: groundedVector.map((value) => value / groundedDistance), maxDistance: groundedDistance,
      npcId: groundedNpc.id, zone: 'torso', impactPoint: groundedImpact,
    },
  }));
  const groundedShot = await next(attacker, 'gameplay_event');
  assert.equal(groundedShot.result.npcId, groundedNpc.id, JSON.stringify(groundedShot.result));
  assert.equal(groundedShot.result.hit, true);
  assert.equal(groundedShot.result.groundReconciled, true);
  assert.equal(groundedNpc.health, 62);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.ok(world.npcs.some((npc) => npc.role === 'police'));
  assert.ok(world.npcs.filter((npc) => npc.role === 'police').length <= 12);
  world.wanted.get(attacker.welcome.id).expiresAt = Date.now() - 1;
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.ok(world.npcs.filter((npc) => npc.role === 'police').every((npc) => !npc.hostileTo && npc.state === 'retiring'));
  for (const npc of world.npcs) if (npc.role === 'police') npc.retireAt = Date.now() - 1;
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(world.npcs.some((npc) => npc.role === 'police'), false);
  attacker.socket.send(JSON.stringify({ type: 'action', action: { kind: 'shoot', eventId: 'shot-1', direction: [1, 0, 0] } }));
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal(attacker.messages.filter((message) => message.type === 'gameplay_event').length, 1);
  attacker.socket.send(JSON.stringify({ type: 'state', state: { x: 9999, y: 9999, feetZ: 0, gait: 'walk' } }));
  const correction = await next(attacker, 'state_correction');
  assert.ok(Math.abs(correction.state.x - 186.94) < 0.1);
  attacker.messages.length = 0;
  attacker.socket.send(JSON.stringify({ type: 'admin_command', command: 'money', args: { amount: 500 } }));
  let admin = await next(attacker, 'admin_result');
  assert.equal(admin.result.success, true);
  assert.equal(admin.profile.money, 3000);
  attacker.messages.length = 0;
  attacker.socket.send(JSON.stringify({ type: 'admin_command', command: 'spawn', args: { item: 'ammo', amount: 12 } }));
  admin = await next(attacker, 'admin_result');
  assert.equal(admin.profile.inventory.pistol_ammo, 77);
  attacker.messages.length = 0;
  attacker.socket.send(JSON.stringify({ type: 'admin_command', command: 'teleport', args: { x: -8.28, y: -1076.25, z: 33.1 } }));
  admin = await next(attacker, 'admin_result');
  assert.equal(admin.result.success, true);
  assert.deepEqual(admin.profile.position, [-8.28, -1076.25, 33.1]);
  attacker.messages.length = 0;
  attacker.socket.send(JSON.stringify({ type: 'admin_command', command: 'noclip', args: { enabled: true } }));
  admin = await next(attacker, 'admin_result');
  assert.equal(admin.result.enabled, true);
  attacker.messages.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 50));
  attacker.socket.send(JSON.stringify({ type: 'state', state: { x: 400, y: -650, feetZ: 80, gait: 'sprint' } }));
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.ok(Math.abs(multiplayer.hub.rooms.get('demo').get(attacker.welcome.id).state.x - 400) < 0.01);
  assert.equal(attacker.messages.some((message) => message.type === 'state_correction'), false);
  collector = await connect('collector', 193.5, -846.5, 31.17);
  collector.messages.length = 0;
  collector.socket.send(JSON.stringify({ type: 'action', action: { kind: 'collect_pickup', eventId: 'pickup-1', pickupId: 'pickup_armor_1' } }));
  const pickup = await next(collector, 'gameplay_event');
  assert.equal(pickup.result.type, 'armor');
  assert.equal(pickup.profile.armor, 50);
  banker = await connect('banker', 149.05, -1041.30, 29.37);
  assert.equal(banker.welcome.profile.banking.checking, 5000);
  assert.equal(banker.welcome.profile.banking.card.pin, undefined, 'card PIN must not be sent to the client');
  const bankAction = async (action) => {
    banker.messages.length = 0;
    banker.socket.send(JSON.stringify({ type: 'action', action }));
    return next(banker, 'gameplay_event');
  };
  let bankEvent = await bankAction({ kind: 'bank_deposit', eventId: 'bank-deposit', accountName: 'checking', amount: 400, reason: 'Test deposit' });
  assert.equal(bankEvent.result.success, true);
  assert.equal(bankEvent.profile.money, 2100);
  assert.equal(bankEvent.profile.banking.checking, 5400);
  bankEvent = await bankAction({ kind: 'bank_withdraw', eventId: 'bank-withdraw', accountName: 'checking', amount: 250, reason: 'Test withdrawal' });
  assert.equal(bankEvent.result.success, true);
  assert.equal(bankEvent.profile.money, 2350);
  assert.equal(bankEvent.profile.banking.checking, 5150);
  bankEvent = await bankAction({ kind: 'bank_open_account', eventId: 'bank-open-shared', accountName: 'Demo Shared', amount: 800 });
  assert.equal(bankEvent.result.success, true);
  assert.equal(bankEvent.profile.banking.checking, 4350);
  assert.equal(bankEvent.profile.banking.sharedAccounts[0].balance, 800);
  bankEvent = await bankAction({ kind: 'bank_internal_transfer', eventId: 'bank-internal', fromAccountName: 'checking', toAccountName: 'Demo Shared', amount: 400, reason: 'Move funds' });
  assert.equal(bankEvent.result.success, true);
  assert.equal(bankEvent.profile.banking.checking, 3950);
  assert.equal(bankEvent.profile.banking.sharedAccounts[0].balance, 1200);
  target.messages.length = 0;
  bankEvent = await bankAction({ kind: 'bank_external_transfer', eventId: 'bank-external', fromAccountName: 'Demo Shared', toAccountNumber: target.welcome.profile.banking.accountNumber, amount: 300, reason: 'Peer payment' });
  assert.equal(bankEvent.result.success, true);
  assert.equal(bankEvent.profile.banking.sharedAccounts[0].balance, 900);
  const recipientUpdate = await next(target, 'bank_profile');
  assert.equal(recipientUpdate.profile.banking.checking, 5300);
  bankEvent = await bankAction({ kind: 'bank_add_user', eventId: 'bank-user', accountName: 'Demo Shared', userAccountNumber: target.welcome.profile.banking.accountNumber });
  assert.equal(bankEvent.result.success, true);
  assert.ok(bankEvent.profile.banking.sharedAccounts[0].users.includes(target.welcome.profile.banking.accountNumber));
  bankEvent = await bankAction({ kind: 'bank_set_card_pin', eventId: 'bank-pin', pin: '4521' });
  assert.equal(bankEvent.result.success, true);
  bankEvent = await bankAction({ kind: 'bank_withdraw', eventId: 'bank-atm-away', accountName: 'checking', amount: 0, channel: 'atm', pin: '4521', verifyOnly: true });
  assert.equal(bankEvent.result.success, false);
  assert.match(bankEvent.result.message, /Stand near a Nexus ATM/);
  await new Promise((resolve) => setTimeout(resolve, 500));
  banker.socket.send(JSON.stringify({ type: 'state', state: { x: 147.47305, y: -1036.21753, feetZ: 28.36778, heading: 0, gait: 'walk' } }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  const bankerPeer = multiplayer.hub.rooms.get('demo').get(banker.welcome.id);
  assert.ok(Math.abs(bankerPeer.state.x - 147.47305) < 0.01);
  bankEvent = await bankAction({ kind: 'bank_withdraw', eventId: 'bank-atm-verify', accountName: 'checking', amount: 0, channel: 'atm', pin: '4521', verifyOnly: true });
  assert.equal(bankEvent.result.success, true);
  bankEvent = await bankAction({ kind: 'bank_withdraw', eventId: 'bank-atm-reject', accountName: 'checking', amount: 0, channel: 'atm', pin: '0000', verifyOnly: true });
  assert.equal(bankEvent.result.success, false);
  attacker.messages.length = 0;
  attacker.socket.send(JSON.stringify({ type: 'action', action: { kind: 'bank_withdraw', eventId: 'bank-too-far', accountName: 'checking', amount: 10 } }));
  const tooFar = await next(attacker, 'gameplay_event');
  assert.equal(tooFar.result.success, false);
  assert.match(tooFar.result.message, /Visit a Nexus Bank branch/);
  const doorDefinition = JSON.parse(fs.readFileSync(path.resolve('assets', 'demo', 'interactables.json'), 'utf8')).doors.find((door) => door.automatic);
  assert.ok(doorDefinition, 'demo export must include an automatic door for close-state coverage');
  doorUser = await connect('door-user', doorDefinition.coords.x, doorDefinition.coords.y, doorDefinition.coords.z);
  assert.equal(doorUser.welcome.doors.length, doorCount);
  doorUser.messages.length = 0;
  doorUser.socket.send(JSON.stringify({
    type: 'action',
    action: { kind: 'door_toggle', eventId: 'door-open', doorId: doorDefinition.id, open: true, automatic: true },
  }));
  const openedDoor = await next(doorUser, 'door_state');
  assert.equal(openedDoor.id, doorDefinition.id);
  assert.equal(openedDoor.open, true);
  doorUser.messages.length = 0;
  const closedDoor = await next(doorUser, 'door_state', 3000);
  assert.equal(closedDoor.id, doorDefinition.id);
  assert.equal(closedDoor.open, false);
  attacker.socket.close(); target.socket.close();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(fs.existsSync(process.env.WEBGLGTA_PROFILE_FILE));
  assert.ok(fs.existsSync(process.env.WEBGLGTA_CHARACTER_FILE));
  console.log('authoritative multiplayer test passed');
} finally {
  character?.socket?.terminate();
  attacker?.socket?.terminate();
  target?.socket?.terminate();
  collector?.socket?.terminate();
  banker?.socket?.terminate();
  doorUser?.socket?.terminate();
  profileOwner?.socket?.terminate();
  duplicateProfile?.socket?.terminate();
  weedVisitor?.socket?.terminate();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
}

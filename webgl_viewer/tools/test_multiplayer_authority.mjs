import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webglgta-mp-'));
process.env.WEBGLGTA_PROFILE_FILE = path.join(dataDir, 'profiles.json');
const { installMultiplayerServer } = await import(`../multiplayer_server.js?test=${Date.now()}`);
const server = http.createServer((_, response) => response.end('ok'));
const multiplayer = installMultiplayerServer(server);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

function connect(sessionId, x, y = 0, feetZ = 0) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/__multiplayer`);
    const messages = [];
    socket.on('message', (data) => {
      const message = JSON.parse(data);
      messages.push(message);
      if (message.type === 'welcome') resolve({ socket, messages, welcome: message });
    });
    socket.on('error', reject);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'join', sessionId, name: sessionId, state: { x, y, feetZ, heading: 0, gait: 'idle' } })));
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
try {
  attacker = await connect('attacker', 0);
  target = await connect('target', 5);
  attacker.messages.length = 0;
  target.messages.length = 0;
  attacker.socket.send(JSON.stringify({ type: 'action', action: { kind: 'shoot', eventId: 'shot-1', direction: [1, 0, 0] } }));
  const damaged = await next(target, 'player_state');
  assert.equal(damaged.profile.health, 62);
  assert.equal(damaged.profile.inventory.pistol_ammo, 68);
  const shot = await next(attacker, 'gameplay_event');
  assert.equal(shot.profile.inventory.pistol_ammo, 67);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const world = multiplayer.hub.rooms.get('demo').world;
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
  assert.ok(Math.abs(correction.state.x) < 1);
  collector = await connect('collector', 193.5, -846.5, 31.17);
  collector.messages.length = 0;
  collector.socket.send(JSON.stringify({ type: 'action', action: { kind: 'collect_pickup', eventId: 'pickup-1', pickupId: 'pickup_armor_1' } }));
  const pickup = await next(collector, 'gameplay_event');
  assert.equal(pickup.result.type, 'armor');
  assert.equal(pickup.profile.armor, 50);
  attacker.socket.close(); target.socket.close();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(fs.existsSync(process.env.WEBGLGTA_PROFILE_FILE));
  console.log('authoritative multiplayer test passed');
} finally {
  attacker?.socket?.terminate();
  target?.socket?.terminate();
  collector?.socket?.terminate();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
}

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
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeout);
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

let attacker;
let target;
let collector;
try {
  attacker = await connect('deployed-attacker', 0);
  target = await connect('deployed-target', 5);
  attacker.messages.length = 0;
  target.messages.length = 0;
  const eventId = `deployed-shot-${randomUUID()}`;
  attacker.socket.send(JSON.stringify({ type: 'action', action: { kind: 'shoot', eventId, direction: [1, 0, 0] } }));
  const damaged = await next(target, 'player_state');
  const accepted = await next(attacker, 'gameplay_event');
  assert.equal(damaged.profile.health, 62);
  assert.equal(accepted.eventId, eventId);
  assert.equal(accepted.profile.inventory.pistol_ammo, 67);
  attacker.socket.send(JSON.stringify({ type: 'state', state: { x: 9_999, y: 9_999, feetZ: 0, gait: 'walk' } }));
  const correction = await next(attacker, 'state_correction');
  assert.ok(Math.abs(correction.state.x) < 1);
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

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const endpoint = process.argv[2] || 'ws://192.168.0.85:5173/__multiplayer';
const expectedModels = new Set(['3250873975', '3014915558', '826475330', '1068876755', '1446741360']);
const socket = new WebSocket(endpoint);

function waitFor(type, timeout = 8_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeout);
    const handler = (data) => {
      const message = JSON.parse(data);
      if (message.type !== type) return;
      clearTimeout(timer);
      socket.off('message', handler);
      resolve(message);
    };
    socket.on('message', handler);
  });
}

try {
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({
    type: 'join',
    sessionId: `npc-nav-test-${randomUUID()}`,
    name: 'npc-nav-test',
    state: { x: 186.94, y: -850.84, feetZ: 31.17, heading: 0, gait: 'idle' },
  }));
  await waitFor('welcome');
  const first = await waitFor('world_state');
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const second = await waitFor('world_state');
  const civilians = first.npcs.filter((npc) => npc.role === 'civilian');
  assert.equal(civilians.length, 6);
  assert.deepEqual(new Set(civilians.map((npc) => String(npc.modelHash))), expectedModels);
  const secondById = new Map(second.npcs.map((npc) => [npc.id, npc]));
  assert.ok(civilians.some((npc) => {
    const later = secondById.get(npc.id);
    return later && Math.hypot(later.x - npc.x, later.y - npc.y) > 0.5;
  }), 'expected at least one authoritative civilian to advance along navigation');
  assert.ok(civilians.some((npc) => {
    const later = secondById.get(npc.id);
    return later && Math.abs(later.feetZ - npc.feetZ) > 0.01;
  }), 'expected extracted YNV waypoint elevation to drive authoritative feetZ');
  console.log(`deployed NPC models/navigation passed (${endpoint})`);
} finally {
  socket.terminate();
}

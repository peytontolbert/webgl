import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const endpoint = process.argv[2] || 'ws://192.168.0.85:5173/__multiplayer';
const expected = {
  walmart: { x: 69.274155, y: -1776.3516, z: 28.290794 },
  recording: { x: 203.4, y: -18.7, z: 74.1 },
};

const socket = new WebSocket(endpoint);
const pending = new Map();

function waitForEvent(eventId, timeout = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(eventId);
      reject(new Error(`Timed out waiting for ${eventId}`));
    }, timeout);
    pending.set(eventId, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

try {
  const welcome = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${endpoint}`)), 5_000);
    socket.once('error', reject);
    socket.on('message', (data) => {
      const message = JSON.parse(data);
      if (message.type === 'welcome') {
        clearTimeout(timer);
        resolve(message);
      }
      if (message.type === 'gameplay_event' && pending.has(message.eventId)) {
        pending.get(message.eventId)(message);
        pending.delete(message.eventId);
      }
    });
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({
    type: 'join',
    sessionId: `deployed-destinations-${randomUUID()}`,
    name: 'Deployed destination test',
    state: { x: 186.94, y: -850.84, feetZ: 31.17, heading: 0, gait: 'idle' },
  }));
  await welcome;

  for (const [destination, coordinates] of Object.entries(expected)) {
    const eventId = `destination-${destination}-${randomUUID()}`;
    const response = waitForEvent(eventId);
    socket.send(JSON.stringify({
      type: 'action',
      action: { kind: 'destination_teleport', destination, eventId },
    }));
    const message = await response;
    assert.equal(message.result?.success, true);
    assert.equal(message.result?.destination, destination);
    assert.equal(message.result?.integratedCity, true);
    assert.deepEqual(
      [message.result?.x, message.result?.y, message.result?.z],
      [coordinates.x, coordinates.y, coordinates.z],
    );
    assert.deepEqual(message.profile?.position, [coordinates.x, coordinates.y, coordinates.z]);
  }

  console.log(`deployed destination authority passed (${endpoint})`);
} finally {
  socket.terminate();
}

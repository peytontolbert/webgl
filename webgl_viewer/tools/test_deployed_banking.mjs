import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const endpoint = process.argv[2] || 'ws://192.168.0.85:5173/__multiplayer';
const LEGION_BANK = { x: 149.05, y: -1041.3, feetZ: 29.37 };
const LEGION_ATM = { x: 147.47305, y: -1036.21753, feetZ: 28.36778 };

function connect(position = LEGION_BANK) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    const messages = [];
    const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${endpoint}`)), 5_000);
    socket.on('message', (data) => {
      const message = JSON.parse(data);
      messages.push(message);
      if (message.type !== 'welcome') return;
      clearTimeout(timer);
      resolve({ socket, messages, welcome: message });
    });
    socket.on('error', reject);
    socket.on('open', () => socket.send(JSON.stringify({
      type: 'join',
      sessionId: `deployed-banking-${randomUUID()}`,
      name: 'Deployed banking test',
      state: { ...position, heading: 0, gait: 'idle' },
    })));
  });
}

function waitFor(client, predicate, timeout = 3_000) {
  const found = client.messages.find(predicate);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.socket.off('message', handler);
      reject(new Error('Timed out waiting for banking result'));
    }, timeout);
    const handler = (data) => {
      const message = JSON.parse(data);
      if (!predicate(message)) return;
      clearTimeout(timer);
      client.socket.off('message', handler);
      resolve(message);
    };
    client.socket.on('message', handler);
  });
}

function bankAction(client, kind, action) {
  const eventId = `bank-${kind}-${randomUUID()}`;
  client.socket.send(JSON.stringify({ type: 'action', action: { kind, eventId, ...action } }));
  return waitFor(client, (message) => message.type === 'gameplay_event' && message.eventId === eventId);
}

let client;
let atmClient;
try {
  client = await connect();
  const profile = client.welcome.profile;
  assert.equal(profile.banking.card.pin, undefined, 'the debit PIN must never be sent to a client');
  const initialCash = profile.money;
  const initialBalance = profile.banking.checking;

  client.messages.length = 0;
  const deposited = await bankAction(client, 'bank_deposit', { accountName: 'Checking', amount: 10 });
  assert.equal(deposited.result.success, true, deposited.result.message);
  assert.equal(deposited.profile.money, initialCash - 10);
  assert.equal(deposited.profile.banking.checking, initialBalance + 10);

  client.messages.length = 0;
  const withdrawn = await bankAction(client, 'bank_withdraw', { accountName: 'Checking', amount: 10 });
  assert.equal(withdrawn.result.success, true, withdrawn.result.message);
  assert.equal(withdrawn.profile.money, initialCash);
  assert.equal(withdrawn.profile.banking.checking, initialBalance);
  assert.equal(withdrawn.profile.banking.statements.checking[0].type, 'withdraw');

  atmClient = await connect(LEGION_ATM);
  atmClient.messages.length = 0;
  const verified = await bankAction(atmClient, 'bank_withdraw', { accountName: 'checking', amount: 0, channel: 'atm', pin: '1234', verifyOnly: true });
  assert.equal(verified.result.success, true, verified.result.message);

  console.log(`deployed banking authority passed (${endpoint})`);
} finally {
  client?.socket?.terminate();
  atmClient?.socket?.terminate();
}

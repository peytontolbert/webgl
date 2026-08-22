import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const multiplayer = read('js/gameplay/multiplayer_client.js');
const characterGate = read('nexus_extensions/nexus_character_select.js');

// Generic profile updates may update health/inventory but never reset the local ped.
assert.match(multiplayer, /_applyProfile\(message\.profile, message\.state, false, true\)/);
assert.match(multiplayer, /_applyProfile\(message\.profile, message\.state, !!message\.respawn, !!message\.respawn\)/);
assert.match(multiplayer, /if \(!syncPosition\) return;/);

assert.match(characterGate, /const staleSocket = client\.socket/);
assert.match(characterGate, /client\.socket = null;\s*try \{ staleSocket\.close/);
assert.match(characterGate, /message\?\.type === 'welcome' && !client\.characterSelected && !client\.characterActivationPending/);
assert.match(characterGate, /if \(socket !== client\.socket\) return;/);
assert.match(characterGate, /this\.socket === socket && this\.__nxCharacterGateEpoch === gateEpoch/);
assert.match(characterGate, /const x = Number\(state\?\.x\)/);
assert.match(characterGate, /const spawnAtResolvedGround = \(viewer, x, y, feetZ, groundSource\)/);
assert.match(characterGate, /resolveGround\?\.\(x, y, feetZ \+ 2\.0/);
assert.match(characterGate, /spawnAtResolvedGround\(viewer, x, y, z, 'server_welcome'\)/);
assert.match(characterGate, /spawnAtResolvedGround\(client\.app, x, y, z, 'server_respawn'\)/);
assert.doesNotMatch(characterGate, /document\.addEventListener\('keydown'/);
assert.match(characterGate, /window\.__nxGameplayDiagnostics/);
assert.match(characterGate, /controller\._nativeTransitionSpeed = \(\) => NaN/);

console.log('login activation stability contract passed');

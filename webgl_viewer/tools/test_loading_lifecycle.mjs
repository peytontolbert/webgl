import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const main = read('js/main.js');
const characterGate = read('nexus_extensions/nexus_character_select.js');
const loading = read('nexus_extensions/nexus_loading.js');

assert.match(main, /this\._worldReady = false/);
assert.match(main, /window\.dispatchEvent\(new CustomEvent\('webglgta:world-ready'\)\)/);
assert.match(main, /this\._startAnimationLoop\(\);\s*this\._markWorldReady\(\);/);

assert.match(characterGate, /client\.status = 'activating'/);
assert.doesNotMatch(characterGate, /client\.status = 'online';/);
assert.match(characterGate, /if \(this\.characterSelected && this\.resumeToken\) return baseConnect\(\);/);
assert.match(characterGate, /dispatch\('nexus-character-ready'/);
assert.match(characterGate, /dispatch\('nexus-character-activation-failed'/);
assert.match(characterGate, /const activationInterrupted = client\.characterActivationPending;/);

// The thin production bundle can be one renderer revision behind source.
// `_animationStarted` is set immediately before the first frame is scheduled,
// while newer bundles additionally publish `_worldReady` after that frame.
assert.match(loading, /viewer\?\.spawnDistrictDemo && viewer\._animationStarted/);
assert.match(loading, /client\?\.characterSelected && client\.status === 'online' && client\.id/);
assert.match(loading, /window\.addEventListener\('nexus-character-activating', start\)/);
assert.doesNotMatch(loading, /Reconnect/);
assert.doesNotMatch(loading, /socket\?\.close|client\?\.connect/);

console.log('loading lifecycle contract passed');

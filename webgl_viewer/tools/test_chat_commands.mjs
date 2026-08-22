import assert from 'node:assert/strict';

import { CHAT_COMMANDS, parseCommandLine } from '../js/gameplay/chat_menu.js';

assert.equal(parseCommandLine('/vehicles').command?.name, 'vehicles');
assert.equal(parseCommandLine('/cars').command?.name, 'vehicles');
assert.equal(parseCommandLine('/help').command?.name, 'commands');
assert.deepEqual(parseCommandLine('/tp -8.28 -1076.25 33.1').args, ['-8.28', '-1076.25', '33.1']);
assert.equal(parseCommandLine('/does-not-exist').command, null);
assert.ok(CHAT_COMMANDS.some((command) => command.name === 'admin'));
assert.ok(CHAT_COMMANDS.some((command) => command.name === 'spawn'));
assert.equal(parseCommandLine('/legion').command?.name, 'legion');

console.log('chat command registry test passed');

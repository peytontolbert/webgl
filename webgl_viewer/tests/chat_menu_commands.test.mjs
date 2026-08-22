import assert from 'node:assert/strict';
import test from 'node:test';
import { CHAT_COMMANDS, parseCommandLine } from '../js/gameplay/chat_menu.js';

test('350Z and track shortcuts are registered as direct chat commands', () => {
    const car = parseCommandLine('/350z');
    const carAlias = parseCommandLine('/z33');
    const track = parseCommandLine('/track');
    const trackAlias = parseCommandLine('/nordschleife');

    assert.equal(car.command?.name, '350z');
    assert.equal(carAlias.command?.name, '350z');
    assert.equal(track.command?.name, 'track');
    assert.equal(trackAlias.command?.name, 'track');
    assert.ok(CHAT_COMMANDS.some((command) => command.name === '350z'));
    assert.ok(CHAT_COMMANDS.some((command) => command.name === 'track'));
});

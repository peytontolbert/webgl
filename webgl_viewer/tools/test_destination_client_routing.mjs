import assert from 'node:assert/strict';
import { MultiplayerClient } from '../js/gameplay/multiplayer_client.js';

const calls = [];
const client = Object.create(MultiplayerClient.prototype);
client.district = 'pfmall';
client.app = {
    vehicleController: { exitVehicle: (reason) => calls.push(['exit', reason]) },
    returnToLegionSquare: (options) => calls.push(['legion', options.serverPosition]),
    activateDemoDestination: (destination) => calls.push(['destination', destination]),
    chatMenu: { addMessage: () => {} },
};

client._handleGameplayEvent({
    kind: 'destination_teleport',
    result: { success: true, destination: 'legion', district: 'demo', x: 186.94, y: -850.84, z: 31.17 },
});
assert.equal(client.district, 'demo');
assert.equal(calls.filter(([kind]) => kind === 'legion').length, 1,
    'the semantic legion destination must route to city recovery even if an older server omits returnToLegion');
assert.equal(calls.filter(([kind]) => kind === 'destination').length, 0);

calls.length = 0;
client._handleGameplayEvent({
    kind: 'destination_teleport',
    result: { success: true, destination: 'mall', district: 'pfmall', x: -310.64, y: -2008.15, z: 30.2 },
});
assert.equal(calls.filter(([kind]) => kind === 'destination').length, 1);
assert.equal(calls.filter(([kind]) => kind === 'legion').length, 0);

console.log('destination client routing passed');

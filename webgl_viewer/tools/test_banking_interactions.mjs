import assert from 'node:assert/strict';
import { InteractionSystem } from '../js/gameplay/interactions.js';

const interactions = new InteractionSystem();
interactions.setManifest({ ok: true, interactions: [] });
const legion = interactions.spots.find((spot) => spot.id === 'nx-bank-legion');
assert.equal(legion?.type, 'bank');
assert.equal(legion?.action, 'open_bank');
assert.equal(legion?.coords.x, 149.05);
const atm = interactions.spots.find((spot) => spot.id === 'nx-atm-007');
assert.equal(atm?.type, 'atm');
assert.equal(atm?.action, 'open_atm');
assert.equal(atm?.coords.x, 118.64156);

assert.equal(interactions.update({ posData: [149.05, -1041.30, 29.37], keyState: {} }), null);
const action = interactions.update({ posData: [149.05, -1041.30, 29.37], keyState: { e: true } });
assert.equal(action?.type, 'open_bank');
assert.equal(interactions.update({ posData: [149.05, -1041.30, 29.37], keyState: { e: true } }), null);
assert.equal(interactions.update({ posData: [118.64156, -883.56946, 30.13945], keyState: {} }), null);
assert.equal(interactions.update({ posData: [118.64156, -883.56946, 30.13945], keyState: { e: true } })?.type, 'open_atm');

console.log('banking interactions: NX branch and exported ATM registration passed');

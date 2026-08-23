import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'multiplayer_server.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'js/main.js'), 'utf8');

for (const expected of [
    "recording: Object.freeze({ label: 'Recording Studio', district: 'demo', x: 203.4, y: -18.7, z: 74.1, halfSize: 0, integratedCity: true",
    "center: Object.freeze({ x: 197.1212, y: -21.09571 })",
    "pfmall: Object.freeze({ label: 'PFMall', district: 'demo', x: -310.64, y: -2008.15, z: 30.2, halfSize: 0, integratedCity: true",
    'doors: new Map(doorsForDistrict(district)',
]) {
    if (!source.includes(expected)) throw new Error(`MLO destination contract missing: ${expected}`);
}

if (source.includes('isLegion ? demoDoors.list : []')) {
    throw new Error('MLO destination rooms still discard their authoritative door state');
}
for (const expected of [
    "destination.integratedCity === true || String(destination.district || '') === 'demo'",
    'const districtBounds = this._getSpawnDistrictBounds() || this._spawnDistrictDescriptor?.bounds',
    "this.spawnPedAt([x, y, feetZ + eye], { groundSource: 'destination_teleport' })",
]) {
    if (!mainSource.includes(expected)) throw new Error(`MLO client integration contract missing: ${expected}`);
}

console.log('MLO destination contract passed.');

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'multiplayer_server.js'), 'utf8');

for (const expected of [
    "recording: Object.freeze({ label: 'Recording Studio', district: 'recording', x: 203.4, y: -18.7, z: 74.1",
    "center: Object.freeze({ x: 197.1212, y: -21.09571 })",
    "pfmall: Object.freeze({ label: 'PFMall', district: 'pfmall', x: -310.64, y: -2008.15, z: 30.2",
]) {
    if (!source.includes(expected)) throw new Error(`MLO destination contract missing: ${expected}`);
}

console.log('MLO destination contract passed.');

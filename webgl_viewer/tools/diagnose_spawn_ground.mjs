#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CollisionWorld } from '../js/gameplay/collision_world.js';

const viewerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function option(name, fallback = null) {
    const index = process.argv.indexOf(name);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function finiteOption(name, fallback) {
    const value = Number(option(name, fallback));
    if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
    return value;
}

const metaPath = path.resolve(option('--meta', path.join(viewerDir, 'assets', 'collision', 'ybn_spawn.json')));
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const binPath = path.resolve(path.dirname(metaPath), String(meta.file));
const bytes = fs.readFileSync(binPath);
const x = finiteOption('--x', meta.center?.x ?? 186.94);
const y = finiteOption('--y', meta.center?.y ?? -850.84);
const z = finiteOption('--z', 31.17);
const alignTo = process.argv.includes('--align-to') ? finiteOption('--align-to', z) : null;

globalThis.window = { location: { href: 'http://collision-probe.local/' } };
globalThis.fetch = async (url) => String(url).endsWith('.json')
    ? { ok: true, json: async () => meta }
    : { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };

const world = new CollisionWorld({ groundPedToTerrain: true, spawnDistrictDemo: true });
await world.loadYbnGround('http://collision-probe.local/ybn_spawn.json');
if (!world.ybnGround) throw new Error(world.ybnGroundError || 'YBN load failed');
const alignment = Number.isFinite(alignTo) ? world.alignYbnToKnownSurface(x, y, alignTo) : null;

const samples = [];
for (const [label, sx, sy] of [
    ['spawn', x, y],
    ['north_1m', x, y + 1],
    ['south_1m', x, y - 1],
    ['east_1m', x + 1, y],
    ['west_1m', x - 1, y],
]) {
    const contacts = [z - 8, z, z + 8, z + 24].map((hint) => {
        const hit = world.resolveGround(sx, sy, hint);
        return {
            hint,
            z: Number.isFinite(Number(hit?.z)) ? Number(hit.z.toFixed(4)) : null,
            source: hit?.source || null,
            material: hit?.material || null,
            triangleOffset: hit?.triangleOffset ?? null,
        };
    });
    samples.push({ label, x: sx, y: sy, contacts });
}

console.log(JSON.stringify({
    ybnVersion: world.ybnGround.meta?.version,
    input: { x, y, z, alignTo },
    alignment,
    samples,
}, null, 2));

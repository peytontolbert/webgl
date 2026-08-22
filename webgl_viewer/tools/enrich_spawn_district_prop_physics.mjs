#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const viewerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultDemoDir = path.join(viewerDir, 'assets', 'demo');

function argumentValue(name, fallback) {
    const index = process.argv.indexOf(name);
    return index >= 0 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]) : fallback;
}

const colliderPath = argumentValue('--colliders', path.join(defaultDemoDir, 'spawn_district_asset_colliders.json'));
const destructiblePath = argumentValue('--destructibles', path.join(defaultDemoDir, 'spawn_district_destructibles.json'));
// These are genuinely loose street props that a pedestrian can displace. Keep
// heavy furniture and fixtures out until the runtime can distinguish vehicle
// impulses from a walking shove.
const pushablePath = /(?:prop_(?:bin_[a-z0-9]+|(?:box|crate)pile[a-z0-9_]*|rub_(?:binbag|boxpile|cardpile)[a-z0-9_]*|skid_(?:box|trolley)[a-z0-9_]*|barrier_work[a-z0-9_]*|consign[a-z0-9_]*))/i;

const manifest = JSON.parse(await readFile(colliderPath, 'utf8'));
const destructibles = JSON.parse(await readFile(destructiblePath, 'utf8'));
const profileByHash = new Map();
const destructibleIds = new Set();
for (const item of destructibles.destructibles || []) {
    const hash = String(item?.archetypeHash || '').trim();
    if (hash && !profileByHash.has(hash)) profileByHash.set(hash, item);
    const id = String(item?.id || '').trim();
    if (id) destructibleIds.add(id);
}
const entityPath = argumentValue(
    '--entities',
    path.join(path.dirname(colliderPath), path.basename(String(manifest.sourceEntities || 'spawn_district_entities_mlo.bin'))),
);
const entities = await readFile(entityPath);
if (entities.toString('ascii', 0, 4) !== 'ENT1') throw new Error(`${entityPath} is not ENT1`);
const entityCount = entities.readUInt32LE(4);
const entityStride = (entities.length - 8) / entityCount;
if (![44, 48, 64].includes(entityStride)) throw new Error(`Unsupported ENT1 stride ${entityStride}`);
let pushableCount = 0;
for (const collider of manifest.colliders || []) {
    delete collider.response;
    delete collider.mass;
    delete collider.instance;
    delete collider.destructibleId;
    const match = /:(\d+)(?::shell:[^:]+)?$/.exec(String(collider.id || ''));
    const index = Number(match?.[1]);
    const destructibleId = `fragment:${collider.archetypeHash}:${index}`;
    if (Number.isInteger(index) && destructibleIds.has(destructibleId)) {
        collider.destructibleId = destructibleId;
    }
    const profile = profileByHash.get(String(collider.archetypeHash || ''));
    const assetPath = String(profile?.fragment?.yftPath || profile?.fragment?.ytypPath || '');
    if (!pushablePath.test(assetPath)) continue;
    if (!Number.isInteger(index) || index < 0 || index >= entityCount) continue;
    const offset = 8 + index * entityStride;
    if (String(entities.readUInt32LE(offset)) !== String(collider.archetypeHash || '')) continue;
    const volume = Math.max(0.01, collider.halfX * 2 * collider.halfY * 2 * (collider.maxZ - collider.minZ));
    collider.response = 'pushable';
    collider.mass = Number(Math.max(4, Math.min(65, volume * 24)).toFixed(2));
    collider.instance = {
        x: entities.readFloatLE(offset + 4),
        y: entities.readFloatLE(offset + 8),
        z: entities.readFloatLE(offset + 12),
    };
    pushableCount++;
}
manifest.pushableColliderCount = pushableCount;
await writeFile(colliderPath, `${JSON.stringify(manifest)}\n`, 'utf8');
console.log(`Enriched demo prop physics: pushable=${pushableCount} total=${manifest.colliders?.length || 0}`);

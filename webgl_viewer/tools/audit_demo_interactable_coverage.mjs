#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NX_BANK_BRANCHES, NX_DEMO_ATMS } from '../js/gameplay/banking_locations.js';

const viewerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoDir = path.join(viewerDir, 'assets', 'demo');
const runtimePath = path.join(viewerDir, 'assets', 'runtime_gameplay_manifest.json');

const [descriptor, interactables, destructibles, fragmentChildren, colliders, runtime] = await Promise.all([
    readJson(path.join(demoDir, 'spawn_district.json')),
    readJson(path.join(demoDir, 'interactables.json')),
    readJson(path.join(demoDir, 'spawn_district_destructibles.json')),
    readJson(path.join(demoDir, 'spawn_district_fragment_children.json')),
    readJson(path.join(demoDir, 'spawn_district_asset_colliders.json')),
    readJson(runtimePath),
]);

function readJson(file) {
    return readFile(file, 'utf8').then(JSON.parse);
}

function argumentValue(name, fallback) {
    const index = process.argv.indexOf(name);
    return index >= 0 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]) : fallback;
}

function fragmentName(item) {
    const source = String(item?.fragment?.yftPath || item?.fragment?.ytypPath || '').toLowerCase();
    return source.match(/[^\\/]+(?=\.yft$)/)?.[0] || source;
}

function physicalClass(name) {
    if (/dumpster/.test(name)) return 'heavy-containers';
    if (/(?:binbag|boxpile|cardpile|cratepile|skid_box|prop_bin_)/.test(name)) return 'loose-trash-and-boxes';
    if (/(?:barrier_work|consign|cone)/.test(name)) return 'portable-roadside';
    if (/(?:skid_trolley|trolley|cart)/.test(name)) return 'carts-and-trolleys';
    if (/(?:pallet)/.test(name)) return 'pallets';
    if (/(?:bench|chair|seat|table|stool)/.test(name)) return 'street-furniture';
    if (/(?:news_disp)/.test(name)) return 'newspaper-boxes';
    if (/(?:parknmeter)/.test(name)) return 'parking-meters';
    if (/(?:hydrant)/.test(name)) return 'hydrants';
    if (/(?:bollard)/.test(name)) return 'bollards';
    if (/(?:sign_road|maxheight)/.test(name)) return 'road-signs';
    if (/(?:streetlight|traffic_|oldlight|wall_light)/.test(name)) return 'lights-and-signals';
    return 'other-fragments';
}

const colliderById = new Map((colliders.colliders || []).map((item) => [String(item.id), item]));
const entityPath = argumentValue(
    '--entities',
    path.join(demoDir, String(destructibles.sourceEntities || descriptor.instanceFile || '')),
);
const entityData = await readFile(entityPath);
if (entityData.toString('ascii', 0, 4) !== 'ENT1') throw new Error(`${entityPath} is not ENT1`);
const entityCount = entityData.readUInt32LE(4);
const entityStride = (entityData.length - 8) / entityCount;
if (![44, 48, 64].includes(entityStride)) throw new Error(`${entityPath} has invalid ENT1 stride ${entityStride}`);
const physical = {};
let fragmentColliderCount = 0;
let linkedColliderCount = 0;
let pushableFragmentCount = 0;
let staleFragmentIdentityCount = 0;
for (const item of destructibles.destructibles || []) {
    const match = /^fragment:(\d+):(\d+)$/.exec(String(item.id));
    const entityIndex = Number(match?.[2]);
    const currentHash = Number.isInteger(entityIndex) && entityIndex >= 0 && entityIndex < entityCount
        ? String(entityData.readUInt32LE(8 + entityIndex * entityStride))
        : '';
    if (!match || currentHash !== match[1]) staleFragmentIdentityCount++;
    const collider = match ? colliderById.get(`asset:${match[1]}:${match[2]}`) : null;
    const category = physicalClass(fragmentName(item));
    const row = physical[category] ||= { instances: 0, colliders: 0, destructibleLinked: 0, pushable: 0 };
    row.instances++;
    if (collider) {
        row.colliders++;
        fragmentColliderCount++;
    }
    if (collider?.destructibleId) {
        row.destructibleLinked++;
        linkedColliderCount++;
    }
    if (collider?.response === 'pushable') {
        row.pushable++;
        pushableFragmentCount++;
    }
}

const gameplayCounts = {};
for (const key of ['interactions', 'shops', 'garages', 'vehicleShops', 'apartments', 'housing']) {
    gameplayCounts[key] = Array.isArray(runtime[key]) ? runtime[key].length : 0;
}
gameplayCounts.geometryDoors = Array.isArray(interactables.doors) ? interactables.doors.length : 0;
gameplayCounts.bankBranches = NX_BANK_BRANCHES.length;
gameplayCounts.atms = NX_DEMO_ATMS.length;

const report = {
    schema: 'webglgta-demo-interactable-coverage-v1',
    generatedAt: new Date().toISOString(),
    placedEntities: Number(descriptor.instanceCount) || 0,
    physical: {
        fragmentInstances: Number(destructibles.destructibleInstanceCount) || 0,
        fragmentArchetypes: Number(destructibles.fragmentProfileCount) || 0,
        fragmentArchetypesWithChildDebris: Number(fragmentChildren.renderableProfileCount) || 0,
        staleFragmentIdentityCount,
        fragmentInstancesWithAssetCollider: fragmentColliderCount,
        fragmentInstancesLinkedToDestruction: linkedColliderCount,
        pushableFragmentInstances: pushableFragmentCount,
        totalAssetColliders: Number(colliders.colliderCount) || 0,
        totalPushableAssetColliders: Number(colliders.pushableColliderCount) || 0,
        byClass: Object.fromEntries(Object.entries(physical).sort(([a], [b]) => a.localeCompare(b))),
    },
    gameplay: gameplayCounts,
    knownGaps: [
        'Heavy fragments do not yet have vehicle-only rigid-body impulses, rotation, tipping, or stacking.',
        'Only geometry-backed doors and manifest-authored locations have E-key actions.',
        'The compressed geometry catalog does not preserve names for every non-fragment vending, seating, storage, terminal, or register archetype.',
        'Destructible fragments without an independent asset collider can react to weapon raycasts but do not provide their own movement blocker.',
    ],
};

const output = path.join(demoDir, 'interactable_coverage_audit.json');
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));

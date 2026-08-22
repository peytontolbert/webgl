import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
function argumentPath(name, fallback) {
    const index = process.argv.indexOf(name);
    return path.resolve(root, index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback);
}

function argumentValue(name, fallback) {
    const index = process.argv.indexOf(name);
    return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

const metadata = JSON.parse(fs.readFileSync(argumentPath('--metadata', '.mlo_source/legion_int_weed/mlo-metadata.json'), 'utf8'));
const interior = JSON.parse(fs.readFileSync(argumentPath('--interior', 'assets/interiors/2219659007.json'), 'utf8'));
const ent = fs.readFileSync(argumentPath('--entities', 'assets/demo/spawn_district_entities_mlo.bin'));

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

assert(ent.subarray(0, 4).toString('ascii') === 'ENT1', 'MLO instance file is not ENT1');
const count = ent.readUInt32LE(4);
const stride = (ent.length - 8) / count;
assert(stride === 64, `expected stride 64, got ${stride}`);

const sourceRootIndex = Number(argumentValue('--root-index', 0));
const sourceRoot = metadata.roots[sourceRootIndex];
assert(sourceRoot, `source root index ${sourceRootIndex} is missing`);
const rootHash = Number(sourceRoot.archetypeHash) >>> 0;
let parentGuid = 0;
for (let index = 0; index < count; index++) {
    const offset = 8 + index * stride;
    if (ent.readUInt32LE(offset) !== rootHash || (ent.readUInt32LE(offset + 60) & 1) === 0) continue;
    const distance = Math.hypot(
        ent.readFloatLE(offset + 4) - Number(sourceRoot.position[0]),
        ent.readFloatLE(offset + 8) - Number(sourceRoot.position[1]),
        ent.readFloatLE(offset + 12) - Number(sourceRoot.position[2]),
    );
    if (distance <= 0.2) {
        parentGuid = ent.readUInt32LE(offset + 48);
        break;
    }
}
assert(parentGuid !== 0, `MLO root ${rootHash} is missing from ENT1`);

const roomCounts = new Map();
const portalCounts = new Map();
let ownedChildren = 0;
for (let index = 0; index < count; index++) {
    const offset = 8 + index * stride;
    const recordParentGuid = ent.readUInt32LE(offset + 52);
    const flags = ent.readUInt32LE(offset + 60);
    if (recordParentGuid !== parentGuid || (flags & 2) === 0) continue;
    const roomIndex = ((flags >>> 8) & 0xff) - 1;
    const portalIndex = ((flags >>> 16) & 0xff) - 1;
    if (roomIndex >= 0) roomCounts.set(roomIndex, (roomCounts.get(roomIndex) || 0) + 1);
    if (portalIndex >= 0) portalCounts.set(portalIndex, (portalCounts.get(portalIndex) || 0) + 1);
    ownedChildren++;
}

const expected = new Map();
const expectedPortals = new Map();
for (const child of sourceRoot.children) {
    if (child.roomIndex >= 0) expected.set(child.roomIndex, (expected.get(child.roomIndex) || 0) + 1);
    if (child.portalIndex >= 0) expectedPortals.set(child.portalIndex, (expectedPortals.get(child.portalIndex) || 0) + 1);
}
assert(ownedChildren === sourceRoot.children.length, `owned ${ownedChildren} of ${sourceRoot.children.length} children`);
for (const [roomIndex, expectedCount] of expected) {
    assert(roomCounts.get(roomIndex) === expectedCount, `room ${roomIndex}: ${roomCounts.get(roomIndex)} != ${expectedCount}`);
}
for (const [portalIndex, expectedCount] of expectedPortals) {
    assert(portalCounts.get(portalIndex) === expectedCount, `portal ${portalIndex}: ${portalCounts.get(portalIndex)} != ${expectedCount}`);
}

const sourceInterior = metadata.interiors[String(rootHash)];
assert(sourceInterior, `source interior ${rootHash} is missing`);
assert(interior.schema === 'webglgta-interior-v2', `unexpected interior schema ${interior.schema}`);
assert(interior.rooms.length === sourceInterior.rooms.length, 'interior room count differs from source');
assert(interior.portals.length === sourceInterior.portals.length, 'interior portal count differs from source');
assert(interior.entitySets.length === sourceInterior.entitySets.length, 'interior entity-set count differs from source');
for (let index = 0; index < interior.rooms.length; index++) {
    assert(Number(interior.rooms[index].timecycleName) === Number(sourceInterior.rooms[index].timecycleName), `room ${index} timecycle differs from source`);
}
for (let index = 0; index < interior.portals.length; index++) {
    assert(Number(interior.portals[index].flags) === Number(sourceInterior.portals[index].flags), `portal ${index} flags differ from source`);
    assert(Number(interior.portals[index].audioOcclusion) === Number(sourceInterior.portals[index].audioOcclusion), `portal ${index} audio occlusion differs from source`);
}

const adjacency = new Map(interior.rooms.map((room) => [room.index, []]));
for (const portal of interior.portals) {
    adjacency.get(portal.roomFrom)?.push(portal.roomTo);
    adjacency.get(portal.roomTo)?.push(portal.roomFrom);
}
const visited = new Set([0]);
const queue = [0];
while (queue.length) {
    const room = queue.shift();
    for (const next of adjacency.get(room) || []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
    }
}
assert(visited.size === interior.rooms.length, 'portal graph does not connect exterior limbo to every room');

console.log(`mlo runtime: ${ownedChildren} owned children, ${interior.rooms.length} rooms, ${interior.portals.length} portals, timecycles and portal graph passed`);

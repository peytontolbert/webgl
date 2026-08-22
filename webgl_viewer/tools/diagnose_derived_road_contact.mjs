import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CollisionWorld } from '../js/gameplay/collision_world.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [x = 4879, y = -849.0400268554688, z = 31.867361583584547] = process.argv.slice(2).map(Number);
if (![x, y, z].every(Number.isFinite)) throw new Error('Usage: node tools/diagnose_derived_road_contact.mjs [x y z]');

globalThis.window = { location: { href: 'http://diagnostic.local/demo' } };
globalThis.fetch = async (url) => {
    const pathname = new URL(String(url), window.location.href).pathname;
    const file = path.resolve(projectRoot, 'dist-thin', `.${pathname}`);
    if (!file.startsWith(path.resolve(projectRoot, 'dist-thin') + path.sep)) return new Response(null, { status: 403 });
    try {
        const data = await fs.readFile(file);
        return new Response(data, { status: 200 });
    } catch (error) {
        if (error?.code === 'ENOENT') return new Response(null, { status: 404 });
        throw error;
    }
};

const world = new CollisionWorld({ spawnDistrictDemo: true, groundPedToTerrain: true });
const road = await world.loadDerivedRoad('assets/tracks/nordschleife/road.json');
const contact = world.resolveGround(x, y, z + 2.0, { preferInterior: false, maxSnapDistance: 8.0 });

console.log(JSON.stringify({
    input: { x, y, z },
    roadLoaded: !!road,
    bounds: world.getDerivedRoadBounds(),
    derivedRoadSpawn: world.getDerivedRoadSpawn(),
    contact,
    savedPositionCanRestoreAsTrack: contact?.source === 'track' && Number.isFinite(Number(contact?.z)),
}, null, 2));

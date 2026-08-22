import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { CollisionWorld } from '../js/gameplay/collision_world.js';

function flatRoad() {
    // One 20m x 10m ribbon segment, rising from z=10 to z=12.
    const vertices = new Float32Array([
        0, 5, 10, 0, -5, 10,
        20, 5, 12, 20, -5, 12,
    ]);
    const grid = new Map();
    for (let gx = 0; gx <= 1; gx++) for (let gy = -1; gy <= 0; gy++) grid.set(`${gx}:${gy}`, [0]);
    return {
        id: 'test-road', vertices, segmentCount: 1,
        minX: 0, minY: -5, minZ: 10, maxX: 20, maxY: 5, maxZ: 12,
        cellSize: 16, grid, meta: { surface: { name: 'asph-nurb', grip: 0.98 } },
    };
}

test('derived road contact supplies visible road elevation and surface grip', () => {
    const world = new CollisionWorld({ spawnDistrictDemo: true, groundPedToTerrain: false });
    world.derivedRoads = [flatRoad()];
    const contact = world._getDerivedRoadContactAtXY(10, 0, 15, 4);
    assert.ok(contact);
    assert.ok(Math.abs(contact.z - 11) < 1e-6);
    assert.equal(contact.material, 'asph-nurb');
    assert.equal(contact.grip, 0.98);

    const ground = world.resolveGround(10, 0, 15, { maxSnapDistance: 4 });
    assert.equal(ground.source, 'track');
    assert.ok(Math.abs(ground.z - 11) < 1e-6);
    assert.equal(ground.surfacePolicy, 'derived_track_road');
});

test('authored track mesh overrides the AI ribbon and preserves pit surface metadata', () => {
    const world = new CollisionWorld({ spawnDistrictDemo: true, groundPedToTerrain: false });
    world.derivedRoads = [flatRoad()];
    const vertices = new Float32Array([
        0, -5, 13,
        20, -5, 13,
        0, 5, 13,
        20, 5, 13,
    ]);
    const indices = new Uint32Array([0, 1, 2, 1, 3, 2]);
    const bounds = { minX: 0, minY: -5, minZ: 13, maxX: 20, maxY: 5, maxZ: 13, cellSize: 16 };
    world.derivedTrackGround = {
        ...bounds,
        vertices,
        indices,
        triangleMaterials: new Uint16Array([0, 0]),
        materialPalette: [{ name: 'pits', surface: 'pits', grip: 0.95, damping: 0.02, validTrack: true, pitlane: true }],
        grid: world._buildYbnGrid(vertices, indices, bounds),
        wallGrid: world._buildYbnWallGrid(vertices, indices, bounds),
        meta: { spawn: { x: 10, y: 0, feetZ: 13, headingRad: 1.25 } },
    };

    const ground = world.resolveGround(10, 0, 15, { maxSnapDistance: 4 });
    assert.equal(ground.source, 'track');
    assert.equal(ground.z, 13);
    assert.equal(ground.material, 'pits');
    assert.equal(ground.grip, 0.95);
    assert.equal(ground.damping, 0.02);
    assert.equal(ground.validTrack, true);
    assert.equal(ground.pitlane, true);
    assert.deepEqual(world.getDerivedRoadSpawn(), [10, 0, 13]);
    assert.equal(world.getDerivedRoadSpawnFrame().headingRad, 1.25);
});

test('packaged tourist spawn is on the authored circuit access surface', () => {
    const root = new URL('../assets/tracks/nordschleife/', import.meta.url);
    const meta = JSON.parse(fs.readFileSync(new URL('surface_collision.json', root), 'utf8'));
    assert.equal(meta.spawn.kind, 'tourist-entry-access');
    assert.equal(meta.spawn.surface, 'TRM-NRM');

    const raw = fs.readFileSync(new URL(meta.file, root));
    const vertexCount = raw.readUInt32LE(8);
    const indexCount = raw.readUInt32LE(12);
    const triangleCount = raw.readUInt32LE(16);
    const positionsOffset = 48;
    const indicesOffset = positionsOffset + vertexCount * 12;
    const materialsOffset = indicesOffset + indexCount * 4;
    const vertices = new Float32Array(raw.buffer, raw.byteOffset + positionsOffset, vertexCount * 3);
    const indices = new Uint32Array(raw.buffer, raw.byteOffset + indicesOffset, indexCount);
    const materials = new Uint16Array(raw.buffer, raw.byteOffset + materialsOffset, triangleCount);
    const spawnMaterial = meta.surfaces.findIndex((surface) => surface.key === meta.spawn.surface);
    let hitZ = null;
    for (let triangle = 0; triangle < triangleCount && hitZ === null; triangle += 1) {
        if (materials[triangle] !== spawnMaterial) continue;
        const ia = indices[triangle * 3] * 3;
        const ib = indices[triangle * 3 + 1] * 3;
        const ic = indices[triangle * 3 + 2] * 3;
        const ax = vertices[ia]; const ay = vertices[ia + 1]; const az = vertices[ia + 2];
        const bx = vertices[ib]; const by = vertices[ib + 1]; const bz = vertices[ib + 2];
        const cx = vertices[ic]; const cy = vertices[ic + 1]; const cz = vertices[ic + 2];
        const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(denominator) < 1e-7) continue;
        const u = ((by - cy) * (meta.spawn.x - cx) + (cx - bx) * (meta.spawn.y - cy)) / denominator;
        const v = ((cy - ay) * (meta.spawn.x - cx) + (ax - cx) * (meta.spawn.y - cy)) / denominator;
        const w = 1 - u - v;
        if (Math.min(u, v, w) >= -1e-5) hitZ = u * az + v * bz + w * cz;
    }
    assert.ok(Number.isFinite(hitZ), 'track spawn had no authored access triangle under it');
    assert.ok(Math.abs(hitZ - meta.spawn.feetZ) < 0.02, `spawn z ${meta.spawn.feetZ} did not match collision ${hitZ}`);
    assert.equal(Object.values(meta.surfaceTriangles).reduce((sum, count) => sum + count, 0), meta.triangles, 'surface totals must cover every authored collision triangle');
    for (const surface of meta.surfaces.filter((entry) => entry.validTrack)) {
        assert.ok(meta.surfaceTriangles[surface.key] > 0, `driveable surface ${surface.key} had no collision triangles`);
    }
});

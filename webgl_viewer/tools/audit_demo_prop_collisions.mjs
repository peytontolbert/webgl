#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { CollisionWorld } from '../js/gameplay/collision_world.js';

const viewerDir = path.resolve(import.meta.dirname, '..');
const colliderPath = path.join(viewerDir, 'assets', 'demo', 'spawn_district_asset_colliders.json');
const ybnMetaPath = path.join(viewerDir, 'assets', 'collision', 'ybn_spawn.json');
const solidPropHashes = new Set([
    '218085040',  // prop_dumpster_01a
    '666561306',  // prop_dumpster_02a
    '4236481708', // prop_dumpster_02b
    '1437508529', // prop_bin_01a
    '1614656839', // prop_bin_02a
    '1329570871', // prop_bin_05a
    '3198190107', // prop_bin_08a
]);

function loadYbn(collision) {
    const meta = JSON.parse(fs.readFileSync(ybnMetaPath, 'utf8'));
    const dataPath = path.resolve(path.dirname(ybnMetaPath), meta.file);
    const buffer = fs.readFileSync(dataPath);
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const header = new DataView(arrayBuffer);
    if (header.getUint32(4, true) !== 3) throw new Error('Expected YBNC v3');
    const vertexCount = header.getUint32(8, true);
    const indexCount = header.getUint32(12, true);
    const cellSize = header.getFloat32(16, true);
    const minGX = header.getInt32(20, true);
    const minGY = header.getInt32(24, true);
    const width = header.getUint32(28, true);
    const height = header.getUint32(32, true);
    const referenceCount = header.getUint32(36, true);
    const wallReferenceCount = header.getUint32(40, true);
    const cellCount = width * height;
    let offset = 44;
    const vertices = new Float32Array(arrayBuffer, offset, vertexCount * 3);
    offset += vertexCount * 3 * 4;
    const indices = new Uint32Array(arrayBuffer, offset, indexCount);
    offset += indexCount * 4;
    const cellOffsets = new Uint32Array(arrayBuffer, offset, cellCount + 1);
    offset += (cellCount + 1) * 4;
    const triangleOffsets = new Uint32Array(arrayBuffer, offset, referenceCount);
    offset += referenceCount * 4;
    const wallCellOffsets = new Uint32Array(arrayBuffer, offset, cellCount + 1);
    offset += (cellCount + 1) * 4;
    const wallTriangleOffsets = new Uint32Array(arrayBuffer, offset, wallReferenceCount);
    collision.ybnGround = {
        meta, vertices, indices,
        minX: meta.bounds.min_x, minY: meta.bounds.min_y,
        maxX: meta.bounds.max_x, maxY: meta.bounds.max_y,
        cellSize,
        grid: { cellSize, minGX, minGY, width, height, cellOffsets, triangleOffsets },
        wallGrid: {
            cellSize, minGX, minGY, width, height,
            cellOffsets: wallCellOffsets,
            triangleOffsets: wallTriangleOffsets,
            triangleCount: meta.wall_triangle_count,
        },
    };
}

const manifest = JSON.parse(fs.readFileSync(colliderPath, 'utf8'));
const colliders = manifest.colliders.filter((item) => solidPropHashes.has(String(item.archetypeHash)));
const failures = [];
let protectedByAuthoredCollision = 0;
for (const collider of colliders) {
    const collision = new CollisionWorld({ groundPedToTerrain: true, spawnDistrictDemo: true });
    loadYbn(collision);
    collision.setAssetColliders([collider]);
    const ground = collision.resolveGround(collider.x, collider.y, collider.minZ, {
        applyYbnCalibration: false,
        preferInterior: false,
    });
    const feetZ = Number(ground.z);
    const startDistance = collider.halfX + 1.2;
    const result = collision.moveCapsule({
        x: collider.x + collider.axisXX * startDistance,
        y: collider.y + collider.axisXY * startDistance,
        feetZ,
        vx: -collider.axisXX * 5,
        vy: -collider.axisXY * 5,
        dt: 0.5,
        radius: 0.38,
        height: 1.8,
        maxStepUp: 0.65,
        obstacleStepUp: 0.45,
        applyYbnCalibration: false,
        useDrawableProxies: false,
    });
    if (!result.blocked) {
        failures.push({
            id: collider.id,
            archetypeHash: collider.archetypeHash,
            groundZ: feetZ,
            minZ: collider.minZ,
            maxZ: collider.maxZ,
            blocked: result.blocked,
            hit: result.hit?.id || result.hit?.source || null,
        });
    } else if (result.hit?.id !== collider.id) protectedByAuthoredCollision++;
}

console.log(JSON.stringify({ tested: colliders.length, protectedByAuthoredCollision, failures }, null, 2));
if (failures.length) process.exitCode = 1;

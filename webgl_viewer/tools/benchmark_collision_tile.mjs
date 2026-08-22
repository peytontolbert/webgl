#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { CollisionWorld } from '../js/gameplay/collision_world.js';

function loadTile(metaPath) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const buffer = fs.readFileSync(path.resolve(path.dirname(metaPath), meta.file));
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const header = new DataView(arrayBuffer);
    const version = header.getUint32(4, true);
    if (version !== 3) throw new Error(`Expected YBNC v3, got ${version}`);
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
    const bounds = meta.bounds;
    const collision = new CollisionWorld({ groundPedToTerrain: false });
    collision.ybnGround = {
        meta,
        vertices,
        indices,
        minX: bounds.min_x,
        minY: bounds.min_y,
        maxX: bounds.max_x,
        maxY: bounds.max_y,
        cellSize,
        grid: { cellSize, minGX, minGY, width, height, cellOffsets, triangleOffsets },
        wallGrid: {
            cellSize, minGX, minGY, width, height,
            cellOffsets: wallCellOffsets,
            triangleOffsets: wallTriangleOffsets,
            triangleCount: meta.wall_triangle_count,
        },
    };
    return collision;
}

function randomSamples(meta, count) {
    let state = 0x12345678;
    const random = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
    const bounds = meta.bounds;
    return Array.from({ length: count }, () => ({
        x: bounds.min_x + (bounds.max_x - bounds.min_x) * random(),
        y: bounds.min_y + (bounds.max_y - bounds.min_y) * random(),
    }));
}

function benchmark(metaPath) {
    const collision = loadTile(metaPath);
    const samples = randomSamples(collision.ybnGround.meta, 20_000);
    let found = 0;
    let start = performance.now();
    for (const sample of samples) {
        if (collision._getYbnGroundAtXY(sample.x, sample.y, 45, 35) !== null) found++;
    }
    const groundMs = performance.now() - start;

    let hits = 0;
    start = performance.now();
    for (let i = 0; i < 5_000; i++) {
        const sample = samples[i];
        const feetZ = collision._getYbnGroundAtXY(sample.x, sample.y, 45, 35) ?? 30;
        if (collision._firstYbnWallHit(sample.x, sample.y, feetZ, 0.38, 1.8, 0.3, 1, 0, 0.3)) hits++;
    }
    const wallMs = performance.now() - start;
    return {
        metaPath: path.resolve(metaPath),
        binaryMB: fs.statSync(path.resolve(path.dirname(metaPath), collision.ybnGround.meta.file)).size / 1024 / 1024,
        triangles: collision.ybnGround.meta.triangle_count,
        groundQueries: samples.length,
        groundFound: found,
        groundMs,
        groundMicrosecondsEach: groundMs * 1000 / samples.length,
        wallQueries: 5_000,
        wallHits: hits,
        wallMs,
        wallMicrosecondsEach: wallMs * 1000 / 5_000,
    };
}

const paths = process.argv.slice(2);
if (!paths.length) throw new Error('Usage: benchmark_collision_tile.mjs <tile.json> [tile.json ...]');
console.log(JSON.stringify(paths.map(benchmark), null, 2));

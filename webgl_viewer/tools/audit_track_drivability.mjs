import fs from 'node:fs';
import { CollisionWorld } from '../js/gameplay/collision_world.js';

const root = new URL('../assets/tracks/nordschleife/', import.meta.url);
const surfaceMeta = JSON.parse(fs.readFileSync(new URL('surface_collision.json', root), 'utf8'));
const collisionRaw = fs.readFileSync(new URL(surfaceMeta.file, root));
const vertexCount = collisionRaw.readUInt32LE(8);
const indexCount = collisionRaw.readUInt32LE(12);
const triangleCount = collisionRaw.readUInt32LE(16);
const positionsOffset = 48;
const indicesOffset = positionsOffset + vertexCount * 12;
const materialsOffset = indicesOffset + indexCount * 4;
const vertices = new Float32Array(collisionRaw.buffer, collisionRaw.byteOffset + positionsOffset, vertexCount * 3);
const indices = new Uint32Array(collisionRaw.buffer, collisionRaw.byteOffset + indicesOffset, indexCount);
const triangleMaterials = new Uint16Array(collisionRaw.buffer, collisionRaw.byteOffset + materialsOffset, triangleCount);
const bounds = { ...surfaceMeta.bounds, cellSize: 16 };
const materialPalette = surfaceMeta.surfaces.map((surface) => ({
    name: surface.name, surface: surface.key.toLowerCase(), grip: surface.friction,
    damping: surface.damping, validTrack: surface.validTrack, pitlane: surface.pitlane,
}));

const roadMeta = JSON.parse(fs.readFileSync(new URL('road.json', root), 'utf8'));
const roadRaw = fs.readFileSync(new URL(roadMeta.file, root));
const roadVertexCount = roadRaw.readUInt32LE(8);
const segmentCount = roadRaw.readUInt32LE(12);
const header = new DataView(roadRaw.buffer, roadRaw.byteOffset, 44);
const minimum = [header.getFloat32(20, true), header.getFloat32(24, true), header.getFloat32(28, true)];
const span = [header.getFloat32(32, true), header.getFloat32(36, true), header.getFloat32(40, true)];
const packed = new Uint16Array(roadRaw.buffer, roadRaw.byteOffset + 44, roadVertexCount * 3);
const roadVertices = new Float32Array(roadVertexCount * 3);
for (let index = 0; index < roadVertices.length; index++) roadVertices[index] = minimum[index % 3] + packed[index] / 65535 * span[index % 3];

const world = new CollisionWorld({ spawnDistrictDemo: true, groundPedToTerrain: false });
const roadGrid = new Map();
for (let segment = 0; segment < segmentCount; segment++) {
    const base = segment * 6; const next = base + 6;
    const xs = [roadVertices[base], roadVertices[base + 3], roadVertices[next], roadVertices[next + 3]];
    const ys = [roadVertices[base + 1], roadVertices[base + 4], roadVertices[next + 1], roadVertices[next + 4]];
    for (let gy = Math.floor(Math.min(...ys) / 16); gy <= Math.floor(Math.max(...ys) / 16); gy++) for (let gx = Math.floor(Math.min(...xs) / 16); gx <= Math.floor(Math.max(...xs) / 16); gx++) {
        const key = `${gx}:${gy}`; if (!roadGrid.has(key)) roadGrid.set(key, []); roadGrid.get(key).push(segment);
    }
}
world.derivedRoads = [{ ...roadMeta.bounds, id: roadMeta.id, meta: roadMeta, vertices: roadVertices, segmentCount, cellSize: 16, grid: roadGrid }];
world.derivedTrackGround = {
    ...bounds, vertices, indices, triangleMaterials, materialPalette,
    grid: world._buildYbnGrid(vertices, indices, bounds),
    wallGrid: world._buildYbnWallGrid(vertices, indices, bounds),
    meta: surfaceMeta,
};
world.movementBounds = { minX: bounds.minX, minY: bounds.minY, maxX: bounds.maxX, maxY: bounds.maxY };

const issues = [];
const collisions = new Map();
let samples = 0;
let missingCenter = 0;
let invalidCenter = 0;
let maxCenterDelta = 0;
let missingWheelPath = 0;
let invalidWheelPath = 0;
let maxCrossTrackHeightDelta = 0;
let priorCenter = null;
for (let segment = 0; segment < segmentCount; segment += 8) {
    const base = segment * 6;
    const next = Math.min(segmentCount, segment + 1) * 6;
    const x = (roadVertices[base] + roadVertices[base + 3]) * 0.5;
    const y = (roadVertices[base + 1] + roadVertices[base + 4]) * 0.5;
    const ribbonZ = (roadVertices[base + 2] + roadVertices[base + 5]) * 0.5;
    const dx = ((roadVertices[next] + roadVertices[next + 3]) * 0.5) - x;
    const dy = ((roadVertices[next + 1] + roadVertices[next + 4]) * 0.5) - y;
    const length = Math.hypot(dx, dy) || 1;
    const ground = world.resolveGround(x, y, ribbonZ + 1.2, { maxSnapDistance: 4, applyYbnCalibration: false });
    samples++;
    if (!ground || ground.source !== 'track') {
        missingCenter++;
        issues.push({ type: 'missing_center', segment, x, y, ribbonZ, source: ground?.source });
        continue;
    }
    if (!ground.validTrack) {
        invalidCenter++;
        issues.push({ type: 'invalid_center', segment, x, y, z: ground.z, material: ground.material });
    }
    if (priorCenter) maxCenterDelta = Math.max(maxCenterDelta, Math.abs(ground.z - priorCenter.z));
    priorCenter = { z: ground.z };
    const rightX = -dy / length;
    const rightY = dx / length;
    for (const lateral of [-0.76, 0.76]) {
        const wheelGround = world.resolveGround(x + rightX * lateral, y + rightY * lateral, ribbonZ + 1.2, { maxSnapDistance: 4, applyYbnCalibration: false });
        if (!wheelGround || wheelGround.source !== 'track') missingWheelPath++;
        else {
            if (!wheelGround.validTrack) invalidWheelPath++;
            maxCrossTrackHeightDelta = Math.max(maxCrossTrackHeightDelta, Math.abs(wheelGround.z - ground.z));
        }
    }
    const speed = 30;
    const move = world.moveVehicle({
        x, y, feetZ: ground.z, heading: Math.atan2(dy, dx),
        vx: dx / length * speed, vy: dy / length * speed, dt: 1 / 60,
        halfWidth: 0.9, halfLength: 1.72, chassisClearance: 0.19,
        chassisHeight: 1.15, wheelRadius: 0.342, maxStepUp: 0.65,
        maxSnapDistance: 4, applyYbnCalibration: false,
    });
    if (move.blocked) {
        const key = `${move.hit?.source || move.reason}:${move.hit?.triangleOffset ?? ''}`;
        collisions.set(key, (collisions.get(key) || 0) + 1);
        const offset = Number(move.hit?.triangleOffset);
        let hitGeometry = null;
        if (Number.isFinite(offset) && offset >= 0) {
            const triangle = Math.floor(offset / 3);
            const points = [0, 1, 2].map((corner) => {
                const vertex = indices[offset + corner] * 3;
                return [vertices[vertex], vertices[vertex + 1], vertices[vertex + 2]];
            });
            const a = points[0]; const b = points[1]; const c = points[2];
            const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            const normal = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            const materialIndex = triangleMaterials[triangle];
            hitGeometry = { triangle, materialIndex, material: materialPalette[materialIndex]?.surface, points, normal, verticalSpan: Math.max(...points.map((point) => point[2])) - Math.min(...points.map((point) => point[2])) };
        }
        issues.push({ type: 'blocked_center', segment, x, y, z: ground.z, material: ground.material, reason: move.reason, hit: move.hit, hitGeometry });
    }
}

const result = {
    schema: 'webglgta-track-drivability-audit-v1', samples, missingCenter, invalidCenter,
    missingWheelPath, invalidWheelPath, maxCenterDelta, maxCrossTrackHeightDelta,
    blockedSamples: issues.filter((issue) => issue.type === 'blocked_center').length,
    uniqueCollisionTriangles: collisions.size,
    collisionTop: [...collisions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25),
    issues: issues.slice(0, 100),
};
console.log(JSON.stringify(result, null, 2));
if (missingCenter || invalidCenter || missingWheelPath || invalidWheelPath || result.blockedSamples) process.exitCode = 1;

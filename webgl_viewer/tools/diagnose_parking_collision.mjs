#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { CollisionWorld } from '../js/gameplay/collision_world.js';

const root = path.resolve(import.meta.dirname, '..');
const tileMetaPath = path.join(root, 'assets', 'collision', 'ybn_spawn.json');

function argumentPath(name, fallback) {
    const index = process.argv.indexOf(name);
    return path.resolve(index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback);
}

const assetManifestPath = argumentPath(
    '--asset-manifest',
    path.join(root, 'assets', 'demo', 'spawn_district_asset_colliders.json'),
);

function loadYbnTile(collision) {
    const meta = JSON.parse(fs.readFileSync(tileMetaPath, 'utf8'));
    const buffer = fs.readFileSync(path.resolve(path.dirname(tileMetaPath), meta.file));
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const header = new DataView(arrayBuffer);
    const version = header.getUint32(4, true);
    if (version !== 3 && version !== 4) throw new Error(`Expected YBNC v3/v4, got v${version}`);
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

function triangleForHit(collision, hit) {
    if (hit?.source !== 'ybn_wall') return null;
    const { vertices, indices } = collision.ybnGround;
    return [0, 1, 2].map((corner) => {
        const vertexOffset = indices[hit.triangleOffset + corner] * 3;
        return Array.from(vertices.slice(vertexOffset, vertexOffset + 3), (value) => Number(value.toFixed(4)));
    });
}

function makeWorld({ ybn, assets }) {
    const collision = new CollisionWorld({ groundPedToTerrain: false });
    collision.resolveGround = () => ({ z: 30, source: 'diagnostic' });
    if (ybn) loadYbnTile(collision);
    if (assets) {
        const manifest = JSON.parse(fs.readFileSync(assetManifestPath, 'utf8'));
        collision.setAssetColliders(manifest.colliders);
        collision.setYbnCollisionExclusions(manifest.ybnCollisionExclusions);
    }
    return collision;
}

function makeAuthoredGroundWorld() {
    const collision = new CollisionWorld({ groundPedToTerrain: true, spawnDistrictDemo: true });
    loadYbnTile(collision);
    const manifest = JSON.parse(fs.readFileSync(assetManifestPath, 'utf8'));
    collision.setAssetColliders(manifest.colliders);
    collision.setYbnCollisionExclusions(manifest.ybnCollisionExclusions);
    return collision;
}

function weedShopSweep({ assets, open, duration = 1.4 }) {
    const collision = new CollisionWorld({ groundPedToTerrain: true, spawnDistrictDemo: true });
    loadYbnTile(collision);
    if (assets) {
        const manifest = JSON.parse(fs.readFileSync(assetManifestPath, 'utf8'));
        collision.setAssetColliders(manifest.colliders);
        collision.setYbnCollisionExclusions(manifest.ybnCollisionExclusions);
    }
    const doors = [
        { id: 'weed-left', archetypeHash: '230454090', coords: { x: 376.98669, y: -833.05334, z: 29.41579 }, passageRadius: 0.9, passageHalfHeight: 1.3 },
        { id: 'weed-right', archetypeHash: '230454090', coords: { x: 377.9418, y: -833.05334, z: 29.4142 }, passageRadius: 0.9, passageHalfHeight: 1.3 },
    ];
    collision.setDoorDefinitions(doors);
    if (open) for (const door of doors) collision.setDoorOpenProgress(door.id, 1);
    const x = 377.46;
    const y = -834.8;
    const ground = collision.resolveGround(x, y, 29, { maxSnapDistance: 4, applyYbnCalibration: false });
    const result = collision.moveCapsule({
        x, y, feetZ: ground.z, vx: 0, vy: 4, dt: duration,
        radius: 0.38, height: 1.8, maxStepUp: 0.65, obstacleStepUp: 0.65,
        maxSnapDistance: 4, applyYbnCalibration: false, useDrawableProxies: false,
    });
    return {
        blocked: result.blocked,
        stoppedAt: [Number(result.x.toFixed(4)), Number(result.y.toFixed(4))],
        hit: result.hit ? {
            source: result.hit.source,
            id: result.hit.id,
            triangleOffset: result.hit.triangleOffset,
            triangle: triangleForHit(collision, result.hit),
        } : null,
    };
}

function legionStaleShellWallSweep({ assets }) {
    const collision = new CollisionWorld({ groundPedToTerrain: true, spawnDistrictDemo: true });
    loadYbnTile(collision);
    if (assets) {
        const manifest = JSON.parse(fs.readFileSync(assetManifestPath, 'utf8'));
        collision.setAssetColliders(manifest.colliders);
        collision.setYbnCollisionExclusions(manifest.ybnCollisionExclusions);
    }
    const x = 378.86572;
    const y = -830.2;
    const ground = collision.resolveGround(x, y, 29.36, { maxSnapDistance: 4, applyYbnCalibration: false });
    const result = collision.moveCapsule({
        x, y, feetZ: ground.z, vx: 0, vy: -1.75, dt: 0.7,
        radius: 0.28, height: 1.8, maxStepUp: 0.65, obstacleStepUp: 0.65,
        maxSnapDistance: 4, applyYbnCalibration: false, useDrawableProxies: false,
    });
    return {
        layers: assets ? 'ybn+assets' : 'ybn',
        blocked: result.blocked,
        stoppedAt: [Number(result.x.toFixed(4)), Number(result.y.toFixed(4))],
        hit: result.hit ? {
            source: result.hit.source,
            id: result.hit.id,
            triangleOffset: result.hit.triangleOffset,
            triangle: triangleForHit(collision, result.hit),
        } : null,
    };
}

function legionWeedShopCounterRoute() {
    const collision = new CollisionWorld({ groundPedToTerrain: true, spawnDistrictDemo: true });
    loadYbnTile(collision);
    const manifest = JSON.parse(fs.readFileSync(assetManifestPath, 'utf8'));
    collision.setAssetColliders(manifest.colliders);
    collision.setYbnCollisionExclusions(manifest.ybnCollisionExclusions);
    const doors = [
        { id: 'weed-left', archetypeHash: '230454090', coords: { x: 376.98669, y: -833.05334, z: 29.41579 }, passageRadius: 0.9, passageHalfHeight: 1.3 },
        { id: 'weed-right', archetypeHash: '230454090', coords: { x: 377.9418, y: -833.05334, z: 29.4142 }, passageRadius: 0.9, passageHalfHeight: 1.3 },
    ];
    collision.setDoorDefinitions(doors);
    for (const door of doors) collision.setDoorOpenProgress(door.id, 1);

    let x = 377.46;
    let y = -834.8;
    let feetZ = collision.resolveGround(x, y, 29, { maxSnapDistance: 4, applyYbnCalibration: false }).z;
    const route = [
        [377.46, -826.0],
        [376.4, -826.0],
        [376.4, -823.4],
        [377.2, -823.4],
    ];
    const visited = [[x, y]];
    for (const [targetX, targetY] of route) {
        while (Math.hypot(targetX - x, targetY - y) > 0.05) {
            const distance = Math.hypot(targetX - x, targetY - y);
            const step = Math.min(0.14, distance);
            const vx = (targetX - x) / distance * 4;
            const vy = (targetY - y) / distance * 4;
            const result = collision.moveCapsule({
                x, y, feetZ, vx, vy, dt: step / 4,
                radius: 0.38, height: 1.8, maxStepUp: 0.65, obstacleStepUp: 0.65,
                maxSnapDistance: 4, applyYbnCalibration: false, useDrawableProxies: false,
            });
            x = result.x;
            y = result.y;
            feetZ = result.ground.z;
            if (result.blocked) return {
                clear: false,
                stoppedAt: [Number(x.toFixed(4)), Number(y.toFixed(4))],
                hit: result.hit ? {
                    source: result.hit.source,
                    id: result.hit.id,
                    triangleOffset: result.hit.triangleOffset,
                    triangle: triangleForHit(collision, result.hit),
                } : null,
                visited,
            };
        }
        visited.push([Number(x.toFixed(4)), Number(y.toFixed(4))]);
    }
    return { clear: true, stoppedAt: visited.at(-1), hit: null, visited };
}

function diagnoseWeedShop() {
    const authoredPortal = weedShopSweep({ assets: false, open: false, duration: 2.8 });
    const closed = weedShopSweep({ assets: true, open: false, duration: 2.8 });
    const open = weedShopSweep({ assets: true, open: true, duration: 2.8 });
    const staleShellWall = [
        legionStaleShellWallSweep({ assets: false }),
        legionStaleShellWallSweep({ assets: true }),
    ];
    const counterRoute = legionWeedShopCounterRoute();
    const result = { authoredPortal, closed, open, staleShellWall, counterRoute };
    console.log(JSON.stringify({ weedShopEntrance: result }, null, 2));
    if (!counterRoute.clear
        || staleShellWall.some((sweep) => sweep.blocked || sweep.stoppedAt[1] > -831.35)) process.exitCode = 1;
}

function officeWeedShopSweep({ ybn, assets, open, lateralOffset = 0 }) {
    const collision = new CollisionWorld({ groundPedToTerrain: true, spawnDistrictDemo: true });
    if (ybn) loadYbnTile(collision);
    const interactables = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'demo', 'interactables.json'), 'utf8'));
    const doors = (interactables.doors || []).filter((door) => {
        const x = Number(door?.coords?.x);
        const y = Number(door?.coords?.y);
        return x > -50 && x < -20 && y > -1060 && y < -1020;
    });
    if (assets) {
        const manifest = JSON.parse(fs.readFileSync(assetManifestPath, 'utf8'));
        collision.setAssetColliders(manifest.colliders);
        collision.setYbnCollisionExclusions(manifest.ybnCollisionExclusions);
    }
    collision.setDoorDefinitions(doors);
    if (open) for (const door of doors) collision.setDoorOpenProgress(door.id, 1);

    const entrance = doors.find((door) => String(door.archetypeHash) === '3752559086');
    if (!entrance) throw new Error('Office weed-shop entrance door is missing');
    const collider = JSON.parse(fs.readFileSync(assetManifestPath, 'utf8')).colliders
        .filter((item) => String(item.archetypeHash) === String(entrance.archetypeHash))
        .sort((left, right) => (
            Math.hypot(Number(left.x) - Number(entrance.coords.x), Number(left.y) - Number(entrance.coords.y))
            - Math.hypot(Number(right.x) - Number(entrance.coords.x), Number(right.y) - Number(entrance.coords.y))
        ))[0];
    if (!collider) throw new Error('Office weed-shop entrance collider is missing');
    const normalX = Number(collider.axisYX);
    const normalY = Number(collider.axisYY);
    const tangentX = Number(collider.axisXX);
    const tangentY = Number(collider.axisXY);
    const startX = Number(entrance.coords.x) - normalX * 2.2 + tangentX * lateralOffset;
    const startY = Number(entrance.coords.y) - normalY * 2.2 + tangentY * lateralOffset;
    const feetZ = collision.resolveGround(startX, startY, Number(entrance.origin.z), {
        maxSnapDistance: 4,
        applyYbnCalibration: false,
    }).z;
    const result = collision.moveCapsule({
        x: startX,
        y: startY,
        feetZ,
        vx: normalX * 5.5,
        vy: normalY * 5.5,
        dt: 0.8,
        radius: 0.38,
        height: 1.8,
        maxStepUp: 0.65,
        obstacleStepUp: 0.65,
        maxSnapDistance: 4,
        applyYbnCalibration: false,
        useDrawableProxies: false,
    });
    return {
        layers: { ybn, assets },
        open,
        lateralOffset,
        start: [Number(startX.toFixed(4)), Number(startY.toFixed(4)), Number(feetZ.toFixed(4))],
        end: [Number(result.x.toFixed(4)), Number(result.y.toFixed(4)), Number(result.ground.z.toFixed(4))],
        blocked: result.blocked,
        reason: result.reason,
        hit: result.hit ? {
            source: result.hit.source,
            id: result.hit.id,
            triangleOffset: result.hit.triangleOffset,
            triangle: triangleForHit(collision, result.hit),
        } : null,
    };
}

function diagnoseOfficeWeedShop() {
    const results = [];
    for (const layer of [
        { ybn: true, assets: false },
        { ybn: false, assets: true },
        { ybn: true, assets: true },
    ]) {
        for (const open of [false, true]) {
            for (const lateralOffset of [-0.3, 0, 0.3]) {
                results.push(officeWeedShopSweep({ ...layer, open, lateralOffset }));
            }
        }
    }
    console.log(JSON.stringify({ officeWeedShopEntrance: results }, null, 2));
    const combinedOpen = results.filter((result) => result.layers.ybn && result.layers.assets && result.open);
    if (combinedOpen.some((result) => result.blocked)) process.exitCode = 1;
}

function scanSouthBoundary() {
    const collision = makeAuthoredGroundWorld();
    const manifest = JSON.parse(fs.readFileSync(assetManifestPath, 'utf8'));
    if (!process.argv.includes('--keep-destructibles')) for (const collider of manifest.colliders) {
        if (collider.destructibleId) collision.destroyedDestructibleIds.add(collider.destructibleId);
    }
    const clear = [];
    const blocked = [];
    for (let x = 195; x <= 240; x += 0.25) {
        let y = -802;
        let feetZ = collision.resolveGround(x, y, 30, { applyYbnCalibration: false }).z;
        let hit = null;
        while (y > -832) {
            const move = collision.moveCapsule({
                x, y, feetZ, vx: 0, vy: -8, dt: 0.02,
                radius: 0.9609, height: 1.8,
                maxStepUp: 0.65, obstacleStepUp: 0.65,
                maxSnapDistance: 4, applyYbnCalibration: false, useDrawableProxies: false,
            });
            if (move.blocked) {
                hit = {
                    x: Number(x.toFixed(2)), y: Number(move.y.toFixed(3)), reason: move.reason,
                    source: move.hit?.source, id: move.hit?.id,
                    triangleOffset: move.hit?.triangleOffset,
                    triangle: triangleForHit(collision, move.hit),
                };
                break;
            }
            y = move.y;
            feetZ = move.ground.z;
        }
        if (hit) blocked.push(hit);
        else clear.push(Number(x.toFixed(2)));
    }
    const intervals = [];
    for (const x of clear) {
        const previous = intervals.at(-1);
        if (previous && Math.abs(x - previous[1] - 0.25) < 1e-6) previous[1] = x;
        else intervals.push([x, x]);
    }
    const uniqueHits = [];
    const seen = new Set();
    for (const hit of blocked) {
        const key = `${hit.reason}:${hit.id || ''}:${hit.triangleOffset ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        uniqueHits.push(hit);
    }
    console.log(JSON.stringify({ scan: 'south-boundary', clearIntervals: intervals, uniqueHits }, null, 2));
}

function sweep(collision, x, radius = 1.15) {
    const result = collision.moveCapsule({
        x, y: -806, feetZ: 30, vx: 0, vy: -20, dt: 1,
        radius, height: 1.8,
        maxStepUp: 0.65, obstacleStepUp: 0.65,
        maxSnapDistance: 4, applyYbnCalibration: false, useDrawableProxies: false,
    });
    return {
        x,
        radius,
        blocked: result.blocked,
        stoppedAt: [Number(result.x.toFixed(4)), Number(result.y.toFixed(4))],
        hit: result.hit ? {
            source: result.hit.source,
            id: result.hit.id,
            label: result.hit.label,
            triangleOffset: result.hit.triangleOffset,
            normal: [result.hit.normalX, result.hit.normalY].map((value) => Number(Number(value).toFixed(4))),
            triangle: triangleForHit(collision, result.hit),
        } : null,
    };
}

if (process.argv.includes('--boundary-scan')) {
    scanSouthBoundary();
    process.exit(0);
}


if (process.argv.includes('--weed-shop')) {
    diagnoseWeedShop();
    process.exit(process.exitCode || 0);
}

if (process.argv.includes('--office-weed-shop')) {
    diagnoseOfficeWeedShop();
    process.exit(process.exitCode || 0);
}

if (!process.argv.includes('--authored-ground-only')) {
    for (const layer of [
        { name: 'ybn', ybn: true, assets: false },
        { name: 'assets', ybn: false, assets: true },
        { name: 'combined', ybn: true, assets: true },
    ]) {
        const collision = makeWorld(layer);
        const results = [];
        for (let x = 202; x <= 215; x += 0.5) results.push(sweep(collision, x));
        console.log(JSON.stringify({ layer: layer.name, results }, null, 2));
    }
}

{
    const collision = makeAuthoredGroundWorld();
    const results = [];
    if (!process.argv.includes('--route-only')) for (let x = 206; x <= 222; x += 0.25) {
        const ground = collision.resolveGround(x, -806, 30, { applyYbnCalibration: false });
        const result = collision.moveCapsule({
            x, y: -806, feetZ: ground.z, vx: 0, vy: -20, dt: 1,
            radius: 0.9609, height: 1.8,
            maxStepUp: 0.65, obstacleStepUp: 0.65,
            maxSnapDistance: 4, applyYbnCalibration: false, useDrawableProxies: false,
        });
        results.push({
            x,
            startGround: Number(ground.z.toFixed(4)),
            endGround: Number(result.ground.z.toFixed(4)),
            blocked: result.blocked,
            reason: result.reason,
            stoppedAt: [Number(result.x.toFixed(4)), Number(result.y.toFixed(4))],
            hit: result.hit ? {
                source: result.hit.source,
                id: result.hit.id,
                triangleOffset: result.hit.triangleOffset,
                triangle: triangleForHit(collision, result.hit),
            } : null,
        });
    }
    const route = [];
    let routeX = 221.54;
    let routeY = -806.78;
    let routeGround = collision.resolveGround(routeX, routeY, 30, { applyYbnCalibration: false }).z;
    for (const [targetX, targetY] of [[218.5, -811], [218.5, -826]]) {
        while (Math.hypot(targetX - routeX, targetY - routeY) > 0.05) {
            const distance = Math.hypot(targetX - routeX, targetY - routeY);
            const step = Math.min(0.16, distance);
            const vx = (targetX - routeX) / distance * 10;
            const vy = (targetY - routeY) / distance * 10;
            const move = collision.moveCapsule({
                x: routeX, y: routeY, feetZ: routeGround, vx, vy, dt: step / 10,
                radius: 0.9609, height: 1.8,
                maxStepUp: 0.65, obstacleStepUp: 0.65,
                maxSnapDistance: 4, applyYbnCalibration: false, useDrawableProxies: false,
            });
            routeX = move.x;
            routeY = move.y;
            routeGround = move.ground.z;
            if (move.blocked) {
                route.push({
                    at: [Number(routeX.toFixed(4)), Number(routeY.toFixed(4))],
                    reason: move.reason,
                    source: move.hit?.source,
                    id: move.hit?.id,
                    triangleOffset: move.hit?.triangleOffset,
                    triangle: triangleForHit(collision, move.hit),
                });
                break;
            }
        }
        if (route.length) break;
    }
    console.log(JSON.stringify({ layer: 'combined-authored-ground', results, route }, null, 2));
    if (process.argv.includes('--assert-clear') && route.length) process.exitCode = 1;
}

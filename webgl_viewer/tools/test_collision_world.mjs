import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CollisionWorld } from '../js/gameplay/collision_world.js';
import { DrawableStreamer } from '../js/drawable_streamer.js';

function makeWorld(triangles) {
    const collision = new CollisionWorld({ groundPedToTerrain: false });
    const vertices = new Float32Array(triangles.flat());
    const indices = new Uint32Array(vertices.length / 3);
    for (let i = 0; i < indices.length; i++) indices[i] = i;
    const bounds = { minX: -10, minY: -10, maxX: 10, maxY: 10, cellSize: 4 };
    collision.ybnGround = {
        ...bounds,
        vertices,
        indices,
        grid: new Map(),
        wallGrid: collision._buildYbnWallGrid(vertices, indices, bounds),
    };
    collision.resolveGround = () => ({ z: 0, source: 'test' });
    return collision;
}

function makePackedWorld(triangles) {
    const collision = new CollisionWorld({ groundPedToTerrain: false });
    const vertices = new Float32Array(triangles.flat());
    const indices = new Uint32Array(vertices.length / 3);
    for (let i = 0; i < indices.length; i++) indices[i] = i;
    const bounds = { minX: -10, minY: -10, maxX: 10, maxY: 10, cellSize: 4 };
    const built = collision._buildYbnWallGrid(vertices, indices, bounds);
    const minGX = Math.floor(bounds.minX / bounds.cellSize);
    const minGY = Math.floor(bounds.minY / bounds.cellSize);
    const maxGX = Math.floor(bounds.maxX / bounds.cellSize);
    const maxGY = Math.floor(bounds.maxY / bounds.cellSize);
    const width = maxGX - minGX + 1;
    const height = maxGY - minGY + 1;
    const cellOffsets = [0];
    const triangleOffsets = [];
    for (let gy = minGY; gy <= maxGY; gy++) {
        for (let gx = minGX; gx <= maxGX; gx++) {
            triangleOffsets.push(...(built.cells.get(`${gx}:${gy}`) || []));
            cellOffsets.push(triangleOffsets.length);
        }
    }
    collision.ybnGround = {
        ...bounds,
        vertices,
        indices,
        grid: new Map(),
        wallGrid: {
            minGX,
            minGY,
            width,
            height,
            cellOffsets: Uint32Array.from(cellOffsets),
            triangleOffsets: Uint32Array.from(triangleOffsets),
            triangleCount: built.triangleCount,
        },
    };
    collision.resolveGround = () => ({ z: 0, source: 'test' });
    return collision;
}

const verticalWall = [
    1, -2, 0, 1, 2, 0, 1, 2, 3,
    1, -2, 0, 1, 2, 3, 1, -2, 3,
];

{
    const metadata = JSON.parse(fs.readFileSync(new URL('../assets/collision/ybn_spawn.json', import.meta.url)));
    assert.equal(metadata.version, 4, 'the demo collision tile must include packed walls and per-triangle materials');
    assert.ok(metadata.wall_triangle_count > 0, 'the demo collision tile must retain authored YBN wall triangles');
    assert.ok(metadata.wall_grid_reference_count > 0, 'the demo collision tile must index authored YBN wall triangles');
    assert.ok(metadata.surface_materials?.length > 20, 'the demo collision tile must retain CodeWalker material profiles');
    assert.equal(metadata.surface_material_triangle_count, metadata.triangle_count, 'every collision triangle must retain a material');
    assert.equal(metadata.skipped_ybn_count, 0, 'every in-range base GTA YBN must load');
    assert.equal(metadata.replaced_base_ybn_count, 5, 'both weed-shop resources must replace their five base collision layers');
    assert.equal(metadata.loose_ybn_count, 7, 'both weed-shop exterior and translated MLO collision resources must load');
    assert.deepEqual(metadata.resource_ybn_offsets?.int_weed, [378.64212, -821.9661, 30.057575]);
    assert.deepEqual(metadata.resource_ybn_offsets?.florek_weedshopcol, [-8.281454, -1076.245728, 33.069939]);
    for (const name of [
        'FiveM:dt1_14_0.ybn', 'FiveM:hi@dt1_14_0.ybn', 'FiveM:int_weed.ybn',
        'FiveM:florek_weedshopcol.ybn', 'FiveM:hei_dt1_22_0.ybn',
        'FiveM:hi@hei_dt1_22_0.ybn', 'FiveM:ma@hei_dt1_22_0.ybn',
    ]) {
        assert.ok(metadata.source_ybn_names.includes(name), `${name} must remain in the collision tile`);
    }
    assert.ok(metadata.emitted_triangle_counts?.BoundPolygonBox > 0, 'GTA box collision primitives must be exported');
    assert.ok(metadata.emitted_triangle_counts?.BoundPolygonCapsule > 0, 'GTA capsule collision primitives must be exported');
    assert.ok(metadata.emitted_triangle_counts?.BoundPolygonCylinder > 0, 'GTA cylinder collision primitives must be exported');
    assert.ok(metadata.emitted_triangle_counts?.BoundPolygonSphere > 0, 'GTA sphere collision primitives must be exported');
    assert.deepEqual(metadata.unsupported_polygon_counts, {}, 'no in-range GTA collision primitive may be silently dropped');
    assert.ok(metadata.grid_cell_size <= 8, 'the packed collision grid must remain narrow enough for per-tick queries');
}

{
    const collision = makeWorld(verticalWall);
    const result = collision.moveCapsule({ x: 0, y: 0, feetZ: 0, vx: 20, vy: 0, dt: 1, radius: 0.38, maxStepUp: 0.3 });
    assert.equal(result.blocked, true);
    assert.ok(result.x > 0.60 && result.x < 0.63, `wall clearance was ${result.x}`);
    assert.ok(Math.abs(result.y) < 1e-6);
}

{
    const collision = makePackedWorld(verticalWall);
    assert.equal(collision.ybnGround.wallGrid.cells, undefined);
    const result = collision.moveCapsule({ x: 0, y: 0, feetZ: 0, vx: 20, vy: 0, dt: 1, radius: 0.38, maxStepUp: 0.3 });
    assert.equal(result.blocked, true, 'packed v3 wall data must block the capsule');
    assert.ok(result.x > 0.60 && result.x < 0.63, `packed wall clearance was ${result.x}`);
}

{
    const collision = makePackedWorld(verticalWall);
    collision.setDoorDefinitions([{
        id: 'test-door', archetypeHash: '123',
        coords: { x: 1, y: 0, z: 1.2 },
        passageRadius: 0.9, passageHalfHeight: 1.3,
    }]);
    const closed = collision.moveCapsule({ x: 0, y: 0, feetZ: 0, vx: 2, vy: 0, dt: 1, radius: 0.38 });
    assert.equal(closed.blocked, true, 'a closed door passage must retain authored wall collision');
    collision.setDoorOpenProgress('test-door', 1);
    const open = collision.moveCapsule({ x: 0, y: 0, feetZ: 0, vx: 2, vy: 0, dt: 1, radius: 0.38 });
    assert.equal(open.blocked, false, 'an open door passage must release authored wall collision');
}

{
    const manifest = JSON.parse(fs.readFileSync(new URL('../assets/demo/spawn_district_asset_colliders.json', import.meta.url)));
    const ids = new Set(manifest.colliders.map((collider) => collider.id));
    assert.equal(ids.has('asset:4109254567:1666:shell:south'), false);
    assert.equal(ids.has('asset:666240703:1667:shell:south'), false);
    assert.equal(ids.has('asset:2765303843:1622'), false, 'the parking egress traffic-light bound must remain disabled');
    for (let index = 4532; index <= 4540; index++) {
        assert.equal(ids.has(`asset:3300474446:${index}`), false, `entrance bollard ${index} must not create invisible collision`);
    }
    assert.equal(
        manifest.colliders.some((item) => item.archetypeHash === '3300474446'
            && item.x >= 212.5 && item.x <= 222.5 && item.y >= -816.25 && item.y <= -811.25),
        false,
        'parking entrance bollards must remain excluded even when generated entity IDs shift',
    );
    assert.deepEqual(
        new Set(manifest.ybnCollisionExclusions.map((item) => item.id)),
        new Set([
            'parking-entrance-traffic-pole',
            'parking-entrance-cross-lane-box',
            'legion-square-weedshop-partition-opening',
        ]),
    );
    const collision = new CollisionWorld({ groundPedToTerrain: false });
    collision.resolveGround = () => ({ z: 30, source: 'test' });
    assert.equal(
        collision.setAssetColliders(manifest.colliders),
        manifest.colliders.length,
        'runtime must install every preprocessed collider, including building shells',
    );
    assert.ok(manifest.buildingShellColliderCount > 0, 'building shell collision must be present');
    assert.ok(manifest.foliageTrunkColliderCount > 0, 'large foliage must receive trunk collision');
    const exit = collision.moveCapsule({
        x: 208.5, y: -806, feetZ: 30, vx: 0, vy: -20, dt: 1,
        radius: 0.95, maxStepUp: 0.65, obstacleStepUp: 0.65,
    });
    assert.equal(exit.blocked, false, `parking-lot entrance remained blocked by ${exit.hit?.id || 'unknown'}`);
    const adjacentBarrier = collision.moveCapsule({
        x: 205, y: -806, feetZ: 30, vx: 0, vy: -20, dt: 1,
        radius: 0.95, maxStepUp: 0.65, obstacleStepUp: 0.65,
    });
    assert.equal(adjacentBarrier.blocked, true, 'nearby exported prop collision should remain active');
}

{
    const collision = makePackedWorld(verticalWall);
    collision.setYbnCollisionExclusions([{
        id: 'test-wall', minX: 0.5, minY: -3, minZ: -1, maxX: 1.5, maxY: 3, maxZ: 4,
    }]);
    const result = collision.moveCapsule({ x: 0, y: 0, feetZ: 0, vx: 2, vy: 0, dt: 1, radius: 0.38 });
    assert.equal(result.blocked, false, 'authored YBN exclusions must remove matching wall contacts');
}

{
    const collision = makeWorld([
        -2, -2, 1, 2, -2, 1, 2, 2, 1,
        -2, -2, 1, 2, 2, 1, -2, 2, 1,
    ]);
    collision.ybnGround.grid.set('0:0', [0, 3]);
    assert.equal(collision._getYbnGroundAtXY(0, 0, 0, 2), 1);
    collision.setYbnCollisionExclusions([{
        id: 'test-ground', minX: -3, minY: -3, minZ: 0.5, maxX: 3, maxY: 3, maxZ: 1.5,
    }]);
    assert.equal(collision._getYbnGroundAtXY(0, 0, 0, 2), null, 'YBN exclusions must also remove false step surfaces');
}

{
    const manifest = JSON.parse(fs.readFileSync(new URL('../assets/demo/spawn_district_asset_colliders.json', import.meta.url)));
    for (const [label, collider] of [
        ['building', manifest.colliders.find((item) => item.source === 'exported_building_shell')],
        ['tree', manifest.colliders.find((item) => item.source === 'exported_foliage_trunk')],
        ['dumpster', manifest.colliders.find((item) => item.archetypeHash === '666561306')],
    ]) {
        assert.ok(collider, `${label} regression fixture must exist in the demo collider manifest`);
        const collision = new CollisionWorld({ groundPedToTerrain: false });
        collision.resolveGround = () => ({ z: collider.minZ, source: 'test' });
        collision.setAssetColliders([collider]);
        const distance = collider.halfX + 1.0;
        const result = collision.moveCapsule({
            x: collider.x + collider.axisXX * distance,
            y: collider.y + collider.axisXY * distance,
            feetZ: collider.minZ,
            vx: -collider.axisXX * 4,
            vy: -collider.axisXY * 4,
            dt: 1,
            radius: 0.38,
            maxStepUp: 0.3,
        });
        assert.equal(result.blocked, true, `${label} collider must block player movement`);
    }
}

{
    const manifest = JSON.parse(fs.readFileSync(new URL('../assets/demo/spawn_district_asset_colliders.json', import.meta.url)));
    const pushable = manifest.colliders.find((item) => item.response === 'pushable');
    const dumpster = manifest.colliders.find((item) => item.archetypeHash === '666561306');
    assert.ok(pushable?.instance, 'a real loose prop must retain its source instance transform');
    assert.ok(dumpster, 'a real heavy dumpster fixture must exist');
    assert.notEqual(dumpster.response, 'pushable', 'dumpsters must remain heavy solid obstacles');

    let movedEvent = null;
    const app = { onDynamicPropMoved(event) { movedEvent = event; } };
    const collision = new CollisionWorld(app);
    collision.resolveGround = (x, y, z) => ({ z, source: 'test' });
    collision.setAssetColliders([pushable]);
    const runtime = collision._assetCollidersById.get(pushable.id);
    const startX = runtime.x + runtime.axisXX * (runtime.halfX + 0.5);
    const startY = runtime.y + runtime.axisXY * (runtime.halfX + 0.5);
    const beforeX = runtime.x;
    const beforeY = runtime.y;
    collision.moveCapsule({
        x: startX,
        y: startY,
        feetZ: runtime.minZ,
        vx: -runtime.axisXX * 2,
        vy: -runtime.axisXY * 2,
        dt: 0.1,
        radius: 0.38,
        maxStepUp: 0.3,
    });
    assert.ok(Math.hypot(runtime.x - beforeX, runtime.y - beforeY) > 0.05, 'light prop contact must move its collider');
    assert.equal(movedEvent?.id, pushable.id, 'light prop contact must update the rendered source instance');
    assert.deepEqual(movedEvent?.source, [pushable.instance.x, pushable.instance.y, pushable.instance.z]);

    const visualState = { _instanceTransformOverridesByHash: new Map(), _dirty: false };
    assert.equal(DrawableStreamer.prototype.setInstanceTransformOverride.call(visualState, {
        archetypeHash: movedEvent.archetypeHash,
        source: movedEvent.source,
        position: movedEvent.position,
    }), true);
    const visual = DrawableStreamer.prototype._instanceTransformOverride.call(
        visualState,
        movedEvent.archetypeHash,
        ...movedEvent.source,
    );
    assert.deepEqual(visual?.position, movedEvent.position, 'rendered instance must follow the moved collider');
}

{
    const curb = [
        1, -2, 0, 1, 2, 0, 1, 2, 0.2,
        1, -2, 0, 1, 2, 0.2, 1, -2, 0.2,
    ];
    const collision = makeWorld(curb);
    const hit = collision._firstYbnWallHit(0.8, 0, 0, 0.38, 1.8, 0.3, 1, 0);
    assert.equal(hit, null, 'a step-height curb must not be treated as a wall');
}

{
    const lowWall = [
        1, -2, 0, 1, 2, 0, 1, 2, 0.8,
        1, -2, 0, 1, 2, 0.8, 1, -2, 0.8,
    ];
    const collision = makeWorld(lowWall);
    const hit = collision._firstYbnWallHit(0.8, 0, 0, 0.38, 1.8, 1.15, 1, 0);
    assert.equal(hit?.source, 'ybn_wall', 'legacy ground snap distance must not make a low wall walkable');
}

{
    const diagonalWall = [
        0, 2, 0, 2, 0, 0, 2, 0, 3,
        0, 2, 0, 2, 0, 3, 0, 2, 3,
    ];
    const collision = makeWorld(diagonalWall);
    const result = collision.moveCapsule({ x: 0, y: 0, feetZ: 0, vx: 2, vy: 1, dt: 1, radius: 0.38, maxStepUp: 0.3 });
    assert.equal(result.blocked, true);
    assert.ok(result.x > 0.5 && result.y > 0.05, `diagonal slide did not advance: ${result.x}, ${result.y}`);
    assert.ok(result.x + result.y <= 2 - Math.SQRT2 * 0.38 + 0.01, 'capsule crossed the diagonal wall');
    assert.ok(Math.abs(result.vx + result.vy) < 0.02, `velocity was not projected onto wall tangent: ${result.vx}, ${result.vy}`);
}

{
    const objectMatrix = new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        1, 0, 0, 1,
    ]);
    const collision = new CollisionWorld({
        instancedModelRenderer: {
            instances: new Map(),
            buckets: new Map([
                ['object', {
                    file: 'dumpster.mesh',
                    instanceData: objectMatrix,
                    instanceStrideFloats: 16,
                    mesh: { bounds: { min: [-0.5, -0.5, 0], max: [0.5, 0.5, 1.2] } },
                }],
            ]),
        },
    });
    const hit = collision._firstDrawableProxyHit(0.7, 0, 0, 0.38, 1.8, 0.3, 1, 0);
    assert.equal(hit?.source, 'drawable_bounds');
    assert.ok(hit.normalX < -0.99);
}

{
    const collision = new CollisionWorld({ groundPedToTerrain: false });
    collision.addDestructibles([{
        id: 'fragment:test',
        label: 'test fragment',
        archetypeHash: '123',
        coords: { x: 2, y: 0, z: 0 },
        radius: 0.5,
        height: 1.0,
        breakSpeed: 4.5,
        blocksMovement: false,
    }]);
    assert.equal(collision.blockers.length, 0, 'non-blocking fragments must not become movement walls');
    const shot = collision.raycast({ origin: [0, 0, 0.5], direction: [1, 0, 0], maxDistance: 5 });
    assert.equal(shot?.id, 'fragment:test');
    assert.equal(shot?.destructible, true);
    const vehicleImpact = collision.findDestructibleImpact({
        start: [0, 0], end: [3, 0], radius: 0.8, feetZ: 0,
    });
    assert.equal(vehicleImpact?.id, 'fragment:test');
    const destroyed = collision.destroyDestructibleForImpact(vehicleImpact, 8, { source: 'vehicle' });
    assert.equal(destroyed?.id, 'fragment:test');
    assert.equal(collision.raycast({ origin: [0, 0, 0.5], direction: [1, 0, 0], maxDistance: 5 }), null);
}

{
    const collision = new CollisionWorld({ groundPedToTerrain: false });
    collision.addDestructibles([{
        id: 'fragment:durable', coords: { x: 1, y: 0, z: 0 }, radius: 0.25, height: 0.5,
        breakSpeed: 1, breakHealth: 2, blocksMovement: false,
    }]);
    const hit = collision.raycast({ origin: [0, 0, 0.25], direction: [1, 0, 0], maxDistance: 3 });
    assert.equal(collision.destroyDestructibleForImpact(hit, 999, { source: 'bullet' }), null);
    assert.equal(collision.destroyDestructibleForImpact(hit, 999, { source: 'bullet' })?.id, 'fragment:durable');
}

{
    const collision = new CollisionWorld({ groundPedToTerrain: false });
    collision.resolveGround = () => ({ z: 0, source: 'test' });
    assert.equal(collision.setAssetColliders([{
        id: 'asset:hydrant', archetypeHash: 'hydrant', source: 'exported_asset_bounds', destructibleId: 'fragment:hydrant',
        x: 1, y: 0, minZ: 0, maxZ: 1.1,
        halfX: 0.25, halfY: 0.25,
        axisXX: 1, axisXY: 0, axisYX: 0, axisYY: 1,
    }]), 1);
    const result = collision.moveCapsule({ x: 0, y: 0, feetZ: 0, vx: 2, vy: 0, dt: 1, radius: 0.38, maxStepUp: 0.3 });
    assert.equal(result.blocked, true);
    assert.equal(result.hit?.source, 'exported_asset_bounds');
    assert.ok(result.x > 0.35 && result.x < 0.38, `asset collider clearance was ${result.x}`);
    collision.destroyedDestructibleIds.add('fragment:hydrant');
    const cleared = collision.moveCapsule({ x: 0, y: 0, feetZ: 0, vx: 2, vy: 0, dt: 1, radius: 0.38, maxStepUp: 0.3 });
    assert.equal(cleared.blocked, false, 'destroyed fragment bounds must stop blocking movement');
}

{
    const collision = new CollisionWorld({ groundPedToTerrain: false });
    collision.resolveGround = () => ({ z: 0, source: 'test' });
    collision.setAssetColliders([{
        id: 'asset:curb', archetypeHash: 'curb', source: 'exported_asset_bounds',
        x: 1, y: 0, minZ: 0, maxZ: 0.6,
        halfX: 0.12, halfY: 2,
        axisXX: 1, axisXY: 0, axisYX: 0, axisYY: 1,
    }]);
    const pedestrian = collision.moveCapsule({
        x: 0, y: 0, feetZ: 0, vx: 2, vy: 0, dt: 1,
        radius: 0.38, maxStepUp: 0.3, obstacleStepUp: 0.3,
    });
    assert.equal(pedestrian.blocked, true, 'a curb above pedestrian step height must remain solid');
    const vehicle = collision.moveCapsule({
        x: 0, y: 0, feetZ: 0, vx: 2, vy: 0, dt: 1,
        radius: 1.15, maxStepUp: 0.65, obstacleStepUp: 0.65,
    });
    assert.equal(vehicle.blocked, false, 'vehicle wheel clearance must apply to exported asset bounds');
}

{
    const calls = [];
    const collision = new CollisionWorld({ groundPedToTerrain: true, spawnDistrictDemo: true });
    collision._getYbnGroundContactAtXY = (_x, _y, _hint, maxRise, options) => {
        calls.push({ maxRise, options });
        return { z: 4.0 };
    };
    const ground = collision.resolveGround(0, 0, 6.0, {
        maxRise: 0.05,
        maxDrop: 8.0,
        nearestToHint: false,
    });
    assert.equal(ground.z, 4.0);
    assert.deepEqual(calls[0], {
        maxRise: 0.05,
        options: { nearestToHint: false, maxDrop: 8.0 },
    }, 'airborne grounding must reject overhead slabs and search downward');
}

{
    let floorQueries = 0;
    const app = {
        groundPedToTerrain: true,
        spawnDistrictDemo: true,
        drawableStreamer: {
            _activeInterior: { parentGuid: 7, roomIndex: 1 },
            getInteriorFloorAtDataPos() {
                floorQueries++;
                return { floorZ: 30.67, inRoom: true, roomIndex: 1 };
            },
        },
    };
    const collision = new CollisionWorld(app);
    collision._getYbnGroundContactAtXY = () => null;
    const ground = collision.resolveGround(-310.64, -2008.15, 30.2, { preferInterior: true });
    assert.equal(floorQueries, 1);
    assert.equal(ground.source, 'interior');
    assert.equal(ground.z, 30.67, 'an active bounded-demo MLO must own its authored room floor when YBN is absent');

    app.drawableStreamer._activeInterior = null;
    const street = collision.resolveGround(-310.64, -2008.15, 30.2, { preferInterior: true });
    assert.equal(floorQueries, 1, 'bounded city ground must not query unrelated render floors without an active MLO');
    assert.equal(street.source, 'runtime');
}

console.log('collision_world: map walls, building shells, trees, dumpsters, vehicle curb clearance, movement sweep, drawable proxy, and fragments passed');

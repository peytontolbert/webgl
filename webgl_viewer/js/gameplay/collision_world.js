function finite(n, fallback = 0.0) {
    const v = Number(n);
    return Number.isFinite(v) ? v : fallback;
}

function dist2xy(a, b, x, y) {
    const dx = finite(a) - finite(x);
    const dy = finite(b) - finite(y);
    return dx * dx + dy * dy;
}

function rayTriangleDistance(origin, direction, maxDistance, ax, ay, az, bx, by, bz, cx, cy, cz) {
    const e1x = bx - ax; const e1y = by - ay; const e1z = bz - az;
    const e2x = cx - ax; const e2y = cy - ay; const e2z = cz - az;
    const px = direction[1] * e2z - direction[2] * e2y;
    const py = direction[2] * e2x - direction[0] * e2z;
    const pz = direction[0] * e2y - direction[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-7) return null;
    const invDet = 1.0 / det;
    const tx = origin[0] - ax; const ty = origin[1] - ay; const tz = origin[2] - az;
    const u = (tx * px + ty * py + tz * pz) * invDet;
    if (u < 0.0 || u > 1.0) return null;
    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (direction[0] * qx + direction[1] * qy + direction[2] * qz) * invDet;
    if (v < 0.0 || u + v > 1.0) return null;
    const distance = (e2x * qx + e2y * qy + e2z * qz) * invDet;
    return Number.isFinite(distance) && distance >= 0.0 && distance <= maxDistance ? distance : null;
}

export class CollisionWorld {
    constructor(app) {
        this.app = app;
        this.manifest = null;
        this.blockers = [];
        this.ybnGround = null;
        this.ybnGroundError = null;
        this.ybnGroundOffset = 0.0;
        this.movementBounds = null;
    }

    setMovementBounds(bounds = null) {
        const minX = Number(bounds?.minX);
        const minY = Number(bounds?.minY);
        const maxX = Number(bounds?.maxX);
        const maxY = Number(bounds?.maxY);
        this.movementBounds = [minX, minY, maxX, maxY].every(Number.isFinite) && maxX > minX && maxY > minY
            ? { minX, minY, maxX, maxY }
            : null;
    }

    async loadYbnGround(metaUrl = 'assets/collision/ybn_spawn.json') {
        this.ybnGround = null;
        this.ybnGroundError = null;
        try {
            const metaResponse = await fetch(metaUrl, { cache: 'no-store' });
            if (!metaResponse.ok) throw new Error(`YBN metadata request failed (${metaResponse.status})`);
            const meta = await metaResponse.json();
            const file = String(meta?.file || '').trim();
            if (!file) throw new Error('YBN metadata has no binary file');

            const dataUrl = new URL(file, new URL(metaUrl, window.location.href)).toString();
            const dataResponse = await fetch(dataUrl, { cache: 'no-store' });
            if (!dataResponse.ok) throw new Error(`YBN binary request failed (${dataResponse.status})`);
            const buffer = await dataResponse.arrayBuffer();
            if (buffer.byteLength < 16) throw new Error('YBN binary is truncated');

            const header = new DataView(buffer, 0, 16);
            const magic = String.fromCharCode(header.getUint8(0), header.getUint8(1), header.getUint8(2), header.getUint8(3));
            const version = header.getUint32(4, true);
            const vertexCount = header.getUint32(8, true);
            const indexCount = header.getUint32(12, true);
            const verticesBytes = vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT;
            const indicesOffset = 16 + verticesBytes;
            const expectedBytes = indicesOffset + indexCount * Uint32Array.BYTES_PER_ELEMENT;
            if (magic !== 'YBNC' || version !== 1 || indexCount % 3 !== 0 || buffer.byteLength < expectedBytes) {
                throw new Error('YBN binary header is invalid');
            }

            const vertices = new Float32Array(buffer, 16, vertexCount * 3);
            const indices = new Uint32Array(buffer, indicesOffset, indexCount);
            const bounds = meta?.bounds || {};
            const minX = Number(bounds.min_x);
            const minY = Number(bounds.min_y);
            const maxX = Number(bounds.max_x);
            const maxY = Number(bounds.max_y);
            if (![minX, minY, maxX, maxY].every(Number.isFinite) || maxX <= minX || maxY <= minY) {
                throw new Error('YBN metadata bounds are invalid');
            }

            const cellSize = 16.0;
            const grid = this._buildYbnGrid(vertices, indices, { minX, minY, maxX, maxY, cellSize });
            this.ybnGround = { meta, vertices, indices, minX, minY, maxX, maxY, cellSize, grid };
            return this.ybnGround;
        } catch (error) {
            this.ybnGround = null;
            this.ybnGroundError = String(error?.message || error || 'YBN ground load failed');
            console.warn('YBN ground collision unavailable:', error);
            return null;
        }
    }

    _buildYbnGrid(vertices, indices, { minX, minY, maxX, maxY, cellSize }) {
        const grid = new Map();
        const put = (gx, gy, triangleOffset) => {
            const key = `${gx}:${gy}`;
            let bucket = grid.get(key);
            if (!bucket) {
                bucket = [];
                grid.set(key, bucket);
            }
            bucket.push(triangleOffset);
        };
        const minGX = Math.floor(minX / cellSize);
        const minGY = Math.floor(minY / cellSize);
        const maxGX = Math.floor(maxX / cellSize);
        const maxGY = Math.floor(maxY / cellSize);

        for (let offset = 0; offset < indices.length; offset += 3) {
            const ia = indices[offset] * 3;
            const ib = indices[offset + 1] * 3;
            const ic = indices[offset + 2] * 3;
            const ax = vertices[ia], ay = vertices[ia + 1];
            const bx = vertices[ib], by = vertices[ib + 1];
            const cx = vertices[ic], cy = vertices[ic + 1];
            if (![ax, ay, bx, by, cx, cy].every(Number.isFinite)) continue;
            const area2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
            if (Math.abs(area2) < 1e-6) continue;
            const gx0 = Math.max(minGX, Math.floor(Math.min(ax, bx, cx) / cellSize));
            const gy0 = Math.max(minGY, Math.floor(Math.min(ay, by, cy) / cellSize));
            const gx1 = Math.min(maxGX, Math.floor(Math.max(ax, bx, cx) / cellSize));
            const gy1 = Math.min(maxGY, Math.floor(Math.max(ay, by, cy) / cellSize));
            for (let gy = gy0; gy <= gy1; gy++) {
                for (let gx = gx0; gx <= gx1; gx++) put(gx, gy, offset);
            }
        }
        return grid;
    }

    _getYbnGroundAtXY(x, y, zHint, maxRise = 1.5) {
        const world = this.ybnGround;
        if (!world || x < world.minX || x > world.maxX || y < world.minY || y > world.maxY) return null;
        const key = `${Math.floor(x / world.cellSize)}:${Math.floor(y / world.cellSize)}`;
        const candidates = world.grid.get(key);
        if (!candidates || candidates.length === 0) return null;

        const hint = Number(zHint);
        const ceiling = Number.isFinite(hint) ? hint + Math.max(0.1, Number(maxRise) || 1.5) : Number.POSITIVE_INFINITY;
        let bestZ = Number.NEGATIVE_INFINITY;
        for (const offset of candidates) {
            const ia = world.indices[offset] * 3;
            const ib = world.indices[offset + 1] * 3;
            const ic = world.indices[offset + 2] * 3;
            const ax = world.vertices[ia], ay = world.vertices[ia + 1], az = world.vertices[ia + 2];
            const bx = world.vertices[ib], by = world.vertices[ib + 1], bz = world.vertices[ib + 2];
            const cx = world.vertices[ic], cy = world.vertices[ic + 1], cz = world.vertices[ic + 2];
            const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
            if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-6) continue;
            const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / denominator;
            const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / denominator;
            const w = 1.0 - u - v;
            if (u < -1e-4 || v < -1e-4 || w < -1e-4) continue;
            const z = u * az + v * bz + w * cz;
            if (Number.isFinite(z) && z <= ceiling && z > bestZ) bestZ = z;
        }
        return Number.isFinite(bestZ) ? bestZ : null;
    }

    alignYbnToKnownSurface(x, y, surfaceZ) {
        const targetZ = Number(surfaceZ);
        const rawZ = this._getYbnGroundAtXY(Number(x), Number(y), targetZ, 5.0);
        if (!Number.isFinite(targetZ) || !Number.isFinite(rawZ)) return null;
        const offset = targetZ - rawZ;
        if (Math.abs(offset) > 5.0) return null;
        this.ybnGroundOffset = offset;
        return { rawZ, targetZ, offset };
    }

    setManifest(manifest) {
        this.manifest = manifest && typeof manifest === 'object' ? manifest : null;
        const raw = this.manifest?.collision?.blockers;
        this.blockers = Array.isArray(raw)
            ? raw
                .map((b) => ({
                    id: String(b.id || b.label || 'blocker'),
                    type: String(b.type || 'circle'),
                    label: String(b.label || b.id || 'blocker'),
                    x: finite(b.x, NaN),
                    y: finite(b.y, NaN),
                    z: finite(b.z, NaN),
                    radius: Math.max(0.1, finite(b.radius, 0.8)),
                    height: Math.max(0.1, finite(b.height, 2.2)),
                }))
                .filter((b) => Number.isFinite(b.x) && Number.isFinite(b.y))
            : [];
    }

    resolveGround(x, y, zHint = NaN, {
        preferInterior = true,
        maxSnapDistance = 35.0,
        applyYbnCalibration = true,
    } = {}) {
        const app = this.app;
        // A bounded demo ships an explicit YBN collision mesh. Rendered
        // drawables can contain overlapping visual floors, so they must not
        // replace that authored collision surface while the demo is active.
        const ybnOnly = app?.spawnDistrictDemo === true;
        const rawTerrainZ = app?.terrainRenderer?.getHeightAtXY?.(x, y);
        const groundEnabled = app?.groundPedToTerrain === true;
        const rawYbnZ = groundEnabled ? this._getYbnGroundAtXY(x, y, zHint, 1.5) : null;
        const ybnOffset = applyYbnCalibration ? (Number(this.ybnGroundOffset) || 0.0) : 0.0;
        const ybnZ = Number.isFinite(rawYbnZ) ? Number(rawYbnZ) + ybnOffset : null;
        let bestZ = Number.isFinite(ybnZ) ? Number(ybnZ) : null;
        let source = Number.isFinite(ybnZ) ? 'ybn' : 'none';
        let interior = null;

        if (preferInterior && !ybnOnly) {
            try {
                const hint = Number.isFinite(Number(zHint))
                    ? Number(zHint)
                    : (bestZ !== null ? bestZ : 0.0);
                interior = app?.drawableStreamer?.getInteriorFloorAtDataPos?.([x, y, hint], {
                    zPadBelow: 14.0,
                    zPadAbove: 8.0,
                    maxRaise: app?.groundPedMaxDelta ?? maxSnapDistance,
                }) || null;
            } catch {
                interior = null;
            }
            if (interior && Number.isFinite(Number(interior.floorZ))) {
                const floorZ = Number(interior.floorZ);
                const closeToHint = Number.isFinite(hint)
                    ? Math.abs(floorZ - hint) <= Math.max(2.0, maxSnapDistance)
                    : true;
                if (interior.inRoom || closeToHint || bestZ === null || floorZ > bestZ) {
                    bestZ = floorZ;
                    source = 'interior';
                }
            }
        }

        if (bestZ === null) {
            const hint = Number(zHint);
            if (Number.isFinite(hint)) {
                bestZ = hint;
                source = 'runtime';
            } else {
                bestZ = 0.0;
            }
        }

        return {
            z: bestZ,
            source,
            terrainZ: Number.isFinite(rawTerrainZ) ? Number(rawTerrainZ) : null,
            calibratedTerrainZ: null,
            ybnZ: Number.isFinite(ybnZ) ? Number(ybnZ) : null,
            rawYbnZ: Number.isFinite(rawYbnZ) ? Number(rawYbnZ) : null,
            ybnCalibrationOffset: ybnOffset,
            surfacePolicy: ybnOnly ? 'aligned_ybn' : 'aligned_ybn_then_drawable_floor',
            interiorFloorZ: interior && Number.isFinite(Number(interior.floorZ)) ? Number(interior.floorZ) : null,
            interior,
        };
    }

    raycast({ origin, direction, maxDistance = 90.0 } = {}) {
        if (!Array.isArray(origin) || !Array.isArray(direction) || origin.length < 3 || direction.length < 3) return null;
        const ox = Number(origin[0]); const oy = Number(origin[1]); const oz = Number(origin[2]);
        const dx = Number(direction[0]); const dy = Number(direction[1]); const dz = Number(direction[2]);
        const distanceLimit = Math.max(0.1, Math.min(500.0, finite(maxDistance, 90.0)));
        const len = Math.hypot(dx, dy, dz);
        if (![ox, oy, oz, len].every(Number.isFinite) || len < 1e-6) return null;
        const unit = [dx / len, dy / len, dz / len];
        let hit = this._raycastYbn([ox, oy, oz], unit, distanceLimit);

        // Gameplay manifests can supply simple dynamic blockers (doors, props) even
        // when their full YBN triangle data has not been exported.
        for (const blocker of this.blockers) {
            const centerZ = Number.isFinite(blocker.z) ? blocker.z + blocker.height * 0.5 : oz;
            const radius = Math.hypot(blocker.radius, blocker.height * 0.5);
            const toX = blocker.x - ox; const toY = blocker.y - oy; const toZ = centerZ - oz;
            const along = toX * unit[0] + toY * unit[1] + toZ * unit[2];
            if (along < 0.0 || along > distanceLimit || (hit && along >= hit.distance)) continue;
            const closestX = ox + unit[0] * along;
            const closestY = oy + unit[1] * along;
            const closestZ = oz + unit[2] * along;
            if (Math.hypot(blocker.x - closestX, blocker.y - closestY, centerZ - closestZ) > radius) continue;
            hit = {
                distance: along,
                point: [closestX, closestY, closestZ],
                source: 'blocker',
                label: blocker.label || blocker.id || 'blocker',
            };
        }
        return hit;
    }

    _raycastYbn(origin, direction, maxDistance) {
        const world = this.ybnGround;
        if (!world?.grid || !world?.vertices || !world?.indices) return null;
        const endX = origin[0] + direction[0] * maxDistance;
        const endY = origin[1] + direction[1] * maxDistance;
        const minGX = Math.max(Math.floor(world.minX / world.cellSize), Math.floor(Math.min(origin[0], endX) / world.cellSize));
        const maxGX = Math.min(Math.floor(world.maxX / world.cellSize), Math.floor(Math.max(origin[0], endX) / world.cellSize));
        const minGY = Math.max(Math.floor(world.minY / world.cellSize), Math.floor(Math.min(origin[1], endY) / world.cellSize));
        const maxGY = Math.min(Math.floor(world.maxY / world.cellSize), Math.floor(Math.max(origin[1], endY) / world.cellSize));
        if (minGX > maxGX || minGY > maxGY) return null;

        let bestDistance = Number.POSITIVE_INFINITY;
        const tested = new Set();
        const offsetZ = Number(world && this.ybnGroundOffset) || 0.0;
        for (let gy = minGY; gy <= maxGY; gy++) {
            for (let gx = minGX; gx <= maxGX; gx++) {
                const candidates = world.grid.get(`${gx}:${gy}`);
                if (!candidates) continue;
                for (const offset of candidates) {
                    if (tested.has(offset)) continue;
                    tested.add(offset);
                    const ia = world.indices[offset] * 3;
                    const ib = world.indices[offset + 1] * 3;
                    const ic = world.indices[offset + 2] * 3;
                    const distance = rayTriangleDistance(
                        origin,
                        direction,
                        Math.min(maxDistance, bestDistance),
                        world.vertices[ia], world.vertices[ia + 1], world.vertices[ia + 2] + offsetZ,
                        world.vertices[ib], world.vertices[ib + 1], world.vertices[ib + 2] + offsetZ,
                        world.vertices[ic], world.vertices[ic + 1], world.vertices[ic + 2] + offsetZ,
                    );
                    if (distance !== null) bestDistance = distance;
                }
            }
        }
        if (!Number.isFinite(bestDistance)) return null;
        return {
            distance: bestDistance,
            point: [
                origin[0] + direction[0] * bestDistance,
                origin[1] + direction[1] * bestDistance,
                origin[2] + direction[2] * bestDistance,
            ],
            source: 'ybn',
            label: 'collision',
        };
    }

    moveCapsule({
        x,
        y,
        feetZ,
        vx,
        vy,
        dt,
        radius = 0.38,
        maxStepUp = 1.15,
        maxSnapDistance = 35.0,
        applyYbnCalibration = true,
    } = {}) {
        const groundOptions = { maxSnapDistance, applyYbnCalibration };
        const oldGround = this.resolveGround(x, y, feetZ, groundOptions);
        const rawTx = finite(x) + finite(vx) * Math.max(0.0, finite(dt));
        const rawTy = finite(y) + finite(vy) * Math.max(0.0, finite(dt));
        const bounds = this.movementBounds;
        const tx = bounds ? Math.max(bounds.minX, Math.min(bounds.maxX, rawTx)) : rawTx;
        const ty = bounds ? Math.max(bounds.minY, Math.min(bounds.maxY, rawTy)) : rawTy;
        const hitDistrictBoundary = tx !== rawTx || ty !== rawTy;
        const targetGround = this.resolveGround(tx, ty, feetZ, groundOptions);

        const stepDelta = targetGround.z - oldGround.z;
        if (Number.isFinite(stepDelta) && stepDelta > maxStepUp) {
            return {
                x,
                y,
                ground: oldGround,
                blocked: true,
                reason: 'step',
                vx: finite(vx) * 0.15,
                vy: finite(vy) * 0.15,
            };
        }

        if (hitDistrictBoundary) {
            return {
                x: tx,
                y: ty,
                ground: targetGround,
                blocked: true,
                reason: 'district_boundary',
                vx: tx === rawTx ? finite(vx) : 0.0,
                vy: ty === rawTy ? finite(vy) : 0.0,
            };
        }

        const hit = this._firstBlockerHit(tx, ty, feetZ, radius);
        if (!hit) {
            return {
                x: tx,
                y: ty,
                ground: targetGround,
                blocked: false,
                reason: '',
                vx: finite(vx),
                vy: finite(vy),
            };
        }

        const tryXGround = this.resolveGround(tx, y, feetZ, groundOptions);
        const hitX = this._firstBlockerHit(tx, y, feetZ, radius);
        if (!hitX && tryXGround.z - oldGround.z <= maxStepUp) {
            return {
                x: tx,
                y,
                ground: tryXGround,
                blocked: true,
                reason: 'slide_y',
                vx: finite(vx),
                vy: 0.0,
            };
        }

        const tryYGround = this.resolveGround(x, ty, feetZ, groundOptions);
        const hitY = this._firstBlockerHit(x, ty, feetZ, radius);
        if (!hitY && tryYGround.z - oldGround.z <= maxStepUp) {
            return {
                x,
                y: ty,
                ground: tryYGround,
                blocked: true,
                reason: 'slide_x',
                vx: 0.0,
                vy: finite(vy),
            };
        }

        return {
            x,
            y,
            ground: oldGround,
            blocked: true,
            reason: hit.label || 'blocker',
            vx: finite(vx) * 0.10,
            vy: finite(vy) * 0.10,
        };
    }

    _firstBlockerHit(x, y, feetZ, radius) {
        const z = Number(feetZ);
        for (const b of this.blockers) {
            if (Number.isFinite(b.z) && Number.isFinite(z)) {
                const minZ = b.z - 0.25;
                const maxZ = b.z + b.height;
                if (z > maxZ || z + 1.8 < minZ) continue;
            }
            const r = finite(radius, 0.38) + finite(b.radius, 0.8);
            if (dist2xy(b.x, b.y, x, y) <= r * r) return b;
        }
        return null;
    }
}

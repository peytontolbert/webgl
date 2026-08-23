import { fetchArrayBufferPreferredCompressed } from '../asset_fetcher.js';

function finite(n, fallback = 0.0) {
    const v = Number(n);
    return Number.isFinite(v) ? v : fallback;
}

function dist2xy(a, b, x, y) {
    const dx = finite(a) - finite(x);
    const dy = finite(b) - finite(y);
    return dx * dx + dy * dy;
}

function closestPointOnTriangle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, out) {
    const abx = bx - ax; const aby = by - ay; const abz = bz - az;
    const acx = cx - ax; const acy = cy - ay; const acz = cz - az;
    const apx = px - ax; const apy = py - ay; const apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0.0 && d2 <= 0.0) { out[0] = ax; out[1] = ay; out[2] = az; return; }

    const bpx = px - bx; const bpy = py - by; const bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0.0 && d4 <= d3) { out[0] = bx; out[1] = by; out[2] = bz; return; }

    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0) {
        const v = d1 / (d1 - d3);
        out[0] = ax + abx * v; out[1] = ay + aby * v; out[2] = az + abz * v;
        return;
    }

    const cpx = px - cx; const cpy = py - cy; const cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0.0 && d5 <= d6) { out[0] = cx; out[1] = cy; out[2] = cz; return; }

    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0) {
        const w = d2 / (d2 - d6);
        out[0] = ax + acx * w; out[1] = ay + acy * w; out[2] = az + acz * w;
        return;
    }

    const va = d3 * d6 - d5 * d4;
    if (va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0) {
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        out[0] = bx + (cx - bx) * w; out[1] = by + (cy - by) * w; out[2] = bz + (cz - bz) * w;
        return;
    }

    const denom = 1.0 / Math.max(1e-12, va + vb + vc);
    const v = vb * denom;
    const w = vc * denom;
    out[0] = ax + abx * v + acx * w;
    out[1] = ay + aby * v + acy * w;
    out[2] = az + abz * v + acz * w;
}

function closestSegmentSegment(p1x, p1y, p1z, q1x, q1y, q1z, p2x, p2y, p2z, q2x, q2y, q2z, out) {
    const d1x = q1x - p1x; const d1y = q1y - p1y; const d1z = q1z - p1z;
    const d2x = q2x - p2x; const d2y = q2y - p2y; const d2z = q2z - p2z;
    const rx = p1x - p2x; const ry = p1y - p2y; const rz = p1z - p2z;
    const a = d1x * d1x + d1y * d1y + d1z * d1z;
    const e = d2x * d2x + d2y * d2y + d2z * d2z;
    const f = d2x * rx + d2y * ry + d2z * rz;
    let s = 0.0; let t = 0.0;
    if (a <= 1e-12 && e <= 1e-12) {
        s = 0.0; t = 0.0;
    } else if (a <= 1e-12) {
        t = Math.max(0.0, Math.min(1.0, f / e));
    } else {
        const c = d1x * rx + d1y * ry + d1z * rz;
        if (e <= 1e-12) {
            s = Math.max(0.0, Math.min(1.0, -c / a));
        } else {
            const b = d1x * d2x + d1y * d2y + d1z * d2z;
            const denom = a * e - b * b;
            if (Math.abs(denom) > 1e-12) s = Math.max(0.0, Math.min(1.0, (b * f - c * e) / denom));
            t = (b * s + f) / e;
            if (t < 0.0) { t = 0.0; s = Math.max(0.0, Math.min(1.0, -c / a)); }
            else if (t > 1.0) { t = 1.0; s = Math.max(0.0, Math.min(1.0, (b - c) / a)); }
        }
    }
    out[0] = p1x + d1x * s; out[1] = p1y + d1y * s; out[2] = p1z + d1z * s;
    out[3] = p2x + d2x * t; out[4] = p2y + d2y * t; out[5] = p2z + d2z * t;
}

function segmentIntersectsTriangle(px, py, pz, qx, qy, qz, ax, ay, az, bx, by, bz, cx, cy, cz, out) {
    const dx = qx - px; const dy = qy - py; const dz = qz - pz;
    const e1x = bx - ax; const e1y = by - ay; const e1z = bz - az;
    const e2x = cx - ax; const e2y = cy - ay; const e2z = cz - az;
    const hx = dy * e2z - dz * e2y;
    const hy = dz * e2x - dx * e2z;
    const hz = dx * e2y - dy * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(det) < 1e-10) return false;
    const inv = 1.0 / det;
    const sx = px - ax; const sy = py - ay; const sz = pz - az;
    const u = (sx * hx + sy * hy + sz * hz) * inv;
    if (u < 0.0 || u > 1.0) return false;
    const rx = sy * e1z - sz * e1y;
    const ry = sz * e1x - sx * e1z;
    const rz = sx * e1y - sy * e1x;
    const v = (dx * rx + dy * ry + dz * rz) * inv;
    if (v < 0.0 || u + v > 1.0) return false;
    const t = (e2x * rx + e2y * ry + e2z * rz) * inv;
    if (t < 0.0 || t > 1.0) return false;
    out[0] = px + dx * t; out[1] = py + dy * t; out[2] = pz + dz * t;
    return true;
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
        this._blockerGrid = new Map();
        this._blockerCellSize = 8.0;
        this._destructibleGrid = new Map();
        this._destructibleCellSize = 12.0;
        this.ybnGround = null;
        this.ybnGroundError = null;
        this.compiledStaticCollision = null;
        this.compiledStaticCollisionError = null;
        this.compiledAssetColliders = null;
        this.ybnGroundOffset = 0.0;
        this.derivedRoads = [];
        this.derivedRoadError = null;
        this.derivedTrackGround = null;
        this.derivedTrackGroundError = null;
        this.derivedTrackTranslation = [0, 0, 0];
        this.worldExtensionLayout = null;
        this.movementBounds = null;
        this._triangleClosest = new Float64Array(3);
        this._segmentClosest = new Float64Array(6);
        this._triangleIntersection = new Float64Array(3);
        this._drawableCollisionGrid = new Map();
        this._drawableCollisionCellSize = 8.0;
        this._drawableCollisionRefreshAt = 0.0;
        this.drawableCollisionProxyCount = 0;
        this._assetColliderGrid = new Map();
        this._assetColliderCellSize = 8.0;
        this._assetColliders = [];
        this._assetCollidersById = new Map();
        this.assetColliderCount = 0;
        // Kept for the in-game diagnostics panel.  This is intentionally the
        // authored collider/YBN hit rather than a render proxy so an invisible
        // blocker can be identified by its exact source and coordinates.
        this.lastVehicleCollision = null;
        this.ybnCollisionExclusions = [];
        // Matrix Universe packages can own a terrain datum independently of a
        // reference export. These surfaces are explicit city data, not a
        // rendering proxy, and therefore participate in player and vehicle
        // ground resolution.
        this.authoredCityGround = [];
        // Drawable bounds are a rendering aid, not authoritative GTA collision.
        // Keeping them out of normal movement avoids turning every streamed sign,
        // decal, or LOD proxy into a solid wall as it becomes resident.
        this.useDrawableCollisionProxies = false;
        this.destructibles = new Map();
        this.destroyedDestructibleIds = new Set();
        this.destructibleDamage = new Map();
        this.doorDefinitions = new Map();
        this.doorOpenProgress = new Map();
        this._dynamicDoorColliderGrid = new Map();
        this._dynamicDoorColliderCellSize = 4.0;
        this._dynamicDoorCollidersDirty = true;
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

    setAuthoredCityGround(surfaces) {
        this.authoredCityGround = (Array.isArray(surfaces) ? surfaces : []).map((surface, index) => {
            const minX = finite(surface?.minX, NaN); const minY = finite(surface?.minY, NaN);
            const maxX = finite(surface?.maxX, NaN); const maxY = finite(surface?.maxY, NaN); const z = finite(surface?.z, NaN);
            if (![minX, minY, maxX, maxY, z].every(Number.isFinite) || maxX <= minX || maxY <= minY) return null;
            return { id: String(surface?.id || `matrix-ground:${index}`), minX, minY, maxX, maxY, z, material: String(surface?.surface || 'asphalt') };
        }).filter(Boolean);
        return this.authoredCityGround.length;
    }

    _getAuthoredCityGroundAtXY(x, y) {
        const px = finite(x, NaN); const py = finite(y, NaN);
        if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
        return this.authoredCityGround.find((surface) => px >= surface.minX && px <= surface.maxX && py >= surface.minY && py <= surface.maxY) || null;
    }

    setYbnCollisionExclusions(records) {
        this.ybnCollisionExclusions = (Array.isArray(records) ? records : []).map((record) => {
            const minX = Number(record?.minX); const minY = Number(record?.minY); const minZ = Number(record?.minZ);
            const maxX = Number(record?.maxX); const maxY = Number(record?.maxY); const maxZ = Number(record?.maxZ);
            if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) return null;
            if (maxX <= minX || maxY <= minY || maxZ <= minZ) return null;
            return { id: String(record?.id || ''), minX, minY, minZ, maxX, maxY, maxZ };
        }).filter(Boolean);
        return this.ybnCollisionExclusions.length;
    }

    _isYbnCollisionExcluded(ax, ay, az, bx, by, bz, cx, cy, cz) {
        if (!this.ybnCollisionExclusions.length) return false;
        const x = (ax + bx + cx) / 3.0;
        const y = (ay + by + cy) / 3.0;
        const z = (az + bz + cz) / 3.0;
        return this.ybnCollisionExclusions.some((bounds) => (
            x >= bounds.minX && x <= bounds.maxX
            && y >= bounds.minY && y <= bounds.maxY
            && z >= bounds.minZ && z <= bounds.maxZ
        ));
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
            // Production deployments package collision binaries as `.gz` only.
            // This helper falls back to the raw path for old/dev deployments.
            const buffer = await fetchArrayBufferPreferredCompressed(dataUrl, {
                usePersistentCache: false,
                priority: 'high',
            });
            if (buffer.byteLength < 16) throw new Error('YBN binary is truncated');

            const header = new DataView(buffer, 0, 16);
            const magic = String.fromCharCode(header.getUint8(0), header.getUint8(1), header.getUint8(2), header.getUint8(3));
            const version = header.getUint32(4, true);
            const vertexCount = header.getUint32(8, true);
            const indexCount = header.getUint32(12, true);
            if (magic !== 'YBNC' || ![1, 2, 3, 4].includes(version) || indexCount % 3 !== 0) {
                throw new Error('YBN binary header is invalid');
            }

            let payloadOffset = 16;
            let packedGrid = null;
            if (version >= 2) {
                const packedHeaderBytes = version >= 3 ? 28 : 24;
                if (buffer.byteLength < 16 + packedHeaderBytes) throw new Error(`YBN v${version} header is truncated`);
                const v2 = new DataView(buffer, 16, packedHeaderBytes);
                packedGrid = {
                    cellSize: v2.getFloat32(0, true),
                    minGX: v2.getInt32(4, true),
                    minGY: v2.getInt32(8, true),
                    width: v2.getUint32(12, true),
                    height: v2.getUint32(16, true),
                    referenceCount: v2.getUint32(20, true),
                    wallReferenceCount: version >= 3 ? v2.getUint32(24, true) : 0,
                };
                payloadOffset = 16 + packedHeaderBytes;
            }
            const verticesBytes = vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT;
            const indicesOffset = payloadOffset + verticesBytes;
            const gridOffsetsOffset = indicesOffset + indexCount * Uint32Array.BYTES_PER_ELEMENT;
            const gridCellCount = packedGrid ? packedGrid.width * packedGrid.height : 0;
            const gridReferencesOffset = gridOffsetsOffset + (gridCellCount + 1) * Uint32Array.BYTES_PER_ELEMENT;
            const wallGridOffsetsOffset = gridReferencesOffset + (packedGrid?.referenceCount || 0) * Uint32Array.BYTES_PER_ELEMENT;
            const wallGridReferencesOffset = wallGridOffsetsOffset + (gridCellCount + 1) * Uint32Array.BYTES_PER_ELEMENT;
            const baseExpectedBytes = packedGrid
                ? (version >= 3
                    ? wallGridReferencesOffset + packedGrid.wallReferenceCount * Uint32Array.BYTES_PER_ELEMENT
                    : gridReferencesOffset + packedGrid.referenceCount * Uint32Array.BYTES_PER_ELEMENT)
                : gridOffsetsOffset;
            const triangleMaterialOffset = baseExpectedBytes;
            const expectedBytes = baseExpectedBytes + (version >= 4 ? (indexCount / 3) * Uint16Array.BYTES_PER_ELEMENT : 0);
            if (buffer.byteLength < expectedBytes) throw new Error('YBN binary is truncated');

            const vertices = new Float32Array(buffer, payloadOffset, vertexCount * 3);
            const indices = new Uint32Array(buffer, indicesOffset, indexCount);
            const triangleMaterials = version >= 4
                ? new Uint16Array(buffer, triangleMaterialOffset, indexCount / 3)
                : null;
            const bounds = meta?.bounds || {};
            const minX = Number(bounds.min_x);
            const minY = Number(bounds.min_y);
            const maxX = Number(bounds.max_x);
            const maxY = Number(bounds.max_y);
            if (![minX, minY, maxX, maxY].every(Number.isFinite) || maxX <= minX || maxY <= minY) {
                throw new Error('YBN metadata bounds are invalid');
            }

            const cellSize = packedGrid?.cellSize || 16.0;
            if (!Number.isFinite(cellSize) || cellSize <= 0) throw new Error('YBN grid cell size is invalid');
            const grid = packedGrid
                ? {
                    ...packedGrid,
                    cellOffsets: new Uint32Array(buffer, gridOffsetsOffset, gridCellCount + 1),
                    triangleOffsets: new Uint32Array(buffer, gridReferencesOffset, packedGrid.referenceCount),
                }
                : this._buildYbnGrid(vertices, indices, { minX, minY, maxX, maxY, cellSize });
            const wallGrid = version >= 3
                ? {
                    ...packedGrid,
                    cellOffsets: new Uint32Array(buffer, wallGridOffsetsOffset, gridCellCount + 1),
                    triangleOffsets: new Uint32Array(buffer, wallGridReferencesOffset, packedGrid.wallReferenceCount),
                    triangleCount: Number(meta?.wall_triangle_count) || 0,
                }
                : this._buildYbnWallGrid(vertices, indices, { minX, minY, maxX, maxY, cellSize });
            this.ybnGround = {
                meta, vertices, indices, triangleMaterials,
                materialPalette: Array.isArray(meta?.surface_materials) ? meta.surface_materials : [],
                minX, minY, maxX, maxY, cellSize, grid, wallGrid,
            };
            return this.ybnGround;
        } catch (error) {
            this.ybnGround = null;
            this.ybnGroundError = String(error?.message || error || 'YBN ground load failed');
            console.warn('YBN ground collision unavailable:', error);
            return null;
        }
    }

    async loadCompiledStaticCollision(manifestUrl) {
        // This is deliberately a separate, opt-in path.  A descriptor selecting
        // it must have a complete package: we do not silently fetch YBNC when a
        // compiled chunk is missing, because that masks broken deployments and
        // defeats the streaming budget.
        this.ybnGround = null;
        this.ybnGroundError = null;
        this.compiledStaticCollision = null;
        this.compiledStaticCollisionError = null;
        try {
            const response = await fetch(manifestUrl, { cache: 'no-store' });
            if (!response.ok) throw new Error(`Compiled collision manifest request failed (${response.status})`);
            const manifest = await response.json();
            if (manifest?.schema !== 'webglgta-static-collision-v1' || !manifest?.chunks || !manifest?.geometry_bounds) {
                throw new Error('Compiled collision manifest is invalid');
            }
            const bounds = manifest.bounds || {};
            const geometry = manifest.geometry_bounds || {};
            const minX = Number(bounds.min_x); const minY = Number(bounds.min_y);
            const maxX = Number(bounds.max_x); const maxY = Number(bounds.max_y);
            const minGX = Number(geometry.min_x); const minGY = Number(geometry.min_y); const minGZ = Number(geometry.min_z);
            const maxGX = Number(geometry.max_x); const maxGY = Number(geometry.max_y); const maxGZ = Number(geometry.max_z);
            const chunkSize = Number(manifest.chunk_size);
            const cellSize = Number(manifest.broadphase_cell_size);
            if (![minX, minY, maxX, maxY, minGX, minGY, minGZ, maxGX, maxGY, maxGZ, chunkSize, cellSize].every(Number.isFinite)
                || maxX <= minX || maxY <= minY || maxGX <= minGX || maxGY <= minGY || maxGZ <= minGZ
                || chunkSize <= 0 || cellSize <= 0) throw new Error('Compiled collision bounds are invalid');
            const normalizedChunks = {};
            for (const [id, entry] of Object.entries(manifest.chunks)) {
                const [gx, gy] = id.split(':').map(Number);
                if (!Number.isInteger(gx) || !Number.isInteger(gy) || !entry?.file) throw new Error(`Compiled collision manifest has an invalid chunk key (${id})`);
                normalizedChunks[id] = { ...entry, gx, gy };
            }
            manifest.chunks = normalizedChunks;
            this.compiledStaticCollision = {
                manifestUrl,
                manifest,
                chunkBaseUrl: new URL('.', new URL(manifestUrl, window.location.href)).toString(),
                chunks: new Map(),
                loading: new Map(),
                chunkSize,
                cellSize,
                maxResidentChunks: 144,
                geometry: { minX: minGX, minY: minGY, minZ: minGZ, maxX: maxGX, maxY: maxGY, maxZ: maxGZ },
            };
            this.ybnGround = {
                meta: manifest,
                vertices: new Float32Array(0), indices: new Uint32Array(0), triangleMaterials: new Uint16Array(0),
                materialPalette: Array.isArray(manifest.surface_materials) ? manifest.surface_materials : [],
                minX, minY, maxX, maxY, cellSize,
                grid: new Map(), wallGrid: { cells: new Map(), triangleCount: 0 },
            };
            return this.compiledStaticCollision;
        } catch (error) {
            this.ybnGround = null;
            this.compiledStaticCollision = null;
            this.compiledStaticCollisionError = String(error?.message || error || 'Compiled collision load failed');
            console.error('Compiled static collision unavailable:', error);
            throw error;
        }
    }

    _decodeCompiledCollisionChunk(buffer, entry, compiled) {
        const headerBytes = 32;
        const extraBytes = 16;
        if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < headerBytes + extraBytes) throw new Error(`Compiled chunk ${entry.file} is truncated`);
        const view = new DataView(buffer);
        const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
        const version = view.getUint32(4, true); const flags = view.getUint32(8, true);
        const vertexCount = view.getUint32(12, true); const triangleCount = view.getUint32(16, true);
        const groundCount = view.getUint32(20, true); const wallCount = view.getUint32(24, true); const cellCount = view.getUint32(28, true);
        if (magic !== 'CWCT' || version !== 4 || (flags & ~3) || !vertexCount || !triangleCount || !cellCount) {
            throw new Error(`Compiled chunk ${entry.file} has an invalid header`);
        }
        const minZ = view.getFloat32(32, true); const maxZ = view.getFloat32(36, true); const actualCellSize = view.getFloat32(40, true);
        if (![minZ, maxZ, actualCellSize].every(Number.isFinite) || maxZ <= minZ || actualCellSize <= 0) throw new Error(`Compiled chunk ${entry.file} has invalid bounds`);
        const indexBytes = flags & 1 ? 4 : 2; const refBytes = flags & 2 ? 4 : 2;
        let offset = headerBytes + extraBytes;
        const need = (count, bytes) => { const start = offset; offset += count * bytes; if (offset > buffer.byteLength) throw new Error(`Compiled chunk ${entry.file} is truncated`); return start; };
        const verticesOffset = need(vertexCount * 3, 2);
        const indicesOffset = need(triangleCount * 3, indexBytes);
        const materialsOffset = need(triangleCount, 2);
        const groundOffsetsOffset = need(cellCount + 1, 4);
        const groundRefsOffset = need(groundCount, refBytes);
        const wallOffsetsOffset = need(cellCount + 1, 4);
        const wallRefsOffset = need(wallCount, refBytes);
        if (offset !== buffer.byteLength) throw new Error(`Compiled chunk ${entry.file} has trailing or malformed data`);
        const readIndex = (at) => indexBytes === 4 ? view.getUint32(at, true) : view.getUint16(at, true);
        const readRef = (at) => refBytes === 4 ? view.getUint32(at, true) : view.getUint16(at, true);
        const bounds = entry?.bounds || {};
        const chunkMinX = Number(bounds.min_x); const chunkMinY = Number(bounds.min_y);
        if (![chunkMinX, chunkMinY].every(Number.isFinite)) throw new Error(`Compiled chunk ${entry.file} has no manifest bounds`);
        const vertices = new Float32Array(vertexCount * 3);
        const sx = compiled.geometry.maxX - compiled.geometry.minX;
        const sy = compiled.geometry.maxY - compiled.geometry.minY;
        for (let i = 0; i < vertexCount; i++) {
            vertices[i * 3] = compiled.geometry.minX + view.getUint16(verticesOffset + i * 6, true) / 65535 * sx;
            vertices[i * 3 + 1] = compiled.geometry.minY + view.getUint16(verticesOffset + i * 6 + 2, true) / 65535 * sy;
            vertices[i * 3 + 2] = minZ + view.getUint16(verticesOffset + i * 6 + 4, true) / 65535 * (maxZ - minZ);
        }
        const indices = new Uint32Array(triangleCount * 3);
        for (let i = 0; i < indices.length; i++) { indices[i] = readIndex(indicesOffset + i * indexBytes); if (indices[i] >= vertexCount) throw new Error(`Compiled chunk ${entry.file} has an invalid index`); }
        const materials = new Uint16Array(triangleCount);
        for (let i = 0; i < triangleCount; i++) materials[i] = view.getUint16(materialsOffset + i * 2, true);
        const readCells = (offsetsOffset, refsOffset, count) => {
            const cells = [];
            for (let cell = 0; cell < cellCount; cell++) {
                const start = view.getUint32(offsetsOffset + cell * 4, true); const end = view.getUint32(offsetsOffset + (cell + 1) * 4, true);
                if (end < start || end > count) throw new Error(`Compiled chunk ${entry.file} has invalid cell references`);
                if (!end) { cells.push(null); continue; }
                const refs = new Uint32Array(end - start);
                for (let ref = start; ref < end; ref++) { const triangle = readRef(refsOffset + ref * refBytes); if (triangle >= triangleCount) throw new Error(`Compiled chunk ${entry.file} has an invalid triangle reference`); refs[ref - start] = triangle; }
                cells.push(refs);
            }
            return cells;
        };
        return { id: `${entry.gx}:${entry.gy}`, entry, vertices, indices, materials, actualCellSize,
            cellsPerSide: Math.sqrt(cellCount), groundCells: readCells(groundOffsetsOffset, groundRefsOffset, groundCount), wallCells: readCells(wallOffsetsOffset, wallRefsOffset, wallCount),
            minGX: Math.floor(chunkMinX / actualCellSize), minGY: Math.floor(chunkMinY / actualCellSize) };
    }

    _rebuildCompiledCollisionWorld() {
        const compiled = this.compiledStaticCollision; const world = this.ybnGround;
        if (!compiled || !world) return;
        let vertexCount = 0; let indexCount = 0; let triangleCount = 0;
        for (const chunk of compiled.chunks.values()) { vertexCount += chunk.vertices.length / 3; indexCount += chunk.indices.length; triangleCount += chunk.materials.length; }
        const vertices = new Float32Array(vertexCount * 3); const indices = new Uint32Array(indexCount); const materials = new Uint16Array(triangleCount);
        const ground = new Map(); const walls = new Map(); let vertexBase = 0; let indexBase = 0; let triangleBase = 0;
        const appendCells = (target, cells, chunk, triangleOffset) => {
            for (let cell = 0; cell < cells.length; cell++) {
                const refs = cells[cell]; if (!refs?.length) continue;
                const gx = chunk.minGX + (cell % chunk.cellsPerSide); const gy = chunk.minGY + Math.floor(cell / chunk.cellsPerSide);
                const key = `${gx}:${gy}`; let values = target.get(key); if (!values) target.set(key, values = []);
                for (const ref of refs) values.push((triangleOffset + ref) * 3);
            }
        };
        for (const chunk of compiled.chunks.values()) {
            vertices.set(chunk.vertices, vertexBase * 3);
            for (let index = 0; index < chunk.indices.length; index++) indices[indexBase + index] = vertexBase + chunk.indices[index];
            materials.set(chunk.materials, triangleBase);
            appendCells(ground, chunk.groundCells, chunk, triangleBase); appendCells(walls, chunk.wallCells, chunk, triangleBase);
            vertexBase += chunk.vertices.length / 3; indexBase += chunk.indices.length; triangleBase += chunk.materials.length;
        }
        world.vertices = vertices; world.indices = indices; world.triangleMaterials = materials; world.grid = ground; world.wallGrid = { cells: walls, triangleCount };
    }

    async streamCompiledStaticCollisionAt(x, y, radius = 96.0) {
        const compiled = this.compiledStaticCollision;
        if (!compiled) throw new Error('Compiled static collision is not loaded');
        const px = Number(x); const py = Number(y); const range = Math.max(compiled.chunkSize, Number(radius) || 0);
        if (![px, py].every(Number.isFinite)) throw new Error('Compiled collision stream position is invalid');
        const gx0 = Math.floor((px - range) / compiled.chunkSize); const gx1 = Math.floor((px + range) / compiled.chunkSize);
        const gy0 = Math.floor((py - range) / compiled.chunkSize); const gy1 = Math.floor((py + range) / compiled.chunkSize);
        const wanted = [];
        for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
            const entry = compiled.manifest.chunks[`${gx}:${gy}`]; if (entry) wanted.push(entry);
        }
        await Promise.all(wanted.map(async (entry) => {
            const id = `${entry.gx}:${entry.gy}`;
            if (compiled.chunks.has(id)) return;
            let pending = compiled.loading.get(id);
            if (!pending) {
                const chunkUrl = new URL(entry.file, compiled.chunkBaseUrl).toString();
                pending = fetchArrayBufferPreferredCompressed(chunkUrl, {
                    usePersistentCache: true,
                    priority: 'high',
                })
                    .then((buffer) => this._decodeCompiledCollisionChunk(buffer, entry, compiled));
                compiled.loading.set(id, pending);
            }
            const chunk = await pending; compiled.loading.delete(id); compiled.chunks.set(id, chunk);
        }));
        // Keep the resident set bounded. Missing chunks are an explicit stream
        // failure for callers to surface, never a legacy YBN fallback.
        if (compiled.chunks.size > compiled.maxResidentChunks) {
            const entries = [...compiled.chunks.values()].sort((a, b) => {
                const da = Math.hypot((a.entry.gx + 0.5) * compiled.chunkSize - px, (a.entry.gy + 0.5) * compiled.chunkSize - py);
                const db = Math.hypot((b.entry.gx + 0.5) * compiled.chunkSize - px, (b.entry.gy + 0.5) * compiled.chunkSize - py);
                return db - da;
            });
            for (const entry of entries.slice(compiled.maxResidentChunks)) compiled.chunks.delete(entry.id);
        }
        this._rebuildCompiledCollisionWorld();
        return { residentChunks: compiled.chunks.size, loadedChunks: wanted.length };
    }

    async loadCompiledAssetColliders(manifestUrl) {
        const response = await fetch(manifestUrl, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Compiled asset collider manifest request failed (${response.status})`);
        const manifest = await response.json();
        if (manifest?.schema !== 'webglgta-compiled-asset-colliders-v1' || !Array.isArray(manifest?.chunks) || !manifest?.live_overlay) throw new Error('Compiled asset collider manifest is invalid');
        const baseUrl = new URL('.', new URL(manifestUrl, window.location.href)).toString();
        const liveResponse = await fetch(new URL(manifest.live_overlay, baseUrl), { cache: 'no-store' });
        if (!liveResponse.ok) throw new Error(`Compiled asset live overlay request failed (${liveResponse.status})`);
        const live = await liveResponse.json();
        this.setAssetColliders(live?.colliders);
        this.setYbnCollisionExclusions(live?.ybnCollisionExclusions);
        this.compiledAssetColliders = { manifest, baseUrl, chunks: new Set(), loading: new Map(), cellSize: Number(manifest.cell_size) };
        return this.compiledAssetColliders;
    }

    async loadCompiledCollisionLayers(manifestUrl) {
        const response = await fetch(manifestUrl, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Compiled collision layer manifest request failed (${response.status})`);
        const layers = await response.json();
        const base = new URL('.', new URL(manifestUrl, window.location.href)).toString();
        const ybnManifest = String(layers?.base_layer?.static_ybn?.manifest || '').trim();
        const assetManifest = String(layers?.base_layer?.asset_colliders?.manifest || '').trim();
        if (layers?.schema !== 'webglgta-compiled-collision-layers-v1' || !ybnManifest || !assetManifest) {
            throw new Error('Compiled collision layer manifest is invalid');
        }
        // A failure rejects startup.  The caller must surface it rather than
        // falling through to YBNC, so an opt-in descriptor is deterministic.
        await this.loadCompiledStaticCollision(new URL(ybnManifest, base).toString());
        await this.loadCompiledAssetColliders(new URL(assetManifest, base).toString());
        this.compiledCollisionLayers = layers;
        return layers;
    }

    async streamCompiledAssetCollidersAt(x, y, radius = 128.0) {
        const compiled = this.compiledAssetColliders;
        if (!compiled) throw new Error('Compiled asset colliders are not loaded');
        const cellSize = compiled.cellSize; const px = Number(x); const py = Number(y); const range = Math.max(cellSize, Number(radius) || 0);
        if (![cellSize, px, py].every(Number.isFinite) || cellSize <= 0) throw new Error('Compiled asset stream position is invalid');
        const byId = new Map(compiled.manifest.chunks.map((entry) => [`${entry.gx}:${entry.gy}`, entry]));
        const jobs = [];
        for (let gy = Math.floor((py - range) / cellSize); gy <= Math.floor((py + range) / cellSize); gy++) for (let gx = Math.floor((px - range) / cellSize); gx <= Math.floor((px + range) / cellSize); gx++) {
            const id = `${gx}:${gy}`; const entry = byId.get(id); if (!entry || compiled.chunks.has(id)) continue;
            let job = compiled.loading.get(id);
            if (!job) job = fetch(new URL(entry.file, compiled.baseUrl), { cache: 'force-cache' }).then((response) => { if (!response.ok) throw new Error(`Compiled asset chunk ${entry.file} request failed (${response.status})`); return response.json(); });
            compiled.loading.set(id, job); jobs.push(job.then((payload) => { compiled.loading.delete(id); compiled.chunks.add(id); this.setAssetColliders(payload?.colliders, { append: true }); }));
        }
        await Promise.all(jobs);
        return { residentChunks: compiled.chunks.size, colliderCount: this.assetColliderCount };
    }

    setDerivedTrackPlacement(layout = null) {
        const translation = Array.isArray(layout?.translation) ? layout.translation.slice(0, 3).map(Number) : [0, 0, 0];
        this.derivedTrackTranslation = translation.length === 3 && translation.every(Number.isFinite) ? translation : [0, 0, 0];
        this.worldExtensionLayout = layout || null;
        return this.derivedTrackTranslation.slice();
    }

    _translateDerivedTrackVertices(vertices) {
        const [dx, dy, dz] = this.derivedTrackTranslation;
        if (!(dx || dy || dz)) return vertices;
        for (let index = 0; index < vertices.length; index += 3) {
            vertices[index] += dx;
            vertices[index + 1] += dy;
            vertices[index + 2] += dz;
        }
        return vertices;
    }

    installWorldExtensionConnector(connector = this.worldExtensionLayout?.connector) {
        const start = Array.isArray(connector?.start) ? connector.start.slice(0, 3).map(Number) : null;
        const end = Array.isArray(connector?.end) ? connector.end.slice(0, 3).map(Number) : null;
        if (!start?.every(Number.isFinite) || !end?.every(Number.isFinite)) return null;
        const dx = end[0] - start[0]; const dy = end[1] - start[1]; const dz = end[2] - start[2];
        const length = Math.hypot(dx, dy);
        if (!(length > 1.0)) return null;
        const halfWidth = Math.max(3, Number(connector?.width) * 0.5 || 9);
        const nx = -dy / length; const ny = dx / length;
        const segmentCount = Math.max(1, Math.ceil(length / 32));
        const vertices = new Float32Array((segmentCount + 1) * 6);
        for (let segment = 0; segment <= segmentCount; segment++) {
            const t = segment / segmentCount;
            const cx = start[0] + dx * t; const cy = start[1] + dy * t; const cz = start[2] + dz * t;
            const base = segment * 6;
            vertices[base] = cx + nx * halfWidth; vertices[base + 1] = cy + ny * halfWidth; vertices[base + 2] = cz;
            vertices[base + 3] = cx - nx * halfWidth; vertices[base + 4] = cy - ny * halfWidth; vertices[base + 5] = cz;
        }
        const cellSize = 16.0;
        const grid = new Map();
        const put = (gx, gy, segment) => {
            const key = `${gx}:${gy}`;
            let bucket = grid.get(key);
            if (!bucket) grid.set(key, bucket = []);
            bucket.push(segment);
        };
        for (let segment = 0; segment < segmentCount; segment++) {
            const base = segment * 6; const next = base + 6;
            const xs = [vertices[base], vertices[base + 3], vertices[next], vertices[next + 3]];
            const ys = [vertices[base + 1], vertices[base + 4], vertices[next + 1], vertices[next + 4]];
            for (let gy = Math.floor(Math.min(...ys) / cellSize); gy <= Math.floor(Math.max(...ys) / cellSize); gy++) {
                for (let gx = Math.floor(Math.min(...xs) / cellSize); gx <= Math.floor(Math.max(...xs) / cellSize); gx++) put(gx, gy, segment);
            }
        }
        const road = {
            id: String(connector?.id || 'world-extension-connector'),
            meta: { surface: { name: String(connector?.surface || 'asphalt'), grip: 0.98 }, roadWidthM: halfWidth * 2, connector: true },
            vertices, segmentCount, cellSize, grid,
            minX: Math.min(start[0], end[0]) - halfWidth, minY: Math.min(start[1], end[1]) - halfWidth, minZ: Math.min(start[2], end[2]),
            maxX: Math.max(start[0], end[0]) + halfWidth, maxY: Math.max(start[1], end[1]) + halfWidth, maxZ: Math.max(start[2], end[2]),
        };
        this.derivedRoads = this.derivedRoads.filter((entry) => entry.id !== road.id);
        this.derivedRoads.push(road);
        return road;
    }

    async loadDerivedRoad(metaUrl = 'assets/tracks/nordschleife/road.json', { applyDerivedTrackPlacement = true } = {}) {
        this.derivedRoadError = null;
        try {
            const response = await fetch(metaUrl, { cache: 'no-store' });
            if (response.status === 404) return null; // Optional local-only package.
            if (!response.ok) throw new Error(`Derived road metadata request failed (${response.status})`);
            const meta = await response.json();
            if (meta?.schema !== 'webglgta-derived-road-v1' || !meta?.file) throw new Error('Derived road metadata is invalid');
            const dataUrl = new URL(String(meta.file), new URL(metaUrl, window.location.href)).toString();
            const dataResponse = await fetch(dataUrl, { cache: 'no-store' });
            if (!dataResponse.ok) throw new Error(`Derived road binary request failed (${dataResponse.status})`);
            const buffer = await dataResponse.arrayBuffer();
            if (buffer.byteLength < 44) throw new Error('Derived road binary is truncated');
            const header = new DataView(buffer, 0, 44);
            const magic = String.fromCharCode(header.getUint8(0), header.getUint8(1), header.getUint8(2), header.getUint8(3));
            const version = header.getUint32(4, true);
            const vertexCount = header.getUint32(8, true);
            const segmentCount = header.getUint32(12, true);
            if (magic !== 'NRB1' || version !== 1 || vertexCount !== (segmentCount + 1) * 2 || vertexCount < 4) throw new Error('Derived road binary header is invalid');
            const minimum = [header.getFloat32(20, true), header.getFloat32(24, true), header.getFloat32(28, true)];
            const span = [header.getFloat32(32, true), header.getFloat32(36, true), header.getFloat32(40, true)];
            const expected = 44 + vertexCount * 3 * Uint16Array.BYTES_PER_ELEMENT;
            if (![...minimum, ...span].every(Number.isFinite) || span.some((value) => value <= 0) || buffer.byteLength < expected) throw new Error('Derived road position payload is invalid');
            const packed = new Uint16Array(buffer, 44, vertexCount * 3);
            const vertices = new Float32Array(vertexCount * 3);
            for (let i = 0; i < vertices.length; i++) vertices[i] = minimum[i % 3] + (packed[i] / 65535.0) * span[i % 3];
            if (applyDerivedTrackPlacement) this._translateDerivedTrackVertices(vertices);
            const bounds = meta?.bounds || {};
            const [dx, dy, dz] = applyDerivedTrackPlacement ? this.derivedTrackTranslation : [0, 0, 0];
            const minX = Number(bounds.minX) + dx; const minY = Number(bounds.minY) + dy; const minZ = Number(bounds.minZ) + dz;
            const maxX = Number(bounds.maxX) + dx; const maxY = Number(bounds.maxY) + dy; const maxZ = Number(bounds.maxZ) + dz;
            if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite) || maxX <= minX || maxY <= minY || maxZ < minZ) throw new Error('Derived road metadata bounds are invalid');
            const cellSize = 16.0;
            const grid = new Map();
            const put = (gx, gy, segment) => {
                const key = `${gx}:${gy}`;
                let bucket = grid.get(key);
                if (!bucket) grid.set(key, bucket = []);
                bucket.push(segment);
            };
            for (let segment = 0; segment < segmentCount; segment++) {
                const base = segment * 6;
                const next = base + 6;
                const xs = [vertices[base], vertices[base + 3], vertices[next], vertices[next + 3]];
                const ys = [vertices[base + 1], vertices[base + 4], vertices[next + 1], vertices[next + 4]];
                const gx0 = Math.floor(Math.min(...xs) / cellSize); const gx1 = Math.floor(Math.max(...xs) / cellSize);
                const gy0 = Math.floor(Math.min(...ys) / cellSize); const gy1 = Math.floor(Math.max(...ys) / cellSize);
                for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) put(gx, gy, segment);
            }
            const placedMeta = { ...meta, bounds: { minX, minY, minZ, maxX, maxY, maxZ }, worldTranslation: this.derivedTrackTranslation.slice() };
            const road = { id: String(meta.id || 'derived-road'), meta: placedMeta, vertices, segmentCount, minX, minY, minZ, maxX, maxY, maxZ, cellSize, grid };
            this.derivedRoads = this.derivedRoads.filter((entry) => entry.id !== road.id);
            this.derivedRoads.push(road);
            return road;
        } catch (error) {
            this.derivedRoadError = String(error?.message || error || 'Derived road load failed');
            console.warn('Derived road collision unavailable:', error);
            return null;
        }
    }

    /**
     * Load original city-builder highway packages.  Unlike attached circuit
     * packages, these road coordinates already live in GTA data-space and
     * must never inherit the circuit's world-placement translation.
     */
    async loadDerivedRoadNetwork(manifestUrl = 'assets/city-highways/manifest.json') {
        try {
            const response = await fetch(manifestUrl, { cache: 'no-store' });
            if (response.status === 404) return [];
            if (!response.ok) throw new Error(`City highway manifest request failed (${response.status})`);
            const manifest = await response.json();
            if (manifest?.schema !== 'webglgta-city-highway-network-v1' || !Array.isArray(manifest?.roads)) {
                throw new Error('City highway manifest is invalid');
            }
            const roads = [];
            for (const entry of manifest.roads) {
                const file = typeof entry === 'string' ? entry : entry?.file;
                if (!file) continue;
                const metaUrl = new URL(String(file), new URL(manifestUrl, window.location.href)).toString();
                const road = await this.loadDerivedRoad(metaUrl, { applyDerivedTrackPlacement: false });
                if (road) roads.push(road);
            }
            return roads;
        } catch (error) {
            console.warn('City highway network unavailable:', error);
            return [];
        }
    }

    async loadDerivedTrackGround(metaUrl = 'assets/tracks/nordschleife/surface_collision.json') {
        this.derivedTrackGroundError = null;
        try {
            const response = await fetch(metaUrl, { cache: 'no-store' });
            if (response.status === 404) return null;
            if (!response.ok) throw new Error(`Authored track collision metadata request failed (${response.status})`);
            const meta = await response.json();
            if (meta?.schema !== 'webglgta-authored-track-collision-v1' || !meta?.file) throw new Error('Authored track collision metadata is invalid');
            const dataUrl = new URL(String(meta.file), new URL(metaUrl, window.location.href)).toString();
            const buffer = await fetchArrayBufferPreferredCompressed(dataUrl, { usePersistentCache: true, priority: 'high' });
            if (buffer.byteLength < 48) throw new Error('Authored track collision binary is truncated');
            const header = new DataView(buffer, 0, 48);
            const magic = String.fromCharCode(header.getUint8(0), header.getUint8(1), header.getUint8(2), header.getUint8(3));
            const version = header.getUint32(4, true);
            const vertexCount = header.getUint32(8, true);
            const indexCount = header.getUint32(12, true);
            const triangleCount = header.getUint32(16, true);
            const materialCount = header.getUint32(20, true);
            if (magic !== 'NCV1' || version !== 1 || indexCount !== triangleCount * 3 || vertexCount < 3 || triangleCount < 1) throw new Error('Authored track collision header is invalid');
            const minimum = [header.getFloat32(24, true), header.getFloat32(28, true), header.getFloat32(32, true)];
            const maximum = [header.getFloat32(36, true), header.getFloat32(40, true), header.getFloat32(44, true)];
            const positionsOffset = 48;
            const indicesOffset = positionsOffset + vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT;
            const materialsOffset = indicesOffset + indexCount * Uint32Array.BYTES_PER_ELEMENT;
            const expected = materialsOffset + triangleCount * Uint16Array.BYTES_PER_ELEMENT;
            if (![...minimum, ...maximum].every(Number.isFinite) || buffer.byteLength < expected) throw new Error('Authored track collision payload is invalid');
            const vertices = new Float32Array(buffer, positionsOffset, vertexCount * 3);
            this._translateDerivedTrackVertices(vertices);
            const indices = new Uint32Array(buffer, indicesOffset, indexCount);
            const triangleMaterials = new Uint16Array(buffer, materialsOffset, triangleCount);
            const materialPalette = Array.isArray(meta?.surfaces) ? meta.surfaces.slice(0, materialCount).map((surface) => ({
                name: String(surface?.name || surface?.key || 'asphalt').toLowerCase(),
                surface: String(surface?.key || surface?.name || 'asphalt').toLowerCase(),
                grip: Number(surface?.friction),
                damping: Number(surface?.damping),
                validTrack: surface?.validTrack === true,
                pitlane: surface?.pitlane === true,
            })) : [];
            const cellSize = 16.0;
            const [dx, dy, dz] = this.derivedTrackTranslation;
            const bounds = { minX: minimum[0] + dx, minY: minimum[1] + dy, minZ: minimum[2] + dz, maxX: maximum[0] + dx, maxY: maximum[1] + dy, maxZ: maximum[2] + dz, cellSize };
            const sourceSpawn = meta?.spawn;
            const placedSpawn = sourceSpawn ? {
                ...sourceSpawn,
                x: Number(sourceSpawn.x) + dx,
                y: Number(sourceSpawn.y) + dy,
                feetZ: Number(sourceSpawn.feetZ) + dz,
            } : null;
            const placedMeta = { ...meta, bounds: { ...bounds }, spawn: placedSpawn, worldTranslation: this.derivedTrackTranslation.slice() };
            const world = {
                id: String(meta.id || 'nordschleife-authored-surfaces'), meta: placedMeta,
                vertices, indices, triangleMaterials, materialPalette, ...bounds,
            };
            world.grid = this._buildYbnGrid(vertices, indices, bounds);
            world.wallGrid = this._buildYbnWallGrid(vertices, indices, bounds);
            this.derivedTrackGround = world;
            return world;
        } catch (error) {
            this.derivedTrackGround = null;
            this.derivedTrackGroundError = String(error?.message || error || 'Authored track collision load failed');
            console.warn('Authored track collision unavailable:', error);
            return null;
        }
    }

    getDerivedRoadBounds() {
        const entries = [...this.derivedRoads, ...(this.derivedTrackGround ? [this.derivedTrackGround] : [])];
        if (!entries.length) return null;
        return entries.reduce((out, road) => ({
            minX: Math.min(out.minX, road.minX), minY: Math.min(out.minY, road.minY), minZ: Math.min(out.minZ, road.minZ),
            maxX: Math.max(out.maxX, road.maxX), maxY: Math.max(out.maxY, road.maxY), maxZ: Math.max(out.maxZ, road.maxZ),
        }), { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity });
    }

    getDerivedRoadSpawn(id = null) {
        const authoredSpawn = this.derivedTrackGround?.meta?.spawn;
        const authored = [Number(authoredSpawn?.x), Number(authoredSpawn?.y), Number(authoredSpawn?.feetZ)];
        if (!id && authored.every(Number.isFinite)) return authored;
        const road = this.derivedRoads.find((entry) => !id || entry.id === id) || null;
        if (!road || road.vertices.length < 6) return null;
        return [
            (road.vertices[0] + road.vertices[3]) * 0.5,
            (road.vertices[1] + road.vertices[4]) * 0.5,
            (road.vertices[2] + road.vertices[5]) * 0.5,
        ];
    }

    getDerivedRoadSpawnFrame(id = null, lookAheadSegments = 10) {
        const authoredSpawn = this.derivedTrackGround?.meta?.spawn;
        const authoredPosition = [Number(authoredSpawn?.x), Number(authoredSpawn?.y), Number(authoredSpawn?.feetZ)];
        const authoredHeading = Number(authoredSpawn?.headingRad);
        if (!id && authoredPosition.every(Number.isFinite) && Number.isFinite(authoredHeading)) {
            return { position: authoredPosition, forwardData: [Math.cos(authoredHeading), Math.sin(authoredHeading)], headingRad: authoredHeading };
        }
        const road = this.derivedRoads.find((entry) => !id || entry.id === id) || null;
        if (!road || road.vertices.length < 12) return null;
        const midpoint = (segment) => {
            const base = Math.max(0, Math.min(road.segmentCount, segment)) * 6;
            return [
                (road.vertices[base] + road.vertices[base + 3]) * 0.5,
                (road.vertices[base + 1] + road.vertices[base + 4]) * 0.5,
                (road.vertices[base + 2] + road.vertices[base + 5]) * 0.5,
            ];
        };
        const position = midpoint(0);
        const ahead = midpoint(Math.max(1, Math.min(road.segmentCount, Math.round(Number(lookAheadSegments) || 10))));
        const dx = ahead[0] - position[0];
        const dy = ahead[1] - position[1];
        const length = Math.hypot(dx, dy);
        if (!(length > 1e-5)) return { position, forwardData: [1, 0], headingRad: 0 };
        return {
            position,
            forwardData: [dx / length, dy / length],
            headingRad: Math.atan2(dy, dx),
        };
    }

    _getDerivedRoadContactAtXY(x, y, zHint, maxRise = 1.5) {
        const hint = Number(zHint);
        let best = null;
        const solveTriangle = (vertices, ia, ib, ic) => {
            const ax = vertices[ia]; const ay = vertices[ia + 1]; const az = vertices[ia + 2];
            const bx = vertices[ib]; const by = vertices[ib + 1]; const bz = vertices[ib + 2];
            const cx = vertices[ic]; const cy = vertices[ic + 1]; const cz = vertices[ic + 2];
            const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
            if (Math.abs(denominator) < 1e-6) return null;
            const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / denominator;
            const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / denominator;
            const w = 1.0 - u - v;
            if (u < -1e-4 || v < -1e-4 || w < -1e-4) return null;
            const z = u * az + v * bz + w * cz;
            return Number.isFinite(z) && (!Number.isFinite(hint) || z <= hint + Math.max(1.5, maxRise)) ? z : null;
        };
        for (const road of this.derivedRoads) {
            if (x < road.minX || x > road.maxX || y < road.minY || y > road.maxY) continue;
            const candidates = road.grid.get(`${Math.floor(x / road.cellSize)}:${Math.floor(y / road.cellSize)}`) || [];
            for (const segment of candidates) {
                const base = segment * 6; const next = base + 6;
                const first = solveTriangle(road.vertices, base, next, base + 3);
                const second = solveTriangle(road.vertices, next, base + 3, next + 3);
                const z = Math.max(first ?? -Infinity, second ?? -Infinity);
                if (Number.isFinite(z) && (!best || z > best.z)) best = { z, road, segment };
            }
        }
        if (!best) return null;
        const surface = best.road.meta?.surface || {};
        return { z: best.z, material: String(surface.name || 'asphalt').toLowerCase(), grip: Number.isFinite(Number(surface.grip)) ? Number(surface.grip) : null, roadId: best.road.id, segment: best.segment };
    }

    _derivedRoadCenterDistance(x, y) {
        let best = Number.POSITIVE_INFINITY;
        for (const road of this.derivedRoads) {
            if (!road?.grid || !road?.vertices || road.segmentCount < 1) continue;
            const gx = Math.floor(Number(x) / road.cellSize);
            const gy = Math.floor(Number(y) / road.cellSize);
            const tested = new Set();
            for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
                const candidates = road.grid.get(`${gx + ox}:${gy + oy}`) || [];
                for (const segment of candidates) {
                    if (tested.has(segment)) continue;
                    tested.add(segment);
                    const base = segment * 6;
                    const next = Math.min(road.segmentCount, segment + 1) * 6;
                    const ax = (road.vertices[base] + road.vertices[base + 3]) * 0.5;
                    const ay = (road.vertices[base + 1] + road.vertices[base + 4]) * 0.5;
                    const bx = (road.vertices[next] + road.vertices[next + 3]) * 0.5;
                    const by = (road.vertices[next + 1] + road.vertices[next + 4]) * 0.5;
                    const dx = bx - ax; const dy = by - ay;
                    const lengthSq = dx * dx + dy * dy;
                    const t = lengthSq > 1e-8 ? Math.max(0, Math.min(1, ((Number(x) - ax) * dx + (Number(y) - ay) * dy) / lengthSq)) : 0;
                    best = Math.min(best, Math.hypot(Number(x) - (ax + dx * t), Number(y) - (ay + dy * t)));
                }
            }
        }
        return best;
    }

    _isDerivedTrackCorridorWall(world, triangleOffset, contactX, contactY, contactZ) {
        if (world !== this.derivedTrackGround || !this.derivedRoads.length || !world?.triangleMaterials) return false;
        const materialIndex = Number(world.triangleMaterials[Math.floor(Number(triangleOffset) / 3)]);
        const material = world.materialPalette?.[materialIndex];
        if (String(material?.surface || material?.name || '').toLowerCase() !== 'wall') return false;
        const roadContact = this._getYbnGroundContactAtXY(
            Number(contactX), Number(contactY), Number(contactZ) + 0.8, 1.5,
            { nearestToHint: true, maxDrop: 2.0 }, world,
        );
        if (!roadContact?.validTrack || String(roadContact.material || '').toLowerCase() !== 'trm-nrm') return false;
        const declaredWidth = Math.max(1, ...this.derivedRoads.map((road) => Number(road.meta?.roadWidthM) || 0));
        const centerClearance = Math.max(0.9, Math.min(1.35, declaredWidth * 0.12));
        return this._derivedRoadCenterDistance(contactX, contactY) <= centerClearance;
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

    _buildYbnWallGrid(vertices, indices, { minX, minY, maxX, maxY, cellSize }) {
        const grid = new Map();
        const minGX = Math.floor(minX / cellSize);
        const minGY = Math.floor(minY / cellSize);
        const maxGX = Math.floor(maxX / cellSize);
        const maxGY = Math.floor(maxY / cellSize);
        let triangleCount = 0;
        const put = (gx, gy, triangleOffset) => {
            const key = `${gx}:${gy}`;
            let bucket = grid.get(key);
            if (!bucket) {
                bucket = [];
                grid.set(key, bucket);
            }
            bucket.push(triangleOffset);
        };

        for (let offset = 0; offset < indices.length; offset += 3) {
            const ia = indices[offset] * 3;
            const ib = indices[offset + 1] * 3;
            const ic = indices[offset + 2] * 3;
            const ax = vertices[ia], ay = vertices[ia + 1], az = vertices[ia + 2];
            const bx = vertices[ib], by = vertices[ib + 1], bz = vertices[ib + 2];
            const cx = vertices[ic], cy = vertices[ic + 1], cz = vertices[ic + 2];
            if (![ax, ay, az, bx, by, bz, cx, cy, cz].every(Number.isFinite)) continue;
            const e1x = bx - ax; const e1y = by - ay; const e1z = bz - az;
            const e2x = cx - ax; const e2y = cy - ay; const e2z = cz - az;
            const nx = e1y * e2z - e1z * e2y;
            const ny = e1z * e2x - e1x * e2z;
            const nz = e1x * e2y - e1y * e2x;
            const normalLength = Math.hypot(nx, ny, nz);
            // Keep surfaces steeper than roughly 53 degrees in the wall index.
            // Low risers are filtered by maxStepUp when the capsule is queried.
            if (normalLength < 1e-7 || Math.hypot(nx, ny) / normalLength < 0.8) continue;

            const gx0 = Math.max(minGX, Math.floor(Math.min(ax, bx, cx) / cellSize));
            const gy0 = Math.max(minGY, Math.floor(Math.min(ay, by, cy) / cellSize));
            const gx1 = Math.min(maxGX, Math.floor(Math.max(ax, bx, cx) / cellSize));
            const gy1 = Math.min(maxGY, Math.floor(Math.max(ay, by, cy) / cellSize));
            for (let gy = gy0; gy <= gy1; gy++) {
                for (let gx = gx0; gx <= gx1; gx++) put(gx, gy, offset);
            }
            triangleCount++;
        }
        return { cells: grid, triangleCount };
    }

    _ybnCellCandidates(world, gx, gy) {
        const grid = world?.grid;
        if (!grid) return null;
        if (grid instanceof Map) return grid.get(`${gx}:${gy}`) || null;
        const localX = gx - grid.minGX;
        const localY = gy - grid.minGY;
        if (localX < 0 || localY < 0 || localX >= grid.width || localY >= grid.height) return null;
        const cellIndex = localY * grid.width + localX;
        const start = grid.cellOffsets[cellIndex];
        const end = grid.cellOffsets[cellIndex + 1];
        return end > start ? grid.triangleOffsets.subarray(start, end) : null;
    }

    _ybnWallCellCandidates(world, gx, gy) {
        const grid = world?.wallGrid;
        if (!grid) return null;
        if (grid.cells instanceof Map) return grid.cells.get(`${gx}:${gy}`) || null;
        const localX = gx - grid.minGX;
        const localY = gy - grid.minGY;
        if (localX < 0 || localY < 0 || localX >= grid.width || localY >= grid.height) return null;
        const cellIndex = localY * grid.width + localX;
        const start = grid.cellOffsets[cellIndex];
        const end = grid.cellOffsets[cellIndex + 1];
        return end > start ? grid.triangleOffsets.subarray(start, end) : null;
    }

    _getYbnGroundContactAtXY(x, y, zHint, maxRise = 1.5, {
        nearestToHint = false,
        maxDrop = Number.POSITIVE_INFINITY,
    } = {}, worldOverride = null) {
        const world = worldOverride || this.ybnGround;
        if (!world || x < world.minX || x > world.maxX || y < world.minY || y > world.maxY) return null;
        const candidates = this._ybnCellCandidates(
            world,
            Math.floor(x / world.cellSize),
            Math.floor(y / world.cellSize),
        );
        if (!candidates || candidates.length === 0) return null;

        const hint = Number(zHint);
        const ceiling = Number.isFinite(hint) ? hint + Math.max(0.1, Number(maxRise) || 1.5) : Number.POSITIVE_INFINITY;
        const floor = Number.isFinite(hint) ? hint - Math.max(0.0, Number(maxDrop) || 0.0) : Number.NEGATIVE_INFINITY;
        let bestZ = Number.NEGATIVE_INFINITY;
        let bestDistance = Number.POSITIVE_INFINITY;
        let bestOffset = -1;
        for (const offset of candidates) {
            const ia = world.indices[offset] * 3;
            const ib = world.indices[offset + 1] * 3;
            const ic = world.indices[offset + 2] * 3;
            const ax = world.vertices[ia], ay = world.vertices[ia + 1], az = world.vertices[ia + 2];
            const bx = world.vertices[ib], by = world.vertices[ib + 1], bz = world.vertices[ib + 2];
            const cx = world.vertices[ic], cy = world.vertices[ic + 1], cz = world.vertices[ic + 2];
            if (this._isYbnCollisionExcluded(ax, ay, az, bx, by, bz, cx, cy, cz)) continue;
            const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
            if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-6) continue;
            const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / denominator;
            const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / denominator;
            const w = 1.0 - u - v;
            if (u < -1e-4 || v < -1e-4 || w < -1e-4) continue;
            const z = u * az + v * bz + w * cz;
            const distance = Number.isFinite(hint) ? Math.abs(z - hint) : 0.0;
            const better = nearestToHint
                ? distance < bestDistance - 1e-5 || (Math.abs(distance - bestDistance) <= 1e-5 && z > bestZ)
                : z > bestZ;
            if (Number.isFinite(z) && z >= floor && z <= ceiling && better) {
                bestZ = z;
                bestDistance = distance;
                bestOffset = offset;
            }
        }
        if (!Number.isFinite(bestZ)) return null;
        const materialIndex = bestOffset >= 0 && world.triangleMaterials
            ? Number(world.triangleMaterials[Math.floor(bestOffset / 3)])
            : -1;
        const materialRecord = materialIndex >= 0 ? world.materialPalette?.[materialIndex] : null;
        return {
            z: bestZ,
            triangleOffset: bestOffset,
            materialIndex: materialIndex >= 0 ? materialIndex : null,
            material: String(materialRecord?.surface || materialRecord?.name || 'asphalt').toLowerCase(),
            grip: Number.isFinite(Number(materialRecord?.grip)) ? Number(materialRecord.grip) : null,
            damping: Number.isFinite(Number(materialRecord?.damping)) ? Number(materialRecord.damping) : null,
            validTrack: materialRecord?.validTrack === true,
            pitlane: materialRecord?.pitlane === true,
            wetGrip: Number.isFinite(Number(materialRecord?.wet_grip)) ? Number(materialRecord.wet_grip) : null,
            tyreDrag: Number.isFinite(Number(materialRecord?.tyre_drag)) ? Number(materialRecord.tyre_drag) : null,
            topSpeedMultiplier: Number.isFinite(Number(materialRecord?.top_speed_mult)) ? Number(materialRecord.top_speed_mult) : null,
        };
    }

    _getYbnGroundAtXY(x, y, zHint, maxRise = 1.5) {
        return this._getYbnGroundContactAtXY(x, y, zHint, maxRise)?.z ?? null;
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
        const rawBlockers = Array.isArray(this.manifest?.collision?.blockers)
            ? this.manifest.collision.blockers
            : [];
        const rawDestructibles = [
            ...(Array.isArray(this.manifest?.destructibles) ? this.manifest.destructibles : []),
            ...(Array.isArray(this.manifest?.collision?.destructibles) ? this.manifest.collision.destructibles : []),
        ];
        this.destroyedDestructibleIds.clear();
        this.destructibleDamage.clear();
        this.destructibles.clear();
        const normalize = (raw, fallbackId, destructible = false) => {
            const coords = raw?.coords || raw || {};
            const id = String(raw?.id || raw?.label || fallbackId);
            const item = {
                id,
                type: String(raw?.type || 'circle'),
                label: String(raw?.label || raw?.name || id),
                x: finite(coords.x, NaN),
                y: finite(coords.y, NaN),
                z: finite(coords.z, NaN),
                radius: Math.max(0.1, finite(raw?.radius, 0.8)),
                height: Math.max(0.1, finite(raw?.height, 2.2)),
                destructible: destructible || raw?.destructible === true,
                breakSpeed: Math.max(0.1, finite(raw?.breakSpeed ?? raw?.breakSpeedMps, 4.5)),
                breakHealth: Math.max(1, Math.floor(finite(raw?.breakHealth, 1))),
                blocksMovement: raw?.blocksMovement !== false,
                archetypeHash: String(raw?.archetypeHash || raw?.hash || '').trim(),
            };
            return Number.isFinite(item.x) && Number.isFinite(item.y) ? item : null;
        };
        this.blockers = rawBlockers
            .map((b, index) => normalize(b, `blocker:${index}`))
            .filter(Boolean);
        for (const blocker of this.blockers) {
            if (blocker.destructible) this.destructibles.set(blocker.id, blocker);
        }
        for (let index = 0; index < rawDestructibles.length; index++) {
            const item = normalize(rawDestructibles[index], `destructible:${index}`, true);
            if (!item) continue;
            this.destructibles.set(item.id, item);
            // A destructible is solid until it receives a qualifying impact.
            if (item.blocksMovement && !this.blockers.some((blocker) => blocker.id === item.id)) this.blockers.push(item);
        }
        this._rebuildVehicleBroadphase();
    }

    addDestructibles(records) {
        const source = Array.isArray(records) ? records : [];
        let added = 0;
        for (let index = 0; index < source.length; index++) {
            const raw = source[index] || {};
            const coords = raw?.coords || raw;
            const id = String(raw?.id || raw?.label || `destructible:${index}`);
            const item = {
                id,
                type: String(raw?.type || 'circle'),
                label: String(raw?.label || raw?.name || id),
                x: finite(coords.x, NaN),
                y: finite(coords.y, NaN),
                z: finite(coords.z, NaN),
                radius: Math.max(0.1, finite(raw?.radius, 0.8)),
                height: Math.max(0.1, finite(raw?.height, 2.2)),
                destructible: true,
                breakSpeed: Math.max(0.1, finite(raw?.breakSpeed ?? raw?.breakSpeedMps, 4.5)),
                breakHealth: Math.max(1, Math.floor(finite(raw?.breakHealth, 1))),
                blocksMovement: raw?.blocksMovement === true,
                archetypeHash: String(raw?.archetypeHash || raw?.hash || '').trim(),
            };
            if (!Number.isFinite(item.x) || !Number.isFinite(item.y) || this.destructibles.has(id)) continue;
            this.destructibles.set(id, item);
            if (item.blocksMovement && !this.blockers.some((blocker) => blocker.id === id)) this.blockers.push(item);
            added++;
        }
        if (added) this._rebuildVehicleBroadphase();
        return added;
    }

    _insertCircleIntoGrid(grid, cellSize, item) {
        if (!grid || !item || !Number.isFinite(item.x) || !Number.isFinite(item.y)) return;
        const radius = Math.max(0.05, finite(item.radius, 0.8));
        const gx0 = Math.floor((item.x - radius) / cellSize);
        const gy0 = Math.floor((item.y - radius) / cellSize);
        const gx1 = Math.floor((item.x + radius) / cellSize);
        const gy1 = Math.floor((item.y + radius) / cellSize);
        for (let gy = gy0; gy <= gy1; gy++) {
            for (let gx = gx0; gx <= gx1; gx++) {
                const key = `${gx}:${gy}`;
                let bucket = grid.get(key);
                if (!bucket) { bucket = []; grid.set(key, bucket); }
                bucket.push(item);
            }
        }
    }

    _rebuildVehicleBroadphase() {
        const blockers = new Map();
        const destructibles = new Map();
        for (const blocker of this.blockers) this._insertCircleIntoGrid(blockers, this._blockerCellSize, blocker);
        for (const destructible of this.destructibles.values()) this._insertCircleIntoGrid(destructibles, this._destructibleCellSize, destructible);
        this._blockerGrid = blockers;
        this._destructibleGrid = destructibles;
    }

    _queryCircleGrid(grid, cellSize, minX, minY, maxX, maxY) {
        if (!grid?.size) return [];
        const gx0 = Math.floor(finite(minX) / cellSize);
        const gy0 = Math.floor(finite(minY) / cellSize);
        const gx1 = Math.floor(finite(maxX) / cellSize);
        const gy1 = Math.floor(finite(maxY) / cellSize);
        const seen = new Set();
        const result = [];
        for (let gy = gy0; gy <= gy1; gy++) {
            for (let gx = gx0; gx <= gx1; gx++) {
                for (const item of grid.get(`${gx}:${gy}`) || []) {
                    if (seen.has(item)) continue;
                    seen.add(item);
                    result.push(item);
                }
            }
        }
        return result;
    }

    setAssetColliders(records, { append = false } = {}) {
        const colliders = append ? [...this._assetColliders] : [];
        const byId = append ? new Map(this._assetCollidersById) : new Map();
        let count = colliders.length;
        for (const raw of Array.isArray(records) ? records : []) {
            const source = String(raw?.source || 'asset_bounds');
            const instance = raw?.instance || null;
            const collider = {
                id: String(raw?.id || `asset:${count}`),
                label: String(raw?.label || raw?.archetypeHash || 'asset'),
                source,
                x: finite(raw?.x, NaN),
                y: finite(raw?.y, NaN),
                minZ: finite(raw?.minZ, NaN),
                maxZ: finite(raw?.maxZ, NaN),
                halfX: Math.max(0.01, finite(raw?.halfX, NaN)),
                halfY: Math.max(0.01, finite(raw?.halfY, NaN)),
                axisXX: finite(raw?.axisXX, NaN),
                axisXY: finite(raw?.axisXY, NaN),
                axisYX: finite(raw?.axisYX, NaN),
                axisYY: finite(raw?.axisYY, NaN),
                archetypeHash: String(raw?.archetypeHash || ''),
                destructibleId: String(raw?.destructibleId || '').trim(),
                response: String(raw?.response || 'static'),
                mass: Math.max(1.0, finite(raw?.mass, 40.0)),
                instanceSourceX: finite(instance?.x, NaN),
                instanceSourceY: finite(instance?.y, NaN),
                instanceSourceZ: finite(instance?.z, NaN),
                instanceX: finite(instance?.x, NaN),
                instanceY: finite(instance?.y, NaN),
                instanceZ: finite(instance?.z, NaN),
            };
            if (![collider.x, collider.y, collider.minZ, collider.maxZ, collider.halfX, collider.halfY,
                collider.axisXX, collider.axisXY, collider.axisYX, collider.axisYY].every(Number.isFinite)
                || collider.maxZ <= collider.minZ) continue;
            const existing = byId.get(collider.id);
            if (existing) {
                const index = colliders.indexOf(existing);
                if (index >= 0) colliders[index] = collider;
            } else {
                colliders.push(collider);
            }
            byId.set(collider.id, collider);
        }
        count = colliders.length;
        this._assetColliders = colliders;
        this._assetCollidersById = byId;
        this._rebuildAssetColliderGrid();
        this.assetColliderCount = count;
        return count;
    }

    _rebuildAssetColliderGrid() {
        const grid = new Map();
        const cellSize = this._assetColliderCellSize;
        for (const collider of this._assetColliders) {
            const extentX = Math.abs(collider.axisXX) * collider.halfX + Math.abs(collider.axisYX) * collider.halfY;
            const extentY = Math.abs(collider.axisXY) * collider.halfX + Math.abs(collider.axisYY) * collider.halfY;
            const gx0 = Math.floor((collider.x - extentX) / cellSize);
            const gy0 = Math.floor((collider.y - extentY) / cellSize);
            const gx1 = Math.floor((collider.x + extentX) / cellSize);
            const gy1 = Math.floor((collider.y + extentY) / cellSize);
            for (let gy = gy0; gy <= gy1; gy++) {
                for (let gx = gx0; gx <= gx1; gx++) {
                    const key = `${gx}:${gy}`;
                    let bucket = grid.get(key);
                    if (!bucket) { bucket = []; grid.set(key, bucket); }
                    bucket.push(collider);
                }
            }
        }
        this._assetColliderGrid = grid;
    }

    _tryPushAssetCollider(hit, moveX, moveY) {
        const collider = hit?._collider || this._assetCollidersById.get(String(hit?.id || ''));
        if (!collider || collider.response !== 'pushable') return false;
        const dx = finite(moveX);
        const dy = finite(moveY);
        const distance = Math.hypot(dx, dy);
        if (distance < 1e-5) return false;
        const maxPushDistance = Math.max(0.18, Math.min(0.4, 0.42 - collider.mass * 0.003));
        const pushScale = Math.min(1.0, maxPushDistance / distance);
        const pushX = dx * pushScale;
        const pushY = dy * pushScale;
        const proposedX = collider.x + pushX;
        const proposedY = collider.y + pushY;
        const propRadius = Math.max(0.12, Math.min(1.25, Math.min(collider.halfX, collider.halfY) * 0.9));
        const propHeight = Math.max(0.2, collider.maxZ - collider.minZ);
        const ground = this.resolveGround(proposedX, proposedY, collider.minZ, {
            preferInterior: false,
            maxSnapDistance: 1.0,
        });
        const groundDelta = finite(ground?.z, collider.minZ) - collider.minZ;
        if (Math.abs(groundDelta) > 0.45) return false;
        const other = this._firstObbGridHit(
            this._assetColliderGrid,
            this._assetColliderCellSize,
            proposedX, proposedY, collider.minZ + groundDelta,
            propRadius, propHeight, 0.0, pushX, pushY, 0.0,
            collider.id,
        );
        if (other) return false;
        const wall = this._firstYbnWallHit(
            proposedX, proposedY, collider.minZ + groundDelta,
            propRadius, propHeight, 0.0, pushX, pushY, 0.0,
        );
        if (wall) return false;

        const previousX = collider.x;
        const previousY = collider.y;
        collider.x = proposedX;
        collider.y = proposedY;
        collider.minZ += groundDelta;
        collider.maxZ += groundDelta;
        if (Number.isFinite(collider.instanceX)) collider.instanceX += pushX;
        if (Number.isFinite(collider.instanceY)) collider.instanceY += pushY;
        if (Number.isFinite(collider.instanceZ)) collider.instanceZ += groundDelta;
        this._rebuildAssetColliderGrid();
        try {
            this.app?.onDynamicPropMoved?.({
                id: collider.id,
                archetypeHash: collider.archetypeHash,
                source: [collider.instanceSourceX, collider.instanceSourceY, collider.instanceSourceZ],
                position: [collider.instanceX, collider.instanceY, collider.instanceZ],
                delta: [collider.x - previousX, collider.y - previousY, groundDelta],
                mass: collider.mass,
            });
        } catch { /* visual response is optional */ }
        return true;
    }

    setDoorDefinitions(records) {
        this.doorDefinitions.clear();
        this.doorOpenProgress.clear();
        for (const raw of Array.isArray(records) ? records : []) {
            const id = String(raw?.id || '');
            const hash = String(raw?.archetypeHash || '');
            const coords = raw?.coords || raw?.origin;
            const origin = raw?.origin || coords;
            if (!id || !hash || !coords || !origin) continue;
            const x = finite(coords.x, NaN);
            const y = finite(coords.y, NaN);
            const z = finite(coords.z, NaN);
            const originX = finite(origin.x, x);
            const originY = finite(origin.y, y);
            const originZ = finite(origin.z, z);
            if (![x, y].every(Number.isFinite)) continue;
            // In exported door records, origin is the hinge while coords is the
            // center of the leaf. The vector therefore runs along the opening,
            // not through it; its perpendicular is the thin door plane.
            const tangentDeltaX = x - originX;
            const tangentDeltaY = y - originY;
            const tangentLength = Math.hypot(tangentDeltaX, tangentDeltaY);
            const hasOrientation = tangentLength >= 0.05;
            const tangentX = hasOrientation ? tangentDeltaX / tangentLength : 1.0;
            const tangentY = hasOrientation ? tangentDeltaY / tangentLength : 0.0;
            this.doorDefinitions.set(id, {
                id,
                archetypeHash: hash,
                x,
                y,
                minZ: Math.min(z, originZ) - Math.max(0.8, finite(raw?.passageHalfHeight, 1.3)),
                maxZ: Math.max(z, originZ) + Math.max(0.8, finite(raw?.passageHalfHeight, 1.3)),
                passageHalfWidth: Math.max(0.4, finite(raw?.passageRadius, 0.9)),
                passageHalfDepth: Math.max(0.22, Math.min(0.7, finite(raw?.passageHalfDepth, 0.4))),
                tangentX,
                tangentY,
                normalX: -tangentY,
                normalY: tangentX,
                hasOrientation,
                originX,
                originY,
                originZ,
                motion: ['slide', 'lift'].includes(raw?.motion) ? raw.motion : 'swing',
                openAmount: Math.max(0.01, finite(raw?.openAmount, Math.PI * 0.5)),
                openSign: finite(raw?.openSign, 1) < 0 ? -1 : 1,
            });
            this.doorOpenProgress.set(id, 0.0);
        }
        this._dynamicDoorCollidersDirty = true;
    }

    setDoorOpenProgress(id, progress) {
        const key = String(id || '');
        if (this.doorDefinitions.has(key)) {
            const next = Math.max(0.0, Math.min(1.0, finite(progress)));
            if (Math.abs(next - finite(this.doorOpenProgress.get(key))) >= 0.002) this._dynamicDoorCollidersDirty = true;
            this.doorOpenProgress.set(key, next);
        }
    }

    _rebuildDynamicDoorColliderGrid() {
        if (!this._dynamicDoorCollidersDirty) return;
        const grid = new Map();
        for (const door of this.doorDefinitions.values()) {
            const progress = finite(this.doorOpenProgress.get(door.id));
            if (progress <= 0.01 || !door.hasOrientation || door.motion === 'lift') continue;
            const baseX = door.x - door.originX;
            const baseY = door.y - door.originY;
            const halfLength = Math.max(0.18, Math.hypot(baseX, baseY));
            let tangentX = door.tangentX;
            let tangentY = door.tangentY;
            let centerX = door.x;
            let centerY = door.y;
            if (door.motion === 'slide') {
                centerX += tangentX * door.openSign * door.openAmount * progress;
                centerY += tangentY * door.openSign * door.openAmount * progress;
            } else {
                const angle = door.openSign * door.openAmount * progress;
                const cosine = Math.cos(angle);
                const sine = Math.sin(angle);
                const rotatedX = baseX * cosine - baseY * sine;
                const rotatedY = baseX * sine + baseY * cosine;
                centerX = door.originX + rotatedX;
                centerY = door.originY + rotatedY;
                tangentX = rotatedX / halfLength;
                tangentY = rotatedY / halfLength;
            }
            const collider = {
                id: `dynamic-door:${door.id}`,
                doorId: door.id,
                label: door.id,
                source: 'dynamic_door',
                x: centerX,
                y: centerY,
                minZ: door.minZ,
                maxZ: door.maxZ,
                halfX: halfLength,
                halfY: Math.max(0.06, Math.min(0.18, door.passageHalfDepth * 0.35)),
                axisXX: tangentX,
                axisXY: tangentY,
                axisYX: -tangentY,
                axisYY: tangentX,
            };
            this._insertCircleIntoGrid(grid, this._dynamicDoorColliderCellSize, {
                ...collider,
                radius: Math.hypot(collider.halfX, collider.halfY),
            });
        }
        this._dynamicDoorColliderGrid = grid;
        this._dynamicDoorCollidersDirty = false;
    }

    _isOpenDoorCollider(proxy) {
        if (!proxy?.archetypeHash) return false;
        for (const door of this.doorDefinitions.values()) {
            if (door.archetypeHash !== proxy.archetypeHash || (this.doorOpenProgress.get(door.id) || 0) < 0.42) continue;
            if (this._isOpenDoorPassage(proxy.x, proxy.y, proxy.minZ, proxy.maxZ - proxy.minZ, 0.04, door)) return true;
        }
        return false;
    }

    _isOpenDoorPassage(x, y, feetZ, height, radius = 0.0, singleDoor = null) {
        const px = finite(x, NaN);
        const py = finite(y, NaN);
        const capsuleMinZ = finite(feetZ, NaN);
        const capsuleMaxZ = capsuleMinZ + Math.max(0.2, finite(height, 1.8));
        if (![px, py, capsuleMinZ, capsuleMaxZ].every(Number.isFinite)) return false;
        const doors = singleDoor ? [singleDoor] : this.doorDefinitions.values();
        const capsuleRadius = Math.max(0.0, finite(radius));
        for (const door of doors) {
            if ((this.doorOpenProgress.get(door.id) || 0) < 0.02) continue;
            if (capsuleMaxZ < door.minZ || capsuleMinZ > door.maxZ) continue;
            const dx = px - door.x;
            const dy = py - door.y;
            if (!door.hasOrientation) {
                if (Math.hypot(dx, dy) <= door.passageHalfWidth + capsuleRadius) return true;
                continue;
            }
            const alongDoor = dx * door.tangentX + dy * door.tangentY;
            const throughDoor = dx * door.normalX + dy * door.normalY;
            if (Math.abs(alongDoor) <= door.passageHalfWidth + capsuleRadius
                && Math.abs(throughDoor) <= door.passageHalfDepth + capsuleRadius) return true;
        }
        return false;
    }

    getDestructible(id) {
        return this.destructibles.get(String(id || '')) || null;
    }

    findDestructibleImpact({ start, end, radius = 0.0, feetZ = NaN } = {}) {
        if (!Array.isArray(start) || !Array.isArray(end) || start.length < 2 || end.length < 2) return null;
        const sx = finite(start[0], NaN); const sy = finite(start[1], NaN);
        const ex = finite(end[0], NaN); const ey = finite(end[1], NaN);
        const moverRadius = Math.max(0.0, finite(radius));
        if (![sx, sy, ex, ey].every(Number.isFinite)) return null;
        const dx = ex - sx; const dy = ey - sy;
        const length2 = dx * dx + dy * dy;
        let closest = null;
        const candidates = this._queryCircleGrid(
            this._destructibleGrid,
            this._destructibleCellSize,
            Math.min(sx, ex) - moverRadius,
            Math.min(sy, ey) - moverRadius,
            Math.max(sx, ex) + moverRadius,
            Math.max(sy, ey) + moverRadius,
        );
        for (const item of candidates) {
            if (!item || this.destroyedDestructibleIds.has(item.id)) continue;
            const verticalCenter = finite(item.z, finite(feetZ, 0.0)) + item.height * 0.5;
            if (Number.isFinite(feetZ) && Math.abs(verticalCenter - feetZ) > item.height * 0.75 + 2.0) continue;
            let t = 0.0;
            if (length2 > 1e-8) t = Math.max(0.0, Math.min(1.0, ((item.x - sx) * dx + (item.y - sy) * dy) / length2));
            const px = sx + dx * t; const py = sy + dy * t;
            const distance = Math.hypot(item.x - px, item.y - py);
            if (distance > item.radius + moverRadius) continue;
            if (!closest || t < closest.t || (t === closest.t && distance < closest.distance)) {
                closest = { ...item, t, distance };
            }
        }
        return closest;
    }

    destroyDestructibleForImpact(hit, speed, { source = 'impact', impactDirection = null, impactPoint = null } = {}) {
        const id = String(hit?.id || '');
        const destructible = hit?.destructible === true ? (this.destructibles.get(id) || hit) : null;
        if (!destructible || this.destroyedDestructibleIds.has(id)) return null;
        const impactSpeed = Math.abs(finite(speed));
        if (impactSpeed < Math.max(0.1, finite(destructible.breakSpeed, 4.5))) return null;
        const requiredHits = Math.max(1, Math.floor(finite(destructible.breakHealth, 1)));
        const appliedHits = source === 'bullet' ? 1 : requiredHits;
        const nextHits = Math.min(requiredHits, (this.destructibleDamage.get(id) || 0) + appliedHits);
        this.destructibleDamage.set(id, nextHits);
        if (nextHits < requiredHits) return null;
        this.destroyedDestructibleIds.add(id);
        this.destructibleDamage.delete(id);
        const event = {
            id,
            label: String(destructible.label || id),
            impactSpeed,
            source: String(source || 'impact'),
            requiredHits,
            archetypeHash: destructible.archetypeHash || '',
            coords: [destructible.x, destructible.y, destructible.z],
            impactDirection: Array.isArray(impactDirection) && impactDirection.length >= 3
                ? [finite(impactDirection[0]), finite(impactDirection[1]), finite(impactDirection[2])]
                : null,
            impactPoint: Array.isArray(impactPoint) && impactPoint.length >= 3
                ? [finite(impactPoint[0]), finite(impactPoint[1]), finite(impactPoint[2])]
                : null,
        };
        try { this.app?.onDestructibleDestroyed?.(event, destructible); } catch { /* optional presentation hook */ }
        return event;
    }

    resolveGround(x, y, zHint = NaN, {
        preferInterior = true,
        maxSnapDistance = 35.0,
        maxRise = 1.5,
        maxDrop = Number.POSITIVE_INFINITY,
        nearestToHint = false,
        applyYbnCalibration = true,
    } = {}) {
        const app = this.app;
        // City streets use authored YBN as their sole gameplay surface. An
        // active MLO is different: destination overlays may intentionally have
        // no YBN at all, so their authored room floor must remain eligible.
        // Requiring an active interior prevents unrelated streamed drawables
        // from stealing ground authority elsewhere in the bounded demo.
        const boundedDemo = app?.spawnDistrictDemo === true;
        const activeInterior = app?.drawableStreamer?._activeInterior || null;
        const allowAuthoredInterior = preferInterior && (!boundedDemo || !!activeInterior);
        const rawTerrainZ = app?.terrainRenderer?.getHeightAtXY?.(x, y);
        const authoredCitySurface = this._getAuthoredCityGroundAtXY(x, y);
        const groundEnabled = app?.groundPedToTerrain === true;
        const ybnContact = groundEnabled ? this._getYbnGroundContactAtXY(
            x,
            y,
            zHint,
            Math.max(0.0, finite(maxRise, 1.5)),
            {
                nearestToHint: nearestToHint === true,
                maxDrop: Number.isFinite(Number(maxDrop)) ? Math.max(0.0, Number(maxDrop)) : Number.POSITIVE_INFINITY,
            },
        ) : null;
        // Derived circuit roads are a separate sparse mesh. They deliberately
        // coexist with GTA YBN rather than replacing it, so the original map
        // remains fully driveable outside the track bounds.
        const authoredTrackContact = this.derivedTrackGround ? this._getYbnGroundContactAtXY(
            x,
            y,
            zHint,
            Math.max(0.0, finite(maxRise, 1.5)),
            {
                nearestToHint: true,
                maxDrop: Number.isFinite(Number(maxDrop)) ? Math.max(0.0, Number(maxDrop)) : Math.max(3.0, maxSnapDistance),
            },
            this.derivedTrackGround,
        ) : null;
        // The authored physics mesh owns track contact. The AI ribbon remains
        // a compatibility fallback for older/local packages only.
        const roadContact = authoredTrackContact || this._getDerivedRoadContactAtXY(x, y, zHint, maxSnapDistance);
        const rawYbnZ = ybnContact?.z ?? null;
        const ybnOffset = applyYbnCalibration ? (Number(this.ybnGroundOffset) || 0.0) : 0.0;
        const ybnZ = Number.isFinite(rawYbnZ) ? Number(rawYbnZ) + ybnOffset : null;
        let bestZ = authoredCitySurface ? authoredCitySurface.z : (Number.isFinite(Number(roadContact?.z)) ? Number(roadContact.z) : (Number.isFinite(ybnZ) ? Number(ybnZ) : null));
        let source = authoredCitySurface ? 'matrix-city' : (Number.isFinite(Number(roadContact?.z)) ? 'track' : (Number.isFinite(ybnZ) ? 'ybn' : 'none'));
        let interior = null;
        const hint = Number.isFinite(Number(zHint))
            ? Number(zHint)
            : (bestZ !== null ? bestZ : 0.0);

        if (allowAuthoredInterior) {
            try {
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
                const eligible = boundedDemo
                    ? interior.inRoom === true
                    : (interior.inRoom || closeToHint || bestZ === null || floorZ > bestZ);
                if (eligible) {
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
            material: source === 'matrix-city' ? authoredCitySurface?.material || 'asphalt' : source === 'track' ? (roadContact?.material || 'asphalt') : source === 'ybn' ? (ybnContact?.material || 'asphalt') : source === 'interior' ? 'concrete' : source === 'terrain' ? 'dirt' : 'asphalt',
            grip: source === 'track' ? roadContact?.grip ?? null : source === 'ybn' ? ybnContact?.grip ?? null : null,
            damping: source === 'track' ? roadContact?.damping ?? null : source === 'ybn' ? ybnContact?.damping ?? null : null,
            validTrack: source === 'track' ? roadContact?.validTrack === true : null,
            pitlane: source === 'track' ? roadContact?.pitlane === true : null,
            wetGrip: source === 'ybn' ? ybnContact?.wetGrip ?? null : null,
            tyreDrag: source === 'ybn' ? ybnContact?.tyreDrag ?? null : null,
            topSpeedMultiplier: source === 'ybn' ? ybnContact?.topSpeedMultiplier ?? null : null,
            materialIndex: source === 'ybn' ? ybnContact?.materialIndex ?? null : null,
            triangleOffset: source === 'ybn' ? ybnContact?.triangleOffset ?? null : null,
            trackRoadId: source === 'track' ? roadContact?.roadId ?? null : null,
            terrainZ: Number.isFinite(rawTerrainZ) ? Number(rawTerrainZ) : null,
            calibratedTerrainZ: null,
            ybnZ: Number.isFinite(ybnZ) ? Number(ybnZ) : null,
            rawYbnZ: Number.isFinite(rawYbnZ) ? Number(rawYbnZ) : null,
            ybnCalibrationOffset: ybnOffset,
            surfacePolicy: source === 'matrix-city'
                ? 'matrix-city-authored-ground'
                : source === 'track'
                ? 'derived_track_road'
                : boundedDemo
                    ? (allowAuthoredInterior ? 'aligned_ybn_then_active_mlo_floor' : 'aligned_ybn')
                    : 'aligned_ybn_then_drawable_floor',
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
        const testedDestructibles = new Set();

        // Gameplay manifests can supply simple dynamic blockers (doors, props) even
        // when their full YBN triangle data has not been exported.
        for (const blocker of this.blockers) {
            if (blocker?.destructible && this.destroyedDestructibleIds.has(blocker.id)) continue;
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
                source: blocker.destructible ? 'destructible' : 'blocker',
                label: blocker.label || blocker.id || 'blocker',
                id: blocker.id || '',
                destructible: blocker.destructible === true,
            };
            if (blocker.destructible) testedDestructibles.add(blocker.id);
        }
        // Some fragment candidates are intentionally non-blocking. They still need
        // bullet raycasts, but must not turn every low prop into an invisible wall.
        for (const destructible of this.destructibles.values()) {
            if (!destructible || testedDestructibles.has(destructible.id) || this.destroyedDestructibleIds.has(destructible.id)) continue;
            const centerZ = Number.isFinite(destructible.z) ? destructible.z + destructible.height * 0.5 : oz;
            const radius = Math.hypot(destructible.radius, destructible.height * 0.5);
            const toX = destructible.x - ox; const toY = destructible.y - oy; const toZ = centerZ - oz;
            const along = toX * unit[0] + toY * unit[1] + toZ * unit[2];
            if (along < 0.0 || along > distanceLimit || (hit && along >= hit.distance)) continue;
            const closestX = ox + unit[0] * along;
            const closestY = oy + unit[1] * along;
            const closestZ = oz + unit[2] * along;
            if (Math.hypot(destructible.x - closestX, destructible.y - closestY, centerZ - closestZ) > radius) continue;
            hit = {
                distance: along,
                point: [closestX, closestY, closestZ],
                source: 'destructible',
                label: destructible.label || destructible.id || 'fragment',
                id: destructible.id,
                destructible: true,
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
                const candidateSets = [
                    this._ybnCellCandidates(world, gx, gy),
                    this._ybnWallCellCandidates(world, gx, gy),
                ];
                for (const candidates of candidateSets) {
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
        height = 1.8,
        maxStepUp = 1.15,
        obstacleStepUp = NaN,
        maxSnapDistance = 35.0,
        maxGroundRise = maxStepUp,
        applyYbnCalibration = true,
        useDrawableProxies = this.useDrawableCollisionProxies,
    } = {}) {
        const groundOptions = {
            maxSnapDistance,
            maxRise: Math.max(0.0, finite(maxGroundRise, maxStepUp)),
            applyYbnCalibration,
        };
        const oldGround = this.resolveGround(x, y, feetZ, groundOptions);
        const rawTx = finite(x) + finite(vx) * Math.max(0.0, finite(dt));
        const rawTy = finite(y) + finite(vy) * Math.max(0.0, finite(dt));
        const bounds = this.movementBounds;
        const tx = bounds ? Math.max(bounds.minX, Math.min(bounds.maxX, rawTx)) : rawTx;
        const ty = bounds ? Math.max(bounds.minY, Math.min(bounds.maxY, rawTy)) : rawTy;
        const hitDistrictBoundary = tx !== rawTx || ty !== rawTy;
        // A stationary grounded ped has no swept path. Avoid a duplicate floor
        // probe and a full blocker broadphase on every display frame.
        if (Math.hypot(tx - finite(x), ty - finite(y)) < 1e-8 && !hitDistrictBoundary) {
            return {
                x: tx,
                y: ty,
                ground: oldGround,
                blocked: false,
                reason: '',
                vx: finite(vx),
                vy: finite(vy),
            };
        }
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

        const moveX = tx - finite(x);
        const moveY = ty - finite(y);
        const sweepOptions = {
            obstacleStepUp: Number.isFinite(Number(obstacleStepUp))
                ? Math.max(0.0, Number(obstacleStepUp))
                : Math.min(0.45, Math.max(0.0, finite(maxStepUp, 1.15))),
            useDrawableProxies: !!useDrawableProxies,
        };
        let firstSweep = this._sweepBlockers(x, y, tx, ty, feetZ, radius, height, maxStepUp, sweepOptions);
        if (firstSweep && this._tryPushAssetCollider(firstSweep.hit, moveX, moveY)) {
            firstSweep = this._sweepBlockers(x, y, tx, ty, feetZ, radius, height, maxStepUp, sweepOptions);
        }
        if (!firstSweep) {
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

        let outX = firstSweep.x;
        let outY = firstSweep.y;
        let remainingX = moveX * (1.0 - firstSweep.t);
        let remainingY = moveY * (1.0 - firstSweep.t);
        const normalX = finite(firstSweep.hit?.normalX);
        const normalY = finite(firstSweep.hit?.normalY);
        const intoWall = remainingX * normalX + remainingY * normalY;
        if (intoWall < 0.0) {
            remainingX -= normalX * intoWall;
            remainingY -= normalY * intoWall;
        }

        if (Math.hypot(remainingX, remainingY) > 1e-6) {
            const slideSweep = this._sweepBlockers(
                outX, outY,
                outX + remainingX, outY + remainingY,
                feetZ, radius, height, maxStepUp, sweepOptions,
            );
            if (slideSweep) {
                outX = slideSweep.x;
                outY = slideSweep.y;
                const secondNormalX = finite(slideSweep.hit?.normalX);
                const secondNormalY = finite(slideSweep.hit?.normalY);
                const secondDot = remainingX * secondNormalX + remainingY * secondNormalY;
                if (secondDot < 0.0) {
                    remainingX -= secondNormalX * secondDot;
                    remainingY -= secondNormalY * secondDot;
                }
            } else {
                outX += remainingX;
                outY += remainingY;
            }
        }

        const finalGround = this.resolveGround(outX, outY, feetZ, groundOptions);
        if (finalGround.z - oldGround.z > maxStepUp) {
            outX = firstSweep.x;
            outY = firstSweep.y;
        }
        const resolvedGround = this.resolveGround(outX, outY, feetZ, groundOptions);
        const projectedVelocityDot = finite(vx) * normalX + finite(vy) * normalY;
        return {
            x: outX,
            y: outY,
            ground: resolvedGround,
            blocked: true,
            reason: firstSweep.hit?.label || 'wall',
            hit: firstSweep.hit || null,
            vx: projectedVelocityDot < 0.0 ? finite(vx) - normalX * projectedVelocityDot : finite(vx),
            vy: projectedVelocityDot < 0.0 ? finite(vy) - normalY * projectedVelocityDot : finite(vy),
        };
    }

    moveVehicle({
        x,
        y,
        feetZ,
        heading = 0.0,
        vx,
        vy,
        dt,
        halfWidth = 0.9,
        halfLength = 2.0,
        chassisClearance = 0.2,
        chassisHeight = 1.15,
        wheelRadius = 0.4,
        maxStepUp = 0.65,
        maxSnapDistance = 4.0,
        applyYbnCalibration = false,
        previousGround = null,
    } = {}) {
        const startX = finite(x);
        const startY = finite(y);
        const baseZ = finite(feetZ);
        const deltaX = finite(vx) * Math.max(0.0, finite(dt));
        const deltaY = finite(vy) * Math.max(0.0, finite(dt));
        const rawTargetX = startX + deltaX;
        const rawTargetY = startY + deltaY;
        const bounds = this.movementBounds;
        const targetX = bounds ? Math.max(bounds.minX, Math.min(bounds.maxX, rawTargetX)) : rawTargetX;
        const targetY = bounds ? Math.max(bounds.minY, Math.min(bounds.maxY, rawTargetY)) : rawTargetY;
        const groundOptions = { maxSnapDistance, applyYbnCalibration };
        const cachedGround = previousGround?.ground || null;
        const canReusePreviousGround = cachedGround
            && Math.abs(finite(previousGround?.x) - startX) <= 0.08
            && Math.abs(finite(previousGround?.y) - startY) <= 0.08
            && Math.abs(finite(previousGround?.feetZ) - baseZ) <= 0.7;
        // The previous target becomes this sweep's start. Reusing that exact
        // contact avoids a duplicate YBN spatial query while retaining a fresh
        // target query and all chassis/step-up collision behavior.
        const oldGround = canReusePreviousGround
            ? cachedGround
            : this.resolveGround(startX, startY, baseZ, groundOptions);
        const targetGround = this.resolveGround(targetX, targetY, baseZ, groundOptions);
        const wheelStep = Math.max(0.2, Math.min(0.75, finite(maxStepUp, finite(wheelRadius, 0.4) * 1.4)));
        if (targetGround.z - oldGround.z > wheelStep) {
            this.lastVehicleCollision = {
                source: 'ground_step',
                label: 'suspension_step',
                x: targetX,
                y: targetY,
                rise: targetGround.z - oldGround.z,
            };
            return { x: startX, y: startY, ground: oldGround, blocked: true, reason: 'suspension_step', vx: finite(vx) * 0.12, vy: finite(vy) * 0.12 };
        }
        if (targetX !== rawTargetX || targetY !== rawTargetY) {
            return { x: targetX, y: targetY, ground: targetGround, blocked: true, reason: 'district_boundary', vx: 0.0, vy: 0.0 };
        }
        if (Math.hypot(deltaX, deltaY) < 1e-8) {
            return { x: targetX, y: targetY, ground: targetGround, blocked: false, reason: '', vx: finite(vx), vy: finite(vy) };
        }

        // Approximate GTA's separate chassis bound with three overlapping lobes
        // along the oriented body. Unlike the pedestrian capsule, their bottom
        // starts above wheel clearance, so curb faces are handled by wheel ground
        // contacts while walls, poles, vehicles, and raised props hit the chassis.
        const width = Math.max(0.45, finite(halfWidth, 0.9));
        const length = Math.max(width, finite(halfLength, 2.0));
        const probeRadius = Math.max(0.32, Math.min(width * 0.82, length * 0.42));
        const longitudinalOffset = Math.max(0.0, length - probeRadius * 0.72);
        const forwardX = Math.cos(finite(heading));
        const forwardY = Math.sin(finite(heading));
        const offsets = [-longitudinalOffset, 0.0, longitudinalOffset];
        const raisedFeetZ = baseZ + Math.max(0.08, finite(chassisClearance, 0.2));
        // Query dynamic blockers once for the full swept chassis AABB. The
        // narrow sweep still evaluates all three lobes and YBN wall triangles,
        // but no longer repeats map lookups for every substep/binary-search.
        const broadphasePadding = longitudinalOffset + probeRadius + Math.max(Math.abs(deltaX), Math.abs(deltaY)) + 0.35;
        const minX = Math.min(startX, targetX) - broadphasePadding;
        const minY = Math.min(startY, targetY) - broadphasePadding;
        const maxX = Math.max(startX, targetX) + broadphasePadding;
        const maxY = Math.max(startY, targetY) + broadphasePadding;
        const sweepOptions = {
            // Road YBNs contain short vertical faces at lane/mesh seams.  The
            // chassis used to treat every one as a wall (zero permitted rise),
            // which creates an invisible collision in otherwise flat streets.
            // The wheel/ground check above still rejects a real step; this only
            // lets the chassis clear a normal, driveable road seam or curb lip.
            obstacleStepUp: Math.min(0.28, wheelStep),
            useDrawableProxies: false,
            blockerCandidates: this._queryCircleGrid(this._blockerGrid, this._blockerCellSize, minX, minY, maxX, maxY),
            assetCandidates: this._queryCircleGrid(this._assetColliderGrid, this._assetColliderCellSize, minX, minY, maxX, maxY),
        };
        const firstVehicleSweep = (fromX, fromY, moveX, moveY) => {
            let earliest = null;
            for (const offset of offsets) {
                const ox = forwardX * offset;
                const oy = forwardY * offset;
                const sweep = this._sweepBlockers(
                    fromX + ox, fromY + oy,
                    fromX + ox + moveX, fromY + oy + moveY,
                    raisedFeetZ, probeRadius, Math.max(0.45, finite(chassisHeight, 1.15)),
                    0.0, sweepOptions,
                );
                if (sweep && (!earliest || sweep.t < earliest.t)) earliest = { ...sweep, probeOffset: offset };
            }
            return earliest;
        };

        const firstSweep = firstVehicleSweep(startX, startY, deltaX, deltaY);
        if (!firstSweep) {
            this.lastVehicleCollision = null;
            return { x: targetX, y: targetY, ground: targetGround, blocked: false, reason: '', vx: finite(vx), vy: finite(vy), surface: targetGround.material || targetGround.source || 'road' };
        }

        let outX = startX + deltaX * firstSweep.t;
        let outY = startY + deltaY * firstSweep.t;
        let remainingX = deltaX * (1.0 - firstSweep.t);
        let remainingY = deltaY * (1.0 - firstSweep.t);
        const normalX = finite(firstSweep.hit?.normalX);
        const normalY = finite(firstSweep.hit?.normalY);
        const intoWall = remainingX * normalX + remainingY * normalY;
        if (intoWall < 0.0) {
            remainingX -= normalX * intoWall;
            remainingY -= normalY * intoWall;
        }
        if (Math.hypot(remainingX, remainingY) > 1e-6) {
            const slideSweep = firstVehicleSweep(outX, outY, remainingX, remainingY);
            const slideT = slideSweep ? slideSweep.t : 1.0;
            outX += remainingX * slideT;
            outY += remainingY * slideT;
        }
        const ground = this.resolveGround(outX, outY, baseZ, groundOptions);
        const velocityDot = finite(vx) * normalX + finite(vy) * normalY;
        this.lastVehicleCollision = {
            source: String(firstSweep.hit?.source || 'collision'),
            id: firstSweep.hit?.id ? String(firstSweep.hit.id) : null,
            label: String(firstSweep.hit?.label || 'chassis'),
            x: outX,
            y: outY,
            triangleOffset: Number.isFinite(Number(firstSweep.hit?.triangleOffset)) ? Number(firstSweep.hit.triangleOffset) : null,
            chassisProbeOffset: firstSweep.probeOffset,
        };
        return {
            x: outX,
            y: outY,
            ground,
            blocked: true,
            reason: firstSweep.hit?.label || 'chassis',
            hit: { ...(firstSweep.hit || {}), chassisProbeOffset: firstSweep.probeOffset },
            vx: velocityDot < 0.0 ? finite(vx) - normalX * velocityDot : finite(vx),
            vy: velocityDot < 0.0 ? finite(vy) - normalY * velocityDot : finite(vy),
            surface: String(firstSweep.hit?.material || firstSweep.hit?.source || ground.material || ground.source || 'solid'),
        };
    }

    _refreshDrawableCollisionProxies(force = false) {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (!force && now < this._drawableCollisionRefreshAt) return;
        this._drawableCollisionRefreshAt = now + 1000.0;
        const renderer = this.app?.instancedModelRenderer;
        if (!renderer) return;

        const grid = new Map();
        const cellSize = this._drawableCollisionCellSize;
        let count = 0;
        const put = (proxy) => {
            const extentX = Math.abs(proxy.axisXX) * proxy.halfX + Math.abs(proxy.axisYX) * proxy.halfY;
            const extentY = Math.abs(proxy.axisXY) * proxy.halfX + Math.abs(proxy.axisYY) * proxy.halfY;
            const gx0 = Math.floor((proxy.x - extentX) / cellSize);
            const gy0 = Math.floor((proxy.y - extentY) / cellSize);
            const gx1 = Math.floor((proxy.x + extentX) / cellSize);
            const gy1 = Math.floor((proxy.y + extentY) / cellSize);
            for (let gy = gy0; gy <= gy1; gy++) {
                for (let gx = gx0; gx <= gx1; gx++) {
                    const key = `${gx}:${gy}`;
                    let bucket = grid.get(key);
                    if (!bucket) { bucket = []; grid.set(key, bucket); }
                    bucket.push(proxy);
                }
            }
            count++;
        };
        const addInstances = (entry, bounds, label) => {
            const data = entry?.instanceData;
            const stride = Math.max(16, Math.floor(finite(entry?.instanceStrideFloats, 16)));
            const min = bounds?.min;
            const max = bounds?.max;
            if (!(data instanceof Float32Array) || !min || !max) return;
            const localMin = [finite(min[0], NaN), finite(min[1], NaN), finite(min[2], NaN)];
            const localMax = [finite(max[0], NaN), finite(max[1], NaN), finite(max[2], NaN)];
            if (![...localMin, ...localMax].every(Number.isFinite)) return;
            const localHalfX = Math.abs(localMax[0] - localMin[0]) * 0.5;
            const localHalfY = Math.abs(localMax[1] - localMin[1]) * 0.5;
            const center = [
                (localMin[0] + localMax[0]) * 0.5,
                (localMin[1] + localMax[1]) * 0.5,
                (localMin[2] + localMax[2]) * 0.5,
            ];
            for (let off = 0; off + 15 < data.length; off += stride) {
                const scaleX = Math.hypot(data[off], data[off + 1]);
                const scaleY = Math.hypot(data[off + 4], data[off + 5]);
                if (scaleX < 1e-6 || scaleY < 1e-6) continue;
                const halfX = localHalfX * scaleX;
                const halfY = localHalfY * scaleY;
                const horizontalSize = Math.max(halfX * 2.0, halfY * 2.0);
                if (horizontalSize < 0.08 || horizontalSize > 12.0) continue;

                const worldCenterX = data[off] * center[0] + data[off + 4] * center[1] + data[off + 8] * center[2] + data[off + 12];
                const worldCenterY = data[off + 1] * center[0] + data[off + 5] * center[1] + data[off + 9] * center[2] + data[off + 13];
                let minZ = Number.POSITIVE_INFINITY;
                let maxZ = Number.NEGATIVE_INFINITY;
                for (let ix = 0; ix < 2; ix++) {
                    for (let iy = 0; iy < 2; iy++) {
                        for (let iz = 0; iz < 2; iz++) {
                            const lx = ix ? localMax[0] : localMin[0];
                            const ly = iy ? localMax[1] : localMin[1];
                            const lz = iz ? localMax[2] : localMin[2];
                            const wz = data[off + 2] * lx + data[off + 6] * ly + data[off + 10] * lz + data[off + 14];
                            minZ = Math.min(minZ, wz);
                            maxZ = Math.max(maxZ, wz);
                        }
                    }
                }
                const worldHeight = maxZ - minZ;
                if (!Number.isFinite(worldCenterX) || !Number.isFinite(worldCenterY) || worldHeight < 0.3 || worldHeight > 25.0) continue;
                if (worldHeight < 0.45 && horizontalSize > 2.0) continue;
                put({
                    source: 'drawable_bounds',
                    label: String(label || 'object'),
                    x: worldCenterX,
                    y: worldCenterY,
                    minZ,
                    maxZ,
                    halfX,
                    halfY,
                    axisXX: data[off] / scaleX,
                    axisXY: data[off + 1] / scaleX,
                    axisYX: data[off + 4] / scaleY,
                    axisYY: data[off + 5] / scaleY,
                });
            }
        };

        for (const entry of renderer.instances?.values?.() || []) {
            let min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
            let max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
            let found = false;
            for (const sm of entry?.submeshes?.values?.() || []) {
                const bounds = sm?.mesh?.bounds;
                if (!bounds?.min || !bounds?.max || sm?.file === '__placeholder__') continue;
                found = true;
                for (let axis = 0; axis < 3; axis++) {
                    min[axis] = Math.min(min[axis], finite(bounds.min[axis], min[axis]));
                    max[axis] = Math.max(max[axis], finite(bounds.max[axis], max[axis]));
                }
            }
            if (found) addInstances(entry, { min, max }, `object:${entry.hash}`);
        }
        for (const entry of renderer.buckets?.values?.() || []) {
            if (entry?.mesh?.bounds) addInstances(entry, entry.mesh.bounds, `object:${entry.file || entry.bucketId}`);
        }
        this._drawableCollisionGrid = grid;
        this.drawableCollisionProxyCount = count;
    }

    _firstObbGridHit(grid, cellSize, x, y, feetZ, radius, height, maxStepUp, moveX, moveY, obstacleStepUp = NaN, ignoreId = '', candidates = null, preserveDoorCollision = false) {
        if (!grid?.size) return null;
        // A doorway can cut through a neighboring wall/foliage proxy whose
        // conservative OBB overlaps the authored opening. Clear the complete
        // passage while the door is open, not only the moving door collider.
        if (!preserveDoorCollision && this._isOpenDoorPassage(x, y, feetZ, height, radius)) return null;
        const r = Math.max(0.05, finite(radius, 0.38));
        const gx0 = Math.floor((finite(x) - r) / cellSize);
        const gy0 = Math.floor((finite(y) - r) / cellSize);
        const gx1 = Math.floor((finite(x) + r) / cellSize);
        const gy1 = Math.floor((finite(y) + r) / cellSize);
        const tested = new Set();
        let best = null;
        const visit = (proxy) => {
            if (tested.has(proxy)) return;
            tested.add(proxy);
            if (ignoreId && proxy.id === ignoreId) return;
            if (!preserveDoorCollision && this._isOpenDoorCollider(proxy)) return;
            if (proxy.destructibleId && this.destroyedDestructibleIds.has(proxy.destructibleId)) return;
            if (finite(feetZ) + finite(height, 1.8) < proxy.minZ || finite(feetZ) > proxy.maxZ) return;
            const walkableRise = Number.isFinite(Number(obstacleStepUp))
                ? Math.max(0.0, Math.min(1.25, Number(obstacleStepUp)))
                : Math.min(0.45, Math.max(0.0, finite(maxStepUp, 1.15)));
            if (proxy.maxZ <= finite(feetZ) + walkableRise + 0.03) return;
            const dx = finite(x) - proxy.x;
            const dy = finite(y) - proxy.y;
            const localX = dx * proxy.axisXX + dy * proxy.axisXY;
            const localY = dx * proxy.axisYX + dy * proxy.axisYY;
            const nearX = Math.max(-proxy.halfX, Math.min(proxy.halfX, localX));
            const nearY = Math.max(-proxy.halfY, Math.min(proxy.halfY, localY));
            let deltaX = localX - nearX;
            let deltaY = localY - nearY;
            let distanceSq = deltaX * deltaX + deltaY * deltaY;
            if (distanceSq > r * r || (best && distanceSq >= best.distanceSq)) return;
            if (distanceSq < 1e-10) {
                const escapeX = proxy.halfX - Math.abs(localX);
                const escapeY = proxy.halfY - Math.abs(localY);
                if (escapeX < escapeY) { deltaX = localX >= 0 ? 1 : -1; deltaY = 0; }
                else { deltaX = 0; deltaY = localY >= 0 ? 1 : -1; }
                distanceSq = 0;
            }
            const localLength = Math.hypot(deltaX, deltaY) || 1.0;
            const localNormalX = deltaX / localLength;
            const localNormalY = deltaY / localLength;
            const normalX = localNormalX * proxy.axisXX + localNormalY * proxy.axisYX;
            const normalY = localNormalX * proxy.axisXY + localNormalY * proxy.axisYY;
            if (Math.hypot(moveX, moveY) > 1e-8 && moveX * normalX + moveY * normalY >= -1e-7) return;
            best = { ...proxy, distanceSq, normalX, normalY, _collider: proxy };
        };
        if (Array.isArray(candidates)) {
            for (const proxy of candidates) visit(proxy);
        } else {
            for (let gy = gy0; gy <= gy1; gy++) {
                for (let gx = gx0; gx <= gx1; gx++) {
                    for (const proxy of grid.get(`${gx}:${gy}`) || []) visit(proxy);
                }
            }
        }
        return best;
    }

    _firstDrawableProxyHit(x, y, feetZ, radius, height, maxStepUp, moveX, moveY, obstacleStepUp = NaN) {
        this._refreshDrawableCollisionProxies();
        return this._firstObbGridHit(
            this._drawableCollisionGrid,
            this._drawableCollisionCellSize,
            x, y, feetZ, radius, height, maxStepUp, moveX, moveY, obstacleStepUp,
        );
    }

    _firstAssetColliderHit(x, y, feetZ, radius, height, maxStepUp, moveX, moveY, obstacleStepUp = NaN, candidates = null) {
        return this._firstObbGridHit(
            this._assetColliderGrid,
            this._assetColliderCellSize,
            x, y, feetZ, radius, height, maxStepUp, moveX, moveY, obstacleStepUp, '', candidates,
        );
    }

    _firstDynamicDoorHit(x, y, feetZ, radius, height, maxStepUp, moveX, moveY, obstacleStepUp = NaN) {
        this._rebuildDynamicDoorColliderGrid();
        return this._firstObbGridHit(
            this._dynamicDoorColliderGrid,
            this._dynamicDoorColliderCellSize,
            x, y, feetZ, radius, height, maxStepUp, moveX, moveY,
            obstacleStepUp, '', null, true,
        );
    }

    _firstBlockerHit(x, y, feetZ, radius, height = 1.8, maxStepUp = 1.15, moveX = 0.0, moveY = 0.0, options = {}) {
        const z = Number(feetZ);
        const blockerCandidates = Array.isArray(options.blockerCandidates) ? options.blockerCandidates : this._queryCircleGrid(
            this._blockerGrid,
            this._blockerCellSize,
            finite(x) - finite(radius, 0.38),
            finite(y) - finite(radius, 0.38),
            finite(x) + finite(radius, 0.38),
            finite(y) + finite(radius, 0.38),
        );
        for (const b of blockerCandidates) {
            if (b?.destructible && this.destroyedDestructibleIds.has(b.id)) continue;
            if (Number.isFinite(b.z) && Number.isFinite(z)) {
                const minZ = b.z - 0.25;
                const maxZ = b.z + b.height;
                if (z > maxZ || z + 1.8 < minZ) continue;
            }
            const r = finite(radius, 0.38) + finite(b.radius, 0.8);
            const dx = finite(x) - finite(b.x);
            const dy = finite(y) - finite(b.y);
            const distanceSq = dx * dx + dy * dy;
            if (distanceSq > r * r) continue;
            const distance = Math.sqrt(distanceSq);
            let normalX = distance > 1e-7 ? dx / distance : -finite(moveX, 1.0);
            let normalY = distance > 1e-7 ? dy / distance : -finite(moveY);
            const normalLength = Math.hypot(normalX, normalY) || 1.0;
            normalX /= normalLength;
            normalY /= normalLength;
            if (Math.hypot(moveX, moveY) > 1e-8 && moveX * normalX + moveY * normalY >= -1e-7) continue;
            return { ...b, source: 'blocker', distanceSq, normalX, normalY };
        }
        const dynamicDoorHit = this._firstDynamicDoorHit(
            x, y, feetZ, radius, height, maxStepUp, moveX, moveY,
            options.obstacleStepUp,
        );
        if (dynamicDoorHit) return dynamicDoorHit;
        const assetHit = this._firstAssetColliderHit(
            x, y, feetZ, radius, height, maxStepUp, moveX, moveY,
            options.obstacleStepUp,
            options.assetCandidates,
        );
        if (assetHit) return assetHit;
        if (options.useDrawableProxies) {
            const drawableHit = this._firstDrawableProxyHit(
                x, y, feetZ, radius, height, maxStepUp, moveX, moveY,
                options.obstacleStepUp,
            );
            if (drawableHit) return drawableHit;
        }
        return this._firstYbnWallHit(
            x, y, feetZ, radius, height, maxStepUp, moveX, moveY,
            options.obstacleStepUp,
        );
    }

    _sweepBlockers(fromX, fromY, toX, toY, feetZ, radius, height = 1.8, maxStepUp = 1.15, options = {}) {
        const dx = finite(toX) - finite(fromX);
        const dy = finite(toY) - finite(fromY);
        const distance = Math.hypot(dx, dy);
        if (distance < 1e-8) return null;
        const stepLength = Math.max(0.04, finite(radius, 0.38) * 0.35);
        const steps = Math.max(1, Math.ceil(distance / stepLength));
        let clearT = 0.0;
        for (let step = 1; step <= steps; step++) {
            const t = step / steps;
            let hit = this._firstBlockerHit(
                finite(fromX) + dx * t,
                finite(fromY) + dy * t,
                feetZ, radius, height, maxStepUp, dx, dy, options,
            );
            if (!hit) {
                clearT = t;
                continue;
            }
            let blockedT = t;
            for (let iteration = 0; iteration < 8; iteration++) {
                const midT = (clearT + blockedT) * 0.5;
                const midHit = this._firstBlockerHit(
                    finite(fromX) + dx * midT,
                    finite(fromY) + dy * midT,
                    feetZ, radius, height, maxStepUp, dx, dy, options,
                );
                if (midHit) {
                    blockedT = midT;
                    hit = midHit;
                } else {
                    clearT = midT;
                }
            }
            return {
                t: clearT,
                blockedT,
                x: finite(fromX) + dx * clearT,
                y: finite(fromY) + dy * clearT,
                hit,
            };
        }
        return null;
    }

    _capsuleTriangleContact(px, py, feetZ, radius, height, ax, ay, az, bx, by, bz, cx, cy, cz) {
        const r = Math.max(0.01, finite(radius, 0.38));
        const capsuleHeight = Math.max(r * 2.0, finite(height, 1.8));
        const segmentMinZ = feetZ + r;
        const segmentMaxZ = feetZ + capsuleHeight - r;
        const closestTriangle = this._triangleClosest;
        const closestSegments = this._segmentClosest;
        const intersection = this._triangleIntersection;
        let bestDistanceSq = Number.POSITIVE_INFINITY;
        let capsuleX = px; let capsuleY = py; let capsuleZ = segmentMinZ;
        let triangleX = ax; let triangleY = ay; let triangleZ = az;
        const save = (sx, sy, sz, tx, ty, tz) => {
            const dx = sx - tx; const dy = sy - ty; const dz = sz - tz;
            const distanceSq = dx * dx + dy * dy + dz * dz;
            if (distanceSq >= bestDistanceSq) return;
            bestDistanceSq = distanceSq;
            capsuleX = sx; capsuleY = sy; capsuleZ = sz;
            triangleX = tx; triangleY = ty; triangleZ = tz;
        };

        if (segmentIntersectsTriangle(px, py, segmentMinZ, px, py, segmentMaxZ, ax, ay, az, bx, by, bz, cx, cy, cz, intersection)) {
            save(intersection[0], intersection[1], intersection[2], intersection[0], intersection[1], intersection[2]);
        } else {
            closestPointOnTriangle(px, py, segmentMinZ, ax, ay, az, bx, by, bz, cx, cy, cz, closestTriangle);
            save(px, py, segmentMinZ, closestTriangle[0], closestTriangle[1], closestTriangle[2]);
            closestPointOnTriangle(px, py, segmentMaxZ, ax, ay, az, bx, by, bz, cx, cy, cz, closestTriangle);
            save(px, py, segmentMaxZ, closestTriangle[0], closestTriangle[1], closestTriangle[2]);
            for (const edge of [[ax, ay, az, bx, by, bz], [bx, by, bz, cx, cy, cz], [cx, cy, cz, ax, ay, az]]) {
                closestSegmentSegment(px, py, segmentMinZ, px, py, segmentMaxZ, ...edge, closestSegments);
                save(
                    closestSegments[0], closestSegments[1], closestSegments[2],
                    closestSegments[3], closestSegments[4], closestSegments[5],
                );
            }
        }
        return { bestDistanceSq, capsuleX, capsuleY, capsuleZ, triangleX, triangleY, triangleZ };
    }

    _firstYbnWallHit(x, y, feetZ, radius, height = 1.8, maxStepUp = 1.15, moveX = 0.0, moveY = 0.0, obstacleStepUp = NaN) {
        const args = [x, y, feetZ, radius, height, maxStepUp, moveX, moveY, obstacleStepUp];
        return this._firstTriangleWorldWallHit(this.derivedTrackGround, 0.0, 'track_wall', ...args)
            || this._firstTriangleWorldWallHit(this.ybnGround, Number(this.ybnGroundOffset) || 0.0, 'ybn_wall', ...args);
    }

    _firstTriangleWorldWallHit(world, offsetZ, source, x, y, feetZ, radius, height = 1.8, maxStepUp = 1.15, moveX = 0.0, moveY = 0.0, obstacleStepUp = NaN) {
        if (!world?.wallGrid || !world?.vertices || !world?.indices) return null;
        const px = Number(x); const py = Number(y); const pz = Number(feetZ);
        const r = Math.max(0.05, finite(radius, 0.38));
        const capsuleHeight = Math.max(0.2, finite(height, 1.8));
        if (![px, py, pz].every(Number.isFinite)) return null;
        if (this._isOpenDoorPassage(px, py, pz, capsuleHeight, r)) return null;
        const gx0 = Math.floor((px - r) / world.cellSize);
        const gy0 = Math.floor((py - r) / world.cellSize);
        const gx1 = Math.floor((px + r) / world.cellSize);
        const gy1 = Math.floor((py + r) / world.cellSize);
        const capsuleMinZ = pz;
        const capsuleMaxZ = pz + capsuleHeight;
        const worldOffsetZ = Number(offsetZ) || 0.0;
        const radiusSq = r * r;
        const tested = new Set();
        let best = null;

        for (let gy = gy0; gy <= gy1; gy++) {
            for (let gx = gx0; gx <= gx1; gx++) {
                const candidates = this._ybnWallCellCandidates(world, gx, gy);
                if (!candidates) continue;
                for (const offset of candidates) {
                    if (tested.has(offset)) continue;
                    tested.add(offset);
                    const ia = world.indices[offset] * 3;
                    const ib = world.indices[offset + 1] * 3;
                    const ic = world.indices[offset + 2] * 3;
                    const ax = world.vertices[ia], ay = world.vertices[ia + 1], az = world.vertices[ia + 2] + worldOffsetZ;
                    const bx = world.vertices[ib], by = world.vertices[ib + 1], bz = world.vertices[ib + 2] + worldOffsetZ;
                    const cx = world.vertices[ic], cy = world.vertices[ic + 1], cz = world.vertices[ic + 2] + worldOffsetZ;
                    if (this._isYbnCollisionExcluded(ax, ay, az, bx, by, bz, cx, cy, cz)) continue;
                    const triangleMinZ = Math.min(az, bz, cz);
                    const triangleMaxZ = Math.max(az, bz, cz);
                    const walkableRise = Number.isFinite(Number(obstacleStepUp))
                        ? Math.max(0.0, Math.min(1.25, Number(obstacleStepUp)))
                        : Math.min(0.45, Math.max(0.0, finite(maxStepUp, 1.15)));
                    if (triangleMaxZ <= pz + walkableRise + 0.03) continue;
                    if (capsuleMaxZ < triangleMinZ - 0.04 || capsuleMinZ > triangleMaxZ + 0.04) continue;
                    if (
                        px + r < Math.min(ax, bx, cx) || px - r > Math.max(ax, bx, cx)
                        || py + r < Math.min(ay, by, cy) || py - r > Math.max(ay, by, cy)
                    ) continue;
                    const contact = this._capsuleTriangleContact(
                        px, py, pz, r, capsuleHeight,
                        ax, ay, az, bx, by, bz, cx, cy, cz,
                    );
                    // Tourist-entry gate WALL meshes cross the authored AI
                    // driving centerline in two places. Treat only the narrow,
                    // metadata-derived inner corridor over TRM-NRM as open;
                    // side walls and guardrails retain normal collision.
                    if (source === 'track_wall' && this._isDerivedTrackCorridorWall(world, offset, contact.triangleX, contact.triangleY, contact.triangleZ)) continue;
                    const distanceSq = contact.bestDistanceSq;
                    if (distanceSq > radiusSq || (best && distanceSq >= best.distanceSq)) continue;
                    let normalX = contact.capsuleX - contact.triangleX;
                    let normalY = contact.capsuleY - contact.triangleY;
                    let normalLength = Math.hypot(normalX, normalY);
                    if (normalLength < 1e-7) {
                        const e1x = bx - ax; const e1y = by - ay; const e1z = bz - az;
                        const e2x = cx - ax; const e2y = cy - ay; const e2z = cz - az;
                        normalX = e1y * e2z - e1z * e2y;
                        normalY = e1z * e2x - e1x * e2z;
                        normalLength = Math.hypot(normalX, normalY);
                        if (normalLength < 1e-7) continue;
                        normalX /= normalLength;
                        normalY /= normalLength;
                        if (moveX * normalX + moveY * normalY > 0.0) {
                            normalX = -normalX;
                            normalY = -normalY;
                        }
                    } else {
                        normalX /= normalLength;
                        normalY /= normalLength;
                    }
                    if (Math.hypot(moveX, moveY) > 1e-8 && moveX * normalX + moveY * normalY >= -1e-7) continue;
                    best = {
                        source,
                        label: 'wall',
                        triangleOffset: Number(offset),
                        distanceSq,
                        normalX,
                        normalY,
                    };
                }
            }
        }
        return best;
    }
}

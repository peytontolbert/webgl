/**
 * Build static collision proxies for the bounded /demo district.
 *
 * The normal YBN tile contains the map's large collision geometry, but it does
 * not include every independent YDR/YFT prop instance.  This derives compact
 * oriented bounds from the actual exported archetype mesh bounds and applies
 * the ENT1 instance transform once at build time.  Runtime movement can then
 * query a small spatial grid without depending on render residency.
 */

import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assets = path.resolve(__dirname, '..', 'assets');
const MIN_HORIZONTAL_SIZE = 0.12;
const MAX_HORIZONTAL_SIZE = 8.0;
const MIN_HEIGHT = 0.25;
const MAX_HEIGHT = 10.0;
const MIN_BUILDING_HORIZONTAL_SIZE = 8.0;
// Larger bounds are compound map/LOD blocks spanning roads and openings. Their
// authored YBN triangles remain authoritative; a rectangular fallback is only
// precise enough for individual structures.
const MAX_BUILDING_HORIZONTAL_SIZE = 40.0;
const MIN_BUILDING_NARROW_SIZE = 3.0;
const MIN_BUILDING_HEIGHT = 6.0;
const BUILDING_WALL_THICKNESS = 0.35;
const MIN_FOLIAGE_TRUNK_HEIGHT = 2.5;
const MIN_FOLIAGE_TRUNK_WIDTH = 1.0;
const MIN_FOLIAGE_TRUNK_HALF_SIZE = 0.18;
const MAX_FOLIAGE_TRUNK_HALF_SIZE = 0.65;
const meshFileBounds = new Map();
// Pedestrian-pushable props only. Heavy GTA fragments remain static until the
// runtime has a separate vehicle/impact rigid-body response.
const PUSHABLE_PROP_PATH = /(?:prop_(?:bin_[a-z0-9]+|(?:box|crate)pile[a-z0-9_]*|rub_(?:binbag|boxpile|cardpile)[a-z0-9_]*|skid_(?:box|trolley)[a-z0-9_]*|barrier_work[a-z0-9_]*|consign[a-z0-9_]*))/i;

function argumentValue(name, fallback) {
    const index = process.argv.indexOf(name);
    return index >= 0 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]) : fallback;
}

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function readEnt1(buffer, file) {
    if (buffer.length < 8 || buffer.toString('ascii', 0, 4) !== 'ENT1') {
        throw new Error(`${file} is not an ENT1 tile`);
    }
    const count = buffer.readUInt32LE(4);
    for (const stride of [64, 48, 44]) {
        if (buffer.length === 8 + count * stride) return { count, stride };
    }
    throw new Error(`${file} has an unsupported ENT1 record size`);
}

function rotate(qx, qy, qz, qw, x, y, z) {
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    return [
        ix * qw + iw * -qx + iy * -qz - iz * -qy,
        iy * qw + iw * -qy + iz * -qx - ix * -qz,
        iz * qw + iw * -qz + ix * -qy - iy * -qx,
    ];
}

function transformedPoint(transform, x, y, z) {
    const rotated = rotate(
        transform.qx, transform.qy, transform.qz, transform.qw,
        x * transform.sx, y * transform.sy, z * transform.sz,
    );
    return [transform.x + rotated[0], transform.y + rotated[1], transform.z + rotated[2]];
}

function hasFoliageMaterials(mesh) {
    let foundMaterial = false;
    let foundNonFoliage = false;
    for (const lod of Object.values(mesh?.lods || {})) {
        for (const submesh of lod?.submeshes || []) {
            const material = submesh?.material || {};
            const name = `${material.shaderName || ''} ${material.diffuseName || ''}`.toLowerCase();
            if (!name.trim()) continue;
            foundMaterial = true;
            if (!name.includes('tree') && !name.includes('foliage') && !name.includes('branch') && !name.includes('leaves')) {
                foundNonFoliage = true;
            }
        }
    }
    return foundMaterial && !foundNonFoliage;
}

function halfToFloat(value) {
    const sign = value & 0x8000 ? -1 : 1;
    const exponent = (value >>> 10) & 0x1f;
    const fraction = value & 0x03ff;
    if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
    if (exponent === 0x1f) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
    return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function boundsFromMeshBuffer(buffer) {
    if (buffer.length < 20 || buffer.toString('ascii', 0, 4) !== 'MSH0') return null;
    const version = buffer.readUInt32LE(4);
    const vertexCount = buffer.readUInt32LE(8);
    if (version < 1 || version > 10 || vertexCount < 1) return null;
    if (version === 10) {
        if (buffer.length < 44) return null;
        const min = [buffer.readFloatLE(20), buffer.readFloatLE(24), buffer.readFloatLE(28)];
        const extent = [buffer.readFloatLE(32), buffer.readFloatLE(36), buffer.readFloatLE(40)];
        const max = min.map((value, axis) => value + extent[axis]);
        return [...min, ...max].every(Number.isFinite) ? { min, max } : null;
    }

    const packed = version >= 9;
    const stride = packed ? 6 : 12;
    if (20 + vertexCount * stride > buffer.length) return null;
    const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    let offset = 20;
    for (let vertex = 0; vertex < vertexCount; vertex++, offset += stride) {
        for (let axis = 0; axis < 3; axis++) {
            const value = packed
                ? halfToFloat(buffer.readUInt16LE(offset + axis * 2))
                : buffer.readFloatLE(offset + axis * 4);
            if (!Number.isFinite(value)) return null;
            min[axis] = Math.min(min[axis], value);
            max[axis] = Math.max(max[axis], value);
        }
    }
    return { min, max };
}

async function readMeshReference(file) {
    const packed = /^@demo-pack\/([^#]+)#(\d+):(\d+)$/.exec(file);
    if (!packed) return readFile(path.join(assets, 'models', file));
    const [, packName, offsetText, lengthText] = packed;
    const offset = Number(offsetText);
    const length = Number(lengthText);
    const handle = await open(path.join(assets, 'demo', 'packs', packName), 'r');
    try {
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

async function boundsForMeshFile(file) {
    if (!meshFileBounds.has(file)) {
        meshFileBounds.set(file, readMeshReference(file)
            .then(boundsFromMeshBuffer)
            .catch(() => null));
    }
    return meshFileBounds.get(file);
}

async function deriveMeshBounds(mesh) {
    for (const lodName of ['high', 'med', 'low', 'vlow']) {
        const submeshes = mesh?.lods?.[lodName]?.submeshes;
        if (!Array.isArray(submeshes) || !submeshes.length) continue;
        const bounds = (await Promise.all(submeshes
            .map((submesh) => String(submesh?.file || '').trim())
            .filter(Boolean)
            .map(boundsForMeshFile))).filter(Boolean);
        if (!bounds.length) continue;
        return {
            min: [0, 1, 2].map((axis) => Math.min(...bounds.map((item) => item.min[axis]))),
            max: [0, 1, 2].map((axis) => Math.max(...bounds.map((item) => item.max[axis]))),
        };
    }
    return null;
}

function buildingShellColliders(base) {
    const wallHalf = BUILDING_WALL_THICKNESS * 0.5;
    const alongXHalf = Math.max(wallHalf, base.halfX);
    const alongYHalf = Math.max(wallHalf, base.halfY - BUILDING_WALL_THICKNESS);
    const make = (suffix, localX, localY, halfX, halfY) => ({
        ...base,
        id: `${base.id}:shell:${suffix}`,
        x: Number((base.x + localX * base.axisXX + localY * base.axisYX).toFixed(4)),
        y: Number((base.y + localX * base.axisXY + localY * base.axisYY).toFixed(4)),
        halfX: Number(halfX.toFixed(4)),
        halfY: Number(halfY.toFixed(4)),
        source: 'exported_building_shell',
    });
    return [
        make('north', 0, base.halfY - wallHalf, alongXHalf, wallHalf),
        make('south', 0, -base.halfY + wallHalf, alongXHalf, wallHalf),
        make('east', base.halfX - wallHalf, 0, wallHalf, alongYHalf),
        make('west', -base.halfX + wallHalf, 0, wallHalf, alongYHalf),
    ];
}

function orientedBounds(hash, index, transform, mesh) {
    const bounds = mesh?.bounds;
    const min = Array.isArray(bounds?.min) ? bounds.min.map(Number) : null;
    const max = Array.isArray(bounds?.max) ? bounds.max.map(Number) : null;
    if (!min || !max || min.length < 3 || max.length < 3 || ![...min, ...max].every(Number.isFinite)) return null;
    const center = [(min[0] + max[0]) * 0.5, (min[1] + max[1]) * 0.5, (min[2] + max[2]) * 0.5];
    const localHalfX = Math.abs(max[0] - min[0]) * 0.5;
    const localHalfY = Math.abs(max[1] - min[1]) * 0.5;
    if (localHalfX < 0.01 || localHalfY < 0.01) return null;

    const worldCenter = transformedPoint(transform, ...center);
    const xAxis = rotate(transform.qx, transform.qy, transform.qz, transform.qw, transform.sx, 0, 0);
    const yAxis = rotate(transform.qx, transform.qy, transform.qz, transform.qw, 0, transform.sy, 0);
    const xLength = Math.hypot(xAxis[0], xAxis[1]);
    const yLength = Math.hypot(yAxis[0], yAxis[1]);
    if (xLength < 1e-4 && yLength < 1e-4) return null;

    // Project a potentially tilted 3D box onto an orthonormal ground-plane OBB.
    // The raw projected axes are not perpendicular after pitch or roll, which
    // can otherwise leave gaps in a capsule collision test.
    const axisXX = xLength >= 1e-4 ? xAxis[0] / xLength : -yAxis[1] / yLength;
    const axisXY = xLength >= 1e-4 ? xAxis[1] / xLength : yAxis[0] / yLength;
    const axisYX = -axisXY;
    const axisYY = axisXX;
    const halfX = Math.abs(localHalfX * (xAxis[0] * axisXX + xAxis[1] * axisXY))
        + Math.abs(localHalfY * (yAxis[0] * axisXX + yAxis[1] * axisXY));
    const halfY = Math.abs(localHalfX * (xAxis[0] * axisYX + xAxis[1] * axisYY))
        + Math.abs(localHalfY * (yAxis[0] * axisYX + yAxis[1] * axisYY));
    const horizontalSize = Math.max(halfX * 2, halfY * 2);

    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const px of [min[0], max[0]]) {
        for (const py of [min[1], max[1]]) {
            for (const pz of [min[2], max[2]]) {
                const point = transformedPoint(transform, px, py, pz);
                minZ = Math.min(minZ, point[2]);
                maxZ = Math.max(maxZ, point[2]);
            }
        }
    }
    const height = maxZ - minZ;
    if (!Number.isFinite(height) || horizontalSize < MIN_HORIZONTAL_SIZE || height < MIN_HEIGHT) return null;

    const base = {
        id: `asset:${hash}:${index}`,
        archetypeHash: String(hash),
        x: Number(worldCenter[0].toFixed(4)),
        y: Number(worldCenter[1].toFixed(4)),
        minZ: Number(minZ.toFixed(4)),
        maxZ: Number(maxZ.toFixed(4)),
        halfX: Number(halfX.toFixed(4)),
        halfY: Number(halfY.toFixed(4)),
        axisXX: Number(axisXX.toFixed(6)),
        axisXY: Number(axisXY.toFixed(6)),
        axisYX: Number(axisYX.toFixed(6)),
        axisYY: Number(axisYY.toFixed(6)),
        source: 'exported_asset_bounds',
    };
    const narrowSize = Math.min(halfX * 2, halfY * 2);
    // Foliage cards can be several metres wide but are never solid boxes.
    // Classify them before the generic prop path so only a compact trunk proxy
    // participates in movement collision.
    if (hasFoliageMaterials(mesh)
        && height >= MIN_FOLIAGE_TRUNK_HEIGHT
        && horizontalSize >= MIN_FOLIAGE_TRUNK_WIDTH) {
        const trunkHalfSize = Math.min(
            MAX_FOLIAGE_TRUNK_HALF_SIZE,
            Math.max(MIN_FOLIAGE_TRUNK_HALF_SIZE, narrowSize * 0.075),
        );
        return [{
            ...base,
            halfX: Number(trunkHalfSize.toFixed(4)),
            halfY: Number(trunkHalfSize.toFixed(4)),
            source: 'exported_foliage_trunk',
        }];
    }
    const propSuitable = horizontalSize <= MAX_HORIZONTAL_SIZE
        && height <= MAX_HEIGHT
        && !(height < 0.45 && horizontalSize > 1.2);
    if (propSuitable) return [base];

    const buildingSuitable = horizontalSize > MIN_BUILDING_HORIZONTAL_SIZE
        && horizontalSize <= MAX_BUILDING_HORIZONTAL_SIZE
        && narrowSize >= MIN_BUILDING_NARROW_SIZE
        && height >= MIN_BUILDING_HEIGHT
        && !hasFoliageMaterials(mesh);
    return buildingSuitable ? buildingShellColliders(base) : null;
}

async function main() {
    const entityPath = argumentValue('--entities', path.join(assets, 'demo', 'spawn_district_entities_mlo.bin'));
    const modelPath = argumentValue('--models', path.join(assets, 'demo', 'spawn_district_models_compressed_v2.json'));
    const destructiblePath = argumentValue('--destructibles', path.join(assets, 'demo', 'spawn_district_destructibles.json'));
    const overridesPath = argumentValue('--overrides', path.join(assets, 'demo', 'spawn_district_collision_overrides.json'));
    const outputPath = argumentValue('--output', path.join(assets, 'demo', 'spawn_district_asset_colliders.json'));
    const descriptorPath = argumentValue('--descriptor', path.join(assets, 'demo', 'spawn_district.json'));
    const entities = await readFile(entityPath);
    const { count, stride } = readEnt1(entities, entityPath);
    const modelManifest = JSON.parse(await readFile(modelPath, 'utf8'));
    const destructibleManifest = JSON.parse(await readFile(destructiblePath, 'utf8'));
    let overrides = {};
    try {
        overrides = JSON.parse(await readFile(overridesPath, 'utf8'));
    } catch {
        // Overrides are optional for districts that do not need authored openings.
    }
    const meshes = modelManifest?.meshes || {};
    const destructiblesById = new Map((destructibleManifest?.destructibles || [])
        .map((item) => [String(item?.id || '').trim(), item])
        .filter(([id]) => id));
    const destructibleProfileByHash = new Map();
    for (const item of destructibleManifest?.destructibles || []) {
        const hash = String(item?.archetypeHash || '').trim();
        if (hash && !destructibleProfileByHash.has(hash)) destructibleProfileByHash.set(hash, item);
    }
    const disabledColliderIds = new Set((overrides?.disabledColliderIds || []).map(String));
    const disabledColliderRegions = Array.isArray(overrides?.disabledColliderRegions) ? overrides.disabledColliderRegions : [];
    const ybnCollisionExclusions = Array.isArray(overrides?.ybnCollisionExclusions) ? overrides.ybnCollisionExclusions : [];
    const view = new DataView(entities.buffer, entities.byteOffset, entities.byteLength);
    const colliders = [];
    const skipped = { missingBounds: 0, unsuitableBounds: 0 };
    let buildingShellCount = 0;
    let foliageTrunkCount = 0;
    let derivedBoundsCount = 0;

    for (let index = 0; index < count; index++) {
        const offset = 8 + index * stride;
        const hash = String(view.getUint32(offset, true));
        const mesh = meshes[hash];
        let bounds = mesh?.bounds || null;
        if (!bounds && mesh) {
            bounds = await deriveMeshBounds(mesh);
            if (bounds) derivedBoundsCount++;
        }
        if (!bounds) {
            skipped.missingBounds++;
            continue;
        }
        const transform = {
            x: view.getFloat32(offset + 4, true),
            y: view.getFloat32(offset + 8, true),
            z: view.getFloat32(offset + 12, true),
            qx: view.getFloat32(offset + 16, true),
            qy: view.getFloat32(offset + 20, true),
            qz: view.getFloat32(offset + 24, true),
            qw: view.getFloat32(offset + 28, true),
            sx: view.getFloat32(offset + 32, true),
            sy: view.getFloat32(offset + 36, true),
            sz: view.getFloat32(offset + 40, true),
        };
        const generated = orientedBounds(hash, index, transform, bounds === mesh.bounds ? mesh : { ...mesh, bounds });
        if (!generated?.length) {
            skipped.unsuitableBounds++;
            continue;
        }
        const destructibleId = `fragment:${hash}:${index}`;
        for (const collider of generated) {
            if (disabledColliderIds.has(collider.id)) continue;
            if (disabledColliderRegions.some((region) => {
                const regionHash = String(region?.archetypeHash || '').trim();
                return (!regionHash || regionHash === collider.archetypeHash)
                    && collider.x >= Number(region?.minX) && collider.x <= Number(region?.maxX)
                    && collider.y >= Number(region?.minY) && collider.y <= Number(region?.maxY);
            })) continue;
            const destructible = destructiblesById.get(destructibleId);
            if (destructible) {
                collider.destructibleId = destructibleId;
            }
            const profile = destructible || destructibleProfileByHash.get(hash);
            const assetPath = String(profile?.fragment?.yftPath || profile?.fragment?.ytypPath || '');
            if (PUSHABLE_PROP_PATH.test(assetPath)) {
                const volume = Math.max(0.01, collider.halfX * 2 * collider.halfY * 2 * (collider.maxZ - collider.minZ));
                collider.response = 'pushable';
                collider.mass = Number(Math.max(4, Math.min(65, volume * 24)).toFixed(2));
                collider.instance = { x: transform.x, y: transform.y, z: transform.z };
            }
            if (collider.source === 'exported_building_shell') buildingShellCount++;
            if (collider.source === 'exported_foliage_trunk') foliageTrunkCount++;
            colliders.push(collider);
        }
    }

    const output = {
        schema: 'webglgta-demo-asset-colliders-v1',
        sourceEntities: path.basename(entityPath),
        sourceModels: path.basename(modelPath),
        sourceDestructibles: path.basename(destructiblePath),
        sourceOverrides: disabledColliderIds.size ? path.basename(overridesPath) : null,
        recordStride: stride,
        colliderCount: colliders.length,
        buildingShellColliderCount: buildingShellCount,
        foliageTrunkColliderCount: foliageTrunkCount,
        derivedBoundsColliderCount: derivedBoundsCount,
        disabledColliderCount: disabledColliderIds.size,
        disabledColliderRegionCount: disabledColliderRegions.length,
        ybnCollisionExclusions,
        skipped,
        colliders,
    };
    const sourceRevision = createHash('sha256')
        .update(entities)
        .update(await readFile(modelPath))
        .update(await readFile(destructiblePath))
        .update(JSON.stringify(overrides))
        .digest('hex')
        .slice(0, 16);
    output.sourceRevision = sourceRevision;
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(output)}\n`, 'utf8');
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
    descriptor.assetColliderRevision = sourceRevision;
    await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
    console.log(`Built demo asset colliders: colliders=${colliders.length} buildings=${buildingShellCount} trunks=${foliageTrunkCount} derivedBounds=${derivedBoundsCount} missingBounds=${skipped.missingBounds} unsuitable=${skipped.unsuitableBounds}`);
}

await main();

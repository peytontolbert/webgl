#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DOOR_PATTERN = /(?:door|gate|shutter|roller|barrier|hatch)/i;
const NON_DOOR_PATTERN = /(?:door[_\s-]*frame|door[_\s-]*det(?:al|ail)|barrier[_\s-]*rope)/i;
const IMAGE_PATTERN = /\.(?:webp|png|jpe?g|ktx2|dds)(?:$|[?#])/i;
const HIDE_WHEN_DOOR_CLOSED = 64;

function parseArgs(argv) {
    const out = { metadata: [] };
    for (let index = 2; index < argv.length; index++) {
        const key = argv[index];
        const value = argv[index + 1];
        if (key === '--repair-descriptor') {
            out.repairDescriptor = true;
        } else if (key === '--quiet') {
            out.quiet = true;
        } else if (key === '--metadata') {
            out.metadata.push(path.resolve(value));
            index++;
        } else if (key.startsWith('--')) {
            out[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = path.resolve(value);
            index++;
        }
    }
    return out;
}

function readJson(file) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    if (fs.existsSync(`${file}.gz`)) return JSON.parse(zlib.gunzipSync(fs.readFileSync(`${file}.gz`)).toString('utf8'));
    if (fs.existsSync(`${file}.br`)) return JSON.parse(zlib.brotliDecompressSync(fs.readFileSync(`${file}.br`)).toString('utf8'));
    throw new Error(`Missing JSON asset (identity/gzip/brotli): ${file}`);
}

function readEnt1(file) {
    const buffer = fs.readFileSync(file);
    if (buffer.length < 8 || buffer.toString('ascii', 0, 4) !== 'ENT1') throw new Error(`Invalid ENT1 file: ${file}`);
    const count = buffer.readUInt32LE(4);
    const stride = count ? (buffer.length - 8) / count : 0;
    if (![44, 48, 64].includes(stride) || 8 + count * stride !== buffer.length) {
        throw new Error(`Invalid ENT1 layout: count=${count} stride=${stride}`);
    }
    const records = [];
    for (let index = 0; index < count; index++) {
        const offset = 8 + index * stride;
        records.push({
            index,
            hash: String(buffer.readUInt32LE(offset)),
            position: [buffer.readFloatLE(offset + 4), buffer.readFloatLE(offset + 8), buffer.readFloatLE(offset + 12)],
            quaternion: [buffer.readFloatLE(offset + 16), buffer.readFloatLE(offset + 20), buffer.readFloatLE(offset + 24), buffer.readFloatLE(offset + 28)],
            scale: [buffer.readFloatLE(offset + 32), buffer.readFloatLE(offset + 36), buffer.readFloatLE(offset + 40)],
            guid: stride >= 64 ? buffer.readUInt32LE(offset + 48) : 0,
            parentGuid: stride >= 64 ? buffer.readUInt32LE(offset + 52) : 0,
            entitySetHash: stride >= 64 ? buffer.readUInt32LE(offset + 56) : 0,
            flags: stride >= 64 ? buffer.readUInt32LE(offset + 60) : 0,
        });
    }
    return { count, stride, records };
}

function distance(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function transformPoint(record, point) {
    const [qx, qy, qz, qw] = record.quaternion;
    const px = point[0] * record.scale[0];
    const py = point[1] * record.scale[1];
    const pz = point[2] * record.scale[2];
    const ux = qy * pz - qz * py;
    const uy = qz * px - qx * pz;
    const uz = qx * py - qy * px;
    const uux = qy * uz - qz * uy;
    const uuy = qz * ux - qx * uz;
    const uuz = qx * uy - qy * ux;
    return [
        record.position[0] + px + 2 * (qw * ux + uux),
        record.position[1] + py + 2 * (qw * uy + uuy),
        record.position[2] + pz + 2 * (qw * uz + uuz),
    ];
}

function portalApertureDistance(point, corners) {
    if (corners.length < 3) return Infinity;
    const center = [0, 1, 2].map((axis) => corners.reduce((sum, corner) => sum + corner[axis], 0) / corners.length);
    const radius = Math.max(...corners.map((corner) => distance(center, corner)));
    const edgeA = corners[1].map((value, axis) => value - corners[0][axis]);
    const edgeB = corners[2].map((value, axis) => value - corners[0][axis]);
    const normal = [
        edgeA[1] * edgeB[2] - edgeA[2] * edgeB[1],
        edgeA[2] * edgeB[0] - edgeA[0] * edgeB[2],
        edgeA[0] * edgeB[1] - edgeA[1] * edgeB[0],
    ];
    const normalLength = Math.hypot(...normal);
    if (normalLength < 1e-6) return distance(point, center);
    const planeDistance = Math.abs(
        (point[0] - center[0]) * normal[0]
        + (point[1] - center[1]) * normal[1]
        + (point[2] - center[2]) * normal[2]
    ) / normalLength;
    return Math.hypot(planeDistance, Math.max(0, distance(point, center) - radius));
}

function meshText(mesh, hash) {
    return ['source', 'name', 'assetName', 'drawableName'].map((key) => String(mesh?.[key] || '')).join(' ') || hash;
}

function collectStrings(value, output) {
    if (typeof value === 'string') {
        if (IMAGE_PATTERN.test(value)) output.add(value.split(/[?#]/, 1)[0]);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectStrings(item, output);
        return;
    }
    if (value && typeof value === 'object') {
        for (const item of Object.values(value)) collectStrings(item, output);
    }
}

function resolveAsset(root, url) {
    const clean = String(url || '').split(/[?#]/, 1)[0].replaceAll('\\', '/');
    const relative = clean.startsWith('@demo-pack/') ? `demo/${clean.slice('@demo-pack/'.length)}` : clean;
    return path.resolve(root, relative);
}

function storedAsset(file) {
    if (fs.existsSync(file)) return { file, encoding: 'identity', logicalSize: fs.statSync(file).size };
    const gzip = `${file}.gz`;
    if (fs.existsSync(gzip)) {
        const descriptor = fs.openSync(gzip, 'r');
        try {
            const trailer = Buffer.allocUnsafe(4);
            const size = fs.fstatSync(descriptor).size;
            fs.readSync(descriptor, trailer, 0, 4, size - 4);
            return { file: gzip, encoding: 'gzip', logicalSize: trailer.readUInt32LE(0) };
        } finally {
            fs.closeSync(descriptor);
        }
    }
    const brotli = `${file}.br`;
    if (fs.existsSync(brotli)) return { file: brotli, encoding: 'br', logicalSize: null };
    return null;
}

function meshFileReference(raw, assetRoot) {
    const match = String(raw || '').match(/^(.*?)(?:#(\d+):(\d+))?$/);
    const url = match?.[1] || '';
    const offset = match?.[2] === undefined ? 0 : Number(match[2]);
    const length = match?.[3] === undefined ? null : Number(match[3]);
    const file = assetRoot ? resolveAsset(assetRoot, url) : null;
    const stored = file ? storedAsset(file) : null;
    const exists = file ? !!stored : null;
    const size = stored?.logicalSize ?? null;
    const validRange = length === null || (Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length > 0 && (!exists || size === null || offset + length <= size));
    return { raw, url, offset, length, file, storedFile: stored?.file || null, encoding: stored?.encoding || null, exists, size, validRange };
}

function portalCoverage(root, definition, doors) {
    const rooms = Array.isArray(definition?.rooms) ? definition.rooms : [];
    const portals = Array.isArray(definition?.portals) ? definition.portals : [];
    const indices = new Set();
    const invalid = [];
    let closable = 0;
    let boundClosable = 0;
    for (let arrayIndex = 0; arrayIndex < portals.length; arrayIndex++) {
        const portal = portals[arrayIndex] || {};
        const index = Number(portal.index);
        const from = Number(portal.roomFrom);
        const to = Number(portal.roomTo);
        const corners = Array.isArray(portal.corners) ? portal.corners : [];
        const reasons = [];
        if (!Number.isInteger(index) || index < 0 || indices.has(index)) reasons.push('invalid-or-duplicate-index');
        indices.add(index);
        if (index !== arrayIndex) reasons.push('index-array-order-mismatch');
        if (!Number.isInteger(from) || from < 0 || from >= rooms.length) reasons.push('invalid-roomFrom');
        if (!Number.isInteger(to) || to < 0 || to >= rooms.length) reasons.push('invalid-roomTo');
        if (corners.length < 4 || corners.some((corner) => !Array.isArray(corner) || corner.length < 3 || corner.some((number) => !Number.isFinite(Number(number))))) {
            reasons.push('invalid-corners');
        }
        if (reasons.length) invalid.push({ index, arrayIndex, reasons });
        if (((Number(portal.flags) >>> 0) & HIDE_WHEN_DOOR_CLOSED) === 0 || corners.length === 0) continue;
        closable++;
        const worldCorners = corners.map((corner) => transformPoint(root, corner));
        const bound = doors.some((door) => {
            const coords = door?.coords;
            if (!coords) return false;
            const bindRadius = Math.max(1.5, Math.min(3.0, Number(door.radius) || 0));
            return portalApertureDistance([Number(coords.x), Number(coords.y), Number(coords.z)], worldCorners) <= bindRadius;
        });
        if (bound) boundClosable++;
    }
    return { rooms: rooms.length, portals: portals.length, invalid, closable, boundClosable };
}

function metadataCoverage(files, roots, childrenByParent, nonRenderable) {
    const sourceRoots = [];
    for (const file of files) {
        const metadata = readJson(file);
        for (const root of metadata.roots || []) sourceRoots.push({ ...root, metadata: file });
    }
    const unmatchedRoots = [];
    const unmatchedChildren = [];
    const omittedNonRenderableChildren = [];
    let matchedChildren = 0;
    for (const source of sourceRoots) {
        const match = roots
            .filter((root) => root.hash === String(Number(source.archetypeHash) >>> 0))
            .sort((a, b) => distance(a.position, source.position) - distance(b.position, source.position))[0];
        if (!match || distance(match.position, source.position) > 0.2) {
            unmatchedRoots.push({ metadata: source.metadata, archetypeHash: source.archetypeHash, position: source.position });
            continue;
        }
        const available = [...(childrenByParent.get(match.guid) || [])];
        for (const child of source.children || []) {
            let bestIndex = -1;
            let bestDistance = Infinity;
            for (let index = 0; index < available.length; index++) {
                if (available[index].hash !== String(Number(child.archetypeHash) >>> 0)) continue;
                const candidateDistance = distance(available[index].position, child.position);
                if (candidateDistance < bestDistance) {
                    bestIndex = index;
                    bestDistance = candidateDistance;
                }
            }
            if (bestIndex < 0 || bestDistance > 0.2) {
                const item = {
                    metadata: source.metadata,
                    rootHash: source.archetypeHash,
                    archetypeHash: String(Number(child.archetypeHash) >>> 0),
                    position: child.position,
                    nearestDistance: Number.isFinite(bestDistance) ? bestDistance : null,
                };
                if (nonRenderable.has(item.archetypeHash)) omittedNonRenderableChildren.push(item);
                else unmatchedChildren.push(item);
            } else {
                available.splice(bestIndex, 1);
                matchedChildren++;
            }
        }
    }
    return { sourceRoots: sourceRoots.length, matchedChildren, omittedNonRenderableChildren, unmatchedRoots, unmatchedChildren };
}

function collisionCoverage(descriptor, roots, manifestFile) {
    const manifest = readJson(manifestFile);
    const compiledNames = new Set((manifest.source_ybn_names || []).map(String));
    for (const overlay of manifest.destination_overlays || []) {
        for (const name of overlay.source_ybn_names || []) compiledNames.add(String(name));
    }
    const imports = Array.isArray(descriptor.mloRuntime?.collisionImports)
        ? descriptor.mloRuntime.collisionImports : [];
    const declaredRoots = new Set();
    const requiredNames = new Set();
    const invalidImports = [];
    for (const item of imports) {
        const rootHashes = Array.isArray(item?.rootArchetypeHashes) ? item.rootArchetypeHashes.map(String) : [];
        if (!rootHashes.length || typeof item?.sourceHasCollision !== 'boolean') {
            invalidImports.push({ id: item?.id || '', reason: 'missing-root-or-source-declaration' });
        }
        for (const hash of rootHashes) declaredRoots.add(hash);
        const sources = Array.isArray(item?.sources) ? item.sources : [];
        if (item?.sourceHasCollision === true && sources.length === 0) {
            invalidImports.push({ id: item?.id || '', reason: 'collision-declared-without-sources' });
        }
        for (const source of sources) {
            if (!source?.placement?.mode || !source?.expectedCompiledName) {
                invalidImports.push({ id: item?.id || '', file: source?.file || '', reason: 'incomplete-source-contract' });
                continue;
            }
            requiredNames.add(String(source.expectedCompiledName));
        }
    }
    const rootHashes = new Set(roots.map((root) => String(root.hash)));
    const missingRootDeclarations = [...rootHashes].filter((hash) => !declaredRoots.has(hash)).sort((a, b) => Number(a) - Number(b));
    const missingCompiledSources = [...requiredNames].filter((name) => !compiledNames.has(name)).sort();
    return {
        ok: descriptor.mloRuntime?.collisionContractSchema === 'webglgta-mlo-collision-import-v1'
            && invalidImports.length === 0 && missingRootDeclarations.length === 0 && missingCompiledSources.length === 0,
        schema: descriptor.mloRuntime?.collisionContractSchema || null,
        imports: imports.length,
        declaredRoots: declaredRoots.size,
        compiledSources: compiledNames.size,
        requiredSources: requiredNames.size,
        invalidImports,
        missingRootDeclarations,
        missingCompiledSources,
    };
}

function main() {
    const args = parseArgs(process.argv);
    for (const key of ['descriptor', 'entities', 'manifest', 'interiors', 'interactables']) {
        if (!args[key]) throw new Error(`Missing --${key}`);
    }
    const descriptor = readJson(args.descriptor);
    const manifest = readJson(args.manifest);
    const interactables = readJson(args.interactables);
    const ent = readEnt1(args.entities);
    const meshes = manifest.meshes || {};
    const nonRenderable = new Set((manifest.nonRenderableHashes || []).map(String));
    const doors = Array.isArray(interactables.doors) ? interactables.doors : [];
    const roots = ent.records.filter((record) => (record.flags & 1) !== 0);
    const children = ent.records.filter((record) => record.parentGuid !== 0);
    const childrenByParent = new Map();
    for (const child of children) {
        if (!childrenByParent.has(child.parentGuid)) childrenByParent.set(child.parentGuid, []);
        childrenByParent.get(child.parentGuid).push(child);
    }

    const ownedHashes = new Set(children.map((record) => record.hash));
    const missingManifest = [...ownedHashes].filter((hash) => !meshes[hash] && !nonRenderable.has(hash));
    const lodPatterns = {};
    let placeholderArchetypes = 0;
    const meshReferences = new Map();
    const textureReferences = new Set();
    const doorCandidateHashes = new Set();
    for (const hash of ownedHashes) {
        const mesh = meshes[hash];
        if (!mesh) continue;
        const lods = mesh.lods || {};
        const pattern = ['high', 'med', 'low'].filter((lod) => lods[lod]?.submeshes?.length).join('+') || 'none';
        lodPatterns[pattern] = (lodPatterns[pattern] || 0) + 1;
        if (mesh.placeholder === true || mesh.isPlaceholder === true) placeholderArchetypes++;
        const text = meshText(mesh, hash);
        if (DOOR_PATTERN.test(text) && !NON_DOOR_PATTERN.test(text)) doorCandidateHashes.add(hash);
        for (const lod of Object.values(lods)) {
            for (const submesh of lod?.submeshes || []) {
                if (submesh.file) meshReferences.set(submesh.file, meshFileReference(submesh.file, args.assetRoot));
                collectStrings(submesh.material, textureReferences);
            }
        }
    }
    const missingMeshFiles = [...meshReferences.values()].filter((entry) => entry.exists === false || !entry.validRange);
    const missingTextures = args.assetRoot
        ? [...textureReferences].filter((url) => !storedAsset(resolveAsset(args.assetRoot, url)))
        : [];

    const geometryDoors = doors.filter((door) => String(door.archetypeHash || '') !== '0');
    const geometryDoorKeys = new Set(geometryDoors.map((door) => `${String(door.archetypeHash)}:${Number(door.origin?.x).toFixed(3)}:${Number(door.origin?.y).toFixed(3)}:${Number(door.origin?.z).toFixed(3)}`));
    const missingDoorInstances = [];
    for (const child of children) {
        if (!doorCandidateHashes.has(child.hash)) continue;
        const key = `${child.hash}:${child.position[0].toFixed(3)}:${child.position[1].toFixed(3)}:${child.position[2].toFixed(3)}`;
        if (!geometryDoorKeys.has(key)) missingDoorInstances.push({ hash: child.hash, position: child.position, source: meshes[child.hash]?.source || '' });
    }

    const rootReports = [];
    for (const root of roots) {
        const definitionFile = path.join(args.interiors, `${root.hash}.json`);
        const definition = fs.existsSync(definitionFile) ? readJson(definitionFile) : null;
        const owned = childrenByParent.get(root.guid) || [];
        rootReports.push({
            archetypeHash: root.hash,
            guid: root.guid,
            position: root.position,
            children: owned.length,
            uniqueChildArchetypes: new Set(owned.map((child) => child.hash)).size,
            definitionPresent: !!definition,
            authoritativeContentBounds: !!definition?.contentBounds?.complete,
            contentBounds: definition?.contentBounds || null,
            portalCoverage: definition ? portalCoverage(root, definition, doors) : null,
        });
    }

    const actualImport = {
        mloRootCount: roots.length,
        uniqueRootArchetypeCount: new Set(roots.map((root) => root.hash)).size,
        mloChildCount: children.length,
        uniqueChildArchetypeCount: ownedHashes.size,
        interiorDefinitionCount: new Set(roots.map((root) => root.hash).filter((hash) => fs.existsSync(path.join(args.interiors, `${hash}.json`)))).size,
    };
    const collision = args.collisionManifest ? collisionCoverage(descriptor, roots, args.collisionManifest) : null;
    const staleDescriptorFields = {};
    for (const key of ['mloRootCount', 'mloChildCount', 'uniqueChildArchetypeCount', 'interiorDefinitionCount']) {
        const declared = Number(descriptor.mloImport?.[key]);
        if (declared !== actualImport[key]) staleDescriptorFields[key] = { declared, actual: actualImport[key] };
    }
    if (Number(descriptor.instanceCount) !== ent.count) staleDescriptorFields.instanceCount = { declared: Number(descriptor.instanceCount), actual: ent.count };
    if (args.repairDescriptor) {
        descriptor.instanceCount = ent.count;
        descriptor.mloImport = {
            ...(descriptor.mloImport || {}),
            retainedBaseInstanceCount: ent.count - roots.length - children.length,
            mloRootCount: actualImport.mloRootCount,
            mloChildCount: actualImport.mloChildCount,
            totalInstanceCount: ent.count,
            interiorDefinitionCount: actualImport.interiorDefinitionCount,
            uniqueChildArchetypeCount: actualImport.uniqueChildArchetypeCount,
        };
        fs.writeFileSync(args.descriptor, JSON.stringify(descriptor, null, 2) + '\n');
    }

    const report = {
        schema: 'webglgta-mlo-coverage-audit-v1',
        ok: missingManifest.length === 0
            && placeholderArchetypes === 0
            && missingMeshFiles.length === 0
            && missingTextures.length === 0
            && rootReports.every((root) => root.definitionPresent && root.authoritativeContentBounds && root.portalCoverage.invalid.length === 0)
            && rootReports.every((root) => root.portalCoverage.boundClosable === root.portalCoverage.closable)
            && missingDoorInstances.length === 0
            && (!args.collisionManifest || collision.ok),
        entities: { records: ent.count, stride: ent.stride, ...actualImport },
        descriptor: { staleFields: staleDescriptorFields },
        assets: {
            manifestArchetypes: Object.keys(meshes).length,
            ownedArchetypes: ownedHashes.size,
            missingManifest,
            nonRenderableOwnedArchetypes: [...ownedHashes].filter((hash) => nonRenderable.has(hash)).length,
            placeholderArchetypes,
            lodPatterns,
            meshReferences: meshReferences.size,
            textureReferences: textureReferences.size,
            missingMeshFiles,
            missingTextures,
        },
        interactions: {
            doors: doors.length,
            geometryDoors: geometryDoors.length,
            portalOnlyDoors: doors.length - geometryDoors.length,
            candidateArchetypes: doorCandidateHashes.size,
            missingDoorInstances,
        },
        roots: rootReports,
        metadata: args.metadata.length ? metadataCoverage(args.metadata, roots, childrenByParent, nonRenderable) : null,
        collision,
    };
    const output = JSON.stringify(report, null, 2) + '\n';
    if (args.output) fs.writeFileSync(args.output, output);
    if (!args.quiet) process.stdout.write(output);
    process.exitCode = report.ok && (!report.metadata || (!report.metadata.unmatchedRoots.length && !report.metadata.unmatchedChildren.length)) ? 0 : 1;
}

main();

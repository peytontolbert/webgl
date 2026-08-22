/**
 * Build small authored-fragment instances for the fixed /demo district.
 *
 * The render export keeps drawable meshes but drops YTYP/YFT physics ownership.
 * This joins CodeWalker's fragment audit with the compact ENT1 tile and retains
 * only small exterior props with real fragment children. It is intentionally a
 * gameplay candidate list, not a claim that every GTA fragment should collide.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assets = path.resolve(__dirname, '..', 'assets');
const MAX_PROFILE_RADIUS = 3.0;
const EXCLUDED_YTYP_PATH_MARKERS = ['\\vegetation\\', '\\building\\', '\\interiors\\'];

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

function profileFromRecord(record) {
    if (record?.assetType !== 'ASSET_TYPE_FRAGMENT') return null;
    const radius = finite(record?.bounds?.sphere?.[3], -1);
    const ytypPath = String(record?.ytypPath || '').toLowerCase();
    const metadata = Array.isArray(record?.fragmentMetadata) ? record.fragmentMetadata[0] : null;
    const physics = metadata?.physicsLod1 || {};
    const childCount = Math.max(0, Math.floor(finite(physics.childCount)));
    if (radius <= 0.05 || radius > MAX_PROFILE_RADIUS || childCount <= 0) return null;
    if (EXCLUDED_YTYP_PATH_MARKERS.some((marker) => ytypPath.includes(marker))) return null;

    const archetypeHash = String(record?.archetypeHash ?? '').trim();
    if (!/^\d+$/.test(archetypeHash)) return null;
    return {
        archetypeHash,
        radius,
        childCount,
        groupCount: Math.max(0, Math.floor(finite(physics.groupCount))),
        glassWindowCount: Math.max(0, Math.floor(finite(metadata?.glassWindowCount))),
        hasVehicleGlass: metadata?.hasVehicleGlass === true,
        ytypPath: String(record?.ytypPath || ''),
        yftPath: String(metadata?.path || ''),
    };
}

async function main() {
    const auditPath = argumentValue('--audit', path.join(assets, 'demo', 'spawn_district_fragment_audit_base.json'));
    const entityPath = argumentValue('--entities', path.join(assets, 'demo', 'spawn_district_entities_mlo.bin'));
    const outputPath = argumentValue('--output', path.join(assets, 'demo', 'spawn_district_destructibles.json'));
    const audit = JSON.parse(await readFile(auditPath, 'utf8'));
    const profiles = new Map();
    for (const record of audit?.records || []) {
        const profile = profileFromRecord(record);
        if (profile) profiles.set(profile.archetypeHash, profile);
    }

    const data = await readFile(entityPath);
    const { count, stride } = readEnt1(data, entityPath);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const destructibles = [];
    for (let index = 0; index < count; index++) {
        const offset = 8 + index * stride;
        const archetypeHash = String(view.getUint32(offset, true));
        const profile = profiles.get(archetypeHash);
        if (!profile) continue;
        const x = view.getFloat32(offset + 4, true);
        const y = view.getFloat32(offset + 8, true);
        const z = view.getFloat32(offset + 12, true);
        const qx = view.getFloat32(offset + 16, true);
        const qy = view.getFloat32(offset + 20, true);
        const qz = view.getFloat32(offset + 24, true);
        const qw = view.getFloat32(offset + 28, true);
        const sx = view.getFloat32(offset + 32, true);
        const sy = view.getFloat32(offset + 36, true);
        const sz = view.getFloat32(offset + 40, true);
        const scale = Math.max(0.05, Math.abs(sx), Math.abs(sy), Math.abs(sz));
        const radius = Math.max(0.12, Math.min(3.5, profile.radius * scale));
        const glass = profile.glassWindowCount > 0 || profile.hasVehicleGlass;
        destructibles.push({
            id: `fragment:${archetypeHash}:${index}`,
            label: `fragment ${archetypeHash}`,
            archetypeHash,
            coords: { x: Number(x.toFixed(4)), y: Number(y.toFixed(4)), z: Number(z.toFixed(4)) },
            rotation: [qx, qy, qz, qw].map((value) => Number(value.toFixed(6))),
            scale: [sx, sy, sz].map((value) => Number(value.toFixed(6))),
            radius: Number(radius.toFixed(4)),
            height: Number(Math.max(0.25, Math.min(5.0, radius * 1.7)).toFixed(4)),
            breakSpeed: glass ? 3.5 : 4.5,
            breakHealth: glass ? 1 : Math.max(1, Math.min(4, Math.ceil(profile.childCount / 8))),
            blocksMovement: false,
            fragment: {
                childCount: profile.childCount,
                groupCount: profile.groupCount,
                glassWindowCount: profile.glassWindowCount,
                ytypPath: profile.ytypPath,
                yftPath: profile.yftPath,
            },
        });
    }

    const output = {
        schema: 'webglgta-demo-destructibles-v1',
        sourceAudit: path.basename(auditPath),
        sourceEntities: path.basename(entityPath),
        recordStride: stride,
        fragmentProfileCount: profiles.size,
        destructibleInstanceCount: destructibles.length,
        destructibles,
    };
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(output)}\n`, 'utf8');
    console.log(`Built demo destructibles: profiles=${profiles.size} instances=${destructibles.length}`);
}

await main();

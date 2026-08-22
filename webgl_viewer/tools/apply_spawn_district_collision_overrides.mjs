#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const viewerDir = path.resolve(toolsDir, '..');

function argumentValue(name, fallback) {
    const index = process.argv.indexOf(name);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const inputPath = path.resolve(argumentValue(
    '--input',
    path.join(viewerDir, 'dist', 'assets', 'demo', 'spawn_district_asset_colliders.json'),
));
const overridesPath = path.resolve(argumentValue(
    '--overrides',
    path.join(viewerDir, 'assets', 'demo', 'spawn_district_collision_overrides.json'),
));
const outputPath = path.resolve(argumentValue(
    '--output',
    path.join(viewerDir, 'assets', 'demo', 'spawn_district_asset_colliders.json'),
));
const descriptorPath = path.resolve(argumentValue(
    '--descriptor',
    path.join(viewerDir, 'assets', 'demo', 'spawn_district.json'),
));

const manifest = JSON.parse(await readFile(inputPath, 'utf8'));
const overrides = JSON.parse(await readFile(overridesPath, 'utf8'));
const disabledColliderIds = new Set((overrides.disabledColliderIds || []).map(String));
const disabledColliderRegions = Array.isArray(overrides.disabledColliderRegions) ? overrides.disabledColliderRegions : [];
const isRegionDisabled = (collider) => disabledColliderRegions.some((region) => {
    const hash = String(region?.archetypeHash || '').trim();
    return (!hash || hash === String(collider?.archetypeHash || ''))
        && Number(collider?.x) >= Number(region?.minX)
        && Number(collider?.x) <= Number(region?.maxX)
        && Number(collider?.y) >= Number(region?.minY)
        && Number(collider?.y) <= Number(region?.maxY);
});
const colliders = (manifest.colliders || []).filter((collider) => (
    !disabledColliderIds.has(String(collider?.id || '')) && !isRegionDisabled(collider)
));
const output = {
    ...manifest,
    sourceOverrides: path.basename(overridesPath),
    colliderCount: colliders.length,
    disabledColliderCount: disabledColliderIds.size,
    disabledColliderRegionCount: disabledColliderRegions.length,
    ybnCollisionExclusions: Array.isArray(overrides.ybnCollisionExclusions)
        ? overrides.ybnCollisionExclusions
        : [],
    colliders,
};
const baseSourceRevision = String(manifest.baseSourceRevision || manifest.sourceRevision || '');
const sourceRevision = createHash('sha256')
    .update(baseSourceRevision)
    .update(JSON.stringify(overrides))
    .digest('hex')
    .slice(0, 16);
output.sourceRevision = sourceRevision;
output.baseSourceRevision = baseSourceRevision;

await writeFile(outputPath, `${JSON.stringify(output)}\n`, 'utf8');
const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
descriptor.assetColliderRevision = sourceRevision;
await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
console.log(`Applied collision overrides: colliders=${colliders.length} disabled=${disabledColliderIds.size} regions=${disabledColliderRegions.length} ybnExclusions=${output.ybnCollisionExclusions.length}`);

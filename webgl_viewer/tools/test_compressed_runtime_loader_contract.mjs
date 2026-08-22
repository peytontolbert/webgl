import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetFetcher = fs.readFileSync(path.join(root, 'js', 'asset_fetcher.js'), 'utf8');
const modelManager = fs.readFileSync(path.join(root, 'js', 'model_manager.js'), 'utf8');
const collisionWorld = fs.readFileSync(path.join(root, 'js', 'gameplay', 'collision_world.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'js', 'main.js'), 'utf8');
const packager = fs.readFileSync(path.join(root, 'tools', 'build_demo_deployment.py'), 'utf8');

assert.match(modelManager, /fetchArrayBufferPreferredCompressed\(path,/);
assert.match(modelManager, /await fetchArrayBufferPreferredCompressed\(path, \{ usePersistentCache/);
assert.match(collisionWorld, /fetchArrayBufferPreferredCompressed\(dataUrl,/);
assert.match(collisionWorld, /fetchArrayBufferPreferredCompressed\(chunkUrl,/);
assert.match(assetFetcher, /pathWithoutQuery\.endsWith\('\.gz'\) \? u : appendUrlPathSuffix\(u, '\.gz'\)/);
assert.match(packager, /def compress_runtime_binaries/);
assert.match(packager, /source\.read\(4\) == b"MSH0"/);
assert.match(packager, /models_dir\.rglob\("\*\.bin"\)/);
assert.match(packager, /path\.suffix\.lower\(\) in \{"\.bin", "\.cwct"\}/);
assert.match(packager, /--keep-runtime-binaries/);
assert.match(packager, /wanted\.discard\(ASSETS \/ "collision" \/ "ybn_spawn\.bin"\)/);
assert.match(main, /const usesCompiledCollision = !!String\(demoDescriptor\?\.compiledCollisionManifestFile \|\| ''\)\.trim\(\)/);
assert.match(main, /if \(!usesCompiledCollision\) \{\s*await this\.collisionWorld\?\.loadYbnGround\?\.\(\)/);

console.log('compressed runtime loader contract passed');

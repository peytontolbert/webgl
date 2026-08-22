#!/usr/bin/env node
/**
 * Package exactly the base texture entries referenced by a compact deployment.
 *
 * Usage:
 *   node tools/package_texture_closure.mjs \
 *     --source-assets assets \
 *     --hashes required_texture_hashes.json \
 *     --out /tmp/texture-closure
 */

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const argument = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? String(argv[index + 1] || '').trim() : '';
};

const sourceAssets = path.resolve(argument('source-assets'));
const hashesFile = path.resolve(argument('hashes'));
const output = path.resolve(argument('out'));
if (!sourceAssets || !hashesFile || !output) {
  throw new Error('Required arguments: --source-assets, --hashes, --out');
}

const hashList = JSON.parse(fs.readFileSync(hashesFile, 'utf8'));
if (!Array.isArray(hashList)) throw new Error('--hashes must contain a JSON array');
const hashes = [...new Set(hashList.map((value) => String(value || '').trim()).filter((value) => /^\d+$/.test(value)))];
if (!hashes.length) throw new Error('--hashes did not contain numeric texture hashes');

const sourceDirectory = path.join(sourceAssets, 'models_textures');
const sourceIndexPayload = JSON.parse(fs.readFileSync(path.join(sourceDirectory, 'index.json'), 'utf8'));
const sourceIndex = sourceIndexPayload?.byHash || sourceIndexPayload;
if (!sourceIndex || typeof sourceIndex !== 'object') throw new Error('Source texture index has no byHash map');

const targetDirectory = path.join(output, 'models_textures');
fs.mkdirSync(targetDirectory, { recursive: true });

const selected = {};
const missing = [];
const copied = new Set();
for (const hash of hashes) {
  const entry = sourceIndex[hash];
  if (!entry || typeof entry !== 'object') {
    missing.push({ hash, reason: 'index' });
    continue;
  }
  const files = [...new Set((Array.isArray(entry.files) ? entry.files : [entry.preferredFile])
    .map((value) => String(value || '').trim())
    .filter((value) => value && path.basename(value) === value))];
  if (!files.length) {
    missing.push({ hash, reason: 'files' });
    continue;
  }
  const unavailable = files.filter((name) => !fs.existsSync(path.join(sourceDirectory, name)));
  if (unavailable.length) {
    missing.push({ hash, reason: 'payload', files: unavailable });
    continue;
  }
  selected[hash] = entry;
  for (const name of files) {
    if (copied.has(name)) continue;
    fs.copyFileSync(path.join(sourceDirectory, name), path.join(targetDirectory, name));
    copied.add(name);
  }
}

const compactIndex = {
  schema: sourceIndexPayload?.schema || 'webglgta-models-textures-index-v1',
  count: Object.keys(selected).length,
  byHash: selected,
};
fs.writeFileSync(path.join(targetDirectory, 'index.json'), JSON.stringify(compactIndex, null, 2) + '\n');
const report = {
  requestedHashes: hashes.length,
  selectedHashes: Object.keys(selected).length,
  copiedFiles: copied.size,
  missing,
};
fs.writeFileSync(path.join(output, 'texture-closure-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (missing.length) process.exitCode = 2;

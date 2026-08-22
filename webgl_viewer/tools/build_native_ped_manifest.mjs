import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelHashes = [
  '3250873975',
  '3014915558',
  '826475330',
  '1068876755',
  '1446741360',
  '1581098148',
];

const meshes = {};
for (const hash of modelHashes) {
  const shardId = (Number(hash) >>> 0) & 0xff;
  const shardFile = path.join(root, 'assets', 'models', 'manifest_shards', `${shardId.toString(16).padStart(2, '0')}.json`);
  const shard = JSON.parse(fs.readFileSync(shardFile, 'utf8'));
  const entry = shard?.meshes?.[hash];
  if (!entry?.lods?.high) throw new Error(`Missing high-LOD metadata for native ped ${hash}`);
  meshes[hash] = entry;
}

const output = {
  schema: 'webglgta-native-ped-manifest-v1',
  version: 1,
  modelCount: modelHashes.length,
  meshes,
};
const outputFile = path.join(root, 'assets', 'peds', 'native_ped_models.json');
fs.writeFileSync(outputFile, `${JSON.stringify(output)}\n`);
console.log(`Wrote ${outputFile} (${modelHashes.length} native peds)`);

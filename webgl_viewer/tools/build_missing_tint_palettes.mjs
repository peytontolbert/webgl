/**
 * Build a CodeWalker extraction dump for missing GTA tint palettes.
 *
 * This intentionally scans only TintPaletteSampler/TextureSamplerDiffPal so
 * palette recovery does not become a full missing-texture export job.
 */
import fs from 'node:fs';
import path from 'node:path';

const viewerRoot = path.resolve(process.argv[2] || '.');
const outPath = path.resolve(process.argv[3] || path.join('tools', 'out', 'missing_tint_palettes.json'));
const manifestPath = process.argv[4] ? path.resolve(process.argv[4]) : '';
const assetsDir = path.join(viewerRoot, 'assets');
const paletteHashes = ['4131954791', '2878898974'];

function joaat(input) {
  let hash = 0;
  for (const ch of String(input).toLowerCase()) {
    hash += ch.charCodeAt(0);
    hash += hash << 10;
    hash ^= hash >>> 6;
  }
  hash += hash << 3;
  hash ^= hash >>> 11;
  hash += hash << 15;
  return hash >>> 0;
}

function slugify(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function textureRel(value) {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  if (!raw) return null;
  if (raw.includes('/') || /\.(png|ktx2|jpg|jpeg|webp)$/i.test(raw)) {
    return raw.replace(/^\/+/, '').replace(/^assets\//i, '');
  }
  return `models_textures/${joaat(raw)}_${slugify(raw)}.png`;
}

function loadIndex(indexPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    return parsed && typeof parsed.byHash === 'object' ? parsed.byHash : parsed || {};
  } catch {
    return {};
  }
}

function materialEntries(entry) {
  const entries = [];
  if (entry && typeof entry.material === 'object') entries.push(['entry', null, entry.material]);
  for (const [lod, lodMeta] of Object.entries(entry?.lods || {})) {
    for (const [submeshIndex, submesh] of (lodMeta?.submeshes || []).entries()) {
      if (submesh?.material && typeof submesh.material === 'object') {
        entries.push([lod, submeshIndex, submesh.material]);
      }
    }
  }
  return entries;
}

const textureIndex = loadIndex(path.join(assetsDir, 'models_textures', 'index.json'));
const missing = new Map();
const shardDir = path.join(assetsDir, 'models', 'manifest_shards');
const shards = manifestPath
  ? [manifestPath]
  : fs.existsSync(shardDir)
  ? fs.readdirSync(shardDir).filter((name) => name.endsWith('.json')).sort().map((name) => path.join(shardDir, name))
  : [path.join(assetsDir, 'models', 'manifest.json')];
let meshesScanned = 0;

for (const shardPath of shards) {
  const shard = JSON.parse(fs.readFileSync(shardPath, 'utf8'));
  for (const [meshHash, entry] of Object.entries(shard?.meshes || {})) {
    meshesScanned += 1;
    const archetypeHash = String(Number(meshHash) >>> 0);
    for (const [lod, submeshIndex, material] of materialEntries(entry)) {
      const textures = material?.shaderParams?.texturesByHash;
      if (!textures || typeof textures !== 'object') continue;
      const palette = paletteHashes.map((hash) => textures[hash]).find((value) => typeof value === 'string' && value.trim());
      const requestedRel = textureRel(palette);
      const match = requestedRel && /^models_textures\/(\d+)(?:_([^/]+))?\.(?:png|ktx2|jpg|jpeg|webp)$/i.exec(requestedRel);
      if (!match || textureIndex[match[1]]) continue;

      let row = missing.get(match[1]);
      if (!row) {
        row = { requestedRel, useCount: 0, refs: [], _refKeys: new Set() };
        missing.set(match[1], row);
      }
      row.useCount += 1;
      if (row.refs.length < 25) {
        const key = `${archetypeHash}:${lod}:${submeshIndex}`;
        if (!row._refKeys.has(key)) {
          row._refKeys.add(key);
          row.refs.push({ archetype_hash: archetypeHash, lod, submesh_index: submeshIndex });
        }
      }
    }
  }
}

const rows = [...missing.values()]
  .map(({ _refKeys, ...row }) => row)
  .sort((a, b) => b.useCount - a.useCount || a.requestedRel.localeCompare(b.requestedRel));
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(rows, null, 2)}\n`);
console.log(`wrote ${outPath} palettes=${rows.length} meshes_scanned=${meshesScanned} base_index_png=${Object.keys(textureIndex).length}`);

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const target = process.argv[2];
if (!target) throw new Error('Usage: node tools/test_thin_asset_scheduler.mjs <bundle.js>');

const source = await readFile(target, 'utf8');
assert.ok(source.includes('function __nxPickAssetRequest()'), 'thin bundle must contain priority-aware request selection');
assert.ok(source.includes('function __nxDrainAssetRequests(){for(;wr+Sr<er;)'), 'thin bundle must only drain free concurrency slots');
assert.ok(source.includes('wr--,__nxDrainAssetRequests()'), 'settled requests must respect a lowered cap');
assert.ok(source.includes('Math.floor(e))),__nxDrainAssetRequests())}'), 'raising the cap must wake queued requests');
assert.ok(source.includes('!n&&li.get(o)===l&&li.delete(o)'), 'old JSON/NDJSON requests must not clear replacements');
assert.ok(source.includes('!s&&li.get(n)===o&&li.delete(n)'), 'old text/binary/blob requests must not clear replacements');
assert.ok(source.includes('!r&&li.get(s)===n&&li.delete(s)'), 'old array-buffer requests must not clear replacements');
console.log('Thin asset scheduler assertions passed.');

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entityPath = path.join(root, 'assets', 'demo', 'spawn_district_entities_supermesh.bin');
const source = await readFile(entityPath);
const recordCount = source.readUInt32LE(4);
const buffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
const messages = [];

globalThis.self = {
  postMessage(message) { messages.push(message); },
};
await import(`../js/chunk_worker.js?dedupe-test=${Date.now()}`);

async function parse(dedupeExactRecords) {
  messages.length = 0;
  await globalThis.self.onmessage({
    data: {
      type: 'parse_ent1',
      reqId: dedupeExactRecords ? 2 : 1,
      camData: [186.94, -850.84, 31.17],
      buffer: buffer.slice(0),
      dedupeExactRecords,
    },
  });
  const result = messages.find((message) => message.type === 'result');
  assert.ok(result?.ok, result?.error || 'ENT1 worker result was missing');
  return result;
}

const raw = await parse(false);
const deduped = await parse(true);

assert.equal(raw.parsed, recordCount);
// The generated supermesh stream is rebuilt as source geometry changes, so its
// exact-record count is intentionally data-driven rather than a fixed fixture.
assert.ok(deduped.dedupedExactRecords > 0, 'expected duplicate source records to be identified');
assert.equal(deduped.parsed, recordCount - deduped.dedupedExactRecords);
assert.equal(deduped.withArchetype, deduped.parsed);
console.log(`demo ENT1 dedupe passed: ${recordCount} records, removed ${deduped.dedupedExactRecords}`);

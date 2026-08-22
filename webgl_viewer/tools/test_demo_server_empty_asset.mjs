import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const serverPath = resolve(process.argv[2] || 'demo_server.js');
const source = await readFile(serverPath, 'utf8');

assert.ok(
  source.includes("if (stat.size === 0) {")
    && source.includes("headers['Content-Length'] = '0';")
    && source.includes('response.end();'),
  'demo server must safely respond to zero-byte assets',
);
assert.ok(
  source.includes("stream.once('error', (error) => {")
    && source.includes('response.destroy(error);'),
  'demo server must contain per-request stream failures',
);
assert.ok(
  source.includes('let rejected = false;')
    && source.includes('response.writeHead(413')
    && source.includes("'Selection payload exceeds 2 MB'"),
  'demo server must reject oversized selection payloads with an HTTP response',
);
console.log(`Zero-byte asset guard present in ${serverPath}`);

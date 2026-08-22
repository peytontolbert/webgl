import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = await readFile(resolve(process.argv[2] || 'nexus_extensions/nexus_bootstrap_dispatcher.js'), 'utf8');

assert.match(source, /const nativeSetTimeout = window\.setTimeout\.bind\(window\);/);
assert.match(source, /let wakeTimer = 0;/);
assert.match(source, /if \(!pending\.size\) return;/);
assert.match(source, /task\.nextAt = now \+ task\.delay;/);
assert.doesNotMatch(source, /nativeSetInterval\(tick, 100\)/);

console.log(`Bootstrap dispatcher lifecycle contract passed for ${process.argv[2] || 'source'}.`);

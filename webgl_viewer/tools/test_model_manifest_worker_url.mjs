import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../js/model_manager.js', import.meta.url), 'utf8');

assert.match(
    source,
    /new URL\(path, document\.baseURI\)\.href/,
    'manifest fallback must resolve relative to the document before entering the module worker',
);
assert.match(
    source,
    /w\.postMessage\(\{ url: workerManifestUrl \}\)/,
    'manifest worker must receive the resolved document URL',
);
assert.doesNotMatch(
    source,
    /w\.postMessage\(\{ url: path \}\)/,
    'raw relative manifest paths resolve incorrectly under the bundled worker URL',
);

console.log('model manifest worker URL contract passed');

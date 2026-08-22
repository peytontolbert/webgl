import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = await readFile(resolve(process.argv[2] || 'js/main.js'), 'utf8');

assert.match(source, /_reportFrameFault\(phase, error\)/);
assert.match(source, /try \{\s*this\.update\(\);\s*\} catch \(error\) \{\s*\/\/ Do not let one malformed streamed asset permanently stop all rendering\./);
assert.match(source, /try \{\s*this\._measureDrivingPhase\('frameRender', \(\) => this\.render\(\)\);\s*\} catch \(error\)/);
assert.match(source, /if \(!this\._destroyed\) this\._animationFrameId = requestAnimationFrame\(\(\) => this\.animate\(\)\);/);

console.log('Frame loop resilience contract passed.');

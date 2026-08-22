import { readFile } from 'node:fs/promises';

const target = process.argv[2];
if (!target) throw new Error('Usage: node tools/test_thin_startup_bundle.mjs <bundle.js>');

const source = await readFile(target, 'utf8');
const required = [
  'timeoutMs:this.spawnDistrictDemo?12e3:3e4,minWaitMs:this.spawnDistrictDemo?4500:0',
  'this._worldReady=!0,window.dispatchEvent(new CustomEvent("webglgta:world-ready"))',
];
for (const fragment of required) {
  if (!source.includes(fragment)) throw new Error(`Missing startup safeguard: ${fragment}`);
}
if (source.includes('timeoutMs:this.spawnDistrictDemo?9e4:3e4')) {
  throw new Error('Legacy 90-second demo warmup is still present');
}
console.log('Thin startup bundle assertions passed.');

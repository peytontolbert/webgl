import { readFile, writeFile } from 'node:fs/promises';

const target = process.argv[2];
if (!target) throw new Error('Usage: node tools/patch_thin_startup_bundle.mjs <bundle.js>');

const replacements = [
  {
    from: 'timeoutMs:this.spawnDistrictDemo?9e4:3e4,minWaitMs:this.spawnDistrictDemo?8e3:0',
    to: 'timeoutMs:this.spawnDistrictDemo?12e3:3e4,minWaitMs:this.spawnDistrictDemo?4500:0',
    label: 'bounded demo warmup',
  },
  {
    from: 'this._startAnimationLoop(),this._setBootStatus(\"\")}catch(p){',
    to: 'this._startAnimationLoop(),this._worldReady=!0,window.dispatchEvent(new CustomEvent(\"webglgta:world-ready\")),this._setBootStatus(\"\")}catch(p){',
    label: 'world-ready handoff',
  },
];

let source = await readFile(target, 'utf8');
for (const { from, to, label } of replacements) {
  const occurrences = source.split(from).length - 1;
  if (occurrences !== 1) throw new Error(`${label}: expected one match, found ${occurrences}`);
  source = source.replace(from, to);
}

await writeFile(target, source, 'utf8');
console.log(`Patched ${target}`);

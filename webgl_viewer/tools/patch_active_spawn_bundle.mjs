#!/usr/bin/env node

import fs from 'node:fs';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error('Usage: patch_active_spawn_bundle.mjs <input.js> <output.js>');

const source = fs.readFileSync(inputPath, 'utf8');
const target = 'return this._spawnDistrictDescriptor=t,this.spawnDistrictBounds={minX:Number(i.minX),minY:Number(i.minY),maxX:Number(i.maxX),maxY:Number(i.maxY)},t';
const replacement = 'return this._spawnDistrictDescriptor=t,this.spawnDistrictBounds={minX:Number(i.minX),minY:Number(i.minY),maxX:Number(i.maxX),maxY:Number(i.maxY)},(()=>{const e=t?.spawn,r=Number(e?.x),s=Number(e?.y),n=Number(e?.pedZ??e?.groundZ??e?.z);if([r,s,n].every(Number.isFinite)){const o=this.collisionWorld?.alignYbnToKnownSurface?.(r,s,n)||null;this._demoYbnAlignment=o,o&&console.info(`[demo] Aligned YBN ground by ${o.offset.toFixed(4)} m at the authored spawn.`)}})(),t';
const occurrences = source.split(target).length - 1;
if (occurrences !== 1) throw new Error(`Expected one spawn-descriptor return target, found ${occurrences}`);

const patched = source.replace(target, replacement);
if (!patched.includes('Aligned YBN ground by')) throw new Error('Ground alignment injection failed');
fs.writeFileSync(outputPath, patched, 'utf8');
console.log(`Patched ${inputPath} -> ${outputPath}`);

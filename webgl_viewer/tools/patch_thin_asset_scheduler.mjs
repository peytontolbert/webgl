import { readFile, writeFile } from 'node:fs/promises';

const target = process.argv[2];
if (!target) throw new Error('Usage: node tools/patch_thin_asset_scheduler.mjs <bundle.js>');

let source = await readFile(target, 'utf8');
const start = source.indexOf('function Td(');
const end = source.indexOf('async function qa()', start);
if (start < 0 || end < 0) throw new Error('Unable to locate the thin asset scheduler');
if (source.includes('function __nxDrainAssetRequests()')) throw new Error('Thin asset scheduler is already patched');

const replacement = `function __nxPickAssetRequest(){const a=ji.length>0,e=Ar.length>0;if(!a&&!e)return null;if(!a)return Ar.shift();if(!e)return ji.shift();if(er<=1){const t=Math.max(1,Math.min(99,Math.round(100*ts)));return hs=(hs+1)%100,hs<t?ji.shift():Ar.shift()}const i=Math.max(1,Math.floor(er*(1-ts))),r=Math.max(1,er-i);return wr<r?ji.shift():Sr<i?Ar.shift():ji.shift()}function __nxDrainAssetRequests(){for(;wr+Sr<er;){const a=__nxPickAssetRequest();if(!a)break;a()}}function Td(a,e){return new Promise((t,i)=>{const r=()=>{e==="low"?Sr++:wr++,Promise.resolve().then(a).then(t,i).finally(()=>{e==="low"?Sr--:wr--,__nxDrainAssetRequests()})},s=wr+Sr,n=e==="low"?"low":"high";if(s<er){if(n==="high"){r();return}if(!(ji.length>0)){r();return}if(er<=1){r();return}const o=Math.max(1,Math.floor(er*(1-ts))),l=Math.max(1,er-o);if(wr<l){const c=ji.shift();c&&c()}else if(Sr<o){r();return}}n==="high"?ji.push(r):Ar.push(r)})}`;
source = source.slice(0, start) + replacement + source.slice(end);

const oldCap = 'function Lr(a){const e=Number(a);Number.isFinite(e)&&(er=Math.max(1,Math.min(128,Math.floor(e))))}';
const newCap = 'function Lr(a){const e=Number(a);Number.isFinite(e)&&(er=Math.max(1,Math.min(128,Math.floor(e))),__nxDrainAssetRequests())}';
const capMatches = source.split(oldCap).length - 1;
if (capMatches !== 1) throw new Error(`Expected one asset concurrency setter, found ${capMatches}`);
source = source.replace(oldCap, newCap);

const cleanupReplacements = [
  ['finally{n||li.delete(o)}', 'finally{!n&&li.get(o)===l&&li.delete(o)}', 2],
  ['finally{s||li.delete(n)}', 'finally{!s&&li.get(n)===o&&li.delete(n)}', 3],
  ['finally{r||li.delete(s)}', 'finally{!r&&li.get(s)===n&&li.delete(s)}', 1],
];
for (const [from, to, expected] of cleanupReplacements) {
  const count = source.split(from).length - 1;
  if (count !== expected) throw new Error(`Expected ${expected} in-flight cleanup matches for ${from}, found ${count}`);
  source = source.replaceAll(from, to);
}

await writeFile(target, source, 'utf8');
console.log(`Patched thin asset scheduler in ${target}`);

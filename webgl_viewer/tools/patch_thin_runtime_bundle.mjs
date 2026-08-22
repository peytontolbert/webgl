import { readFile, writeFile } from 'node:fs/promises';

const target = process.argv[2];
if (!target) throw new Error('Usage: node tools/patch_thin_runtime_bundle.mjs <bundle.js>');

const from = 'animate(){if(this._destroyed)return;this._animationFrameId=0;const e=performance.now();this.update();const t=performance.now();this._cpuUpdateMs=t-e,this.render();const i=performance.now();this._cpuRenderMs=i-t,this._cpuFrameMs=i-e,this._destroyed||(this._animationFrameId=requestAnimationFrame(()=>this.animate()))}destroy(){';
const to = '_reportFrameFault(e,t){const i=String(t?.message||t||"Unknown frame error"),r=`${String(e||"unknown")}:${i}`,s=performance.now(),n=this._lastFrameFault;if(n?.key===r&&s-n.at<5e3)return;this._lastFrameFault={key:r,at:s};try{globalThis.__viewerReportError?.({subsystem:`frame.${String(e||"unknown")}`,level:"error",message:i,stack:t?.stack})}catch{}try{console.error(`WebGL GTA ${String(e||"frame")} failure:`,t)}catch{}}animate(){if(this._destroyed)return;this._animationFrameId=0;const e=performance.now();try{this.update()}catch(r){this._reportFrameFault("update",r)}const t=performance.now();this._cpuUpdateMs=t-e;try{this.render()}catch(r){this._reportFrameFault("render",r)}const i=performance.now();this._cpuRenderMs=i-t,this._cpuFrameMs=i-e,this._destroyed||(this._animationFrameId=requestAnimationFrame(()=>this.animate()))}destroy(){';

let source = await readFile(target, 'utf8');
const occurrences = source.split(from).length - 1;
if (occurrences !== 1) throw new Error(`Expected one unguarded animation loop, found ${occurrences}`);
source = source.replace(from, to);
await writeFile(target, source, 'utf8');
console.log(`Patched frame loop in ${target}`);

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const target = process.argv[2];
if (!target) throw new Error('Usage: node tools/test_thin_runtime_bundle.mjs <bundle.js>');

const source = await readFile(target, 'utf8');
assert.ok(source.includes('_reportFrameFault(e,t){'), 'thin bundle must report frame faults');
assert.ok(source.includes('try{this.update()}catch(r){this._reportFrameFault("update",r)}'), 'thin bundle must contain update failures');
assert.ok(source.includes('try{this.render()}catch(r){this._reportFrameFault("render",r)}'), 'thin bundle must contain render failures');
assert.ok(source.includes('requestAnimationFrame(()=>this.animate())'), 'thin bundle must continue scheduling frames');
assert.ok(!source.includes('const e=performance.now();this.update();const t=performance.now();this._cpuUpdateMs=t-e,this.render();'), 'unguarded frame loop must be absent');
console.log('Thin runtime bundle assertions passed.');

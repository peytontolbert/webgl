import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audioAssetUrl } from '../js/gameplay/audio_system.js';

const expectedEvents = [
    'pistol_fire', 'footstep_walk', 'footstep_run', 'landing',
    'weapon_reload_clip_out', 'weapon_reload_clip_in',
    'melee_hit',
    'vehicle_door_open', 'vehicle_door_close',
    'vehicle_collision_low', 'vehicle_collision_high',
    'vehicle_suspension', 'vehicle_jump_land', 'vehicle_handbrake',
    'distant_horn', 'distant_siren', 'bird_call',
    'pain_male', 'pain_female', 'wasted',
];
const assets = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const audioSource = await readFile(resolve(assets, '..', 'js/gameplay/audio_system.js'), 'utf8');
assert.match(audioSource, /const activation = navigator\.userActivation;/);
assert.match(audioSource, /if \(!this\._unlocked && activation && !activation\.isActive\) return false;/);
const manifest = JSON.parse(await readFile(resolve(assets, 'gta_audio/manifest.json'), 'utf8'));
assert.equal(manifest.schema, 'webglgta-gta-demo-audio-graph-v2');
for (const event of expectedEvents) {
    const layers = manifest.events?.[event]?.layers;
    assert.ok(Array.isArray(layers) && layers.length > 0, `${event} needs at least one GTA source`);
    for (const layer of layers) {
        assert.equal(audioAssetUrl(layer), `/assets/${layer}`, `${layer} must resolve under the public assets root`);
        const path = resolve(assets, layer);
        await access(path);
        assert.ok((await stat(path)).size > 512, `${layer} is unexpectedly small`);
    }
}
assert.equal(Object.keys(manifest.events).length, expectedEvents.length, 'manifest contains unmapped or missing runtime events');
for (const event of expectedEvents) {
    assert.ok(manifest.events[event].graph, `${event} must retain an executable audio graph`);
}
console.log(`GTA demo audio assets: ${expectedEvents.length} runtime events and ${Object.values(manifest.events).reduce((count, event) => count + event.layers.length, 0)} clips verified`);

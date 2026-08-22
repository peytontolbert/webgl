import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { audioAssetUrl, vehicleAudioAssetUrl, vehicleAudioPhaseWeights, vehicleAudioProfile, vehicleAudioScheduleWindow, vehicleAudioShiftWobble } from '../js/gameplay/audio_system.js';

assert.equal(audioAssetUrl('gta_audio/footstep_0.opus'), '/assets/gta_audio/footstep_0.opus');
assert.equal(audioAssetUrl('/assets/gta_audio/footstep_0.opus'), '/assets/gta_audio/footstep_0.opus');

assert.equal(vehicleAudioProfile('DILETTANTE').kind, 'electric');
assert.equal(vehicleAudioProfile('HAULER').kind, 'diesel');
assert.equal(vehicleAudioProfile('DOMINATOR').kind, 'v8');
assert.equal(vehicleAudioProfile('COMET2').kind, 'turbo4');
assert.equal(vehicleAudioProfile('T20').kind, 'super');
assert.equal(vehicleAudioProfile('COQUETTE').kind, 'sportsV8');
assert.equal(vehicleAudioProfile('COQUETTE').redlineRpm, 7200);
assert.equal(vehicleAudioProfile('SCHAFTER4').kind, 'luxury');

for (const [rpm, load] of [[0, 0], [0.4, 0], [0.5, 0.6], [1, 1]]) {
    const weights = vehicleAudioPhaseWeights(rpm, load);
    assert.ok(Object.values(weights).every((weight) => weight >= 0 && weight <= 1));
    assert.ok(Math.abs(Object.values(weights).reduce((sum, weight) => sum + weight, 0) - 1) < 1e-9, 'audio phase weights must remain normalized');
}
assert.ok(vehicleAudioPhaseWeights(0, 0).idle > 0.99, 'settled engine should use idle grains');
assert.ok(vehicleAudioPhaseWeights(0.6, 0.8).accel > 0.99, 'loaded engine should use acceleration grains');
assert.ok(vehicleAudioPhaseWeights(0.6, 0).decel > 0.99, 'closed throttle at RPM should use overrun grains');

const shiftStart = vehicleAudioShiftWobble({ gearChangeWobblePitch: 0.1, gearChangeWobbleVolume: 0.35, gearChangeWobbleSpeed: 0.2 }, 0);
const shiftMid = vehicleAudioShiftWobble({ gearChangeWobblePitch: 0.1, gearChangeWobbleVolume: 0.35, gearChangeWobbleSpeed: 0.2 }, 0.5);
const shiftEnd = vehicleAudioShiftWobble({ gearChangeWobblePitch: 0.1, gearChangeWobbleVolume: 0.35, gearChangeWobbleSpeed: 0.2 }, 1);
assert.deepEqual(shiftStart, { rate: 1, gain: 1 }, 'shift wobble must begin cleanly');
assert.ok(shiftMid.rate < 1 && shiftMid.gain < 1, 'REL pitch and volume wobble must affect the clutch transition');
assert.ok(Math.abs(shiftEnd.rate - 1) < 1e-12 && Math.abs(shiftEnd.gain - 1) < 1e-12, 'shift wobble must settle after the authored transition');

let nextGrainAt = 0;
let scheduledGrains = 0;
for (let frame = 0; frame < 30; frame++) {
    const schedule = vehicleAudioScheduleWindow(nextGrainAt, frame / 30, 57);
    nextGrainAt = schedule.nextAt;
    scheduledGrains += schedule.times.length;
}
assert.ok(scheduledGrains >= 54 && scheduledGrains <= 62, `57 Hz REL clock scheduled ${scheduledGrains} grains at 30 FPS`);

const catalog = JSON.parse(await readFile(new URL('../assets/custom_vehicles/catalog.json', import.meta.url), 'utf8'));
const kinds = new Set((catalog.vehicles || []).map((vehicle) => vehicleAudioProfile(vehicle.audioNameHash).kind));
assert.ok(kinds.size >= 6, 'custom vehicle audio hashes should map to differentiated engine families');

const carrera = catalog.vehicles.find((vehicle) => String(vehicle.model).toLowerCase() === 'cgt');
assert.equal(String(carrera?.audioNameHash).toUpperCase(), 'COQUETTE');
const manifest = JSON.parse(await readFile(new URL('../assets/vehicle_audio/manifest.json', import.meta.url), 'utf8'));
const controller = manifest.controllers?.COQUETTE;
assert.ok(controller?.bank, 'COQUETTE must resolve to an authored REL bank');
const clips = manifest.banks?.[controller.bank]?.clips;
const requiredClips = ['engine_idle', 'engine_accel', 'engine_decel', 'exhaust_idle', 'exhaust_accel', 'exhaust_decel'];
for (const name of requiredClips) {
    assert.ok(clips?.[name], `COQUETTE is missing ${name}`);
    assert.equal(vehicleAudioAssetUrl(clips[name]), `/assets/${clips[name]}`);
    await access(new URL(`../assets/${clips[name]}`, import.meta.url));
}

console.log(`vehicle audio profiles: ${catalog.vehicles.length} vehicles map across ${kinds.size} engine families; COQUETTE authored bank ${controller.bank} is complete`);

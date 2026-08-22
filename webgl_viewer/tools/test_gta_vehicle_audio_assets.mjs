import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const expectedBanks = ['hybrid', 'rig_1', 'supercar_1', 'muscle_car_1', '4_cylinder_sport_1', 'v8_luxury_1', 'regular_saloon_1'];
const assets = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const manifest = JSON.parse(await readFile(resolve(assets, 'vehicle_audio/manifest.json'), 'utf8'));
assert.equal(manifest.schema, 'webglgta-gta-vehicle-rel-granular-v5', 'vehicle manifest must include the authored REL and AWC granular data');
for (const bank of expectedBanks) assert.ok(manifest.banks?.[bank], `missing fallback bank ${bank}`);
for (const [bank, definition] of Object.entries(manifest.banks || {})) {
    const clips = definition?.clips;
    const expectedClips = ['engine_idle', 'engine_accel', 'engine_decel', 'exhaust_idle', 'exhaust_accel', 'exhaust_decel'];
    assert.deepEqual(Object.keys(clips || {}).sort(), expectedClips.sort(), `${bank} needs GTA granular engine and exhaust clips`);
    for (const layer of Object.values(clips)) {
        const path = resolve(assets, layer);
        await access(path);
        assert.ok((await stat(path)).size > 2_048, `${layer} is unexpectedly small`);
    }
    for (const clip of expectedClips) {
        const authored = definition?.granular?.[clip];
        assert.ok(authored?.sampleCount > 1, `${bank}/${clip} needs its authored AWC sample range`);
        assert.ok(authored?.grains?.length, `${bank}/${clip} needs authored AWC grain offsets`);
        assert.ok(authored?.loops?.length, `${bank}/${clip} needs an authored AWC loop sequence`);
        for (const [offset, nativeRate] of authored.grains) {
            assert.ok(Number.isInteger(offset) && offset >= 0 && offset < authored.sampleCount, `${bank}/${clip} has an invalid AWC grain offset`);
            assert.ok(Number.isFinite(nativeRate) && nativeRate > 0, `${bank}/${clip} has an invalid AWC grain clock`);
        }
        for (const loop of authored.loops) {
            assert.ok(loop.length, `${bank}/${clip} has an empty AWC loop`);
            for (const index of loop) assert.ok(Number.isInteger(index) && index >= 0 && index < authored.grains.length, `${bank}/${clip} loop has an invalid grain index`);
        }
    }
}
for (const audioNameHash of ['SULTAN', 'ADDER', 'FUSILADE']) {
    const controller = manifest.controllers?.[audioNameHash];
    assert.ok(controller, `${audioNameHash} needs an authored GTA REL controller`);
    assert.ok(controller.engine?.granularClock?.length, `${audioNameHash} needs REL grain clock data`);
    assert.equal(controller.engine.channels?.length, 6, `${audioNameHash} needs six REL granular channel settings`);
    assert.equal(typeof controller.granular?.engineVolumePreSubmix, 'number', `${audioNameHash} needs REL engine pre-submix gain`);
    assert.equal(typeof controller.granular?.exhaustVolumePreSubmix, 'number', `${audioNameHash} needs REL exhaust pre-submix gain`);
    assert.equal(typeof controller.granular?.engineMaxConeAttenuation, 'number', `${audioNameHash} needs REL engine cone attenuation`);
    assert.equal(typeof controller.granular?.engineClutchAttenuationPostSubmix, 'number', `${audioNameHash} needs REL clutch attenuation`);
    assert.ok(controller.bank && manifest.banks?.[controller.bank], `${audioNameHash} needs its resolved GTA AWC bank`);
}
assert.equal(manifest.banks[manifest.controllers.SULTAN.bank].sourceBank, 'sports_saloon_3_pj_6cyl.awc', 'SULTAN must use its resolved GTA source bank');
assert.ok(Object.keys(manifest.controllers || {}).length >= 80, 'expected REL controllers for the demo vehicle set');
for (const [audioNameHash, controller] of Object.entries(manifest.controllers || {})) {
    assert.ok(controller.bank && manifest.banks?.[controller.bank], `${audioNameHash} must resolve to an exported GTA AWC bank`);
}
const bankClipCount = Object.values(manifest.banks).reduce((count, bank) => count + Object.keys(bank.clips || {}).length, 0);
console.log(`GTA vehicle audio assets: ${Object.keys(manifest.banks).length} granular banks, ${bankClipCount} Opus clips, and ${Object.keys(manifest.controllers).length} REL controllers verified`);

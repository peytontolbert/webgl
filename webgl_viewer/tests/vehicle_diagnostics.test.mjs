import assert from 'node:assert/strict';
import test from 'node:test';
import { VehicleDiagnostics } from '../js/gameplay/vehicle_diagnostics.js';

test('vehicle diagnostics captures fixed-step samples and events only while recording', () => {
    const recorder = new VehicleDiagnostics({ maxSamples: 60 });
    recorder.capture(1 / 60, { ignored: true });
    recorder.start({ label: 'acceleration', physicsMode: 'assetto' });
    recorder.capture(0.01, { speed: 1 });
    recorder.event('shift', { gear: 2 });
    recorder.capture(0.01, { speed: 2 });
    recorder.capture(0.01, { speed: 3 });
    recorder.stop();
    const snapshot = recorder.snapshot();
    assert.equal(snapshot.schema, 'webglgta-vehicle-telemetry-v1');
    assert.equal(snapshot.label, 'acceleration');
    assert.equal(snapshot.sampleCount, 3);
    assert.equal(snapshot.events[0].type, 'shift');
    assert.equal(snapshot.samples.at(-1).speed, 3);
});

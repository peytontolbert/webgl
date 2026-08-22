import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { assettoLongitudinalPitchDelta, createAssettoVehicleState, stepAssettoVehicle } from '../js/gameplay/assetto_vehicle_solver.js';

const contacts = {
    contacts: {
        27922: { grounded: true, grip: 1 }, 26418: { grounded: true, grip: 1 },
        27902: { grounded: true, grip: 1 }, 26398: { grounded: true, grip: 1 },
    },
};

const profile = {
    mass: 1250, wheelbase: 2.65, trackFront: 1.5, trackRear: 1.5,
    centerOfGravityFrontFraction: 0.52, driveBiasFront: 0, brakeBiasFront: 0.64,
    steeringLock: 32, finalDrive: 3.9, gearRatios: [3.4, 2.1, 1.4, 1.0],
    redlineRpm: 7000, shiftTimeUpSec: 0.18, shiftTimeDownSec: 0.16,
    brakeTorqueNm: 3000, engineTorqueCurveNm: [[0, 190], [3000, 235], [6500, 200], [7200, 0]],
    tyres: {
        front: { radius: 0.31, angularInertia: 1.2, peakLongitudinalMu: 1.15, peakLateralMu: 1.2, referenceLoadN: 3200 },
        rear: { radius: 0.31, angularInertia: 1.3, peakLongitudinalMu: 1.18, peakLateralMu: 1.22, referenceLoadN: 3000 },
    },
};

test('Assetto load transfer raises the hood under forward acceleration', () => {
    const compliant = { ...profile, centerOfGravityHeightM: 0.52, suspension: { front: { springRateNpm: 32760 }, rear: { springRateNpm: 34500 } } };
    const forward = assettoLongitudinalPitchDelta(compliant, 5);
    const reverse = assettoLongitudinalPitchDelta(compliant, -5);
    const stiff = assettoLongitudinalPitchDelta({ ...compliant, suspension: { front: { springRateNpm: 90000 }, rear: { springRateNpm: 90000 } } }, 5);
    assert.ok(forward > 0, `forward acceleration must be nose-up, got ${forward}`);
    assert.ok(reverse < 0, `reverse acceleration must be nose-down, got ${reverse}`);
    assert.ok(Math.abs(stiff) < Math.abs(forward), 'stiffer springs must reduce longitudinal pitch');
});

test('Assetto four-wheel solver accelerates via engine torque and tracks independent wheel state', () => {
    const state = createAssettoVehicleState();
    let result = null;
    for (let i = 0; i < 360; i++) result = stepAssettoVehicle(state, profile, contacts, { throttle: true, reverse: false, steer: 0, handbrake: false }, 1 / 120);
    assert.ok(result.longitudinal > 3.0, `expected forward motion, got ${result.longitudinal}`);
    assert.ok(result.rpm >= 850);
    assert.ok(result.wheels[27902].omega > 0, 'driven rear wheel should spin');
    assert.equal(result.wheels[27922].grounded, true);
});

test('Assetto reverse gear produces sustained backward motion from rest', () => {
    const state = createAssettoVehicleState();
    let result;
    for (let i = 0; i < 360; i++) result = stepAssettoVehicle(state, profile, contacts, { throttle: false, reverse: true, steer: 0, handbrake: false }, 1 / 120);
    assert.ok(result.reverse, 'reverse transmission state must be active');
    assert.ok(result.longitudinal < -2.5, `expected backward motion, got ${result.longitudinal}`);
    assert.ok(result.wheels['27902'].omega < 0 && result.wheels['26398'].omega < 0, 'driven rear wheels must rotate backward');
});

test('Assetto four-wheel solver brakes a moving vehicle without changing the GTA path', () => {
    const state = createAssettoVehicleState();
    state.longitudinal = 22;
    for (const key of Object.keys(state.wheelOmega)) state.wheelOmega[key] = 22 / 0.31;
    let result = null;
    for (let i = 0; i < 300; i++) result = stepAssettoVehicle(state, profile, contacts, { throttle: false, reverse: false, steer: 0, handbrake: false }, 1 / 120);
    const coastSpeed = result.longitudinal;
    for (let i = 0; i < 300; i++) result = stepAssettoVehicle(state, profile, contacts, { throttle: false, reverse: true, steer: 0, handbrake: false }, 1 / 120);
    assert.ok(result.longitudinal < coastSpeed - 1, `expected braking to reduce ${coastSpeed}, got ${result.longitudinal}`);
});

test('Assetto four-wheel solver creates a stable yaw response from front steering', () => {
    const state = createAssettoVehicleState();
    let result = null;
    for (let i = 0; i < 480; i++) result = stepAssettoVehicle(state, profile, contacts, { throttle: true, reverse: false, steer: 0.35, handbrake: false }, 1 / 120);
    assert.ok(result.longitudinal > 3, 'vehicle must be moving before yaw is meaningful');
    assert.ok(result.yawRate > 0.02, `expected positive yaw from positive steering, got ${result.yawRate}`);
    assert.ok(Math.abs(result.wheels[27922].slipAngle) > 0.001, 'front tyre must report lateral slip');
});

test('Assetto steering retains useful authored authority at road speed and lets tyres limit the turn', () => {
    const state = createAssettoVehicleState();
    state.longitudinal = 30;
    for (const key of Object.keys(state.wheelOmega)) {
        const front = key === '27922' || key === '26418';
        state.wheelOmega[key] = state.longitudinal / (front ? profile.tyres.front.radius : profile.tyres.rear.radius);
    }
    let result;
    for (let index = 0; index < 120; index++) result = stepAssettoVehicle(state, profile, contacts, { throttle: false, reverse: false, steer: 1, handbrake: false }, 1 / 120);
    const authoredLockRad = profile.steeringLock * Math.PI / 180;
    assert.ok(result.steeringRad > authoredLockRad * 0.72, `speed must retain useful authored steering authority (${result.steeringRad} vs ${authoredLockRad})`);
    assert.ok(Number.isFinite(result.yawRate) && Math.abs(result.yawRate) < 2, `tyre-limited yaw must remain stable, got ${result.yawRate}`);
});

test('350Z calibration retains its active tyre compound and quadratic body aero', () => {
    const profile = JSON.parse(fs.readFileSync(new URL('../assets/physics/assetto-corsa/350z.json', import.meta.url), 'utf8')).assettoHandling;
    assert.equal(profile.tyres.front.compoundSection, 'FRONT_1');
    assert.equal(profile.tyres.rear.compoundSection, 'REAR_1');
    assert.ok(profile.tyres.front.peakLongitudinalMu > 1.1);
    assert.ok(profile.aeroDragNPerMps2 > 0.4 && profile.aeroDragNPerMps2 < 0.6);
    const state = createAssettoVehicleState();
    let result = null;
    for (let index = 0; index < 120 * 60; index++) result = stepAssettoVehicle(state, profile, contacts, { throttle: true, reverse: false, steer: 0, handbrake: false }, 1 / 120);
    const topKph = result.longitudinal * 3.6;
    assert.ok(topKph > 220 && topKph < 250, `expected aero/gearing-limited 350Z speed, got ${topKph.toFixed(1)} km/h`);
});

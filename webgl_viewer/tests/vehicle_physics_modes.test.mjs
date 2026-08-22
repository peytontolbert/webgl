import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeVehiclePhysicsMode, vehiclePhysicsHandling, vehiclePhysicsModeLabel } from '../js/gameplay/vehicle_physics_modes.js';

test('GTA physics mode leaves authored handling untouched', () => {
    const handling = { mass: 1450, driveForce: 0.3, steeringLock: 35 };
    assert.equal(vehiclePhysicsHandling({ physicsMode: 'gta', handling }), handling);
    assert.equal(normalizeVehiclePhysicsMode('unknown'), 'gta');
    assert.equal(vehiclePhysicsModeLabel('gta'), 'GTA handling');
});

test('Assetto profile produces a separate numerical handling path', () => {
    const gta = { mass: 1450, driveForce: 0.3, brakeForce: 0.8, steeringLock: 35, tractionMax: 2.2, tractionMin: 2.0, tractionLateral: 22.5, tractionLossMult: 1, lowSpeedTractionLossMult: 1, suspensionForce: 2, suspensionCompDamp: 1, suspensionReboundDamp: 1.5, antiRollBarForce: 0.7, brakeBiasFront: 0.5, driveBiasFront: 0 };
    const assetto = vehiclePhysicsHandling({ physicsMode: 'assetto', handling: gta, assettoHandling: { mass: 1230 } });
    assert.equal(assetto.mass, 1230);
    assert.notEqual(assetto.driveForce, gta.driveForce);
    assert.notEqual(assetto.steeringLock, gta.steeringLock);
    assert.equal(vehiclePhysicsModeLabel('assetto'), 'Assetto Corsa profile');
});

test('Assetto-derived tyre and suspension values calibrate the compatible solver fields', () => {
    const handling = vehiclePhysicsHandling({
        physicsMode: 'assetto', handling: { mass: 1450, tractionMax: 2.2, tractionMin: 2, tractionLateral: 22.5 },
        assettoHandling: {
            mass: 1200, centerOfGravityFrontFraction: 0.52,
            tyres: { front: { peakLateralMu: 1.18, peakSlipAngleDeg: 8.2 }, rear: { peakLateralMu: 1.22, peakSlipAngleDeg: 8.6 } },
            suspension: { front: { springRateNpm: 40000, bumpDampingNsPm: 3000, reboundDampingNsPm: 4200, antiRollBarNm: 15000 }, rear: { springRateNpm: 32000, bumpDampingNsPm: 2800, reboundDampingNsPm: 3800, antiRollBarNm: 5000 } },
        },
    });
    assert.equal(handling.tractionMax, 1.2);
    assert.ok(Math.abs(handling.tractionLateral - 8.4) < 1e-9);
    assert.equal(handling.tractionBiasFront, 0.52);
    assert.ok(handling.suspensionForce > 1 && handling.suspensionForce < 2.1);
    assert.ok(handling.antiRollBarForce > 0);
});

test('signed Assetto steering metadata preserves its physical lock magnitude', () => {
    const handling = vehiclePhysicsHandling({ physicsMode: 'assetto', handling: {}, assettoHandling: { steeringLock: -23.8 } });
    assert.equal(handling.steeringLock, 23.8);
});

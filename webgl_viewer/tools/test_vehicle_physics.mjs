import assert from 'node:assert/strict';
import { VehicleController, vehicleGearTopFractions, vehicleSteeringScale } from '../js/gameplay/vehicle_controller.js';

const gearFractions = vehicleGearTopFractions(6);
assert.equal(gearFractions.length, 6);
assert.equal(gearFractions.at(-1), 1);
assert.ok(gearFractions.every((fraction, index) => index === 0 || fraction > gearFractions[index - 1]), 'gear top speeds must increase monotonically');
assert.ok(vehicleSteeringScale(35) < vehicleSteeringScale(5) * 0.35, 'high-speed steering must be substantially reduced');

let groundZ = 0;
let groundQueryCount = 0;
let destructibleScanCount = 0;
let npcImpactScanCount = 0;
const app = {
    spawnDistrictDemo: false,
    player: { headingRad: 0, handsUp: false },
    ped: { posData: [0, 0, 1.2], posView: [0, 0, 0] },
    pedEyeHeightData: 1.2,
    collisionWorld: {
        resolveGround() { groundQueryCount++; return { z: groundZ, source: 'test_ground', material: 'concrete' }; },
        moveCapsule({ x, y, vx, vy, dt }) { return { x: x + vx * dt, y: y + vy * dt, vx, vy, blocked: false, ground: { z: 0, source: 'test_ground' } }; },
        findDestructibleImpact() { destructibleScanCount++; return null; },
        destroyDestructibleForImpact() { return null; },
    },
    npcSystem: { applyVehicleImpacts() { npcImpactScanCount++; return []; } },
    _resetPedMotion() {},
    _setGtaThirdPersonRigForPed() {},
    _dataToViewer(value) { return value; },
};

const controller = new VehicleController(app);

const demoApp = {
    ...app,
    spawnDistrictDemo: true,
    spawnDistrictBounds: { minX: -100, minY: -100, maxX: 100, maxY: 100 },
    ped: null,
    player: { headingRad: 0, handsUp: false },
};
const demoController = new VehicleController(demoApp);
demoController.customCatalog = {
    defaultVehicle: 'demo_car',
    vehicles: [{ model: 'demo_car', hash: '42', name: 'Demo Car', groundOffset: 0.4 }],
};
demoController._customCatalogResolved = true;
demoController.setManifest({ garages: [{ coords: { x: 70, y: 70, z: 0, w: 0 }, source: 'far garage' }] });
assert.equal(demoController.vehicle, null, 'demo vehicle must wait for the ped instead of using a distant garage fallback');
demoApp.ped = { posData: [10, 20, 1.2], posView: [10, 20, 1.2] };
demoController.update({ keyState: {}, dt: 1 / 60 });
assert.ok(demoController.vehicle, 'demo vehicle should spawn once the ped exists');
assert.equal(demoController.vehicle.source, 'demo_spawn_near_ped', 'demo vehicle must not use the pre-ped garage fallback');
assert.ok(demoController.getDistanceToPlayer() >= 7 && demoController.getDistanceToPlayer() <= 10, 'demo vehicle should be visible and reachable near the ped');

controller.spawnVehicle({
    model: 'testcar', hash: '1', name: 'Test Car',
    coords: { x: 0, y: 0, z: 0, w: 0 },
    wheelRadius: 0.3,
    wheelRadii: { 27922: 0.31, 26418: 0.31, 27902: 0.29, 26398: 0.29 },
    wheelPivots: {
        27922: [-0.75, 1.25, -0.2], 26418: [0.75, 1.25, -0.2],
        27902: [-0.75, -1.25, -0.2], 26398: [0.75, -1.25, -0.2],
    },
    driverSeat: [-0.35, 0.0, 0.1],
    camera: { povOffset: [0.04, -0.16, 0.61], povRollCageAdjustment: -0.01 },
    damage: { bodyHealth: 1200, mapScale: 0.4, offsetScale: 0.7, weaponForceMult: 1.0 },
    handling: {
        mass: 1450, dragCoeff: 7.5, centerOfMass: [0.0, 0.08, -0.1], inertiaMultiplier: [1.0, 1.2, 1.4],
        driveForce: 0.34, driveInertia: 1.1, clutchChangeRateUpShift: 4.0, clutchChangeRateDownShift: 3.5,
        maxFlatVelocity: 220, brakeForce: 0.9, brakeBiasFront: 0.62, handBrakeForce: 0.9, steeringLock: 38,
        tractionMax: 2.3, tractionMin: 2.0, tractionLateral: 22.5, tractionBiasFront: 0.52, tractionLossMult: 1.0,
        lowSpeedTractionLossMult: 1.2, suspensionForce: 2.5, suspensionCompDamp: 1.4, suspensionReboundDamp: 2.0,
        suspensionUpperLimit: 0.09, suspensionLowerLimit: -0.11, antiRollBarForce: 0.85, antiRollBarBiasFront: 0.55,
        rollCentreHeightFront: 0.4, rollCentreHeightRear: 0.38, collisionDamageMult: 0.5,
        deformationDamageMult: 0.7, engineDamageMult: 1.5, downforceModifier: 0.1, driveBiasFront: 0.35, gears: 6,
    },
});
controller.inVehicle = true;

controller.update({ keyState: { w: true }, dt: 1 / 60 });
assert.ok(controller.vehicle.throttle > 0 && controller.vehicle.throttle < 1, 'throttle should build over a short drivetrain response window');

for (let frame = 0; frame < 180; frame++) controller.update({ keyState: { w: true }, dt: 1 / 60 });
assert.ok(controller.vehicle.speed > 5, 'throttle should produce forward motion');
assert.ok(controller.vehicle.rpm > 850, 'drivetrain should raise engine RPM');
assert.ok(controller.vehicle.gear >= 1, 'automatic gearbox should remain in a valid gear');
assert.ok(controller.vehicle.gear > 1, 'sustained acceleration should produce an upshift');
assert.ok(controller.vehicle.bodyPitch > 0, `forward acceleration must raise the hood (pitch=${controller.vehicle.bodyPitch})`);
assert.equal(Object.keys(controller.vehicle.wheelStates).length, 4, 'all four wheel states should be populated');
assert.ok(Object.values(controller.vehicle.wheelStates).every((wheel) => Number.isFinite(wheel.spinRad)), 'wheel rotation should be tracked per wheel');
assert.ok(Object.values(controller.vehicle.wheelStates).every((wheel) => wheel.grounded), 'wheels within suspension reach should be grounded');
assert.ok(Object.values(controller.vehicle.wheelStates).every((wheel) => Number.isFinite(wheel.suspensionOffset)), 'per-wheel suspension travel should be exported to rendering');

groundQueryCount = 0;
destructibleScanCount = 0;
npcImpactScanCount = 0;
controller.update({ keyState: { w: true }, dt: 1 / 30 });
assert.equal(controller._lastPhysicsStats.substeps, 2, 'a 30 FPS frame should use two swept 60 Hz physics steps');
assert.ok(groundQueryCount >= 4 && groundQueryCount <= 8, 'driving contacts must remain fresh while allowing short-lived YBN probe reuse');
assert.equal(destructibleScanCount, 1, 'broad destructible scanning should run once per rendered frame');
assert.equal(npcImpactScanCount, 1, 'NPC impact scanning should run once per rendered frame');

controller.vehicle.speed = 5;
controller.vehicle.velocityLocal = [5, 0];
controller.vehicle.yawRate = 0;
controller._movingWheelContactSeconds = Number.POSITIVE_INFINITY;
groundQueryCount = 0;
for (let frame = 0; frame < 30; frame++) controller.update({ keyState: {}, dt: 1 / 60 });
assert.ok(groundQueryCount <= 64, 'normal driving should not resample all four wheel contacts at every 60 Hz simulation step');

controller.vehicle.speed = 0;
controller.vehicle.velocityLocal = [0, 0];
controller.vehicle.yawRate = 0;
controller.vehicle.throttle = 0;
controller.vehicle.brake = 0;
controller.vehicle.steering = 0;
groundQueryCount = 0;
destructibleScanCount = 0;
npcImpactScanCount = 0;
for (let frame = 0; frame < 12; frame++) controller.update({ keyState: {}, dt: 1 / 60 });
assert.ok(groundQueryCount <= 8, 'a stationary occupied vehicle should reuse wheel contacts instead of querying all four wheels every frame');
assert.equal(destructibleScanCount, 0, 'a stationary occupied vehicle must skip broad destructible impact scans');
assert.equal(npcImpactScanCount, 0, 'a stationary occupied vehicle must skip NPC impact scans');

const settledSuspension = controller.vehicle.wheelStates['27922'].suspensionOffset;
groundZ = -0.06;
controller.update({ keyState: { w: true }, dt: 1 / 60 });
const filteredSuspension = controller.vehicle.wheelStates['27922'].suspensionOffset;
assert.ok(filteredSuspension < settledSuspension && filteredSuspension > settledSuspension - 0.06, 'visual suspension should damp abrupt contact-height changes');
groundZ = 0;

const headingBeforeTurn = controller.vehicle.headingRad;
for (let frame = 0; frame < 90; frame++) controller.update({ keyState: { w: true, a: true }, dt: 1 / 60 });
assert.notEqual(controller.vehicle.headingRad, headingBeforeTurn, 'steering should change heading');
assert.ok(Math.abs(controller.vehicle.steeringRad) > 0.01, 'front tire steering angle should be tracked');
assert.notEqual(controller.vehicle.wheelStates['27922'].steeringRad, controller.vehicle.wheelStates['26418'].steeringRad, 'front tires should use Ackermann steering angles');
assert.ok(Number.isFinite(controller.vehicle.bodyPitch) && Number.isFinite(controller.vehicle.bodyRoll), 'terrain pose must remain finite');

const speedBeforeBrake = Math.abs(controller.vehicle.speed);
for (let frame = 0; frame < 90; frame++) controller.update({ keyState: { s: true }, dt: 1 / 60 });
assert.ok(Math.abs(controller.vehicle.speed) < speedBeforeBrake, 'braking should reduce longitudinal speed');

const camera = controller.getDriverCameraTransform();
assert.ok(camera?.position?.every(Number.isFinite), 'driver first-person camera anchor should be finite');
const renderState = controller.getRenderState();
assert.equal(renderState.audioNameHash, 'SULTAN', 'render state should retain an audio profile identifier');
assert.notEqual(renderState.position, controller.vehicle.position, 'render-state position must remain a snapshot buffer');
assert.equal(controller.getRenderState(), renderState, 'per-frame render state should reuse its outer object');

controller.applyDamage(100, 'world_collision');
assert.equal(Math.round(controller.vehicle.damage), 35, 'collision and deformation metadata should scale visible body damage');
assert.equal(Math.round(controller.vehicle.engineHealth), 978, 'engine damage multiplier should reduce engine condition');

controller.vehicle.speed = 0;
controller.vehicle.velocityLocal = [0, 0];
groundZ = -10;
const airborneStartZ = controller.vehicle.position[2];
for (let frame = 0; frame < 20; frame++) controller.update({ keyState: {}, dt: 1 / 60 });
assert.ok(Object.values(controller.vehicle.wheelStates).every((wheel) => !wheel.grounded), 'wheels beyond suspension reach should be airborne');
assert.ok(controller.vehicle.position[2] < airborneStartZ, 'an airborne chassis should fall under gravity');
groundZ = 0;
for (let frame = 0; frame < 60; frame++) controller.update({ keyState: {}, dt: 1 / 60 });
assert.ok(Object.values(controller.vehicle.wheelStates).some((wheel) => wheel.grounded), 'wheel contacts should recover on landing');

controller.vehicle.position = [0, 0, controller.vehicle.groundOffset];
controller.vehicle.headingRad = 0;
controller.vehicle.speed = 0;
controller.vehicle.velocityLocal = [0, 0];
controller.vehicle.yawRate = 0;
controller.vehicle.steering = 0;
controller.vehicle.steeringRad = 0;
controller.vehicle.gear = 5;
for (let frame = 0; frame < 180; frame++) controller.update({ keyState: { s: true }, dt: 1 / 60 });
assert.ok(controller.vehicle.speed < -7, 'holding reverse from rest should produce useful reverse speed');
assert.ok(controller.vehicle.speed >= -18.01, 'reverse must respect its dedicated speed ceiling');
assert.equal(controller.vehicle.gear, 1, 'reverse must not inherit a high forward gear');
assert.equal(controller.vehicle.transmissionDirection, -1, 'reverse transmission state should be explicit');
assert.ok(controller.vehicle.bodyPitch < 0, `reverse acceleration must lower the hood (pitch=${controller.vehicle.bodyPitch})`);
assert.match(controller.getStatusLine(), /gear R/, 'vehicle diagnostics should report reverse gear');

const reverseHeadingStart = controller.vehicle.headingRad;
for (let frame = 0; frame < 90; frame++) controller.update({ keyState: { s: true, a: true }, dt: 1 / 60 });
assert.ok(controller.vehicle.headingRad < reverseHeadingStart, 'left steering while reversing should rotate opposite to forward travel');
assert.ok(Number.isFinite(controller.vehicle.yawRate) && Math.abs(controller.vehicle.yawRate) < 2.0, 'reverse yaw must stay finite and controlled');

for (let frame = 0; frame < 240; frame++) controller.update({ keyState: { w: true }, dt: 1 / 60 });
assert.ok(controller.vehicle.speed > 3, `forward throttle should brake out of reverse and resume forward drive (speed=${controller.vehicle.speed.toFixed(3)}, throttle=${controller.vehicle.throttle.toFixed(3)}, brake=${controller.vehicle.brake.toFixed(3)}, lateral=${controller.vehicle.velocityLocal[1].toFixed(3)}, yaw=${controller.vehicle.yawRate.toFixed(3)})`);
assert.equal(controller.vehicle.transmissionDirection, 1, 'transmission should return to forward state');

controller.vehicle.physicsMode = 'assetto';
controller.vehicle.assettoHandling = {
    mass: 1245, wheelbase: 2.649, trackFront: 1.534, trackRear: 1.544,
    centerOfGravityFrontFraction: 0.53, driveBiasFront: 0, brakeBiasFront: 0.68,
    steeringLock: 17.3, finalDrive: 3.538, gearRatios: [2.633, 1.866, 1.457, 1.179, 1, 0.889],
    redlineRpm: 7500, idleRpm: 750, brakeTorqueNm: 2700,
    engineTorqueCurveNm: [[0, 0], [3000, 351], [5000, 390], [7500, 271]],
    suspension: { front: { springRateNpm: 32760 }, rear: { springRateNpm: 34500 } },
    tyres: { front: { radius: 0.342, peakLongitudinalMu: 1.2, peakLateralMu: 1.25 }, rear: { radius: 0.3, peakLongitudinalMu: 1.2, peakLateralMu: 1.25 } },
};
controller.vehicle.position = [0, 0, controller.vehicle.groundOffset];
controller.vehicle.speed = 0;
controller.vehicle.velocityLocal = [0, 0];
controller.vehicle.bodyPitch = 0;
controller.resetAssettoState({ preserveMotion: false });
for (let frame = 0; frame < 180; frame++) controller.update({ keyState: { w: true }, dt: 1 / 60 });
assert.ok(controller.vehicle.bodyPitch > 0, `Assetto forward acceleration must raise the hood (pitch=${controller.vehicle.bodyPitch})`);
controller.vehicle.speed = 0;
controller.vehicle.velocityLocal = [0, 0];
controller.vehicle.bodyPitch = 0;
controller.resetAssettoState({ preserveMotion: false });
for (let frame = 0; frame < 180; frame++) controller.update({ keyState: { s: true }, dt: 1 / 60 });
assert.ok(controller.vehicle.bodyPitch < 0, `Assetto reverse acceleration must lower the hood (pitch=${controller.vehicle.bodyPitch})`);
assert.ok(controller.vehicle.speed < -2.5, `Assetto reverse must move the vehicle backward (speed=${controller.vehicle.speed})`);
assert.equal(controller.vehicle.transmissionDirection, -1, 'Assetto reverse transmission state must report R');

console.log('vehicle physics: drivetrain, reverse, tire model, suspension, damage, terrain contact, braking, and driver camera passed');

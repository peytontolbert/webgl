import assert from 'node:assert/strict';

const spawned = [];
const intervalCallbacks = [];
let now = 10_000;
const priorNow = Date.now;
Date.now = () => now;
const assertNear = (actual, expected, epsilon = 1e-8) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);
const cityBounds = { minX: -1813.06, minY: -2850.84, maxX: 2186.94, maxY: 1149.16 };
const trackBounds = { minX: 4879.767431878325, minY: -5621.812081087741, maxX: 11007.975662935669, maxY: -799.9227851887806 };
const world = {
    resolveGround: (x) => Math.abs(x - 7000.023681640625) < 0.01
        ? { source: 'track', z: 31.99848747253418, material: 'asph-nurb' }
        : { source: 'ybn', z: 31.17, material: 'asphalt' },
    getDerivedRoadSpawn: () => [7000.023681640625, -849.9922180175781, 31.99848747253418],
    moveCapsule: (args) => ({ ...args, blocked: false }),
    moveVehicle: (args) => ({ ...args, blocked: false }),
};
const vehicle = { position: [0, 0, 0], velocity: [3, 4, 0], velocityLocal: [1, 2], speed: 5, yawRate: 0.4, groundOffset: 0.4 };
const viewer = {
    spawnDistrictDemo: true,
    spawnDistrictBounds: cityBounds,
    _nordschleifeActive: false,
    _spawnDistrictDescriptor: { spawn: { x: 186.94, y: -850.84, pedZ: 31.17 } },
    pedEyeHeightData: 1.2,
    ped: { posData: [186.94, -850.84, 32.37] },
    collisionWorld: world,
    vehicleController: { inVehicle: false, vehicle, _syncOccupantPed: () => {} },
    spawnPedAt: (position, options) => { spawned.push({ position, options }); viewer.ped.posData = [...position]; },
    _setGtaThirdPersonRigForPed: () => {},
    _getSpawnDistrictCameraRig: () => ({}),
};

globalThis.window = {
    __viewerApp: viewer,
    requestAnimationFrame: (callback) => callback(),
    setInterval: (callback) => { intervalCallbacks.push(callback); return intervalCallbacks.length; },
};
await import(new URL('../nexus_extensions/nexus_demo_boundary_recovery.js?boundary-test=1', import.meta.url));

const inBoundsOptions = { groundSource: 'normal_spawn' };
viewer.spawnPedAt([187, -851, 32], inBoundsOptions);
assert.deepEqual(spawned.at(-1).position, [187, -851, 32]);
assert.strictEqual(spawned.at(-1).options, inBoundsOptions);
const inBoundsPed = world.moveCapsule({ x: 187, y: -851, feetZ: 31, vx: 1, vy: 0 });
assert.equal(inBoundsPed.blocked, false);
assert.equal(inBoundsPed.x, 187);
const inBoundsVehicle = world.moveVehicle({ x: 187, y: -851, feetZ: 31, vx: 1, vy: 0 });
assert.equal(inBoundsVehicle.blocked, false);
assert.equal(inBoundsVehicle.x, 187);

viewer.spawnPedAt([9999, -850, 20], { groundSource: 'bad_input' });
assert.deepEqual(spawned.at(-1).position.slice(0, 2), [186.94, -850.84]);
assertNear(spawned.at(-1).position[2], 32.37);
assert.equal(spawned.at(-1).options.groundSource, 'demo_bounds_recovery');

const pedRecovery = world.moveCapsule({ x: 9999, y: -850, feetZ: 20, vx: 4, vy: 0 });
assert.equal(pedRecovery.reason, 'demo_bounds_recovery');
assert.deepEqual([pedRecovery.x, pedRecovery.y, pedRecovery.vx, pedRecovery.vy], [186.94, -850.84, 0, 0]);

viewer.vehicleController.inVehicle = true;
const vehicleRecovery = world.moveVehicle({ x: 9999, y: -850, feetZ: 20, vx: 4, vy: 0 });
assert.equal(vehicleRecovery.reason, 'demo_bounds_recovery');
assert.equal(vehicleRecovery.surface, 'asphalt');
viewer.ped.posData = [9999, -850, 20];
intervalCallbacks[0]();
now += 1_001;
intervalCallbacks[0]();
assert.deepEqual(vehicle.position.slice(0, 2), [186.94, -850.84]);
assertNear(vehicle.position[2], 31.57);
assert.deepEqual(vehicle.velocity, [0, 0, 0]);

viewer.vehicleController.inVehicle = false;
viewer._nordschleifeActive = true;
viewer.spawnDistrictBounds = trackBounds;
viewer.spawnPedAt([4000, -850, 20]);
assert.deepEqual(spawned.at(-1).position.slice(0, 2), [7000.023681640625, -849.9922180175781]);
assertNear(spawned.at(-1).position[2], 33.19848747253418);
assert.equal(viewer._demoBoundsRecovery.kind, 'track');
Date.now = priorNow;
console.log('demo boundary recovery passed');

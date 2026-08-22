import assert from 'node:assert/strict';

const storage = new Map();
const fakeBody = { innerHTML: '', querySelector: () => ({}), querySelectorAll: () => [] };
const fakeElement = () => ({
    style: {},
    append: () => {},
    querySelector: (selector) => selector === '.nxChBody' ? fakeBody : {},
    querySelectorAll: () => [],
});

const spawns = [];
const activated = [];
const viewer = {
    ped: {},
    spawnDistrictDemo: true,
    spawnDistrictBounds: { minX: -1813.06, minY: -2850.84, maxX: 2186.94, maxY: 1149.16 },
    pedEyeHeightData: 1.2,
    playerController: { _lastGroundContact: { source: 'city' } },
    collisionWorld: {
        getDerivedRoadBounds: () => ({ minX: 4879.767431878325, minY: -5621.812081087741, maxX: 11007.975662935669, maxY: -799.9227851887806 }),
        getDerivedRoadSpawn: () => [7000.023681640625, -849.9922180175781, 31.99848747253418],
        resolveGround: (x) => Math.abs(x - 7000.023681640625) < 0.01
            ? { source: 'track', z: 31.99848747253418 }
            : { source: 'runtime', z: 0 },
    },
    _setNurburgringActive: (value) => { activated.push(value); return true; },
    spawnPedAt: (position, options) => spawns.push({ position, options }),
    _setGtaThirdPersonRigForPed: () => {},
    _getSpawnDistrictCameraRig: () => ({}),
    _initGameplayCameraFromCurrentPose: () => {},
    _syncMultiplayerHud: () => {},
};
const client = {
    app: viewer,
    connect: () => {},
    _onMessage: () => {},
    _onDisconnect: () => {},
    _applyProfile: () => true,
    _captureLocalState: () => ({}),
    _retryMs: 750,
    socket: null,
};

globalThis.window = {
    __viewerApp: { multiplayer: client },
    addEventListener: () => {},
    dispatchEvent: () => {},
};
globalThis.document = { addEventListener: () => {}, createElement: fakeElement, head: { append: () => {} }, body: { append: () => {} } };
globalThis.localStorage = { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) };
globalThis.HTMLInputElement = class HTMLInputElement {};
globalThis.location = { protocol: 'http:', host: 'diagnostic.local' };
globalThis.setInterval = () => 0;
let animationFrameCount = 0;
globalThis.requestAnimationFrame = (callback) => {
    if (animationFrameCount++ === 0) callback();
    return animationFrameCount;
};

const extensionUrl = new URL('../nexus_extensions/nexus_character_select.js', import.meta.url);
await import(`${extensionUrl.href}?track-restore-test=1`);
client._applyProfile({ position: [4879, -849.0400268554688, 31.867361583584547] });

assert.deepEqual(activated, [true]);
assert.equal(spawns.length, 1);
assert.equal(spawns[0].options.groundSource, 'saved_track_recovery');
assert.equal(spawns[0].position[0], 7000.023681640625);
assert.equal(spawns[0].position[1], -849.9922180175781);
assert.equal(spawns[0].position[2], 33.19848747253418);
assert.equal(viewer.playerController._lastGroundContact, null);
console.log('character track-boundary recovery passed');

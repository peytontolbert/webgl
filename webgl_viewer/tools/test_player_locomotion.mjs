import assert from 'node:assert/strict';
import { PlayerController } from '../js/gameplay/player_controller.js';

const app = {
    ped: { posData: [0, 0, 1.2], posView: [0, 0, 0] },
    pedEyeHeightData: 1.2,
    player: { headingRad: 0, animGait: 'idle', _lastMoveDirData: [0, 0, 0] },
    camera: { direction: [1, 0, 0], up: [0, 0, 1] },
    keyState: {},
    gameplayMoveConfig: {
        walkSpeed: 1.45, runSpeed: 3.85, sprintSpeed: 6.15,
        walkAcceleration: 2.6, runAcceleration: 4.6, sprintAcceleration: 3.7,
        braking: 6.4, walkTurnRate: 2.2, runTurnRate: 4.25, sprintTurnRate: 3.25,
    },
    _pedVelocityData: [0, 0, 0],
    _pedVerticalVelocityData: 0,
    _pedOnGround: true,
    _dataToViewer(value) { return [...value]; },
    _viewerDirToDataDir(value) { return [...value]; },
    _lerpAngleRad(a, b, t) { return a + (b - a) * t; },
    pedRenderer: { setPositions() {} },
    collisionWorld: {
        moveCapsule({ x, y, vx, vy, dt }) { return { x: x + vx * dt, y: y + vy * dt, vx, vy, blocked: false, ground: { z: 0, source: 'test' } }; },
        resolveGround() { return { z: 0, source: 'test' }; },
    },
    playerModelRenderer: {
        getSkinningAnimationClipDuration(clip) {
            if (clip === 'locomotion_start_walk_left') return 2.066667;
            if (clip === 'locomotion_start_run_left') return 1.733333;
            if (clip === 'locomotion_stop_walk_left') return 3.0;
            if (clip === 'walk') return 3.666667;
            if (clip === 'run') return 2.633333;
            return 0;
        },
        getSkinningAnimationClipRootMotion(clip) {
            const makeFrames = (distance, count = 4) => Array.from({ length: count }, (_, index) => [
                0, distance * (index / (count - 1)), 1,
                0, 0, 0, 1,
            ]);
            if (clip === 'walk') return { frames: makeFrames(4.75) };
            if (clip === 'run') return { frames: makeFrames(12.28) };
            if (clip === 'locomotion_start_walk_left') {
                return { frames: [
                    [0, 0, 1, 0, 0, 0, 1],
                    [0, 0.02, 1, 0, 0, 0, 1],
                    [0, 0.20, 1, 0, 0, 0, 1],
                    [0, 0.70, 1, 0, 0, 0, 1],
                ] };
            }
            if (clip === 'locomotion_stop_walk_left') {
                return { frames: [
                    [0, 0, 1, 0, 0, 0, 1],
                    [0, 0.35, 1, 0, 0, 0, 1],
                    [0, 0.42, 1, 0, 0, 0, 1],
                    [0, 0.42, 1, 0, 0, 0, 1],
                ] };
            }
            return null;
        },
    },
};

const controller = new PlayerController(app, app.collisionWorld);
app.keyState = { w: true };
controller.update(1 / 60);
assert.equal(
    app.player._locomotionTransition?.clip,
    'locomotion_start_walk_left',
    'an unarmed walk must enter its sampled GTA start clip before falling into the walk loop',
);
assert.equal(
    Math.hypot(...app._pedVelocityData),
    0,
    'the initial YCD launch sample must begin at rest instead of receiving a hand-tuned acceleration impulse',
);
controller.update(1 / 60);
assert.ok(
    Math.hypot(...app._pedVelocityData) > 0,
    'the following frame must advance from the sampled native launch curve',
);
assert.equal(
    app.player._locomotionTransition?.duration,
    2.066667,
    'a transition must use its source palette duration when the animation set is ready',
);
for (let frame = 0; frame < 130; frame++) controller.update(1 / 60);
assert.equal(app.player._locomotionTransition, null, 'a locomotion one-shot must retire instead of restarting every render frame');
app.keyState = {};
controller.update(1 / 60);
assert.equal(
    app.player._locomotionTransition?.clip,
    'locomotion_stop_walk_left',
    'releasing movement must enter a sampled GTA stop clip',
);
controller.reset();
app.ped.posData = [0, 0, 1.2];
app.player.headingRad = 0;
app._pedVelocityData = [0, 0, 0];
for (let frame = 0; frame < 150; frame++) {
    app.keyState = { w: true };
    controller.update(1 / 60);
}
assert.equal(app.player._locomotionGait, 'walk', 'normal keyboard movement must select the native walk gait');
assert.ok(app._pedVelocityData[0] > 1.1, 'walk should build toward its configured pace through the native start clip');

const headingBeforeTurn = app.player.headingRad;
const velocityBeforeTurn = [...app._pedVelocityData];
app.keyState = { d: true };
controller.update(1 / 60);
assert.ok(Math.abs(app.player.headingRad - headingBeforeTurn) <= (2.2 / 60) + 1e-6, 'a 90-degree input change must respect the walk turn rate');
assert.ok(Math.abs(app._pedVelocityData[0]) > Math.abs(app._pedVelocityData[1]), 'a single lateral input frame must not snap movement sideways');
assert.ok(Math.hypot(...app._pedVelocityData) < Math.hypot(...velocityBeforeTurn), 'turning before alignment should reduce travel pace');

for (let frame = 0; frame < 36; frame++) {
    app.keyState = { d: true };
    controller.update(1 / 60);
}
assert.ok(app._pedVelocityData[1] < -0.9, 'movement should resume once the ped has turned into the requested direction');

controller.reset();
app.ped.posData = [0, 0, 1.2];
app.player.headingRad = 0;
app._pedVelocityData = [0, 0, 0];
for (let frame = 0; frame < 150; frame++) {
    app.keyState = { w: true };
    controller.update(1 / 60);
}
const reversalSpeed = Math.hypot(...app._pedVelocityData);
app.keyState = { s: true };
controller.update(1 / 60);
assert.ok(Math.hypot(...app._pedVelocityData) < reversalSpeed, 'a hard reversal must brake before it can travel in the opposite direction');
const lateralSpeed = -app._pedVelocityData[0] * Math.sin(app.player.headingRad) + app._pedVelocityData[1] * Math.cos(app.player.headingRad);
assert.ok(Math.abs(lateralSpeed) < 1e-6, 'a hard reversal must keep velocity aligned to the turning body');

controller.reset();
app.keyState = {};
controller.update(1 / 60);
assert.ok(Math.hypot(...app._pedVelocityData) < 1e-6, 'resetting locomotion must clear retained speed after a gameplay interruption');

app.keyState = { w: true, control: true };
controller.update(1 / 60);
assert.equal(app.player._locomotionGait, 'walk', 'Ctrl/Alt movement must preserve the native walk gait');
app.keyState = { w: true, shift: true };
controller.update(1 / 60);
assert.equal(app.player._locomotionGait, 'run', 'Shift movement must select the native run gait');

console.log('player locomotion: native walk/run selection, start timing, reversal braking, and heading-limited turns passed');

import assert from 'node:assert/strict';
import { InstancedModelRenderer } from '../js/instanced_model_renderer.js';
import { getSkinningAnimationFrame } from '../js/skinning_animation_codec.js';

const renderer = Object.create(InstancedModelRenderer.prototype);
const frame0 = Float32Array.from({ length: 24 }, (_, index) => index < 12 ? 1 : 3);
const frame1 = Float32Array.from({ length: 24 }, (_, index) => index < 12 ? 2 : 4);
const clip = { name: 'melee_punch_right', duration: 1, boneCount: 2, frames: [frame0, frame1] };

const first = renderer._sampleSkinningAnimationFrame(clip, 0.24);
const second = renderer._sampleSkinningAnimationFrame(clip, 0.74);
assert.equal(first.data, frame0);
assert.equal(second.data, frame1);
assert.equal(first.key, 'ycd:melee_punch_right:frame:0');
assert.equal(second.key, 'ycd:melee_punch_right:frame:1');

const packed = renderer._packFlatBoneTextureRows(second, [1, 0]);
assert.equal(packed.boneCount, 2);
assert.equal(packed.data[0], 4);
assert.equal(packed.data[12], 2);
const reused = renderer._packFlatBoneTextureRows(first, [1, 0], packed.data);
assert.equal(reused.data, packed.data);
assert.equal(reused.data[0], 3);

function makeAnimationRenderer() {
    const value = Object.create(InstancedModelRenderer.prototype);
    value._skinBaseRows3x4 = [new Array(12).fill(0), new Array(12).fill(0)];
    value._skinTransforms3x4 = value._skinBaseRows3x4;
    value._skinFlatPose = null;
    value._skinPoseVersion = 1;
    value._lastSkinPoseKey = '';
    value._skinAnimationSet = null;
    value.enableSampledYcdSkinning = true;
    return value;
}

const rawFrame0 = Array.from(frame0);
const rawFrame1 = Array.from(frame1);
const primary = makeAnimationRenderer();
const secondary = makeAnimationRenderer();
const animationSet = {
    boneCount: 2,
    clips: {
        walk: { fps: 2, duration: 1, frames3x4: [rawFrame0, rawFrame1] },
        locomotion_start_run_left: { fps: 2, duration: 1, frames3x4: [rawFrame0, rawFrame1] },
        phone_text_in: { fps: 2, duration: 1, frames3x4: [rawFrame0, rawFrame1] },
    },
};
primary.setSkinningAnimationSet(animationSet);
secondary.setSkinningAnimationSet(animationSet);
assert.equal(primary._skinAnimationSet.clips.walk.frames[0], secondary._skinAnimationSet.clips.walk.frames[0]);
assert.equal(primary.getSkinningAnimationClipDuration('LOCOMOTION_START_RUN_LEFT'), 1);
assert.equal(primary.getSkinningAnimationClipDuration('unknown'), 0);

primary._updateSkinningPose({ enabled: true, move01: 1, phase: 0, stride: 1, gait: 'walk', combat: null });
assert.equal(primary._skinFlatPose.data, primary._skinAnimationSet.clips.walk.frames[0]);
const firstPoseVersion = primary._skinPoseVersion;
primary._updateSkinningPose({ enabled: true, move01: 1, phase: Math.PI, stride: 1, gait: 'walk', combat: null });
assert.equal(primary._skinFlatPose.data, primary._skinAnimationSet.clips.walk.frames[1]);
assert.ok(primary._skinPoseVersion > firstPoseVersion);

const transition = { active: true, clip: 'locomotion_start_run_left', progress: 0.75 };
assert.equal(
    primary._selectSkinningAnimationClip({ enabled: true, move01: 0, gait: 'run', combat: null, transition })?.name,
    'locomotion_start_run_left',
    'an unarmed one-shot transition must win over the looping gait clip',
);
primary._updateSkinningPose({ enabled: true, move01: 0, phase: 0, stride: 1, gait: 'run', combat: null, transition });
assert.equal(primary._skinFlatPose.data, primary._skinAnimationSet.clips.locomotion_start_run_left.frames[1]);

primary._updateSkinningPose({
    enabled: false,
    move01: 0,
    phase: Math.PI,
    stride: 1,
    gait: 'idle',
    combat: null,
    gesture: { active: true, clip: 'phone_text_in', samplePhase: true },
});
assert.equal(primary._skinFlatPose.data, primary._skinAnimationSet.clips.phone_text_in.frames[1]);

const compressedClip = {
    boneCount: 1,
    frameCount: 2,
    frameStride: 12,
    frameValues: new Uint16Array([
        ...new Array(12).fill(0x3c00), // float16 1.0
        ...new Array(12).fill(0x4000), // float16 2.0
    ]),
};
const compressedFirst = getSkinningAnimationFrame(compressedClip, 0);
const compressedSecond = getSkinningAnimationFrame(compressedClip, 1);
assert.equal(compressedFirst.length, 12);
assert.equal(compressedFirst[0], 1);
assert.equal(compressedSecond[0], 2);
assert.equal(getSkinningAnimationFrame(compressedClip, 0), compressedFirst);
assert.equal(compressedClip._decodedFrameCache.size, 2);

console.log('skinning palette: direct frame selection, frame sharing, float16 cache, and reusable subset packing passed');

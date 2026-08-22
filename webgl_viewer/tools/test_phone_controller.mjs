import assert from 'node:assert/strict';
import { PhoneController } from '../js/gameplay/phone_controller.js';

const calls = [];
const app = {
    ped: { posData: [0, 0, 0] },
    player: { enabled: true, handsUp: false },
    vehicleController: { inVehicle: false },
    meleeController: { lifeState: 'alive', clearInput: () => calls.push('clearMelee'), getStatus: () => ({ attacking: false }) },
    weaponController: { holsterImmediate: () => calls.push('holster'), clearPointerState: () => calls.push('clearPointer'), isVisible: () => false },
    emotePalette: { stop: () => calls.push('stopEmote') },
    _resetPedMotion: () => calls.push('resetMotion'),
    preparePhoneForUse: async () => true,
    playerModelRenderer: { getSkinningAnimationClipDuration: () => 0 },
};

const phone = new PhoneController(app);
assert.equal(phone.open(), true);
assert.equal(phone.getCharacterPose().clip, 'phone_text_in');
assert.deepEqual(calls, ['holster', 'clearPointer', 'clearMelee', 'stopEmote', 'resetMotion']);

phone.update(1.3);
assert.equal(phone.getCharacterPose().clip, 'phone_text_idle');
assert.equal(phone.startCall(), true);
assert.equal(phone.getCharacterPose().clip, 'phone_text_to_call');
phone.update(0.7);
assert.equal(phone.getCharacterPose().clip, 'phone_call_idle');

assert.equal(phone.startPhoto(), true);
assert.equal(phone.getCharacterPose().clip, 'phone_call_to_text');
phone.update(0.7);
assert.equal(phone.getCharacterPose().clip, 'phone_photo_enter');
phone.update(2.7);
assert.equal(phone.getCharacterPose().clip, 'phone_photo_idle');
assert.equal(phone.getNetworkState().clip, 'phone_photo_idle');

assert.equal(phone.close(), true);
assert.equal(phone.getCharacterPose().clip, 'phone_photo_exit');
phone.update(2.7);
assert.equal(phone.active, false);

app.vehicleController.inVehicle = true;
assert.equal(phone.open(), false);
console.log('phone controller tests passed');

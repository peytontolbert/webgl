const TAU = Math.PI * 2.0;

const PHONE_CLIP_DURATIONS = Object.freeze({
    phone_text_in: 1.1999998,
    phone_text_idle: 4.9333329,
    phone_text_out: 2.3333333,
    phone_call_in: 1.3999996,
    phone_call_idle: 6.0,
    phone_call_out: 1.333333,
    phone_text_to_call: 0.5999999,
    phone_call_to_text: 0.5999999,
    phone_photo_enter: 2.5666668,
    phone_photo_idle: 4.0999999,
    phone_photo_exit: 2.5666666,
    phone_selfie_enter: 1.2000003,
    phone_selfie_idle: 2.3666666,
    phone_selfie_exit: 1.4000001,
});

const LOOPING_CLIPS = new Set([
    'phone_text_idle',
    'phone_call_idle',
    'phone_photo_idle',
    'phone_selfie_idle',
]);

function finite(value, fallback = 0.0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export class PhoneController {
    constructor(app) {
        this.app = app;
        this.clip = '';
        this.elapsed = 0.0;
        this.mode = 'text';
        this._afterClip = '';
    }

    get active() {
        return !!this.clip;
    }

    canUse() {
        const app = this.app;
        return !!app?.ped
            && !!app?.player?.enabled
            && !app?.vehicleController?.inVehicle
            && !app?.player?.handsUp
            && app?.meleeController?.lifeState === 'alive';
    }

    open() {
        if (this.active || !this.canUse()) return false;
        try { this.app.weaponController?.holsterImmediate?.(); } catch { /* ignore */ }
        try { this.app.weaponController?.clearPointerState?.(); } catch { /* ignore */ }
        try { this.app.meleeController?.clearInput?.(); } catch { /* ignore */ }
        try { this.app.emotePalette?.stop?.('phone'); } catch { /* ignore */ }
        try { this.app._resetPedMotion?.(); } catch { /* ignore */ }
        this.mode = 'text';
        this._setClip('phone_text_in');
        void this.app.preparePhoneForUse?.();
        return true;
    }

    toggle() {
        return this.active ? this.close() : this.open();
    }

    close() {
        if (!this.active) return false;
        this._afterClip = 'hide';
        if (this.clip.startsWith('phone_photo_')) {
            this._setClip('phone_photo_exit');
        } else if (this.clip.startsWith('phone_selfie_')) {
            this._setClip('phone_selfie_exit');
        } else if (this.mode === 'call') {
            this._setClip('phone_call_out');
        } else {
            this._setClip('phone_text_out');
        }
        return true;
    }

    startCall() {
        return this._changeMode('call');
    }

    startPhoto() {
        return this._changeMode('photo');
    }

    startSelfie() {
        return this._changeMode('selfie');
    }

    _changeMode(nextMode) {
        if (!this.active || !this.canUse()) return false;
        const mode = String(nextMode || '').toLowerCase();
        if (!['text', 'call', 'photo', 'selfie'].includes(mode)) return false;
        if (mode === this.mode && this.clip.endsWith('_idle')) return false;
        this._afterClip = '';
        if (mode === 'text') {
            if (this.mode === 'call') this._setClip('phone_call_to_text');
            else if (this.mode === 'photo') this._setClip('phone_photo_exit');
            else if (this.mode === 'selfie') this._setClip('phone_selfie_exit');
            else this._setClip('phone_text_idle');
        } else if (mode === 'call') {
            if (this.mode === 'text') this._setClip('phone_text_to_call');
            else if (this.mode === 'photo') {
                this._afterClip = 'phone_text_to_call';
                this._setClip('phone_photo_exit');
            } else if (this.mode === 'selfie') {
                this._afterClip = 'phone_text_to_call';
                this._setClip('phone_selfie_exit');
            } else {
                this._setClip('phone_call_idle');
            }
        } else {
            const enter = mode === 'photo' ? 'phone_photo_enter' : 'phone_selfie_enter';
            if (this.mode === 'call') {
                this._afterClip = enter;
                this._setClip('phone_call_to_text');
            } else if (this.mode === 'photo' || this.mode === 'selfie') {
                this._afterClip = enter;
                this._setClip(this.mode === 'photo' ? 'phone_photo_exit' : 'phone_selfie_exit');
            } else {
                this._setClip(enter);
            }
        }
        this.mode = mode;
        return true;
    }

    update(dt) {
        if (!this.active) return null;
        if (!this.canUse() || this.app?.weaponController?.isVisible?.() || this.app?.meleeController?.getStatus?.()?.attacking) {
            this.hideImmediate();
            return null;
        }

        const duration = this._duration(this.clip);
        this.elapsed += Math.max(0.0, finite(dt));
        if (LOOPING_CLIPS.has(this.clip)) {
            this.elapsed %= duration;
            return this.getCharacterPose();
        }
        if (this.elapsed < duration) return this.getCharacterPose();
        this._advanceAfterClip();
        return this.getCharacterPose();
    }

    getCharacterPose() {
        if (!this.active) return null;
        const duration = this._duration(this.clip);
        return {
            active: true,
            clip: this.clip,
            phase: (Math.max(0.0, Math.min(duration, this.elapsed)) / duration) * TAU,
            samplePhase: true,
            hand: this.clip.startsWith('phone_selfie_') ? 'left' : 'right',
            mode: this.mode,
        };
    }

    getNetworkState() {
        const pose = this.getCharacterPose();
        return pose ? { active: true, clip: pose.clip, mode: pose.mode } : null;
    }

    hideImmediate() {
        const wasActive = this.active;
        this.clip = '';
        this.elapsed = 0.0;
        this.mode = 'text';
        this._afterClip = '';
        return wasActive;
    }

    _advanceAfterClip() {
        const after = this._afterClip;
        this._afterClip = '';
        if (after === 'hide') {
            this.hideImmediate();
            return;
        }
        if (after) {
            this._setClip(after);
            return;
        }
        switch (this.clip) {
            case 'phone_text_in': this._setClip('phone_text_idle'); break;
            case 'phone_call_in': this._setClip('phone_call_idle'); break;
            case 'phone_text_to_call': this._setClip('phone_call_idle'); break;
            case 'phone_call_to_text': this._setClip('phone_text_idle'); break;
            case 'phone_photo_enter': this._setClip('phone_photo_idle'); break;
            case 'phone_selfie_enter': this._setClip('phone_selfie_idle'); break;
            case 'phone_photo_exit': this._setClip('phone_text_idle'); break;
            case 'phone_selfie_exit': this._setClip('phone_text_idle'); break;
            case 'phone_text_out':
            case 'phone_call_out': this.hideImmediate(); break;
            default: this._setClip('phone_text_idle'); break;
        }
    }

    _duration(clip) {
        const native = finite(this.app?.playerModelRenderer?.getSkinningAnimationClipDuration?.(clip));
        return native > 0.01 ? native : (PHONE_CLIP_DURATIONS[clip] || 1.0);
    }

    _setClip(clip) {
        this.clip = clip;
        this.elapsed = 0.0;
    }
}

const VOICE_MODES = Object.freeze([
    Object.freeze({ name: 'Whisper', range: 3 }),
    Object.freeze({ name: 'Normal', range: 7 }),
    Object.freeze({ name: 'Shouting', range: 15 }),
]);

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Number(value) || 0));
}

function setAudioPosition(node, x, y, z) {
    if (!node) return;
    if (node.positionX) {
        node.positionX.value = x;
        node.positionY.value = y;
        node.positionZ.value = z;
    } else {
        node.setPosition?.(x, y, z);
    }
}

export class GameAudioSystem {
    constructor(app) {
        this.app = app;
        this.multiplayer = null;
        this.context = null;
        this.master = null;
        this.ambientGain = null;
        this.sfxGain = null;
        this.voiceGain = null;
        this.ambientEnabled = true;
        this.gameplayEnabled = true;
        this.ambientVolume = 0.28;
        this.sfxVolume = 0.8;
        this.voiceVolume = 1;
        this.voiceModeIndex = 1;
        this.microphoneEnabled = false;
        this.talking = false;
        this.localStream = null;
        this.voicePeers = new Map();
        this._ambientSources = [];
        this._birdTimer = 0;
        this._cityTimer = 0;
        this._stepTimer = 0;
        this._stepSide = 0;
        this._wasGrounded = true;
        this._airTime = 0;
        this._fallSpeed = 0;
        this._lastVehicleEvent = '';
        this._lastVehicleSpeed = 0;
        this._engineNodes = null;
        this._lastWeaponPhase = 'holstered';
        this._lastWeaponAmmo = null;
        this._lastWeaponActionSerial = 0;
        this._lastShot = null;
        this._lastAttack = null;
        this._lastMeleeAttacking = false;
        this._lastHit = null;
        this._lastLifeState = 'alive';
        this.lastSfx = 'none';
        this._noiseBuffers = new Map();
        this._remoteSfx = new Map();
        this._unlocked = false;
        this.lastError = '';
        this._unlock = () => { void this.resume(); };
        window.addEventListener('pointerdown', this._unlock, { passive: true });
        window.addEventListener('keydown', this._unlock, { passive: true });
    }

    attachMultiplayer(multiplayer) {
        this.multiplayer = multiplayer;
    }

    _ensureContext() {
        if (this.context) return this.context;
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
            this.lastError = 'Web Audio is unavailable';
            this._syncUi();
            return null;
        }
        const context = new AudioContextClass({ latencyHint: 'interactive' });
        const master = context.createGain();
        const ambientGain = context.createGain();
        const sfxGain = context.createGain();
        const voiceGain = context.createGain();
        master.gain.value = 0.9;
        ambientGain.gain.value = this.ambientEnabled ? this.ambientVolume : 0;
        sfxGain.gain.value = this.gameplayEnabled ? this.sfxVolume : 0;
        voiceGain.gain.value = this.voiceVolume;
        ambientGain.connect(master);
        sfxGain.connect(master);
        voiceGain.connect(master);
        master.connect(context.destination);
        this.context = context;
        this.master = master;
        this.ambientGain = ambientGain;
        this.sfxGain = sfxGain;
        this.voiceGain = voiceGain;
        this._startAmbientBed();
        this._scheduleBirds();
        this._scheduleCitySounds();
        return context;
    }

    async resume() {
        const context = this._ensureContext();
        if (!context) return false;
        try {
            if (context.state !== 'running') await context.resume();
            this._unlocked = context.state === 'running';
            this._syncUi();
            return this._unlocked;
        } catch (error) {
            this.lastError = String(error?.message || error);
            this._syncUi();
            return false;
        }
    }

    _noiseBuffer(seconds = 4) {
        const context = this.context;
        const key = Math.ceil(Math.max(0.05, seconds) * 20) / 20;
        const cached = this._noiseBuffers.get(key);
        if (cached) return cached;
        const frameCount = Math.max(1, Math.floor(context.sampleRate * key));
        const buffer = context.createBuffer(1, frameCount, context.sampleRate);
        const data = buffer.getChannelData(0);
        let brown = 0;
        for (let i = 0; i < data.length; i++) {
            const white = Math.random() * 2 - 1;
            brown = (brown + 0.018 * white) / 1.018;
            data[i] = brown * 3.2;
        }
        this._noiseBuffers.set(key, buffer);
        return buffer;
    }

    _startAmbientBed() {
        const context = this.context;
        if (!context || !this.ambientGain || this._ambientSources.length) return;
        const noise = this._noiseBuffer(5);

        const city = context.createBufferSource();
        const cityFilter = context.createBiquadFilter();
        const cityGain = context.createGain();
        city.buffer = noise;
        city.loop = true;
        cityFilter.type = 'lowpass';
        cityFilter.frequency.value = 260;
        cityGain.gain.value = 0.32;
        city.connect(cityFilter).connect(cityGain).connect(this.ambientGain);
        city.start();

        const wind = context.createBufferSource();
        const windFilter = context.createBiquadFilter();
        const windGain = context.createGain();
        const windLfo = context.createOscillator();
        const windDepth = context.createGain();
        wind.buffer = noise;
        wind.loop = true;
        windFilter.type = 'bandpass';
        windFilter.frequency.value = 720;
        windFilter.Q.value = 0.45;
        windGain.gain.value = 0.16;
        windLfo.frequency.value = 0.075;
        windDepth.gain.value = 0.08;
        windLfo.connect(windDepth).connect(windGain.gain);
        wind.connect(windFilter).connect(windGain).connect(this.ambientGain);
        wind.start();
        windLfo.start();
        this._ambientSources.push(city, wind, windLfo);
    }

    _scheduleBirds() {
        clearTimeout(this._birdTimer);
        if (!this.context) return;
        const delay = 4_500 + Math.random() * 9_000;
        this._birdTimer = window.setTimeout(() => {
            if (this.ambientEnabled && this.context?.state === 'running') this._playBirdCall();
            this._scheduleBirds();
        }, delay);
    }

    _playBirdCall() {
        const context = this.context;
        if (!context || !this.ambientGain) return;
        const now = context.currentTime;
        const panner = context.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 3;
        panner.maxDistance = 45;
        panner.rolloffFactor = 0.8;
        const angle = Math.random() * Math.PI * 2;
        const local = this.app?.ped?.posData || [0, 0, 0];
        setAudioPosition(
            panner,
            (Number(local[0]) || 0) + Math.cos(angle) * 16,
            (Number(local[1]) || 0) + Math.sin(angle) * 16,
            (Number(local[2]) || 0) + 5 + Math.random() * 7,
        );
        panner.connect(this.ambientGain);
        for (let i = 0; i < 3; i++) {
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            const start = now + i * 0.16;
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(1850 + Math.random() * 350, start);
            oscillator.frequency.exponentialRampToValueAtTime(2850 + Math.random() * 450, start + 0.09);
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(0.055, start + 0.018);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.13);
            oscillator.connect(gain).connect(panner);
            oscillator.start(start);
            oscillator.stop(start + 0.15);
        }
    }

    _scheduleCitySounds() {
        clearTimeout(this._cityTimer);
        if (!this.context) return;
        this._cityTimer = window.setTimeout(() => {
            if (this.ambientEnabled && this.context?.state === 'running') {
                if (Math.random() < 0.72) this._playHorn();
                else this._playDistantSiren();
            }
            this._scheduleCitySounds();
        }, 9000 + Math.random() * 17000);
    }

    _spatialDestination(position, bus = this.sfxGain, maxDistance = 70) {
        if (!this.context || !bus || !position) return bus;
        const panner = this.context.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 2;
        panner.maxDistance = maxDistance;
        panner.rolloffFactor = 0.9;
        setAudioPosition(panner, Number(position[0]) || 0, Number(position[1]) || 0, Number(position[2]) || 0);
        panner.connect(bus);
        return panner;
    }

    _noiseBurst({ duration = 0.1, gain = 0.15, frequency = 900, type = 'bandpass', position = null, bus = null, delay = 0 } = {}) {
        const context = this.context;
        const output = bus || this.sfxGain;
        if (!context || !output || context.state !== 'running') return;
        const start = context.currentTime + delay;
        const source = context.createBufferSource();
        const filter = context.createBiquadFilter();
        const envelope = context.createGain();
        source.buffer = this._noiseBuffer(Math.max(0.08, duration));
        filter.type = type;
        filter.frequency.value = frequency;
        filter.Q.value = 0.7;
        envelope.gain.setValueAtTime(0.0001, start);
        envelope.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), start + Math.min(0.012, duration * 0.2));
        envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        const destination = this._spatialDestination(position, output);
        source.connect(filter).connect(envelope).connect(destination);
        source.start(start);
        source.stop(start + duration + 0.02);
    }

    _tone({ from = 160, to = 90, duration = 0.12, gain = 0.12, type = 'sine', position = null, bus = null, delay = 0 } = {}) {
        const context = this.context;
        const output = bus || this.sfxGain;
        if (!context || !output || context.state !== 'running') return;
        const start = context.currentTime + delay;
        const oscillator = context.createOscillator();
        const envelope = context.createGain();
        oscillator.type = type;
        oscillator.frequency.setValueAtTime(Math.max(20, from), start);
        oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, to), start + duration);
        envelope.gain.setValueAtTime(0.0001, start);
        envelope.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), start + 0.008);
        envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        oscillator.connect(envelope).connect(this._spatialDestination(position, output));
        oscillator.start(start);
        oscillator.stop(start + duration + 0.02);
    }

    _markSfx(name) {
        this.lastSfx = name;
        this._syncUi();
    }

    _playFootstep(sprinting = false, position = null) {
        const hard = String(this.app?.playerController?.lastGroundSource || '').includes('interior');
        this._noiseBurst({ duration: sprinting ? 0.095 : 0.075, gain: sprinting ? 0.19 : 0.12, frequency: hard ? 1500 : 920, position });
        this._tone({ from: sprinting ? 105 : 82, to: 52, duration: 0.08, gain: sprinting ? 0.1 : 0.055, position });
        this._stepSide ^= 1;
        this._markSfx(sprinting ? 'sprint step' : 'footstep');
    }

    _playJump() {
        this._noiseBurst({ duration: 0.13, gain: 0.075, frequency: 620 });
        this._tone({ from: 100, to: 145, duration: 0.09, gain: 0.035 });
        this._markSfx('jump');
    }

    _playLanding(strength = 0.5) {
        const amount = clamp(strength, 0.25, 1);
        this._noiseBurst({ duration: 0.12, gain: 0.12 + amount * 0.18, frequency: 420, type: 'lowpass' });
        this._tone({ from: 92, to: 38, duration: 0.16, gain: 0.08 + amount * 0.15 });
        this._markSfx('landing');
    }

    _playGunshot(position = null) {
        position ||= this.app?.ped?.posData || null;
        this._noiseBurst({ duration: 0.075, gain: 0.72, frequency: 2100, position });
        this._noiseBurst({ duration: 0.24, gain: 0.25, frequency: 520, type: 'lowpass', position, delay: 0.015 });
        this._tone({ from: 145, to: 46, duration: 0.18, gain: 0.38, type: 'triangle', position });
        this._noiseBurst({ duration: 0.32, gain: 0.07, frequency: 1100, position, delay: 0.11 });
        this._markSfx('gunshot');
    }

    _playWeaponAction(action) {
        if (action === 'reload') {
            this._noiseBurst({ duration: 0.035, gain: 0.12, frequency: 2600 });
            this._tone({ from: 230, to: 150, duration: 0.05, gain: 0.08, delay: 0.18 });
            this._noiseBurst({ duration: 0.04, gain: 0.16, frequency: 3200, delay: 0.72 });
        } else {
            this._noiseBurst({ duration: 0.035, gain: 0.1, frequency: 3000 });
            this._tone({ from: 310, to: 180, duration: 0.045, gain: 0.045 });
        }
        this._markSfx(`weapon ${action}`);
    }

    _playEmptyWeapon() {
        this._tone({ from: 1850, to: 1150, duration: 0.025, gain: 0.045, type: 'square' });
        this._noiseBurst({ duration: 0.025, gain: 0.075, frequency: 3600 });
        this._markSfx('empty trigger');
    }

    _playMeleeImpact(hit = true, position = null) {
        if (hit) {
            this._noiseBurst({ duration: 0.095, gain: 0.3, frequency: 380, type: 'lowpass', position });
            this._tone({ from: 115, to: 48, duration: 0.11, gain: 0.2, position });
        } else {
            this._noiseBurst({ duration: 0.12, gain: 0.1, frequency: 1250, position });
        }
        this._markSfx(hit ? 'melee impact' : 'melee swing');
    }

    _playDoor(entering) {
        this._noiseBurst({ duration: 0.09, gain: 0.2, frequency: 650, type: 'lowpass' });
        this._tone({ from: entering ? 105 : 130, to: 55, duration: 0.14, gain: 0.17 });
        this._markSfx(entering ? 'car door close' : 'car door open');
    }

    _playVehicleImpact(strength = 0.5) {
        const amount = clamp(strength, 0.25, 1);
        this._noiseBurst({ duration: 0.28, gain: 0.25 + amount * 0.35, frequency: 300, type: 'lowpass' });
        this._tone({ from: 120, to: 32, duration: 0.3, gain: 0.22 + amount * 0.25, type: 'sawtooth' });
        this._markSfx('vehicle impact');
    }

    _startEngine() {
        if (this._engineNodes || !this.context || !this.sfxGain) return;
        const context = this.context;
        const gain = context.createGain();
        const filter = context.createBiquadFilter();
        const low = context.createOscillator();
        const high = context.createOscillator();
        const road = context.createBufferSource();
        const roadFilter = context.createBiquadFilter();
        const roadGain = context.createGain();
        low.type = 'sawtooth';
        high.type = 'square';
        road.buffer = this._noiseBuffer(2);
        road.loop = true;
        roadFilter.type = 'bandpass';
        roadFilter.frequency.value = 820;
        roadFilter.Q.value = 0.55;
        roadGain.gain.value = 0.0001;
        gain.gain.value = 0.0001;
        filter.type = 'lowpass';
        filter.frequency.value = 620;
        low.connect(filter);
        high.connect(filter);
        filter.connect(gain).connect(this.sfxGain);
        road.connect(roadFilter).connect(roadGain).connect(this.sfxGain);
        low.start();
        high.start();
        road.start();
        this._engineNodes = { gain, filter, low, high, road, roadFilter, roadGain };
    }

    _updateEngine(speed, driving, dt) {
        if (!this.context) return;
        if (!driving) {
            if (this._engineNodes) {
                this._engineNodes.gain.gain.setTargetAtTime(0.0001, this.context.currentTime, 0.12);
                this._engineNodes.roadGain.gain.setTargetAtTime(0.0001, this.context.currentTime, 0.12);
            }
            return;
        }
        this._startEngine();
        const nodes = this._engineNodes;
        if (!nodes) return;
        const amount = clamp(Math.abs(speed) / 36, 0, 1);
        const throttle = !!(this.app?.keyState?.w || this.app?.keyState?.s);
        const rpm = 38 + amount * 92 + (throttle ? 16 : 0);
        nodes.low.frequency.setTargetAtTime(rpm, this.context.currentTime, 0.04);
        nodes.high.frequency.setTargetAtTime(rpm * 2.02, this.context.currentTime, 0.04);
        nodes.filter.frequency.setTargetAtTime(360 + amount * 1100, this.context.currentTime, 0.06);
        nodes.gain.gain.setTargetAtTime(0.08 + amount * 0.14, this.context.currentTime, 0.08);
        nodes.roadGain.gain.setTargetAtTime(amount < 0.08 ? 0.0001 : 0.025 + amount * 0.1, this.context.currentTime, 0.08);
        nodes.roadFilter.frequency.setTargetAtTime(520 + amount * 1800, this.context.currentTime, 0.08);
        if (Math.abs(speed) > 7 && this.app?.keyState?.[' ']) {
            this._noiseBurst({ duration: Math.min(0.12, dt + 0.04), gain: 0.08 + amount * 0.15, frequency: 2400 });
            this._markSfx('tire skid');
        }
    }

    _playHorn() {
        const local = this.app?.ped?.posData || [0, 0, 0];
        const angle = Math.random() * Math.PI * 2;
        const position = [local[0] + Math.cos(angle) * 30, local[1] + Math.sin(angle) * 30, local[2] + 1];
        this._tone({ from: 315, to: 310, duration: 0.35, gain: 0.06, type: 'square', position, bus: this.ambientGain });
        this._tone({ from: 420, to: 415, duration: 0.32, gain: 0.035, type: 'square', position, bus: this.ambientGain });
    }

    _playDistantSiren() {
        const local = this.app?.ped?.posData || [0, 0, 0];
        const position = [local[0] + 36, local[1] - 28, local[2] + 1];
        for (let i = 0; i < 4; i++) {
            this._tone({ from: i % 2 ? 510 : 690, to: i % 2 ? 690 : 510, duration: 0.42, gain: 0.025, type: 'sine', position, bus: this.ambientGain, delay: i * 0.4 });
        }
    }

    updateGameplay(dt = 1 / 60) {
        if (!this.gameplayEnabled || !this.context || this.context.state !== 'running') return;
        const step = clamp(dt, 0, 0.1);
        const app = this.app;
        const vehicle = app?.vehicleController?.getRenderState?.();
        const driving = !!vehicle?.occupied;
        const speed = Number(vehicle?.speed) || 0;
        this._updateEngine(speed, driving, step);
        const vehicleEvent = String(app?.vehicleController?.lastEvent || '');
        if (vehicleEvent && vehicleEvent !== this._lastVehicleEvent) {
            if (vehicleEvent.startsWith('entered')) this._playDoor(true);
            else if (vehicleEvent.startsWith('exited')) this._playDoor(false);
            else if (vehicleEvent.includes('impact') || vehicleEvent.includes('strike') || vehicleEvent.includes('damage') || vehicleEvent.includes('destroyed')) this._playVehicleImpact(Math.abs(speed) / 24);
        }
        this._lastVehicleEvent = vehicleEvent;
        if (driving && Math.abs(this._lastVehicleSpeed) - Math.abs(speed) > 8) this._playVehicleImpact((Math.abs(this._lastVehicleSpeed) - Math.abs(speed)) / 18);
        this._lastVehicleSpeed = speed;

        const grounded = !!app?._pedOnGround;
        const vertical = Number(app?._pedVerticalVelocity) || Number(app?._pedVelocityData?.[2]) || 0;
        if (!driving) {
            if (this._wasGrounded && !grounded && vertical > 0.2) this._playJump();
            if (!grounded) {
                this._airTime += step;
                this._fallSpeed = Math.min(this._fallSpeed, vertical);
            } else if (!this._wasGrounded) {
                this._playLanding(Math.max(this._airTime * 0.7, Math.abs(this._fallSpeed) / 9));
                this._airTime = 0;
                this._fallSpeed = 0;
            }
            const gait = String(app?.player?.animGait || 'idle');
            const moving = grounded && (gait === 'walk' || gait === 'sprint');
            if (moving) {
                this._stepTimer -= step;
                if (this._stepTimer <= 0) {
                    this._playFootstep(gait === 'sprint');
                    this._stepTimer = gait === 'sprint' ? 0.29 : 0.5;
                }
            } else this._stepTimer = 0;
        } else {
            this._stepTimer = 0;
            this._airTime = 0;
        }
        this._wasGrounded = grounded;

        const weapon = app?.weaponController?.getStatus?.();
        if (weapon) {
            if (weapon.lastShot && weapon.lastShot !== this._lastShot) this._playGunshot();
            if (weapon.phase !== this._lastWeaponPhase) {
                if (weapon.phase === 'reloading') this._playWeaponAction('reload');
                else if (weapon.phase === 'equipped') this._playWeaponAction('draw');
                else if (weapon.phase === 'holstered') this._playWeaponAction('holster');
            }
            if (this._lastWeaponAmmo !== null && weapon.magazineAmmo < this._lastWeaponAmmo && weapon.lastShot === this._lastShot) this._playGunshot();
            if (weapon.actionSerial !== this._lastWeaponActionSerial) {
                if (weapon.lastAction === 'empty') this._playEmptyWeapon();
                else if (weapon.lastAction === 'install_switch') this._playWeaponAction('attachment');
            }
            this._lastShot = weapon.lastShot;
            this._lastWeaponAmmo = weapon.magazineAmmo;
            this._lastWeaponPhase = weapon.phase;
            this._lastWeaponActionSerial = weapon.actionSerial;
        }

        const melee = app?.meleeController?.getStatus?.();
        if (melee) {
            if (melee.attacking && !this._lastMeleeAttacking) this._playMeleeImpact(false);
            if (melee.lastAttack && melee.lastAttack !== this._lastAttack && melee.lastAttack.result === 'hit') this._playMeleeImpact(true);
            if (melee.lastHit && melee.lastHit !== this._lastHit) this._playMeleeImpact(true);
            if (melee.lifeState !== this._lastLifeState && melee.lifeState !== 'alive') this._playLanding(1);
            this._lastAttack = melee.lastAttack;
            this._lastMeleeAttacking = melee.attacking;
            this._lastHit = melee.lastHit;
            this._lastLifeState = melee.lifeState;
        }
    }

    setAmbientEnabled(enabled) {
        this.ambientEnabled = !!enabled;
        void this.resume();
        this.ambientGain?.gain.setTargetAtTime(
            this.ambientEnabled ? this.ambientVolume : 0,
            this.context?.currentTime || 0,
            0.08,
        );
        this._syncUi();
    }

    setAmbientVolume(value) {
        this.ambientVolume = clamp(value, 0, 1);
        if (this.ambientEnabled && this.ambientGain) {
            this.ambientGain.gain.setTargetAtTime(this.ambientVolume, this.context.currentTime, 0.05);
        }
    }

    setGameplayEnabled(enabled) {
        this.gameplayEnabled = !!enabled;
        void this.resume();
        this.sfxGain?.gain.setTargetAtTime(this.gameplayEnabled ? this.sfxVolume : 0, this.context?.currentTime || 0, 0.05);
        this._syncUi();
    }

    setSfxVolume(value) {
        this.sfxVolume = clamp(value, 0, 1.5);
        if (this.gameplayEnabled && this.sfxGain) this.sfxGain.gain.setTargetAtTime(this.sfxVolume, this.context.currentTime, 0.04);
    }

    setVoiceVolume(value) {
        this.voiceVolume = clamp(value, 0, 1.5);
        if (this.voiceGain) this.voiceGain.gain.setTargetAtTime(this.voiceVolume, this.context.currentTime, 0.04);
    }

    setVoiceMode(index) {
        this.voiceModeIndex = Math.max(0, Math.min(VOICE_MODES.length - 1, Number(index) | 0));
        this._syncUi();
    }

    cycleVoiceMode() {
        this.setVoiceMode((this.voiceModeIndex + 1) % VOICE_MODES.length);
    }

    get voiceMode() {
        return VOICE_MODES[this.voiceModeIndex];
    }

    getNetworkState() {
        return {
            voiceEnabled: this.microphoneEnabled,
            voiceTalking: this.talking,
            voiceRange: this.voiceMode.range,
            voiceMode: this.voiceModeIndex,
        };
    }

    async toggleMicrophone() {
        if (this.microphoneEnabled) {
            this.disableMicrophone();
            return false;
        }
        return this.enableMicrophone();
    }

    async enableMicrophone() {
        await this.resume();
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
            this.lastError = 'Microphone requires HTTPS or localhost';
            this._syncUi();
            return false;
        }
        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                video: false,
            });
            for (const track of this.localStream.getAudioTracks()) track.enabled = false;
            this.microphoneEnabled = true;
            this.lastError = '';
            for (const peer of this.multiplayer?.peers?.values?.() || []) this.onPeerAvailable(peer.id);
            this._syncUi();
            return true;
        } catch (error) {
            this.lastError = error?.name === 'NotAllowedError' ? 'Microphone permission denied' : String(error?.message || error);
            this._syncUi();
            return false;
        }
    }

    disableMicrophone() {
        this.setTalking(false);
        for (const track of this.localStream?.getTracks?.() || []) track.stop();
        this.localStream = null;
        this.microphoneEnabled = false;
        for (const peer of this.voicePeers.values()) this._closeVoicePeer(peer);
        this.voicePeers.clear();
        this._syncUi();
    }

    setTalking(talking) {
        const next = !!talking && this.microphoneEnabled;
        if (this.talking === next) return;
        this.talking = next;
        for (const track of this.localStream?.getAudioTracks?.() || []) track.enabled = next;
        this._syncUi();
    }

    handleKeyDown(event) {
        const key = String(event?.key || '').toLowerCase();
        if (key === 'f11' && !event.repeat) {
            this.cycleVoiceMode();
            event.preventDefault();
            return true;
        }
        if (key === 'n') {
            this.setTalking(true);
            event.preventDefault();
            return true;
        }
        return false;
    }

    handleKeyUp(event) {
        if (String(event?.key || '').toLowerCase() !== 'n') return false;
        this.setTalking(false);
        event.preventDefault();
        return true;
    }

    _sendSignal(target, signal) {
        const socket = this.multiplayer?.socket;
        if (!target || socket?.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ type: 'voice_signal', target, signal }));
    }

    _createVoicePeer(peerId) {
        if (!window.RTCPeerConnection) return null;
        let peer = this.voicePeers.get(peerId);
        if (peer) return peer;
        const pc = new RTCPeerConnection({ iceServers: [] });
        peer = {
            id: peerId,
            pc,
            makingOffer: false,
            ignoreOffer: false,
            polite: String(this.multiplayer?.id || '') > String(peerId),
            source: null,
            panner: null,
            rangeGain: null,
        };
        this.voicePeers.set(peerId, peer);
        for (const track of this.localStream?.getAudioTracks?.() || []) pc.addTrack(track, this.localStream);
        pc.onicecandidate = ({ candidate }) => {
            if (candidate) this._sendSignal(peerId, { candidate: candidate.toJSON?.() || candidate });
        };
        pc.onnegotiationneeded = async () => {
            try {
                peer.makingOffer = true;
                await pc.setLocalDescription();
                this._sendSignal(peerId, { description: pc.localDescription });
            } catch (error) {
                console.warn('Voice negotiation failed:', error);
            } finally {
                peer.makingOffer = false;
            }
        };
        pc.ontrack = (event) => this._attachRemoteVoice(peer, event.streams?.[0]);
        pc.onconnectionstatechange = () => {
            if (['failed', 'closed'].includes(pc.connectionState)) this.removePeer(peerId);
        };
        return peer;
    }

    onPeerAvailable(peerId) {
        const peer = this._createVoicePeer(String(peerId || ''));
        if (!peer || !this.localStream) return;
        const senders = peer.pc.getSenders();
        for (const track of this.localStream.getAudioTracks()) {
            if (!senders.some((sender) => sender.track === track)) peer.pc.addTrack(track, this.localStream);
        }
    }

    async handleSignal(fromValue, signal) {
        const from = String(fromValue || '');
        if (!from || !signal || typeof signal !== 'object') return;
        const peer = this._createVoicePeer(from);
        if (!peer) return;
        const pc = peer.pc;
        try {
            if (signal.description) {
                const description = signal.description;
                const offerCollision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
                peer.ignoreOffer = !peer.polite && offerCollision;
                if (peer.ignoreOffer) return;
                await pc.setRemoteDescription(description);
                if (description.type === 'offer') {
                    await pc.setLocalDescription();
                    this._sendSignal(from, { description: pc.localDescription });
                }
            } else if (signal.candidate) {
                try {
                    await pc.addIceCandidate(signal.candidate);
                } catch (error) {
                    if (!peer.ignoreOffer) throw error;
                }
            }
        } catch (error) {
            console.warn('Voice signal rejected:', error);
        }
    }

    _attachRemoteVoice(peer, stream) {
        const context = this._ensureContext();
        if (!context || !stream || peer.source) return;
        const source = context.createMediaStreamSource(stream);
        const rangeGain = context.createGain();
        const panner = context.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 1.4;
        panner.maxDistance = 15;
        panner.rolloffFactor = 0.9;
        source.connect(rangeGain).connect(panner).connect(this.voiceGain);
        peer.source = source;
        peer.rangeGain = rangeGain;
        peer.panner = panner;
        void this.resume();
    }

    removePeer(peerId) {
        const peer = this.voicePeers.get(String(peerId || ''));
        if (!peer) return;
        this._closeVoicePeer(peer);
        this.voicePeers.delete(peer.id);
    }

    _closeVoicePeer(peer) {
        try { peer.source?.disconnect?.(); } catch { /* ignore */ }
        try { peer.rangeGain?.disconnect?.(); } catch { /* ignore */ }
        try { peer.panner?.disconnect?.(); } catch { /* ignore */ }
        try { peer.pc?.close?.(); } catch { /* ignore */ }
    }

    resetPeers() {
        for (const peer of this.voicePeers.values()) this._closeVoicePeer(peer);
        this.voicePeers.clear();
    }

    update(remotePeers = []) {
        const context = this.context;
        const local = this.app?.ped?.posData;
        if (!context || !local) return;
        const eye = Number(this.app?.pedEyeHeightData) || 1.2;
        const listener = context.listener;
        const lx = Number(local[0]) || 0;
        const ly = Number(local[1]) || 0;
        const lz = (Number(local[2]) || 0) - eye + 1.6;
        if (listener.positionX) {
            listener.positionX.value = lx;
            listener.positionY.value = ly;
            listener.positionZ.value = lz;
        } else {
            listener.setPosition?.(lx, ly, lz);
        }
        const heading = Number(this.app?.player?.headingRad) || 0;
        const fx = Math.sin(heading);
        const fy = Math.cos(heading);
        if (listener.forwardX) {
            listener.forwardX.value = fx;
            listener.forwardY.value = fy;
            listener.forwardZ.value = 0;
            listener.upX.value = 0;
            listener.upY.value = 0;
            listener.upZ.value = 1;
        } else {
            listener.setOrientation?.(fx, fy, 0, 0, 0, 1);
        }

        const now = performance.now();
        const activeRemoteIds = new Set();
        for (const state of remotePeers) {
            const id = String(state.id || '');
            activeRemoteIds.add(id);
            let remote = this._remoteSfx.get(id);
            if (!remote) {
                remote = { nextStepAt: 0, weaponSerial: Number(state.weaponActionSerial) || 0, meleeSerial: Number(state.meleeActionSerial) || 0 };
                this._remoteSfx.set(id, remote);
            }
            const position = [Number(state.x) || 0, Number(state.y) || 0, (Number(state.feetZ) || 0) + 0.08];
            if (!state.inVehicle && ['walk', 'run', 'sprint'].includes(state.gait) && now >= remote.nextStepAt) {
                const sprinting = state.gait === 'sprint';
                this._playFootstep(sprinting, position);
                remote.nextStepAt = now + (sprinting ? 290 : state.gait === 'run' ? 370 : 500);
            }
            if (Number(state.weaponActionSerial) > remote.weaponSerial && state.weaponAction === 'fire') this._playGunshot([position[0], position[1], position[2] + 1.25]);
            if (Number(state.meleeActionSerial) > remote.meleeSerial) this._playMeleeImpact(false, position);
            remote.weaponSerial = Math.max(remote.weaponSerial, Number(state.weaponActionSerial) || 0);
            remote.meleeSerial = Math.max(remote.meleeSerial, Number(state.meleeActionSerial) || 0);
            const peer = this.voicePeers.get(String(state.id || ''));
            if (!peer?.panner || !peer.rangeGain) continue;
            const x = Number(state.x) || 0;
            const y = Number(state.y) || 0;
            const z = (Number(state.feetZ) || 0) + 1.6;
            setAudioPosition(peer.panner, x, y, z);
            const range = clamp(state.voiceRange || 7, 1, 30);
            peer.panner.maxDistance = range;
            const distance = Math.hypot(x - lx, y - ly, z - lz);
            const edgeStart = range * 0.72;
            const gain = distance >= range ? 0 : distance <= edgeStart ? 1 : 1 - ((distance - edgeStart) / (range - edgeStart));
            peer.rangeGain.gain.setTargetAtTime(gain, context.currentTime, 0.035);
        }
        for (const id of this._remoteSfx.keys()) if (!activeRemoteIds.has(id)) this._remoteSfx.delete(id);
    }

    handleRemoteGameplayEvent(message) {
        const state = message?.state;
        if (!state) return;
        const position = [Number(state.x) || 0, Number(state.y) || 0, (Number(state.feetZ) || 0) + 1.3];
        const remote = this._remoteSfx.get(String(message.id || '')) || { nextStepAt: 0, weaponSerial: 0, meleeSerial: 0 };
        if (message.kind === 'shoot') {
            this._playGunshot(position);
            remote.weaponSerial = Math.max(remote.weaponSerial, Number(state.weaponActionSerial) || 0);
        } else if (message.kind === 'melee') {
            this._playMeleeImpact(!!message.result, position);
            remote.meleeSerial = Math.max(remote.meleeSerial, Number(state.meleeActionSerial) || 0);
        }
        else if (message.kind === 'vehicle_damage') this._playVehicleImpact(0.7);
        this._remoteSfx.set(String(message.id || ''), remote);
    }

    _syncUi() {
        const button = document.getElementById('voiceMicToggle');
        if (button) button.textContent = this.microphoneEnabled ? 'Disable microphone' : 'Enable microphone';
        const mode = document.getElementById('voiceMode');
        if (mode) mode.value = String(this.voiceModeIndex);
        const status = document.getElementById('audioStatus');
        if (status) {
            const mic = this.microphoneEnabled ? (this.talking ? 'MIC TALKING' : 'MIC READY') : 'MIC OFF';
            const environment = !this.ambientEnabled
                ? 'ENV OFF'
                : this.context?.state === 'running' ? 'ENV ON' : 'ENV PAUSED';
            const effects = this.gameplayEnabled
                ? `SFX ON${this.lastSfx !== 'none' ? ` (${this.lastSfx.toUpperCase()})` : ''}`
                : 'SFX OFF';
            status.textContent = this.lastError || `${environment} | ${effects} | ${mic} | ${this.voiceMode.name.toUpperCase()} ${this.voiceMode.range}M`;
        }
        this.app?._syncMultiplayerHud?.();
    }

    destroy() {
        clearTimeout(this._birdTimer);
        clearTimeout(this._cityTimer);
        this.disableMicrophone();
        for (const source of this._ambientSources) {
            try { source.stop?.(); } catch { /* ignore */ }
            try { source.disconnect?.(); } catch { /* ignore */ }
        }
        this._ambientSources.length = 0;
        this._noiseBuffers.clear();
        this._remoteSfx.clear();
        if (this._engineNodes) {
            try { this._engineNodes.low.stop(); } catch { /* ignore */ }
            try { this._engineNodes.high.stop(); } catch { /* ignore */ }
            try { this._engineNodes.road.stop(); } catch { /* ignore */ }
            this._engineNodes = null;
        }
        window.removeEventListener('pointerdown', this._unlock);
        window.removeEventListener('keydown', this._unlock);
        try { this.context?.close?.(); } catch { /* ignore */ }
        this.context = null;
    }
}

export { VOICE_MODES };

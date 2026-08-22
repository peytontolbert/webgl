const VOICE_MODES = Object.freeze([
    Object.freeze({ name: 'Whisper', range: 3 }),
    Object.freeze({ name: 'Normal', range: 7 }),
    Object.freeze({ name: 'Shouting', range: 15 }),
]);

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Number(value) || 0));
}

const GRANULAR_CLIP_INDEX = Object.freeze({
    engine_accel: 0,
    exhaust_accel: 1,
    engine_decel: 2,
    exhaust_decel: 3,
    engine_idle: 4,
    exhaust_idle: 5,
});

const MAX_CACHED_VEHICLE_AUDIO_BUFFERS = 24;

export function audioAssetUrl(path) {
    const normalized = String(path || '').replace(/^\/+/, '');
    if (!normalized) return '';
    return normalized.startsWith('assets/') ? `/${normalized}` : `/assets/${normalized}`;
}

export const vehicleAudioAssetUrl = audioAssetUrl;

function centibelGain(value) {
    // REL volume values are centibels. Keeping this conversion here means the
    // browser mixer consumes the same authored balance as the source profile.
    return Math.pow(10, clamp(value, -6000, 2400) / 2000);
}

function granularClockRate(sound, clip, rpm01) {
    const index = GRANULAR_CLIP_INDEX[clip];
    const channel = Number.isInteger(index) ? sound?.channels?.[index] : null;
    const clockIndex = Number(channel?.granularClockIndex) || 0;
    const clock = sound?.granularClock?.[clockIndex];
    const min = Number(clock?.[0]);
    const max = Number(clock?.[1]);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) return 10.5;
    return Math.max(1, min + (max - min) * clamp(rpm01, 0, 1));
}

export function vehicleAudioShiftWobble(granular, progress) {
    const t = clamp(progress, 0, 1);
    const envelope = Math.sin(t * Math.PI);
    const pitchDepth = clamp(Number(granular?.gearChangeWobblePitch) || 0, 0, 0.35);
    const volumeDepth = clamp(Number(granular?.gearChangeWobbleVolume) || 0, 0, 1);
    // The REL speed value controls how quickly the short clutch dip settles.
    // Keep it bounded: it changes the shape of an authored shift rather than
    // adding an unphysical vibrato to the source recording.
    const settleSpeed = clamp(Number(granular?.gearChangeWobbleSpeed) || 0.2, 0.04, 1.0);
    const shape = Math.pow(envelope, 1.0 + settleSpeed * 1.5);
    return {
        rate: 1.0 - shape * pitchDepth,
        gain: 1.0 - shape * volumeDepth * 0.35,
    };
}

function smoothstep(edge0, edge1, value) {
    const t = clamp((value - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
}

export function vehicleAudioPhaseWeights(rpm01, load) {
    const rpm = clamp(rpm01, 0, 1);
    const throttle = clamp(load, 0, 1);
    const idle = (1 - smoothstep(0.04, 0.22, rpm)) * (1 - smoothstep(0.03, 0.18, throttle));
    const moving = 1 - idle;
    const acceleration = moving * smoothstep(0.02, 0.3, throttle);
    return { idle, accel: acceleration, decel: moving - acceleration };
}

export function vehicleAudioScheduleWindow(nextAt, now, rate, horizonSeconds = 0.045, maxEvents = 8) {
    const clockRate = Math.max(1, Number(rate) || 1);
    let scheduledAt = Math.max(now - 0.008, Number(nextAt) || now);
    const horizon = now + Math.max(0, Number(horizonSeconds) || 0);
    const times = [];
    while (scheduledAt <= horizon && times.length < maxEvents) {
        times.push(Math.max(now, scheduledAt));
        scheduledAt += 1 / clockRate;
    }
    return { times, nextAt: scheduledAt };
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

function setAudioOrientation(node, x, y, z) {
    if (!node) return;
    if (node.orientationX) {
        node.orientationX.value = x;
        node.orientationY.value = y;
        node.orientationZ.value = z;
    } else {
        node.setOrientation?.(x, y, z);
    }
}

const VEHICLE_AUDIO_PRESETS = Object.freeze({
    electric: Object.freeze({ kind: 'electric', bank: 'hybrid', cylinders: 0, idleRpm: 550, redlineRpm: 15500, lowType: 'sine', highType: 'sawtooth', lowGain: 0.07, highGain: 0.12, subGain: 0.035, intakeGain: 0.016, intakeBase: 950, intakeRange: 2000, roadGain: 0.09 }),
    diesel: Object.freeze({ kind: 'diesel', bank: 'rig_1', cylinders: 6, idleRpm: 650, redlineRpm: 3300, lowType: 'sawtooth', highType: 'square', lowGain: 0.22, highGain: 0.035, subGain: 0.14, intakeGain: 0.026, intakeBase: 260, intakeRange: 760, roadGain: 0.13 }),
    super: Object.freeze({ kind: 'super', bank: 'supercar_1', cylinders: 10, idleRpm: 900, redlineRpm: 8300, lowType: 'sawtooth', highType: 'square', lowGain: 0.17, highGain: 0.11, subGain: 0.065, intakeGain: 0.052, intakeBase: 650, intakeRange: 2600, roadGain: 0.12 }),
    sportsV8: Object.freeze({ kind: 'sportsV8', bank: 'supercar_7_us_v8', cylinders: 8, idleRpm: 800, redlineRpm: 7200, lowType: 'sawtooth', highType: 'square', lowGain: 0.19, highGain: 0.09, subGain: 0.09, intakeGain: 0.045, intakeBase: 520, intakeRange: 2200, roadGain: 0.115 }),
    v8: Object.freeze({ kind: 'v8', bank: 'muscle_car_1', cylinders: 8, idleRpm: 720, redlineRpm: 6600, lowType: 'sawtooth', highType: 'square', lowGain: 0.20, highGain: 0.072, subGain: 0.12, intakeGain: 0.031, intakeBase: 360, intakeRange: 1480, roadGain: 0.12 }),
    turbo4: Object.freeze({ kind: 'turbo4', bank: '4_cylinder_sport_1', cylinders: 4, idleRpm: 820, redlineRpm: 7400, lowType: 'sawtooth', highType: 'triangle', lowGain: 0.13, highGain: 0.105, subGain: 0.045, intakeGain: 0.060, intakeBase: 780, intakeRange: 2800, roadGain: 0.11 }),
    luxury: Object.freeze({ kind: 'luxury', bank: 'v8_luxury_1', cylinders: 6, idleRpm: 700, redlineRpm: 6800, lowType: 'triangle', highType: 'sawtooth', lowGain: 0.15, highGain: 0.078, subGain: 0.085, intakeGain: 0.026, intakeBase: 430, intakeRange: 1500, roadGain: 0.105 }),
    standard: Object.freeze({ kind: 'standard', bank: 'regular_saloon_1', cylinders: 6, idleRpm: 750, redlineRpm: 6000, lowType: 'sawtooth', highType: 'square', lowGain: 0.15, highGain: 0.065, subGain: 0.075, intakeGain: 0.024, intakeBase: 420, intakeRange: 1280, roadGain: 0.1 }),
});

export function vehicleAudioProfile(audioNameHash) {
    const key = String(audioNameHash || 'SULTAN').trim().toUpperCase();
    let preset = 'standard';
    if (/(VOLTIC|SURGE|DILETTANTE|CYBER|TESLA|ELECTRIC)/.test(key)) preset = 'electric';
    else if (/(HAULER|MULE|PACKER|BUS|RUBBLE|TRUCK|PHANTOM|BISON|SADLER)/.test(key)) preset = 'diesel';
    else if (/(COQUETTE)/.test(key)) preset = 'sportsV8';
    else if (/(ADDER|BANSHEE|CHEETAH|ENTITY|FURIA|INFERNUS|ITALIGTB|LE7B|NERO|OSIRIS|PFISTER811|REAPER|SC1|SHEAVA|T20|TURISMOR|TYRANT|TYRUS|VACCA|XA21|ZENTORNO)/.test(key)) preset = 'super';
    else if (/(DOMINATOR|GAUNTLET|SABREGT|HOTKNIFE|BLADE|DUKES|MAMBA|STINGER|NIGHTSHARK|GRANGER|BALLER|HUNTLEY|MESA|BIFTA|CONTENDER|DUBSTA)/.test(key)) preset = 'v8';
    else if (/(COMET|ELEGY|SULTAN|FUTO|JESTER|KURUMA|SPECTER|FELTZER|COQUETTE|CARBONIZZARE|FLASHGT|RUSTON|BRIOSO|ISSI|BLISTA|FQ2|FUGITIVE|STRATUM|SENTINEL|FUROREGT|FUSILADE)/.test(key)) preset = 'turbo4';
    else if (/(SCHWARZER|TAILGATER|ORACLE|SCHAFTER|WINDSOR|FELON|ZION|COGCABRIO|F620|EXEMPLAR|ALPHA|SURANO|NINEF|PRIMO|WASHINGTON)/.test(key)) preset = 'luxury';
    return { key, ...VEHICLE_AUDIO_PRESETS[preset] };
}

export class GameAudioSystem {
    constructor(app) {
        this.app = app;
        this.multiplayer = null;
        this.context = null;
        this.master = null;
        this.ambientGain = null;
        this.interiorAmbientFilter = null;
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
        this._gtaVehicleAudio = null;
        this._gtaVehicleAudioManifest = null;
        this._gtaVehicleAudioManifestPromise = null;
        this._gtaVehicleAudioBuffers = new Map();
        this._requestedVehicleAudioBank = '';
        this._vehicleGranularWorkletState = 'unknown';
        this._vehicleGranularWorkletPromise = null;
        this._vehicleAudioStatus = { mode: 'procedural', bank: '', detail: 'waiting for vehicle' };
        this._gtaEventAudioManifest = null;
        this._gtaEventAudioManifestPromise = null;
        this._gtaEventAudioBuffers = new Map();
        this._gtaEventAudioPromises = new Map();
        this._gtaEventAudioReady = new Map();
        this._gtaEventAudioFailures = new Map();
        this._lastWeaponPhase = 'holstered';
        this._lastWeaponAmmo = null;
        this._lastWeaponActionSerial = 0;
        this._lastShot = null;
        this._lastNpcShotId = '';
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
        const interiorAmbientFilter = context.createBiquadFilter();
        master.gain.value = 0.9;
        ambientGain.gain.value = this.ambientEnabled ? this.ambientVolume : 0;
        sfxGain.gain.value = this.gameplayEnabled ? this.sfxVolume : 0;
        voiceGain.gain.value = this.voiceVolume;
        interiorAmbientFilter.type = 'lowpass';
        interiorAmbientFilter.frequency.value = 20000;
        interiorAmbientFilter.Q.value = 0.35;
        ambientGain.connect(interiorAmbientFilter).connect(master);
        sfxGain.connect(master);
        voiceGain.connect(master);
        master.connect(context.destination);
        this.context = context;
        this.master = master;
        this.ambientGain = ambientGain;
        this.interiorAmbientFilter = interiorAmbientFilter;
        this.sfxGain = sfxGain;
        this.voiceGain = voiceGain;
        this._startAmbientBed();
        this._scheduleBirds();
        this._scheduleCitySounds();
        return context;
    }

    async resume() {
        // Chrome rejects resume() before a user gesture and logs once per call.
        // Initial settings synchronization invokes this method during startup,
        // so defer context creation/resume until an actual unlock gesture.
        const activation = navigator.userActivation;
        if (!this._unlocked && activation && !activation.isActive) return false;
        const context = this._ensureContext();
        if (!context) return false;
        try {
            if (context.state !== 'running') await context.resume();
            this._unlocked = context.state === 'running';
            if (this._unlocked) {
                this._syncListenerToCamera();
                void this._preloadGtaEventAudio();
            }
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

    async _loadGtaEventAudioManifest() {
        if (this._gtaEventAudioManifest !== null) return this._gtaEventAudioManifest || null;
        if (this._gtaEventAudioManifestPromise) return this._gtaEventAudioManifestPromise;
        this._gtaEventAudioManifestPromise = fetch('/assets/gta_audio/manifest.json?rev=gta-demo-rel-20260816-2', { cache: 'no-store' })
            .then(async (response) => {
                if (!response.ok) throw new Error(`demo audio manifest ${response.status}`);
                const manifest = await response.json();
                if (!manifest?.events || typeof manifest.events !== 'object') throw new Error('demo audio manifest is invalid');
                this._gtaEventAudioManifest = manifest;
                return manifest;
            })
            .catch(() => {
                this._gtaEventAudioManifest = false;
                return null;
            })
            .finally(() => { this._gtaEventAudioManifestPromise = null; });
        return this._gtaEventAudioManifestPromise;
    }

    _loadGtaEventAudioBuffer(path) {
        if (!this.context || !path) return Promise.resolve(null);
        const url = audioAssetUrl(path);
        const cached = this._gtaEventAudioBuffers.get(url);
        if (cached) return cached;
        const pending = fetch(`${url}?rev=gta-demo-rel-20260816-2`, { cache: 'no-store' })
            .then(async (response) => {
                if (!response.ok) throw new Error(`demo audio ${response.status}`);
                return this.context.decodeAudioData(await response.arrayBuffer());
            })
            .catch((error) => {
                this._gtaEventAudioBuffers.delete(url);
                this._gtaEventAudioFailures.set(url, String(error?.message || error));
                throw error;
            });
        this._gtaEventAudioBuffers.set(url, pending);
        return pending;
    }

    async _ensureGtaEventAudio(event) {
        const name = String(event || '');
        if (!name || !this.context || this.context.state !== 'running') return null;
        const ready = this._gtaEventAudioReady.get(name);
        if (ready?.buffers?.size) return ready;
        const pending = this._gtaEventAudioPromises.get(name);
        if (pending) return pending;
        const load = (async () => {
            const manifest = await this._loadGtaEventAudioManifest();
            const definition = manifest?.events?.[name];
            const layers = definition?.layers;
            if (!Array.isArray(layers) || !layers.length) return null;
            const buffers = (await Promise.all(layers.map((path) => this._loadGtaEventAudioBuffer(path))))
                .filter((buffer) => !!buffer);
            if (!buffers.length) return null;
            const readyEvent = { definition, buffers: new Map(layers.map((path, index) => [path, buffers[index]]).filter((entry) => !!entry[1])) };
            this._gtaEventAudioReady.set(name, readyEvent);
            return readyEvent;
        })().catch(() => null).finally(() => this._gtaEventAudioPromises.delete(name));
        this._gtaEventAudioPromises.set(name, load);
        return load;
    }

    async _preloadGtaEventAudio() {
        const manifest = await this._loadGtaEventAudioManifest();
        if (!manifest) return;
        await Promise.all(Object.keys(manifest.events).map((event) => this._ensureGtaEventAudio(event)));
    }

    _playGtaEvent(event, { position = null, bus = null, gain = 1.0, playbackRate = 1.0 } = {}) {
        const context = this.context;
        const output = bus || this.sfxGain;
        const ready = this._gtaEventAudioReady.get(String(event || ''));
        if (!context || context.state !== 'running' || !output) return false;
        if (!ready?.buffers?.size) {
            void this._ensureGtaEventAudio(event);
            // A mapped event may arrive while its Opus leaves are still being
            // decoded. Suppress the old synthesized fallback during that race;
            // silence is preferable to playing a different, incorrect sound.
            return true;
        }
        const graph = ready.definition?.graph;
        if (graph) return this._playGtaGraphNode(graph, {
            buffers: ready.buffers, output, position,
            gain: clamp(gain, 0.0001, 2), playbackRate: clamp(playbackRate, 0.25, 4),
            delay: 0, envelopes: [],
        });
        const buffers = [...ready.buffers.values()];
        return this._playGtaSample(buffers[Math.floor(Math.random() * buffers.length)], {
            output, position, gain, playbackRate, delay: 0, envelopes: [],
        });
    }

    _playGtaGraphNode(node, state) {
        if (!node || node.type === 'silence') return false;
        const header = node.header || {};
        const volume = Number(header.volume) || 0;
        const volumeVariance = Math.max(0, Number(header.volumeVariance) || 0);
        const pitch = Number(header.pitch) || 0;
        const pitchVariance = Math.max(0, Number(header.pitchVariance) || 0);
        const preDelay = Number(header.preDelay) || 0;
        const preDelayVariance = Math.max(0, Number(header.preDelayVariance) || 0);
        const next = {
            ...state,
            gain: state.gain * centibelGain(volume + (Math.random() * 2 - 1) * volumeVariance),
            playbackRate: state.playbackRate * Math.pow(2, (pitch + (Math.random() * 2 - 1) * pitchVariance) / 1200),
            delay: Math.max(0, state.delay + (preDelay + (Math.random() * 2 - 1) * preDelayVariance) / 1000),
            envelopes: node.envelope ? [...state.envelopes, node.envelope] : state.envelopes,
        };
        if (node.type === 'sample') {
            const buffer = state.buffers.get(node.path);
            return !!buffer && this._playGtaSample(buffer, next);
        }
        if (node.type === 'RandomizedSound') {
            const variations = (node.variations || []).filter((entry) => entry?.sound?.type !== 'silence');
            const total = variations.reduce((sum, entry) => sum + Math.max(0, Number(entry.weight) || 0), 0);
            if (!variations.length) return false;
            let choice = Math.random() * (total || variations.length);
            let selected = variations[variations.length - 1].sound;
            for (const variation of variations) {
                choice -= total ? Math.max(0, Number(variation.weight) || 0) : 1;
                if (choice <= 0) { selected = variation.sound; break; }
            }
            return this._playGtaGraphNode(selected, next);
        }
        if (node.type === 'random' || node.type === 'SoundHashList') {
            const children = (node.children || []).filter((child) => child?.type !== 'silence');
            return children.length ? this._playGtaGraphNode(children[Math.floor(Math.random() * children.length)], next) : false;
        }
        if (node.type === 'WrapperSound') {
            return this._playGtaGraphNode(node.primary, next) || this._playGtaGraphNode(node.fallback, next);
        }
        if (node.type === 'SequentialSound') {
            let delay = next.delay;
            let played = false;
            for (const child of node.children || []) {
                const childState = { ...next, delay };
                played = this._playGtaGraphNode(child, childState) || played;
                const firstPath = child?.path;
                delay += firstPath ? (state.buffers.get(firstPath)?.duration || 0) : 0;
            }
            return played;
        }
        if (node.type === 'MultitrackSound') {
            return (node.children || []).reduce((played, child) => this._playGtaGraphNode(child, next) || played, false);
        }
        const children = (node.children || []).filter((child) => child?.type !== 'silence');
        if (children.length === 1) return this._playGtaGraphNode(children[0], next);
        return children.reduce((played, child) => this._playGtaGraphNode(child, next) || played, false);
    }

    _playGtaSample(buffer, { output, position, gain, playbackRate, delay = 0, envelopes = [] }) {
        const context = this.context;
        if (!context || !buffer || !output) return false;
        const source = context.createBufferSource();
        const envelope = context.createGain();
        const isSpatial = Array.isArray(position) && position.length >= 3;
        const destination = this._spatialDestination(position, output);
        const startAt = context.currentTime + Math.max(0, delay);
        const duration = buffer.duration / Math.max(0.01, playbackRate);
        source.buffer = buffer;
        source.playbackRate.value = clamp(playbackRate, 0.25, 4);
        envelope.gain.setValueAtTime(clamp(gain, 0.0001, 2), startAt);
        for (const authored of envelopes) {
            if (Number(authored?.Mode) !== 0) continue;
            const attack = Math.max(0, Number(authored.Attack) || 0) / 1000;
            const decay = Math.max(0, Number(authored.Decay) || 0) / 1000;
            const release = Math.max(0, Number(authored.Release) || 0) / 1000;
            const sustain = clamp(Number(authored.Sustain) / 100, 0, 1);
            envelope.gain.setValueAtTime(0.0001, startAt);
            envelope.gain.linearRampToValueAtTime(clamp(gain, 0.0001, 2), startAt + attack);
            envelope.gain.linearRampToValueAtTime(clamp(gain * sustain, 0.0001, 2), startAt + attack + decay);
            if (release > 0) envelope.gain.linearRampToValueAtTime(0.0001, startAt + Math.max(attack + decay, duration - release));
        }
        source.connect(envelope).connect(destination);
        source.onended = () => {
            try { source.disconnect(); } catch { /* ignore */ }
            try { envelope.disconnect(); } catch { /* ignore */ }
            if (isSpatial) {
                try { destination?.disconnect?.(); } catch { /* ignore */ }
            }
        };
        source.start(startAt);
        return true;
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
        const local = this.app?.ped?.posData || [0, 0, 0];
        const sampledPosition = [local[0] + (Math.random() - 0.5) * 32, local[1] + (Math.random() - 0.5) * 32, local[2] + 5 + Math.random() * 7];
        if (this._playGtaEvent('bird_call', { position: sampledPosition, bus: this.ambientGain, gain: 0.4, playbackRate: 0.94 + Math.random() * 0.12 })) return;
        const now = context.currentTime;
        const panner = context.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 3;
        panner.maxDistance = 45;
        panner.rolloffFactor = 0.8;
        const angle = Math.random() * Math.PI * 2;
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
        const input = this.context.createGain();
        const filter = this.context.createBiquadFilter();
        const panner = this.context.createPanner();
        filter.type = 'lowpass';
        filter.Q.value = 0.35;
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 2;
        panner.maxDistance = maxDistance;
        panner.rolloffFactor = 0.9;
        setAudioPosition(panner, Number(position[0]) || 0, Number(position[1]) || 0, Number(position[2]) || 0);
        const listener = this._getAudioCameraPose().position;
        const acoustic = this.app?.drawableStreamer?.getMloAcousticPath?.(position, listener);
        input.gain.value = clamp(acoustic?.gain ?? 1, 0.0001, 1);
        filter.frequency.value = clamp(acoustic?.cutoffHz ?? 20000, 500, 20000);
        input.connect(filter).connect(panner).connect(bus);
        return input;
    }

    _getAudioCameraPose() {
        const app = this.app;
        const camera = app?.camera;
        const dataPosition = camera?.position && app?._viewerPosToDataPos?.(camera.position);
        const dataDirection = camera?.direction && app?._viewerDirToDataDir?.(camera.direction);
        const ped = app?.ped?.posData || [0, 0, 0];
        const fallbackHeading = Number(app?.player?.headingRad) || 0;
        const position = Array.isArray(dataPosition) && dataPosition.length >= 3
            ? [Number(dataPosition[0]) || 0, Number(dataPosition[1]) || 0, Number(dataPosition[2]) || 0]
            : [Number(ped[0]) || 0, Number(ped[1]) || 0, (Number(ped[2]) || 0) + (Number(app?.pedEyeHeightData) || 1.2)];
        let direction = Array.isArray(dataDirection) && dataDirection.length >= 3
            ? [Number(dataDirection[0]) || 0, Number(dataDirection[1]) || 0, Number(dataDirection[2]) || 0]
            : [Math.sin(fallbackHeading), Math.cos(fallbackHeading), 0];
        const length = Math.hypot(direction[0], direction[1], direction[2]) || 1;
        direction = [direction[0] / length, direction[1] / length, direction[2] / length];
        return { position, direction };
    }

    _syncListenerToCamera() {
        const context = this.context;
        if (!context) return null;
        const pose = this._getAudioCameraPose();
        const listener = context.listener;
        const [lx, ly, lz] = pose.position;
        if (listener.positionX) {
            listener.positionX.value = lx;
            listener.positionY.value = ly;
            listener.positionZ.value = lz;
        } else {
            listener.setPosition?.(lx, ly, lz);
        }
        const [fx, fy, fz] = pose.direction;
        if (listener.forwardX) {
            listener.forwardX.value = fx;
            listener.forwardY.value = fy;
            listener.forwardZ.value = fz;
            listener.upX.value = 0;
            listener.upY.value = 0;
            listener.upZ.value = 1;
        } else {
            listener.setOrientation?.(fx, fy, fz, 0, 0, 1);
        }
        return pose;
    }

    _createVehicleVoiceNodes(coneAttenuation = 0) {
        const context = this.context;
        if (!context || !this.sfxGain) return null;
        const input = context.createGain();
        const exteriorFilter = context.createBiquadFilter();
        const exteriorGain = context.createGain();
        const panner = context.createPanner();
        const interiorFilter = context.createBiquadFilter();
        const interiorGain = context.createGain();
        exteriorFilter.type = 'lowpass';
        exteriorFilter.frequency.value = 18000;
        exteriorFilter.Q.value = 0.25;
        exteriorGain.gain.value = 0.0001;
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        // A GTA third-person camera follows the local vehicle several metres
        // behind it. A 1 m reference distance made the local engine almost
        // disappear under normal inverse-distance attenuation.
        panner.refDistance = 3.0;
        panner.maxDistance = 105;
        panner.rolloffFactor = 0.36;
        panner.coneInnerAngle = 220;
        panner.coneOuterAngle = 350;
        panner.coneOuterGain = Math.max(0.035, Math.min(1, centibelGain(coneAttenuation)));
        interiorFilter.type = 'lowpass';
        interiorFilter.frequency.value = 1400;
        interiorFilter.Q.value = 0.35;
        interiorGain.gain.value = 0.0001;
        input.connect(exteriorFilter).connect(exteriorGain).connect(panner).connect(this.sfxGain);
        input.connect(interiorFilter).connect(interiorGain).connect(this.sfxGain);
        return { input, exteriorFilter, exteriorGain, panner, interiorFilter, interiorGain };
    }

    _disposeVehicleVoiceNodes(nodes) {
        if (!nodes) return;
        for (const node of Object.values(nodes)) {
            try { node?.disconnect?.(); } catch { /* ignore */ }
        }
    }

    _updateVehicleSpatialAudio(state, vehicle, rpm01 = 0) {
        if (!state?.voiceNodes || !vehicle?.position || !this.context) return;
        const x = Number(vehicle.position[0]) || 0;
        const y = Number(vehicle.position[1]) || 0;
        const z = Number(vehicle.position[2]) || 0;
        const heading = Number(vehicle.headingRad) || 0;
        // VehicleController stores heading in data space where +X/+Y are
        // forward at heading 0/PI/2 respectively. The old sin/cos ordering
        // rotated every engine and exhaust emitter by 90 degrees, making the
        // authored GTA bank pan from the wrong side of the vehicle.
        const forwardX = Math.cos(heading);
        const forwardY = Math.sin(heading);
        const enginePosition = [x + forwardX * 0.58, y + forwardY * 0.58, z + 0.48];
        const exhaustPosition = [x - forwardX * 1.48, y - forwardY * 1.48, z + 0.34];
        const pose = this._getAudioCameraPose();
        const vehicleCamera = this.app?.vehicleController?.getDriverCameraTransform?.()?.position;
        const cameraDistance = Math.hypot(
            pose.position[0] - (Number(vehicleCamera?.[0]) || x),
            pose.position[1] - (Number(vehicleCamera?.[1]) || y),
            pose.position[2] - (Number(vehicleCamera?.[2]) || z),
        );
        const occupied = !!vehicle.occupied;
        const firstPerson = occupied && (this.app?.gameplayCameraMode === 'firstPerson' || cameraDistance < 1.3);
        // The player vehicle needs a near-field cabin mix even in third person.
        // Without it the only signal is the spatial emitter 8-12 m behind the
        // camera, which makes the authored granular bank sound thin and quiet.
        const exteriorMix = occupied ? (firstPerson ? 0.12 : 0.78) : 1.0;
        const interiorMix = occupied ? (firstPerson ? 0.78 : 0.34) : 0.0001;
        const interiorCutoff = firstPerson
            ? 4200 + rpm01 * 2400
            : 9200 + rpm01 * 4200;
        const now = this.context.currentTime;
        for (const [voice, position] of [['engine', enginePosition], ['exhaust', exhaustPosition]]) {
            const nodes = state.voiceNodes[voice];
            if (!nodes) continue;
            setAudioPosition(nodes.panner, position[0], position[1], position[2]);
            const direction = voice === 'engine' ? [forwardX, forwardY, 0] : [-forwardX, -forwardY, 0];
            setAudioOrientation(nodes.panner, direction[0], direction[1], direction[2]);
            nodes.exteriorGain.gain.setTargetAtTime(exteriorMix, now, 0.065);
            nodes.interiorGain.gain.setTargetAtTime(
                interiorMix * (voice === 'engine' ? 1.0 : 0.68), now, 0.065,
            );
            nodes.interiorFilter.frequency.setTargetAtTime(
                interiorCutoff * (voice === 'engine' ? 1.0 : 0.82), now, 0.08,
            );
            nodes.exteriorFilter.frequency.setTargetAtTime(firstPerson ? 8500 : 18000, now, 0.08);
        }
        state.spatialMix = {
            occupied,
            firstPerson,
            cameraDistance,
            exteriorMix,
            interiorMix,
            interiorCutoff,
        };
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
        const event = sprinting ? 'footstep_run' : 'footstep_walk';
        if (this._playGtaEvent(event, { position, gain: sprinting ? 0.72 : 0.5, playbackRate: 1.0 })) {
            this._stepSide ^= 1;
            this._markSfx(sprinting ? 'GTA sprint step' : 'GTA footstep');
            return;
        }
        const hard = String(this.app?.playerController?.lastGroundSource || '').includes('interior');
        this._noiseBurst({ duration: sprinting ? 0.095 : 0.075, gain: sprinting ? 0.19 : 0.12, frequency: hard ? 1500 : 920, position });
        this._tone({ from: sprinting ? 105 : 82, to: 52, duration: 0.08, gain: sprinting ? 0.1 : 0.055, position });
        this._stepSide ^= 1;
        this._markSfx(sprinting ? 'sprint step' : 'footstep');
    }

    _playJump() {
        // No verified jump-off event exists in the active shoe/weapon graph.
        // Landing remains authored; adding a tone here would be a placeholder.
    }

    _playLanding(strength = 0.5) {
        const amount = clamp(strength, 0.25, 1);
        if (this._playGtaEvent('landing', { gain: 0.52 + amount * 0.35, playbackRate: 1.08 - amount * 0.12 })) {
            this._markSfx('GTA landing');
            return;
        }
        this._noiseBurst({ duration: 0.12, gain: 0.12 + amount * 0.18, frequency: 420, type: 'lowpass' });
        this._tone({ from: 92, to: 38, duration: 0.16, gain: 0.08 + amount * 0.15 });
        this._markSfx('landing');
    }

    _playGunshot(position = null) {
        position ||= this.app?.ped?.posData || null;
        if (this._playGtaEvent('pistol_fire', { position, gain: 1.0 })) {
            this._markSfx('GTA pistol fire');
            return;
        }
        this._noiseBurst({ duration: 0.075, gain: 0.72, frequency: 2100, position });
        this._noiseBurst({ duration: 0.24, gain: 0.25, frequency: 520, type: 'lowpass', position, delay: 0.015 });
        this._tone({ from: 145, to: 46, duration: 0.18, gain: 0.38, type: 'triangle', position });
        this._noiseBurst({ duration: 0.32, gain: 0.07, frequency: 1100, position, delay: 0.11 });
        this._markSfx('gunshot');
    }

    _playWeaponAction(action) {
        if (action !== 'reload') {
            // Pistol heft/put-down resolve to GTA's silence wrapper. Do not add
            // an invented draw, holster, or attachment sound over the animation.
            return;
        }
        const event = action === 'reload' ? 'weapon_reload_clip_out' : `weapon_${String(action || '')}`;
        if (this._playGtaEvent(event, { gain: action === 'reload' ? 0.66 : 0.62 })) {
            if (action === 'reload') {
                window.setTimeout(() => this._playGtaEvent('weapon_reload_clip_in', { gain: 0.72 }), 560);
            }
            this._markSfx(`GTA weapon ${action}`);
            return;
        }
        if (action === 'reload') {
            this._noiseBurst({ duration: 0.035, gain: 0.12, frequency: 2600 });
            this._tone({ from: 230, to: 150, duration: 0.05, gain: 0.08, delay: 0.18 });
            this._noiseBurst({ duration: 0.04, gain: 0.16, frequency: 3200, delay: 0.72 });
        }
        this._markSfx(`weapon ${action}`);
    }

    _playEmptyWeapon() {
        // The active pistol SoundSet has no dry-fire marker. Keep this silent
        // until a verified script event is present instead of synthesizing one.
    }

    _playMeleeImpact(hit = true, position = null) {
        if (!hit) return;
        if (this._playGtaEvent('melee_hit', { position, gain: 0.75 })) {
            this._markSfx(hit ? 'GTA melee impact' : 'GTA melee swing');
            return;
        }
        if (hit) {
            this._noiseBurst({ duration: 0.095, gain: 0.3, frequency: 380, type: 'lowpass', position });
            this._tone({ from: 115, to: 48, duration: 0.11, gain: 0.2, position });
        }
        this._markSfx(hit ? 'melee impact' : 'melee swing');
    }

    _playerPainEvent() {
        const modelName = String(this.app?.runtimeCharacterProfile?.modelName || this.app?.player?.modelName || '').toLowerCase();
        return modelName.includes('mp_f_') || modelName.startsWith('a_f_') ? 'pain_female' : 'pain_male';
    }

    _playDoor(entering) {
        const event = entering ? 'vehicle_door_close' : 'vehicle_door_open';
        if (this._playGtaEvent(event, { gain: entering ? 0.72 : 0.6 })) {
            this._markSfx(entering ? 'GTA car door close' : 'GTA car door open');
            return;
        }
        this._noiseBurst({ duration: 0.09, gain: 0.2, frequency: 650, type: 'lowpass' });
        this._tone({ from: entering ? 105 : 130, to: 55, duration: 0.14, gain: 0.17 });
        this._markSfx(entering ? 'car door close' : 'car door open');
    }

    _playVehicleImpact(strength = 0.5) {
        const amount = clamp(strength, 0.25, 1);
        const event = amount >= 0.62 ? 'vehicle_collision_high' : 'vehicle_collision_low';
        if (this._playGtaEvent(event, { gain: 0.34 + amount * 0.56 })) {
            this._markSfx('GTA vehicle impact');
            return;
        }
        this._noiseBurst({ duration: 0.28, gain: 0.25 + amount * 0.35, frequency: 300, type: 'lowpass' });
        this._tone({ from: 120, to: 32, duration: 0.3, gain: 0.22 + amount * 0.25, type: 'sawtooth' });
        this._markSfx('vehicle impact');
    }

    async _loadGtaVehicleAudioManifest() {
        if (this._gtaVehicleAudioManifest !== null) return this._gtaVehicleAudioManifest || null;
        if (this._gtaVehicleAudioManifestPromise) return this._gtaVehicleAudioManifestPromise;
        this._gtaVehicleAudioManifestPromise = fetch('/assets/vehicle_audio/manifest.json?rev=gta-rel-granular-v5', { cache: 'no-store' })
            .then(async (response) => {
                if (!response.ok) throw new Error(`vehicle audio manifest ${response.status}`);
                const manifest = await response.json();
                if (!manifest?.banks || typeof manifest.banks !== 'object') throw new Error('vehicle audio manifest is invalid');
                this._gtaVehicleAudioManifest = manifest;
                return manifest;
            })
            .catch(() => {
                // The procedural layer remains a complete fallback for partial deployments.
                this._gtaVehicleAudioManifest = false;
                this._vehicleAudioStatus = { mode: 'procedural', bank: '', detail: 'GTA vehicle audio manifest unavailable' };
                return null;
            })
            .finally(() => { this._gtaVehicleAudioManifestPromise = null; });
        return this._gtaVehicleAudioManifestPromise;
    }

    _loadGtaVehicleAudioBuffer(path) {
        if (!this.context || !path) return Promise.resolve(null);
        const url = vehicleAudioAssetUrl(path);
        const cached = this._gtaVehicleAudioBuffers.get(url);
        if (cached) {
            // Map insertion order is our LRU queue. Refresh a reused clip.
            this._gtaVehicleAudioBuffers.delete(url);
            this._gtaVehicleAudioBuffers.set(url, cached);
            return cached;
        }
        const pending = fetch(`${url}?rev=gta-rel-granular-v5`, { cache: 'no-store' })
            .then(async (response) => {
                if (!response.ok) throw new Error(`vehicle audio ${response.status}`);
                return this.context.decodeAudioData(await response.arrayBuffer());
            })
            .catch((error) => {
                this._gtaVehicleAudioBuffers.delete(url);
                throw error;
            });
        this._gtaVehicleAudioBuffers.set(url, pending);
        return pending;
    }

    _trimGtaVehicleAudioBuffers(activePaths = []) {
        const keep = new Set(activePaths.map(audioAssetUrl));
        while (this._gtaVehicleAudioBuffers.size > MAX_CACHED_VEHICLE_AUDIO_BUFFERS) {
            const candidate = this._gtaVehicleAudioBuffers.keys().next().value;
            if (!candidate) break;
            const value = this._gtaVehicleAudioBuffers.get(candidate);
            this._gtaVehicleAudioBuffers.delete(candidate);
            if (keep.has(candidate)) this._gtaVehicleAudioBuffers.set(candidate, value);
        }
    }

    async _ensureVehicleGranularWorklet() {
        if (!this.context?.audioWorklet || typeof AudioWorkletNode === 'undefined') {
            this._vehicleGranularWorkletState = 'unsupported';
            return false;
        }
        if (this._vehicleGranularWorkletState === 'ready') return true;
        if (this._vehicleGranularWorkletState === 'failed') return false;
        if (this._vehicleGranularWorkletPromise) return this._vehicleGranularWorkletPromise;
        this._vehicleGranularWorkletState = 'loading';
        this._vehicleGranularWorkletPromise = this.context.audioWorklet.addModule(
            new URL('./gta_vehicle_audio_worklet.js', import.meta.url),
        ).then(() => {
            this._vehicleGranularWorkletState = 'ready';
            return true;
        }).catch(() => {
            this._vehicleGranularWorkletState = 'failed';
            return false;
        }).finally(() => {
            this._vehicleGranularWorkletPromise = null;
        });
        return this._vehicleGranularWorkletPromise;
    }

    _createVehicleGranularWorkletVoice(buffers, output) {
        if (!this.context || this._vehicleGranularWorkletState !== 'ready' || !output) return null;
        try {
            const node = new AudioWorkletNode(this.context, 'webglgta-gta-vehicle-granular-v1', {
                numberOfInputs: 0,
                numberOfOutputs: 1,
                outputChannelCount: [2],
            });
            const transfer = [];
            const clips = [];
            for (const [name, buffer] of Object.entries(buffers || {})) {
                if (!buffer?.numberOfChannels || !buffer?.length) continue;
                const channels = [];
                for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
                    const copy = buffer.getChannelData(channel).slice();
                    channels.push(copy.buffer);
                    transfer.push(copy.buffer);
                }
                clips.push({ name, channels });
            }
            node.port.postMessage({ type: 'clips', clips }, transfer);
            node.connect(output);
            return node;
        } catch {
            return null;
        }
    }

    _stopGtaVehicleAudio(fadeSeconds = 0.06) {
        const state = this._gtaVehicleAudio;
        this._gtaVehicleAudio = null;
        if (!state || !this.context) return;
        const now = this.context.currentTime;
        for (const channel of state.channels) {
            try {
                channel.gain.gain.cancelScheduledValues(now);
                channel.gain.gain.setValueAtTime(Math.max(0.0001, channel.gain.gain.value), now);
                channel.gain.gain.exponentialRampToValueAtTime(0.0001, now + fadeSeconds);
                channel.source.stop(now + fadeSeconds + 0.01);
            } catch { /* source may already be stopped */ }
        }
        for (const grain of state.grainSources || []) {
            try {
                grain.gain.gain.cancelScheduledValues(now);
                grain.gain.gain.setValueAtTime(Math.max(0.0001, grain.gain.gain.value), now);
                grain.gain.gain.exponentialRampToValueAtTime(0.0001, now + fadeSeconds);
                grain.source.stop(now + fadeSeconds + 0.01);
            } catch { /* grain may already be stopped */ }
        }
        for (const nodes of Object.values(state.voiceNodes || {})) this._disposeVehicleVoiceNodes(nodes);
        for (const node of Object.values(state.workletNodes || {})) {
            try { node.port.postMessage({ type: 'clear' }); } catch { /* ignore */ }
            try { node.disconnect(); } catch { /* ignore */ }
        }
    }

    _muteGtaVehicleAudio() {
        if (!this._gtaVehicleAudio || !this.context) return;
        const now = this.context.currentTime;
        for (const channel of this._gtaVehicleAudio.channels) {
            channel.gain.gain.setTargetAtTime(0.0001, now, 0.1);
        }
        for (const grain of this._gtaVehicleAudio.grainSources || []) {
            grain.gain.gain.setTargetAtTime(0.0001, now, 0.03);
        }
        for (const nodes of Object.values(this._gtaVehicleAudio.voiceNodes || {})) {
            nodes.exteriorGain?.gain?.setTargetAtTime(0.0001, now, 0.04);
            nodes.interiorGain?.gain?.setTargetAtTime(0.0001, now, 0.04);
        }
    }

    async _ensureGtaVehicleAudio(profile) {
        if (!this.context || !this.sfxGain || !profile?.bank) return false;
        if (this._gtaVehicleAudio?.key === profile.key) return true;
        if (this._requestedVehicleAudioBank === profile.key) return false;
        this._requestedVehicleAudioBank = profile.key;
        this._vehicleAudioStatus = { mode: 'loading', bank: profile.bank, detail: 'decoding GTA granular engine clips' };
        try {
            const manifest = await this._loadGtaVehicleAudioManifest();
            if (!manifest || this._requestedVehicleAudioBank !== profile.key) return false;
            const controller = manifest.controllers?.[profile.key] || null;
            const bank = controller?.bank || profile.bank;
            const bankDefinition = manifest.banks?.[bank];
            const clips = bankDefinition?.clips;
            const requiredClips = ['engine_idle', 'engine_accel', 'engine_decel', 'exhaust_idle', 'exhaust_accel', 'exhaust_decel'];
            if (!clips || requiredClips.some((name) => !clips[name])) throw new Error(`missing GTA granular bank: ${bank}`);
            const buffers = Object.fromEntries(await Promise.all(requiredClips.map(async (name) => [name, await this._loadGtaVehicleAudioBuffer(clips[name])]))) ;
            if (this._requestedVehicleAudioBank !== profile.key || Object.values(buffers).some((buffer) => !buffer)) return false;
            this._trimGtaVehicleAudioBuffers(Object.values(clips));
            this._stopGtaVehicleAudio();
            const granularSettings = controller?.granular || {};
            const voiceNodes = {
                engine: this._createVehicleVoiceNodes(granularSettings.engineMaxConeAttenuation),
                exhaust: this._createVehicleVoiceNodes(granularSettings.exhaustMaxConeAttenuation),
            };
            const useWorklet = await this._ensureVehicleGranularWorklet();
            const workletNodes = useWorklet ? {
                engine: this._createVehicleGranularWorkletVoice(buffers, voiceNodes.engine?.input || this.sfxGain),
                exhaust: this._createVehicleGranularWorkletVoice(buffers, voiceNodes.exhaust?.input || this.sfxGain),
            } : {};
            const granularWorkletReady = !!workletNodes.engine && !!workletNodes.exhaust;
            if (!granularWorkletReady) {
                for (const node of Object.values(workletNodes)) {
                    try { node?.disconnect?.(); } catch { /* ignore */ }
                }
            }
            const createIdleChannel = (name) => {
                const source = this.context.createBufferSource();
                const gain = this.context.createGain();
                source.buffer = buffers[name];
                source.loop = true;
                source.playbackRate.value = 0.94;
                gain.gain.value = 0.0001;
                const voice = name.startsWith('exhaust_') ? 'exhaust' : 'engine';
                source.connect(gain).connect(voiceNodes[voice]?.input || this.sfxGain);
                source.onended = () => {
                    try { source.disconnect(); } catch { /* ignore */ }
                    try { gain.disconnect(); } catch { /* ignore */ }
                };
                source.start();
                return { name, source, gain };
            };
            // Authored REL controllers play the idle recordings as granular
            // sources too. The legacy whole-buffer loops are only a fallback
            // for assets which have not been profiled yet.
            const channels = controller ? [] : [createIdleChannel('engine_idle'), createIdleChannel('exhaust_idle')];
            this._gtaVehicleAudio = {
                key: profile.key,
                bank,
                clips: buffers,
                granular: bankDefinition?.granular || {},
                channels,
                voiceNodes,
                controller,
                grainSources: new Set(),
                workletNodes: granularWorkletReady ? workletNodes : {},
                workletScheduledGrains: 0,
                nextGrainAt: Object.fromEntries(Object.keys(buffers).map((name) => [name, this.context.currentTime])),
                grainCursor: { engine: null, exhaust: null },
                revLimiterCursor: {},
                lastGear: null,
                shiftWobbleStartedAt: 0,
                shiftWobbleUntil: 0,
            };
            this._vehicleAudioStatus = {
                mode: controller ? 'gta-rel-granular' : 'gta-granular',
                bank,
                detail: controller
                    ? `decoded GTA AWC clips with authored grains, REL mix values, and spatial engine/exhaust emitters (${granularWorkletReady ? 'AudioWorklet mixer' : 'legacy node mixer'})`
                    : 'decoded GTA idle, acceleration, and deceleration clips',
            };
            return true;
        } catch (error) {
            this._vehicleAudioStatus = { mode: 'procedural', bank: profile.bank, detail: String(error?.message || error || 'GTA AWC load failed') };
            return false;
        } finally {
            if (this._requestedVehicleAudioBank === profile.key) this._requestedVehicleAudioBank = '';
        }
    }

    _nextAuthoredGrain(state, voice, clip, targetRate) {
        const metadata = state?.granular?.[clip];
        const grains = metadata?.grains;
        const loops = metadata?.loops;
        if (!Array.isArray(grains) || !grains.length || !Array.isArray(loops) || !loops.length) return null;

        let bestLoop = -1;
        let bestDifference = Infinity;
        for (let loopIndex = 0; loopIndex < loops.length; loopIndex++) {
            const sequence = loops[loopIndex];
            if (!Array.isArray(sequence) || !sequence.length) continue;
            let total = 0;
            let count = 0;
            for (const grainIndex of sequence) {
                const rate = Number(grains[grainIndex]?.[1]);
                if (!Number.isFinite(rate) || rate <= 0) continue;
                total += rate;
                count++;
            }
            if (!count) continue;
            const difference = Math.abs(total / count - targetRate);
            if (difference < bestDifference) {
                bestDifference = difference;
                bestLoop = loopIndex;
            }
        }
        if (bestLoop < 0) return null;

        const cursorKey = `${voice}:${clip}`;
        const cursor = state.grainCursor?.[cursorKey];
        if (cursor?.loopIndex >= 0 && cursor.loopIndex !== bestLoop) {
            const currentSequence = loops[cursor.loopIndex];
            if (Array.isArray(currentSequence) && currentSequence.length) {
                let currentTotal = 0;
                let currentCount = 0;
                for (const grainIndex of currentSequence) {
                    const rate = Number(grains[grainIndex]?.[1]);
                    if (!Number.isFinite(rate) || rate <= 0) continue;
                    currentTotal += rate;
                    currentCount++;
                }
                const currentDifference = currentCount ? Math.abs(currentTotal / currentCount - targetRate) : Infinity;
                if (currentDifference <= bestDifference * 1.18 + 0.35) bestLoop = cursor.loopIndex;
            }
        }

        const sequence = loops[bestLoop];
        const cursorIndex = cursor?.clip === clip && cursor.loopIndex === bestLoop
            ? (cursor.cursorIndex + 1) % sequence.length
            : 0;
        const grainIndex = Number(sequence[cursorIndex]);
        const grain = grains[grainIndex];
        const offset = Number(grain?.[0]);
        const nativeRate = Number(grain?.[1]);
        const sampleCount = Number(metadata?.sampleCount);
        if (!Number.isFinite(offset) || !Number.isFinite(nativeRate) || nativeRate <= 0 || !Number.isFinite(sampleCount) || sampleCount <= 1) return null;
        state.grainCursor[cursorKey] = { clip, loopIndex: bestLoop, cursorIndex };
        return { offsetRatio: clamp(offset / sampleCount, 0, 0.9999), nativeRate };
    }

    _emitGtaVehicleGrain(state, voice, clip, now, rpm01, targetRate, gainValue, controllerSound = null) {
        const context = this.context;
        const buffer = state?.clips?.[clip];
        if (!context || !buffer || gainValue <= 0.0001) return;
        const clipIndex = GRANULAR_CLIP_INDEX[clip];
        const channel = Number.isInteger(clipIndex) ? controllerSound?.channels?.[clipIndex] : null;
        const authored = this._nextAuthoredGrain(state, voice, clip, targetRate);
        const grainRate = Math.max(1, Number(targetRate) || granularClockRate(controllerSound, clip, rpm01));
        const grainSeconds = clamp(1 / grainRate, 0.016, 0.16);
        const playbackRate = authored
            ? clamp(grainRate / authored.nativeRate, 0.35, 2.8)
            : 0.9 + rpm01 * 0.25;
        const overlap = authored ? Math.min(0.012, grainSeconds * 0.18) : 0;
        const offset = authored
            ? Math.max(0, Math.min(buffer.duration - 0.012, buffer.duration * authored.offsetRatio))
            : (() => {
                const sourceWindow = Math.min(buffer.duration - 0.02, grainSeconds * playbackRate);
                const offsetRange = Math.max(0, buffer.duration - sourceWindow - 0.04);
                const randomness = clamp(Number(controllerSound?.loopRandomisationPitchFraction) || 0, 0, 0.2) * 0.5;
                return 0.02 + offsetRange * clamp(rpm01 * 0.92 + (Math.random() - 0.5) * randomness, 0, 1);
            })();
        const sourceDuration = Math.min(buffer.duration - offset, (grainSeconds + overlap) * playbackRate);
        if (sourceDuration <= 0.004) return;
        // AWC offsets select recorded grains, while REL clocks decide how far
        // the current vehicle state stretches each authored grain.
        const channelGain = centibelGain(channel?.volume ?? 0);
        const worklet = state?.workletNodes?.[voice];
        if (worklet?.port) {
            // AudioBufferSourceNode instances cannot be reused. Scheduling the
            // grain inside a persistent AudioWorklet removes per-grain source,
            // gain, connect, disconnect, and GC churn from the driving tick.
            try {
                worklet.port.postMessage({
                    type: 'grain',
                    clip,
                    startFrame: Math.round(Math.max(now, context.currentTime) * context.sampleRate),
                    offsetFrames: Math.round(offset * buffer.sampleRate),
                    durationFrames: Math.max(1, Math.round(grainSeconds * context.sampleRate)),
                    rate: playbackRate,
                    gain: gainValue * channelGain,
                    fadeFrames: Math.max(1, Math.round(Math.min(0.012, grainSeconds * 0.22) * context.sampleRate)),
                });
                state.workletScheduledGrains = (Number(state.workletScheduledGrains) || 0) + 1;
                return;
            } catch {
                // Use the legacy path for this grain if a browser drops the worklet.
            }
        }
        const source = context.createBufferSource();
        const gain = context.createGain();
        source.buffer = buffer;
        source.playbackRate.value = playbackRate;
        gain.gain.setValueAtTime(0.0001, now);
        const fadeIn = Math.min(0.012, grainSeconds * 0.22);
        const fadeOutAt = now + Math.max(fadeIn, grainSeconds - Math.min(0.012, grainSeconds * 0.2));
        gain.gain.linearRampToValueAtTime(gainValue * channelGain, now + fadeIn);
        gain.gain.setValueAtTime(gainValue * channelGain, fadeOutAt);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + grainSeconds + overlap);
        source.connect(gain).connect(state.voiceNodes?.[voice]?.input || this.sfxGain);
        const grain = { source, gain };
        state.grainSources.add(grain);
        source.onended = () => {
            state.grainSources.delete(grain);
            try { source.disconnect(); } catch { /* ignore */ }
            try { gain.disconnect(); } catch { /* ignore */ }
        };
        source.start(now, offset, sourceDuration);
    }

    _mixGtaVehicleAudio(profile, rpm, load, vehicle = null) {
        const state = this._gtaVehicleAudio;
        if (!state || state.key !== profile.key || !this.context) return false;
        const rpm01 = clamp((rpm - profile.idleRpm) / Math.max(1, profile.redlineRpm - profile.idleRpm), 0, 1);
        const now = this.context.currentTime;
        const controller = state.controller;
        this._updateVehicleSpatialAudio(state, vehicle, rpm01);
        const idleRate = 0.92 + rpm01 * 0.32;
        const idleMix = 0.22 * (1.0 - rpm01 * 0.58) + load * 0.035;
        for (const channel of state.channels) {
            const isExhaust = channel.name === 'exhaust_idle';
            channel.gain.gain.setTargetAtTime(Math.max(0.0001, idleMix * (isExhaust ? 0.6 : 1.0)), now, 0.045);
            channel.source.playbackRate.setTargetAtTime(idleRate * (isExhaust ? 0.98 : 1.0), now, 0.045);
        }
        if (!controller && now + 0.012 >= state.nextGrainAt.engine) {
            const accelerating = load > 0.09;
            const suffix = accelerating ? 'accel' : 'decel';
            const motionMix = clamp(0.035 + rpm01 * 0.2 + load * 0.13, 0.035, 0.31);
            this._emitGtaVehicleGrain(state, 'engine', `engine_${suffix}`, now, rpm01, 10.5, motionMix);
            this._emitGtaVehicleGrain(state, 'exhaust', `exhaust_${suffix}`, now, rpm01, 10.5, motionMix * 0.62);
            state.nextGrainAt.engine = now + 0.095;
        }
        if (controller) {
            const granular = controller.granular || {};
            const engineSound = controller.engine || null;
            const exhaustSound = controller.exhaust || engineSound;
            const master = centibelGain(granular.masterVolume);
            const gear = Math.max(0, Number(vehicle?.gear) | 0);
            if (gear > 0 && state.lastGear !== null && gear !== state.lastGear) {
                const wobbleSeconds = clamp((Number(granular.gearChangeWobbleLength) || 0) / 100, 0.04, 0.35);
                state.shiftWobbleStartedAt = now;
                state.shiftWobbleUntil = now + wobbleSeconds;
            }
            if (gear > 0) state.lastGear = gear;
            const wobbleDuration = Math.max(0.001, state.shiftWobbleUntil - state.shiftWobbleStartedAt);
            const wobbleProgress = state.shiftWobbleUntil > now
                ? clamp((now - state.shiftWobbleStartedAt) / wobbleDuration, 0, 1)
                : 1;
            const shiftWobble = state.shiftWobbleUntil > now
                ? vehicleAudioShiftWobble(granular, wobbleProgress)
                : { rate: 1, gain: 1 };
            const clutchActive = Number(vehicle?.shiftTimer) > 0;
            const engineClutch = clutchActive ? centibelGain(granular.engineClutchAttenuationPostSubmix) : 1;
            const exhaustClutch = clutchActive ? centibelGain(granular.exhaustClutchAttenuationPostSubmix) : 1;
            const weights = vehicleAudioPhaseWeights(rpm01, load);
            const phasePreVolume = (phase) => centibelGain(phase === 'idle'
                ? granular.idleVolumePreSubmix
                : (phase === 'accel' ? granular.accelVolumePreSubmix : granular.decelVolumePreSubmix));
            const phasePostVolume = (voice, phase) => {
                if (phase === 'idle') return centibelGain(voice === 'engine' ? granular.engineIdleVolumePostSubmix : granular.exhaustIdleVolumePostSubmix);
                if (phase === 'accel') return centibelGain(voice === 'engine' ? granular.engineThrottleVolumePostSubmix : granular.exhaustThrottleVolumePostSubmix);
                return centibelGain(voice === 'engine' ? granular.engineRevsVolumePostSubmix : granular.exhaustRevsVolumePostSubmix);
            };
            const scheduleVoice = (voice, sound, baseGain, clutchGain) => {
                for (const phase of ['idle', 'accel', 'decel']) {
                    const weight = weights[phase];
                    const clip = `${voice}_${phase}`;
                    if (weight <= 0.001) {
                        if (state.nextGrainAt[clip] < now) state.nextGrainAt[clip] = now;
                        continue;
                    }
                    const rate = granularClockRate(sound, clip, rpm01) * shiftWobble.rate;
                    const gain = clamp(baseGain * master * phasePreVolume(phase) * phasePostVolume(voice, phase) * clutchGain * shiftWobble.gain * Math.sqrt(weight), 0.0001, 0.3);
                    const schedule = vehicleAudioScheduleWindow(state.nextGrainAt[clip], now, rate);
                    for (const scheduledAt of schedule.times) {
                        const limiterPlay = Math.max(1, Number(granular.revLimiterGrainsToPlay) | 0);
                        const limiterSkip = Math.max(0, Number(granular.revLimiterGrainsToSkip) | 0);
                        const limiterPeriod = limiterPlay + limiterSkip;
                        const limiterCursor = Number(state.revLimiterCursor[clip]) | 0;
                        const limiterActive = rpm01 > 0.985 && limiterSkip > 0;
                        const limiterCut = limiterActive && limiterCursor % limiterPeriod >= limiterPlay
                            ? 1 - clamp(Number(granular.revLimiterVolumeCut), 0, 1)
                            : 1;
                        this._emitGtaVehicleGrain(state, voice, clip, Math.max(now, scheduledAt), rpm01, rate, gain * limiterCut, sound);
                        state.revLimiterCursor[clip] = limiterActive ? (limiterCursor + 1) % limiterPeriod : 0;
                    }
                    state.nextGrainAt[clip] = schedule.nextAt;
                }
            };
            scheduleVoice('engine', engineSound, 0.075 * centibelGain(granular.engineVolumePreSubmix) * centibelGain(granular.engineVolumePostSubmix), engineClutch);
            scheduleVoice('exhaust', exhaustSound, 0.065 * centibelGain(granular.exhaustVolumePreSubmix) * centibelGain(granular.exhaustVolumePostSubmix), exhaustClutch);
        }
        return true;
    }

    _startEngine(profile) {
        if (!this.context || !this.sfxGain) return;
        if (this._engineNodes) {
            if (this._engineNodes.profileKey !== profile.key) {
                this._engineNodes.low.type = profile.lowType;
                this._engineNodes.high.type = profile.highType;
                this._engineNodes.profileKey = profile.key;
            }
            return;
        }
        const context = this.context;
        const gain = context.createGain();
        const filter = context.createBiquadFilter();
        const low = context.createOscillator();
        const high = context.createOscillator();
        const sub = context.createOscillator();
        const subGain = context.createGain();
        const intake = context.createBufferSource();
        const intakeFilter = context.createBiquadFilter();
        const intakeGain = context.createGain();
        const road = context.createBufferSource();
        const roadFilter = context.createBiquadFilter();
        const roadGain = context.createGain();
        const skid = context.createBufferSource();
        const skidFilter = context.createBiquadFilter();
        const skidGain = context.createGain();
        low.type = profile.lowType;
        high.type = profile.highType;
        sub.type = 'sine';
        subGain.gain.value = 0.0001;
        intake.buffer = this._noiseBuffer(2);
        intake.loop = true;
        intakeFilter.type = 'bandpass';
        intakeFilter.frequency.value = profile.intakeBase;
        intakeFilter.Q.value = 0.75;
        intakeGain.gain.value = 0.0001;
        road.buffer = this._noiseBuffer(2);
        road.loop = true;
        roadFilter.type = 'bandpass';
        roadFilter.frequency.value = 820;
        roadFilter.Q.value = 0.55;
        roadGain.gain.value = 0.0001;
        skid.buffer = this._noiseBuffer(1.5);
        skid.loop = true;
        skidFilter.type = 'highpass';
        skidFilter.frequency.value = 1350;
        skidGain.gain.value = 0.0001;
        gain.gain.value = 0.0001;
        filter.type = 'lowpass';
        filter.frequency.value = 620;
        low.connect(filter);
        high.connect(filter);
        sub.connect(subGain).connect(filter);
        intake.connect(intakeFilter).connect(intakeGain).connect(filter);
        filter.connect(gain).connect(this.sfxGain);
        road.connect(roadFilter).connect(roadGain).connect(this.sfxGain);
        skid.connect(skidFilter).connect(skidGain).connect(this.sfxGain);
        low.start();
        high.start();
        sub.start();
        intake.start();
        road.start();
        skid.start();
        this._engineNodes = { gain, filter, low, high, sub, subGain, intake, intakeFilter, intakeGain, road, roadFilter, roadGain, skid, skidFilter, skidGain, profileKey: profile.key };
    }

    _updateEngine(vehicle, driving, dt) {
        if (!this.context) return;
        if (!driving) {
            if (this._engineNodes) {
                this._engineNodes.gain.gain.setTargetAtTime(0.0001, this.context.currentTime, 0.12);
                this._engineNodes.roadGain.gain.setTargetAtTime(0.0001, this.context.currentTime, 0.12);
                this._engineNodes.skidGain?.gain?.setTargetAtTime(0.0001, this.context.currentTime, 0.05);
            }
            this._muteGtaVehicleAudio();
            return;
        }
        const profile = vehicleAudioProfile(vehicle?.audioNameHash);
        if (this._gtaVehicleAudio?.key !== profile.key && this._requestedVehicleAudioBank !== profile.key && this._gtaVehicleAudioManifest !== false) {
            void this._ensureGtaVehicleAudio(profile);
        }
        this._startEngine(profile);
        const nodes = this._engineNodes;
        if (!nodes) return;
        const speed = Math.abs(Number(vehicle?.speed) || 0);
        const maxSpeed = Math.max(20, Math.min(105, (Number(vehicle?.handling?.maxFlatVelocity) || 151.2) / 3.6));
        const speed01 = clamp(speed / maxSpeed, 0, 1);
        const load = clamp(vehicle?.engineLoad, 0, 1);
        const slip = clamp(vehicle?.tireSlip, 0, 1);
        const rpm = clamp(vehicle?.rpm, profile.idleRpm, profile.redlineRpm);
        const gtaAudioActive = this._mixGtaVehicleAudio(profile, rpm, load, vehicle);
        // Once an authored bank is active, every synthetic engine layer must
        // be silent. Otherwise its oscillator/noise character leaks through
        // the real AWC material and makes the vehicle read as a placeholder.
        const syntheticMix = gtaAudioActive ? 0.0001 : 1;
        const firingHz = profile.kind === 'electric'
            ? 42 + (rpm / profile.redlineRpm) * 230
            : Math.max(18, (rpm / 60) * (profile.cylinders / 2));
        nodes.low.frequency.setTargetAtTime(firingHz, this.context.currentTime, 0.035);
        nodes.high.frequency.setTargetAtTime(firingHz * (profile.kind === 'electric' ? 4.2 : 2.03), this.context.currentTime, 0.035);
        nodes.sub.frequency.setTargetAtTime(Math.max(20, firingHz * (profile.kind === 'electric' ? 0.82 : 0.5)), this.context.currentTime, 0.04);
        nodes.subGain.gain.setTargetAtTime((0.0001 + profile.subGain * (0.42 + load * 0.58)) * syntheticMix, this.context.currentTime, 0.06);
        nodes.filter.frequency.setTargetAtTime(260 + speed01 * 950 + load * 780, this.context.currentTime, 0.055);
        // An active AWC bank replaces the oscillator engine entirely. Leaving even
        // a quiet oscillator under it still reads as the old placeholder sound.
        nodes.gain.gain.setTargetAtTime((0.025 + profile.lowGain * (0.46 + load * 0.54) + speed01 * 0.045) * syntheticMix, this.context.currentTime, 0.06);
        // The granular AWC source already contains intake/exhaust content. Do
        // not leave procedural intake noise underneath an active GTA bank.
        nodes.intakeGain.gain.setTargetAtTime(0.0001 + profile.intakeGain * (0.12 + load * 0.88) * (0.35 + speed01 * 0.65) * syntheticMix, this.context.currentTime, 0.05);
        nodes.intakeFilter.frequency.setTargetAtTime(profile.intakeBase + speed01 * profile.intakeRange + load * profile.intakeRange * 0.35, this.context.currentTime, 0.05);
        // Granular banks replace engine synthesis, not wheel/material contact.
        nodes.roadGain.gain.setTargetAtTime(speed01 < 0.025 ? 0.0001 : 0.012 + speed01 * profile.roadGain, this.context.currentTime, 0.07);
        nodes.roadFilter.frequency.setTargetAtTime(460 + speed01 * 2050, this.context.currentTime, 0.07);
        nodes.skidGain?.gain?.setTargetAtTime(slip > 0.07 ? slip * (0.035 + speed01 * 0.16) : 0.0001, this.context.currentTime, 0.035);
        nodes.skidFilter?.frequency?.setTargetAtTime(850 + slip * 2100, this.context.currentTime, 0.04);
        if (slip > 0.22 && speed > 5) this._markSfx('tire scrub');
    }

    _prewarmVehicleAudio(vehicle) {
        if (!vehicle || !this.context || this.context.state !== 'running') return;
        const profile = vehicleAudioProfile(vehicle.audioNameHash);
        if (this._gtaVehicleAudio?.key === profile.key || this._requestedVehicleAudioBank === profile.key || this._gtaVehicleAudioManifest === false) return;
        const distance = Number(this.app?.vehicleController?.getDistanceToPlayer?.());
        if (!Number.isFinite(distance) || distance > 100) return;
        this._vehicleAudioStatus = { mode: 'preloading', bank: profile.bank, detail: 'preparing GTA granular engine bank near player' };
        void this._ensureGtaVehicleAudio(profile);
    }

    _playHorn() {
        const local = this.app?.ped?.posData || [0, 0, 0];
        const angle = Math.random() * Math.PI * 2;
        const position = [local[0] + Math.cos(angle) * 30, local[1] + Math.sin(angle) * 30, local[2] + 1];
        if (this._playGtaEvent('distant_horn', { position, bus: this.ambientGain, gain: 0.32 })) return;
        this._tone({ from: 315, to: 310, duration: 0.35, gain: 0.06, type: 'square', position, bus: this.ambientGain });
        this._tone({ from: 420, to: 415, duration: 0.32, gain: 0.035, type: 'square', position, bus: this.ambientGain });
    }

    _playDistantSiren() {
        const local = this.app?.ped?.posData || [0, 0, 0];
        const position = [local[0] + 36, local[1] - 28, local[2] + 1];
        if (this._playGtaEvent('distant_siren', { position, bus: this.ambientGain, gain: 0.25 })) return;
        for (let i = 0; i < 4; i++) {
            this._tone({ from: i % 2 ? 510 : 690, to: i % 2 ? 690 : 510, duration: 0.42, gain: 0.025, type: 'sine', position, bus: this.ambientGain, delay: i * 0.4 });
        }
    }

    updateGameplay(dt = 1 / 60) {
        if (!this.gameplayEnabled || !this.context || this.context.state !== 'running') return;
        this._syncListenerToCamera();
        const step = clamp(dt, 0, 0.1);
        const app = this.app;
        const vehicle = app?.vehicleController?.getRenderState?.();
        const driving = !!vehicle?.occupied;
        const speed = Number(vehicle?.speed) || 0;
        if (!driving) this._prewarmVehicleAudio(vehicle);
        this._updateEngine(vehicle, driving, step);
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
        const npcShot = app?.npcSystem?.lastShot;
        if (npcShot?.id && String(npcShot.id) !== this._lastNpcShotId) {
            this._playGunshot(Array.isArray(npcShot.startData) ? npcShot.startData : null);
            this._lastNpcShotId = String(npcShot.id);
        }

        const melee = app?.meleeController?.getStatus?.();
        if (melee) {
            if (melee.attacking && !this._lastMeleeAttacking) this._playMeleeImpact(false);
            if (melee.lastAttack && melee.lastAttack !== this._lastAttack && melee.lastAttack.result === 'hit') this._playMeleeImpact(true);
            if (melee.lastHit && melee.lastHit !== this._lastHit) {
                this._playMeleeImpact(true);
                this._playGtaEvent(this._playerPainEvent(), { position: app?.ped?.posData || null, gain: 0.72 });
            }
            if (melee.lifeState !== this._lastLifeState && melee.lifeState !== 'alive') {
                this._playLanding(1);
                this._playGtaEvent(melee.lifeState === 'dead' ? 'wasted' : this._playerPainEvent(), { gain: 0.82 });
            }
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
        const occlusionFilter = context.createBiquadFilter();
        const panner = context.createPanner();
        occlusionFilter.type = 'lowpass';
        occlusionFilter.frequency.value = 20000;
        occlusionFilter.Q.value = 0.35;
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 1.4;
        panner.maxDistance = 15;
        panner.rolloffFactor = 0.9;
        source.connect(rangeGain).connect(occlusionFilter).connect(panner).connect(this.voiceGain);
        peer.source = source;
        peer.rangeGain = rangeGain;
        peer.occlusionFilter = occlusionFilter;
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
        try { peer.occlusionFilter?.disconnect?.(); } catch { /* ignore */ }
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
        // The audio listener must match the camera, especially in a vehicle.
        // Following the ped heading caused HRTF panning to disagree with view
        // direction and made all in-car sources read as flat/incorrect.
        const pose = this._syncListenerToCamera();
        if (!pose) return;
        const lx = pose.position[0];
        const ly = pose.position[1];
        const lz = pose.position[2];

        const now = performance.now();
        const interiorEnvironment = this.app?.drawableStreamer?.getActiveInteriorEnvironment?.(this.app?.timeOfDayHours);
        if (this.interiorAmbientFilter) {
            const strength = clamp(interiorEnvironment?.strength ?? 0, 0, 1);
            this.interiorAmbientFilter.frequency.setTargetAtTime(20000 - strength * 17800, context.currentTime, 0.08);
        }
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
            const acoustic = this.app?.drawableStreamer?.getMloAcousticPath?.([x, y, z], [lx, ly, lz]);
            peer.rangeGain.gain.setTargetAtTime(gain * clamp(acoustic?.gain ?? 1, 0, 1), context.currentTime, 0.035);
            peer.occlusionFilter?.frequency?.setTargetAtTime(clamp(acoustic?.cutoffHz ?? 20000, 500, 20000), context.currentTime, 0.05);
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

    getVehicleAudioStatus() {
        return {
            ...this._vehicleAudioStatus,
            activeBank: this._gtaVehicleAudio?.bank || '',
            activeChannels: this._gtaVehicleAudio?.channels?.length || 0,
            activeGrains: this._gtaVehicleAudio?.grainSources?.size || 0,
            granularMixer: Object.keys(this._gtaVehicleAudio?.workletNodes || {}).length
                ? 'audioworklet'
                : 'legacy-nodes',
            scheduledWorkletGrains: this._gtaVehicleAudio?.workletScheduledGrains || 0,
            cachedBuffers: this._gtaVehicleAudioBuffers.size,
            spatialEngine: !!this._gtaVehicleAudio?.voiceNodes?.engine,
            spatialExhaust: !!this._gtaVehicleAudio?.voiceNodes?.exhaust,
            spatialMix: this._gtaVehicleAudio?.spatialMix || null,
            contextState: this.context?.state || 'uninitialized',
            gameplayEnabled: this.gameplayEnabled,
            unlocked: this._unlocked,
            sfxVolume: this.sfxVolume,
        };
    }

    getEventAudioStatus() {
        return {
            manifestEvents: Object.keys(this._gtaEventAudioManifest?.events || {}).length,
            readyEvents: this._gtaEventAudioReady.size,
            cachedBuffers: this._gtaEventAudioBuffers.size,
            failures: Object.fromEntries(this._gtaEventAudioFailures),
        };
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
        this._stopGtaVehicleAudio(0);
        this._gtaVehicleAudioBuffers.clear();
        this._gtaEventAudioBuffers.clear();
        this._gtaEventAudioPromises.clear();
        this._gtaEventAudioReady.clear();
        this._gtaEventAudioFailures.clear();
        if (this._engineNodes) {
            try { this._engineNodes.low.stop(); } catch { /* ignore */ }
            try { this._engineNodes.high.stop(); } catch { /* ignore */ }
            try { this._engineNodes.sub.stop(); } catch { /* ignore */ }
            try { this._engineNodes.intake.stop(); } catch { /* ignore */ }
            try { this._engineNodes.road.stop(); } catch { /* ignore */ }
            try { this._engineNodes.skid?.stop(); } catch { /* ignore */ }
            this._engineNodes = null;
        }
        window.removeEventListener('pointerdown', this._unlock);
        window.removeEventListener('keydown', this._unlock);
        try { this.context?.close?.(); } catch { /* ignore */ }
        this.context = null;
    }
}

export { VOICE_MODES };

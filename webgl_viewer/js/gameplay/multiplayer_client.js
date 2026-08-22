const SEND_INTERVAL_MS = 66;
const INTERPOLATION_DELAY_MS = 120;
const EXTRAPOLATION_LIMIT_MS = 100;
const PEER_SAMPLE_LIMIT = 8;
const CONNECT_TIMEOUT_MS = 8_000;
const PEER_TIMEOUT_MS = 15_000;
const RESUME_TOKEN_KEY = 'webglgta.multiplayer.resume.v1';
const SESSION_RESUME_TOKEN_KEY = 'webglgta.multiplayer.resume.session.v1';

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function lerpAngle(a, b, t) {
    const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
    return a + delta * t;
}

function randomPlayerName() {
    return `Player ${Math.floor(1000 + Math.random() * 9000)}`;
}

function pageSessionId() {
    // This identifies a live browser page to the server, not a character. It
    // must not be inherited by a duplicate tab, otherwise one profile can make
    // two sockets repeatedly evict each other before the duplicate-tab guard
    // has a chance to respond.
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

function sessionResumeToken() {
    try {
        const scoped = sessionStorage.getItem(SESSION_RESUME_TOKEN_KEY);
        if (scoped !== null) return scoped;
        const saved = localStorage.getItem(RESUME_TOKEN_KEY) || '';
        sessionStorage.setItem(SESSION_RESUME_TOKEN_KEY, saved);
        return saved;
    } catch {
        return '';
    }
}

export class MultiplayerClient {
    constructor(app) {
        this.app = app;
        const params = new URLSearchParams(window.location.search);
        this.district = params.get('outpost') === 'weed' ? 'weed_shop' : 'demo';
        this.room = this.district;
        this.name = String(params.get('name') || randomPlayerName()).slice(0, 24);
        this.sessionId = pageSessionId();
        this.resumeToken = sessionResumeToken();
        this._sessionNonce = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
        this._sessionChannel = null;
        this._isolatedDuplicateSession = false;
        this.id = '';
        this.status = 'offline';
        this.socket = null;
        this.peers = new Map();
        this.profile = null;
        this.adminCommands = false;
        this.pickups = [];
        this.nearbyPickup = null;
        this._pickupUseDown = false;
        this._lastWeaponActionSerial = 0;
        this._lastMeleeActionSerial = 0;
        this._lastAppearanceKey = '';
        this.lastGameplayEvent = null;
        this._lastSendMs = 0;
        this._retryMs = 750;
        this._retryTimer = 0;
        this._connectTimer = 0;
        this._destroyed = false;
        try {
            this._sessionChannel = new BroadcastChannel('webglgta.multiplayer.sessions.v1');
            this._sessionChannel.addEventListener('message', (event) => this._onSessionMessage(event.data));
            this._sessionChannel.postMessage({ type: 'probe', sessionId: this.sessionId, nonce: this._sessionNonce });
        } catch { /* BroadcastChannel is optional. */ }
    }

    _onSessionMessage(message) {
        if (!message || message.sessionId !== this.sessionId || message.nonce === this._sessionNonce) return;
        if (message.type === 'probe' && (this.status === 'online' || this.status === 'connecting')) {
            this._sessionChannel?.postMessage?.({
                type: 'active',
                sessionId: this.sessionId,
                nonce: this._sessionNonce,
                target: message.nonce,
            });
            return;
        }
        // Two newly opened tabs can both be offline while they probe. Use a
        // deterministic tie-breaker so only one keeps the cloned profile token.
        if (message.type === 'probe' && this.status === 'offline' && String(message.nonce) < String(this._sessionNonce)) {
            this._isolateDuplicateSession();
            return;
        }
        if (message.type !== 'active' || message.target !== this._sessionNonce || this.status === 'online') return;
        this._isolateDuplicateSession();
    }

    _isolateDuplicateSession() {
        this.sessionId = pageSessionId();
        // localStorage is intentionally left untouched for the original tab.
        // This tab gets a new profile rather than concurrently controlling it.
        this.resumeToken = '';
        this._isolatedDuplicateSession = true;
        try {
            sessionStorage.setItem(SESSION_RESUME_TOKEN_KEY, '');
        } catch { /* ignore */ }
    }

    connect() {
        if (this._destroyed || this.socket || !this.app?.spawnDistrictDemo) return;
        this.status = 'connecting';
        this.app?._syncMultiplayerHud?.();
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(`${protocol}//${window.location.host}/__multiplayer`);
        this.socket = socket;
        clearTimeout(this._connectTimer);
        this._connectTimer = setTimeout(() => socket.close(4000, 'connect timeout'), CONNECT_TIMEOUT_MS);
        socket.addEventListener('open', () => {
            try {
                socket.send(JSON.stringify({ type: 'join', room: this.room, district: this.district, name: this.name, sessionId: this.sessionId, resumeToken: this.resumeToken, state: this._captureLocalState({ includeAppearance: true }) }));
            } catch {
                socket.close();
            }
        });
        socket.addEventListener('message', (event) => this._onMessage(event.data));
        socket.addEventListener('close', (event) => this._onDisconnect(socket, event));
        socket.addEventListener('error', () => socket.close());
    }

    _onDisconnect(socket, event = null) {
        if (this.socket !== socket) return;
        clearTimeout(this._connectTimer);
        this.socket = null;
        this.id = '';
        const fatal = Number(event?.code) === 4004;
        this.status = (this._destroyed || fatal) ? 'offline' : 'reconnecting';
        this.peers.clear();
        this.app?.audioSystem?.resetPeers?.();
        this.app?._clearRemotePlayerMeshes?.();
        this.app?._syncMultiplayerHud?.();
        if (!this._destroyed && !fatal) {
            clearTimeout(this._retryTimer);
            this._retryTimer = setTimeout(() => this.connect(), this._retryMs);
            this._retryMs = Math.min(8_000, this._retryMs * 1.7);
        }
    }

    _waitForProfileRelease() {
        // A second page must not turn itself into a fresh temporary character.
        // That behavior made a duplicated tab look like a second player spawned
        // directly beside the local one. Keep its profile token, retry after the
        // current owner disconnects, and preserve the single-character contract.
        this.status = 'profile_in_use';
        this.app?._syncMultiplayerHud?.();
        try { this.socket?.close(4005, 'profile already active'); } catch { /* ignore */ }
    }

    _onMessage(raw) {
        let message;
        try { message = JSON.parse(raw); } catch { return; }
        if (message.type === 'welcome') {
            if (!message.id) return;
            clearTimeout(this._connectTimer);
            this.id = String(message.id || '');
            this.resumeToken = String(message.resumeToken || this.resumeToken || '');
            try {
                sessionStorage.setItem(SESSION_RESUME_TOKEN_KEY, this.resumeToken);
                // An automatically isolated duplicate tab keeps its temporary
                // character in session storage. It must not overwrite the
                // original tab's persisted character token.
                if (this.resumeToken && !this._isolatedDuplicateSession) localStorage.setItem(RESUME_TOKEN_KEY, this.resumeToken);
            } catch { /* ignore */ }
            this.room = String(message.room || this.room);
            this.adminCommands = message.adminCommands === true;
            this.status = 'online';
            this._retryMs = 750;
            this.peers.clear();
            // A welcome is the only normal profile message that establishes a
            // local position. Later profile updates carry inventory, banking,
            // or health state and must not recreate the local ped.
            this._applyProfile(message.profile, message.state, false, true);
            this.app?.npcSystem?.applyNetworkSnapshot?.(message.world || [], message);
            this.pickups = Array.isArray(message.pickups) ? message.pickups : [];
            this.app?.doorController?.applyNetworkStates?.(message.doors || []);
            for (const peer of message.peers || []) {
                this._upsertPeer(peer.id, peer.name, peer.state, true);
                this.app?.audioSystem?.onPeerAvailable?.(peer.id);
            }
        } else if (message.type === 'peer_joined') {
            this._upsertPeer(message.id, message.name, message.state, true);
            this.app?.audioSystem?.onPeerAvailable?.(message.id);
        } else if (message.type === 'peer_state') {
            this._upsertPeer(message.id, null, message.state, false);
        } else if (message.type === 'peer_left') {
            const id = String(message.id || '');
            this.peers.delete(id);
            this.app?.audioSystem?.removePeer?.(id);
        } else if (message.type === 'voice_signal') {
            void this.app?.audioSystem?.handleSignal?.(message.from, message.signal);
        } else if (message.type === 'chat') {
            this.app?.chatMenu?.receiveChat?.(message);
        } else if (message.type === 'player_state') {
            this._applyProfile(message.profile, message.state, !!message.respawn, !!message.respawn);
        } else if (message.type === 'bank_profile') {
            this._applyProfile(message.profile);
        } else if (message.type === 'admin_result') {
            if (message.result?.success && (message.command === 'teleport' || (message.command === 'noclip' && message.result.enabled))) {
                this.app?.vehicleController?.exitVehicle?.('admin movement');
            }
            this._applyProfile(message.profile, message.state, false, message.result?.success && message.command === 'teleport');
            this.app?.chatMenu?.receiveAdminResult?.(message);
        } else if (message.type === 'track_teleport_result') {
            const result = message.result || {};
            if (result.success) {
                this.district = String(result.expansion?.id || result.district || 'nordschleife');
                this.app?.teleportToDerivedRoad?.(result.expansion || null, message.state || null);
            }
            this.app?.chatMenu?.addMessage?.({ system: true, text: String(result.message || (result.success ? 'Teleported to the Nurburgring road' : 'Track teleport failed')) });
        } else if (message.type === 'state_correction') {
            this._applyStateCorrection(message.state);
        } else if (message.type === 'gameplay_event') {
            this._handleGameplayEvent(message);
        } else if (message.type === 'world_state') {
            this.app?.npcSystem?.applyNetworkSnapshot?.(message.npcs || [], message);
            this.pickups = Array.isArray(message.pickups) ? message.pickups : this.pickups;
            const mine = (message.wanted || []).find((entry) => entry.id === this.id);
            if (this.app?.npcSystem) this.app.npcSystem.wantedLevel = Number(mine?.level) || 0;
        } else if (message.type === 'door_state') {
            this.app?.doorController?.applyNetworkState?.(message);
        } else if (message.type === 'profile_in_use' || (message.type === 'error' && message.code === 'profile_in_use')) {
            this._waitForProfileRelease();
        } else if (message.type === 'session_replaced') {
            // The newer page owns the character. Wait for it to leave instead
            // of manufacturing a second local profile in the same world.
            this._waitForProfileRelease();
        } else if (message.type === 'error') {
            this.status = String(message.code || 'error');
        }
        this.app?._syncMultiplayerHud?.();
    }

    _applyProfile(profile, state = null, respawn = false, syncPosition = false) {
        if (profile && typeof profile === 'object') this.profile = profile;
        if (profile?.banking) this.app?.bankingController?.applyProfile?.(profile);
        const health = Number(profile?.health ?? state?.health);
        const armor = Number(profile?.armor ?? state?.armor);
        if (Number.isFinite(health)) this.app?.meleeController?.applyAuthoritativeState?.({ health, armor, dead: health <= 0, respawn });
        if (profile?.inventory) this.app?.weaponController?.applyAuthoritativeInventory?.(profile.inventory);
        if (!syncPosition) return;
        const position = profile?.position;
        if (Array.isArray(position) && position.length >= 3 && this.app?.ped) {
            const eye = Number(this.app.pedEyeHeightData) || 1.2;
            const x = Number(position[0]);
            const y = Number(position[1]);
            const feetZ = Number(position[2]);
            this.app.spawnPedAt?.([x, y, feetZ + eye], { groundSource: 'server_profile' });
            // A saved MLO position can arrive before its collision tile and
            // containing room. Settle it while idle instead of making the first
            // movement input perform the authoritative floor correction.
            this.app.settlePersistedDemoSpawn?.({ x, y, feetZ, label: 'saved location' });
        }
    }

    _applyStateCorrection(state) {
        if (!state || !this.app?.ped) return;
        if (!state.inVehicle && this.app?.vehicleController?.inVehicle) {
            this.app.vehicleController.exitVehicle?.('server correction');
        }
        const eye = Number(this.app.pedEyeHeightData) || 1.2;
        this.app.spawnPedAt?.([Number(state.x) || 0, Number(state.y) || 0, (Number(state.feetZ) || 0) + eye], { groundSource: 'server_correction' });
    }

    _handleGameplayEvent(message) {
        this.lastGameplayEvent = message;
        const destination = message?.kind === 'destination_teleport' ? message.result : null;
        if (destination?.success) {
            this.district = String(destination.district || this.district || 'demo');
            this.app?.vehicleController?.exitVehicle?.('destination travel');
            const returnsToLegion = destination.returnToLegion === true
                || String(destination.destination || '').trim().toLowerCase() === 'legion';
            if (returnsToLegion) this.app?.returnToLegionSquare?.({ serverPosition: destination });
            else this.app?.activateDemoDestination?.(destination);
            this.app?.chatMenu?.addMessage?.({
                system: true,
                text: `Arrived at ${String(destination.label || 'destination')}`,
            });
        }
        if (message.profile) this._applyProfile(message.profile, message.state);
        this.app?.bankingController?.handleServerEvent?.(message);
        if (message?.kind === 'door_toggle' && message?.result) this.app?.doorController?.applyNetworkState?.(message.result);
        if (message.id && message.id !== this.id) this.app?.audioSystem?.handleRemoteGameplayEvent?.(message);
        if (message.id && message.state) this._upsertPeer(message.id, null, message.state, true);
    }

    sendGameplayAction(action) {
        if (!action || this.socket?.readyState !== WebSocket.OPEN || this.status !== 'online') return false;
        this.socket.send(JSON.stringify({ type: 'action', action }));
        return true;
    }

    sendChat(text) {
        const value = String(text || '').trim().slice(0, 180);
        if (!value || this.socket?.readyState !== WebSocket.OPEN || this.status !== 'online') return false;
        this.socket.send(JSON.stringify({ type: 'chat', text: value }));
        return true;
    }

    sendAdminCommand(command, args = {}) {
        if (!command || this.socket?.readyState !== WebSocket.OPEN || this.status !== 'online') return false;
        this.socket.send(JSON.stringify({ type: 'admin_command', command, args }));
        return true;
    }

    requestTrackTeleport() {
        if (this.socket?.readyState !== WebSocket.OPEN || this.status !== 'online') return false;
        this.socket.send(JSON.stringify({ type: 'track_teleport' }));
        return true;
    }

    requestLegionRecovery() {
        return this.sendGameplayAction({
            kind: 'destination_teleport',
            destination: 'legion',
            eventId: `${this.sessionId}:legion-recovery:${Date.now()}`,
        });
    }

    _upsertPeer(idValue, name, state, immediate) {
        const id = String(idValue || '');
        if (!id || id === this.id || !state) return;
        const now = performance.now();
        let peer = this.peers.get(id);
        const nextState = peer ? { ...peer.render, ...state } : { ...state };
        if (!peer) {
            peer = { id, name: String(name || 'Player'), render: nextState, samples: [{ at: now, state: nextState }], lastSeen: now };
            this.peers.set(id, peer);
        } else {
            if (name) peer.name = String(name);
            if (!Array.isArray(peer.samples)) peer.samples = [];
            if (immediate) {
                peer.samples.length = 0;
                peer.render = nextState;
            }
            const previous = peer.samples[peer.samples.length - 1];
            peer.samples.push({ at: Math.max(now, Number(previous?.at) + 1 || now), state: nextState });
            if (peer.samples.length > PEER_SAMPLE_LIMIT) peer.samples.splice(0, peer.samples.length - PEER_SAMPLE_LIMIT);
            peer.lastSeen = now;
        }
    }

    _interpolatePeer(peer, renderTime) {
        const samples = peer.samples;
        if (!Array.isArray(samples) || !samples.length) return peer.render;
        while (samples.length > 2 && samples[1].at <= renderTime) samples.shift();
        const fromSample = samples[0];
        const toSample = samples[1] || fromSample;
        const span = Math.max(1, toSample.at - fromSample.at);
        let t = samples.length < 2 ? 1 : (renderTime - fromSample.at) / span;
        if (t > 1) t = 1 + Math.min(EXTRAPOLATION_LIMIT_MS, renderTime - toSample.at) / span;
        t = Math.max(0, t);
        const a = fromSample.state;
        const b = toSample.state;
        const fromTransition = a.locomotionTransition;
        const toTransition = b.locomotionTransition;
        const sameTransition = fromTransition?.active
            && toTransition?.active
            && fromTransition.clip === toTransition.clip;
        return {
            ...b,
            x: lerp(Number(a.x) || 0, Number(b.x) || 0, t),
            y: lerp(Number(a.y) || 0, Number(b.y) || 0, t),
            feetZ: lerp(Number(a.feetZ) || 0, Number(b.feetZ) || 0, t),
            heading: lerpAngle(Number(a.heading) || 0, Number(b.heading) || 0, t),
            phase: lerp(Number(a.phase) || 0, Number(b.phase) || 0, t),
            move01: lerp(Number(a.move01) || 0, Number(b.move01) || 0, t),
            locomotionTransition: sameTransition
                ? {
                    ...toTransition,
                    progress: Math.max(0, Math.min(1, lerp(Number(fromTransition.progress) || 0, Number(toTransition.progress) || 0, t))),
                }
                : (toTransition || null),
        };
    }

    _captureLocalState({ includeAppearance = false } = {}) {
        const ped = this.app?.ped?.posData;
        if (!ped) return null;
        const player = this.app.player || {};
        const vehicle = this.app.vehicleController?.getRenderState?.();
        const voice = this.app.audioSystem?.getNetworkState?.() || {};
        const transition = player._locomotionTransition;
        const state = {
            x: Number(ped[0]) || 0,
            y: Number(ped[1]) || 0,
            feetZ: (Number(ped[2]) || 0) - (Number(this.app.pedEyeHeightData) || 0),
            heading: Number(player.headingRad) || 0,
            phase: Number(player.animPhase) || 0,
            move01: Number(player.animMove01) || 0,
            gait: String(player.animGait || 'idle'),
            locomotionTransition: transition?.active ? {
                active: true,
                clip: String(transition.clip || ''),
                progress: Math.max(0, Math.min(1, Number(transition.progress) || 0)),
            } : null,
            phone: this.app.phoneController?.getNetworkState?.() || null,
            health: Number(this.app.meleeController?.getStatus?.()?.health) || 0,
            armor: Number(this.app.meleeController?.getStatus?.()?.armor) || 0,
            dead: this.app.meleeController?.getStatus?.()?.lifeState === 'dead',
            inVehicle: !!this.app.vehicleController?.inVehicle,
            vehicle: vehicle ? {
                x: Number(vehicle.position?.[0]) || 0,
                y: Number(vehicle.position?.[1]) || 0,
                z: Number(vehicle.position?.[2]) || 0,
                heading: Number(vehicle.headingRad) || 0,
                model: String(vehicle.model || 'sultan'),
                speed: Number(vehicle.speed) || 0,
                damage: Number(vehicle.damage) || 0,
            } : null,
            weaponAction: String(this.app.weaponController?.getStatus?.()?.lastAction || ''),
            weaponActionSerial: Number(this.app.weaponController?.getStatus?.()?.actionSerial) || 0,
            weaponPhase: String(this.app.weaponController?.getStatus?.()?.phase || 'holstered'),
            weaponFiring: Number(this.app.weaponController?.getRenderState?.()?.shotPulse) > 0,
            meleeAction: String(this.app.meleeController?.getStatus?.()?.lastAttack?.type || ''),
            meleeActionSerial: Number(this.app.meleeController?.getStatus?.()?.actionSerial) || 0,
            meleeAttacking: !!this.app.meleeController?.getStatus?.()?.attacking,
            meleeProgress: Number(this.app.meleeController?.getCharacterPose?.()?.progress) || 0,
            ...voice,
        };
        if (includeAppearance) state.appearance = {
                modelName: String(this.app.runtimeCharacterProfile?.modelName || this.app.player?.modelName || 'mp_m_freemode_01'),
                hashes: Array.isArray(this.app.player?.hashes) ? this.app.player.hashes.slice(0, 32) : [],
                components: Array.isArray(this.app.runtimeCharacterProfile?.components)
                    ? this.app.runtimeCharacterProfile.components.slice(0, 32).map((item) => `${item.componentId}:${item.drawable}:${item.texture}`) : [],
        };
        return state;
    }

    update() {
        if (this.status === 'offline' && !this.socket && this.app?.ped) this.connect();
        if (this.status !== 'online' || this.socket?.readyState !== WebSocket.OPEN) return;
        const now = performance.now();
        const renderTime = now - INTERPOLATION_DELAY_MS;
        let peersChanged = false;
        for (const peer of Array.from(this.peers.values())) {
            if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
                this.peers.delete(peer.id);
                peersChanged = true;
                continue;
            }
            peer.render = this._interpolatePeer(peer, renderTime);
        }
        if (peersChanged) this.app?._syncMultiplayerHud?.();
        this.app?.audioSystem?.update?.(this.getRemotePlayers());
        this._updatePickups();
        this._sendPendingGameplayActions();
        if (now - this._lastSendMs >= SEND_INTERVAL_MS) {
            const state = this._captureLocalState();
            if (state) this.socket.send(JSON.stringify({ type: 'state', state }));
            this._lastSendMs = now;
        }
    }

    _updatePickups() {
        const ped = this.app?.ped?.posData;
        const eye = Number(this.app?.pedEyeHeightData) || 0;
        this.nearbyPickup = null;
        if (ped) {
            let bestDistance = 2.25;
            for (const pickup of this.pickups) {
                if (!pickup.available) continue;
                const distance = Math.hypot((Number(pickup.x) || 0) - ped[0], (Number(pickup.y) || 0) - ped[1], (Number(pickup.feetZ) || 0) - (ped[2] - eye));
                if (distance >= bestDistance) continue;
                bestDistance = distance;
                this.nearbyPickup = pickup;
            }
        }
        const useDown = !!this.app?.keyState?.e;
        if (this.nearbyPickup && useDown && !this._pickupUseDown) {
            this.sendGameplayAction({
                kind: 'collect_pickup',
                eventId: `${this.sessionId}:pickup:${this.nearbyPickup.id}:${Date.now()}`,
                pickupId: this.nearbyPickup.id,
            });
        }
        this._pickupUseDown = useDown;
    }

    _sendPendingGameplayActions() {
        const weapon = this.app?.weaponController?.getStatus?.();
        if (weapon && weapon.actionSerial !== this._lastWeaponActionSerial) {
            this._lastWeaponActionSerial = weapon.actionSerial;
            if (weapon.lastAction === 'fire') {
                const shot = weapon.lastShot?.network || {};
                this.sendGameplayAction({
                    kind: 'shoot',
                    eventId: `${this.sessionId}:weapon:${weapon.actionSerial}`,
                    origin: shot.origin,
                    direction: shot.direction || weapon.lastShot?.muzzle?.direction || [0, 1, 0],
                    maxDistance: shot.maxDistance,
                    npcId: shot.npcId,
                    zone: shot.zone,
                    impactPoint: shot.impactPoint,
                });
            }
        }
        const melee = this.app?.meleeController?.getStatus?.();
        if (melee && melee.actionSerial !== this._lastMeleeActionSerial) {
            this._lastMeleeActionSerial = melee.actionSerial;
            this.sendGameplayAction({
                kind: 'melee',
                eventId: `${this.sessionId}:melee:${melee.actionSerial}`,
                attackType: melee.lastAttack?.type || 'right_punch',
            });
        }
        const appearance = {
            modelName: String(this.app?.runtimeCharacterProfile?.modelName || 'mp_m_freemode_01'),
            hashes: Array.isArray(this.app?.player?.hashes) ? this.app.player.hashes.slice(0, 32) : [],
            components: Array.isArray(this.app?.runtimeCharacterProfile?.components)
                ? this.app.runtimeCharacterProfile.components.slice(0, 32).map((item) => `${item.componentId}:${item.drawable}:${item.texture}`) : [],
        };
        const key = JSON.stringify(appearance);
        if (key !== this._lastAppearanceKey) {
            this._lastAppearanceKey = key;
            this.sendGameplayAction({ kind: 'appearance', eventId: `${this.sessionId}:appearance:${Date.now()}`, appearance });
        }
    }

    getRemotePlayers() {
        return Array.from(this.peers.values()).map((peer) => ({ ...peer.render, id: peer.id, name: peer.name }));
    }

    destroy() {
        this._destroyed = true;
        clearTimeout(this._retryTimer);
        clearTimeout(this._connectTimer);
        this.socket?.close(1000, 'leaving');
        this.socket = null;
        this.peers.clear();
        this.app?.audioSystem?.resetPeers?.();
        try { this._sessionChannel?.close?.(); } catch { /* ignore */ }
        this._sessionChannel = null;
    }
}

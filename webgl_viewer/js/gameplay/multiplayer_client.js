const SEND_INTERVAL_MS = 66;
const INTERPOLATION_DELAY_MS = 100;
const CONNECT_TIMEOUT_MS = 8_000;
const PEER_TIMEOUT_MS = 15_000;

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

function stableSessionId() {
    const key = 'webglgta.multiplayer.session.v1';
    try {
        const existing = sessionStorage.getItem(key);
        if (existing) return existing;
        const value = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
        sessionStorage.setItem(key, value);
        return value;
    } catch {
        return `${Date.now()}-${Math.random()}`;
    }
}

export class MultiplayerClient {
    constructor(app) {
        this.app = app;
        const params = new URLSearchParams(window.location.search);
        this.room = 'demo';
        this.name = String(params.get('name') || randomPlayerName()).slice(0, 24);
        this.sessionId = stableSessionId();
        try { this.resumeToken = localStorage.getItem('webglgta.multiplayer.resume.v1') || ''; } catch { this.resumeToken = ''; }
        this._sessionNonce = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
        this._sessionChannel = null;
        this.id = '';
        this.status = 'offline';
        this.socket = null;
        this.peers = new Map();
        this.profile = null;
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
        if (message.type !== 'active' || message.target !== this._sessionNonce || this.status !== 'offline') return;
        this.sessionId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
        try { sessionStorage.setItem('webglgta.multiplayer.session.v1', this.sessionId); } catch { /* ignore */ }
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
            clearTimeout(this._connectTimer);
            this.status = 'online';
            this._retryMs = 750;
            socket.send(JSON.stringify({ type: 'join', room: this.room, name: this.name, sessionId: this.sessionId, resumeToken: this.resumeToken, state: this._captureLocalState() }));
            this.app?._syncMultiplayerHud?.();
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

    _onMessage(raw) {
        let message;
        try { message = JSON.parse(raw); } catch { return; }
        if (message.type === 'welcome') {
            this.id = String(message.id || '');
            this.resumeToken = String(message.resumeToken || this.resumeToken || '');
            try { if (this.resumeToken) localStorage.setItem('webglgta.multiplayer.resume.v1', this.resumeToken); } catch { /* ignore */ }
            this.room = String(message.room || this.room);
            this.peers.clear();
            this._applyProfile(message.profile, message.state);
            this.app?.npcSystem?.applyNetworkSnapshot?.(message.world || []);
            this.pickups = Array.isArray(message.pickups) ? message.pickups : [];
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
        } else if (message.type === 'player_state') {
            this._applyProfile(message.profile, message.state, !!message.respawn);
        } else if (message.type === 'state_correction') {
            this._applyStateCorrection(message.state);
        } else if (message.type === 'gameplay_event') {
            this._handleGameplayEvent(message);
        } else if (message.type === 'world_state') {
            this.app?.npcSystem?.applyNetworkSnapshot?.(message.npcs || []);
            this.pickups = Array.isArray(message.pickups) ? message.pickups : this.pickups;
            const mine = (message.wanted || []).find((entry) => entry.id === this.id);
            if (this.app?.npcSystem) this.app.npcSystem.wantedLevel = Number(mine?.level) || 0;
        } else if (message.type === 'error') {
            this.status = String(message.code || 'error');
        }
        this.app?._syncMultiplayerHud?.();
    }

    _applyProfile(profile, state = null, respawn = false) {
        if (profile && typeof profile === 'object') this.profile = profile;
        const health = Number(profile?.health ?? state?.health);
        const armor = Number(profile?.armor ?? state?.armor);
        if (Number.isFinite(health)) this.app?.meleeController?.applyAuthoritativeState?.({ health, armor, dead: health <= 0, respawn });
        if (profile?.inventory) this.app?.weaponController?.applyAuthoritativeInventory?.(profile.inventory);
        if (respawn) return;
        const position = profile?.position;
        if (Array.isArray(position) && position.length >= 3 && this.app?.ped) {
            const eye = Number(this.app.pedEyeHeightData) || 1.2;
            this.app.spawnPedAt?.([Number(position[0]), Number(position[1]), Number(position[2]) + eye], { groundSource: 'server_profile' });
        }
    }

    _applyStateCorrection(state) {
        if (!state || !this.app?.ped) return;
        const eye = Number(this.app.pedEyeHeightData) || 1.2;
        this.app.spawnPedAt?.([Number(state.x) || 0, Number(state.y) || 0, (Number(state.feetZ) || 0) + eye], { groundSource: 'server_correction' });
    }

    _handleGameplayEvent(message) {
        this.lastGameplayEvent = message;
        if (message.profile) this._applyProfile(message.profile, message.state);
        if (message.id && message.id !== this.id) this.app?.audioSystem?.handleRemoteGameplayEvent?.(message);
        if (message.id && message.state) this._upsertPeer(message.id, null, message.state, true);
    }

    sendGameplayAction(action) {
        if (!action || this.socket?.readyState !== WebSocket.OPEN || this.status !== 'online') return false;
        this.socket.send(JSON.stringify({ type: 'action', action }));
        return true;
    }

    _upsertPeer(idValue, name, state, immediate) {
        const id = String(idValue || '');
        if (!id || id === this.id || !state) return;
        const now = performance.now();
        let peer = this.peers.get(id);
        if (!peer) {
            peer = { id, name: String(name || 'Player'), previous: state, target: state, render: { ...state }, previousAt: now, targetAt: now, lastSeen: now };
            this.peers.set(id, peer);
        } else {
            if (name) peer.name = String(name);
            peer.previous = immediate ? state : { ...peer.render };
            peer.previousAt = immediate ? now - SEND_INTERVAL_MS : peer.targetAt;
            peer.target = state;
            peer.targetAt = now;
            peer.lastSeen = now;
        }
    }

    _captureLocalState() {
        const ped = this.app?.ped?.posData;
        if (!ped) return null;
        const player = this.app.player || {};
        const vehicle = this.app.vehicleController?.getRenderState?.();
        const voice = this.app.audioSystem?.getNetworkState?.() || {};
        return {
            x: Number(ped[0]) || 0,
            y: Number(ped[1]) || 0,
            feetZ: (Number(ped[2]) || 0) - (Number(this.app.pedEyeHeightData) || 0),
            heading: Number(player.headingRad) || 0,
            phase: Number(player.animPhase) || 0,
            move01: Number(player.animMove01) || 0,
            gait: String(player.animGait || 'idle'),
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
            appearance: {
                modelName: String(this.app.runtimeCharacterProfile?.modelName || this.app.player?.modelName || 'mp_m_freemode_01'),
                hashes: Array.isArray(this.app.player?.hashes) ? this.app.player.hashes.slice(0, 32) : [],
                components: Array.isArray(this.app.runtimeCharacterProfile?.components)
                    ? this.app.runtimeCharacterProfile.components.slice(0, 32).map((item) => `${item.componentId}:${item.drawable}:${item.texture}`) : [],
            },
            ...voice,
        };
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
            const span = Math.max(1, peer.targetAt - peer.previousAt);
            const t = Math.max(0, Math.min(1, (renderTime - peer.previousAt) / span));
            const a = peer.previous;
            const b = peer.target;
            peer.render = {
                ...b,
                x: lerp(Number(a.x) || 0, Number(b.x) || 0, t),
                y: lerp(Number(a.y) || 0, Number(b.y) || 0, t),
                feetZ: lerp(Number(a.feetZ) || 0, Number(b.feetZ) || 0, t),
                heading: lerpAngle(Number(a.heading) || 0, Number(b.heading) || 0, t),
                phase: lerp(Number(a.phase) || 0, Number(b.phase) || 0, t),
                move01: lerp(Number(a.move01) || 0, Number(b.move01) || 0, t),
            };
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
                this.sendGameplayAction({
                    kind: 'shoot',
                    eventId: `${this.sessionId}:weapon:${weapon.actionSerial}`,
                    direction: weapon.lastShot?.muzzle?.direction || [0, 1, 0],
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

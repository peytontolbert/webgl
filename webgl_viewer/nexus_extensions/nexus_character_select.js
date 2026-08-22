const app = () => window.__viewerApp;
const mp = () => app()?.multiplayer;
const dispatch = (type, detail = {}) => window.dispatchEvent(new CustomEvent(type, { detail }));

const createAccountId = () => {
    const webCrypto = globalThis.crypto;
    if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (typeof webCrypto?.getRandomValues === 'function') webCrypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const installGate = () => {
    const client = mp();
    if (!client || client.__nxPreWorldGate) return false;
    client.__nxPreWorldGate = true;
    client.characterSlots = [];
    client.characterSelected = false;
    client.characterActivationPending = false;
    client.characterAccount = localStorage.getItem('nexus.demo.character.account.v1') || createAccountId();
    localStorage.setItem('nexus.demo.character.account.v1', client.characterAccount);

    const baseConnect = client.connect.bind(client);
    const priorMessage = client._onMessage.bind(client);
    const priorDisconnect = client._onDisconnect.bind(client);
    const priorApplyProfile = client._applyProfile.bind(client);
    const gateEpoch = (Number(client.__nxCharacterGateEpoch) || 0) + 1;
    client.__nxCharacterGateEpoch = gateEpoch;

    // The main client can open its normal join socket during the frame in
    // which it creates the temporary boot ped. Detach that socket before
    // closing it so its close handler cannot schedule a second lifecycle.
    const staleSocket = client.socket;
    clearTimeout(client._connectTimer);
    clearTimeout(client._retryTimer);
    client._connectTimer = 0;
    client._retryTimer = 0;
    if (staleSocket) {
        client.socket = null;
        try { staleSocket.close(4000, 'character selection gate'); } catch { /* ignore */ }
    }

    // Start/stop YCD clips remain visual transitions only. Their sampled root
    // translation is not reliable in the exported runtime data and could zero
    // physical walking speed even while W/A/S/D was held.
    const installStableLocomotion = (viewer) => {
        const controller = viewer?.playerController;
        if (!controller || controller.__nxStableLocomotionInstalled) return;
        controller.__nxStableLocomotionInstalled = true;
        controller._nativeTransitionSpeed = () => NaN;
    };
    installStableLocomotion(client.app);

    const stabilizeInitialGameplayCamera = (rig = null) => {
        const viewer = client.app;
        if (!viewer?.ped) return;
        viewer.followPed = true;
        viewer.controlPed = true;
        viewer._followPedYSmoothed = null;
        try { viewer._setGtaThirdPersonRigForPed?.(rig || viewer._getSpawnDistrictCameraRig?.()); } catch { /* ignore */ }
        try { viewer._initGameplayCameraFromCurrentPose?.(); } catch { /* ignore */ }
    };

    const isWithinBounds = (x, y, bounds) => {
        const minX = Number(bounds?.minX);
        const minY = Number(bounds?.minY);
        const maxX = Number(bounds?.maxX);
        const maxY = Number(bounds?.maxY);
        return [x, y, minX, minY, maxX, maxY].every(Number.isFinite)
            && x >= minX && x <= maxX && y >= minY && y <= maxY;
    };

    // Network transforms are persisted as feet positions, but a city export
    // can be rebuilt with a slightly different collision surface. Resolve the
    // contact before the first rendered frame instead of letting the movement
    // loop visibly correct an airborne ped on its first update.
    const spawnAtResolvedGround = (viewer, x, y, feetZ, groundSource) => {
        const eye = Number(viewer?.pedEyeHeightData) || 1.2;
        const ground = viewer?.collisionWorld?.resolveGround?.(x, y, feetZ + 2.0, {
            preferInterior: false,
            maxSnapDistance: 12.0,
        }) || null;
        const resolvedZ = Number(ground?.z);
        const spawnFeetZ = Number.isFinite(resolvedZ) ? resolvedZ : feetZ;
        viewer?.spawnPedAt?.([x, y, spawnFeetZ + eye], { groundSource });
        if (viewer?.playerController) viewer.playerController._lastGroundContact = null;
        return { ground, feetZ: spawnFeetZ };
    };

    const activateTrackSpawn = (viewer, x, y, z, groundSource) => {
        const ground = viewer?.collisionWorld?.resolveGround?.(x, y, z + 2.0, {
            preferInterior: false,
            maxSnapDistance: 8.0,
        }) || null;
        if (ground?.source !== 'track' || !Number.isFinite(Number(ground.z))) return false;
        if (!viewer?._setNurburgringActive?.(true)) return false;
        const eye = Number(viewer.pedEyeHeightData) || 1.2;
        viewer.spawnPedAt?.([x, y, Number(ground.z) + eye], { groundSource });
        if (viewer.playerController) viewer.playerController._lastGroundContact = null;
        viewer._setGtaThirdPersonRigForPed?.({ distanceData: 7.5, heightData: 2.0, sideData: 0.7 });
        return true;
    };

    const restoreSavedTrackSpawn = (viewer, x, y, z) => {
        const trackBounds = viewer?.collisionWorld?.getDerivedRoadBounds?.();
        if (isWithinBounds(x, y, trackBounds)) {
            return activateTrackSpawn(viewer, x, y, z, 'saved_track_profile');
        }
        // Track packages can be rebuilt with a slightly tighter contact AABB.
        // A persisted point just outside the new edge is still recognizably a
        // track save, but resolving it literally leaves the ped below/away from
        // the circuit. Recover those near-edge saves at the authored road spawn.
        const margin = 64.0;
        const nearTrack = trackBounds
            && x >= Number(trackBounds.minX) - margin
            && x <= Number(trackBounds.maxX) + margin
            && y >= Number(trackBounds.minY) - margin
            && y <= Number(trackBounds.maxY) + margin;
        const recovery = nearTrack ? viewer?.collisionWorld?.getDerivedRoadSpawn?.() : null;
        if (!Array.isArray(recovery) || recovery.length < 3) return false;
        return activateTrackSpawn(
            viewer,
            Number(recovery[0]),
            Number(recovery[1]),
            Number(recovery[2]),
            'saved_track_recovery',
        );
    };

    // The activation welcome's state is the single authority for the initial
    // transform. A profile position is persistence data and can be stale after
    // a map switch, which previously caused a second competing spawn.
    client._applyProfile = (profile, state = null, respawn = false, syncPosition = false) => {
        const initialActivation = !client.characterSelected && !client.__nxInitialCharacterSpawnApplied;
        let stableProfile = profile;
        if (profile && typeof profile === 'object' && Object.prototype.hasOwnProperty.call(profile, 'position')) {
            stableProfile = { ...profile };
            delete stableProfile.position;
        }
        // Pass a position-free profile to both source and deployed bundles.
        // The deployed thin bundle predates syncPosition, so explicit spawning
        // below is the only cross-version-safe authority path.
        const result = priorApplyProfile(stableProfile, state, respawn, false);
        if (initialActivation) {
            client.__nxInitialCharacterSpawnApplied = true;
            const viewer = client.app;
            const x = Number(state?.x);
            const y = Number(state?.y);
            const z = Number(state?.feetZ);
            if ([x, y, z].every(Number.isFinite)) {
                const outsideCity = viewer?.spawnDistrictBounds
                    && !isWithinBounds(x, y, viewer.spawnDistrictBounds);
                const restoredTrack = outsideCity && restoreSavedTrackSpawn(viewer, x, y, z);
                if (!restoredTrack) {
                    spawnAtResolvedGround(viewer, x, y, z, 'server_welcome');
                    stabilizeInitialGameplayCamera();
                }
            } else {
                const saved = Array.isArray(profile?.position) ? profile.position : [];
                const savedX = Number(saved[0]);
                const savedY = Number(saved[1]);
                const savedZ = Number(saved[2]);
                const savedOutsideCity = viewer?.spawnDistrictBounds
                    && [savedX, savedY, savedZ].every(Number.isFinite)
                    && !isWithinBounds(savedX, savedY, viewer.spawnDistrictBounds);
                const restoredTrack = savedOutsideCity
                    && restoreSavedTrackSpawn(viewer, savedX, savedY, savedZ);
                if (!restoredTrack) {
                    console.warn('[character] Activation welcome omitted a valid transform; recovering at Legion.');
                    viewer?.returnToLegionSquare?.();
                    stabilizeInitialGameplayCamera();
                }
            }
        } else if (respawn && state && client.app?.ped) {
            const x = Number(state.x);
            const y = Number(state.y);
            const z = Number(state.feetZ);
            if ([x, y, z].every(Number.isFinite)) {
                spawnAtResolvedGround(client.app, x, y, z, 'server_respawn');
                stabilizeInitialGameplayCamera();
            }
        }
        return result;
    };
    client._onMessage = (raw) => {
        let message;
        try { message = JSON.parse(raw); } catch { return; }
        if (message?.type === 'character_slots') {
            client.characterSlots = Array.isArray(message.slots) ? message.slots : [];
            if (client.characterActivationPending && message.error) {
                client.characterActivationPending = false;
                client.status = 'selecting';
                dispatch('nexus-character-activation-failed', { error: String(message.error) });
            }
            dispatch('nexus-character-slots', { slots: client.characterSlots, error: message.error || '' });
            client.app?._syncMultiplayerHud?.();
            return;
        }

        // A pre-selector base socket can have a welcome packet in flight as it
        // is closed. It has no selected character and must never bootstrap the
        // world behind the selector.
        if (message?.type === 'welcome' && !client.characterSelected && !client.characterActivationPending) return;

        // The original handler validates and applies the server's welcome
        // snapshot before the character gate announces a usable world.
        priorMessage(raw);
        if (message?.type === 'welcome' && client.id && client.status === 'online') {
            if (!client.characterSelected) {
                client.characterSelected = true;
                client.characterActivationPending = false;
                dispatch('nexus-character-ready', { id: client.id, room: client.room });
            }
        } else if (message?.type === 'error' && client.characterActivationPending) {
            client.characterActivationPending = false;
            client.status = 'selecting';
            dispatch('nexus-character-activation-failed', { error: String(message.code || 'Character activation failed') });
        }
        client.app?._syncMultiplayerHud?.();
    };

    client._onDisconnect = (socket, event) => {
        if (socket !== client.socket) return;
        if (client.characterSelected) {
            priorDisconnect(socket, event);
            return;
        }

        const activationInterrupted = client.characterActivationPending;
        clearTimeout(client._connectTimer);
        client._connectTimer = 0;
        client.socket = null;
        client.id = '';
        client.status = 'selecting';
        if (activationInterrupted) {
            client.characterActivationPending = false;
            dispatch('nexus-character-activation-failed', { error: 'Character activation interrupted' });
        }
        if (!client._destroyed && Number(event?.code) !== 4004) {
            clearTimeout(client._retryTimer);
            client._retryTimer = setTimeout(() => client.connect(), client._retryMs);
            client._retryMs = Math.min(8_000, client._retryMs * 1.7);
        }
        client.app?._syncMultiplayerHud?.();
    };

    client.connect = function connectCharacterGate() {
        if (this._destroyed || this.socket || !this.app?.spawnDistrictDemo) return;
        // A selected character reconnects through the normal resume-token
        // path. Re-running bootstrap here used to reopen the selector after a
        // transport retry and left the loading layer orphaned.
        if (this.characterSelected && this.resumeToken) return baseConnect();

        this.status = 'connecting';
        this.app?._syncMultiplayerHud?.();
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(`${protocol}//${location.host}/__multiplayer`);
        this.socket = socket;
        clearTimeout(this._connectTimer);
        this._connectTimer = setTimeout(() => socket.close(4000, 'connect timeout'), 8000);
        socket.addEventListener('open', () => {
            if (this.socket !== socket || this.__nxCharacterGateEpoch !== gateEpoch || this.characterSelected) {
                socket.close(4000, 'stale character socket');
                return;
            }
            clearTimeout(this._connectTimer);
            this.status = 'selecting';
            this._retryMs = 750;
            try { socket.send(JSON.stringify({ type: 'character_bootstrap', accountId: this.characterAccount })); }
            catch { socket.close(); }
            this.app?._syncMultiplayerHud?.();
        });
        socket.addEventListener('message', (event) => {
            if (this.socket === socket && this.__nxCharacterGateEpoch === gateEpoch) this._onMessage(event.data);
        });
        socket.addEventListener('close', (event) => this._onDisconnect(socket, event));
        socket.addEventListener('error', () => socket.close());
    };

    client.createCharacter = (name) => {
        if (client.socket?.readyState !== WebSocket.OPEN || client.status !== 'selecting') return false;
        client.socket.send(JSON.stringify({ type: 'character_create', name }));
        return true;
    };
    client.deleteCharacter = (token) => {
        if (client.socket?.readyState !== WebSocket.OPEN || client.status !== 'selecting') return false;
        client.socket.send(JSON.stringify({ type: 'character_delete', accountId: client.characterAccount, token }));
        return true;
    };
    client.activateCharacter = (token) => {
        if (client.socket?.readyState !== WebSocket.OPEN || client.status !== 'selecting') return false;
        client.characterActivationPending = true;
        client.status = 'activating';
        dispatch('nexus-character-activating', { token });
        try {
            client.socket.send(JSON.stringify({
                type: 'character_activate',
                token,
                sessionId: client.sessionId,
                state: client._captureLocalState({ includeAppearance: true }),
            }));
        } catch {
            client.characterActivationPending = false;
            client.status = 'selecting';
            dispatch('nexus-character-activation-failed', { error: 'Unable to activate character' });
            return false;
        }
        client.app?._syncMultiplayerHud?.();
        return true;
    };

    const connectWhenReady = () => {
        if (client._destroyed || client.socket) return;
        if (client.app?.spawnDistrictDemo) client.connect();
        else requestAnimationFrame(connectWhenReady);
    };
    requestAnimationFrame(connectWhenReady);
    return true;
};

const gateLoop = () => {
    if (!installGate()) requestAnimationFrame(gateLoop);
};
requestAnimationFrame(gateLoop);

// Kept as a read-only console probe so a reported input issue has an exact
// state instead of relying on a hidden capture-phase keyboard gate.
window.__nxGameplayDiagnostics = () => {
    const viewer = app();
    const client = mp();
    const controller = viewer?.playerController;
    let movementBlock = '';
    if (!client?.characterSelected) movementBlock = 'character_not_selected';
    else if (viewer?.settingsMenuOpen) movementBlock = 'settings_menu';
    else if (viewer?.vehicleController?.inVehicle) movementBlock = 'in_vehicle';
    else if (viewer?.meleeController?.lifeState && viewer.meleeController.lifeState !== 'alive') movementBlock = `life_${viewer.meleeController.lifeState}`;
    else if (viewer?.player?.handsUp) movementBlock = 'hands_up';
    else if (viewer?.phoneController?.active) movementBlock = 'phone_open';
    return {
        online: client?.status === 'online',
        characterSelected: !!client?.characterSelected,
        activationPending: !!client?.characterActivationPending,
        controlPed: !!viewer?.controlPed,
        followPed: !!viewer?.followPed,
        movementBlock: movementBlock || null,
        keyState: { ...(viewer?.keyState || {}) },
        lastGrounding: viewer?._pedGroundingDebug || null,
        lastBoundaryRecovery: viewer?._demoBoundsRecovery || null,
        controllerReady: !!controller,
        stableLocomotion: !!controller?.__nxStableLocomotionInstalled,
        locomotionTransition: viewer?.player?._locomotionTransition || null,
        forwardSpeed: Number(controller?._forwardSpeed) || 0,
    };
};

const clean = (value) => String(value || '').replace(/[<>&]/g, '').trim().slice(0, 24);
let slots = [];
let ready = false;
let lastState = '';
const style = document.createElement('style');
style.textContent = '#nxCharacters{position:fixed;inset:0;z-index:2000;display:grid;place-items:center;background:#05090cff;color:#edf4f7;font:13px Arial}#nxCharacters[hidden]{display:none}.nxChPanel{width:min(680px,calc(100vw - 28px));max-height:calc(100vh - 28px);overflow:auto;border:1px solid #536a76;background:#101820;box-shadow:0 18px 54px #000b}.nxChHead{padding:16px;border-bottom:1px solid #394d57}.nxChHead h1{margin:0;font-size:18px}.nxChHead p{margin:5px 0 0;color:#a8bac2;font-size:11px}.nxChBody{padding:16px}.nxChList{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.nxChCard{padding:12px;border:1px solid #364a54;background:#0d161b}.nxChCard b{display:block;font-size:14px}.nxChCard span{display:block;margin-top:3px;color:#a8bac2;font-size:11px}.nxChActions,.nxChCreate{display:flex;gap:7px;margin-top:11px}.nxChActions button,.nxChCreate button{border:1px solid #526975;background:#1b2b33;color:#edf4f7;padding:8px 10px;font-size:11px;cursor:pointer}.nxChDelete{margin-left:auto;background:#321d20!important;border-color:#85444c!important}.nxChCreate input{min-width:0;flex:1;padding:8px;border:1px solid #526975;background:#0a1115;color:#fff}.nxChEmpty{padding:20px 0;color:#a8bac2;text-align:center}@media(max-width:600px){.nxChList{grid-template-columns:1fr}}';
document.head.append(style);

const view = document.createElement('section');
view.id = 'nxCharacters';
view.innerHTML = '<div class="nxChPanel"><div class="nxChHead"><h1>Select Character</h1><p>Choose a saved character or create a new one.</p></div><div class="nxChBody"></div></div>';
document.body.append(view);
const body = view.querySelector('.nxChBody');

const render = () => {
    const client = mp();
    const selectable = client?.status === 'selecting' && !client.characterActivationPending;
    const waiting = client?.status === 'activating' || client?.characterActivationPending;
    const list = slots.length
        ? `<div class="nxChList">${slots.map((character) => `<article class="nxChCard"><b>${clean(character.name)}</b><span>Last played ${character.lastPlayedAt ? new Date(character.lastPlayedAt).toLocaleDateString() : 'Never'}</span><div class="nxChActions"><button type="button" data-select="${character.token}" ${selectable ? '' : 'disabled'}>Play</button><button type="button" class="nxChDelete" data-delete="${character.token}" ${selectable ? '' : 'disabled'}>Delete</button></div></article>`).join('')}</div>`
        : `<div class="nxChEmpty">${waiting ? 'Entering Los Santos...' : (selectable ? 'No saved characters. Create your first character below.' : 'Connecting to character service...')}</div>`;
    body.innerHTML = `${list}<form class="nxChCreate"><input maxlength="24" name="name" placeholder="Character name" aria-label="Character name" ${selectable ? '' : 'disabled'}><button type="submit" ${selectable ? '' : 'disabled'}>Create</button></form>`;
    for (const item of body.querySelectorAll('[data-select]')) item.onclick = () => client?.activateCharacter?.(item.dataset.select);
    for (const item of body.querySelectorAll('[data-delete]')) item.onclick = () => client?.deleteCharacter?.(item.dataset.delete);
    body.querySelector('form').onsubmit = (event) => {
        event.preventDefault();
        const name = clean(new FormData(event.currentTarget).get('name'));
        if (name) client?.createCharacter?.(name);
    };
};

window.addEventListener('nexus-character-slots', (event) => {
    slots = Array.isArray(event.detail?.slots) ? event.detail.slots : [];
    ready = true;
    lastState = `${mp()?.status || ''}:${mp()?.characterActivationPending ? 'pending' : ''}`;
    render();
});
window.addEventListener('nexus-character-ready', () => {
    view.hidden = true;
});
window.addEventListener('nexus-character-activation-failed', () => render());

setInterval(() => {
    const client = mp();
    if (!client) return;
    if (client.status === 'online' && client.characterSelected) {
        view.hidden = true;
        return;
    }
    view.hidden = false;
    const nextState = `${client.status || ''}:${client.characterActivationPending ? 'pending' : ''}`;
    if (!ready || nextState !== lastState) {
        lastState = nextState;
        render();
    }
}, 300);

window.__nxCharacters = { open: () => { view.hidden = false; render(); }, list: () => slots.slice() };

import { glMatrix } from '../glmatrix.js';

function finite(value, fallback = 0.0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function distance3(position, coords) {
    if (!Array.isArray(position) || position.length < 3 || !coords) return Infinity;
    return Math.hypot(
        finite(position[0]) - finite(coords.x),
        finite(position[1]) - finite(coords.y),
        finite(position[2]) - finite(coords.z),
    );
}

export class DoorController {
    constructor(app) {
        this.app = app;
        this.doors = [];
        this.byId = new Map();
        this.byHash = new Map();
        this.states = new Map();
        this._entryCaches = new WeakMap();
        this._networkTouchAt = new Map();
    }

    setManifest(manifest) {
        this.doors = (Array.isArray(manifest?.doors) ? manifest.doors : []).map((raw) => ({
            ...raw,
            id: String(raw?.id || ''),
            archetypeHash: String(raw?.archetypeHash || ''),
            source: String(raw?.source || ''),
            motion: ['slide', 'lift'].includes(raw?.motion) ? raw.motion : 'swing',
            openAmount: Math.max(0.01, finite(raw?.openAmount, Math.PI * 0.5)),
            openSign: finite(raw?.openSign, 1) < 0 ? -1 : 1,
            radius: Math.max(0.8, finite(raw?.radius, 2.2)),
            automatic: raw?.automatic !== false,
            // The imported FiveM MLO doors do not have their server-side native
            // DoorSystem task in this browser runtime. Treat an unlocked MLO
            // doorway as a local proximity door so it can never remain a wall
            // solely because the player did not press the interaction key.
            proximityOpen: raw?.automatic !== false
                || (/FiveM\s+MLO\s+loose\s+YDR/i.test(String(raw?.source || '')) && raw?.locked !== true),
            locked: raw?.locked === true,
            autoCloseMs: Math.max(250, finite(raw?.autoCloseMs, 1300)),
        })).filter((door) => door.id && door.archetypeHash && door.coords && door.origin);
        this.byId = new Map(this.doors.map((door) => [door.id, door]));
        this.byHash.clear();
        for (const door of this.doors) {
            if (!this.byHash.has(door.archetypeHash)) this.byHash.set(door.archetypeHash, []);
            this.byHash.get(door.archetypeHash).push(door);
            if (!this.states.has(door.id)) {
                this.states.set(door.id, {
                    open: false,
                    target: 0.0,
                    progress: 0.0,
                    updatedAt: 0,
                    lastNearbyAt: 0,
                });
            }
        }
        this.app?.collisionWorld?.setDoorDefinitions?.(this.doors);
    }

    applyNetworkStates(records) {
        for (const record of Array.isArray(records) ? records : []) {
            this.applyNetworkState(record);
        }
    }

    applyNetworkState(record) {
        const id = String(record?.id || record?.doorId || '');
        const state = this.states.get(id);
        if (!state) return false;
        state.open = record?.open === true;
        state.target = state.open ? 1.0 : 0.0;
        state.updatedAt = Math.max(state.updatedAt, finite(record?.updatedAt, Date.now()));
        return true;
    }

    update({ posData, action = null, dt = 1 / 60 } = {}) {
        const now = Date.now();
        const online = this.app?.multiplayer?.status === 'online';
        const actionDoor = action?.type === 'use_door' ? this.byId.get(String(action?.spot?.id || '')) : null;
        if (actionDoor) {
            const state = this.states.get(actionDoor.id);
            if (state && !actionDoor.locked) {
                const open = state.target < 0.5;
                this._setDoorTarget(actionDoor, open, { network: online, automatic: false });
            }
        }

        for (const door of this.doors) {
            const state = this.states.get(door.id);
            if (!state) continue;
            const nearby = distance3(posData, door.coords) <= door.radius;
            if (door.proximityOpen && !door.locked && nearby) {
                state.lastNearbyAt = now;
                if (state.target < 0.5) this._setDoorTarget(door, true, { network: online, automatic: true });
                if (online && now >= (this._networkTouchAt.get(door.id) || 0)) {
                    this._networkTouchAt.set(door.id, now + 750);
                    this._sendDoorAction(door, true, true);
                }
            } else if (door.proximityOpen && state.target > 0.5
                && now - finite(state.lastNearbyAt, 0) >= door.autoCloseMs) {
                this._setDoorTarget(door, false, { network: online, automatic: true });
            }

            const speed = door.motion === 'slide' ? 3.8 : 4.8;
            const amount = Math.max(0.0, Math.min(1.0, finite(dt, 1 / 60) * speed));
            state.progress += (state.target - state.progress) * amount;
            if (Math.abs(state.progress - state.target) < 0.001) state.progress = state.target;
            this.app?.collisionWorld?.setDoorOpenProgress?.(door.id, state.progress);
        }
        this.app?.drawableStreamer?.syncMloPortalDoors?.(this.doors, this.states);
        this._applyAnimatedMatrices();
    }

    getDoorState(id) {
        return this.states.get(String(id || '')) || null;
    }

    _setDoorTarget(door, open, { network = false, automatic = false } = {}) {
        const state = this.states.get(door.id);
        if (!state) return;
        state.open = !!open;
        state.target = state.open ? 1.0 : 0.0;
        state.updatedAt = Date.now();
        if (network) this._sendDoorAction(door, state.open, automatic);
    }

    _sendDoorAction(door, open, automatic) {
        this.app?.multiplayer?.sendGameplayAction?.({
            kind: 'door_toggle',
            eventId: `door:${door.id}:${Date.now()}`,
            doorId: door.id,
            open: !!open,
            automatic: !!automatic,
        });
    }

    _applyAnimatedMatrices() {
        const renderer = this.app?.instancedModelRenderer;
        if (!renderer?.ready || !renderer.instances?.size) return;
        for (const [hash, doors] of this.byHash) {
            for (const [key, entry] of renderer.instances) {
                if (!key.startsWith(`${hash}:`) || !(entry?.instanceData instanceof Float32Array)) continue;
                const stride = Math.max(16, Math.floor(finite(entry.instanceStrideFloats, 16)));
                let cache = this._entryCaches.get(entry);
                if (!cache || cache.base.length !== entry.instanceData.length || cache.stride !== stride) {
                    cache = { base: new Float32Array(entry.instanceData), stride, indices: new Map(), lastKey: '' };
                    for (const door of doors) {
                        let bestOffset = -1;
                        let bestDistance = 0.12;
                        for (let offset = 0; offset + 15 < cache.base.length; offset += stride) {
                            const d = Math.hypot(
                                cache.base[offset + 12] - finite(door.origin.x),
                                cache.base[offset + 13] - finite(door.origin.y),
                                cache.base[offset + 14] - finite(door.origin.z),
                            );
                            if (d < bestDistance) { bestDistance = d; bestOffset = offset; }
                        }
                        if (bestOffset >= 0) cache.indices.set(door.id, bestOffset);
                    }
                    this._entryCaches.set(entry, cache);
                }
                const progressKey = doors.map((door) => finite(this.states.get(door.id)?.progress).toFixed(3)).join('|');
                if (progressKey === cache.lastKey) continue;
                const output = new Float32Array(cache.base);
                for (const door of doors) {
                    const offset = cache.indices.get(door.id);
                    const progress = finite(this.states.get(door.id)?.progress);
                    if (offset === undefined || progress <= 0.0001) continue;
                    const matrix = output.subarray(offset, offset + 16);
                    if (door.motion === 'slide') {
                        glMatrix.mat4.translate(matrix, matrix, [door.openSign * door.openAmount * progress, 0, 0]);
                    } else if (door.motion === 'lift') {
                        glMatrix.mat4.rotateY(matrix, matrix, door.openSign * door.openAmount * progress);
                    } else {
                        glMatrix.mat4.rotateZ(matrix, matrix, door.openSign * door.openAmount * progress);
                    }
                }
                cache.lastKey = progressKey;
                renderer.updateInstanceMatricesForArchetype(entry.hash, entry.lod, output, entry.minDist, { skipInstanceBounds: true });
            }
        }
    }
}

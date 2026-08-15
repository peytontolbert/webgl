function finite(n, fallback = 0.0) {
    const v = Number(n);
    return Number.isFinite(v) ? v : fallback;
}

function gtaHeadingToDataRad(degrees) {
    return (Math.PI * 0.5) + finite(degrees) * (Math.PI / 180.0);
}

// Sultan seat_dside_f from the vehicle YFT skeleton. Coordinates are relative
// to the vehicle drawable root, whose local forward axis is +Y.
const SULTAN_DRIVER_SEAT_LOCAL = Object.freeze([-0.367056, -0.027149, 0.074445]);

export class VehicleController {
    constructor(app) {
        this.app = app;
        this.manifest = null;
        this.inVehicle = false;
        this.vehicle = null;
        this.lastEvent = '';
        this.enterDistance = 3.2;
        // Sultan's baked wheel contact plane is 0.3995 m below its model origin.
        this.groundOffset = 0.4;
        this._wasExitDown = false;
        this._lastDamageAt = 0;
    }

    setManifest(manifest) {
        this.manifest = manifest && typeof manifest === 'object' ? manifest : null;
        if (this.app?.spawnDistrictDemo && !this.vehicle) this.spawnDemoVehicle();
    }

    spawnDemoVehicle() {
        const spawn = this._chooseDemoGarageSpawn();
        return this.spawnVehicle({
            model: 'sultan',
            hash: '970598228',
            name: 'Karin Sultan',
            coords: spawn.coords,
            source: spawn.source,
        });
    }

    spawnVehicle({ model = 'sultan', hash = '970598228', name = 'Karin Sultan', coords = null, source = '' } = {}) {
        const c = coords || { x: 221.54, y: -806.78, z: 30.67, w: 69.92 };
        const x = finite(c.x, 221.54);
        const y = finite(c.y, -806.78);
        const requestedZ = finite(c.z, 30.67);
        const ground = this._resolveGround(x, y, requestedZ);
        const groundZ = Number.isFinite(Number(ground?.z)) ? Number(ground.z) : requestedZ;
        this.inVehicle = false;
        this.vehicle = {
            id: `vehicle_${Date.now().toString(36)}`,
            model: String(model || 'sultan'),
            hash: String(hash || '970598228'),
            name: String(name || model || 'Karin Sultan'),
            source: String(source || ''),
            position: [x, y, groundZ + this.groundOffset],
            headingRad: gtaHeadingToDataRad(c.w),
            speed: 0.0,
            steering: 0.0,
            wheelRotationRad: 0.0,
            groundSource: String(ground?.source || 'server_garage'),
            health: 1000,
            damage: 0,
            destroyed: false,
            suspension: 0,
            bodyRoll: 0,
        };
        this.lastEvent = `spawned ${this.vehicle.name}`;
        return this.vehicle;
    }

    restoreState(saved, occupied = false) {
        const state = saved && typeof saved === 'object' ? saved : null;
        const position = Array.isArray(state?.position) ? state.position.map(Number) : null;
        if (!position || position.length < 3 || !position.slice(0, 3).every(Number.isFinite)) {
            this.spawnDemoVehicle();
            return false;
        }
        const restoredGround = this._resolveGround(
            position[0],
            position[1],
            position[2],
        );
        const restoredZ = Number.isFinite(Number(restoredGround?.z))
            ? Number(restoredGround.z) + this.groundOffset
            : position[2];
        this.vehicle = {
            id: String(state.id || `vehicle_${Date.now().toString(36)}`),
            model: String(state.model || 'sultan'),
            hash: String(state.hash || '970598228'),
            name: String(state.name || 'Karin Sultan'),
            source: String(state.source || 'gameplay_restore'),
            position: [position[0], position[1], restoredZ],
            headingRad: finite(state.headingRad),
            speed: Math.max(-12.0, Math.min(42.0, finite(state.speed))),
            steering: Math.max(-1.0, Math.min(1.0, finite(state.steering))),
            wheelRotationRad: finite(state.wheelRotationRad),
            groundSource: String(state.groundSource || 'gameplay_restore'),
            health: Math.max(0, Math.min(1000, finite(state.health, 1000))),
            damage: Math.max(0, Math.min(1000, finite(state.damage, 0))),
            destroyed: !!state.destroyed,
            suspension: finite(state.suspension),
            bodyRoll: finite(state.bodyRoll),
        };
        this.inVehicle = !!occupied;
        if (this.inVehicle) this._syncOccupantPed();
        this.lastEvent = `restored ${this.vehicle.name}`;
        return true;
    }

    update({ action = null, keyState = null, dt = 1 / 60 } = {}) {
        this.lastEvent = '';
        if (!this.vehicle && this.app?.spawnDistrictDemo) this.spawnDemoVehicle();
        if (!this.vehicle) return;

        const exitDown = !!keyState?.f;
        if (this.inVehicle) {
            if (exitDown && !this._wasExitDown) this.exitVehicle('exited');
            else this._updateDriving(Math.max(0.001, Math.min(0.05, finite(dt, 1 / 60))), keyState || {});
        } else if (exitDown && !this._wasExitDown && this.getDistanceToPlayer() <= this.enterDistance) {
            this.enterVehicle();
        } else if (this._isVehicleAction(action)) {
            const spot = action?.spot || null;
            if (spot?.coords) {
                this.spawnVehicle({ coords: spot.coords, source: spot.source });
                this.enterVehicle();
            }
        }
        this._wasExitDown = exitDown;
    }

    enterVehicle() {
        if (!this.vehicle || this.vehicle.destroyed || this.getDistanceToPlayer() > this.enterDistance + 0.5) return false;
        this.inVehicle = true;
        if (this.app?.player) this.app.player.handsUp = false;
        this.vehicle.speed = 0.0;
        this.lastEvent = `entered ${this.vehicle.name}`;
        this._syncOccupantPed();
        try { this.app?._resetPedMotion?.(); } catch { /* ignore */ }
        try { this.app?._setGtaThirdPersonRigForPed?.({ distanceData: 10.5, heightData: 3.2, sideData: 0.6 }); } catch { /* ignore */ }
        return true;
    }

    exitVehicle(reason = 'exited') {
        if (!this.vehicle) return false;
        const v = this.vehicle;
        const sideX = -Math.sin(v.headingRad);
        const sideY = Math.cos(v.headingRad);
        const x = v.position[0] + sideX * 1.8;
        const y = v.position[1] + sideY * 1.8;
        const ground = this._resolveGround(x, y, v.position[2]);
        const feetZ = Number.isFinite(Number(ground?.z)) ? Number(ground.z) : v.position[2] - this.groundOffset;
        this.inVehicle = false;
        v.speed = 0.0;
        this._placePed(x, y, feetZ);
        this.lastEvent = `${reason} ${v.name}`;
        try { this.app?._setGtaThirdPersonRigForPed?.({ distanceData: 6.0, heightData: 1.7, sideData: 0.6 }); } catch { /* ignore */ }
        return true;
    }

    syncOccupantPed() {
        if (this.inVehicle) this._syncOccupantPed();
    }

    getDistanceToPlayer() {
        const p = this.app?.ped?.posData;
        const v = this.vehicle?.position;
        if (!Array.isArray(p) || !Array.isArray(v)) return Number.POSITIVE_INFINITY;
        return Math.hypot(finite(p[0]) - v[0], finite(p[1]) - v[1], finite(p[2]) - v[2]);
    }

    getPrompt() {
        if (!this.vehicle) return '';
        if (this.inVehicle) return `F  Exit ${this.vehicle.name}`;
        const distance = this.getDistanceToPlayer();
        return distance <= this.enterDistance ? `F  Enter ${this.vehicle.name}` : '';
    }

    getRenderState() {
        if (!this.vehicle) return null;
        return {
            ...this.vehicle,
            position: this.vehicle.position.slice(0, 3),
            occupied: this.inVehicle,
        };
    }

    getDriverSeatTransform() {
        const v = this.vehicle;
        if (!v) return null;
        const local = SULTAN_DRIVER_SEAT_LOCAL;
        const drawableHeading = finite(v.headingRad) - Math.PI * 0.5;
        const cos = Math.cos(drawableHeading);
        const sin = Math.sin(drawableHeading);
        return {
            position: [
                v.position[0] + cos * local[0] - sin * local[1],
                v.position[1] + sin * local[0] + cos * local[1],
                v.position[2] + local[2],
            ],
            headingRad: finite(v.headingRad),
        };
    }

    getStatusLine() {
        if (!this.vehicle) return 'Vehicle: unavailable';
        const speedMph = Math.abs(this.vehicle.speed) * 2.236936;
        if (this.inVehicle) return `Vehicle: ${this.vehicle.name} driving ${speedMph.toFixed(0)} mph`;
        const distance = this.getDistanceToPlayer();
        return `Vehicle: ${this.vehicle.name} parked distance=${Number.isFinite(distance) ? distance.toFixed(1) : 'n/a'}m`;
    }

    _updateDriving(dt, keyState) {
        const v = this.vehicle;
        if (v.destroyed) { v.speed = 0; return; }
        const speedBefore = v.speed;
        const throttle = (keyState.w ? 1 : 0) - (keyState.s ? 1 : 0);
        const steerInput = (keyState.a ? 1 : 0) - (keyState.d ? 1 : 0);
        const handbrake = !!keyState[' '] || !!keyState.space || !!keyState.spacebar;
        const maxForward = 42.0;
        const maxReverse = -12.0;

        if (throttle > 0) {
            v.speed += (v.speed < -0.5 ? 22.0 : 10.5) * dt;
        } else if (throttle < 0) {
            v.speed -= (v.speed > 0.5 ? 24.0 : 8.0) * dt;
        } else {
            const drag = (1.2 + Math.abs(v.speed) * 0.055) * dt;
            v.speed = Math.abs(v.speed) <= drag ? 0.0 : v.speed - Math.sign(v.speed) * drag;
        }
        if (handbrake) v.speed *= Math.exp(-8.0 * dt);
        v.speed = Math.max(maxReverse, Math.min(maxForward, v.speed));
        v.wheelRotationRad = (finite(v.wheelRotationRad) - (v.speed * dt / this.groundOffset)) % (Math.PI * 2.0);

        const steerTarget = steerInput * Math.max(0.25, 1.0 - Math.min(0.72, Math.abs(v.speed) / 58.0));
        const steerA = 1.0 - Math.exp(-8.0 * dt);
        v.steering += (steerTarget - v.steering) * steerA;
        if (Math.abs(v.speed) > 0.05) {
            v.headingRad += v.steering * (v.speed / 2.65) * dt * 0.72;
        }

        const vx = Math.cos(v.headingRad) * v.speed;
        const vy = Math.sin(v.headingRad) * v.speed;
        const move = this.app?.collisionWorld?.moveCapsule?.({
            x: v.position[0],
            y: v.position[1],
            feetZ: v.position[2] - this.groundOffset,
            vx,
            vy,
            dt,
            radius: 1.15,
            maxStepUp: 0.55,
            maxSnapDistance: 4.0,
            applyYbnCalibration: false,
        }) || null;
        if (move?.blocked) {
            const impact = Math.abs(speedBefore);
            v.speed *= -0.12;
            if (impact > 4.0) this.applyDamage(Math.min(180, impact * 7.5), 'world_collision');
        }
        v.position[0] = move ? finite(move.x, v.position[0]) : v.position[0] + vx * dt;
        v.position[1] = move ? finite(move.y, v.position[1]) : v.position[1] + vy * dt;
        const ground = move?.ground || this._resolveGround(v.position[0], v.position[1], v.position[2]);
        if (Number.isFinite(Number(ground?.z))) v.position[2] = Number(ground.z) + this.groundOffset;
        v.groundSource = String(ground?.source || v.groundSource || 'gameplay');
        const suspensionTarget = move?.blocked ? 1 : Math.min(1, Math.abs(v.speed - speedBefore) * 0.24);
        v.suspension += (suspensionTarget - finite(v.suspension)) * (1 - Math.exp(-10 * dt));
        v.bodyRoll += ((-v.steering * Math.min(0.18, Math.abs(v.speed) / 150)) - finite(v.bodyRoll)) * (1 - Math.exp(-7 * dt));
        let impacts = [];
        try {
            impacts = this.app?.npcSystem?.applyVehicleImpacts?.({
                position: v.position,
                heading: v.headingRad,
                speed: v.speed,
                dt,
            }) || [];
        } catch {
            impacts = [];
        }
        if (impacts.length) {
            // Preserve a little momentum but make a collision clearly felt.
            v.speed *= Math.max(0.62, 1.0 - impacts.length * 0.12);
            const lethalCount = impacts.filter((impact) => impact.lethal).length;
            this.lastEvent = lethalCount
                ? `vehicle impact: ${impacts.length} pedestrian${impacts.length === 1 ? '' : 's'}`
                : `vehicle strike: ${impacts.length} pedestrian${impacts.length === 1 ? '' : 's'}`;
            this.applyDamage(impacts.length * 12, 'pedestrian_impact');
        }
        this._syncOccupantPed();
    }

    applyDamage(amount, source = 'impact') {
        const v = this.vehicle;
        if (!v || v.destroyed) return false;
        const applied = Math.max(0, Math.min(250, finite(amount)));
        if (applied <= 0) return false;
        v.damage = Math.min(1000, finite(v.damage) + applied);
        v.health = Math.max(0, 1000 - v.damage);
        v.destroyed = v.health <= 0;
        this.lastEvent = v.destroyed ? `vehicle destroyed: ${v.name}` : `vehicle damage: ${Math.round(applied)} ${source}`;
        const now = performance.now();
        if (now - this._lastDamageAt > 180) {
            this._lastDamageAt = now;
            this.app?.multiplayer?.sendGameplayAction?.({
                kind: 'vehicle_damage', eventId: `${this.app.multiplayer.sessionId}:vehicle:${Date.now()}`,
                vehicleId: v.id, amount: applied, source,
            });
        }
        if (v.destroyed && this.inVehicle) this.exitVehicle('escaped destroyed');
        return true;
    }

    _syncOccupantPed() {
        const seat = this.getDriverSeatTransform();
        if (!seat) return;
        this._placePed(seat.position[0], seat.position[1], seat.position[2]);
        if (this.app?.player) this.app.player.headingRad = seat.headingRad;
    }

    _placePed(x, y, feetZ) {
        const app = this.app;
        if (!app?.ped) return;
        const eye = finite(app.pedEyeHeightData, 1.2);
        app.ped.posData[0] = x;
        app.ped.posData[1] = y;
        app.ped.posData[2] = feetZ + eye;
        app.ped.posView = app._dataToViewer?.(app.ped.posData) || app.ped.posView;
        app.pedRenderer?.setPositions?.([app.ped.posData]);
    }

    _resolveGround(x, y, zHint) {
        return this.app?.collisionWorld?.resolveGround?.(x, y, zHint, {
            applyYbnCalibration: false,
        }) || null;
    }

    _chooseDemoGarageSpawn() {
        const fallback = {
            coords: { x: 221.54, y: -806.78, z: 30.67, w: 69.92 },
            source: 'FiveM garage fallback',
        };
        const garages = Array.isArray(this.manifest?.garages) ? this.manifest.garages : [];
        const centerX = 186.94;
        const centerY = -850.84;
        let best = null;
        for (const garage of garages) {
            const c = garage?.coords;
            if (![c?.x, c?.y, c?.z].map(Number).every(Number.isFinite)) continue;
            const d = Math.hypot(Number(c.x) - centerX, Number(c.y) - centerY);
            if (d > 100.0 || (best && d >= best.distance)) continue;
            best = { distance: d, coords: c, source: String(garage.source || '') };
        }
        return best || fallback;
    }

    _isVehicleAction(action) {
        const t = String(action?.type || '');
        return t === 'open_garage' || t === 'open_vehicle_shop';
    }
}

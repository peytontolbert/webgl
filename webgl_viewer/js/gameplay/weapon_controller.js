const GLOCK17 = Object.freeze({
    id: 'weapon_glock17',
    label: 'Glock-17',
    magazineCapacity: 17,
    reserveAmmo: 51,
    // The FiveM weapon meta sets TimeBetweenShots to 0.370 for WEAPON_GLOCK17.
    semiFireInterval: 0.37,
    automaticFireInterval: 0.10,
    reloadDuration: 1.9,
    // Duration of weapons@pistol@combat_pistol/w_fire exported for this ped.
    firePoseDuration: 0.3333333,
    // Sampled from weapons@pistol@ GTA YCD transition clips.
    drawDuration: 0.5333338,
    holsterDuration: 0.5333333,
    // The pistol becomes visible when the sampled draw hand reaches the hip,
    // and leaves the hand at the matching point in the holster clip.
    drawAttachProgress: 0.32,
    holsterDetachProgress: 0.72,
    aimEnterDuration: 0.3333333,
    recoil: 0.3,
    automaticRecoilMultiplier: 1.5,
    automaticSpreadMultiplier: 1.3,
});

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

export class WeaponController {
    constructor(app) {
        this.app = app;
        this.weapon = {
            ...GLOCK17,
            magazineAmmo: GLOCK17.magazineCapacity,
            reserveAmmo: GLOCK17.reserveAmmo,
            switchItems: 1,
            switchInstalled: false,
        };
        this.phase = 'holstered';
        this.phaseRemaining = 0.0;
        this.aimRequested = false;
        this.aimHeld = false;
        this.aimTransition = null;
        this.aimTransitionRemaining = 0.0;
        this.fireHeld = false;
        this.firePressed = false;
        this.fireCooldown = 0.0;
        this.recoilKick = 0.0;
        this.shotPulse = 0.0;
        this.tracer = null;
        this.lastAction = null;
        this.actionSerial = 0;
        this.lastShotDiagnostics = null;
        this._hudKey = '';
        this.drawPending = false;
        this._drawRequestSerial = 0;
    }

    toggleDraw() {
        if (this.drawPending) return false;
        if (this.phase === 'drawing' || this.phase === 'holstering' || this.phase === 'reloading') return false;
        if (this.phase === 'equipped') {
            this.phase = 'holstering';
            this.phaseRemaining = this.weapon.holsterDuration;
            this.aimRequested = false;
            this.aimHeld = false;
            this._clearAimTransition();
            this.fireHeld = false;
            this.firePressed = false;
            this._setAction('holster');
        } else {
            const prepare = this.app?.prepareWeaponForDraw?.();
            if (prepare && typeof prepare.then === 'function') {
                const serial = ++this._drawRequestSerial;
                this.drawPending = true;
                this._setAction('prepare_draw');
                void Promise.resolve(prepare).then((ready) => {
                    if (serial !== this._drawRequestSerial) return;
                    this.drawPending = false;
                    if (ready && this.phase === 'holstered') this._beginDraw();
                    else if (!ready) this._setAction('draw_unavailable');
                }).catch(() => {
                    if (serial !== this._drawRequestSerial) return;
                    this.drawPending = false;
                    this._setAction('draw_unavailable');
                });
            } else {
                this._beginDraw();
            }
        }
        return true;
    }

    _beginDraw() {
        this.phase = 'drawing';
        this.phaseRemaining = this.weapon.drawDuration;
        this.aimRequested = false;
        this.aimHeld = false;
        this._clearAimTransition();
        this.fireHeld = false;
        this.firePressed = false;
        this._setAction('draw');
    }

    holsterImmediate() {
        this._drawRequestSerial++;
        this.drawPending = false;
        this.phase = 'holstered';
        this.phaseRemaining = 0.0;
        this.aimRequested = false;
        this.aimHeld = false;
        this._clearAimTransition();
        this.fireHeld = false;
        this.firePressed = false;
        this._setAction('holster_hands_up');
    }

    reload() {
        if (this.phase !== 'equipped') return false;
        const missing = this.weapon.magazineCapacity - this.weapon.magazineAmmo;
        if (missing <= 0 || this.weapon.reserveAmmo <= 0) return false;
        this.phase = 'reloading';
        this.phaseRemaining = this.weapon.reloadDuration;
        this.aimRequested = false;
        this.aimHeld = false;
        this._clearAimTransition();
        this.fireHeld = false;
        this.firePressed = false;
        this._setAction('reload');
        return true;
    }

    installSwitch() {
        if (this.phase !== 'equipped' || this.weapon.switchInstalled || this.weapon.switchItems <= 0) return false;
        this.weapon.switchItems -= 1;
        this.weapon.switchInstalled = true;
        this.weapon.id = 'weapon_glock17_auto';
        this.weapon.label = 'Glock-17 Auto';
        this._setAction('install_switch');
        return true;
    }

    setAimHeld(held) {
        const wasRequested = this.aimRequested;
        this.aimRequested = !!held;
        this.aimHeld = this.aimRequested && this.phase === 'equipped';
        if (this.aimHeld && !wasRequested) this._beginAimTransition();
        // Do not retain a left-button press across an ADS release. A new shot
        // must begin while RMB is actively held.
        if (!this.aimRequested) {
            this._clearAimTransition();
            this.fireHeld = false;
            this.firePressed = false;
        }
    }

    setFireHeld(held) {
        const next = !!held && this.isAiming();
        // A shot begins only from the explicit ADS state. This also prevents a
        // click made before RMB is held from being queued and firing later.
        if (next && !this.fireHeld) this.firePressed = true;
        this.fireHeld = next;
    }

    clearPointerState() {
        this.aimRequested = false;
        this.aimHeld = false;
        this._clearAimTransition();
        this.fireHeld = false;
        this.firePressed = false;
    }

    isAiming() {
        return this.phase === 'equipped' && this.aimHeld;
    }

    isVisible() {
        if (this.phase === 'equipped' || this.phase === 'reloading') return true;
        if (this.phase === 'drawing') {
            const progress = 1.0 - clamp(this.phaseRemaining / this.weapon.drawDuration, 0.0, 1.0);
            return progress >= this.weapon.drawAttachProgress;
        }
        if (this.phase === 'holstering') {
            const progress = 1.0 - clamp(this.phaseRemaining / this.weapon.holsterDuration, 0.0, 1.0);
            return progress < this.weapon.holsterDetachProgress;
        }
        return false;
    }

    isEquipped() {
        return this.phase === 'equipped';
    }

    getMovementScale() {
        if (this.phase === 'drawing' || this.phase === 'holstering') return 0.65;
        if (this.phase === 'reloading') return 0.5;
        if (this.isAiming()) return 0.58;
        return 1.0;
    }

    getStatus() {
        return {
            id: this.weapon.id,
            label: this.weapon.label,
            phase: this.phase,
            preparing: this.drawPending,
            aiming: this.isAiming(),
            aimTransition: this.aimTransition,
            aimProgress: this.aimTransition === 'enter'
                ? 1.0 - clamp(this.aimTransitionRemaining / this.weapon.aimEnterDuration, 0.0, 1.0)
                : 1.0,
            automatic: this.weapon.switchInstalled,
            magazineAmmo: this.weapon.magazineAmmo,
            magazineCapacity: this.weapon.magazineCapacity,
            reserveAmmo: this.weapon.reserveAmmo,
            switchItems: this.weapon.switchItems,
            switchInstalled: this.weapon.switchInstalled,
            lastAction: this.lastAction,
            actionSerial: this.actionSerial,
            lastShot: this.lastShotDiagnostics,
        };
    }

    getInventory() {
        return {
            weapon: {
                id: this.weapon.id,
                label: this.weapon.label,
                quantity: 1,
                equipped: this.phase === 'equipped',
                automatic: this.weapon.switchInstalled,
            },
            switch: {
                id: 'glockswitch',
                label: 'Glock switch',
                quantity: this.weapon.switchItems,
                installed: this.weapon.switchInstalled,
                canApply: this.phase === 'equipped' && !this.weapon.switchInstalled && this.weapon.switchItems > 0,
            },
            ammo: {
                id: 'pistol_ammo',
                label: 'Pistol ammo',
                quantity: this.weapon.magazineAmmo + this.weapon.reserveAmmo,
                magazineAmmo: this.weapon.magazineAmmo,
                reserveAmmo: this.weapon.reserveAmmo,
            },
        };
    }

    applyAuthoritativeInventory(inventory = {}) {
        const total = Math.max(0, Number(inventory.pistol_ammo) || 0);
        const current = this.weapon.magazineAmmo + this.weapon.reserveAmmo;
        if (total < current) {
            let remove = current - total;
            const fromReserve = Math.min(this.weapon.reserveAmmo, remove);
            this.weapon.reserveAmmo -= fromReserve;
            remove -= fromReserve;
            this.weapon.magazineAmmo = Math.max(0, this.weapon.magazineAmmo - remove);
        } else if (total > current) {
            this.weapon.reserveAmmo += total - current;
        }
        this.weapon.switchItems = Math.max(0, Number(inventory.glockswitch) || 0);
        if (this.app) this.app._weaponUiKey = '';
    }

    getCharacterPose() {
        if (this.phase === 'holstered') return { armed: false, blend: 0.0, aiming: false, reloading: false, phase: 'holstered' };
        let blend = 0.72;
        let clipProgress = 1.0;
        if (this.phase === 'drawing') {
            clipProgress = 1.0 - clamp(this.phaseRemaining / this.weapon.drawDuration, 0.0, 1.0);
            blend = clipProgress;
        } else if (this.phase === 'holstering') {
            clipProgress = 1.0 - clamp(this.phaseRemaining / this.weapon.holsterDuration, 0.0, 1.0);
            blend = 1.0 - clipProgress;
        } else if (this.phase === 'reloading') {
            blend = 0.84;
            clipProgress = 1.0 - clamp(this.phaseRemaining / this.weapon.reloadDuration, 0.0, 1.0);
        } else if (this.isAiming()) {
            blend = 1.0;
        }
        return {
            armed: true,
            blend,
            aiming: this.isAiming(),
            aimTransition: this.aimTransition,
            aimProgress: this.aimTransition === 'enter'
                ? 1.0 - clamp(this.aimTransitionRemaining / this.weapon.aimEnterDuration, 0.0, 1.0)
                : 1.0,
            reloading: this.phase === 'reloading',
            firing: this.shotPulse > 0.0,
            fireProgress: this.shotPulse > 0.0
                ? 1.0 - clamp(this.shotPulse / this.weapon.firePoseDuration, 0.0, 1.0)
                : 0.0,
            clipProgress,
            phase: this.phase,
        };
    }

    getRenderState() {
        return {
            visible: this.isVisible(),
            aiming: this.isAiming(),
            automatic: this.weapon.switchInstalled,
            phase: this.phase,
            recoilKick: this.recoilKick,
            recoil01: this._getRecoil01(),
            shotPulse: this.shotPulse,
            fireProgress: this.shotPulse > 0.0
                ? 1.0 - clamp(this.shotPulse / this.weapon.firePoseDuration, 0.0, 1.0)
                : 1.0,
            tracer: this.tracer,
        };
    }

    update(dt) {
        const step = Math.max(0.0, Math.min(0.05, Number(dt) || 0.0));
        this.fireCooldown = Math.max(0.0, this.fireCooldown - step);
        this.recoilKick = Math.max(0.0, this.recoilKick - step * 8.0);
        this.shotPulse = Math.max(0.0, this.shotPulse - step);
        if (this.aimTransitionRemaining > 0.0) {
            this.aimTransitionRemaining = Math.max(0.0, this.aimTransitionRemaining - step);
            if (this.aimTransitionRemaining <= 0.0) this.aimTransition = null;
        }
        if (this.tracer) {
            this.tracer.remaining -= step;
            if (this.tracer.remaining <= 0.0) this.tracer = null;
        }

        if (this.phaseRemaining > 0.0) {
            this.phaseRemaining = Math.max(0.0, this.phaseRemaining - step);
            if (this.phaseRemaining <= 0.0) this._finishPhase();
            return;
        }

        if (this.phase !== 'equipped') return;
        const wantsShot = this.isAiming() && (this.weapon.switchInstalled ? this.fireHeld : this.firePressed);
        this.firePressed = false;
        if (wantsShot && this.fireCooldown <= 0.0) this._fireOne();
    }

    _finishPhase() {
        if (this.phase === 'drawing') {
            this.phase = 'equipped';
            // Preserve an RMB hold that began during the draw transition.
            this.aimHeld = this.aimRequested;
            if (this.aimHeld) this._beginAimTransition();
            return;
        }
        if (this.phase === 'holstering') {
            this.phase = 'holstered';
            this.aimRequested = false;
            this.aimHeld = false;
            this._clearAimTransition();
            return;
        }
        if (this.phase === 'reloading') {
            const missing = this.weapon.magazineCapacity - this.weapon.magazineAmmo;
            const loaded = Math.max(0, Math.min(missing, this.weapon.reserveAmmo));
            this.weapon.magazineAmmo += loaded;
            this.weapon.reserveAmmo -= loaded;
            this.phase = 'equipped';
            this.aimHeld = this.aimRequested;
            if (this.aimHeld) this._beginAimTransition();
        }
    }

    _beginAimTransition() {
        this.aimTransition = 'enter';
        this.aimTransitionRemaining = this.weapon.aimEnterDuration;
    }

    _clearAimTransition() {
        this.aimTransition = null;
        this.aimTransitionRemaining = 0.0;
    }

    _getRecoil01() {
        const pulse01 = clamp(this.shotPulse / this.weapon.firePoseDuration, 0.0, 1.0);
        // Keep the mechanical kick brief even though the arm fire pose lasts
        // through the full sampled clip duration.
        return clamp(Math.max(this.recoilKick, 0.65 * pulse01 * pulse01 * pulse01), 0.0, 1.0);
    }

    _fireOne() {
        if (this.weapon.magazineAmmo <= 0) {
            this._setAction('empty');
            return;
        }
        this.weapon.magazineAmmo -= 1;
        this._setAction('fire');
        const automatic = this.weapon.switchInstalled;
        this.fireCooldown = automatic ? this.weapon.automaticFireInterval : this.weapon.semiFireInterval;
        const kick = this.weapon.recoil * (automatic ? this.weapon.automaticRecoilMultiplier : 1.0);
        this.recoilKick = clamp(this.recoilKick + kick, 0.0, 1.0);
        this.shotPulse = this.weapon.firePoseDuration;
        // Resolve the shot at the angle the player saw when firing. Camera
        // recoil is presentation for the following frame and subsequent shot.
        this.tracer = this._buildTracer();

        const app = this.app;
        try {
            const jitter = (Math.random() - 0.5) * 0.0018 * (automatic ? this.weapon.automaticSpreadMultiplier : 1.0);
            // Gameplay aim is decoupled from the camera's visual look-at slope.
            // Moving the orbit upward still produces the expected screen recoil.
            app._gpPitch = clamp((Number(app._gpPitch) || 0.0) - kick * 0.012, -1.15, 1.15);
            app._gpYaw = (Number(app._gpYaw) || 0.0) + jitter;
        } catch {
            // Camera kick is presentation only.
        }
    }

    _setAction(action) {
        this.lastAction = action;
        this.actionSerial++;
    }

    _buildTracer() {
        const app = this.app;
        const ped = app?.ped?.posData;
        if (!Array.isArray(ped) || ped.length < 3) return null;
        const reticleDirection = this._aimDirectionData();
        const origin = this._muzzleDataPosition(reticleDirection);
        const maxDistance = 90.0;
        // A third-person camera is offset from the muzzle. Acquire the reticle
        // target from the player's aim point, then test the real muzzle-to-target
        // path so a wall beside the player still blocks a shot.
        const aimOrigin = this._aimOriginData(origin);
        const usableWorldHit = (candidate, minDistance) => {
            const distance = Number(candidate?.distance);
            // Collision bounds can contain the eye or muzzle. A zero-distance
            // exit from that containing bound is not a wall in front of the shot.
            return Number.isFinite(distance) && distance >= minDistance ? candidate : null;
        };
        let aimWorldHit = null;
        try {
            aimWorldHit = usableWorldHit(app?.collisionWorld?.raycast?.({
                origin: aimOrigin,
                direction: reticleDirection,
                maxDistance,
            }) || null, 0.20);
        } catch {
            aimWorldHit = null;
        }
        const aimWorldDistance = Number.isFinite(Number(aimWorldHit?.distance))
            ? Number(aimWorldHit.distance)
            : maxDistance;
        let aimNpcHit = null;
        try {
            aimNpcHit = app?.npcSystem?.raycast?.({
                origin: aimOrigin,
                direction: reticleDirection,
                maxDistance: Math.min(maxDistance, aimWorldDistance),
            }) || null;
        } catch {
            aimNpcHit = null;
        }
        const aimNpcWins = !!aimNpcHit && (!aimWorldHit || aimNpcHit.distance <= aimWorldDistance + 0.03);
        const targetPoint = aimNpcWins
            ? aimNpcHit.point
            : (Array.isArray(aimWorldHit?.point) ? aimWorldHit.point : [
                aimOrigin[0] + reticleDirection[0] * maxDistance,
                aimOrigin[1] + reticleDirection[1] * maxDistance,
                aimOrigin[2] + reticleDirection[2] * maxDistance,
            ]);
        const toTarget = [
            Number(targetPoint[0]) - origin[0],
            Number(targetPoint[1]) - origin[1],
            Number(targetPoint[2]) - origin[2],
        ];
        const targetDistance = Math.hypot(toTarget[0], toTarget[1], toTarget[2]);
        const direction = targetDistance > 1e-5
            ? [toTarget[0] / targetDistance, toTarget[1] / targetDistance, toTarget[2] / targetDistance]
            : reticleDirection;
        const physicalLimit = Math.min(maxDistance, Math.max(0.1, targetDistance + 0.03));
        let hit = null;
        try {
            hit = usableWorldHit(
                app?.collisionWorld?.raycast?.({ origin, direction, maxDistance: physicalLimit }) || null,
                0.08,
            );
        } catch {
            hit = null;
        }
        const worldDistance = Number.isFinite(Number(hit?.distance)) ? Number(hit.distance) : physicalLimit;
        let npcHit = null;
        try {
            npcHit = app?.npcSystem?.raycast?.({
                origin,
                direction,
                // A world collision closer than the NPC always wins, which keeps
                // hitscan damage from passing through buildings and walls.
                maxDistance: Math.min(physicalLimit, worldDistance),
            }) || null;
        } catch {
            npcHit = null;
        }
        if (npcHit && (!hit || npcHit.distance <= worldDistance + 0.03)) {
            const zone = String(npcHit.zone || 'torso');
            const damage = zone === 'head' ? 110 : 38;
            const force = zone === 'head' ? 6.8 : 5.2;
            let impact = null;
            try {
                impact = app?.npcSystem?.applyBulletHit?.(npcHit.id, {
                    damage,
                    direction: [direction[0], direction[1]],
                    force,
                    zone,
                }) || null;
            } catch {
                impact = null;
            }
            if (impact?.applied) {
                hit = {
                    distance: npcHit.distance,
                    point: npcHit.point,
                    source: 'npc',
                    label: npcHit.id,
                    npcId: npcHit.id,
                    zone,
                    damage: impact.damage,
                    lethal: impact.lethal,
                };
            }
        }
        if (hit?.destructible === true) {
            try {
                const destroyed = app?.collisionWorld?.destroyDestructibleForImpact?.(hit, 999.0, {
                    source: 'bullet',
                    impactDirection: direction,
                    impactPoint: hit?.point || null,
                });
                if (destroyed) {
                    hit.destroyed = true;
                    hit.archetypeHash = destroyed.archetypeHash || '';
                }
            } catch {
                // A missed optional fragment manifest must never suppress the shot tracer.
            }
        }
        const endData = Array.isArray(hit?.point) && hit.point.length >= 3
            ? [Number(hit.point[0]), Number(hit.point[1]), Number(hit.point[2])]
            : [Number(targetPoint[0]), Number(targetPoint[1]), Number(targetPoint[2])];
        // The server validates shots from the ped eye, not the hand socket. Aim
        // that trusted origin at the exact reticle/muzzle-resolved impact so
        // replacing a supplied origin can never skew the authoritative ray.
        const networkOrigin = [Number(ped[0]), Number(ped[1]), Number(ped[2])];
        const networkToTarget = [
            endData[0] - networkOrigin[0],
            endData[1] - networkOrigin[1],
            endData[2] - networkOrigin[2],
        ];
        const rawNetworkDistance = Math.hypot(...networkToTarget);
        const networkDistance = Math.max(0.1, Math.min(maxDistance, rawNetworkDistance));
        const networkDirection = rawNetworkDistance > 1e-5
            ? networkToTarget.map((value) => value / rawNetworkDistance)
            : reticleDirection;
        this.lastShotDiagnostics = {
            schema: 'webglgta-shot-diagnostics-v1',
            reticle: {
                origin: this._roundVec3(aimOrigin),
                direction: this._roundVec3(reticleDirection),
                worldHit: aimWorldHit ? { source: String(aimWorldHit.source || 'collision'), distance: this._roundNumber(aimWorldDistance) } : null,
                npcHit: aimNpcHit ? { id: String(aimNpcHit.id), zone: String(aimNpcHit.zone || 'torso'), distance: this._roundNumber(aimNpcHit.distance) } : null,
            },
            muzzle: {
                origin: this._roundVec3(origin),
                direction: this._roundVec3(direction),
                targetDistance: this._roundNumber(targetDistance),
                worldHit: hit && hit.source !== 'npc' ? { source: String(hit.source || 'collision'), distance: this._roundNumber(hit.distance) } : null,
                npcHit: npcHit ? { id: String(npcHit.id), zone: String(npcHit.zone || 'torso'), distance: this._roundNumber(npcHit.distance) } : null,
            },
            result: hit ? {
                source: String(hit.source || 'collision'),
                npcId: hit.npcId ? String(hit.npcId) : null,
                zone: hit.zone ? String(hit.zone) : null,
                damage: Number.isFinite(Number(hit.damage)) ? Number(hit.damage) : null,
            } : { source: 'miss' },
            network: {
                origin: networkOrigin,
                direction: networkDirection,
                maxDistance: networkDistance,
                npcId: hit?.source === 'npc' && hit.npcId ? String(hit.npcId) : null,
                zone: hit?.source === 'npc' && hit.zone ? String(hit.zone) : null,
                impactPoint: hit?.source === 'npc' ? endData.slice(0, 3) : null,
            },
        };
        return {
            startData: origin,
            endData,
            hit: hit ? {
                source: String(hit.source || 'collision'),
                label: String(hit.label || 'collision'),
                npcId: hit.npcId ? String(hit.npcId) : null,
                zone: hit.zone ? String(hit.zone) : null,
                damage: Number.isFinite(Number(hit.damage)) ? Number(hit.damage) : null,
                lethal: hit.lethal === true,
            } : null,
            remaining: 0.10,
            duration: 0.10,
        };
    }

    _aimOriginData(fallback) {
        const app = this.app;
        if (this.isAiming() && app?.camera?.position && typeof app?._viewerPosToDataPos === 'function') {
            const camera = app._viewerPosToDataPos(app.camera.position);
            if (Array.isArray(camera) && camera.length >= 3 && camera.slice(0, 3).every((value) => Number.isFinite(Number(value)))) {
                return [Number(camera[0]), Number(camera[1]), Number(camera[2])];
            }
        }
        const ped = this.app?.ped?.posData;
        if (Array.isArray(ped) && ped.length >= 3 && ped.slice(0, 3).every((value) => Number.isFinite(Number(value)))) {
            return [Number(ped[0]), Number(ped[1]), Number(ped[2])];
        }
        return [Number(fallback[0]), Number(fallback[1]), Number(fallback[2])];
    }

    _roundNumber(value) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.round(number * 1000.0) / 1000.0 : null;
    }

    _roundVec3(vector) {
        return [this._roundNumber(vector?.[0]), this._roundNumber(vector?.[1]), this._roundNumber(vector?.[2])];
    }

    getWeaponPoseData() {
        const ped = this.app?.ped?.posData;
        if (!Array.isArray(ped) || ped.length < 3) return null;
        const direction = this._aimDirectionData();
        const feetZ = Number(ped[2]) - (Number(this.app?.pedEyeHeightData) || 1.2);
        const right = [direction[1], -direction[0], 0.0];
        const aiming = this.isAiming();
        const recoilBack = (Number(this.recoilKick) || 0.0) * 0.045;
        const activeHand = [
            Number(ped[0]) + direction[0] * (aiming ? 0.48 : 0.28) + right[0] * 0.24 - direction[0] * recoilBack,
            Number(ped[1]) + direction[1] * (aiming ? 0.48 : 0.28) + right[1] * 0.24 - direction[1] * recoilBack,
            feetZ + (aiming ? 1.32 : 1.20),
        ];
        // Match the sampled draw/holster clip timing: the weapon travels from the
        // right hip to the active hand instead of popping into place on state change.
        const holsterHand = [
            Number(ped[0]) - direction[0] * 0.10 + right[0] * 0.28,
            Number(ped[1]) - direction[1] * 0.10 + right[1] * 0.28,
            feetZ + 0.82,
        ];
        let handBlend = 1.0;
        if (this.phase === 'drawing') handBlend = 1.0 - clamp(this.phaseRemaining / this.weapon.drawDuration, 0.0, 1.0);
        else if (this.phase === 'holstering') handBlend = clamp(this.phaseRemaining / this.weapon.holsterDuration, 0.0, 1.0);
        const hand = [
            holsterHand[0] + (activeHand[0] - holsterHand[0]) * handBlend,
            holsterHand[1] + (activeHand[1] - holsterHand[1]) * handBlend,
            holsterHand[2] + (activeHand[2] - holsterHand[2]) * handBlend,
        ];
        // The skinned ped owns the actual wrist position and orientation. Keep
        // this controller-only pose as a fallback for unskinned character models.
        let attachment = null;
        try { attachment = this.app?._getWeaponRightHandPose?.() || null; } catch { /* ignore */ }
        if (attachment?.hand && attachment?.forward && attachment?.right) {
            return {
                hand: attachment.hand,
                direction,
                right,
                visualDirection: attachment.forward,
                visualRight: attachment.right,
                visualUp: attachment.up,
                aiming,
                attachedToHand: true,
            };
        }
        return { hand, direction, right, aiming, attachedToHand: false };
    }

    _muzzleDataPosition(direction = null) {
        const pose = this.getWeaponPoseData();
        if (!pose) return [0, 0, 0];
        const forward = direction || pose.direction;
        return [
            pose.hand[0] + forward[0] * 0.29,
            pose.hand[1] + forward[1] * 0.29,
            pose.hand[2] + forward[2] * 0.29 + 0.035,
        ];
    }

    _aimDirectionData() {
        const app = this.app;
        if (this.isAiming() && typeof app?._getGameplayAimDirectionData === 'function') {
            const gameplayDirection = app._getGameplayAimDirectionData();
            const gameplayLength = Math.hypot(
                Number(gameplayDirection?.[0]) || 0.0,
                Number(gameplayDirection?.[1]) || 0.0,
                Number(gameplayDirection?.[2]) || 0.0,
            );
            if (gameplayLength > 1e-5) {
                return [
                    gameplayDirection[0] / gameplayLength,
                    gameplayDirection[1] / gameplayLength,
                    gameplayDirection[2] / gameplayLength,
                ];
            }
        }
        if (this.isAiming() && app?.camera?.direction && typeof app._viewerDirToDataDir === 'function') {
            const fromCamera = app._viewerDirToDataDir(app.camera.direction);
            const len = Math.hypot(Number(fromCamera?.[0]) || 0.0, Number(fromCamera?.[1]) || 0.0, Number(fromCamera?.[2]) || 0.0) || 1.0;
            return [fromCamera[0] / len, fromCamera[1] / len, fromCamera[2] / len];
        }
        const heading = Number(app?.player?.headingRad) || 0.0;
        return [Math.cos(heading), Math.sin(heading), 0.0];
    }
}

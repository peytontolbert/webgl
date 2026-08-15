const COMBO = Object.freeze([
    // Timings are taken from the sampled GTA YCD frames, including recovery.
    // `impactAt` is the contact frame of the animated striking limb.
    { type: 'right_punch', clip: 'melee_punch_right', duration: 2.0333333, impactAt: 0.8666667, damage: 18, reach: 2.05, force: 2.4, chainFrom: 0.58 },
    { type: 'left_punch', clip: 'melee_punch_left', duration: 1.7999992, impactAt: 0.3666667, damage: 20, reach: 2.10, force: 2.7, chainFrom: 0.46 },
    { type: 'front_kick', clip: 'melee_kick', duration: 2.6333339, impactAt: 0.6666667, damage: 32, reach: 2.35, force: 4.6, knockdown: true, chainFrom: 0.55 },
]);
const PLAYER_DEATH_RESPAWN_SECONDS = 5.0;
const PLAYER_KNOCKDOWN_SECONDS = 5.6;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

export class MeleeController {
    constructor(app) {
        this.app = app;
        this.playerHealth = 100;
        this.playerMaxHealth = 100;
        this.playerArmor = 0;
        this.guardHeld = false;
        this.attack = null;
        this.comboIndex = 0;
        this.comboResetRemaining = 0.0;
        this.queuedAttack = false;
        this.targetId = null;
        this.lastHit = null;
        this.lastAttack = null;
        this.hurtPulse = 0.0;
        this.hurtElapsed = 0.0;
        this.lifeState = 'alive';
        this.lifeElapsed = 0.0;
        this.lifeDuration = 0.0;
        this.lifeClip = '';
        this._uiVersion = 0;
        this.actionSerial = 0;
    }

    canUse() {
        return !!this.app?.ped
            && !!this.app?.player?.enabled
            && !this.app?.settingsMenuOpen
            && this.lifeState === 'alive'
            && !this.app?.weaponController?.isVisible?.();
    }

    pressAttack() {
        if (!this.canUse()) return false;
        if (this.attack) {
            if (this.attack.progress >= this.attack.spec.chainFrom && this.attack.progress < 0.96) this.queuedAttack = true;
            return true;
        }
        this._startAttack(this.comboIndex);
        return true;
    }

    setGuardHeld(held) {
        this.guardHeld = !!held && this.canUse();
        if (!this.guardHeld && !this.attack) this.targetId = null;
    }

    clearInput() {
        this.guardHeld = false;
        this.queuedAttack = false;
    }

    getMovementScale() {
        if (this.lifeState !== 'alive') return 0.0;
        if (this.attack) return 0.28;
        if (this.guardHeld) return 0.58;
        return 1.0;
    }

    getCharacterPose() {
        if (!this.attack && !this.guardHeld && this.hurtPulse <= 0.0 && this.lifeState === 'alive') return null;
        if (this.lifeState !== 'alive') return this._getIncapacitatedPose();
        // No exported block loop exists in the current YCD set. Keep the guard
        // on the renderer's stable upper-body fallback instead of freezing an
        // unrelated one-shot melee intro frame.
        const clip = this.attack?.spec?.clip || (this.hurtPulse > 0.0 ? 'melee_hit_front' : 'melee_guard');
        return {
            armed: false,
            melee: true,
            phase: this.attack ? 'attack' : (this.hurtPulse > 0.0 ? 'hurt' : 'guard'),
            attackType: this.attack?.spec?.type || '',
            progress: this.attack?.progress || 0.0,
            clip,
            clipProgress: this.attack ? this.attack.progress : (this.hurtPulse > 0.0 ? clamp(this.hurtElapsed / 0.36, 0, 1) : 0.72),
            blend: this.attack ? 1.0 : (this.guardHeld ? 0.82 : 0.65),
            guarding: this.guardHeld,
            hurt: this.hurtPulse > 0.0,
        };
    }

    getStatus() {
        const target = this.app?.npcSystem?.getById?.(this.targetId) || null;
        return {
            health: this.playerHealth,
            maxHealth: this.playerMaxHealth,
            armor: this.playerArmor,
            attacking: !!this.attack,
            guarding: this.guardHeld,
            combo: this.attack ? this.comboIndex + 1 : 0,
            lifeState: this.lifeState,
            lifeElapsed: this.lifeElapsed,
            lifeDuration: this.lifeDuration,
            respawnRemaining: this.lifeState === 'dead'
                ? Math.max(0.0, this.lifeDuration - this.lifeElapsed)
                : 0.0,
            target: target ? { id: target.id, health: target.health, maxHealth: target.maxHealth } : null,
            lastHit: this.lastHit,
            lastAttack: this.lastAttack,
            attack: this.attack ? {
                type: this.attack.spec.type,
                clip: this.attack.spec.clip,
                elapsed: this.attack.elapsed,
                duration: this.attack.spec.duration,
                impactAt: this.attack.spec.impactAt,
                didImpact: this.attack.didImpact,
            } : null,
            version: this._uiVersion,
            actionSerial: this.actionSerial,
        };
    }

    update(dt) {
        const step = clamp(Number(dt) || 0.0, 0.0, 0.05);
        this.hurtPulse = Math.max(0.0, this.hurtPulse - step);
        if (this.hurtPulse > 0.0) this.hurtElapsed += step;
        if (this.lifeState !== 'alive') {
            this._updateLifeState(step);
            return;
        }
        this.comboResetRemaining = Math.max(0.0, this.comboResetRemaining - step);
        if (!this.canUse()) {
            this.clearInput();
            this.attack = null;
            return;
        }
        if (this.guardHeld && !this.attack) {
            this._refreshTarget(2.8);
            this._faceTarget();
        }
        if (!this.attack) {
            if (this.comboResetRemaining <= 0.0) this.comboIndex = 0;
            return;
        }

        const attack = this.attack;
        attack.elapsed += step;
        attack.progress = clamp(attack.elapsed / attack.spec.duration, 0.0, 1.0);
        this._faceTarget();
        if (!attack.didImpact && attack.elapsed >= attack.spec.impactAt) {
            attack.didImpact = true;
            this._applyImpact(attack);
        }
        if (attack.elapsed < attack.spec.duration) return;

        this.attack = null;
        this.comboResetRemaining = 0.72;
        if (this.queuedAttack) {
            this.queuedAttack = false;
            this.comboIndex = (this.comboIndex + 1) % COMBO.length;
            this._startAttack(this.comboIndex);
        } else {
            this.comboIndex = (this.comboIndex + 1) % COMBO.length;
        }
        this._uiVersion++;
    }

    receiveNpcHit(npc, damage = 8) {
        if (this.lifeState === 'dead') return false;
        if (this.lifeState === 'knocked_out' || this.lifeState === 'knockdown') {
            this._setLifeState('dead', PLAYER_DEATH_RESPAWN_SECONDS, 'melee_death_a');
            return true;
        }
        if (!this.canUse() || this.playerHealth <= 0) return false;
        const blocked = this._isGuardingAgainst(npc);
        const applied = Math.max(1, Math.round((Number(damage) || 8) * (blocked ? 0.22 : 1.0)));
        const armorDamage = Math.min(this.playerArmor, applied);
        this.playerArmor -= armorDamage;
        this.playerHealth = Math.max(0, this.playerHealth - (applied - armorDamage));
        this.hurtPulse = blocked ? 0.12 : 0.32;
        this.hurtElapsed = 0.0;
        this.lastHit = { source: npc?.id || 'npc', damage: applied, blocked };
        if (this.playerHealth <= 0) {
            this._setLifeState('dead', PLAYER_DEATH_RESPAWN_SECONDS, 'melee_death_a');
        } else if (!blocked && applied >= 10 && this.playerHealth <= 45) {
            this._setLifeState('knockdown', PLAYER_KNOCKDOWN_SECONDS, 'melee_knockdown');
        }
        this._uiVersion++;
        return true;
    }

    _startAttack(index) {
        const spec = COMBO[Math.max(0, Math.min(COMBO.length - 1, index | 0))];
        this._refreshTarget(spec.reach + 0.45);
        this.attack = { spec, elapsed: 0.0, progress: 0.0, didImpact: false };
        this.lastAttack = { type: spec.type, result: 'started', target: this.targetId };
        void this.app?._ensureMeleeAnimations?.();
        this._faceTarget();
        this._stepTowardTarget();
        this._uiVersion++;
    }

    _refreshTarget(range) {
        const existing = this.app?.npcSystem?.getById?.(this.targetId) || null;
        const ped = this.app?.ped?.posData;
        if (existing && ped && this._isTargetReachable(existing, ped, range + 0.35)) return existing;

        let heading = Number(this.app?.player?.headingRad) || 0.0;
        try {
            const cameraDirection = this.app?._getGameplayAimDirectionData?.()
                || this.app?._viewerDirToDataDir?.(this.app?.camera?.direction);
            if (Math.hypot(Number(cameraDirection?.[0]) || 0.0, Number(cameraDirection?.[1]) || 0.0) > 1e-4) {
                heading = Math.atan2(cameraDirection[1], cameraDirection[0]);
            }
        } catch { /* ignore */ }
        const target = this.app?.npcSystem?.findMeleeTarget?.({
            origin: this.app?.ped?.posData,
            heading,
            maxDistance: range,
            coneDot: this.guardHeld ? -0.05 : 0.18,
        }) || null;
        if (!target || !ped || !this._isTargetReachable(target, ped, range)) {
            this.targetId = null;
            return null;
        }
        this.targetId = target.id;
        return target;
    }

    _stepTowardTarget() {
        const ped = this.app?.ped?.posData;
        const target = this.app?.npcSystem?.getById?.(this.targetId);
        if (!ped || !target) return;
        const dx = target.x - ped[0];
        const dy = target.y - ped[1];
        const distance = Math.hypot(dx, dy);
        if (distance <= 1.05 || distance > 2.65) return;
        const stepDistance = Math.min(0.42, distance - 1.0);
        const eye = Number(this.app?.pedEyeHeightData) || 1.2;
        const moved = this.app?.collisionWorld?.moveCapsule?.({
            x: ped[0], y: ped[1], feetZ: ped[2] - eye,
            vx: (dx / distance) * stepDistance,
            vy: (dy / distance) * stepDistance,
            dt: 1.0, radius: 0.38, maxStepUp: 0.65, maxSnapDistance: 3.0,
        });
        if (!moved) return;
        ped[0] = Number(moved.x) || ped[0];
        ped[1] = Number(moved.y) || ped[1];
        if (Number.isFinite(Number(moved.ground?.z))) ped[2] = Number(moved.ground.z) + eye;
        this.app.ped.posView = this.app._dataToViewer?.(ped) || this.app.ped.posView;
    }

    _faceTarget() {
        const ped = this.app?.ped?.posData;
        const target = this.app?.npcSystem?.getById?.(this.targetId);
        if (!ped || !target) return;
        const heading = Math.atan2(target.y - ped[1], target.x - ped[0]);
        this.app.player.headingRad = heading;
        this.app.player._lastMoveDirData = [Math.cos(heading), Math.sin(heading), 0.0];
    }

    _applyImpact(attack) {
        this.actionSerial++;
        let target = this.app?.npcSystem?.getById?.(this.targetId) || null;
        if (!target) target = this._refreshTarget(attack.spec.reach);
        const ped = this.app?.ped?.posData;
        if (!target || !ped) {
            this.lastAttack = { type: attack.spec.type, result: 'miss', reason: 'no_target' };
            this._uiVersion++;
            return;
        }
        const dx = target.x - ped[0];
        const dy = target.y - ped[1];
        const distance = Math.hypot(dx, dy);
        if (distance > attack.spec.reach || distance < 1e-4) {
            this.lastAttack = { type: attack.spec.type, result: 'miss', reason: 'out_of_range', distance };
            this._uiVersion++;
            return;
        }
        if (!this._isTargetReachable(target, ped, attack.spec.reach)) {
            this.lastAttack = { type: attack.spec.type, result: 'miss', reason: 'blocked_by_world', distance };
            this._uiVersion++;
            return;
        }
        const hit = this.app.npcSystem.applyMeleeHit?.(target.id, {
            damage: attack.spec.damage,
            direction: [dx / distance, dy / distance],
            force: attack.spec.force,
            attackType: attack.spec.type,
            knockdown: !!attack.spec.knockdown,
        });
        if (hit) {
            this.lastHit = { target: target.id, damage: attack.spec.damage, attackType: attack.spec.type };
            this.lastAttack = { type: attack.spec.type, result: 'hit', target: target.id, distance };
        } else {
            this.lastAttack = { type: attack.spec.type, result: 'miss', reason: 'target_rejected', target: target.id, distance };
        }
        this._uiVersion++;
    }

    applyAuthoritativeState({ health, armor, dead = false, respawn = false } = {}) {
        this.playerHealth = clamp(Number(health) || 0, 0, this.playerMaxHealth);
        this.playerArmor = clamp(Number(armor) || 0, 0, 100);
        if (dead && this.lifeState !== 'dead') this._setLifeState('dead', PLAYER_DEATH_RESPAWN_SECONDS, 'melee_death_a');
        if (respawn) this._respawnPlayer();
        this._uiVersion++;
    }

    _isTargetReachable(target, ped, maxDistance) {
        const dx = Number(target?.x) - Number(ped?.[0]);
        const dy = Number(target?.y) - Number(ped?.[1]);
        const distance = Math.hypot(dx, dy);
        if (!Number.isFinite(distance) || distance < 1e-4 || distance > maxDistance) return false;
        const origin = [Number(ped[0]), Number(ped[1]), Number(ped[2])];
        const targetZ = Number(target?.feetZ) + (Number(target?.ragdollOffsetZ) || 0.0) + 1.0;
        const rayDistance = Math.hypot(dx, dy, targetZ - origin[2]);
        if (!Number.isFinite(rayDistance) || rayDistance < 1e-4) return true;
        const direction = [dx / rayDistance, dy / rayDistance, (targetZ - origin[2]) / rayDistance];
        try {
            const worldHit = this.app?.collisionWorld?.raycast?.({ origin, direction, maxDistance: rayDistance });
            return !worldHit || !Number.isFinite(Number(worldHit.distance)) || Number(worldHit.distance) >= rayDistance - 0.08;
        } catch {
            return true;
        }
    }

    _isGuardingAgainst(npc) {
        if (!this.guardHeld || this.attack || !npc) return false;
        const ped = this.app?.ped?.posData;
        if (!ped) return false;
        const dx = Number(npc.x) - Number(ped[0]);
        const dy = Number(npc.y) - Number(ped[1]);
        const distance = Math.hypot(dx, dy);
        if (!Number.isFinite(distance) || distance < 1e-4 || distance > 2.0) return false;
        const heading = Number(this.app?.player?.headingRad) || 0.0;
        return ((dx / distance) * Math.cos(heading) + (dy / distance) * Math.sin(heading)) >= 0.1;
    }

    _getIncapacitatedPose() {
        let clip = this.lifeClip;
        let progress = clamp(this.lifeElapsed / Math.max(0.001, this.lifeDuration), 0, 1);
        if (this.lifeState === 'knocked_out' && this.lifeElapsed > 1.0) {
            clip = 'melee_writhe';
            progress = ((this.lifeElapsed - 1.0) / 3.0) % 1.0;
        }
        return {
            armed: false,
            melee: true,
            phase: this.lifeState,
            clip,
            clipProgress: progress,
            progress,
            blend: 1.0,
            incapacitated: true,
        };
    }

    _setLifeState(state, duration, clip) {
        this.lifeState = state;
        this.lifeElapsed = 0.0;
        this.lifeDuration = Math.max(0.05, Number(duration) || 1.0);
        this.lifeClip = String(clip || '');
        this.attack = null;
        this.clearInput();
        void this.app?._ensureMeleeAnimations?.();
        this._uiVersion++;
    }

    _updateLifeState(step) {
        this.lifeElapsed += step;
        if (this.lifeElapsed < this.lifeDuration) return;
        if (this.lifeState === 'knockdown') {
            this._setLifeState('getting_up', 1.15, 'melee_getup');
            return;
        }
        if (this.lifeState === 'knocked_out') {
            this.playerHealth = Math.max(35, Math.round(this.playerMaxHealth * 0.35));
            this._setLifeState('getting_up', 1.25, 'melee_getup_injured');
            return;
        }
        if (this.lifeState === 'getting_up') {
            this.lifeState = 'alive';
            this.lifeElapsed = 0.0;
            this.lifeDuration = 0.0;
            this.lifeClip = '';
            this._uiVersion++;
            return;
        }
        if (this.lifeState === 'dead') this._respawnPlayer();
    }

    _respawnPlayer() {
        let respawned = false;
        try {
            respawned = this.app?.respawnPlayerFromDeath?.() === true;
        } catch {
            respawned = false;
        }
        if (!respawned) {
            try {
                this.app?.spawnPedAtCity?.();
                respawned = !!this.app?.ped;
            } catch {
                respawned = false;
            }
        }
        this.playerHealth = this.playerMaxHealth;
        this.lifeState = 'alive';
        this.lifeElapsed = 0.0;
        this.lifeDuration = 0.0;
        this.lifeClip = '';
        this.hurtPulse = 0.0;
        this.hurtElapsed = 0.0;
        this.attack = null;
        this.targetId = null;
        this.comboIndex = 0;
        this.comboResetRemaining = 0.0;
        this.clearInput();
        this._uiVersion++;
        return respawned;
    }
}

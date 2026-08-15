const TAU = Math.PI * 2.0;
const NPC_CORPSE_SECONDS = 15.0;
const NPC_KNOCKDOWN_SECONDS = 5.6;
const NPC_KICK_KNOCKDOWN_SECONDS = 8.0;
const NPC_VEHICLE_LETHAL_SPEED = 14.0;
const NPC_LANDED_POSE_PROGRESS = 0.82;
// Sampled from melee@unarmed@streamed_core/walking_punch. Damage must happen
// at the animated contact frame, not when the NPC begins winding up.
const NPC_MELEE_ATTACK_DURATION = 2.4666669;
const NPC_MELEE_ATTACK_IMPACT_AT = 1.0;
const NPC_MELEE_ATTACK_REACH = 1.42;
const NPC_MELEE_HIT_REACH = 1.62;
const MAX_LOCAL_POLICE = 6;
const POLICE_RETIRE_SECONDS = 6.0;
// YCD collapse clips are relative to the animated root. The browser must carry
// the actor root into a prone pose or the sampled body remains standing upright.
const NPC_PRONE_PITCH = -Math.PI * 0.5;
// Collision feetZ is the ground plane; extra clearance lifts prone bodies.
const NPC_PRONE_GROUND_OFFSET = 0.0;

function finite(value, fallback = 0.0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function normalizeDirectionXY(direction) {
    const x = finite(direction?.[0], 1.0);
    const y = finite(direction?.[1], 0.0);
    const length = Math.hypot(x, y);
    return length > 1e-5 ? [x / length, y / length] : [1.0, 0.0];
}

export class NpcSystem {
    constructor(app, collisionWorld) {
        this.app = app;
        this.collisionWorld = collisionWorld;
        this.npcs = [];
        this.enabled = true;
        this._crowdInitialized = false;
        this._seed = 0x6d2b79f5;
        this.wantedLevel = 0;
        this.wantedHeat = 0;
        this._policeSerial = 0;
        this._networkSnapshotAt = 0;
        this._playerWasAttackable = true;
    }

    ensureDemoCrowd() {
        if (!this.enabled || !this.app?.spawnDistrictDemo || this._crowdInitialized) return false;
        const bounds = this.app.spawnDistrictBounds;
        const spawn = this.app?._spawnDistrictDescriptor?.spawn || null;
        const centerX = finite(spawn?.x, (finite(bounds?.minX) + finite(bounds?.maxX)) * 0.5);
        const centerY = finite(spawn?.y, (finite(bounds?.minY) + finite(bounds?.maxY)) * 0.5);
        const baseZ = finite(spawn?.pedZ, finite(this.app?.ped?.posData?.[2], 31.0));
        if (!bounds) return false;

        const offsets = [[14, 8], [-15, 6], [23, -15], [-20, -18], [8, 28], [-27, 19]];
        for (let i = 0; i < offsets.length; i++) {
            const x = this._clampX(centerX + offsets[i][0]);
            const y = this._clampY(centerY + offsets[i][1]);
            const groundZ = this._groundAt(x, y, baseZ);
            if (!Number.isFinite(groundZ)) continue;
            const npc = {
                id: `ambient_${i + 1}`,
                x,
                y,
                feetZ: groundZ,
                heading: this._random() * TAU - Math.PI,
                targetX: x,
                targetY: y,
                homeX: x,
                homeY: y,
                speed: 1.15 + this._random() * 0.35,
                retargetIn: this._random() * 0.8,
                health: 100,
                maxHealth: 100,
                state: 'wander',
                hostile: false,
                role: 'civilian',
                groupId: `crowd_${Math.floor(i / 2)}`,
                courage: this._random(),
                weapon: '',
                fleeRemaining: 0.0,
                reportRemaining: 0.0,
                hitRemaining: 0.0,
                downRemaining: 0.0,
                stateElapsed: 0.0,
                stateDuration: 0.0,
                stateClip: '',
                attackCooldown: 0.0,
                attackElapsed: 0.0,
                attackRemaining: 0.0,
                attackHitAt: NPC_MELEE_ATTACK_IMPACT_AT,
                attackDidHit: false,
                knockbackX: 0.0,
                knockbackY: 0.0,
                impactCooldown: 0.0,
                ragdollLethal: false,
                ragdollVX: 0.0,
                ragdollVY: 0.0,
                ragdollVZ: 0.0,
                ragdollOffsetZ: 0.0,
                ragdollPitch: 0.0,
                ragdollRoll: 0.0,
                ragdollGroundPitch: 0.0,
                ragdollGroundRoll: 0.0,
                ragdollGroundOffsetZ: 0.0,
                ragdollPitchVelocity: 0.0,
                ragdollRollVelocity: 0.0,
                ragdollGrounded: true,
                ragdollFallClip: 'melee_knockdown',
                ragdollFallDuration: NPC_KNOCKDOWN_SECONDS,
                downedDuration: 1.5,
                ragdollDeathClip: 'melee_death_a',
                lastDamageSource: '',
                lastHitZone: '',
            };
            this._chooseTarget(npc);
            this.npcs.push(npc);
        }
        this._crowdInitialized = this.npcs.length > 0;
        return this._crowdInitialized;
    }

    clear() {
        this.npcs.length = 0;
        this._crowdInitialized = false;
        this.wantedLevel = 0;
        this.wantedHeat = 0;
    }

    update(dt) {
        if (!this.enabled) return;
        this.ensureDemoCrowd();
        const step = Math.max(0.001, Math.min(0.05, finite(dt, 1 / 60)));
        const playerX = finite(this.app?.ped?.posData?.[0], NaN);
        const playerY = finite(this.app?.ped?.posData?.[1], NaN);
        const playerAttackable = this._isPlayerAttackable();
        if (!playerAttackable) {
            this.wantedLevel = 0;
            this.wantedHeat = 0;
            this._disengageAllFromPlayer();
        }
        this._playerWasAttackable = playerAttackable;
        this._retireUnneededPolice(step, playerAttackable);
        if (performance.now() - this._networkSnapshotAt < 1_000) {
            for (const npc of this.npcs) npc.stateElapsed = finite(npc.stateElapsed) + step;
            return;
        }
        this.wantedHeat = Math.max(0, this.wantedHeat - step);
        if (this.wantedLevel > 0 && this.wantedHeat <= 0) {
            this.wantedLevel--;
            this.wantedHeat = this.wantedLevel > 0 ? 22 : 0;
        }
        if (playerAttackable && this.wantedLevel > 0) this._ensurePoliceResponse(playerX, playerY);

        for (let npcIndex = this.npcs.length - 1; npcIndex >= 0; npcIndex--) {
            const npc = this.npcs[npcIndex];
            npc.attackCooldown = Math.max(0.0, finite(npc.attackCooldown) - step);
            npc.fleeRemaining = Math.max(0.0, finite(npc.fleeRemaining) - step);
            npc.impactCooldown = Math.max(0.0, finite(npc.impactCooldown) - step);
            npc.stateElapsed = finite(npc.stateElapsed) + step;
            if (npc.state === 'dead') {
                if (npc.stateElapsed >= npc.stateDuration) this.npcs.splice(npcIndex, 1);
                continue;
            }
            if (npc.state === 'vehicle_hit') {
                this._updateRagdollPhysics(npc, step, 2.2);
                if (npc.stateElapsed >= npc.stateDuration) {
                    this._setState(npc, 'ragdoll', npc.ragdollFallDuration, npc.ragdollFallClip);
                }
                continue;
            }
            if (npc.state === 'ragdoll') {
                this._updateRagdollPhysics(npc, step, npc.ragdollLethal ? 2.1 : 3.4);
                if (npc.stateElapsed >= npc.stateDuration && npc.ragdollGrounded) {
                    this._settleRagdoll(npc);
                    if (npc.ragdollLethal) {
                        // Keep the grounded final fall pose. The short `dead_*`
                        // clips are static reactions and can stand a corpse back up.
                        this._setState(npc, 'dead', NPC_CORPSE_SECONDS, npc.ragdollFallClip || 'melee_knockdown');
                    } else {
                        this._setState(npc, 'downed', npc.downedDuration, 'melee_writhe');
                    }
                }
                continue;
            }
            if (npc.state === 'downed') {
                if (npc.stateElapsed >= npc.stateDuration) {
                    this._setState(npc, 'getting_up', 2.5, 'melee_getup_injured');
                }
                continue;
            }
            if (npc.state === 'knocked_out' || npc.state === 'knockdown') {
                if (npc.stateElapsed >= npc.stateDuration) this._setState(npc, 'getting_up', 1.25, npc.state === 'knocked_out' ? 'melee_getup_injured' : 'melee_getup');
                continue;
            }
            if (npc.state === 'getting_up') {
                this._blendRagdollToStanding(npc);
                if (npc.stateElapsed >= npc.stateDuration) {
                    if (npc.health <= 0) npc.health = Math.max(35, Math.round(npc.maxHealth * 0.35));
                    this._settleRagdoll(npc, { upright: true });
                    this._setState(npc, npc.hostile ? 'hostile' : 'wander');
                }
                continue;
            }
            if (npc.hitRemaining > 0.0) {
                npc.hitRemaining -= step;
                this._moveWithVelocity(npc, npc.knockbackX, npc.knockbackY, step, 0.34, 0.4);
                const damping = Math.exp(-7.0 * step);
                npc.knockbackX *= damping;
                npc.knockbackY *= damping;
                if (npc.hitRemaining <= 0.0) this._setState(npc, npc.hostile ? 'hostile' : 'wander');
                continue;
            }

            if (npc.attackRemaining > 0.0) {
                if (!playerAttackable) {
                    this._cancelNpcAttack(npc);
                    continue;
                }
                npc.attackRemaining = Math.max(0.0, npc.attackRemaining - step);
                npc.attackElapsed += step;
                if (!npc.attackDidHit && npc.attackElapsed >= finite(npc.attackHitAt, NPC_MELEE_ATTACK_IMPACT_AT)) {
                    npc.attackDidHit = true;
                    this._applyNpcMeleeImpact(npc);
                }
                continue;
            }

            npc.retargetIn -= step;
            const fleeing = npc.fleeRemaining > 0 && Number.isFinite(playerX) && Number.isFinite(playerY);
            let dx = fleeing ? npc.x - playerX : npc.hostile && Number.isFinite(playerX) ? playerX - npc.x : npc.targetX - npc.x;
            let dy = fleeing ? npc.y - playerY : npc.hostile && Number.isFinite(playerY) ? playerY - npc.y : npc.targetY - npc.y;
            let distance = Math.hypot(dx, dy);
            if (!npc.hostile && (npc.retargetIn <= 0.0 || distance < 0.8)) {
                this._chooseTarget(npc);
                dx = npc.targetX - npc.x;
                dy = npc.targetY - npc.y;
                distance = Math.hypot(dx, dy);
            }
            if (distance < 1e-4) continue;
            dx /= distance;
            dy /= distance;

            if (playerAttackable && npc.hostile && npc.weapon === 'pistol' && distance >= 3.0 && distance <= 18.0) {
                npc.heading = Math.atan2(dy, dx);
                npc.state = 'shooting';
                if (npc.attackCooldown <= 0.0 && this._hasLineOfSightToPlayer(npc, distance)) {
                    npc.attackCooldown = 0.85 + this._random() * 0.55;
                    this.app?.meleeController?.receiveNpcHit?.(npc, 12);
                }
                continue;
            }
            if (playerAttackable && npc.hostile && distance < NPC_MELEE_ATTACK_REACH) {
                npc.heading = Math.atan2(dy, dx);
                npc.state = 'attack';
                if (npc.attackCooldown <= 0.0) {
                    npc.attackCooldown = NPC_MELEE_ATTACK_DURATION + 0.25 + this._random() * 0.35;
                    npc.attackElapsed = 0.0;
                    npc.attackRemaining = NPC_MELEE_ATTACK_DURATION;
                    npc.attackHitAt = NPC_MELEE_ATTACK_IMPACT_AT;
                    npc.attackDidHit = false;
                }
                continue;
            }
            npc.state = fleeing ? 'flee' : npc.hostile ? 'hostile' : 'wander';

            if (Number.isFinite(playerX) && Number.isFinite(playerY)) {
                const awayX = npc.x - playerX;
                const awayY = npc.y - playerY;
                const playerDistance = Math.hypot(awayX, awayY);
                if (playerDistance < 1.5 && playerDistance > 1e-4) {
                    const strength = (1.5 - playerDistance) / 1.5;
                    dx += (awayX / playerDistance) * strength * 1.8;
                    dy += (awayY / playerDistance) * strength * 1.8;
                    const adjustedLength = Math.hypot(dx, dy) || 1.0;
                    dx /= adjustedLength;
                    dy /= adjustedLength;
                }
            }

            const desiredHeading = Math.atan2(dy, dx);
            const turn = 1.0 - Math.exp(-7.0 * step);
            npc.heading = this.app?._lerpAngleRad
                ? this.app._lerpAngleRad(npc.heading, desiredHeading, turn)
                : desiredHeading;
            const moveSpeed = fleeing ? 3.25 : npc.role === 'police' ? 2.65 : npc.hostile ? 1.85 : npc.speed;
            const collision = this.collisionWorld?.moveCapsule?.({
                x: npc.x,
                y: npc.y,
                feetZ: npc.feetZ,
                vx: dx * moveSpeed,
                vy: dy * moveSpeed,
                dt: step,
                radius: 0.34,
                maxStepUp: 0.65,
                maxSnapDistance: 3.0,
            });
            if (collision) {
                npc.x = finite(collision.x, npc.x);
                npc.y = finite(collision.y, npc.y);
                const groundZ = Number(collision.ground?.z);
                if (Number.isFinite(groundZ)) npc.feetZ = groundZ;
                if (collision.blocked) npc.retargetIn = 0.0;
            } else {
                npc.x = this._clampX(npc.x + dx * moveSpeed * step);
                npc.y = this._clampY(npc.y + dy * moveSpeed * step);
            }
        }
    }

    getById(id) {
        const key = String(id || '');
        return this.npcs.find((npc) => npc.id === key) || null;
    }

    applyNetworkSnapshot(snapshot) {
        if (!Array.isArray(snapshot)) return false;
        this.ensureDemoCrowd();
        const template = this.npcs[0] || null;
        const next = [];
        for (const state of snapshot) {
            let npc = this.getById(state?.id);
            if (!npc && template) npc = { ...template, id: String(state.id || `network_${next.length}`) };
            if (!npc) continue;
            const changed = npc.state !== String(state.state || 'wander');
            npc.x = finite(state.x, npc.x);
            npc.y = finite(state.y, npc.y);
            const networkFeetZ = finite(state.feetZ, npc.feetZ);
            const ground = this.collisionWorld?.resolveGround?.(npc.x, npc.y, networkFeetZ, {
                preferInterior: false,
                maxSnapDistance: 8.0,
                applyYbnCalibration: true,
            });
            npc.feetZ = Number.isFinite(Number(ground?.z)) ? Number(ground.z) : networkFeetZ;
            npc.heading = finite(state.heading, npc.heading);
            npc.health = clamp(finite(state.health, npc.health), 0, finite(state.maxHealth, 100));
            npc.maxHealth = finite(state.maxHealth, 100);
            npc.state = String(state.state || 'wander');
            npc.role = String(state.role || 'civilian');
            npc.weapon = String(state.weapon || '');
            npc.hostile = !!state.hostile;
            if (changed) {
                npc.stateElapsed = 0;
                npc.stateClip = npc.state === 'dead' ? 'melee_death_a' : npc.state === 'shooting' ? 'melee_npc_attack' : '';
            }
            if (npc.state === 'dead') {
                npc.ragdollGrounded = true;
                npc.ragdollPitch = NPC_PRONE_PITCH;
                npc.ragdollGroundPitch = NPC_PRONE_PITCH;
                npc.ragdollGroundOffsetZ = NPC_PRONE_GROUND_OFFSET;
            }
            next.push(npc);
        }
        this.npcs = next;
        this._crowdInitialized = next.length > 0;
        this._networkSnapshotAt = performance.now();
        return true;
    }

    findMeleeTarget({ origin, heading = 0.0, maxDistance = 2.3, coneDot = 0.0 } = {}) {
        const ox = Number(origin?.[0]);
        const oy = Number(origin?.[1]);
        if (!Number.isFinite(ox) || !Number.isFinite(oy)) return null;
        const fx = Math.cos(Number(heading) || 0.0);
        const fy = Math.sin(Number(heading) || 0.0);
        let best = null;
        let bestScore = Number.POSITIVE_INFINITY;
        for (const npc of this.npcs) {
            if (npc.state === 'dead' || npc.state === 'getting_up') continue;
            const dx = npc.x - ox;
            const dy = npc.y - oy;
            const distance = Math.hypot(dx, dy);
            if (distance < 1e-4 || distance > maxDistance) continue;
            const dot = (dx * fx + dy * fy) / distance;
            if (dot < coneDot) continue;
            const score = distance - dot * 0.45;
            if (score < bestScore) {
                bestScore = score;
                best = npc;
            }
        }
        return best;
    }

    raycast({ origin, direction, maxDistance = 90.0 } = {}) {
        if (!Array.isArray(origin) || !Array.isArray(direction) || origin.length < 3 || direction.length < 3) return null;
        const ox = Number(origin[0]); const oy = Number(origin[1]); const oz = Number(origin[2]);
        const dx = Number(direction[0]); const dy = Number(direction[1]); const dz = Number(direction[2]);
        const length = Math.hypot(dx, dy, dz);
        const distanceLimit = clamp(finite(maxDistance, 90.0), 0.1, 500.0);
        if (![ox, oy, oz, length].every(Number.isFinite) || length < 1e-5) return null;
        const unit = [dx / length, dy / length, dz / length];
        let best = null;

        for (const npc of this.npcs) {
            if (npc.state === 'dead') continue;
            const zones = [
                { name: 'head', center: [npc.x, npc.y, npc.feetZ + finite(npc.ragdollOffsetZ) + 1.56], radius: 0.24, multiplier: 2.2 },
                { name: 'torso', center: [npc.x, npc.y, npc.feetZ + finite(npc.ragdollOffsetZ) + 0.98], radius: 0.46, multiplier: 1.0 },
            ];
            for (const zone of zones) {
                const distance = this._raySphereDistance([ox, oy, oz], unit, zone.center, zone.radius, distanceLimit);
                if (distance === null || (best && distance >= best.distance)) continue;
                best = {
                    id: npc.id,
                    npc,
                    distance,
                    point: [ox + unit[0] * distance, oy + unit[1] * distance, oz + unit[2] * distance],
                    zone: zone.name,
                    damageMultiplier: zone.multiplier,
                };
            }
        }
        return best;
    }

    applyBulletHit(id, { damage = 38, direction = [1, 0], force = 5.4, zone = 'torso' } = {}) {
        const npc = this.getById(id);
        if (!npc || npc.state === 'dead') return { applied: false };
        const hitZone = String(zone) === 'head' ? 'head' : 'torso';
        this.reportCrime({ type: 'gunfire', severity: 2, origin: [npc.x, npc.y], victimId: npc.id });
        return this._applyImpact(npc, {
            damage,
            direction,
            force,
            source: 'bullet',
            zone: hitZone,
            deathClip: hitZone === 'head' ? 'melee_death_b' : 'melee_death_a',
        });
    }

    applyVehicleImpacts({ position, heading = 0.0, speed = 0.0, dt = 1 / 60 } = {}) {
        if (!Array.isArray(position) || position.length < 2) return [];
        const x = Number(position[0]); const y = Number(position[1]);
        const speedMps = finite(speed);
        const impactSpeed = Math.abs(speedMps);
        if (!Number.isFinite(x) || !Number.isFinite(y) || impactSpeed < 2.25) return [];

        const headingRad = finite(heading);
        const sign = speedMps >= 0.0 ? 1.0 : -1.0;
        const forwardX = Math.cos(headingRad) * sign;
        const forwardY = Math.sin(headingRad) * sign;
        const sweepReach = 2.35 + Math.min(2.6, impactSpeed * clamp(finite(dt, 1 / 60), 0.001, 0.05) * 1.35);
        const lethalImpact = impactSpeed >= NPC_VEHICLE_LETHAL_SPEED;
        const damage = lethalImpact
            ? 100
            : clamp(Math.round(12.0 + impactSpeed * 4.2), 18, 92);
        const force = clamp(2.4 + impactSpeed * 0.48, 3.0, 18.0);
        const impacts = [];

        for (const npc of this.npcs) {
            if (npc.state === 'dead'
                || npc.state === 'vehicle_hit'
                || npc.state === 'ragdoll'
                || npc.state === 'downed'
                || npc.state === 'getting_up'
                || finite(npc.impactCooldown) > 0.0) continue;
            const relX = npc.x - x;
            const relY = npc.y - y;
            const longitudinal = relX * forwardX + relY * forwardY;
            const lateral = Math.abs(relX * -forwardY + relY * forwardX);
            if (longitudinal < -1.2 || longitudinal > sweepReach || lateral > 1.42) continue;
            const result = this._applyImpact(npc, {
                damage,
                direction: [forwardX, forwardY],
                force,
                source: 'vehicle',
                zone: 'body',
                deathClip: impactSpeed >= 8.0 ? 'melee_death_b' : 'melee_death_a',
            });
            if (!result.applied) continue;
            npc.impactCooldown = 3.0;
            impacts.push({ id: npc.id, damage, lethal: result.lethal, speed: impactSpeed });
        }
        return impacts;
    }

    applyMeleeHit(id, { damage = 18, direction = [1, 0], force = 2.5, attackType = 'punch', knockdown = false } = {}) {
        const npc = this.getById(id);
        if (!npc || npc.state === 'dead' || npc.state === 'getting_up') return false;
        if (npc.state === 'knocked_out' || npc.state === 'knockdown') {
            npc.health = 0;
            npc.hostile = false;
            this._beginRagdollPhysics(npc, { force: Math.hypot(npc.knockbackX, npc.knockbackY), direction });
            this._settleRagdoll(npc);
            this._setState(npc, 'dead', NPC_CORPSE_SECONDS, npc.stateClip || 'melee_knockdown');
            return true;
        }
        npc.health = Math.max(0, finite(npc.health, 100) - Math.max(0, finite(damage, 18)));
        this.reportCrime({ type: 'assault', severity: 1, origin: [npc.x, npc.y], victimId: npc.id });
        npc.hostile = npc.role === 'police' || npc.courage > 0.58;
        if (!npc.hostile) npc.fleeRemaining = 12.0;
        npc.lastAttackType = String(attackType || 'punch');
        npc.knockbackX = finite(direction?.[0], 1.0) * finite(force, 2.5);
        npc.knockbackY = finite(direction?.[1], 0.0) * finite(force, 2.5);
        if (npc.health <= 0) {
            const kicked = attackType === 'front_kick';
            npc.ragdollLethal = true;
            npc.ragdollVX = npc.knockbackX * 0.55;
            npc.ragdollVY = npc.knockbackY * 0.55;
            npc.ragdollFallClip = kicked ? 'melee_knockdown_kick' : 'melee_knockdown';
            npc.ragdollFallDuration = kicked ? NPC_KICK_KNOCKDOWN_SECONDS : NPC_KNOCKDOWN_SECONDS;
            npc.ragdollDeathClip = kicked ? 'melee_death_b' : 'melee_death_a';
            this._beginRagdollPhysics(npc, { force: Math.hypot(npc.ragdollVX, npc.ragdollVY), airborne: false });
            this._setState(npc, 'ragdoll', npc.ragdollFallDuration, npc.ragdollFallClip);
            npc.hitRemaining = 0.0;
            npc.knockbackX = 0.0;
            npc.knockbackY = 0.0;
        } else if (knockdown) {
            npc.ragdollLethal = false;
            npc.ragdollFallClip = 'melee_knockdown_kick';
            npc.ragdollFallDuration = NPC_KICK_KNOCKDOWN_SECONDS;
            npc.downedDuration = 1.8;
            this._beginRagdollPhysics(npc, { force: Math.hypot(npc.knockbackX, npc.knockbackY), direction });
            this._setState(npc, 'ragdoll', npc.ragdollFallDuration, npc.ragdollFallClip);
            npc.hitRemaining = 0.0;
        } else {
            this._setState(npc, 'hit', attackType === 'front_kick' ? 0.62 : 0.42, this._reactionClipRelative(npc, direction));
            npc.hitRemaining = attackType === 'front_kick' ? 0.48 : 0.30;
        }
        return true;
    }

    reportCrime({ type = 'crime', severity = 1, origin = null, victimId = '' } = {}) {
        const amount = clamp(Math.round(finite(severity, 1)), 1, 3);
        this.wantedLevel = clamp(Math.max(this.wantedLevel, amount), 0, 5);
        this.wantedHeat = 28 + this.wantedLevel * 8;
        const ox = finite(origin?.[0], finite(this.app?.ped?.posData?.[0]));
        const oy = finite(origin?.[1], finite(this.app?.ped?.posData?.[1]));
        for (const npc of this.npcs) {
            if (npc.id === victimId || npc.state === 'dead' || npc.role === 'police') continue;
            const distance = Math.hypot(npc.x - ox, npc.y - oy);
            if (distance > (type === 'gunfire' ? 38 : 18)) continue;
            if (npc.courage > 0.82 && distance < 8) npc.hostile = true;
            else {
                npc.hostile = false;
                npc.fleeRemaining = Math.max(npc.fleeRemaining, 10 + this._random() * 8);
            }
        }
        return this.wantedLevel;
    }

    _ensurePoliceResponse(playerX, playerY) {
        if (!Number.isFinite(playerX) || !Number.isFinite(playerY)) return;
        const wantedCount = Math.min(MAX_LOCAL_POLICE, this.wantedLevel * 2);
        const allPolice = this.npcs.filter((npc) => npc.role === 'police');
        const existing = allPolice.filter((npc) => npc.state !== 'dead' && finite(npc.retireElapsed) <= 0).length;
        const template = this.npcs.find((npc) => npc.role === 'civilian');
        if (!template || existing >= wantedCount || allPolice.length >= MAX_LOCAL_POLICE) return;
        const angle = this._random() * TAU;
        const distance = 28 + this._random() * 16;
        const x = this._clampX(playerX + Math.cos(angle) * distance);
        const y = this._clampY(playerY + Math.sin(angle) * distance);
        const feetZ = this._groundAt(x, y, template.feetZ);
        const npc = {
            ...template,
            id: `police_${++this._policeSerial}`,
            x, y, feetZ,
            homeX: x, homeY: y,
            targetX: playerX, targetY: playerY,
            heading: Math.atan2(playerY - y, playerX - x),
            health: 100,
            state: 'hostile',
            role: 'police',
            groupId: 'police',
            courage: 1,
            weapon: this.wantedLevel >= 2 ? 'pistol' : '',
            hostile: true,
            fleeRemaining: 0,
            attackCooldown: 0.4 + this._random(),
            hitRemaining: 0,
            stateElapsed: 0,
            stateDuration: 0,
            ragdollLethal: false,
            ragdollOffsetZ: 0,
            ragdollPitch: 0,
            ragdollRoll: 0,
            retireElapsed: 0,
        };
        this._settleRagdoll(npc, { upright: true });
        this.npcs.push(npc);
    }

    _hasLineOfSightToPlayer(npc, distance) {
        const player = this.app?.ped?.posData;
        if (!player || distance <= 0.01) return false;
        const origin = [npc.x, npc.y, npc.feetZ + 1.35];
        const target = [Number(player[0]), Number(player[1]), Number(player[2])];
        const delta = target.map((value, index) => value - origin[index]);
        const length = Math.hypot(delta[0], delta[1], delta[2]);
        const direction = delta.map((value) => value / Math.max(0.001, length));
        try {
            const hit = this.collisionWorld?.raycast?.({ origin, direction, maxDistance: length });
            return !hit || !Number.isFinite(Number(hit.distance)) || Number(hit.distance) >= length - 0.12;
        } catch {
            return true;
        }
    }

    _applyImpact(npc, { damage = 0, direction = [1, 0], force = 0.0, source = 'impact', zone = 'body', deathClip = 'melee_death_a' } = {}) {
        if (!npc || npc.state === 'dead') return { applied: false };
        const appliedDamage = clamp(Math.round(Math.max(0.0, finite(damage))), 0, 100);
        const appliedForce = clamp(Math.max(0.0, finite(force)), 0.0, 18.0);
        const [dirX, dirY] = normalizeDirectionXY(direction);
        npc.health = Math.max(0, finite(npc.health, npc.maxHealth || 100) - appliedDamage);
        npc.hostile = npc.role === 'police' || npc.courage > 0.58;
        if (!npc.hostile && String(source) !== 'vehicle') npc.fleeRemaining = 12.0;
        npc.lastDamageSource = String(source || 'impact');
        npc.lastHitZone = String(zone || 'body');
        npc.ragdollLethal = npc.health <= 0;
        npc.ragdollVX = dirX * appliedForce;
        npc.ragdollVY = dirY * appliedForce;
        npc.ragdollFallClip = appliedForce >= 8.0 ? 'melee_knockdown_kick' : 'melee_knockdown';
        npc.ragdollFallDuration = appliedForce >= 8.0
            ? NPC_KICK_KNOCKDOWN_SECONDS
            : NPC_KNOCKDOWN_SECONDS;
        npc.downedDuration = clamp(1.15 + appliedForce * 0.08, 1.35, 2.35);
        npc.ragdollDeathClip = String(deathClip || 'melee_death_a');
        this._beginRagdollPhysics(npc, {
            force: appliedForce,
            airborne: String(source) === 'vehicle',
            direction: [dirX, dirY],
        });
        npc.hitRemaining = 0.0;
        npc.knockbackX = 0.0;
        npc.knockbackY = 0.0;
        if (String(source) === 'vehicle') {
            this._setState(npc, 'vehicle_hit', 0.42, this._reactionClipRelative(npc, [dirX, dirY]));
        } else {
            this._setState(npc, 'ragdoll', npc.ragdollFallDuration, npc.ragdollFallClip);
        }
        return {
            applied: true,
            damage: appliedDamage,
            health: npc.health,
            lethal: npc.ragdollLethal,
            state: npc.state,
        };
    }

    _beginRagdollPhysics(npc, { force = 0.0, airborne = false, direction = [1, 0] } = {}) {
        const appliedForce = clamp(finite(force), 0.0, 18.0);
        const [dirX, dirY] = normalizeDirectionXY(direction);
        npc.ragdollOffsetZ = 0.0;
        npc.ragdollVZ = airborne ? clamp(2.4 + appliedForce * 0.34, 3.2, 8.5) : 0.0;
        npc.ragdollPitch = NPC_PRONE_PITCH * 0.08;
        npc.ragdollRoll = 0.0;
        npc.ragdollGroundPitch = NPC_PRONE_PITCH;
        npc.ragdollGroundRoll = 0.0;
        npc.ragdollGroundOffsetZ = NPC_PRONE_GROUND_OFFSET;
        npc.ragdollPitchVelocity = airborne ? (3.0 + appliedForce * 0.17) : 0.0;
        npc.ragdollRollVelocity = airborne ? (dirX * dirY >= 0.0 ? 1.0 : -1.0) * (1.2 + appliedForce * 0.09) : 0.0;
        npc.ragdollGrounded = !airborne;
    }

    _updateRagdollPhysics(npc, dt, airDrag) {
        this._moveWithVelocity(npc, npc.ragdollVX, npc.ragdollVY, dt, 0.34, 0.4);
        const airborne = finite(npc.ragdollOffsetZ) > 0.0 || finite(npc.ragdollVZ) > 0.0;
        const horizontalDamping = Math.exp(-(airborne ? Math.max(0.15, airDrag * 0.24) : airDrag) * dt);
        npc.ragdollVX *= horizontalDamping;
        npc.ragdollVY *= horizontalDamping;

        npc.ragdollVZ = finite(npc.ragdollVZ) - 9.81 * dt;
        npc.ragdollOffsetZ = finite(npc.ragdollOffsetZ) + npc.ragdollVZ * dt;
        npc.ragdollPitch = finite(npc.ragdollPitch) + finite(npc.ragdollPitchVelocity) * dt;
        npc.ragdollRoll = finite(npc.ragdollRoll) + finite(npc.ragdollRollVelocity) * dt;

        if (npc.ragdollOffsetZ <= 0.0) {
            const impactSpeed = Math.max(0.0, -finite(npc.ragdollVZ));
            npc.ragdollOffsetZ = 0.0;
            if (impactSpeed > 3.0) {
                npc.ragdollVZ = Math.min(2.1, impactSpeed * 0.2);
                npc.ragdollVX *= 0.62;
                npc.ragdollVY *= 0.62;
                npc.ragdollPitchVelocity *= 0.38;
                npc.ragdollRollVelocity *= 0.38;
                npc.ragdollGrounded = false;
            } else {
                npc.ragdollVZ = 0.0;
                npc.ragdollGrounded = true;
            }
        } else {
            npc.ragdollGrounded = false;
        }

        if (npc.ragdollGrounded) {
            const settle = 1.0 - Math.exp(-8.0 * dt);
            npc.ragdollPitch += (finite(npc.ragdollGroundPitch) - npc.ragdollPitch) * settle;
            npc.ragdollRoll += (finite(npc.ragdollGroundRoll) - npc.ragdollRoll) * settle;
            npc.ragdollGroundOffsetZ += (NPC_PRONE_GROUND_OFFSET - finite(npc.ragdollGroundOffsetZ)) * settle;
            npc.ragdollPitchVelocity *= Math.exp(-10.0 * dt);
            npc.ragdollRollVelocity *= Math.exp(-10.0 * dt);
        }
    }

    _settleRagdoll(npc, { upright = false } = {}) {
        npc.ragdollOffsetZ = 0.0;
        npc.ragdollVZ = 0.0;
        if (upright) {
            npc.ragdollGroundPitch = 0.0;
            npc.ragdollGroundRoll = 0.0;
            npc.ragdollGroundOffsetZ = 0.0;
        }
        npc.ragdollPitch = finite(npc.ragdollGroundPitch);
        npc.ragdollRoll = finite(npc.ragdollGroundRoll);
        npc.ragdollPitchVelocity = 0.0;
        npc.ragdollRollVelocity = 0.0;
        npc.ragdollGrounded = true;
    }

    _blendRagdollToStanding(npc) {
        const progress = clamp(finite(npc.stateElapsed) / Math.max(0.001, finite(npc.stateDuration, 1.25)), 0.0, 1.0);
        const remain = 1.0 - progress;
        npc.ragdollPitch = finite(npc.ragdollGroundPitch) * remain;
        npc.ragdollRoll = finite(npc.ragdollGroundRoll) * remain;
        npc.ragdollGroundOffsetZ = NPC_PRONE_GROUND_OFFSET * remain;
    }

    _moveWithVelocity(npc, vx, vy, dt, radius = 0.34, maxStepUp = 0.4) {
        const collision = this.collisionWorld?.moveCapsule?.({
            x: npc.x,
            y: npc.y,
            feetZ: npc.feetZ,
            vx: finite(vx),
            vy: finite(vy),
            dt,
            radius,
            maxStepUp,
            maxSnapDistance: 3.0,
        });
        if (collision) {
            npc.x = finite(collision.x, npc.x);
            npc.y = finite(collision.y, npc.y);
            if (Number.isFinite(Number(collision.ground?.z))) npc.feetZ = Number(collision.ground.z);
            return collision;
        }
        npc.x = this._clampX(npc.x + finite(vx) * dt);
        npc.y = this._clampY(npc.y + finite(vy) * dt);
        return null;
    }

    _raySphereDistance(origin, direction, center, radius, maxDistance) {
        const toX = center[0] - origin[0];
        const toY = center[1] - origin[1];
        const toZ = center[2] - origin[2];
        const along = toX * direction[0] + toY * direction[1] + toZ * direction[2];
        if (along < 0.0 || along > maxDistance) return null;
        const closestX = origin[0] + direction[0] * along;
        const closestY = origin[1] + direction[1] * along;
        const closestZ = origin[2] + direction[2] * along;
        const lateralSq = (center[0] - closestX) ** 2 + (center[1] - closestY) ** 2 + (center[2] - closestZ) ** 2;
        const radiusSq = radius * radius;
        if (lateralSq > radiusSq) return null;
        return Math.max(0.0, along - Math.sqrt(radiusSq - lateralSq));
    }

    _respawn(npc) {
        npc.x = npc.homeX;
        npc.y = npc.homeY;
        npc.feetZ = this._groundAt(npc.x, npc.y, npc.feetZ);
        npc.health = npc.maxHealth;
        npc.hostile = false;
        npc.state = 'wander';
        npc.hitRemaining = 0.0;
        npc.downRemaining = 0.0;
        npc.attackCooldown = 0.0;
        npc.knockbackX = 0.0;
        npc.knockbackY = 0.0;
        npc.impactCooldown = 0.0;
        npc.ragdollLethal = false;
        npc.ragdollVX = 0.0;
        npc.ragdollVY = 0.0;
        this._settleRagdoll(npc, { upright: true });
        npc.ragdollFallClip = 'melee_knockdown';
        npc.ragdollFallDuration = NPC_KNOCKDOWN_SECONDS;
        npc.downedDuration = 1.5;
        npc.ragdollDeathClip = 'melee_death_a';
        npc.lastDamageSource = '';
        npc.lastHitZone = '';
        npc.stateElapsed = 0.0;
        npc.stateDuration = 0.0;
        npc.stateClip = '';
        npc.attackElapsed = 0.0;
        npc.attackRemaining = 0.0;
        this._chooseTarget(npc);
    }

    getAnimationPose(npc) {
        if (!npc) return null;
        if (npc.attackRemaining > 0.0) {
            return { clip: 'melee_npc_attack', progress: Math.min(1, npc.attackElapsed / NPC_MELEE_ATTACK_DURATION), phase: 'attack' };
        }
        if (!npc.stateClip) return null;
        if (npc.state === 'dead') return { clip: npc.stateClip, progress: 1.0, phase: 'dead' };
        let progress = Math.min(1, npc.stateElapsed / Math.max(0.001, npc.stateDuration));
        let clip = npc.stateClip;
        if (npc.state === 'vehicle_hit') {
            const clipDuration = clip === 'melee_hit_front' ? 2.2667 : 1.5;
            progress = Math.min(0.42, npc.stateElapsed / clipDuration);
        }
        if (npc.state === 'downed') {
            progress = (npc.stateElapsed / 13.0) % 1.0;
        }
        if (npc.state === 'ragdoll' && npc.ragdollGrounded) {
            progress = Math.max(progress, NPC_LANDED_POSE_PROGRESS);
        }
        if (npc.state === 'knocked_out' && npc.stateElapsed > 1.0) {
            clip = 'melee_writhe';
            progress = ((npc.stateElapsed - 1.0) / 3.0) % 1.0;
        }
        return { clip, progress, phase: npc.state };
    }

    _applyNpcMeleeImpact(npc) {
        const ped = this.app?.ped?.posData;
        if (!this._isPlayerAttackable() || !npc || !Array.isArray(ped) || ped.length < 2) return false;
        const dx = Number(ped[0]) - finite(npc.x);
        const dy = Number(ped[1]) - finite(npc.y);
        const distance = Math.hypot(dx, dy);
        if (!Number.isFinite(distance) || distance > NPC_MELEE_HIT_REACH) return false;
        return this.app?.meleeController?.receiveNpcHit?.(npc, 7 + Math.floor(this._random() * 5)) === true;
    }

    _isPlayerAttackable() {
        const melee = this.app?.meleeController;
        return !!this.app?.ped
            && !!this.app?.player?.enabled
            && String(melee?.lifeState || 'alive') === 'alive'
            && finite(melee?.playerHealth, 100) > 0;
    }

    _cancelNpcAttack(npc) {
        if (!npc) return;
        npc.attackRemaining = 0.0;
        npc.attackElapsed = 0.0;
        npc.attackDidHit = true;
        npc.attackCooldown = Math.max(0.75, finite(npc.attackCooldown));
        if (npc.state === 'attack' || npc.state === 'shooting' || npc.state === 'hostile') {
            this._setState(npc, 'wander');
        }
    }

    _disengageAllFromPlayer() {
        for (const npc of this.npcs) {
            if (npc.state === 'dead') continue;
            npc.hostile = false;
            this._cancelNpcAttack(npc);
            if (npc.role !== 'police' && finite(npc.retargetIn) <= 0) this._chooseTarget(npc);
        }
    }

    _retireUnneededPolice(step, playerAttackable) {
        const keepPolice = playerAttackable && this.wantedLevel > 0;
        for (let index = this.npcs.length - 1; index >= 0; index--) {
            const npc = this.npcs[index];
            if (npc.role !== 'police' || npc.state === 'dead') continue;
            if (keepPolice) {
                npc.retireElapsed = 0.0;
                continue;
            }
            npc.retireElapsed = finite(npc.retireElapsed) + step;
            npc.hostile = false;
            this._cancelNpcAttack(npc);
            if (npc.retireElapsed >= POLICE_RETIRE_SECONDS) this.npcs.splice(index, 1);
        }
    }

    _setState(npc, state, duration = 0.0, clip = '') {
        npc.state = state;
        npc.stateElapsed = 0.0;
        npc.stateDuration = state === 'dead'
            ? NPC_CORPSE_SECONDS
            : Math.max(0.0, finite(duration));
        npc.stateClip = String(clip || '');
    }

    _reactionClip(direction) {
        const x = finite(direction?.[0]);
        const y = finite(direction?.[1]);
        if (Math.abs(x) > Math.abs(y)) return x > 0 ? 'melee_hit_left' : 'melee_hit_right';
        return y > 0 ? 'melee_hit_front' : 'melee_hit_back';
    }

    _reactionClipRelative(npc, direction) {
        const [x, y] = normalizeDirectionXY(direction);
        const heading = finite(npc?.heading);
        const forward = x * Math.cos(heading) + y * Math.sin(heading);
        const right = x * -Math.sin(heading) + y * Math.cos(heading);
        if (Math.abs(forward) >= Math.abs(right)) return forward >= 0.0 ? 'melee_hit_back' : 'melee_hit_front';
        return right >= 0.0 ? 'melee_hit_left' : 'melee_hit_right';
    }

    _chooseTarget(npc) {
        const angle = this._random() * TAU;
        const radius = 7.0 + this._random() * 19.0;
        npc.targetX = this._clampX(npc.homeX + Math.cos(angle) * radius);
        npc.targetY = this._clampY(npc.homeY + Math.sin(angle) * radius);
        npc.retargetIn = 8.0 + this._random() * 10.0;
    }

    _groundAt(x, y, zHint) {
        const raw = this.collisionWorld?._getYbnGroundAtXY?.(x, y, zHint, 6.0);
        if (Number.isFinite(Number(raw))) return Number(raw) + (Number(this.collisionWorld?.ybnGroundOffset) || 0.0);
        const resolved = this.collisionWorld?.resolveGround?.(x, y, zHint, { preferInterior: false, maxSnapDistance: 8.0 });
        return Number.isFinite(Number(resolved?.z)) ? Number(resolved.z) : NaN;
    }

    _clampX(x) {
        const b = this.app?.spawnDistrictBounds;
        return b ? Math.max(b.minX + 2.0, Math.min(b.maxX - 2.0, x)) : x;
    }

    _clampY(y) {
        const b = this.app?.spawnDistrictBounds;
        return b ? Math.max(b.minY + 2.0, Math.min(b.maxY - 2.0, y)) : y;
    }

    _random() {
        let t = this._seed += 0x6d2b79f5;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
}

import { PedNavigationGraph } from './ped_navigation.js';

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
const MAX_LOCAL_POLICE = 4;
const POLICE_RETIRE_SECONDS = 6.0;
const POLICE_SPAWN_INTERVAL_SECONDS = 2.4;
const POLICE_AIM_SECONDS = 0.7;
const POLICE_SHOT_EFFECT_SECONDS = 0.12;
const NETWORK_INTERPOLATION_DELAY_MS = 120;
const NETWORK_EXTRAPOLATION_LIMIT_MS = 100;
const NETWORK_SNAPSHOT_STALE_MS = 500;
const NETWORK_SAMPLE_LIMIT = 8;
const NPC_STANDING_CAPSULE_HEIGHT = 1.8;
const NPC_GROUND_STEP_RISE = 1.15;
const NPC_GROUND_PENETRATION_EPSILON = 0.05;
// YCD collapse clips are relative to the animated root. The browser must carry
// the actor root into a prone pose or the sampled body remains standing upright.
const NPC_PRONE_PITCH = -Math.PI * 0.5;
// Collision feetZ is the ground plane; extra clearance lifts prone bodies.
const NPC_PRONE_GROUND_OFFSET = 0.0;
const AMBIENT_PED_MODEL_HASHES = Object.freeze([
    '3250873975', // a_m_y_skater_01
    '3014915558', // a_m_y_business_02
    '826475330',  // a_f_y_business_02
    '1068876755', // a_m_m_bevhills_02
    '1446741360', // a_f_y_tourist_01
]);
const POLICE_PED_MODEL_HASH = '1581098148';

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
        this._networkSequence = -1;
        this._networkAuthorityActive = false;
        this._playerWasAttackable = true;
        this._policeSpawnCooldown = 0.0;
        this._npcShotSerial = 0;
        this.shotEffects = [];
        this.lastShot = null;
        // Vehicle impacts must not linearly scan every streamed ped. Keep a
        // small data-space grid that is rebuilt after simulation/network steps.
        this._spatialGrid = new Map();
        this._spatialCellSize = 12.0;
        this._simulationLodStats = { near: 0, medium: 0, far: 0, skipped: 0 };
        this.navigation = new PedNavigationGraph();
        if (typeof window !== 'undefined') void this.navigation.load();
    }

    ensureDemoCrowd() {
        if (!this.enabled || !this.app?.spawnDistrictDemo) return false;
        const bounds = this.app.spawnDistrictBounds;
        const spawn = this.app?._spawnDistrictDescriptor?.spawn || null;
        const centerX = finite(spawn?.x, (finite(bounds?.minX) + finite(bounds?.maxX)) * 0.5);
        const centerY = finite(spawn?.y, (finite(bounds?.minY) + finite(bounds?.maxY)) * 0.5);
        const eye = Math.max(0.5, finite(this.app?.pedEyeHeightData, 1.2));
        const baseZ = Number.isFinite(Number(spawn?.feetZ))
            ? Number(spawn.feetZ)
            : Number.isFinite(Number(spawn?.pedZ))
                ? Number(spawn.pedZ) - eye
                : finite(this.app?.ped?.posData?.[2], 31.0) - eye;
        if (!bounds) return false;

        const offsets = [[14, 8], [-15, 6], [23, -15], [-20, -18], [8, 28], [-27, 19]];
        const existingIds = new Set(this.npcs.map((npc) => String(npc?.id || '')));
        for (let i = 0; i < offsets.length; i++) {
            const id = `ambient_${i + 1}`;
            if (existingIds.has(id)) continue;
            const x = this._clampX(centerX + offsets[i][0]);
            const y = this._clampY(centerY + offsets[i][1]);
            const groundZ = this._groundAt(x, y, baseZ);
            const npc = {
                id,
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
                modelHash: AMBIENT_PED_MODEL_HASHES[i % AMBIENT_PED_MODEL_HASHES.length],
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
        // Keep the bounded demo populated after a corpse expires or a collision
        // tile arrives a frame later. IDs make this safe to call every update.
        this._crowdInitialized = true;
        return true;
    }

    clear() {
        this.npcs.length = 0;
        this._crowdInitialized = false;
        this.wantedLevel = 0;
        this.wantedHeat = 0;
        this.shotEffects.length = 0;
        this.lastShot = null;
        this._spatialGrid.clear();
    }

    _rebuildSpatialGrid() {
        const grid = new Map();
        const cellSize = this._spatialCellSize;
        for (const npc of this.npcs) {
            if (!npc || !Number.isFinite(npc.x) || !Number.isFinite(npc.y)) continue;
            const key = `${Math.floor(npc.x / cellSize)}:${Math.floor(npc.y / cellSize)}`;
            let bucket = grid.get(key);
            if (!bucket) { bucket = []; grid.set(key, bucket); }
            bucket.push(npc);
        }
        this._spatialGrid = grid;
    }

    _querySpatialGrid(minX, minY, maxX, maxY) {
        if (!this._spatialGrid.size) return this.npcs;
        const cellSize = this._spatialCellSize;
        const gx0 = Math.floor(finite(minX) / cellSize);
        const gy0 = Math.floor(finite(minY) / cellSize);
        const gx1 = Math.floor(finite(maxX) / cellSize);
        const gy1 = Math.floor(finite(maxY) / cellSize);
        const result = [];
        for (let gy = gy0; gy <= gy1; gy++) {
            for (let gx = gx0; gx <= gx1; gx++) {
                const bucket = this._spatialGrid.get(`${gx}:${gy}`);
                if (bucket?.length) result.push(...bucket);
            }
        }
        return result;
    }

    _npcSimulationInterval(npc, playerX, playerY) {
        if (npc?.hostile || npc?.weapon || ['attack', 'shooting', 'vehicle_hit', 'ragdoll', 'downed', 'getting_up'].includes(String(npc?.state || ''))) return 0;
        const distance = Math.hypot(finite(npc?.x) - playerX, finite(npc?.y) - playerY);
        if (distance <= 60) return 0;
        if (distance <= 180) return 0.1;
        return 0.5;
    }

    getSimulationLodStats() {
        return { ...this._simulationLodStats, gridCells: this._spatialGrid.size };
    }

    update(dt) {
        if (!this.enabled) return;
        this.ensureDemoCrowd();
        const step = Math.max(0.001, Math.min(0.05, finite(dt, 1 / 60)));
        this._policeSpawnCooldown = Math.max(0.0, this._policeSpawnCooldown - step);
        for (const effect of this.shotEffects) effect.remaining = Math.max(0.0, finite(effect.remaining) - step);
        this.shotEffects = this.shotEffects.filter((effect) => effect.remaining > 0.0);
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
        const networkNow = performance.now();
        const networkFresh = this._networkAuthorityActive
            && networkNow - this._networkSnapshotAt <= NETWORK_SNAPSHOT_STALE_MS
            && this.npcs.length > 0
            && this.npcs.every((npc) => Array.isArray(npc?._networkSamples) && npc._networkSamples.length > 0);
        if (networkFresh) {
            for (const npc of this.npcs) {
                this._updateNetworkTransform(npc, networkNow);
                npc.stateElapsed = finite(npc.stateElapsed) + step;
            }
            this._rebuildSpatialGrid();
            return;
        }
        // A stalled websocket should return control to local simulation quickly.
        // Keeping old samples here would blend a resumed snapshot from a stale
        // world position and produce the same apparent teleport.
        if (this._networkAuthorityActive) {
            this._networkAuthorityActive = false;
            for (const npc of this.npcs) delete npc._networkSamples;
        }
        this.wantedHeat = Math.max(0, this.wantedHeat - step);
        if (this.wantedLevel > 0 && this.wantedHeat <= 0) {
            this.wantedLevel--;
            this.wantedHeat = this.wantedLevel > 0 ? 22 : 0;
        }
        if (playerAttackable && this.wantedLevel > 0) this._ensurePoliceResponse(playerX, playerY);

        const lodStats = { near: 0, medium: 0, far: 0, skipped: 0 };
        for (let npcIndex = this.npcs.length - 1; npcIndex >= 0; npcIndex--) {
            const npc = this.npcs[npcIndex];
            // Destination collision often finishes streaming after the crowd
            // templates are created. Reconcile at a bounded cadence so a
            // temporary server/template Z cannot become permanent presentation
            // authority (the source of floating and half-buried pedestrians).
            npc.groundReconcileIn = finite(npc.groundReconcileIn) - step;
            if (npc.groundReconcileIn <= 0.0) {
                npc.feetZ = this._groundAt(npc.x, npc.y, npc.feetZ);
                npc.groundReconcileIn = 0.35 + this._random() * 0.25;
            }
            npc.attackCooldown = Math.max(0.0, finite(npc.attackCooldown) - step);
            npc.shotPulse = Math.max(0.0, finite(npc.shotPulse) - step);
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

            const lodInterval = this._npcSimulationInterval(npc, playerX, playerY);
            if (lodInterval <= 0) {
                lodStats.near++;
                npc._simulationAccumulator = 0.0;
            } else {
                const distance = Math.hypot(finite(npc.x) - playerX, finite(npc.y) - playerY);
                if (distance <= 180) lodStats.medium++;
                else lodStats.far++;
                npc._simulationAccumulator = finite(npc._simulationAccumulator) + step;
                if (npc._simulationAccumulator + 1e-6 < lodInterval) {
                    lodStats.skipped++;
                    continue;
                }
                // Preserve travel distance while running the far AI less often.
                npc._simulationDt = Math.min(0.55, npc._simulationAccumulator);
                npc._simulationAccumulator = 0.0;
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

            const simulationStep = lodInterval > 0 ? Math.max(step, finite(npc._simulationDt, step)) : step;
            npc._simulationDt = 0.0;
            npc.retargetIn -= simulationStep;
            const fleeing = npc.fleeRemaining > 0 && Number.isFinite(playerX) && Number.isFinite(playerY);
            const navWaypoint = !fleeing && !npc.hostile ? this._currentNavigationWaypoint(npc) : null;
            let dx = fleeing ? npc.x - playerX : npc.hostile && Number.isFinite(playerX) ? playerX - npc.x : finite(navWaypoint?.[0], npc.targetX) - npc.x;
            let dy = fleeing ? npc.y - playerY : npc.hostile && Number.isFinite(playerY) ? playerY - npc.y : finite(navWaypoint?.[1], npc.targetY) - npc.y;
            let distance = Math.hypot(dx, dy);
            if (navWaypoint && distance < 0.65) {
                npc.navPathIndex = Math.min((npc.navPath?.length || 1) - 1, finite(npc.navPathIndex) + 1);
                const nextWaypoint = this._currentNavigationWaypoint(npc);
                dx = finite(nextWaypoint?.[0], npc.targetX) - npc.x;
                dy = finite(nextWaypoint?.[1], npc.targetY) - npc.y;
                distance = Math.hypot(dx, dy);
            }
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
                npc.aimElapsed = finite(npc.aimElapsed) + step;
                if (npc.attackCooldown <= 0.0 && npc.aimElapsed >= POLICE_AIM_SECONDS && this._hasLineOfSightToPlayer(npc, distance)) {
                    npc.attackCooldown = 1.05 + this._random() * 0.7;
                    this._fireNpcPistol(npc, distance);
                }
                continue;
            }
            npc.aimElapsed = 0.0;
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
            const turn = 1.0 - Math.exp(-7.0 * simulationStep);
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
                dt: simulationStep,
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
                npc.x = this._clampX(npc.x + dx * moveSpeed * simulationStep);
                npc.y = this._clampY(npc.y + dy * moveSpeed * simulationStep);
            }
        }
        this._simulationLodStats = lodStats;
        this._rebuildSpatialGrid();
    }

    getById(id) {
        const key = String(id || '');
        return this.npcs.find((npc) => npc.id === key) || null;
    }

    applyNetworkSnapshot(snapshot, metadata = null) {
        if (!Array.isArray(snapshot)) return false;
        const sequence = Number(metadata?.sequence);
        if (Number.isFinite(sequence) && sequence <= this._networkSequence) return false;
        if (Number.isFinite(sequence)) this._networkSequence = sequence;
        this.ensureDemoCrowd();
        const now = performance.now();
        const template = this.npcs[0] || null;
        const next = [];
        for (const state of snapshot) {
            let npc = this.getById(state?.id);
            const isNew = !npc;
            if (!npc && template) {
                npc = { ...template, id: String(state.id || `network_${next.length}`) };
                delete npc._networkSamples;
            }
            if (!npc) continue;
            const changed = npc.state !== String(state.state || 'wander');
            const targetX = finite(state.x, npc.x);
            const targetY = finite(state.y, npc.y);
            // Preserve the server sample here. Presentation grounding is applied
            // after interpolation only when the local YBN has a plausible floor.
            const targetFeetZ = finite(state.feetZ, npc.feetZ);
            const targetHeading = finite(state.heading, npc.heading);
            const samples = Array.isArray(npc._networkSamples) ? npc._networkSamples : [];
            if (isNew || !samples.length) {
                npc.x = targetX;
                npc.y = targetY;
                npc.feetZ = targetFeetZ;
                npc.heading = targetHeading;
            }
            const previousSample = samples[samples.length - 1];
            samples.push({
                at: Math.max(now, finite(previousSample?.at, now - 1) + 1),
                sequence: finite(metadata?.sequence, 0),
                x: targetX,
                y: targetY,
                feetZ: targetFeetZ,
                heading: targetHeading,
            });
            if (samples.length > NETWORK_SAMPLE_LIMIT) samples.splice(0, samples.length - NETWORK_SAMPLE_LIMIT);
            npc._networkSamples = samples;
            if (now >= finite(npc._networkGroundRefreshAt)) {
                npc._networkGroundZ = this._networkGroundAt(targetX, targetY, targetFeetZ);
                npc._networkGroundRefreshAt = now + 350 + (next.length % 4) * 55;
            }
            npc.feetZ = finite(npc._networkGroundZ, targetFeetZ);
            npc.health = clamp(finite(state.health, npc.health), 0, finite(state.maxHealth, 100));
            npc.maxHealth = finite(state.maxHealth, 100);
            npc.state = String(state.state || 'wander');
            npc.role = String(state.role || 'civilian');
            npc.modelHash = String(state.modelHash || npc.modelHash || AMBIENT_PED_MODEL_HASHES[next.length % AMBIENT_PED_MODEL_HASHES.length]);
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
        this._networkAuthorityActive = next.length > 0;
        this._networkSnapshotAt = now;
        return true;
    }

    getNetworkStatus(now = performance.now()) {
        return {
            authoritative: this._networkAuthorityActive,
            ageMs: this._networkSnapshotAt ? Math.max(0, now - this._networkSnapshotAt) : null,
            sequence: this._networkSequence,
            sampled: this.npcs.filter((npc) => Array.isArray(npc?._networkSamples) && npc._networkSamples.length > 0).length,
        };
    }

    _updateNetworkTransform(npc, now) {
        const samples = npc?._networkSamples;
        if (!Array.isArray(samples) || !samples.length) return;
        const renderAt = now - NETWORK_INTERPOLATION_DELAY_MS;
        while (samples.length > 2 && finite(samples[1]?.at, now) <= renderAt) samples.shift();
        const from = samples[0];
        const to = samples[1] || from;
        const span = Math.max(1, finite(to.at, now) - finite(from.at, now));
        let t = (renderAt - finite(from.at, now)) / span;
        if (samples.length < 2) t = 1.0;
        else if (t > 1.0) t = 1.0 + Math.min(NETWORK_EXTRAPOLATION_LIMIT_MS, renderAt - finite(to.at, renderAt)) / span;
        t = Math.max(0.0, t);
        npc.x = finite(from.x, npc.x) + (finite(to.x, npc.x) - finite(from.x, npc.x)) * t;
        npc.y = finite(from.y, npc.y) + (finite(to.y, npc.y) - finite(from.y, npc.y)) * t;
        const serverFeetZ = finite(from.feetZ, npc.feetZ) + (finite(to.feetZ, npc.feetZ) - finite(from.feetZ, npc.feetZ)) * t;
        npc.networkFeetZ = serverFeetZ;
        if (now >= finite(npc._networkGroundRefreshAt)) {
            npc._networkGroundZ = this._networkGroundAt(npc.x, npc.y, serverFeetZ);
            npc._networkGroundRefreshAt = now + 350 + (String(npc.id || '').length % 4) * 55;
        }
        npc.feetZ = finite(npc._networkGroundZ, serverFeetZ);
        const fromHeading = finite(from.heading, npc.heading);
        const toHeading = finite(to.heading, fromHeading);
        const headingDelta = Math.atan2(Math.sin(toHeading - fromHeading), Math.cos(toHeading - fromHeading));
        npc.heading = fromHeading + headingDelta * t;
    }

    findMeleeTarget({ origin, heading = 0.0, maxDistance = 2.3, coneDot = 0.0 } = {}) {
        const ox = Number(origin?.[0]);
        const oy = Number(origin?.[1]);
        if (!Number.isFinite(ox) || !Number.isFinite(oy)) return null;
        const fx = Math.cos(Number(heading) || 0.0);
        const fy = Math.sin(Number(heading) || 0.0);
        let best = null;
        let bestScore = Number.POSITIVE_INFINITY;
        // Targeting shares the NPC grid with vehicle impacts, but its query is
        // centered on the attacker rather than a vehicle's swept chassis.
        const reach = Math.max(0.1, finite(maxDistance, 2.3)) + 0.25;
        const candidates = this._querySpatialGrid(
            ox - reach,
            oy - reach,
            ox + reach,
            oy + reach,
        );
        for (const npc of candidates) {
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
                { name: 'head', center: [npc.x, npc.y, npc.feetZ + finite(npc.ragdollOffsetZ) + 1.56], radius: 0.28, multiplier: 2.2 },
                { name: 'torso', center: [npc.x, npc.y, npc.feetZ + finite(npc.ragdollOffsetZ) + 1.10], radius: 0.52, multiplier: 1.0 },
                { name: 'torso', center: [npc.x, npc.y, npc.feetZ + finite(npc.ragdollOffsetZ) + 0.68], radius: 0.42, multiplier: 1.0 },
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
        this.reportCrime({
            type: 'gunfire',
            severity: npc.role === 'police' ? 2 : 1,
            origin: [npc.x, npc.y],
            victimId: npc.id,
        });
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
        const wantedCount = Math.min(MAX_LOCAL_POLICE, this.wantedLevel + 1);
        const allPolice = this.npcs.filter((npc) => npc.role === 'police');
        const existing = allPolice.filter((npc) => npc.state !== 'dead' && finite(npc.retireElapsed) <= 0).length;
        const template = this.npcs.find((npc) => npc.role === 'civilian');
        if (!template || existing >= wantedCount || allPolice.length >= MAX_LOCAL_POLICE || this._policeSpawnCooldown > 0.0) return;
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
            modelHash: POLICE_PED_MODEL_HASH,
            groupId: 'police',
            courage: 1,
            weapon: this.wantedLevel >= 2 ? 'pistol' : '',
            hostile: true,
            fleeRemaining: 0,
            attackCooldown: 0.4 + this._random(),
            aimElapsed: 0,
            shotPulse: 0,
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
        this._policeSpawnCooldown = POLICE_SPAWN_INTERVAL_SECONDS;
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
            return false;
        }
    }

    _fireNpcPistol(npc, distance) {
        const player = this.app?.ped?.posData;
        if (!npc || !Array.isArray(player) || player.length < 3 || !this._isPlayerAttackable()) return false;
        const forward = [Math.cos(finite(npc.heading)), Math.sin(finite(npc.heading))];
        const origin = [npc.x + forward[0] * 0.36, npc.y + forward[1] * 0.36, npc.feetZ + 1.34];
        const accuracy = clamp(0.48 - Math.max(0.0, finite(distance) - 3.0) * 0.018 + this.wantedLevel * 0.025, 0.18, 0.52);
        const hitPlayer = this._random() < accuracy;
        const missSide = hitPlayer ? 0.0 : (this._random() * 2.0 - 1.0) * (0.65 + finite(distance) * 0.065);
        const missHeight = hitPlayer ? 0.0 : (this._random() * 2.0 - 1.0) * 0.75;
        const target = [
            finite(player[0]) - forward[1] * missSide,
            finite(player[1]) + forward[0] * missSide,
            finite(player[2]) + 1.02 + missHeight,
        ];
        const shot = {
            id: `npc_shot_${++this._npcShotSerial}`,
            npcId: String(npc.id || ''),
            startData: origin,
            endData: target,
            remaining: POLICE_SHOT_EFFECT_SECONDS,
            duration: POLICE_SHOT_EFFECT_SECONDS,
            hit: hitPlayer,
        };
        this.shotEffects.push(shot);
        this.lastShot = shot;
        npc.shotPulse = 0.34;
        if (hitPlayer) {
            const damage = 8 + Math.floor(this._random() * 5);
            this.app?.meleeController?.receiveNpcHit?.(npc, damage);
        }
        return true;
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
        if (String(source) === 'bullet' && !npc.ragdollLethal) {
            npc.knockbackX = dirX * appliedForce * 0.22;
            npc.knockbackY = dirY * appliedForce * 0.22;
            npc.hitRemaining = String(zone) === 'head' ? 0.52 : 0.34;
            npc.ragdollVX = 0.0;
            npc.ragdollVY = 0.0;
            this._settleRagdoll(npc, { upright: true });
            this._setState(npc, 'hit', npc.hitRemaining, this._reactionClipRelative(npc, [dirX, dirY]));
            return {
                applied: true,
                damage: appliedDamage,
                health: npc.health,
                lethal: false,
                state: npc.state,
            };
        }
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
        npc.aimElapsed = 0.0;
        npc.shotPulse = 0.0;
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
        if (npc.state === 'shooting') {
            const firing = finite(npc.shotPulse) > 0.0;
            return {
                armed: true,
                melee: false,
                clip: firing ? 'fire_idle' : 'aim_idle',
                progress: firing ? clamp(1.0 - finite(npc.shotPulse) / 0.34, 0.0, 1.0) : 0.55,
                phase: 'equipped',
                aiming: true,
                firing,
            };
        }
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
        npc.aimElapsed = 0.0;
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
        const route = this.navigation?.route?.(npc.x, npc.y, npc.feetZ, () => this._random()) || [];
        if (route.length > 1) {
            npc.navPath = route;
            npc.navPathIndex = 1;
            const destination = route[route.length - 1];
            npc.targetX = this._clampX(destination[0]);
            npc.targetY = this._clampY(destination[1]);
            npc.retargetIn = 12.0 + this._random() * 12.0;
            return;
        }
        const angle = this._random() * TAU;
        const radius = 7.0 + this._random() * 19.0;
        npc.targetX = this._clampX(npc.homeX + Math.cos(angle) * radius);
        npc.targetY = this._clampY(npc.homeY + Math.sin(angle) * radius);
        npc.navPath = null;
        npc.navPathIndex = 0;
        npc.retargetIn = 8.0 + this._random() * 10.0;
    }

    _currentNavigationWaypoint(npc) {
        if (!Array.isArray(npc?.navPath) || !npc.navPath.length) return null;
        const index = clamp(Math.round(finite(npc.navPathIndex)), 0, npc.navPath.length - 1);
        return npc.navPath[index] || null;
    }

    _groundAt(x, y, zHint) {
        const options = {
            preferInterior: true,
            maxSnapDistance: 12.0,
            maxRise: NPC_GROUND_STEP_RISE,
            maxDrop: 12.0,
            nearestToHint: false,
        };
        const resolved = this.collisionWorld?.resolveGround?.(x, y, zHint, options);
        const resolvedZ = Number(resolved?.z);
        // A normal movement step may rise only 1.15 m, but an NPC can arrive
        // below an already-overlapping authored floor (for example when a
        // lower terrain/YBN layer wins before the street tile is resident).
        // Query only through the standing capsule and depenetrate upward to the
        // highest surface crossing that capsule. This fixes buried peds without
        // granting the ability to step or teleport onto roofs above their head.
        const recovery = this.collisionWorld?.resolveGround?.(x, y, zHint, {
            ...options,
            maxRise: NPC_STANDING_CAPSULE_HEIGHT - NPC_GROUND_PENETRATION_EPSILON,
        });
        const recoveryZ = Number(recovery?.z);
        if (Number.isFinite(recoveryZ)
            && (!Number.isFinite(resolvedZ) || recoveryZ > resolvedZ + NPC_GROUND_PENETRATION_EPSILON)) {
            return recoveryZ;
        }
        if (Number.isFinite(resolvedZ)) return resolvedZ;
        // The FiveM profile's root height is the only reliable fallback while a
        // local YBN tile is still loading. Skipping the ped entirely here made
        // the visible crowd disappear permanently after an unlucky first frame.
        return finite(zHint, finite(this.app?._spawnDistrictDescriptor?.spawn?.pedZ, 31.0));
    }

    _networkGroundAt(x, y, serverFeetZ) {
        return this._groundAt(x, y, serverFeetZ);
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

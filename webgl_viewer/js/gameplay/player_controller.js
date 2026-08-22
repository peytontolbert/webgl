import { glMatrix } from '../glmatrix.js';

function finite(n, fallback = 0.0) {
    const v = Number(n);
    return Number.isFinite(v) ? v : fallback;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, finite(value)));
}

function shortestAngle(from, to) {
    let delta = (finite(to) - finite(from)) % (Math.PI * 2.0);
    if (delta > Math.PI) delta -= Math.PI * 2.0;
    if (delta < -Math.PI) delta += Math.PI * 2.0;
    return delta;
}

function moveToward(current, target, maxDelta) {
    const delta = finite(target) - finite(current);
    const step = Math.max(0.0, finite(maxDelta));
    if (Math.abs(delta) <= step) return finite(target);
    return finite(current) + Math.sign(delta) * step;
}

function smoothstep(min, max, value) {
    const span = Math.max(1e-5, finite(max) - finite(min));
    const t = clamp((finite(value) - finite(min)) / span, 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

function angleFromQuaternionXYWZ(frame) {
    const x = finite(frame?.[3]);
    const y = finite(frame?.[4]);
    const z = finite(frame?.[5]);
    const w = finite(frame?.[6], 1.0);
    return Math.atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z));
}

function rootMotionFrame(rootMotion, progress) {
    const frames = Array.isArray(rootMotion?.frames) ? rootMotion.frames : [];
    if (frames.length < 2) return null;
    const scaled = clamp(progress, 0.0, 1.0) * (frames.length - 1);
    const lo = Math.floor(scaled);
    const hi = Math.min(frames.length - 1, lo + 1);
    const t = scaled - lo;
    const left = frames[lo];
    const right = frames[hi];
    if (!Array.isArray(left) || !Array.isArray(right) || left.length < 7 || right.length < 7) return null;
    const out = new Array(7);
    for (let i = 0; i < 7; i++) out[i] = finite(left[i]) + (finite(right[i]) - finite(left[i])) * t;
    const qLength = Math.hypot(out[3], out[4], out[5], out[6]);
    if (qLength < 1e-5) return null;
    out[3] /= qLength;
    out[4] /= qLength;
    out[5] /= qLength;
    out[6] /= qLength;
    return out;
}

export class PlayerController {
    constructor(app, collisionWorld) {
        this.app = app;
        this.collisionWorld = collisionWorld;
        // World displacement is owned by this scalar rather than by a free
        // camera-space velocity vector. That keeps the feet travelling in the
        // direction the ped is visibly facing, including during hard turns.
        this._forwardSpeed = 0.0;
        this._aimVelocity = [0.0, 0.0];
        this._hadLocomotionInput = false;
        this._lastLocomotionGait = 'walk';
        this._lastGroundContact = null;
    }

    reset() {
        this._forwardSpeed = 0.0;
        this._aimVelocity[0] = 0.0;
        this._aimVelocity[1] = 0.0;
        this._hadLocomotionInput = false;
        this._lastLocomotionGait = 'walk';
        this._lastGroundContact = null;
        if (this.app?.player) this.app.player._locomotionTransition = null;
    }

    update(dt) {
        const app = this.app;
        if (!app?.ped) return false;
        dt = clamp(dt, 0.0, 0.1);
        if (app.vehicleController?.inVehicle) {
            this.reset();
            app.vehicleController.syncOccupantPed?.();
            return true;
        }
        if (app.meleeController?.lifeState && app.meleeController.lifeState !== 'alive') {
            this.reset();
            app._resetPedMotion?.();
            if (app.player) {
                app.player.animGait = 'idle';
                app.player._sprintRequested = false;
            }
            return true;
        }
        if (app.player?.handsUp) {
            this.reset();
            app._resetPedMotion?.();
            return true;
        }
        if (app.phoneController?.active) {
            // The exported phone dictionaries are standing full-body clips.
            // Keep gameplay motion at rest until phone locomotion clips exist,
            // rather than allowing the collision capsule to move under a
            // stationary skinned pose.
            this.reset();
            app._pedVelocityData = [0.0, 0.0, 0.0];
            if (app.player) {
                app.player.animGait = 'idle';
                app.player.animMove01 = 0.0;
                app.player.animSpeed = 0.0;
                app.player._sprintRequested = false;
            }
            return true;
        }
        if (app.adminNoclipEnabled) {
            this.reset();
            return this._updateNoclip(dt);
        }

        const cfg = app.gameplayMoveConfig || {};
        const profile = app.vehicleController?.getMovementProfile?.() || {};
        const ks = app.keyState || {};

        const inputRight = (ks['d'] ? 1 : 0) - (ks['a'] ? 1 : 0);
        const inputForward = (ks['w'] ? 1 : 0) - (ks['s'] ? 1 : 0);
        const inputLen = Math.hypot(inputRight, inputForward);
        const hasInput = inputLen > 1e-5;

        const vel = app._pedVelocityData || [0, 0, 0];
        let desiredVx = 0.0;
        let desiredVy = 0.0;
        let desiredForwardSpeed = 0.0;
        let locomotionHeading = finite(app.player?.headingRad, 0.0);
        let targetHeading = locomotionHeading;
        let aiming = !!app.weaponController?.isAiming?.();
        let requestedGait = 'idle';
        let movementAcceleration = finite(profile.braking, finite(cfg.braking, 7.5));
        let turnDelta = 0.0;
        let moveDirection = null;
        if (hasInput) {
            const invInput = 1.0 / inputLen;
            const { fx, fy, rx, ry } = this._cameraBasisData();
            let dx = (inputRight * invInput) * rx + (inputForward * invInput) * fx;
            let dy = (inputRight * invInput) * ry + (inputForward * invInput) * fy;
            const dLen = Math.hypot(dx, dy) || 1.0;
            dx /= dLen;
            dy /= dLen;

            const slow = !!(ks['control'] || ks['ctrl'] || ks['alt']);
            // The browser contract keeps the lower-speed native walk loop as
            // the baseline and promotes it to the native run loop while Shift
            // is held. This matches the demo input contract and keeps the
            // simulated displacement in step with the displayed YCD cadence.
            const run = !!ks['shift'] && !slow;
            const weaponMovementScale = finite(app.weaponController?.getMovementScale?.(), 1.0);
            const meleeMovementScale = finite(app.meleeController?.getMovementScale?.(), 1.0);
            const wheelScale = app.player?.weaponWheelOpen ? 0.2 : 1.0;
            const running = run && wheelScale === 1.0;
            requestedGait = running ? 'run' : 'walk';
            const baseSpeed = this._nativeGaitSpeed({ cfg, profile, gait: requestedGait });
            const speed = baseSpeed * weaponMovementScale * meleeMovementScale * wheelScale;
            const acceleration = this._accelerationFor({ cfg, profile, gait: requestedGait, aiming });
            movementAcceleration = acceleration;
            if (app.player) {
                targetHeading = Math.atan2(dy, dx);
                moveDirection = { dx, dy, speed };
                turnDelta = shortestAngle(finite(app.player.headingRad, targetHeading), targetHeading);
                app.player._locomotionGait = requestedGait;
                app.player._sprintRequested = false;
            }
        } else if (app.player) {
            app.player._lastMoveDirData = [0, 0, 0];
            app.player._locomotionGait = 'idle';
            app.player._sprintRequested = false;
        }

        // Advance the sampled one-shot before calculating this frame's motion.
        // The old order accelerated on the first input frame, then reset velocity
        // on the next frame when the start clip was finally created.
        this._updateLocomotionTransition({
            dt,
            hasInput,
            aiming,
            gait: requestedGait,
            turnDelta,
            targetHeading,
            speed: Math.hypot(finite(vel[0]), finite(vel[1])),
        });

        if (hasInput && app.player && moveDirection) {
            const { dx, dy, speed } = moveDirection;
            if (aiming) {
                // GTA permits camera-relative strafing while aiming. Keep this
                // separate from ordinary locomotion, which must rotate first.
                desiredVx = dx * speed;
                desiredVy = dy * speed;
                app.player._lastMoveDirData = [dx, dy, 0.0];
            } else {
                const currentHeading = finite(app.player.headingRad, targetHeading);
                const transitionHeading = this._locomotionTransitionHeading(currentHeading);
                const turnRate = this._turnRateFor({ cfg, profile, gait: requestedGait, aiming: false });
                const heading = Number.isFinite(transitionHeading)
                    ? transitionHeading
                    : currentHeading + clamp(
                        shortestAngle(currentHeading, targetHeading),
                        -turnRate * dt,
                        turnRate * dt,
                    );
                app.player.headingRad = heading;
                const remaining = shortestAngle(heading, targetHeading);
                locomotionHeading = heading;
                // GTA turns the body before committing to a new movement line.
                // A reversal is allowed to rotate in place until the torso has
                // substantially caught up with its requested travel direction.
                const facing = Math.max(0.0, Math.cos(remaining));
                const turnCommit = smoothstep(0.18, 0.88, facing);
                const reversing = Math.abs(turnDelta) > 2.15;
                desiredForwardSpeed = speed * (reversing && Math.abs(remaining) > 0.82 ? 0.0 : turnCommit);
                desiredVx = Math.cos(heading) * desiredForwardSpeed;
                desiredVy = Math.sin(heading) * desiredForwardSpeed;
                app.player._lastMoveDirData = [Math.cos(heading), Math.sin(heading), 0.0];
            }
        }

        const braking = finite(profile.braking, finite(cfg.braking, 7.5));
        if (aiming) {
            // Aiming deliberately keeps GTA's camera-relative strafe contract.
            // It does not inherit non-aim locomotion's body-forward turn gate.
            const rate = hasInput ? movementAcceleration : braking;
            const a = 1.0 - Math.exp(-Math.max(0.1, rate) * dt);
            this._aimVelocity[0] = this._aimVelocity[0] * (1.0 - a) + desiredVx * a;
            this._aimVelocity[1] = this._aimVelocity[1] * (1.0 - a) + desiredVy * a;
            if (!hasInput && Math.hypot(this._aimVelocity[0], this._aimVelocity[1]) < 0.02) {
                this._aimVelocity[0] = 0.0;
                this._aimVelocity[1] = 0.0;
            }
            vel[0] = this._aimVelocity[0];
            vel[1] = this._aimVelocity[1];
            this._forwardSpeed = 0.0;
        } else {
            const speedNow = Math.max(0.0, finite(this._forwardSpeed));
            const nativeTransitionSpeed = this._nativeTransitionSpeed(dt);
            const speedTarget = Number.isFinite(nativeTransitionSpeed)
                ? nativeTransitionSpeed * (hasInput ? (desiredForwardSpeed / Math.max(0.001, moveDirection?.speed || 1.0)) : 1.0)
                : (hasInput ? desiredForwardSpeed : 0.0);
            const usingSourceCadence = Number.isFinite(nativeTransitionSpeed);
            const rate = usingSourceCadence
                ? finite(cfg.rootMotionResponse, 20.0)
                : (speedTarget > speedNow ? movementAcceleration : braking);
            this._forwardSpeed = moveToward(speedNow, Math.max(0.0, speedTarget), Math.max(0.1, rate) * dt);
            if (this._forwardSpeed < 0.02 && speedTarget <= 0.02) this._forwardSpeed = 0.0;
            vel[0] = Math.cos(locomotionHeading) * this._forwardSpeed;
            vel[1] = Math.sin(locomotionHeading) * this._forwardSpeed;
            this._aimVelocity[0] = 0.0;
            this._aimVelocity[1] = 0.0;
        }

        if (app.player) app.player._locomotionReferenceSpeed = moveDirection?.speed || 0.0;

        const oldX = finite(app.ped.posData[0]);
        const oldY = finite(app.ped.posData[1]);
        const eye = finite(app.pedEyeHeightData, 1.2);
        const oldFeetZ = finite(app.ped.posData[2]) - eye;
        const jumpEnabled = profile.jumpEnabled !== false;
        const cachedGround = this._lastGroundContact;
        const standingStill = !hasInput
            && app._pedOnGround
            && Math.hypot(finite(vel[0]), finite(vel[1])) < 0.01
            && Math.abs(this._forwardSpeed) < 0.01;
        const canReuseGround = standingStill
            && cachedGround?.ground
            && Math.hypot(oldX - finite(cachedGround.x), oldY - finite(cachedGround.y)) <= 0.05
            && Math.abs(oldFeetZ - finite(cachedGround.feetZ)) <= 0.35;
        // A stationary capsule has no swept path to test. Re-querying all YBN
        // candidates every display frame caused cold-streaming spikes and let
        // newly loaded overlapping floors move the camera under an idle player.
        const collision = canReuseGround
            ? {
                x: oldX,
                y: oldY,
                ground: cachedGround.ground,
                blocked: false,
                reason: '',
                vx: 0.0,
                vy: 0.0,
            }
            : (this.collisionWorld?.moveCapsule?.({
                x: oldX,
                y: oldY,
                feetZ: oldFeetZ,
                vx: vel[0],
                vy: vel[1],
                dt,
                radius: finite(profile.radius, 0.38),
                maxStepUp: finite(profile.maxStepUp, finite(cfg.maxStepUp, 1.15)),
                // A jump/fall may pass beneath upper slabs in an MLO. Only a
                // grounded capsule may step upward onto a floor; an airborne
                // capsule must continue falling to a surface below its feet.
                maxGroundRise: app._pedOnGround
                    ? finite(profile.maxStepUp, finite(cfg.maxStepUp, 1.15))
                    : 0.05,
                maxSnapDistance: finite(app.groundPedMaxDelta, 35.0),
            }) || null);

        let newX = collision ? finite(collision.x, oldX) : oldX + vel[0] * dt;
        let newY = collision ? finite(collision.y, oldY) : oldY + vel[1] * dt;
        let ground = collision?.ground || this.collisionWorld?.resolveGround?.(newX, newY, oldFeetZ) || null;
        let feetZ = oldFeetZ;

        if (collision?.blocked) {
            vel[0] = finite(collision.vx, vel[0]);
            vel[1] = finite(collision.vy, vel[1]);
            if (!aiming) {
                // Collision is authoritative. Keep the next non-aim frame from
                // restoring a pre-impact speed into the blocking geometry.
                this._forwardSpeed = Math.max(0.0, vel[0] * Math.cos(locomotionHeading) + vel[1] * Math.sin(locomotionHeading));
            } else {
                this._aimVelocity[0] = vel[0];
                this._aimVelocity[1] = vel[1];
            }
        }

        const jumpPressed = !!(ks[' '] || ks['space'] || ks['spacebar']);
        if (jumpEnabled && jumpPressed && app._pedOnGround) {
            app._pedVerticalVelocityData = finite(cfg.jumpSpeed, 6.2);
            app._pedOnGround = false;
        }

        if (!app._pedOnGround) {
            app._pedVerticalVelocityData -= finite(cfg.gravity, 22.0) * dt;
            feetZ += app._pedVerticalVelocityData * dt;
        }

        const groundZ = Number(ground?.z);
        if (Number.isFinite(groundZ)) {
            const pad = finite(cfg.groundProbePad, 0.08);
            if (app._pedOnGround || feetZ <= groundZ + pad) {
                feetZ = groundZ;
                app._pedVerticalVelocityData = 0.0;
                app._pedOnGround = true;
            }
        }
        if (ground && Number.isFinite(groundZ)) {
            this._lastGroundContact = {
                x: newX,
                y: newY,
                feetZ,
                ground,
            };
        }

        app._pedVelocityData = vel;
        app.ped.posData[0] = newX;
        app.ped.posData[1] = newY;
        app.ped.posData[2] = feetZ + eye;
        app.ped.posView = app._dataToViewer(app.ped.posData);
        app.pedRenderer?.setPositions?.([app.ped.posData]);
        app._pedGroundSource = ground?.source || 'gameplay';
        app._pedGroundingDebug = {
            desiredZ: oldFeetZ,
            groundZ: ground?.source === 'ybn' || ground?.source === 'terrain' ? groundZ : null,
            terrainEnvelopeZ: ground?.terrainZ ?? null,
            ybnZ: ground?.ybnZ ?? null,
            rawYbnZ: ground?.rawYbnZ ?? null,
            ybnAlignmentOffset: ground?.ybnCalibrationOffset ?? null,
            ybnZ: ground?.ybnZ ?? null,
            rawYbnZ: ground?.rawYbnZ ?? null,
            ybnAlignmentOffset: ground?.ybnCalibrationOffset ?? null,
            interiorFloorZ: ground?.interiorFloorZ ?? null,
            usedGround: ground?.source === 'ybn' || ground?.source === 'terrain',
            usedInterior: ground?.source === 'interior',
            groundSource: ground?.source || 'gameplay',
            finalZ: feetZ + eye,
            blocked: !!collision?.blocked,
            blockReason: collision?.reason || '',
        };
        return true;
    }

    _speedFor({ cfg, profile, gait }) {
        if (gait === 'sprint') return finite(profile.sprintSpeed, finite(cfg.sprintSpeed, 7.4));
        if (gait === 'run') return finite(profile.runSpeed, finite(cfg.runSpeed, 4.6));
        return finite(profile.walkSpeed, finite(cfg.walkSpeed, 1.7));
    }

    _rootMotionForClip(clipName) {
        const renderer = this.app?.playerModelRenderer;
        const rootMotion = renderer?.getSkinningAnimationClipRootMotion?.(clipName);
        const duration = Number(renderer?.getSkinningAnimationClipDuration?.(clipName));
        if (!rootMotion || !Array.isArray(rootMotion.frames) || rootMotion.frames.length < 2 || !Number.isFinite(duration) || duration <= 0.0) {
            return null;
        }
        return { rootMotion, duration };
    }

    _nativeGaitSpeed({ cfg, profile, gait }) {
        const fallback = this._speedFor({ cfg, profile, gait });
        const motion = this._rootMotionForClip(gait);
        const frames = motion?.rootMotion?.frames;
        if (!frames?.length) return fallback;
        const first = frames[0];
        const last = frames[frames.length - 1];
        const distance = Math.hypot(
            finite(last?.[0]) - finite(first?.[0]),
            finite(last?.[1]) - finite(first?.[1]),
        );
        // Frames are sampled at i / frameCount, so the final sample lands one
        // frame before the formal clip end. Correct that sampling interval when
        // converting a root path to metres per second.
        const sampledDuration = motion.duration * ((frames.length - 1) / frames.length);
        const sourceSpeed = distance / Math.max(1e-4, sampledDuration);
        return Number.isFinite(sourceSpeed) && sourceSpeed > 0.08 && sourceSpeed < 20.0
            ? sourceSpeed
            : fallback;
    }

    _nativeTransitionSpeed(dt) {
        const transition = this.app?.player?._locomotionTransition;
        if (!transition?.active || (transition.kind !== 'start' && transition.kind !== 'stop')) return NaN;
        const motion = this._rootMotionForClip(transition.clip);
        const frames = motion?.rootMotion?.frames;
        if (!frames?.length) return NaN;
        const first = frames[0];
        const last = frames[frames.length - 1];
        const totalX = finite(last?.[0]) - finite(first?.[0]);
        const totalY = finite(last?.[1]) - finite(first?.[1]);
        const totalLength = Math.hypot(totalX, totalY);
        if (totalLength < 1e-4) return NaN;
        const sampleDt = Math.max(1e-4, Math.min(Math.max(1e-4, dt), motion.duration * 0.08));
        const nowProgress = clamp(finite(transition.progress), 0.0, 1.0);
        const previousProgress = clamp(nowProgress - sampleDt / motion.duration, 0.0, 1.0);
        const current = rootMotionFrame(motion.rootMotion, nowProgress);
        const previous = rootMotionFrame(motion.rootMotion, previousProgress);
        if (!current || !previous) return NaN;
        const distance = (
            (finite(current[0]) - finite(previous[0])) * (totalX / totalLength)
            + (finite(current[1]) - finite(previous[1])) * (totalY / totalLength)
        );
        const speed = distance / sampleDt;
        return Number.isFinite(speed) && speed >= -0.01 && speed < 20.0 ? Math.max(0.0, speed) : NaN;
    }

    _locomotionTransitionHeading() {
        const transition = this.app?.player?._locomotionTransition;
        if (!transition?.active || transition.kind !== 'turn180') return NaN;
        const startHeading = Number(transition.startHeading);
        const targetHeading = Number(transition.targetHeading);
        if (!Number.isFinite(startHeading) || !Number.isFinite(targetHeading)) return NaN;

        const motion = this._rootMotionForClip(transition.clip);
        const first = rootMotionFrame(motion?.rootMotion, 0.0);
        const current = rootMotionFrame(motion?.rootMotion, transition.progress);
        let turn01 = smoothstep(0.0, 0.7, finite(transition.progress));
        if (first && current) {
            const sourceTurn = Math.abs(shortestAngle(
                angleFromQuaternionXYWZ(first),
                angleFromQuaternionXYWZ(current),
            ));
            // The source clip's yaw is used as a timing curve. The input target
            // owns left/right direction, so left/right dictionaries remain safe
            // even when their authoring basis differs.
            turn01 = clamp(sourceTurn / Math.PI, 0.0, 1.0);
        }
        return this.app?._lerpAngleRad?.(startHeading, targetHeading, turn01)
            ?? (startHeading + shortestAngle(startHeading, targetHeading) * turn01);
    }

    _locomotionTransitionDuration(clip, fallback) {
        const sourceDuration = Number(this.app?.playerModelRenderer?.getSkinningAnimationClipDuration?.(clip));
        return Number.isFinite(sourceDuration) && sourceDuration > 0.0
            ? sourceDuration
            : Math.max(0.05, finite(fallback, 0.5));
    }

    _locomotionTransitionSide(turnDelta) {
        const turn = finite(turnDelta);
        if (Math.abs(turn) > 0.02) return turn < 0.0 ? 'right' : 'left';
        const phase = finite(this.app?.player?.animPhase);
        const cycle01 = ((phase / (Math.PI * 2.0)) % 1.0 + 1.0) % 1.0;
        return cycle01 < 0.5 ? 'left' : 'right';
    }

    _updateLocomotionTransition({ dt, hasInput, aiming, gait, turnDelta, targetHeading, speed }) {
        const app = this.app;
        const player = app?.player;
        if (!player) return;

        const wasInput = this._hadLocomotionInput;
        const movingGait = gait === 'walk' || gait === 'sprint' || gait === 'run'
            ? gait
            : this._lastLocomotionGait;
        const normalizedGait = movingGait === 'walk' || movingGait === 'sprint' ? movingGait : 'run';
        const weaponActive = !!app.weaponController?.isVisible?.();
        if (aiming || weaponActive || player.handsUp || app.emotePalette?.active) {
            player._locomotionTransition = null;
            this._hadLocomotionInput = hasInput;
            if (hasInput && gait !== 'idle') this._lastLocomotionGait = normalizedGait;
            return;
        }

        const side = this._locomotionTransitionSide(turnDelta);
        let next = null;
        if (hasInput && !wasInput) {
            const sourceGait = normalizedGait === 'sprint' ? 'run' : normalizedGait;
            const clip = `locomotion_start_${sourceGait}_${side}`;
            next = {
                kind: 'start',
                clip,
                duration: this._locomotionTransitionDuration(clip, sourceGait === 'walk' ? 2.0 : 1.9),
            };
        } else if (!hasInput && wasInput && speed > 0.12) {
            const sourceGait = this._lastLocomotionGait === 'sprint' ? 'run' : this._lastLocomotionGait;
            const clip = `locomotion_stop_${sourceGait}_${side}`;
            next = {
                kind: 'stop',
                clip,
                duration: this._locomotionTransitionDuration(clip, sourceGait === 'walk' ? 3.2 : 3.45),
            };
        } else if (
            hasInput
            && wasInput
            && Math.abs(finite(turnDelta)) > 2.55
            && speed > 0.35
            && player._locomotionTransition?.kind !== 'turn180'
        ) {
            const sourceGait = normalizedGait;
            const clip = sourceGait === 'sprint'
                ? `locomotion_turn_sprint_${side}`
                : `locomotion_turn_${sourceGait}_180_${side}`;
            next = {
                kind: 'turn180',
                clip,
                duration: this._locomotionTransitionDuration(
                    clip,
                    sourceGait === 'walk' ? 3.3 : (sourceGait === 'sprint' ? 1.17 : 2.45),
                ),
            };
        }

        if (next) {
            // The source clips are one-shots. Progress is kept separate from the
            // looping locomotion phase so the sampled palette cannot restart when
            // the renderer receives a new camera or world-streaming frame.
            player._locomotionTransition = {
                active: true,
                ...next,
                gait: normalizedGait,
                startHeading: finite(player.headingRad, 0.0),
                targetHeading: finite(targetHeading, finite(player.headingRad, 0.0)),
                elapsed: 0.0,
                progress: 0.0,
            };
        } else if (player._locomotionTransition?.active) {
            const transition = player._locomotionTransition;
            const duration = this._locomotionTransitionDuration(transition.clip, transition.duration);
            transition.duration = duration;
            transition.elapsed = Math.max(0.0, finite(transition.elapsed) + Math.max(0.0, finite(dt)));
            transition.progress = clamp(transition.elapsed / duration, 0.0, 1.0);
            if (transition.progress >= 1.0) player._locomotionTransition = null;
        }

        this._hadLocomotionInput = hasInput;
        if (hasInput && gait !== 'idle') this._lastLocomotionGait = normalizedGait;
    }

    _turnRateFor({ cfg, profile, gait, aiming }) {
        if (aiming) return finite(profile.aimTurnRate, finite(cfg.aimTurnRate, 8.5));
        const key = gait === 'walk' ? 'walkTurnRate' : (gait === 'sprint' ? 'sprintTurnRate' : 'runTurnRate');
        const fallback = gait === 'walk' ? 2.7 : (gait === 'sprint' ? 3.8 : 5.2);
        return clamp(finite(profile[key], finite(cfg[key], fallback)), 0.6, 12.0);
    }

    _accelerationFor({ cfg, profile, gait, aiming }) {
        if (aiming) return clamp(finite(profile.aimAcceleration, finite(cfg.aimAcceleration, 6.0)), 0.5, 20.0);
        const key = gait === 'walk' ? 'walkAcceleration' : (gait === 'sprint' ? 'sprintAcceleration' : 'runAcceleration');
        const fallback = gait === 'walk' ? 3.3 : (gait === 'sprint' ? 4.8 : 5.8);
        return clamp(finite(profile[key], finite(cfg[key], finite(cfg.acceleration, fallback))), 0.5, 20.0);
    }

    _updateNoclip(dt) {
        const app = this.app;
        const ks = app.keyState || {};
        const inputRight = (ks.d ? 1 : 0) - (ks.a ? 1 : 0);
        const inputForward = (ks.w ? 1 : 0) - (ks.s ? 1 : 0);
        const inputVertical = (ks[' '] || ks.space || ks.spacebar ? 1 : 0) - (ks.control || ks.ctrl ? 1 : 0);
        const length = Math.hypot(inputRight, inputForward, inputVertical);
        const speed = ks.shift ? 28 : 9;
        const bounds = app.spawnDistrictDemo ? app.spawnDistrictBounds : null;
        const hasBounds = [bounds?.minX, bounds?.minY, bounds?.maxX, bounds?.maxY]
            .map(Number)
            .every(Number.isFinite)
            && Number(bounds.maxX) > Number(bounds.minX)
            && Number(bounds.maxY) > Number(bounds.minY);

        if (hasBounds) {
            const minX = Number(bounds.minX);
            const minY = Number(bounds.minY);
            const maxX = Number(bounds.maxX);
            const maxY = Number(bounds.maxY);
            const span = Math.max(maxX - minX, maxY - minY);
            const recoveryDistance = Math.max(64.0, Math.min(250.0, span * 0.1));
            const rawX = Number(app.ped.posData[0]);
            const rawY = Number(app.ped.posData[1]);
            const outsideDistance = Number.isFinite(rawX) && Number.isFinite(rawY)
                ? Math.hypot(
                    rawX < minX ? minX - rawX : (rawX > maxX ? rawX - maxX : 0.0),
                    rawY < minY ? minY - rawY : (rawY > maxY ? rawY - maxY : 0.0),
                )
                : Infinity;
            if (outsideDistance > recoveryDistance) {
                const configured = app._spawnDistrictDescriptor?.spawn || null;
                const configuredX = Number(configured?.x);
                const configuredY = Number(configured?.y);
                const fallbackX = Number.isFinite(configuredX)
                    ? clamp(configuredX, minX, maxX)
                    : (minX + maxX) * 0.5;
                const fallbackY = Number.isFinite(configuredY)
                    ? clamp(configuredY, minY, maxY)
                    : (minY + maxY) * 0.5;
                const fallbackFeetZ = finite(configured?.pedZ, finite(configured?.z, 31.17));
                app.spawnPedAt?.([
                    fallbackX,
                    fallbackY,
                    fallbackFeetZ + finite(app.pedEyeHeightData, 1.2),
                ], { groundSource: 'demo_boundary_recovery' });
            } else if (outsideDistance > 0.0) {
                const inset = Math.min(0.5, span * 0.001);
                app.ped.posData[0] = clamp(rawX, minX + inset, maxX - inset);
                app.ped.posData[1] = clamp(rawY, minY + inset, maxY - inset);
            }
        }

        if (length > 1e-5) {
            const { fx, fy, rx, ry } = this._cameraBasisData();
            const scale = speed * dt / length;
            const nextX = app.ped.posData[0] + (inputRight * rx + inputForward * fx) * scale;
            const nextY = app.ped.posData[1] + (inputRight * ry + inputForward * fy) * scale;
            if (hasBounds) {
                const minX = Number(bounds.minX);
                const minY = Number(bounds.minY);
                const maxX = Number(bounds.maxX);
                const maxY = Number(bounds.maxY);
                const inset = Math.min(0.5, Math.max(0.01, Math.min(maxX - minX, maxY - minY) * 0.001));
                app.ped.posData[0] = clamp(nextX, minX + inset, maxX - inset);
                app.ped.posData[1] = clamp(nextY, minY + inset, maxY - inset);
            } else {
                app.ped.posData[0] = nextX;
                app.ped.posData[1] = nextY;
            }
            app.ped.posData[2] += inputVertical * scale;
            if (app.player && Math.hypot(inputRight, inputForward) > 1e-5) {
                app.player.headingRad = Math.atan2(inputRight * ry + inputForward * fy, inputRight * rx + inputForward * fx);
                app.player.animGait = ks.shift ? 'sprint' : 'run';
                app.player.animMove01 = 1;
            }
        } else if (app.player) {
            app.player.animGait = 'idle';
            app.player.animMove01 = 0;
        }
        app._pedVelocityData = [0, 0, 0];
        app._pedVerticalVelocityData = 0;
        app._pedOnGround = false;
        app._pedGroundSource = 'noclip';
        app.ped.posView = app._dataToViewer(app.ped.posData);
        app.pedRenderer?.setPositions?.([app.ped.posData]);
        return true;
    }

    _cameraBasisData() {
        const app = this.app;
        const fwdView = glMatrix.vec3.fromValues(
            app.camera.direction[0],
            app.camera.direction[1],
            app.camera.direction[2],
        );
        fwdView[1] = 0.0;
        if (glMatrix.vec3.length(fwdView) < 1e-5) fwdView[2] = -1.0;
        glMatrix.vec3.normalize(fwdView, fwdView);

        const rightView = glMatrix.vec3.create();
        glMatrix.vec3.cross(rightView, fwdView, app.camera.up);
        glMatrix.vec3.normalize(rightView, rightView);

        const fwdData = app._viewerDirToDataDir(fwdView);
        const rightData = app._viewerDirToDataDir(rightView);
        let fx = finite(fwdData[0]);
        let fy = finite(fwdData[1]);
        let rx = finite(rightData[0]);
        let ry = finite(rightData[1]);
        const fl = Math.hypot(fx, fy) || 1.0;
        const rl = Math.hypot(rx, ry) || 1.0;
        fx /= fl;
        fy /= fl;
        rx /= rl;
        ry /= rl;
        return { fx, fy, rx, ry };
    }
}

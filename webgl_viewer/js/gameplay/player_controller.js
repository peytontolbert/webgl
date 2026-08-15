import { glMatrix } from '../glmatrix.js';

function finite(n, fallback = 0.0) {
    const v = Number(n);
    return Number.isFinite(v) ? v : fallback;
}

export class PlayerController {
    constructor(app, collisionWorld) {
        this.app = app;
        this.collisionWorld = collisionWorld;
    }

    update(dt) {
        const app = this.app;
        if (!app?.ped) return false;
        if (app.vehicleController?.inVehicle) {
            app.vehicleController.syncOccupantPed?.();
            return true;
        }
        if (app.meleeController?.lifeState && app.meleeController.lifeState !== 'alive') {
            app._resetPedMotion?.();
            if (app.player) {
                app.player.animGait = 'idle';
                app.player._sprintRequested = false;
            }
            return true;
        }
        if (app.player?.handsUp) {
            app._resetPedMotion?.();
            return true;
        }

        const cfg = app.gameplayMoveConfig || {};
        const profile = app.vehicleController?.getMovementProfile?.() || {};
        const ks = app.keyState || {};

        const inputRight = (ks['d'] ? 1 : 0) - (ks['a'] ? 1 : 0);
        const inputForward = (ks['w'] ? 1 : 0) - (ks['s'] ? 1 : 0);
        const inputLen = Math.hypot(inputRight, inputForward);
        const hasInput = inputLen > 1e-5;

        let desiredVx = 0.0;
        let desiredVy = 0.0;
        if (hasInput) {
            const invInput = 1.0 / inputLen;
            const { fx, fy, rx, ry } = this._cameraBasisData();
            let dx = (inputRight * invInput) * rx + (inputForward * invInput) * fx;
            let dy = (inputRight * invInput) * ry + (inputForward * invInput) * fy;
            const dLen = Math.hypot(dx, dy) || 1.0;
            dx /= dLen;
            dy /= dLen;

            const slow = !!(ks['control'] || ks['ctrl'] || ks['alt']);
            // GTA's on-foot contract is jog by default, Shift to sprint, and
            // Ctrl/Alt to walk. Restrict sprinting to forward movement so
            // strafing/backpedalling retains the normal run profile.
            const sprint = !!ks['shift'] && inputForward > 0.15 && !slow;
            const weaponMovementScale = finite(app.weaponController?.getMovementScale?.(), 1.0);
            const meleeMovementScale = finite(app.meleeController?.getMovementScale?.(), 1.0);
            const wheelScale = app.player?.weaponWheelOpen ? 0.2 : 1.0;
            const speed = this._speedFor({ cfg, profile, slow, sprint: sprint && wheelScale === 1.0 }) * weaponMovementScale * meleeMovementScale * wheelScale;
            desiredVx = dx * speed;
            desiredVy = dy * speed;

            const turnSharpness = finite(profile.turnSharpness, finite(cfg.turnSharpness, 14.0));
            const turnA = 1.0 - Math.exp(-Math.max(0.1, turnSharpness) * dt);
            if (app.player) {
                const targetHeading = Math.atan2(dy, dx);
                app.player.headingRad = app._lerpAngleRad(finite(app.player.headingRad, targetHeading), targetHeading, turnA);
                app.player._lastMoveDirData = [dx, dy, 0.0];
                app.player._sprintRequested = sprint;
            }
        } else if (app.player) {
            app.player._lastMoveDirData = [0, 0, 0];
            app.player._sprintRequested = false;
        }

        const vel = app._pedVelocityData || [0, 0, 0];
        const accelBase = hasInput
            ? finite(profile.acceleration, finite(cfg.acceleration, 11.0))
            : finite(profile.braking, finite(cfg.braking, 14.0));
        const accel = (hasInput && !!ks['shift'] && inputForward > 0.15 && !(ks['control'] || ks['ctrl'] || ks['alt']))
            ? finite(profile.sprintAcceleration, finite(cfg.sprintAcceleration, accelBase))
            : accelBase;
        const a = 1.0 - Math.exp(-Math.max(0.1, accel) * dt);
        vel[0] = vel[0] * (1 - a) + desiredVx * a;
        vel[1] = vel[1] * (1 - a) + desiredVy * a;
        if (!hasInput && Math.hypot(vel[0], vel[1]) < 0.02) {
            vel[0] = 0.0;
            vel[1] = 0.0;
        }

        const oldX = finite(app.ped.posData[0]);
        const oldY = finite(app.ped.posData[1]);
        const eye = finite(app.pedEyeHeightData, 1.2);
        const oldFeetZ = finite(app.ped.posData[2]) - eye;
        const jumpEnabled = profile.jumpEnabled !== false;
        const collision = this.collisionWorld?.moveCapsule?.({
            x: oldX,
            y: oldY,
            feetZ: oldFeetZ,
            vx: vel[0],
            vy: vel[1],
            dt,
            radius: finite(profile.radius, 0.38),
            maxStepUp: finite(profile.maxStepUp, finite(cfg.maxStepUp, 1.15)),
            maxSnapDistance: finite(app.groundPedMaxDelta, 35.0),
        }) || null;

        let newX = collision ? finite(collision.x, oldX) : oldX + vel[0] * dt;
        let newY = collision ? finite(collision.y, oldY) : oldY + vel[1] * dt;
        let ground = collision?.ground || this.collisionWorld?.resolveGround?.(newX, newY, oldFeetZ) || null;
        let feetZ = oldFeetZ;

        if (collision?.blocked) {
            vel[0] = finite(collision.vx, vel[0]);
            vel[1] = finite(collision.vy, vel[1]);
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

    _speedFor({ cfg, profile, slow, sprint }) {
        if (slow) return finite(profile.walkSpeed, finite(cfg.walkSpeed, 1.7));
        if (sprint) return finite(profile.sprintSpeed, finite(cfg.sprintSpeed, 7.4));
        return finite(profile.runSpeed, finite(cfg.runSpeed, 4.6));
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

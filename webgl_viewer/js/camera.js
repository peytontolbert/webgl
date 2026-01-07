import { glMatrix } from './glmatrix.js';

export class Camera {
    constructor() {
        // Camera parameters
        this.fieldOfView = 45.0; // Reduced for better perspective
        this.aspectRatio = 1.0;
        // NOTE: For "character-level" close-up inspection we need a small near plane.
        // Depth precision isn't perfect at world scale, but this makes close viewing possible.
        this.nearPlane = 0.1;
        this.farPlane = 100000.0; // Increased to see the whole map
        this.orthographicSize = 1000.0;
        
        // Zoom limits (allow close-up inspection + wide map viewing)
        this.minZoom = 1.0;
        this.maxZoom = 80000.0;
        
        // Camera state
        this.position = glMatrix.vec3.create();
        this.target = glMatrix.vec3.create();
        this.up = glMatrix.vec3.fromValues(0, 1, 0); // Y is up in GTA5
        this.direction = glMatrix.vec3.create();
        
        // Movement and rotation
        // moveSpeed is in world units / second (scaled a bit by distance to target so map-scale navigation stays usable)
        this.moveSpeed = 500.0;
        // rotationSpeed is radians / pixel
        this.rotationSpeed = 0.002;
        // zoomSpeed is the wheel normalization factor used by exponential zoom.
        // This matches `_applyGameplayCameraZoomDelta` in main.js.
        this.zoomSpeed = 0.0012;

        // Stable look state (prevents gimbal/flip from incremental matrix rotations)
        this.yaw = 0.0;   // radians
        this.pitch = 0.0; // radians
        this._lookDistance = 1000.0;
        
        // Matrices
        this.viewMatrix = glMatrix.mat4.create();
        this.projectionMatrix = glMatrix.mat4.create();
        this.viewProjectionMatrix = glMatrix.mat4.create();
        
        // Initialize camera position for viewing the entire GTA5 map
        // Position the camera at a high angle looking down at the terrain
        this.position[0] = 10000;  // X position (10km east)
        this.position[1] = 8000;   // Y position (8km height)
        this.position[2] = 10000;  // Z position (10km north)
        
        // Look at the center of the map
        this.target[0] = 0;
        this.target[1] = 0;
        this.target[2] = 0;
        
        // Update matrices
        this.updateViewMatrix();
        this.updateProjectionMatrix();
    }

    setFovDegrees(deg) {
        const v = Number(deg);
        if (!Number.isFinite(v)) return;
        // Keep within a sane range.
        this.fieldOfView = Math.max(10.0, Math.min(120.0, v));
        this.updateProjectionMatrix();
    }

    lookAtPoint(targetVec3) {
        this.target[0] = targetVec3[0];
        this.target[1] = targetVec3[1];
        this.target[2] = targetVec3[2];
        this.updateViewMatrix();
    }

    frameAABB(minVec3, maxVec3) {
        // Place camera so the AABB is likely in view (simple heuristic).
        const cx = (minVec3[0] + maxVec3[0]) * 0.5;
        const cy = (minVec3[1] + maxVec3[1]) * 0.5;
        const cz = (minVec3[2] + maxVec3[2]) * 0.5;
        const dx = (maxVec3[0] - minVec3[0]);
        const dy = (maxVec3[1] - minVec3[1]);
        const dz = (maxVec3[2] - minVec3[2]);
        const radius = Math.max(1.0, Math.sqrt(dx*dx + dy*dy + dz*dz) * 0.5);

        this.target[0] = cx;
        this.target[1] = cy;
        this.target[2] = cz;

        // Put camera on a diagonal above the scene.
        this.position[0] = cx + radius * 0.8;
        this.position[1] = cy + radius * 1.2;
        this.position[2] = cz + radius * 0.8;

        // Expand clip planes to cover the scene.
        this.nearPlane = Math.max(1.0, radius * 0.01);
        this.farPlane = Math.max(1000.0, radius * 10.0);
        this.updateProjectionMatrix();
        this.updateViewMatrix();
    }

    updateViewMatrix() {
        // Create view matrix looking from position to target
        glMatrix.mat4.lookAt(
            this.viewMatrix,
            this.position,
            this.target,
            this.up
        );
        
        // Calculate direction vector (from position to target)
        glMatrix.vec3.subtract(this.direction, this.target, this.position);
        const dist = glMatrix.vec3.length(this.direction) || 1.0;
        glMatrix.vec3.scale(this.direction, this.direction, 1.0 / dist);

        // Keep stable yaw/pitch in sync with the current pose so external changes (lookAtPoint, follow mode, etc.)
        // don't cause the next rotate() to "jump".
        this._lookDistance = dist;
        this.yaw = Math.atan2(this.direction[0], this.direction[2]);
        // Clamp asin input to avoid NaNs from precision drift.
        const y = Math.max(-1.0, Math.min(1.0, this.direction[1]));
        this.pitch = Math.asin(y);
        
        // Update combined matrix
        glMatrix.mat4.multiply(
            this.viewProjectionMatrix,
            this.projectionMatrix,
            this.viewMatrix
        );
    }

    updateProjectionMatrix() {
        // Use perspective projection for 3D view
        glMatrix.mat4.perspective(
            this.projectionMatrix,
            glMatrix.glMatrix.toRadian(this.fieldOfView),
            this.aspectRatio,
            this.nearPlane,
            this.farPlane
        );
        
        // Update combined matrix
        glMatrix.mat4.multiply(
            this.viewProjectionMatrix,
            this.projectionMatrix,
            this.viewMatrix
        );
    }

    move(direction, dt = 1 / 60, opts = undefined) {
        // direction is expected to be normalized-ish (caller does this); dt is seconds.
        const keepTarget = !!(opts && opts.keepTarget);
        const flattenForward = !!(opts && opts.flattenForward);
        const t = Number(dt);
        const safeDt = Number.isFinite(t) ? Math.max(0.0, Math.min(0.1, t)) : (1 / 60);

        // Scale movement with distance so you can traverse the full map without huge speed toggles.
        const distance = this.getDistance();
        // Keep a small-but-nonzero minimum so close-up inspection can be fine-grained.
        const distanceScale = Math.max(0.02, Math.min(100.0, distance * 0.002));
        const step = this.moveSpeed * safeDt * distanceScale;

        // Camera basis (forward = look direction)
        let forward = this.direction;
        // Common "editor" behavior: keep WASD on the ground plane so forward/back doesn't bob when pitched.
        if (flattenForward) {
            const f = glMatrix.vec3.fromValues(forward[0], 0.0, forward[2]);
            if (glMatrix.vec3.length(f) > 1e-6) {
                glMatrix.vec3.normalize(f, f);
                forward = f;
            }
        }
        const right = glMatrix.vec3.create();
        glMatrix.vec3.cross(right, forward, this.up);
        glMatrix.vec3.normalize(right, right);

        const delta = glMatrix.vec3.create();
        glMatrix.vec3.scaleAndAdd(delta, delta, right, direction[0] * step);
        glMatrix.vec3.scaleAndAdd(delta, delta, this.up, direction[1] * step);
        glMatrix.vec3.scaleAndAdd(delta, delta, forward, direction[2] * step);

        glMatrix.vec3.add(this.position, this.position, delta);
        if (!keepTarget) glMatrix.vec3.add(this.target, this.target, delta);

        this.updateViewMatrix();
    }

    rotate(deltaX, deltaY) {
        const dx = Number(deltaX);
        const dy = Number(deltaY);
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;

        this.yaw += dx * this.rotationSpeed;
        this.pitch += -dy * this.rotationSpeed;

        // Clamp pitch to avoid flips.
        const maxPitch = glMatrix.glMatrix.toRadian(89.0);
        this.pitch = Math.max(-maxPitch, Math.min(maxPitch, this.pitch));

        const cp = Math.cos(this.pitch);
        const sp = Math.sin(this.pitch);
        const cy = Math.cos(this.yaw);
        const sy = Math.sin(this.yaw);

        // Forward direction derived from yaw/pitch (Y-up).
        const forward = glMatrix.vec3.fromValues(sy * cp, sp, cy * cp);
        glMatrix.vec3.normalize(forward, forward);

        // Preserve current look distance (what "zoom" sets).
        const d = this.getDistance();
        this._lookDistance = Number.isFinite(d) && d > 1e-6 ? d : (this._lookDistance || 1.0);

        glMatrix.vec3.scaleAndAdd(this.target, this.position, forward, this._lookDistance);
        this.updateViewMatrix();
    }

    zoom(delta) {
        const currentDistance = glMatrix.vec3.distance(this.position, this.target);
        // Exponential zoom feels consistent across wheel types (mouse wheel vs trackpad).
        // Clamp exponent to avoid huge jumps from high-resolution trackpads.
        const d = Number(delta) || 0.0; // raw wheel deltaY
        const exp = Math.max(-0.25, Math.min(0.25, d * this.zoomSpeed));
        const s = Math.exp(exp);
        const newDistance = currentDistance * s;
        
        // Clamp distance
        const clampedDistance = Math.max(this.minZoom, Math.min(this.maxZoom, newDistance));
        
        // Update position
        glMatrix.vec3.scaleAndAdd(
            this.position,
            this.target,
            this.direction,
            -clampedDistance
        );
        
        // Update matrices
        this.updateViewMatrix();
    }

    setZoomLimits(minZoom, maxZoom) {
        const mn = Number(minZoom);
        const mx = Number(maxZoom);
        if (!Number.isFinite(mn) || !Number.isFinite(mx)) return;
        this.minZoom = Math.max(0.1, Math.min(mn, mx));
        this.maxZoom = Math.max(this.minZoom, mx);
    }

    setClipPlanes(nearPlane, farPlane) {
        const n = Number(nearPlane);
        const f = Number(farPlane);
        if (!Number.isFinite(n) || !Number.isFinite(f)) return;
        this.nearPlane = Math.max(0.01, Math.min(n, f * 0.5));
        this.farPlane = Math.max(this.nearPlane * 2.0, f);
        this.updateProjectionMatrix();
    }

    getDistance() {
        return glMatrix.vec3.distance(this.position, this.target);
    }

    getOrientation() {
        // Calculate rotation angles from direction vector
        const pitch = Math.asin(this.direction[1]);
        const yaw = Math.atan2(this.direction[0], this.direction[2]);
        
        return {
            pitch: glMatrix.glMatrix.toDegree(pitch),
            yaw: glMatrix.glMatrix.toDegree(yaw)
        };
    }

    resize(width, height) {
        this.aspectRatio = width / height;
        this.updateProjectionMatrix();
    }
} 
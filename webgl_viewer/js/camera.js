// Import gl-matrix
import * as glMatrix from 'gl-matrix';

export class Camera {
    constructor() {
        // Camera parameters
        this.fieldOfView = 45.0; // Reduced for better perspective
        this.aspectRatio = 1.0;
        this.nearPlane = 100.0; // Increased for better depth precision
        this.farPlane = 100000.0; // Increased to see the whole map
        this.orthographicSize = 1000.0;
        
        // Zoom limits adjusted for GTA5 map scale
        this.minZoom = 5000.0; // 5km minimum zoom
        this.maxZoom = 20000.0; // 20km maximum zoom
        
        // Camera state
        this.position = glMatrix.vec3.create();
        this.target = glMatrix.vec3.create();
        this.up = glMatrix.vec3.fromValues(0, 1, 0); // Y is up in GTA5
        this.direction = glMatrix.vec3.create();
        
        // Movement and rotation
        this.moveSpeed = 500.0; // Reduced for more stable movement
        this.rotationSpeed = 0.0005; // Reduced for smoother rotation
        this.zoomSpeed = 0.05; // Reduced for smoother zooming
        
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

    /**
     * Hard-set camera pose.
     * @param {number[]} positionVec3
     * @param {number[]} targetVec3
     */
    setLookAt(positionVec3, targetVec3) {
        if (positionVec3 && positionVec3.length >= 3) {
            this.position[0] = Number(positionVec3[0]) || 0;
            this.position[1] = Number(positionVec3[1]) || 0;
            this.position[2] = Number(positionVec3[2]) || 0;
        }
        if (targetVec3 && targetVec3.length >= 3) {
            this.target[0] = Number(targetVec3[0]) || 0;
            this.target[1] = Number(targetVec3[1]) || 0;
            this.target[2] = Number(targetVec3[2]) || 0;
        }
        this.updateViewMatrix();
    }

    /**
     * Update zoom bounds based on a scene "diameter" in world units.
     * Keeps scroll zoom sane when the scene scale changes.
     */
    setZoomBoundsForSceneDiameter(diameter) {
        const d = Number(diameter);
        if (!Number.isFinite(d) || d <= 0) return;
        this.minZoom = Math.max(50.0, d * 0.05);
        this.maxZoom = Math.max(this.minZoom * 2.0, d * 2.5);
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
        glMatrix.vec3.normalize(this.direction, this.direction);
        
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

    move(direction) {
        // Scale movement by distance from target, but less aggressively
        const distance = glMatrix.vec3.distance(this.position, this.target);
        const scale = distance * 0.005; // Reduced from 0.01 to 0.005
        
        // Apply movement in camera space
        glMatrix.vec3.scaleAndAdd(this.position, this.position, this.direction, direction[2] * scale);
        
        // Calculate right vector
        const right = glMatrix.vec3.create();
        glMatrix.vec3.cross(right, this.direction, this.up);
        glMatrix.vec3.normalize(right, right);
        
        // Apply horizontal movement
        glMatrix.vec3.scaleAndAdd(this.position, this.position, right, direction[0] * scale);
        
        // Apply vertical movement
        glMatrix.vec3.scaleAndAdd(this.position, this.position, this.up, direction[1] * scale);
        
        // Update matrices
        this.updateViewMatrix();
    }

    rotate(deltaX, deltaY) {
        // Convert mouse movement to rotation angles with reduced sensitivity
        const sensitivity = 0.005; // Reduced from 0.01 to 0.005
        const pitch = -deltaY * sensitivity; // Invert pitch to match GTA5's coordinate system
        const yaw = deltaX * sensitivity;
        
        // Calculate rotation matrix
        const rotationMatrix = glMatrix.mat4.create();
        glMatrix.mat4.rotateY(rotationMatrix, rotationMatrix, yaw);
        glMatrix.mat4.rotateX(rotationMatrix, rotationMatrix, pitch);
        
        // Apply rotation to direction vector
        const rotatedDirection = glMatrix.vec3.create();
        glMatrix.vec3.transformMat4(rotatedDirection, this.direction, rotationMatrix);
        
        // Update target position
        glMatrix.vec3.scaleAndAdd(
            this.target,
            this.position,
            rotatedDirection,
            glMatrix.vec3.distance(this.position, this.target)
        );
        
        // Update matrices
        this.updateViewMatrix();
    }

    zoom(delta) {
        // Calculate new distance with reduced zoom speed
        const currentDistance = glMatrix.vec3.distance(this.position, this.target);
        const newDistance = currentDistance * (1.0 - delta * 0.5); // Reduced from 1.0 to 0.5
        
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
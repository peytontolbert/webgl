import { glMatrix } from '../glmatrix.js';
import { InstancedModelRenderer } from '../instanced_model_renderer.js';

const { mat4, quat, vec3 } = glMatrix;

function finite(value, fallback = 0.0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function normalizedDirection(value, fallbackSeed = 0) {
    const x = finite(value?.[0]);
    const y = finite(value?.[1]);
    const z = finite(value?.[2]);
    const length = Math.hypot(x, y, z);
    if (length > 1e-5) return [x / length, y / length, z / length];
    const angle = ((fallbackSeed >>> 0) % 6283) / 1000.0;
    return [Math.cos(angle), Math.sin(angle), 0.22];
}

function seededUnit(seed) {
    let value = (seed >>> 0) || 1;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return ((value >>> 0) & 0xFFFF) / 0xFFFF;
}

function hashString(value) {
    let hash = 2166136261;
    for (const character of String(value || '')) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

/**
 * Lightweight browser presentation for the authored YFT fragment children.
 * Physics remains deliberately bounded: GTA's Havok solver is not embedded in
 * the viewer, but each rendered shard and its initial transform come directly
 * from FragPhysicsLOD.Children / FragTransforms.
 */
export class FragmentDebrisSystem {
    constructor(app) {
        this.app = app;
        this.renderer = null;
        this._rendererInitPromise = null;
        this.profiles = new Map();
        this.bodies = [];
        this.maxBodies = 96;
        this.maxBodiesPerBreak = 12;
        this.maxAgeSeconds = 11.0;
        this.settleAgeSeconds = 2.0;
        this._activeHashes = new Set();
        this._pendingSourceSuppressions = new Map();
        this._bodyMatrix = mat4.create();
        this._baseMatrix = mat4.create();
        this._localMatrix = mat4.create();
        this._stepQuat = quat.create();
        this._renderStats = { profileCount: 0, bodies: 0, meshes: 0, dropped: 0 };
    }

    installManifest(data) {
        const meshes = data?.meshes;
        const profiles = data?.profiles;
        if (!meshes || typeof meshes !== 'object' || !profiles || typeof profiles !== 'object') return 0;
        this.app?.modelManager?.installManifestSubset?.({ version: 4, meshes }, { source: 'demo/spawn_district_fragment_children.json' });
        this.profiles.clear();
        for (const [hash, profile] of Object.entries(profiles)) {
            if (!profile || !Array.isArray(profile.children) || profile.children.length === 0) continue;
            this.profiles.set(String(hash), profile);
        }
        this._renderStats.profileCount = this.profiles.size;
        return this.profiles.size;
    }

    async ensureRenderer() {
        if (this.renderer?.ready) return true;
        if (this._rendererInitPromise) return this._rendererInitPromise;
        this._rendererInitPromise = (async () => {
            try {
                const renderer = new InstancedModelRenderer(this.app.gl, this.app.modelManager, this.app.textureStreamer);
                renderer.maxMeshLoadsInFlight = 2;
                renderer.meshLoadOptions = {
                    usePersistentCache: true,
                    cacheBust: 'yft-fragment-children-v1',
                    requireBlendAttributes: false,
                };
                await renderer.init();
                if (!renderer.ready) return false;
                this.renderer = renderer;
                return true;
            } catch (error) {
                console.warn('Fragment debris renderer failed to initialize:', error);
                return false;
            } finally {
                if (!this.renderer?.ready) this._rendererInitPromise = null;
            }
        })();
        return this._rendererInitPromise;
    }

    _parentMatrix(destructible) {
        const coords = destructible?.coords || destructible || {};
        const translation = [finite(coords.x), finite(coords.y), finite(coords.z)];
        const rotation = Array.isArray(destructible?.rotation) && destructible.rotation.length >= 4
            ? destructible.rotation.map((value, index) => finite(value, index === 3 ? 1.0 : 0.0))
            : [0.0, 0.0, 0.0, 1.0];
        const scale = Array.isArray(destructible?.scale) && destructible.scale.length >= 3
            ? destructible.scale.slice(0, 3).map((value) => Math.max(0.001, Math.abs(finite(value, 1.0))))
            : [1.0, 1.0, 1.0];
        const output = mat4.create();
        mat4.fromRotationTranslationScale(output, rotation, translation, scale);
        return output;
    }

    breakFragment(event, destructible) {
        if (!this.renderer?.ready) return false;
        const profile = this.profiles.get(String(destructible?.archetypeHash || event?.archetypeHash || ''));
        if (!profile?.children?.length) return false;
        const parent = this._parentMatrix(destructible);
        const impactSeed = hashString(event?.id || destructible?.id || profile.archetypeHash);
        const breakId = String(event?.id || destructible?.id || `${profile.archetypeHash}:${impactSeed}`);
        const impactDirection = normalizedDirection(event?.impactDirection, impactSeed);
        const impactSpeed = Math.max(1.0, finite(event?.impactSpeed, 5.0));
        const sourceScale = String(event?.source || '') === 'bullet'
            ? 2.3
            : Math.min(12.0, 1.8 + impactSpeed * 0.34);
        const children = profile.children.slice(0, this.maxBodiesPerBreak);
        while (this.bodies.length + children.length > this.maxBodies) this.bodies.shift();

        for (let childOrdinal = 0; childOrdinal < children.length; childOrdinal++) {
            const child = children[childOrdinal];
            const meshHash = String(child?.meshHash || '');
            if (!meshHash) continue;
            const transform = Array.isArray(child?.transform) && child.transform.length >= 16
                ? child.transform.map((value, index) => finite(value, (index % 5) === 0 ? 1.0 : 0.0))
                : [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
            mat4.copy(this._localMatrix, transform);
            const positionOffset = profile.positionOffset;
            if (Array.isArray(positionOffset) && positionOffset.length >= 3) {
                mat4.translate(this._localMatrix, this._localMatrix, [
                    finite(positionOffset[0]), finite(positionOffset[1]), finite(positionOffset[2]),
                ]);
            }
            mat4.multiply(this._baseMatrix, parent, this._localMatrix);

            const seed = (impactSeed + Math.imul(childOrdinal + 1, 0x9E3779B9)) >>> 0;
            const sideAngle = (seededUnit(seed) - 0.5) * Math.PI * 0.86;
            const sideX = impactDirection[0] * Math.cos(sideAngle) - impactDirection[1] * Math.sin(sideAngle);
            const sideY = impactDirection[0] * Math.sin(sideAngle) + impactDirection[1] * Math.cos(sideAngle);
            const upward = 0.8 + seededUnit(seed ^ 0xA5A5A5A5) * 2.1;
            const speed = sourceScale * (0.68 + seededUnit(seed ^ 0xC2B2AE35) * 0.64);
            const mass = Math.max(0.05, finite(child?.mass, 1.0));
            const baseRotation = quat.create();
            const baseScale = vec3.create();
            mat4.getRotation(baseRotation, this._baseMatrix);
            mat4.getScaling(baseScale, this._baseMatrix);
            const axis = vec3.fromValues(
                seededUnit(seed ^ 0x68BC21EB) * 2.0 - 1.0,
                seededUnit(seed ^ 0x02E5BE93) * 2.0 - 1.0,
                seededUnit(seed ^ 0x967A889B) * 2.0 - 1.0,
            );
            if (vec3.length(axis) < 1e-4) axis[2] = 1.0;
            vec3.normalize(axis, axis);
            this.bodies.push({
                meshHash,
                breakId,
                profileHash: String(profile.archetypeHash || destructible?.archetypeHash || ''),
                childIndex: Number(child?.childIndex) || 0,
                source: String(child?.geometrySource || 'unknown'),
                mass,
                gravity: Math.max(0.15, finite(profile.gravityFactor, 1.0)),
                age: 0.0,
                settled: false,
                position: vec3.fromValues(this._baseMatrix[12], this._baseMatrix[13], this._baseMatrix[14]),
                velocity: vec3.fromValues(sideX * speed / Math.sqrt(mass), sideY * speed / Math.sqrt(mass), upward + impactDirection[2] * speed * 0.25),
                axis,
                angularSpeed: (seededUnit(seed ^ 0x85EBCA6B) * 2.0 - 1.0) * (3.2 + sourceScale * 0.46),
                spin: quat.create(),
                baseRotation,
                scale: baseScale,
                matrix: mat4.clone(this._baseMatrix),
            });
        }
        this._renderStats.bodies = this.bodies.length;
        return true;
    }

    deferSourceSuppression(event, suppress) {
        if (typeof suppress !== 'function') return false;
        const breakId = String(event?.id || '');
        if (!breakId || !this.bodies.some((body) => body.breakId === breakId)) return false;
        this._pendingSourceSuppressions.set(breakId, suppress);
        this._flushSourceSuppressions();
        return true;
    }

    _meshIsRenderable(hash) {
        const entry = this.renderer?.instances?.get?.(`${String(hash)}:high`);
        if (!entry?.submeshes) return false;
        for (const submesh of entry.submeshes.values()) {
            if (submesh?.mesh) return true;
        }
        return false;
    }

    _flushSourceSuppressions() {
        if (!this._pendingSourceSuppressions.size) return;
        for (const [breakId, suppress] of this._pendingSourceSuppressions) {
            const hasVisibleChild = this.bodies
                .some((body) => body.breakId === breakId && this._meshIsRenderable(body.meshHash));
            if (!hasVisibleChild) continue;
            this._pendingSourceSuppressions.delete(breakId);
            try { suppress(); } catch (error) { console.warn('Fragment source suppression failed:', error); }
        }
    }

    _simulateBody(body, dt) {
        body.age += dt;
        if (!body.settled) {
            body.velocity[2] -= 9.81 * body.gravity * dt;
            vec3.scaleAndAdd(body.position, body.position, body.velocity, dt);
            const ground = this.app?.collisionWorld?.resolveGround?.(body.position[0], body.position[1], body.position[2], {
                preferInterior: false,
                maxSnapDistance: 30.0,
            });
            const groundZ = Number(ground?.z);
            if (Number.isFinite(groundZ) && body.position[2] <= groundZ + 0.025) {
                body.position[2] = groundZ + 0.025;
                if (Math.abs(body.velocity[2]) > 0.85) {
                    body.velocity[2] *= -0.28;
                    body.velocity[0] *= 0.62;
                    body.velocity[1] *= 0.62;
                } else {
                    body.velocity[2] = 0.0;
                    body.velocity[0] *= Math.exp(-4.8 * dt);
                    body.velocity[1] *= Math.exp(-4.8 * dt);
                    if (Math.hypot(body.velocity[0], body.velocity[1]) < 0.18 && body.age >= this.settleAgeSeconds) body.settled = true;
                }
            }
            quat.setAxisAngle(this._stepQuat, body.axis, body.angularSpeed * dt);
            quat.multiply(body.spin, this._stepQuat, body.spin);
        }
        const rotation = quat.create();
        quat.multiply(rotation, body.baseRotation, body.spin);
        mat4.fromRotationTranslationScale(body.matrix, rotation, body.position, body.scale);
    }

    _syncRendererInstances() {
        if (!this.renderer?.ready) return;
        const grouped = new Map();
        for (const body of this.bodies) {
            let list = grouped.get(body.meshHash);
            if (!list) {
                list = [];
                grouped.set(body.meshHash, list);
            }
            list.push(body);
        }
        const next = new Set(grouped.keys());
        for (const hash of this._activeHashes) {
            if (!next.has(hash)) void this.renderer.setInstancesForArchetype(hash, 'high', new Float32Array(0), 0, { allowPlaceholderMesh: false });
        }
        for (const [hash, bodies] of grouped.entries()) {
            const matrices = new Float32Array(bodies.length * 16);
            for (let index = 0; index < bodies.length; index++) matrices.set(bodies[index].matrix, index * 16);
            if (!this.renderer.updateInstanceMatricesForArchetype(hash, 'high', matrices, 0)) {
                void this.renderer.setInstancesForArchetype(hash, 'high', matrices, 0, { allowPlaceholderMesh: false, loadPriority: 80 });
            }
        }
        this._activeHashes = next;
        this._renderStats.meshes = next.size;
    }

    update(dt) {
        const step = Math.max(0.0, Math.min(0.05, finite(dt, 0.0)));
        if (step <= 0.0 || this.bodies.length === 0) return;
        this.bodies = this.bodies.filter((body) => {
            this._simulateBody(body, step);
            return body.age < this.maxAgeSeconds;
        });
        this._renderStats.bodies = this.bodies.length;
        this._syncRendererInstances();
        try { this.renderer?.pumpMeshLoadsOnce?.(); } catch { /* loader stays optional */ }
        this._flushSourceSuppressions();
    }

    render(viewProjectionMatrix, cameraPosition, options = {}) {
        if (!this.renderer?.ready || this.bodies.length === 0) return;
        this.renderer.render(viewProjectionMatrix, true, cameraPosition, {
            ...options,
            occlusion: null,
            gpuFrustumCulling: false,
            fastStateRestore: true,
        });
    }

    getStatus() {
        return {
            ...this._renderStats,
            activeProfileHashes: [...new Set(this.bodies.map((body) => body.profileHash))].length,
            pendingSourceSuppressions: this._pendingSourceSuppressions.size,
            ready: !!this.renderer?.ready,
        };
    }

    clear() {
        this.bodies.length = 0;
        this._renderStats.bodies = 0;
        this._pendingSourceSuppressions.clear();
        try { this.renderer?.clearScene?.(); } catch { /* ignore */ }
        this._activeHashes.clear();
    }
}

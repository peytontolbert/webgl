import { normalizeVehiclePhysicsMode, vehiclePhysicsHandling, vehiclePhysicsModeLabel } from './vehicle_physics_modes.js';
import { VehicleDiagnostics } from './vehicle_diagnostics.js';
import { assettoLongitudinalPitchDelta, createAssettoVehicleState, stepAssettoVehicle } from './assetto_vehicle_solver.js';

function finite(n, fallback = 0.0) {
    const v = Number(n);
    return Number.isFinite(v) ? v : fallback;
}

export function vehicleGearTopFractions(gearCount) {
    const count = Math.max(1, Math.min(10, Number(gearCount) | 0 || 1));
    if (count === 1) return [1];
    const first = clamp(0.12 + 0.4 / count, 0.16, 0.25);
    const step = Math.pow(1 / first, 1 / (count - 1));
    return Array.from({ length: count }, (_, index) => index === count - 1 ? 1 : first * Math.pow(step, index));
}

export function vehicleSteeringScale(speedMetersPerSecond) {
    const speed = Math.abs(finite(speedMetersPerSecond));
    return 0.08 + 0.92 / (1 + Math.pow(speed / 11, 2));
}

function gtaHeadingToDataRad(degrees) {
    return (Math.PI * 0.5) + finite(degrees) * (Math.PI / 180.0);
}

function dataRadToGtaHeading(radians) {
    return (finite(radians) - (Math.PI * 0.5)) * (180.0 / Math.PI);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, finite(value)));
}

const WHEEL_TAGS = Object.freeze({
    frontLeft: '27922', frontRight: '26418', rearLeft: '27902', rearRight: '26398',
});

const SURFACE_GRIP = Object.freeze({
    asphalt: 1.0,
    concrete: 0.97,
    metal: 0.78,
    dirt: 0.74,
    gravel: 0.68,
    grass: 0.62,
    sand: 0.55,
    mud: 0.48,
    ice: 0.22,
});

function surfaceProfile(ground) {
    const raw = String(ground?.material || ground?.surface || '').toLowerCase();
    const source = String(ground?.source || '').toLowerCase();
    const gripClass = Object.keys(SURFACE_GRIP).find((name) => raw.includes(name))
        || (source === 'terrain' ? 'dirt' : source === 'interior' ? 'concrete' : 'asphalt');
    const material = raw || gripClass;
    const authoredGrip = Number(ground?.grip);
    return {
        material,
        grip: Number.isFinite(authoredGrip) ? clamp(authoredGrip, 0.1, 1.5) : (SURFACE_GRIP[gripClass] || 1.0),
        damping: Math.max(0.0, finite(ground?.damping)),
        validTrack: ground?.validTrack === true,
        pitlane: ground?.pitlane === true,
    };
}

const SULTAN_WHEEL_PIVOTS = Object.freeze({
    [WHEEL_TAGS.frontLeft]: Object.freeze([-0.7025, 1.3375, -0.0775]),
    [WHEEL_TAGS.frontRight]: Object.freeze([0.7025, 1.3375, -0.0775]),
    [WHEEL_TAGS.rearLeft]: Object.freeze([-0.7025, -1.3375, -0.0775]),
    [WHEEL_TAGS.rearRight]: Object.freeze([0.7025, -1.3375, -0.0775]),
});

const SULTAN_DRIVER_SEAT_LOCAL = Object.freeze([-0.367056, -0.027149, 0.074445]);
const DEFAULT_HANDLING = Object.freeze({
    mass: 1450, dragCoeff: 8.0, percentSubmerged: 85,
    centerOfMass: Object.freeze([0.0, 0.0, 0.0]), inertiaMultiplier: Object.freeze([1.0, 1.0, 1.0]),
    driveBiasFront: 0.35, driveBiasBack: 0.0, gears: 5, driveForce: 0.3, driveInertia: 1.0,
    clutchChangeRateUpShift: 3.0, clutchChangeRateDownShift: 3.0,
    maxFlatVelocity: 151.2, brakeForce: 0.8, brakeBiasFront: 0.5, handBrakeForce: 0.7, steeringLock: 35,
    tractionMax: 2.2, tractionMin: 2.0, tractionLateral: 22.5, tractionSpringDeltaMax: 0.15,
    lowSpeedTractionLossMult: 1.0, camberStiffness: 0.0, tractionBiasFront: 0.5, tractionLossMult: 1.0,
    suspensionForce: 2.0, suspensionCompDamp: 1.0, suspensionReboundDamp: 1.5,
    suspensionUpperLimit: 0.1, suspensionLowerLimit: -0.1, suspensionRaise: 0.0, suspensionBiasFront: 0.5,
    antiRollBarForce: 0.7, antiRollBarBiasFront: 0.5, rollCentreHeightFront: 0.35, rollCentreHeightRear: 0.35,
    collisionDamageMult: 1.0, weaponDamageMult: 1.0, deformationDamageMult: 1.0, engineDamageMult: 1.0,
    petrolTankVolume: 65, oilVolume: 5, downforceModifier: 0.0,
});

function vec3(value, fallback) {
    return Array.isArray(value) && value.length >= 3
        ? [finite(value[0], fallback[0]), finite(value[1], fallback[1]), finite(value[2], fallback[2])]
        : [...fallback];
}

function normalizedHandling(value) {
    const handling = value && typeof value === 'object' ? value : {};
    return {
        ...DEFAULT_HANDLING,
        ...handling,
        centerOfMass: vec3(handling.centerOfMass, DEFAULT_HANDLING.centerOfMass),
        inertiaMultiplier: vec3(handling.inertiaMultiplier, DEFAULT_HANDLING.inertiaMultiplier),
    };
}

function normalizedCamera(value) {
    const camera = value && typeof value === 'object' ? value : {};
    return {
        povOffset: vec3(camera.povOffset, [0.0, 0.0, 0.6]),
        povRollCageAdjustment: finite(camera.povRollCageAdjustment),
        followCamera: String(camera.followCamera || ''),
        aimCamera: String(camera.aimCamera || ''),
        bonnetCamera: String(camera.bonnetCamera || ''),
    };
}

function normalizedDamage(value) {
    const damage = value && typeof value === 'object' ? value : {};
    return {
        bodyHealth: clamp(finite(damage.bodyHealth, 1000), 250, 2500),
        mapScale: clamp(finite(damage.mapScale, 0.5), 0, 2),
        offsetScale: clamp(finite(damage.offsetScale, 0.5), 0, 2),
        weaponForceMult: clamp(finite(damage.weaponForceMult, 1), 0.1, 4),
    };
}

function normalizedWheelRadii(value, fallback) {
    const radii = value && typeof value === 'object' ? value : {};
    const fallbackRadius = Math.max(0.15, finite(fallback, 0.35));
    return Object.fromEntries(Object.values(WHEEL_TAGS).map((tag) => [tag, Math.max(0.15, finite(radii[tag], fallbackRadius))]));
}

const SULTAN_DEFINITION = Object.freeze({
    model: 'sultan', hash: '970598228', name: 'Karin Sultan',
    groundOffset: 0.4, wheelRadius: 0.4, collisionRadius: 1.15,
    driverSeat: SULTAN_DRIVER_SEAT_LOCAL,
    wheelPivots: SULTAN_WHEEL_PIVOTS,
    audioNameHash: 'SULTAN',
    handling: DEFAULT_HANDLING,
    camera: Object.freeze({ povOffset: Object.freeze([0.0, 0.0, 0.6]), povRollCageAdjustment: 0.0 }),
    damage: Object.freeze({ bodyHealth: 1000, mapScale: 0.5, offsetScale: 0.5, weaponForceMult: 1.0 }),
});

export class VehicleController {
    constructor(app) {
        this.app = app;
        this.manifest = null;
        this.inVehicle = false;
        this.vehicle = null;
        this.lastEvent = '';
        this.lastCollision = null;
        this.enterDistance = 3.2;
        // Sultan's baked wheel contact plane is 0.3995 m below its model origin.
        this.groundOffset = 0.4;
        this.customCatalog = null;
        this.customCatalogPromise = null;
        // Avoid spawning the unavailable built-in fallback while the custom
        // vehicle catalog is still resolving during the first gameplay tick.
        this._customCatalogResolved = false;
        this._demoVehicleSpawnPending = false;
        this._wasExitDown = false;
        this._lastDamageAt = 0;
        this.physicsMode = 'gta';
        this.diagnostics = new VehicleDiagnostics();
        this._assettoProfileCache = new Map();
        this._assettoProfilePromises = new Map();
        // A parked, occupied vehicle has no swept movement to resolve. Keep the
        // last wheel contacts briefly so sitting in a car does not repeatedly
        // query the full YBN ground stack before the driver starts moving.
        this._idleWheelContactSeconds = Number.POSITIVE_INFINITY;
        this._idleWheelVisualSeconds = Number.POSITIVE_INFINITY;
        this._movingWheelContactSeconds = Number.POSITIVE_INFINITY;
        this._renderState = { position: [0.0, 0.0, 0.0] };
    }

    _recordCollision(move, vehicle) {
        if (!move?.blocked) return;
        const hit = move.hit || null;
        this.lastCollision = {
            at: Date.now(),
            position: [
                finite(vehicle?.position?.[0]),
                finite(vehicle?.position?.[1]),
                finite(vehicle?.position?.[2]),
            ],
            source: String(hit?.source || ''),
            id: String(hit?.id || ''),
            reason: String(move.reason || ''),
            triangleOffset: Number.isFinite(Number(hit?.triangleOffset)) ? Number(hit.triangleOffset) : null,
            chassisProbeOffset: Number.isFinite(Number(hit?.chassisProbeOffset)) ? Number(hit.chassisProbeOffset) : null,
            normal: [finite(hit?.normalX), finite(hit?.normalY)],
            obstacle: hit ? {
                minZ: Number.isFinite(Number(hit.minZ)) ? Number(hit.minZ) : null,
                maxZ: Number.isFinite(Number(hit.maxZ)) ? Number(hit.maxZ) : null,
            } : null,
        };
        this.diagnostics?.event('collision', { ...this.lastCollision });
    }

    setManifest(manifest) {
        this.manifest = manifest && typeof manifest === 'object' ? manifest : null;
        this._ensureDemoVehicle();
    }

    setPhysicsMode(mode) {
        const next = normalizeVehiclePhysicsMode(mode);
        this.physicsMode = next;
        if (this.vehicle) {
            this.vehicle.physicsMode = next;
            this.vehicle.velocityLocal[1] = 0.0;
            this.vehicle.yawRate *= 0.5;
            if (next === 'assetto') {
                // A mode change must adopt the currently visible vehicle state.
                // Starting a blank solver here used to discard forward speed and
                // leave wheel speed from an unrelated prior run.
                this.resetAssettoState({ preserveMotion: true });
                void this._loadAssettoProfile(this.vehicle);
            } else {
                this.vehicle.assettoSolver = null;
            }
        }
        this.lastEvent = `driving mode: ${vehiclePhysicsModeLabel(next)}`;
        return next;
    }

    resetAssettoState({ preserveMotion = false } = {}) {
        const vehicle = this.vehicle;
        if (!vehicle) return null;
        const state = createAssettoVehicleState();
        const profile = vehicle.assettoHandling && typeof vehicle.assettoHandling === 'object'
            ? vehicle.assettoHandling
            : {};
        if (preserveMotion) {
            state.longitudinal = finite(vehicle.velocityLocal?.[0], vehicle.speed);
            state.lateral = finite(vehicle.velocityLocal?.[1]);
            state.yawRate = finite(vehicle.yawRate);
            state.rpm = Math.max(finite(profile.idleRpm, 850), finite(vehicle.rpm, 850));
            state.gear = Math.max(1, Math.min(Array.isArray(profile.gearRatios) ? profile.gearRatios.length : 6, Math.floor(finite(vehicle.gear, 1))));
            for (const key of Object.keys(state.wheelOmega)) {
                const axle = key === WHEEL_TAGS.frontLeft || key === WHEEL_TAGS.frontRight ? 'front' : 'rear';
                const radius = Math.max(0.15, finite(profile.tyres?.[axle]?.radius, vehicle.wheelRadii?.[key] ?? vehicle.wheelRadius));
                state.wheelOmega[key] = state.longitudinal / radius;
            }
        }
        vehicle.assettoSolver = state;
        return state;
    }

    getPhysicsMode() {
        return normalizeVehiclePhysicsMode(this.vehicle?.physicsMode || this.physicsMode);
    }

    startDiagnostics(label = 'manual') {
        const vehicle = this.vehicle;
        if (!vehicle) return null;
        return this.diagnostics.start({
            label,
            vehicleId: vehicle.id,
            model: vehicle.model,
            name: vehicle.name,
            physicsMode: this.getPhysicsMode(),
            profileStatus: vehicle.assettoProfileStatus || 'none',
            profileSource: vehicle.assettoProfileSource || null,
            handling: { ...vehiclePhysicsHandling(vehicle) },
        });
    }

    stopDiagnostics() {
        return this.diagnostics.stop();
    }

    getDiagnostics(options) {
        return this.diagnostics.snapshot(options);
    }

    async _loadAssettoProfile(vehicle) {
        const model = String(vehicle?.model || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
        if (!model || !vehicle || vehicle.assettoProfileStatus === 'loaded') return vehicle?.assettoHandling || null;
        if (this._assettoProfileCache.has(model)) {
            const cached = this._assettoProfileCache.get(model);
            if (this.vehicle?.id === vehicle.id && cached) {
                vehicle.assettoHandling = { ...cached.assettoHandling };
                vehicle.assettoProfileSource = cached.source || null;
                vehicle.assettoProfileStatus = 'loaded';
                vehicle.assettoProfileError = null;
            }
            return cached?.assettoHandling || null;
        }
        if (this._assettoProfilePromises.has(model)) return this._assettoProfilePromises.get(model);
        vehicle.assettoProfileStatus = 'loading';
        vehicle.assettoProfileError = null;
        const profileUrl = `/assets/physics/assetto-corsa/${encodeURIComponent(model)}.json`;
        vehicle.assettoProfileUrl = profileUrl;
        const promise = fetch(profileUrl, { cache: 'no-store' })
            .then((response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.json();
            })
            .then((profile) => {
                if (profile?.schema !== 'webglgta-assetto-corsa-profile-v1' || !profile?.assettoHandling || typeof profile.assettoHandling !== 'object') {
                    throw new Error('invalid Assetto profile schema');
                }
                this._assettoProfileCache.set(model, profile);
                if (this.vehicle?.id === vehicle.id) {
                    vehicle.assettoHandling = { ...profile.assettoHandling };
                    vehicle.assettoProfileSource = profile.source || null;
                    vehicle.assettoProfileStatus = 'loaded';
                    vehicle.assettoProfileError = null;
                    if (this.getPhysicsMode() === 'assetto') this.resetAssettoState({ preserveMotion: true });
                    this.lastEvent = `loaded local Assetto profile: ${model}`;
                    this.diagnostics.event('assetto_profile_loaded', { model, source: profile.source || null });
                }
                return profile.assettoHandling;
            })
            .catch((error) => {
                const message = String(error?.message || error || 'profile load failed');
                if (this.vehicle?.id === vehicle.id) vehicle.assettoProfileError = message;
                this.diagnostics.event('assetto_profile_failed', { model, url: profileUrl, error: message });
                console.warn(`[vehicle] Assetto profile ${model} unavailable at ${profileUrl}: ${message}`);
                return null;
            })
            .finally(() => {
                if (this.vehicle?.id === vehicle.id && vehicle.assettoProfileStatus === 'loading') vehicle.assettoProfileStatus = 'baseline';
                this._assettoProfilePromises.delete(model);
            });
        this._assettoProfilePromises.set(model, promise);
        return promise;
    }

    _ensureDemoVehicle() {
        if (this.vehicle || !this.app?.spawnDistrictDemo) return;
        // The gameplay manifest arrives before the ped is spawned. Creating the
        // demo car at that point selected the static garage fallback, which is
        // often out of sight and outside the enter prompt radius. Wait until the
        // character has a real data-space position, then place the vehicle nearby.
        const ped = this.app?.ped?.posData;
        const hasPedPosition = Array.isArray(ped)
            && ped.length >= 3
            && [ped[0], ped[1], ped[2]].every((value) => Number.isFinite(Number(value)));
        if (!hasPedPosition) {
            if (!this._customCatalogResolved && !this._demoVehicleSpawnPending) {
                this._demoVehicleSpawnPending = true;
                void this.loadCustomCatalog().finally(() => {
                    this._demoVehicleSpawnPending = false;
                });
            }
            return;
        }
        if (this._customCatalogResolved) {
            this.spawnDemoVehicle();
            return;
        }
        if (this._demoVehicleSpawnPending) return;
        this._demoVehicleSpawnPending = true;
        void this.loadCustomCatalog().finally(() => {
            this._demoVehicleSpawnPending = false;
            this._ensureDemoVehicle();
        });
    }

    async loadCustomCatalog() {
        if (this.customCatalog) return this.customCatalog;
        if (this.customCatalogPromise) return this.customCatalogPromise;
        this.customCatalogPromise = fetch('assets/custom_vehicles/catalog.json?rev=autos-20260815', { cache: 'no-store' })
            .then((response) => response.ok ? response.json() : null)
            .then((catalog) => {
                this.customCatalog = catalog && Array.isArray(catalog.vehicles) ? catalog : null;
                return this.customCatalog;
            })
            .catch(() => null)
            .finally(() => {
                this._customCatalogResolved = true;
                this.customCatalogPromise = null;
            });
        return this.customCatalogPromise;
    }

    _definitionForModel(model) {
        const wanted = String(model || '').toLowerCase();
        return this.customCatalog?.vehicles?.find?.((row) => String(row?.model || '').toLowerCase() === wanted) || null;
    }

    _defaultDefinition() {
        const preferred = String(this.customCatalog?.defaultVehicle || '').toLowerCase();
        return this._definitionForModel(preferred) || this.customCatalog?.vehicles?.[0] || SULTAN_DEFINITION;
    }

    spawnDemoVehicle() {
        const spawn = this._chooseDemoVehicleSpawn();
        const definition = this._defaultDefinition();
        return this.spawnVehicle({
            ...definition,
            coords: spawn.coords,
            source: spawn.source,
        });
    }

    spawnVehicle(options = {}) {
        const selected = this._definitionForModel(options.model) || {};
        const definition = { ...SULTAN_DEFINITION, ...selected, ...options };
        const { model, hash, name, coords = null, source = '' } = definition;
        const groundOffset = Math.max(0.15, finite(definition.groundOffset, 0.4));
        const c = coords || { x: 221.54, y: -806.78, z: 30.67, w: 69.92 };
        const x = finite(c.x, 221.54);
        const y = finite(c.y, -806.78);
        const requestedZ = finite(c.z, 30.67);
        const ground = this._resolveGround(x, y, requestedZ);
        const groundZ = Number.isFinite(Number(ground?.z)) ? Number(ground.z) : requestedZ;
        this.inVehicle = false;
        const damageConfig = normalizedDamage(definition.damage);
        this.vehicle = {
            id: `vehicle_${Date.now().toString(36)}`,
            model: String(model || 'sultan'),
            hash: String(hash || '970598228'),
            name: String(name || model || 'Karin Sultan'),
            source: String(source || ''),
            position: [x, y, groundZ + groundOffset],
            headingRad: gtaHeadingToDataRad(c.w),
            speed: 0.0,
            velocityLocal: [0.0, 0.0],
            yawRate: 0.0,
            steering: 0.0,
            steeringRad: 0.0,
            throttle: 0.0,
            brake: 0.0,
            wheelRotationRad: 0.0,
            wheelStates: {},
            rpm: 850.0,
            gear: 1,
            shiftTimer: 0.0,
            engineLoad: 0.0,
            tireSlip: 0.0,
            bodyPitch: 0.0,
            verticalVelocity: 0.0,
            longitudinalAcceleration: 0.0,
            groundSource: String(ground?.source || 'server_garage'),
            health: damageConfig.bodyHealth,
            bodyHealth: damageConfig.bodyHealth,
            engineHealth: 1000,
            damage: 0,
            destroyed: false,
            suspension: 0,
            bodyRoll: 0,
            groundOffset,
            wheelRadius: Math.max(0.15, finite(definition.wheelRadius, groundOffset)),
            wheelRadii: normalizedWheelRadii(definition.wheelRadii, definition.wheelRadius ?? groundOffset),
            wheelPivots: definition.wheelPivots && typeof definition.wheelPivots === 'object' ? { ...definition.wheelPivots } : null,
            collisionRadius: Math.max(0.7, finite(definition.collisionRadius, 1.15)),
            driverSeat: Array.isArray(definition.driverSeat) ? definition.driverSeat.slice(0, 3).map(Number) : [...SULTAN_DRIVER_SEAT_LOCAL],
            handling: normalizedHandling(definition.handling),
            physicsMode: normalizeVehiclePhysicsMode(options.physicsMode || this.physicsMode),
            assettoHandling: definition.assettoHandling && typeof definition.assettoHandling === 'object' ? { ...definition.assettoHandling } : null,
            camera: normalizedCamera(definition.camera),
            damageConfig,
            steerWheelMult: clamp(finite(definition.steerWheelMult, 1.0), 0.1, 3.0),
            audioNameHash: String(definition.audioNameHash || SULTAN_DEFINITION.audioNameHash),
            assetManifest: String(definition.manifest || ''),
            metadataPath: String(definition.metadata || ''),
        };
        this.groundOffset = groundOffset;
        this._idleWheelContactSeconds = Number.POSITIVE_INFINITY;
        this._idleWheelVisualSeconds = Number.POSITIVE_INFINITY;
        this._movingWheelContactSeconds = Number.POSITIVE_INFINITY;
        this.vehicle._chassisGroundCache = null;
        this.lastEvent = `spawned ${this.vehicle.name}`;
        if (this.physicsMode === 'assetto') void this._loadAssettoProfile(this.vehicle);
        return this.vehicle;
    }

    spawnVehicleNearPlayer(model) {
        const definition = this._definitionForModel(model);
        if (!definition) return null;
        const occupied = !!this.inVehicle && !!this.vehicle;
        const headingRad = occupied
            ? finite(this.vehicle.headingRad)
            : finite(this.app?.player?.headingRad);
        const ped = this.app?.ped?.posData;
        const base = occupied ? this.vehicle.position : ped;
        if (!Array.isArray(base) && !(base instanceof Float32Array)) return null;
        const distance = occupied ? 0.0 : Math.max(3.5, finite(definition.collisionRadius, 1.0) * 2.6);
        const x = finite(base[0]) + Math.cos(headingRad) * distance;
        const y = finite(base[1]) + Math.sin(headingRad) * distance;
        const z = occupied
            ? finite(base[2]) - finite(this.vehicle?.groundOffset, 0.4)
            : finite(base[2]) - finite(this.app?.pedEyeHeightData, 1.2);
        const vehicle = this.spawnVehicle({
            ...definition,
            coords: { x, y, z, w: dataRadToGtaHeading(headingRad) },
            source: 'chat_vehicle_menu',
        });
        if (occupied && vehicle) {
            this.inVehicle = true;
            this._syncOccupantPed();
        }
        return vehicle;
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
        const definition = this._definitionForModel(state.model) || {};
        const groundOffset = Math.max(0.15, finite(state.groundOffset, definition.groundOffset ?? this.groundOffset));
        const restoredZ = Number.isFinite(Number(restoredGround?.z))
            ? Number(restoredGround.z) + groundOffset
            : position[2];
        const damageConfig = normalizedDamage(state.damageConfig || definition.damage);
        const bodyHealth = clamp(finite(state.bodyHealth, damageConfig.bodyHealth), 250, 2500);
        this.vehicle = {
            id: String(state.id || `vehicle_${Date.now().toString(36)}`),
            model: String(state.model || 'sultan'),
            hash: String(state.hash || '970598228'),
            name: String(state.name || 'Karin Sultan'),
            source: String(state.source || 'gameplay_restore'),
            position: [position[0], position[1], restoredZ],
            headingRad: finite(state.headingRad),
            speed: Math.max(-12.0, Math.min(42.0, finite(state.speed))),
            velocityLocal: Array.isArray(state.velocityLocal) && state.velocityLocal.length >= 2
                ? [finite(state.velocityLocal[0]), finite(state.velocityLocal[1])]
                : [finite(state.speed), 0.0],
            yawRate: finite(state.yawRate),
            steering: Math.max(-1.0, Math.min(1.0, finite(state.steering))),
            steeringRad: finite(state.steeringRad),
            throttle: clamp(state.throttle, -1.0, 1.0),
            brake: clamp(state.brake, 0.0, 1.0),
            wheelRotationRad: finite(state.wheelRotationRad),
            wheelStates: state.wheelStates && typeof state.wheelStates === 'object' ? { ...state.wheelStates } : {},
            rpm: clamp(state.rpm, 650, 9000) || 850.0,
            gear: Math.max(1, Math.min(10, Number(state.gear) | 0 || 1)),
            shiftTimer: Math.max(0, finite(state.shiftTimer)),
            engineLoad: clamp(state.engineLoad, 0, 1),
            tireSlip: clamp(state.tireSlip, 0, 1),
            bodyPitch: clamp(state.bodyPitch, -0.35, 0.35),
            verticalVelocity: finite(state.verticalVelocity),
            longitudinalAcceleration: finite(state.longitudinalAcceleration),
            groundSource: String(state.groundSource || 'gameplay_restore'),
            health: Math.max(0, Math.min(bodyHealth, finite(state.health, bodyHealth))),
            bodyHealth,
            engineHealth: clamp(finite(state.engineHealth, 1000), 0, 1000),
            damage: Math.max(0, Math.min(bodyHealth, finite(state.damage, 0))),
            destroyed: !!state.destroyed,
            suspension: finite(state.suspension),
            bodyRoll: finite(state.bodyRoll),
            groundOffset,
            wheelRadius: Math.max(0.15, finite(state.wheelRadius, definition.wheelRadius ?? groundOffset)),
            wheelRadii: normalizedWheelRadii(state.wheelRadii || definition.wheelRadii, state.wheelRadius ?? definition.wheelRadius ?? groundOffset),
            wheelPivots: state.wheelPivots || definition.wheelPivots || null,
            collisionRadius: Math.max(0.7, finite(state.collisionRadius, definition.collisionRadius ?? 1.15)),
            driverSeat: Array.isArray(state.driverSeat || definition.driverSeat) ? (state.driverSeat || definition.driverSeat).slice(0, 3).map(Number) : [...SULTAN_DRIVER_SEAT_LOCAL],
            handling: normalizedHandling({ ...(definition.handling || {}), ...(state.handling || {}) }),
            physicsMode: normalizeVehiclePhysicsMode(state.physicsMode || this.physicsMode),
            assettoHandling: state.assettoHandling && typeof state.assettoHandling === 'object' ? { ...state.assettoHandling } : (definition.assettoHandling || null),
            camera: normalizedCamera(state.camera || definition.camera),
            damageConfig,
            steerWheelMult: clamp(finite(state.steerWheelMult, definition.steerWheelMult ?? 1.0), 0.1, 3.0),
            audioNameHash: String(state.audioNameHash || definition.audioNameHash || SULTAN_DEFINITION.audioNameHash),
            assetManifest: String(state.assetManifest || definition.manifest || ''),
            metadataPath: String(state.metadataPath || definition.metadata || ''),
        };
        this.groundOffset = groundOffset;
        this.physicsMode = normalizeVehiclePhysicsMode(this.vehicle.physicsMode);
        this.inVehicle = !!occupied;
        this._idleWheelContactSeconds = Number.POSITIVE_INFINITY;
        this._idleWheelVisualSeconds = Number.POSITIVE_INFINITY;
        this._movingWheelContactSeconds = Number.POSITIVE_INFINITY;
        this.vehicle._chassisGroundCache = null;
        if (this.inVehicle) this._syncOccupantPed();
        this.lastEvent = `restored ${this.vehicle.name}`;
        return true;
    }

    update({ action = null, keyState = null, dt = 1 / 60 } = {}) {
        this.lastEvent = '';
        this._ensureDemoVehicle();
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
        this.vehicle.velocityLocal = [0.0, 0.0];
        this.vehicle.yawRate = 0.0;
        this._idleWheelContactSeconds = Number.POSITIVE_INFINITY;
        this._idleWheelVisualSeconds = Number.POSITIVE_INFINITY;
        this._movingWheelContactSeconds = Number.POSITIVE_INFINITY;
        this.vehicle._chassisGroundCache = null;
        this.lastEvent = `entered ${this.vehicle.name}`;
        this._syncOccupantPed();
        try { this.app?._resetPedMotion?.(); } catch { /* ignore */ }
        try { this.app?._setGtaThirdPersonRigForPed?.({ distanceData: 10.5, heightData: 3.2, sideData: 0.6 }); } catch { /* ignore */ }
        try { this.app?._applyPreferredVehicleCamera?.(); } catch { /* ignore */ }
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
        const feetZ = Number.isFinite(Number(ground?.z)) ? Number(ground.z) : v.position[2] - v.groundOffset;
        this.inVehicle = false;
        v.speed = 0.0;
        v.velocityLocal = [0.0, 0.0];
        v.yawRate = 0.0;
        this._placePed(x, y, feetZ);
        this.lastEvent = `${reason} ${v.name}`;
        try { this.app?._setGtaThirdPersonRigForPed?.({ distanceData: 6.0, heightData: 1.7, sideData: 0.6 }); } catch { /* ignore */ }
        try { this.app?._syncVehicleCameraViewControls?.(); } catch { /* ignore */ }
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
        // This feeds audio, rendering, multiplayer, persistence, and HUD code
        // every frame. Keep snapshot semantics for the position while reusing
        // the outer object to avoid copying a full vehicle record several times
        // per frame.
        const state = this._renderState || (this._renderState = { position: [0.0, 0.0, 0.0] });
        const position = state.position || [0.0, 0.0, 0.0];
        Object.assign(state, this.vehicle);
        state.position = position;
        position[0] = finite(this.vehicle.position?.[0]);
        position[1] = finite(this.vehicle.position?.[1]);
        position[2] = finite(this.vehicle.position?.[2]);
        state.occupied = this.inVehicle;
        return state;
    }

    getDriverSeatTransform() {
        const v = this.vehicle;
        if (!v) return null;
        const local = Array.isArray(v.driverSeat) ? v.driverSeat : SULTAN_DRIVER_SEAT_LOCAL;
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

    getDriverCameraTransform() {
        const v = this.vehicle;
        if (!v) return null;
        const seat = Array.isArray(v.driverSeat) ? v.driverSeat : SULTAN_DRIVER_SEAT_LOCAL;
        // PovCameraOffset is vehicle-specific FiveM metadata. It is relative to
        // the driver layout anchor, not a world-space camera coordinate.
        const pov = vec3(v.camera?.povOffset, [0.0, 0.0, 0.6]);
        const local = [
            finite(seat[0]) + pov[0],
            finite(seat[1]) + pov[1],
            finite(seat[2]) + pov[2] + finite(v.camera?.povRollCageAdjustment),
        ];
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
        if (this.inVehicle) {
            const profile = this.getPhysicsMode() === 'assetto'
                ? ` ${this.vehicle.assettoProfileStatus === 'loaded' ? 'local profile' : 'baseline'}`
                : '';
            const gear = this.vehicle.transmissionDirection < 0 ? 'R' : (this.vehicle.gear || 1);
            return `Vehicle: ${this.vehicle.name} ${speedMph.toFixed(0)} mph  gear ${gear}  ${Math.round(this.vehicle.rpm || 0)} rpm  ${vehiclePhysicsModeLabel(this.getPhysicsMode())}${profile}`;
        }
        const distance = this.getDistanceToPlayer();
        return `Vehicle: ${this.vehicle.name} parked distance=${Number.isFinite(distance) ? distance.toFixed(1) : 'n/a'}m`;
    }

    _updateDriving(dt, keyState) {
        const step = Math.max(0.001, Math.min(0.05, finite(dt, 1 / 60)));
        const assetto = this.getPhysicsMode() === 'assetto';
        const fixedStep = assetto ? (1 / 120) : (1 / 60);
        let remaining = step;
        let substeps = 0;
        // Assetto mode owns a dedicated 120 Hz wheel/drivetrain solver. GTA
        // mode retains its established 60 Hz arcade path unchanged.
        while (remaining > 0.00001) {
            const physicsStep = Math.min(fixedStep, remaining);
            const processFrameInteractions = remaining - physicsStep <= 0.00001;
            if (assetto) this._stepAssettoDriving(physicsStep, keyState, { processFrameInteractions });
            else this._stepDriving(physicsStep, keyState, { processFrameInteractions });
            remaining -= physicsStep;
            substeps++;
        }
        this._lastPhysicsStats = { substeps, stepSeconds: step, fixedStep, backend: assetto ? 'assetto-four-wheel-v1' : 'gta' };
    }

    _wheelLayout(vehicle) {
        const pivots = vehicle?.wheelPivots && typeof vehicle.wheelPivots === 'object'
            ? vehicle.wheelPivots
            : SULTAN_WHEEL_PIVOTS;
        return [
            { tag: WHEEL_TAGS.frontLeft, front: true, left: true, pivot: pivots[WHEEL_TAGS.frontLeft] || SULTAN_WHEEL_PIVOTS[WHEEL_TAGS.frontLeft] },
            { tag: WHEEL_TAGS.frontRight, front: true, left: false, pivot: pivots[WHEEL_TAGS.frontRight] || SULTAN_WHEEL_PIVOTS[WHEEL_TAGS.frontRight] },
            { tag: WHEEL_TAGS.rearLeft, front: false, left: true, pivot: pivots[WHEEL_TAGS.rearLeft] || SULTAN_WHEEL_PIVOTS[WHEEL_TAGS.rearLeft] },
            { tag: WHEEL_TAGS.rearRight, front: false, left: false, pivot: pivots[WHEEL_TAGS.rearRight] || SULTAN_WHEEL_PIVOTS[WHEEL_TAGS.rearRight] },
        ].filter((wheel) => Array.isArray(wheel.pivot) && wheel.pivot.length >= 3);
    }

    _sampleWheelContacts(vehicle) {
        const layout = this._wheelLayout(vehicle);
        const handling = vehiclePhysicsHandling(vehicle) || DEFAULT_HANDLING;
        const heading = finite(vehicle.headingRad) - Math.PI * 0.5;
        const cos = Math.cos(heading);
        const sin = Math.sin(heading);
        const contacts = {};
        let total = 0.0;
        let count = 0;
        let frontTotal = 0.0;
        let frontCount = 0;
        let rearTotal = 0.0;
        let rearCount = 0;
        let leftTotal = 0.0;
        let leftCount = 0;
        let rightTotal = 0.0;
        let rightCount = 0;
        let gripTotal = 0.0;
        let dampingTotal = 0.0;
        let validTrackCount = 0;
        let pitlaneCount = 0;
        let groundedCount = 0;
        let frontGrounded = 0;
        let rearGrounded = 0;
        const materialCounts = new Map();
        for (const wheel of layout) {
            const local = wheel.pivot;
            const x = vehicle.position[0] + cos * finite(local[0]) - sin * finite(local[1]);
            const y = vehicle.position[1] + sin * finite(local[0]) + cos * finite(local[1]);
            const ground = this._resolveGround(x, y, vehicle.position[2] - vehicle.groundOffset);
            const z = Number.isFinite(Number(ground?.z)) ? Number(ground.z) : (vehicle.position[2] - vehicle.groundOffset);
            const surface = surfaceProfile(ground);
            const radius = Math.max(0.15, finite(vehicle.wheelRadii?.[wheel.tag], vehicle.wheelRadius));
            const hubZ = vehicle.position[2] + finite(local[2]);
            const wantedOffset = z + radius - hubZ;
            const lowerLimit = Math.min(-0.04, finite(handling.suspensionLowerLimit, -0.1));
            const upperLimit = Math.max(0.04, finite(handling.suspensionUpperLimit, 0.1));
            const grounded = wantedOffset >= lowerLimit - 0.05;
            const suspensionOffset = clamp(wantedOffset, lowerLimit, upperLimit);
            contacts[wheel.tag] = {
                x, y, z,
                source: String(ground?.source || 'runtime'),
                material: surface.material,
                grip: surface.grip,
                damping: surface.damping,
                validTrack: surface.validTrack,
                pitlane: surface.pitlane,
                grounded,
                suspensionOffset,
                compression: clamp((suspensionOffset - lowerLimit) / Math.max(0.01, upperLimit - lowerLimit), 0, 1),
                front: wheel.front,
                left: wheel.left,
            };
            if (!grounded) continue;
            groundedCount++;
            if (wheel.front) frontGrounded++; else rearGrounded++;
            gripTotal += surface.grip;
            dampingTotal += surface.damping;
            if (surface.validTrack) validTrackCount++;
            if (surface.pitlane) pitlaneCount++;
            materialCounts.set(surface.material, (materialCounts.get(surface.material) || 0) + 1);
            total += z;
            count++;
            if (wheel.front) { frontTotal += z; frontCount++; } else { rearTotal += z; rearCount++; }
            if (wheel.left) { leftTotal += z; leftCount++; } else { rightTotal += z; rightCount++; }
        }
        const average = count ? total / count : vehicle.position[2] - vehicle.groundOffset;
        const front = frontCount ? frontTotal / frontCount : average;
        const rear = rearCount ? rearTotal / rearCount : average;
        const left = leftCount ? leftTotal / leftCount : average;
        const right = rightCount ? rightTotal / rightCount : average;
        const wheelbase = Math.max(2.0, Math.min(5.5, this._wheelbase(vehicle)));
        const track = Math.max(1.1, Math.min(3.0, this._trackWidth(vehicle)));
        const material = [...materialCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'asphalt';
        return {
            contacts,
            average,
            front,
            rear,
            left,
            right,
            material,
            grip: count ? gripTotal / count : 1.0,
            damping: count ? dampingTotal / count : 0.0,
            validTrack: count > 0 && validTrackCount === count,
            pitlane: pitlaneCount > 0,
            groundedCount,
            frontGrounded,
            rearGrounded,
            pitch: clamp(Math.atan2(front - rear, wheelbase), -0.24, 0.24),
            roll: clamp(Math.atan2(right - left, track), -0.24, 0.24),
        };
    }

    _updateWheelVisuals(vehicle, dt, contacts = null) {
        const wheels = this._wheelLayout(vehicle);
        const states = vehicle.wheelStates && typeof vehicle.wheelStates === 'object' ? vehicle.wheelStates : {};
        const speed = finite(vehicle.velocityLocal?.[0], vehicle.speed);
        const currentSpin = finite(vehicle.wheelRotationRad);
        const averageRadius = Math.max(0.15, finite(vehicle.wheelRadius, 0.33));
        const assettoWheelOmega = vehicle.assettoSolver?.wheelOmega;
        const meanOmega = assettoWheelOmega
            ? Object.values(assettoWheelOmega).reduce((sum, value) => sum + finite(value), 0) / Math.max(1, Object.keys(assettoWheelOmega).length)
            : null;
        vehicle.wheelRotationRad = (currentSpin - (meanOmega === null ? (speed / averageRadius) : meanOmega) * dt) % (Math.PI * 2.0);
        const wheelbase = Math.max(2.0, Math.min(5.5, this._wheelbase(vehicle)));
        const track = Math.max(1.1, Math.min(3.0, this._trackWidth(vehicle)));
        const steering = finite(vehicle.steeringRad);
        const handling = vehiclePhysicsHandling(vehicle) || DEFAULT_HANDLING;
        const turnRadius = Math.abs(Math.tan(steering)) > 1e-4 ? wheelbase / Math.abs(Math.tan(steering)) : Infinity;
        for (const wheel of wheels) {
            const prior = states[wheel.tag] || {};
            const radius = Math.max(0.15, finite(vehicle.wheelRadii?.[wheel.tag], averageRadius));
            const spinDelta = Number.isFinite(Number(assettoWheelOmega?.[wheel.tag]))
                ? -Number(assettoWheelOmega[wheel.tag]) * dt
                : -(speed * dt / radius);
            let steeringRad = 0.0;
            if (wheel.front && Number.isFinite(turnRadius)) {
                const innerRadius = Math.max(0.2, turnRadius - track * 0.5);
                const outerRadius = turnRadius + track * 0.5;
                const isInner = (steering > 0.0) === wheel.left;
                steeringRad = Math.sign(steering) * Math.atan(wheelbase / (isInner ? innerRadius : outerRadius));
            }
            const contact = contacts?.contacts?.[wheel.tag] || null;
            const targetSuspension = finite(contact?.suspensionOffset);
            const priorSuspension = Number.isFinite(Number(prior.suspensionOffset))
                ? Number(prior.suspensionOffset)
                : targetSuspension;
            const movingUp = targetSuspension > priorSuspension;
            const damper = movingUp ? handling.suspensionCompDamp : handling.suspensionReboundDamp;
            const suspensionResponse = clamp(
                10.0 + clamp(handling.suspensionForce, 0.2, 8.0) * 3.5 + clamp(damper, 0.1, 8.0) * 1.5,
                12.0,
                38.0,
            );
            const suspensionOffset = priorSuspension
                + (targetSuspension - priorSuspension) * (1.0 - Math.exp(-suspensionResponse * dt));
            states[wheel.tag] = {
                spinRad: (finite(prior.spinRad, currentSpin) + spinDelta) % (Math.PI * 2.0),
                steeringRad,
                grounded: contact?.grounded !== false,
                suspensionOffset,
                compression: finite(contact?.compression),
            };
        }
        vehicle.wheelStates = states;
    }

    _idleWheelContacts(vehicle, dt) {
        this._idleWheelContactSeconds += Math.max(0.0, finite(dt));
        if (!vehicle._wheelContactCache || this._idleWheelContactSeconds >= 0.125) {
            vehicle._wheelContactCache = this._sampleWheelContacts(vehicle);
            this._idleWheelContactSeconds = 0.0;
        }
        return vehicle._wheelContactCache;
    }

    _movingWheelContacts(vehicle, dt) {
        const speed = Math.abs(finite(vehicle.velocityLocal?.[0], vehicle.speed));
        // Wheel contacts are the expensive YBN probe path. A 30 Hz update is
        // stable for normal street driving; at highway speed return to 60 Hz so
        // steep ramps and curbs still receive a probe every simulation step.
        const interval = speed >= 26.0 ? (1.0 / 60.0) : (speed >= 12.0 ? (1.0 / 40.0) : (1.0 / 30.0));
        this._movingWheelContactSeconds += Math.max(0.0, finite(dt));
        if (!vehicle._wheelContactCache || this._movingWheelContactSeconds >= interval) {
            vehicle._wheelContactCache = this._sampleWheelContacts(vehicle);
            this._movingWheelContactSeconds = 0.0;
        }
        return vehicle._wheelContactCache;
    }

    _stepStationaryVehicle(vehicle, handling, dt) {
        // Settle controls and suspension while parked. The next throttle,
        // brake, steer, or handbrake input immediately takes the full physics
        // path below, including swept chassis collision.
        vehicle.throttle += (0.0 - finite(vehicle.throttle)) * (1.0 - Math.exp(-10.5 * dt));
        vehicle.brake += (0.0 - finite(vehicle.brake)) * (1.0 - Math.exp(-12.0 * dt));
        vehicle.engineLoad += (0.0 - finite(vehicle.engineLoad)) * (1.0 - Math.exp(-9.0 * dt));
        vehicle.rpm += (800.0 - finite(vehicle.rpm, 800.0)) * (1.0 - Math.exp(-7.0 * dt));
        vehicle.steering += (0.0 - finite(vehicle.steering)) * (1.0 - Math.exp(-7.5 * dt));
        vehicle.steeringRad = finite(vehicle.steering) * (clamp(handling.steeringLock, 18, 58) || 35) * (Math.PI / 180.0);

        const contacts = this._idleWheelContacts(vehicle, dt);
        const suspensionBiasFront = clamp(handling.suspensionBiasFront, 0.1, 0.9);
        const roadHeight = contacts.front * suspensionBiasFront + contacts.rear * (1.0 - suspensionBiasFront);
        const targetZ = roadHeight + vehicle.groundOffset + clamp(handling.suspensionRaise, -0.45, 0.45);
        const verticalError = targetZ - vehicle.position[2];
        const compressionDamp = verticalError < 0.0 ? handling.suspensionCompDamp : handling.suspensionReboundDamp;
        const suspensionResponse = clamp(5.0 + clamp(handling.suspensionForce, 0.2, 8.0) * 2.8 + clamp(compressionDamp, 0.1, 8.0), 7.0, 30.0);
        const priorZ = vehicle.position[2];
        if (contacts.groundedCount > 0) {
            vehicle.position[2] += verticalError * (1.0 - Math.exp(-suspensionResponse * dt));
            vehicle.verticalVelocity = (vehicle.position[2] - priorZ) / Math.max(dt, 0.001);
        } else {
            vehicle.verticalVelocity = finite(vehicle.verticalVelocity) - 9.81 * dt;
            vehicle.position[2] += vehicle.verticalVelocity * dt;
        }
        const suspensionLower = Math.min(0.0, finite(handling.suspensionLowerLimit, -0.1));
        const suspensionUpper = Math.max(0.0, finite(handling.suspensionUpperLimit, 0.1));
        vehicle.suspension += (clamp(verticalError, suspensionLower, suspensionUpper) - finite(vehicle.suspension))
            * (1.0 - Math.exp(-suspensionResponse * dt));
        const rollCenter = clamp((finite(handling.rollCentreHeightFront) + finite(handling.rollCentreHeightRear)) * 0.5, 0.08, 1.2);
        const antiRoll = clamp(handling.antiRollBarForce, 0.0, 4.0) * (0.55 + clamp(handling.antiRollBarBiasFront, 0.0, 1.0) * 0.45);
        const rollLimit = clamp(0.11 + (suspensionUpper - suspensionLower) * 0.5, 0.12, 0.25);
        vehicle.bodyRoll += (clamp(contacts.roll, -rollLimit, rollLimit) - finite(vehicle.bodyRoll))
            * (1.0 - Math.exp(-(7.0 + antiRoll * 3.0) * dt));
        vehicle.bodyPitch += (clamp(contacts.pitch, -0.25, 0.25) - finite(vehicle.bodyPitch))
            * (1.0 - Math.exp(-(7.0 + clamp(handling.suspensionForce, 0.2, 8.0) * 1.8) * dt));
        const firstContact = contacts.contacts?.[WHEEL_TAGS.frontLeft]
            || contacts.contacts?.[WHEEL_TAGS.frontRight]
            || contacts.contacts?.[WHEEL_TAGS.rearLeft]
            || contacts.contacts?.[WHEEL_TAGS.rearRight];
        vehicle.groundSource = String(firstContact?.source || vehicle.groundSource || 'gameplay');
        vehicle.surfaceMaterial = contacts.material;
        vehicle.surfaceGrip = contacts.grip;
        vehicle.surfaceDamping = contacts.damping;
        vehicle.surfaceValidTrack = contacts.validTrack;
        vehicle.surfacePitlane = contacts.pitlane;
        if (!Array.isArray(vehicle.velocityLocal)) vehicle.velocityLocal = [0.0, 0.0];
        vehicle.velocityLocal[0] = 0.0;
        vehicle.velocityLocal[1] = 0.0;
        vehicle.speed = 0.0;
        vehicle.longitudinalAcceleration = 0.0;
        vehicle.yawRate = 0.0;
        vehicle.tireSlip = 0.0;

        this._idleWheelVisualSeconds += Math.max(0.0, finite(dt));
        if (!Object.keys(vehicle.wheelStates || {}).length || this._idleWheelVisualSeconds >= (1.0 / 30.0)) {
            this._updateWheelVisuals(vehicle, dt, contacts);
            this._idleWheelVisualSeconds = 0.0;
        }
    }

    _stepAssettoDriving(dt, keyState, { processFrameInteractions = true } = {}) {
        const v = this.vehicle;
        if (!v || v.destroyed) {
            if (v) v.speed = 0.0;
            return;
        }
        const imported = v.assettoHandling && typeof v.assettoHandling === 'object' ? v.assettoHandling : {};
        // Fallback values are retained only so an explicit Assetto selection is
        // still driveable while a local profile is loading. Once loaded, all
        // available AC numeric data takes precedence over GTA coefficients.
        const profile = { ...vehiclePhysicsHandling(v), ...imported, tyres: imported.tyres, suspension: imported.suspension };
        const contacts = this._movingWheelContacts(v, dt);
        const solver = v.assettoSolver && typeof v.assettoSolver === 'object' ? v.assettoSolver : createAssettoVehicleState();
        const input = {
            throttle: !!keyState?.w,
            reverse: !!keyState?.s,
            steer: (keyState?.a ? 1 : 0) - (keyState?.d ? 1 : 0),
            handbrake: !!keyState?.[' '] || !!keyState?.space || !!keyState?.spacebar,
        };
        const result = stepAssettoVehicle(solver, profile, contacts, input, dt);
        v.assettoSolver = solver;
        v.throttle = result.throttle;
        v.brake = result.brake;
        v.steering = solver.steering;
        v.steeringRad = result.steeringRad;
        v.rpm = result.rpm;
        v.gear = result.gear;
        v.shiftTimer = result.shiftTimer;
        v.engineLoad = result.engineLoad;

        const forwardX = Math.cos(v.headingRad);
        const forwardY = Math.sin(v.headingRad);
        const rightX = -forwardY;
        const rightY = forwardX;
        let longitudinal = result.longitudinal;
        let lateral = result.lateral;
        let yawRate = result.yawRate;
        let vx = forwardX * longitudinal + rightX * lateral;
        let vy = forwardY * longitudinal + rightY * lateral;
        const speedBefore = finite(v.velocityLocal?.[0], v.speed);
        const collisionArgs = {
            x: v.position[0], y: v.position[1], feetZ: v.position[2] - v.groundOffset,
            vx, vy, dt, heading: v.headingRad,
            halfWidth: Math.max(0.7, this._trackWidth(v) * 0.5 + 0.12),
            halfLength: Math.max(1.45, this._wheelbase(v) * 0.5 + v.wheelRadius * 0.8),
            chassisClearance: Math.max(0.16, v.wheelRadius * 0.55), chassisHeight: 1.15,
            wheelRadius: v.wheelRadius, maxStepUp: 0.65, obstacleStepUp: 0.65, maxSnapDistance: 4.0,
            applyYbnCalibration: false, useDrawableProxies: false, previousGround: v._chassisGroundCache,
        };
        const collisionWorld = this.app?.collisionWorld;
        let move = collisionWorld?.moveVehicle?.(collisionArgs) || collisionWorld?.moveCapsule?.({ ...collisionArgs, radius: v.collisionRadius }) || null;
        if (move?.blocked) {
            this._recordCollision(move, v);
            vx = finite(move.vx); vy = finite(move.vy);
            longitudinal = vx * forwardX + vy * forwardY;
            lateral = vx * rightX + vy * rightY;
            yawRate *= 0.38;
            solver.longitudinal = longitudinal;
            solver.lateral = lateral;
            solver.yawRate = yawRate;
            if (Math.abs(speedBefore) > 4.0) this.applyDamage(Math.min(180, Math.abs(speedBefore) * 7.5), 'world_collision');
        }
        v.headingRad += yawRate * dt;
        v.position[0] = move ? finite(move.x, v.position[0]) : v.position[0] + vx * dt;
        v.position[1] = move ? finite(move.y, v.position[1]) : v.position[1] + vy * dt;
        if (move?.ground) {
            v._chassisGroundCache = { x: v.position[0], y: v.position[1], feetZ: v.position[2] - v.groundOffset, ground: move.ground };
        }

        const frontRate = finite(imported.suspension?.front?.springRateNpm, 36000);
        const rearRate = finite(imported.suspension?.rear?.springRateNpm, 32000);
        const averageRate = Math.max(8000, (frontRate + rearRate) * 0.5);
        const suspensionResponse = clamp(Math.sqrt(averageRate / Math.max(1, finite(profile.mass, 1450))) * 1.25, 7, 30);
        const roadHeight = contacts.front * clamp(profile.centerOfGravityFrontFraction, 0.2, 0.8)
            + contacts.rear * (1 - clamp(profile.centerOfGravityFrontFraction, 0.2, 0.8));
        const targetZ = roadHeight + v.groundOffset;
        const verticalError = targetZ - v.position[2];
        const priorZ = v.position[2];
        if (contacts.groundedCount > 0) {
            v.position[2] += verticalError * (1 - Math.exp(-suspensionResponse * dt));
            v.verticalVelocity = (v.position[2] - priorZ) / Math.max(dt, 0.001);
        } else {
            v.verticalVelocity = finite(v.verticalVelocity) - 9.81 * dt;
            v.position[2] += v.verticalVelocity * dt;
        }
        const antiRoll = (finite(imported.suspension?.front?.antiRollBarNm) + finite(imported.suspension?.rear?.antiRollBarNm)) / Math.max(1, finite(profile.mass, 1450));
        v.bodyRoll += (clamp(contacts.roll - result.forces.accelerationY * 0.025 / Math.max(0.3, antiRoll * 0.06), -0.28, 0.28) - finite(v.bodyRoll)) * (1 - Math.exp(-(8 + antiRoll * 0.8) * dt));
        const dynamicPitch = assettoLongitudinalPitchDelta(profile, result.forces.accelerationX);
        v.bodyPitch += (clamp(contacts.pitch + dynamicPitch, -0.28, 0.28) - finite(v.bodyPitch)) * (1 - Math.exp(-10 * dt));
        v.suspension = clamp(verticalError, -0.25, 0.25);
        v.groundSource = String(move?.ground?.source || Object.values(contacts.contacts)[0]?.source || 'gameplay');
        v.surfaceMaterial = contacts.material;
        v.surfaceGrip = contacts.grip;
        v.surfaceDamping = contacts.damping;
        v.surfaceValidTrack = contacts.validTrack;
        v.surfacePitlane = contacts.pitlane;
        v.velocityLocal = [longitudinal, lateral];
        v.speed = longitudinal;
        v.yawRate = yawRate;
        v.longitudinalAcceleration = result.forces.accelerationX;
        v.tireSlip = result.tireSlip;
        v.transmissionDirection = result.reverse || longitudinal < -0.35 ? -1 : 1;
        this._updateWheelVisuals(v, dt, contacts);

        let impacts = [];
        if (processFrameInteractions) {
            try { impacts = this.app?.npcSystem?.applyVehicleImpacts?.({ position: v.position, heading: v.headingRad, speed: v.speed, dt }) || []; } catch { impacts = []; }
        }
        if (impacts.length) {
            solver.longitudinal *= Math.max(0.62, 1 - impacts.length * 0.12);
            v.speed = solver.longitudinal;
            v.velocityLocal[0] = v.speed;
            this.applyDamage(impacts.length * 12, 'pedestrian_impact');
        }
        this.diagnostics.capture(dt, {
            input: { throttle: v.throttle, brake: v.brake, steering: v.steering, handbrake: input.handbrake },
            pose: { x: v.position[0], y: v.position[1], z: v.position[2], headingRad: v.headingRad },
            velocity: { longitudinal, lateral, yawRate, worldX: vx, worldY: vy, vertical: v.verticalVelocity },
            powertrain: { rpm: v.rpm, gear: v.gear, shiftTimer: v.shiftTimer, engineLoad: v.engineLoad, transmissionDirection: v.transmissionDirection, tractionControl: result.tractionControl },
            dynamics: { ...result.forces, tireSlip: v.tireSlip, backend: 'assetto-four-wheel-v1' },
            surface: { material: v.surfaceMaterial, grip: v.surfaceGrip, damping: v.surfaceDamping, validTrack: v.surfaceValidTrack, pitlane: v.surfacePitlane, groundSource: v.groundSource },
            wheels: result.wheels,
            collision: move?.blocked ? { source: String(move.hit?.source || ''), id: String(move.hit?.id || '') } : null,
        });
        if (processFrameInteractions) this._syncOccupantPed();
    }

    _stepDriving(dt, keyState, { processFrameInteractions = true } = {}) {
        const v = this.vehicle;
        if (!v || v.destroyed) {
            if (v) v.speed = 0.0;
            return;
        }
        const handling = vehiclePhysicsHandling(v) || DEFAULT_HANDLING;
        const noDriverInput = !keyState?.w && !keyState?.s && !keyState?.a && !keyState?.d
            && !keyState?.[' '] && !keyState?.space && !keyState?.spacebar;
        const parked = noDriverInput
            && Math.abs(finite(v.velocityLocal?.[0], v.speed)) < 0.06
            && Math.abs(finite(v.velocityLocal?.[1])) < 0.04
            && Math.abs(finite(v.yawRate)) < 0.03
            && Math.abs(finite(v.throttle)) < 0.035
            && Math.abs(finite(v.brake)) < 0.035;
        if (parked) {
            this._movingWheelContactSeconds = Number.POSITIVE_INFINITY;
            this._stepStationaryVehicle(v, handling, dt);
            if (processFrameInteractions) this._syncOccupantPed();
            return;
        }
        this._idleWheelContactSeconds = Number.POSITIVE_INFINITY;
        this._idleWheelVisualSeconds = Number.POSITIVE_INFINITY;
        const mass = clamp(handling.mass, 650, 12000) || 1450;
        const wheelbase = Math.max(2.0, Math.min(5.5, this._wheelbase(v)));
        const centerOfMass = vec3(handling.centerOfMass, [0.0, 0.0, 0.0]);
        const inertiaMultiplier = vec3(handling.inertiaMultiplier, [1.0, 1.0, 1.0]);
        const frontDistance = clamp((wheelbase * 0.5) - centerOfMass[1], wheelbase * 0.22, wheelbase * 0.78);
        const rearDistance = wheelbase - frontDistance;
        const inertia = Math.max(650, mass * (wheelbase * wheelbase) * 0.29 * clamp(inertiaMultiplier[2], 0.35, 3.5));
        const maxForward = Math.max(22.0, Math.min(105.0, finite(handling.maxFlatVelocity, 151.2) / 3.6));
        const reverseTopSpeed = clamp(maxForward * 0.28, 12.0, 18.0);
        const maxReverse = -reverseTopSpeed;
        const tractionMax = clamp(handling.tractionMax, 1.1, 4.0) || 2.1;
        const tractionMin = clamp(handling.tractionMin, 0.9, tractionMax) || tractionMax * 0.86;
        const driveBiasFront = clamp(handling.driveBiasFront, 0.0, 1.0);
        const gearCount = Math.max(1, Math.min(10, Number(handling.gears) | 0 || 5));
        const throttlePressed = !!keyState?.w;
        const reversePressed = !!keyState?.s;
        const steerInput = (keyState?.a ? 1 : 0) - (keyState?.d ? 1 : 0);
        const handbrake = !!keyState?.[' '] || !!keyState?.space || !!keyState?.spacebar;
        const speedBefore = finite(v.velocityLocal?.[0], v.speed);
        let longitudinal = speedBefore;
        let lateral = finite(v.velocityLocal?.[1]);
        let yawRate = finite(v.yawRate);

        let driveTarget = 0.0;
        let brakeTarget = 0.0;
        if (throttlePressed) {
            if (longitudinal < -0.75) brakeTarget = 1.0;
            else driveTarget = 1.0;
        } else if (reversePressed) {
            if (longitudinal > 0.75) brakeTarget = 1.0;
            else driveTarget = -0.82;
        }
        const throttleResponse = Math.abs(driveTarget) > Math.abs(finite(v.throttle)) ? 7.0 : 10.5;
        v.throttle += (driveTarget - finite(v.throttle)) * (1.0 - Math.exp(-throttleResponse * dt));
        v.brake += (brakeTarget - finite(v.brake)) * (1.0 - Math.exp(-(brakeTarget > 0.0 ? 18.0 : 12.0) * dt));
        const driveInput = finite(v.throttle);
        const brakeInput = finite(v.brake);
        const reverseEngaged = driveTarget < 0.0 || driveInput < -0.08 || (longitudinal < -0.5 && driveInput <= 0.05);

        const gearTopFractions = vehicleGearTopFractions(gearCount);
        const currentGear = Math.max(1, Math.min(gearCount, Number(v.gear) | 0 || 1));
        const currentGearTopSpeed = maxForward * gearTopFractions[currentGear - 1];
        const currentGearUtilization = Math.abs(longitudinal) / Math.max(1, currentGearTopSpeed);
        v.shiftTimer = Math.max(0.0, finite(v.shiftTimer) - dt);
        if (reverseEngaged) {
            // Reverse has one dedicated ratio. It must not inherit whichever
            // forward gear was active before the driver started backing up.
            v.gear = 1;
            v.shiftTimer = 0.0;
        } else if (v.shiftTimer <= 0.0 && currentGearUtilization > 0.91 && driveInput > 0.08 && currentGear < gearCount) {
            v.gear = currentGear + 1;
            v.shiftTimer = Number.isFinite(Number(handling.shiftTimeUpSec))
                ? clamp(handling.shiftTimeUpSec, 0.04, 1.2)
                : 0.2 / clamp(handling.clutchChangeRateUpShift, 0.4, 12.0);
        } else if (
            v.shiftTimer <= 0.0
            && currentGear > 1
            && Math.abs(longitudinal) < maxForward * gearTopFractions[currentGear - 2] * (driveInput > 0.45 ? 0.76 : 0.58)
        ) {
            v.gear = currentGear - 1;
            v.shiftTimer = Number.isFinite(Number(handling.shiftTimeDownSec))
                ? clamp(handling.shiftTimeDownSec, 0.04, 1.2)
                : 0.18 / clamp(handling.clutchChangeRateDownShift, 0.4, 12.0);
        } else v.gear = currentGear;
        const idleRpm = 800;
        const redlineRpm = clamp(finite(handling.redlineRpm, 7200), 3500, 12000);
        const gearTopSpeed = reverseEngaged
            ? reverseTopSpeed
            : Math.max(6.0, maxForward * gearTopFractions[v.gear - 1]);
        const coupledRpm = idleRpm + clamp(Math.abs(longitudinal) / gearTopSpeed, 0, 1.04) * (redlineRpm - idleRpm);
        const freeRevRpm = idleRpm + Math.abs(driveInput) * 1850;
        const rpmTarget = Math.max(coupledRpm, freeRevRpm * clamp(1.0 - Math.abs(longitudinal) / 7.0, 0.0, 1.0));
        const rpmResponse = 5.0 + clamp(handling.driveInertia, 0.15, 4.0) * 5.0;
        v.rpm += (clamp(rpmTarget, idleRpm, redlineRpm) - finite(v.rpm, idleRpm)) * (1 - Math.exp(-rpmResponse * dt));
        const clutchEngagement = v.shiftTimer > 0.0 ? 0.12 : 1.0;
        v.engineLoad += ((Math.abs(driveInput) * clutchEngagement) - finite(v.engineLoad)) * (1 - Math.exp(-9 * dt));

        const steeringSpeedScale = vehicleSteeringScale(longitudinal);
        const steeringTarget = steerInput * steeringSpeedScale;
        const steeringResponse = Math.abs(steeringTarget) > Math.abs(finite(v.steering)) ? 4.6 : 7.5;
        v.steering += (steeringTarget - finite(v.steering)) * (1 - Math.exp(-steeringResponse * dt));
        const steeringLock = clamp(handling.steeringLock, 18, 58) || 35;
        v.steeringRad = finite(v.steering) * steeringLock * (Math.PI / 180.0);

        const centerOfMassHeight = clamp(0.24 + Math.abs(centerOfMass[2]) + ((finite(handling.rollCentreHeightFront) + finite(handling.rollCentreHeightRear)) * 0.25), 0.2, 0.85);
        const priorAcceleration = clamp(finite(v.longitudinalAcceleration), -18.0, 18.0);
        const weightTransfer = mass * priorAcceleration * centerOfMassHeight / wheelbase;
        const downforce = clamp(handling.downforceModifier, 0.0, 12.0) * longitudinal * longitudinal * 0.28;
        let normalFront = Math.max(mass * 9.81 * 0.08, mass * 9.81 * (rearDistance / wheelbase) - weightTransfer + downforce * clamp(handling.tractionBiasFront, 0.15, 0.85));
        let normalRear = Math.max(mass * 9.81 * 0.08, mass * 9.81 * (frontDistance / wheelbase) + weightTransfer + downforce * (1.0 - clamp(handling.tractionBiasFront, 0.15, 0.85)));
        const contactSurface = this._movingWheelContacts(v, dt);
        normalFront *= clamp(contactSurface.frontGrounded / 2.0, 0.0, 1.0);
        normalRear *= clamp(contactSurface.rearGrounded / 2.0, 0.0, 1.0);
        const lowSpeedLoss = 1.0 / (1.0 + clamp(handling.lowSpeedTractionLossMult, 0.0, 5.0) * 0.16 * clamp(1.0 - Math.abs(longitudinal) / 8.0, 0.0, 1.0));
        const surfaceGrip = lowSpeedLoss * clamp(contactSurface.grip, 0.2, 1.15) / clamp(handling.tractionLossMult, 0.35, 4.0);
        const tractionBiasFront = clamp(handling.tractionBiasFront, 0.1, 0.9);
        const frontGrip = normalFront * tractionMax * surfaceGrip * (0.72 + tractionBiasFront * 0.56);
        const rearGrip = normalRear * tractionMax * surfaceGrip * (handbrake ? 0.18 : (1.28 - tractionBiasFront * 0.56));
        const velocityForSlip = Math.max(1.5, Math.abs(longitudinal));
        // Steering orientation reverses when the tire rolls backward, but the
        // lateral velocity term must not. Flipping both makes tire force amplify
        // reverse sideslip instead of damping it.
        const travelDirection = Math.sign(longitudinal || driveInput || 1.0);
        const frontSlip = Math.atan2(lateral + yawRate * frontDistance, velocityForSlip) - v.steeringRad * travelDirection;
        const rearSlip = Math.atan2(lateral - yawRate * rearDistance, velocityForSlip);
        const peakSlip = clamp(clamp(handling.tractionLateral, 8.0, 45.0) * (Math.PI / 180.0), 0.14, 0.55);
        const lateralForce = (slip, peakForce) => {
            const magnitude = Math.abs(slip);
            const normalized = clamp(magnitude / peakSlip, 0.0, 2.5);
            const curveGrip = tractionMin + (tractionMax - tractionMin) * (1.0 - clamp(normalized, 0.0, 1.0));
            const force = peakForce * (curveGrip / tractionMax) * (normalized <= 1.0 ? normalized : Math.max(0.34, 1.0 - (normalized - 1.0) * 0.42));
            return -Math.sign(slip) * force;
        };
        const frontForce = lateralForce(frontSlip, frontGrip);
        const rearForce = lateralForce(rearSlip, rearGrip);
        const drivenNormal = normalFront * driveBiasFront + normalRear * (1.0 - driveBiasFront);
        // Longitudinal and lateral forces share one finite contact patch. Without
        // this friction circle the car can accelerate or brake at full force while
        // also cornering at full force, which feels unnaturally locked to the road.
        const frontLongitudinalCapacity = Math.sqrt(Math.max(0.0, frontGrip * frontGrip - frontForce * frontForce));
        const rearLongitudinalCapacity = Math.sqrt(Math.max(0.0, rearGrip * rearGrip - rearForce * rearForce));
        const drivenLongitudinalCapacity = frontLongitudinalCapacity * driveBiasFront
            + rearLongitudinalCapacity * (1.0 - driveBiasFront);
        const torqueShape = 0.7 + 0.36 * Math.sin(Math.PI * clamp((finite(v.rpm) - idleRpm) / (redlineRpm - idleRpm), 0, 1));
        const gearTorque = reverseEngaged
            ? 1.34
            : clamp(0.72 / Math.sqrt(gearTopFractions[v.gear - 1]), 0.72, 1.55);
        const driveAcceleration = 2.0 + clamp(handling.driveForce, 0.04, 1.0) * 10.0;
        const engineCondition = clamp(finite(v.engineHealth, 1000) / 1000.0, 0.18, 1.0);
        const driveForce = driveInput * clutchEngagement * engineCondition * Math.min(
            drivenNormal * tractionMax * surfaceGrip * 0.9,
            drivenLongitudinalCapacity,
            mass * driveAcceleration * torqueShape * gearTorque,
        );
        const brakeAcceleration = 5.0 + clamp(handling.brakeForce, 0.1, 4.0) * 7.0;
        const brakeDemand = brakeInput * mass * brakeAcceleration;
        const brakeBiasFront = clamp(handling.brakeBiasFront, 0.1, 0.9);
        // Steering slip may consume most of the computed friction circle. Keep
        // a service-brake reserve so changing drive direction cannot leave the
        // car indefinitely sliding in its prior direction.
        const frontBrakeCapacity = Math.max(frontLongitudinalCapacity * 0.94, frontGrip * 0.34);
        const rearBrakeCapacity = Math.max(rearLongitudinalCapacity * 0.94, rearGrip * 0.34);
        const frontBrake = Math.min(brakeDemand * brakeBiasFront, frontBrakeCapacity);
        const rearBrake = Math.min(brakeDemand * (1.0 - brakeBiasFront), rearBrakeCapacity);
        const brakeForce = (frontBrake + rearBrake) * -Math.sign(longitudinal || (reversePressed ? -1 : 1));
        const handbrakeDemand = handbrake ? mass * (4.0 + clamp(handling.handBrakeForce, 0.1, 3.0) * 9.0) : 0.0;
        const handbrakeForce = Math.min(handbrakeDemand, normalRear * tractionMax * 0.52) * -Math.sign(longitudinal || 1);
        const rolling = mass * 0.14 * -Math.sign(longitudinal || 0.0);
        const aerodynamic = -clamp(handling.dragCoeff, 0.5, 30.0) * 0.052 * longitudinal * Math.abs(longitudinal);
        const longitudinalAcceleration = (driveForce + brakeForce + handbrakeForce + rolling + aerodynamic) / mass + yawRate * lateral;
        const lateralAcceleration = (frontForce + rearForce) / mass - yawRate * longitudinal;
        const yawAcceleration = (frontDistance * frontForce - rearDistance * rearForce) / inertia;
        const priorLongitudinal = longitudinal;
        longitudinal = clamp(longitudinal + longitudinalAcceleration * dt, maxReverse, maxForward);
        if (!throttlePressed && !reversePressed && !handbrake && priorLongitudinal * longitudinal < 0.0) longitudinal = 0.0;
        lateral += lateralAcceleration * dt;
        yawRate += yawAcceleration * dt;
        // Parking-speed motion follows wheelbase geometry closely. Blend into
        // the tire-force model as speed rises so reversing is predictable but
        // higher-speed handling still carries inertia and slip.
        const parkingBlend = clamp(1.0 - Math.abs(longitudinal) / 9.0, 0.0, 1.0);
        if (parkingBlend > 0.0 && contactSurface.groundedCount > 0) {
            const kinematicYawRate = (longitudinal / wheelbase) * Math.tan(v.steeringRad)
                * clamp(contactSurface.grip, 0.45, 1.1);
            const response = 1.0 - Math.exp(-(5.5 + parkingBlend * 4.5) * dt);
            yawRate += (kinematicYawRate - yawRate) * response * parkingBlend;
        }
        if (Math.abs(longitudinal) < 1.25) {
            lateral *= Math.exp(-9.0 * dt);
            yawRate *= Math.exp(-8.0 * dt);
        } else {
            yawRate *= Math.exp(-(0.7 + Math.abs(longitudinal) * 0.015) * dt);
        }
        if (handbrake && Math.abs(longitudinal) > 5.0) lateral += v.steeringRad * Math.abs(longitudinal) * 0.42 * dt;

        v.headingRad += yawRate * dt;
        const forwardX = Math.cos(v.headingRad);
        const forwardY = Math.sin(v.headingRad);
        const rightX = -forwardY;
        const rightY = forwardX;
        let vx = forwardX * longitudinal + rightX * lateral;
        let vy = forwardY * longitudinal + rightY * lateral;
        const collisionArgs = {
            x: v.position[0], y: v.position[1], feetZ: v.position[2] - v.groundOffset,
            vx, vy, dt, heading: v.headingRad,
            halfWidth: Math.max(0.7, this._trackWidth(v) * 0.5 + 0.12),
            halfLength: Math.max(1.45, this._wheelbase(v) * 0.5 + v.wheelRadius * 0.8),
            chassisClearance: Math.max(0.16, v.wheelRadius * 0.55),
            chassisHeight: 1.15,
            wheelRadius: v.wheelRadius,
            maxStepUp: 0.65, obstacleStepUp: 0.65, maxSnapDistance: 4.0,
            applyYbnCalibration: false, useDrawableProxies: false,
            previousGround: v._chassisGroundCache,
        };
        const collisionWorld = this.app?.collisionWorld;
        const fragmentImpact = processFrameInteractions
            ? collisionWorld?.findDestructibleImpact?.({
                start: [v.position[0], v.position[1]], end: [v.position[0] + vx * dt, v.position[1] + vy * dt],
                radius: v.collisionRadius, feetZ: v.position[2] - v.groundOffset,
            })
            : null;
        let destroyed = collisionWorld?.destroyDestructibleForImpact?.(fragmentImpact, speedBefore, {
            source: 'vehicle', impactDirection: [vx, vy, 0.0], impactPoint: fragmentImpact ? [fragmentImpact.x, fragmentImpact.y, fragmentImpact.z] : null,
        }) || null;
        let move = collisionWorld?.moveVehicle?.(collisionArgs) || collisionWorld?.moveCapsule?.({ ...collisionArgs, radius: v.collisionRadius }) || null;
        if (!destroyed) destroyed = collisionWorld?.destroyDestructibleForImpact?.(move?.hit, speedBefore, {
            source: 'vehicle', impactDirection: [vx, vy, 0.0], impactPoint: move?.hit?.point || null,
        }) || null;
        if (destroyed) {
            move = collisionWorld?.moveVehicle?.(collisionArgs) || collisionWorld?.moveCapsule?.({ ...collisionArgs, radius: v.collisionRadius }) || move;
            this.lastEvent = `destroyed: ${destroyed.label}`;
        }
        if (move?.blocked) {
            this._recordCollision(move, v);
            const impact = Math.abs(speedBefore);
            vx = finite(move.vx, 0.0);
            vy = finite(move.vy, 0.0);
            longitudinal = vx * forwardX + vy * forwardY;
            lateral = vx * rightX + vy * rightY;
            const normalX = finite(move.hit?.normalX);
            const normalY = finite(move.hit?.normalY);
            const lever = finite(move.hit?.chassisProbeOffset);
            const torqueSign = (forwardX * normalY - forwardY * normalX) * lever;
            yawRate = clamp(yawRate * 0.42 + torqueSign * impact / Math.max(5.0, wheelbase * 7.0), -1.8, 1.8);
            if (impact > 4.0) this.applyDamage(Math.min(180, impact * 7.5), 'world_collision');
        }
        v.position[0] = move ? finite(move.x, v.position[0]) : v.position[0] + vx * dt;
        v.position[1] = move ? finite(move.y, v.position[1]) : v.position[1] + vy * dt;
        if (move?.ground) {
            v._chassisGroundCache = {
                x: v.position[0],
                y: v.position[1],
                feetZ: v.position[2] - v.groundOffset,
                ground: move.ground,
            };
        }

        const contacts = contactSurface;
        const suspensionBiasFront = clamp(handling.suspensionBiasFront, 0.1, 0.9);
        const roadHeight = contacts.front * suspensionBiasFront + contacts.rear * (1.0 - suspensionBiasFront);
        const targetZ = roadHeight + v.groundOffset + clamp(handling.suspensionRaise, -0.45, 0.45);
        const verticalError = targetZ - v.position[2];
        const compressionDamp = verticalError < 0.0 ? handling.suspensionCompDamp : handling.suspensionReboundDamp;
        const suspensionResponse = clamp(5.0 + clamp(handling.suspensionForce, 0.2, 8.0) * 2.8 + clamp(compressionDamp, 0.1, 8.0), 7.0, 30.0);
        const priorZ = v.position[2];
        if (contacts.groundedCount > 0) {
            v.position[2] += verticalError * (1.0 - Math.exp(-suspensionResponse * dt));
            v.verticalVelocity = (v.position[2] - priorZ) / Math.max(dt, 0.001);
        } else {
            v.verticalVelocity = finite(v.verticalVelocity) - 9.81 * dt;
            v.position[2] += v.verticalVelocity * dt;
        }
        const suspensionLower = Math.min(0.0, finite(handling.suspensionLowerLimit, -0.1));
        const suspensionUpper = Math.max(0.0, finite(handling.suspensionUpperLimit, 0.1));
        v.suspension += (clamp(verticalError, suspensionLower, suspensionUpper) - finite(v.suspension)) * (1.0 - Math.exp(-suspensionResponse * dt));
        const rollCenter = clamp((finite(handling.rollCentreHeightFront) + finite(handling.rollCentreHeightRear)) * 0.5, 0.08, 1.2);
        const antiRoll = clamp(handling.antiRollBarForce, 0.0, 4.0) * (0.55 + clamp(handling.antiRollBarBiasFront, 0.0, 1.0) * 0.45);
        const dynamicRoll = -lateralAcceleration * centerOfMassHeight / Math.max(5.0, 42.0 * (rollCenter + antiRoll * 0.45));
        const rollLimit = clamp(0.11 + (suspensionUpper - suspensionLower) * 0.5, 0.12, 0.25);
        const rollTarget = clamp(contacts.roll + dynamicRoll, -rollLimit, rollLimit);
        v.bodyRoll += (rollTarget - finite(v.bodyRoll)) * (1.0 - Math.exp(-(7.0 + antiRoll * 3.0) * dt));
        const pitchTarget = clamp(contacts.pitch + longitudinalAcceleration * centerOfMassHeight * 0.006, -0.25, 0.25);
        v.bodyPitch += (pitchTarget - finite(v.bodyPitch)) * (1.0 - Math.exp(-(7.0 + clamp(handling.suspensionForce, 0.2, 8.0) * 1.8) * dt));
        v.groundSource = String(move?.ground?.source || Object.values(contacts.contacts)[0]?.source || v.groundSource || 'gameplay');
        v.surfaceMaterial = contacts.material;
        v.surfaceGrip = contacts.grip;
        v.surfaceDamping = contacts.damping;
        v.surfaceValidTrack = contacts.validTrack;
        v.surfacePitlane = contacts.pitlane;
        v.velocityLocal = [longitudinal, lateral];
        v.speed = longitudinal;
        v.transmissionDirection = reverseEngaged || longitudinal < -0.35
            ? -1
            : ((driveInput > 0.08 || longitudinal > 0.35) ? 1 : finite(v.transmissionDirection, 1));
        v.longitudinalAcceleration = longitudinalAcceleration;
        v.yawRate = yawRate;
        v.tireSlip = clamp(Math.max(Math.abs(frontSlip), Math.abs(rearSlip), handbrake ? Math.abs(lateral) / 4.0 : 0.0) / 0.38, 0, 1);
        this._updateWheelVisuals(v, dt, contacts);

        let impacts = [];
        if (processFrameInteractions) {
            try { impacts = this.app?.npcSystem?.applyVehicleImpacts?.({ position: v.position, heading: v.headingRad, speed: v.speed, dt }) || []; } catch { impacts = []; }
        }
        if (impacts.length) {
            v.speed *= Math.max(0.62, 1.0 - impacts.length * 0.12);
            v.velocityLocal[0] = v.speed;
            const lethalCount = impacts.filter((impact) => impact.lethal).length;
            this.lastEvent = lethalCount
                ? `vehicle impact: ${impacts.length} pedestrian${impacts.length === 1 ? '' : 's'}`
                : `vehicle strike: ${impacts.length} pedestrian${impacts.length === 1 ? '' : 's'}`;
            this.applyDamage(impacts.length * 12, 'pedestrian_impact');
        }
        this.diagnostics.capture(dt, {
            input: { throttle: driveInput, brake: brakeInput, steering: v.steering, handbrake },
            pose: { x: v.position[0], y: v.position[1], z: v.position[2], headingRad: v.headingRad },
            velocity: { longitudinal, lateral, yawRate, worldX: vx, worldY: vy, vertical: v.verticalVelocity },
            powertrain: { rpm: v.rpm, gear: v.gear, shiftTimer: v.shiftTimer, engineLoad: v.engineLoad, transmissionDirection: v.transmissionDirection },
            dynamics: {
                longitudinalAcceleration, lateralAcceleration, yawAcceleration,
                driveForce, brakeForce, handbrakeForce, aerodynamic, rolling,
                frontLateralForce: frontForce, rearLateralForce: rearForce,
                frontNormalForce: normalFront, rearNormalForce: normalRear,
                frontSlip, rearSlip, tireSlip: v.tireSlip,
            },
            surface: { material: v.surfaceMaterial, grip: v.surfaceGrip, damping: v.surfaceDamping, validTrack: v.surfaceValidTrack, pitlane: v.surfacePitlane, groundSource: v.groundSource },
            wheels: Object.fromEntries(Object.entries(contacts.contacts).map(([tag, contact]) => [tag, {
                grounded: !!contact.grounded, compression: finite(contact.compression), grip: finite(contact.grip), material: contact.material,
            }])),
            collision: move?.blocked ? { source: String(move.hit?.source || ''), id: String(move.hit?.id || '') } : null,
        });
        if (processFrameInteractions) this._syncOccupantPed();
    }

    _updateDrivingLegacy(dt, keyState) {
        const v = this.vehicle;
        if (v.destroyed) { v.speed = 0; return; }
        const speedBefore = v.speed;
        const throttle = (keyState.w ? 1 : 0) - (keyState.s ? 1 : 0);
        const steerInput = (keyState.a ? 1 : 0) - (keyState.d ? 1 : 0);
        const handbrake = !!keyState[' '] || !!keyState.space || !!keyState.spacebar;
        const handling = v.handling || SULTAN_DEFINITION.handling;
        const maxForward = Math.max(25.0, Math.min(85.0, finite(handling.maxFlatVelocity, 151.2) / 3.6));
        const maxReverse = -12.0;
        const driveAcceleration = Math.max(7.0, Math.min(18.0, 7.5 + finite(handling.driveForce, 0.3) * 8.0));
        const brakeAcceleration = Math.max(16.0, Math.min(32.0, 16.0 + finite(handling.brakeForce, 0.8) * 10.0));

        if (throttle > 0) {
            v.speed += (v.speed < -0.5 ? brakeAcceleration : driveAcceleration) * dt;
        } else if (throttle < 0) {
            v.speed -= (v.speed > 0.5 ? brakeAcceleration : 8.0) * dt;
        } else {
            const drag = (1.2 + Math.abs(v.speed) * 0.055) * dt;
            v.speed = Math.abs(v.speed) <= drag ? 0.0 : v.speed - Math.sign(v.speed) * drag;
        }
        if (handbrake) v.speed *= Math.exp(-8.0 * dt);
        v.speed = Math.max(maxReverse, Math.min(maxForward, v.speed));
        v.wheelRotationRad = (finite(v.wheelRotationRad) - (v.speed * dt / v.wheelRadius)) % (Math.PI * 2.0);

        const steerTarget = steerInput * Math.max(0.25, 1.0 - Math.min(0.72, Math.abs(v.speed) / 58.0));
        const steerA = 1.0 - Math.exp(-8.0 * dt);
        v.steering += (steerTarget - v.steering) * steerA;
        if (Math.abs(v.speed) > 0.05) {
            const wheelbase = Math.max(2.0, Math.min(4.2, this._wheelbase(v)));
            v.headingRad += v.steering * (v.speed / wheelbase) * dt * 0.72;
        }

        const vx = Math.cos(v.headingRad) * v.speed;
        const vy = Math.sin(v.headingRad) * v.speed;
        const collisionArgs = {
            x: v.position[0],
            y: v.position[1],
            feetZ: v.position[2] - v.groundOffset,
            vx,
            vy,
            dt,
            heading: v.headingRad,
            halfWidth: Math.max(0.7, this._trackWidth(v) * 0.5 + 0.12),
            halfLength: Math.max(1.45, this._wheelbase(v) * 0.5 + v.wheelRadius * 0.8),
            chassisClearance: Math.max(0.16, v.wheelRadius * 0.55),
            chassisHeight: 1.15,
            wheelRadius: v.wheelRadius,
            // Vehicle movement is not a pedestrian capsule. Low curbs and parking
            // stops may be climbed by the wheel/suspension path, while YBN walls
            // remain authoritative for buildings and other real static barriers.
            maxStepUp: 0.65,
            obstacleStepUp: 0.65,
            maxSnapDistance: 4.0,
            applyYbnCalibration: false,
            useDrawableProxies: false,
        };
        const collisionWorld = this.app?.collisionWorld;
        const fragmentImpact = collisionWorld?.findDestructibleImpact?.({
            start: [v.position[0], v.position[1]],
            end: [v.position[0] + vx * dt, v.position[1] + vy * dt],
            radius: v.collisionRadius,
            feetZ: v.position[2] - v.groundOffset,
        });
        const fragmentImpactOptions = {
            source: 'vehicle',
            impactDirection: [vx, vy, 0.0],
            impactPoint: fragmentImpact ? [fragmentImpact.x, fragmentImpact.y, fragmentImpact.z] : null,
        };
        let destroyed = collisionWorld?.destroyDestructibleForImpact?.(fragmentImpact, speedBefore, fragmentImpactOptions) || null;
        let move = collisionWorld?.moveVehicle?.(collisionArgs) || collisionWorld?.moveCapsule?.({ ...collisionArgs, radius: v.collisionRadius }) || null;
        if (!destroyed) destroyed = collisionWorld?.destroyDestructibleForImpact?.(move?.hit, speedBefore, {
            source: 'vehicle',
            impactDirection: [vx, vy, 0.0],
            impactPoint: move?.hit?.point || null,
        }) || null;
        if (destroyed) {
            // Re-run against the changed collision set so a successful impact does
            // not consume a frame by stopping the car at the former prop location.
            move = this.app?.collisionWorld?.moveVehicle?.(collisionArgs) || this.app?.collisionWorld?.moveCapsule?.({ ...collisionArgs, radius: v.collisionRadius }) || move;
            this.lastEvent = `destroyed: ${destroyed.label}`;
        }
        if (move?.blocked) {
            this._recordCollision(move, v);
            const impact = Math.abs(speedBefore);
            v.speed *= -0.12;
            if (impact > 4.0) this.applyDamage(Math.min(180, impact * 7.5), 'world_collision');
        }
        v.position[0] = move ? finite(move.x, v.position[0]) : v.position[0] + vx * dt;
        v.position[1] = move ? finite(move.y, v.position[1]) : v.position[1] + vy * dt;
        const ground = move?.ground || this._resolveGround(v.position[0], v.position[1], v.position[2]);
        if (Number.isFinite(Number(ground?.z))) v.position[2] = Number(ground.z) + v.groundOffset;
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
        const handling = v.handling || DEFAULT_HANDLING;
        const sourceName = String(source || 'impact');
        const collision = sourceName.includes('collision') || sourceName.includes('impact');
        const weapon = sourceName.includes('weapon') || sourceName.includes('bullet');
        const multiplier = collision
            ? clamp(handling.collisionDamageMult, 0.1, 4.0)
            : weapon
                ? clamp(handling.weaponDamageMult, 0.1, 4.0) * clamp(v.damageConfig?.weaponForceMult, 0.1, 4.0)
                : 1.0;
        const applied = Math.max(0, Math.min(250, finite(amount) * multiplier));
        if (applied <= 0) return false;
        const bodyHealth = clamp(finite(v.bodyHealth, v.damageConfig?.bodyHealth ?? 1000), 250, 2500);
        const deformation = applied * clamp(handling.deformationDamageMult, 0.1, 4.0);
        const engineDamage = applied * (collision ? 0.30 : 0.16) * clamp(handling.engineDamageMult, 0.1, 4.0);
        v.damage = Math.min(bodyHealth, finite(v.damage) + deformation);
        v.health = Math.max(0, bodyHealth - v.damage);
        v.engineHealth = Math.max(0, clamp(finite(v.engineHealth, 1000), 0, 1000) - engineDamage);
        v.damageVisual = clamp(v.damage / bodyHealth, 0, 1) * clamp(v.damageConfig?.offsetScale, 0, 2);
        v.destroyed = v.health <= 0;
        this.lastEvent = v.destroyed ? `vehicle destroyed: ${v.name}` : `vehicle damage: ${Math.round(applied)} ${source}`;
        this.diagnostics?.event('damage', { amount: applied, source: String(source), destroyed: v.destroyed, health: v.health, engineHealth: v.engineHealth });
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
        if (app.pedRenderer?.setPosition) app.pedRenderer.setPosition(app.ped.posData);
        else app.pedRenderer?.setPositions?.([app.ped.posData]);
    }

    _resolveGround(x, y, zHint) {
        return this.app?.collisionWorld?.resolveGround?.(x, y, zHint, {
            applyYbnCalibration: false,
        }) || null;
    }

    _wheelbase(vehicle) {
        const pivots = vehicle?.wheelPivots || this._definitionForModel(vehicle?.model)?.wheelPivots;
        const front = pivots?.['27922'] || pivots?.['26418'];
        const rear = pivots?.['27902'] || pivots?.['26398'];
        return Array.isArray(front) && Array.isArray(rear) ? Math.abs(finite(front[1]) - finite(rear[1])) : 2.65;
    }

    _trackWidth(vehicle) {
        const pivots = vehicle?.wheelPivots || this._definitionForModel(vehicle?.model)?.wheelPivots;
        const left = pivots?.['27922'] || pivots?.['27902'];
        const right = pivots?.['26418'] || pivots?.['26398'];
        return Array.isArray(left) && Array.isArray(right) ? Math.abs(finite(right[0]) - finite(left[0])) : 1.4;
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

    _chooseDemoVehicleSpawn() {
        const ped = this.app?.ped?.posData;
        if (!Array.isArray(ped) || ped.length < 3 || !ped.slice(0, 3).every((value) => Number.isFinite(Number(value)))) {
            return this._chooseDemoGarageSpawn();
        }

        const feetZ = finite(ped[2]) - Math.max(0.5, finite(this.app?.pedEyeHeightData, 1.2));
        const heading = finite(this.app?.player?.headingRad);
        // Keep the initial vehicle in the active camera neighborhood without
        // placing it in the ped capsule. Try the heading axis before the sides so
        // the first candidate behaves like a conventional nearby parked car.
        const headings = [heading, heading + Math.PI, heading + Math.PI * 0.5, heading - Math.PI * 0.5];
        const distances = [7.5, 9.5];
        const bounds = this.app?.spawnDistrictBounds || null;
        for (const candidateHeading of headings) {
            for (const distance of distances) {
                const x = finite(ped[0]) + Math.cos(candidateHeading) * distance;
                const y = finite(ped[1]) + Math.sin(candidateHeading) * distance;
                if (bounds && (x < Number(bounds.minX) || x > Number(bounds.maxX) || y < Number(bounds.minY) || y > Number(bounds.maxY))) continue;
                const ground = this._resolveGround(x, y, feetZ);
                const z = Number.isFinite(Number(ground?.z)) ? Number(ground.z) : feetZ;
                return {
                    coords: { x, y, z, w: dataRadToGtaHeading(candidateHeading) },
                    source: 'demo_spawn_near_ped',
                };
            }
        }
        return this._chooseDemoGarageSpawn();
    }

    _isVehicleAction(action) {
        const t = String(action?.type || '');
        return t === 'open_garage' || t === 'open_vehicle_shop';
    }
}

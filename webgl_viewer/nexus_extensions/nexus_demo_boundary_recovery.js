const finite = (value, fallback = NaN) => Number.isFinite(Number(value)) ? Number(value) : fallback;

const boundsFor = (viewer) => viewer?.spawnDistrictDemo ? viewer.spawnDistrictBounds : null;

const outsideBounds = (position, bounds) => {
    const x = finite(position?.[0]);
    const y = finite(position?.[1]);
    const minX = finite(bounds?.minX);
    const minY = finite(bounds?.minY);
    const maxX = finite(bounds?.maxX);
    const maxY = finite(bounds?.maxY);
    return [x, y, minX, minY, maxX, maxY].every(Number.isFinite)
        && (x < minX || x > maxX || y < minY || y > maxY);
};

const resolveRecovery = (viewer) => {
    const world = viewer?.collisionWorld;
    if (!viewer?.spawnDistrictDemo || !world) return null;

    if (viewer._nordschleifeActive) {
        const trackSpawn = world.getDerivedRoadSpawn?.();
        if (!Array.isArray(trackSpawn) || trackSpawn.length < 3 || !trackSpawn.slice(0, 3).every(Number.isFinite)) return null;
        const ground = world.resolveGround?.(trackSpawn[0], trackSpawn[1], trackSpawn[2] + 2.0, {
            preferInterior: false,
            maxSnapDistance: 8.0,
        }) || null;
        if (ground?.source !== 'track' || !Number.isFinite(Number(ground.z))) return null;
        return { x: Number(trackSpawn[0]), y: Number(trackSpawn[1]), feetZ: Number(ground.z), ground, kind: 'track' };
    }

    const configured = viewer._spawnDistrictDescriptor?.spawn || {};
    const x = finite(configured.x, 186.94);
    const y = finite(configured.y, -850.84);
    const configuredZ = finite(configured.pedZ, finite(configured.z, 31.17));
    const ground = world.resolveGround?.(x, y, configuredZ + 2.0, {
        preferInterior: false,
        maxSnapDistance: 8.0,
    }) || null;
    return {
        x,
        y,
        feetZ: finite(ground?.z, configuredZ),
        ground,
        kind: 'city',
    };
};

const noteRecovery = (viewer, recovery, reason) => {
    viewer._demoBoundsRecovery = {
        at: Date.now(),
        kind: recovery.kind,
        reason,
        x: recovery.x,
        y: recovery.y,
        feetZ: recovery.feetZ,
    };
};

const installMotionRecovery = (viewer) => {
    const world = viewer?.collisionWorld;
    if (!world || world.__nxDemoBoundaryRecoveryWrapped) return;
    world.__nxDemoBoundaryRecoveryWrapped = true;

    const recoverMotion = (args, vehicle = false) => {
        const bounds = boundsFor(viewer);
        if (!bounds || !outsideBounds([args?.x, args?.y], bounds)) return null;
        const recovery = resolveRecovery(viewer);
        if (!recovery) return null;
        noteRecovery(viewer, recovery, vehicle ? 'vehicle_motion' : 'ped_motion');
        return {
            x: recovery.x,
            y: recovery.y,
            ground: recovery.ground,
            blocked: true,
            reason: 'demo_bounds_recovery',
            recovered: true,
            vx: 0.0,
            vy: 0.0,
            ...(vehicle ? { surface: recovery.ground?.material || recovery.ground?.source || 'asphalt' } : {}),
        };
    };

    const priorMoveCapsule = world.moveCapsule.bind(world);
    world.moveCapsule = (args = {}) => recoverMotion(args, false) || priorMoveCapsule(args);
    const priorMoveVehicle = world.moveVehicle.bind(world);
    world.moveVehicle = (args = {}) => recoverMotion(args, true) || priorMoveVehicle(args);
};

const install = () => {
    const viewer = window.__viewerApp;
    if (!viewer?.spawnDistrictDemo || !viewer?.collisionWorld || !viewer?.spawnPedAt) return false;

    installMotionRecovery(viewer);
    if (viewer.__nxDemoBoundaryRecoveryInstalled) return true;
    viewer.__nxDemoBoundaryRecoveryInstalled = true;

    const priorSpawnPedAt = viewer.spawnPedAt.bind(viewer);
    viewer.spawnPedAt = (position, options = {}) => {
        const bounds = boundsFor(viewer);
        if (!bounds || !outsideBounds(position, bounds)) return priorSpawnPedAt(position, options);
        const recovery = resolveRecovery(viewer);
        if (!recovery) return priorSpawnPedAt(position, options);
        noteRecovery(viewer, recovery, 'ped_spawn');
        const eye = finite(viewer.pedEyeHeightData, 1.2);
        const result = priorSpawnPedAt([recovery.x, recovery.y, recovery.feetZ + eye], {
            ...(options && typeof options === 'object' ? options : {}),
            groundSource: 'demo_bounds_recovery',
        });
        return result;
    };

    // Catch direct transform writes which bypass both spawn and collision. This
    // intentionally waits for a stable violation. World transitions can change
    // their active bounds across adjacent frames; recovering immediately there
    // would fight the valid transition and produce a visible camera snap.
    window.setInterval(() => {
        const bounds = boundsFor(viewer);
        const ped = viewer.ped;
        if (!bounds || !ped || !outsideBounds(ped.posData, bounds)) {
            viewer._nxBoundsOutsideSince = 0;
            return;
        }
        const now = Date.now();
        if (!viewer._nxBoundsOutsideSince) {
            viewer._nxBoundsOutsideSince = now;
            return;
        }
        if (now - viewer._nxBoundsOutsideSince < 1000) return;
        viewer._nxBoundsOutsideSince = now;
        const recovery = resolveRecovery(viewer);
        if (!recovery) return;
        const vehicle = viewer.vehicleController?.vehicle;
        if (viewer.vehicleController?.inVehicle && vehicle) {
            vehicle.position = [recovery.x, recovery.y, recovery.feetZ + finite(vehicle.groundOffset, 0.4)];
            vehicle.velocity = [0, 0, 0];
            vehicle.velocityLocal = [0, 0];
            vehicle.speed = 0;
            vehicle.yawRate = 0;
            vehicle._chassisGroundCache = null;
            viewer.vehicleController?._syncOccupantPed?.();
            noteRecovery(viewer, recovery, 'vehicle_transform');
            return;
        }
        viewer.spawnPedAt([recovery.x, recovery.y, recovery.feetZ + finite(viewer.pedEyeHeightData, 1.2)], { groundSource: 'demo_bounds_recovery' });
    }, 250);
    return true;
};

const waitForViewer = () => {
    if (!install()) window.requestAnimationFrame(waitForViewer);
};
window.requestAnimationFrame(waitForViewer);

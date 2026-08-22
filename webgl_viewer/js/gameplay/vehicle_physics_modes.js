const finite = (value, fallback = 0) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value)));

export const VEHICLE_PHYSICS_MODES = Object.freeze({
    gta: Object.freeze({ id: 'gta', label: 'GTA handling', description: 'The existing arcade-oriented GTA handling values.' }),
    assetto: Object.freeze({ id: 'assetto', label: 'Assetto Corsa profile', description: 'A deterministic simulation baseline, optionally calibrated from a local Assetto Corsa data profile.' }),
});

export function normalizeVehiclePhysicsMode(value) {
    return String(value || '').toLowerCase() === 'assetto' ? 'assetto' : 'gta';
}

export function vehiclePhysicsModeLabel(value) {
    return VEHICLE_PHYSICS_MODES[normalizeVehiclePhysicsMode(value)].label;
}

/**
 * GTA mode returns authored handling unchanged. Assetto mode is an independent
 * solver profile that accepts derived values from a user-owned, plaintext
 * Assetto Corsa data profile; it does not use executable game code.
 */
export function vehiclePhysicsHandling(vehicle) {
    const gtaHandling = vehicle?.handling && typeof vehicle.handling === 'object' ? vehicle.handling : {};
    if (normalizeVehiclePhysicsMode(vehicle?.physicsMode) !== 'assetto') return gtaHandling;
    const imported = vehicle?.assettoHandling && typeof vehicle.assettoHandling === 'object' ? vehicle.assettoHandling : {};
    const mass = clamp(imported.mass ?? gtaHandling.mass, 650, 12000);
    const frontTyre = imported.tyres?.front || {};
    const rearTyre = imported.tyres?.rear || {};
    const frontSuspension = imported.suspension?.front || {};
    const rearSuspension = imported.suspension?.rear || {};
    const axleAverage = (front, rear) => {
        const values = [finite(front, Number.NaN), finite(rear, Number.NaN)].filter(Number.isFinite);
        return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    };
    const tyrePeak = axleAverage(frontTyre.peakLateralMu, rearTyre.peakLateralMu);
    const tyrePeakSlip = axleAverage(frontTyre.peakSlipAngleDeg, rearTyre.peakSlipAngleDeg);
    const springRate = axleAverage(frontSuspension.springRateNpm, rearSuspension.springRateNpm);
    const bumpDamping = axleAverage(frontSuspension.bumpDampingNsPm, rearSuspension.bumpDampingNsPm);
    const reboundDamping = axleAverage(frontSuspension.reboundDampingNsPm, rearSuspension.reboundDampingNsPm);
    const antiRollBar = axleAverage(frontSuspension.antiRollBarNm, rearSuspension.antiRollBarNm);
    const derivedSuspensionForce = springRate === null ? null : clamp(springRate / mass / 16, 0.2, 8);
    const derivedBumpDamping = bumpDamping === null ? null : clamp(bumpDamping / mass / 2.5, 0.1, 8);
    const derivedReboundDamping = reboundDamping === null ? null : clamp(reboundDamping / mass / 2.5, 0.1, 8);
    const derivedAntiRoll = antiRollBar === null ? null : clamp(antiRollBar / mass / 14, 0, 4);
    return {
        ...gtaHandling,
        ...imported,
        mass,
        driveBiasFront: clamp(imported.driveBiasFront ?? gtaHandling.driveBiasFront, 0, 1),
        brakeBiasFront: clamp(imported.brakeBiasFront ?? gtaHandling.brakeBiasFront, 0.35, 0.78),
        // This baseline favors a narrower tire peak, stronger load transfer,
        // more damping, and less low-speed steering assistance than GTA mode.
        driveForce: clamp(imported.driveForce ?? finite(gtaHandling.driveForce, 0.3) * 0.82, 0.04, 1),
        brakeForce: clamp(imported.brakeForce ?? finite(gtaHandling.brakeForce, 0.8) * 0.92, 0.1, 4),
        steeringLock: clamp(Math.abs(finite(imported.steeringLock, finite(gtaHandling.steeringLock, 35) * 0.78)), 18, 58),
        tractionMax: clamp(imported.tractionMax ?? tyrePeak ?? finite(gtaHandling.tractionMax, 2.2) * 0.90, 1.1, 4),
        tractionMin: clamp(imported.tractionMin ?? (tyrePeak === null ? finite(gtaHandling.tractionMin, 2.0) * 0.80 : tyrePeak * 0.82), 0.9, 4),
        tractionLateral: clamp(imported.tractionLateral ?? tyrePeakSlip ?? finite(gtaHandling.tractionLateral, 22.5) * 0.72, 8, 45),
        tractionLossMult: clamp(imported.tractionLossMult ?? Math.max(1.08, finite(gtaHandling.tractionLossMult, 1)), 0.35, 4),
        lowSpeedTractionLossMult: clamp(imported.lowSpeedTractionLossMult ?? finite(gtaHandling.lowSpeedTractionLossMult, 1) * 1.15, 0, 5),
        tractionBiasFront: clamp(imported.tractionBiasFront ?? imported.centerOfGravityFrontFraction ?? gtaHandling.tractionBiasFront, 0.1, 0.9),
        suspensionBiasFront: clamp(imported.suspensionBiasFront ?? imported.centerOfGravityFrontFraction ?? gtaHandling.suspensionBiasFront, 0.1, 0.9),
        suspensionForce: clamp(imported.suspensionForce ?? derivedSuspensionForce ?? finite(gtaHandling.suspensionForce, 2) * 1.18, 0.2, 8),
        suspensionCompDamp: clamp(imported.suspensionCompDamp ?? derivedBumpDamping ?? finite(gtaHandling.suspensionCompDamp, 1) * 1.22, 0.1, 8),
        suspensionReboundDamp: clamp(imported.suspensionReboundDamp ?? derivedReboundDamping ?? finite(gtaHandling.suspensionReboundDamp, 1.5) * 1.24, 0.1, 8),
        antiRollBarForce: clamp(imported.antiRollBarForce ?? derivedAntiRoll ?? finite(gtaHandling.antiRollBarForce, 0.7) * 1.12, 0, 4),
    };
}

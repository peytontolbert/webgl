import { readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = new Set(process.argv.slice(2));
const assetsArg = process.argv.indexOf('--assets-dir');
const assetsDir = resolve(assetsArg >= 0 ? process.argv[assetsArg + 1] : 'webgl_viewer/assets');
const checkOnly = args.has('--check');

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function items(value) {
    return Array.isArray(value) ? value.filter((row) => row && typeof row === 'object') : value && typeof value === 'object' ? [value] : [];
}

function scalar(node, name, fallback) {
    const value = node?.[name];
    return finite(value && typeof value === 'object' ? value['@value'] : value, fallback);
}

function text(node, name, fallback = '') {
    const value = node?.[name];
    const raw = value && typeof value === 'object' ? (value['#text'] ?? value['@value']) : value;
    return String(raw ?? fallback).trim();
}

function vector(node, name, fallback) {
    const value = node?.[name];
    if (!value || typeof value !== 'object') return [...fallback];
    return ['x', 'y', 'z'].map((axis, index) => finite(value[`@${axis}`], fallback[index]));
}

function compactHandling(node) {
    const fields = {
        mass: ['fMass', 1500], dragCoeff: ['fInitialDragCoeff', 8.0], percentSubmerged: ['fPercentSubmerged', 85],
        driveBiasFront: ['fDriveBiasFront', 0.5], driveBiasBack: ['fDriveBiasBack', 0], gears: ['nInitialDriveGears', 5],
        driveForce: ['fInitialDriveForce', 0.3], driveInertia: ['fDriveInertia', 1],
        clutchChangeRateUpShift: ['fClutchChangeRateScaleUpShift', 3], clutchChangeRateDownShift: ['fClutchChangeRateScaleDownShift', 3],
        maxFlatVelocity: ['fInitialDriveMaxFlatVel', 160], brakeForce: ['fBrakeForce', 0.8], brakeBiasFront: ['fBrakeBiasFront', 0.5],
        handBrakeForce: ['fHandBrakeForce', 0.7], steeringLock: ['fSteeringLock', 35], tractionMax: ['fTractionCurveMax', 2.3],
        tractionMin: ['fTractionCurveMin', 2.0], tractionLateral: ['fTractionCurveLateral', 22.5],
        tractionSpringDeltaMax: ['fTractionSpringDeltaMax', 0.15], lowSpeedTractionLossMult: ['fLowSpeedTractionLossMult', 1],
        camberStiffness: ['fCamberStiffnesss', 0], tractionBiasFront: ['fTractionBiasFront', 0.5], tractionLossMult: ['fTractionLossMult', 1],
        suspensionForce: ['fSuspensionForce', 2], suspensionCompDamp: ['fSuspensionCompDamp', 1],
        suspensionReboundDamp: ['fSuspensionReboundDamp', 1.5], suspensionUpperLimit: ['fSuspensionUpperLimit', 0.1],
        suspensionLowerLimit: ['fSuspensionLowerLimit', -0.1], suspensionRaise: ['fSuspensionRaise', 0],
        suspensionBiasFront: ['fSuspensionBiasFront', 0.5], antiRollBarForce: ['fAntiRollBarForce', 0.7],
        antiRollBarBiasFront: ['fAntiRollBarBiasFront', 0.5], rollCentreHeightFront: ['fRollCentreHeightFront', 0.35],
        rollCentreHeightRear: ['fRollCentreHeightRear', 0.35], collisionDamageMult: ['fCollisionDamageMult', 1],
        weaponDamageMult: ['fWeaponDamageMult', 1], deformationDamageMult: ['fDeformationDamageMult', 1],
        engineDamageMult: ['fEngineDamageMult', 1], petrolTankVolume: ['fPetrolTankVolume', 65], oilVolume: ['fOilVolume', 5],
        downforceModifier: ['fDownforceModifier', 0],
    };
    const output = Object.fromEntries(Object.entries(fields).map(([key, [name, fallback]]) => [key, scalar(node, name, fallback)]));
    output.gears = Math.max(1, Math.round(output.gears));
    output.centerOfMass = vector(node, 'vecCentreOfMassOffset', [0, 0, 0]);
    output.inertiaMultiplier = vector(node, 'vecInertiaMultiplier', [1, 1, 1]);
    return output;
}

function compactVehicle(node) {
    return {
        camera: {
            povOffset: vector(node, 'PovCameraOffset', [0, 0, 0.6]),
            povRollCageAdjustment: scalar(node, 'PovCameraVerticalAdjustmentForRollCage', 0),
            followCamera: text(node, 'cameraName'), aimCamera: text(node, 'aimCameraName'), bonnetCamera: text(node, 'bonnetCameraName'),
        },
        damage: {
            bodyHealth: scalar(node, 'defaultBodyHealth', 1000), mapScale: scalar(node, 'damageMapScale', 0.5),
            offsetScale: scalar(node, 'damageOffsetScale', 0.5), weaponForceMult: scalar(node, 'weaponForceMult', 1),
        },
        wheel: {
            scale: scalar(node, 'wheelScale', 0.35), rearScale: scalar(node, 'wheelScaleRear', scalar(node, 'wheelScale', 0.35)), type: text(node, 'wheelType'),
        },
        steerWheelMult: scalar(node, 'steerWheelMult', 1), vehicleFlags: text(node, 'flags'),
        vehicleClass: text(node, 'vehicleClass'), vehicleType: text(node, 'type'), layout: text(node, 'layout'),
    };
}

function applyFallbackMechanics(definition) {
    definition.handling = { ...compactHandling({}), ...(definition.handling || {}) };
    definition.handling.centerOfMass = Array.isArray(definition.handling.centerOfMass) ? definition.handling.centerOfMass : [0, 0, 0];
    definition.handling.inertiaMultiplier = Array.isArray(definition.handling.inertiaMultiplier) ? definition.handling.inertiaMultiplier : [1, 1, 1];
    const fallback = compactVehicle({});
    definition.camera = { ...fallback.camera, ...(definition.camera || {}) };
    definition.damage = { ...fallback.damage, ...(definition.damage || {}) };
    definition.wheel = { ...fallback.wheel, ...(definition.wheel || {}) };
    definition.steerWheelMult = finite(definition.steerWheelMult, fallback.steerWheelMult);
    definition.vehicleFlags = String(definition.vehicleFlags || '');
}

async function readJson(path) {
    return JSON.parse(await readFile(path, 'utf8'));
}

async function enrich(definition) {
    const document = await readJson(resolve(assetsDir, String(definition.metadata || '')));
    const findFile = (name) => document.files?.find((entry) => String(entry?.name || '').toLowerCase() === name);
    const vehicleItems = items(findFile('vehicles.meta')?.data?.InitDatas?.Item);
    const vehicle = vehicleItems.find((item) => text(item, 'modelName').toLowerCase() === String(definition.model || '').toLowerCase()) || vehicleItems[0];
    const handlingItems = items(findFile('handling.meta')?.data?.HandlingData?.Item);
    const handlingId = text(vehicle, 'handlingId').toLowerCase();
    const handling = handlingItems.find((item) => text(item, 'handlingName').toLowerCase() === handlingId) || handlingItems[0];
    if (!vehicle || !handling) throw new Error('missing vehicles.meta or handling.meta entry');
    definition.handling = compactHandling(handling);
    Object.assign(definition, compactVehicle(vehicle));
}

const catalogPath = resolve(assetsDir, 'custom_vehicles/catalog.json');
const catalog = await readJson(catalogPath);
const failures = [];
const fallbacks = [];
let enriched = 0;
for (const definition of catalog.vehicles || []) {
    try {
        await enrich(definition);
        enriched++;
        const manifestPath = resolve(assetsDir, `custom_vehicles/${definition.model}.json`);
        await access(manifestPath);
        if (!checkOnly) {
            const manifest = await readJson(manifestPath);
            manifest.vehicle = definition;
            await writeFile(manifestPath, JSON.stringify(manifest));
        }
    } catch (error) {
        applyFallbackMechanics(definition);
        fallbacks.push({ model: definition?.model || 'unknown', reason: String(error?.message || error) });
        const manifestPath = resolve(assetsDir, `custom_vehicles/${definition.model}.json`);
        try {
            await access(manifestPath);
            if (!checkOnly) {
                const manifest = await readJson(manifestPath);
                manifest.vehicle = definition;
                await writeFile(manifestPath, JSON.stringify(manifest));
            }
        } catch (manifestError) {
            failures.push({ model: definition?.model || 'unknown', error: String(manifestError?.message || manifestError) });
        }
    }
}
catalog.stats = { ...(catalog.stats || {}), mechanicsEnriched: enriched, mechanicsMetadataFallbacks: fallbacks.length, mechanicsEnrichmentFailures: failures.length };
if (!checkOnly) await writeFile(catalogPath, JSON.stringify(catalog));
console.log(JSON.stringify({ enriched, fallbacks, failures }, null, 2));
process.exitCode = failures.length ? 1 : 0;

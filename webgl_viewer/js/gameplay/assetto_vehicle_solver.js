const finite = (value, fallback = 0) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value)));
const lerp = (a, b, t) => a + (b - a) * t;

function curve(points, x, fallback) {
    if (!Array.isArray(points) || !points.length) return fallback;
    const rows = points.filter((row) => Array.isArray(row) && Number.isFinite(Number(row[0])) && Number.isFinite(Number(row[1])));
    if (!rows.length) return fallback;
    rows.sort((a, b) => Number(a[0]) - Number(b[0]));
    if (x <= rows[0][0]) return finite(rows[0][1], fallback);
    for (let i = 1; i < rows.length; i++) {
        if (x <= rows[i][0]) {
            const span = Math.max(1e-6, Number(rows[i][0]) - Number(rows[i - 1][0]));
            return lerp(Number(rows[i - 1][1]), Number(rows[i][1]), clamp((x - Number(rows[i - 1][0])) / span, 0, 1));
        }
    }
    return finite(rows[rows.length - 1][1], fallback);
}

function axleValue(profile, axle, key, fallback) {
    return finite(profile?.[axle]?.[key], fallback);
}

function tyre(profile, axle, key, fallback) {
    return finite(profile?.tyres?.[axle]?.[key], fallback);
}

function wheelKey(front, left) {
    return front ? (left ? '27922' : '26418') : (left ? '27902' : '26398');
}

/**
 * A compact independent road-car solver. It uses Assetto-style data units
 * (kg, m, N/m, N*s/m, Nm, metres, radians) and intentionally does not call
 * the GTA handling equations. Collision/ground probing stays in the host app.
 */
export function createAssettoVehicleState() {
    return {
        longitudinal: 0, lateral: 0, yawRate: 0, rpm: 900, gear: 1, shiftTimer: 0,
        steering: 0, throttle: 0, brake: 0, engineLoad: 0,
        wheelOmega: { 27922: 0, 26418: 0, 27902: 0, 26398: 0 },
        previousLongitudinalAcceleration: 0, previousLateralAcceleration: 0,
    };
}

/**
 * Quasi-static chassis pitch from longitudinal load transfer. Positive is
 * nose-up, matching the GTA drawable's local +Y forward / positive-X render
 * rotation convention. Spring rates are per wheel in Assetto data, hence the
 * two-spring axle stiffness below.
 */
export function assettoLongitudinalPitchDelta(profile, accelerationMetersPerSecondSquared) {
    const mass = clamp(profile?.mass, 650, 12000) || 1450;
    const wheelbase = clamp(profile?.wheelbase, 2.0, 5.5) || 2.65;
    const cgHeight = clamp(finite(profile?.centerOfGravityHeightM, 0.52), 0.25, 1.0);
    const frontRate = clamp(finite(profile?.suspension?.front?.springRateNpm, 36000), 8000, 250000);
    const rearRate = clamp(finite(profile?.suspension?.rear?.springRateNpm, 32000), 8000, 250000);
    const loadTransfer = mass * finite(accelerationMetersPerSecondSquared) * cgHeight / wheelbase;
    const frontRise = loadTransfer / (frontRate * 2.0);
    const rearSquat = loadTransfer / (rearRate * 2.0);
    return clamp(Math.atan2(frontRise + rearSquat, wheelbase), -0.14, 0.14);
}

export function stepAssettoVehicle(state, profile, contacts, input, dt) {
    const mass = clamp(profile?.mass, 650, 12000) || 1450;
    const wheelbase = clamp(profile?.wheelbase, 2.0, 5.5) || 2.65;
    const trackFront = clamp(profile?.trackFront, 1.1, 3.0) || 1.45;
    const trackRear = clamp(profile?.trackRear, 1.1, 3.0) || trackFront;
    const frontFraction = clamp(profile?.centerOfGravityFrontFraction, 0.25, 0.75) || 0.52;
    const cgHeight = clamp(finite(profile?.centerOfGravityHeightM, 0.52), 0.25, 1.0);
    const yawInertia = Math.max(650, finite(profile?.inertiaTensor?.[2], mass * wheelbase * wheelbase * 0.29));
    const driveFront = clamp(profile?.driveBiasFront, 0, 1);
    const brakeFront = clamp(profile?.brakeBiasFront, 0.2, 0.85);
    const finalDrive = clamp(profile?.finalDrive, 1.0, 8.0) || 3.8;
    const ratios = Array.isArray(profile?.gearRatios) && profile.gearRatios.length ? profile.gearRatios.map((value) => Math.max(0.1, finite(value, 1))) : [3.2, 2.1, 1.45, 1.1, 0.9];
    const redline = clamp(profile?.redlineRpm, 3000, 12000) || 7200;
    const idle = clamp(profile?.idleRpm, 650, Math.min(1800, redline * 0.35)) || 850;
    const shiftUp = clamp(profile?.shiftTimeUpSec, 0.04, 1.2) || 0.18;
    const shiftDown = clamp(profile?.shiftTimeDownSec, 0.04, 1.2) || 0.16;
    const throttleTarget = input.throttle ? 1 : input.reverse ? -0.82 : 0;
    const brakeTarget = (input.throttle && state.longitudinal < -0.7) || (input.reverse && state.longitudinal > 0.7) ? 1 : 0;
    state.throttle += (throttleTarget - state.throttle) * (1 - Math.exp(-(Math.abs(throttleTarget) > Math.abs(state.throttle) ? 8 : 11) * dt));
    state.brake += (brakeTarget - state.brake) * (1 - Math.exp(-(brakeTarget ? 20 : 13) * dt));
    // Assetto's STEER_LOCK is the physical road-wheel limit. The old 10%
    // speed floor reduced the 350Z to only 4.5 degrees at 30 m/s and 2.8
    // degrees at 50 m/s, making bends impossible before the tyre model could
    // generate physical understeer. Preserve most of the authored authority;
    // modest speed sensitivity keeps binary keyboard input controllable.
    const speedAuthority = 0.58 + 0.42 / (1 + Math.pow(Math.abs(state.longitudinal) / 32, 2));
    const steerTarget = clamp(input.steer, -1, 1) * speedAuthority;
    const speedResponseScale = 0.48 + 0.52 / (1 + Math.pow(Math.abs(state.longitudinal) / 34, 2));
    const steeringRate = (Math.abs(steerTarget) > Math.abs(state.steering) ? 5.5 : 8.0) * speedResponseScale;
    state.steering += (steerTarget - state.steering) * (1 - Math.exp(-steeringRate * dt));
    // Some AC suspension conventions encode steering lock with a signed value;
    // the sign describes orientation, not a negative maximum angle.
    const steeringLock = clamp(Math.abs(finite(profile?.steeringLock, 32)), 15, 58) || 32;
    const steerRad = state.steering * steeringLock * Math.PI / 180;

    state.shiftTimer = Math.max(0, state.shiftTimer - dt);
    const reverse = state.throttle < -0.08 || (input.reverse && state.longitudinal < -0.5);
    const gearCount = ratios.length;
    state.gear = clamp(state.gear, 1, gearCount) | 0;
    const drivenOmega = driveFront > 0.5
        ? (state.wheelOmega[27922] + state.wheelOmega[26418]) * 0.5
        : (state.wheelOmega[27902] + state.wheelOmega[26398]) * 0.5;
    const ratio = reverse ? -Math.max(2.0, ratios[0] * 0.82) : ratios[state.gear - 1];
    const coupledRpm = Math.abs(drivenOmega * ratio * finalDrive) * (60 / (2 * Math.PI));
    const freeRpm = idle + Math.abs(state.throttle) * (redline - idle) * 0.68;
    const targetRpm = state.shiftTimer > 0 ? freeRpm : Math.max(freeRpm, coupledRpm);
    state.rpm += (clamp(targetRpm, idle, redline * 1.04) - state.rpm) * (1 - Math.exp(-16 * dt));
    if (!reverse && state.shiftTimer <= 0 && state.throttle > 0.2 && state.rpm > redline * 0.975 && state.gear < gearCount) {
        state.gear++;
        state.shiftTimer = shiftUp;
    } else if (!reverse && state.shiftTimer <= 0 && state.gear > 1 && state.rpm < Math.max(idle * 1.5, redline * 0.48)) {
        state.gear--;
        state.shiftTimer = shiftDown;
    }

    const frontDistance = wheelbase * (1 - frontFraction);
    const rearDistance = wheelbase - frontDistance;
    const longTransfer = mass * state.previousLongitudinalAcceleration * cgHeight / wheelbase;
    const latTransferFront = mass * state.previousLateralAcceleration * cgHeight * frontFraction / trackFront;
    const latTransferRear = mass * state.previousLateralAcceleration * cgHeight * (1 - frontFraction) / trackRear;
    const staticFront = mass * 9.81 * frontFraction;
    const staticRear = mass * 9.81 * (1 - frontFraction);
    const wheels = [
        { key: wheelKey(true, true), front: true, left: true, x: trackFront * 0.5, y: frontDistance },
        { key: wheelKey(true, false), front: true, left: false, x: -trackFront * 0.5, y: frontDistance },
        { key: wheelKey(false, true), front: false, left: true, x: trackRear * 0.5, y: -rearDistance },
        { key: wheelKey(false, false), front: false, left: false, x: -trackRear * 0.5, y: -rearDistance },
    ];
    const torquePoints = Array.isArray(profile?.engineTorqueCurveNm) ? profile.engineTorqueCurveNm : [];
    const curvePeak = torquePoints.reduce((peak, point) => Math.max(peak, Array.isArray(point) ? finite(point[1]) : 0), 0);
    const peakEngineTorque = Math.max(80, finite(profile?.peakEngineTorqueNm, curvePeak || mass * 0.17));
    const curveTorque = curve(torquePoints, state.rpm, Number.NaN);
    // Some traffic/placeholder data contains a nominal LUT with no usable
    // positive torque above idle. Do not let that silently create a dead car;
    // retain a documented conservative envelope until a valid car profile is
    // supplied. A real curve still owns the result wherever it is positive.
    const fallbackTorque = peakEngineTorque * clamp(0.94 - (state.rpm / redline) * 0.22, 0.50, 0.94);
    const usableCurveTorque = Number.isFinite(curveTorque) && (curveTorque > peakEngineTorque * 0.025 || state.rpm >= redline * 0.97);
    // Throttle sign selects the transmission direction; engine output itself is
    // a positive magnitude. Clamping signed reverse throttle to zero left only
    // coast torque, which the negative reverse ratio then turned into a small
    // forward wheel torque.
    const engineTorque = Math.max(0, usableCurveTorque ? curveTorque : fallbackTorque) * Math.abs(state.throttle);
    const coastTorque = Math.max(0, curve(profile?.engineBrakingCurveNm, state.rpm, peakEngineTorque * 0.16)) * clamp(1 - Math.abs(state.throttle) * 1.5, 0, 1);
    const totalDriveTorque = state.shiftTimer > 0 ? 0 : (engineTorque - coastTorque) * ratio * finalDrive * 0.90;
    const brakeTorque = Math.max(50, finite(profile?.brakeTorqueNm, mass * 2.1)) * state.brake;
    const handbrakeTorque = input.handbrake ? Math.max(400, brakeTorque * 0.8) : 0;
    let forceX = 0; let forceY = 0; let yawMoment = 0; let maxSlip = 0;
    const telemetryWheels = {};
    const driveCandidates = wheels.filter((wheel) => wheel.front ? driveFront > 0.02 : driveFront < 0.98);
    const drivenSlip = driveCandidates.length ? driveCandidates.reduce((sum, wheel) => sum + Math.abs(finite(state._lastSlipRatio?.[wheel.key])), 0) / driveCandidates.length : 0;
    const tcFactor = drivenSlip > 0.13 && Math.abs(state.throttle) > 0.01 ? clamp(1 - (drivenSlip - 0.13) * 2.5, 0.2, 1) : 1;
    const nextSlipRatio = {};

    for (const wheel of wheels) {
        const axle = wheel.front ? 'front' : 'rear';
        const contact = contacts?.contacts?.[wheel.key] || {};
        const grounded = contact.grounded !== false;
        const grip = clamp(contact.grip, 0.15, 1.5);
        const staticLoad = wheel.front ? staticFront * 0.5 : staticRear * 0.5;
        const longLoad = wheel.front ? -longTransfer * 0.5 : longTransfer * 0.5;
        const lateralLoad = (wheel.front ? latTransferFront : latTransferRear) * (wheel.left ? -1 : 1);
        const normal = grounded ? Math.max(mass * 9.81 * 0.025, staticLoad + longLoad + lateralLoad) : 0;
        const radius = clamp(tyre(profile, axle, 'radius', 0.33), 0.18, 0.65);
        const inertia = clamp(tyre(profile, axle, 'angularInertia', 1.2), 0.15, 8.0);
        const steer = wheel.front ? steerRad : 0;
        const patchLong = state.longitudinal - state.yawRate * wheel.x;
        const patchLat = state.lateral + state.yawRate * wheel.y;
        const tireLong = patchLong * Math.cos(steer) + patchLat * Math.sin(steer);
        const tireLat = -patchLong * Math.sin(steer) + patchLat * Math.cos(steer);
        const omega = finite(state.wheelOmega[wheel.key]);
        const slipRatio = (radius * omega - tireLong) / Math.max(3, Math.abs(tireLong));
        const slipAngle = Math.atan2(tireLat, Math.max(1.0, Math.abs(tireLong)));
        nextSlipRatio[wheel.key] = slipRatio;
        const refLoad = Math.max(300, tyre(profile, axle, 'referenceLoadN', staticLoad));
        const muLong = Math.max(0.35, tyre(profile, axle, 'peakLongitudinalMu', 1.05) * (1 + tyre(profile, axle, 'longitudinalLoadSensitivity', -0.04) * ((normal - refLoad) / refLoad))) * grip;
        const muLat = Math.max(0.35, tyre(profile, axle, 'peakLateralMu', 1.08) * (1 + tyre(profile, axle, 'lateralLoadSensitivity', -0.04) * ((normal - refLoad) / refLoad))) * grip;
        let fx = muLong * normal * Math.tanh(slipRatio / 0.105);
        let fy = -muLat * normal * Math.tanh(slipAngle / 0.105);
        const ellipse = Math.hypot(fx / Math.max(1, muLong * normal), fy / Math.max(1, muLat * normal));
        if (ellipse > 1) { fx /= ellipse; fy /= ellipse; }
        const driven = wheel.front ? driveFront : 1 - driveFront;
        const wheelDriveTorque = totalDriveTorque * driven * 0.5 * tcFactor;
        const wheelBrakeTorque = brakeTorque * (wheel.front ? brakeFront : 1 - brakeFront) * 0.5 + (!wheel.front ? handbrakeTorque * 0.5 : 0);
        const absFactor = state.brake > 0.05 && slipRatio < -0.16 ? 0.36 : 1;
        const brakeSign = Math.sign(omega || tireLong || 1);
        const torqueOmega = omega + ((wheelDriveTorque - wheelBrakeTorque * absFactor * brakeSign) / inertia) * dt;
        // Explicit tyre torque integration becomes numerically stiff at browser
        // frame sizes. Relax each wheel toward its ground-speed solution after
        // applying drivetrain torque; this retains slip while preventing the
        // free front wheels from alternating between lock and overspeed.
        const rollingOmega = tireLong / radius;
        const rollingBlend = 1 - Math.exp(-34 * dt);
        state.wheelOmega[wheel.key] = torqueOmega + (rollingOmega - torqueOmega) * rollingBlend;
        // Prevent a stopped wheel from numerically rolling backwards under brakes.
        if (Math.abs(state.wheelOmega[wheel.key]) < 0.25 && Math.abs(tireLong) < 0.6 && state.brake > 0.1) state.wheelOmega[wheel.key] = 0;
        const bodyFx = fx * Math.cos(steer) - fy * Math.sin(steer);
        const bodyFy = fx * Math.sin(steer) + fy * Math.cos(steer);
        forceX += bodyFx; forceY += bodyFy; yawMoment += wheel.y * bodyFy - wheel.x * bodyFx;
        maxSlip = Math.max(maxSlip, Math.abs(slipRatio), Math.abs(slipAngle) / 0.35);
        telemetryWheels[wheel.key] = { normal, fx: bodyFx, fy: bodyFy, slipRatio, slipAngle, omega: state.wheelOmega[wheel.key], grounded, grip };
    }
    state._lastSlipRatio = nextSlipRatio;
    const speedSquared = state.longitudinal * Math.abs(state.longitudinal);
    const rollingConstant = tyre(profile, 'front', 'rollingResistanceN', 12) + tyre(profile, 'rear', 'rollingResistanceN', 12);
    const rollingQuadratic = tyre(profile, 'front', 'rollingResistanceSpeedSquared', 0) + tyre(profile, 'rear', 'rollingResistanceSpeedSquared', 0);
    const rolling = -Math.sign(state.longitudinal || 0) * (rollingConstant + rollingQuadratic * speedSquared);
    // Assetto aero is imported as force / speed^2.  Retain a conservative
    // fallback only for profiles which genuinely have no aero data.
    const aeroDrag = finite(profile?.aeroDragNPerMps2, Number.NaN);
    const dragPerSpeedSquared = Number.isFinite(aeroDrag) && aeroDrag > 0
        ? aeroDrag
        : clamp(profile?.dragCoeff, 0.2, 20) * 0.045;
    const drag = -dragPerSpeedSquared * speedSquared;
    const accelerationX = (forceX + rolling + drag) / mass + state.yawRate * state.lateral;
    const accelerationY = forceY / mass - state.yawRate * state.longitudinal;
    const yawAcceleration = yawMoment / yawInertia;
    state.longitudinal += accelerationX * dt;
    state.lateral += accelerationY * dt;
    state.yawRate += yawAcceleration * dt;
    if (Math.abs(state.longitudinal) < 0.15 && !input.throttle && !input.reverse) state.longitudinal = 0;
    if (Math.abs(state.longitudinal) < 1.0) state.lateral *= Math.exp(-7.0 * dt);
    state.yawRate *= Math.exp(-(0.45 + Math.abs(state.longitudinal) * 0.012) * dt);
    state.engineLoad += ((Math.abs(state.throttle) * tcFactor) - state.engineLoad) * (1 - Math.exp(-10 * dt));
    state.previousLongitudinalAcceleration = accelerationX;
    state.previousLateralAcceleration = accelerationY;
    return {
        longitudinal: state.longitudinal, lateral: state.lateral, yawRate: state.yawRate, steeringRad: steerRad,
        rpm: state.rpm, gear: state.gear, shiftTimer: state.shiftTimer, throttle: state.throttle, brake: state.brake, engineLoad: state.engineLoad,
        forces: { longitudinal: forceX, lateral: forceY, yawMoment, rolling, drag, accelerationX, accelerationY, yawAcceleration },
        wheels: telemetryWheels, tireSlip: clamp(maxSlip, 0, 2), tractionControl: tcFactor, reverse,
    };
}

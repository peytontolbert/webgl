#!/usr/bin/env python3
"""Create a local-only browser physics profile from Assetto Corsa plaintext INI data.

This tool intentionally reads only an already-available ``data/`` directory.
It does not inspect executables, decrypt or unpack data.acd, or copy models,
textures, sounds, track meshes, or original INI text into the web project.
"""

from __future__ import annotations

import argparse
import configparser
import json
from pathlib import Path
from typing import Any


CAR_FILES = ("car.ini", "engine.ini", "drivetrain.ini", "suspensions.ini", "brakes.ini", "tyres.ini", "aero.ini", "setup.ini")


def number(value: str | None, fallback: float | None = None) -> float | None:
    try:
        # Assetto Corsa INI files commonly use a semicolon comment after a
        # numeric literal. Keep only the literal in our derived profile.
        literal = str(value).split(";", 1)[0].split("#", 1)[0].strip()
        return float(literal)
    except (TypeError, ValueError):
        return fallback


def section_value(data: dict[str, dict[str, str]], section: str, *keys: str) -> float | None:
    row = data.get(section.upper(), {})
    for key in keys:
        value = number(row.get(key.upper()))
        if value is not None:
            return value
    return None


def text_value(data: dict[str, dict[str, str]], section: str, key: str) -> str | None:
    value = data.get(section.upper(), {}).get(key.upper())
    if value is None:
        return None
    return str(value).split(";", 1)[0].split("#", 1)[0].strip() or None


def numeric_series(data: dict[str, dict[str, str]], section: str, prefix: str) -> list[float]:
    row = data.get(section.upper(), {})
    values: list[tuple[int, float]] = []
    for key, raw in row.items():
        if not key.startswith(prefix.upper()):
            continue
        suffix = key[len(prefix):]
        if not suffix.isdigit():
            continue
        value = number(raw)
        if value is not None:
            values.append((int(suffix), value))
    return [value for _, value in sorted(values)]


def read_ini(path: Path) -> dict[str, dict[str, str]]:
    parser = configparser.ConfigParser(interpolation=None, strict=False)
    parser.optionxform = str.upper
    # Some valid community data folders use visual `////` separators. They are
    # not INI syntax, so retain only section, assignment, and normal comment
    # lines before passing the data to ConfigParser.
    raw_lines = path.read_text(encoding="utf-8-sig", errors="replace").splitlines()
    ini_lines = [line for line in raw_lines if (
        not line.strip()
        or line.lstrip().startswith((";", "#"))
        or (line.strip().startswith("[") and line.strip().endswith("]"))
        or "=" in line
    )]
    parser.read_string("\n".join(ini_lines), source=str(path))
    return {section.upper(): dict(parser.items(section)) for section in parser.sections()}


def read_available(data_dir: Path, filenames: tuple[str, ...]) -> dict[str, dict[str, dict[str, str]]]:
    return {name: read_ini(data_dir / name) for name in filenames if (data_dir / name).is_file()}


def read_lut(path: Path) -> list[list[float]]:
    """Read a numeric Assetto-style ``x|y`` lookup table as derived points.

    The output deliberately contains values only: it carries no source text,
    names, or game assets. Invalid/comment lines are ignored.
    """
    if not path.is_file():
        return []
    points: list[list[float]] = []
    for raw_line in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        line = raw_line.split(";", 1)[0].split("#", 1)[0].strip()
        if "|" not in line:
            continue
        x, y, *_ = line.split("|")
        first, second = number(x), number(y)
        if first is not None and second is not None:
            points.append([first, second])
    return points


def engine_curve(path: Path, limiter_rpm: float | None) -> list[list[float]]:
    """Return a usable engine curve, excluding post-limiter sentinel rows.

    Community data sometimes appends arbitrary data after the engine limiter.
    Those rows are not physically reachable and can turn a numeric interpolation
    into an enormous fictitious torque request, so keep values through a small
    limiter margin only.
    """
    limit = limiter_rpm * 1.05 if limiter_rpm is not None else None
    return [[rpm, torque] for rpm, torque in read_lut(path) if rpm >= 0 and torque >= 0 and (limit is None or rpm <= limit)]


def compact(values: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in values.items() if value is not None}


def tyre_profile(tyres: dict[str, dict[str, str]]) -> dict[str, Any]:
    """Extract the two active axle compounds without reproducing INI data."""
    compound_index = section_value(tyres, "COMPOUND_DEFAULT", "INDEX")

    def axle(name: str) -> dict[str, Any]:
        # Assetto content is inconsistent here: official cars commonly put
        # compound zero in FRONT/REAR, while many community cars declare
        # COMPOUND_DEFAULT=0 but store the active tyre in FRONT_1/REAR_1.
        # Pick an existing numbered section before the unnumbered fallback.
        index = int(compound_index or 0)
        candidates = [f"{name}_{index}", f"{name}_{index + 1}", name]
        section = next((candidate for candidate in candidates if candidate in tyres), name)
        values = compact({
            "radius": section_value(tyres, section, "RADIUS"),
            "width": section_value(tyres, section, "WIDTH"),
            "peakLongitudinalMu": section_value(tyres, section, "DX0"),
            "peakLateralMu": section_value(tyres, section, "DY0"),
            "peakSlipAngleDeg": section_value(tyres, section, "FRICTION_LIMIT_ANGLE"),
            "longitudinalLoadSensitivity": section_value(tyres, section, "DX1"),
            "lateralLoadSensitivity": section_value(tyres, section, "DY1"),
            "referenceLoadN": section_value(tyres, section, "FZ0"),
            "relaxationLength": section_value(tyres, section, "RELAXATION_LENGTH"),
            "rollingResistanceN": section_value(tyres, section, "ROLLING_RESISTANCE_0"),
            "rollingResistanceSpeedSquared": section_value(tyres, section, "ROLLING_RESISTANCE_1"),
            "angularInertia": section_value(tyres, section, "ANGULAR_INERTIA"),
        })
        return {"compoundSection": section, **values}

    return compact({"compoundIndex": compound_index, "front": axle("FRONT"), "rear": axle("REAR")})


def aero_profile(aero: dict[str, dict[str, str]], data_dir: Path) -> dict[str, Any]:
    """Derive a zero-incidence quadratic drag coefficient in N/(m/s)^2.

    Assetto's aero entries express reference area as chord*span and drag as a
    dimensionless LUT.  The browser solver needs force directly, so derive
    only the zero-incidence total.  This remains numeric calibration data and
    avoids copying the original LUT or mesh data into the demo.
    """
    rho = 1.225
    total = 0.0
    areas: list[float] = []
    for section, row in aero.items():
        if not section.startswith("WING_"):
            continue
        chord = number(row.get("CHORD"))
        span = number(row.get("SPAN"))
        gain = number(row.get("CD_GAIN"), 1.0)
        lut_name = text_value(aero, section, "LUT_AOA_CD")
        if not chord or not span or gain is None or not lut_name:
            continue
        points = read_lut(data_dir / lut_name)
        if not points:
            continue
        # Linear interpolation is unnecessary for the usual explicit 0-degree
        # row; the closest sample is a stable fallback for unusual LUTs.
        cd = min(points, key=lambda point: abs(point[0]))[1]
        if cd < 0:
            continue
        area = chord * span
        total += 0.5 * rho * area * cd * gain
        areas.append(area)
    return compact({
        "aeroDragNPerMps2": total if total > 0 else None,
        "aeroReferenceAreaM2": sum(areas) if areas else None,
    })


def axle_suspension(suspensions: dict[str, dict[str, str]], axle: str) -> dict[str, Any]:
    return compact({
        "track": section_value(suspensions, axle, "TRACK"),
        "springRateNpm": section_value(suspensions, axle, "SPRING_RATE"),
        "progressiveSpringRateNpm2": section_value(suspensions, axle, "PROGRESSIVE_SPRING_RATE"),
        "bumpDampingNsPm": section_value(suspensions, axle, "DAMP_BUMP"),
        "reboundDampingNsPm": section_value(suspensions, axle, "DAMP_REBOUND"),
        "bumpStopUpM": section_value(suspensions, axle, "BUMPSTOP_UP"),
        "bumpStopDownM": section_value(suspensions, axle, "BUMPSTOP_DN"),
        "antiRollBarNm": section_value(suspensions, "ARB", axle),
    })


def canonical_handling(files: dict[str, dict[str, dict[str, str]]], data_dir: Path) -> dict[str, Any]:
    car, engine, drivetrain, brakes, suspensions, tyres, aero = (files.get(name, {}) for name in ("car.ini", "engine.ini", "drivetrain.ini", "brakes.ini", "suspensions.ini", "tyres.ini", "aero.ini"))
    mass = section_value(car, "BASIC", "TOTALMASS") or section_value(car, "CAR", "TOTALMASS")
    gear_count = section_value(drivetrain, "GEARS", "COUNT")
    limiter = section_value(engine, "ENGINE_DATA", "LIMITER")
    brake_bias = section_value(brakes, "DATA", "FRONT_SHARE")
    brake_torque = section_value(brakes, "DATA", "MAX_TORQUE")
    wheelbase = section_value(suspensions, "BASIC", "WHEELBASE")
    track_front = section_value(suspensions, "BASIC", "TRACK_FRONT")
    track_rear = section_value(suspensions, "BASIC", "TRACK_REAR")
    steer_lock_wheel = section_value(car, "CONTROLS", "STEER_LOCK")
    steer_ratio = section_value(car, "CONTROLS", "STEER_RATIO")
    drive_type = (text_value(drivetrain, "TRACTION", "TYPE") or "").upper()
    drive_bias_front = {"FWD": 1.0, "RWD": 0.0, "AWD": 0.5, "AWD1": 0.5, "AWD2": 0.5, "4WD": 0.5}.get(drive_type)
    shift_up_ms = section_value(drivetrain, "GEARBOX", "CHANGE_UP_TIME")
    shift_down_ms = section_value(drivetrain, "GEARBOX", "CHANGE_DN_TIME")
    final_drive = section_value(drivetrain, "GEARS", "FINAL")
    gear_ratios = numeric_series(drivetrain, "GEARS", "GEAR_")
    inertia = text_value(car, "BASIC", "INERTIA")
    inertia_vector = [number(value) for value in inertia.split(",")] if inertia else []
    # AC vehicle data sometimes expresses inertia as a mass-normalized tuple.
    # Canonicalize it to kg m^2 so the browser solver has one unambiguous unit.
    if mass and inertia_vector and all(value is not None for value in inertia_vector) and max(inertia_vector) < 50:
        inertia_vector = [value * mass for value in inertia_vector]
    return compact({
        "mass": mass,
        "gears": int(gear_count) if gear_count is not None else None,
        "redlineRpm": limiter,
        "idleRpm": section_value(engine, "ENGINE_DATA", "MINIMUM"),
        "brakeBiasFront": brake_bias,
        "brakeTorqueNm": brake_torque,
        "driveBiasFront": drive_bias_front,
        "steeringLock": (steer_lock_wheel / steer_ratio) if steer_lock_wheel and steer_ratio else None,
        "shiftTimeUpSec": (shift_up_ms / 1000.0) if shift_up_ms is not None else None,
        "shiftTimeDownSec": (shift_down_ms / 1000.0) if shift_down_ms is not None else None,
        "finalDrive": final_drive,
        "gearRatios": gear_ratios or None,
        "differentialPower": section_value(drivetrain, "DIFFERENTIAL", "POWER"),
        "differentialCoast": section_value(drivetrain, "DIFFERENTIAL", "COAST"),
        "differentialPreloadNm": section_value(drivetrain, "DIFFERENTIAL", "PRELOAD"),
        "inertiaTensor": inertia_vector if inertia_vector and all(value is not None for value in inertia_vector) else None,
        "wheelbase": wheelbase,
        "trackFront": track_front or section_value(suspensions, "FRONT", "TRACK"),
        "trackRear": track_rear or section_value(suspensions, "REAR", "TRACK"),
        "centerOfGravityFrontFraction": section_value(suspensions, "BASIC", "CG_LOCATION"),
        "tyres": tyre_profile(tyres) if tyres else None,
        "suspension": compact({"front": axle_suspension(suspensions, "FRONT"), "rear": axle_suspension(suspensions, "REAR")}) if suspensions else None,
        "engineTorqueCurveNm": engine_curve(data_dir / "power.lut", limiter) or None,
        "engineBrakingCurveNm": engine_curve(data_dir / "coast.lut", limiter) or None,
        **aero_profile(aero, data_dir),
    })


def surface_summary(track_data_dir: Path) -> list[dict[str, Any]]:
    path = track_data_dir / "surfaces.ini"
    if not path.is_file():
        return []
    data = read_ini(path)
    rows: list[dict[str, Any]] = []
    for name, values in data.items():
        rows.append(compact({
            "name": (text_value(data, name, "KEY") or name).lower(),
            "friction": number(values.get("FRICTION")),
            "damping": number(values.get("DAMP")),
            "waviness": number(values.get("WAV")),
        }))
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--car-data", type=Path, required=True, help="Path to one authorized car's plaintext data directory")
    parser.add_argument("--car-id", required=True, help="Stable non-proprietary identifier used by the local demo")
    parser.add_argument("--track-data", type=Path, help="Optional plaintext track data directory, e.g. ks_nordschleife/data")
    parser.add_argument("--track-id", default="ks_nordschleife", help="Local track profile identifier")
    parser.add_argument("--out", type=Path, required=True, help="Output JSON path (keep this local; it is gitignored by default)")
    args = parser.parse_args()

    car_data = args.car_data.resolve()
    if not car_data.is_dir():
        parser.error(f"--car-data is not a directory: {car_data}")
    files = read_available(car_data, CAR_FILES)
    if not files:
        parser.error("No supported plaintext INI files found. Provide an authorized, already-unpacked data directory; data.acd is intentionally unsupported.")

    profile: dict[str, Any] = {
        "schema": "webglgta-assetto-corsa-profile-v1",
        "source": {"kind": "local_plaintext_ini", "carId": args.car_id, "trackId": args.track_id},
        "assettoHandling": canonical_handling(files, car_data),
        "availableFiles": sorted(files),
    }
    if args.track_data:
        track_data = args.track_data.resolve()
        if not track_data.is_dir():
            parser.error(f"--track-data is not a directory: {track_data}")
        profile["trackSurfaces"] = surface_summary(track_data)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(profile, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Wrote local profile: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

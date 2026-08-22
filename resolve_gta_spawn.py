#!/usr/bin/env python
"""
Resolve a GTA-like player spawn for the WebGL viewer.

This is intentionally a resolver, not a hardcoded coordinate:
- explicit exported spawn profiles win
- FiveM/NX-style runtime resource configs are parsed when present
- GTA save/script support is surfaced as diagnostics so we can add real parsers without
  changing the client boot path again

The output is browser-safe JSON consumed by /__spawn/resolve in Vite.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import struct
import time
from pathlib import Path
from typing import Any, Iterable


REPO_ROOT = Path(__file__).resolve().parent


def read_dotenv(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    try:
        for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            v = v.strip().strip('"').strip("'")
            out[k.strip()] = v
    except Exception:
        pass
    return out


def as_float(v: Any, default: float = math.nan) -> float:
    try:
        f = float(v)
        return f if math.isfinite(f) else default
    except Exception:
        return default


def vector_obj(values: Iterable[Any], *, label: str = "", source: str = "") -> dict[str, Any] | None:
    vals = [as_float(x) for x in list(values)[:4]]
    if len(vals) < 3 or not all(math.isfinite(v) for v in vals[:3]):
        return None
    while len(vals) < 4:
        vals.append(0.0)
    x, y, z, w = vals
    return {
        "x": x,
        "y": y,
        "z": z,
        "w": w if math.isfinite(w) else 0.0,
        "label": label,
        "source": source,
    }


def parse_vector_args(text: str) -> list[float] | None:
    nums = re.findall(r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?", text or "")
    if len(nums) < 3:
        return None
    return [float(x) for x in nums[:4]]


def _extract_mapping_vector(text: str) -> list[float] | None:
    """
    Extract x/y/z/(heading) from Lua/JSON-ish table text.

    This intentionally accepts a small set of common shapes from FiveM resources and
    SQL dumps, for example:
      { x = 1.0, y = 2.0, z = 3.0, w = 90.0 }
      {"x":1.0,"y":2.0,"z":3.0,"heading":90.0}
    """
    found: dict[str, float] = {}
    for m in re.finditer(
        r"""["']?(x|y|z|w|h|heading)["']?\s*(?:=|:)\s*["']?([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)""",
        text or "",
        re.IGNORECASE,
    ):
        k = m.group(1).lower()
        if k == "h":
            k = "heading"
        try:
            found[k] = float(m.group(2))
        except Exception:
            continue
    if not all(k in found for k in ("x", "y", "z")):
        return None
    return [found["x"], found["y"], found["z"], found.get("w", found.get("heading", 0.0))]


def _find_table_vectors(text: str, source: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    # Common resource configs: Config.DefaultSpawn = { x=..., y=..., z=... }
    # Server state dumps: last_location = {"x":...,"y":...,"z":...}
    table_patterns = [
        (r"Config\s*\.\s*DefaultSpawn\s*=\s*\{([^{}]{1,800})\}", "default_spawn"),
        (r"Config\s*\.\s*PedCoords\s*=\s*\{([^{}]{1,800})\}", "character_preview_ped"),
        (r"Config\s*\.\s*CamCoords\s*=\s*\{([^{}]{1,800})\}", "character_preview_camera"),
        (r"Config\s*\.\s*HiddenCoords\s*=\s*\{([^{}]{1,800})\}", "hidden_coords"),
        (r"(?:last[_-]?location|lastLocation)\s*=\s*\{([^{}]{1,800})\}", "last_location"),
        (r"(?:position|coords)\s*=\s*\{([^{}]{1,800})\}", "coords"),
    ]
    for pat, label in table_patterns:
        for m in re.finditer(pat, text, re.IGNORECASE | re.MULTILINE):
            vals = _extract_mapping_vector(m.group(1))
            obj = vector_obj(vals or [], label=label, source=source)
            if obj:
                out.append(obj)

    # Embedded JSON strings inside SQL rows or metadata columns.
    for m in re.finditer(r"\{[^{}]{1,800}['\"]x['\"]\s*:[^{}]{1,800}\}", text or "", re.IGNORECASE):
        vals = _extract_mapping_vector(m.group(0))
        obj = vector_obj(vals or [], label="embedded_position", source=source)
        if obj:
            out.append(obj)
    return out


def find_vectors_in_lua(text: str, source: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []

    assignment_patterns = [
        (r"Config\s*\.\s*DefaultSpawn\s*=\s*vector[34]\s*\(([^)]*)\)", "default_spawn"),
        (r"Config\s*\.\s*PedCoords\s*=\s*vector[34]\s*\(([^)]*)\)", "character_preview_ped"),
        (r"Config\s*\.\s*CamCoords\s*=\s*vector[34]\s*\(([^)]*)\)", "character_preview_camera"),
        (r"Config\s*\.\s*HiddenCoords\s*=\s*vector[34]\s*\(([^)]*)\)", "hidden_coords"),
    ]
    for pat, label in assignment_patterns:
        for m in re.finditer(pat, text, re.IGNORECASE | re.MULTILINE):
            vals = parse_vector_args(m.group(1))
            obj = vector_obj(vals or [], label=label, source=source)
            if obj:
                out.append(obj)

    # Spawn selector / apartments / housing configs usually store `coords = vector4(...)`.
    interesting = re.search(r"spawn|apartment|house|housing|multicharacter", source, re.IGNORECASE) is not None
    if interesting:
        for m in re.finditer(r"([A-Za-z0-9_\"'\-\[\]\.]+)?\s*coords\s*=\s*vector[34]\s*\(([^)]*)\)", text, re.IGNORECASE):
            vals = parse_vector_args(m.group(2))
            label_raw = str(m.group(1) or "").strip().strip('"').strip("'").strip("[]").strip(".")
            label = label_raw or "spawn_coords"
            obj = vector_obj(vals or [], label=label, source=source)
            if obj:
                out.append(obj)

    out.extend(_find_table_vectors(text, source))
    return out


def walk_json_vectors(value: Any, source: str, path: str = "") -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if isinstance(value, dict):
        keys = {str(k).lower() for k in value.keys()}
        if {"x", "y", "z"}.issubset(keys):
            lower = {str(k).lower(): v for k, v in value.items()}
            obj = vector_obj(
                [lower.get("x"), lower.get("y"), lower.get("z"), lower.get("w", lower.get("heading", 0.0))],
                label=path or "json_coords",
                source=source,
            )
            if obj:
                out.append(obj)
        for k, v in value.items():
            out.extend(walk_json_vectors(v, source, f"{path}.{k}" if path else str(k)))
    elif isinstance(value, list):
        if len(value) >= 3 and all(isinstance(x, (int, float)) for x in value[:3]):
            obj = vector_obj(value[:4], label=path or "json_vector", source=source)
            if obj:
                out.append(obj)
        for i, v in enumerate(value):
            out.extend(walk_json_vectors(v, source, f"{path}[{i}]"))
    return out


def dedupe_vectors(vectors: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[int, int, int, int, str]] = set()
    out: list[dict[str, Any]] = []
    for v in vectors:
        key = (
            round(float(v.get("x", 0)) * 100),
            round(float(v.get("y", 0)) * 100),
            round(float(v.get("z", 0)) * 100),
            round(float(v.get("w", 0)) * 100),
            str(v.get("label", "")),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(v)
    return out


def resource_roots_from_env(env: dict[str, str], explicit: list[str]) -> list[Path]:
    roots: list[Path] = []
    for raw in explicit:
        if raw:
            roots.append(Path(raw).expanduser())
    for k in ("GTA_SPAWN_RESOURCES", "FIVEM_RESOURCES", "RESOURCES_ROOT", "NX_RESOURCES"):
        raw = env.get(k) or ""
        if raw:
            roots.append(Path(raw).expanduser())
    for p in (REPO_ROOT / "resources", REPO_ROOT / "outdated_resources"):
        roots.append(p)

    out: list[Path] = []
    seen: set[str] = set()
    for p in roots:
        try:
            rp = p.resolve()
        except Exception:
            rp = p
        s = str(rp).lower()
        if s in seen:
            continue
        seen.add(s)
        if rp.exists() and rp.is_dir():
            out.append(rp)
    return out


def scan_resource_spawns(roots: list[Path], limit_files: int = 1200) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    vectors: list[dict[str, Any]] = []
    scanned = 0
    roots_info: list[str] = []
    for root in roots:
        roots_info.append(str(root))
        for p in root.rglob("*"):
            if scanned >= limit_files:
                break
            if not p.is_file() or p.suffix.lower() not in {".lua", ".json", ".sql"}:
                continue
            rel = str(p.relative_to(root)).replace("\\", "/")
            if not re.search(r"spawn|apartment|house|housing|multicharacter|config|client|server|player|character", rel, re.IGNORECASE):
                continue
            scanned += 1
            try:
                txt = p.read_text(encoding="utf-8", errors="ignore")
            except Exception:
                continue
            source = f"{root.name}/{rel}"
            if p.suffix.lower() == ".lua":
                vectors.extend(find_vectors_in_lua(txt, source))
            elif p.suffix.lower() == ".json":
                try:
                    obj = json.loads(txt)
                except Exception:
                    obj = None
                if obj is not None:
                    vectors.extend(walk_json_vectors(obj, source))
                vectors.extend(_find_table_vectors(txt, source))
            else:
                vectors.extend(_find_table_vectors(txt, source))
    return dedupe_vectors(vectors), {"roots": roots_info, "filesScanned": scanned}


def game_paths_from_env(env: dict[str, str]) -> list[Path]:
    roots: list[Path] = []
    for k in ("GTA5_PATH", "GTA_PATH", "GAME_PATH", "gta5_path", "gta_location"):
        raw = env.get(k) or ""
        if raw:
            roots.append(Path(raw).expanduser())
    out: list[Path] = []
    seen: set[str] = set()
    for p in roots:
        try:
            rp = p.resolve()
        except Exception:
            rp = p
        s = str(rp).lower()
        if s in seen:
            continue
        seen.add(s)
        out.append(rp)
    return out


def load_cached_script_index(assets_dir: Path) -> dict[str, Any] | None:
    p = assets_dir / "runtime_script_index.json"
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    known = data.get("knownScripts") if isinstance(data.get("knownScripts"), list) else []
    return {
        "source": f"assets/{p.name}",
        "generatedAt": data.get("generatedAt"),
        "gamePath": data.get("gamePath"),
        "entryCount": data.get("entryCount"),
        "yscCount": data.get("yscCount"),
        "scriptArchiveCount": data.get("scriptArchiveCount"),
        "knownScripts": known[:40],
    }


def load_explicit_profile(assets_dir: Path) -> dict[str, Any] | None:
    for name in ("runtime_spawn.json", "spawns.json", "spawn_profile.json"):
        p = assets_dir / name
        if not p.exists():
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if isinstance(data, dict):
            data.setdefault("source", f"assets/{name}")
            return data
    return None


def default_save_dirs(env: dict[str, str], explicit: list[str]) -> list[Path]:
    roots: list[Path] = []
    for raw in explicit:
        if raw:
            roots.append(Path(raw).expanduser())
    for k in ("GTA_SAVE_DIR", "GTA_PROFILE_DIR", "ROCKSTAR_GTA5_PROFILE"):
        raw = env.get(k) or ""
        if raw:
            roots.append(Path(raw).expanduser())
    home = Path(os.environ.get("USERPROFILE") or os.environ.get("HOME") or "")
    if str(home):
        roots.extend([
            home / "Documents" / "Rockstar Games" / "GTA V" / "Profiles",
            home / "OneDrive" / "Documents" / "Rockstar Games" / "GTA V" / "Profiles",
        ])
    out: list[Path] = []
    seen: set[str] = set()
    for p in roots:
        try:
            rp = p.resolve()
        except Exception:
            rp = p
        s = str(rp).lower()
        if s in seen:
            continue
        seen.add(s)
        if rp.exists():
            out.append(rp)
    return out


def discover_save_files(save_roots: list[Path]) -> list[dict[str, Any]]:
    files: list[Path] = []
    for root in save_roots:
        if root.is_file():
            files.append(root)
            continue
        for pat in ("SGTA5*", "sgta5*", "*.bak"):
            files.extend([p for p in root.rglob(pat) if p.is_file()])
    uniq: dict[str, Path] = {}
    for p in files:
        uniq[str(p.resolve()).lower()] = p
    rows = []
    for p in uniq.values():
        try:
            st = p.stat()
        except Exception:
            continue
        rows.append({
            "path": str(p),
            "name": p.name,
            "size": st.st_size,
            "mtime": st.st_mtime,
            "mtimeIso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(st.st_mtime)),
        })
    rows.sort(key=lambda r: float(r.get("mtime", 0)), reverse=True)
    return rows


def scan_save_float_candidates(save_file: Path, max_bytes: int = 12_000_000) -> list[dict[str, Any]]:
    """
    Diagnostic-only heuristic. GTA save parsing is not implemented here; this scans little-endian
    float triples that look like GTA world coordinates. Use only to guide a real parser.
    """
    try:
        data = save_file.read_bytes()
    except Exception:
        return []
    if len(data) > max_bytes:
        data = data[:max_bytes]
    out: list[dict[str, Any]] = []
    for off in range(0, max(0, len(data) - 12), 4):
        try:
            x, y, z = struct.unpack_from("<fff", data, off)
        except Exception:
            continue
        if not (math.isfinite(x) and math.isfinite(y) and math.isfinite(z)):
            continue
        if not (-5000 <= x <= 9000 and -8000 <= y <= 9000 and -100 <= z <= 650):
            continue
        # Reject common false positives from matrices/tables and near-origin scalar data.
        if abs(x) < 50 or abs(y) < 50 or abs(z) < 0.75:
            continue
        if abs(x - y) < 1e-4:
            continue
        score = 1.0
        if -4000 <= x <= 5000 and -4500 <= y <= 6500:
            score += 1.0
        if 1.0 <= z <= 250.0:
            score += 1.0
        out.append({"offset": off, "x": x, "y": y, "z": z, "confidence": score})
    out.sort(key=lambda r: (-float(r.get("confidence", 0)), int(r.get("offset", 0))))
    return out[:100]


def heading_to_camera(ped: dict[str, Any], distance: float = 7.5, height: float = 2.2) -> dict[str, Any]:
    x = float(ped["x"])
    y = float(ped["y"])
    z = float(ped["z"])
    h = math.radians(float(ped.get("w", 0.0)))
    # GTA/FiveM heading convention: 0 faces +Y, 90 faces +X.
    fx = math.sin(h)
    fy = math.cos(h)
    return {
        "x": x - fx * distance,
        "y": y - fy * distance,
        "z": z + height,
        "w": float(ped.get("w", 0.0)),
        "label": "computed_follow_camera",
        "source": ped.get("source", ""),
    }


def coerce_spawn_profile(profile: dict[str, Any]) -> dict[str, Any] | None:
    spawn = profile.get("spawn") if isinstance(profile.get("spawn"), dict) else profile
    ped0 = spawn.get("ped") or spawn.get("coords") or spawn.get("position") or spawn.get("defaultSpawn")
    cam0 = spawn.get("cam") or spawn.get("camera") or spawn.get("camCoords")
    hidden0 = spawn.get("hidden") or profile.get("hidden")
    if isinstance(ped0, list):
        ped = vector_obj(ped0, label="explicit_spawn", source=str(profile.get("source", "")))
    elif isinstance(ped0, dict):
        ped = vector_obj([ped0.get("x"), ped0.get("y"), ped0.get("z"), ped0.get("w", ped0.get("heading", 0))], label=str(ped0.get("label", "explicit_spawn")), source=str(ped0.get("source", profile.get("source", ""))))
    else:
        ped = None
    if not ped:
        return None
    if isinstance(cam0, list):
        cam = vector_obj(cam0, label="explicit_camera", source=str(profile.get("source", "")))
    elif isinstance(cam0, dict):
        cam = vector_obj([cam0.get("x"), cam0.get("y"), cam0.get("z"), cam0.get("w", cam0.get("heading", 0))], label=str(cam0.get("label", "explicit_camera")), source=str(cam0.get("source", profile.get("source", ""))))
    else:
        cam = heading_to_camera(ped)
    if isinstance(hidden0, list):
        hidden = vector_obj(hidden0, label="explicit_hidden", source=str(profile.get("source", "")))
    elif isinstance(hidden0, dict):
        hidden = vector_obj([hidden0.get("x"), hidden0.get("y"), hidden0.get("z"), hidden0.get("w", hidden0.get("heading", 0))], label=str(hidden0.get("label", "explicit_hidden")), source=str(hidden0.get("source", profile.get("source", ""))))
    else:
        hidden = None
    return {
        "source": str(profile.get("source", "explicit_profile")),
        "kind": str(profile.get("kind") or spawn.get("kind") or "explicit_profile"),
        "ped": ped,
        "cam": cam,
        "hidden": hidden,
        "candidates": profile.get("candidates", []),
    }


def select_resource_spawn(vectors: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not vectors:
        return None
    priority = [
        "last_location",
        "default_spawn",
        "spawn_coords",
        "coords",
        "character_preview_ped",
    ]
    chosen = None
    for label in priority:
        chosen = next((v for v in vectors if label in str(v.get("label", "")).lower()), None)
        if chosen:
            break
    if not chosen:
        chosen = vectors[0]
    cam = next((v for v in vectors if "camera" in str(v.get("label", "")).lower() or "camcoords" in str(v.get("label", "")).lower()), None)
    if not cam:
        cam = heading_to_camera(chosen)
    hidden = next((v for v in vectors if "hidden" in str(v.get("label", "")).lower()), None)
    return {
        "source": str(chosen.get("source", "resource_config")),
        "kind": "resource_config",
        "ped": chosen,
        "cam": cam,
        "hidden": hidden,
        "candidates": vectors[:200],
    }


def fallback_spawn(assets_dir: Path) -> dict[str, Any]:
    # This is explicitly a fallback, not claimed to be GTA-accurate runtime logic.
    ped = {
        "x": 195.0,
        "y": -933.0,
        "z": 32.0,
        "w": 0.0,
        "label": "viewer_fallback_legion_square",
        "source": "fallback",
    }
    return {
        "source": "fallback",
        "kind": "viewer_fallback",
        "ped": ped,
        "cam": heading_to_camera(ped),
        "candidates": [],
    }


def build_spawn_response(args: argparse.Namespace) -> dict[str, Any]:
    env = {**read_dotenv(REPO_ROOT / ".env"), **os.environ}
    assets_dir = Path(args.assets_dir).resolve() if args.assets_dir else (REPO_ROOT / "webgl_viewer" / "assets")
    game_paths = game_paths_from_env(env)
    cached_script_index = load_cached_script_index(assets_dir)
    diagnostics: dict[str, Any] = {
        "assetsDir": str(assets_dir),
        "gameInstall": {
            "paths": [{"path": str(p), "exists": p.exists(), "isDir": p.is_dir()} for p in game_paths],
        },
        "scriptRuntime": {
            "implemented": False,
            "reason": "RPF/YSC files can be indexed, but this checkout does not include a YSC VM/decompiler. Resolver is ready for a script parser source.",
            "cachedIndex": cached_script_index,
        },
    }

    explicit = load_explicit_profile(assets_dir)
    if explicit:
        resolved = coerce_spawn_profile(explicit)
        if resolved:
            diagnostics["explicitProfile"] = str(explicit.get("source", "assets"))
            return {"ok": True, "spawn": resolved, "diagnostics": diagnostics}

    roots = resource_roots_from_env(env, args.resources_root or [])
    vectors, res_diag = scan_resource_spawns(roots)
    diagnostics["resources"] = res_diag
    if vectors:
        return {"ok": True, "spawn": select_resource_spawn(vectors), "diagnostics": diagnostics}

    save_roots = default_save_dirs(env, args.save_dir or [])
    saves = discover_save_files(save_roots)
    diagnostics["saves"] = {
        "roots": [str(p) for p in save_roots],
        "files": saves[:20],
        "parser": "not-authoritative",
    }
    if args.allow_save_heuristic and saves:
        p = Path(str(saves[0]["path"]))
        candidates = scan_save_float_candidates(p)
        diagnostics["saves"]["floatCandidates"] = candidates[:20]
        diagnostics["saves"]["floatHeuristic"] = {
            "usedForSpawn": False,
            "reason": "Float triples are diagnostic only; SGTA5 last-location parsing must be implemented before save data can drive spawn placement.",
        }

    diagnostics["fallbackReason"] = "No explicit spawn profile, runtime resource config, or authoritative save parser output was available."
    return {"ok": True, "spawn": fallback_spawn(assets_dir), "diagnostics": diagnostics}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--assets-dir", default="")
    ap.add_argument("--resources-root", action="append", default=[])
    ap.add_argument("--save-dir", action="append", default=[])
    ap.add_argument("--allow-save-heuristic", action="store_true")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()
    data = build_spawn_response(args)
    print(json.dumps(data, indent=2 if args.pretty else None))


if __name__ == "__main__":
    main()

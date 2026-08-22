#!/usr/bin/env python
"""
Build a browser-safe gameplay manifest from a FiveM/NX server.

The importer is intentionally read-only against the remote host:
- reads server.cfg and selected resource config files over SSH
- reads MySQL schema metadata, not secret data, when configured
- writes webgl_viewer/assets/runtime_gameplay_manifest.json

The manifest is a contract for the browser-native gameplay layer. It is not a
Lua runtime and it does not make the browser a FiveM protocol client.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shlex
import time
from pathlib import Path
from typing import Any, Iterable

from import_remote_fivem_spawn import (
    DEFAULT_REMOTE_HOST,
    DEFAULT_REMOTE_ROOT,
    fetch_latest_db_appearance,
    fetch_latest_db_position,
    parse_ensured_resources,
    parse_mysql_columns,
    parse_mysql_connection,
    parse_mysql_rows,
    remote_cat,
    run_ssh,
    sql_ident,
    mysql_query,
)
from resolve_gta_spawn import REPO_ROOT, find_vectors_in_lua, vector_obj, parse_vector_args


MANIFEST_VERSION = 1
MAX_STRING = 120

RESOURCE_KEYWORDS = (
    "nx-", "qb-", "qbx-", "ox_", "illenium",
    "spawn", "multi", "vehicle", "garage", "shop", "inventory", "item",
    "job", "target", "apartment", "housing", "house", "doorlock", "bank",
    "cityhall", "police", "ambulance", "craft", "drug", "gang", "fuel",
    "territor", "stash", "society", "management",
)

DB_TABLE_KEYWORDS = (
    "player", "skin", "appearance", "vehicle", "garage", "inventory", "item",
    "job", "gang", "house", "apartment", "stash", "trunk", "glovebox",
    "bank", "society", "property", "door", "shop",
)


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def clean_str(value: Any, max_len: int = MAX_STRING) -> str:
    s = str(value or "").strip()
    s = re.sub(r"\s+", " ", s)
    if len(s) > max_len:
        s = s[: max_len - 1] + "..."
    return s


def as_number(value: Any, default: float | None = None) -> float | None:
    try:
        n = float(value)
        if math.isfinite(n):
            return n
    except Exception:
        pass
    return default


def compact_source(source: str, host: str, root: str) -> str:
    prefix = f"ssh://{host}{root.rstrip('/')}/"
    if source.startswith(prefix):
        return source[len(prefix):]
    return source


def source_for(host: str, root: str, path: str) -> str:
    rel = str(path).replace("\\", "/")
    return f"ssh://{host}{rel}"


def lua_unquote(value: str | None) -> str:
    if not value:
        return ""
    s = value.strip()
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        s = s[1:-1]
    return s.strip()


def parse_lua_string_prop(body: str, keys: Iterable[str]) -> str:
    for key in keys:
        m = re.search(
            rf"\b{re.escape(key)}\b\s*=\s*([\"'])(.*?)\1",
            body or "",
            re.IGNORECASE | re.DOTALL,
        )
        if m:
            return clean_str(m.group(2))
    return ""


def parse_lua_number_prop(body: str, keys: Iterable[str]) -> float | None:
    for key in keys:
        m = re.search(
            rf"\b{re.escape(key)}\b\s*=\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)",
            body or "",
            re.IGNORECASE,
        )
        if m:
            return as_number(m.group(1))
    return None


def parse_lua_bool_prop(body: str, keys: Iterable[str]) -> bool | None:
    for key in keys:
        m = re.search(rf"\b{re.escape(key)}\b\s*=\s*(true|false)\b", body or "", re.IGNORECASE)
        if m:
            return m.group(1).lower() == "true"
    return None


def iter_lua_blocks(text: str, min_body: int = 8, max_body: int = 5000) -> Iterable[tuple[str, str]]:
    """
    Shallow table-block scanner for common FiveM config shapes.

    This intentionally avoids executing Lua. It captures enough of the common
    keyed table style to extract labels, coords, prices, and models.
    """
    src = text or ""
    pat = re.compile(
        r"(?:\[\s*([\"']?)([A-Za-z0-9_@./:-]+)\1\s*\]|([A-Za-z_][A-Za-z0-9_@./:-]*))\s*=\s*\{",
        re.IGNORECASE,
    )
    for m in pat.finditer(src):
        key = m.group(2) or m.group(3) or ""
        start = m.end()
        depth = 1
        i = start
        in_str: str | None = None
        esc = False
        while i < len(src):
            ch = src[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == in_str:
                    in_str = None
            else:
                if ch in ("'", '"'):
                    in_str = ch
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth <= 0:
                        body = src[start:i]
                        if min_body <= len(body) <= max_body:
                            yield clean_str(key, 80), body
                        break
            i += 1


def parse_all_vectors(text: str, source: str) -> list[dict[str, Any]]:
    out = list(find_vectors_in_lua(text, source))
    for m in re.finditer(r"vector[34]\s*\(([^)]*)\)", text or "", re.IGNORECASE):
        vals = parse_vector_args(m.group(1))
        if not vals:
            continue
        before = (text or "")[max(0, m.start() - 220):m.start()]
        after = (text or "")[m.end():m.end() + 220]
        label = ""
        lm = re.search(r"([A-Za-z0-9_.'\"\[\]-]+)\s*(?:=|:)\s*$", before)
        if lm:
            label = lua_unquote(lm.group(1).strip("[]"))
        if not label:
            for key in ("label", "name", "title", "header", "job", "type"):
                sm = re.search(rf"\b{key}\b\s*=\s*([\"'])(.*?)\1", before + after, re.IGNORECASE | re.DOTALL)
                if sm:
                    label = sm.group(2)
                    break
        obj = vector_obj(vals, label=clean_str(label or "coords", 100), source=source)
        if obj:
            obj["_context"] = clean_str((before + after).replace("\n", " "), 280)
            out.append(obj)
    return dedupe_records(out, keys=("x", "y", "z", "w", "label", "source"))


def classify_path(path: str, context: str = "") -> str:
    p = f"{path} {context}".lower()
    if "vehicleshop" in p or "vehicle_shop" in p or ("vehicle" in p and "shop" in p):
        return "vehicle_shop"
    if "garage" in p or "parking" in p:
        return "garage"
    if "apartment" in p:
        return "apartment"
    if "housing" in p or "/house" in p or "\\house" in p or "realestate" in p:
        return "housing"
    if "shop" in p or "store" in p or "market" in p:
        return "shop"
    if "spawn" in p or "multicharacter" in p:
        return "spawn"
    if "target" in p or "interact" in p or "cityhall" in p or "bank" in p or "police" in p or "ambulance" in p:
        return "interaction"
    if "door" in p:
        return "door"
    return "point"


def vector_entry(v: dict[str, Any], path: str, host: str, root: str) -> dict[str, Any]:
    ctx = clean_str(v.get("_context", ""), 280)
    category = classify_path(path, ctx)
    label = clean_str(v.get("label") or category, 100)
    return {
        "id": stable_id(category, path, label, v.get("x"), v.get("y"), v.get("z")),
        "type": category,
        "label": label,
        "coords": {
            "x": v.get("x"),
            "y": v.get("y"),
            "z": v.get("z"),
            "w": v.get("w", 0.0),
        },
        "radius": default_radius_for(category),
        "source": compact_source(str(v.get("source") or source_for(host, root, path)), host, root),
    }


def default_radius_for(category: str) -> float:
    return {
        "spawn": 2.5,
        "garage": 6.0,
        "vehicle_shop": 8.0,
        "shop": 3.0,
        "apartment": 4.0,
        "housing": 4.0,
        "door": 1.4,
    }.get(category, 2.5)


def stable_id(*parts: Any) -> str:
    raw = "|".join(clean_str(p, 120).lower() for p in parts)
    h = 2166136261
    for ch in raw:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    prefix = re.sub(r"[^a-z0-9]+", "_", clean_str(parts[0] if parts else "item", 24).lower()).strip("_") or "item"
    return f"{prefix}_{h:08x}"


def dedupe_records(records: Iterable[dict[str, Any]], keys: tuple[str, ...]) -> list[dict[str, Any]]:
    seen: set[tuple[Any, ...]] = set()
    out: list[dict[str, Any]] = []
    for rec in records:
        key = []
        for k in keys:
            v = rec.get(k)
            if isinstance(v, float):
                v = round(v, 3)
            key.append(v)
        t = tuple(key)
        if t in seen:
            continue
        seen.add(t)
        out.append(rec)
    return out


def extract_items(text: str, source: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not re.search(r"item|inventory|shared", source, re.IGNORECASE):
        return out
    for key, body in iter_lua_blocks(text):
        label = parse_lua_string_prop(body, ("label", "name", "title"))
        weight = parse_lua_number_prop(body, ("weight",))
        item_type = parse_lua_string_prop(body, ("type",))
        image = parse_lua_string_prop(body, ("image",))
        unique = parse_lua_bool_prop(body, ("unique",))
        useable = parse_lua_bool_prop(body, ("useable", "usable", "shouldClose"))
        if not (label or weight is not None or item_type or image):
            continue
        out.append({
            "id": clean_str(key, 80),
            "label": label or clean_str(key, 80),
            "type": item_type,
            "weight": weight,
            "image": image,
            "unique": unique,
            "useable": useable,
            "source": source,
        })
    return dedupe_records(out, keys=("id", "source"))


def extract_jobs(text: str, source: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not re.search(r"job|jobs|shared", source, re.IGNORECASE):
        return out
    for key, body in iter_lua_blocks(text):
        label = parse_lua_string_prop(body, ("label", "name"))
        default_duty = parse_lua_bool_prop(body, ("defaultDuty", "defaultduty"))
        if not label and "grades" not in body.lower():
            continue
        out.append({
            "id": clean_str(key, 80),
            "label": label or clean_str(key, 80),
            "defaultDuty": default_duty,
            "gradeCount": len(re.findall(r"\[\s*[\"']?\d+[\"']?\s*\]\s*=", body)),
            "source": source,
        })
    return dedupe_records(out, keys=("id", "source"))


def extract_vehicles(text: str, source: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not re.search(r"vehicle|car|garage", source, re.IGNORECASE):
        return out
    for key, body in iter_lua_blocks(text):
        model = parse_lua_string_prop(body, ("model", "spawncode", "vehicle"))
        name = parse_lua_string_prop(body, ("name", "label", "title"))
        brand = parse_lua_string_prop(body, ("brand", "make"))
        category = parse_lua_string_prop(body, ("category", "type", "class"))
        price = parse_lua_number_prop(body, ("price", "cost"))
        if not (model or price is not None or brand or category):
            continue
        out.append({
            "id": clean_str(model or key, 80),
            "model": clean_str(model or key, 80),
            "name": name or clean_str(model or key, 80),
            "brand": brand,
            "category": category,
            "price": price,
            "source": source,
        })
    return dedupe_records(out, keys=("model", "source"))


def extract_products(text: str, source: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not re.search(r"shop|store|inventory|item|product", source, re.IGNORECASE):
        return out
    for key, body in iter_lua_blocks(text):
        item = parse_lua_string_prop(body, ("name", "item", "id"))
        label = parse_lua_string_prop(body, ("label", "title"))
        price = parse_lua_number_prop(body, ("price", "cost"))
        amount = parse_lua_number_prop(body, ("amount", "count", "stock"))
        if not (item and (price is not None or "products" in source.lower())):
            continue
        out.append({
            "id": clean_str(item or key, 80),
            "label": label or clean_str(item or key, 80),
            "price": price,
            "amount": amount,
            "source": source,
        })
    return dedupe_records(out, keys=("id", "price", "source"))


def remote_resource_files(host: str, root: str, max_files: int) -> list[str]:
    resources_root = f"{root.rstrip('/')}/resources"
    qroot = shlex.quote(resources_root)
    cmd = (
        f"find {qroot} -maxdepth 5 -type f "
        "\\( -iname '*.lua' -o -iname '*.json' -o -iname '*.cfg' \\) "
        "-size -700k | sort"
    )
    raw = run_ssh(host, cmd, timeout=30)
    files = [line.strip() for line in raw.splitlines() if line.strip()]
    filtered = []
    for path in files:
        low = path.lower()
        if any(k in low for k in RESOURCE_KEYWORDS):
            filtered.append(path)
        if len(filtered) >= max_files:
            break
    return filtered


def build_db_schema(host: str, mysql_cfg: dict[str, Any] | None, max_tables: int = 80) -> dict[str, Any]:
    out: dict[str, Any] = {
        "configured": bool(mysql_cfg and mysql_cfg.get("configured")),
        "queried": False,
        "tables": {},
    }
    if not mysql_cfg or not mysql_cfg.get("configured"):
        return out
    raw = mysql_query(host, mysql_cfg, "SHOW TABLES;", timeout=20)
    out["queried"] = True
    tables = [row[0] for row in parse_mysql_rows(raw) if row]
    candidates = [t for t in tables if any(k in t.lower() for k in DB_TABLE_KEYWORDS)]
    for table in candidates[:max_tables]:
        try:
            cols = parse_mysql_columns(mysql_query(host, mysql_cfg, f"SHOW COLUMNS FROM {sql_ident(table)};", timeout=20))
            out["tables"][table] = {"columns": cols}
        except Exception as e:
            out["tables"][table] = {"error": str(e)}
    out["candidateCount"] = len(candidates)
    return out


def build_manifest_from_remote(
    host: str,
    root: str,
    *,
    query_db: bool = True,
    max_files: int = 180,
) -> dict[str, Any]:
    root = root.rstrip("/")
    source_base = f"ssh://{host}{root}"
    server_cfg = remote_cat(host, f"{root}/server.cfg")
    mysql_cfg = parse_mysql_connection(server_cfg)

    db_position = None
    db_position_diag: dict[str, Any] = {}
    db_appearance = None
    db_appearance_diag: dict[str, Any] = {}
    db_citizenid = None
    db_schema: dict[str, Any] = {"configured": bool(mysql_cfg and mysql_cfg.get("configured")), "queried": False, "tables": {}}
    if query_db:
        db_position, db_position_diag = fetch_latest_db_position(host, mysql_cfg)
        if db_position:
            db_citizenid = db_position.pop("_citizenid_raw", None)
        db_appearance, db_appearance_diag = fetch_latest_db_appearance(host, mysql_cfg, db_citizenid)
        db_schema = build_db_schema(host, mysql_cfg)

    files = remote_resource_files(host, root, max_files=max_files)
    started = parse_ensured_resources(server_cfg)
    vectors: list[dict[str, Any]] = []
    items: list[dict[str, Any]] = []
    jobs: list[dict[str, Any]] = []
    vehicles: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    scanned_files: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []

    for path in files:
        source = source_for(host, root, path)
        rel_source = compact_source(source, host, root)
        try:
            text = remote_cat(host, path)
            scanned_files.append({"path": rel_source, "bytes": len(text.encode("utf-8", errors="ignore"))})
        except Exception as e:
            errors.append({"path": path, "error": str(e)})
            continue

        for v in parse_all_vectors(text, source):
            vectors.append(vector_entry(v, path, host, root))
        items.extend({**x, "source": compact_source(x["source"], host, root)} for x in extract_items(text, rel_source))
        jobs.extend({**x, "source": compact_source(x["source"], host, root)} for x in extract_jobs(text, rel_source))
        vehicles.extend({**x, "source": compact_source(x["source"], host, root)} for x in extract_vehicles(text, rel_source))
        products.extend({**x, "source": compact_source(x["source"], host, root)} for x in extract_products(text, rel_source))

    vectors = dedupe_vector_entries(vectors)
    by_type: dict[str, list[dict[str, Any]]] = {}
    for entry in vectors:
        by_type.setdefault(str(entry.get("type") or "point"), []).append(entry)

    spawn_candidates = []
    for entry in by_type.get("spawn", []):
        spawn_candidates.append({
            "x": entry["coords"].get("x"),
            "y": entry["coords"].get("y"),
            "z": entry["coords"].get("z"),
            "w": entry["coords"].get("w", 0.0),
            "label": entry.get("label") or "spawn",
            "source": entry.get("source") or "",
        })
    if db_position:
        spawn_current = db_position
        spawn_kind = "server_database_last_location"
    elif spawn_candidates:
        spawn_current = spawn_candidates[0]
        spawn_kind = "server_resource_spawn"
    else:
        spawn_current = None
        spawn_kind = "unknown"

    manifest = {
        "ok": True,
        "version": MANIFEST_VERSION,
        "mode": "remote",
        "generatedAt": now_iso(),
        "source": {"host": host, "serverRoot": root, "base": source_base},
        "server": {
            "startedResources": started,
            "mysql": {
                "configured": bool(mysql_cfg and mysql_cfg.get("configured")),
                "host": mysql_cfg.get("host") if mysql_cfg else None,
                "database": mysql_cfg.get("database") if mysql_cfg else None,
            },
        },
        "db": db_schema,
        "spawn": {
            "kind": spawn_kind,
            "current": spawn_current,
            "candidates": spawn_candidates[:120],
        },
        "character": db_appearance,
        "jobs": dedupe_records(jobs, keys=("id", "source"))[:500],
        "inventory": {
            "items": dedupe_records(items, keys=("id", "source"))[:1200],
            "products": dedupe_records(products, keys=("id", "price", "source"))[:1200],
        },
        "shops": by_type.get("shop", [])[:300],
        "garages": by_type.get("garage", [])[:300],
        "vehicleShops": by_type.get("vehicle_shop", [])[:120],
        "vehicles": dedupe_records(vehicles, keys=("model", "source"))[:1200],
        "apartments": by_type.get("apartment", [])[:200],
        "housing": by_type.get("housing", [])[:400],
        "interactions": build_interactions(by_type),
        "collision": {
            "mode": "browser_heightfield_plus_manifest_blockers",
            "blockers": build_blockers(by_type),
        },
        "resources": {
            "scannedFileCount": len(scanned_files),
            "selectedFileCount": len(files),
            "files": scanned_files[:300],
        },
        "diagnostics": {
            "dbPosition": db_position_diag,
            "dbAppearance": db_appearance_diag,
            "errors": errors[:80],
        },
    }
    return manifest


def dedupe_vector_entries(entries: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[Any, ...]] = set()
    out: list[dict[str, Any]] = []
    for e in entries:
        c = e.get("coords") or {}
        key = (
            e.get("type"),
            round(float(c.get("x") or 0.0), 2),
            round(float(c.get("y") or 0.0), 2),
            round(float(c.get("z") or 0.0), 2),
            e.get("label"),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(e)
    return out


def build_interactions(by_type: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for kind in ("shop", "garage", "vehicle_shop", "apartment", "housing", "interaction", "door"):
        for entry in by_type.get(kind, []):
            out.append({
                **entry,
                "action": action_for_type(kind),
            })
    return out[:800]


def action_for_type(kind: str) -> str:
    return {
        "shop": "open_shop",
        "garage": "open_garage",
        "vehicle_shop": "open_vehicle_shop",
        "apartment": "enter_apartment",
        "housing": "enter_property",
        "door": "use_door",
    }.get(kind, "interact")


def build_blockers(by_type: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    blockers = []
    for entry in by_type.get("door", [])[:120]:
        c = entry.get("coords") or {}
        blockers.append({
            "id": entry.get("id"),
            "type": "circle",
            "label": entry.get("label") or "door",
            "x": c.get("x"),
            "y": c.get("y"),
            "z": c.get("z"),
            "radius": 0.85,
            "height": 2.2,
            "source": entry.get("source"),
        })
    return blockers


def build_manifest_from_runtime_dump(assets_dir: Path, *, host: str, root: str, reason: str) -> dict[str, Any]:
    dump = read_json(assets_dir / "runtime_resource_dump.json") or {}
    spawn = read_json(assets_dir / "runtime_spawn.json") or {}
    character = read_json(assets_dir / "runtime_character.json")
    parsed = dump.get("parsed") if isinstance(dump.get("parsed"), dict) else {}
    spawn_candidates = []
    for v in [
        parsed.get("defaultSpawn"),
        parsed.get("previewPed"),
        parsed.get("previewCamera"),
        parsed.get("hiddenCoords"),
        *(parsed.get("spawnSelector") if isinstance(parsed.get("spawnSelector"), list) else []),
    ]:
        if isinstance(v, dict):
            spawn_candidates.append(v)

    interactions = []
    for v in parsed.get("spawnSelector", []) if isinstance(parsed.get("spawnSelector"), list) else []:
        if not isinstance(v, dict):
            continue
        interactions.append({
            "id": stable_id("spawn", v.get("label"), v.get("x"), v.get("y"), v.get("z")),
            "type": "spawn",
            "action": "set_spawn",
            "label": clean_str(v.get("label") or "spawn", 100),
            "coords": {"x": v.get("x"), "y": v.get("y"), "z": v.get("z"), "w": v.get("w", 0.0)},
            "radius": 3.0,
            "source": v.get("source") or "",
        })

    db_tables = {}
    db_diag = dump.get("database") if isinstance(dump.get("database"), dict) else {}
    if isinstance(db_diag.get("columns"), list):
        db_tables["players"] = {"columns": db_diag.get("columns")}

    return {
        "ok": True,
        "version": MANIFEST_VERSION,
        "mode": "cache_fallback",
        "generatedAt": now_iso(),
        "source": {"host": host, "serverRoot": root, "base": f"ssh://{host}{root}"},
        "server": dump.get("server") or {"startedResources": [], "mysql": {"configured": False}},
        "db": {
            "configured": bool(db_diag.get("configured")),
            "queried": bool(db_diag.get("queried")),
            "tables": db_tables,
        },
        "spawn": {
            "kind": spawn.get("kind") or "cached_spawn",
            "current": (spawn.get("spawn") or {}).get("ped") if isinstance(spawn.get("spawn"), dict) else None,
            "candidates": spawn_candidates,
        },
        "character": character,
        "jobs": [],
        "inventory": {"items": [], "products": []},
        "shops": [],
        "garages": [],
        "vehicleShops": [],
        "vehicles": [],
        "apartments": [],
        "housing": [],
        "interactions": interactions,
        "collision": {"mode": "browser_heightfield", "blockers": []},
        "resources": {"scannedFileCount": 0, "selectedFileCount": 0, "files": []},
        "diagnostics": {
            "fallbackReason": reason,
            "runtimeDumpGeneratedAt": dump.get("generatedAt"),
        },
    }


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def write_manifest(manifest: dict[str, Any], assets_dir: Path, pretty: bool) -> Path:
    assets_dir.mkdir(parents=True, exist_ok=True)
    path = assets_dir / "runtime_gameplay_manifest.json"
    path.write_text(json.dumps(manifest, indent=2 if pretty else None), encoding="utf-8")
    return path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=DEFAULT_REMOTE_HOST)
    ap.add_argument("--server-root", default=DEFAULT_REMOTE_ROOT)
    ap.add_argument("--assets-dir", default=str(REPO_ROOT / "webgl_viewer" / "assets"))
    ap.add_argument("--max-files", type=int, default=180)
    ap.add_argument("--no-db", action="store_true")
    ap.add_argument("--no-cache-on-fail", action="store_true")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    assets_dir = Path(args.assets_dir).resolve()
    remote_error = None
    try:
        manifest = build_manifest_from_remote(
            args.host,
            args.server_root,
            query_db=not args.no_db,
            max_files=max(1, min(1000, int(args.max_files or 180))),
        )
    except Exception as e:
        remote_error = str(e)
        if args.no_cache_on_fail:
            raise
        manifest = build_manifest_from_runtime_dump(
            assets_dir,
            host=args.host,
            root=args.server_root.rstrip("/"),
            reason=remote_error,
        )

    path = write_manifest(manifest, assets_dir, args.pretty)
    print(json.dumps({
        "ok": True,
        "mode": manifest.get("mode"),
        "remoteError": remote_error,
        "manifest": str(path),
        "counts": {
            "jobs": len(manifest.get("jobs") or []),
            "items": len((manifest.get("inventory") or {}).get("items") or []),
            "shops": len(manifest.get("shops") or []),
            "garages": len(manifest.get("garages") or []),
            "vehicleShops": len(manifest.get("vehicleShops") or []),
            "vehicles": len(manifest.get("vehicles") or []),
            "interactions": len(manifest.get("interactions") or []),
            "dbTables": len((manifest.get("db") or {}).get("tables") or {}),
            "resourcesScanned": (manifest.get("resources") or {}).get("scannedFileCount", 0),
        },
    }))


if __name__ == "__main__":
    main()

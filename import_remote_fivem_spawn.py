#!/usr/bin/env python
"""
Import an explicit WebGL viewer spawn profile from a remote FiveM/NX server.

The importer is intentionally read-only against the remote host:
- reads server.cfg and NX spawn/multicharacter configs over SSH
- optionally queries the configured MySQL database for the latest persisted
  players.position
- writes local browser assets/runtime_spawn.json and a compact diagnostic dump

It does not start FXServer or a FiveM client.
"""

from __future__ import annotations

import argparse
import json
import re
import shlex
import subprocess
import time
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from resolve_gta_spawn import (
    REPO_ROOT,
    find_vectors_in_lua,
    heading_to_camera,
    parse_vector_args,
    vector_obj,
)


DEFAULT_REMOTE_ROOT = "/data/NexusAI/fivem_server"
DEFAULT_REMOTE_HOST = "peyton@192.168.0.85"
DEFAULT_RENDER_FALLBACK_MODEL = "a_m_y_skater_01"

FREEMODE_MODELS = {
    "mp_m_freemode_01": 1885233650,
    "mp_f_freemode_01": 2627665880,
}

COMPONENT_ASSET_PARTS = {
    0: ("head", "r"),
    1: ("berd", "u"),
    2: ("hair", "u"),
    3: ("uppr", "r"),
    4: ("lowr", "r"),
    5: ("hand", "u"),
    6: ("feet", "u"),
    7: ("teef", "u"),
    8: ("accs", "u"),
    9: ("task", "u"),
    10: ("decl", "u"),
    11: ("jbib", "u"),
}

SKINCHANGER_COMPONENT_KEYS = {
    "face": 0,
    "mask": 1,
    "beard": 1,
    "hair": 2,
    "arms": 3,
    "torso": 11,
    "top": 11,
    "tshirt": 8,
    "undershirt": 8,
    "pants": 4,
    "legs": 4,
    "bags": 5,
    "bag": 5,
    "shoes": 6,
    "accessory": 7,
    "chain": 7,
    "vest": 9,
    "decals": 10,
}

SKINCHANGER_PROP_KEYS = {
    "helmet": 0,
    "hat": 0,
    "glasses": 1,
    "ears": 2,
    "watches": 6,
    "bracelets": 7,
}


def run_ssh(host: str, remote_command: str, timeout: int = 20) -> str:
    proc = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, remote_command],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )
    if proc.returncode != 0:
        msg = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(msg or f"ssh command failed with exit code {proc.returncode}")
    return proc.stdout


def remote_cat(host: str, path: str) -> str:
    return run_ssh(host, f"cat {shlex.quote(path)}")


def parse_ensured_resources(server_cfg: str) -> list[str]:
    out: list[str] = []
    for raw in server_cfg.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^(?:ensure|start)\s+(.+?)\s*(?:#.*)?$", line, re.IGNORECASE)
        if not m:
            continue
        name = m.group(1).strip().strip('"').strip("'")
        if name:
            out.append(name)
    return out


def parse_mysql_connection(server_cfg: str) -> dict[str, Any] | None:
    m = re.search(r"""mysql_connection_string\s+["']([^"']+)["']""", server_cfg, re.IGNORECASE)
    if not m:
        return None
    raw = m.group(1).strip()
    parsed = urlparse(raw)
    if not parsed.scheme.startswith("mysql"):
        return None
    db = parsed.path.lstrip("/")
    return {
        "host": parsed.hostname or "localhost",
        "port": parsed.port or 3306,
        "user": unquote(parsed.username or ""),
        "password": unquote(parsed.password or ""),
        "database": db,
        "configured": bool(db and parsed.username),
    }


def parse_config_bool(text: str, key: str) -> bool | None:
    m = re.search(rf"\b{re.escape(key)}\s*=\s*(true|false)\b", text, re.IGNORECASE)
    if not m:
        return None
    return m.group(1).lower() == "true"


def first_by_label(vectors: list[dict[str, Any]], label: str) -> dict[str, Any] | None:
    needle = label.lower()
    return next((v for v in vectors if needle in str(v.get("label", "")).lower()), None)


def parse_spawn_selector_config(text: str, source: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    pat = re.compile(
        r"""(?P<key>[A-Za-z0-9_\-]+)\s*=\s*\{(?P<body>.*?coords\s*=\s*vec(?:tor)?[34]\s*\([^)]*\).*?)\}""",
        re.IGNORECASE | re.DOTALL,
    )
    for m in pat.finditer(text):
        body = m.group("body")
        vm = re.search(r"coords\s*=\s*vec(?:tor)?[34]\s*\(([^)]*)\)", body, re.IGNORECASE)
        vals = parse_vector_args(vm.group(1) if vm else "")
        label = m.group("key")
        lm = re.search(r"""label\s*=\s*["']([^"']+)["']""", body, re.IGNORECASE)
        if lm:
            label = f"{label}:{lm.group(1)}"
        obj = vector_obj(vals or [], label=f"spawn_selector:{label}", source=source)
        if obj:
            out.append(obj)
    return out


def mysql_query(host: str, mysql_cfg: dict[str, Any], query: str, timeout: int = 20) -> str:
    if not mysql_cfg or not mysql_cfg.get("configured"):
        raise RuntimeError("mysql is not configured")
    remote = (
        f"MYSQL_PWD={shlex.quote(str(mysql_cfg.get('password', '')))} "
        f"mysql -h {shlex.quote(str(mysql_cfg.get('host', 'localhost')))} "
        f"-P {int(mysql_cfg.get('port') or 3306)} "
        f"-u {shlex.quote(str(mysql_cfg.get('user', '')))} "
        f"{shlex.quote(str(mysql_cfg.get('database', '')))} "
        f"-N -B -e {shlex.quote(query)}"
    )
    return run_ssh(host, remote, timeout=timeout)


def sql_ident(name: str) -> str:
    s = str(name or "").strip()
    if not re.match(r"^[A-Za-z0-9_]+$", s):
        raise ValueError(f"Unsafe SQL identifier: {name!r}")
    return f"`{s}`"


def sql_string(value: str) -> str:
    s = str(value or "")
    s = s.replace("\\", "\\\\").replace("'", "''")
    return f"'{s}'"


def parse_mysql_rows(raw: str) -> list[list[str]]:
    rows: list[list[str]] = []
    for line in (raw or "").splitlines():
        if not line:
            continue
        rows.append(line.split("\t"))
    return rows


def parse_mysql_columns(raw: str) -> list[str]:
    cols: list[str] = []
    for line in raw.splitlines():
        parts = line.split("\t")
        if parts and parts[0]:
            cols.append(parts[0])
    return cols


def _redact_identifier(value: str) -> str:
    s = str(value or "")
    if not s:
        return ""
    return f"...{s[-4:]}" if len(s) > 4 else "present"


def parse_position_value(value: str) -> dict[str, Any] | None:
    if not value:
        return None
    try:
        obj = json.loads(value)
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    return vector_obj(
        [obj.get("x"), obj.get("y"), obj.get("z"), obj.get("w", obj.get("heading", 0.0))],
        label="players.position",
        source="remote_mysql:players.position",
    )


def fetch_latest_db_position(host: str, mysql_cfg: dict[str, Any] | None) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    diag: dict[str, Any] = {
        "configured": bool(mysql_cfg and mysql_cfg.get("configured")),
        "queried": False,
    }
    if not mysql_cfg or not mysql_cfg.get("configured"):
        return None, diag

    try:
        cols = parse_mysql_columns(mysql_query(host, mysql_cfg, "SHOW COLUMNS FROM players;", timeout=20))
        diag["columns"] = cols
    except Exception as e:
        diag["error"] = str(e)
        return None, diag

    if "position" not in cols:
        diag["error"] = "players.position column not found"
        return None, diag

    time_cols = [
        c for c in ("last_updated", "updated_at", "lastupdate", "last_login", "last_logged", "created_at")
        if c in cols
    ]
    id_col = "citizenid" if "citizenid" in cols else ("cid" if "cid" in cols else "")
    select_id = id_col if id_col else "''"
    select_time = time_cols[0] if time_cols else "''"
    order = f" ORDER BY {time_cols[0]} DESC" if time_cols else ""
    query = (
        f"SELECT {select_id}, position, {select_time} FROM players "
        f"WHERE position IS NOT NULL AND position <> ''{order} LIMIT 25;"
    )
    try:
        raw = mysql_query(host, mysql_cfg, query, timeout=30)
        diag["queried"] = True
    except Exception as e:
        diag["error"] = str(e)
        return None, diag

    candidates: list[dict[str, Any]] = []
    for line in raw.splitlines():
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        citizenid = parts[0]
        pos_raw = parts[1]
        updated = parts[2] if len(parts) > 2 else ""
        pos = parse_position_value(pos_raw)
        if not pos:
            continue
        pos["label"] = "last_location"
        pos["source"] = "remote_mysql:players.position"
        pos["_row"] = {"citizenid": _redact_identifier(citizenid), "updated": updated}
        pos["_citizenid_raw"] = citizenid
        candidates.append(pos)

    diag["candidateCount"] = len(candidates)
    diag["sampleRows"] = [c.get("_row", {}) for c in candidates[:5]]
    if not candidates:
        return None, diag
    chosen = dict(candidates[0])
    chosen.pop("_row", None)
    return chosen, diag


def _json_loads_maybe(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    text = str(value or "").strip()
    if not text:
        return None
    for _ in range(2):
        try:
            obj = json.loads(text)
        except Exception:
            return None
        if not isinstance(obj, str):
            return obj
        text = obj.strip()
    return None


def _as_int(value: Any, default: int | None = None) -> int | None:
    try:
        if value is None:
            return default
        if isinstance(value, bool):
            return int(value)
        if isinstance(value, str) and not value.strip():
            return default
        return int(float(value))
    except Exception:
        return default


def _normalise_model_name(model: Any) -> str:
    raw = str(model or "").strip().strip('"').strip("'").strip("`")
    if not raw:
        return ""
    if re.match(r"^\d+$", raw):
        h = int(raw) & 0xFFFFFFFF
        for name, known_hash in FREEMODE_MODELS.items():
            if h == known_hash:
                return name
        return raw
    return raw.lower()


def _component_id_from_key(key: str) -> int | None:
    s = str(key or "").strip().lower()
    if re.match(r"^\d+$", s):
        return _as_int(s)
    s = re.sub(r"_(?:1|drawable|draw)$", "", s)
    return SKINCHANGER_COMPONENT_KEYS.get(s)


def _prop_id_from_key(key: str) -> int | None:
    s = str(key or "").strip().lower()
    if re.match(r"^\d+$", s):
        return _as_int(s)
    s = re.sub(r"_(?:1|prop|drawable|draw)$", "", s)
    return SKINCHANGER_PROP_KEYS.get(s)


def _component_asset_name(component_id: int, drawable: int) -> str | None:
    parts = COMPONENT_ASSET_PARTS.get(int(component_id))
    if not parts or int(drawable) < 0:
        return None
    prefix, suffix = parts
    return f"{prefix}_{int(drawable):03d}_{suffix}"


def _normalise_components(appearance: dict[str, Any]) -> list[dict[str, Any]]:
    components: dict[int, dict[str, Any]] = {}

    def add(cid: Any, drawable: Any, texture: Any = 0, palette: Any = 0, source: str = "") -> None:
        cid_i = _as_int(cid)
        draw_i = _as_int(drawable)
        if cid_i is None or draw_i is None or cid_i < 0 or cid_i > 11:
            return
        tex_i = _as_int(texture, 0)
        pal_i = _as_int(palette, 0)
        asset_name = _component_asset_name(cid_i, draw_i)
        components[cid_i] = {
            "componentId": cid_i,
            "drawable": draw_i,
            "texture": tex_i if tex_i is not None else 0,
            "palette": pal_i if pal_i is not None else 0,
            "assetName": asset_name,
            "source": source,
        }

    raw_components = appearance.get("components")
    if isinstance(raw_components, list):
        for item in raw_components:
            if not isinstance(item, dict):
                continue
            add(
                item.get("component_id", item.get("componentId", item.get("id"))),
                item.get("drawable", item.get("drawable_id", item.get("drawableId"))),
                item.get("texture", item.get("texture_id", item.get("textureId", 0))),
                item.get("palette", item.get("palette_id", item.get("paletteId", 0))),
                "components[]",
            )
    elif isinstance(raw_components, dict):
        for k, item in raw_components.items():
            cid = _component_id_from_key(str(k))
            if isinstance(item, dict):
                add(
                    item.get("component_id", item.get("componentId", cid)),
                    item.get("drawable", item.get("drawable_id", item.get("drawableId"))),
                    item.get("texture", item.get("texture_id", item.get("textureId", 0))),
                    item.get("palette", item.get("palette_id", item.get("paletteId", 0))),
                    f"components.{k}",
                )
            elif cid is not None:
                add(cid, item, appearance.get(f"{k}_2", 0), 0, f"components.{k}")

    # Legacy skinchanger/esx/qb-style flat keys, e.g. tshirt_1/tshirt_2.
    for key, cid in SKINCHANGER_COMPONENT_KEYS.items():
        draw_key = f"{key}_1"
        tex_key = f"{key}_2"
        if draw_key in appearance or key in appearance:
            add(cid, appearance.get(draw_key, appearance.get(key)), appearance.get(tex_key, 0), 0, "flat")

    return [components[k] for k in sorted(components.keys())]


def _normalise_props(appearance: dict[str, Any]) -> list[dict[str, Any]]:
    props: dict[int, dict[str, Any]] = {}

    def add(pid: Any, drawable: Any, texture: Any = 0, source: str = "") -> None:
        pid_i = _as_int(pid)
        draw_i = _as_int(drawable)
        if pid_i is None or draw_i is None or pid_i < 0:
            return
        tex_i = _as_int(texture, 0)
        props[pid_i] = {
            "propId": pid_i,
            "drawable": draw_i,
            "texture": tex_i if tex_i is not None else 0,
            "source": source,
        }

    raw_props = appearance.get("props")
    if isinstance(raw_props, list):
        for item in raw_props:
            if not isinstance(item, dict):
                continue
            add(
                item.get("prop_id", item.get("propId", item.get("id"))),
                item.get("drawable", item.get("drawable_id", item.get("drawableId"))),
                item.get("texture", item.get("texture_id", item.get("textureId", 0))),
                "props[]",
            )
    elif isinstance(raw_props, dict):
        for k, item in raw_props.items():
            pid = _prop_id_from_key(str(k))
            if isinstance(item, dict):
                add(
                    item.get("prop_id", item.get("propId", pid)),
                    item.get("drawable", item.get("drawable_id", item.get("drawableId"))),
                    item.get("texture", item.get("texture_id", item.get("textureId", 0))),
                    f"props.{k}",
                )
            elif pid is not None:
                add(pid, item, appearance.get(f"{k}_2", 0), f"props.{k}")

    for key, pid in SKINCHANGER_PROP_KEYS.items():
        draw_key = f"{key}_1"
        tex_key = f"{key}_2"
        if draw_key in appearance or key in appearance:
            add(pid, appearance.get(draw_key, appearance.get(key)), appearance.get(tex_key, 0), "flat")

    return [props[k] for k in sorted(props.keys())]


def sanitize_character_appearance(row_model: Any, skin_value: Any, *, source: str, row_info: dict[str, Any]) -> dict[str, Any] | None:
    raw = _json_loads_maybe(skin_value)
    if not isinstance(raw, dict):
        return None

    model_name = _normalise_model_name(row_model or raw.get("model") or raw.get("ped") or raw.get("pedModel"))
    model_hash = FREEMODE_MODELS.get(model_name)
    components = _normalise_components(raw)
    props = _normalise_props(raw)
    render_names: list[str] = []
    seen: set[str] = set()
    if model_name in FREEMODE_MODELS:
        for c in components:
            name = c.get("assetName")
            if name and name not in seen:
                seen.add(name)
                render_names.append(name)
    elif model_name:
        render_names.append(model_name)

    hair = raw.get("hair")
    if not isinstance(hair, dict):
        hair = {}
    head_blend = raw.get("headBlend") or raw.get("head_blend")
    overlays = raw.get("headOverlays") or raw.get("head_overlays")
    face_features = raw.get("faceFeatures") or raw.get("face_features")

    profile = {
        "ok": True,
        "source": source,
        "row": row_info,
        "modelName": model_name,
        "modelHash": model_hash,
        "fallbackModelName": DEFAULT_RENDER_FALLBACK_MODEL,
        "components": components,
        "props": props,
        "appearance": {
            "hair": {
                "color": hair.get("color", raw.get("hairColor", raw.get("hair_color"))),
                "highlight": hair.get("highlight", raw.get("hairHighlightColor", raw.get("hair_highlight_color"))),
            },
            "headBlendPresent": isinstance(head_blend, dict),
            "headOverlaysPresent": isinstance(overlays, (dict, list)),
            "faceFeaturesPresent": isinstance(face_features, (dict, list)),
        },
        "render": {
            "mode": "freemode_components" if model_name in FREEMODE_MODELS else "single_model",
            "modelNames": render_names,
            "fallbackModelName": DEFAULT_RENDER_FALLBACK_MODEL,
            "meshComposition": "skinned_drawable_components" if model_name in FREEMODE_MODELS else "static_drawable",
            "skinning": model_name in FREEMODE_MODELS,
            "exactness": "saved_fivem_appearance_components; freemode drawables use exported GTA blend weights/indices",
        },
    }
    if model_hash:
        profile["render"].update({
            "skeleton": f"peds/{model_hash}_skeleton.json",
            "animations": f"peds/{model_hash}_animations.json",
            "animationSource": "CodeWalker YCD sampled skinTransforms3x4 on ped YFT skeleton",
        })
    return profile


def _query_appearance_table(
    host: str,
    mysql_cfg: dict[str, Any],
    table: str,
    columns: list[str],
    citizenid: str | None,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    cols = {c.lower(): c for c in columns}
    json_col = next((cols[c] for c in ("skin", "appearance", "appearance_data", "skin_data", "components") if c in cols), "")
    model_col = next((cols[c] for c in ("model", "ped", "ped_model") if c in cols), "")
    if not json_col:
        return None, {"table": table, "reason": "no appearance json column"}

    id_col = next((cols[c] for c in ("citizenid", "citizen_id", "identifier", "license", "cid") if c in cols), "")
    active_col = next((cols[c] for c in ("active", "is_active", "selected") if c in cols), "")
    updated_col = next((cols[c] for c in ("updated_at", "last_updated", "lastupdate", "created_at", "id") if c in cols), "")

    select_cols = [
        sql_ident(id_col) if id_col else "''",
        sql_ident(model_col) if model_col else "''",
        sql_ident(json_col),
        sql_ident(active_col) if active_col else "''",
        sql_ident(updated_col) if updated_col else "''",
    ]
    where = ""
    if citizenid and id_col:
        where = f" WHERE {sql_ident(id_col)} = {sql_string(citizenid)}"
    order_bits: list[str] = []
    if active_col:
        order_bits.append(f"{sql_ident(active_col)} DESC")
    if updated_col:
        order_bits.append(f"{sql_ident(updated_col)} DESC")
    order = f" ORDER BY {', '.join(order_bits)}" if order_bits else ""
    query = f"SELECT {', '.join(select_cols)} FROM {sql_ident(table)}{where}{order} LIMIT 10;"
    raw = mysql_query(host, mysql_cfg, query, timeout=30)
    rows = parse_mysql_rows(raw)
    for parts in rows:
        while len(parts) < 5:
            parts.append("")
        row_id, model, skin, active, updated = parts[:5]
        row_info = {
            "table": table,
            "citizenid": _redact_identifier(row_id),
            "active": active,
        }
        if updated_col and updated_col.lower() == "id":
            row_info["rowId"] = updated
        elif updated_col:
            row_info["updated"] = updated
        profile = sanitize_character_appearance(
            model,
            skin,
            source=f"remote_mysql:{table}.{json_col}",
            row_info=row_info,
        )
        if profile:
            return profile, {
                "table": table,
                "jsonColumn": json_col,
                "modelColumn": model_col or None,
                "idColumn": id_col or None,
                "rowCount": len(rows),
                "matched": True,
            }
    return None, {"table": table, "rowCount": len(rows), "matched": False}


def fetch_latest_db_appearance(
    host: str,
    mysql_cfg: dict[str, Any] | None,
    citizenid: str | None,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    diag: dict[str, Any] = {
        "configured": bool(mysql_cfg and mysql_cfg.get("configured")),
        "queried": False,
        "matched": False,
    }
    if not mysql_cfg or not mysql_cfg.get("configured"):
        return None, diag

    try:
        tables = [r[0] for r in parse_mysql_rows(mysql_query(host, mysql_cfg, "SHOW TABLES;", timeout=20)) if r]
        diag["queried"] = True
        diag["candidateTables"] = [
            t for t in tables
            if any(k in t.lower() for k in ("skin", "appearance"))
        ][:25]
    except Exception as e:
        diag["error"] = str(e)
        return None, diag

    preferred = [
        "playerskins",
        "player_skins",
        "player_appearance",
        "players_appearance",
        "illenium_appearance",
    ]
    ordered: list[str] = []
    lower_to_name = {t.lower(): t for t in tables}
    for name in preferred:
        if name in lower_to_name:
            ordered.append(lower_to_name[name])
    for t in tables:
        tl = t.lower()
        if t not in ordered and any(k in tl for k in ("skin", "appearance")):
            ordered.append(t)

    attempts: list[dict[str, Any]] = []
    for table in ordered:
        try:
            columns = parse_mysql_columns(mysql_query(host, mysql_cfg, f"SHOW COLUMNS FROM {sql_ident(table)};", timeout=20))
            profile, attempt = _query_appearance_table(host, mysql_cfg, table, columns, citizenid)
            attempt["columns"] = columns
            attempts.append(attempt)
            if profile:
                diag["matched"] = True
                diag["source"] = profile.get("source")
                diag["attempts"] = attempts
                return profile, diag
        except Exception as e:
            attempts.append({"table": table, "error": str(e)})
            continue

    diag["attempts"] = attempts
    return None, diag


def _query_appearance_options_table(
    host: str,
    mysql_cfg: dict[str, Any],
    table: str,
    columns: list[str],
    limit: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    cols = {c.lower(): c for c in columns}
    json_col = next((cols[c] for c in ("skin", "appearance", "appearance_data", "skin_data", "components") if c in cols), "")
    model_col = next((cols[c] for c in ("model", "ped", "ped_model") if c in cols), "")
    id_col = next((cols[c] for c in ("citizenid", "citizen_id", "identifier", "license", "cid") if c in cols), "")
    active_col = next((cols[c] for c in ("active", "is_active", "selected") if c in cols), "")
    updated_col = next((cols[c] for c in ("updated_at", "last_updated", "lastupdate", "created_at", "id") if c in cols), "")
    if not json_col:
        return [], {"table": table, "reason": "no appearance json column"}

    select_cols = [
        sql_ident(id_col) if id_col else "''",
        sql_ident(model_col) if model_col else "''",
        sql_ident(json_col),
        sql_ident(active_col) if active_col else "''",
        sql_ident(updated_col) if updated_col else "''",
    ]
    order_bits: list[str] = []
    if active_col:
        order_bits.append(f"{sql_ident(active_col)} DESC")
    if updated_col:
        order_bits.append(f"{sql_ident(updated_col)} DESC")
    order = f" ORDER BY {', '.join(order_bits)}" if order_bits else ""
    query = f"SELECT {', '.join(select_cols)} FROM {sql_ident(table)}{order} LIMIT {max(1, min(250, int(limit)))};"
    raw = mysql_query(host, mysql_cfg, query, timeout=30)

    profiles: list[dict[str, Any]] = []
    for row_num, parts in enumerate(parse_mysql_rows(raw), start=1):
        while len(parts) < 5:
            parts.append("")
        row_id, model, skin, active, updated = parts[:5]
        row_info = {
            "table": table,
            "citizenid": _redact_identifier(row_id),
            "active": active,
        }
        if updated_col and updated_col.lower() == "id":
            row_info["rowId"] = updated
        elif updated_col:
            row_info["updated"] = updated
        profile = sanitize_character_appearance(
            model,
            skin,
            source=f"remote_mysql:{table}.{json_col}",
            row_info=row_info,
        )
        if not profile:
            continue
        profile["optionId"] = f"{table}:{row_num}:{row_id or updated or len(profiles)}"
        profiles.append(profile)

    return profiles, {
        "table": table,
        "jsonColumn": json_col,
        "modelColumn": model_col or None,
        "idColumn": id_col or None,
        "rowCount": len(profiles),
        "matched": bool(profiles),
    }


def fetch_db_appearance_options(
    host: str,
    mysql_cfg: dict[str, Any] | None,
    limit: int = 40,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    diag: dict[str, Any] = {
        "configured": bool(mysql_cfg and mysql_cfg.get("configured")),
        "queried": False,
        "matched": False,
    }
    if not mysql_cfg or not mysql_cfg.get("configured"):
        return [], diag

    try:
        tables = [r[0] for r in parse_mysql_rows(mysql_query(host, mysql_cfg, "SHOW TABLES;", timeout=20)) if r]
        diag["queried"] = True
    except Exception as e:
        diag["error"] = str(e)
        return [], diag

    preferred = ["playerskins", "player_skins", "player_appearance", "players_appearance", "illenium_appearance"]
    lower_to_name = {t.lower(): t for t in tables}
    ordered: list[str] = []
    for name in preferred:
        if name in lower_to_name:
            ordered.append(lower_to_name[name])
    for t in tables:
        tl = t.lower()
        if t not in ordered and any(k in tl for k in ("skin", "appearance")):
            ordered.append(t)

    attempts: list[dict[str, Any]] = []
    all_profiles: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    for table in ordered:
        if len(all_profiles) >= limit:
            break
        try:
            columns = parse_mysql_columns(mysql_query(host, mysql_cfg, f"SHOW COLUMNS FROM {sql_ident(table)};", timeout=20))
            profiles, attempt = _query_appearance_options_table(host, mysql_cfg, table, columns, limit - len(all_profiles))
            attempt["columns"] = columns
            attempts.append(attempt)
            for profile in profiles:
                key = json.dumps(
                    {
                        "model": profile.get("modelName"),
                        "row": profile.get("row"),
                        "components": [
                            [c.get("componentId"), c.get("drawable"), c.get("texture")]
                            for c in profile.get("components", [])
                            if isinstance(c, dict)
                        ],
                    },
                    sort_keys=True,
                )
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                all_profiles.append(profile)
                if len(all_profiles) >= limit:
                    break
        except Exception as e:
            attempts.append({"table": table, "error": str(e)})
            continue

    diag["matched"] = bool(all_profiles)
    diag["count"] = len(all_profiles)
    diag["attempts"] = attempts
    return all_profiles, diag


def build_profile(host: str, server_root: str, query_db: bool = True) -> tuple[dict[str, Any], dict[str, Any]]:
    source_base = f"ssh://{host}{server_root}"
    server_cfg = remote_cat(host, f"{server_root}/server.cfg")
    multi_path = f"{server_root}/resources/[nx]/nx-mod-multicharacter/config.lua"
    spawn_path = f"{server_root}/resources/[nx]/nx-mod-spawn/config.lua"
    multi_cfg = remote_cat(host, multi_path)
    spawn_cfg = remote_cat(host, spawn_path)

    multi_source = f"{source_base}/resources/[nx]/nx-mod-multicharacter/config.lua"
    spawn_source = f"{source_base}/resources/[nx]/nx-mod-spawn/config.lua"
    multi_vectors = find_vectors_in_lua(multi_cfg, multi_source)
    spawn_vectors = parse_spawn_selector_config(spawn_cfg, spawn_source)

    default_spawn = first_by_label(multi_vectors, "default_spawn")
    preview_ped = first_by_label(multi_vectors, "character_preview_ped")
    preview_cam = first_by_label(multi_vectors, "character_preview_camera")
    hidden = first_by_label(multi_vectors, "hidden_coords")

    if not default_spawn:
        raise RuntimeError("Could not parse Config.DefaultSpawn from remote nx-mod-multicharacter/config.lua")

    mysql_cfg = parse_mysql_connection(server_cfg)
    db_diag: dict[str, Any] = {"configured": bool(mysql_cfg and mysql_cfg.get("configured")), "queried": False}
    db_spawn = None
    db_citizenid = None
    if query_db:
        db_spawn, db_diag = fetch_latest_db_position(host, mysql_cfg)
        if db_spawn:
            db_citizenid = db_spawn.pop("_citizenid_raw", None)

    if db_spawn:
        ped = db_spawn
        kind = "server_database_last_location"
        source = db_spawn["source"]
    else:
        ped = dict(default_spawn)
        ped["label"] = "server_default_spawn"
        kind = "server_resource_default_spawn"
        source = default_spawn.get("source", multi_source)

    character_profile = None
    character_diag: dict[str, Any] = {"configured": bool(mysql_cfg and mysql_cfg.get("configured")), "queried": False}
    character_options: list[dict[str, Any]] = []
    character_options_diag: dict[str, Any] = {"configured": bool(mysql_cfg and mysql_cfg.get("configured")), "queried": False}
    if query_db:
        character_profile, character_diag = fetch_latest_db_appearance(host, mysql_cfg, db_citizenid)
        character_options, character_options_diag = fetch_db_appearance_options(host, mysql_cfg, limit=40)

    cam = heading_to_camera(ped)
    cam["source"] = source

    candidates = []
    for v in [default_spawn, preview_ped, preview_cam, hidden, *spawn_vectors]:
        if v:
            candidates.append(v)

    skip_selection = parse_config_bool(multi_cfg, "Config.SkipSelection")
    dump = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "remote": {
            "host": host,
            "serverRoot": server_root,
        },
        "server": {
            "startedResources": parse_ensured_resources(server_cfg),
            "mysql": {
                "configured": bool(mysql_cfg and mysql_cfg.get("configured")),
                "host": mysql_cfg.get("host") if mysql_cfg else None,
                "database": mysql_cfg.get("database") if mysql_cfg else None,
            },
        },
        "flow": {
            "stack": "nx",
            "skipSelection": skip_selection,
            "decision": "SkipSelection uses players.position when valid; otherwise Config.DefaultSpawn.",
            "clientEvent": "nx-mod-multicharacter:client:spawnLastLocation",
        },
        "database": db_diag,
        "appearance": character_diag,
        "appearanceOptions": character_options_diag,
        "parsed": {
            "defaultSpawn": default_spawn,
            "previewPed": preview_ped,
            "previewCamera": preview_cam,
            "hiddenCoords": hidden,
            "spawnSelector": spawn_vectors,
        },
    }

    profile = {
        "source": source_base,
        "kind": kind,
        "generatedAt": dump["generatedAt"],
        "flow": dump["flow"],
        "spawn": {
            "ped": ped,
            "cam": cam,
            "hidden": hidden,
        },
        "preview": {
            "ped": preview_ped,
            "cam": preview_cam,
            "hidden": hidden,
        },
        "candidates": candidates,
        "diagnostics": {
            "remote": dump["remote"],
            "database": db_diag,
            "appearance": character_diag,
        },
    }
    if character_profile:
        profile["character"] = character_profile
        dump["character"] = character_profile
    if character_options:
        profile["characters"] = character_options
        dump["characters"] = character_options
    return profile, dump


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=DEFAULT_REMOTE_HOST)
    ap.add_argument("--server-root", default=DEFAULT_REMOTE_ROOT)
    ap.add_argument("--assets-dir", default=str(REPO_ROOT / "webgl_viewer" / "assets"))
    ap.add_argument("--no-db", action="store_true")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    assets_dir = Path(args.assets_dir).resolve()
    profile, dump = build_profile(args.host, args.server_root.rstrip("/"), query_db=not args.no_db)

    assets_dir.mkdir(parents=True, exist_ok=True)
    spawn_path = assets_dir / "runtime_spawn.json"
    dump_path = assets_dir / "runtime_resource_dump.json"
    character_path = assets_dir / "runtime_character.json"
    characters_path = assets_dir / "runtime_characters.json"
    indent = 2 if args.pretty else None
    spawn_path.write_text(json.dumps(profile, indent=indent), encoding="utf-8")
    dump_path.write_text(json.dumps(dump, indent=indent), encoding="utf-8")
    if profile.get("character"):
        character_path.write_text(json.dumps(profile["character"], indent=indent), encoding="utf-8")
    if isinstance(profile.get("characters"), list):
        characters_path.write_text(json.dumps({
            "schema": "webglgta-nexusai-appearance-options-v1",
            "generatedAt": profile.get("generatedAt"),
            "source": profile.get("source"),
            "characters": profile["characters"],
        }, indent=indent), encoding="utf-8")

    ped = profile["spawn"]["ped"]
    print(json.dumps({
        "ok": True,
        "kind": profile.get("kind"),
        "spawn": {"x": ped.get("x"), "y": ped.get("y"), "z": ped.get("z"), "w": ped.get("w")},
        "character": {
            "ok": bool(profile.get("character")),
            "modelName": profile.get("character", {}).get("modelName") if isinstance(profile.get("character"), dict) else None,
            "renderMode": profile.get("character", {}).get("render", {}).get("mode") if isinstance(profile.get("character"), dict) else None,
            "modelCount": len(profile.get("character", {}).get("render", {}).get("modelNames", [])) if isinstance(profile.get("character"), dict) else 0,
            "options": len(profile.get("characters", [])) if isinstance(profile.get("characters"), list) else 0,
        },
        "runtimeSpawn": str(spawn_path),
        "resourceDump": str(dump_path),
        "runtimeCharacter": str(character_path) if profile.get("character") else None,
        "runtimeCharacters": str(characters_path) if isinstance(profile.get("characters"), list) else None,
    }))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Generate a small, AI-friendly "control bundle" from GTA5 client data using CodeWalker.

This is meant for the "we have the GTA5 client, extract the necessary information" workflow:
- We are NOT extracting an input->movement function (that's game/client code).
- We ARE extracting the stable identifiers you can reason about:
  - player ped locomotion clipsets + anim dictionary names
  - a best-effort set of candidate asset entry paths (.ycd/.ymt/.meta) that likely back those identifiers

Outputs (by default):
- output/ai/control_bundle.json

Typical use:
  python3 scripts/generate_ai_control_bundle.py --gta5-path /data/webglgta/webgl-gta/gtav
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple


PLAYER_FIELDS = (
    "Name",
    "ClipDictionaryName",
    "MovementClipSet",
    "MovementClipSets",
    "StrafeClipSet",
    "MovementToStrafeClipSet",
    "InjuredStrafeClipSet",
    "SidestepClipSet",
    "MotionTaskDataSetName",
    "DefaultTaskDataSetName",
    "DefaultGestureClipSet",
    "DefaultBrawlingStyle",
    "DefaultUnarmedWeapon",
    "CombatInfo",
    "NavCapabilitiesName",
    "PerceptionInfo",
)


ASSET_EXTS = (".ycd", ".ymt", ".meta")


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _is_truthy_str(v: Any) -> bool:
    return isinstance(v, str) and v.strip() != ""


def _norm_token(v: str) -> str:
    return v.strip()


def _collect_tokens(player_rows: List[Dict[str, Any]]) -> List[str]:
    """
    Collect the set of identifiers that are likely to correspond to real assets.
    Keep this conservative to avoid generating huge candidate lists.
    """
    tokens: Set[str] = set()
    def _add(v: Any) -> None:
        if _is_truthy_str(v):
            tokens.add(_norm_token(str(v)))

    for r in player_rows:
        # High-signal identifiers that tend to map to real anim/clipset assets.
        for k in (
            "ClipDictionaryName",
            "MovementClipSet",
            "StrafeClipSet",
            "MovementToStrafeClipSet",
            "InjuredStrafeClipSet",
            "SidestepClipSet",
            "DefaultGestureClipSet",
        ):
            v = r.get(k)
            _add(v)

        # Lower-signal identifiers (datasets/combat styles/etc.) can explode the match set
        # (e.g. "franklin" matches many cutscene assets). We only include these if the caller
        # explicitly wants broader discovery.
        # NOTE: this is intentionally conservative; you can widen later with --include-broad-tokens.
        if r.get("_include_broad_tokens"):
            for k in (
                "DefaultBrawlingStyle",
                "CombatInfo",
                "MotionTaskDataSetName",
                "DefaultTaskDataSetName",
            ):
                _add(r.get(k))
        # MovementClipSets can be list-like (already JSON-ified by generator)
        mcs = r.get("MovementClipSets")
        if isinstance(mcs, list):
            for v in mcs:
                if _is_truthy_str(v):
                    tokens.add(_norm_token(v))

    # Drop known placeholder-ish strings
    tokens.discard("clip_set_id_invalid")
    tokens.discard("")
    # Keep tokens likely to correspond to asset names/paths.
    # This further reduces false positives from generic identifiers.
    allowed_prefixes = ("move_", "anim_group_", "clip_")
    filtered = [t for t in tokens if t.startswith(allowed_prefixes)]
    return sorted(filtered)


def _split_rpf_entry_path(entry_path: str) -> Optional[Tuple[str, str]]:
    """
    CodeWalker RPF manager paths often look like:
      /abs/path/to/x64a.rpf\\data\\peds.ymt
    Return (rpf_abs_path, internal_path_backslashes)
    """
    if not entry_path:
        return None
    s = entry_path
    # find the first ".rpf\" boundary
    low = s.lower()
    idx = low.find(".rpf\\")
    if idx == -1:
        # sometimes forward slashes leak in; normalize and retry
        s2 = s.replace("/", "\\")
        low2 = s2.lower()
        idx2 = low2.find(".rpf\\")
        if idx2 == -1:
            return None
        s = s2
        idx = idx2
    rpf_abs = s[: idx + 4]
    internal = s[idx + 5 :]  # after ".rpf\"
    return (rpf_abs, internal)


def _iter_all_entry_paths(rpf_manager) -> Iterable[str]:
    for rpf in rpf_manager.AllRpfs:
        entries = getattr(rpf, "AllEntries", None)
        if not entries:
            continue
        for e in entries:
            # e.Path is the full CodeWalker entry path (includes the rpf path prefix)
            try:
                p = str(e.Path)
            except Exception:
                continue
            if p:
                yield p


def _find_asset_candidates(rpf_manager, tokens: List[str]) -> Dict[str, List[Dict[str, str]]]:
    """
    Single-pass scan through all RPF entry paths and match on substring tokens.

    Returns:
      token -> [{rpf, file, entryPath}]
    """
    tokens_l = [t.lower() for t in tokens]
    out: Dict[str, List[Dict[str, str]]] = {t: [] for t in tokens}

    # Fast path: if no tokens, nothing to do.
    if not tokens:
        return out

    # Precompute: for each token we will append matches; cap per token to avoid runaway output.
    cap_per_token = 200

    for entry_path in _iter_all_entry_paths(rpf_manager):
        ep_low = entry_path.lower()
        if not ep_low.endswith(ASSET_EXTS):
            continue

        # Check if any token matches this entry path.
        # Tokens are few (player-only) so O(N_tokens * N_entries) is fine here.
        for t, tl in zip(tokens, tokens_l):
            if len(out[t]) >= cap_per_token:
                continue
            if tl in ep_low:
                split = _split_rpf_entry_path(entry_path)
                if not split:
                    continue
                rpf_abs, internal = split
                out[t].append({"rpf": rpf_abs, "file": internal, "entryPath": entry_path})

    # Remove empty lists to keep the JSON smaller (but keep ordering stable at top-level).
    return {k: v for k, v in out.items() if v}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--gta5-path",
        default=os.environ.get("gta5_path") or os.environ.get("GTA5_PATH") or "",
        help="Path to GTA5 install folder (contains GTA5.exe, common.rpf, update/...).",
    )
    ap.add_argument(
        "--ped-controls-json",
        default="docs/generated/ped-control-mapping.json",
        help="Path to ped-control-mapping JSON (relative to repo root unless absolute).",
    )
    ap.add_argument(
        "--out",
        default="output/ai/control_bundle.json",
        help="Output JSON path (relative to repo root unless absolute).",
    )
    ap.add_argument(
        "--include-nonplayer",
        action="store_true",
        help="Include a small sample of non-player ped rows (debugging / exploration).",
    )
    ap.add_argument(
        "--include-broad-tokens",
        action="store_true",
        help="Also include lower-signal tokens (datasets/combat styles) which can produce lots of matches.",
    )
    args = ap.parse_args()

    repo_root = _repo_root()
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

    gta5_path = Path(args.gta5_path).expanduser().resolve() if args.gta5_path else Path()
    if not gta5_path.exists():
        raise SystemExit(
            "--gta5-path is required (or set env gta5_path). "
            "Example: --gta5-path /data/webglgta/webgl-gta/gtav"
        )

    ped_controls_path = Path(args.ped_controls_json)
    if not ped_controls_path.is_absolute():
        ped_controls_path = (repo_root / ped_controls_path).resolve()
    if not ped_controls_path.exists():
        raise SystemExit(
            f"Missing ped controls JSON: {ped_controls_path}\n"
            "Generate it with:\n"
            f"  python3 {repo_root}/scripts/generate_ped_control_mapping.py --gta5-path {gta5_path}"
        )

    out_path = Path(args.out)
    if not out_path.is_absolute():
        out_path = (repo_root / out_path).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    rows = _read_json(ped_controls_path)
    if not isinstance(rows, list):
        raise SystemExit(f"Unexpected JSON shape in {ped_controls_path} (expected list).")

    player_rows_all = [r for r in rows if isinstance(r, dict) and r.get("_is_player_ped") is True]

    # Deduplicate player rows by ped name (the source list contains multiple entries across peds.* sources).
    # Prefer the first occurrence.
    seen_names: Set[str] = set()
    player_rows: List[Dict[str, Any]] = []
    for r in player_rows_all:
        name = str(r.get("Name") or "")
        if not name or name in seen_names:
            continue
        seen_names.add(name)
        row = {k: r.get(k) for k in PLAYER_FIELDS}
        # Internal knob for token collection (keeps the JSON clean).
        row["_include_broad_tokens"] = bool(args.include_broad_tokens)
        player_rows.append(row)

    nonplayer_sample: List[Dict[str, Any]] = []
    if args.include_nonplayer:
        for r in rows:
            if not isinstance(r, dict):
                continue
            if r.get("_is_player_ped"):
                continue
            name = r.get("Name")
            if not _is_truthy_str(name):
                continue
            nonplayer_sample.append({k: r.get(k) for k in ("Name", "MovementClipSet", "StrafeClipSet", "ClipDictionaryName")})
            if len(nonplayer_sample) >= 25:
                break

    tokens = _collect_tokens(player_rows)
    # Remove internal knob now that tokens are computed.
    for r in player_rows:
        r.pop("_include_broad_tokens", None)

    # Use CodeWalker RPF manager to find candidate assets that include these tokens in their entry paths.
    from gta5_modules.dll_manager import DllManager

    dm = DllManager(str(gta5_path))
    if not dm.initialized:
        raise SystemExit("DllManager failed to initialize (see logs).")
    rm = dm.get_rpf_manager()

    candidates = _find_asset_candidates(rm, tokens)

    # Flatten unique file exports (rpf,file pairs)
    unique_exports: Dict[str, Dict[str, str]] = {}
    for token, matches in candidates.items():
        for m in matches:
            key = f"{m['rpf']}|{m['file']}"
            if key not in unique_exports:
                unique_exports[key] = {"rpf": m["rpf"], "file": m["file"]}

    bundle = {
        "generated_at": _now_iso(),
        "gta5_path": str(gta5_path),
        "sources": {
            "ped_control_mapping_json": str(ped_controls_path),
        },
        "players": player_rows,
        "tokens": tokens,
        "asset_candidates_by_token": candidates,
        "unique_export_list": sorted(unique_exports.values(), key=lambda x: (x["rpf"], x["file"])),
        "notes": [
            "This bundle is 'asset discovery': it does not include Rockstar input->movement code.",
            "Use unique_export_list to pull candidate .ycd/.ymt/.meta files from RPFS using CodeWalker.Cli extract.",
        ],
    }
    if nonplayer_sample:
        bundle["nonplayer_sample"] = nonplayer_sample

    out_path.write_text(json.dumps(bundle, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote: {out_path}")
    print(f"Players: {len(player_rows)} | Tokens: {len(tokens)} | Export candidates: {len(bundle['unique_export_list'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



#!/usr/bin/env python3
"""
Minimal CLI to control a FiveM client through the `ai_bot_bridge` resource.

This talks to FXServer's embedded HTTP server:
  POST http://<host>:<port>/aibot

Examples:
  python3 tools/aibot_cli.py --server http://127.0.0.1:30120 --player 3 state
  python3 tools/aibot_cli.py --server http://127.0.0.1:30120 --player 3 tp --x -75.0 --y -818.0 --z 326.0 --heading 0
  python3 tools/aibot_cli.py --server http://127.0.0.1:30120 --player 3 walk --x -80 --y -820 --z 326 --speed 1.0
  python3 tools/aibot_cli.py --server http://127.0.0.1:30120 --player 3 stop

Optional auth:
  set server convar: aibot_token "secret"
  pass: --token secret
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from typing import Any, Dict, Optional


def _post_json(url: str, payload: Dict[str, Any], token: Optional[str]) -> Dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            **({"Authorization": f"Bearer {token}"} if token else {}),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            return json.loads(raw)
        except Exception:
            return {"ok": False, "error": f"http_{e.code}", "body": raw}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default="http://127.0.0.1:30120", help="Base server URL (default: http://127.0.0.1:30120)")
    ap.add_argument("--token", default="", help="Bearer token if aibot_token is set on the server")
    ap.add_argument("--player", type=int, default=0, help="Target server player id (source id)")

    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="List players and whether server has recent state for them")
    sub.add_parser("state", help="Get last known state for --player")
    sub.add_parser("stop", help="Clear tasks on --player")

    tp = sub.add_parser("tp", help="Teleport --player to coords")
    tp.add_argument("--x", type=float, required=True)
    tp.add_argument("--y", type=float, required=True)
    tp.add_argument("--z", type=float, required=True)
    tp.add_argument("--heading", type=float, default=None)

    hd = sub.add_parser("heading", help="Set heading for --player")
    hd.add_argument("--heading", type=float, required=True)

    walk = sub.add_parser("walk", help="Walk straight to coords")
    walk.add_argument("--x", type=float, required=True)
    walk.add_argument("--y", type=float, required=True)
    walk.add_argument("--z", type=float, required=True)
    walk.add_argument("--speed", type=float, default=1.0)
    walk.add_argument("--timeoutMs", type=int, default=-1)
    walk.add_argument("--heading", type=float, default=0.0)
    walk.add_argument("--distToStop", type=float, default=0.25)

    run = sub.add_parser("run", help="Run straight to coords (higher speed)")
    run.add_argument("--x", type=float, required=True)
    run.add_argument("--y", type=float, required=True)
    run.add_argument("--z", type=float, required=True)
    run.add_argument("--speed", type=float, default=3.0)
    run.add_argument("--timeoutMs", type=int, default=-1)
    run.add_argument("--heading", type=float, default=0.0)
    run.add_argument("--distToStop", type=float, default=0.25)

    args = ap.parse_args()

    url = args.server.rstrip("/") + "/aibot"
    token = args.token.strip() or None

    if args.cmd in ("state", "stop", "tp", "heading", "walk", "run") and not args.player:
        print("Error: --player is required for this command.", file=sys.stderr)
        return 2

    payload: Dict[str, Any] = {}
    if args.cmd == "list":
        payload = {"action": "list"}
    elif args.cmd == "state":
        payload = {"action": "get_state", "player": args.player}
    elif args.cmd == "stop":
        payload = {"action": "stop", "player": args.player}
    elif args.cmd == "tp":
        payload = {"action": "teleport", "player": args.player, "x": args.x, "y": args.y, "z": args.z}
        if args.heading is not None:
            payload["heading"] = args.heading
    elif args.cmd == "heading":
        payload = {"action": "set_heading", "player": args.player, "heading": args.heading}
    elif args.cmd == "walk":
        payload = {
            "action": "walk_to",
            "player": args.player,
            "x": args.x,
            "y": args.y,
            "z": args.z,
            "speed": args.speed,
            "timeoutMs": args.timeoutMs,
            "heading": args.heading,
            "distToStop": args.distToStop,
        }
    elif args.cmd == "run":
        payload = {
            "action": "run_to",
            "player": args.player,
            "x": args.x,
            "y": args.y,
            "z": args.z,
            "speed": args.speed,
            "timeoutMs": args.timeoutMs,
            "heading": args.heading,
            "distToStop": args.distToStop,
        }
    else:
        raise SystemExit("unreachable")

    resp = _post_json(url, payload, token)
    print(json.dumps(resp, indent=2, sort_keys=True))
    return 0 if resp.get("ok") is True else 1


if __name__ == "__main__":
    raise SystemExit(main())


